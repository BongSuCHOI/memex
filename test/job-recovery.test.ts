import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { captureTranscriptPrefix, ensureSessionMemoryState } from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { getPipelineStatus, formatPipelineStatus } from "../src/pipeline-status.js";
import {
  dismissMemoryJob,
  listMemoryJobs,
  recoverTerminalWork,
  showMemoryJob,
} from "../src/job-recovery.js";

/**
 * Issues #20 / #39 — terminal work had no recovery path.
 *
 * Observed on the real data root (v0.5.2): seven `capsule_update` jobs `dead`
 * at attempts=5/5 with `last_error = 'capsule patch exceeds bounded storage
 * size'` since 2026-09-05, seven `checkpoints` at `dead-letter`, and an
 * overview warning ("확인이 필요한 작업 7개") whose only action was a link to a
 * read-only view. Seven of the eight terminal states had no recovery command at
 * all, and they are written together in one transaction — so recovering only
 * `memory_jobs` would leave the work stuck anyway.
 *
 * Every fixture below is wall-clock independent: `new Date()`-relative only.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let root: string;
let db: Database.Database;
let workstream: string;
const vector = new Array(384).fill(0.01);
const DEAD_ERROR = "capsule patch exceeds bounded storage size";

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
    timestamp: new Date().toISOString(), userMessage: id, assistantMessage: "ok",
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

/** Drive the real worker to the observed dead state for one capsule job. */
async function deadCapsuleJob(session: string, exchangeId: string): Promise<string> {
  put(session, exchangeId);
  capture(session);
  db.prepare("UPDATE memory_jobs SET max_attempts = 1 WHERE kind = 'capsule_update' AND state = 'pending'").run();
  await runContinuityWorker(db, {
    maxJobs: 1,
    model: async () => { throw new Error(DEAD_ERROR); },
  });
  return (db.prepare(
    "SELECT job_id FROM memory_jobs WHERE kind = 'capsule_update' AND state = 'dead' ORDER BY updated_at DESC LIMIT 1",
  ).get() as { job_id: string }).job_id;
}

/**
 * Reproduce the six-table extraction terminal unit that
 * `continuity-store.ts` writes together when attempts are exhausted.
 */
function deadExtractionUnit(): { jobId: string; targetId: string } {
  const now = new Date().toISOString();
  const sessionId = "session-extract";
  const targetId = "target-dead-1";
  const jobId = "job-extract-dead-1";
  const checkpointId = "cp-extract-dead-1";
  bind(sessionId);
  put(sessionId, "extract-exchange-1");
  const rowid = (db.prepare("SELECT rowid FROM exchanges WHERE id = ?").get("extract-exchange-1") as { rowid: number }).rowid;
  const generation = (db.prepare("SELECT content_generation FROM exchanges WHERE id = ?")
    .get("extract-exchange-1") as { content_generation: number }).content_generation;
  db.prepare(`INSERT INTO checkpoints
      (checkpoint_id, session_id, ordinal, kind, state, idempotency_key, created_at)
    VALUES (?, ?, 1, 'extraction', 'failed-visible', ?, ?)`)
    .run(checkpointId, sessionId, `${checkpointId}-key`, now);
  db.prepare(`INSERT INTO extraction_targets
      (target_id, session_id, project, from_rowid, through_rowid, item_count,
       policy_version, state, attempts, last_error, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 'p', 'dead', 5, 'extraction model exploded', ?, ?, ?)`)
    .run(targetId, sessionId, root, rowid, rowid, `${targetId}-key`, now, now);
  db.prepare(`INSERT INTO extraction_target_items
      (target_id, ordinal, exchange_id, exchange_rowid, content_generation, content_hash, state)
    VALUES (?, 1, 'extract-exchange-1', ?, ?, 'hash', 'failed-visible')`)
    .run(targetId, rowid, generation);
  db.prepare(`INSERT INTO exchange_extraction_state
      (exchange_id, content_generation, policy_version, state, target_id)
    VALUES ('extract-exchange-1', ?, 'p', 'failed-visible', ?)`)
    .run(generation, targetId);
  db.prepare(`INSERT INTO extraction_failed_ranges
      (failure_id, target_id, from_ordinal, through_ordinal, from_rowid, through_rowid,
       payload_fingerprint, error_kind, error_message, state, created_at, updated_at)
    VALUES ('failure-1', ?, 1, 1, ?, ?, 'fp', 'model', 'extraction model exploded', 'failed-visible', ?, ?)`)
    .run(targetId, rowid, rowid, now, now);
  db.prepare(`INSERT INTO memory_jobs
      (job_id, kind, partition_key, checkpoint_id, target_id, policy_version, priority,
       state, available_at, attempts, max_attempts, last_error, idempotency_key, created_at, updated_at)
    VALUES (?, 'fact_extract', ?, ?, ?, 'p', 10, 'dead', ?, 5, 5, 'extraction model exploded', ?, ?, ?)`)
    .run(jobId, `session:${sessionId}`, checkpointId, targetId, now, `${jobId}-key`, now, now);
  return { jobId, targetId };
}

function stateCounts(table: string): Record<string, number> {
  return Object.fromEntries((db.prepare(`SELECT state, COUNT(*) AS c FROM ${table} GROUP BY state`)
    .all() as Array<{ state: string; c: number }>).map((row) => [row.state, row.c]));
}

function attention() {
  return getPipelineStatus({ db }).attention;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-job-recovery-"));
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

it("memex status counts the dead jobs the overview warned about, and lists every terminal state", async () => {
  await deadCapsuleJob("session-A", "capsule-source-1");
  deadExtractionUnit();

  const before = attention();
  expect(before.memoryJobsDead).toBe(2);
  expect(before.total).toBe(2);
  expect(before.terminal).toMatchObject({
    checkpointsDeadLetter: 1,
    checkpointsFailedVisible: 1,
    extractionTargetsDead: 1,
    extractionTargetItemsFailedVisible: 1,
    capsuleCheckpointFailedVisible: 1,
    extractionFailedRanges: 1,
  });
  const text = formatPipelineStatus(getPipelineStatus({ db }));
  expect(text).toContain("Needs attention: 2");
  expect(text).toContain("memex recover --all-dead");
});

it("jobs list and show expose the dead job with its stored cause", async () => {
  const jobId = await deadCapsuleJob("session-A", "capsule-source-1");

  const dead = listMemoryJobs(db, { state: "dead" });
  expect(dead.map((job) => job.jobId)).toEqual([jobId]);
  expect(dead[0].lastError).toBe(DEAD_ERROR);
  expect(dead[0].attempts).toBe(dead[0].maxAttempts);

  const detail = showMemoryJob(db, jobId)!;
  expect(detail.kind).toBe("capsule_update");
  expect(detail.checkpoint?.state).toBe("dead-letter");
  expect(detail.capsuleCheckpointState?.state).toBe("failed-visible");
  expect(detail.retryHistory).toEqual([]);
  expect(showMemoryJob(db, "no-such-job")).toBeNull();
});

it("recover resets the whole terminal unit in one transaction and clears the attention count", () => {
  const { jobId, targetId } = deadExtractionUnit();
  expect(attention().total).toBe(1);

  const result = recoverTerminalWork(db, { jobId });
  expect(result.dryRun).toBe(false);
  expect(result.entries).toHaveLength(1);
  // All six tables the terminal transaction wrote are reset together (#39).
  expect(Object.keys(result.entries[0].reset).sort()).toEqual([
    "checkpoints",
    "exchange_extraction_state",
    "extraction_failed_ranges",
    "extraction_target_items",
    "extraction_targets",
    "memory_jobs",
  ]);

  expect(stateCounts("memory_jobs")).toMatchObject({ pending: 1 });
  expect(stateCounts("extraction_targets")).toEqual({ pending: 1 });
  expect(stateCounts("extraction_target_items")).toEqual({ pending: 1 });
  expect(stateCounts("exchange_extraction_state")).toEqual({ pending: 1 });
  expect(stateCounts("extraction_failed_ranges")).toEqual({ retry: 1 });
  expect(
    (db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = 'cp-extract-dead-1'")
      .get() as { state: string }).state,
  ).toBe("pending");
  expect(
    (db.prepare("SELECT attempts, lease_owner, last_error FROM memory_jobs WHERE job_id = ?")
      .get(jobId) as { attempts: number; lease_owner: string | null; last_error: string | null }),
  ).toEqual({ attempts: 0, lease_owner: null, last_error: null });

  // The failure is preserved, not erased.
  const detail = showMemoryJob(db, jobId)!;
  expect(detail.retryHistory).toHaveLength(1);
  expect(detail.retryHistory[0]).toMatchObject({
    fromState: "dead", attempts: 5, lastError: "extraction model exploded", action: "retry",
  });
  expect(detail.target?.state).toBe("pending");
  expect(attention().total).toBe(0);
  expect(attention().terminal.extractionTargetsDead).toBe(0);
  expect(targetId).toBe("target-dead-1");
});

it("recover --all-dead handles capsule and extraction units together; --dry-run writes nothing", async () => {
  await deadCapsuleJob("session-A", "capsule-source-1");
  deadExtractionUnit();

  const plan = recoverTerminalWork(db, { allDead: true, dryRun: true });
  expect(plan.dryRun).toBe(true);
  expect(plan.entries).toHaveLength(2);
  expect(attention().total).toBe(2);
  expect(stateCounts("memory_jobs").dead).toBe(2);

  const applied = recoverTerminalWork(db, { allDead: true });
  expect(applied.entries).toHaveLength(2);
  expect(attention().total).toBe(0);
  expect(stateCounts("memory_jobs").dead).toBeUndefined();
  // The recovered capsule checkpoint is claimable again, with the #33 page
  // hint and frozen target cleared.
  expect(db.prepare("SELECT state, page_items_hint, target_seq FROM capsule_checkpoint_state").get())
    .toEqual({ state: "pending", page_items_hint: null, target_seq: null });
});

it("dismiss supersedes the job, records the reason, writes an audit line, and drops the count", async () => {
  const jobId = await deadCapsuleJob("session-A", "capsule-source-1");
  expect(attention().total).toBe(1);

  const result = dismissMemoryJob(db, { jobId, reason: "capsule content no longer relevant" });
  expect(result.fromState).toBe("dead");
  expect(stateCounts("memory_jobs")).toMatchObject({ superseded: 1 });
  const row = db.prepare("SELECT state, last_error FROM memory_jobs WHERE job_id = ?").get(jobId) as
    { state: string; last_error: string };
  expect(row.state).toBe("superseded");
  expect(row.last_error).toBe("user dismissed: capsule content no longer relevant");
  expect(attention().total).toBe(0);

  const audit = fs.readFileSync(path.join(process.env.MEMEX_HOME!, "logs", "ui-audit.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  expect(audit.at(-1)).toMatchObject({ source: "memex-cli", action: "jobs dismiss", id: jobId, status: "ok" });
  // Metadata only: the reason text itself never reaches the audit log.
  expect(JSON.stringify(audit.at(-1))).not.toContain("no longer relevant");
  // The dismissal is preserved in retry_history.
  expect(showMemoryJob(db, jobId)!.retryHistory.at(-1)).toMatchObject({ action: "dismiss", fromState: "dead" });
});

it("refuses to recover or dismiss the wrong state and unknown ids", async () => {
  put("session-A", "pending-source");
  capture("session-A");
  const pending = (db.prepare("SELECT job_id FROM memory_jobs WHERE kind = 'capsule_update'")
    .get() as { job_id: string }).job_id;

  expect(() => recoverTerminalWork(db, { jobId: pending })).toThrow(/is 'pending'; only 'dead'/);
  expect(() => recoverTerminalWork(db, { jobId: "no-such-id" })).toThrow(/no memory job or extraction target/);
  expect(() => recoverTerminalWork(db, {})).toThrow(/requires a job id/);
  expect(() => dismissMemoryJob(db, { jobId: "no-such-id", reason: "x" })).toThrow(/no memory job with id/);
  expect(() => dismissMemoryJob(db, { jobId: pending, reason: "  " })).toThrow(/requires --reason/);
});

it("the CLI drives the same recovery and refuses a job id it cannot recover", async () => {
  const jobId = await deadCapsuleJob("session-A", "capsule-source-1");
  db.close();
  const env = {
    ...process.env,
    MEMEX_HOME: process.env.MEMEX_HOME!,
    MEMEX_DB_PATH: process.env.MEMEX_DB_PATH!,
  };
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [path.join(REPO, "cli", "memex.js"), ...args], { env, encoding: "utf8" });

  expect(run("jobs", "list", "--state", "dead")).toContain(jobId);
  expect(run("recover", jobId, "--dry-run")).toContain("[dry-run] would recover: 1 unit(s)");
  expect(run("recover", jobId)).toContain("Recovered: 1 unit(s)");
  expect(() => run("recover", jobId)).toThrow();
  expect(run("status")).toContain("Needs attention: 0");
  db = initDatabase();
});
