import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings.js")>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => new Array(384).fill(0.01),
  };
});

import { initDatabase, insertExchange } from "../src/db.js";
import {
  claimExtractionTarget,
  claimMemoryJobById,
  ensureExtractionTarget,
  type ExtractionTarget,
} from "../src/continuity-store.js";
import { runFactExtraction } from "../src/fact-extractor.js";
import {
  bindMemoryJobToBudget,
  deferMemoryJobForModelBudget,
  ensureModelBudgetSchema,
  findExhaustedModelBudgetForClaim,
  getOrCreateAutomaticMaintenanceModelBudget,
} from "../src/model-budget.js";
import type { ConversationExchange } from "../src/types.js";

/**
 * Issue #12 — an already-dead model budget must never burn a queue claim.
 *
 * Observed 2026-09-09: 14:03:52Z automatic maintenance claimed two
 * `fact_extract` jobs and only then met budget `fe4a61c1`, whose `deadline_at`
 * (06:17Z) had long passed. `reserveModelAttempt` throws before it inserts an
 * attempt row, so no provider call happened — yet both jobs came out with
 * `attempts = 1` and `available_at = now + 60min`. At 14:04:18Z the same wake
 * minted a fresh budget whose only outstanding work was now in backoff, so the
 * window expired unused.
 */

let root: string;
let db: Database.Database;

/**
 * 🚨 벽시계 독립. `runFactExtraction` 은 `now` 를 받지 않고 내부에서 `new Date()`
 * 로 선점 시각을 잡는다. 관측 시각을 박아두면 픽스처 시계와 코드 시계가 갈라져
 * "backoff 없음"(available_at <= T0) 같은 단언이 벽시계에 따라 흔들린다. 기준점만
 * 실행 시각으로 옮기고 관측된 상대 구조(-8h 예산, +26s 새 예산)는 그대로 둔다.
 */
const T0 = new Date();
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const HOUR = 60 * 60_000;

function exchange(id: string, lineEnd: number): ConversationExchange {
  return {
    id,
    project: "/project",
    timestamp: at(-HOUR + lineEnd * 1_000).toISOString(),
    userMessage: `we decided to use postgres for ${id}`,
    assistantMessage: `ack ${id}`,
    archivePath: "/archive/session.jsonl",
    lineStart: lineEnd,
    lineEnd,
    sessionId: "session-1",
    cwd: "/project",
    closureState: "closed",
  };
}

function seedSession(): ExtractionTarget {
  insertExchange(db, exchange("e1", 1), new Array(384).fill(0.01));
  insertExchange(db, exchange("e2", 2), new Array(384).fill(0.01));
  return ensureExtractionTarget(db, {
    sessionId: "session-1",
    project: "/project",
    now: T0.toISOString(),
  })!;
}

function jobRow(jobId: string): {
  state: string;
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  budget_id: string | null;
} {
  return db.prepare(`
    SELECT state, attempts, available_at, lease_owner, budget_id
    FROM memory_jobs WHERE job_id = ?
  `).get(jobId) as never;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-claim-reason-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "memex.sqlite");
  delete process.env.MEMEX_MODEL_BUDGET_ID;
  delete process.env.MEMEX_MAINTENANCE_WAVE_ID;
  db = initDatabase();
  ensureModelBudgetSchema(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});
describe("issue #12 — a dead budget never burns a claim", () => {
  it("refuses the claim instead of spending an attempt and an hour of backoff", async () => {
    const { jobId } = seedSession();
    // 06:17Z budget, still bound to the queue, deadline long past at 14:03Z.
    const stale = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { deadlineAt: at(-8 * HOUR).toISOString() },
      now: at(-8 * HOUR),
    });
    bindMemoryJobToBudget(db, {
      jobId,
      budgetId: stale.budgetId,
      parentWaveId: stale.parentWaveId,
    });
    const before = jobRow(jobId);
    expect(before.attempts).toBe(0);

    expect(
      findExhaustedModelBudgetForClaim(db, { jobId, now: T0 })?.reason,
    ).toBe("deadline");

    // The detached worker inherits MEMEX_MODEL_BUDGET_ID from the wake.
    const result = await runFactExtraction(db, "session-1", "/project", {
      claimVariant: "worker",
      modelContext: { budgetId: stale.budgetId, parentWaveId: stale.parentWaveId },
    });
    expect(result.skipped).toBe("budget_exhausted");
    expect(result.budgetReason).toBe("deadline");

    const after = jobRow(jobId);
    expect(after.attempts, "a claim that cannot call the model must not cost one").toBe(0);
    expect(after.state).toBe("pending");
    expect(after.lease_owner).toBeNull();
    expect(
      after.available_at <= T0.toISOString(),
      "no one-hour backoff for work that never ran",
    ).toBe(true);
  });

  it("lets the fresh budget from the same wake claim the work immediately", async () => {
    const target = seedSession();
    const jobId = target.jobId;
    const stale = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { deadlineAt: at(-8 * HOUR).toISOString() },
      now: at(-8 * HOUR),
    });
    bindMemoryJobToBudget(db, {
      jobId,
      budgetId: stale.budgetId,
      parentWaveId: stale.parentWaveId,
    });
    await runFactExtraction(db, "session-1", "/project", {
      claimVariant: "worker",
      modelContext: { budgetId: stale.budgetId, parentWaveId: stale.parentWaveId },
    });

    // 14:04:18Z — the same wake mints the replacement budget 26 seconds later.
    const fresh = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      now: at(26_000),
    });
    expect(fresh.budgetId).not.toBe(stale.budgetId);
    expect(fresh.state).toBe("active");

    const rebound = jobRow(jobId);
    expect(rebound.budget_id).toBe(fresh.budgetId);
    expect(rebound.attempts).toBe(0);
    expect(rebound.available_at <= at(26_000).toISOString()).toBe(true);

    const claim = claimExtractionTarget(db, target, "fresh-runner", at(26_000));
    expect(claim, "the fresh window must not find only backoff work").not.toBeNull();
  });

  it("refunds an unspent claim on a deadline stop but keeps the attempts fence", () => {
    const { jobId } = seedSession();
    const claimedAt = T0;
    const claim = claimMemoryJobById(db, {
      jobId,
      owner: "worker",
      now: claimedAt,
    });
    expect(claim?.attempts).toBe(1);

    // No model_work_attempts row exists for this claim: reserveModelAttempt
    // throws before it inserts one, so the provider was never called.
    expect(deferMemoryJobForModelBudget(db, {
      jobId,
      owner: "worker",
      leaseGeneration: claim!.lease_generation,
      reason: "deadline",
      now: at(1_000),
      claimedAt,
    })).toBe(true);
    const refunded = jobRow(jobId);
    expect(refunded.attempts).toBe(0);
    expect(refunded.state).toBe("pending");
    expect(refunded.available_at).toBe(at(1_000).toISOString());
    expect(
      db.prepare("SELECT state, attempts FROM extraction_targets WHERE target_id = (SELECT target_id FROM memory_jobs WHERE job_id = ?)").get(jobId),
    ).toMatchObject({ state: "pending", attempts: 0 });

    // An attempts exhaustion is real spend: it keeps retry + the hour fence.
    const second = claimMemoryJobById(db, {
      jobId,
      owner: "worker-2",
      now: at(2_000),
    });
    expect(deferMemoryJobForModelBudget(db, {
      jobId,
      owner: "worker-2",
      leaseGeneration: second!.lease_generation,
      reason: "attempts",
      now: at(2_000),
      claimedAt: at(2_000),
    })).toBe(true);
    const fenced = jobRow(jobId);
    expect(fenced.attempts).toBe(1);
    expect(fenced.state).toBe("retry");
    expect(fenced.available_at).toBe(at(2_000 + HOUR).toISOString());
  });
});
