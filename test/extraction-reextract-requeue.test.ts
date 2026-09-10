/**
 * `memex extract rules reextract --apply` has to leave work that RUNS (#30 §3.8).
 *
 * The re-queue reset `state`, `attempts` and the item rows but not
 * `cursor_ordinal`, and a completed target's cursor equals `item_count`. The next
 * claim reads the page AFTER the cursor, so it got an empty one — and
 * `runFactExtraction` records that as
 * `target has no pending page despite incomplete state`, a non-retryable internal
 * failure plus a visible failed range. Every re-extraction an operator asked for
 * failed on its first pass, and the CLI test that existed only looked at the row
 * states, never at an extraction afterwards.
 *
 * So this suite re-queues and then actually extracts, through the real claim path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/codex-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-exec.js")>();
  const { codexMock } = await import("./extraction-rules-fixture.js");
  return { ...actual, ...codexMock(actual) };
});
vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase } from "../src/db.js";
import { runFactExtraction } from "../src/fact-extractor.js";
import { requeueCompletedExtractionTarget } from "../src/continuity-store.js";
import { resetExtractionRulesCache } from "../src/extraction-rules.js";
import { resetQuarantineMemory } from "../src/overlay-matcher.js";
import {
  PROJECT,
  SESSION,
  claimSnapshot,
  factCandidate,
  pinOverlayEnv,
  resetScript,
  restoreOverlayEnv,
  script,
  seedExchanges,
} from "./extraction-rules-fixture.js";

let root: string;
let db: Database.Database;

interface TargetRow {
  target_id: string;
  cursor_ordinal: number;
  item_count: number;
  state: string;
  last_error: string | null;
  policy_version: string;
}

function target(): TargetRow {
  return db.prepare(
    "SELECT target_id, cursor_ordinal, item_count, state, last_error, policy_version FROM extraction_targets",
  ).get() as TargetRow;
}

function jobId(): string | null {
  const row = db.prepare("SELECT job_id FROM memory_jobs WHERE kind = 'fact_extract'").get() as
    | { job_id: string }
    | undefined;
  return row?.job_id ?? null;
}

function checkpointId(): string | null {
  const row = db.prepare("SELECT checkpoint_id FROM memory_jobs WHERE kind = 'fact_extract'").get() as
    | { checkpoint_id: string | null }
    | undefined;
  return row?.checkpoint_id ?? null;
}

function makeClaimable(): void {
  db.prepare("UPDATE memory_jobs SET available_at = ? WHERE kind = 'fact_extract'").run(
    new Date(Date.now() - 1_000).toISOString(),
  );
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-reextract-"));
  pinOverlayEnv(root);
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  process.env.MEMEX_CODEX_MODEL = "test-model";
  resetQuarantineMemory();
  resetExtractionRulesCache();
  resetScript([factCandidate("Riverpod was chosen for state management", "Riverpod")]);
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  db = initDatabase();
  seedExchanges(db, { userMessage: "Riverpod was chosen for state management." });
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  restoreOverlayEnv();
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  delete process.env.MEMEX_LLM_RETRY_BASE_MS;
  delete process.env.MEMEX_CODEX_MODEL;
  resetQuarantineMemory();
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("requeueCompletedExtractionTarget", () => {
  it("rewinds the cursor so the next extraction starts at the first ordinal", async () => {
    const first = await runFactExtraction(db, SESSION, PROJECT);
    expect(first.skipped).toBeUndefined();
    expect(first.saved).toBe(1);
    const completed = target();
    expect(completed.state).toBe("completed");
    // The state the bug needed: a completed target's cursor is at the end.
    expect(completed.cursor_ordinal).toBe(completed.item_count);
    expect(completed.cursor_ordinal).toBeGreaterThan(0);

    const changed = requeueCompletedExtractionTarget(db, {
      targetId: completed.target_id,
      jobId: jobId(),
      checkpointId: checkpointId(),
    });
    expect(changed.extraction_targets).toBe(1);

    const requeued = target();
    expect(requeued.state).toBe("pending");
    expect(requeued.cursor_ordinal).toBe(0);
    // The scheduling key is NOT touched: rewriting it would turn one edited rule
    // into a full-corpus re-extraction.
    expect(requeued.policy_version).toBe(completed.policy_version);

    // The part no existing test did: actually extract again.
    makeClaimable();
    resetScript([factCandidate("Riverpod was chosen for state management", "Riverpod")]);
    const second = await runFactExtraction(db, SESSION, PROJECT);

    expect(second.skipped).toBeUndefined();
    expect(second.extracted).toBe(1);
    const after = claimSnapshot(db);
    expect(after.failedRanges).toBe(0);
    expect(after.jobState).toBe("completed");
    expect(after.targetState).toBe("completed");
    expect(target().last_error).toBeNull();
    expect(target().cursor_ordinal).toBe(completed.item_count);
    // Every item was re-processed, not skipped past.
    expect(after.processedGenerations).toBe(completed.item_count);
  });

  it("leaves a target another worker has re-claimed alone", async () => {
    await runFactExtraction(db, SESSION, PROJECT);
    const completed = target();
    db.prepare("UPDATE extraction_targets SET state = 'running' WHERE target_id = ?").run(
      completed.target_id,
    );

    const changed = requeueCompletedExtractionTarget(db, {
      targetId: completed.target_id,
      jobId: jobId(),
      checkpointId: checkpointId(),
    });

    expect(changed).toEqual({});
    const untouched = target();
    expect(untouched.state).toBe("running");
    expect(untouched.cursor_ordinal).toBe(completed.cursor_ordinal);
  });
});
