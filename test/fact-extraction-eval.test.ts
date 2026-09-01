import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  compareFactExtractionReports,
  evaluateFactExtractionArchiveSessions,
  evaluateFactExtractionFixture,
  parseFactExtractionFixture,
  type FactExtractionEvaluationReport,
} from "../src/fact-extraction-eval.js";

const fixturePath = path.join(
  import.meta.dirname,
  "fixtures",
  "fact-extraction-cases.json",
);
const p2FixturePath = path.join(
  import.meta.dirname,
  "fixtures",
  "fact-extraction-p2-cases.json",
);

function entailmentVerification(
  systemPrompt: string,
  userMessage: string,
  verdict = 'ENTAILED',
): { text: string; tokenUsage: { input_tokens: number; output_tokens: number } } | null {
  if (!systemPrompt.includes('authoritative-entailment-v2')) return null;
  const envelope = JSON.parse(userMessage) as { candidates: unknown[] };
  return {
    text: JSON.stringify(envelope.candidates.map((_, index) => ({
      candidate_index: index + 1,
      verdict,
    }))),
    tokenUsage: { input_tokens: 10, output_tokens: 2 },
  };
}

describe("fact extraction evaluation fixture", () => {
  it("keeps the P2 scope and long-range fixture separate from the 17-case baseline", () => {
    const fixture = parseFactExtractionFixture(
      JSON.parse(fs.readFileSync(p2FixturePath, "utf8")),
    );
    expect(fixture.cases).toHaveLength(23);
    expect(new Set(fixture.cases.map((entry) => entry.id)).size).toBe(23);
    const tags = new Set(fixture.cases.flatMap((entry) => entry.tags));
    for (const tag of [
      "global",
      "project",
      "long_range",
      "watermark",
      "ambiguous",
      "one_off",
      "cross_language",
      "human_origin",
      "open_vocabulary",
      "question_shaped",
      "negative_replacement",
      "pure_approval",
    ]) {
      expect(tags).toContain(tag);
    }
    expect(fixture.cases.find((entry) => entry.id === "g6-global-workflow-constraint")?.expected)
      .toEqual(expect.objectContaining({
        outcome: "facts",
        facts: [expect.objectContaining({ category: "constraint", scope_type: "global" })],
      }));
    for (const id of [
      "g9-cross-language-project",
      "g10-global-double-check",
      "l4-pure-proceed",
      "l5-korean-continue",
      "l6-open-vocabulary-original",
      "l7-human-origin-referent",
      "l8-question-shaped-constraint",
      "l9-negative-replacement",
    ]) {
      expect(fixture.cases.some((entry) => entry.id === id), id).toBe(true);
    }
    expect(fixture.cases.find((entry) => entry.id === "l7-human-origin-referent"))
      .toEqual(expect.objectContaining({
        watermark_after_exchange_index: 6,
        expected: expect.objectContaining({
          facts: [expect.objectContaining({
            authoritative_exchange_ids: ["l7-7"],
          })],
        }),
      }));
  });

  it("covers every required Phase 0 scenario", () => {
    const fixture = parseFactExtractionFixture(
      JSON.parse(fs.readFileSync(fixturePath, "utf8")),
    );

    expect(fixture.cases).toHaveLength(17);
    expect(new Set(fixture.cases.map((entry) => entry.id)).size).toBe(17);

    const tags = new Set(fixture.cases.flatMap((entry) => entry.tags));
    expect(tags).toEqual(
      expect.objectContaining(
        new Set([
          "positive",
          "negative",
          "explicit",
          "ratification",
          "exploration",
          "assistant_only",
          "recall",
          "self_amplification",
          "verified_local",
          "repeated_signal",
          "weak_signal",
          "short_ack",
          "social_ack",
          "watermark",
          "batch_boundary",
        ]),
      ),
    );
  });

  it("preserves the legacy 17-case fixture hash when additive term groups are absent", async () => {
    const fixture = parseFactExtractionFixture(
      JSON.parse(fs.readFileSync(fixturePath, "utf8")),
    );
    const report = await evaluateFactExtractionFixture(fixture, {
      model: "fixture-model",
      invokeModel: async () => ({ text: "[]" }),
    });

    expect(report.source).toEqual({
      kind: "fixture",
      name: "fact-extraction-context-grounding-curated-v1",
      sha256: "f45b4f0aa5ecda45c4d16a426f12e7d62b8c04dc97e4db64d65ebcb9ed75bcd6",
    });
  });

  it("scores expected facts, unsupported facts, misses, and telemetry", async () => {
    const fixture = parseFactExtractionFixture({
      schema_version: 1,
      name: "scoring-fixture",
      description: "small deterministic fixture",
      cases: [
        {
          id: "accepted",
          title: "accepted",
          tags: ["positive", "explicit"],
          exchanges: [
            {
              id: "accepted-1",
              user_message: "This project uses SQLite.",
              assistant_message: "Acknowledged.",
            },
          ],
          expected: {
            outcome: "facts",
            facts: [
              {
                required_terms: ["sqlite"],
                category: "knowledge",
                scope_type: "project",
                authoritative_exchange_ids: ["accepted-1"],
              },
            ],
          },
        },
        {
          id: "unsupported",
          title: "unsupported",
          tags: ["negative", "self_amplification"],
          exchanges: [
            {
              id: "unsupported-1",
              user_message: "What did the assistant say?",
              assistant_message: "The project uses Redis.",
            },
          ],
          expected: {
            outcome: "none",
            false_positive_taxonomy: "DROP-unsupported",
          },
        },
        {
          id: "missed",
          title: "missed",
          tags: ["positive", "ratification"],
          exchanges: [
            {
              id: "missed-1",
              user_message: "Use Riverpod.",
              assistant_message: "Proceeding.",
            },
          ],
          expected: {
            outcome: "facts",
            facts: [
              {
                required_terms: ["riverpod"],
                category: "decision",
                scope_type: "project",
                authoritative_exchange_ids: ["missed-1"],
              },
            ],
          },
        },
      ],
    });

    const report = await evaluateFactExtractionFixture(fixture, {
      model: "fixture-model",
      createdAt: "2026-08-31T00:00:00.000Z",
      invokeModel: async ({ caseId, systemPrompt, userMessage }) => {
        const verification = entailmentVerification(
          systemPrompt,
          userMessage,
          caseId === "unsupported" ? "NOT_ENOUGH" : "ENTAILED",
        );
        if (verification) return verification;
        if (caseId === "accepted") {
          return {
            text: JSON.stringify([
              {
                fact: "This project uses SQLite.",
                category: "knowledge",
                scope_type: "project",
                confidence: 0.95,
                grounding_type: "explicit",
                durable: true,
                evidence: [{
                  exchange_index: 1,
                  source: "human",
                  kind: "assertion",
                  supporting_span: "This project uses SQLite.",
                }],
              },
            ]),
            tokenUsage: { input_tokens: 100, output_tokens: 20 },
          };
        }
        if (caseId === "unsupported") {
          return {
            text: JSON.stringify([
              {
                fact: "This project uses Redis.",
                category: "knowledge",
                scope_type: "project",
                confidence: 0.95,
                grounding_type: "explicit",
                durable: true,
                evidence: [{
                  exchange_index: 1,
                  source: "human",
                  kind: "assertion",
                  supporting_span: "What did the assistant say?",
                }],
              },
            ]),
            tokenUsage: { input_tokens: 80, output_tokens: 20 },
          };
        }
        return {
          text: "[]",
          tokenUsage: { input_tokens: 60, output_tokens: 2 },
        };
      },
    });

    expect(report.summary).toMatchObject({
      case_count: 3,
      passed_cases: 2,
      failed_cases: 1,
      expected_fact_count: 2,
      matched_fact_count: 1,
      false_positive_count: 0,
      self_amplification_leakage_count: 0,
      generator_calls: 3,
      verifier_calls: 2,
      unknown_calls: 0,
      model_calls: 5,
      generator_input_tokens: 240,
      generator_output_tokens: 42,
      verifier_input_tokens: 20,
      verifier_output_tokens: 4,
      input_tokens: 260,
      output_tokens: 46,
    });
    expect(report.summary.generator_latency_ms).toEqual(expect.any(Number));
    expect(report.summary.verifier_latency_ms).toEqual(expect.any(Number));
    expect(report.cases.find((entry) => entry.id === "accepted")?.calls.map(
      (call) => call.call_type,
    )).toEqual(["generator", "verifier"]);
    expect(report.cases.find((entry) => entry.id === "unsupported")).toEqual(
      expect.objectContaining({ passed: true, issues: [] }),
    );
    expect(report.cases.find((entry) => entry.id === "missed")?.issues).toContain(
      "MISS-important",
    );
  });

  it("reports exclusive candidate acceptance and rejection telemetry", async () => {
    const fixture = parseFactExtractionFixture({
      schema_version: 1,
      name: "observability-fixture",
      description: "Phase 6 candidate decision telemetry",
      cases: [{
        id: "candidate-decisions",
        title: "candidate decisions",
        tags: ["positive", "ratification", "verified_local", "repeated_signal"],
        exchanges: [
          {
            id: "decision-1",
            user_message: "Keep responses concise across projects.",
            assistant_message: "I recommend Riverpod for this project.",
            tool_evidence: [{
              id: "tool-1",
              tool_name: "read_file",
              tool_result: "database = sqlite",
              source_type: "repo_file",
              learnable: true,
              is_error: false,
            }],
          },
          {
            id: "decision-2",
            user_message: "Yes, use it. Keep this concise too.",
            assistant_message: "Proceeding with Riverpod.",
          },
        ],
        expected: {
          outcome: "facts",
          facts: [
            {
              required_terms: ["riverpod"],
              category: "decision",
              scope_type: "project",
              authoritative_exchange_ids: ["decision-2"],
            },
            {
              required_terms: ["sqlite"],
              category: "knowledge",
              scope_type: "project",
              authoritative_exchange_ids: ["decision-1"],
            },
            {
              required_terms: ["concise"],
              category: "preference",
              scope_type: "global",
              authoritative_exchange_ids: ["decision-1", "decision-2"],
            },
          ],
        },
      }],
    });

    const accepted = [
      {
        fact: "This project uses Riverpod.",
        category: "decision",
        scope_type: "project",
        confidence: 0.95,
        grounding_type: "explicit",
        durable: true,
        evidence: [{
          exchange_index: 2,
          source: "human",
          kind: "ratification",
          supporting_span: "Yes, use it.",
        }],
        context_dependencies: [{
          context_id: 'ctx-1',
          relation: 'ratified_proposition',
        }],
      },
      {
        fact: "This project uses SQLite.",
        category: "knowledge",
        scope_type: "project",
        confidence: 0.95,
        grounding_type: "verified",
        durable: true,
        evidence: [{
          exchange_index: 1,
          source: "tool",
          kind: "repo_file",
          tool_call_id: "tool-1",
          tool_name: "read_file",
          source_type: "repo_file",
          supporting_span: "database = sqlite",
        }],
      },
      {
        fact: "The user prefers concise responses across projects.",
        category: "preference",
        scope_type: "global",
        confidence: 0.9,
        grounding_type: "inferred",
        durable: true,
        evidence: [
          { exchange_index: 1, source: "human", kind: "repeated_signal", supporting_span: "concise" },
          { exchange_index: 2, source: "human", kind: "repeated_signal", supporting_span: "concise" },
        ],
      },
    ];
    const rejected = [
      { ...accepted[0], fact: "Temporary choice.", durable: false },
      {
        ...accepted[0],
        fact: "Assistant-only claim.",
        evidence: [{ exchange_index: 1, source: "assistant", kind: "assertion" }],
      },
      {
        ...accepted[2],
        fact: "The user prefers concise responses.",
        evidence: [{
          exchange_index: 1,
          source: "human",
          kind: "repeated_signal",
          supporting_span: "concise",
        }],
      },
      { ...accepted[0], fact: "Low confidence.", confidence: 0.4 },
      { ...accepted[0], fact: "" },
    ];

    const report = await evaluateFactExtractionFixture(fixture, {
      model: "fixture-model",
      invokeModel: async ({ systemPrompt, userMessage }) =>
        entailmentVerification(systemPrompt, userMessage) ?? {
          text: JSON.stringify([...accepted, ...rejected]),
        },
    });

    expect(report.summary).toMatchObject({
      candidate_count: 8,
      accepted_count: 3,
      rejected_invalid_schema: 1,
      rejected_invalid_evidence: 1,
      rejected_not_durable: 1,
      rejected_grounding_rule: 1,
      rejected_confidence: 1,
      grounding_explicit: 1,
      grounding_verified: 1,
      grounding_inferred: 1,
      context_resolved_ratification: 1,
      windows_with_referent_candidates: 1,
      referent_candidates_total: 1,
      max_referent_candidates: 1,
      average_referent_candidates_per_window: 1,
    });
    expect(report.cases[0].extraction_observability).toEqual(
      expect.objectContaining({ candidate_count: 8, accepted_count: 3 }),
    );
  });

  it("reports per-case regressions and improvements against a baseline", () => {
    const baseline = {
      schema_version: 1,
      created_at: "2026-08-30T00:00:00.000Z",
      mode: "curated",
      model: "baseline",
      source: { kind: "fixture", name: "fixture", sha256: "a" },
      summary: {
        case_count: 2,
        passed_cases: 1,
        failed_cases: 1,
        expected_fact_count: 1,
        matched_fact_count: 0,
        observed_fact_count: 1,
        false_positive_count: 1,
        self_amplification_leakage_count: 1,
        positive_fact_recall: 0,
        negative_no_fact_accuracy: 0,
        precision: 0,
        model_calls: 2,
        input_tokens: 20,
        output_tokens: 10,
        token_usage_status: "observed",
        total_latency_ms: 10,
      },
      cases: [
        { id: "fixed", passed: false, issues: ["MISS-important"] },
        { id: "broken", passed: true, issues: [] },
      ],
    } as unknown as FactExtractionEvaluationReport;
    const current = {
      ...baseline,
      created_at: "2026-08-31T00:00:00.000Z",
      model: "current",
      cases: [
        { id: "fixed", passed: true, issues: [] },
        { id: "broken", passed: false, issues: ["DROP-noise"] },
      ],
    } as FactExtractionEvaluationReport;

    expect(compareFactExtractionReports(current, baseline)).toMatchObject({
      baseline_model: "baseline",
      improvements: ["fixed"],
      regressions: ["broken"],
    });

    expect(() =>
      compareFactExtractionReports(
        { ...current, source: { kind: "fixture", name: "fixture", sha256: "b" } },
        baseline,
      ),
    ).toThrow(/same fixture sha256/);
  });

  it("matches required terms across punctuation-only wording differences", async () => {
    const fixture = parseFactExtractionFixture({
      schema_version: 1,
      name: "punctuation-normalization",
      description: "hyphenated model wording should match fixture terms",
      cases: [{
        id: "hyphenated-pattern",
        title: "hyphenated pattern",
        tags: ["positive", "verified-tool"],
        exchanges: [{
          id: "hyphenated-pattern-1",
          user_message: "Duplicate-email failures in the auth callback are prevented by deduplication.",
          assistant_message: "Checking.",
        }],
        expected: {
          outcome: "facts",
          facts: [{
            required_terms: ["duplicate email", "auth callback"],
            category: "pattern",
            scope_type: "project",
            authoritative_exchange_ids: ["hyphenated-pattern-1"],
          }],
        },
      }],
    });
    const report = await evaluateFactExtractionFixture(fixture, {
      model: "fixture-model",
      invokeModel: async ({ systemPrompt, userMessage }) =>
        entailmentVerification(systemPrompt, userMessage) ?? ({
          text: JSON.stringify([{
          fact: "Deduplication prevents duplicate-email failures in the auth callback.",
          category: "pattern",
          scope_type: "project",
          grounding_type: "explicit",
          durable: true,
          confidence: 0.95,
          evidence: [{
            exchange_index: 1,
            source: "human",
            kind: "assertion",
            supporting_span: "Duplicate-email failures in the auth callback",
          }],
          }]),
        }),
    });
    expect(report.cases[0].passed).toBe(true);
  });

  it("matches every multilingual term group without requiring one canonical output language", async () => {
    const fixture = parseFactExtractionFixture({
      schema_version: 1,
      name: "multilingual-groups",
      description: "canonical fact language must not determine scoring",
      cases: [{
        id: "multilingual-workflow",
        title: "multilingual workflow",
        tags: ["positive", "cross_language"],
        exchanges: [{
          id: "multilingual-workflow-1",
          user_message: "앞으로 작업 전에 조사하고 계획해줘.",
          assistant_message: "그 순서를 유지하겠습니다.",
        }],
        expected: {
          outcome: "facts",
          facts: [{
            required_term_groups: [
              ["조사", "research", "investigation"],
              ["계획", "plan", "planning"],
            ],
            category: "constraint",
            scope_type: "global",
            authoritative_exchange_ids: ["multilingual-workflow-1"],
          }],
        },
      }],
    });
    const report = await evaluateFactExtractionFixture(fixture, {
      model: "fixture-model",
      invokeModel: async ({ systemPrompt, userMessage }) =>
        entailmentVerification(systemPrompt, userMessage) ?? ({
          text: JSON.stringify([{
            fact: "The user requires research and planning before work.",
            category: "constraint",
            scope_type: "global",
            grounding_type: "explicit",
            durable: true,
            confidence: 0.95,
            evidence: [{
              exchange_index: 1,
              source: "human",
              kind: "assertion",
              supporting_span: "앞으로 작업 전에 조사하고 계획해줘.",
            }],
          }]),
        }),
    });

    expect(report.cases[0]).toEqual(expect.objectContaining({ passed: true, issues: [] }));
  });

  it("applies legacy required terms and multilingual groups conjunctively", async () => {
    const fixture = parseFactExtractionFixture({
      schema_version: 1,
      name: "combined-term-contract",
      description: "legacy AND and group AND must both apply",
      cases: [{
        id: "combined-term-contract",
        title: "combined term contract",
        tags: ["positive", "cross_language"],
        exchanges: [{
          id: "combined-term-contract-1",
          user_message: "작업 전에 조사하고 계획하는 절차는 필수야.",
          assistant_message: "그 절차를 유지하겠습니다.",
        }],
        expected: {
          outcome: "facts",
          facts: [{
            required_terms: ["mandatory"],
            required_term_groups: [
              ["조사", "research"],
              ["계획", "planning"],
            ],
            category: "constraint",
            scope_type: "global",
            authoritative_exchange_ids: ["combined-term-contract-1"],
          }],
        },
      }],
    });
    const report = await evaluateFactExtractionFixture(fixture, {
      model: "fixture-model",
      invokeModel: async ({ systemPrompt, userMessage }) =>
        entailmentVerification(systemPrompt, userMessage) ?? ({
          text: JSON.stringify([{
            fact: "The user requires research and planning before work.",
            category: "constraint",
            scope_type: "global",
            grounding_type: "explicit",
            durable: true,
            confidence: 0.95,
            evidence: [{
              exchange_index: 1,
              source: "human",
              kind: "assertion",
              supporting_span: "작업 전에 조사하고 계획하는 절차는 필수야.",
            }],
          }]),
        }),
    });

    expect(report.cases[0].issues).toContain("MISS-important");
  });

  it("rejects malformed JSON at the fixture boundary", () => {
    expect(() =>
      parseFactExtractionFixture({
        schema_version: 1,
        name: "bad",
        description: "bad",
        cases: [{ id: "missing-fields" }],
      }),
    ).toThrow(/cases\[0\]/);
  });

  it("evaluates archive sessions through a read-only database without mutation", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "memex-fact-extraction-shadow-"),
    );
    const dbPath = path.join(directory, "db.sqlite");
    const writer = new Database(dbPath);
    writer.exec(`
      CREATE TABLE exchanges (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        cwd TEXT,
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
        is_error INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE extraction_log (
        session_id TEXT PRIMARY KEY,
        last_exchange_rowid INTEGER NOT NULL
      );
      INSERT INTO exchanges (
        id, session_id, project, cwd, user_message, assistant_message, timestamp
      ) VALUES (
        'shadow-exchange-1', 'shadow-session', '/tmp/project', '/tmp/project',
        'This project uses SQLite.', 'Acknowledged.', '2026-08-31T00:00:00Z'
      );
      INSERT INTO extraction_log (session_id, last_exchange_rowid)
      VALUES ('shadow-session', 99);
    `);
    writer.close();
    const before = fs.readFileSync(dbPath);

    const readonly = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    readonly.pragma("query_only = ON");
    try {
      const report = await evaluateFactExtractionArchiveSessions(
        readonly,
        ["shadow-session"],
        {
          model: "fixture-model",
          createdAt: "2026-08-31T00:00:00.000Z",
          invokeModel: async ({ systemPrompt, userMessage }) =>
            entailmentVerification(systemPrompt, userMessage) ?? ({
              text: JSON.stringify([
              {
                fact: "This project uses SQLite.",
                category: "knowledge",
                scope_type: "project",
                confidence: 0.95,
                grounding_type: "explicit",
                durable: true,
                evidence: [{
                  exchange_index: 1,
                  source: "human",
                  kind: "assertion",
                  supporting_span: "This project uses SQLite.",
                }],
              },
            ]),
              tokenUsage: { input_tokens: 10, output_tokens: 4 },
            }),
        },
      );
      expect(report.mode).toBe("shadow");
      expect(report.cases[0]).toMatchObject({
        id: "shadow-session",
        expected: null,
        passed: null,
        observed_facts: [
          {
            fact: "This project uses SQLite.",
            source_exchange_ids: ["shadow-exchange-1"],
          },
        ],
      });
      expect(() =>
        readonly.prepare("DELETE FROM extraction_log").run(),
      ).toThrow();
      expect(
        readonly
          .prepare(
            "SELECT last_exchange_rowid FROM extraction_log WHERE session_id = ?",
          )
          .get("shadow-session"),
      ).toEqual({ last_exchange_rowid: 99 });
    } finally {
      readonly.close();
    }

    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
