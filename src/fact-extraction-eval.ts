import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  createFactExtractionObservability,
  extractFactsFromExchanges,
  type FactExtractionModelCall,
  type FactExtractionObservability,
} from "./fact-extractor.js";
import type {
  EvidenceSourceType,
  ExtractedFact,
  FactCategory,
  FactScopeType,
} from "./types.js";

export type EvaluationIssue =
  | "DROP-noise"
  | "DROP-unsupported"
  | "MISS-important"
  | "WRONG-category"
  | "WRONG-provenance"
  | "WRONG-scope"
  | "EVAL-error";

export interface FactExtractionEvalToolEvidence {
  id: string;
  tool_name: string;
  tool_result: string | null;
  source_type: EvidenceSourceType;
  learnable: boolean;
  is_error: boolean;
}

export interface FactExtractionEvalExchange {
  id: string;
  user_message: string;
  assistant_message: string;
  assistant_learnable?: boolean;
  has_memex_recall?: boolean;
  tool_evidence?: FactExtractionEvalToolEvidence[];
}

export interface ExpectedEvaluationFact {
  required_terms: string[];
  category: FactCategory;
  scope_type: FactScopeType;
  authoritative_exchange_ids: string[];
}

export type FactExtractionCaseExpectation =
  | { outcome: "facts"; facts: ExpectedEvaluationFact[] }
  | { outcome: "none"; false_positive_taxonomy: EvaluationIssue };

export interface FactExtractionEvaluationCase {
  id: string;
  title: string;
  tags: string[];
  exchanges: FactExtractionEvalExchange[];
  watermark_after_exchange_index?: number;
  expected: FactExtractionCaseExpectation;
}

export interface FactExtractionEvaluationFixture {
  schema_version: 1;
  name: string;
  description: string;
  cases: FactExtractionEvaluationCase[];
}

export interface EvaluationTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
}

export interface EvaluationModelInvocation {
  caseId: string;
  systemPrompt: string;
  userMessage: string;
  callIndex: number;
}

export interface EvaluationModelResult {
  text: string;
  tokenUsage?: EvaluationTokenUsage | null;
}

export type EvaluationModelInvoker = (
  invocation: EvaluationModelInvocation,
) => Promise<EvaluationModelResult>;

export interface EvaluationCallReport {
  call_index: number;
  prompt_sha256: string;
  input_characters: number;
  output_characters: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  latency_ms: number;
}

export interface FactExtractionEvaluationCaseReport {
  id: string;
  title: string;
  tags: string[];
  expected: FactExtractionCaseExpectation | null;
  observed_facts: ExtractedFact[];
  passed: boolean | null;
  issues: EvaluationIssue[];
  expected_fact_count: number;
  matched_fact_count: number;
  false_positive_count: number;
  execution_error?: string;
  calls: EvaluationCallReport[];
  extraction_observability: FactExtractionObservability;
}

export interface EvaluationSummary extends FactExtractionObservability {
  case_count: number;
  passed_cases: number;
  failed_cases: number;
  execution_error_count: number;
  expected_fact_count: number;
  matched_fact_count: number;
  observed_fact_count: number;
  false_positive_count: number;
  self_amplification_leakage_count: number;
  positive_fact_recall: number | null;
  negative_no_fact_accuracy: number | null;
  precision: number | null;
  ratification_resolution: number | null;
  verified_local_recall: number | null;
  exploration_false_positive_rate: number | null;
  model_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  token_usage_status: "observed" | "partial" | "NOT_PROVEN";
  input_characters: number;
  output_characters: number;
  total_latency_ms: number;
}

export interface FactExtractionEvaluationReport {
  schema_version: 1;
  created_at: string;
  mode: "curated" | "shadow";
  model: string;
  source:
    | { kind: "fixture"; name: string; sha256: string }
    | { kind: "archive"; session_ids_sha256: string; session_count: number };
  summary: EvaluationSummary;
  cases: FactExtractionEvaluationCaseReport[];
  comparison?: FactExtractionReportComparison;
  run_context?: {
    git_head: string | null;
    git_dirty: boolean | null;
    node: string;
    platform: string;
    arch: string;
    extractor_profile: "production-current";
    database_mode: "not-opened" | "read-only";
  };
}

export interface FactExtractionReportComparison {
  baseline_model: string;
  baseline_created_at: string;
  improvements: string[];
  regressions: string[];
  unchanged_passes: string[];
  unchanged_failures: string[];
  deltas: {
    matched_fact_count: number;
    false_positive_count: number;
    self_amplification_leakage_count: number;
    model_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    total_latency_ms: number;
  };
}

const FACT_CATEGORIES = new Set<FactCategory>([
  "decision",
  "preference",
  "pattern",
  "knowledge",
  "constraint",
]);
const FACT_SCOPES = new Set<FactScopeType>(["global", "project"]);
const EVIDENCE_SOURCE_TYPES = new Set<EvidenceSourceType>([
  "human_assertion",
  "assistant_generated",
  "repo_file",
  "git_history",
  "test_execution",
  "external_unverified",
  "memex_recall",
]);
const NEGATIVE_TAXONOMY = new Set<EvaluationIssue>([
  "DROP-noise",
  "DROP-unsupported",
  "WRONG-scope",
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function optionalBoolean(
  value: unknown,
  path: string,
): boolean | undefined {
  return value === undefined ? undefined : booleanValue(value, path);
}

function parseToolEvidence(
  value: unknown,
  path: string,
): FactExtractionEvalToolEvidence {
  const input = record(value, path);
  const sourceType = stringValue(input.source_type, `${path}.source_type`);
  if (!EVIDENCE_SOURCE_TYPES.has(sourceType as EvidenceSourceType)) {
    throw new Error(`${path}.source_type is unsupported: ${sourceType}`);
  }
  if (input.tool_result !== null && typeof input.tool_result !== "string") {
    throw new Error(`${path}.tool_result must be a string or null`);
  }
  return {
    id: stringValue(input.id, `${path}.id`),
    tool_name: stringValue(input.tool_name, `${path}.tool_name`),
    tool_result: input.tool_result as string | null,
    source_type: sourceType as EvidenceSourceType,
    learnable: booleanValue(input.learnable, `${path}.learnable`),
    is_error: booleanValue(input.is_error, `${path}.is_error`),
  };
}

function parseExchange(
  value: unknown,
  path: string,
): FactExtractionEvalExchange {
  const input = record(value, path);
  if (!Array.isArray(input.tool_evidence) && input.tool_evidence !== undefined) {
    throw new Error(`${path}.tool_evidence must be an array`);
  }
  return {
    id: stringValue(input.id, `${path}.id`),
    user_message:
      typeof input.user_message === "string"
        ? input.user_message
        : (() => {
            throw new Error(`${path}.user_message must be a string`);
          })(),
    assistant_message:
      typeof input.assistant_message === "string"
        ? input.assistant_message
        : (() => {
            throw new Error(`${path}.assistant_message must be a string`);
          })(),
    assistant_learnable: optionalBoolean(
      input.assistant_learnable,
      `${path}.assistant_learnable`,
    ),
    has_memex_recall: optionalBoolean(
      input.has_memex_recall,
      `${path}.has_memex_recall`,
    ),
    tool_evidence: (input.tool_evidence ?? []).map((tool, index) =>
      parseToolEvidence(tool, `${path}.tool_evidence[${index}]`),
    ),
  };
}

function parseExpectedFact(
  value: unknown,
  path: string,
): ExpectedEvaluationFact {
  const input = record(value, path);
  const category = stringValue(input.category, `${path}.category`);
  const scope = stringValue(input.scope_type, `${path}.scope_type`);
  if (!FACT_CATEGORIES.has(category as FactCategory)) {
    throw new Error(`${path}.category is unsupported: ${category}`);
  }
  if (!FACT_SCOPES.has(scope as FactScopeType)) {
    throw new Error(`${path}.scope_type is unsupported: ${scope}`);
  }
  return {
    required_terms: stringArray(input.required_terms, `${path}.required_terms`),
    category: category as FactCategory,
    scope_type: scope as FactScopeType,
    authoritative_exchange_ids: stringArray(
      input.authoritative_exchange_ids,
      `${path}.authoritative_exchange_ids`,
    ),
  };
}

function parseExpectation(
  value: unknown,
  path: string,
): FactExtractionCaseExpectation {
  const input = record(value, path);
  if (input.outcome === "facts") {
    if (!Array.isArray(input.facts) || input.facts.length === 0) {
      throw new Error(`${path}.facts must be a non-empty array`);
    }
    return {
      outcome: "facts",
      facts: input.facts.map((fact, index) =>
        parseExpectedFact(fact, `${path}.facts[${index}]`),
      ),
    };
  }
  if (input.outcome === "none") {
    const taxonomy = stringValue(
      input.false_positive_taxonomy,
      `${path}.false_positive_taxonomy`,
    ) as EvaluationIssue;
    if (!NEGATIVE_TAXONOMY.has(taxonomy)) {
      throw new Error(`${path}.false_positive_taxonomy is unsupported: ${taxonomy}`);
    }
    return { outcome: "none", false_positive_taxonomy: taxonomy };
  }
  throw new Error(`${path}.outcome must be facts or none`);
}

function parseCase(
  value: unknown,
  index: number,
): FactExtractionEvaluationCase {
  const path = `cases[${index}]`;
  const input = record(value, path);
  if (!Array.isArray(input.exchanges) || input.exchanges.length === 0) {
    throw new Error(`${path}.exchanges must be a non-empty array`);
  }
  const exchanges = input.exchanges.map((exchange, exchangeIndex) =>
    parseExchange(exchange, `${path}.exchanges[${exchangeIndex}]`),
  );
  const exchangeIds = new Set(exchanges.map((exchange) => exchange.id));
  if (exchangeIds.size !== exchanges.length) {
    throw new Error(`${path}.exchanges contains duplicate ids`);
  }
  const expected = parseExpectation(input.expected, `${path}.expected`);
  if (expected.outcome === "facts") {
    for (const [factIndex, fact] of expected.facts.entries()) {
      for (const exchangeId of fact.authoritative_exchange_ids) {
        if (!exchangeIds.has(exchangeId)) {
          throw new Error(
            `${path}.expected.facts[${factIndex}] references unknown exchange ${exchangeId}`,
          );
        }
      }
    }
  }

  let watermark: number | undefined;
  if (input.watermark_after_exchange_index !== undefined) {
    if (
      !Number.isInteger(input.watermark_after_exchange_index) ||
      Number(input.watermark_after_exchange_index) < 1 ||
      Number(input.watermark_after_exchange_index) >= exchanges.length
    ) {
      throw new Error(
        `${path}.watermark_after_exchange_index must identify a prefix exchange`,
      );
    }
    watermark = Number(input.watermark_after_exchange_index);
  }

  return {
    id: stringValue(input.id, `${path}.id`),
    title: stringValue(input.title, `${path}.title`),
    tags: stringArray(input.tags, `${path}.tags`),
    exchanges,
    watermark_after_exchange_index: watermark,
    expected,
  };
}

export function parseFactExtractionFixture(
  value: unknown,
): FactExtractionEvaluationFixture {
  const input = record(value, "fixture");
  if (input.schema_version !== 1) {
    throw new Error("fixture.schema_version must be 1");
  }
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    throw new Error("fixture.cases must be a non-empty array");
  }
  const cases = input.cases.map(parseCase);
  const caseIds = new Set(cases.map((entry) => entry.id));
  if (caseIds.size !== cases.length) {
    throw new Error("fixture.cases contains duplicate ids");
  }
  return {
    schema_version: 1,
    name: stringValue(input.name, "fixture.name"),
    description: stringValue(input.description, "fixture.description"),
    cases,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createCaseDatabase(
  testCase: FactExtractionEvaluationCase,
): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE exchanges (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT '["human_assertion","assistant_generated"]',
      assistant_learnable INTEGER NOT NULL DEFAULT 0,
      has_memex_recall INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_result TEXT,
      source_type TEXT NOT NULL,
      learnable INTEGER NOT NULL,
      is_error INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    );
  `);
  const insertExchange = db.prepare(`
    INSERT INTO exchanges (
      id, session_id, user_message, assistant_message,
      provenance, assistant_learnable, has_memex_recall, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTool = db.prepare(`
    INSERT INTO tool_calls (
      id, exchange_id, tool_name, tool_result, source_type,
      learnable, is_error, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction(() => {
    testCase.exchanges.forEach((exchange, exchangeIndex) => {
      const timestamp = new Date(
        Date.UTC(2026, 0, 1, 0, exchangeIndex),
      ).toISOString();
      insertExchange.run(
        exchange.id,
        testCase.id,
        exchange.user_message,
        exchange.assistant_message,
        JSON.stringify(["human_assertion", "assistant_generated"]),
        exchange.assistant_learnable ? 1 : 0,
        exchange.has_memex_recall ? 1 : 0,
        timestamp,
      );
      for (const tool of exchange.tool_evidence ?? []) {
        insertTool.run(
          tool.id,
          exchange.id,
          tool.tool_name,
          tool.tool_result,
          tool.source_type,
          tool.learnable ? 1 : 0,
          tool.is_error ? 1 : 0,
          timestamp,
        );
      }
    });
  });
  insertAll();
  return db;
}

function exactSetMatch(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function includesRequiredTerms(fact: string, terms: string[]): boolean {
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalized = normalize(fact);
  return terms.every((term) => normalized.includes(normalize(term)));
}

function uniqueIssues(issues: EvaluationIssue[]): EvaluationIssue[] {
  return [...new Set(issues)];
}

function scoreCase(
  testCase: FactExtractionEvaluationCase,
  facts: ExtractedFact[],
): {
  passed: boolean;
  issues: EvaluationIssue[];
  matchedFacts: number;
  falsePositives: number;
} {
  if (testCase.expected.outcome === "none") {
    return {
      passed: facts.length === 0,
      issues:
        facts.length === 0
          ? []
          : [testCase.expected.false_positive_taxonomy],
      matchedFacts: 0,
      falsePositives: facts.length,
    };
  }

  const issues: EvaluationIssue[] = [];
  const consumed = new Set<number>();
  let matchedFacts = 0;
  for (const expected of testCase.expected.facts) {
    const candidateIndex = facts.findIndex(
      (fact, index) =>
        !consumed.has(index) &&
        includesRequiredTerms(fact.fact, expected.required_terms),
    );
    if (candidateIndex < 0) {
      issues.push("MISS-important");
      continue;
    }
    consumed.add(candidateIndex);
    const candidate = facts[candidateIndex];
    let contractMatches = true;
    if (candidate.category !== expected.category) {
      issues.push("WRONG-category");
      contractMatches = false;
    }
    if (candidate.scope_type !== expected.scope_type) {
      issues.push("WRONG-scope");
      contractMatches = false;
    }
    if (
      !exactSetMatch(
        candidate.source_exchange_ids ?? [],
        expected.authoritative_exchange_ids,
      )
    ) {
      issues.push("WRONG-provenance");
      contractMatches = false;
    }
    if (contractMatches) matchedFacts += 1;
  }

  const falsePositives = facts.length - consumed.size;
  if (falsePositives > 0) issues.push("DROP-noise");
  return {
    passed:
      matchedFacts === testCase.expected.facts.length &&
      falsePositives === 0 &&
      issues.length === 0,
    issues: uniqueIssues(issues),
    matchedFacts,
    falsePositives,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function summarize(
  reports: FactExtractionEvaluationCaseReport[],
): EvaluationSummary {
  const calls = reports.flatMap((entry) => entry.calls);
  const curated = reports.filter((entry) => entry.expected !== null);
  const positives = curated.filter(
    (entry) => entry.expected?.outcome === "facts",
  );
  const negatives = curated.filter(
    (entry) => entry.expected?.outcome === "none",
  );
  const expectedFactCount = positives.reduce(
    (sum, entry) => sum + entry.expected_fact_count,
    0,
  );
  const matchedFactCount = positives.reduce(
    (sum, entry) => sum + entry.matched_fact_count,
    0,
  );
  const observedFactCount = reports.reduce(
    (sum, entry) => sum + entry.observed_facts.length,
    0,
  );
  const falsePositiveCount = reports.reduce(
    (sum, entry) => sum + entry.false_positive_count,
    0,
  );
  const tokenObserved = calls.filter(
    (call) => call.input_tokens !== null && call.output_tokens !== null,
  );
  const tokenStatus =
    calls.length === 0 || tokenObserved.length === 0
      ? "NOT_PROVEN"
      : tokenObserved.length === calls.length
        ? "observed"
        : "partial";
  const taggedRatio = (tag: string): number | null => {
    const selected = positives.filter((entry) => entry.tags.includes(tag));
    return ratio(
      selected.filter((entry) => entry.passed === true).length,
      selected.length,
    );
  };
  const exploration = negatives.filter((entry) =>
    entry.tags.includes("exploration"),
  );
  const extractionObservability = reports.reduce<FactExtractionObservability>(
    (total, entry) => {
      for (const key of Object.keys(total) as Array<keyof FactExtractionObservability>) {
        total[key] += entry.extraction_observability[key];
      }
      return total;
    },
    createFactExtractionObservability(),
  );

  return {
    ...extractionObservability,
    case_count: reports.length,
    passed_cases: curated.filter((entry) => entry.passed === true).length,
    failed_cases: curated.filter((entry) => entry.passed === false).length,
    execution_error_count: reports.filter((entry) => entry.execution_error).length,
    expected_fact_count: expectedFactCount,
    matched_fact_count: matchedFactCount,
    observed_fact_count: observedFactCount,
    false_positive_count: falsePositiveCount,
    self_amplification_leakage_count: reports
      .filter((entry) => entry.tags.includes("self_amplification"))
      .reduce((sum, entry) => sum + entry.observed_facts.length, 0),
    positive_fact_recall: ratio(matchedFactCount, expectedFactCount),
    negative_no_fact_accuracy: ratio(
      negatives.filter((entry) => entry.observed_facts.length === 0).length,
      negatives.length,
    ),
    precision: ratio(matchedFactCount, observedFactCount),
    ratification_resolution: taggedRatio("ratification"),
    verified_local_recall: taggedRatio("verified_local"),
    exploration_false_positive_rate: ratio(
      exploration.filter((entry) => entry.observed_facts.length > 0).length,
      exploration.length,
    ),
    model_calls: calls.length,
    input_tokens:
      tokenStatus === "NOT_PROVEN"
        ? null
        : tokenObserved.reduce((sum, call) => sum + (call.input_tokens ?? 0), 0),
    output_tokens:
      tokenStatus === "NOT_PROVEN"
        ? null
        : tokenObserved.reduce((sum, call) => sum + (call.output_tokens ?? 0), 0),
    cached_input_tokens:
      tokenStatus === "NOT_PROVEN"
        ? null
        : tokenObserved.reduce(
            (sum, call) => sum + (call.cached_input_tokens ?? 0),
            0,
          ),
    token_usage_status: tokenStatus,
    input_characters: calls.reduce(
      (sum, call) => sum + call.input_characters,
      0,
    ),
    output_characters: calls.reduce(
      (sum, call) => sum + call.output_characters,
      0,
    ),
    total_latency_ms: calls.reduce((sum, call) => sum + call.latency_ms, 0),
  };
}

export interface EvaluateFixtureOptions {
  model: string;
  invokeModel: EvaluationModelInvoker;
  createdAt?: string;
}

export async function evaluateFactExtractionFixture(
  fixture: FactExtractionEvaluationFixture,
  options: EvaluateFixtureOptions,
): Promise<FactExtractionEvaluationReport> {
  const caseReports: FactExtractionEvaluationCaseReport[] = [];
  for (const testCase of fixture.cases) {
    const db = createCaseDatabase(testCase);
    const calls: EvaluationCallReport[] = [];
    const extractionObservability = createFactExtractionObservability();
    let callIndex = 0;
    const modelCall: FactExtractionModelCall = async (
      systemPrompt,
      userMessage,
    ) => {
      const currentCall = ++callIndex;
      const started = performance.now();
      const result = await options.invokeModel({
        caseId: testCase.id,
        systemPrompt,
        userMessage,
        callIndex: currentCall,
      });
      const tokenUsage = result.tokenUsage ?? null;
      calls.push({
        call_index: currentCall,
        prompt_sha256: sha256(`${systemPrompt}\n---\n${userMessage}`),
        input_characters: systemPrompt.length + userMessage.length,
        output_characters: result.text.length,
        input_tokens: tokenUsage?.input_tokens ?? null,
        output_tokens: tokenUsage?.output_tokens ?? null,
        cached_input_tokens: tokenUsage?.cached_input_tokens ?? null,
        latency_ms: performance.now() - started,
      });
      return result.text;
    };

    let facts: ExtractedFact[] = [];
    let executionError: string | undefined;
    try {
      facts = await extractFactsFromExchanges(
        db,
        testCase.id,
        { droppedBatches: 0 },
        undefined,
        {
          onlyAfterRowid: testCase.watermark_after_exchange_index,
          modelCall,
          observability: extractionObservability,
        },
      );
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    } finally {
      db.close();
    }

    const score = executionError
      ? {
          passed: false,
          issues: ["EVAL-error" as const],
          matchedFacts: 0,
          falsePositives: 0,
        }
      : scoreCase(testCase, facts);
    caseReports.push({
      id: testCase.id,
      title: testCase.title,
      tags: testCase.tags,
      expected: testCase.expected,
      observed_facts: facts,
      passed: score.passed,
      issues: score.issues,
      expected_fact_count:
        testCase.expected.outcome === "facts"
          ? testCase.expected.facts.length
          : 0,
      matched_fact_count: score.matchedFacts,
      false_positive_count: score.falsePositives,
      ...(executionError ? { execution_error: executionError } : {}),
      calls,
      extraction_observability: extractionObservability,
    });
  }

  return {
    schema_version: 1,
    created_at: options.createdAt ?? new Date().toISOString(),
    mode: "curated",
    model: options.model,
    source: {
      kind: "fixture",
      name: fixture.name,
      sha256: sha256(JSON.stringify(fixture)),
    },
    summary: summarize(caseReports),
    cases: caseReports,
  };
}

export interface EvaluateArchiveOptions extends EvaluateFixtureOptions {}

export async function evaluateFactExtractionArchiveSessions(
  db: Database.Database,
  sessionIds: string[],
  options: EvaluateArchiveOptions,
): Promise<FactExtractionEvaluationReport> {
  if (sessionIds.length === 0) {
    throw new Error("at least one archive session id is required");
  }
  const uniqueSessionIds = [...new Set(sessionIds)];
  const reports: FactExtractionEvaluationCaseReport[] = [];
  for (const sessionId of uniqueSessionIds) {
    const session = db
      .prepare(`
        SELECT COUNT(*) AS exchange_count,
               MAX(COALESCE(cwd, project)) AS project
        FROM exchanges WHERE session_id = ?
      `)
      .get(sessionId) as { exchange_count: number; project: string | null };
    if (session.exchange_count === 0) {
      reports.push({
        id: sessionId,
        title: `Archive session ${sessionId}`,
        tags: ["shadow"],
        expected: null,
        observed_facts: [],
        passed: null,
        issues: ["EVAL-error"],
        expected_fact_count: 0,
        matched_fact_count: 0,
        false_positive_count: 0,
        execution_error: "session was not found in the archive database",
        calls: [],
        extraction_observability: createFactExtractionObservability(),
      });
      continue;
    }

    const calls: EvaluationCallReport[] = [];
    const extractionObservability = createFactExtractionObservability();
    let callIndex = 0;
    const modelCall: FactExtractionModelCall = async (
      systemPrompt,
      userMessage,
    ) => {
      const currentCall = ++callIndex;
      const started = performance.now();
      const result = await options.invokeModel({
        caseId: sessionId,
        systemPrompt,
        userMessage,
        callIndex: currentCall,
      });
      const tokenUsage = result.tokenUsage ?? null;
      calls.push({
        call_index: currentCall,
        prompt_sha256: sha256(`${systemPrompt}\n---\n${userMessage}`),
        input_characters: systemPrompt.length + userMessage.length,
        output_characters: result.text.length,
        input_tokens: tokenUsage?.input_tokens ?? null,
        output_tokens: tokenUsage?.output_tokens ?? null,
        cached_input_tokens: tokenUsage?.cached_input_tokens ?? null,
        latency_ms: performance.now() - started,
      });
      return result.text;
    };

    let facts: ExtractedFact[] = [];
    let executionError: string | undefined;
    try {
      facts = await extractFactsFromExchanges(
        db,
        sessionId,
        { droppedBatches: 0 },
        undefined,
        { modelCall, observability: extractionObservability },
      );
    } catch (error) {
      executionError = error instanceof Error ? error.message : String(error);
    }
    reports.push({
      id: sessionId,
      title: session.project
        ? `Archive session in ${session.project}`
        : `Archive session ${sessionId}`,
      tags: ["shadow"],
      expected: null,
      observed_facts: facts,
      passed: null,
      issues: executionError ? ["EVAL-error"] : [],
      expected_fact_count: 0,
      matched_fact_count: 0,
      false_positive_count: 0,
      ...(executionError ? { execution_error: executionError } : {}),
      calls,
      extraction_observability: extractionObservability,
    });
  }

  return {
    schema_version: 1,
    created_at: options.createdAt ?? new Date().toISOString(),
    mode: "shadow",
    model: options.model,
    source: {
      kind: "archive",
      session_ids_sha256: sha256(uniqueSessionIds.sort().join("\n")),
      session_count: uniqueSessionIds.length,
    },
    summary: summarize(reports),
    cases: reports,
  };
}

export function compareFactExtractionReports(
  current: FactExtractionEvaluationReport,
  baseline: FactExtractionEvaluationReport,
): FactExtractionReportComparison {
  if (
    current.mode !== "curated" ||
    baseline.mode !== "curated" ||
    current.source.kind !== "fixture" ||
    baseline.source.kind !== "fixture"
  ) {
    throw new Error("fact extraction comparison requires two curated reports");
  }
  if (current.source.sha256 !== baseline.source.sha256) {
    throw new Error("fact extraction comparison requires the same fixture sha256");
  }
  const currentCaseIds = current.cases.map((entry) => entry.id).sort();
  const baselineCaseIds = baseline.cases.map((entry) => entry.id).sort();
  if (JSON.stringify(currentCaseIds) !== JSON.stringify(baselineCaseIds)) {
    throw new Error("fact extraction comparison requires the same case ids");
  }
  const baselineById = new Map(
    baseline.cases.map((entry) => [entry.id, entry]),
  );
  const improvements: string[] = [];
  const regressions: string[] = [];
  const unchangedPasses: string[] = [];
  const unchangedFailures: string[] = [];
  for (const entry of current.cases) {
    const prior = baselineById.get(entry.id);
    if (!prior || entry.passed === null || prior.passed === null) continue;
    if (!prior.passed && entry.passed) improvements.push(entry.id);
    else if (prior.passed && !entry.passed) regressions.push(entry.id);
    else if (entry.passed) unchangedPasses.push(entry.id);
    else unchangedFailures.push(entry.id);
  }
  const tokenDelta = (
    currentValue: number | null,
    baselineValue: number | null,
  ): number | null =>
    currentValue === null || baselineValue === null
      ? null
      : currentValue - baselineValue;
  return {
    baseline_model: baseline.model,
    baseline_created_at: baseline.created_at,
    improvements,
    regressions,
    unchanged_passes: unchangedPasses,
    unchanged_failures: unchangedFailures,
    deltas: {
      matched_fact_count:
        current.summary.matched_fact_count - baseline.summary.matched_fact_count,
      false_positive_count:
        current.summary.false_positive_count - baseline.summary.false_positive_count,
      self_amplification_leakage_count:
        current.summary.self_amplification_leakage_count -
        baseline.summary.self_amplification_leakage_count,
      model_calls: current.summary.model_calls - baseline.summary.model_calls,
      input_tokens: tokenDelta(
        current.summary.input_tokens,
        baseline.summary.input_tokens,
      ),
      output_tokens: tokenDelta(
        current.summary.output_tokens,
        baseline.summary.output_tokens,
      ),
      total_latency_ms:
        current.summary.total_latency_ms - baseline.summary.total_latency_ms,
    },
  };
}
