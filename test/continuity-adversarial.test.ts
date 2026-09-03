import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings.js")>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => new Array(384).fill(0.01),
  };
});

import { initDatabase, insertExchange } from "../src/db.js";
import {
  applyWorkCapsulePatch,
  buildRehydrationContext,
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  handleContinuityHook,
  readResidentFactRevisions,
} from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";
import type { ConversationExchange } from "../src/types.js";

const SESSION = "continuity-adversarial-session";
const PROJECT = "/project/adversarial";
let root: string;
let sessions: string;
let transcript: string;
let db: Database.Database;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function hook(event: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    transcript_path: transcript,
    cwd: PROJECT,
    hook_event_name: event,
    ...extra,
  };
}

function appendTurn(index: number): void {
  fs.appendFileSync(transcript, line({
    timestamp: `2026-09-03T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `turn ${index}: continue continuity implementation` }],
    },
  }));
  fs.appendFileSync(transcript, line({
    timestamp: `2026-09-03T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `turn ${index} complete` }],
    },
  }));
}

function putExchange(id = "capsule-exchange", lineStart = 2): void {
  const exchange: ConversationExchange = {
    id,
    project: PROJECT,
    cwd: PROJECT,
    timestamp: "2026-09-03T00:00:00Z",
    userMessage: "Keep continuity state precise",
    assistantMessage: "Next: run the adversarial matrix",
    archivePath: transcript,
    lineStart,
    lineEnd: lineStart + 1,
    sessionId: SESSION,
    closureState: "closed",
    contentGeneration: 1,
    parserVersion: 2,
  };
  insertExchange(db, exchange, new Array(384).fill(0.01));
}

const capsulePatch = {
  objective: "Implement Continuity Core",
  currentState: "Adversarial verification",
  verifiedProgress: [{ text: "User requested continuity", sourceExchangeIds: ["capsule-exchange"] }],
  hypotheses: [],
  blockers: [],
  openQuestions: [],
  nextActions: ["Run gate"],
  touchedAreas: ["src/continuity-core.ts"],
  carryFactRevisions: [],
  sourceExchangeIds: ["capsule-exchange"],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-continuity-adversarial-"));
  sessions = path.join(root, "sessions");
  transcript = path.join(sessions, "rollout-adversarial.jsonl");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(transcript, line({
    type: "session_meta",
    payload: { id: SESSION, cwd: PROJECT },
  }));
  process.env.MEMEX_HOME = path.join(root, "memex-home");
  process.env.MEMEX_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = sessions;
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Phase 2 long-session adversarial matrix", () => {
  it("captures and accounts for 200 turns, eight compactions, interrupts, and duplicates without full-copy accounting", async () => {
    putExchange("long-session-context");
    let appendedBytes = 0;
    let compactCount = 0;
    const autoAt = new Set([25, 50, 75, 100, 125, 150]);
    const manualAt = new Set([175, 200]);
    for (let turn = 1; turn <= 200; turn++) {
      appendTurn(turn);
      if (turn % 40 === 0) {
        const interrupted = handleContinuityHook(hook("Interrupt", { turn_id: `turn-${turn}` }), { db });
        appendedBytes += interrupted.capture?.appendedBytes ?? 0;
      }
      const stopped = handleContinuityHook(hook("Stop", { turn_id: `turn-${turn}` }), { db });
      appendedBytes += stopped.capture?.appendedBytes ?? 0;
      const duplicate = handleContinuityHook(hook("Stop", { turn_id: `turn-${turn}` }), { db });
      expect(duplicate.capture?.checkpointId).toBe(stopped.capture?.checkpointId);
      expect(duplicate.capture?.created).toBe(false);

      if (autoAt.has(turn) || manualAt.has(turn)) {
        const trigger = autoAt.has(turn) ? "auto" : "manual";
        const pre = handleContinuityHook(hook("PreCompact", {
          turn_id: `turn-${turn}`,
          trigger,
        }), { db });
        const preDuplicate = handleContinuityHook(hook("PreCompact", {
          turn_id: `turn-${turn}`,
          trigger,
        }), { db });
        expect(preDuplicate.capture?.checkpointId).toBe(pre.capture?.checkpointId);
        const compact = handleContinuityHook(hook("SessionStart", {
          turn_id: `turn-${turn}`,
          source: "compact",
        }), { db });
        expect(compact.stdout).toContain("WORK NOW");
        compactCount += 1;
      }
    }

    // Same turn, later prefix: a second compact must be a different checkpoint.
    fs.appendFileSync(transcript, line({ type: "event_msg", payload: { type: "token_count", stage: "first" } }));
    const first = handleContinuityHook(hook("PreCompact", {
      turn_id: "double-compact",
      trigger: "manual",
    }), { db });
    appendedBytes += first.capture?.appendedBytes ?? 0;
    fs.appendFileSync(transcript, line({ type: "event_msg", payload: { type: "token_count", stage: "second" } }));
    const second = handleContinuityHook(hook("PreCompact", {
      turn_id: "double-compact",
      trigger: "manual",
    }), { db });
    appendedBytes += second.capture?.appendedBytes ?? 0;
    expect(second.capture?.checkpointId).not.toBe(first.capture?.checkpointId);

    const final = handleContinuityHook(hook("SessionEnd", { reason: "complete" }), { db });
    appendedBytes += final.capture?.appendedBytes ?? 0;
    expect(appendedBytes).toBe(fs.statSync(transcript).size);
    expect(fs.statSync(final.capture!.journalPath).size).toBe(fs.statSync(transcript).size);
    expect(readResidentFactRevisions(db, SESSION).contextEpoch).toBe(compactCount);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE kind = 'interrupt'").get())
      .toEqual({ n: 5 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE kind = 'precompact'").get())
      .toEqual({ n: 10 });
    const jobs = db.prepare(`
      SELECT kind, COUNT(*) AS n FROM memory_jobs GROUP BY kind ORDER BY kind
    `).all() as Array<{ kind: string; n: number }>;
    expect(jobs.find((row) => row.kind === "capture_index")?.n).toBeGreaterThanOrEqual(200);
    // Stop boundaries are coalesced; mandatory compact/final boundaries remain explicit.
    expect(jobs.find((row) => row.kind === "capsule_update")?.n).toBeLessThanOrEqual(12);
    expect(db.prepare("SELECT COUNT(*) AS n FROM capture_gaps").get()).toEqual({ n: 0 });

    // Drain every exact captured prefix through P0 without touching the P1
    // model lane. This makes the long-session acceptance observable at the
    // exchange boundary rather than proving only that queue rows exist.
    while ((db.prepare(`
      SELECT COUNT(*) AS n FROM memory_jobs
      WHERE kind = 'capture_index' AND state IN ('pending','retry')
    `).get() as { n: number }).n > 0) {
      const [result] = await runContinuityWorker(db, { maxJobs: 1 });
      expect(result).toMatchObject({ kind: "capture_index", state: "completed" });
    }
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM memory_jobs
      WHERE kind = 'capture_index' AND state <> 'completed'
    `).get()).toEqual({ n: 0 });
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM exchanges
      WHERE session_id = ? AND id <> 'long-session-context'
        AND closure_state IN ('closed','final')
    `).get(SESSION)).toEqual({ n: 200 });
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM exchanges
      WHERE session_id = ? AND id <> 'long-session-context'
        AND closure_state NOT IN ('closed','final')
    `).get(SESSION)).toEqual({ n: 0 });
  });

  it("detects a journal hash mismatch and leaves the exact capture job retryable", async () => {
    appendTurn(1);
    const capture = captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "final",
    });
    const journal = fs.readFileSync(capture.journalPath);
    journal[journal.length - 2] ^= 1;
    fs.writeFileSync(capture.journalPath, journal);
    const result = await runContinuityWorker(db, { maxJobs: 1 });
    expect(result).toEqual([
      expect.objectContaining({ kind: "capture_index", state: "retry", detail: expect.stringMatching(/hash mismatch/) }),
    ]);
    expect(db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?").get(capture.captureIndexJobId))
      .toEqual({ state: "retry" });
    expect(db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = ?").get(capture.checkpointId))
      .toEqual({ state: "retry" });
  });

  it("makes exhausted capture retries dead-visible with no stranded Capsule job", async () => {
    appendTurn(1);
    const capture = captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "final",
    });
    const journal = fs.readFileSync(capture.journalPath);
    journal[journal.length - 2] ^= 1;
    fs.writeFileSync(capture.journalPath, journal);
    for (let attempt = 0; attempt < 5; attempt++) {
      const [result] = await runContinuityWorker(db, { maxJobs: 1 });
      expect(result).toMatchObject({
        kind: "capture_index",
        state: attempt === 4 ? "dead" : "retry",
      });
      db.prepare("UPDATE memory_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE job_id = ?")
        .run(capture.captureIndexJobId);
    }
    expect(db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?")
      .get(capture.captureIndexJobId)).toEqual({ state: "dead" });
    expect(db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?")
      .get(capture.capsuleJobId)).toEqual({ state: "dead" });
    expect(db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = ?")
      .get(capture.checkpointId)).toEqual({ state: "dead-letter" });
    expect(db.prepare("SELECT state FROM capsule_checkpoint_state WHERE checkpoint_id = ?")
      .get(capture.checkpointId)).toEqual({ state: "failed-visible" });
  });

  it("uses lifecycle evidence for Interrupt open versus Stop closed", async () => {
    appendTurn(1);
    captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "interrupt",
    });
    const interruptedResult = (await runContinuityWorker(db, { maxJobs: 1 }))[0];
    expect(interruptedResult).toMatchObject({
      kind: "capture_index",
      state: "completed",
    });
    expect(db.prepare(`
      SELECT closure_state FROM exchanges WHERE session_id = ? ORDER BY line_end DESC LIMIT 1
    `).get(SESSION)).toEqual({ closure_state: "interrupted" });

    appendTurn(2);
    captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "stop",
    });
    expect((await runContinuityWorker(db, { maxJobs: 1 }))[0]).toMatchObject({
      kind: "capture_index",
      state: "completed",
    });
    expect(db.prepare(`
      SELECT closure_state FROM exchanges WHERE session_id = ? ORDER BY line_end DESC LIMIT 1
    `).get(SESSION)).toEqual({ closure_state: "closed" });
  });

  it("cannot recreate exchanges when privacy purge wins during capture indexing", async () => {
    appendTurn(1);
    const capture = captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "final",
    });
    const result = await runContinuityWorker(db, {
      maxJobs: 1,
      beforePrefixIngest: () => purgeConversationFromIndex(db, {
        archivePath: capture.journalPath,
        sessionId: SESSION,
      }),
    });
    expect(result).toEqual([
      expect.objectContaining({
        kind: "capture_index",
        state: "completed",
        detail: "purged user-excluded conversation",
      }),
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?").get(SESSION))
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE checkpoint_id = ?")
      .get(capture.checkpointId)).toEqual({ n: 0 });
    expect(db.prepare("SELECT reason FROM conversation_exclusions WHERE session_id = ?")
      .get(SESSION)).toEqual({ reason: "source_conversation_excluded" });
  });

  it("rejects a stale Capsule completion atomically and keeps the tail baton available", async () => {
    appendTurn(1);
    putExchange();
    const earlier = captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "precompact",
    });
    const state = ensureSessionMemoryState(db, { sessionId: SESSION, project: PROJECT });
    expect(applyWorkCapsulePatch(db, {
      workstreamId: state.workstreamId,
      expectedGeneration: 0,
      throughCheckpointId: earlier.checkpointId,
      patch: capsulePatch,
    })?.generation).toBe(1);
    db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE job_id = ?")
      .run(earlier.capsuleJobId);
    appendTurn(2);
    putExchange("capsule-exchange-2", 4);
    const capture = captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "final",
    });
    db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
    const model = vi.fn(async () => {
      const competing = applyWorkCapsulePatch(db, {
        workstreamId: state.workstreamId,
        expectedGeneration: 1,
        throughCheckpointId: earlier.checkpointId,
        patch: { ...capsulePatch, currentState: "Concurrent authoritative advance" },
      });
      expect(competing?.generation).toBe(2);
      return JSON.stringify({ ...capsulePatch, currentState: "stale model result" });
    });
    const result = await runContinuityWorker(db, { maxJobs: 1, model });
    expect(result).toEqual([
      expect.objectContaining({ kind: "capsule_update", state: "stale" }),
    ]);
    expect(db.prepare("SELECT current_state, generation FROM work_capsules").get())
      .toEqual({ current_state: "Concurrent authoritative advance", generation: 2 });
    expect(db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?").get(capture.capsuleJobId))
      .toEqual({ state: "retry" });
    expect(buildRehydrationContext(db, { sessionId: SESSION }).context)
      .toContain("Concurrent authoritative advance");
  });

  it("keeps a failed Capsule retryable while deterministic tail context survives", async () => {
    appendTurn(1);
    putExchange();
    const capture = captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: PROJECT,
      transcriptPath: transcript,
      kind: "final",
    });
    db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
    const result = await runContinuityWorker(db, {
      maxJobs: 1,
      model: async () => "not exact JSON",
    });
    expect(result).toEqual([
      expect.objectContaining({ kind: "capsule_update", state: "retry" }),
    ]);
    expect(db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?").get(capture.capsuleJobId))
      .toEqual({ state: "retry" });
    const context = buildRehydrationContext(db, { sessionId: SESSION }).context;
    expect(context).toContain("DETERMINISTIC TAIL BATON");
    expect(context).toContain("Keep continuity state precise");
  });
});
