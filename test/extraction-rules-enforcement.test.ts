/**
 * The NEGATIVE test: a forbidden string reaches NO durable table (#30 §3.3, R9).
 *
 * This is the test the whole design exists for. An `observation` response never
 * reaches the candidate validator — `extractFactsFromExchanges` sees
 * `typeof candidate.observation === "string"` and `continue`s well before it — and
 * then lands in `recordIncidentOccurrence` (summary, signature_text),
 * `recordIncidentRemediation` (summary) and `recordChronicleEvent` (new_value).
 * A filter that only looked at fact candidates would pass every assertion about
 * facts and still write the operator's API key into `incident_signatures`.
 *
 * So all four routes are driven here — fact, incident, remediation, validated —
 * and the assertion is not "the fact table is empty" but "the string is in no
 * table at all", checked twice: against the six destinations §3.3 names, and
 * against every text column of every table that is not the conversation archive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase, insertExchange } from "../src/db.js";
import { saveExtractedFactsDetailed } from "../src/fact-extractor.js";
import { recordIncidentOccurrence } from "../src/chronicle.js";
import {
  loadExtractionRules,
  resetExtractionRulesCache,
  resolveExtractionRules,
} from "../src/extraction-rules.js";
import { rulesDoc, scanForForbidden, scanWholeDatabase, writeRules } from "./extraction-rules-fixture.js";
import type { ExtractedFact, ExtractedObservation } from "../src/types.js";

/** The secret. Shaped like the documented example so the regex is a real one. */
const SECRET = "sk-live-AbCdEf0123456789";
const PATTERN = "\\bsk-[A-Za-z0-9_-]{16,}";

let root: string;
let db: Database.Database;
const cwd = "/project/rules-enforcement";
const emb = new Array(384).fill(0.1);

function human(id: string, text: string, timestamp: string): void {
  insertExchange(
    db,
    {
      id,
      project: cwd,
      cwd,
      timestamp,
      userMessage: text,
      assistantMessage: "assistant context only",
      archivePath: path.join(root, "s1.jsonl"),
      lineStart: 1,
      lineEnd: 2,
      sessionId: "s1",
      closureState: "closed",
      parserVersion: 2,
    },
    emb,
  );
}

function toolCall(exchangeId: string, id: string, result: string, isError: boolean): void {
  db.prepare(`
    INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable)
    VALUES (?, ?, 'shell', '{"command":"npm test"}', ?, ?, ?, 'test_execution', 1)
  `).run(
    id,
    exchangeId,
    result,
    isError ? 1 : 0,
    (db.prepare("SELECT timestamp FROM exchanges WHERE id = ?").get(exchangeId) as {
      timestamp: string;
    }).timestamp,
  );
}

function factCandidate(text: string, span: string, subject: string): ExtractedFact {
  return {
    fact: text,
    category: "knowledge",
    scope_type: "project",
    confidence: 0.95,
    grounding_type: "explicit",
    durable: true,
    evidence: [{ exchange_index: 1, source: "human", kind: "assertion", supporting_span: span }],
    source_exchange_ids: ["ex-1"],
    subject_key: subject,
  };
}

function incident(summary: string, signature: string, toolId: string, span: string): ExtractedObservation {
  return {
    observation: "incident",
    summary,
    signature_text: signature,
    confidence: 0.9,
    evidence: [
      {
        exchange_index: 1,
        source: "tool",
        kind: "test_execution",
        source_type: "test_execution",
        tool_call_id: toolId,
        tool_name: "shell",
        supporting_span: span,
      },
    ],
    source_exchange_ids: ["ex-1"],
    source_evidence_ids: [toolId],
  };
}

function validated(
  summary: string,
  toolId: string,
  span: string,
  remediates?: string,
): ExtractedObservation {
  return {
    observation: "validated",
    summary,
    ...(remediates ? { remediates_signature_key: remediates } : {}),
    confidence: 0.9,
    evidence: [
      {
        exchange_index: 1,
        source: "tool",
        kind: "test_execution",
        source_type: "test_execution",
        tool_call_id: toolId,
        tool_name: "shell",
        supporting_span: span,
      },
    ],
    source_exchange_ids: ["ex-1"],
    source_evidence_ids: [toolId],
  };
}

async function save(
  facts: ExtractedFact[],
  observations: ExtractedObservation[],
): Promise<Awaited<ReturnType<typeof saveExtractedFactsDetailed>>> {
  return saveExtractedFactsDetailed(db, facts, cwd, [], undefined, undefined, {
    sessionId: "s1",
    observations,
    // The claim-time snapshot: exactly what `runFactExtraction` passes.
    rulesSnapshot: resolveExtractionRules(cwd, loadExtractionRules()),
    targetId: "target-enforcement",
  });
}

function count(sql: string): number {
  return Number((db.prepare(sql).get() as { n: number }).n);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-rules-enforce-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  resetExtractionRulesCache();
  db = initDatabase();
  writeRules(path.join(root, "home"), rulesDoc([{ id: "user.secret", source: PATTERN }]));
  resetExtractionRulesCache();
  human("ex-1", `The deploy key is ${SECRET} and the build failed.`, "2026-08-01T10:00:00.000Z");
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_EMBEDDING_STUB;
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a forbidden string in any of the four routes reaches no table", () => {
  it("(a) a fact candidate is dropped and nothing about it is stored", async () => {
    const outcome = await save(
      [factCandidate(`The deploy key is ${SECRET}`, SECRET, "state.deploy.key")],
      [],
    );
    expect(outcome.blockedByRules).toBe(1);
    expect(outcome.savedIds).toEqual([]);
    expect(count("SELECT COUNT(*) AS n FROM facts")).toBe(0);
    // No Chronicle event either: the insert never happened, so neither did its
    // ASSERTED row with the secret as `new_fact`.
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(0);
    expect(scanForForbidden(db, SECRET)).toEqual([]);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
  });

  it("(b) an incident observation is dropped before recordIncidentOccurrence", async () => {
    toolCall("ex-1", "t1", `FAIL auth with ${SECRET}`, true);
    const outcome = await save([], [incident(`auth fails using ${SECRET}`, `FAIL auth with ${SECRET}`, "t1", "FAIL auth")]);
    expect(outcome.blockedByRules).toBe(1);
    expect(outcome.incidents).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM incident_occurrences")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM incident_signatures")).toBe(0);
    expect(scanForForbidden(db, SECRET)).toEqual([]);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
  });

  it("(c) a remediation is dropped before recordIncidentRemediation", async () => {
    // A clean signature exists first, so the remediation route is genuinely
    // reachable — otherwise this would pass for the wrong reason.
    toolCall("ex-1", "t0", "FAIL auth handshake", true);
    const { signatureKey } = recordIncidentOccurrence(db, {
      projectId: (db.prepare("SELECT project_id FROM projects LIMIT 1").get() as {
        project_id: string;
      }).project_id,
      sessionId: "s1",
      signatureText: "FAIL auth handshake",
      summary: "auth handshake fails",
      sourceExchangeIds: ["ex-1"],
      sourceEvidenceIds: ["t0"],
      evidenceAuthority: "trusted-tool",
      recordedAt: new Date().toISOString(),
      actor: "extractor",
    });
    const before = count("SELECT COUNT(*) AS n FROM fact_revisions");
    toolCall("ex-1", "t2", "PASS auth handshake", false);
    const outcome = await save([], [validated(`fixed by rotating ${SECRET}`, "t2", "PASS auth", signatureKey)]);
    expect(outcome.blockedByRules).toBe(1);
    expect(outcome.validations).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions")).toBe(before);
    const summaryOf = (): string | null =>
      (db.prepare("SELECT remediation_summary FROM incident_signatures WHERE signature_key = ?")
        .get(signatureKey) as { remediation_summary: string | null }).remediation_summary;
    expect(summaryOf()).toBeNull();
    expect(scanForForbidden(db, SECRET)).toEqual([]);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);

    // Positive control — without it this test would pass even if the remediation
    // route were unreachable for some unrelated reason.
    const clean = await save([], [validated("fixed by rotating the key", "t2", "PASS auth", signatureKey)]);
    expect(clean.blockedByRules).toBe(0);
    expect(clean.validations).toBe(1);
    expect(summaryOf()).toBe("fixed by rotating the key");
  });

  it("(d) a VALIDATED Chronicle event is dropped before recordChronicleEvent", async () => {
    toolCall("ex-1", "t3", "PASS smoke suite", false);
    const outcome = await save([], [validated(`smoke suite passes with ${SECRET}`, "t3", "PASS smoke")]);
    expect(outcome.blockedByRules).toBe(1);
    expect(outcome.validations).toBe(0);
    // `newValue` is the summary — the column a fact-only filter would miss.
    expect(count("SELECT COUNT(*) AS n FROM fact_revisions WHERE event_kind = 'VALIDATED'")).toBe(0);
    expect(scanForForbidden(db, SECRET)).toEqual([]);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
  });

  it("blocks on `subject_key` and `fact_kr`, not only on `fact`", async () => {
    const outcome = await save(
      [
        {
          ...factCandidate("The deploy key is rotated", "deploy key", "state.deploy.key"),
          fact_kr: `배포 키는 ${SECRET} 입니다`,
        },
      ],
      [],
    );
    expect(outcome.blockedByRules).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM facts")).toBe(0);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
  });

  it("blocks on an EVIDENCE span when the scope says evidence", async () => {
    writeRules(
      path.join(root, "home"),
      rulesDoc([{ id: "user.secret", source: PATTERN, scope: "evidence" }]),
    );
    resetExtractionRulesCache();
    const outcome = await save(
      [factCandidate("A deploy key exists", SECRET, "state.deploy.key")],
      [],
    );
    expect(outcome.blockedByRules).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM facts")).toBe(0);
  });

  it("a `fact_text`-scoped rule does NOT block on evidence alone", async () => {
    writeRules(
      path.join(root, "home"),
      rulesDoc([{ id: "user.secret", source: PATTERN, scope: "fact_text" }]),
    );
    resetExtractionRulesCache();
    const outcome = await save(
      [factCandidate("A deploy key exists", SECRET, "state.deploy.key")],
      [],
    );
    expect(outcome.blockedByRules).toBe(0);
    expect(outcome.savedIds).toHaveLength(1);
  });
});

describe("a drop is not a failure", () => {
  it("stores the innocent candidates from the same batch and throws nothing", async () => {
    const outcome = await save(
      [
        factCandidate(`The deploy key is ${SECRET}`, SECRET, "state.deploy.key"),
        factCandidate("The build failed", "the build failed", "state.build.status"),
      ],
      [],
    );
    expect(outcome.blockedByRules).toBe(1);
    expect(outcome.savedIds).toHaveLength(1);
    const stored = db.prepare("SELECT fact FROM facts").all() as Array<{ fact: string }>;
    expect(stored).toEqual([{ fact: "The build failed" }]);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
  });

  it("stores everything when no rule applies", async () => {
    writeRules(path.join(root, "home"), rulesDoc([{ id: "user.other", source: "ghp_[a-z]{8,}" }]));
    resetExtractionRulesCache();
    const outcome = await save(
      [factCandidate(`The deploy key is ${SECRET}`, SECRET, "state.deploy.key")],
      [],
    );
    expect(outcome.blockedByRules).toBe(0);
    expect(outcome.savedIds).toHaveLength(1);
  });

  it("leaves the conversation archive alone — the rule forbids memory, not history", async () => {
    await save([factCandidate(`The deploy key is ${SECRET}`, SECRET, "state.deploy.key")], []);
    // The operator typed the secret; deleting their transcript would be a
    // different and much worse feature.
    expect(
      count(`SELECT COUNT(*) AS n FROM exchanges WHERE user_message LIKE '%${SECRET}%'`),
    ).toBe(1);
  });
});
