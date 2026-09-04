import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Phase 4B independent gate: adversarial coverage that the 4A suite did not
 * prove directly — projection/event atomicity under injected failure,
 * incident duplicate delivery and out-of-order remediation, sibling
 * workstream isolation of the timeline, and an end-to-end two-database sync
 * matrix (duplicate replay, out-of-order generations, same-id conflict,
 * event tombstones, legacy peer rows, ungrounded peer rows, replay after purge).
 */

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
import { getActiveFacts, insertFact } from "../src/fact-db.js";
import {
  applyFactMeaningMutation,
  factHistory,
  mutateFactMeaning,
  StaleFactMutationError,
} from "../src/fact-management.js";
import { ClaimLostError, saveExtractedFactsDetailed } from "../src/fact-extractor.js";
import {
  ChronicleGroundingError,
  formatChronicleEvent,
  listIncidentOccurrences,
  matchIncidentPatterns,
  readChronicleTimeline,
  recordChronicleEvent,
  recordIncidentOccurrence,
  recordIncidentRemediation,
} from "../src/chronicle.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";
import { handleToolCall } from "../src/mcp-server.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { exportForSync, getSyncDir } from "../src/sync-export.js";
import { importFromSync } from "../src/sync-import.js";
import { craftCommittedGeneration } from "./sync-fixture.js";
import type { ConversationExchange, ExtractedFact } from "../src/types.js";

let root: string;
let db: Database.Database;
const cwd = "/project/chronicle-gate";
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

function human(id: string, sessionId: string, timestamp: string, text: string, overrides: Partial<ConversationExchange> = {}): void {
  insertExchange(db, exchange(id, sessionId, timestamp, text, overrides), emb);
}

function toolCall(exchangeId: string, id: string, result: string, options: { isError?: boolean } = {}): void {
  db.prepare(`
    INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable)
    VALUES (?, ?, 'shell', '{"command":"npm test"}', ?, ?, ?, 'test_execution', 1)
  `).run(id, exchangeId, result, options.isError ? 1 : 0,
    (db.prepare("SELECT timestamp FROM exchanges WHERE id = ?").get(exchangeId) as { timestamp: string }).timestamp);
}

function candidate(text: string, subject: string, exchangeIds: string[], spans: string[], extra: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    fact: text, category: "knowledge", scope_type: "project", confidence: 0.95, grounding_type: "explicit", durable: true,
    evidence: exchangeIds.map((_, index) => ({ exchange_index: index + 1, source: "human", kind: "assertion", supporting_span: spans[index] })),
    source_exchange_ids: exchangeIds, subject_key: subject, ...extra,
  };
}

async function save(facts: ExtractedFact[], extras: Parameters<typeof saveExtractedFactsDetailed>[6] = {}, commitMarker?: (extracted: number, saved: number) => number) {
  return saveExtractedFactsDetailed(db, facts, cwd, [], undefined, commitMarker, extras);
}

function count(sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-chronicle-gate-"));
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

describe("projection/event atomicity under injected failure", () => {
  it("projection UPDATE succeeds but the CHANGED event is rejected: the projection rolls back with it", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s1", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis.");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    const fact = getActiveFacts(db)[0];
    expect(() => applyFactMeaningMutation(db, {
      factId: fact.id, newText: "Runtime session store is Redis", source: { exchangeIds: ["ex-2"] },
      chronicle: { actor: "extractor", grounded: { cause: { text: "made up", exchangeId: "ex-2", supportingSpan: "not in the source at all" } } },
    }, emb)).toThrow(ChronicleGroundingError);
    const after = getActiveFacts(db)[0];
    expect(after.fact).toBe("Runtime session store is MySQL");
    expect(after.semantic_generation).toBe(1);
    expect(factHistory(db, fact.id).map((e) => e.event_kind)).toEqual(["ASSERTED"]);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(1);
  });

  it("CHANGED event is appended but a later step of the same transaction fails: no event survives", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    const fact = getActiveFacts(db)[0];
    const other = insertFact(db, { fact: "Some other fact", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: [], embedding: emb });
    await expect(mutateFactMeaning(db, {
      factId: fact.id, newText: "Runtime session store is Redis", chronicle: { actor: "user", userStatedRationale: "migrated" },
      deactivateFacts: [{ id: other, expectedSemanticGeneration: 999 }],
    })).rejects.toThrow(StaleFactMutationError);
    expect(getActiveFacts(db).find((f) => f.id === fact.id)?.fact).toBe("Runtime session store is MySQL");
    expect(factHistory(db, fact.id).map((e) => e.event_kind)).toEqual(["ASSERTED"]);
    expect(getActiveFacts(db).some((f) => f.id === other)).toBe(true);
  });

  it("ASSERTED fact insert is rolled back when its event cannot be grounded", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    await expect(save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"], {
      change_context: { cause: { exchange_id: "ex-1", supporting_span: "text that is not in ex-1", text: "hallucinated" } },
    })])).rejects.toThrow(ChronicleGroundingError);
    expect(count("SELECT COUNT(*) AS n FROM facts")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(0);
  });

  it("a lost claim after facts, events and incidents were written rolls back every row", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    toolCall("ex-1", "t1", "FAIL redis reconnect: missing TTL refresh", { isError: true });
    await expect(save(
      [candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])],
      { sessionId: "s1", observations: [{
        observation: "incident", summary: "redis reconnect fails", signature_text: "FAIL redis reconnect: missing TTL refresh", confidence: 0.9,
        evidence: [{ exchange_index: 1, source: "tool", kind: "test_execution", source_type: "test_execution", tool_call_id: "t1", tool_name: "shell", supporting_span: "missing TTL refresh" }],
        source_exchange_ids: ["ex-1"], source_evidence_ids: ["t1"],
      }] },
      () => 0,
    )).rejects.toThrow(ClaimLostError);
    for (const table of ["facts", "fact_revisions", "incident_occurrences", "incident_signatures"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table}`)).toBe(0);
    }
  });

  it("a grounded field always cites its exchange in the event sources", async () => {
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s1", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis because the TTL cleanup job is too expensive.");
    const id = insertFact(db, { fact: "Session store is MySQL", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: ["ex-1"], embedding: emb, subject_key: "state.runtime.session_store" });
    const { event } = recordChronicleEvent(db, {
      kind: "CHANGED", factId: id, previousValue: "Session store is MySQL", newValue: "Session store is Redis", actor: "extractor", projectionApplied: true,
      sourceExchangeIds: [],
      grounded: { cause: { text: "TTL cleanup job is too expensive", exchangeId: "ex-2", supportingSpan: "TTL cleanup job is too expensive" } },
    });
    expect(event.source_exchange_ids).toEqual(["ex-2"]);
    expect(event.effective_at).toBe("2026-08-14T10:20:00.000Z");
    expect(event.effective_at_source).toBe("source");
  });
});

describe("incident duplicate delivery, coalescing and out-of-order remediation", () => {
  function projectId(): string {
    return ensureSessionMemoryState(db, { sessionId: "s1", project: cwd }).projectId;
  }
  const base = { signatureText: "FAIL redis reconnect: missing TTL refresh", evidenceAuthority: "trusted-tool" as const, actor: "extractor" as const };

  it("duplicate delivery with a null session is a no-op: one occurrence, one event, one episode", () => {
    human("ex-1", "s1", "2026-07-02T10:00:00.000Z", "run"); toolCall("ex-1", "t1", base.signatureText, { isError: true });
    human("ex-2", "s9", "2026-07-20T10:00:00.000Z", "run"); toolCall("ex-2", "t2", base.signatureText, { isError: true });
    const pid = projectId();
    const first = recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: null, sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"] });
    const replay = recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: null, sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"] });
    expect(replay).toMatchObject({ coalesced: true, occurrenceId: first.occurrenceId, eventId: first.eventId, episodeCount: 1, patternState: "candidate" });
    expect(count("SELECT COUNT(*) AS n FROM incident_occurrences")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions WHERE event_kind = 'INCIDENT'")).toBe(1);
    expect(listIncidentOccurrences(db, { projectId: pid })[0].retry_count).toBe(0);
    // A genuinely independent episode (different evidence, weeks later) still counts.
    const second = recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: null, sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"] });
    expect(second).toMatchObject({ coalesced: false, episodeCount: 2, patternState: "pattern" });
  });

  it("duplicate delivery of a session retry does not inflate retry_count; a new retry does", () => {
    human("ex-1", "s1", "2026-07-02T10:00:00.000Z", "run"); toolCall("ex-1", "t1", base.signatureText, { isError: true });
    human("ex-2", "s1", "2026-07-02T10:10:00.000Z", "run again"); toolCall("ex-2", "t2", base.signatureText, { isError: true });
    const pid = projectId();
    recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s1", sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"] });
    recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s1", sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"] });
    expect(listIncidentOccurrences(db, { projectId: pid })[0].retry_count).toBe(0);
    recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s1", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"] });
    recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s1", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"] });
    const [occurrence] = listIncidentOccurrences(db, { projectId: pid });
    expect(occurrence.retry_count).toBe(1);
    expect(occurrence.source_exchange_ids).toEqual(["ex-1", "ex-2"]);
    expect(count("SELECT COUNT(*) AS n FROM incident_occurrences")).toBe(1);
  });

  it("an older episode recorded after the remediation stays remediated; a later one reopens the pattern", () => {
    human("ex-1", "s1", "2026-07-02T10:00:00.000Z", "run"); toolCall("ex-1", "t1", base.signatureText, { isError: true });
    human("ex-2", "s2", "2026-07-03T10:00:00.000Z", "run"); toolCall("ex-2", "t2", base.signatureText, { isError: true });
    human("ex-fix", "s3", "2026-07-05T10:00:00.000Z", "verify"); toolCall("ex-fix", "t-fix", "PASS reconnect suite");
    human("ex-late", "s4", "2026-07-04T10:00:00.000Z", "run"); toolCall("ex-late", "t-late", base.signatureText, { isError: true });
    human("ex-again", "s5", "2026-07-09T10:00:00.000Z", "run"); toolCall("ex-again", "t-again", base.signatureText, { isError: true });
    const pid = projectId();
    const a = recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s1", sourceExchangeIds: ["ex-1"], sourceEvidenceIds: ["t1"] });
    recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s2", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"] });
    recordIncidentRemediation(db, { projectId: pid, signatureKey: a.signatureKey, summary: "TTL reset on reconnect", sourceExchangeIds: ["ex-fix"], sourceEvidenceIds: ["t-fix"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    // Worker order: the s4 failure (effective 07-04, before the 07-05 fix) is processed after the remediation.
    const late = recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s4", sourceExchangeIds: ["ex-late"], sourceEvidenceIds: ["t-late"] });
    expect(late).toMatchObject({ coalesced: false, episodeCount: 3, patternState: "remediated" });
    expect(listIncidentOccurrences(db, { projectId: pid, sessionId: "s4" })[0].state).toBe("remediated");
    expect(db.prepare("SELECT pattern_state, remediation_summary FROM incident_signatures").get()).toEqual({ pattern_state: "remediated", remediation_summary: "TTL reset on reconnect" });
    expect(matchIncidentPatterns(db, { projectId: pid, text: base.signatureText })).toHaveLength(0);
    const again = recordIncidentOccurrence(db, { ...base, projectId: pid, sessionId: "s5", sourceExchangeIds: ["ex-again"], sourceEvidenceIds: ["t-again"] });
    expect(again).toMatchObject({ coalesced: false, episodeCount: 4, patternState: "pattern" });
    expect(db.prepare("SELECT remediation_event_id FROM incident_signatures").get()).toEqual({ remediation_event_id: null });
    expect(matchIncidentPatterns(db, { projectId: pid, text: base.signatureText })[0].episodeCount).toBe(4);
    // A retry of the reopened episode in the same session never coalesces into a remediated occurrence.
    expect(count("SELECT COUNT(*) AS n FROM incident_occurrences WHERE state = 'open'")).toBe(1);
  });

  it("the same signature in two workstreams is one project pattern with two source-linked episodes", () => {
    const a = ensureSessionMemoryState(db, { sessionId: "ws-a", project: cwd });
    const b = ensureSessionMemoryState(db, { sessionId: "ws-b", project: cwd });
    expect(a.workstreamId).not.toBe(b.workstreamId);
    human("ex-a", "ws-a", "2026-07-02T10:00:00.000Z", "run", { workstreamId: a.workstreamId }); toolCall("ex-a", "ta", base.signatureText, { isError: true });
    human("ex-b", "ws-b", "2026-07-03T10:00:00.000Z", "run", { workstreamId: b.workstreamId }); toolCall("ex-b", "tb", base.signatureText, { isError: true });
    recordIncidentOccurrence(db, { ...base, projectId: a.projectId, workstreamId: a.workstreamId, sessionId: "ws-a", sourceExchangeIds: ["ex-a"], sourceEvidenceIds: ["ta"] });
    const second = recordIncidentOccurrence(db, { ...base, projectId: a.projectId, workstreamId: b.workstreamId, sessionId: "ws-b", sourceExchangeIds: ["ex-b"], sourceEvidenceIds: ["tb"] });
    expect(second).toMatchObject({ episodeCount: 2, patternState: "pattern" });
    expect(listIncidentOccurrences(db, { projectId: a.projectId }).map((o) => o.workstream_id).sort()).toEqual([a.workstreamId, b.workstreamId].sort());
    expect(matchIncidentPatterns(db, { projectId: a.projectId, text: base.signatureText, limit: 500 }).length).toBeLessThanOrEqual(20);
  });
});

describe("timeline and trace_fact scope isolation", () => {
  it("a sibling workstream's unmerged history never appears under another workstream or project scope", async () => {
    const a = ensureSessionMemoryState(db, { sessionId: "sess-a", project: cwd });
    const b = ensureSessionMemoryState(db, { sessionId: "sess-b", project: cwd });
    human("ex-p", "sess-p", "2026-08-01T10:00:00.000Z", "Main uses MySQL as the session store.");
    human("ex-a", "sess-a", "2026-08-10T10:00:00.000Z", "In this worktree the session store is Redis.", { workstreamId: a.workstreamId, workspaceId: a.workspaceId });
    human("ex-b", "sess-b", "2026-08-11T10:00:00.000Z", "In this worktree the session store is Postgres.", { workstreamId: b.workstreamId, workspaceId: b.workspaceId });
    await save([candidate("Session store is MySQL", "state.runtime.session_store", ["ex-p"], ["MySQL as the session store"])]);
    const projectFact = getActiveFacts(db)[0];
    const factA = insertFact(db, { fact: "Session store is Redis (worktree A)", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: ["ex-a"], embedding: emb, subject_key: "state.runtime.session_store", project_id: a.projectId, workspace_id: a.workspaceId, workstream_id: a.workstreamId });
    const factB = insertFact(db, { fact: "Session store is Postgres (worktree B)", category: "knowledge", scope_type: "project", scope_project: cwd, source_exchange_ids: ["ex-b"], embedding: emb, subject_key: "state.runtime.session_store", project_id: b.projectId, workspace_id: b.workspaceId, workstream_id: b.workstreamId });
    recordChronicleEvent(db, { kind: "ASSERTED", projectId: a.projectId, subjectKey: "state.runtime.session_store", factId: factA, newValue: "Session store is Redis (worktree A)", sourceExchangeIds: ["ex-a"], actor: "extractor", projectionApplied: true });
    recordChronicleEvent(db, { kind: "ASSERTED", projectId: b.projectId, subjectKey: "state.runtime.session_store", factId: factB, newValue: "Session store is Postgres (worktree B)", sourceExchangeIds: ["ex-b"], actor: "extractor", projectionApplied: true });
    expect(projectFact.promotion_state).toBe("legacy-project");
    expect(db.prepare("SELECT promotion_state FROM facts WHERE id = ?").get(factA)).toEqual({ promotion_state: "workstream" });

    const query = { projectId: a.projectId, subjectKey: "state.runtime.session_store", order: "asc" as const };
    const all = readChronicleTimeline(db, query).events.map((e) => e.new_value);
    expect(all).toHaveLength(3);
    const inA = readChronicleTimeline(db, { ...query, workstreamId: a.workstreamId, workspaceId: a.workspaceId }).events.map((e) => e.new_value);
    expect(inA).toEqual(["Session store is MySQL", "Session store is Redis (worktree A)"]);
    const inB = readChronicleTimeline(db, { ...query, workstreamId: b.workstreamId, workspaceId: b.workspaceId }).events.map((e) => e.new_value);
    expect(inB).toEqual(["Session store is MySQL", "Session store is Postgres (worktree B)"]);
    const projectOnly = readChronicleTimeline(db, { ...query, projectTruthOnly: true }).events.map((e) => e.new_value);
    expect(projectOnly).toEqual(["Session store is MySQL"]);

    const traceA = await handleToolCall("trace_fact", { subject_key: "state.runtime.session_store", scope: "workstream", workstream_id: a.workstreamId, include_incidents: false });
    const textA = traceA.content[0].text as string;
    expect(traceA.isError).toBeFalsy();
    expect(textA).toContain("Session store is Redis (worktree A)");
    expect(textA).toContain(`scope: workstream ${a.workstreamId} (unmerged; not project-wide truth)`);
    expect(textA).not.toContain("Postgres (worktree B)");
    const traceProject = await handleToolCall("trace_fact", { subject_key: "state.runtime.session_store", scope: "project", project_id: a.projectId, include_incidents: false });
    const textProject = traceProject.content[0].text as string;
    expect(textProject).toContain("[CURRENT FACT] Session store is MySQL");
    expect(textProject).not.toContain("worktree A");
    expect(textProject).not.toContain("worktree B");
    // Session scope reaches exactly that session's evidence.
    const traceSession = await handleToolCall("trace_fact", { subject_key: "state.runtime.session_store", scope: "session", session_id: "sess-b", include_incidents: false });
    const textSession = traceSession.content[0].text as string;
    expect(textSession).toContain("Postgres (worktree B)");
    expect(textSession).not.toContain("worktree A");
    expect(formatChronicleEvent(db, readChronicleTimeline(db, { factId: factB }).events[0])).toContain("unmerged; not project-wide truth");
  });
});

describe("sync end-to-end across two databases", () => {
  let dbA: Database.Database;
  let dbB: Database.Database;
  const pathA = () => path.join(root, "device-a.sqlite");
  const pathB = () => path.join(root, "device-b.sqlite");

  function open(which: "a" | "b"): Database.Database {
    process.env.TEST_DB_PATH = which === "a" ? pathA() : pathB();
    const opened = initDatabase();
    db = opened;
    return opened;
  }
  function close(which: "a" | "b"): void {
    (which === "a" ? dbA : dbB).close();
  }

  async function seedDeviceA(): Promise<{ factId: string; incidentEventId: string; projectId: string }> {
    dbA = open("a");
    human("ex-1", "s1", "2026-08-01T10:00:00.000Z", "We use MySQL as the runtime session store.");
    human("ex-2", "s2", "2026-08-14T10:20:00.000Z", "Switch the session store to Redis because session write P95 exceeded the limit.");
    toolCall("ex-2", "t2", "FAIL redis reconnect: missing TTL refresh", { isError: true });
    await save([candidate("Runtime session store is MySQL", "state.runtime.session_store", ["ex-1"], ["MySQL as the runtime session store"])]);
    await save([candidate("Runtime session store is Redis", "state.runtime.session_store", ["ex-2"], ["Switch the session store to Redis"], {
      change_context: { cause: { exchange_id: "ex-2", supporting_span: "session write P95 exceeded the limit", text: "session write P95 exceeded the limit" } },
      classifier_notes: ["unverified rationale: probably cheaper (span is not present in the source)"],
    })]);
    const fact = getActiveFacts(db)[0];
    const incident = recordIncidentOccurrence(db, { projectId: fact.project_id as string, sessionId: "s2", signatureText: "FAIL redis reconnect: missing TTL refresh", sourceExchangeIds: ["ex-2"], sourceEvidenceIds: ["t2"], evidenceAuthority: "trusted-tool", actor: "extractor" });
    return { factId: fact.id, incidentEventId: incident.eventId, projectId: fact.project_id as string };
  }

  function exportedRows(): { facts: string[]; revisions: string[]; tombstones: string[] } {
    const devices = path.join(getSyncDir(), "devices");
    const [device] = fs.readdirSync(devices);
    const current = JSON.parse(fs.readFileSync(path.join(devices, device, "CURRENT"), "utf-8")) as { generation: string };
    const dir = path.join(devices, device, "generations", current.generation);
    const lines = (name: string) => fs.readFileSync(path.join(dir, name), "utf-8").split("\n").filter(Boolean);
    return { facts: lines("facts.jsonl"), revisions: lines("fact-revisions.jsonl"), tombstones: lines("fact-tombstones.jsonl") };
  }

  afterEach(() => {
    // `db` is closed by the outer afterEach; close the other handle here.
    for (const handle of [dbA, dbB]) {
      if (handle && handle !== db && handle.open) handle.close();
    }
  });

  it("replays idempotently, keeps effective order, preserves grounded vs note fields, and survives conflict, tombstone, legacy and ungrounded peer rows", async () => {
    const seeded = await seedDeviceA();
    const exported = exportForSync();
    expect(exported.revisions).toBe(3);
    const rows = exportedRows();
    const revisionRows = rows.revisions.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(revisionRows.every((row) => typeof row.event_kind === "string" && "portable_project_key" in row && typeof row.project_id === "string")).toBe(true);
    close("a");

    dbB = open("b");
    const first = await importFromSync();
    expect(first.malformedRows).toEqual([]);
    expect(first.newFacts).toBe(1);
    expect(first.newRevisions).toBe(3);
    const second = await importFromSync();
    expect(second.newRevisions).toBe(0);
    expect(second.newFacts).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(3);

    const localProject = (db.prepare("SELECT project_id FROM facts WHERE id = ?").get(seeded.factId) as { project_id: string }).project_id;
    const timeline = readChronicleTimeline(db, { projectId: localProject, subjectKey: "state.runtime.session_store", order: "asc" }).events;
    expect(timeline.map((e) => e.event_kind)).toEqual(["ASSERTED", "CHANGED"]);
    expect(timeline[1]).toMatchObject({
      grounded_cause: "session write P95 exceeded the limit",
      classifier_note: "unverified rationale: probably cheaper (span is not present in the source)",
      effective_at: "2026-08-14T10:20:00.000Z", effective_at_source: "peer", actor: "extractor",
    });
    expect(formatChronicleEvent(db, timeline[1])).toContain("ex-2: source unavailable (purged or missing)");
    const incidentEvent = readChronicleTimeline(db, { projectId: localProject, kinds: ["INCIDENT"] }).events;
    expect(incidentEvent).toHaveLength(1);
    expect(incidentEvent[0].id).toBe(seeded.incidentEventId);

    // Same event id with different content from another peer: visible conflict, local history untouched.
    const changed = revisionRows.find((row) => row.event_kind === "CHANGED")!;
    const factLine = rows.facts[0];
    craftCommittedGeneration("device-conflict", {
      "facts.jsonl": `${factLine}\n`,
      "fact-revisions.jsonl": `${JSON.stringify({ ...changed, new_fact: "Runtime session store is Memcached" })}\n`,
    });
    const conflict = await importFromSync();
    expect(conflict.malformedRows.some((row) => /conflicts with the local event of the same id/.test(row.error))).toBe(true);
    expect(readChronicleTimeline(db, { factId: seeded.factId, kinds: ["CHANGED"] }).events[0].new_value).toBe("Runtime session store is Redis");
    fs.rmSync(path.join(getSyncDir(), "devices", "device-conflict"), { recursive: true, force: true });

    // Released 7-field peer row: imported as a legacy CHANGED event whose reason is a classifier note.
    craftCommittedGeneration("device-legacy", {
      "facts.jsonl": `${factLine}\n`,
      "fact-revisions.jsonl": `${JSON.stringify({ id: "legacy-peer-rev", fact_id: seeded.factId, previous_fact: "old", new_fact: "Runtime session store is Redis", reason: "peer consolidator said so", source_exchange_id: null, created_at: "2026-08-20T00:00:00.000Z" })}\n`,
    });
    const legacy = await importFromSync();
    expect(legacy.malformedRows).toEqual([]);
    expect(legacy.newRevisions).toBe(1);
    const legacyEvent = readChronicleTimeline(db, { factId: seeded.factId }).events.find((e) => e.id === "legacy-peer-rev")!;
    expect(legacyEvent).toMatchObject({ event_kind: "CHANGED", actor: "legacy", classifier_note: "peer consolidator said so", grounded_cause: null, effective_at_source: "peer" });
    fs.rmSync(path.join(getSyncDir(), "devices", "device-legacy"), { recursive: true, force: true });

    // A peer row carrying a grounded cause without any cited source is not a Memex-written row: the generation is rejected.
    craftCommittedGeneration("device-ungrounded", {
      "facts.jsonl": `${factLine}\n`,
      "fact-revisions.jsonl": `${JSON.stringify({ ...changed, id: "ungrounded-peer-event", source_exchange_ids: "[]", source_exchange_id: null, grounded_cause: "because I said so" })}\n`,
    });
    const ungrounded = await importFromSync();
    expect(ungrounded.malformedRows.some((row) => /schema validation/.test(row.error))).toBe(true);
    expect(db.prepare("SELECT 1 FROM fact_revisions WHERE id = 'ungrounded-peer-event'").get()).toBeUndefined();
    fs.rmSync(path.join(getSyncDir(), "devices", "device-ungrounded"), { recursive: true, force: true });

    // Event tombstone: the incident event is removed and can never be replayed.
    craftCommittedGeneration("device-tombstone", {
      "fact-tombstones.jsonl": `${JSON.stringify({ fact_id: null, event_id: seeded.incidentEventId, deleted_at: "2026-08-30T00:00:00.000Z", reason: "privacy_purge" })}\n`,
    });
    const tombstoned = await importFromSync();
    expect(tombstoned.newTombstones).toBe(1);
    expect(db.prepare("SELECT 1 FROM fact_revisions WHERE id = ?").get(seeded.incidentEventId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM chronicle_tombstones WHERE event_id = ?").get(seeded.incidentEventId)).toBeTruthy();
    fs.rmSync(path.join(getSyncDir(), "devices", "device-tombstone"), { recursive: true, force: true });
    const replay = await importFromSync(); // device A's original generation is still committed
    expect(replay.newRevisions).toBe(0);
    expect(db.prepare("SELECT 1 FROM fact_revisions WHERE id = ?").get(seeded.incidentEventId)).toBeUndefined();
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(3);
  });

  it("out-of-order generations: the later change arriving first still yields an effective-ordered timeline", async () => {
    const seeded = await seedDeviceA();
    exportForSync();
    const rows = exportedRows();
    const revisionRows = rows.revisions.map((line) => JSON.parse(line) as Record<string, unknown>);
    const asserted = revisionRows.find((row) => row.event_kind === "ASSERTED")!;
    const changed = revisionRows.find((row) => row.event_kind === "CHANGED")!;
    close("a");
    fs.rmSync(path.join(getSyncDir(), "devices"), { recursive: true, force: true });
    // Devices import in name order: the CHANGED event lands before the ASSERTED one.
    craftCommittedGeneration("device-1-late-change", { "facts.jsonl": `${rows.facts[0]}\n`, "fact-revisions.jsonl": `${JSON.stringify(changed)}\n` });
    craftCommittedGeneration("device-2-early-assert", { "facts.jsonl": `${rows.facts[0]}\n`, "fact-revisions.jsonl": `${JSON.stringify(asserted)}\n` });

    dbB = open("b");
    const result = await importFromSync();
    expect(result.malformedRows).toEqual([]);
    expect(result.newRevisions).toBe(2);
    const seqs = db.prepare("SELECT event_kind, chronicle_seq FROM fact_revisions ORDER BY chronicle_seq").all() as Array<{ event_kind: string; chronicle_seq: number }>;
    expect(seqs.map((row) => row.event_kind)).toEqual(["CHANGED", "ASSERTED"]);
    const timeline = readChronicleTimeline(db, { factId: seeded.factId, order: "asc" }).events;
    expect(timeline.map((e) => e.event_kind)).toEqual(["ASSERTED", "CHANGED"]);
    expect(timeline[0].effective_at < timeline[1].effective_at).toBe(true);
  });

  it("purge on the origin propagates as tombstones and a stale replay after the purge resurrects nothing", async () => {
    const seeded = await seedDeviceA();
    exportForSync();
    const before = exportedRows();
    close("a");
    dbB = open("b");
    expect((await importFromSync()).newRevisions).toBe(3);
    close("b");

    dbA = open("a");
    purgeConversationFromIndex(db, { archivePath: path.join(root, "s2.jsonl"), sessionId: "s2" });
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM chronicle_tombstones")).toBe(3);
    const purged = exportForSync();
    expect(purged.tombstones).toBeGreaterThanOrEqual(4); // fact tombstone + three event tombstones
    close("a");

    dbB = open("b");
    const result = await importFromSync();
    expect(result.malformedRows).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM incident_occurrences")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM facts")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM chronicle_tombstones")).toBe(3);
    // A third device still holds the pre-purge snapshot and replays it.
    craftCommittedGeneration("device-stale-replay", {
      "facts.jsonl": before.facts.join("\n") + "\n",
      "fact-revisions.jsonl": before.revisions.join("\n") + "\n",
    });
    const replay = await importFromSync();
    expect(replay.newRevisions).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM facts")).toBe(0);
    expect(seeded.factId).toBeTruthy();
  });
});
