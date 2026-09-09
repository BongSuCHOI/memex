import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { captureTranscriptPrefix, ensureSessionMemoryState } from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { CAPSULE_PAGE_ITEMS } from "../src/continuity-evidence.js";

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
