/**
 * The candidate validator's half of `custom_fact_kinds` (#121 §(b)).
 *
 * Two behaviours, and the difference between them is the whole point:
 *
 *  - a category the CURRENT rules define is accepted and stored verbatim, so
 *    `facts.category` holds the operator's id;
 *  - a category they do NOT define drops that one candidate, with a single audit
 *    line and its own `unknown_fact_kind` reason. It is never an exception, never
 *    a failed range and never an attempt, because the alternative — treating a
 *    stale label as an extraction failure — would retry the same conversation
 *    forever and spend a model call each time.
 *
 * The audit assertion is deliberately about the FILE rather than a spy: the
 * reason `rules.blocked` is written with `await` in production is that a one-shot
 * extraction worker can exit before a detached promise resolves, and the only way
 * to catch a regression of that is to look for the line on disk afterwards.
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

import { initDatabase } from "../src/db.js";
import {
  createFactExtractionObservability,
  extractFactsFromExchanges,
} from "../src/fact-extractor.js";
import {
  loadExtractionRules,
  resetExtractionRulesCache,
  resolveExtractionRules,
} from "../src/extraction-rules.js";
import { pinOverlayEnv, restoreOverlayEnv, writeRules } from "./extraction-rules-fixture.js";

const PROJECT = "/tmp/custom-kind-project";
const SESSION = "sess-custom-kind";
const SPAN = "Riverpod";
const MESSAGE = "Flutter 프로젝트의 상태관리는 Riverpod으로 결정했습니다.";

const KIND = {
  id: "runbook",
  label_en: "Runbook step",
  label_ko: "운영 절차",
  description: "A step an operator must follow when this system misbehaves.",
};

let root: string;
let db: Database.Database;

function rulesFile(kinds: unknown[]): void {
  writeRules(root, {
    schema: "memex.extraction-rules-overlay",
    version: 1,
    revision: 1,
    custom_fact_kinds: kinds,
  });
  resetExtractionRulesCache();
}

function candidate(category: string, fact: string): Record<string, unknown> {
  return {
    fact,
    category,
    scope_type: "project",
    grounding_type: "explicit",
    durable: true,
    confidence: 0.95,
    evidence: [{ exchange_index: 1, source: "human", kind: "assertion", supporting_span: SPAN }],
    context_dependencies: [],
  };
}

/**
 * The scripted provider. Answers both model stages, so the fail-closed
 * entailment verifier stays REAL: a candidate that reaches the database here
 * genuinely cleared it, and the custom kind did not buy it a shortcut.
 */
function modelCall(candidates: unknown[]) {
  return async (systemPrompt: string, userMessage: string): Promise<string> => {
    if (!systemPrompt.includes("authoritative-entailment-v3")) return JSON.stringify(candidates);
    const envelope = JSON.parse(userMessage) as {
      candidates?: Array<{ selected_context_dependencies?: unknown[] }>;
    };
    return JSON.stringify(
      (envelope.candidates ?? []).map((entry, index) => ({
        candidate_index: index + 1,
        verdict: "ENTAILED",
        used_context_dependencies: entry.selected_context_dependencies ?? [],
        used_local_context_exchange_indices: [],
      })),
    );
  };
}

function auditLines(): Array<Record<string, unknown>> {
  const file = path.join(root, "logs", "ui-audit.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-kind-validate-"));
  pinOverlayEnv(root);
  process.env.MEMEX_DB_PATH = path.join(root, "test.sqlite");
  resetExtractionRulesCache();
  db = initDatabase();
  const insert = db.prepare(`
    INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  for (let i = 0; i < 2; i++) {
    insert.run(
      `ex-${i}`,
      PROJECT,
      new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      MESSAGE,
      "Riverpod 결정을 확인합니다.",
      path.join(root, `a${i}.jsonl`),
      1,
      10,
      SESSION,
    );
  }
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  resetExtractionRulesCache();
  restoreOverlayEnv();
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("extraction with custom fact kinds", () => {
  it("keeps a candidate whose kind the rules define", async () => {
    rulesFile([KIND]);
    const rules = resolveExtractionRules(PROJECT, loadExtractionRules());
    const observability = createFactExtractionObservability();

    const facts = await extractFactsFromExchanges(db, SESSION, undefined, undefined, {
      modelCall: modelCall([candidate("runbook", "Restart the queue worker after a stuck lease.")]),
      extractionRules: rules,
      observability,
    });

    expect(facts.map((fact) => fact.category)).toEqual(["runbook"]);
    expect(observability.accepted_count).toBe(1);
    expect(observability.rejected_unknown_fact_kind).toBe(0);
    expect(auditLines().filter((line) => line.action === "rules.kind-dropped")).toEqual([]);
  });

  it("drops an undefined kind with one audit line, and the run still succeeds", async () => {
    rulesFile([KIND]);
    const rules = resolveExtractionRules(PROJECT, loadExtractionRules());
    const observability = createFactExtractionObservability();

    const facts = await extractFactsFromExchanges(db, SESSION, undefined, undefined, {
      modelCall: modelCall([
        candidate("postmortem", "The queue stalled because the lease never expired."),
        candidate("runbook", "Restart the queue worker after a stuck lease."),
      ]),
      extractionRules: rules,
      observability,
    });

    // The defined kind survives; only the undefined one is dropped. A drop is
    // NOT a failure: the run returns normally and nothing throws.
    expect(facts.map((fact) => fact.category)).toEqual(["runbook"]);
    expect(observability.rejected_unknown_fact_kind).toBe(1);

    const dropped = auditLines().filter((line) => line.action === "rules.kind-dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ kinds: "postmortem", dropped: 1, project: PROJECT });
    expect(dropped[0].to_hash).toBe(rules.hash);
    // Ids and counts only — the dropped candidate's text must not reach a log
    // written by the code that refused to store it.
    expect(JSON.stringify(dropped[0])).not.toContain("lease never expired");
  });

  it("leaves a built-in category alone and keeps a malformed one a schema problem", async () => {
    rulesFile([KIND]);
    const rules = resolveExtractionRules(PROJECT, loadExtractionRules());
    const observability = createFactExtractionObservability();

    const facts = await extractFactsFromExchanges(db, SESSION, undefined, undefined, {
      modelCall: modelCall([
        candidate("decision", "Riverpod is the state management choice."),
        candidate("NOT A KIND", "Something the model invented."),
      ]),
      extractionRules: rules,
      observability,
    });

    expect(facts.map((fact) => fact.category)).toEqual(["decision"]);
    // A value that is not even a well-formed id is a malformed candidate, not a
    // stale label, so it must not be counted (or audited) as a dropped kind.
    expect(observability.rejected_invalid_schema).toBe(1);
    expect(observability.rejected_unknown_fact_kind).toBe(0);
    expect(auditLines().filter((line) => line.action === "rules.kind-dropped")).toEqual([]);
  });

  it("omits subject_key for a custom kind and records the unused proposal", async () => {
    rulesFile([KIND]);
    const rules = resolveExtractionRules(PROJECT, loadExtractionRules());

    const [fact] = await extractFactsFromExchanges(db, SESSION, undefined, undefined, {
      modelCall: modelCall([
        {
          ...candidate("runbook", "Restart the queue worker after a stuck lease."),
          subject_key: "decision.runtime.queue",
        },
      ]),
      extractionRules: rules,
    });

    // A custom kind has no Chronicle slot prefix, so the proposal is dropped to a
    // note rather than borrowing a built-in's slot space. Inventing a prefix here
    // would let two custom kinds collide in slots the built-in five own.
    expect(fact.category).toBe("runbook");
    expect(fact.subject_key ?? null).toBeNull();
    expect((fact.classifier_notes ?? []).join(" ")).toContain("unresolved subject_key proposal");
  });

  it("drops every non-built-in kind when the overlay defines none", async () => {
    const observability = createFactExtractionObservability();
    const facts = await extractFactsFromExchanges(db, SESSION, undefined, undefined, {
      modelCall: modelCall([candidate("runbook", "Restart the queue worker after a stuck lease.")]),
      observability,
    });
    expect(facts).toEqual([]);
    expect(observability.rejected_unknown_fact_kind).toBe(1);
    expect(observability.rejected_invalid_schema).toBe(0);
  });
});
