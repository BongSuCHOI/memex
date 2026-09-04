import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

const embeddingCalls = vi.hoisted(() => ({ n: 0, fail: false }));
const factSearch = vi.hoisted(() => ({ fail: false }));

function hashedEmbedding(text: string): number[] {
  const vector = new Array<number>(384).fill(0);
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 2)) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) { hash ^= token.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
    vector[hash % 384] += 1;
  }
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  EMBEDDING_VERSION: 2,
  initEmbeddings: async () => {
    if (embeddingCalls.fail) throw new Error("embedding model unavailable");
  },
  generateEmbedding: async (text: string) => {
    if (embeddingCalls.fail) throw new Error("embedding model unavailable");
    embeddingCalls.n++;
    return hashedEmbedding(text);
  },
  // Hashed bag-of-words vectors: unrelated prompts score ~0.1, related ≥ 0.35.
  queryBaseline: async () => 0.2,
  embeddingCallStats: () => ({ modelCalls: embeddingCalls.n, cacheHits: 0 }),
}));
vi.mock("../src/fact-db.js", async (io) => {
  const actual = await io<typeof import("../src/fact-db.js")>();
  return {
    ...actual,
    searchFactsByScope: (...args: Parameters<typeof actual.searchFactsByScope>) => {
      if (factSearch.fail) throw new Error("vector index unavailable");
      return actual.searchFactsByScope(...args);
    },
  };
});
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase, insertExchange } from "../src/db.js";
import { getActiveFacts, insertFact } from "../src/fact-db.js";
import { deactivateFactTransactional, mutateFactMeaning } from "../src/fact-management.js";
import { createRelation } from "../src/ontology-db.js";
import { computeInjectContext } from "../src/inject-core.js";
import { decideRecall, detectPromptIntents, tokenizePrompt } from "../src/recall-gate.js";
import { NORMAL_BUNDLE_BUDGET, REHYDRATION_BUNDLE_BUDGET, renderMemoryBundle } from "../src/memory-bundle.js";
import { recordIncidentOccurrence, recordChronicleEvent, summarizeTelemetry } from "../src/chronicle.js";
import { advanceContextEpoch, buildRehydrationContext, ensureSessionMemoryState, handleContinuityHook } from "../src/continuity-core.js";
import { createWorkstream, bindSessionWorkstream } from "../src/continuity-identity.js";
import { handleToolCall } from "../src/mcp-server.js";
import type { ConversationExchange } from "../src/types.js";

let root: string;
let db: Database.Database;
const cwd = "/project/recall";
const SESSION = "recall-session-1";

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
    embedding: hashedEmbedding(text), ...extra,
  });
}

async function inject(prompt: string, session = SESSION, options: Parameters<typeof computeInjectContext>[4] = {}) {
  const before = embeddingCalls.n;
  const context = await computeInjectContext(prompt, cwd, "daemon", session, options);
  return { context, embeddings: embeddingCalls.n - before };
}

function gateState(session = SESSION) {
  return db.prepare(`
    SELECT informative_prompts_since_retrieval AS informative, last_retrieval_epoch AS lastEpoch,
           topic_fingerprint_json AS fingerprint, context_epoch AS epoch, resident_fact_revisions_json AS resident
    FROM session_memory_state WHERE session_id = ?
  `).get(session) as { informative: number; lastEpoch: number; fingerprint: string; epoch: number; resident: string };
}

/** Facts inserted after the session exists bump the project revision; consume it so the next prompt is not a forced correction. */
function settleRevision(session = SESSION): void {
  db.prepare("UPDATE session_memory_state SET memory_revision_seen = (SELECT memory_revision FROM projects WHERE project_id = session_memory_state.project_id) WHERE session_id = ?").run(session);
}

function telemetryTotal(metric: string, session = SESSION): number {
  return Number((db.prepare("SELECT COALESCE(SUM(value), 0) AS v FROM continuity_telemetry WHERE metric = ? AND session_id = ?").get(metric, session) as { v: number }).v);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-recall-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  embeddingCalls.n = 0;
  embeddingCalls.fail = false;
  factSearch.fail = false;
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("cheap gate", () => {
  it("a. acknowledgements and continuations skip with zero embedding, vector, graph or model work", async () => {
    fact("The runtime session store is Redis");
    const first = await inject("What is our runtime session store decision?");
    expect(first.embeddings).toBe(1);
    for (const prompt of ["고마워", "ok thanks", "계속해", "continue", "응"]) {
      const result = await inject(prompt);
      expect(result.context).toBe("");
      expect(result.embeddings).toBe(0);
    }
    expect(telemetryTotal("retrieval_gate_skip_count")).toBe(5);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recall_events").get()).toEqual({ n: 1 });
    expect(gateState().informative).toBe(0); // acks are not substantive
  });

  it("b. a short explicit memory question is never skipped for being short", async () => {
    fact("The runtime session store is Redis");
    await inject("Set up the runtime session store client wrapper for the API");
    const result = await inject("왜 Redis?");
    expect(result.embeddings).toBe(1);
    expect(detectPromptIntents("why redis").memory).toBe(true);
    expect(decideRecall({
      prompt: "왜 Redis?",
      state: { contextEpoch: 0, lastRetrievalEpoch: 0, lastSource: null, capsuleGenerationSeen: 0, memoryRevisionSeen: 0, topicFingerprint: ["redis"], hasTopicEmbedding: true, informativePromptsSinceRetrieval: 0, residentTokens: new Set(["redis"]) },
      currentCapsuleGeneration: 0, currentProjectRevision: 0, incidentMatched: false,
    })).toMatchObject({ action: "retrieve", triggers: ["explicit_memory_intent"] });
  });

  it("c/f/g/h. first substantive prompt, topic drift, low coverage and safety refresh trigger; coherent follow-ups do not", async () => {
    fact("The runtime session store is Redis for burst traffic");
    fact("Deployments use blue green rollout with health checks");
    const first = await inject("Configure the redis session store client for burst traffic");
    expect(first.embeddings).toBe(1);
    expect(gateState().lastEpoch).toBe(0);
    const followUp = await inject("add the redis client retry option too");
    expect(followUp.embeddings).toBeLessThanOrEqual(1);
    expect(followUp.context).toBe("");
    const drift = await inject("Now rewrite the deployment rollout pipeline with health checks and canary stages");
    expect(drift.embeddings).toBe(1);
    expect(drift.context).toContain("blue green rollout");
    const coverageBase = await inject("Tune the redis session store timeout for the api gateway path");
    expect(coverageBase.embeddings).toBeLessThanOrEqual(1);
    const lowCoverage = decideRecall({
      prompt: "Investigate the kafka consumer lag alerts and partition rebalance storms in staging",
      state: { contextEpoch: 0, lastRetrievalEpoch: 0, lastSource: null, capsuleGenerationSeen: 0, memoryRevisionSeen: 0, topicFingerprint: ["redis", "session", "store", "timeout", "kafka", "consumer", "lag", "alerts", "partition", "rebalance", "storms", "staging"], hasTopicEmbedding: true, informativePromptsSinceRetrieval: 0, residentTokens: new Set(["redis", "session"]) },
      currentCapsuleGeneration: 0, currentProjectRevision: 0, incidentMatched: false,
    });
    expect(lowCoverage.triggers).toContain("low_resident_coverage");
    const refresh = decideRecall({
      prompt: "tweak the redis session store timeout value",
      state: { contextEpoch: 0, lastRetrievalEpoch: 0, lastSource: null, capsuleGenerationSeen: 0, memoryRevisionSeen: 0, topicFingerprint: ["redis", "session", "store", "timeout"], hasTopicEmbedding: true, informativePromptsSinceRetrieval: 6, residentTokens: new Set(["redis", "session", "store", "timeout"]) },
      currentCapsuleGeneration: 0, currentProjectRevision: 0, incidentMatched: false,
    });
    expect(refresh.triggers).toContain("safety_refresh");
    const coherent = decideRecall({
      prompt: "tweak the redis timeout for the gateway api path",
      state: { contextEpoch: 0, lastRetrievalEpoch: 0, lastSource: null, capsuleGenerationSeen: 0, memoryRevisionSeen: 0, topicFingerprint: ["redis", "session", "store", "timeout"], hasTopicEmbedding: true, informativePromptsSinceRetrieval: 1, residentTokens: new Set(["redis", "session", "store", "timeout"]) },
      currentCapsuleGeneration: 0, currentProjectRevision: 0, incidentMatched: false,
    });
    expect(coherent.action).toBe("ambiguous");
    const lexical = decideRecall({
      prompt: "tweak the redis session store timeout value once more",
      state: { contextEpoch: 0, lastRetrievalEpoch: 0, lastSource: null, capsuleGenerationSeen: 0, memoryRevisionSeen: 0, topicFingerprint: ["tweak", "redis", "session", "store", "timeout", "value"], hasTopicEmbedding: true, informativePromptsSinceRetrieval: 1, residentTokens: new Set(["redis"]) },
      currentCapsuleGeneration: 0, currentProjectRevision: 0, incidentMatched: false,
    });
    expect(lexical).toMatchObject({ action: "skip", skipReason: "coherent_topic" });
  });

  it("d/i. a new Capsule generation and the first prompt after compact retrieve and render WORK NOW", async () => {
    fact("The runtime session store is Redis");
    const scope = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    await inject("Configure the redis session store client");
    const quiet = await inject("also log redis client errors");
    expect(quiet.context).toBe("");
    db.prepare(`
      INSERT INTO work_capsules (workstream_id, generation, objective, current_state, next_actions_json, updated_at)
      VALUES (?, 1, 'Ship the Redis session store', 'client wired, tests pending', '["run the failover test"]', ?)
      ON CONFLICT(workstream_id) DO UPDATE SET generation = 1, objective = excluded.objective, current_state = excluded.current_state, next_actions_json = excluded.next_actions_json
    `).run(scope.workstreamId, new Date().toISOString());
    const capsule = await inject("also log redis client warnings");
    expect(capsule.embeddings).toBe(1);
    expect(capsule.context).toContain("[WORK NOW]");
    expect(capsule.context).toContain("Objective: Ship the Redis session store");
    expect(capsule.context.indexOf("[WORK NOW]")).toBeLessThan(capsule.context.indexOf("[CURRENT TRUTH]") === -1 ? Infinity : capsule.context.indexOf("[CURRENT TRUTH]"));
    const again = await inject("also log redis client info");
    expect(again.context).not.toContain("[WORK NOW]");
    advanceContextEpoch(db, { sessionId: SESSION, source: "compact", turnId: "t-compact" });
    db.prepare("UPDATE session_memory_state SET last_source = 'compact' WHERE session_id = ?").run(SESSION);
    const afterCompact = await inject("also log redis client debug");
    expect(afterCompact.embeddings).toBe(1);
    expect(afterCompact.context).toContain("[WORK NOW]");
  });

  it("e. a stale project memory revision forces retrieval and emits the correction before ordinary results", async () => {
    const id = fact("Main uses MySQL as the session store", { subject_key: "state.main.session_store" });
    await inject("Configure the mysql session store client");
    expect(gateState().resident).toContain(id);
    await mutateFactMeaning(db, { factId: id, newText: "Main uses Redis as the session store", chronicle: { actor: "user", userStatedRationale: "migrated" } });
    const result = await inject("ok now wire the session store client");
    expect(result.context).toContain("[MEMEX CORRECTION]");
    expect(result.context).toContain("Main uses Redis as the session store");
    expect(telemetryTotal("project_revision_invalidations")).toBe(1);
  });
});

describe("delta, residency and bundle", () => {
  it("j/k/l. same revision is suppressed, a new generation is a correction, an inactive resident fact is retracted", async () => {
    const id = fact("The runtime session store is Redis");
    const first = await inject("Configure the redis runtime session store client");
    expect(first.context).toContain("[CURRENT TRUTH]");
    const repeat = await inject("Configure the redis runtime session store client", SESSION, { gate: false });
    expect(repeat.context).toBe("");
    expect(telemetryTotal("repeated_context_turns")).toBe(1);
    await mutateFactMeaning(db, { factId: id, newText: "The runtime session store is Redis Cluster", chronicle: { actor: "user" } });
    db.prepare("UPDATE session_memory_state SET memory_revision_seen = (SELECT memory_revision FROM projects LIMIT 1) WHERE session_id = ?").run(SESSION);
    const corrected = await inject("Configure the redis runtime session store client", SESSION, { gate: false });
    expect(corrected.context).toContain("[MEMEX CORRECTION]");
    expect(corrected.context).toContain("Updated (supersedes earlier context)");
    expect(corrected.context).toContain("Redis Cluster");
    expect(gateState().resident).toContain(`["${id}",2,1]`);
    deactivateFactTransactional(db, id);
    db.prepare("UPDATE session_memory_state SET memory_revision_seen = (SELECT memory_revision FROM projects LIMIT 1) WHERE session_id = ?").run(SESSION);
    const retracted = await inject("Configure the redis runtime session store client", SESSION, { gate: false });
    expect(retracted.context).toContain("No longer active: The runtime session store is Redis Cluster");
    expect(retracted.context).not.toContain("[CURRENT TRUTH]");
  });

  it("m. facts from another workstream or workspace are never injected", async () => {
    const scope = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    const otherWorkstream = createWorkstream(db, { projectId: scope.projectId, workspaceId: scope.workspaceId, projectPath: cwd, ownerSessionId: "other-session", branch: "feature/x" });
    bindSessionWorkstream(db, { sessionId: "other-session", projectId: scope.projectId, workspaceId: scope.workspaceId, projectPath: cwd, explicitWorkstreamId: otherWorkstream });
    insertFact(db, {
      fact: "Experimental redis session store uses a sharded cluster", category: "knowledge", scope_type: "project", scope_project: cwd,
      source_exchange_ids: [], embedding: hashedEmbedding("Experimental redis session store uses a sharded cluster"),
      project_id: scope.projectId, workspace_id: scope.workspaceId, workstream_id: otherWorkstream, promotion_state: "workstream", promotion_evidence: "experimental",
    });
    fact("The runtime session store is Redis");
    settleRevision();
    const result = await inject("Configure the redis session store cluster client");
    expect(result.context).toContain("The runtime session store is Redis");
    expect(result.context).not.toContain("sharded cluster");
  });

  it("n/o. bundles are deterministic and never exceed the normal (1000) or rehydration (2000) hard cap", async () => {
    for (let i = 0; i < 12; i++) {
      fact(`Redis session store rule ${i}: ${"detail ".repeat(30)} number ${i}`);
    }
    const result = await inject("Explain the redis session store rules and detail numbers");
    expect(result.context.length).toBeLessThanOrEqual(NORMAL_BUNDLE_BUDGET.hard + 1);
    const sections = [
      { kind: "RECENT EVIDENCE" as const, items: [{ text: "z evidence" }] },
      { kind: "CURRENT TRUTH" as const, items: [{ text: "b fact" }, { text: "a fact" }] },
      { kind: "WATCH" as const, items: [{ text: "w pattern" }] },
    ];
    const one = renderMemoryBundle(sections, NORMAL_BUNDLE_BUDGET);
    const two = renderMemoryBundle(sections, NORMAL_BUNDLE_BUDGET);
    expect(one.text).toBe(two.text);
    expect(one.sections.map((s) => s.kind)).toEqual(["CURRENT TRUTH", "WATCH", "RECENT EVIDENCE"]);
    const huge = renderMemoryBundle([{ kind: "CURRENT TRUTH", items: Array.from({ length: 40 }, (_, i) => ({ text: `${"x".repeat(150)} ${i}` })) }], REHYDRATION_BUNDLE_BUDGET);
    expect(huge.chars).toBeLessThanOrEqual(REHYDRATION_BUNDLE_BUDGET.hard);
    expect(huge.truncated).toBe(true);
    ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    const rehydrated = buildRehydrationContext(db, { sessionId: SESSION });
    expect(rehydrated.context.length).toBeLessThanOrEqual(2000);
  });

  it("p. graph expansion only runs on why/related/dependency intents", async () => {
    const a = fact("The runtime session store is Redis");
    const b = fact("Session TTL is thirty minutes because of the compliance review");
    createRelation(db, a, "INFLUENCES", b, "ttl depends on store");
    const routine = await inject("Configure the redis runtime session store client");
    expect(routine.context).not.toContain("[INFLUENCES]");
    const why = await inject("Why did we choose the redis runtime session store and what depends on it?");
    expect(why.context).toContain("[INFLUENCES]");
    expect(why.context).toContain("compliance review");
  });
});

describe("WATCH, TRACE and assistant lanes", () => {
  function projectId(): string {
    return ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" }).projectId;
  }

  it("q/r. WATCH appears only for verified independent incident patterns, never for assistant similarity or single episodes", async () => {
    const pid = projectId();
    insertExchange(db, exchange("ex-1", "s-a", "2026-07-02T10:00:00.000Z", "run tests", "I think redis reconnect failed with missing TTL refresh"), hashedEmbedding("redis reconnect missing TTL refresh"));
    db.prepare("INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable) VALUES ('t1','ex-1','shell','{}','FAIL redis reconnect: missing TTL refresh',1,'2026-07-02T10:00:00.000Z','test_execution',1)").run();
    insertExchange(db, exchange("ex-2", "s-b", "2026-08-14T10:00:00.000Z", "failover test"), hashedEmbedding("failover"));
    db.prepare("INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable) VALUES ('t2','ex-2','shell','{}','FAIL redis reconnect: missing TTL refresh',1,'2026-08-14T10:00:00.000Z','test_execution',1)").run();
    const single = recordIncidentOccurrence(db, { projectId: pid, sessionId: "s-a", signatureText: "FAIL redis reconnect: missing TTL refresh", sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    expect(single.patternState).toBe("candidate");
    const candidateOnly = await inject("The tests print FAIL redis reconnect: missing TTL refresh again, what now?");
    expect(candidateOnly.context).not.toContain("[WATCH");
    recordIncidentOccurrence(db, { projectId: pid, sessionId: "s-b", signatureText: "FAIL redis reconnect: missing TTL refresh", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    const watched = await inject("Running the suite gives FAIL redis reconnect: missing TTL refresh in staging");
    expect(watched.context).toContain("[WATCH — VERIFIED INCIDENT PATTERN]");
    expect(watched.context).toContain("2 verified episodes");
    expect(telemetryTotal("watch_emissions")).toBe(1);
    const ttl = await inject("Running the suite gives FAIL redis reconnect: missing TTL refresh in staging once more");
    expect(ttl.context).not.toContain("[WATCH");
    const unrelated = await inject("Why does the redis client reconnect so slowly on startup?");
    expect(unrelated.context).not.toContain("[WATCH");
  });

  it("s. a stale assistant answer never outranks current truth and is labeled context-only when it is the only hint", async () => {
    insertExchange(db, exchange("ex-old", SESSION, "2026-06-01T10:00:00.000Z", "Why did we pick the redis session store originally?", "We picked Redis because MySQL locked up under burst traffic."), hashedEmbedding("Why did we pick the redis session store originally?"));
    const noFacts = await inject("Why did we pick the redis session store originally?");
    expect(noFacts.context).toContain("[ASSISTANT CONTEXT-ONLY — NOT AUTHORITATIVE]");
    expect(noFacts.context).toContain("may be stale");
    const current = fact("The runtime session store is MySQL again after the Redis rollback", { subject_key: "state.runtime.session_store" });
    const pid = (db.prepare("SELECT project_id FROM facts WHERE id = ?").get(current) as { project_id: string }).project_id;
    recordChronicleEvent(db, { kind: "ASSERTED", projectId: pid, subjectKey: "state.runtime.session_store", factId: current, newValue: "The runtime session store is MySQL again after the Redis rollback", actor: "user", projectionApplied: true });
    settleRevision();
    const withFact = await inject("Why did we pick the redis session store originally and what is it now?", SESSION, { gate: false });
    expect(withFact.context).toContain("[CURRENT TRUTH]");
    expect(withFact.context).toContain("MySQL again");
    expect(withFact.context).not.toContain("[ASSISTANT CONTEXT-ONLY");
    expect(withFact.context).toContain("[TRACE — HISTORY AVAILABLE]");
    expect(withFact.context).toContain("trace_fact subject_key=state.runtime.session_store");
  });
});

describe("failure modes, MCP and metrics", () => {
  it("t. embeddings unavailable: skips stay free and retrieval degrades to vector-free sections without throwing", async () => {
    fact("The runtime session store is Redis");
    await inject("Configure the redis session store client");
    embeddingCalls.fail = true;
    const ack = await inject("thanks");
    expect(ack).toEqual({ context: "", embeddings: 0 });
    const scope = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    db.prepare("INSERT OR REPLACE INTO work_capsules (workstream_id, generation, objective, updated_at) VALUES (?, 2, 'Keep shipping', ?)").run(scope.workstreamId, new Date().toISOString());
    const degraded = await inject("Configure the redis session store client");
    expect(degraded.embeddings).toBe(0);
    expect(degraded.context).toContain("[WORK NOW]");
    expect(degraded.context).not.toContain("[CURRENT TRUTH]");
    expect(telemetryTotal("retrieval_execute_count")).toBe(2);
  });

  it("u. a retrieval service failure returns nothing, logs, and leaves residency untouched", async () => {
    fact("The runtime session store is Redis");
    factSearch.fail = true;
    const result = await inject("Configure the redis session store client");
    expect(result.context).toBe("");
    expect(gateState().resident).toBe("[]");
    expect(db.prepare("SELECT COUNT(*) AS n FROM recall_events").get()).toEqual({ n: 0 });
  });

  it("v. MCP source/history paths are unaffected by gate skips", async () => {
    const pid = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" }).projectId;
    const id = fact("The runtime session store is Redis", { subject_key: "state.runtime.session_store", project_id: pid });
    recordChronicleEvent(db, { kind: "ASSERTED", projectId: pid, subjectKey: "state.runtime.session_store", factId: id, newValue: "The runtime session store is Redis", actor: "user", projectionApplied: true });
    // The fact landed after the session existed; consume that revision first so the acks are pure skips.
    await inject("Configure the redis session store client");
    await inject("thanks");
    await inject("계속");
    const trace = await handleToolCall("trace_fact", { subject_key: "state.runtime.session_store", project_id: pid });
    expect(trace.content[0].text).toContain("[CHRONICLE EVENT] ASSERTED");
    const facts = await handleToolCall("search_facts", { query: "The runtime session store is Redis", project_id: pid });
    expect(facts.content[0].text).toContain("Redis");
    expect(telemetryTotal("retrieval_gate_skip_count")).toBe(2);
  });

  it("w. metrics equal the actual embedding calls, retrievals and injected bytes", async () => {
    fact("The runtime session store is Redis");
    fact("Deployments use blue green rollout");
    const prompts = ["Configure the redis session store client", "thanks", "계속해", "Now rewrite the deployment rollout pipeline with canary stages", "ok"];
    let injectedChars = 0;
    let retrievals = 0;
    for (const prompt of prompts) {
      const result = await inject(prompt);
      injectedChars += result.context.length;
      if (result.embeddings > 0) retrievals++;
    }
    expect(telemetryTotal("embedding_calls")).toBe(embeddingCalls.n);
    expect(telemetryTotal("retrieval_execute_count")).toBe(retrievals);
    expect(telemetryTotal("retrieval_gate_skip_count")).toBe(prompts.length - retrievals);
    expect(telemetryTotal("injected_chars")).toBe(injectedChars);
    const summary = summarizeTelemetry(db, {});
    expect(summary.notice).toContain("MEASURED, NOT A FACT");
    expect(summary.metrics.map((m) => m.metric)).toContain("bundle_size");
  });

  it("x. a synthetic 150-turn workload keeps acks free, respects the hard budget, and retrieves far less than every prompt", async () => {
    fact("The runtime session store is Redis");
    fact("Deployments use blue green rollout with health checks");
    fact("Session TTL is thirty minutes because of compliance");
    const topics = [
      ["Configure the redis session store client", "add the redis client retry option", "log redis client errors"],
      ["Rewrite the deployment rollout pipeline with canary stages", "add health checks to the rollout", "document the rollout"],
      ["Set the session ttl to thirty minutes in config", "why is the session ttl thirty minutes?", "keep the ttl"],
    ];
    const acks = ["thanks", "ok", "계속해", "응", "good"];
    let embeddingsUsed = 0;
    let ackEmbeddings = 0;
    let maxChars = 0;
    let turns = 0;
    for (let round = 0; round < 10; round++) {
      for (const topic of topics) {
        for (const prompt of topic) {
          const result = await inject(prompt);
          turns++;
          expect(result.embeddings).toBeLessThanOrEqual(1);
          embeddingsUsed += result.embeddings;
          maxChars = Math.max(maxChars, result.context.length);
        }
        for (const ack of acks.slice(0, 2)) {
          const result = await inject(ack);
          turns++;
          ackEmbeddings += result.embeddings;
          maxChars = Math.max(maxChars, result.context.length);
        }
      }
    }
    const retrievals = telemetryTotal("retrieval_execute_count");
    expect(turns).toBe(150);
    expect(ackEmbeddings).toBe(0);
    expect(maxChars).toBeLessThanOrEqual(NORMAL_BUNDLE_BUDGET.hard + 1);
    expect(retrievals).toBeLessThan(turns * 0.4);
    expect(retrievals).toBeGreaterThan(0);
    expect(embeddingsUsed).toBeLessThanOrEqual(90);
    expect(telemetryTotal("embedding_calls")).toBe(embeddingsUsed + ackEmbeddings);
    expect(retrievals + telemetryTotal("retrieval_gate_skip_count")).toBe(turns);
  });

  it("session start compact rehydration still respects its hard cap and epochs", () => {
    const scope = ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
    for (let i = 0; i < 6; i++) fact(`Long rule ${i} ${"words ".repeat(60)}`);
    db.prepare("UPDATE session_memory_state SET carry_fact_revisions_json = ? WHERE session_id = ?")
      .run(JSON.stringify(getActiveFacts(db).map((f) => [f.id, 1, 1])), SESSION);
    const rehydrated = buildRehydrationContext(db, { sessionId: SESSION });
    expect(rehydrated.context.length).toBeLessThanOrEqual(2000);
    expect(scope.contextEpoch).toBe(0);
    expect(tokenizePrompt("The Redis session store!").sort()).toEqual(["redis", "session", "store"]);
    void handleContinuityHook;
  });
});
