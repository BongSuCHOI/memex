import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  deferMemoryJobForModelBudget,
  ensureModelBudgetSchema,
  finishModelAttempt,
  getModelWorkContext,
  getModelWorkBudget,
  getOrCreateMaintenanceModelBudget,
  getOrCreateModelWorkBudget,
  getModelWorkDiagnostics,
  getModelWorkTargets,
  ModelBudgetExhaustedError,
  ModelBudgetOutputLimitError,
  registerModelWorkTargets,
  reserveModelAttempt,
  startNewModelWorkRunForJob,
  startNewModelWorkRunForBudget,
  withResolvedModelWorkContext,
} from "../src/model-budget.js";
import { runCodex } from "../src/codex-exec.js";
import { callMemoryModel } from "../src/llm.js";

function tempDir(prefix = "memex-model-work-lifecycle-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
    CREATE TABLE extraction_targets (
      target_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE extraction_target_items (
      target_id TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE checkpoints (checkpoint_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE capsule_checkpoint_state (
      checkpoint_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function fakeCodex(dir: string, source: string): string {
  const bin = path.join(dir, "fake-codex");
  fs.writeFileSync(bin, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return bin;
}

describe("model-work lifecycle boundaries", () => {
  it("keeps the attempt cap after a real process restart", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "budget.sqlite");
    const db = new Database(dbPath);
    ensureModelBudgetSchema(db);
    const budget = getOrCreateModelWorkBudget(db, {
      parentWaveId: "restart-process-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    db.close();

    const script = `
      import Database from 'better-sqlite3';
      const mod = await import(${JSON.stringify(path.resolve("dist/model-budget.js"))});
      const db = new Database(${JSON.stringify(dbPath)});
      mod.ensureModelBudgetSchema(db);
      mod.reserveModelAttempt(db, { budgetId: ${JSON.stringify(budget.budgetId)}, inputChars: 1, stage: 'restart' });
      db.close();
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(0);

    const resumed = new Database(dbPath);
    expect(getModelWorkBudget(resumed, budget.budgetId)).toMatchObject({
      reservedAttempts: 1,
      state: "exhausted",
    });
    expect(() => reserveModelAttempt(resumed, {
      budgetId: budget.budgetId,
      inputChars: 1,
      stage: "after-restart",
    })).toThrow(ModelBudgetExhaustedError);
    resumed.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts real provider retries against one shared durable cap", async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "retry.sqlite");
    const callsPath = path.join(dir, "provider-calls");
    const db = new Database(dbPath);
    ensureModelBudgetSchema(db);
    const budget = getOrCreateModelWorkBudget(db, {
      parentWaveId: "retry-cap-wave",
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    const bin = fakeCodex(dir, `
      import fs from 'node:fs';
      fs.readFileSync(0, 'utf8');
      fs.appendFileSync(${JSON.stringify(callsPath)}, 'call\\n');
      console.error('provider failure'); process.exit(7);
    `);
    const saved = {
      bin: process.env.MEMEX_CODEX_BIN,
      retries: process.env.MEMEX_LLM_RETRIES,
      backoff: process.env.MEMEX_LLM_RETRY_BASE_MS,
    };
    process.env.MEMEX_CODEX_BIN = bin;
    process.env.MEMEX_LLM_RETRIES = "2";
    process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
    try {
      await expect(callMemoryModel("system", "user", 100, {
        modelContext: { db, budgetId: budget.budgetId, stage: "retry" },
      })).rejects.toThrow(ModelBudgetExhaustedError);
      expect(fs.readFileSync(callsPath, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
      expect(getModelWorkBudget(db, budget.budgetId)).toMatchObject({
        reservedAttempts: 2,
        state: "exhausted",
      });
      expect(getModelWorkDiagnostics(db, { budgetId: budget.budgetId }).totals.unknown).toBe(2);
    } finally {
      if (saved.bin === undefined) delete process.env.MEMEX_CODEX_BIN;
      else process.env.MEMEX_CODEX_BIN = saved.bin;
      if (saved.retries === undefined) delete process.env.MEMEX_LLM_RETRIES;
      else process.env.MEMEX_LLM_RETRIES = saved.retries;
      if (saved.backoff === undefined) delete process.env.MEMEX_LLM_RETRY_BASE_MS;
      else process.env.MEMEX_LLM_RETRY_BASE_MS = saved.backoff;
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defers an exhausted lease without burning queue attempts or cursor state", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const now = new Date("2026-09-08T00:00:00.000Z");
    const budget = getOrCreateModelWorkBudget(db, {
      parentWaveId: "defer-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    const attempt = reserveModelAttempt(db, { budgetId: budget.budgetId, inputChars: 1 });
    finishModelAttempt(db, { attemptId: attempt.attemptId, state: "failed" });
    db.prepare("INSERT INTO checkpoints VALUES ('cp-defer', 'processing')").run();
    db.prepare("INSERT INTO extraction_targets VALUES ('target-defer', 'running', 'worker', ?, 1, NULL, ?)").run(
      new Date(now.getTime() + 60_000).toISOString(),
      now.toISOString(),
    );
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, state, target_id, checkpoint_id, available_at, lease_owner,
         lease_until, lease_generation, attempts, updated_at, budget_id)
      VALUES ('job-defer', 'fact_extract', 'running', 'target-defer', 'cp-defer', ?,
              'worker', ?, 1, 0, ?, ?)
    `).run(
      now.toISOString(),
      new Date(now.getTime() + 60_000).toISOString(),
      now.toISOString(),
      budget.budgetId,
    );

    expect(deferMemoryJobForModelBudget(db, {
      jobId: "job-defer",
      budgetId: budget.budgetId,
      owner: "worker",
      leaseGeneration: 1,
      reason: "attempts",
      now,
      availableAt: new Date(now.getTime() + 3_600_000),
    })).toBe(true);
    expect(db.prepare("SELECT state, attempts, lease_owner, lease_until, last_error FROM memory_jobs WHERE job_id = 'job-defer'").get()).toMatchObject({
      state: "retry",
      attempts: 0,
      lease_owner: null,
      lease_until: null,
      last_error: "model work budget exhausted: attempts",
    });
    expect(db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = 'cp-defer'").get()).toEqual({ state: "retry" });
    expect(db.prepare("SELECT state, lease_owner FROM extraction_targets WHERE target_id = 'target-defer'").get()).toMatchObject({ state: "retry", lease_owner: null });
    db.close();
  });

  it("keeps unknown usage null and marks incomplete usage partial per attempt", () => {
    const db = new Database(":memory:");
    ensureModelBudgetSchema(db);
    const budget = getOrCreateModelWorkBudget(db, {
      parentWaveId: "usage-status-wave",
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    const unknown = reserveModelAttempt(db, { budgetId: budget.budgetId, inputChars: 1, stage: "usage" });
    finishModelAttempt(db, { attemptId: unknown.attemptId, state: "failed", tokenUsage: null });
    const partial = reserveModelAttempt(db, { budgetId: budget.budgetId, inputChars: 1, stage: "usage" });
    finishModelAttempt(db, {
      attemptId: partial.attemptId,
      state: "completed",
      tokenUsage: { input_tokens: 4, output_tokens: 2 },
    });
    const attempts = getModelWorkDiagnostics(db, { budgetId: budget.budgetId }).attempts
      .sort((a, b) => a.attemptNo - b.attemptNo);
    expect(attempts[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      tokenUsageStatus: "NOT_PROVEN",
    });
    expect(attempts[1]).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      cachedInputTokens: null,
      tokenUsageStatus: "partial",
    });
    db.close();
  });

  it("does not silently rotate an exhausted pending wave, then gives independent work a new cap", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const first = getOrCreateMaintenanceModelBudget(db, {
      parentWaveId: "maintenance-lifecycle",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    const attempt = reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1 });
    finishModelAttempt(db, { attemptId: attempt.attemptId, state: "failed" });
    db.prepare(`
      INSERT INTO memory_jobs (job_id, kind, state, available_at, updated_at, budget_id)
      VALUES ('bound-pending', 'fact_extract', 'retry', datetime('now'), datetime('now'), ?)
    `).run(first.budgetId);

    const held = getOrCreateMaintenanceModelBudget(db, { parentWaveId: "maintenance-lifecycle" });
    expect(held).toMatchObject({ budgetId: first.budgetId, state: "exhausted" });
    db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE job_id = 'bound-pending'").run();
    const closed = getOrCreateMaintenanceModelBudget(db, { parentWaveId: "maintenance-lifecycle" });
    expect(closed).toMatchObject({ budgetId: first.budgetId, state: "completed" });

    db.prepare(`
      INSERT INTO memory_jobs (job_id, kind, state, available_at, updated_at, budget_id)
      VALUES ('independent-pending', 'fact_extract', 'pending', datetime('now'), datetime('now'), NULL)
    `).run();
    const next = getOrCreateMaintenanceModelBudget(db, {
      parentWaveId: "maintenance-lifecycle",
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    expect(next.budgetId).not.toBe(first.budgetId);
    expect(next.state).toBe("active");
    db.close();
  });

  it("does not rotate an exhausted wave while an unassigned derived fact is still pending", () => {
    const previousAutoOntology = process.env.MEMEX_AUTO_ONTOLOGY;
    process.env.MEMEX_AUTO_ONTOLOGY = "1";
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        is_active INTEGER NOT NULL,
        ontology_category_id TEXT,
        needs_consolidation INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `);
    ensureModelBudgetSchema(db);
    const first = getOrCreateMaintenanceModelBudget(db, {
      parentWaveId: "derived-pending-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    const attempt = reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1, stage: "model" });
    finishModelAttempt(db, { attemptId: attempt.attemptId, state: "failed" });
    db.prepare("INSERT INTO facts (id, is_active, ontology_category_id, needs_consolidation, updated_at) VALUES ('fact-pending', 1, NULL, 0, datetime('now'))").run();

    const resumed = getOrCreateMaintenanceModelBudget(db, {
      parentWaveId: "derived-pending-wave",
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    expect(resumed).toMatchObject({ budgetId: first.budgetId, state: "exhausted" });
    db.close();
    if (previousAutoOntology === undefined) delete process.env.MEMEX_AUTO_ONTOLOGY;
    else process.env.MEMEX_AUTO_ONTOLOGY = previousAutoOntology;
  });

  it("resolves a bound job's old budget across worker wave names after restart", async () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "worker-wave-a",
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    db.prepare(`
      INSERT INTO memory_jobs (job_id, kind, state, available_at, updated_at, budget_id)
      VALUES ('bound-job', 'fact_extract', 'retry', datetime('now'), datetime('now'), ?)
    `).run(old.budgetId);

    await withResolvedModelWorkContext({
      db,
      jobId: "bound-job",
      parentWaveId: "worker-wave-b",
      stage: "fact_extract",
    }, async () => {
      expect(getModelWorkContext()?.budgetId).toBe(old.budgetId);
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets WHERE parent_wave_id = 'worker-wave-b'").get()).toEqual({ n: 0 });
    db.close();
  });

  it("keeps active lease jobs on the old run and retains their old attempt ledger", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "lease-affinity-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    const now = new Date("2026-09-08T00:00:00.000Z");
    const attempt = reserveModelAttempt(db, { budgetId: old.budgetId, inputChars: 1, stage: "old" });
    db.prepare(`
      INSERT INTO memory_jobs (job_id, kind, state, available_at, lease_owner, lease_until, updated_at, budget_id)
      VALUES ('active-lease', 'fact_extract', 'pending', ?, 'other', ?, ?, ?)
    `).run(
      now.toISOString(),
      new Date(now.getTime() + 10 * 60_000).toISOString(),
      now.toISOString(),
      old.budgetId,
    );
    db.prepare("UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?").run(old.budgetId);

    const result = startNewModelWorkRunForBudget(db, {
      budgetId: old.budgetId,
      now,
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    expect(result.skippedJobIds).toEqual(["active-lease"]);
    expect(db.prepare("SELECT budget_id FROM memory_jobs WHERE job_id = 'active-lease'").get()).toEqual({ budget_id: old.budgetId });
    expect(getModelWorkDiagnostics(db, { budgetId: old.budgetId }).attempts.map((row) => row.attemptId)).toEqual([attempt.attemptId]);
    db.close();
  });

  it("keeps running-job target membership on the old run during full resume", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "running-target-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    db.prepare("UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?").run(old.budgetId);
    const now = new Date("2026-09-08T00:00:00.000Z");
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, state, target_id, available_at, lease_owner, lease_until,
         lease_generation, updated_at, budget_id)
      VALUES ('running-target-job', 'fact_extract', 'running', 'fact-running', ?,
              'owner', ?, 4, ?, ?)
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
      jobId: "running-target-job",
    });

    const result = startNewModelWorkRunForBudget(db, {
      budgetId: old.budgetId,
      now,
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    expect(result.reboundJobIds).toEqual([]);
    expect(result.skippedJobIds).toEqual([]);
    expect(getModelWorkTargets(db, { budgetId: old.budgetId })).toHaveLength(1);
    expect(getModelWorkTargets(db, { budgetId: result.budget.budgetId })).toHaveLength(0);
    expect(db.prepare("SELECT budget_id, state FROM memory_jobs WHERE job_id = 'running-target-job'").get()).toEqual({
      budget_id: old.budgetId,
      state: "running",
    });
    db.close();
  });

  it("does not move a job target when an explicit per-job resume is rejected", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "running-job-resume-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, state, target_id, available_at, lease_owner, lease_until,
         lease_generation, updated_at, budget_id)
      VALUES ('running-job-resume', 'fact_extract', 'running', 'fact-job', ?,
              'owner', ?, 2, ?, ?)
    `).run(
      "2026-09-08T00:00:00.000Z",
      "2026-09-08T00:01:00.000Z",
      "2026-09-08T00:00:00.000Z",
      old.budgetId,
    );
    registerModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "ontology",
      targetIds: ["fact-job"],
      jobId: "running-job-resume",
    });

    expect(() => startNewModelWorkRunForJob(db, {
      jobId: "running-job-resume",
      parentWaveId: "running-job-resume-next",
      limits: { maxAttempts: 2, deadlineAt: null },
    })).toThrow(/not resumable from state running/);
    expect(getModelWorkTargets(db, { budgetId: old.budgetId })).toHaveLength(1);
    expect(getModelWorkTargets(db).filter((target) => target.targetId === "fact-job"))
      .toHaveLength(1);
    db.close();
  });

  it("moves jobless derived targets and queue targets atomically with a successful resume", () => {
    const db = new Database(":memory:");
    memoryJobSchema(db);
    ensureModelBudgetSchema(db);
    const old = getOrCreateModelWorkBudget(db, {
      parentWaveId: "target-resume-wave",
      limits: { maxAttempts: 1, deadlineAt: null },
    });
    db.prepare("UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?").run(old.budgetId);
    registerModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "relation",
      targetIds: ["fact-jobless"],
    });
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, state, target_id, available_at, updated_at, budget_id)
      VALUES ('resume-target-job', 'fact_extract', 'retry', 'target-resume', ?, ?, ?)
    `).run("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z", old.budgetId);
    registerModelWorkTargets(db, {
      budgetId: old.budgetId,
      stage: "ontology",
      targetIds: ["fact-job"],
      jobId: "resume-target-job",
    });
    const result = startNewModelWorkRunForBudget(db, {
      budgetId: old.budgetId,
      now: new Date("2026-09-08T00:00:00.000Z"),
      limits: { maxAttempts: 2, deadlineAt: null },
    });
    expect(result.reboundJobIds).toEqual(["resume-target-job"]);
    expect(getModelWorkTargets(db, { budgetId: old.budgetId })).toHaveLength(0);
    expect(getModelWorkTargets(db, { budgetId: result.budget.budgetId })
      .map((target) => [target.stage, target.targetId, target.jobId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([
        ["ontology", "fact-job", "resume-target-job"],
        ["relation", "fact-jobless", null],
      ]);
    db.close();
  });

  it("uses an isolated ephemeral Codex invocation for provider work", async () => {
    const dir = tempDir();
    const argsPath = path.join(dir, "args.json");
    const bin = fakeCodex(dir, `
      import fs from 'node:fs';
      fs.readFileSync(0, 'utf8');
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args, cwd: process.cwd() }));
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'isolated-reply');
    `);
    try {
      await expect(runCodex({ codexBin: bin, userMessage: "x", timeoutMs: 5_000 })).resolves.toBe("isolated-reply");
      const recorded = JSON.parse(fs.readFileSync(argsPath, "utf8")) as { args: string[]; cwd: string };
      expect(recorded.args).toEqual(expect.arrayContaining([
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--json",
        "-",
      ]));
      const canonical = (value: string) => value.replace(/^\/private(?=\/)/, "");
      expect(canonical(recorded.args[recorded.args.indexOf("-C") + 1])).toBe(canonical(recorded.cwd));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never returns partial output after timeout or non-zero provider exit", async () => {
    const dir = tempDir();
    const marker = path.join(dir, "orphan-marker");
    const timeoutBin = fakeCodex(dir, `
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      fs.readFileSync(0, 'utf8');
      const marker = ${JSON.stringify(marker)};
      spawn(process.execPath, ['-e', \`setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'orphan'), 500)\`], { stdio: 'ignore' });
      setTimeout(() => {}, 5000);
    `);
    await expect(runCodex({ codexBin: timeoutBin, userMessage: "x", timeoutMs: 100 })).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fs.existsSync(marker)).toBe(false);

    const partialBin = fakeCodex(dir, `
      import fs from 'node:fs';
      fs.readFileSync(0, 'utf8');
      const args = process.argv.slice(2); const output = args[args.indexOf('-o') + 1];
      fs.writeFileSync(output, 'partial-answer'); console.error('provider failed'); process.exit(7);
    `);
    await expect(runCodex({ codexBin: partialBin, userMessage: "x", timeoutMs: 5_000 })).rejects.toThrow(/code=7/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("enforces final output bounds", () => {
    const dir = tempDir();
    const outputBin = fakeCodex(dir, `
      import fs from 'node:fs';
      fs.readFileSync(0, 'utf8');
      const args = process.argv.slice(2); fs.writeFileSync(args[args.indexOf('-o') + 1], '123456789');
    `);
    return runCodex({ codexBin: outputBin, userMessage: "x", maxOutputChars: 3 }).then(
      () => { throw new Error("expected output bound failure"); },
      (error) => expect(error).toBeInstanceOf(ModelBudgetOutputLimitError),
    ).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  });
});
