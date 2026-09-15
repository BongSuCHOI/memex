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
  rolloverSpentWaveBudgets,
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

  it("continues a spent continuity wave after its window and moves only its lease-free queued jobs (#140)", () => {
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
        hold_reason TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    ensureModelBudgetSchema(db);
    const now = new Date("2026-09-15T05:00:00.000Z");
    const past = new Date(now.getTime() - 60 * 60_000).toISOString();
    const future = new Date(now.getTime() + 60 * 60_000).toISOString();
    const wave = (parentWaveId: string, state: string, deadlineAt: string | null, automatic = 0) => {
      const budget = getOrCreateModelWorkBudget(db, { parentWaveId, limits: { maxAttempts: 3, deadlineAt } });
      db.prepare("UPDATE model_work_budgets SET state = ?, automatic = ? WHERE budget_id = ?")
        .run(state, automatic, budget.budgetId);
      return budget.budgetId;
    };
    const job = (id: string, budgetId: string, state: string, extra: { leaseUntil?: string; hold?: string; attempts?: number } = {}) => {
      db.prepare(`INSERT INTO memory_jobs (job_id, kind, state, available_at, lease_until, attempts, hold_reason, updated_at, budget_id)
        VALUES (?, 'capsule_update', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, state, past, extra.leaseUntil ?? null, extra.attempts ?? 0, extra.hold ?? null, past, budgetId);
    };
    const spent = wave("continuity:ws-1", "exhausted", past);
    job("ws1-retry", spent, "retry", { attempts: 1 });
    job("ws1-held", spent, "pending", { hold: "model_config_rejected" });
    job("ws1-done", spent, "completed");
    const leased = wave("continuity:ws-2", "exhausted", past);
    job("ws2-retry", leased, "retry");
    job("ws2-running", leased, "running", { leaseUntil: future });
    const open = wave("continuity:ws-3", "exhausted", future);
    job("ws3-retry", open, "retry");
    const manual = wave("manual-run", "exhausted", past);
    job("manual-retry", manual, "retry");
    const auto = wave("maintenance", "exhausted", past, 1);
    job("auto-retry", auto, "retry");
    const cancelled = wave("continuity:ws-4", "cancelled", past);
    job("ws4-retry", cancelled, "retry");

    const rolled = rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } });
    expect(rolled).toHaveLength(1);
    expect(rolled[0]).toMatchObject({ budgetId: spent, reboundJobIds: ["ws1-retry"] });
    expect(rolled[0].parentWaveId).toBe("continuity:ws-1#2");
    const next = getModelWorkBudget(db, rolled[0].nextBudgetId)!;
    expect(next).toMatchObject({ state: "active", rootWaveId: "continuity:ws-1", runSeq: 2, automatic: false });
    const row = (id: string) => db.prepare("SELECT state, budget_id, attempts, available_at, maintenance_wave_id FROM memory_jobs WHERE job_id = ?").get(id) as Record<string, unknown>;
    expect(row("ws1-retry")).toMatchObject({
      state: "pending", budget_id: next.budgetId, attempts: 1, available_at: now.toISOString(), maintenance_wave_id: "continuity:ws-1#2",
    });
    for (const untouched of ["ws1-held", "ws1-done", "ws2-retry", "ws2-running", "ws3-retry", "manual-retry", "auto-retry", "ws4-retry"]) {
      expect(row(untouched).budget_id, untouched).not.toBe(next.budgetId);
    }
    expect(row("ws1-held")).toMatchObject({ state: "pending", budget_id: spent });
    expect(row("ws2-retry")).toMatchObject({ state: "retry", budget_id: leased });
    // Idempotent: nothing movable is left on the spent budget.
    expect(rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } })).toEqual([]);
    // A hold released after the wave moved on joins the current run; no third run is opened.
    db.prepare("UPDATE memory_jobs SET hold_reason = NULL WHERE job_id = 'ws1-held'").run();
    const later = rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } });
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ budgetId: spent, nextBudgetId: next.budgetId, reboundJobIds: ["ws1-held"] });
    expect(row("ws1-held")).toMatchObject({ state: "pending", budget_id: next.budgetId });
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets WHERE root_wave_id = 'continuity:ws-1'").get()).toEqual({ n: 2 });
    // The current run is spent but its window is still open: a job surfacing on
    // the old run waits for that window instead of opening a third run.
    job("ws1-late", spent, "retry");
    db.prepare("UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?").run(next.budgetId);
    expect(rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } })).toEqual([]);
    expect(row("ws1-late")).toMatchObject({ state: "retry", budget_id: spent });
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets WHERE root_wave_id = 'continuity:ws-1'").get()).toEqual({ n: 2 });
    // Once that window has passed, exactly one next run opens and every job
    // still parked on either spent run joins it.
    db.prepare("UPDATE model_work_budgets SET deadline_at = ? WHERE budget_id = ?").run(past, next.budgetId);
    const third = rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } });
    expect(third.flatMap((entry) => entry.reboundJobIds).sort()).toEqual(["ws1-held", "ws1-late", "ws1-retry"]);
    expect(new Set(third.map((entry) => entry.nextBudgetId)).size).toBe(1);
    expect(getModelWorkBudget(db, third[0].nextBudgetId)).toMatchObject({ runSeq: 3, state: "active" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets WHERE root_wave_id = 'continuity:ws-1'").get()).toEqual({ n: 3 });
    // A latest run without a deadline is an indefinite window: joined while active.
    db.prepare("UPDATE model_work_budgets SET deadline_at = NULL WHERE budget_id = ?").run(third[0].nextBudgetId);
    job("ws1-open", spent, "retry");
    const joined = rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } });
    expect(joined.map((entry) => [entry.nextBudgetId, entry.reboundJobIds])).toEqual([[third[0].nextBudgetId, ["ws1-open"]]]);
    // …and waited for while spent, however long that is.
    db.prepare("UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?").run(third[0].nextBudgetId);
    job("ws1-wait", spent, "retry");
    expect(rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets WHERE root_wave_id = 'continuity:ws-1'").get()).toEqual({ n: 3 });
    db.prepare("DELETE FROM memory_jobs WHERE job_id = 'ws1-wait'").run();
    // An operator cancelled the current run: the wave stays closed, whatever the window says.
    db.prepare("UPDATE model_work_budgets SET state = 'cancelled', deadline_at = ? WHERE budget_id = ?").run(past, third[0].nextBudgetId);
    job("ws1-after-cancel", spent, "retry");
    expect(rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: future } })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets WHERE root_wave_id = 'continuity:ws-1'").get()).toEqual({ n: 3 });
    db.prepare("DELETE FROM memory_jobs WHERE job_id = 'ws1-after-cancel'").run();
    db.prepare("UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?").run(third[0].nextBudgetId);
    // An absolute deadline already in the past would open a run spent at birth: refused.
    job("ws1-last", spent, "retry");
    db.prepare("UPDATE model_work_budgets SET deadline_at = ? WHERE budget_id = ?").run(past, third[0].nextBudgetId);
    expect(rolloverSpentWaveBudgets(db, { now, limits: { maxAttempts: 3, deadlineAt: past } })).toEqual([]);
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
    // Issue #42: rollover is a bounded run number, not an appended uuid.
    expect(next.parentWaveId).toBe("maintenance#2");
    expect(next.rootWaveId).toBe("maintenance");
    expect(next.runSeq).toBe(2);
    expect(next.state).toBe("active");
    db.close();
  });
});
