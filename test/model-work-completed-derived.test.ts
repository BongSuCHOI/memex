import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  ensureModelBudgetSchema,
  getModelWorkTargets,
  getOrCreateModelWorkBudget,
  registerModelWorkTargets,
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

describe("model-work completed queue ownership", () => {
  it("moves unfinished derived targets from a completed extraction job", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "completed-derived-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    db.prepare(
      "UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?",
    ).run(old.budgetId);
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, state, target_id, available_at, updated_at, budget_id)
      VALUES ('completed-extraction', 'fact_extract', 'completed',
              'extraction-target', ?, ?, ?)
    `).run(
      "2026-09-08T00:00:00.000Z",
      "2026-09-08T00:00:00.000Z",
      old.budgetId,
    );
    registerModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "relation",
      targetIds: ["fact-derived-after-commit"],
      jobId: "completed-extraction",
    });

    const resumed = startNewModelWorkRunForBudget(db, {
      budgetId: old.budgetId,
      parentWaveId: "completed-derived-wave-2",
      limits: { maxAttempts: 1, deadlineAt: null },
    });

    expect(db.prepare(
      "SELECT budget_id, state FROM memory_jobs WHERE job_id = 'completed-extraction'",
    ).get()).toEqual({ budget_id: old.budgetId, state: "completed" });
    expect(getModelWorkTargets(db, { budgetId: old.budgetId })).toEqual([]);
    expect(getModelWorkTargets(db, { budgetId: resumed.budget.budgetId })).toMatchObject([{
      stage: "relation",
      targetId: "fact-derived-after-commit",
      jobId: "completed-extraction",
      state: "pending",
    }]);
    db.close();
  });
});
