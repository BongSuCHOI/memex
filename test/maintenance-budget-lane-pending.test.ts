import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { initDatabase } from "../src/db.js";
import {
  AUTOMATIC_MAINTENANCE_COOLDOWN_MS,
  ensureModelBudgetSchema,
  exhaustModelBudget,
  findExhaustedModelBudgetForClaim,
  finishModelAttempt,
  getModelWorkTargets,
  getOrCreateAutomaticMaintenanceModelBudget,
  holdMemoryJob,
  peekResolvedModelBudget,
  registerModelWorkTargets,
  releaseHeldJobs,
  reserveModelAttempt,
} from "../src/model-budget.js";

/**
 * Issue #175 — automatic fact extraction deadlocks once the job queue drains.
 *
 * `getOrCreateAutomaticMaintenanceModelBudget` decided "is there pending work?"
 * from `memory_jobs` / `model_work_targets` alone. But a `fact_extract` job is
 * only ever CREATED by the extraction worker, and the worker only spawns while
 * the maintenance budget is `active`. So the moment the queue drained the wake
 * marked the budget `completed`, the worker never spawned, no job was ever
 * created, and the next wake saw the same empty queue — seven sessions pending
 * since 2026-09-17 on the work Mac, maintenance#23–#25 all `completed` with
 * 0–1 attempts and an empty 24h window.
 *
 * The lane predicates (a pending extraction SESSION, a pending ontology FACT)
 * live one level above the job queue, so the caller passes them in.
 *
 * Wall-clock independent: every fixture time is relative to `new Date()`.
 */

const T0 = new Date();
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const HOUR = AUTOMATIC_MAINTENANCE_COOLDOWN_MS;
/** Far enough ahead that no fixture call meets a clock-dead `active` run. */
const limits = { maxAttempts: 8, deadlineAt: at(6 * HOUR).toISOString() };

describe("issue #175 — a completed automatic budget reopens for lane-level work", () => {
  let root: string;
  let db: Database.Database;

  const budgetCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get() as { n: number }).n;

  /** A claimed job bound to `budgetId`, with a live lease `holdMemoryJob` can CAS. */
  const claimedBoundJob = (jobId: string, budgetId: string, waveId: string) => {
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, partition_key, policy_version, state, available_at,
         lease_owner, lease_until, lease_generation, attempts, idempotency_key,
         created_at, updated_at, budget_id, maintenance_wave_id)
      VALUES (?, 'capsule_update', ?, 'test', 'running', ?, 'owner-1', ?, 1, 1, ?, ?, ?, ?, ?)
    `).run(
      jobId, `session:${jobId}`, T0.toISOString(), at(30 * 60_000).toISOString(),
      jobId, T0.toISOString(), T0.toISOString(), budgetId, waveId,
    );
  };

  const jobRow = (jobId: string) =>
    db.prepare("SELECT budget_id, state, hold_reason FROM memory_jobs WHERE job_id = ?").get(jobId) as
      { budget_id: string | null; state: string; hold_reason: string | null };

  /**
   * Exactly the row `holdMemoryJob` leaves behind: unbound, `state='pending'`,
   * no lease, attempts refunded, `hold_reason` set (src/model-budget.ts
   * `holdJobStatement`). Written directly so the fixture does not need a whole
   * claimed Continuity job to reach one durable state.
   */
  const holdUnboundJob = (jobId: string) => {
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, partition_key, policy_version, state, available_at,
         attempts, idempotency_key, created_at, updated_at, hold_reason)
      VALUES (?, 'capsule_update', ?, 'test', 'pending', ?, 0, ?, ?, ?, 'model_config_rejected')
    `).run(jobId, `session:${jobId}`, T0.toISOString(), jobId, T0.toISOString(), T0.toISOString());
  };

  /**
   * The exact durable state from the issue: the latest automatic maintenance
   * budget is `completed` and the job queue is empty, because the previous
   * wake found nothing to do.
   */
  const drainedToCompleted = (runLimits = limits) => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runLimits,
      now: T0,
    });
    expect(first.state).toBe("active");
    expect(first.runSeq).toBe(1);
    // The next wake sees no job and no derived target: the run is retired.
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runLimits,
      now: at(60_000),
    });
    expect(drained.budgetId).toBe(first.budgetId);
    expect(drained.state).toBe("completed");
    expect(budgetCount()).toBe(1);
    return drained;
  };

  /** Unbound queue work of another lane — what mints the next run in #180-1. */
  const unboundPendingJob = (jobId: string, kind = "capture_index") => {
    db.prepare(`
      INSERT INTO memory_jobs
        (job_id, kind, partition_key, policy_version, state, available_at,
         attempts, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, 'test', 'pending', ?, 0, ?, ?, ?)
    `).run(jobId, kind, `session:${jobId}`, T0.toISOString(), jobId, T0.toISOString(), T0.toISOString());
  };

  const budgetRow = (budgetId: string) =>
    db.prepare("SELECT state, run_seq FROM model_work_budgets WHERE budget_id = ?").get(budgetId) as
      { state: string; run_seq: number };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-lane-pending-"));
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

  it("rolls a completed run over to a new active run when a lane has work", () => {
    // 이슈 #180-2: run 의 경계는 데드라인이다. 데드라인이 아직 열려 있으면 같은 run
    // 을 되돌려 쓰므로(아래 "reopens the completed unspent run in place"), 롤오버를
    // 보려면 run 1 의 창이 끝난 뒤의 wake 여야 한다.
    const runOne = { maxAttempts: 8, deadlineAt: at(10 * 60_000).toISOString() };
    const drained = drainedToCompleted(runOne);

    // A new session arrives. There is still no `fact_extract` job — only the
    // worker creates one — so the queue is the wrong place to ask.
    const reopened = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(11 * 60_000),
      lanePending: true,
    });
    expect(
      reopened.state,
      "a pending extraction session must reopen the drained maintenance wave",
    ).toBe("active");
    expect(reopened.budgetId).not.toBe(drained.budgetId);
    expect(reopened.parentWaveId).toBe("maintenance#2");
    expect(reopened.rootWaveId).toBe("maintenance");
    expect(reopened.runSeq).toBe(2);
    expect(reopened.automatic).toBe(true);
    expect(budgetCount()).toBe(2);
    // Nothing failed, so the rollover is a clock-only stop: no 60-minute wait.
    expect(Date.parse(reopened.createdAt)).toBeLessThan(Date.parse(drained.createdAt) + HOUR);
    // The retired run keeps its own ledger.
    expect(
      db.prepare("SELECT state FROM model_work_budgets WHERE budget_id = ?").get(drained.budgetId),
    ).toEqual({ state: "completed" });
  });

  it("without lane work the completed run stays completed (no new run)", () => {
    const drained = drainedToCompleted();

    const explicit = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: false,
    });
    expect(explicit.budgetId).toBe(drained.budgetId);
    expect(explicit.state).toBe("completed");

    // Every pre-#175 caller omits the flag and must keep its behaviour.
    const omitted = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * HOUR),
    });
    expect(omitted.budgetId).toBe(drained.budgetId);
    expect(omitted.state).toBe("completed");
    expect(budgetCount()).toBe(1);
  });

  it("the 24h rolling cap outranks lane work", () => {
    vi.stubEnv("MEMEX_AUTO_MODEL_MAX_ATTEMPTS", "1");
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    // Spend the window's single automatic attempt while the run was live.
    const attempt = reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1, now: T0 });
    finishModelAttempt(db, {
      attemptId: attempt.attemptId,
      state: "completed",
      finishedAt: T0.toISOString(),
    });
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
    });
    expect(drained.budgetId).toBe(first.budgetId);
    expect(drained.state).toBe("completed");

    const capped = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: true,
    });
    expect(capped.state, "the 24h cap is unconditional").not.toBe("active");
    expect(capped.budgetId).toBe(first.budgetId);
    expect(budgetCount()).toBe(1);

    // Once the window rolls off, the same lane work opens the next run.
    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 8, deadlineAt: at(25 * HOUR).toISOString() },
      now: at(24 * HOUR + 60_000),
      lanePending: true,
    });
    expect(rolled.budgetId).not.toBe(first.budgetId);
    expect(rolled.state).toBe("active");
    expect(rolled.runSeq).toBe(2);
  });

  /**
   * Codex review of the #175 fix: `completed` is not proof that nothing was
   * spent. The `!pending` block rewrites ANY non-completed row to `completed`
   * (the status attention counter reads `state = 'exhausted'`), so a run that
   * burned its last allowed attempt and then met an empty queue also reads
   * `completed` — and a state-only clock-only rule let it reopen two minutes
   * later, skipping the hour it had genuinely earned.
   */
  it("a run that spent its attempt cap still serves the 60-minute cooldown", () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 1, deadlineAt: at(6 * HOUR).toISOString() },
      now: T0,
    });
    // Spend the run's whole cap on a real provider call.
    const attempt = reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1, now: T0 });
    finishModelAttempt(db, {
      attemptId: attempt.attemptId,
      state: "completed",
      finishedAt: T0.toISOString(),
    });

    // The next wake settles the spent run AND retires it, because the queue is
    // empty by then: one row that is `completed` with a spend on its ledger.
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
    });
    expect(drained.budgetId).toBe(first.budgetId);
    expect(drained.state).toBe("completed");
    // `reserveModelAttempt` writes `state = 'exhausted'` on the reservation
    // that fills the cap without recording a reason, so the row that reaches
    // the wake carries NO reason at all: the attempt ledger below is the only
    // witness of the spend, which is why the cooldown rule has to read it.
    expect(drained.exhaustedReason).toBeNull();
    expect(drained.reservedAttempts).toBeGreaterThanOrEqual(drained.maxAttempts);

    const early = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: true,
    });
    expect(
      early.budgetId,
      "a run that spent its cap must serve the cooldown, `completed` or not",
    ).toBe(first.budgetId);
    expect(early.state).not.toBe("active");
    expect(budgetCount()).toBe(1);

    // 61 minutes after the spend the cooldown is over and the lane reopens.
    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 8, deadlineAt: at(7 * HOUR).toISOString() },
      now: at(61 * 60_000),
      lanePending: true,
    });
    expect(rolled.budgetId).not.toBe(first.budgetId);
    expect(rolled.state).toBe("active");
    expect(rolled.runSeq).toBe(2);
  });

  /** The other spend witness: a recorded reason, with the cap still unspent. */
  it("a run retired after a recorded spend keeps its cooldown too", () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    exhaustModelBudget(db, { budgetId: first.budgetId, reason: "attempts", now: T0 });
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
    });
    expect(drained.state).toBe("completed");
    expect(drained.exhaustedReason, "the reason survives the retirement").toBe("attempts");
    expect(drained.reservedAttempts).toBeLessThan(drained.maxAttempts);

    const early = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: true,
    });
    expect(early.budgetId, "a recorded spend outranks the `completed` state").toBe(first.budgetId);
    expect(early.state).not.toBe("active");
    expect(budgetCount()).toBe(1);

    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 8, deadlineAt: at(7 * HOUR).toISOString() },
      now: at(61 * 60_000),
      lanePending: true,
    });
    expect(rolled.budgetId).not.toBe(first.budgetId);
    expect(rolled.state).toBe("active");
  });

  /**
   * Issue #177 item 2, Codex follow-up — `lanePending: false` alone is not the
   * whole fix.
   *
   * `countPendingModelWork` counted every unbound `memory_jobs` row in
   * `pending`/`retry`, and `holdMemoryJob` parks a held job in exactly that
   * state (`state='pending'`, lease cleared, attempts refunded, `hold_reason`
   * set). So a drained `completed` run plus ONE held job reopened run 2 on every
   * wake past the deadline, no matter what the caller passed — and the same hold
   * then skipped every model lane the run was minted for. A held job is by
   * definition not runnable work, which is why `rolloverSpentWaveBudgets` and
   * `rebindSpentQueueJobsToBudget` already exclude it from `movable`.
   */
  it("an unbound HELD job is not pending work: a drained run stays completed", () => {
    const drained = drainedToCompleted();
    holdUnboundJob("job-held-1");

    const wake = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: false,
    });
    expect(
      wake.budgetId,
      "a held job must not mint a run that the same hold will skip every lane of",
    ).toBe(drained.budgetId);
    expect(wake.state).toBe("completed");
    expect(budgetCount()).toBe(1);

    // Releasing the hold turns it back into ordinary queued work, and the very
    // next wake opens the run that will actually drain it — 이슈 #180-2 이후로는
    // 데드라인이 아직 열려 있는 미소비 run 을 **제자리에서** 다시 열어 쓴다.
    expect(releaseHeldJobs(db, "model_config_rejected")).toBe(1);
    const reopened = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(3 * 60_000),
      lanePending: false,
    });
    expect(
      reopened.state,
      "once the hold is lifted the job is real work again and must reopen the wave",
    ).toBe("active");
    expect(reopened.budgetId, "an open unspent run is reused, not replaced (#180-2)")
      .toBe(drained.budgetId);
    expect(reopened.runSeq).toBe(1);
    expect(budgetCount()).toBe(1);
  });

  /**
   * Issue #177, Codex round 2 — the hold_reason exclusion stranded a BOUND job.
   *
   * Excluding held jobs from `countPendingModelWork` is right, but it also means
   * wave selection retires the run they are bound to as `completed`. When the
   * hold is released the job is ordinary work again — and it is still bound to a
   * `completed` run that no rollover path adopted: `rolloverSpentWaveBudgets`
   * and the automatic rollover only rebound jobs off an `exhausted` budget, and
   * the `completed` branch went straight to `insertModelWorkBudget` with no
   * rebind at all. Codex reproduced both halves of the consequence: before the
   * retired run's deadline the model call is charged to a `completed` budget,
   * and after it the claim is refused with `deadline` — forever.
   */
  it("a released held job bound to a retired run joins the wave's next run", () => {
    // 이슈 #180-2 이후: 데드라인이 열려 있는 미소비 run 은 제자리에서 다시 열리므로,
    // **다음 run** 으로의 이동을 보려면 run 1 의 창이 끝난 뒤에 hold 를 풀어야 한다.
    const runOne = { maxAttempts: 8, deadlineAt: at(10 * 60_000).toISOString() };
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runOne,
      now: T0,
    });
    expect(first.state).toBe("active");
    claimedBoundJob("job-bound-1", first.budgetId, first.parentWaveId);
    expect(
      holdMemoryJob(db, {
        jobId: "job-bound-1",
        owner: "owner-1",
        leaseGeneration: 1,
        reason: "model_config_rejected",
        detail: "models.json names a model the provider rejected",
        now: T0,
      }),
      "the hold CAS must match the claim the fixture wrote",
    ).toBe(true);
    expect(jobRow("job-bound-1")).toEqual({
      budget_id: first.budgetId,
      state: "pending",
      hold_reason: "model_config_rejected",
    });

    // The wake sees no runnable work (the only job is held) and retires run 1.
    const retired = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runOne,
      now: at(60_000),
      lanePending: false,
    });
    expect(retired.budgetId).toBe(first.budgetId);
    expect(retired.state).toBe("completed");
    expect(budgetCount()).toBe(1);

    // STILL HELD: nothing moves, nothing is minted, the hold is intact.
    const stillHeld = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runOne,
      now: at(2 * 60_000),
      lanePending: false,
    });
    expect(stillHeld.budgetId).toBe(first.budgetId);
    expect(stillHeld.state).toBe("completed");
    expect(budgetCount()).toBe(1);
    expect(
      jobRow("job-bound-1"),
      "a job that is still held must not be moved off its run",
    ).toEqual({
      budget_id: first.budgetId,
      state: "pending",
      hold_reason: "model_config_rejected",
    });

    // The operator fixes the setting, after run 1's window has ended.
    expect(releaseHeldJobs(db, "model_config_rejected")).toBe(1);
    const reopened = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(11 * 60_000),
      lanePending: false,
    });
    expect(reopened.state, "the released job is real work and must open run 2").toBe("active");
    expect(reopened.budgetId).not.toBe(first.budgetId);
    expect(reopened.runSeq).toBe(2);
    expect(budgetCount()).toBe(2);
    expect(
      jobRow("job-bound-1"),
      "a released job left on the retired run can never be claimed again",
    ).toEqual({
      budget_id: reopened.budgetId,
      state: "pending",
      hold_reason: null,
    });

    // And the claim path agrees: the job resolves to the LIVE run, not the
    // retired one, so the model call is charged to run 2 and is not refused.
    const peeked = peekResolvedModelBudget(db, { jobId: "job-bound-1" });
    expect("budget" in peeked && peeked.budget.budgetId).toBe(reopened.budgetId);
    expect(
      findExhaustedModelBudgetForClaim(db, {
        jobId: "job-bound-1",
        parentWaveId: "maintenance",
        now: at(12 * 60_000),
      }),
      "a job on the live run must not be refused",
    ).toBeNull();
  });

  /**
   * 🚨 이슈 #180-1 — 해제된 hold job 이 **더 오래된** 은퇴 run 에 묶여 좌초한다.
   *
   * #177 라운드 2 는 `latest` 하나에서만 job 을 데려왔다. 리뷰어가 재현한 순서는
   * 그 한 칸을 비켜간다: capsule job 이 run 1 에서 hold → run 1 이 `completed` 로
   * 은퇴 → 무관한 **unbound** 작업이 run 2 를 연다 → hold 해제. 이제 job 이 묶인
   * run 1 은 더 이상 `latest` 가 아니므로 어떤 wake 도 그것을 옮기지 않고,
   * run 1 의 데드라인이 지나면 claim 이 `deadline` 으로 거절되어 **영구히** 멈춘다.
   *
   * 그래서 자동 wake 는 매번, 반환할 예산이 `active` 로 확정된 뒤, 같은 계보
   * (`root_wave_id`)의 **모든** 비활성 run 에서 움직일 수 있는 job 을 데려온다.
   */
  it("adopts a released job stranded on an older retired run, not just on `latest`", () => {
    // run 1: 10분 데드라인 — #180-2 의 재사용 창을 지나 run 2 가 열리게 한다.
    const runOne = { maxAttempts: 8, deadlineAt: at(10 * 60_000).toISOString() };
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runOne,
      now: T0,
    });
    expect(first.state).toBe("active");
    for (const jobId of ["job-capsule-1", "job-capsule-held"]) {
      claimedBoundJob(jobId, first.budgetId, first.parentWaveId);
      expect(
        holdMemoryJob(db, {
          jobId,
          owner: "owner-1",
          leaseGeneration: 1,
          reason: jobId === "job-capsule-1" ? "model_config_rejected" : "extraction_rules_invalid",
          detail: "held while run 1 retires",
          now: T0,
        }),
        "the hold CAS must match the claim the fixture wrote",
      ).toBe(true);
    }

    // 아무 실행 가능한 일감이 없다 → run 1 은 `completed` 로 은퇴한다.
    const retired = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runOne,
      now: at(60_000),
      lanePending: false,
    });
    expect(retired.budgetId).toBe(first.budgetId);
    expect(retired.state).toBe("completed");

    // 무관한 unbound 작업이 run 2 를 연다(run 1 의 데드라인은 이미 지났다).
    unboundPendingJob("job-index-1");
    const second = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(11 * 60_000),
      lanePending: false,
    });
    expect(second.budgetId).not.toBe(first.budgetId);
    expect(second.state).toBe("active");
    expect(second.runSeq).toBe(2);
    expect(budgetCount()).toBe(2);
    // 두 job 모두 아직 hold 중이므로 움직이지 않는다.
    for (const jobId of ["job-capsule-1", "job-capsule-held"]) {
      expect(jobRow(jobId).budget_id, "a held job must not be moved off its run").toBe(
        first.budgetId,
      );
    }

    // 운영자가 설정을 고친다 — 하나만 해제되고, 다른 하나는 hold 상태로 남는다.
    expect(releaseHeldJobs(db, "model_config_rejected")).toBe(1);
    const wake = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(13 * 60_000),
      lanePending: false,
    });
    expect(wake.budgetId, "the live run is reused, not replaced").toBe(second.budgetId);
    expect(wake.state).toBe("active");
    expect(budgetCount()).toBe(2);
    expect(
      jobRow("job-capsule-1"),
      "a released job left on an older retired run can never be claimed again",
    ).toEqual({ budget_id: second.budgetId, state: "pending", hold_reason: null });
    expect(
      jobRow("job-capsule-held"),
      "a job that is still held stays on its own run",
    ).toEqual({
      budget_id: first.budgetId,
      state: "pending",
      hold_reason: "extraction_rules_invalid",
    });

    // The claim path agrees: the job resolves to the LIVE run and is not refused.
    const peeked = peekResolvedModelBudget(db, { jobId: "job-capsule-1" });
    expect("budget" in peeked && peeked.budget.budgetId).toBe(second.budgetId);
    expect(
      findExhaustedModelBudgetForClaim(db, {
        jobId: "job-capsule-1",
        parentWaveId: "maintenance",
        now: at(14 * 60_000),
      }),
      "a job on the live run must not be refused",
    ).toBeNull();
  });

  /**
   * 🚨 이슈 #180-2 — pending/idle 교대가 wake 마다 run 을 찍어냈다.
   *
   * 큐가 비면 run 은 `completed` 로 은퇴하고, 몇 분 뒤 레인 작업이 다시 나타나면
   * (미소비 은퇴 run 은 쿨다운을 건너뛰도록 설계됐으므로) 즉시 **새** run 이
   * 열렸다. 3분 wake 간격에서 작업이 교대하면 0/6/12분에 run 이 열려 하루 240개,
   * 모델 호출 0회다. 데드라인이 아직 열려 있고 아무것도 소비되지 않았다면 같은
   * run 을 다시 `active` 로 되돌려 쓴다(같은 id, 같은 원장).
   */
  it("reopens the completed unspent run in place while its deadline is open", () => {
    const drained = drainedToCompleted();

    const reopened = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(3 * 60_000),
      lanePending: true,
    });
    expect(
      reopened.budgetId,
      "an open, unspent run must be reused instead of minting the next one",
    ).toBe(drained.budgetId);
    expect(reopened.state).toBe("active");
    expect(reopened.runSeq).toBe(1);
    expect(reopened.parentWaveId).toBe("maintenance");
    expect(budgetCount()).toBe(1);
    // 같은 원장: 생성 시각은 그대로, updated_at 만 움직인다.
    expect(reopened.createdAt).toBe(drained.createdAt);
    expect(Date.parse(reopened.updatedAt)).toBeGreaterThanOrEqual(Date.parse(drained.updatedAt));
    expect(reopened.maxAttempts).toBe(drained.maxAttempts);
    expect(reopened.deadlineAt).toBe(drained.deadlineAt);
  });

  it("mints the next run once the completed run's deadline has passed", () => {
    const runOne = { maxAttempts: 8, deadlineAt: at(10 * 60_000).toISOString() };
    const drained = drainedToCompleted(runOne);

    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(11 * 60_000),
      lanePending: true,
    });
    expect(
      rolled.budgetId,
      "a run whose window has ended cannot be reused: its deadline fences the spend",
    ).not.toBe(drained.budgetId);
    expect(rolled.state).toBe("active");
    expect(rolled.runSeq).toBe(2);
    expect(budgetCount()).toBe(2);
    expect(budgetRow(drained.budgetId).state).toBe("completed");
  });

  it("pending/idle alternation inside one deadline mints no run at all", () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    expect(first.state).toBe("active");

    // 리뷰어가 관측한 모양: 3분 wake 간격에서 레인 작업이 교대한다.
    for (let wake = 1; wake <= 5; wake++) {
      const lanePending = wake % 2 === 1;
      const seen = getOrCreateAutomaticMaintenanceModelBudget(db, {
        parentWaveId: "maintenance",
        limits,
        now: at(wake * 3 * 60_000),
        lanePending,
      });
      expect(seen.budgetId, `wake ${wake}`).toBe(first.budgetId);
      expect(seen.state, `wake ${wake}`).toBe(lanePending ? "active" : "completed");
    }
    expect(
      budgetCount(),
      "one deadline window is one run, however often the queue empties",
    ).toBe(1);
  });

  /**
   * 🚨 이슈 #184 — hold 중에도 pending `model_work_targets` 가 run 을 찍어냈다.
   *
   * hold 중인 `memory_jobs` 는 #177 부터 제외되지만, `model_work_targets` 의
   * `pending` 행(ontology/consolidation/relation)에는 hold 표시가 없어서 계속
   * `jobsPending` 으로 집계됐다. 그래서 provider 가 모델 설정을 거절해 hold 가
   * 걸린 상태에서도 15분 데드라인마다 run 이 새로 열렸다 — target 만 끌고 다니는
   * run 이 시간당 4개, 하루 96개, 모델 호출은 0회(#177/#180 이 job 에 대해 닫은
   * churn 이 target 으로 되돌아온 것).
   *
   * hold 는 아래 모델 레인 전부를 건너뛰므로, hold 중에는 wave 자체가 움직이지
   * 않아야 한다: 은퇴도, 재개방도, 롤오버도, 입양도 없이 `latest` 그대로.
   */
  const pendingConsolidationFact = (factId: string) => {
    db.prepare(`
      INSERT INTO facts
        (id, fact, category, scope_type, scope_project, source_exchange_ids,
         created_at, updated_at, needs_consolidation)
      VALUES (?, 'a fact the consolidation lane still owes work on', 'knowledge',
              'project', '/project', '[]', ?, ?, 1)
    `).run(factId, T0.toISOString(), T0.toISOString());
  };

  it("a model-config hold freezes the wave: a pending target cannot mint a run", () => {
    // run 1: 10분 데드라인 — hold 중 wake 가 이 창을 넘긴다.
    const runOne = { maxAttempts: 8, deadlineAt: at(10 * 60_000).toISOString() };
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: runOne,
      now: T0,
    });
    expect(first.state).toBe("active");
    // 온톨로지/통합 워커가 등록해 둔 파생 작업. hold 표시를 가질 수 없는 행이다.
    pendingConsolidationFact("fact-held-1");
    expect(
      registerModelWorkTargets(db, {
        budgetId: first.budgetId,
        stage: "consolidation",
        targetIds: ["fact-held-1"],
        now: T0,
      }),
    ).toBe(1);

    // 데드라인이 지난 뒤의 wake — hold 가 살아 있다.
    const held = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(11 * 60_000),
      lanePending: false,
      holdActive: true,
    });
    expect(
      held.budgetId,
      "a held wave must not mint a run that the same hold skips every lane of",
    ).toBe(first.budgetId);
    expect(budgetCount()).toBe(1);

    // 15분 뒤의 다음 wake도 마찬가지다 — 시간당 4개가 아니라 0개.
    const heldAgain = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(26 * 60_000),
      lanePending: false,
      holdActive: true,
    });
    expect(heldAgain.budgetId).toBe(first.budgetId);
    expect(budgetCount()).toBe(1);
    // target 은 원래 run 에 그대로 남는다(입양도 없다).
    expect(getModelWorkTargets(db, { budgetId: first.budgetId }).map((t) => t.targetId))
      .toEqual(["fact-held-1"]);

    // 운영자가 설정을 고친다 — 기존 롤오버가 그대로 run 2 를 열고 target 을 데려간다.
    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(27 * 60_000),
      lanePending: false,
      holdActive: false,
    });
    expect(rolled.budgetId).not.toBe(first.budgetId);
    expect(rolled.state).toBe("active");
    expect(rolled.runSeq).toBe(2);
    expect(budgetCount()).toBe(2);
    expect(
      getModelWorkTargets(db, { budgetId: rolled.budgetId }).map((t) => t.targetId),
      "the released hold must hand the target to the run that can drain it",
    ).toEqual(["fact-held-1"]);
  });

  it("a hold still mints the FIRST run, because the hook needs a budget id", () => {
    // 훅은 maintenanceBudget.budgetId 를 childEnv 로 넘긴다(scripts/session-start-
    // maintenance.js). 계보에 아무 run 도 없을 때는 hold 중에도 그 한 개는 열린다.
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
      lanePending: false,
      holdActive: true,
    });
    expect(first.budgetId).toBeTruthy();
    expect(first.state).toBe("active");
    expect(first.runSeq).toBe(1);
    expect(budgetCount()).toBe(1);
    // 그 다음부터는 얼어붙는다.
    const held = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
      lanePending: false,
      holdActive: true,
    });
    expect(held.budgetId).toBe(first.budgetId);
    expect(held.state, "a held wave is not even retired").toBe("active");
    expect(budgetCount()).toBe(1);
  });

  it("an active run with lane work is returned unchanged", () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    expect(first.state).toBe("active");

    const same = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
      lanePending: true,
    });
    expect(same.budgetId, "lane work must not mint a second run beside a live one").toBe(
      first.budgetId,
    );
    expect(same.state).toBe("active");
    expect(budgetCount()).toBe(1);
  });
});

/**
 * The wiring half of #175, on the real hook script: a drained `completed`
 * automatic budget plus a pending extraction SESSION must spawn
 * `backfill-extract-worker.js`. Slice pattern follows
 * `test/maintenance-prompt-wake.test.ts`: the script is copied into a temp root
 * whose `dist/` holds stubs, so nothing touches a real data root.
 */
describe("issue #175 — session-start-maintenance spawns the extract lane", () => {
  const roots: string[] = [];
  /** Generous by design: node startup on a loaded CI box is not a deadline. */
  const SPAWN_TIMEOUT_MS = 15_000;
  /** Headroom after the control child proves children have had their turn. */
  const SETTLE_MS = 2_000;

  afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * `configHold` stubs `currentModelConfigHold` to a live hold (issue #177
   * item 2). An explicit local export wins over `export *` for the same name,
   * so the rest of the real module is untouched.
   */
  const fixture = (sessionPending: boolean, configHold = false, pendingTarget = false) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-lane-slice-"));
    roots.push(root);
    const scripts = path.join(root, "scripts");
    const dist = path.join(root, "dist");
    // 🚨 The child runs the REAL hook, which reads the data root (models.json,
    // via `currentModelConfigHold`). Both roots therefore point INSIDE the
    // fixture: removing `MEMEX_HOME` would have let it read the developer's own
    // `~/.config/memex`.
    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg");
    for (const dir of [scripts, dist, home, xdg]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.copyFileSync(
      "scripts/session-start-maintenance.js",
      path.join(scripts, "session-start-maintenance.js"),
    );
    const dbFile = path.join(root, "state.sqlite");
    const budgetModule = pathToFileURL(path.resolve("dist/model-budget.js")).href;
    fs.writeFileSync(
      path.join(dist, "model-budget.js"),
      `export * from ${JSON.stringify(budgetModule)};${
        configHold
          ? `\nexport function currentModelConfigHold(){return{model:'held-fixture-model'};}`
          : ""
      }`,
    );
    fs.writeFileSync(
      path.join(dist, "db.js"),
      `import {createRequire} from 'node:module';
       const Database=createRequire(${JSON.stringify(path.resolve("package.json"))})('better-sqlite3');
       export function initDatabase(){const db=new Database(${JSON.stringify(dbFile)});db.pragma('busy_timeout=5000');return db;}`,
    );
    fs.writeFileSync(
      path.join(dist, "reembed-selector.js"),
      "export const buildCategoryReembedPending=()=>({}),buildFactReembedPending=()=>({}),buildReembedPending=()=>({});",
    );
    // The session-level extraction predicate: one pending session, or none.
    fs.writeFileSync(
      path.join(dist, "pending-extraction.js"),
      `export const getExtractionConfig=()=>({});
       export const pendingExtractionCoreQuery=()=>({sql:'SELECT 1 AS session_id WHERE ${sessionPending ? 1 : 0}',params:[]});`,
    );
    fs.writeFileSync(path.join(dist, "embeddings.js"), "export const EMBEDDING_VERSION='fixture';");
    fs.writeFileSync(path.join(dist, "observe-hook-event.js"), "export function recordHookEvent(){}");
    fs.writeFileSync(path.join(dist, "fact-management.js"), "export function reconcileFactTiers(){}");
    // The CONTROL spawn: sync export is gated only on this stub, so it fires on
    // every run, before the lane gates. It is the instrument's own positive
    // control — a run whose log holds this line was definitely being recorded.
    fs.writeFileSync(path.join(dist, "sync-paths.js"), "export const readSyncConfig=()=>({enabled:true});");
    const control = path.join(root, "control-spawned");
    fs.writeFileSync(
      path.join(scripts, "sync-export-hook.js"),
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(control)},'spawned');`,
    );
    // 🚨 The spawn LEDGER, so the negative case is a fact and not a wait.
    //
    // `spawnDetached` hands the child to the OS and unrefs it, so "no marker
    // file yet" can never prove "no spawn" — only that the child has not
    // written yet. This CJS preload patches `child_process` in the hook process
    // BEFORE its ESM entry is evaluated (the builtin's ESM facade reads the
    // CJS export when it is first evaluated, so the named `spawn` import the
    // hook holds is the patched one) and appends one line per call
    // SYNCHRONOUSLY, inside the same tick as the call. Once the hook process
    // has exited, the log is complete by construction: a spawn it never
    // recorded is a spawn it never made.
    const spawnLog = path.join(root, "spawn-log.jsonl");
    fs.writeFileSync(
      path.join(root, "spawn-log.cjs"),
      `const cp = require('node:child_process');
       const fs = require('node:fs');
       const LOG = ${JSON.stringify(spawnLog)};
       for (const name of ['spawn', 'spawnSync', 'fork']) {
         const real = cp[name];
         if (typeof real !== 'function') continue;
         cp[name] = function (file, args) {
           try {
             fs.appendFileSync(LOG, JSON.stringify({
               fn: name,
               file: String(file),
               args: Array.isArray(args) ? args.map(String) : [],
             }) + '\\n');
           } catch { /* the ledger must never break the run it observes */ }
           return real.apply(this, arguments);
         };
       }`,
    );
    const spawned = path.join(root, "spawned");
    fs.writeFileSync(
      path.join(scripts, "backfill-extract-worker.js"),
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(spawned)},process.env.MEMEX_MODEL_BUDGET_ID ?? '');`,
    );
    // The drained state: one automatic maintenance run, `completed`, no jobs.
    const seed = new Database(dbFile);
    try {
      ensureModelBudgetSchema(seed);
      const first = getOrCreateAutomaticMaintenanceModelBudget(seed, { parentWaveId: "maintenance" });
      seed
        .prepare("UPDATE model_work_budgets SET state = 'completed', automatic = 1 WHERE budget_id = ?")
        .run(first.budgetId);
      // 이슈 #184: 파생 target 하나가 예산에 매달린, 데드라인이 지난 run.
      // hold 표시를 가질 수 없는 행이므로 예전 코드에서는 매 wake 마다 run 이
      // 새로 열렸다(시간당 4개).
      if (pendingTarget) {
        seed.exec(`
          CREATE TABLE IF NOT EXISTS facts (
            id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1,
            ontology_category_id TEXT, needs_consolidation INTEGER NOT NULL DEFAULT 1
          );
          INSERT INTO facts(id) VALUES ('fact-held-slice');
        `);
        registerModelWorkTargets(seed, {
          budgetId: first.budgetId,
          stage: "consolidation",
          targetIds: ["fact-held-slice"],
        });
        seed
          .prepare("UPDATE model_work_budgets SET deadline_at = ? WHERE budget_id = ?")
          .run(new Date(Date.now() - 60 * 60_000).toISOString(), first.budgetId);
      }
    } finally {
      seed.close();
    }
    return { root, scripts, spawned, control, spawnLog, dbFile, home, xdg };
  };

  /** Runs the hook to completion; every path it can read stays in the fixture. */
  const runHook = async (f: ReturnType<typeof fixture>) => {
    // A regression here would point the real hook at a real data root, so it is
    // asserted, not just intended.
    expect(f.home.startsWith(os.tmpdir()) && f.xdg.startsWith(os.tmpdir())).toBe(true);
    const run = promisify(execFile);
    // `--require` on argv, not NODE_OPTIONS: the shim then observes THIS process
    // only, instead of being inherited by every worker it spawns.
    const out = await run(process.execPath, [
      "--require",
      path.join(f.root, "spawn-log.cjs"),
      path.join(f.scripts, "session-start-maintenance.js"),
    ], {
      timeout: 60_000,
      env: {
        ...process.env,
        MEMEX_HOME: f.home,
        XDG_CONFIG_HOME: f.xdg,
        MEMEX_DB_PATH: f.dbFile,
        MEMEX_MODEL_BUDGET_ID: undefined,
        MEMEX_MAINTENANCE_WAVE_ID: undefined,
      } as NodeJS.ProcessEnv,
    });
    expect(out.stdout).toBe("");
    return out;
  };

  /** Every script the hook process actually handed to `child_process`. */
  const spawnedScripts = (f: ReturnType<typeof fixture>): string[] =>
    (fs.existsSync(f.spawnLog) ? fs.readFileSync(f.spawnLog, "utf8") : "")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => (JSON.parse(line) as { args: string[] }).args)
      .map((arg) => path.basename(arg));

  const waitFor = async (file: string, timeoutMs = SPAWN_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return fs.existsSync(file);
  };

  it("reopens the drained wave and spawns the worker for a pending session", async () => {
    const f = fixture(true);
    await runHook(f);
    // Primary: the hook's own spawn ledger, complete once it has exited.
    expect(
      spawnedScripts(f),
      "a pending extraction session must spawn backfill-extract-worker.js",
    ).toContain("backfill-extract-worker.js");
    // Secondary: the child really ran. Generous — node startup is not a deadline.
    expect(await waitFor(f.spawned), "the spawned worker must reach the disk").toBe(true);
    const check = new Database(f.dbFile);
    try {
      // 이슈 #180-2: 시드된 run 은 미소비이고 15분 데드라인이 아직 열려 있으므로
      // 다음 run 이 아니라 **같은 run** 이 다시 `active` 가 된다 — 행은 하나뿐이다.
      expect(check.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get()).toEqual({ n: 1 });
      expect(
        check
          .prepare("SELECT state, run_seq FROM model_work_budgets ORDER BY run_seq DESC LIMIT 1")
          .get(),
      ).toEqual({ state: "active", run_seq: 1 });
      // The child is bound to the run the hook just opened.
      expect(fs.readFileSync(f.spawned, "utf8")).toBe(
        (check.prepare("SELECT budget_id FROM model_work_budgets WHERE state = 'active'").get() as {
          budget_id: string;
        }).budget_id,
      );
    } finally {
      check.close();
    }
  });

  it("stays drained when no session is pending", async () => {
    const f = fixture(false);
    // The hook process has fully exited, so its spawn ledger is final: no
    // polling, no settle, nothing left that could still append to it.
    await runHook(f);
    const spawns = spawnedScripts(f);
    // The instrument's positive control: this run WAS being recorded.
    expect(spawns, "the ledger must prove it was recording").toContain("sync-export-hook.js");
    expect(spawns, "no pending session means no extract worker, ever").not.toContain(
      "backfill-extract-worker.js",
    );
    // Belt and braces: nothing reached the disk either, after a generous settle.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(fs.existsSync(f.spawned)).toBe(false);
    const check = new Database(f.dbFile);
    try {
      expect(check.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get()).toEqual({ n: 1 });
    } finally {
      check.close();
    }
  });

  /**
   * 🚨 이슈 #184 — hold 아래에서 파생 target 이 run 을 찍어내는 것을 훅에서 막는다.
   *
   * 훅은 이미 mint 전에 `currentModelConfigHold` 를 읽는다(#177 항목 2). 그 결과를
   * `lanePending: false` 로만 넘기면 큐 쪽 절반이 남는다: `model_work_targets` 의
   * pending 행에는 hold 표시가 없으므로, 데드라인이 지난 run 은 wake 마다 롤오버해
   * target 만 새 run 으로 끌고 다녔다(시간당 4개, 모델 호출 0회). 그래서 훅은
   * `holdActive` 도 넘기고, hold 동안 wave 는 얼어붙는다.
   *
   * wake 게이트(`claimMaintenanceWake`)는 3분에 한 번만 통과시키므로, 두 번째
   * wake 를 만들려면 그 행을 과거로 되돌린다 — 훅을 두 번 돌리고 행이 하나인지 본다.
   */
  it("a held wave mints no run for a pending derived target, wake after wake", async () => {
    const f = fixture(false, true, true);
    await runHook(f);
    // 두 번째 wake: 3분 합치기 게이트를 과거로 되돌린다.
    const reset = new Database(f.dbFile);
    try {
      reset.prepare("UPDATE model_maintenance_wake SET wake_after = ?")
        .run(new Date(Date.now() - 60 * 60_000).toISOString());
    } finally {
      reset.close();
    }
    await runHook(f);

    const check = new Database(f.dbFile);
    try {
      expect(
        check.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get(),
        "a pending target under a live hold must not open a single run",
      ).toEqual({ n: 1 });
      expect(
        check
          .prepare("SELECT state, run_seq FROM model_work_budgets ORDER BY run_seq DESC LIMIT 1")
          .get(),
        "the frozen run is not even retired or reopened",
      ).toEqual({ state: "completed", run_seq: 1 });
      // target 은 원래 run 에 그대로 남아, hold 가 풀린 첫 wake 를 기다린다.
      expect(
        check.prepare("SELECT COUNT(*) AS n FROM model_work_targets WHERE state = 'pending'").get(),
      ).toEqual({ n: 1 });
    } finally {
      check.close();
    }
    // 그리고 아무 모델 워커도 뜨지 않는다.
    const spawns = spawnedScripts(f);
    expect(spawns, "the ledger must prove it was recording").toContain("sync-export-hook.js");
    expect(spawns).not.toContain("backfill-ontology-worker.js");
    expect(spawns).not.toContain("fact-consolidate-worker.js");
  });

  /**
   * Issue #177 item 2 — a model-config hold must not mint a run either.
   *
   * The hold was read AFTER the mint, so a drained `completed` automatic budget
   * plus one pending session opened a brand-new run on every wake past the
   * 15-minute deadline (4/hour, 96/day) that no worker would ever use: the same
   * hold then skipped every model lane the run existed for. The hold already
   * stops the model lanes, so the wave must not be held open for them.
   */
  it("a model-config hold mints no run for lane work, and spawns no worker", async () => {
    const f = fixture(true, true);
    await runHook(f);
    const spawns = spawnedScripts(f);
    // The instrument's positive control: this run WAS being recorded.
    expect(spawns, "the ledger must prove it was recording").toContain("sync-export-hook.js");
    expect(
      spawns,
      "a held model lane must not spawn the extract worker",
    ).not.toContain("backfill-extract-worker.js");
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(fs.existsSync(f.spawned)).toBe(false);
    const check = new Database(f.dbFile);
    try {
      expect(
        check.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get(),
        "a held wave must not mint a run no worker can use",
      ).toEqual({ n: 1 });
      expect(
        check
          .prepare("SELECT state, run_seq FROM model_work_budgets ORDER BY run_seq DESC LIMIT 1")
          .get(),
      ).toEqual({ state: "completed", run_seq: 1 });
    } finally {
      check.close();
    }
  });
});
