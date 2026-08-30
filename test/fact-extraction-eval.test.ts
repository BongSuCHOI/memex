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

describe("fact extraction evaluation fixture", () => {
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
      invokeModel: async ({ caseId }) => {
        if (caseId === "accepted") {
          return {
            text: JSON.stringify([
              {
                fact: "This project uses SQLite.",
                category: "knowledge",
                scope_type: "project",
                confidence: 0.95,
                source_exchange_indices: [1],
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
                source_exchange_indices: [1],
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
      passed_cases: 1,
      failed_cases: 2,
      expected_fact_count: 2,
      matched_fact_count: 1,
      false_positive_count: 1,
      self_amplification_leakage_count: 1,
      model_calls: 3,
      input_tokens: 240,
      output_tokens: 42,
    });
    expect(report.cases.find((entry) => entry.id === "unsupported")?.issues).toContain(
      "DROP-unsupported",
    );
    expect(report.cases.find((entry) => entry.id === "missed")?.issues).toContain(
      "MISS-important",
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
          invokeModel: async () => ({
            text: JSON.stringify([
              {
                fact: "This project uses SQLite.",
                category: "knowledge",
                scope_type: "project",
                confidence: 0.95,
                source_exchange_indices: [1],
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
