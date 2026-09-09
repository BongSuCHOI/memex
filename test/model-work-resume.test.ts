import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  ensureModelBudgetSchema,
  finishModelAttempt,
  getModelWorkBudget,
  getModelWorkDiagnostics,
  getModelWorkTargets,
  getOrCreateModelWorkBudget,
  ModelBudgetExhaustedError,
  registerModelWorkTargets,
  reserveModelAttempt,
  settleModelWorkTargets,
  startNewModelWorkRunForBudget,
} from "../src/model-budget.js";

function memoryJobSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE memory_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      target_id TEXT,
      checkpoint_id TEXT,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      partition_key TEXT NOT NULL DEFAULT 'p',
      created_at TEXT NOT NULL DEFAULT '2026-09-08T00:00:00.000Z',
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function derivedFactSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL,
      ontology_category_id TEXT,
      needs_consolidation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

describe("model-work resume regressions", () => {
  it("keeps a running job's target affinity and old attempt ledger on operator resume", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const now = new Date("2026-09-08T00:00:00.000Z");
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "resume-running-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    const attempt = reserveModelAttempt(db, {
      budgetId: old.budgetId,
      inputChars: 7,
      stage: "ontology",
      targetId: "fact-running",
      jobId: "running-job",
    });
    finishModelAttempt(db, {
      attemptId: attempt.attemptId,
      state: "failed",
      errorClass: "provider_failure",
    });
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, state, target_id, available_at, lease_owner, lease_until,
         lease_generation, updated_at, budget_id)
      VALUES ('running-job', 'fact_extract', 'running', 'fact-running', ?,
              'worker', ?, 3, ?, ?)
    `).run(
      now.toISOString(),
      new Date(now.getTime() + 60_000).toISOString(),
      now.toISOString(),
      old.budgetId,
    );
    registerModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "ontology",
      targetIds: ["fact-running"],
      jobId: "running-job",
      now,
    });

    const resumed = startNewModelWorkRunForBudget(db, {
      budgetId: old.budgetId,
      parentWaveId: "resume-running-wave-2",
      limits: { maxAttempts: 2, deadlineAt: null },
      now,
    });

    expect(resumed.reboundJobIds).toEqual([]);
    expect(resumed.skippedJobIds).toEqual([]);
    expect(db.prepare(
      "SELECT budget_id, state FROM memory_jobs WHERE job_id = 'running-job'",
    ).get()).toEqual({ budget_id: old.budgetId, state: "running" });
    expect(getModelWorkTargets(db, { budgetId: old.budgetId })).toMatchObject([{
      stage: "ontology",
      targetId: "fact-running",
      jobId: "running-job",
      state: "pending",
    }]);
    expect(getModelWorkTargets(db, { budgetId: resumed.budget.budgetId })).toEqual([]);
    expect(getModelWorkDiagnostics(db, { budgetId: old.budgetId }).attempts.map((row) => row.attemptId))
      .toEqual([attempt.attemptId]);
    expect(getModelWorkBudget(db, old.budgetId)).toMatchObject({
      state: "exhausted",
      reservedAttempts: 1,
    });
    db.close();
  });

  it("keeps an unrelated dirty fact out of a filtered budget's pending diagnostics", () => {
    const db = new Database(":memory:");
    derivedFactSchema(db);
    ensureModelBudgetSchema(db);
    db.prepare(
      "INSERT INTO facts (id, is_active, ontology_category_id, needs_consolidation, updated_at) VALUES (?, 1, NULL, 0, ?), (?, 1, NULL, 0, ?)",
    ).run(
      "owned-fact",
      "2026-09-08T00:00:00.000Z",
      "unrelated-dirty-fact",
      "2026-09-08T00:00:01.000Z",
    );
    const budget = getOrCreateModelWorkBudget(db, {
      parentWaveId: "diagnostics-scope-wave",
      limits: { maxAttempts: 3, deadlineAt: null },
    });
    registerModelWorkTargets(db, {
      budgetId: budget.budgetId,
      stage: "ontology",
      targetIds: ["owned-fact"],
    });

    const diagnostics = getModelWorkDiagnostics(db, { budgetId: budget.budgetId });
    expect(diagnostics.pending).toMatchObject([{
      stage: "ontology",
      targetId: "owned-fact",
      state: "pending",
    }]);
    expect(diagnostics.pending.some((item) => item.targetId === "unrelated-dirty-fact")).toBe(false);
    expect(diagnostics.unassigned).toMatchObject([{
      stage: "ontology",
      targetId: "unrelated-dirty-fact",
      state: "pending",
    }]);
    expect(diagnostics.totals.pending).toBe(1);
    expect(diagnostics.totals.unassigned).toBe(1);
    db.close();
  });

  it("retains relation work after ontology consumes the exhausted cap and moves it on retry", () => {
    const db = new Database(":memory:");
    derivedFactSchema(db);
    ensureModelBudgetSchema(db);
    db.prepare(
      "INSERT INTO facts (id, is_active, ontology_category_id, needs_consolidation, updated_at) VALUES ('fact-relation', 1, 'category-1', 0, datetime('now'))",
    ).run();
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "relation-after-ontology-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    registerModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "ontology",
      targetIds: ["fact-relation"],
    });
    const ontologyAttempt = reserveModelAttempt(db, {
      budgetId: old.budgetId,
      inputChars: 3,
      stage: "ontology",
      targetId: "fact-relation",
    });
    finishModelAttempt(db, { attemptId: ontologyAttempt.attemptId, state: "completed" });
    settleModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "ontology",
      targetIds: ["fact-relation"],
      reason: "ontology_done",
    });
    registerModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "relation",
      targetIds: ["fact-relation"],
    });

    expect(() => reserveModelAttempt(db, {
      budgetId: old.budgetId,
      inputChars: 4,
      stage: "relation",
      targetId: "fact-relation",
    })).toThrow(ModelBudgetExhaustedError);
    expect(getModelWorkDiagnostics(db, { budgetId: old.budgetId }).pending).toMatchObject([{
      stage: "relation",
      targetId: "fact-relation",
      state: "pending",
    }]);

    const resumed = startNewModelWorkRunForBudget(db, {
      budgetId: old.budgetId,
      parentWaveId: "relation-after-ontology-wave-2",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    expect(getModelWorkTargets(db, { budgetId: old.budgetId })).toMatchObject([{
      stage: "ontology",
      targetId: "fact-relation",
      state: "completed",
    }]);
    expect(getModelWorkTargets(db, { budgetId: resumed.budget.budgetId })).toMatchObject([{
      stage: "relation",
      targetId: "fact-relation",
      state: "pending",
    }]);
    expect(getModelWorkDiagnostics(db, { budgetId: old.budgetId }).attempts.map((row) => row.attemptId))
      .toEqual([ontologyAttempt.attemptId]);
    db.close();
  });
});
