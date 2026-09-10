import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  automaticMaintenanceWindow,
  ensureModelBudgetSchema,
  finishModelAttempt,
  getModelWorkBudget,
  getModelWorkDiagnostics,
  getOrCreateModelWorkBudget,
  ModelBudgetExhaustedError,
  reserveModelAttempt,
  settleConfigRejectedAttempt,
} from "../src/model-budget.js";

/**
 * A wrong model setting must cost ZERO budget (E3/H1).
 *
 * That is four things at once, and the last is the one two review rounds got
 * wrong: refunding the reservation number alone does NOT unblock a budget,
 * because `reserveModelAttempt` marks it `exhausted` when it hands out the last
 * attempt and `budgetExhaustion` treats that state as sticky.
 *
 * The release condition also cannot key on the refunded row's own `attempt_no`.
 * With `max_attempts=2`: A reserves #1, B reserves #2 (now exhausted), B
 * COMPLETES, A is rejected. The reservation that caused exhaustion was B's; the
 * one being refunded is A's. The measured result of the `attempt_no` rule was
 * `('exhausted', 1, 2)` — a budget permanently fenced by a setting the user had
 * already fixed. Test 'concurrent reservation, reverse completion' is the
 * regression line for exactly that.
 */

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-config-budget-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  db = new Database(process.env.MEMEX_DB_PATH);
  ensureModelBudgetSchema(db);
});

afterEach(() => {
  if (db.open) db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_AUTO_MODEL_MAX_ATTEMPTS;
  fs.rmSync(root, { recursive: true, force: true });
});

function budget(options: { maxAttempts: number; deadlineAt?: string | null; wave?: string }) {
  return getOrCreateModelWorkBudget(db, {
    parentWaveId: options.wave ?? "wave-config",
    limits: {
      maxAttempts: options.maxAttempts,
      maxInputChars: 1_000,
      maxOutputChars: 1_000,
      deadlineAt: options.deadlineAt ?? null,
    },
  });
}

function budgetRow(budgetId: string): { state: string; reserved_attempts: number } {
  return db.prepare(
    "SELECT state, reserved_attempts FROM model_work_budgets WHERE budget_id = ?",
  ).get(budgetId) as { state: string; reserved_attempts: number };
}

describe("settleConfigRejectedAttempt", () => {
  it("keeps the attempt as evidence, refunds the reservation and lifts exhaustion", () => {
    const b = budget({ maxAttempts: 1 });
    const reservation = reserveModelAttempt(db, {
      budgetId: b.budgetId, stage: "fact_extract", inputChars: 10,
    });
    // The single attempt exhausted the budget on reservation.
    expect(budgetRow(b.budgetId)).toEqual({ state: "exhausted", reserved_attempts: 1 });

    expect(settleConfigRejectedAttempt(db, { attemptId: reservation.attemptId })).toBe(true);

    expect(budgetRow(b.budgetId)).toEqual({ state: "active", reserved_attempts: 0 });
    const attempt = db.prepare(
      "SELECT state, outcome, error_class FROM model_work_attempts WHERE attempt_id = ?",
    ).get(reservation.attemptId) as { state: string; outcome: string; error_class: string };
    // The row survives — the evidence that a call was refused — but it is out
    // of the accounting.
    expect(attempt).toEqual({
      state: "failed",
      outcome: "config_rejected",
      error_class: "CodexRequestRejectedError",
    });

    // And the budget really is usable again once the setting is fixed.
    expect(() =>
      reserveModelAttempt(db, { budgetId: b.budgetId, stage: "fact_extract", inputChars: 10 }),
    ).not.toThrow();
  });

  it("★ concurrent reservation, reverse completion: A#1 rejected after B#2 completed", () => {
    const b = budget({ maxAttempts: 2 });
    const a = reserveModelAttempt(db, { budgetId: b.budgetId, stage: "fact_extract", inputChars: 10 });
    const second = reserveModelAttempt(db, { budgetId: b.budgetId, stage: "capsule", inputChars: 10 });
    expect(budgetRow(b.budgetId)).toEqual({ state: "exhausted", reserved_attempts: 2 });

    // B finishes normally; A's envelope is then refused.
    finishModelAttempt(db, { attemptId: second.attemptId, state: "completed", outputChars: 4 });
    expect(settleConfigRejectedAttempt(db, { attemptId: a.attemptId })).toBe(true);

    // Effective usage is 1 (B's row only), reserved is 1 → active.
    // The `attempt_no >= max_attempts` rule produced ('exhausted', 1, 2) here.
    expect(budgetRow(b.budgetId)).toEqual({ state: "active", reserved_attempts: 1 });
    const effectiveUsed = db.prepare(`
      SELECT COUNT(*) AS n FROM model_work_attempts
      WHERE budget_id = ? AND COALESCE(outcome,'') NOT IN ('config_rejected')
    `).get(b.budgetId) as { n: number };
    expect(effectiveUsed.n).toBe(1);
  });

  it("does not revive a deadline exhaustion", () => {
    const b = budget({ maxAttempts: 4, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    const reservation = reserveModelAttempt(db, {
      budgetId: b.budgetId, stage: "fact_extract", inputChars: 10,
    });
    // The deadline passes, then the budget is fenced by it.
    db.prepare(
      "UPDATE model_work_budgets SET deadline_at = ?, state = 'exhausted' WHERE budget_id = ?",
    ).run(new Date(Date.now() - 60_000).toISOString(), b.budgetId);

    expect(settleConfigRejectedAttempt(db, { attemptId: reservation.attemptId })).toBe(true);
    expect(budgetRow(b.budgetId).state).toBe("exhausted");
  });

  it("does not revive a cancelled budget", () => {
    const b = budget({ maxAttempts: 4 });
    const reservation = reserveModelAttempt(db, {
      budgetId: b.budgetId, stage: "fact_extract", inputChars: 10,
    });
    db.prepare("UPDATE model_work_budgets SET state = 'cancelled' WHERE budget_id = ?").run(b.budgetId);

    expect(settleConfigRejectedAttempt(db, { attemptId: reservation.attemptId })).toBe(true);
    expect(budgetRow(b.budgetId).state).toBe("cancelled");
  });

  it("is idempotent — a second call cannot refund twice", () => {
    const b = budget({ maxAttempts: 3 });
    const reservation = reserveModelAttempt(db, {
      budgetId: b.budgetId, stage: "fact_extract", inputChars: 10,
    });
    expect(settleConfigRejectedAttempt(db, { attemptId: reservation.attemptId })).toBe(true);
    expect(budgetRow(b.budgetId).reserved_attempts).toBe(0);
    expect(settleConfigRejectedAttempt(db, { attemptId: reservation.attemptId })).toBe(false);
    expect(budgetRow(b.budgetId).reserved_attempts).toBe(0);
  });

  it("refuses an attempt that already finished normally", () => {
    const b = budget({ maxAttempts: 3 });
    const reservation = reserveModelAttempt(db, {
      budgetId: b.budgetId, stage: "fact_extract", inputChars: 10,
    });
    finishModelAttempt(db, { attemptId: reservation.attemptId, state: "completed" });
    expect(settleConfigRejectedAttempt(db, { attemptId: reservation.attemptId })).toBe(false);
    expect(budgetRow(b.budgetId).reserved_attempts).toBe(1);
  });
});

describe("the 24h automatic-maintenance window", () => {
  function automaticBudget(wave: string) {
    const b = getOrCreateModelWorkBudget(db, {
      parentWaveId: wave,
      limits: { maxAttempts: 8, maxInputChars: 1_000, maxOutputChars: 1_000, deadlineAt: null },
    });
    db.prepare("UPDATE model_work_budgets SET automatic = 1 WHERE budget_id = ?").run(b.budgetId);
    return b;
  }

  it("does not count a refused envelope against the rolling cap", () => {
    const b = automaticBudget("auto-wave");
    const first = reserveModelAttempt(db, { budgetId: b.budgetId, stage: "ontology", inputChars: 5 });
    finishModelAttempt(db, { attemptId: first.attemptId, state: "completed" });
    const rejected = reserveModelAttempt(db, { budgetId: b.budgetId, stage: "ontology", inputChars: 5 });

    expect(automaticMaintenanceWindow(db).used).toBe(2);
    settleConfigRejectedAttempt(db, { attemptId: rejected.attemptId });
    // Without this exclusion a wrong setting eats the daily cap, and automatic
    // maintenance stays blocked even after the setting is corrected.
    expect(automaticMaintenanceWindow(db).used).toBe(1);
  });

  it("stays blocked when the window is genuinely full, even after a release", () => {
    process.env.MEMEX_AUTO_MODEL_MAX_ATTEMPTS = "2";
    const b = automaticBudget("auto-wave-full");
    // The rejection happens first, then two real calls fill the daily cap.
    const rejected = reserveModelAttempt(db, {
      budgetId: b.budgetId, stage: "ontology", inputChars: 5,
    });
    settleConfigRejectedAttempt(db, { attemptId: rejected.attemptId });
    for (let i = 0; i < 2; i++) {
      const reservation = reserveModelAttempt(db, {
        budgetId: b.budgetId, stage: "ontology", inputChars: 5,
      });
      finishModelAttempt(db, { attemptId: reservation.attemptId, state: "completed" });
    }

    // The release returned the BUDGET's own cap, not the shared rolling window:
    // 3 ledger rows, 2 of which count, and the cap is 2.
    expect(automaticMaintenanceWindow(db).used).toBe(2);
    expect(automaticMaintenanceWindow(db).remaining).toBe(0);
    expect(() =>
      reserveModelAttempt(db, { budgetId: b.budgetId, stage: "ontology", inputChars: 5 }),
    ).toThrow(ModelBudgetExhaustedError);
  });
});

describe("diagnostics", () => {
  it("reports config rejections in their own bucket, out of `failed`", () => {
    const b = budget({ maxAttempts: 4 });
    const ok = reserveModelAttempt(db, { budgetId: b.budgetId, stage: "fact_extract", inputChars: 5 });
    finishModelAttempt(db, { attemptId: ok.attemptId, state: "completed" });
    const broken = reserveModelAttempt(db, { budgetId: b.budgetId, stage: "fact_extract", inputChars: 5 });
    finishModelAttempt(db, { attemptId: broken.attemptId, state: "failed", errorClass: "Boom" });
    const rejected = reserveModelAttempt(db, { budgetId: b.budgetId, stage: "fact_extract", inputChars: 5 });
    settleConfigRejectedAttempt(db, { attemptId: rejected.attemptId });

    const diagnostics = getModelWorkDiagnostics(db, { budgetId: b.budgetId });
    expect(diagnostics.totals.completed).toBe(1);
    // A refused envelope is `state='failed'` in the ledger, but reporting it as
    // a failed model call is what made "the budget is burning" and "the setting
    // is wrong" look identical.
    expect(diagnostics.totals.failed).toBe(1);
    expect(diagnostics.totals.configRejected).toBe(1);
    const stage = diagnostics.stages.find((entry) => entry.stage === "fact_extract")!;
    expect(stage.failed).toBe(1);
    expect(stage.configRejected).toBe(1);
  });

  it("survives a budget with no rows at all", () => {
    const b = budget({ maxAttempts: 1 });
    expect(getModelWorkDiagnostics(db, { budgetId: b.budgetId }).totals.configRejected).toBe(0);
    expect(getModelWorkBudget(db, b.budgetId)?.state).toBe("active");
  });
});
