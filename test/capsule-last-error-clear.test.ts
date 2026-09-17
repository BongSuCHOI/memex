// Issue #157 — a success ends the failure it followed.
//
// Observed on the work Mac (0.7.21): a capsule_update job that had succeeded
// eight pages in a row still showed
// `lastError: "capsule evidence sources must be declared in sourceExchangeIds"`
// on a `pending`, `attempts: 0` row, while its own capsule_checkpoint_state
// reported `lastError: null`. `completeMemoryJob` left `last_error` in place,
// and the partial-success reopen UPDATE (src/continuity-core.ts) did not clear
// it either, so the message outlived the failure forever.
//
// The failure history itself is not what this clears: `retry_history` and the
// recovery audit keep it.
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import {
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  scheduleCapsuleBacklog,
} from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";

let root: string;
let db: Database.Database;
let workstream: string;
const vector = new Array(384).fill(0.01);
const SESSION = "session-157";

const PATCH = {
  objective: "Maintain continuity",
  currentState: "Captured work",
  verifiedProgress: [],
  hypotheses: [],
  blockers: [],
  openQuestions: [],
  nextActions: ["Verify the next step"],
  touchedAreas: [],
  carryFactRevisions: [],
  sourceExchangeIds: [],
};

function transcript(): string {
  return path.join(root, `${SESSION}.jsonl`);
}

function put(id: string): void {
  insertExchange(
    db,
    {
      id,
      sessionId: SESSION,
      project: root,
      cwd: root,
      archivePath: transcript(),
      timestamp: new Date().toISOString(),
      userMessage: id,
      assistantMessage: "",
      lineStart: 2,
      lineEnd: 2,
    },
    vector,
  );
}

function capture(): void {
  fs.appendFileSync(
    transcript(),
    JSON.stringify({ type: "event_msg", payload: { type: "note", text: "x" } }) + "\n",
  );
  captureTranscriptPrefix(db, {
    sessionId: SESSION,
    project: root,
    transcriptPath: transcript(),
    kind: "final",
  });
  // P0 ingestion is covered elsewhere; the rows above stand in for it so the
  // only claimable lane here is the capsule one.
  db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
}

function capsuleJob(): {
  job_id: string;
  state: string;
  attempts: number;
  last_error: string | null;
} {
  return db
    .prepare(
      "SELECT job_id, state, attempts, last_error FROM memory_jobs WHERE kind = 'capsule_update'",
    )
    .get() as { job_id: string; state: string; attempts: number; last_error: string | null };
}

/** Undeclared evidence sources: the exact failure class the issue reported. */
const UNDECLARED_SOURCES = async () =>
  JSON.stringify({
    ...PATCH,
    sourceExchangeIds: [],
    hypotheses: [{ text: "Unverified proposal", sourceExchangeIds: ["source-1"] }],
  });

beforeEach(() => {
  // Isolated data root: this suite must never resolve the real one.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-157-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  db = initDatabase();
  workstream = ensureSessionMemoryState(db, { sessionId: SESSION, project: root }).workstreamId;
  fs.writeFileSync(
    transcript(),
    JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: root } }) + "\n",
  );
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

it("a succeeding capsule page clears the previous attempt's last_error, and the reopened job stays clean (#157)", async () => {
  put("source-1");
  capture();

  // 1) One real failure, recorded the way the issue observed it.
  const failed = await runContinuityWorker(db, { maxJobs: 1, model: UNDECLARED_SOURCES });
  expect(failed[0].state).toBe("retry");
  const afterFailure = capsuleJob();
  expect(afterFailure.state).toBe("retry");
  expect(afterFailure.last_error).toContain(
    "capsule evidence sources must be declared in sourceExchangeIds",
  );

  // 2) The next attempt succeeds (the backoff has elapsed). completeMemoryJob is
  //    the only thing that may clear the message — assert it BEFORE any reopen,
  //    so this case cannot be satisfied by the reopen UPDATE alone.
  const later = new Date(Date.now() + 60 * 60_000);
  const succeeded = await runContinuityWorker(db, {
    maxJobs: 1,
    now: later,
    model: async () => JSON.stringify(PATCH),
  });
  expect(succeeded[0].state).toBe("completed");
  const afterSuccess = capsuleJob();
  expect(afterSuccess.state).toBe("completed");
  expect(afterSuccess.last_error).toBeNull();

  // 3) Evidence arrives past the frontier, so the same job is reopened for the
  //    next page — the state the issue's `memex jobs show` was reporting.
  put("source-2");
  scheduleCapsuleBacklog(db);
  const reopened = capsuleJob();
  expect(reopened.job_id).toBe(afterSuccess.job_id);
  expect(reopened.state).toBe("pending");
  expect(reopened.attempts).toBe(0);
  expect(reopened.last_error).toBeNull();

  // The checkpoint projection and the job now agree, which was the contradiction.
  const checkpointState = db
    .prepare(
      "SELECT last_error FROM capsule_checkpoint_state WHERE workstream_id = ?",
    )
    .get(workstream) as { last_error: string | null } | undefined;
  expect(checkpointState?.last_error ?? null).toBeNull();
});

it("a genuinely failed attempt still records its last_error (#157)", async () => {
  put("source-1");
  capture();

  const results = await runContinuityWorker(db, {
    maxJobs: 1,
    model: async () => {
      throw new Error("provider exploded mid-page");
    },
  });
  expect(results[0].state).toBe("retry");
  const job = capsuleJob();
  expect(job.state).toBe("retry");
  expect(job.last_error).toContain("provider exploded mid-page");
  expect(job.attempts).toBeGreaterThan(0);
});
