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
  ensureExtractionTarget,
  type ExtractionTarget,
} from "../src/continuity-store.js";
import { runFactExtraction } from "../src/fact-extractor.js";
import {
  AUTOMATIC_MAINTENANCE_COOLDOWN_MS,
  AUTOMATIC_MAINTENANCE_WINDOW_MS,
  bindMemoryJobToBudget,
  ensureModelBudgetSchema,
  finishModelAttempt,
  findExhaustedModelBudgetForClaim,
  getOrCreateAutomaticMaintenanceModelBudget,
  reserveModelAttempt,
  startNewModelWorkRunForBudget,
} from "../src/model-budget.js";
import type { ConversationExchange } from "../src/types.js";

/**
 * Issue #14 — a deadline-expired budget must not stay `active`.
 *
 * Observed on the real data root at 2026-09-09T15:11Z: jobs 9588a335 and
 * 43ec49c8 were `pending`, bound to automatic budget 15af9e61 whose
 * `deadline_at` (14:19:18Z) had passed but whose durable `state` was still
 * `active`. Every `memex backfill extract` printed
 * `DEFERRED (budget_exhausted: deadline)` — correct, no attempt burned — and
 * `memex model-work resume 15af9e61 --new-run` answered `is still active;
 * resume requires an exhausted or cancelled budget`. There was no exit.
 *
 * Before 0.5.1 the exit existed because `reserveModelAttempt` wrote the budget
 * durably to `exhausted` on its way to throwing. The #12 pre-claim check
 * reported that same exhaustion without making that same write.
 */

let root: string;
let db: Database.Database;

/**
 * 🚨 벽시계 독립. 이슈의 관측 시각(14:04:18Z 생성 / 14:19:18Z deadline / 15:11Z
 * 관측)은 **상대 간격**으로만 재현한다. `runFactExtraction` 은 `now` 를 받지 않고
 * 내부에서 `new Date()` 를 읽으므로, 절대 시각을 박아두면 픽스처 시계와 코드
 * 시계가 갈라진 채로만 통과하는 테스트가 된다(이슈 #11 픽스처가 그렇게 썩었다).
 */
const T0 = new Date();
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
/** The wake that minted the budget, 67 minutes before the observation. */
const CREATED = at(-67 * 60_000);
/** Its 15-minute deadline — 52 minutes in the past by the observation. */
const DEADLINE = new Date(CREATED.getTime() + 15 * 60_000);
const HOUR = AUTOMATIC_MAINTENANCE_COOLDOWN_MS;
const DAY = AUTOMATIC_MAINTENANCE_WINDOW_MS;
const SESSIONS = ["session-9588a335", "session-43ec49c8"] as const;

function exchange(sessionId: string, id: string, lineEnd: number): ConversationExchange {
  return {
    id,
    project: "/project",
    timestamp: new Date(CREATED.getTime() - HOUR + lineEnd * 1_000).toISOString(),
    userMessage: `we decided to use postgres for ${id}`,
    assistantMessage: `ack ${id}`,
    archivePath: "/archive/session.jsonl",
    lineStart: lineEnd,
    lineEnd,
    sessionId,
    cwd: "/project",
    closureState: "closed",
  };
}

function budgetRow(budgetId: string): { state: string; updated_at: string } {
  return db
    .prepare("SELECT state, updated_at FROM model_work_budgets WHERE budget_id = ?")
    .get(budgetId) as never;
}

function jobRow(jobId: string): {
  state: string;
  attempts: number;
  available_at: string;
  budget_id: string | null;
} {
  return db.prepare(`
    SELECT state, attempts, available_at, budget_id
    FROM memory_jobs WHERE job_id = ?
  `).get(jobId) as never;
}

/**
 * The issue's exact durable state: an automatic budget past its deadline but
 * still stored `active`, with both extraction jobs `pending` and bound to it.
 */
function seedExpiredActiveBudget(): {
  budgetId: string;
  parentWaveId: string;
  targets: ExtractionTarget[];
} {
  const targets: ExtractionTarget[] = [];
  for (const sessionId of SESSIONS) {
    let line = 0;
    for (const suffix of ["a", "b"]) {
      line += 1;
      insertExchange(
        db,
        exchange(sessionId, `${sessionId}-${suffix}`, line),
        new Array(384).fill(0.01),
      );
    }
    targets.push(
      ensureExtractionTarget(db, {
        sessionId,
        project: "/project",
        now: CREATED.toISOString(),
      })!,
    );
  }
  const budget = getOrCreateAutomaticMaintenanceModelBudget(db, {
    parentWaveId: "maintenance",
    limits: { deadlineAt: DEADLINE.toISOString() },
    now: CREATED,
  });
  // Exactly what the issue reports: the clock ran out, the row did not move.
  expect(budgetRow(budget.budgetId).state).toBe("active");
  for (const target of targets) {
    bindMemoryJobToBudget(db, {
      jobId: target.jobId,
      budgetId: budget.budgetId,
      parentWaveId: budget.parentWaveId,
    });
    expect(jobRow(target.jobId)).toMatchObject({ state: "pending", attempts: 0 });
  }
  return { budgetId: budget.budgetId, parentWaveId: budget.parentWaveId, targets };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-expired-budget-"));
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
  vi.unstubAllEnvs();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("issue #14 — a deadline-expired budget reaches durable `exhausted`", () => {
  it("defers the backfill claim without burning an attempt and settles the budget", async () => {
    const { budgetId, parentWaveId, targets } = seedExpiredActiveBudget();

    const reported: Array<string | undefined> = [];
    for (const target of targets) {
      const result = await runFactExtraction(
        db,
        target.sessionId,
        "/project",
        { claimVariant: "worker", modelContext: { budgetId, parentWaveId } },
      );
      expect(result.skipped).toBe("budget_exhausted");
      expect(result.budgetReason).toBe("deadline");
      reported.push(result.budgetId);
      // #12's contract survives: a claim that cannot call the model costs
      // neither an attempt nor an hour of backoff.
      expect(jobRow(target.jobId)).toMatchObject({
        state: "pending",
        attempts: 0,
        budget_id: budgetId,
      });
    }

    // The regression itself. Reporting the exhaustion is not enough: nothing
    // that reads durable state could see it, so resume had nothing to resume.
    expect(budgetRow(budgetId).state).toBe("exhausted");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM model_work_attempts").get(),
      "the transition is bookkeeping, not a synthetic provider call",
    ).toEqual({ n: 0 });
    // The worker prints `memex model-work resume <id> --new-run`; without the
    // id the operator has to go find it before they can act on the line.
    expect(reported).toEqual(targets.map(() => budgetId));
  });

  it("leaves a budget that is genuinely fine untouched", () => {
    const live = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "live",
      limits: { deadlineAt: at(HOUR).toISOString() },
      now: T0,
    });
    const before = budgetRow(live.budgetId);
    expect(before.state).toBe("active");
    expect(
      findExhaustedModelBudgetForClaim(db, { budgetId: live.budgetId, now: T0 }),
    ).toBeNull();
    // Not even `updated_at` moves: the check is read-only unless it refuses.
    expect(budgetRow(live.budgetId)).toEqual(before);
  });

  it("accepts resume --new-run on an untouched active budget whose deadline passed", () => {
    const { budgetId, targets } = seedExpiredActiveBudget();
    // Belt and braces: no pre-claim check has run, so resume itself must settle
    // the clock-dead budget rather than refuse the operator's only exit.
    expect(budgetRow(budgetId).state).toBe("active");

    const resumed = startNewModelWorkRunForBudget(db, { budgetId, now: T0 });
    expect(resumed.previousBudget.state).toBe("exhausted");
    expect(resumed.budget.budgetId).not.toBe(budgetId);
    expect(resumed.budget.state).toBe("active");
    expect(resumed.reboundJobIds.sort()).toEqual(
      targets.map((t) => t.jobId).sort(),
    );
    expect(resumed.skippedJobIds).toEqual([]);
    expect(budgetRow(budgetId).state).toBe("exhausted");
  });

  it("still refuses resume on a budget with real time left", () => {
    const live = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "live",
      limits: { deadlineAt: at(HOUR).toISOString() },
      now: T0,
    });
    expect(() =>
      startNewModelWorkRunForBudget(db, { budgetId: live.budgetId, now: T0 }),
    ).toThrow(/is still active/);
    expect(budgetRow(live.budgetId).state).toBe("active");
  });

  it("walks the whole issue back out: defer -> resume --new-run -> claim", async () => {
    const { budgetId, parentWaveId, targets } = seedExpiredActiveBudget();
    for (const target of targets) {
      await runFactExtraction(db, target.sessionId, "/project", {
        claimVariant: "worker",
        modelContext: { budgetId, parentWaveId },
      });
    }

    // (b) `memex model-work resume <budget> --new-run`, which used to throw.
    const resumed = startNewModelWorkRunForBudget(db, { budgetId, now: at(60_000) });
    expect(resumed.reboundJobIds.sort()).toEqual(targets.map((t) => t.jobId).sort());

    // (c) the next claim is handed a live budget and goes through.
    for (const target of targets) {
      expect(jobRow(target.jobId)).toMatchObject({
        state: "pending",
        attempts: 0,
        budget_id: resumed.budget.budgetId,
      });
      expect(
        findExhaustedModelBudgetForClaim(db, {
          jobId: target.jobId,
          now: at(61_000),
        }),
        "the fresh run must not read as exhausted",
      ).toBeNull();
      const fresh = ensureExtractionTarget(db, {
        sessionId: target.sessionId,
        project: "/project",
      })!;
      expect(
        claimExtractionTarget(db, fresh, "operator-runner", at(61_000)),
        "the exact target/cursor the deferral preserved must be claimable",
      ).not.toBeNull();
    }
  });
});

describe("issue #14 — the automatic wake exits the same state on its own", () => {
  it("mints a fresh budget, rebinds the jobs and claims them in the same wake", () => {
    const { budgetId, targets } = seedExpiredActiveBudget();

    // One SessionStart wake, 67 minutes after the dead budget was minted:
    // past its deadline and past the 1h cooldown.
    const fresh = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      now: T0,
    });
    expect(fresh.budgetId).not.toBe(budgetId);
    expect(fresh).toMatchObject({ state: "active", automatic: true, reservedAttempts: 0 });
    expect(budgetRow(budgetId).state).toBe("exhausted");

    for (const target of targets) {
      expect(jobRow(target.jobId)).toMatchObject({
        state: "pending",
        attempts: 0,
        budget_id: fresh.budgetId,
      });
      expect(
        findExhaustedModelBudgetForClaim(db, { jobId: target.jobId, now: T0 }),
      ).toBeNull();
      expect(
        claimExtractionTarget(db, target, "wake-runner", T0),
        "an automatic wake that cannot claim its own work leaves the backlog stuck",
      ).not.toBeNull();
    }
  });

  it("honors the 1h cooldown: an early wake settles the budget but mints nothing", () => {
    const { budgetId, targets } = seedExpiredActiveBudget();
    // 14:34Z — deadline passed, but only 30 minutes since the budget was made.
    const early = new Date(CREATED.getTime() + 30 * 60_000);
    const same = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      now: early,
    });
    expect(same.budgetId).toBe(budgetId);
    // The wake still owes the durable transition — that is what makes the
    // operator's `resume --new-run` available during the cooldown.
    expect(same.state).toBe("exhausted");
    expect(jobRow(targets[0].jobId).budget_id).toBe(budgetId);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get(),
    ).toEqual({ n: 1 });
  });

  it("honors the 24h rolling cap: no fresh budget until the window rolls off", () => {
    vi.stubEnv("MEMEX_AUTO_MODEL_MAX_ATTEMPTS", "1");
    const { budgetId } = seedExpiredActiveBudget();
    // Spend the single automatic attempt while the budget was still live.
    const attempt = reserveModelAttempt(db, {
      budgetId,
      inputChars: 1,
      now: CREATED,
    });
    finishModelAttempt(db, {
      attemptId: attempt.attemptId,
      state: "completed",
      finishedAt: CREATED.toISOString(),
    });

    const capped = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      now: T0,
    });
    expect(capped.budgetId, "the cap outranks the expired deadline").toBe(budgetId);
    expect(capped.state).toBe("exhausted");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get(),
    ).toEqual({ n: 1 });

    // 24h after the attempt the window has room again.
    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      now: new Date(CREATED.getTime() + DAY),
    });
    expect(rolled.budgetId).not.toBe(budgetId);
    expect(rolled.state).toBe("active");
  });
});
