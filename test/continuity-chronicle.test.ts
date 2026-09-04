import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  EMBEDDING_VERSION: 2,
  initEmbeddings: async () => {},
  generateEmbedding: async (text: string) => {
    const vector = new Array(384).fill(0.01);
    for (let i = 0; i < text.length && i < 384; i++) vector[i] += (text.charCodeAt(i) % 13) / 100;
    return vector;
  },
}));
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase, insertExchange } from "../src/db.js";
import { getActiveFacts, insertFact, getRevisions } from "../src/fact-db.js";
import {
  applyFactMeaningMutation,
  deactivateFactTransactional,
  editFact,
  factHistory,
  mutateFactMeaning,
  restoreFact,
  StaleFactMutationError,
} from "../src/fact-management.js";
import { applyConsolidationResult } from "../src/consolidator.js";
import {
  saveExtractedFactsDetailed,
  validateExtractedObservationCandidate,
  validateExtractedFactCandidate,
} from "../src/fact-extractor.js";
import {
  ChronicleGroundingError,
  currentFactRevision,
  judgeCompetingEvidence,
  listIncidentOccurrences,
  matchIncidentPatterns,
  normalizeIncidentSignature,
  normalizeSubjectKey,
  readChronicleTimeline,
  recordChronicleEvent,
  recordIncidentOccurrence,
  recordIncidentRemediation,
  recordTelemetrySample,
  summarizeTelemetry,
  verifyGroundedField,
  formatChronicleEvent,
} from "../src/chronicle.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";
import { handleToolCall } from "../src/mcp-server.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { createCheckpointWithJob } from "../src/continuity-store.js";
import type { ConversationExchange, ExtractedFact } from "../src/types.js";

let root: string;
let db: Database.Database;
const cwd = "/project/chronicle";
const emb = new Array(384).fill(0.1);

function exchange(
  id: string,
  sessionId: string,
  timestamp: string,
  userMessage: string,
  overrides: Partial<ConversationExchange> = {},
): ConversationExchange {
  return {
    id, project: cwd, cwd, timestamp, userMessage,
    assistantMessage: "assistant context only",
    archivePath: path.join(root, `${sessionId}.jsonl`),
    lineStart: 1, lineEnd: 2, sessionId, closureState: "closed", parserVersion: 2,
    ...overrides,
  };
}

function human(id: string, sessionId: string, timestamp: string, text: string): void {
  insertExchange(db, exchange(id, sessionId, timestamp, text), emb);
}

function assistantOnly(id: string, sessionId: string, timestamp: string, text: string): void {
  insertExchange(db, exchange(id, sessionId, timestamp, text, { provenance: ["assistant_generated"] }), emb);
}

function toolCall(
  exchangeId: string,
  id: string,
  result: string,
  options: { sourceType?: string; isError?: boolean; learnable?: boolean } = {},
): void {
  db.prepare(`
    INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable)
    VALUES (?, ?, 'shell', '{"command":"npm test"}', ?, ?, ?, ?, ?)
  `).run(
    id, exchangeId, result, options.isError ? 1 : 0,
    (db.prepare("SELECT timestamp FROM exchanges WHERE id = ?").get(exchangeId) as { timestamp: string }).timestamp,
    options.sourceType ?? "test_execution", options.learnable === false ? 0 : 1,
  );
}

function candidate(
  text: string,
  subject: string,
  exchangeIds: string[],
  spans: string[],
  extra: Partial<ExtractedFact> = {},
): ExtractedFact {
  return {
    fact: text,
    category: "knowledge",
    scope_type: "project",
    confidence: 0.95,
    grounding_type: "explicit",
    durable: true,
    evidence: exchangeIds.map((_, index) => ({
      exchange_index: index + 1, source: "human", kind: "assertion", supporting_span: spans[index],
    })),
    source_exchange_ids: exchangeIds,
    subject_key: subject,
    ...extra,
  };
}

async function save(facts: ExtractedFact[], extras: Parameters<typeof saveExtractedFactsDetailed>[6] = {}) {
  return saveExtractedFactsDetailed(db, facts, cwd, [], undefined, undefined, extras);
}

function timeline(subject: string) {
  const projectId = (db.prepare("SELECT project_id FROM facts WHERE subject_key = ? LIMIT 1").get(subject) as { project_id: string } | undefined)?.project_id
    ?? (db.prepare("SELECT project_id FROM projects LIMIT 1").get() as { project_id: string }).project_id;
  return readChronicleTimeline(db, { projectId, subjectKey: subject, order: "asc", limit: 100 }).events;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-chronicle-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Chronicle projection and events", () => {
  it("a. ASSERTED writes the current fact and its event in one commit with source-effective time", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    const outcome = await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    expect(outcome.asserted).toBe(1);
    const [fact] = getActiveFacts(db);
    expect(fact.subject_key).toBe("state.runtime.session_store");
    const events = timeline("state.runtime.session_store");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_kind: "ASSERTED", fact_id: fact.id, new_value: "Runtime session store is MySQL",
      effective_at: "2026-08-01T10:00:00.000Z", effective_at_source: "source", projection_applied: true,
      actor: "extractor", evidence_authority: "human", grounded_cause: null,
    });
    expect(events[0].recorded_at > events[0].effective_at).toBe(true);
    expect(currentFactRevision(db, fact.id)).toMatchObject({ semanticGeneration: 1, latestEventId: events[0].id });
  });

  it("b/j. MySQL→Redis CHANGED keeps identity, records grounded cause only from the source, and null cause otherwise", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s1", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis because session write P95 exceeded the limit under burst traffic row lock contention.");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    const before = getActiveFacts(db)[0];
    const outcome = await save([candidate("Runtime session store is Redis", "state.runtime.session_store", ["ex-2"], ["Switch the session store to Redis"], {
      change_context: {
        cause: { exchange_id: "ex-2", supporting_span: "session write P95 exceeded the limit", text: "session write P95 exceeded the limit" },
        problem: { exchange_id: "ex-2", supporting_span: "burst traffic row lock contention", text: "burst traffic row lock contention" },
      },
    })]);
    expect(outcome.changed).toBe(1);
    const active = getActiveFacts(db);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(before.id);
    expect(active[0].fact).toBe("Runtime session store is Redis");
    expect(active[0].semantic_generation).toBe(2);
    const events = timeline("state.runtime.session_store");
    expect(events.map((e) => e.event_kind)).toEqual(["ASSERTED", "CHANGED"]);
    expect(events[1]).toMatchObject({
      previous_value: "Runtime session store is MySQL", new_value: "Runtime session store is Redis",
      from_semantic_generation: 1, to_semantic_generation: 2,
      grounded_cause: "session write P95 exceeded the limit", problem: "burst traffic row lock contention",
      effective_at: "2026-08-14T10:20:00.000Z", projection_applied: true,
    });
    expect(events[0].grounded_cause).toBeNull();
  });

  it("c. Redis→MySQL rollback links reverts_event_id and deletes no history", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s1", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis.");
    human("ex-3", "s1", "2026-08-20T09:00:00.000Z", "Roll the session store back to MySQL, the failover test failed.");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    await save([candidate("Runtime session store is Redis", "state.runtime.session_store", ["ex-2"], ["Switch the session store to Redis"])]);
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-3"], ["Roll the session store back to MySQL"])]);
    const events = timeline("state.runtime.session_store");
    expect(events.map((e) => e.event_kind)).toEqual(["ASSERTED", "CHANGED", "CHANGED"]);
    expect(events[2].reverts_event_id).toBe(events[1].id);
    expect(events[2].previous_value).toBe("Runtime session store is Redis");
    expect(getActiveFacts(db)[0].fact).toBe("Runtime session store is MySQL");
    expect(db.prepare("SELECT COUNT(*) AS n FROM fact_revisions").get()).toEqual({ n: 3 });
  });

  it("d. RETIRED and RESTORED are lifecycle events; RESTORED reverts RETIRED", async () => {
    const id = insertFact(db, { fact: "Retire me later", category: "decision", scope_type: "project", scope_project: cwd, source_exchange_ids: [], embedding: emb, subject_key: "decision.test.retire" });
    const retired = deactivateFactTransactional(db, id, { chronicle: { actor: "user", userStatedRationale: "obsolete" } });
    expect(retired.eventId).toBeTruthy();
    const restored = await restoreFact(db, id);
    const events = factHistory(db, id);
    expect(events.map((e) => e.event_kind)).toEqual(["RETIRED", "RESTORED"]);
    expect(events[0]).toMatchObject({ rationale: "obsolete", lifecycle_generation: 2, actor: "user", projection_applied: true });
    expect(events[1].reverts_event_id).toBe(retired.eventId);
    expect(restored.eventId).toBe(events[1].id);
    expect(currentFactRevision(db, id)).toMatchObject({ lifecycleGeneration: 3, isActive: true });
  });

  it("e. VALIDATED/INCIDENT are event-only and cannot claim a projection change", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    toolCall("ex-1", "tool-ok", "PASS 12 tests\nload_test passed");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    const fact = getActiveFacts(db)[0];
    const { event } = recordChronicleEvent(db, {
      kind: "VALIDATED", projectId: fact.project_id, subjectKey: fact.subject_key, newValue: "load test passed",
      sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["tool-ok"], actor: "extractor", evidenceAuthority: "trusted-tool", projectionApplied: false,
    });
    expect(event.projection_applied).toBe(false);
    expect(getActiveFacts(db)[0].semantic_generation).toBe(1);
    expect(() => recordChronicleEvent(db, {
      kind: "VALIDATED", projectId: fact.project_id, factId: fact.id, newValue: "x", sourceExchangeIds: ["ex-1"],
      actor: "extractor", projectionApplied: true,
    })).toThrow(/event-only/);
    expect(() => recordChronicleEvent(db, {
      kind: "INCIDENT", projectId: fact.project_id, newValue: "no evidence", actor: "extractor", projectionApplied: false,
    })).toThrow(ChronicleGroundingError);
  });

  it("f. competing evidence with the same effective time or lower authority becomes a CONTRADICTED candidate, not a forced overwrite", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "Decision: the session store target is Redis.");
    human("ex-2", "s2", "2026-08-01T10:00:00.000Z", "I think the session store is MySQL.");
    human("ex-3", "s2", "2026-08-05T10:00:00.000Z", "Looks like the session store is MySQL after all.");
    await save([candidate("Session store target is Redis", "decision.runtime.session_store.target", ["ex-1"], ["session store target is Redis"], {
      category: "decision", evidence: [{ exchange_index: 1, source: "human", kind: "decision", supporting_span: "session store target is Redis" }],
    })]);
    const tie = await save([candidate("Session store target is MySQL", "decision.runtime.session_store.target", ["ex-2"], ["session store is MySQL"], { category: "decision" })]);
    expect(tie.contradicted).toBe(1);
    const lowerAuthority = await save([candidate("Session store target is MySQL", "decision.runtime.session_store.target", ["ex-3"], ["session store is MySQL after all"], { category: "decision" })]);
    expect(lowerAuthority.contradicted).toBe(1);
    expect(getActiveFacts(db)).toHaveLength(1);
    expect(getActiveFacts(db)[0].fact).toBe("Session store target is Redis");
    const events = timeline("decision.runtime.session_store.target");
    expect(events.filter((e) => e.event_kind === "CONTRADICTED")).toHaveLength(2);
    expect(events.filter((e) => e.event_kind === "CONTRADICTED").every((e) => !e.projection_applied && e.outcome?.resolution === "unresolved")).toBe(true);
    expect(judgeCompetingEvidence({ existingEffectiveAt: "2026-01-01T00:00:00Z", existingAuthority: "human-decision", incomingEffectiveAt: "2026-02-01T00:00:00Z", incomingAuthority: "trusted-tool" }).verdict).toBe("contradicted");
  });

  it("g. duplicate event delivery is idempotent: same content, one row", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    toolCall("ex-1", "tool-1", "FAIL redis reconnect: missing TTL refresh");
    const input = {
      kind: "INCIDENT" as const, projectId: "proj-dup-00000001", newValue: "failover failed",
      sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["tool-1"], actor: "extractor" as const, projectionApplied: false,
    };
    const first = recordChronicleEvent(db, input);
    const second = recordChronicleEvent(db, input);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM fact_revisions").get()).toEqual({ n: 1 });
  });

  it("h. a stale worker cannot overwrite the projection or append its event", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    const fact = getActiveFacts(db)[0];
    await mutateFactMeaning(db, { factId: fact.id, newText: "Runtime session store is Redis", chronicle: { actor: "user", userStatedRationale: "migrated" } });
    expect(() => applyFactMeaningMutation(db, {
      factId: fact.id, newText: "Runtime session store is Postgres", expectedSemanticGeneration: 1,
      chronicle: { actor: "consolidator" },
    }, emb)).toThrow(StaleFactMutationError);
    expect(getActiveFacts(db)[0].fact).toBe("Runtime session store is Redis");
    expect(factHistory(db, fact.id).map((e) => e.event_kind)).toEqual(["ASSERTED", "CHANGED"]);
  });

  it("i. recorded order opposite to effective order: the timeline follows effective_at and older evidence never overwrites", async () => {
    human("ex-old", "s1", "2026-07-01T10:00:00.000Z", "Back then the session store was MySQL.");
    human("ex-new", "s2", "2026-08-14T10:20:00.000Z", "Now the session store is Redis.");
    await save([candidate("Session store is Redis", "state.runtime.session_store", ["ex-new"], ["session store is Redis"])]);
    const outcome = await save([candidate("Session store is MySQL", "state.runtime.session_store", ["ex-old"], ["session store was MySQL"])]);
    expect(outcome.historical).toBe(1);
    expect(getActiveFacts(db)[0].fact).toBe("Session store is Redis");
    const events = timeline("state.runtime.session_store");
    expect(events.map((e) => [e.event_kind, e.new_value, e.projection_applied])).toEqual([
      ["ASSERTED", "Session store is MySQL", false],
      ["ASSERTED", "Session store is Redis", true],
    ]);
    expect(events[0].recorded_at >= events[1].recorded_at).toBe(true);
    expect(events[0].effective_at < events[1].effective_at).toBe(true);
  });

  it("k. model-inferred reasons stay classifier notes; unproven grounded fields are rejected", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s1", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis.");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    await save([candidate("Runtime session store is Redis", "state.runtime.session_store", ["ex-2"], ["Switch the session store to Redis"], {
      classifier_notes: ["unverified cause: probably lock contention (span is not present in the source)"],
    })]);
    const changed = timeline("state.runtime.session_store")[1];
    expect(changed.grounded_cause).toBeNull();
    expect(changed.classifier_note).toContain("unverified cause");
    expect(formatChronicleEvent(db, changed)).toContain("classifier note (model inference, NOT authoritative)");
    expect(formatChronicleEvent(db, changed)).toContain("grounded cause (source-cited): null");
    expect(() => recordChronicleEvent(db, {
      kind: "CHANGED", projectId: changed.project_id, factId: changed.fact_id, previousValue: "a", newValue: "b",
      grounded: { cause: { text: "hallucinated", exchangeId: "ex-2", supportingSpan: "this text is not in the source" } },
      actor: "extractor", projectionApplied: true,
    })).toThrow(ChronicleGroundingError);
    expect(verifyGroundedField(db, { text: "x", exchangeId: "ex-2", supportingSpan: "Switch the session store" })).toBe(true);
    // Consolidator verdicts are model inference: reason lands in classifier_note.
    const a = insertFact(db, { fact: "Config version is v1", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: ["ex-1"], embedding: emb });
    const b = insertFact(db, { fact: "Config version is v2", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: ["ex-2"], embedding: emb });
    const facts = getActiveFacts(db);
    await applyConsolidationResult(db, facts.find((f) => f.id === a)!, facts.find((f) => f.id === b)!, { relation: "EVOLUTION", merged_fact: "Config version is v2", reason: "model thinks it evolved" });
    const consolidated = factHistory(db, a).find((e) => e.event_kind === "CHANGED")!;
    expect(consolidated.actor).toBe("consolidator");
    expect(consolidated.grounded_cause).toBeNull();
    expect(consolidated.classifier_note).toContain("model thinks it evolved");
  });

  it("m. subject keys separate slots by meaning and reject ambiguous proposals", async () => {
    expect(normalizeSubjectKey("state.runtime.session_store", "knowledge")).toBe("state.runtime.session_store");
    expect(normalizeSubjectKey("decision.runtime.session_store.target", "decision")).toBe("decision.runtime.session_store.target");
    expect(normalizeSubjectKey("state.runtime.session_store", "decision")).toBeNull();
    expect(normalizeSubjectKey("Session Store", "knowledge")).toBeNull();
    expect(normalizeSubjectKey("state", "knowledge")).toBeNull();
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "The main branch session store is MySQL but we decided the target is Redis.");
    await save([
      candidate("Main session store is MySQL", "state.main.runtime.session_store", ["ex-1"], ["session store is MySQL"]),
      candidate("Session store target is Redis", "decision.runtime.session_store.target", ["ex-1"], ["the target is Redis"], {
        category: "decision", evidence: [{ exchange_index: 1, source: "human", kind: "decision", supporting_span: "the target is Redis" }],
      }),
    ]);
    expect(getActiveFacts(db)).toHaveLength(2);
    const ambiguous = validateExtractedFactCandidate({
      fact: "Session store is MySQL", category: "knowledge", scope_type: "project", grounding_type: "explicit", durable: true, confidence: 0.9,
      subject_key: "Not A Key", evidence: [{ exchange_index: 1, source: "human", kind: "assertion", supporting_span: "session store is MySQL" }],
    }, [{ id: "ex-1", user_message: "The main branch session store is MySQL but we decided the target is Redis.", assistant_message: "", provenance: '["human_assertion"]' }]);
    expect(ambiguous?.subject_key).toBeUndefined();
    expect(ambiguous?.classifier_notes?.[0]).toContain("unresolved subject_key");
    // Rephrasing of the current value merges provenance without an event.
    const merged = await save([candidate("main session store is mysql", "state.main.runtime.session_store", ["ex-1"], ["session store is MySQL"])]);
    expect(merged.merged).toBe(1);
    expect(timeline("state.main.runtime.session_store")).toHaveLength(1);
  });
});

describe("Incident episodes and patterns", () => {
  function projectId(): string {
    return ensureSessionMemoryState(db, { sessionId: "s1", project: cwd }).projectId;
  }

  it("n/o/p. retries coalesce, independent episodes promote a pattern, and only verified remediation resolves it", () => {
    human("ex-1", "s1", "2026-07-02T10:00:00.000Z", "Integration test run.");
    toolCall("ex-1", "t1", "FAIL redis reconnect: missing TTL refresh at 0x1f3a", { isError: true });
    human("ex-2", "s1", "2026-07-02T10:10:00.000Z", "Retry the integration test.");
    toolCall("ex-2", "t2", "FAIL redis reconnect: missing TTL refresh at 0x9b21", { isError: true });
    human("ex-3", "s2", "2026-08-14T10:00:00.000Z", "Failover test run.");
    toolCall("ex-3", "t3", "FAIL redis reconnect: missing TTL refresh at 0x0001", { isError: true });
    human("ex-4", "s3", "2026-08-15T10:00:00.000Z", "Verify the fix.");
    toolCall("ex-4", "t4", "PASS redis reconnect suite 4/4");
    const pid = projectId();
    const first = recordIncidentOccurrence(db, { projectId: pid, sessionId: "s1", signatureText: "FAIL redis reconnect: missing TTL refresh at 0x1f3a", sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    const retry = recordIncidentOccurrence(db, { projectId: pid, sessionId: "s1", signatureText: "FAIL redis reconnect: missing TTL refresh at 0x9b21", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    expect(first.coalesced).toBe(false);
    expect(retry.coalesced).toBe(true);
    expect(retry.occurrenceId).toBe(first.occurrenceId);
    expect(retry.patternState).toBe("candidate");
    expect(db.prepare("SELECT COUNT(*) AS n FROM fact_revisions WHERE event_kind = 'INCIDENT'").get()).toEqual({ n: 1 });
    expect(listIncidentOccurrences(db, { projectId: pid })[0].retry_count).toBe(1);

    const second = recordIncidentOccurrence(db, { projectId: pid, sessionId: "s2", signatureText: "FAIL redis reconnect: missing TTL refresh at 0x0001", sourceExchangeIds: ["ex-3"], sourceEvidenceIds: ["t3"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    expect(second.coalesced).toBe(false);
    expect(second.episodeCount).toBe(2);
    expect(second.patternState).toBe("pattern");
    expect(second.signatureKey).toBe(first.signatureKey);

    // Absence of recurrence never resolves the pattern.
    expect(matchIncidentPatterns(db, { projectId: pid, text: "redis reconnect missing ttl refresh" })[0]).toMatchObject({ patternState: "pattern", episodeCount: 2 });
    expect(() => recordIncidentRemediation(db, { projectId: pid, signatureKey: first.signatureKey, summary: "fixed", sourceExchangeIds: ["ex-3"], sourceEvidenceIds: ["t3"], evidenceAuthority: "trusted-tool", actor: "extractor" }))
      .toThrow(ChronicleGroundingError);
    const remediation = recordIncidentRemediation(db, { projectId: pid, signatureKey: first.signatureKey, summary: "reset TTL in the reconnect callback", sourceExchangeIds: ["ex-4"], sourceEvidenceIds: ["t4"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    expect(remediation.remediatedOccurrences).toBe(2);
    expect(db.prepare("SELECT pattern_state, remediation_summary FROM incident_signatures").get()).toEqual({ pattern_state: "remediated", remediation_summary: "reset TTL in the reconnect callback" });
    expect(matchIncidentPatterns(db, { projectId: pid, text: "redis reconnect missing ttl refresh" })).toHaveLength(0);
    expect(matchIncidentPatterns(db, { projectId: pid, text: "redis reconnect missing ttl refresh", includeRemediated: true })[0].remediationSummary).toContain("reset TTL");
    expect(normalizeIncidentSignature("FAIL redis reconnect at 0x1f3a on 2026-07-02T10:00:00Z /var/log/app.log").text).toBe("fail redis reconnect at <hex> on <time> <path>");
  });

  it("recurrence after remediation reopens the pattern", () => {
    human("ex-1", "s1", "2026-07-02T10:00:00.000Z", "run"); toolCall("ex-1", "t1", "FAIL leak in pool", { isError: true });
    human("ex-2", "s2", "2026-07-03T10:00:00.000Z", "run"); toolCall("ex-2", "t2", "FAIL leak in pool", { isError: true });
    human("ex-3", "s3", "2026-07-04T10:00:00.000Z", "run"); toolCall("ex-3", "t3", "PASS pool suite");
    human("ex-4", "s4", "2026-07-09T10:00:00.000Z", "run"); toolCall("ex-4", "t4", "FAIL leak in pool", { isError: true });
    const pid = projectId();
    const base = { projectId: pid, signatureText: "FAIL leak in pool", evidenceAuthority: "trusted-tool" as const, actor: "extractor" as const };
    const a = recordIncidentOccurrence(db, { ...base, sessionId: "s1", sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"] });
    recordIncidentOccurrence(db, { ...base, sessionId: "s2", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"] });
    recordIncidentRemediation(db, { projectId: pid, signatureKey: a.signatureKey, summary: "fixed", sourceExchangeIds: ["ex-3"], sourceEvidenceIds: ["t3"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    const again = recordIncidentOccurrence(db, { ...base, sessionId: "s4", sourceExchangeIds: ["ex-4"], sourceEvidenceIds: ["t4"] });
    expect(again.patternState).toBe("pattern");
    expect(again.episodeCount).toBe(3);
  });

  it("v. assistant text, Capsule summaries and untrusted tools never ground an incident, validation, or cause", () => {
    assistantOnly("ex-a", "s1", "2026-08-01T10:00:00.000Z", "I believe the tests failed with a TTL error.");
    toolCall("ex-a", "t-ext", "FAIL something", { sourceType: "external_unverified", learnable: false });
    human("ex-h", "s1", "2026-08-01T10:05:00.000Z", "Fine.");
    toolCall("ex-h", "t-recall", "FAIL recalled", { sourceType: "memex_recall", learnable: false });
    const pid = projectId();
    expect(() => recordIncidentOccurrence(db, { projectId: pid, sessionId: "s1", signatureText: "TTL error", sourceExchangeIds: ["ex-a"], evidenceAuthority: "human", actor: "extractor" })).toThrow(ChronicleGroundingError);
    expect(() => recordIncidentOccurrence(db, { projectId: pid, sessionId: "s1", signatureText: "FAIL something", sourceExchangeIds: ["ex-a"], sourceEvidenceIds: ["t-ext"], evidenceAuthority: "trusted-tool", actor: "extractor" })).toThrow(ChronicleGroundingError);
    expect(() => recordIncidentOccurrence(db, { projectId: pid, sessionId: "s1", signatureText: "FAIL recalled", sourceExchangeIds: ["ex-h"], sourceEvidenceIds: ["t-recall"], evidenceAuthority: "trusted-tool", actor: "extractor" })).toThrow(ChronicleGroundingError);
    expect(verifyGroundedField(db, { text: "x", exchangeId: "ex-a", supportingSpan: "tests failed" })).toBe(false);
    expect(() => recordChronicleEvent(db, { kind: "CHANGED", factId: null, newValue: "x", userStatedRationale: "assistant said so", actor: "consolidator", projectionApplied: false })).toThrow(ChronicleGroundingError);
    const exchanges = [
      { id: "ex-a", user_message: "", assistant_message: "I believe the tests failed", provenance: '["assistant_generated"]', assistant_learnable: 0,
        tool_evidence: [{ id: "t-ext", tool_name: "shell", tool_result: "FAIL something", source_type: "external_unverified", learnable: 0, is_error: 1 }] },
    ];
    expect(validateExtractedObservationCandidate({ observation: "incident", summary: "tests failed", confidence: 0.9,
      evidence: [{ exchange_index: 1, source: "assistant", kind: "assertion", supporting_span: "tests failed" }] }, exchanges)).toBeNull();
    expect(validateExtractedObservationCandidate({ observation: "incident", summary: "tests failed", confidence: 0.9,
      evidence: [{ exchange_index: 1, source: "tool", kind: "test_execution", source_type: "test_execution", tool_call_id: "t-ext", tool_name: "shell", supporting_span: "FAIL something" }] }, exchanges)).toBeNull();
  });

  it("observation candidates with trusted test evidence become incident occurrences in the extraction commit", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "Run the tests.");
    toolCall("ex-1", "t1", "FAIL auth middleware: token expiry off by one", { isError: true });
    const exchanges = [{ id: "ex-1", user_message: "Run the tests.", assistant_message: "", provenance: '["human_assertion"]',
      tool_evidence: [{ id: "t1", tool_name: "shell", tool_result: "FAIL auth middleware: token expiry off by one", source_type: "test_execution", learnable: 1, is_error: 1 }] }];
    const observation = validateExtractedObservationCandidate({
      observation: "incident", summary: "auth middleware token expiry test fails", signature_text: "FAIL auth middleware: token expiry off by one", confidence: 0.9,
      evidence: [{ exchange_index: 1, source: "tool", kind: "test_execution", source_type: "test_execution", tool_call_id: "t1", tool_name: "shell", supporting_span: "token expiry off by one" }],
    }, exchanges);
    expect(observation).toMatchObject({ observation: "incident", source_exchange_ids: ["ex-1"], source_evidence_ids: ["t1"] });
    const outcome = await save([], { observations: [observation!], sessionId: "s1" });
    expect(outcome.incidents).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM incident_occurrences").get()).toEqual({ n: 1 });
    expect(getActiveFacts(db)).toHaveLength(0);
  });
});

describe("MCP deep exploration", () => {
  async function seedSubject(): Promise<{ projectId: string; factId: string }> {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s2", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis because session write P95 exceeded the limit.");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    await save([candidate("Runtime session store is Redis", "state.runtime.session_store", ["ex-2"], ["Switch the session store to Redis"], {
      change_context: { cause: { exchange_id: "ex-2", supporting_span: "session write P95 exceeded the limit", text: "session write P95 exceeded the limit" } },
    })]);
    const fact = getActiveFacts(db)[0];
    return { projectId: fact.project_id as string, factId: fact.id };
  }

  it("q. trace_fact walks current fact → Chronicle timeline → source evidence with labeled lanes", async () => {
    const { projectId, factId } = await seedSubject();
    const result = await handleToolCall("trace_fact", { fact_id: factId, project_id: projectId, scope: "project" });
    const text = result.content[0].text as string;
    expect(result.isError).toBeFalsy();
    expect(text).toContain("[CURRENT FACT] Runtime session store is Redis");
    expect(text).toContain("[CHRONICLE EVENT] ASSERTED");
    expect(text).toContain("[CHRONICLE EVENT] CHANGED");
    expect(text).toContain('value: "Runtime session store is MySQL" → "Runtime session store is Redis"');
    expect(text).toContain("grounded cause (source-cited): session write P95 exceeded the limit");
    expect(text).toContain("[RAW EVIDENCE] ex-2");
    expect(text).toContain("session s2");
    const bySubject = await handleToolCall("trace_fact", { subject_key: "state.runtime.session_store", project_id: projectId });
    expect(bySubject.content[0].text).toContain("Chronicle Timeline (subject");
    const missing = await handleToolCall("trace_fact", { project_id: projectId });
    expect(missing.isError).toBe(true);
  });

  it("r. large history is bounded and cursor-paginated without gaps or duplicates", async () => {
    const { projectId, factId } = await seedSubject();
    for (let i = 0; i < 40; i++) {
      await mutateFactMeaning(db, { factId, newText: `Runtime session store revision ${i}`, chronicle: { actor: "user", effectiveAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}.000Z` } });
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = readChronicleTimeline(db, { projectId, subjectKey: "state.runtime.session_store", limit: 7, order: "asc", cursor });
      expect(page.events.length).toBeLessThanOrEqual(7);
      for (const event of page.events) {
        expect(seen.has(event.id)).toBe(false);
        seen.add(event.id);
      }
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(seen.size).toBe(42);
    expect(pages).toBe(6);
    expect(readChronicleTimeline(db, { projectId, limit: 1000 }).limit).toBe(100);
    const first = await handleToolCall("trace_fact", { fact_id: factId, project_id: projectId, timeline_limit: 5 });
    const firstText = first.content[0].text as string;
    expect(firstText).toContain("5 of max 5");
    const cursorMatch = /_Next timeline cursor: (\S+)_/.exec(firstText);
    expect(cursorMatch).toBeTruthy();
    const second = await handleToolCall("trace_fact", { fact_id: factId, project_id: projectId, timeline_limit: 5, timeline_cursor: cursorMatch![1] });
    expect(second.content[0].text).not.toContain(firstText.split("[CHRONICLE EVENT]")[1].split("\n")[1]);
  });

  it("s. other-session and workstream memory is reachable and filterable", async () => {
    const { projectId } = await seedSubject();
    const s1 = readChronicleTimeline(db, { projectId, subjectKey: "state.runtime.session_store", sessionId: "s1" }).events;
    const s2 = readChronicleTimeline(db, { projectId, subjectKey: "state.runtime.session_store", sessionId: "s2" }).events;
    expect(s1.map((e) => e.event_kind)).toEqual(["ASSERTED"]);
    expect(s2.map((e) => e.event_kind)).toEqual(["CHANGED"]);
    const other = await handleToolCall("trace_fact", { subject_key: "state.runtime.session_store", project_id: projectId, scope: "project" });
    expect(other.content[0].text).toContain("session s1");
    expect(other.content[0].text).toContain("session s2");
    const foreign = await handleToolCall("trace_fact", { fact_id: getActiveFacts(db)[0].id, scope: "global" });
    expect(foreign.isError).toBe(true);
  });
});

describe("Privacy purge and telemetry", () => {
  it("l/u. purging a session removes its events, occurrences and signatures, tombstones them, and pending work cannot resurrect them", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s2", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis.");
    toolCall("ex-2", "t2", "FAIL redis reconnect", { isError: true });
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    await save([candidate("Runtime session store is Redis", "state.runtime.session_store", ["ex-2"], ["Switch the session store to Redis"])]);
    const pid = getActiveFacts(db)[0].project_id as string;
    const incident = recordIncidentOccurrence(db, { projectId: pid, sessionId: "s2", signatureText: "FAIL redis reconnect", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    ensureSessionMemoryState(db, { sessionId: "s2", project: cwd });
    createCheckpointWithJob(db, {
      checkpoint: { checkpointId: "purge-cp", sessionId: "s2", ordinal: 1, kind: "stop", idempotencyKey: "purge-cp" },
      job: { kind: "capture_index", partitionKey: "session:s2", policyVersion: "continuity-capture-v1", priority: 100, idempotencyKey: "purge-cp-job" },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE state = 'pending'").get()).toEqual({ n: 1 });
    const eventsBefore = db.prepare("SELECT id FROM fact_revisions").all() as Array<{ id: string }>;
    expect(eventsBefore).toHaveLength(3);

    purgeConversationFromIndex(db, { archivePath: path.join(root, "s2.jsonl"), sessionId: "s2" });

    expect(db.prepare("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM fact_revisions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM incident_occurrences").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM incident_signatures").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chronicle_tombstones").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT 1 FROM chronicle_tombstones WHERE event_id = ?").get(incident.eventId)).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE state IN ('pending','running','retry')").get()).toEqual({ n: 0 });
    expect(() => recordIncidentOccurrence(db, { projectId: pid, sessionId: "s2", signatureText: "FAIL redis reconnect", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"], evidenceAuthority: "trusted-tool", actor: "extractor" })).toThrow(ChronicleGroundingError);
  });

  it("purged sources are reported as unavailable by the formatter instead of being exposed", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    const id = insertFact(db, { fact: "Kept fact", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: [], embedding: emb, subject_key: "state.kept" });
    const { event } = recordChronicleEvent(db, { kind: "ASSERTED", factId: id, newValue: "Kept fact", sourceExchangeIds: [], actor: "user", projectionApplied: true });
    db.prepare("UPDATE fact_revisions SET source_exchange_ids = '[\"ghost\"]' WHERE id = ?").run(event.id);
    const text = formatChronicleEvent(db, readChronicleTimeline(db, { factId: id }).events[0]);
    expect(text).toContain("ghost: source unavailable (purged or missing)");
    expect(getRevisions(db, id)).toHaveLength(1);
  });

  it("measured telemetry is summarized separately and never becomes a fact or event", () => {
    recordTelemetrySample(db, { metric: "injected_chars", value: 812, unit: "chars", sessionId: "s1" });
    recordTelemetrySample(db, { metric: "injected_chars", value: 300, unit: "chars", sessionId: "s1" });
    recordTelemetrySample(db, { metric: "semantic_retrieval_calls", value: 1, sessionId: "s1" });
    expect(() => recordTelemetrySample(db, { metric: "hours_saved" as never, value: 12 })).toThrow(/unknown telemetry metric/);
    const summary = summarizeTelemetry(db, {});
    expect(summary.notice).toContain("MEASURED, NOT A FACT");
    expect(summary.metrics.find((m) => m.metric === "injected_chars")).toMatchObject({ samples: 2, sum: 1112 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM fact_revisions").get()).toEqual({ n: 0 });
  });

  it("legacy revision rows migrate to CHANGED events whose reason is a classifier note", () => {
    const id = insertFact(db, { fact: "Legacy", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: [], embedding: emb });
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "legacy source");
    db.prepare(`INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at) VALUES ('legacy-rev', ?, 'old', 'Legacy', 'consolidator said so', 'ex-1', '2026-08-02T00:00:00.000Z')`).run(id);
    db.prepare("UPDATE fact_revisions SET recorded_at = '' WHERE id = 'legacy-rev'").run();
    db.close();
    db = initDatabase();
    const [event] = factHistory(db, id);
    expect(event).toMatchObject({
      event_kind: "CHANGED", actor: "legacy", classifier_note: "consolidator said so", grounded_cause: null,
      effective_at: "2026-08-01T10:00:00.000Z", effective_at_source: "source", recorded_at: "2026-08-02T00:00:00.000Z",
      source_exchange_ids: ["ex-1"],
    });
    expect(db.pragma("user_version", { simple: true })).toBe(5);
  });
});
