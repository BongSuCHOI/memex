import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import {
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  readWorkCapsule,
  validateWorkCapsulePatchWithTruncation,
  DEFAULT_MAX_CAPSULE_CHARS,
  capsuleMaxChars,
} from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";

/**
 * Issue #17 — the 2,000-character Capsule cap killed real jobs.
 *
 * Observed on the real data root (2026-09-05..07): seven `memory_jobs` rows
 * with `kind='capsule_update'`, `state='dead'`, `attempts=5/5` and
 * `last_error='capsule patch exceeds bounded storage size'`. The cap was below
 * what the patch schema itself allows, so the model's structured summary was
 * discarded instead of stored shortened.
 *
 * These tests start from that shape — a model answer well past the cap — and
 * assert the job now converges by priority truncation, recording exactly what
 * was removed.
 */

let root: string;
let db: Database.Database;
let workstream: string;
const vector = new Array(384).fill(0.01);
const originalMaxChars = process.env.MEMEX_CAPSULE_MAX_CHARS;

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

/** Every field stays inside the per-item schema limits; only the total is large. */
function oversizedPatch(): Record<string, unknown> {
  const line = (prefix: string, index: number) => `${prefix}-${index}-${"x".repeat(480)}`;
  return {
    objective: "o".repeat(500),
    currentState: "c".repeat(500),
    verifiedProgress: Array.from({ length: 8 }, (_, i) => ({
      text: line("verified", i), sourceExchangeIds: ["source"],
    })),
    hypotheses: Array.from({ length: 8 }, (_, i) => ({
      text: line("hypothesis", i), sourceExchangeIds: ["source"],
    })),
    blockers: Array.from({ length: 8 }, (_, i) => line("blocker", i)),
    openQuestions: Array.from({ length: 8 }, (_, i) => line("question", i)),
    nextActions: Array.from({ length: 8 }, (_, i) => line("action", i)),
    touchedAreas: Array.from({ length: 8 }, (_, i) => line("area", i)),
    carryFactRevisions: Array.from({ length: 64 }, (_, i) => [`fact-${i}`, 1, 1]),
    sourceExchangeIds: ["source"],
  };
}

/** Just under the 12,000 default: nothing may be removed from this one. */
function withinBudgetPatch(): Record<string, unknown> {
  const line = (prefix: string, index: number) => `${prefix}-${index}-${"x".repeat(480)}`;
  return {
    objective: "o".repeat(500),
    currentState: "c".repeat(500),
    verifiedProgress: Array.from({ length: 8 }, (_, i) => ({
      text: line("verified", i), sourceExchangeIds: ["source"],
    })),
    hypotheses: Array.from({ length: 8 }, (_, i) => ({
      text: line("hypothesis", i), sourceExchangeIds: ["source"],
    })),
    blockers: [],
    openQuestions: [],
    nextActions: [line("action", 0), line("action", 1)],
    touchedAreas: [],
    carryFactRevisions: [],
    sourceExchangeIds: ["source"],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-capsule-size-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  delete process.env.MEMEX_CAPSULE_MAX_CHARS;
  db = initDatabase();
  workstream = ensureSessionMemoryState(db, { sessionId: "session-A", project: root }).workstreamId;
  bind("session-A");
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  if (originalMaxChars === undefined) delete process.env.MEMEX_CAPSULE_MAX_CHARS;
  else process.env.MEMEX_CAPSULE_MAX_CHARS = originalMaxChars;
  fs.rmSync(root, { recursive: true, force: true });
});

it("the default bounded storage size is 12,000 characters and MEMEX_CAPSULE_MAX_CHARS overrides it", () => {
  expect(DEFAULT_MAX_CAPSULE_CHARS).toBe(12_000);
  expect(capsuleMaxChars()).toBe(12_000);
  process.env.MEMEX_CAPSULE_MAX_CHARS = "20000";
  expect(capsuleMaxChars()).toBe(20_000);
  process.env.MEMEX_CAPSULE_MAX_CHARS = "not-a-number";
  expect(capsuleMaxChars()).toBe(12_000);
  // The floor keeps priority truncation able to reach the budget.
  process.env.MEMEX_CAPSULE_MAX_CHARS = "10";
  expect(capsuleMaxChars()).toBe(2_000);
});

it("a 20,000-character patch is truncated by priority instead of throwing", () => {
  const raw = oversizedPatch();
  expect(JSON.stringify(raw).length).toBeGreaterThan(20_000);
  const { patch, truncation } = validateWorkCapsulePatchWithTruncation(raw);
  expect(truncation.truncated).toBe(true);
  expect(truncation.originalChars).toBeGreaterThan(20_000);
  expect(truncation.finalChars).toBeLessThanOrEqual(12_000);
  expect(JSON.stringify(patch).length).toBeLessThanOrEqual(12_000);
  // objective / currentState / verifiedProgress survive; the advisory lists go first.
  expect(patch.objective).toBe("o".repeat(500));
  expect(patch.currentState).toBe("c".repeat(500));
  expect(patch.verifiedProgress.length).toBe(8);
  expect(truncation.truncatedFields).toContain("touchedAreas");
  expect(truncation.truncatedFields).not.toContain("objective");
});

it("an 11,000-character patch is stored unchanged", () => {
  const raw = withinBudgetPatch();
  const size = JSON.stringify(raw).length;
  expect(size).toBeGreaterThan(10_000);
  expect(size).toBeLessThan(12_000);
  const { patch, truncation } = validateWorkCapsulePatchWithTruncation(raw);
  expect(truncation.truncated).toBe(false);
  expect(truncation.truncatedFields).toEqual([]);
  expect(patch.hypotheses.length).toBe(8);
  expect(patch.nextActions.length).toBe(2);
});

it("the worker stores an oversized Capsule and records truncated / truncated_fields / original_chars", async () => {
  put("session-A", "source");
  capture("session-A");
  const raw = oversizedPatch();
  const originalChars = JSON.stringify(raw).length;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let result;
  try {
    result = await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(raw) });
  } finally {
    console.warn = originalWarn;
  }

  // The observed failure mode is gone: the job converges instead of dying.
  expect(result[0].state).toBe("completed");
  expect(
    db.prepare("SELECT COUNT(*) AS c FROM memory_jobs WHERE kind='capsule_update' AND state='dead'")
      .get(),
  ).toEqual({ c: 0 });

  const capsule = readWorkCapsule(db, workstream);
  expect(capsule?.generation).toBe(1);
  expect(capsule?.truncated).toBe(true);
  expect(capsule?.truncatedFields.length).toBeGreaterThan(0);
  expect(capsule?.originalChars).toBe(originalChars);
  const row = db.prepare("SELECT truncated, truncated_fields_json, original_chars FROM work_capsules WHERE workstream_id = ?")
    .get(workstream) as { truncated: number; truncated_fields_json: string; original_chars: number };
  expect(row.truncated).toBe(1);
  expect(JSON.parse(row.truncated_fields_json).length).toBeGreaterThan(0);
  expect(row.original_chars).toBe(originalChars);

  // One WARN line, naming the env var that controls the budget.
  const warned = warnings.filter((line) => line.includes("capsule patch truncated"));
  expect(warned.length).toBe(1);
  expect(warned[0]).toContain("MEMEX_CAPSULE_MAX_CHARS");
  expect(warned[0]).toContain(String(originalChars));
});

it("even the old 2,000-character budget now truncates instead of killing the job", async () => {
  process.env.MEMEX_CAPSULE_MAX_CHARS = "2000";
  put("session-A", "source");
  capture("session-A");
  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await runContinuityWorker(db, {
      maxJobs: 1, model: async () => JSON.stringify(oversizedPatch()),
    });
  } finally {
    console.warn = originalWarn;
  }
  expect(result[0].state).toBe("completed");
  expect(result[0].detail).not.toContain("exceeds bounded storage size");
  const capsule = readWorkCapsule(db, workstream);
  expect(capsule?.truncated).toBe(true);
  expect(JSON.stringify({
    objective: capsule?.objective, currentState: capsule?.currentState,
    verifiedProgress: capsule?.verifiedProgress, hypotheses: capsule?.hypotheses,
    blockers: capsule?.blockers, openQuestions: capsule?.openQuestions,
    nextActions: capsule?.nextActions, touchedAreas: capsule?.touchedAreas,
    carryFactRevisions: capsule?.carryFactRevisions, sourceExchangeIds: capsule?.sourceExchangeIds,
  }).length).toBeLessThanOrEqual(2_000);
});
