import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * The selection snapshot is the one the provider is actually asked for (#31,
 * pre-release review of 0.7.0 · design E2).
 *
 * `callMemoryModelInternal` resolves the selection ONCE, before the retry loop,
 * and that snapshot owns the HOLD fingerprint and the ledger rows. The provider
 * invocation used to re-resolve from `options` + env/models.json on every
 * attempt, so a configuration change landing BETWEEN two attempts of one call
 * made the two disagree: the refusal of model B was recorded against model A's
 * fingerprint, blocking A (which never failed) and leaving B (which did) free.
 *
 * The regression line is therefore what the provider was SENT, not what the row
 * says: the rows looked perfectly consistent in the broken version.
 */

const sent: Array<{ model: string | null | undefined; reasoning: string | null | undefined }> = [];
/** Mutated from inside the first provider call — the mid-retry config change. */
let flipTo: { model: string; reasoning: string } | null = null;

vi.mock("../src/codex-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-exec.js")>();
  return {
    ...actual,
    runCodex: async (opts: {
      model?: string | null;
      reasoningEffort?: string | null;
      onObservation?: (observation: unknown) => void;
    }) => {
      sent.push({ model: opts.model, reasoning: opts.reasoningEffort });
      opts.onObservation?.({
        duration_ms: 1,
        token_usage: null,
        model: opts.model ?? null,
        reasoning_effort: opts.reasoningEffort ?? null,
      });
      if (sent.length === 1) {
        // The user (or another process) changes the selection while this call is
        // between attempt 1 and attempt 2.
        if (flipTo) {
          process.env.MEMEX_CODEX_MODEL = flipTo.model;
          process.env.MEMEX_CODEX_REASONING = flipTo.reasoning;
        }
        return ""; // empty body → transient → retried
      }
      throw new actual.CodexRequestRejectedError({
        status: 400,
        providerType: null,
        providerMessage: `The '${opts.model}' model is not supported when using Codex with a ChatGPT account.`,
        model: String(opts.model),
        reasoningEffort: opts.reasoningEffort ?? null,
      });
    },
  };
});

let root: string;
let db: Database.Database;

beforeEach(async () => {
  sent.length = 0;
  flipTo = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-selection-snapshot-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  process.env.MEMEX_CODEX_MODEL = "good-A";
  process.env.MEMEX_CODEX_REASONING = "low";
  const { ensureModelBudgetSchema } = await import("../src/model-budget.js");
  db = new Database(process.env.MEMEX_DB_PATH);
  ensureModelBudgetSchema(db);
});

afterEach(() => {
  if (db.open) db.close();
  for (const key of [
    "MEMEX_HOME",
    "MEMEX_DB_PATH",
    "MEMEX_LLM_RETRY_BASE_MS",
    "MEMEX_CODEX_MODEL",
    "MEMEX_CODEX_REASONING",
  ]) {
    delete process.env[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

it("sends the captured selection on every attempt, even when the configuration changes mid-retry", async () => {
  const { callMemoryModelObserved } = await import("../src/llm.js");
  const { activeModelConfigHold } = await import("../src/model-budget.js");
  const { llmSelectionFingerprint } = await import("../src/model-settings.js");

  const fingerprintA = llmSelectionFingerprint();
  flipTo = { model: "bad-B", reasoning: "high" };

  const error = await callMemoryModelObserved("sys", "user", 64, {
    modelContext: { db },
  }).then(
    () => null,
    (reason: unknown) => reason,
  );

  // Two attempts (empty body, then the rejection) and BOTH named the snapshot.
  expect(sent).toEqual([
    { model: "good-A", reasoning: "low" },
    { model: "good-A", reasoning: "low" },
  ]);
  // The refusal therefore belongs to the selection the hold names.
  expect((error as { detail?: { model?: string } })?.detail?.model).toBe("good-A");
  const hold = activeModelConfigHold(db, fingerprintA);
  expect(hold?.model).toBe("good-A");
  expect(hold?.reasoningEffort).toBe("low");
  // The selection that was never used is not blocked.
  expect(activeModelConfigHold(db, llmSelectionFingerprint())).toBeNull();
});

it("pins a per-call override too, so an env change cannot replace it between attempts", async () => {
  const { callMemoryModelObserved } = await import("../src/llm.js");
  flipTo = { model: "bad-B", reasoning: "high" };

  await callMemoryModelObserved("sys", "user", 64, {
    modelContext: { db },
    model: "harness-C",
    reasoningEffort: null,
  }).catch(() => {});

  expect(sent).toEqual([
    { model: "harness-C", reasoning: null },
    { model: "harness-C", reasoning: null },
  ]);
});
