import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureModelBudgetSchema,
  finishModelAttempt,
  getModelWorkDiagnostics,
  getModelWorkBudget,
  getOrCreateMaintenanceModelBudget,
  getOrCreateModelWorkBudget,
  ModelBudgetExhaustedError,
  reserveModelAttempt,
  startNewModelWorkRunForBudget,
} from "../src/model-budget.js";

describe("durable model work budget", () => {
  it("shares an atomic attempt cap across connections and keeps usage unknown honest", () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-model-budget-"));
    const dbPath = join(dir, "db.sqlite");
    const first = new Database(dbPath);
    const second = new Database(dbPath);
    ensureModelBudgetSchema(first);
    const budget = getOrCreateModelWorkBudget(first, {
      parentWaveId: "wave-test",
      limits: {
        maxAttempts: 2,
        maxInputChars: 100,
        maxOutputChars: 20,
        deadlineAt: null,
      },
    });
    try {
      const a = reserveModelAttempt(first, {
        budgetId: budget.budgetId,
        inputChars: 5,
        stage: "test",
      });
      finishModelAttempt(second, {
        attemptId: a.attemptId,
        state: "failed",
        tokenUsage: null,
        errorClass: "provider_failure",
        errorMessage: "secret prompt must not persist",
      });
      const b = reserveModelAttempt(second, {
        budgetId: budget.budgetId,
        inputChars: 5,
        stage: "test",
      });
      expect(() => reserveModelAttempt(first, {
        budgetId: budget.budgetId,
        inputChars: 5,
        stage: "test",
      })).toThrow(ModelBudgetExhaustedError);
      finishModelAttempt(first, {
        attemptId: b.attemptId,
        state: "completed",
        tokenUsage: { input_tokens: 3, output_tokens: 2 },
        outputChars: 4,
      });
      const diagnostics = getModelWorkDiagnostics(second, { budgetId: budget.budgetId });
      expect(diagnostics.budgets[0].reservedAttempts).toBe(2);
      expect(diagnostics.totals.failed).toBe(1);
      expect(diagnostics.totals.completed).toBe(1);
      expect(diagnostics.attempts[0].errorClass).toBe("provider_failure");
      expect(diagnostics.attempts[0].errorMessage).toBeNull();
      expect(diagnostics.attempts[1].tokenUsageStatus).toBe("partial");
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses the same parent wave on restart without resetting its cap", () => {
    const db = new Database(":memory:");
    ensureModelBudgetSchema(db);
    const first = getOrCreateModelWorkBudget(db, {
      parentWaveId: "restart-wave",
      limits: { maxAttempts: 3, deadlineAt: null },
    });
    reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1 });
    const resumed = getOrCreateModelWorkBudget(db, {
      parentWaveId: "restart-wave",
      limits: { maxAttempts: 99, deadlineAt: null },
    });
    expect(resumed.budgetId).toBe(first.budgetId);
    expect(resumed.reservedAttempts).toBe(1);
    expect(resumed.maxAttempts).toBe(3);
    db.close();
  });

  it("persists deadline exhaustion before rejecting a reservation", () => {
    const db = new Database(":memory:");
    ensureModelBudgetSchema(db);
    const now = new Date("2026-09-08T00:00:00.000Z");
    const budget = getOrCreateModelWorkBudget(db, {
      parentWaveId: "deadline-wave",
      limits: { maxAttempts: 3, deadlineAt: now.toISOString() },
    });

    expect(() => reserveModelAttempt(db, {
      budgetId: budget.budgetId,
      inputChars: 1,
      now,
    })).toThrow(ModelBudgetExhaustedError);
    expect(getModelWorkBudget(db, budget.budgetId)?.state).toBe("exhausted");
    db.close();
  });

  it("explicitly starts a fresh run and skips jobs with active leases", () => {
    const db = new Database(":memory:");
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
        last_error TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    ensureModelBudgetSchema(db);
    const oldBudget = getOrCreateModelWorkBudget(db, {
      parentWaveId: "old-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    reserveModelAttempt(db, { budgetId: oldBudget.budgetId, inputChars: 1 });
    const now = new Date("2026-09-08T00:00:00.000Z");
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, state, available_at, lease_until, updated_at, budget_id)
      VALUES (?, 'fact_extract', 'retry', ?, NULL, ?, ?),
             (?, 'fact_extract', 'pending', ?, ?, ?, ?)
    `).run(
      "job-ready", now.toISOString(), now.toISOString(), oldBudget.budgetId,
      "job-held", now.toISOString(), new Date(now.getTime() + 60_000).toISOString(), now.toISOString(), oldBudget.budgetId,
    );

    const result = startNewModelWorkRunForBudget(db, {
      budgetId: oldBudget.budgetId,
      now,
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    expect(result.budget.budgetId).not.toBe(oldBudget.budgetId);
    expect(result.reboundJobIds).toEqual(["job-ready"]);
    expect(result.skippedJobIds).toEqual(["job-held"]);
    expect(db.prepare("SELECT budget_id FROM memory_jobs WHERE job_id = 'job-ready'").get()).toMatchObject({
      budget_id: result.budget.budgetId,
    });
    expect(db.prepare("SELECT budget_id FROM memory_jobs WHERE job_id = 'job-held'").get()).toMatchObject({
      budget_id: oldBudget.budgetId,
    });
    db.close();
  });

  it("closes an idle maintenance wave and creates a new wave for later work", () => {
    const db = new Database(":memory:");
    ensureModelBudgetSchema(db);
    const first = getOrCreateMaintenanceModelBudget(db, {
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    const attempt = reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1 });
    finishModelAttempt(db, { attemptId: attempt.attemptId, state: "completed" });
    expect(first.state).toBe("active");

    const closed = getOrCreateMaintenanceModelBudget(db);
    expect(closed.budgetId).toBe(first.budgetId);
    expect(closed.state).toBe("completed");

    db.exec(`
      CREATE TABLE memory_jobs (
        job_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        available_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    ensureModelBudgetSchema(db);
    db.prepare(`
      INSERT INTO memory_jobs (job_id, state, available_at, updated_at)
      VALUES ('later-job', 'pending', datetime('now'), datetime('now'))
    `).run();
    const next = getOrCreateMaintenanceModelBudget(db, {
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    expect(next.budgetId).not.toBe(first.budgetId);
    expect(next.parentWaveId).toMatch(/^maintenance:run:/);
    expect(next.state).toBe("active");
    db.close();
  });
});
