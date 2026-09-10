import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { captureTranscriptPrefix, ensureSessionMemoryState } from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { CAPSULE_PAGE_ITEMS } from "../src/continuity-evidence.js";
import { recoverTerminalWork } from "../src/job-recovery.js";

/**
 * Issue #33 — Capsule retries did not converge.
 *
 * Observed on the real data root (v0.5.2): `capsule_frontiers.through_seq = 0`
 * for all eight workstreams while `workstream_evidence` held 40 rows, seven
 * `capsule_update` jobs `dead` at `attempts=5/5` with one identical
 * `last_error`, and three workstreams holding two dead jobs each. The frontier
 * only advances inside a successful commit, so every retry re-read the same
 * bytes, and `scheduleCapsuleForCheckpoint` ignored `dead`, so each new
 * checkpoint created another job that replayed the same failure five times.
 *
 * These tests start from that shape: evidence present, a deterministic
 * failure, frontier at 0.
 */

let root: string;
let db: Database.Database;
let workstream: string;
const vector = new Array(384).fill(0.01);

function transcript(session: string): string {
  return path.join(root, `${session}.jsonl`);
}

function bind(session: string): void {
  ensureSessionMemoryState(db, { sessionId: session, project: root, explicitWorkstreamId: workstream });
  fs.writeFileSync(
    transcript(session),
    JSON.stringify({ type: "session_meta", payload: { id: session, cwd: root } }) + "\n",
  );
}

function put(session: string, id: string): void {
  insertExchange(db, {
    id, sessionId: session, project: root, cwd: root, archivePath: transcript(session),
    timestamp: new Date().toISOString(), userMessage: id, assistantMessage: "",
    lineStart: 2, lineEnd: 2,
  }, vector);
}

function capture(session: string): void {
  fs.appendFileSync(
    transcript(session),
    JSON.stringify({ type: "event_msg", payload: { type: "note", text: "" } }) + "\n",
  );
  captureTranscriptPrefix(db, {
    sessionId: session, project: root, transcriptPath: transcript(session), kind: "final",
  });
  db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
}

function frontier(): number {
  return (db.prepare("SELECT through_seq FROM capsule_frontiers WHERE workstream_id = ?")
    .get(workstream) as { through_seq: number }).through_seq;
}

function capsuleJobs(): Array<{ job_id: string; state: string; attempts: number }> {
  return db.prepare(
    "SELECT job_id, state, attempts FROM memory_jobs WHERE kind = 'capsule_update' ORDER BY created_at, job_id",
  ).all() as Array<{ job_id: string; state: string; attempts: number }>;
}

function checkpointState(): Array<{ state: string; last_error: string | null; page_items_hint: number | null; page_chars_hint: number | null }> {
  return db.prepare(
    "SELECT state, last_error, page_items_hint, page_chars_hint FROM capsule_checkpoint_state",
  ).all() as Array<{ state: string; last_error: string | null; page_items_hint: number | null; page_chars_hint: number | null }>;
}

function skipRecord(): { checkpoint_id: string; skipped_seq: number | null; frontier_before_skip: number | null } {
  return db.prepare(
    "SELECT checkpoint_id, skipped_seq, frontier_before_skip FROM capsule_checkpoint_state",
  ).get() as { checkpoint_id: string; skipped_seq: number | null; frontier_before_skip: number | null };
}

function deadCapsuleJobId(): string {
  return (db.prepare("SELECT job_id FROM memory_jobs WHERE kind = 'capsule_update' AND state = 'dead'")
    .get() as { job_id: string }).job_id;
}

/**
 * 🚨 Wall-clock independent. Retry backoff is a relative interval, so the
 * fixture advances the worker's `now` instead of pinning an absolute date.
 */
async function drainFailingAttempts(segments: number[], attempts = 5): Promise<string[]> {
  const states: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const now = new Date(Date.now() + attempt * 3_600_000);
    const result = await runContinuityWorker(db, {
      maxJobs: 1,
      now,
      model: async (_system, user) => {
        segments.push(JSON.parse(user).contiguousSegment.length);
        throw new Error("capsule model exploded");
      },
    });
    states.push(result[0]?.state ?? "none");
  }
  return states;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-capsule-retry-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  db = initDatabase();
  workstream = ensureSessionMemoryState(db, { sessionId: "session-A", project: root }).workstreamId;
  bind("session-A");
  for (let i = 0; i < CAPSULE_PAGE_ITEMS; i++) put("session-A", `exchange-${i}`);
  capture("session-A");
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

it("each failed attempt halves the page instead of re-reading identical evidence", async () => {
  const segments: number[] = [];
  const states = await drainFailingAttempts(segments, 4);

  expect(states).toEqual(["retry", "retry", "retry", "retry"]);
  // Before the fix every attempt read the same 8 fragments.
  expect(segments).toEqual([8, 4, 2, 1]);
  expect(new Set(segments).size).toBeGreaterThan(1);
  const [state] = checkpointState();
  expect(state.state).toBe("retry");
  expect(state.page_items_hint).toBe(1);
  expect(state.last_error).toContain("next page items=1");
});

it("an attempts-exhausted Capsule advances the frontier past the fragment it could not distill", async () => {
  expect(frontier()).toBe(0);
  const segments: number[] = [];
  const states = await drainFailingAttempts(segments, 5);

  expect(states[4]).toBe("dead");
  expect(capsuleJobs().filter((job) => job.state === "dead").length).toBe(1);
  // The observed permanent stall was through_seq stuck at 0 with evidence
  // waiting behind it. Partial progress is now recorded.
  expect(frontier()).toBe(1);
  expect(
    db.prepare("SELECT COUNT(*) AS c FROM workstream_evidence WHERE workstream_id = ? AND seq > ?")
      .get(workstream, frontier()),
  ).toEqual({ c: CAPSULE_PAGE_ITEMS - 1 });
  const [state] = checkpointState();
  expect(state.last_error).toContain("skipped evidence seq 1");
  // Issue #71: the skip records where the frontier stood so it is reversible.
  expect(skipRecord()).toMatchObject({ skipped_seq: 1, frontier_before_skip: 0 });
});

/**
 * Issue #71 — observed with `max_attempts = 1` and one network failure:
 *   attempt: {"state":"dead","detail":"LLM call failed: fetch failed (ECONNRESET)
 *             (skipped evidence seq 1; frontier advanced)","pageItems":8}
 *   frontier after one transient failure: 1
 *   checkpoint state: [{"state":"failed-visible","page_items_hint":null,...}]
 *   frontier after memex recover: 1
 * The page had never been shrunk and the provider — not the evidence — failed,
 * yet the fragment was stepped over and no recovery path brought it back.
 */
it("a transient failure leaves the frontier where it was, even when it is terminal", async () => {
  db.prepare("UPDATE memory_jobs SET max_attempts = 1 WHERE kind = 'capsule_update' AND state = 'pending'").run();
  let pageItems = 0;
  const result = await runContinuityWorker(db, {
    maxJobs: 1,
    model: async (_system, user) => {
      pageItems = JSON.parse(user).contiguousSegment.length;
      throw new Error("LLM call failed: fetch failed (ECONNRESET)");
    },
  });

  expect(result[0]?.state).toBe("dead");
  expect(pageItems).toBe(CAPSULE_PAGE_ITEMS);
  // The provider failed; nothing was learned about the evidence.
  expect(frontier()).toBe(0);
  const [state] = checkpointState();
  expect(state.state).toBe("failed-visible");
  expect(state.last_error).not.toContain("skipped evidence");
  expect(skipRecord()).toMatchObject({ skipped_seq: null, frontier_before_skip: null });
  // So every fragment is still waiting for the recovered job.
  expect(
    db.prepare("SELECT COUNT(*) AS c FROM workstream_evidence WHERE workstream_id = ? AND seq > ?")
      .get(workstream, frontier()),
  ).toEqual({ c: CAPSULE_PAGE_ITEMS });
});

it("recovering a skipped Capsule puts the skipped fragment back into the model input", async () => {
  await drainFailingAttempts([], 5);
  expect(frontier()).toBe(1);
  const jobId = deadCapsuleJobId();

  const recovered = recoverTerminalWork(db, { jobId, now: new Date(Date.now() + 6 * 3_600_000) });
  expect(recovered.entries[0].reset.capsule_frontiers).toBe(1);
  // Before this change the frontier stayed at 1 and seq 1 was never read again.
  expect(frontier()).toBe(0);
  expect(skipRecord()).toMatchObject({ skipped_seq: null, frontier_before_skip: null });

  const seen: number[] = [];
  await runContinuityWorker(db, {
    maxJobs: 1,
    now: new Date(Date.now() + 7 * 3_600_000),
    model: async (_system, user) => {
      for (const item of JSON.parse(user).contiguousSegment) seen.push(item.evidenceSeq);
      throw new Error("still failing");
    },
  });
  expect(seen).toContain(1);
});

it("a dead Capsule job is not re-created by the next checkpoint", async () => {
  await drainFailingAttempts([], 5);
  expect(capsuleJobs().map((job) => job.state)).toEqual(["dead"]);

  // The real data root grew a second dead job per workstream exactly here.
  put("session-A", "exchange-after-dead");
  capture("session-A");
  await runContinuityWorker(db, {
    maxJobs: 2,
    now: new Date(Date.now() + 10 * 3_600_000),
    model: async () => { throw new Error("must not be called"); },
  });

  const jobs = capsuleJobs();
  expect(jobs.length).toBe(1);
  expect(jobs[0].state).toBe("dead");
  expect(jobs[0].attempts).toBe(5);
});

it("a successful Capsule clears the shrink hint so the stream returns to full pages", async () => {
  const segments: number[] = [];
  await drainFailingAttempts(segments, 2);
  expect(checkpointState()[0].page_items_hint).toBe(2);

  const succeeded = await runContinuityWorker(db, {
    maxJobs: 4,
    now: new Date(Date.now() + 5 * 3_600_000),
    model: async (_system, user) => {
      segments.push(JSON.parse(user).contiguousSegment.length);
      return JSON.stringify({
        objective: "Converge", currentState: "Distilled", verifiedProgress: [], hypotheses: [],
        blockers: [], openQuestions: [], nextActions: ["Continue"], touchedAreas: [],
        carryFactRevisions: [], sourceExchangeIds: [],
      });
    },
  });

  expect(succeeded.every((result) => ["completed", "partial"].includes(result.state))).toBe(true);
  expect(frontier()).toBe(CAPSULE_PAGE_ITEMS);
  expect(checkpointState()[0].page_items_hint).toBeNull();
  expect(checkpointState()[0].page_chars_hint).toBeNull();
});
