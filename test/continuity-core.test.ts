import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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
  advanceContextEpoch,
  applyWorkCapsulePatch,
  buildDeterministicTailBaton,
  buildRehydrationContext,
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  handleContinuityHook,
  normalizeHookPayload,
  readResidentFactRevisions,
  recordResidentFactRevisions,
  validateTranscriptPath,
  validateWorkCapsulePatch,
} from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";
import type { ConversationExchange } from "../src/types.js";
import type Database from "better-sqlite3";

let root: string;
let sessions: string;
let transcript: string;
let db: Database.Database;

function rollout(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function basicRollout(sessionId = "session-core-1"): string {
  return rollout([
    { type: "session_meta", payload: { id: sessionId, cwd: "/project" } },
    { type: "response_item", timestamp: "2026-09-03T00:00:00Z", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: "Implement the durable journal" }],
    } },
    { type: "response_item", timestamp: "2026-09-03T00:00:01Z", payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: "Next: run the crash test" }],
    } },
  ]);
}

function hook(event: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: "session-core-1",
    transcript_path: transcript,
    cwd: "/project",
    hook_event_name: event,
    turn_id: "turn-1",
    ...extra,
  };
}

function putExchange(id = "exchange-core-1", generation = 1): void {
  const exchange: ConversationExchange = {
    id,
    project: "/project",
    cwd: "/project",
    timestamp: "2026-09-03T00:00:00Z",
    userMessage: "Implement the durable journal",
    assistantMessage: "Next: run the crash test",
    archivePath: transcript,
    lineStart: 2,
    lineEnd: 3,
    sessionId: "session-core-1",
    closureState: "closed",
    contentGeneration: generation,
    parserVersion: 2,
  };
  insertExchange(db, exchange, new Array(384).fill(0.01));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-continuity-core-"));
  sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  transcript = path.join(sessions, "rollout-session-core-1.jsonl");
  fs.writeFileSync(transcript, basicRollout());
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

describe("rolling journal and checkpoint capture", () => {
  it("copies only new complete bytes and defers a trailing partial line", () => {
    const first = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "stop", turnId: "turn-1",
    });
    expect(first.sourceFromByte).toBe(0);
    expect(first.appendedBytes).toBe(fs.statSync(transcript).size);
    expect(fs.readFileSync(first.journalPath, "utf8")).toBe(basicRollout());

    fs.appendFileSync(transcript, '{"type":"response_item"');
    const partial = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "precompact", turnId: "turn-1",
    });
    expect(partial.appendedBytes).toBe(0);
    expect(partial.sourceThroughByte).toBe(first.sourceThroughByte);
    expect(partial.checkpointId).not.toBe(first.checkpointId);

    fs.appendFileSync(transcript, ',"payload":{"type":"reasoning"}}\n');
    const completed = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "stop", turnId: "turn-1",
    });
    expect(completed.sourceFromByte).toBe(first.sourceThroughByte);
    expect(completed.appendedBytes).toBeGreaterThan(0);
    expect(fs.statSync(completed.journalPath).size).toBe(completed.sourceThroughByte);
    expect(db.prepare("SELECT COUNT(*) AS n FROM journal_blocks").get()).toEqual({ n: 2 });
  });

  it("makes duplicate delivery idempotent and growing same-turn compact distinct", () => {
    const first = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "precompact", turnId: "turn-1",
    });
    const duplicate = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "precompact", turnId: "turn-1",
    });
    expect(duplicate.checkpointId).toBe(first.checkpointId);
    expect(duplicate.created).toBe(false);
    fs.appendFileSync(transcript, rollout([{ type: "event_msg", payload: { type: "token_count" } }]));
    const grown = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "precompact", turnId: "turn-1",
    });
    expect(grown.checkpointId).not.toBe(first.checkpointId);
  });

  it("starts a new stream epoch on truncation/replacement without rewinding old evidence", () => {
    const first = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    fs.writeFileSync(transcript, rollout([{ type: "session_meta", payload: { id: "session-core-1", cwd: "/project" } }]));
    const second = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    expect(second.streamEpoch).toBe(1);
    expect(first.journalPath).not.toBe(second.journalPath);
    expect(fs.existsSync(first.journalPath)).toBe(true);
    expect(db.prepare("SELECT state FROM journal_streams WHERE stream_epoch = 0").get())
      .toEqual({ state: "replaced" });
  });

  it("treats a same-inode same-size rewrite as a new stream epoch", () => {
    const first = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    const rewritten = basicRollout().replace("durable", "changed");
    expect(Buffer.byteLength(rewritten)).toBe(fs.statSync(transcript).size);
    fs.writeFileSync(transcript, rewritten);
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(transcript, future, future);
    const second = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    expect(second.streamEpoch).toBe(first.streamEpoch + 1);
    expect(fs.readFileSync(first.journalPath, "utf8")).toBe(basicRollout());
    expect(fs.readFileSync(second.journalPath, "utf8")).toBe(rewritten);
  });

  it("detects a rewritten existing prefix even when the replacement grows", () => {
    const first = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    const rewritten = basicRollout().replace("durable", "changed") +
      rollout([{ type: "event_msg", payload: { type: "token_count", grown: true } }]);
    expect(Buffer.byteLength(rewritten)).toBeGreaterThan(first.sourceThroughByte);
    fs.writeFileSync(transcript, rewritten);
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(transcript, future, future);

    const second = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    expect(second.streamEpoch).toBe(first.streamEpoch + 1);
    expect(fs.readFileSync(second.journalPath, "utf8")).toBe(rewritten);
    expect(fs.readFileSync(first.journalPath, "utf8")).toBe(basicRollout());
  });

  it("recovers the fsynced orphan tail after a crash before DB commit", () => {
    expect(() => captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "precompact", afterJournalFsync: () => { throw new Error("crash-after-fsync"); },
    })).toThrow("crash-after-fsync");
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
    const recovered = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript,
      kind: "precompact",
    });
    expect(fs.statSync(recovered.journalPath).size).toBe(recovered.appendedBytes);
    expect(db.prepare("SELECT COUNT(*) AS n FROM journal_blocks").get()).toEqual({ n: 1 });
  });

  it("startup trims only an orphan tail beyond the committed journal boundary", () => {
    const capture = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    fs.appendFileSync(capture.journalPath, "orphan-uncommitted-tail");
    const result = handleContinuityHook(hook("SessionStart", { source: "startup" }), { db });
    expect(result.warning).toBeUndefined();
    expect(fs.statSync(capture.journalPath).size).toBe(capture.appendedBytes);
  });

  it("surfaces a short committed journal as a durable gap and closes it after a new stream capture", () => {
    const capture = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    fs.truncateSync(capture.journalPath, capture.appendedBytes - 1);
    const resumed = handleContinuityHook(hook("SessionStart", { source: "resume" }), { db });
    expect(resumed.warning).toMatch(/open capture gap/);
    expect(db.prepare("SELECT state FROM capture_gaps").get()).toEqual({ state: "open" });

    fs.writeFileSync(transcript, rollout([
      { type: "session_meta", payload: { id: "session-core-1", cwd: "/project" } },
    ]));
    const recovered = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    expect(recovered.streamEpoch).toBe(1);
    expect(db.prepare("SELECT state FROM capture_gaps").get()).toEqual({ state: "recovered" });
  });

  it("recaptures an intact source into a new epoch when the committed journal is short", () => {
    const first = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    fs.truncateSync(first.journalPath, first.appendedBytes - 1);

    const recovered = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    expect(recovered.streamEpoch).toBe(first.streamEpoch + 1);
    expect(fs.readFileSync(recovered.journalPath, "utf8")).toBe(basicRollout());
    expect(db.prepare("SELECT state FROM capture_gaps").get()).toEqual({ state: "recovered" });
  });

  it("serializes competing hook processes before journal append", async () => {
    const dbUrl = pathToFileURL(path.resolve("src/db.ts")).href;
    const coreUrl = pathToFileURL(path.resolve("src/continuity-core.ts")).href;
    const childCode = `
      import { initDatabase } from ${JSON.stringify(dbUrl)};
      import { captureTranscriptPrefix } from ${JSON.stringify(coreUrl)};
      const childDb = initDatabase();
      try {
        captureTranscriptPrefix(childDb, {
          sessionId: "session-core-1", project: "/project",
          transcriptPath: process.env.MEMEX_TEST_TRANSCRIPT, kind: "stop",
        });
      } finally { childDb.close(); }
    `;
    const run = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "--input-type=module", "-e", childCode,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, MEMEX_TEST_TRANSCRIPT: transcript },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    await Promise.all([run(), run(), run(), run()]);

    const stream = db.prepare(`
      SELECT journal_path, journal_byte_end FROM journal_streams
      WHERE session_id = ? AND state = 'active'
    `).get("session-core-1") as { journal_path: string; journal_byte_end: number };
    expect(fs.statSync(stream.journal_path).size).toBe(fs.statSync(transcript).size);
    expect(stream.journal_byte_end).toBe(fs.statSync(transcript).size);
    expect(db.prepare("SELECT COUNT(*) AS n FROM journal_blocks").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'capture_index'").get())
      .toEqual({ n: 1 });
  }, 20_000);

  it("rolls back checkpoint and both jobs together at every transaction seam", () => {
    for (const seam of ["checkpoint", "job"] as const) {
      const isolated = `${seam}-session`;
      const file = path.join(sessions, `rollout-${isolated}.jsonl`);
      fs.writeFileSync(file, basicRollout(isolated));
      expect(() => captureTranscriptPrefix(db, {
        sessionId: isolated, project: "/project", transcriptPath: file, kind: "stop",
        ...(seam === "checkpoint"
          ? { afterCheckpoint: () => { throw new Error(`crash-${seam}`); } }
          : { afterJob: () => { throw new Error(`crash-${seam}`); } }),
      })).toThrow(`crash-${seam}`);
      expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ?").get(isolated))
        .toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE partition_key LIKE ?").get(`%${isolated}%`))
        .toEqual({ n: 0 });
    }
  });
});

describe("epoch, residency, rehydration, and Capsule", () => {
  it("rehydrates immediately after compact with zero PostCompact dependency", () => {
    putExchange();
    handleContinuityHook(hook("PreCompact", { trigger: "auto" }), { db });
    const result = handleContinuityHook(hook("SessionStart", { source: "compact" }), { db });
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext)
      .toContain("Implement the durable journal");
    const epoch = readResidentFactRevisions(db, "session-core-1").contextEpoch;
    expect(epoch).toBe(1);
    handleContinuityHook(hook("SessionStart", { source: "compact" }), { db });
    expect(readResidentFactRevisions(db, "session-core-1").contextEpoch).toBe(1);
  });

  it("clear starts a fresh epoch and discards carry/residency", () => {
    ensureSessionMemoryState(db, { sessionId: "session-core-1", project: "/project" });
    recordResidentFactRevisions(db, "session-core-1", 0, [["fact-x", 1, 1]]);
    advanceContextEpoch(db, { sessionId: "session-core-1", source: "clear", turnId: "clear-1" });
    expect(readResidentFactRevisions(db, "session-core-1")).toEqual({
      contextEpoch: 1, resident: [], carry: [],
    });
  });

  it("rehydrates the latest active generation and blocks stale residency CAS", () => {
    ensureSessionMemoryState(db, { sessionId: "session-core-1", project: "/project" });
    db.prepare(`
      INSERT INTO facts
        (id, fact, category, scope_type, scope_project, source_exchange_ids,
         created_at, updated_at, semantic_generation, semantic_updated_at,
         lifecycle_generation, lifecycle_updated_at)
      VALUES ('fact-x', 'current truth', 'knowledge', 'project', '/project', '[]',
        ?, ?, 2, ?, 3, ?)
    `).run("2026-09-03T00:00:00Z", "2026-09-03T00:00:00Z", "2026-09-03T00:00:00Z", "2026-09-03T00:00:00Z");
    recordResidentFactRevisions(db, "session-core-1", 0, [["fact-x", 1, 1]]);
    advanceContextEpoch(db, { sessionId: "session-core-1", source: "compact", turnId: "compact-1" });
    const result = buildRehydrationContext(db, { sessionId: "session-core-1" });
    expect(result.context).toContain("current truth");
    expect(result.factRevisions).toEqual([["fact-x", 2, 3]]);
    expect(recordResidentFactRevisions(db, "session-core-1", 0, [["fact-x", 2, 3]])).toBe(false);
  });

  it("enforces typed authoritative sources, bounded shape, and generation CAS", () => {
    putExchange();
    const capture = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "final",
    });
    const state = ensureSessionMemoryState(db, { sessionId: "session-core-1", project: "/project" });
    const patch = {
      objective: "Implement continuity",
      currentState: "Journal capture is under test",
      verifiedProgress: [{ text: "User requested durable journal", sourceExchangeIds: ["exchange-core-1"] }],
      hypotheses: [{ text: "The remaining race may be in recovery", sourceExchangeIds: ["exchange-core-1"] }],
      blockers: [], openQuestions: [], nextActions: ["Run crash matrix"], touchedAreas: ["src/continuity-core.ts"],
      carryFactRevisions: [], sourceExchangeIds: ["exchange-core-1"],
    };
    expect(validateWorkCapsulePatch(patch).verifiedProgress).toHaveLength(1);
    const applied = applyWorkCapsulePatch(db, {
      workstreamId: state.workstreamId,
      expectedGeneration: 0,
      throughCheckpointId: capture.checkpointId,
      patch,
    });
    expect(applied?.authority).toBe("context-only");
    expect(applyWorkCapsulePatch(db, {
      workstreamId: state.workstreamId,
      expectedGeneration: 0,
      throughCheckpointId: capture.checkpointId,
      patch,
    })).toBeNull();
    expect(() => validateWorkCapsulePatch({ ...patch, verifiedProgress: [{ text: "unsourced", sourceExchangeIds: [] }] }))
      .toThrow(/requires text and sources/);
    expect(() => validateWorkCapsulePatch({ ...patch, unexpected: true }))
      .toThrow(/exact required fields/);
    const { blockers: _omitted, ...missingField } = patch;
    expect(() => validateWorkCapsulePatch(missingField)).toThrow(/exact required fields/);
    expect(() => validateWorkCapsulePatch({ ...patch, objective: "x".repeat(501) }))
      .toThrow(/at most 500/);
    expect(() => validateWorkCapsulePatch({
      ...patch,
      hypotheses: [{ text: "User requested durable journal", sourceExchangeIds: ["exchange-core-1"] }],
    })).toThrow(/both verified progress and hypothesis/);

    insertExchange(db, {
      id: "assistant-only-source",
      project: "/project",
      cwd: "/project",
      timestamp: "2026-09-03T00:00:02Z",
      userMessage: "",
      assistantMessage: "The implementation is complete",
      archivePath: transcript,
      lineStart: 4,
      lineEnd: 4,
      sessionId: "session-core-1",
      closureState: "closed",
      contentGeneration: 1,
      parserVersion: 2,
    }, new Array(384).fill(0.01));
    expect(() => applyWorkCapsulePatch(db, {
      workstreamId: state.workstreamId,
      expectedGeneration: 1,
      throughCheckpointId: capture.checkpointId,
      patch: {
        ...patch,
        verifiedProgress: [{ text: "Implementation complete", sourceExchangeIds: ["assistant-only-source"] }],
        hypotheses: [],
        sourceExchangeIds: ["assistant-only-source"],
      },
    })).toThrow(/not authoritative/);
  });

  it("rolls back the Capsule projection when atomic job completion is rejected", () => {
    putExchange();
    const capture = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "final",
    });
    const jobId = capture.capsuleJobId!;
    const state = ensureSessionMemoryState(db, { sessionId: "session-core-1", project: "/project" });
    db.prepare(`
      UPDATE memory_jobs
      SET state = 'running', lease_owner = 'capsule-worker', lease_generation = 1,
          lease_until = '2099-01-01T00:00:00.000Z'
      WHERE job_id = ?
    `).run(jobId);
    db.exec(`
      CREATE TEMP TRIGGER reject_capsule_job_completion
      BEFORE UPDATE OF state ON memory_jobs
      WHEN OLD.kind = 'capsule_update' AND NEW.state = 'completed'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    expect(() => applyWorkCapsulePatch(db, {
      workstreamId: state.workstreamId,
      expectedGeneration: 0,
      throughCheckpointId: capture.checkpointId,
      patch: {
        objective: "Implement continuity",
        currentState: "Atomic completion under test",
        verifiedProgress: [{ text: "User requested durable journal", sourceExchangeIds: ["exchange-core-1"] }],
        hypotheses: [], blockers: [], openQuestions: [], nextActions: ["Retry"],
        touchedAreas: ["src/continuity-core.ts"], carryFactRevisions: [],
        sourceExchangeIds: ["exchange-core-1"],
      },
      jobLease: { jobId, owner: "capsule-worker", leaseGeneration: 1 },
      now: "2026-09-03T00:00:00.000Z",
    })).toThrow(/lease changed during atomic completion/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM work_capsules").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT state FROM capsule_checkpoint_state WHERE checkpoint_id = ?")
      .get(capture.checkpointId)).toEqual({ state: "pending" });
    expect(db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?").get(jobId))
      .toEqual({ state: "running" });
  });

  it("builds a bounded deterministic tail baton without promoting assistant prose", () => {
    putExchange();
    const baton = buildDeterministicTailBaton(db, { sessionId: "session-core-1" });
    expect(baton).toContain("DETERMINISTIC TAIL BATON");
    expect(baton).toContain("Implement the durable journal");
    expect(baton.length).toBeLessThanOrEqual(1_200);
  });

  it("adds a deterministic tail baton when the latest Capsule is stale", () => {
    putExchange();
    const capsuleBoundary = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "precompact",
    });
    const state = ensureSessionMemoryState(db, { sessionId: "session-core-1", project: "/project" });
    expect(applyWorkCapsulePatch(db, {
      workstreamId: state.workstreamId,
      expectedGeneration: 0,
      throughCheckpointId: capsuleBoundary.checkpointId,
      patch: {
        objective: "Implement continuity", currentState: "Older capsule",
        verifiedProgress: [{ text: "User requested journal", sourceExchangeIds: ["exchange-core-1"] }],
        hypotheses: [], blockers: [], openQuestions: [], nextActions: ["Old next"],
        touchedAreas: [], carryFactRevisions: [], sourceExchangeIds: ["exchange-core-1"],
      },
    })?.generation).toBe(1);
    fs.appendFileSync(transcript, rollout([{ type: "event_msg", payload: { type: "token_count" } }]));
    captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });

    const context = buildRehydrationContext(db, { sessionId: "session-core-1" }).context;
    expect(context).toContain("State: Older capsule");
    expect(context).toContain("DETERMINISTIC TAIL BATON");
  });

  it("runs capture-index before Capsule and accepts a strict model patch", async () => {
    putExchange();
    const capture = captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "final",
    });
    db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
    const model = vi.fn(async () => JSON.stringify({
      objective: "Implement continuity",
      currentState: "Captured",
      verifiedProgress: [{ text: "Request captured", sourceExchangeIds: ["exchange-core-1"] }],
      hypotheses: [], blockers: [], openQuestions: [], nextActions: ["Verify"],
      touchedAreas: [], carryFactRevisions: [], sourceExchangeIds: ["exchange-core-1"],
    }));
    const result = await runContinuityWorker(db, { maxJobs: 1, model });
    expect(result).toEqual([expect.objectContaining({ kind: "capsule_update", state: "completed" })]);
    expect(model).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = ?").get(capture.checkpointId))
      .toEqual({ state: "processed" });
  });
});

describe("hook security and boundary contract", () => {
  it("normalizes official snake_case fields without dropping lifecycle data", () => {
    expect(normalizeHookPayload(hook("Interrupt", {
      permission_mode: "workspace-write",
      stop_hook_active: true,
      last_assistant_message: "partial",
    }))).toMatchObject({
      sessionId: "session-core-1",
      hookEventName: "Interrupt",
      permissionMode: "workspace-write",
      stopHookActive: true,
      lastAssistantMessage: "partial",
    });
  });

  it("binds project identity to session_meta cwd and rejects a session id mismatch", () => {
    const captured = handleContinuityHook(hook("Stop", { cwd: "/payload-drift" }), { db });
    expect(captured.capture).toBeDefined();
    expect(db.prepare("SELECT project FROM session_memory_state WHERE session_id = ?")
      .get("session-core-1")).toEqual({ project: "/project" });

    const mismatch = path.join(sessions, "rollout-mismatch.jsonl");
    fs.writeFileSync(mismatch, basicRollout("different-session"));
    expect(() => handleContinuityHook(hook("Stop", { transcript_path: mismatch }), {
      db,
      strictCapture: true,
    })).toThrow(/does not match transcript session_meta/);
  });

  it("rejects traversal, foreign roots, and symlink transcript paths", () => {
    const foreign = path.join(root, "foreign.jsonl");
    fs.writeFileSync(foreign, "{}\n");
    expect(() => validateTranscriptPath(foreign)).toThrow(/outside allowed/);
    const link = path.join(sessions, "link.jsonl");
    fs.symlinkSync(transcript, link);
    expect(() => validateTranscriptPath(link)).toThrow(/symlink/);
  });

  it("capture events emit no invalid plain stdout and create no model/embedding call", () => {
    for (const event of ["Stop", "Interrupt", "PreCompact", "SessionEnd"]) {
      const result = handleContinuityHook(hook(event, event === "PreCompact" ? { trigger: "manual" } : {}), { db });
      expect(result.stdout).toBe("");
    }
  });

  it("does not recreate Continuity state after terminal conversation exclusion", () => {
    captureTranscriptPrefix(db, {
      sessionId: "session-core-1", project: "/project", transcriptPath: transcript, kind: "stop",
    });
    purgeConversationFromIndex(db, {
      archivePath: transcript,
      sessionId: "session-core-1",
    });
    const result = handleContinuityHook(hook("SessionEnd"), { db });
    expect(result).toEqual({ stdout: "" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT reason FROM conversation_exclusions WHERE session_id = ?")
      .get("session-core-1")).toEqual({ reason: "source_conversation_excluded" });
    expect(fs.existsSync(path.join(process.env.MEMEX_HOME!, "journals", "session-core-1"))).toBe(false);
  });
});
