/**
 * Phase 5B adversarial gate suite. Runs the real prompt path on the
 * deterministic embedding stub (no mocked embedding module) so probe warm-up
 * and memo hits are real model-call accounting, and builds the two-session /
 * two-workstream / compaction cases the 5A suite did not cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase, insertExchange } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import { mutateFactMeaning } from "../src/fact-management.js";
import { computeInjectContext } from "../src/inject-core.js";
import { embeddingCallStats, stubEmbedding } from "../src/embeddings.js";
import { decideRecall, type RecallGateState } from "../src/recall-gate.js";
import { recordIncidentOccurrence, recordChronicleEvent } from "../src/chronicle.js";
import { advanceContextEpoch, ensureSessionMemoryState, handleContinuityHook } from "../src/continuity-core.js";
import { bindSessionWorkstream, createWorkstream, indexHotEvidenceForSession, sessionProjectRevisionState } from "../src/continuity-identity.js";
import type { ConversationExchange } from "../src/types.js";

let root: string;
let db: Database.Database;
const cwd = "/project/recall-gate";
const SESSION = "gate-session";

function exchange(id: string, sessionId: string, timestamp: string, userMessage: string, assistantMessage = "context only"): ConversationExchange {
  return {
    id, project: cwd, cwd, timestamp, userMessage, assistantMessage,
    archivePath: path.join(root, `${sessionId}.jsonl`), lineStart: 1, lineEnd: 2, sessionId,
    closureState: "closed", parserVersion: 2,
  };
}

function fact(text: string, extra: Partial<Parameters<typeof insertFact>[1]> = {}): string {
  return insertFact(db, {
    fact: text, category: "decision", scope_type: "project", scope_project: cwd, source_exchange_ids: [],
    embedding: stubEmbedding(text), ...extra,
  });
}

/** `embeddings` counts embedding requests (model inferences plus query-memo hits) made for the prompt. */
async function inject(prompt: string, session = SESSION, options: Parameters<typeof computeInjectContext>[4] = {}) {
  const before = embeddingCallStats();
  const context = await computeInjectContext(prompt, cwd, "daemon", session, options);
  const after = embeddingCallStats();
  return { context, embeddings: (after.modelCalls - before.modelCalls) + (after.cacheHits - before.cacheHits) };
}

function settleRevision(session = SESSION): void {
  db.prepare("UPDATE session_memory_state SET memory_revision_seen = (SELECT memory_revision FROM projects WHERE project_id = session_memory_state.project_id) WHERE session_id = ?").run(session);
}

function telemetryTotal(metric: string, session = SESSION): number {
  return Number((db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM continuity_telemetry WHERE metric = ? AND session_id = ?").get(metric, session) as { v: number }).v);
}

function capsule(workstreamId: string, generation: number, objective = "Ship the Redis session store"): void {
  db.prepare(`
    INSERT INTO work_capsules (workstream_id, generation, objective, current_state, next_actions_json, updated_at)
    VALUES (?, ?, ?, 'client wired, tests pending', '["run the failover test"]', ?)
    ON CONFLICT(workstream_id) DO UPDATE SET generation = excluded.generation, objective = excluded.objective,
      current_state = excluded.current_state, next_actions_json = excluded.next_actions_json
  `).run(workstreamId, generation, objective, new Date().toISOString());
}

function compactEpoch(session = SESSION): void {
  advanceContextEpoch(db, { sessionId: session, source: "compact", turnId: `c-${Date.now()}` });
  db.prepare("UPDATE session_memory_state SET last_source = 'compact' WHERE session_id = ?").run(session);
}

const baseState: RecallGateState = {
  contextEpoch: 0, lastRetrievalEpoch: 0, lastSource: null, capsuleGenerationSeen: 0, memoryRevisionSeen: 0,
  topicFingerprint: ["redis", "session", "store", "client"], hasTopicEmbedding: true,
  informativePromptsSinceRetrieval: 0, residentTokens: new Set(["redis", "session", "store"]),
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-recall-gate-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_EMBEDDING_STUB;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Phase 5B adversarial gate", () => {
  it("1. a continuation as the first prompt of a session or epoch carries WORK NOW with zero embeddings", async () => {
    const scope = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    capsule(scope.workstreamId, 1);
    fact("The runtime session store is Redis");
    settleRevision();
    const first = await inject("이어서 계속해줘");
    expect(first.embeddings).toBe(0);
    expect(first.context).toContain("[WORK NOW]");
    expect(first.context).toContain("Objective: Ship the Redis session store");
    expect(first.context).not.toContain("[CURRENT TRUTH]");
    const again = await inject("continue");
    expect(again).toEqual({ context: "", embeddings: 0 });
    compactEpoch();
    const afterCompact = await inject("continue");
    expect(afterCompact.embeddings).toBe(0);
    expect(afterCompact.context).toContain("[WORK NOW]");
    const substantive = await inject("Configure the redis runtime session store client now");
    expect(substantive.embeddings).toBeGreaterThanOrEqual(1);
    expect(substantive.context).toContain("[CURRENT TRUTH]");
    expect(substantive.context).not.toContain("[WORK NOW]");
  });

  it("2. a stale project revision never swallows the prompt's own recall, corrects resident facts only, and does not push never-resident sibling facts", async () => {
    const pid = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" }).projectId;
    const main = fact("Main uses MySQL as the session store", { subject_key: "state.main.session_store", project_id: pid });
    const rollout = fact("Deployments use blue green rollout with health checks", { subject_key: "state.deploy.rollout", project_id: pid });
    recordChronicleEvent(db, { kind: "ASSERTED", projectId: pid, subjectKey: "state.deploy.rollout", factId: rollout, newValue: "Deployments use blue green rollout with health checks", actor: "user", projectionApplied: true });
    settleRevision();
    const resident = await inject("Configure the mysql session store client");
    expect(resident.context).toContain("Main uses MySQL");
    // A sibling session changes the resident fact and distills an unrelated new one.
    await mutateFactMeaning(db, { factId: main, newText: "Main uses Redis as the session store", chronicle: { actor: "user", userStatedRationale: "migrated" } });
    fact("The payment retry limit is three attempts", { subject_key: "state.payment.retry_limit", project_id: pid });
    const asked = await inject("Why did we choose the blue green rollout with health checks?");
    expect(asked.context).toContain("[MEMEX CORRECTION]");
    expect(asked.context).toContain("Main uses Redis as the session store");
    expect(asked.context).toContain("[CURRENT TRUTH]");
    expect(asked.context).toContain("blue green rollout");
    expect(asked.context).toContain("[TRACE — HISTORY AVAILABLE]");
    expect(asked.context).toContain("subject_key=state.deploy.rollout");
    expect(asked.context.indexOf("[MEMEX CORRECTION]")).toBeLessThan(asked.context.indexOf("[CURRENT TRUTH]"));
    expect(asked.context).not.toContain("payment retry limit");
    const state = sessionProjectRevisionState(db, SESSION);
    expect(state.seen).toBe(state.current);
    expect(telemetryTotal("project_revision_invalidations")).toBe(1);
    // The sibling changes it again while the user only acknowledges: the correction still lands, without any embedding.
    await mutateFactMeaning(db, { factId: main, newText: "Main uses Redis Cluster as the session store", chronicle: { actor: "user" } });
    const ack = await inject("thanks");
    expect(ack.embeddings).toBe(0);
    expect(ack.context).toContain("[MEMEX CORRECTION]");
    expect(ack.context).toContain("Redis Cluster");
    expect(ack.context).not.toContain("[CURRENT TRUTH]");
    expect(await inject("thanks")).toEqual({ context: "", embeddings: 0 });
  });

  it("3. sibling Hot Evidence is injected once per epoch and the session's own evidence is never echoed back", async () => {
    const own = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    bindSessionWorkstream(db, { sessionId: "sibling", projectId: own.projectId, workspaceId: own.workspaceId, projectPath: cwd, explicitWorkstreamId: own.workstreamId });
    insertExchange(db, exchange("own-ex", SESSION, "2026-09-04T00:00:00.000Z", "My own latest instruction about the redis client"), stubEmbedding("own"));
    insertExchange(db, exchange("sib-ex", "sibling", "2026-09-04T00:00:00.000Z", "Sibling measured P95 240ms on the redis client benchmark"), stubEmbedding("sibling"));
    indexHotEvidenceForSession(db, SESSION, { now: "2026-09-04T00:00:01.000Z" });
    indexHotEvidenceForSession(db, "sibling", { now: "2026-09-04T00:00:01.000Z" });
    fact("The runtime session store is Redis");
    settleRevision();
    const first = await inject("Configure the redis runtime session store client", SESSION, { now: "2026-09-04T00:01:00.000Z" });
    expect(first.context).toContain("[RECENT EVIDENCE — NOT YET DISTILLED]");
    expect(first.context).toContain("Sibling measured P95");
    expect(first.context).not.toContain("My own latest instruction");
    const drift = await inject("Now rewrite the deployment rollout pipeline with canary stages and health checks", SESSION, { now: "2026-09-04T00:02:00.000Z" });
    expect(drift.embeddings).toBeGreaterThanOrEqual(1);
    expect(drift.context).not.toContain("Sibling measured P95");
    insertExchange(db, exchange("sib-ex-2", "sibling", "2026-09-04T00:03:00.000Z", "Sibling confirmed the failover test passes with TTL refresh"), stubEmbedding("sibling two"));
    indexHotEvidenceForSession(db, "sibling", { now: "2026-09-04T00:03:01.000Z" });
    const next = await inject("Investigate the kafka consumer lag alerts and partition rebalance storms in staging", SESSION, { now: "2026-09-04T00:04:00.000Z" });
    expect(next.context).toContain("Sibling confirmed the failover");
    expect(next.context).not.toContain("Sibling measured P95");
    // Compaction loses the context: SessionStart(compact) rehydrates it, and the first prompt afterwards does not repeat it.
    const rehydrated = handleContinuityHook({ hook_event_name: "SessionStart", session_id: SESSION, cwd, source: "compact" }, { db });
    expect(rehydrated.stdout).toContain("Sibling confirmed the failover");
    const afterCompact = await inject("Tune the redis session store timeout for the api gateway path", SESSION, { now: "2026-09-04T00:05:00.000Z" });
    expect(afterCompact.embeddings).toBeGreaterThanOrEqual(1);
    expect(afterCompact.context).not.toContain("Sibling confirmed the failover");
  });

  it("4. a WATCH warning is suppressed inside its TTL and re-emitted on a fresh match after five substantive prompts", async () => {
    const pid = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" }).projectId;
    insertExchange(db, exchange("ex-1", "s-a", "2026-07-02T10:00:00.000Z", "run tests"), stubEmbedding("run tests"));
    db.prepare("INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable) VALUES ('t1','ex-1','shell','{}','FAIL redis reconnect: missing TTL refresh',1,'2026-07-02T10:00:00.000Z','test_execution',1)").run();
    insertExchange(db, exchange("ex-2", "s-b", "2026-08-14T10:00:00.000Z", "failover test"), stubEmbedding("failover"));
    db.prepare("INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable) VALUES ('t2','ex-2','shell','{}','FAIL redis reconnect: missing TTL refresh',1,'2026-08-14T10:00:00.000Z','test_execution',1)").run();
    recordIncidentOccurrence(db, { projectId: pid, sessionId: "s-a", signatureText: "FAIL redis reconnect: missing TTL refresh", sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    recordIncidentOccurrence(db, { projectId: pid, sessionId: "s-b", signatureText: "FAIL redis reconnect: missing TTL refresh", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    fact("The runtime session store is Redis");
    settleRevision();
    const signature = "The suite prints FAIL redis reconnect: missing TTL refresh in staging";
    const emitted = await inject(signature);
    expect(emitted.context).toContain("[WATCH — VERIFIED INCIDENT PATTERN]");
    expect((await inject(`${signature} once more`)).context).not.toContain("[WATCH");
    const drifts = [
      "Rewrite the deployment rollout pipeline with canary stages and health checks",
      "Investigate the kafka consumer lag alerts and partition rebalance storms",
      "Design the billing invoice export job with monthly aggregation windows",
      "Refactor the notification dispatcher retries with exponential backoff",
      "Document the onboarding checklist for the platform infrastructure team",
    ];
    for (const prompt of drifts) await inject(prompt);
    const again = await inject(`${signature} after the rollout`);
    expect(again.context).toContain("[WATCH — VERIFIED INCIDENT PATTERN]");
    expect(telemetryTotal("watch_emissions")).toBe(2);
    expect((await inject(`${signature} yet again in staging`)).context).not.toContain("[WATCH");
  });

  it("5. the first prompt after a SessionStart(compact) rehydration retrieves but does not repeat the Capsule; an empty Capsule generation cannot force retrieval forever", async () => {
    const scope = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    capsule(scope.workstreamId, 1);
    fact("The runtime session store is Redis");
    fact("Deployments use blue green rollout with health checks");
    settleRevision();
    expect((await inject("Configure the redis runtime session store client")).context).toContain("[WORK NOW]");
    const rehydrated = handleContinuityHook({ hook_event_name: "SessionStart", session_id: SESSION, cwd, source: "compact" }, { db });
    expect(rehydrated.stdout).toContain("[WORK NOW]");
    const after = await inject("Rewrite the deployment rollout pipeline with canary stages and health checks");
    expect(after.embeddings).toBeGreaterThanOrEqual(1);
    expect(after.context).toContain("blue green rollout");
    expect(after.context).not.toContain("[WORK NOW]");
    // A Capsule generation with nothing to show is still marked resident.
    db.prepare("UPDATE work_capsules SET generation = 2, objective = '', current_state = '', next_actions_json = '[]' WHERE workstream_id = ?").run(scope.workstreamId);
    const empty = await inject("Add health checks to the rollout stages");
    expect(empty.context).not.toContain("[WORK NOW]");
    expect(db.prepare("SELECT capsule_generation_seen AS g FROM session_memory_state WHERE session_id = ?").get(SESSION)).toEqual({ g: 2 });
    const executed = telemetryTotal("retrieval_execute_count");
    await inject("add health checks to the rollout stages too");
    expect(telemetryTotal("retrieval_execute_count")).toBe(executed);
  });

  it("6. feature/main divergent truth across two sessions: main never sees the feature fact, and the feature session is corrected at its next retrieval even off-topic", async () => {
    const main = ensureSessionMemoryState(db, { sessionId: "main-session", project: cwd, prompt: "start" });
    const feature = createWorkstream(db, { projectId: main.projectId, workspaceId: main.workspaceId, projectPath: cwd, ownerSessionId: "feature-session", branch: "feature/redis" });
    bindSessionWorkstream(db, { sessionId: "feature-session", projectId: main.projectId, workspaceId: main.workspaceId, projectPath: cwd, explicitWorkstreamId: feature });
    fact("Main uses MySQL as the session store", { subject_key: "state.main.session_store", project_id: main.projectId, promotion_state: "project-current", promotion_evidence: "validated" });
    const featureFact = insertFact(db, {
      fact: "Feature branch uses Redis as the session store", category: "knowledge", scope_type: "project", scope_project: cwd,
      source_exchange_ids: [], embedding: stubEmbedding("Feature branch uses Redis as the session store"),
      project_id: main.projectId, workspace_id: main.workspaceId, workstream_id: feature, promotion_state: "workstream", promotion_evidence: "experimental",
    });
    settleRevision("main-session");
    settleRevision("feature-session");
    const m1 = await inject("Configure the session store client for the api", "main-session");
    expect(m1.context).toContain("Main uses MySQL");
    expect(m1.context).not.toContain("Feature branch uses Redis");
    const f1 = await inject("Configure the session store client for the api", "feature-session");
    expect(f1.context).toContain("Feature branch uses Redis");
    await mutateFactMeaning(db, { factId: featureFact, newText: "Feature branch uses Redis Cluster as the session store", chronicle: { actor: "user" } });
    const m2 = await inject("Now rewrite the deployment rollout pipeline with canary stages", "main-session");
    expect(m2.context).not.toContain("Redis Cluster");
    const f2 = await inject("Now rewrite the deployment rollout pipeline with canary stages", "feature-session");
    expect(f2.context).toContain("[MEMEX CORRECTION]");
    expect(f2.context).toContain("Redis Cluster");
    expect(m2.context).not.toContain("[MEMEX CORRECTION]");
  });

  it("7. embedding metrics equal real inference counts, including probe warm-up and query memo hits", async () => {
    fact("The runtime session store is Redis");
    fact("Deployments use blue green rollout with health checks");
    settleRevision();
    const s0 = embeddingCallStats();
    await inject("Configure the redis runtime session store client with metrics accounting");
    const s1 = embeddingCallStats();
    expect(s1.modelCalls - s0.modelCalls).toBeGreaterThanOrEqual(1);
    expect(telemetryTotal("embedding_calls")).toBe(s1.modelCalls - s0.modelCalls);
    const prompt = "Now rewrite the deployment rollout pipeline with canary stages and metrics accounting";
    await inject(prompt, SESSION, { gate: false });
    await inject(prompt, SESSION, { gate: false });
    const s2 = embeddingCallStats();
    expect(telemetryTotal("embedding_calls")).toBe(s2.modelCalls - s0.modelCalls);
    expect(telemetryTotal("embedding_cache_hits")).toBe(s2.cacheHits - s0.cacheHits);
    expect(s2.cacheHits - s1.cacheHits).toBe(1);
    expect(telemetryTotal("retrieval_execute_count") + telemetryTotal("retrieval_gate_skip_count")).toBe(3);
  });

  it("8. important short prompts retrieve and pure acknowledgements skip, in Korean and English", () => {
    const decide = (prompt: string, incidentMatched = false) => decideRecall({ prompt, state: baseState, currentCapsuleGeneration: 0, currentProjectRevision: 0, incidentMatched });
    for (const prompt of [
      "왜 Redis?", "이전에 뭐 결정했지?", "출처는?", "언제 바꿨어?", "이거 전에도 났던 에러 아냐?", "근거가 뭐야",
      "why mysql?", "what did we decide?", "source?", "history of the ttl?", "same error again", "did this happen before?",
      "MySQL로 바꾸자", "롤백하자", "캐시 레이어 제거해", "switch to postgres", "drop the cache layer", "revert it",
    ]) {
      expect(decide(prompt).action, prompt).toBe("retrieve");
      expect(decide(prompt).triggers.some((t) => t === "explicit_memory_intent" || t === "high_impact_intent"), prompt).toBe(true);
    }
    expect(decide("FAIL redis reconnect: missing TTL refresh", true).triggers).toContain("incident_signature_match");
    for (const prompt of [
      "응 고마워", "ok thanks", "네 계속해주세요", "좋아 진행해", "sounds good, go ahead", "yes do that", "ㅇㅋ", "감사합니다!",
      "continue please", "그래 계속", "ok nice work", "좋아요 다음으로 넘어가요", "알겠어요 진행할게요", "go for it",
    ]) {
      expect(decide(prompt).action, prompt).toBe("skip");
    }
    // Acknowledgements still retrieve when the epoch has no retrieval yet (Capsule carry).
    expect(decideRecall({ prompt: "계속해줘", state: { ...baseState, lastRetrievalEpoch: -1 }, currentCapsuleGeneration: 1, currentProjectRevision: 0, incidentMatched: false }))
      .toMatchObject({ action: "retrieve", substantive: false });
    // A memory question as the first prompt in an epoch records the epoch trigger too.
    expect(decideRecall({ prompt: "왜 Redis?", state: { ...baseState, lastRetrievalEpoch: 0, contextEpoch: 1, lastSource: "compact" }, currentCapsuleGeneration: 0, currentProjectRevision: 0, incidentMatched: false }).triggers)
      .toEqual(["explicit_memory_intent", "compact_first_prompt"]);
  });
});
