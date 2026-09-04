/**
 * Final Integration (Prompt F1) end-to-end seams. One fixture drives the whole
 * Continuity v1 system across Phase boundaries: capture → checkpoint/outbox →
 * P0/P1 worker → exact extraction (mocked model) → Chronicle slot resolution →
 * injection gate/bundle → sync export/import into a second database → privacy
 * purge → replay, with crash injection and duplicate delivery at the seams,
 * and the RFC §21.2 / Prompt F1 mandatory zero counts measured at the end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

let extractionModel: (system: string, user: string) => Promise<string> = async () => "[]";
vi.mock("../src/llm.js", async (io) => ({
  ...(await io<typeof import("../src/llm.js")>()),
  callMemoryModel: async (system: string, user: string) => extractionModel(system, user),
}));
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase, insertExchange } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import {
  applyWorkCapsulePatch,
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  handleContinuityHook,
  readResidentFactRevisions,
} from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { runFactExtraction, saveExtractedFactsDetailed } from "../src/fact-extractor.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";
import { claimMemoryJobById, completeMemoryJob } from "../src/continuity-store.js";
import { ingestPrefixExchanges } from "../src/archive-ingestion.js";
import { recordIncidentOccurrence, readChronicleTimeline } from "../src/chronicle.js";
import { assignFactSubject } from "../src/continuity-identity.js";
import { mutateFactMeaning } from "../src/fact-management.js";
import { computeInjectContext } from "../src/inject-core.js";
import { embeddingCallStats, stubEmbedding } from "../src/embeddings.js";
import { handleToolCall } from "../src/mcp-server.js";
import { exportForSync, getSyncDir } from "../src/sync-export.js";
import { importFromSync } from "../src/sync-import.js";
import type { ConversationExchange, ExtractedFact } from "../src/types.js";

const PROJECT = "/project/final-integration";
const OTHER_PROJECT = "/project/final-other";
const SUBJECT = "state.runtime.session_store";
const MYSQL_TEXT = "We use MySQL as the runtime session store.";
const REDIS_TEXT = "Switch the runtime session store to Redis because session write P95 exceeded the limit.";
const REDIS_CAUSE = "session write P95 exceeded the limit";
const INCIDENT = "FAIL redis reconnect: missing TTL refresh";

let root: string;
let sessions: string;
let db: Database.Database;
let dbPathA: string;
let dbPathB: string;
/** Every human_evidence text the mocked extractor was actually shown. */
let presented: Set<string>;
let extractionCalls: number;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function transcriptFor(session: string): string {
  return path.join(sessions, `rollout-${session}.jsonl`);
}

function startTranscript(session: string): void {
  fs.writeFileSync(transcriptFor(session), line({ type: "session_meta", payload: { id: session, cwd: PROJECT } }));
}

function hook(session: string, event: string, extra: Record<string, unknown> = {}) {
  return { session_id: session, transcript_path: transcriptFor(session), cwd: PROJECT, hook_event_name: event, ...extra };
}

function turnTimestamp(index: number): string {
  return `2026-09-04T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
}

function appendTurn(session: string, index: number, user: string, assistant = "context only"): void {
  const ts = turnTimestamp(index);
  fs.appendFileSync(transcriptFor(session), line({
    timestamp: ts, type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] },
  }));
  fs.appendFileSync(transcriptFor(session), line({
    timestamp: ts, type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: assistant }] },
  }));
}

function count(sql: string, ...args: unknown[]): number {
  return Number((db.prepare(sql).get(...args) as { n: number }).n);
}

async function drainCapture(model: (s: string, u: string) => Promise<string> = async () => "{}"): Promise<void> {
  for (let guard = 0; guard < 500; guard++) {
    if (count("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'capture_index' AND state IN ('pending','retry')") === 0) return;
    db.prepare("UPDATE memory_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'capture_index' AND state = 'retry'").run();
    const [result] = await runContinuityWorker(db, { maxJobs: 1, model });
    if (!result || result.kind !== "capture_index") throw new Error(`capture drain stalled: ${JSON.stringify(result)}`);
  }
  throw new Error("capture drain did not converge");
}

/** Exact extractor stand-in: a fact for MySQL and a grounded change for Redis; everything else yields nothing. */
async function extractorStandIn(system: string, user: string): Promise<string> {
  if (system.includes("authoritative-entailment-v3")) {
    const envelope = JSON.parse(user) as { candidates: Array<{ selected_context_dependencies: Array<{ context_id: string; relation: string }> }> };
    return JSON.stringify(envelope.candidates.map((candidate, index) => ({
      candidate_index: index + 1,
      verdict: "ENTAILED",
      used_context_dependencies: candidate.selected_context_dependencies,
      used_local_context_exchange_indices: [],
    })));
  }
  extractionCalls += 1;
  const envelope = JSON.parse(user) as { local_exchanges: Array<{ index: number; human_evidence: string | null }> };
  const candidates: Record<string, unknown>[] = [];
  for (const exchange of envelope.local_exchanges) {
    if (!exchange.human_evidence) continue;
    presented.add(exchange.human_evidence);
    if (exchange.human_evidence === MYSQL_TEXT) {
      candidates.push({
        fact: "Runtime session store is MySQL", category: "knowledge", scope_type: "project", confidence: 0.95,
        grounding_type: "explicit", durable: true, subject_key: SUBJECT,
        evidence: [{ exchange_index: exchange.index, source: "human", kind: "assertion", supporting_span: "MySQL as the runtime session store" }],
      });
    }
    if (exchange.human_evidence === REDIS_TEXT) {
      candidates.push({
        fact: "Runtime session store is Redis", category: "knowledge", scope_type: "project", confidence: 0.95,
        grounding_type: "explicit", durable: true, subject_key: SUBJECT,
        evidence: [{ exchange_index: exchange.index, source: "human", kind: "assertion", supporting_span: "Switch the runtime session store to Redis" }],
        change_context: {
          cause: { exchange_index: exchange.index, supporting_span: REDIS_CAUSE, text: REDIS_CAUSE },
          // Not present in the source: must become a classifier note, never authoritative.
          rationale: { exchange_index: exchange.index, supporting_span: "probably cheaper to operate", text: "probably cheaper to operate" },
        },
      });
    }
  }
  return JSON.stringify(candidates);
}

const capsuleModel = async (_system: string, user: string): Promise<string> => {
  const { contiguousSegment } = JSON.parse(user) as { contiguousSegment: Array<{ exchangeId: string; human: string }> };
  const ids = contiguousSegment.map((entry) => entry.exchangeId);
  return JSON.stringify({
    objective: "Migrate the runtime session store to Redis",
    currentState: `segment through ${ids[ids.length - 1]}`,
    verifiedProgress: [{ text: contiguousSegment[0].human.slice(0, 120), sourceExchangeIds: [ids[0]] }],
    hypotheses: [],
    blockers: ["failover test still red"],
    openQuestions: [],
    nextActions: ["run the failover test"],
    touchedAreas: ["src/session/"],
    carryFactRevisions: [],
    sourceExchangeIds: ids,
  });
};

async function inject(prompt: string, session: string, project = PROJECT) {
  const before = embeddingCallStats();
  const context = await computeInjectContext(prompt, project, "daemon", session);
  const after = embeddingCallStats();
  return { context, embeddings: (after.modelCalls - before.modelCalls) + (after.cacheHits - before.cacheHits) };
}

function candidate(text: string, exchangeId: string, span: string): ExtractedFact {
  return {
    fact: text, category: "knowledge", scope_type: "project", confidence: 0.95, grounding_type: "explicit", durable: true,
    evidence: [{ exchange_index: 1, source: "human", kind: "assertion", supporting_span: span }],
    source_exchange_ids: [exchangeId], subject_key: SUBJECT,
  };
}

function openDb(which: "a" | "b"): Database.Database {
  process.env.MEMEX_DB_PATH = which === "a" ? dbPathA : dbPathB;
  db = initDatabase();
  return db;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-final-integration-"));
  sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  dbPathA = path.join(root, "device-a.sqlite");
  dbPathB = path.join(root, "device-b.sqlite");
  process.env.MEMEX_HOME = path.join(root, "memex-home");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = sessions;
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_MAX_EXTRACT_WINDOWS = "1";
  extractionModel = async () => "[]";
  presented = new Set();
  extractionCalls = 0;
  openDb("a");
});

afterEach(() => {
  if (db.open) db.close();
  for (const key of ["MEMEX_HOME", "MEMEX_DB_PATH", "MEMEX_ALLOWED_TRANSCRIPT_ROOTS", "MEMEX_EMBEDDING_STUB", "MEMEX_MAX_EXTRACT_WINDOWS"]) {
    delete process.env[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Final Integration: cross-phase end-to-end", () => {
  it("capture → outbox → worker → extraction → Chronicle → injection → sync → purge → replay with crash/duplicate seams and zero-count accounting", async () => {
    const A = "final-session-a";
    const B = "final-session-b";
    const C = "final-session-c";
    startTranscript(A);
    extractionModel = extractorStandIn;
    const zero: Record<string, number> = {};

    // ---- 1. Capture with duplicate delivery, Interrupt, PreCompact/compact, crash seams ----
    const filler = (n: number) => `Task ${n}: wire the redis client and rerun the failover test suite.`;
    const texts: string[] = [];
    let rehydrationMisses = 0;
    let compactions = 0;
    for (let turn = 1; turn <= 14; turn++) {
      const text = turn === 1 ? MYSQL_TEXT : turn === 8 ? REDIS_TEXT : filler(turn);
      texts.push(text);
      appendTurn(A, turn, text);
      if (turn === 5) {
        const interrupted = handleContinuityHook(hook(A, "Interrupt", { turn_id: `turn-${turn}` }), { db });
        expect(interrupted.capture?.created).toBe(true);
      }
      if (turn === 2 || turn === 3 || turn === 4) {
        // Crash after journal fsync / after checkpoint / after job: every seam
        // must roll back to a state the re-delivered Stop converges from.
        const seam = turn === 2 ? "afterJournalFsync" : turn === 3 ? "afterCheckpoint" : "afterJob";
        expect(() => captureTranscriptPrefix(db, {
          sessionId: A, project: PROJECT, transcriptPath: transcriptFor(A), kind: "stop", turnId: `turn-${turn}`,
          [seam]: () => { throw new Error(`crash-${seam}`); },
        })).toThrow(`crash-${seam}`);
      }
      const stopped = handleContinuityHook(hook(A, "Stop", { turn_id: `turn-${turn}` }), { db });
      expect(stopped.capture?.created).toBe(true);
      expect(stopped.warning).toBeUndefined();
      const duplicate = handleContinuityHook(hook(A, "Stop", { turn_id: `turn-${turn}` }), { db });
      expect(duplicate.capture?.checkpointId).toBe(stopped.capture?.checkpointId);
      expect(duplicate.capture?.created).toBe(false);
      if (turn === 6 || turn === 12) {
        const trigger = turn === 6 ? "auto" : "manual";
        const pre = handleContinuityHook(hook(A, "PreCompact", { turn_id: `turn-${turn}`, trigger }), { db });
        const preDuplicate = handleContinuityHook(hook(A, "PreCompact", { turn_id: `turn-${turn}`, trigger }), { db });
        expect(preDuplicate.capture?.checkpointId).toBe(pre.capture?.checkpointId);
        if (turn === 12) {
          // Same turn, grown prefix: the second compaction is a distinct checkpoint.
          fs.appendFileSync(transcriptFor(A), line({ type: "event_msg", payload: { type: "token_count", turn } }));
          const second = handleContinuityHook(hook(A, "PreCompact", { turn_id: `turn-${turn}`, trigger }), { db });
          expect(second.capture?.checkpointId).not.toBe(pre.capture?.checkpointId);
        }
        // No PostCompact is ever delivered in this fixture.
        const compact = handleContinuityHook(hook(A, "SessionStart", { turn_id: `turn-${turn}`, source: "compact" }), { db });
        compactions += 1;
        if (!compact.stdout.includes("WORK NOW")) rehydrationMisses += 1;
        const compactDuplicate = handleContinuityHook(hook(A, "SessionStart", { turn_id: `turn-${turn}`, source: "compact" }), { db });
        expect(readResidentFactRevisions(db, A).contextEpoch).toBe(compactions);
        expect(compactDuplicate.stdout).toBe(compact.stdout);
      }
    }
    zero.compact_rehydration_miss = rehydrationMisses;
    zero.postcompact_dependency_failure = compactions === 2 && readResidentFactRevisions(db, A).contextEpoch === 2 ? 0 : 1;
    expect(count("SELECT COUNT(*) AS n FROM capture_gaps WHERE state = 'open'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM capture_gaps WHERE state = 'recovered'")).toBeGreaterThanOrEqual(1);
    const stream = db.prepare("SELECT journal_path, copied_byte_end FROM journal_streams WHERE session_id = ? AND state = 'active'").get(A) as { journal_path: string; copied_byte_end: number };
    expect(fs.statSync(stream.journal_path).size).toBe(fs.statSync(transcriptFor(A)).size);
    expect(stream.copied_byte_end).toBe(fs.statSync(transcriptFor(A)).size);

    // ---- 2. P0 capture indexing: crash during ingest, stale lease, then drain ----
    const firstCapture = (await runContinuityWorker(db, { maxJobs: 1, beforePrefixIngest: () => { throw new Error("crash-index"); } }))[0];
    expect(firstCapture).toMatchObject({ kind: "capture_index", state: "retry", detail: "crash-index" });
    db.prepare("UPDATE memory_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE state = 'retry'").run();
    // Stale owner: an expired lease cannot complete after a newer owner reclaimed the job.
    const firstJob = db.prepare("SELECT job_id FROM memory_jobs WHERE kind = 'capture_index' ORDER BY created_at, job_id LIMIT 1").get() as { job_id: string };
    const stale = claimMemoryJobById(db, { jobId: firstJob.job_id, owner: "stale-owner", now: new Date(Date.now() - 10 * 60_000), leaseMs: 1_000 })!;
    expect(stale).not.toBeNull();
    const fresh = claimMemoryJobById(db, { jobId: firstJob.job_id, owner: "fresh-owner", now: new Date() })!;
    expect(fresh.lease_generation).toBe(stale.lease_generation + 1);
    expect(completeMemoryJob(db, { jobId: firstJob.job_id, owner: "stale-owner", leaseGeneration: stale.lease_generation })).toBe(false);
    db.prepare("UPDATE memory_jobs SET state = 'pending', lease_owner = NULL, lease_until = NULL WHERE job_id = ?").run(firstJob.job_id);
    await drainCapture();
    expect(count("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'capture_index' AND state <> 'completed'")).toBe(0);
    const closed = count("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ? AND closure_state = 'closed'", A);
    expect(closed).toBe(14);
    zero.checkpoint_prefix_hash_mismatch = count("SELECT COUNT(*) AS n FROM memory_jobs WHERE last_error LIKE '%hash mismatch%'");
    const exchangeRows = db.prepare("SELECT id, user_message, timestamp, workstream_id, project_id FROM exchanges WHERE session_id = ? ORDER BY exchange_seq, rowid").all(A) as Array<{ id: string; user_message: string; timestamp: string; workstream_id: string | null; project_id: string | null }>;
    const stateA = ensureSessionMemoryState(db, { sessionId: A, project: PROJECT });
    expect(exchangeRows.every((row) => row.workstream_id === stateA.workstreamId && row.project_id === stateA.projectId)).toBe(true);
    const byText = new Map(exchangeRows.map((row) => [row.user_message, row]));

    // CP2 then CP1: an older, shorter prefix cannot delete or regress anything.
    const before = db.prepare("SELECT id, line_end, content_generation FROM exchanges WHERE session_id = ? ORDER BY rowid").all(A);
    const olderPrefix: ConversationExchange[] = exchangeRows.slice(0, 3).map((row, index) => ({
      id: row.id, project: PROJECT, cwd: PROJECT, timestamp: row.timestamp, userMessage: row.user_message, assistantMessage: "context only",
      archivePath: stream.journal_path, lineStart: 2 + index * 2, lineEnd: 2 + index * 2, sessionId: A, closureState: "open", contentGeneration: 1, parserVersion: 2,
    }));
    const regression = await ingestPrefixExchanges(db, olderPrefix);
    expect(regression.indexed).toBe(0);
    expect(db.prepare("SELECT id, line_end, content_generation FROM exchanges WHERE session_id = ? ORDER BY rowid").all(A)).toEqual(before);

    // ---- 3. P1 Capsule: model crash → retry → strict patch; then immediate rehydration uses it ----
    const crashed = (await runContinuityWorker(db, { maxJobs: 1, model: async () => { throw new Error("crash-capsule-model"); } }))[0];
    expect(crashed).toMatchObject({ kind: "capsule_update", state: "retry" });
    db.prepare("UPDATE memory_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'capsule_update' AND state = 'retry'").run();
    for (let guard = 0; guard < 20 && count("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'capsule_update' AND state IN ('pending','retry')") > 0; guard++) {
      const [result] = await runContinuityWorker(db, { maxJobs: 1, model: capsuleModel });
      expect(result).toMatchObject({ kind: "capsule_update", state: "completed" });
    }
    const capsule = db.prepare("SELECT generation, objective, source_session_id FROM work_capsules WHERE workstream_id = ?").get(stateA.workstreamId) as { generation: number; objective: string; source_session_id: string };
    expect(capsule.generation).toBeGreaterThanOrEqual(1);
    expect(capsule.source_session_id).toBe(A);
    expect(count("SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ? AND state NOT IN ('processed')", A)).toBe(0);
    appendTurn(A, 15, filler(15));
    handleContinuityHook(hook(A, "PreCompact", { turn_id: "turn-15", trigger: "auto" }), { db });
    const rehydrated = handleContinuityHook(hook(A, "SessionStart", { turn_id: "turn-15", source: "compact" }), { db });
    compactions += 1;
    expect(rehydrated.stdout).toContain("[WORK NOW]");
    expect(rehydrated.stdout).toContain("Objective: Migrate the runtime session store to Redis");
    // A Capsule older than the newest checkpoint is supplemented, never trusted alone.
    expect(rehydrated.stdout).toContain("DETERMINISTIC TAIL BATON");
    // The turn that was compacted mid-flight still ends with its Stop fence.
    handleContinuityHook(hook(A, "Stop", { turn_id: "turn-15" }), { db });
    await drainCapture();
    expect(count("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ? AND closure_state = 'closed'", A)).toBe(15);

    // ---- 4. Exact extraction: model crash → retry, contiguous pages, Chronicle slot resolution ----
    let extractionCrashes = 0;
    const crashingExtractor = async (system: string, user: string) => {
      if (!system.includes("authoritative-entailment-v3") && extractionCrashes === 0) {
        extractionCrashes += 1;
        throw new Error("crash-extraction-model");
      }
      return extractorStandIn(system, user);
    };
    extractionModel = crashingExtractor;
    for (let guard = 0; guard < 20; guard++) {
      db.prepare("UPDATE memory_jobs SET available_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'fact_extract' AND state = 'retry'").run();
      let result: Awaited<ReturnType<typeof runFactExtraction>>;
      try {
        result = await runFactExtraction(db, A, PROJECT);
      } catch (error) {
        // A model-time crash defers the page: cursor untouched, target retryable, nothing completed.
        expect((error as Error).message).toBe("crash-extraction-model");
        expect(db.prepare("SELECT state, cursor_ordinal FROM extraction_targets").get()).toEqual({ state: "retry", cursor_ordinal: 0 });
        expect(db.prepare("SELECT state FROM memory_jobs WHERE kind = 'fact_extract'").get()).toEqual({ state: "retry" });
        continue;
      }
      expect(result.skipped).toBeUndefined();
      const target = db.prepare("SELECT state FROM extraction_targets ORDER BY created_at DESC LIMIT 1").get() as { state: string };
      if (target.state === "completed") break;
    }
    expect(extractionCrashes).toBe(1);
    const target = db.prepare("SELECT target_id, state, cursor_ordinal, item_count FROM extraction_targets").get() as { target_id: string; state: string; cursor_ordinal: number; item_count: number };
    expect(target).toMatchObject({ state: "completed", item_count: 15 });
    expect(target.cursor_ordinal).toBe(target.item_count);
    zero.cursor_overrun = target.cursor_ordinal > target.item_count ? 1 : 0;
    const items = db.prepare("SELECT ordinal, exchange_id, state FROM extraction_target_items WHERE target_id = ? ORDER BY ordinal").all(target.target_id) as Array<{ ordinal: number; exchange_id: string; state: string }>;
    expect(items.map((item) => item.ordinal)).toEqual(items.map((_, index) => index + 1));
    zero.silent_skipped_pages = items.filter((item) => item.state !== "processed").length;
    const messageById = new Map(db.prepare("SELECT id, user_message FROM exchanges WHERE session_id = ?").all(A).map((row) => [(row as { id: string }).id, (row as { user_message: string }).user_message]));
    // EXACT EXTRACTION: every cursor-passed exchange was presented to the model.
    expect(items.every((item) => presented.has(messageById.get(item.exchange_id) as string))).toBe(true);
    zero.unaccounted_closed_exchanges = count(`
      SELECT COUNT(*) AS n FROM exchanges e
      WHERE e.session_id = ? AND e.closure_state IN ('closed','final')
        AND NOT EXISTS (
          SELECT 1 FROM exchange_extraction_state s
          WHERE s.exchange_id = e.id AND s.content_generation = e.content_generation AND s.state = 'processed'
        )
    `, A);
    // The transient crash left an audit row in `retry`; nothing is failed-visible or dead.
    expect(count("SELECT COUNT(*) AS n FROM extraction_failed_ranges WHERE state = 'failed-visible'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM memory_jobs WHERE state = 'dead'")).toBe(0);

    const active = db.prepare("SELECT id, fact, promotion_state, workstream_id, semantic_generation, lifecycle_generation FROM facts WHERE subject_key = ? AND is_active = 1").all(SUBJECT) as Array<{ id: string; fact: string; promotion_state: string; workstream_id: string | null; semantic_generation: number; lifecycle_generation: number }>;
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ fact: "Runtime session store is Redis", promotion_state: "workstream", workstream_id: stateA.workstreamId });
    const factId = active[0].id;
    const timeline = readChronicleTimeline(db, { factId, order: "asc" }).events;
    expect(timeline.map((event) => event.event_kind)).toEqual(["ASSERTED", "CHANGED"]);
    expect(timeline[1]).toMatchObject({ previous_value: "Runtime session store is MySQL", grounded_cause: REDIS_CAUSE, effective_at_source: "source", rationale: null });
    expect(timeline[1].classifier_note).toContain("unverified rationale: probably cheaper to operate");
    expect(timeline[1].source_exchange_ids).toContain(byText.get(REDIS_TEXT)!.id);
    expect(timeline[1].effective_at).toBe(byText.get(REDIS_TEXT)!.timestamp);

    // Duplicate delivery of the same change: provenance merge, no second event.
    const replayed = await saveExtractedFactsDetailed(db, [candidate("Runtime session store is Redis", byText.get(REDIS_TEXT)!.id, "Switch the runtime session store to Redis")], PROJECT, []);
    expect(replayed).toMatchObject({ asserted: 0, changed: 0, merged: 1 });
    // Old generation after new: older source evidence becomes history, never the projection.
    const historical = await saveExtractedFactsDetailed(db, [candidate("Runtime session store was MySQL before July", byText.get(MYSQL_TEXT)!.id, "MySQL as the runtime session store")], PROJECT, []);
    expect(historical).toMatchObject({ historical: 1, changed: 0 });
    expect((db.prepare("SELECT fact FROM facts WHERE id = ?").get(factId) as { fact: string }).fact).toBe("Runtime session store is Redis");
    zero.duplicate_authoritative_chronicle_event = count(`
      SELECT COUNT(*) AS n FROM (
        SELECT subject_key, effective_at, event_kind, COUNT(*) AS c FROM fact_revisions
        WHERE projection_applied = 1 GROUP BY subject_key, effective_at, event_kind HAVING c > 1
      )
    `);
    zero.ungrounded_cause_authoritative = count(`
      SELECT COUNT(*) AS n FROM fact_revisions
      WHERE (grounded_cause IS NOT NULL OR problem IS NOT NULL) AND (source_exchange_ids = '[]' OR source_exchange_ids IS NULL)
    `) + count("SELECT COUNT(*) AS n FROM fact_revisions WHERE rationale LIKE '%probably cheaper%'");

    // Chronicle transaction crash: a rejected commit marker rolls facts and events back together.
    const eventsBefore = count("SELECT COUNT(*) AS n FROM fact_revisions");
    const factsBefore = count("SELECT COUNT(*) AS n FROM facts");
    await expect(saveExtractedFactsDetailed(db, [{
      ...candidate("Runtime session store is Memcached", byText.get(REDIS_TEXT)!.id, "Switch the runtime session store to Redis"),
      subject_key: "state.runtime.cache_store",
    }], PROJECT, [], undefined, () => 0)).rejects.toThrow();
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(eventsBefore);
    expect(count("SELECT COUNT(*) AS n FROM facts")).toBe(factsBefore);

    // ---- 5. Injection: gate, delta, correction, scope, WATCH, TRACE, MCP deep path ----
    const otherState = ensureSessionMemoryState(db, { sessionId: "final-other-session", project: OTHER_PROJECT });
    insertFact(db, {
      fact: "The other project uses DynamoDB as its session store", category: "knowledge", scope_type: "project",
      scope_project: OTHER_PROJECT, project_id: otherState.projectId, subject_key: SUBJECT, source_exchange_ids: [],
      embedding: stubEmbedding("The other project uses DynamoDB as its session store"),
    });
    const injected: string[] = [];
    const ask = async (prompt: string, session: string) => {
      const result = await inject(prompt, session);
      injected.push(result.context);
      return result;
    };
    const resume = await ask("Which runtime session store are we on and why did it change?", A);
    expect(resume.context).toContain("[CURRENT TRUTH]");
    expect(resume.context).toContain("Runtime session store is Redis");
    expect(resume.context).toContain("[TRACE — HISTORY AVAILABLE]");
    expect(resume.context).toContain(`trace_fact subject_key=${SUBJECT}`);
    expect(resume.context).not.toContain("DynamoDB");
    const ack = await ask("thanks", A);
    expect(ack).toEqual({ context: "", embeddings: 0 });

    // Sibling correction: the resident revision moves; the next acknowledgement corrects it vector-free.
    await mutateFactMeaning(db, { factId, newText: "Runtime session store is Redis Cluster", chronicle: { actor: "user", userStatedRationale: "cluster mode for failover" } });
    const corrected = await ask("ok", A);
    expect(corrected.embeddings).toBe(0);
    expect(corrected.context).toContain("[MEMEX CORRECTION]");
    expect(corrected.context).toContain("Runtime session store is Redis Cluster");
    expect(corrected.context).toContain('earlier: "Runtime session store is Redis"');
    zero.stale_fact_correction_failure = corrected.context.includes("Redis Cluster") ? 0 : 1;

    // Different workstream in the same project: unmerged workstream truth never leaks.
    ensureSessionMemoryState(db, { sessionId: B, project: PROJECT, prompt: "Design the billing invoice PDF export layout" });
    expect((db.prepare("SELECT workstream_id FROM session_memory_state WHERE session_id = ?").get(B) as { workstream_id: string }).workstream_id).not.toBe(stateA.workstreamId);
    const wrongWorkstream = await ask("Which runtime session store are we on?", B);
    expect(wrongWorkstream.context).not.toContain("Redis");
    zero.unmerged_project_current_promotion = count("SELECT COUNT(*) AS n FROM facts WHERE promotion_state IN ('project-current','decision')");
    // Explicit merge/validation promotion is the only path to project-wide truth.
    assignFactSubject(db, { factId, projectId: stateA.projectId, subjectKey: SUBJECT, promotionState: "project-current", evidence: "merged" });
    const promoted = await ask("Which runtime session store are we on now?", B);
    expect(promoted.context).toContain("Runtime session store is Redis Cluster");

    // Same workstream, sibling session C shares Capsule and current truth.
    ensureSessionMemoryState(db, { sessionId: C, project: PROJECT, explicitWorkstreamId: stateA.workstreamId });
    const sibling = await ask("continue", C);
    expect(sibling.embeddings).toBe(0);
    expect(sibling.context).toContain("[WORK NOW]");
    expect(sibling.context).toContain("Migrate the runtime session store to Redis");

    // WATCH from two independent verified episodes; MCP deep trace with lanes.
    const redisExchange = byText.get(REDIS_TEXT)!.id;
    const laterExchange = byText.get(filler(11))!.id;
    recordIncidentOccurrence(db, { projectId: stateA.projectId, workstreamId: stateA.workstreamId, sessionId: A, signatureText: INCIDENT, sourceExchangeIds: [redisExchange], evidenceAuthority: "human", actor: "extractor", effectiveAt: turnTimestamp(8) });
    recordIncidentOccurrence(db, { projectId: stateA.projectId, workstreamId: stateA.workstreamId, sessionId: "final-session-x", signatureText: INCIDENT, sourceExchangeIds: [laterExchange], evidenceAuthority: "human", actor: "extractor", effectiveAt: turnTimestamp(11) });
    const watch = await ask(`the failover suite fails again with ${INCIDENT}`, A);
    expect(watch.context).toContain("[WATCH — VERIFIED INCIDENT PATTERN]");
    expect(watch.context).toContain("2 verified episodes");
    const trace = await handleToolCall("trace_fact", { subject_key: SUBJECT, scope: "project", project_id: stateA.projectId, include_incidents: true });
    const traceText = trace.content[0].text;
    expect(traceText).toContain("[CURRENT FACT] Runtime session store is Redis Cluster");
    expect(traceText).toContain("CHANGED");
    expect(traceText).toContain(`grounded cause (source-cited): ${REDIS_CAUSE}`);
    expect(traceText).toContain("NOT authoritative");
    const traceOther = await handleToolCall("trace_fact", { fact_id: factId, scope: "project", project_id: otherState.projectId });
    expect(traceOther.isError).toBe(true);
    zero.cross_project_injection = injected.filter((context) => context.includes("DynamoDB")).length;
    zero.wrong_workstream_injection = wrongWorkstream.context.includes("Redis") ? 1 : 0;

    // ---- 6. Sync export/import into a second database, duplicate delivery, uncommitted generation ----
    const exported = exportForSync();
    // The promoted Redis fact plus the other project's own project-scoped fact.
    expect(exported.facts).toBe(2);
    expect(exported.revisions).toBeGreaterThanOrEqual(3);
    const devicesDir = path.join(getSyncDir(), "devices");
    const [deviceA] = fs.readdirSync(devicesDir);
    const generationsDir = path.join(devicesDir, deviceA, "generations");
    const committed = JSON.parse(fs.readFileSync(path.join(devicesDir, deviceA, "CURRENT"), "utf-8")) as { generation: string };
    const snapshotDir = path.join(root, "pre-purge-generation");
    fs.cpSync(path.join(generationsDir, committed.generation), snapshotDir, { recursive: true });
    // A crashed export leaves an unreferenced generation: importers never read it.
    const crashedGeneration = path.join(generationsDir, "crashed-generation");
    fs.cpSync(snapshotDir, crashedGeneration, { recursive: true });
    fs.writeFileSync(path.join(crashedGeneration, "facts.jsonl"), fs.readFileSync(path.join(snapshotDir, "facts.jsonl"), "utf-8").replace("Redis Cluster", "Riak"));
    db.close();
    openDb("b");
    const firstImport = await importFromSync();
    expect(firstImport.malformedRows).toEqual([]);
    expect(firstImport.newFacts).toBe(2);
    expect(firstImport.newRevisions).toBe(exported.revisions);
    expect((db.prepare("SELECT fact FROM facts WHERE id = ?").get(factId) as { fact: string }).fact).toBe("Runtime session store is Redis Cluster");
    const secondImport = await importFromSync();
    expect(secondImport).toMatchObject({ newFacts: 0, updatedFacts: 0, newRevisions: 0 });
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(exported.revisions);
    const peerProject = (db.prepare("SELECT project_id FROM facts WHERE id = ?").get(factId) as { project_id: string }).project_id;
    expect(count("SELECT memory_revision AS n FROM projects WHERE project_id = ?", peerProject)).toBeGreaterThanOrEqual(1);
    const peerTrace = await handleToolCall("trace_fact", { fact_id: factId, scope: "project", project_id: peerProject, include_incidents: false });
    expect(peerTrace.content[0].text).toContain("source unavailable (purged or missing)");
    expect(peerTrace.content[0].text).toContain(REDIS_CAUSE);
    db.close();

    // ---- 7. Privacy purge on the origin: crash injection, full cascade, replay refusal ----
    openDb("a");
    db.exec("CREATE TRIGGER purge_crash BEFORE DELETE ON journal_streams BEGIN SELECT RAISE(ABORT, 'purge-crash'); END");
    expect(() => purgeConversationFromIndex(db, { archivePath: transcriptFor(A), sessionId: A })).toThrow(/purge-crash/);
    db.exec("DROP TRIGGER purge_crash");
    expect(count("SELECT COUNT(*) AS n FROM conversation_exclusions WHERE session_id = ?", A)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?", A)).toBe(15);
    expect(count("SELECT COUNT(*) AS n FROM facts WHERE id = ?", factId)).toBe(1);
    const purged = purgeConversationFromIndex(db, { archivePath: transcriptFor(A), sessionId: A });
    expect(purged.exchanges).toBe(15);
    const purgedIds = exchangeRows.map((row) => row.id);
    const placeholders = purgedIds.map(() => "?").join(",");
    const residue = {
      exchanges: count("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?", A),
      vectors: count(`SELECT COUNT(*) AS n FROM vec_exchanges WHERE id IN (${placeholders})`, ...purgedIds),
      journals: count("SELECT COUNT(*) AS n FROM journal_streams WHERE session_id = ?", A),
      blocks: count("SELECT COUNT(*) AS n FROM journal_blocks WHERE session_id = ?", A),
      checkpoints: count("SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ?", A),
      jobs: count("SELECT COUNT(*) AS n FROM memory_jobs WHERE partition_key IN (?, ?)", `session:${A}`, `workstream:${stateA.workstreamId}`),
      targets: count("SELECT COUNT(*) AS n FROM extraction_targets WHERE session_id = ?", A),
      generationState: count(`SELECT COUNT(*) AS n FROM exchange_extraction_state WHERE exchange_id IN (${placeholders})`, ...purgedIds),
      hotEvidence: count("SELECT COUNT(*) AS n FROM hot_evidence WHERE session_id = ?", A),
      sessionState: count("SELECT COUNT(*) AS n FROM session_memory_state WHERE session_id = ?", A),
      recall: count("SELECT COUNT(*) AS n FROM recall_events WHERE session_id = ?", A),
      capsule: count("SELECT COUNT(*) AS n FROM work_capsules WHERE source_session_id = ?", A),
      fact: count("SELECT COUNT(*) AS n FROM facts WHERE id = ?", factId),
      events: count("SELECT COUNT(*) AS n FROM fact_revisions WHERE fact_id = ?", factId),
      incidents: count("SELECT COUNT(*) AS n FROM incident_occurrences WHERE project_id = ?", stateA.projectId),
      journalDir: fs.existsSync(path.join(process.env.MEMEX_HOME as string, "journals", A)) ? 1 : 0,
    };
    expect(residue).toEqual(Object.fromEntries(Object.keys(residue).map((key) => [key, 0])));
    expect(count("SELECT COUNT(*) AS n FROM fact_tombstones WHERE fact_id = ?", factId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM chronicle_tombstones")).toBeGreaterThanOrEqual(3);
    // Sibling sessions keep their bindings but lose the purged projection and re-receive WORK NOW later.
    expect(count("SELECT COUNT(*) AS n FROM session_memory_state WHERE session_id = ?", C)).toBe(1);
    expect((db.prepare("SELECT capsule_generation_seen AS n FROM session_memory_state WHERE session_id = ?").get(C) as { n: number }).n).toBe(0);

    // Replay after purge: hooks, worker, extraction and injection recreate nothing.
    appendTurn(A, 16, "Private follow-up that must never be indexed");
    expect(handleContinuityHook(hook(A, "Stop", { turn_id: "turn-16" }), { db })).toEqual({ stdout: "" });
    expect(handleContinuityHook(hook(A, "SessionEnd", { reason: "other" }), { db })).toEqual({ stdout: "" });
    expect(await runContinuityWorker(db, { maxJobs: 4, model: capsuleModel })).toEqual([]);
    expect(await runFactExtraction(db, A, PROJECT)).toEqual({ extracted: 0, saved: 0 });
    const afterPurge = await inject("Which runtime session store are we on?", C);
    expect(afterPurge.context).not.toContain("Redis");
    const resurrection = count("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?", A) + count("SELECT COUNT(*) AS n FROM facts WHERE id = ?", factId) + count("SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ?", A);

    // Purge propagates through sync; a stale pre-purge generation from a third device resurrects nothing.
    const purgedExport = exportForSync();
    expect(purgedExport.tombstones).toBeGreaterThanOrEqual(4);
    db.close();
    openDb("b");
    const purgeImport = await importFromSync();
    expect(purgeImport.deletedFacts).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM facts WHERE id = ?", factId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions WHERE fact_id = ?", factId)).toBe(0);
    const staleDevice = path.join(devicesDir, "device-stale");
    fs.mkdirSync(path.join(staleDevice, "generations"), { recursive: true });
    fs.cpSync(snapshotDir, path.join(staleDevice, "generations", committed.generation), { recursive: true });
    fs.writeFileSync(path.join(staleDevice, "CURRENT"), JSON.stringify({ generation: committed.generation, exported_at: new Date().toISOString() }));
    const staleReplay = await importFromSync();
    expect(staleReplay.newFacts).toBe(0);
    expect(staleReplay.newRevisions).toBe(0);
    zero.purged_memory_resurrection = resurrection
      + count("SELECT COUNT(*) AS n FROM facts WHERE id = ?", factId)
      + count("SELECT COUNT(*) AS n FROM fact_revisions WHERE fact_id = ?", factId)
      + count("SELECT COUNT(*) AS n FROM facts WHERE fact LIKE '%Riak%'");

    expect(zero).toEqual({
      unaccounted_closed_exchanges: 0,
      checkpoint_prefix_hash_mismatch: 0,
      cursor_overrun: 0,
      silent_skipped_pages: 0,
      duplicate_authoritative_chronicle_event: 0,
      cross_project_injection: 0,
      wrong_workstream_injection: 0,
      unmerged_project_current_promotion: 0,
      purged_memory_resurrection: 0,
      compact_rehydration_miss: 0,
      stale_fact_correction_failure: 0,
      ungrounded_cause_authoritative: 0,
      postcompact_dependency_failure: 0,
    });
    expect(extractionCalls).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("P0 capture indexing is never blocked by a pending P2 extraction job in the same session partition", async () => {
    const S = "final-partition-session";
    startTranscript(S);
    for (let turn = 1; turn <= 12; turn++) {
      appendTurn(S, turn, `Decision ${turn}: the session store for this service must use Redis with TTL refresh on reconnect.`);
      handleContinuityHook(hook(S, "Stop", { turn_id: `turn-${turn}` }), { db });
    }
    await drainCapture();
    expect(count("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ? AND closure_state = 'closed'", S)).toBe(12);

    // One extraction page (5 rows) of a 12-row target: the fact_extract job
    // stays pending with a cursor, exactly like a real multi-run session.
    const first = await runFactExtraction(db, S, PROJECT);
    expect(first.skipped).toBeUndefined();
    const target = db.prepare("SELECT state, cursor_ordinal, item_count FROM extraction_targets").get() as { state: string; cursor_ordinal: number; item_count: number };
    expect(target.item_count).toBe(12);
    expect(target.cursor_ordinal).toBeGreaterThan(0);
    expect(target.cursor_ordinal).toBeLessThan(12);
    expect(db.prepare("SELECT state FROM memory_jobs WHERE kind = 'fact_extract'").get()).toEqual({ state: "pending" });

    appendTurn(S, 13, "Decision 13: reconnect callbacks must re-arm the TTL.");
    const capture = handleContinuityHook(hook(S, "Stop", { turn_id: "turn-13" }), { db });
    expect(capture.capture?.created).toBe(true);
    const results = await runContinuityWorker(db, { maxJobs: 2, model: capsuleModel });
    expect(results.map((r) => [r.kind, r.state])).toContainEqual(["capture_index", "completed"]);
    expect(db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?").get(capture.capture!.captureIndexJobId)).toEqual({ state: "completed" });
    // Extraction waits for the capture lane, then resumes its own cursor.
    await runFactExtraction(db, S, PROJECT);
    expect((db.prepare("SELECT cursor_ordinal FROM extraction_targets").get() as { cursor_ordinal: number }).cursor_ordinal).toBeGreaterThan(target.cursor_ordinal);
  });

  it("privacy purge removes a Capsule projection derived from the purged session even when a sibling shares the workstream", () => {
    const A = "final-purge-a";
    const B = "final-purge-b";
    startTranscript(A);
    appendTurn(A, 1, "Private: our Redis password rotates every 7 days");
    const stateA = ensureSessionMemoryState(db, { sessionId: A, project: PROJECT });
    const exchange: ConversationExchange = {
      id: "purge-a-exchange", project: PROJECT, cwd: PROJECT, timestamp: "2026-09-04T00:00:01Z",
      userMessage: "Private: our Redis password rotates every 7 days", assistantMessage: "noted",
      archivePath: transcriptFor(A), lineStart: 2, lineEnd: 3, sessionId: A, closureState: "closed", contentGeneration: 1, parserVersion: 2,
    };
    insertExchange(db, exchange, new Array(384).fill(0.01));
    const cp = captureTranscriptPrefix(db, { sessionId: A, project: PROJECT, transcriptPath: transcriptFor(A), kind: "precompact" });
    const capsule = applyWorkCapsulePatch(db, {
      workstreamId: stateA.workstreamId, expectedGeneration: 0, throughCheckpointId: cp.checkpointId,
      patch: {
        objective: "Rotate the Redis password every 7 days", currentState: "private rotation policy captured",
        verifiedProgress: [{ text: "Redis password rotates every 7 days", sourceExchangeIds: ["purge-a-exchange"] }],
        hypotheses: [], blockers: [], openQuestions: [], nextActions: [], touchedAreas: [], carryFactRevisions: [],
        sourceExchangeIds: ["purge-a-exchange"],
      },
    });
    expect(capsule?.generation).toBe(1);
    ensureSessionMemoryState(db, { sessionId: B, project: PROJECT, explicitWorkstreamId: stateA.workstreamId });
    db.prepare("UPDATE session_memory_state SET capsule_generation_seen = 1 WHERE session_id = ?").run(B);

    purgeConversationFromIndex(db, { archivePath: transcriptFor(A), sessionId: A });

    expect(count("SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?", A)).toBe(0);
    expect(db.prepare("SELECT 1 FROM work_capsules WHERE workstream_id = ?").get(stateA.workstreamId)).toBeUndefined();
    expect(count("SELECT COUNT(*) AS n FROM minimal_workstreams WHERE workstream_id = ?", stateA.workstreamId)).toBe(1);
    expect((db.prepare("SELECT capsule_generation_seen AS n FROM session_memory_state WHERE session_id = ?").get(B) as { n: number }).n).toBe(0);
  });
});
