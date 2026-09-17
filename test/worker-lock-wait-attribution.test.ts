// Issue #162 (Codex diff review) — the worker must never name a BUSY victim as
// the lock holder.
//
// `timeWorkerTransaction` separates wait_ms (blocked, someone else held it) from
// held_ms (this process held it, everyone else waited) by having the body call
// `markStart()` as its first statement. Three of the worker's call sites could
// not do that: `applyWorkCapsulePatch`, `completeEmptyCapsuleCheckpoint` and
// `scheduleCapsuleBacklog` open their own transactions inside continuity-core,
// so the worker called `markStart()` at the CALL instead. A call that never got
// the lock and died on SQLITE_BUSY was then logged as `wait_ms: 0,
// held_ms: 477` — and `memex doctor` reads held_ms as "held the write lock for
// N ms", i.e. it accused the victim.
//
// Isolated MEMEX_HOME under a temp dir; the lock is always a REAL second
// connection holding BEGIN IMMEDIATE.
import { afterEach, beforeEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import {
  captureTranscriptPrefix,
  completeEmptyCapsuleCheckpoint,
  ensureSessionMemoryState,
  scheduleCapsuleBacklog,
} from "../src/continuity-core.js";
import { appendSessionEvidence } from "../src/continuity-evidence.js";
import { runContinuityWorker, workerTransactionLogPath } from "../src/continuity-worker.js";

const require_ = createRequire(import.meta.url);
const SESSION = "session-lock-attribution";
const vector = new Array(384).fill(0.01);

const PATCH = {
  objective: "Attribute the write lock correctly",
  currentState: "Captured work",
  verifiedProgress: [],
  hypotheses: [],
  blockers: [],
  openQuestions: [],
  nextActions: ["Separate wait from held"],
  touchedAreas: [],
  carryFactRevisions: [],
  sourceExchangeIds: [],
};

let root: string;
let dbPath: string;
let db: Database.Database;

function transcript(): string {
  return path.join(root, `${SESSION}.jsonl`);
}

function rows(): Array<{ label: string; wait_ms: number; held_ms: number; pid: number }> {
  const file = workerTransactionLogPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

/**
 * A second PROCESS holding `BEGIN IMMEDIATE`. It has to be a process: the
 * waiting side blocks its thread inside SQLite, so a timer here could never
 * fire to release the lock.
 */
function holdWriteLock(holdMs: number): { marker: string; done: Promise<void> } {
  const script = path.join(root, `hold-lock-${Date.now()}.cjs`);
  const marker = path.join(root, `locked-${Date.now()}`);
  fs.writeFileSync(
    script,
    `
const fs = require("node:fs");
const Database = require(${JSON.stringify(require_.resolve("better-sqlite3"))});
(() => {
  const db = new Database(${JSON.stringify(dbPath)});
  db.pragma("busy_timeout = 10000");
  db.exec("BEGIN IMMEDIATE");
  fs.writeFileSync(${JSON.stringify(marker)}, "1");
  setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});
})();
`,
  );
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  return { marker, done: new Promise<void>((resolve) => child.on("exit", () => resolve())) };
}

async function awaitLock(lock: { marker: string }): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(lock.marker)) {
    if (Date.now() > deadline) throw new Error("the lock holder never started");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-lock-attr-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  dbPath = path.join(root, "db.sqlite");
  process.env.MEMEX_DB_PATH = dbPath;
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  db = initDatabase();
  ensureSessionMemoryState(db, { sessionId: SESSION, project: root });
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

it("a BUSY applyWorkCapsulePatch is logged as wait, never as held", async () => {
  put("source-1");
  capture();
  // Bound the worker's own wait so the BUSY arrives while the holder still has
  // the lock, and so the wait is over the 1 s row threshold.
  db.pragma("busy_timeout = 1200");

  let lock: { marker: string; done: Promise<void> } | null = null;
  const results = await runContinuityWorker(db, {
    maxJobs: 1,
    // The model call is the only point in processCapsule between the claim and
    // applyWorkCapsulePatch that a test can hold open, and it is exactly where
    // a real worker sits while another writer takes the lock.
    model: async () => {
      lock = holdWriteLock(2_500);
      await awaitLock(lock);
      return JSON.stringify(PATCH);
    },
  });
  if (lock) await (lock as { done: Promise<void> }).done;

  expect(results[0].detail).toMatch(/SQLITE_BUSY|database is locked/i);
  const patch = rows().filter((row) => row.label === "applyWorkCapsulePatch");
  expect(patch).toHaveLength(1);
  expect(patch[0].wait_ms).toBeGreaterThan(1_000);
  expect(patch[0].held_ms).toBeLessThan(200);
}, 30_000);

/**
 * The other two own-transaction call sites are reached by `runContinuityWorker`
 * only after `ensureModelBudgetSchema`'s own immediate transaction, which dies
 * on a lock held at worker entry — so their contract is asserted directly on the
 * functions the worker calls. It is the same contract `markStart()` needs: the
 * callback fires as the FIRST statement of the real transaction body, and a call
 * that never entered the body reports nothing at all.
 */
for (const site of ["completeEmptyCapsuleCheckpoint", "scheduleCapsuleBacklog"] as const) {
  it(`${site} reports the instant the lock was granted, not the call`, async () => {
    const call = (onTransactionStart: () => void): unknown =>
      site === "completeEmptyCapsuleCheckpoint"
        ? completeEmptyCapsuleCheckpoint(db, {
            // No such job: the body returns false, but it still ENTERS — which
            // is the only thing being measured here.
            checkpointId: "missing-checkpoint",
            jobId: "missing-job",
            owner: "owner",
            leaseGeneration: 1,
            onTransactionStart,
          })
        : scheduleCapsuleBacklog(db, { onTransactionStart });

    if (site === "scheduleCapsuleBacklog") {
      // scheduleCapsuleBacklog opens a transaction only when there IS a
      // backlog: evidence past the frontier with no live capsule job.
      put("source-1");
      capture();
      appendSessionEvidence(db, SESSION);
      db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capsule_update'").run();
    }

    const lock = holdWriteLock(1_200);
    await awaitLock(lock);
    db.pragma("busy_timeout = 100");
    let enteredWhileBusy = false;
    expect(() => call(() => { enteredWhileBusy = true; })).toThrow(
      /SQLITE_BUSY|database is locked/i,
    );
    expect(enteredWhileBusy).toBe(false);
    await lock.done;

    db.pragma("busy_timeout = 5000");
    let inTransaction: boolean | null = null;
    call(() => { inTransaction = db.inTransaction; });
    expect(inTransaction).toBe(true);
  }, 30_000);
}
