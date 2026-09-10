import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  MODEL_CONFIG_HOLD_TTL_MS,
  activeModelConfigHold,
  clearModelConfigHold,
  currentModelConfigHold,
  ensureModelBudgetSchema,
  listModelConfigHolds,
  recordModelConfigHold,
} from "../src/model-budget.js";
import {
  invalidateModelSettingsCache,
  llmSelectionFingerprint,
} from "../src/model-settings.js";

/**
 * E2 — one data root, several processes, DIFFERENT env.
 *
 * v2 of this design kept the hold in a single `id=1` row and had the lookup
 * DELETE it on a fingerprint mismatch. So a worker started with
 * `MEMEX_CODEX_MODEL=B` would erase the valid hold that process A was standing
 * behind, and A would call the broken selection again — indefinitely. Keying the
 * table on the fingerprint removes the race rather than narrowing it: there is
 * no shared row left to delete.
 *
 * What is NOT claimed, deliberately: "exactly one provider call per wrong
 * setting". The hold is written after a rejection is observed, so calls already
 * in flight each take one. The guarantee is the bound.
 */

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-hold-multiproc-"));
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

/** Record a hold the way llm.ts does: for the fingerprint of the selection the
 *  failing call actually used. */
function recordFor(model: string, reasoning: string | null = null): string {
  process.env.MEMEX_CODEX_MODEL = model;
  if (reasoning) process.env.MEMEX_CODEX_REASONING = reasoning;
  else delete process.env.MEMEX_CODEX_REASONING;
  invalidateModelSettingsCache();
  const fingerprint = llmSelectionFingerprint();
  recordModelConfigHold(db, {
    fingerprint,
    model,
    reasoningEffort: reasoning,
    status: 400,
    providerType: "invalid_request_error",
    providerMessage: `the '${model}' model is not supported`,
    stage: "fact_extract",
    jobId: "job-1",
  });
  return fingerprint;
}

describe("fingerprint-keyed holds", () => {
  it("two processes with different env coexist and never erase each other", () => {
    const a = recordFor("model-A");
    const b = recordFor("model-B");
    expect(a).not.toBe(b);

    // Process A looks up its own selection: it sees its hold and nothing else.
    process.env.MEMEX_CODEX_MODEL = "model-A";
    invalidateModelSettingsCache();
    expect(currentModelConfigHold(db)?.model).toBe("model-A");
    // The act of looking did NOT touch B's row — the v2 regression.
    expect(activeModelConfigHold(db, b)?.model).toBe("model-B");

    // Releasing A leaves B held.
    expect(clearModelConfigHold(db, a, "probe-ok")).toBe(true);
    expect(activeModelConfigHold(db, a)).toBeNull();
    expect(activeModelConfigHold(db, b)?.model).toBe("model-B");
  });

  it("a per-call override gets its own hold and does not block the default", () => {
    const base = llmSelectionFingerprint();
    const override = llmSelectionFingerprint({ model: "one-off-model" });
    recordModelConfigHold(db, {
      fingerprint: override,
      model: "one-off-model",
      reasoningEffort: null,
      status: 400,
      providerType: null,
      providerMessage: "nope",
    });

    expect(activeModelConfigHold(db, override)).not.toBeNull();
    // An evaluation harness's one-off model must not fence ordinary work.
    expect(activeModelConfigHold(db, base)).toBeNull();
    expect(currentModelConfigHold(db)).toBeNull();
    expect(currentModelConfigHold(db, { model: "one-off-model" })).not.toBeNull();
  });

  it("fixing the setting makes the hold inert without any explicit clear", () => {
    recordFor("broken-model");
    process.env.MEMEX_CODEX_MODEL = "working-model";
    invalidateModelSettingsCache();
    // Nothing was cleared; the new fingerprint simply matches no active row.
    expect(currentModelConfigHold(db)).toBeNull();
    expect(listModelConfigHolds(db)).toHaveLength(1);
  });

  it("counts re-observations of the same selection instead of adding rows", () => {
    const fingerprint = recordFor("broken-model");
    recordFor("broken-model");
    recordFor("broken-model");
    const hold = activeModelConfigHold(db, fingerprint)!;
    expect(hold.observedCount).toBe(3);
    expect(listModelConfigHolds(db)).toHaveLength(1);
  });

  it("a reasoning change is a different selection", () => {
    const low = recordFor("same-model", "low");
    const high = recordFor("same-model", "high");
    expect(low).not.toBe(high);
    expect(listModelConfigHolds(db)).toHaveLength(2);
  });
});

describe("clearing keeps history", () => {
  it("marks the row cleared rather than deleting it", () => {
    const fingerprint = recordFor("broken-model");
    expect(clearModelConfigHold(db, fingerprint, "manual")).toBe(true);
    const row = db.prepare(
      "SELECT cleared_at, cleared_by, observed_count FROM model_config_holds WHERE selection_fingerprint = ?",
    ).get(fingerprint) as { cleared_at: string; cleared_by: string; observed_count: number };
    expect(row.cleared_by).toBe("manual");
    expect(row.cleared_at).toBeTruthy();
    // Idempotent: nothing active left to clear.
    expect(clearModelConfigHold(db, fingerprint, "manual")).toBe(false);
  });

  it("revives a cleared hold if the same selection is refused again", () => {
    const fingerprint = recordFor("broken-model");
    clearModelConfigHold(db, fingerprint, "probe-ok");
    expect(activeModelConfigHold(db, fingerprint)).toBeNull();
    // The probe said ok, the real call says otherwise: the selection is broken.
    recordFor("broken-model");
    expect(activeModelConfigHold(db, fingerprint)?.observedCount).toBe(2);
  });

  it("TTL closes a stale hold without deleting it", () => {
    const fingerprint = recordFor("broken-model");
    db.prepare(
      "UPDATE model_config_holds SET last_observed_at = ? WHERE selection_fingerprint = ?",
    ).run(new Date(Date.now() - MODEL_CONFIG_HOLD_TTL_MS - 60_000).toISOString(), fingerprint);

    ensureModelBudgetSchema(db);

    expect(activeModelConfigHold(db, fingerprint)).toBeNull();
    const row = db.prepare(
      "SELECT cleared_by FROM model_config_holds WHERE selection_fingerprint = ?",
    ).get(fingerprint) as { cleared_by: string };
    expect(row.cleared_by).toBe("ttl");
  });
});

describe("reporting", () => {
  it("lists every active hold and flags the one blocking this process", () => {
    recordFor("model-A");
    recordFor("model-B");
    process.env.MEMEX_CODEX_MODEL = "model-A";
    invalidateModelSettingsCache();

    const listed = listModelConfigHolds(db, llmSelectionFingerprint());
    expect(listed).toHaveLength(2);
    expect(listed.filter((hold) => hold.current).map((hold) => hold.model)).toEqual(["model-A"]);
    for (const hold of listed) {
      expect(hold.status).toBe(400);
      expect(hold.providerMessage).toContain("not supported");
    }
  });

  it("bounds the provider sentence it stores", () => {
    const fingerprint = llmSelectionFingerprint();
    recordModelConfigHold(db, {
      fingerprint,
      model: "m",
      reasoningEffort: null,
      status: 400,
      providerType: null,
      providerMessage: "x".repeat(2_000),
    });
    expect(activeModelConfigHold(db, fingerprint)!.providerMessage.length).toBe(400);
  });

  it("answers safely on a database with no hold table", () => {
    const bare = new Database(":memory:");
    try {
      expect(activeModelConfigHold(bare, "anything")).toBeNull();
      expect(listModelConfigHolds(bare)).toEqual([]);
    } finally {
      bare.close();
    }
  });
});
