import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  AUTOMATIC_MAINTENANCE_COOLDOWN_MS as HOUR,
  AUTOMATIC_MAINTENANCE_WINDOW_MS as DAY,
  automaticMaintenanceWindow,
  ensureModelBudgetSchema,
  finishModelAttempt,
  getModelWorkTargets,
  getModelWorkDiagnostics,
  getOrCreateAutomaticMaintenanceModelBudget as maintain,
  getOrCreateMaintenanceModelBudget,
  registerModelWorkTargets,
  reserveModelAttempt,
  settleModelWorkTargets,
} from "../src/model-budget.js";

const start = new Date("2026-09-09T00:00:00.000Z");
const at = (offset: number) => new Date(start.getTime() + offset);
const limits = { maxAttempts: 1, deadlineAt: null };

function setup(path = ":memory:") {
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1,
      ontology_category_id TEXT, needs_consolidation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory_jobs (
      job_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'fact_extract',
      state TEXT NOT NULL, target_id TEXT, checkpoint_id TEXT,
      available_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL
    );
  `);
  ensureModelBudgetSchema(db);
  return db;
}

function spend(db: Database.Database, budgetId: string, now = start) {
  const attempt = reserveModelAttempt(db, { budgetId, inputChars: 1, now });
  finishModelAttempt(db, { attemptId: attempt.attemptId, state: "completed", finishedAt: now.toISOString() });
  return attempt;
}

afterEach(() => vi.unstubAllEnvs());

describe("bounded automatic maintenance continuation", () => {
  it("migrates an old ledger idempotently and restores its real database backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-auto-migration-"));
    const db = setup(join(dir, "current.sqlite"));
    try {
      const old = getOrCreateMaintenanceModelBudget(db, { limits });
      spend(db, old.budgetId);
      db.exec("ALTER TABLE model_work_budgets DROP COLUMN automatic");
      const snapshot = join(dir, "backup.sqlite");
      await db.backup(snapshot);
      expect(getModelWorkDiagnostics(db).automaticMaintenance).toBeUndefined();
      ensureModelBudgetSchema(db);
      ensureModelBudgetSchema(db);
      expect(db.prepare("SELECT automatic,reserved_attempts FROM model_work_budgets").get())
        .toEqual({ automatic: 0, reserved_attempts: 1 });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      const backup = new Database(snapshot, { readonly: true });
      try {
        await backup.backup(join(dir, "restored.sqlite"));
      } finally { backup.close(); }
      const restored = new Database(join(dir, "restored.sqlite"));
      try {
        expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(restored.pragma("foreign_key_check")).toEqual([]);
        expect(restored.prepare("SELECT reserved_attempts FROM model_work_budgets").get()).toEqual({ reserved_attempts: 1 });
        expect((restored.pragma("table_info(model_work_budgets)") as Array<{ name: string }>).some(c => c.name === "automatic")).toBe(false);
      } finally { restored.close(); }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("resumes pending targets after cooldown without replaying completed targets or refunding attempts", () => {
    const db = setup();
    try {
      db.exec("INSERT INTO facts(id) VALUES ('pending'),('done')");
      const first = maintain(db, { now: start, limits });
      registerModelWorkTargets(db, { budgetId: first.budgetId, stage: "ontology", targetIds: ["pending", "done"] });
      settleModelWorkTargets(db, { budgetId: first.budgetId, stage: "ontology", targetIds: ["done"], state: "completed" });
      db.exec("UPDATE facts SET ontology_category_id = 'category' WHERE id = 'done'");
      spend(db, first.budgetId);
      expect(maintain(db, { now: at(HOUR - 1), limits }).budgetId).toBe(first.budgetId);
      const next = maintain(db, { now: at(HOUR), limits });
      expect(next.budgetId).not.toBe(first.budgetId);
      expect(next).toMatchObject({ state: "active", reservedAttempts: 0, automatic: true });
      expect(getModelWorkTargets(db, { budgetId: next.budgetId }).map(t => t.targetId)).toEqual(["pending"]);
      expect(db.prepare("SELECT reserved_attempts FROM model_work_budgets WHERE budget_id = ?").get(first.budgetId)).toEqual({ reserved_attempts: 1 });
      expect(maintain(db, { now: at(HOUR), limits }).budgetId).toBe(next.budgetId);
    } finally { db.close(); }
  });

  it("shares the rolling attempt cap across wave names and checks it at each reservation", () => {
    vi.stubEnv("MEMEX_AUTO_MODEL_MAX_ATTEMPTS", "2");
    const db = setup();
    try {
      db.exec("INSERT INTO facts(id) VALUES ('pending')");
      const first = maintain(db, { now: start, limits: { maxAttempts: 10, deadlineAt: null } });
      const sibling = maintain(db, { parentWaveId: "other", now: start, limits: { maxAttempts: 10, deadlineAt: null } });
      spend(db, first.budgetId);
      spend(db, sibling.budgetId);
      expect(() => spend(db, first.budgetId)).toThrow(/window/);
      expect(automaticMaintenanceWindow(db, start)).toMatchObject({ used: 2, remaining: 0, retryAt: at(DAY).toISOString() });
      expect(maintain(db, { now: at(HOUR), limits }).state).toBe("exhausted");
      expect(() => spend(db, first.budgetId, at(DAY))).toThrow(/budget exhausted/);
      const next = maintain(db, { now: at(DAY), limits });
      expect(next.budgetId).not.toBe(first.budgetId);
      spend(db, next.budgetId, at(DAY));
      expect(automaticMaintenanceWindow(db, at(DAY)).used).toBe(1);
    } finally { db.close(); }
  });

  it("does not refund the shared cap on completed waves or restart", () => {
    vi.stubEnv("MEMEX_AUTO_MODEL_MAX_ATTEMPTS", "1");
    const db = setup();
    try {
      const first = maintain(db, { now: start, limits });
      spend(db, first.budgetId);
      expect(maintain(db, { now: at(HOUR), limits }).state).toBe("completed");
      db.exec("INSERT INTO facts(id) VALUES ('new')");
      expect(maintain(db, { now: at(HOUR + 1), limits }).budgetId).toBe(first.budgetId);
      expect(automaticMaintenanceWindow(db, at(HOUR)).remaining).toBe(0);
    } finally { db.close(); }
  });

  it("preserves retry counts and future backoff, and leaves permanent failures alone", () => {
    const db = setup();
    try {
      const first = maintain(db, { now: start, limits });
      const insert = db.prepare(`INSERT INTO memory_jobs(job_id,state,attempts,available_at,updated_at,budget_id,last_error)
        VALUES (?, ?, 2, ?, ?, ?, ?)`);
      insert.run("retry", "retry", at(2 * HOUR).toISOString(), start.toISOString(), first.budgetId, "model work budget exhausted: attempts");
      insert.run("failed", "dead", start.toISOString(), start.toISOString(), first.budgetId, "permanent source failure");
      spend(db, first.budgetId);
      const next = maintain(db, { now: at(HOUR), limits });
      expect(db.prepare("SELECT budget_id,attempts,available_at FROM memory_jobs WHERE job_id='retry'").get())
        .toEqual({ budget_id: next.budgetId, attempts: 2, available_at: at(2 * HOUR).toISOString() });
      expect(db.prepare("SELECT budget_id,state,attempts FROM memory_jobs WHERE job_id='failed'").get())
        .toEqual({ budget_id: first.budgetId, state: "dead", attempts: 2 });
    } finally { db.close(); }
  });

  it("waits for active leases and reclaims expired jobs without resetting attempts", () => {
    const db = setup();
    try {
      const first = maintain(db, { now: start, limits });
      db.prepare(`INSERT INTO memory_jobs(job_id,state,attempts,available_at,updated_at,budget_id,lease_until)
        VALUES ('held','running',2,?,?,?,?)`).run(start.toISOString(), start.toISOString(), first.budgetId, at(HOUR + 1).toISOString());
      spend(db, first.budgetId);
      expect(maintain(db, { now: at(HOUR), limits }).budgetId).toBe(first.budgetId);
      const next = maintain(db, { now: at(HOUR + 1), limits });
      expect(db.prepare("SELECT budget_id,state,attempts FROM memory_jobs").get())
        .toEqual({ budget_id: next.budgetId, state: "pending", attempts: 2 });
    } finally { db.close(); }
  });

  it("detects expired active deadlines and retains crashed reservations as unknown", () => {
    const db = setup();
    try {
      db.exec("INSERT INTO facts(id) VALUES ('pending')");
      const first = maintain(db, { now: start, limits: { maxAttempts: 2, deadlineAt: at(15 * 60_000).toISOString() } });
      reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1, now: start });
      expect(maintain(db, { now: at(15 * 60_000), limits }).budgetId).toBe(first.budgetId);
      const next = maintain(db, { now: at(HOUR) });
      expect(next.budgetId).not.toBe(first.budgetId);
      expect(next.deadlineAt).toBe(at(HOUR + 15 * 60_000).toISOString());
      expect(db.prepare("SELECT state,token_usage_status FROM model_work_attempts").get())
        .toEqual({ state: "unknown", token_usage_status: "NOT_PROVEN" });
    } finally { db.close(); }
  });

  it("never automatically resumes operator cancellation", () => {
    const db = setup();
    try {
      db.exec("INSERT INTO facts(id) VALUES ('pending')");
      const first = maintain(db, { now: start, limits });
      db.prepare("UPDATE model_work_budgets SET state='cancelled' WHERE budget_id=?").run(first.budgetId);
      expect(maintain(db, { now: at(2 * DAY), limits })).toMatchObject({ budgetId: first.budgetId, state: "cancelled" });
    } finally { db.close(); }
  });

  it("rolls back budget creation and all target moves together on a rebind error", () => {
    const db = setup();
    try {
      db.exec("INSERT INTO facts(id) VALUES ('pending')");
      const first = maintain(db, { now: start, limits });
      registerModelWorkTargets(db, { budgetId: first.budgetId, stage: "ontology", targetIds: ["pending"] });
      spend(db, first.budgetId);
      db.exec("CREATE TRIGGER fail_move BEFORE INSERT ON model_work_targets BEGIN SELECT RAISE(ABORT,'injected failure'); END");
      expect(() => maintain(db, { now: at(HOUR), limits })).toThrow("injected failure");
      expect(db.prepare("SELECT COUNT(*) n FROM model_work_budgets").get()).toEqual({ n: 1 });
      expect(getModelWorkTargets(db, { budgetId: first.budgetId })[0].state).toBe("pending");
    } finally { db.close(); }
  });

  it("adopts legacy maintenance attempts without discarding their cap", () => {
    vi.stubEnv("MEMEX_AUTO_MODEL_MAX_ATTEMPTS", "1");
    const db = setup();
    try {
      const legacy = getOrCreateMaintenanceModelBudget(db, { limits });
      spend(db, legacy.budgetId);
      db.exec("INSERT INTO facts(id) VALUES ('pending')");
      expect(maintain(db, { now: at(HOUR), limits }).budgetId).toBe(legacy.budgetId);
      expect(automaticMaintenanceWindow(db, at(HOUR)).remaining).toBe(0);
    } finally { db.close(); }
  });

  it("reuses one rollover across database connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-auto-resume-"));
    const first = setup(join(dir, "db.sqlite"));
    const second = new Database(join(dir, "db.sqlite"));
    try {
      first.exec("INSERT INTO facts(id) VALUES ('pending')");
      const old = maintain(first, { now: start, limits });
      spend(first, old.budgetId);
      const next = maintain(first, { now: at(HOUR), limits });
      expect(maintain(second, { now: at(HOUR), limits }).budgetId).toBe(next.budgetId);
      expect(second.prepare("SELECT COUNT(*) n FROM model_work_budgets").get()).toEqual({ n: 2 });
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("two actual processes share one rollover and cannot both spend its last attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-auto-process-"));
    const dbPath = join(dir, "db.sqlite");
    const db = setup(dbPath);
    try {
      db.exec("INSERT INTO facts(id) VALUES ('pending')");
      const old = maintain(db, { now: start, limits });
      spend(db, old.budgetId);
      const source = pathToFileURL(join(process.cwd(), "src/model-budget.ts")).href;
      const script = `
        import Database from 'better-sqlite3';
        import { getOrCreateAutomaticMaintenanceModelBudget, reserveModelAttempt, finishModelAttempt } from ${JSON.stringify(source)};
        const db = new Database(${JSON.stringify(dbPath)});
        db.pragma('busy_timeout=5000');
        const now = new Date(${JSON.stringify(at(HOUR).toISOString())});
        const b = getOrCreateAutomaticMaintenanceModelBudget(db,{ now, limits:{ maxAttempts:1, deadlineAt:null } });
        let spent = false;
        try {
          const a = reserveModelAttempt(db,{budgetId:b.budgetId,inputChars:1,now});
          finishModelAttempt(db,{attemptId:a.attemptId,state:'completed',finishedAt:now.toISOString()});
          spent = true;
        } catch (e) { if(e.code !== 'MEMEX_MODEL_BUDGET') throw e; }
        console.log(JSON.stringify({ budgetId:b.budgetId,spent })); db.close();
      `;
      const results = await Promise.all([0, 1].map(() => promisify(execFile)(
        process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
        { timeout: 20_000 },
      )));
      const outputs = results.map(r => JSON.parse(r.stdout));
      expect(new Set(outputs.map(r => r.budgetId)).size).toBe(1);
      expect(outputs.filter(r => r.spent).length).toBe(1);
      expect(db.prepare("SELECT COUNT(*) n FROM model_work_budgets").get()).toEqual({ n: 2 });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
