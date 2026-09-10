import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * `memex models test` is an EXPLICIT, isolated, single provider call (#31 §3.4).
 *
 * Two ways the 0.7.0 probe broke that promise:
 *  1. every probe used the fixed wave `model-probe`, and
 *     `getOrCreateWaveModelBudget` returns an existing EXHAUSTED budget while any
 *     unattributed work is pending — so the test that proves a fix was refused by
 *     the very backlog it exists to release (`bypassConfigHold` does not bypass
 *     budget exhaustion);
 *  2. it used the shared retry loop, so "test once" was up to three provider
 *     calls, three timeouts (60s each) and three ledger attempts.
 */

let providerCalls = 0;
let providerAnswer: string | null = "MEMEX_OK";

vi.mock("../src/codex-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-exec.js")>();
  return {
    ...actual,
    runCodex: async (opts: {
      model?: string | null;
      reasoningEffort?: string | null;
      onObservation?: (observation: unknown) => void;
    }) => {
      providerCalls++;
      opts.onObservation?.({
        duration_ms: 1,
        token_usage: null,
        model: opts.model ?? null,
        reasoning_effort: opts.reasoningEffort ?? null,
      });
      return providerAnswer ?? "";
    },
  };
});

let root: string;
let db: Database.Database;

beforeEach(async () => {
  providerCalls = 0;
  providerAnswer = "MEMEX_OK";
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-probe-isolation-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  const { ensureModelBudgetSchema } = await import("../src/model-budget.js");
  db = new Database(process.env.MEMEX_DB_PATH);
  ensureModelBudgetSchema(db);
  // The queue shape `countPendingModelWork` reads: one pending job attributed to
  // no budget at all, which is what kept a spent probe budget attached.
  db.exec(`
    CREATE TABLE memory_jobs (
      job_id TEXT PRIMARY KEY, budget_id TEXT, state TEXT, updated_at TEXT,
      maintenance_wave_id TEXT, hold_reason TEXT
    );
    INSERT INTO memory_jobs (job_id, budget_id, state) VALUES ('job-unbound', NULL, 'pending');
  `);
});

afterEach(() => {
  if (db.open) db.close();
  for (const key of ["MEMEX_HOME", "MEMEX_DB_PATH", "MEMEX_LLM_RETRY_BASE_MS"]) {
    delete process.env[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const probeAttempts = () =>
  db
    .prepare("SELECT budget_id, state FROM model_work_attempts WHERE stage = 'model_probe'")
    .all() as Array<{ budget_id: string; state: string }>;

it("does not inherit an exhausted probe budget held open by unattributed work", async () => {
  const { exhaustModelBudget, getOrCreateModelWorkBudget } = await import("../src/model-budget.js");
  const { probeModel } = await import("../src/model-settings-probe.js");

  // A previous probe's budget, spent, under the wave every probe used to share.
  const spent = getOrCreateModelWorkBudget(db, { parentWaveId: "model-probe" });
  exhaustModelBudget(db, { budgetId: spent.budgetId, reason: "attempts" });

  const result = await probeModel(db, { model: "gpt-5.6-luna", reasoning: null });

  expect(result.error).toBeNull();
  expect(result.ok).toBe(true);
  expect(providerCalls).toBe(1);
  // The attempt was recorded against a budget of this probe's own.
  const attempts = probeAttempts();
  expect(attempts).toHaveLength(1);
  expect(attempts[0].budget_id).not.toBe(spent.budgetId);
});

it("gives every probe its own wave, so two probes in a row both run", async () => {
  const { probeModel } = await import("../src/model-settings-probe.js");
  expect((await probeModel(db, { model: "gpt-5.6-luna", reasoning: null })).ok).toBe(true);
  expect((await probeModel(db, { model: "gpt-5.6-luna", reasoning: null })).ok).toBe(true);
  const waves = new Set(
    (
      db
        .prepare("SELECT parent_wave_id FROM model_work_budgets")
        .all() as Array<{ parent_wave_id: string }>
    )
      .map((row) => row.parent_wave_id)
      .filter((wave) => wave.startsWith("model-probe")),
  );
  expect(waves.size).toBe(2);
  expect([...waves].every((wave) => /^model-probe:[0-9a-f-]{36}$/.test(wave))).toBe(true);
});

it("spends exactly one provider call and one ledger attempt on a failing probe", async () => {
  const { probeModel } = await import("../src/model-settings-probe.js");
  providerAnswer = null; // empty body — 'transient', which the shared loop retries

  const result = await probeModel(db, { model: "gpt-5.6-luna", reasoning: null });

  expect(result.ok).toBe(false);
  expect(result.errorClass).toBe("transient");
  expect(providerCalls).toBe(1);
  expect(probeAttempts()).toHaveLength(1);
});
