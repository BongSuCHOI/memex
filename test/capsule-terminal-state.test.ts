import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { captureTranscriptPrefix, ensureSessionMemoryState } from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { claimMemoryJobById, failMemoryJob } from "../src/continuity-store.js";

/**
 * Issue #34 — the worker overwrote the store's terminal state with `retry`.
 *
 * Observed on the real data root (v0.5.2):
 *
 *   memory_jobs               dead 7        (capsule_update)
 *   checkpoints               dead-letter 7
 *   capsule_checkpoint_state  retry 7, failed-visible 0
 *
 * `failMemoryJob` writes `failed-visible` when attempts are exhausted, but it
 * answered a bare `true` for both retry and dead, so the caller wrote `retry`
 * over it unconditionally. The row is then invisible as a failure and nobody
 * drains it — its job is already dead.
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

function stateCounts(table: string): Record<string, number> {
  const rows = db.prepare(`SELECT state, COUNT(*) AS c FROM ${table} GROUP BY state`)
    .all() as Array<{ state: string; c: number }>;
  return Object.fromEntries(rows.map((row) => [row.state, row.c]));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-capsule-terminal-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  db = initDatabase();
  workstream = ensureSessionMemoryState(db, { sessionId: "session-A", project: root }).workstreamId;
  bind("session-A");
});

afterEach(() => {
  if (db.open) db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

it("failMemoryJob reports the transition it took, not a bare boolean", () => {
  put("session-A", "source");
  capture("session-A");
  const job = db.prepare(
    "SELECT job_id, max_attempts FROM memory_jobs WHERE kind = 'capsule_update'",
  ).get() as { job_id: string; max_attempts: number };
  db.prepare("UPDATE memory_jobs SET max_attempts = 1 WHERE job_id = ?").run(job.job_id);

  const now = new Date();
  const first = claimMemoryJobById(db, { jobId: job.job_id, owner: "o1", now })!;
  expect(failMemoryJob(db, {
    jobId: job.job_id, owner: "o1", leaseGeneration: first.lease_generation,
    error: "capsule patch exceeds bounded storage size", retry: true, now,
  })).toBe("dead");

  // The store's own terminal write is intact.
  expect(stateCounts("memory_jobs").dead).toBe(1);
  expect(stateCounts("capsule_checkpoint_state")).toEqual({ "failed-visible": 1 });
  // A lost CAS is still distinguishable from a transition.
  expect(failMemoryJob(db, {
    jobId: job.job_id, owner: "o1", leaseGeneration: first.lease_generation,
    error: "late", retry: true, now,
  })).toBeNull();
});

it("the worker leaves a dead capsule job's checkpoint state terminal, never back at retry", async () => {
  put("session-A", "source");
  capture("session-A");
  db.prepare("UPDATE memory_jobs SET max_attempts = 1 WHERE kind = 'capsule_update'").run();

  const result = await runContinuityWorker(db, {
    maxJobs: 1,
    model: async () => { throw new Error("capsule patch exceeds bounded storage size"); },
  });

  expect(result[0].state).toBe("dead");
  // This is the exact combination the real data root could not produce before:
  // dead job + dead-letter checkpoint + failed-visible capsule state.
  expect(stateCounts("memory_jobs")).toMatchObject({ dead: 1 });
  expect(stateCounts("checkpoints")).toMatchObject({ "dead-letter": 1 });
  expect(stateCounts("capsule_checkpoint_state")).toEqual({ "failed-visible": 1 });
  const row = db.prepare("SELECT last_error FROM capsule_checkpoint_state").get() as { last_error: string };
  expect(row.last_error).toContain("capsule patch exceeds bounded storage size");
});

it("a retryable failure still records retry on a non-terminal checkpoint state", async () => {
  put("session-A", "source");
  capture("session-A");

  const result = await runContinuityWorker(db, {
    maxJobs: 1,
    model: async () => { throw new Error("provider unavailable"); },
  });

  expect(result[0].state).toBe("retry");
  expect(stateCounts("memory_jobs")).toMatchObject({ retry: 1 });
  expect(stateCounts("capsule_checkpoint_state")).toEqual({ retry: 1 });
});

it("migration repairs an existing dead job whose capsule state was left at retry", () => {
  put("session-A", "source");
  capture("session-A");
  const checkpointId = (db.prepare(
    "SELECT checkpoint_id FROM capsule_checkpoint_state",
  ).get() as { checkpoint_id: string }).checkpoint_id;

  // Reproduce the observed rows exactly: job dead, checkpoint dead-letter,
  // capsule_checkpoint_state left at 'retry' by the old overwrite.
  db.prepare(`UPDATE memory_jobs SET state = 'dead', attempts = 5, max_attempts = 5,
      last_error = 'capsule patch exceeds bounded storage size'
    WHERE kind = 'capsule_update'`).run();
  db.prepare("UPDATE checkpoints SET state = 'dead-letter' WHERE checkpoint_id = ?").run(checkpointId);
  db.prepare(`UPDATE capsule_checkpoint_state SET state = 'retry',
      last_error = 'capsule patch exceeds bounded storage size' WHERE checkpoint_id = ?`)
    .run(checkpointId);
  expect(stateCounts("capsule_checkpoint_state")).toEqual({ retry: 1 });
  db.close();

  // Re-opening runs the additive migration, which repairs the row.
  const reopened = initDatabase();
  try {
    const repaired = reopened.prepare(
      "SELECT state, last_error FROM capsule_checkpoint_state WHERE checkpoint_id = ?",
    ).get(checkpointId) as { state: string; last_error: string };
    expect(repaired.state).toBe("failed-visible");
    // The stored cause is preserved, not replaced by the repair.
    expect(repaired.last_error).toBe("capsule patch exceeds bounded storage size");
  } finally {
    reopened.close();
  }

  // Idempotent: a second open changes nothing.
  const again = initDatabase();
  try {
    expect((again.prepare("SELECT state FROM capsule_checkpoint_state WHERE checkpoint_id = ?")
      .get(checkpointId) as { state: string }).state).toBe("failed-visible");
  } finally {
    again.close();
  }
  db = new Database(process.env.MEMEX_DB_PATH!);
});
