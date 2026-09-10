import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ensureModelBudgetSchema,
  finishModelAttempt,
  formatModelWorkDiagnostics,
  getModelWorkDiagnostics,
  getOrCreateModelWorkBudget,
  reserveModelAttempt,
} from "../src/model-budget.js";
import { invalidateModelSettingsCache, writeModelSettings } from "../src/model-settings.js";

/**
 * Once the model is selectable, one run can mix two of them — so `model_work_attempts`
 * has to say which. Before this the ledger recorded what a call cost and never
 * what it cost it ON, which made "the new model is slower/worse" unanswerable
 * from local evidence.
 *
 * Two values per row on purpose: the INTENDED selection at reservation (known
 * before the call) and the one actually sent at completion (observed by
 * codex-exec). They differ exactly when something overrides per call.
 */

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-attempt-identity-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMEX_CODEX_REASONING;
  invalidateModelSettingsCache();
  db = new Database(process.env.MEMEX_DB_PATH);
  ensureModelBudgetSchema(db);
});

afterEach(() => {
  if (db.open) db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMEX_CODEX_REASONING;
  invalidateModelSettingsCache();
  fs.rmSync(root, { recursive: true, force: true });
});

function newBudget(wave = "wave-identity") {
  return getOrCreateModelWorkBudget(db, {
    parentWaveId: wave,
    limits: { maxAttempts: 8, maxInputChars: 1_000, maxOutputChars: 1_000, deadlineAt: null },
  });
}

function attemptRow(attemptId: string): { model: string | null; reasoning_effort: string | null; outcome: string | null } {
  return db.prepare(
    "SELECT model, reasoning_effort, outcome FROM model_work_attempts WHERE attempt_id = ?",
  ).get(attemptId) as { model: string | null; reasoning_effort: string | null; outcome: string | null };
}

describe("the attempt ledger records the selection", () => {
  it("writes the resolved selection at reservation", () => {
    writeModelSettings({ llm: { model: "gpt-6-astra", reasoning: "high" } });
    invalidateModelSettingsCache();
    const budget = newBudget();
    const reservation = reserveModelAttempt(db, {
      budgetId: budget.budgetId, stage: "fact_extract", inputChars: 10,
    });
    expect(attemptRow(reservation.attemptId)).toEqual({
      model: "gpt-6-astra",
      reasoning_effort: "high",
      outcome: null,
    });
  });

  it("prefers a per-call override over the resolved selection", () => {
    writeModelSettings({ llm: { model: "gpt-6-astra", reasoning: "high" } });
    invalidateModelSettingsCache();
    const budget = newBudget();
    const reservation = reserveModelAttempt(db, {
      budgetId: budget.budgetId,
      stage: "fact_extract",
      inputChars: 10,
      model: "eval-model",
      reasoningEffort: null,
    });
    expect(attemptRow(reservation.attemptId)).toEqual({
      model: "eval-model",
      reasoning_effort: null,
      outcome: null,
    });
  });

  it("overwrites with what the provider actually received at completion", () => {
    const budget = newBudget();
    const reservation = reserveModelAttempt(db, {
      budgetId: budget.budgetId, stage: "capsule", inputChars: 10,
    });
    finishModelAttempt(db, {
      attemptId: reservation.attemptId,
      state: "completed",
      model: "actually-sent",
      reasoningEffort: "medium",
    });
    expect(attemptRow(reservation.attemptId)).toEqual({
      model: "actually-sent",
      reasoning_effort: "medium",
      outcome: null,
    });
  });

  it("keeps the reservation's values when the completion observes nothing", () => {
    writeModelSettings({ llm: { model: "gpt-6-astra", reasoning: "low" } });
    invalidateModelSettingsCache();
    const budget = newBudget();
    const reservation = reserveModelAttempt(db, {
      budgetId: budget.budgetId, stage: "capsule", inputChars: 10,
    });
    // A provider stub that reports no selection must not erase what we know.
    finishModelAttempt(db, { attemptId: reservation.attemptId, state: "unknown" });
    expect(attemptRow(reservation.attemptId)).toEqual({
      model: "gpt-6-astra",
      reasoning_effort: "low",
      outcome: null,
    });
  });

  it("records an observed `no flag was sent` distinctly from `nothing observed`", () => {
    writeModelSettings({ llm: { reasoning: "high" } });
    invalidateModelSettingsCache();
    const budget = newBudget();
    const reservation = reserveModelAttempt(db, {
      budgetId: budget.budgetId, stage: "capsule", inputChars: 10,
    });
    finishModelAttempt(db, {
      attemptId: reservation.attemptId, state: "completed", reasoningEffort: null,
    });
    expect(attemptRow(reservation.attemptId).reasoning_effort).toBeNull();
  });
});

describe("diagnostics surface", () => {
  it("exposes the columns and prints them", () => {
    writeModelSettings({ llm: { model: "gpt-6-astra", reasoning: "xhigh" } });
    invalidateModelSettingsCache();
    const budget = newBudget();
    const reservation = reserveModelAttempt(db, {
      budgetId: budget.budgetId, stage: "fact_extract", inputChars: 10,
    });
    finishModelAttempt(db, { attemptId: reservation.attemptId, state: "completed" });

    const diagnostics = getModelWorkDiagnostics(db, { budgetId: budget.budgetId });
    expect(diagnostics.attempts[0].model).toBe("gpt-6-astra");
    expect(diagnostics.attempts[0].reasoningEffort).toBe("xhigh");
    expect(diagnostics.attempts[0].outcome).toBeNull();
    const text = formatModelWorkDiagnostics(diagnostics);
    expect(text).toContain("model=gpt-6-astra");
    expect(text).toContain("effort=xhigh");
    expect(text).toContain("config_rejected=0");
  });
});

describe("migration from a pre-0.7.0 database", () => {
  it("adds the three columns once and leaves existing rows NULL", () => {
    const legacy = path.join(root, "legacy.sqlite");
    const old = new Database(legacy);
    try {
      // The 0.6.x attempt ledger: no model / reasoning_effort / outcome.
      old.exec(`
        CREATE TABLE model_work_budgets (
          budget_id TEXT PRIMARY KEY, parent_wave_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'active',
          max_attempts INTEGER NOT NULL, reserved_attempts INTEGER NOT NULL DEFAULT 0,
          max_input_chars INTEGER NOT NULL, max_output_chars INTEGER NOT NULL,
          deadline_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(parent_wave_id)
        );
        CREATE TABLE model_work_attempts (
          attempt_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL, stage TEXT NOT NULL, job_id TEXT, target_id TEXT,
          state TEXT NOT NULL DEFAULT 'reserved', started_at TEXT NOT NULL,
          finished_at TEXT, duration_ms INTEGER, input_chars INTEGER, output_chars INTEGER,
          token_usage_json TEXT, token_usage_status TEXT, error_class TEXT, error_message TEXT
        );
        INSERT INTO model_work_budgets
          (budget_id, parent_wave_id, max_attempts, max_input_chars, max_output_chars,
           created_at, updated_at)
          VALUES ('b1', 'w1', 8, 100, 100, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
        INSERT INTO model_work_attempts
          (attempt_id, budget_id, attempt_no, stage, state, started_at)
          VALUES ('a1', 'b1', 1, 'fact_extract', 'completed', '2026-01-01T00:00:00Z');
      `);
      const columnCount = (name: string) =>
        (old.prepare("PRAGMA table_info(model_work_attempts)").all() as Array<{ name: string }>)
          .filter((row) => row.name === name).length;

      ensureModelBudgetSchema(old);
      for (const column of ["model", "reasoning_effort", "outcome"]) {
        expect(columnCount(column)).toBe(1);
      }
      // The historical row reads as "recorded before Memex could name its own
      // selection", not as a wrong one.
      expect(
        old.prepare("SELECT model, reasoning_effort, outcome FROM model_work_attempts WHERE attempt_id = 'a1'")
          .get(),
      ).toEqual({ model: null, reasoning_effort: null, outcome: null });

      // Idempotent.
      ensureModelBudgetSchema(old);
      for (const column of ["model", "reasoning_effort", "outcome"]) {
        expect(columnCount(column)).toBe(1);
      }
    } finally {
      old.close();
    }
  });
});
