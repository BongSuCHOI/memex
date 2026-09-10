import Database from "better-sqlite3";
import { type LlmSelectionOverride } from "./model-settings.js";
/**
 * Durable accounting for model work.
 *
 * A budget is deliberately a small row plus an append-only attempt ledger. The
 * row is the authority for the cap; the ledger is only the privacy-safe
 * explanation of where that cap went. Prompts, model responses, and secrets
 * never enter either table.
 */
export declare const MODEL_BUDGET_SCHEMA_VERSION = 1;
export declare const MODEL_BUDGET_TABLE = "model_work_budgets";
export declare const MODEL_ATTEMPT_TABLE = "model_work_attempts";
/** Durable requested-target membership. This is separate from provider
 * attempts because a whole batch can be pending before its first await or
 * reservation. */
export declare const MODEL_TARGET_TABLE = "model_work_targets";
export declare const AUTOMATIC_MAINTENANCE_WINDOW_MS: number;
export declare const AUTOMATIC_MAINTENANCE_COOLDOWN_MS: number;
export declare const MAINTENANCE_WAKE_INTERVAL_MS: number;
/** Issue #31: an active hold nobody observes for this long is closed by TTL. */
export declare const MODEL_CONFIG_HOLD_TTL_MS: number;
/**
 * Issue #31 — `memory_jobs.hold_reason`. The value set lives here, in ONE
 * place, and both HOLD transitions validate against it so the check is not
 * scattered across the six call sites that use them.
 */
export declare const HOLD_REASONS: readonly ["model_config_rejected", "extraction_rules_invalid", "extraction_rules_unavailable"];
export type HoldReason = (typeof HOLD_REASONS)[number];
/**
 * Attempt outcomes that exist as EVIDENCE but are excluded from every budget
 * aggregate (reserved / used / exhausted, and the 24h automatic window).
 *
 * Adding a member here is the whole change needed to make a new "cost nothing"
 * outcome free: the SQL below is generated from this array rather than
 * hand-written per query.
 */
export declare const BUDGET_FREE_OUTCOMES: readonly ["config_rejected"];
export type BudgetFreeOutcome = (typeof BUDGET_FREE_OUTCOMES)[number];
export type ModelBudgetState = "active" | "exhausted" | "completed" | "cancelled";
export type ModelAttemptState = "reserved" | "completed" | "failed" | "unknown";
export type ModelBudgetExhaustionReason = "attempts" | "deadline" | "cancelled" | "window";
export type ModelWorkTargetState = "pending" | "completed" | "failed" | "cancelled";
export interface ModelBudgetLimits {
    maxAttempts: number;
    maxInputChars: number;
    maxOutputChars: number;
    deadlineAt: string | null;
}
export interface ModelWorkBudget {
    budgetId: string;
    parentWaveId: string;
    /**
     * 이슈 #42: rollover 계보의 ROOT. `parent_wave_id`에 `:run:<uuid>`를 계속
     * 이어붙이던 것이 rollover 1회당 41자씩 무한히 자랐고(실데이터에 이미 3단계
     * 중첩), 확장된 id가 환경변수로 자식 워커에 전파돼 또 붙었다. 계보는 이제
     * 문자열이 아니라 이 컬럼이다: 공유 rolling cap 조회의 기준이기도 하다.
     */
    rootWaveId: string;
    /** 이 root 안에서 몇 번째 run인지(1부터). `UNIQUE(root_wave_id, run_seq)`. */
    runSeq: number;
    state: ModelBudgetState;
    maxAttempts: number;
    reservedAttempts: number;
    maxInputChars: number;
    maxOutputChars: number;
    deadlineAt: string | null;
    createdAt: string;
    updatedAt: string;
    automatic: boolean;
}
export interface ModelWorkContext {
    /** Reuse the caller's already initialized connection when available. */
    db?: Database.Database;
    dbPath?: string;
    budgetId?: string;
    parentWaveId?: string;
    stage?: string;
    jobId?: string | null;
    targetId?: string | null;
}
export interface ModelAttemptReservation {
    attemptId: string;
    budgetId: string;
    parentWaveId: string;
    attemptNo: number;
    startedAt: string;
    deadlineAt: string | null;
    maxInputChars: number;
    maxOutputChars: number;
    remainingAttempts: number;
    remainingDeadlineMs: number | null;
}
export interface ModelWorkTargetMembership {
    membershipId: string;
    budgetId: string;
    parentWaveId: string;
    stage: string;
    targetId: string;
    jobId: string | null;
    state: ModelWorkTargetState;
    createdAt: string;
    updatedAt: string;
    reason: string | null;
}
export interface ModelWorkRunResumeResult {
    previousBudget: ModelWorkBudget;
    budget: ModelWorkBudget;
    reboundJobIds: string[];
    skippedJobIds: string[];
}
export interface FinishModelAttemptInput {
    attemptId: string;
    state: Exclude<ModelAttemptState, "reserved">;
    durationMs?: number | null;
    outputChars?: number | null;
    tokenUsage?: {
        input_tokens: number;
        output_tokens: number;
        cached_input_tokens?: number;
    } | null;
    tokenUsageStatus?: "observed" | "partial" | "NOT_PROVEN";
    errorClass?: string | null;
    errorMessage?: string | null;
    finishedAt?: string;
    /** Issue #31: the selection the provider ACTUALLY received, as observed by
     *  codex-exec. Absent leaves the reservation's intended values in place. */
    model?: string | null;
    reasoningEffort?: string | null;
}
export declare class ModelBudgetError extends Error {
    readonly code = "MEMEX_MODEL_BUDGET";
    readonly budgetId: string;
    readonly parentWaveId: string;
    readonly reason: ModelBudgetExhaustionReason;
    readonly pending = true;
    constructor(budgetId: string, parentWaveId: string, reason: ModelBudgetExhaustionReason, detail?: string);
}
export declare class ModelBudgetExhaustedError extends ModelBudgetError {
}
export declare class ModelBudgetInputLimitError extends Error {
    readonly code = "MEMEX_MODEL_INPUT_LIMIT";
    readonly pending = true;
    readonly inputChars: number;
    readonly maxInputChars: number;
    constructor(inputChars: number, maxInputChars: number);
}
export declare class ModelBudgetOutputLimitError extends Error {
    readonly code = "MEMEX_MODEL_OUTPUT_LIMIT";
    readonly pending = true;
    readonly outputChars: number;
    readonly maxOutputChars: number;
    constructor(outputChars: number, maxOutputChars: number);
}
export declare class ModelBudgetOutputSchemaError extends Error {
    readonly code = "MEMEX_MODEL_OUTPUT_SCHEMA";
    readonly pending = true;
    constructor(detail?: string);
}
export declare class ModelBudgetNotFoundError extends Error {
    readonly code = "MEMEX_MODEL_BUDGET_NOT_FOUND";
    constructor(budgetId: string);
}
export declare class ModelBudgetAffinityError extends Error {
    readonly code = "MEMEX_MODEL_BUDGET_AFFINITY";
    constructor(jobId: string, existing: string, requested: string);
}
/**
 * Issue #31 — an active config hold refused this call before it could reserve.
 *
 * Classified `'config'` by `classifyLlmError` (via `code`), so the caller takes
 * the same HOLD path a live provider rejection takes. The difference is cost:
 * this one spends NOTHING — no reservation, no provider call.
 */
export declare class ModelConfigHeldError extends Error {
    readonly code = "MEMEX_MODEL_CONFIG_HELD";
    readonly hold: ModelConfigHold;
    constructor(hold: ModelConfigHold);
}
export declare function getModelWorkContext(): ModelWorkContext | undefined;
/** Run work with context merged into the current async context. */
export declare function withModelWorkContext<T>(context: Partial<ModelWorkContext>, fn: () => T | Promise<T>): Promise<T>;
/**
 * 이슈 #42: wave 계보를 문자열이 아니라 컬럼으로 읽는다.
 *
 * 역사적으로 rollover는 `parent_wave_id`에 `:run:<uuid>`(41자)를 이어붙여
 * 표현했고 상한이 없었다. 실데이터에는 이미 3단계 중첩이 있었다:
 *   maintenance
 *   maintenance:run:f11b5103-…
 *   maintenance:run:f11b5103-…:run:7344dd28-…
 * 이 함수는 어떤 형태의 id에서도 ROOT를 뽑는다 — 옛 `:run:` 사슬과 새
 * `#<seq>` 접미사 둘 다. 환경변수로 옛 id를 물려받은 워커가 여전히 같은
 * 계보(=같은 rolling cap)로 해석되게 하는 것이 목적이다.
 */
export declare function rootWaveIdOf(parentWaveId: string): string;
/**
 * Additive, idempotent local telemetry migration. This is intentionally
 * separate from the Continuity schema version: budgets are operational state
 * and do not alter transcript/fact protocol meaning.
 */
export declare function ensureModelBudgetSchema(db: Database.Database): void;
export declare function modelBudgetLimitsFromEnv(now?: number): ModelBudgetLimits;
/**
 * Automatic ontology classification is an optional local-derived maintenance
 * lane. It is enabled by default; MEMEX_AUTO_ONTOLOGY=0 disables it. The manual ontology
 * backfill command remains available regardless of this switch.
 */
export declare function isAutomaticOntologyEnabled(): boolean;
/**
 * Register every requested derived target before the caller's first await.
 * Membership is intentionally independent of the attempt ledger: one batch
 * may own many targets while consuming one provider reservation, and a crash
 * before that reservation must still leave the targets attached to the same
 * durable wave.
 */
export declare function registerModelWorkTargets(db: Database.Database, input: {
    budgetId: string;
    stage: string;
    targetIds: string[];
    jobId?: string | null;
    now?: Date;
}): number;
/** Mark requested targets settled while preserving the row for diagnostics. */
export declare function settleModelWorkTargets(db: Database.Database, input: {
    budgetId: string;
    stage: string;
    targetIds: string[];
    state?: Exclude<ModelWorkTargetState, "pending">;
    reason?: string | null;
    now?: Date;
}): number;
/** Read target memberships for a budget in stable diagnostic order. */
export declare function getModelWorkTargets(db: Database.Database, filter?: {
    budgetId?: string;
    parentWaveId?: string;
    state?: ModelWorkTargetState;
}): ModelWorkTargetMembership[];
export declare function getModelWorkBudget(db: Database.Database, budgetId: string): ModelWorkBudget | null;
/**
 * Create or reuse a budget for one stable parent wave. Existing rows always
 * win, including exhausted rows; changing env limits cannot reset a run.
 */
export declare function getOrCreateModelWorkBudget(db: Database.Database, input: {
    parentWaveId: string;
    budgetId?: string;
    limits?: Partial<ModelBudgetLimits>;
}): ModelWorkBudget;
/** Explicit new run entrypoint. It never resets or mutates an older budget. */
export declare function startNewModelWorkRun(db: Database.Database, input?: {
    parentWaveId?: string;
    budgetId?: string;
    limits?: Partial<ModelBudgetLimits>;
}): ModelWorkBudget;
export declare function bindMemoryJobToBudget(db: Database.Database, input: {
    jobId: string;
    budgetId: string;
    parentWaveId?: string | null;
}): boolean;
/**
 * Explicit operator action for moving one pending job to a fresh budget run.
 * The expected old budget is checked so an operator cannot accidentally reset
 * a job that another process rebound concurrently. Queue attempts are reset
 * only by this explicit action; the previous provider-attempt ledger remains
 * attached to its original budget for auditability.
 */
export declare function rebindMemoryJobToBudget(db: Database.Database, input: {
    jobId: string;
    budgetId: string;
    expectedBudgetId?: string | null;
    now?: Date;
    /** Automatic continuation must preserve retry history and backoff. */
    automatic?: boolean;
}): boolean;
/** Start a fresh, explicitly named run for one pending job and rebind it. */
export declare function startNewModelWorkRunForJob(db: Database.Database, input: {
    jobId: string;
    parentWaveId?: string;
    limits?: Partial<ModelBudgetLimits>;
    now?: Date;
}): ModelWorkBudget;
/**
 * Explicitly start a fresh budget for one exhausted wave and move only queue
 * jobs that are still safe to retry. Running jobs remain bound to the old
 * budget; a lease-free CAS is used for every rebind so a concurrent worker
 * cannot be reset underneath an active claim.
 *
 * 🚨 Issue #14, belt and braces. A budget whose deadline/window has passed is
 * spent whatever its stored `state` says, so resume settles that first rather
 * than refusing the operator's only exit. It is the same transition every
 * other caller makes, so a budget that arrives here already `exhausted` — the
 * normal case — is unaffected. `state` alone still fences a genuinely live
 * budget: an `active` budget with time left is refused as before.
 */
export declare function startNewModelWorkRunForBudget(db: Database.Database, input: {
    budgetId: string;
    parentWaveId?: string;
    limits?: Partial<ModelBudgetLimits>;
    now?: Date;
    automatic?: boolean;
}): ModelWorkRunResumeResult;
/**
 * Pre-flight for a queue claim: would this job be handed a budget that is
 * already spent? Read-only whenever the budget is genuinely fine; when it is
 * not, it performs — and only then — the durable exhausted transition.
 *
 * 🚨 Issue #14. This check stands in for `reserveModelAttempt`, and the
 * reservation did not merely *report* exhaustion: it wrote the budget durably
 * to `exhausted` before throwing. Reporting without writing left budget
 * `15af9e61` `active` with a deadline hours in the past, so every foreground
 * backfill deferred and `model-work resume --new-run` refused the budget as
 * "still active" — no way out but an automatic wake. The transition goes
 * through the same `markModelBudgetExhausted` the reservation uses, so the
 * pre-flight cannot leave a state the reservation would not have left.
 *
 * 🚨 Issue #12. The extractor claimed a job (which burns one `attempts`), then
 * resolved its budget deep inside the model call, and only there discovered
 * that the budget's `deadline_at` had passed hours ago. `reserveModelAttempt`
 * throws *before* inserting a `model_work_attempts` row, so no provider call
 * ever happened — yet the claim's attempt was spent and
 * `deferMemoryJobForModelBudget` parked the job for a full hour. The fresh
 * budget minted seconds later by the same maintenance wake then had nothing
 * left to run. Resolving the budget *before* the claim keeps a dead budget
 * from ever reaching the extractor.
 *
 * Resolution mirrors `withResolvedModelWorkContext`: a bound job's durable
 * budget wins over any explicitly requested/environment budget. Nothing is
 * created here — an unbound job with no explicit budget returns null and takes
 * the normal lazy-creation path.
 */
export declare function findExhaustedModelBudgetForClaim(db: Database.Database, input: {
    jobId?: string | null;
    budgetId?: string | null;
    now?: Date;
}): {
    budgetId: string;
    parentWaveId: string;
    reason: ModelBudgetExhaustionReason;
} | null;
/**
 * Release a claimed queue item because its parent model budget is exhausted.
 * This transition intentionally does not increment queue attempts, move a
 * cursor, or mark a target dead. The scheduler filters the exhausted budget
 * until bounded automatic maintenance or an explicit operator run rebinds it.
 *
 * `claimedAt` opts into the issue-#12 safety net: when the budget died of a
 * `deadline`/`window` (i.e. wall-clock, not work) and this claim never
 * reserved a single provider attempt, the claim itself was a no-op, so the
 * attempt it consumed is refunded and the job returns to `pending` at `now`
 * instead of an hour out. An `attempts` exhaustion keeps the old contract:
 * that budget really was spent, and the backoff is the fence.
 */
export declare function deferMemoryJobForModelBudget(db: Database.Database, input: {
    jobId: string;
    budgetId?: string;
    parentWaveId?: string;
    owner: string;
    leaseGeneration: number;
    reason: ModelBudgetExhaustionReason;
    now?: Date;
    availableAt?: Date;
    /** Instant this claim was taken; enables the unspent-claim refund. */
    claimedAt?: Date;
}): boolean;
/**
 * Return one claimed job to "waiting on a configuration".
 *
 * Deliberately NOT `failMemoryJob`:
 *  - state is `'pending'`, not `'retry'` — a hold does not belong on the
 *    exponential backoff ladder, and `max_attempts` must never terminate it;
 *  - `available_at` is now, so the session after the fix picks it up at once;
 *  - attempts are REFUNDED (the claim bought nothing);
 *  - `checkpoints` and `capsule_checkpoint_state` are untouched — a hold is not
 *    a failure, and for Capsule work advancing anything here would step the
 *    evidence frontier and lose a fragment permanently.
 *
 * The CAS is byte-for-byte `failMemoryJob`'s, so a stale owner can never
 * overwrite a live claim. Returns false when it does not match.
 */
export declare function holdMemoryJob(db: Database.Database, input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    reason: HoldReason;
    detail: string;
    now?: Date;
}): boolean;
/**
 * Return a whole extraction claim — job + target + checkpoint marker.
 *
 * Acceptance criterion, asserted by the tests: across this transition
 * `memory_jobs.attempts` and `extraction_targets.attempts` are unchanged from
 * before the claim, both states are `pending`, `extraction_failures` and
 * `extraction_log` gain NO rows, and `checkpoints.state` is back off
 * `processing`. A hold that leaves a failed range behind is not a hold.
 */
export declare function releaseExtractionClaimOnHold(db: Database.Database, input: {
    targetId: string;
    jobId: string;
    owner: string;
    leaseGeneration: number;
    reason: HoldReason;
    detail: string;
    now?: Date;
}): boolean;
/**
 * Lift the hold marker so the next claim treats the job as ordinary work.
 *
 * Touches `hold_reason` and nothing else: the job is already `pending` with its
 * attempts refunded, and rewriting state/attempts here would undo that.
 */
export declare function clearJobHold(db: Database.Database, jobId: string): boolean;
/**
 * Lift every hold with THIS reason. Returns how many rows were lifted.
 *
 * Reason isolation is the point: a fixed model selection must not release jobs
 * that are waiting on a quarantined extraction rule, and vice versa. Each owner
 * releases only its own.
 */
export declare function releaseHeldJobs(db: Database.Database, reason: HoldReason): number;
/** Per-reason held-job counts for `memex status`, doctor and the Web UI. */
export declare function heldJobSummary(db: Database.Database): Array<{
    reason: HoldReason;
    jobs: number;
    oldestHeldAt: string | null;
}>;
export interface ModelConfigHold {
    fingerprint: string;
    heldAt: string;
    model: string;
    reasoningEffort: string | null;
    status: number | null;
    providerType: string | null;
    providerMessage: string;
    observedCount: number;
    lastObservedAt: string;
}
/**
 * Record (or re-observe) a hold for ONE selection fingerprint.
 *
 * "Exactly once per data root" is explicitly NOT promised: the hold is written
 * AFTER a rejection is observed, so calls already in flight each take one
 * rejection. The guarantee is the bound — the number of provider calls a wrong
 * setting can cause equals the number of calls already in flight when the hold
 * commits (measured 1-4 workers), and zero afterwards. Retry and splitting can
 * never add to it.
 */
export declare function recordModelConfigHold(db: Database.Database, input: {
    fingerprint: string;
    model: string;
    reasoningEffort: string | null;
    status: number | null;
    providerType: string | null;
    providerMessage: string;
    stage?: string | null;
    jobId?: string | null;
    now?: Date;
}): void;
/**
 * Note one more time this hold blocked work.
 *
 * The gate refuses a call without reaching the provider, so nothing else would
 * record it — yet "this selection has stopped work 14 times" is exactly what
 * doctor should be able to say, and it also keeps the 30-day TTL from closing a
 * hold that is actively fencing every session.
 */
export declare function touchModelConfigHold(db: Database.Database, fingerprint: string, now?: Date): void;
/** The active hold for THIS fingerprint, or null. Other fingerprints' rows are
 *  never read, updated or deleted here — that is the whole (b)5 fix. */
export declare function activeModelConfigHold(db: Database.Database, fingerprint: string): ModelConfigHold | null;
/** Close one fingerprint's hold. The row is kept (audit), never deleted. */
export declare function clearModelConfigHold(db: Database.Database, fingerprint: string, reason: "probe-ok" | "manual", now?: Date): boolean;
/**
 * Close every active hold for this model + reasoning pair, whatever SOURCE
 * recorded it, and report how many were closed.
 *
 * Lookups are fingerprint-scoped on purpose — that is what stops two processes
 * with different env from erasing each other's hold. A REPAIR is different: it
 * is deliberate and user-initiated ("this model works now"), and the user means
 * the model, not the path the id took to get here. Without this, a probe run as
 * `memex models test --model X` could never lift the hold that the same X
 * recorded through env or models.json, and the repair command would be unable to
 * repair anything.
 */
export declare function clearModelConfigHoldsForSelection(db: Database.Database, selection: {
    model: string;
    reasoningEffort: string | null;
}, reason: "probe-ok" | "manual", now?: Date): number;
/** Every active hold, flagged with whether it is the one blocking this process.
 *  Other selections' holds are visible but inert here. */
export declare function listModelConfigHolds(db: Database.Database, currentFingerprint?: string): Array<ModelConfigHold & {
    current: boolean;
}>;
/**
 * The hold (if any) blocking THIS process's current selection.
 *
 * A convenience for the pre-claim gates in the detached workers and the session
 * hook, which otherwise each have to import two modules to ask one question.
 */
export declare function currentModelConfigHold(db: Database.Database, overrides?: LlmSelectionOverride): ModelConfigHold | null;
/**
 * Settle a reservation the provider refused before any model work began.
 *
 * Four things together make a wrong setting cost ZERO budget: no retry (llm.ts),
 * this refund, exclusion from the 24h automatic window, and the claim refund
 * above. What remains is one evidence row and one hold row.
 *
 * The exhaustion release is the subtle half. `reserveModelAttempt` marks a
 * budget `exhausted` when it hands out the last attempt, and `budgetExhaustion`
 * treats that state as STICKY — so decrementing the counter alone does not
 * unblock anything. The release condition cannot look at the refunded row's own
 * `attempt_no` either: with `max_attempts=2`, if A reserves #1, B reserves #2
 * (exhausting it), B then completes and A is rejected, the reservation that
 * caused exhaustion was B's while the one being refunded is A's — the observed
 * result was `('exhausted', 1, 2)`. So it counts EFFECTIVE USAGE right now
 * instead, and deadline/cancelled exhaustion is never revived.
 */
export declare function settleConfigRejectedAttempt(db: Database.Database, input: {
    attemptId: string;
    durationMs?: number;
    errorClass?: string;
    now?: Date;
}): boolean;
/**
 * Atomically reserve one provider attempt immediately before runCodex. A
 * reservation is never returned to the pool: a crash after this point still
 * represents a possible provider attempt and must remain counted.
 */
export declare function reserveModelAttempt(db: Database.Database, input: {
    budgetId: string;
    stage?: string;
    jobId?: string | null;
    targetId?: string | null;
    inputChars: number;
    now?: Date;
    /** Issue #31: the selection this attempt INTENDS to use. Defaults to the
     *  resolved one; llm.ts passes a per-call override when it has one, and
     *  overwrites both with the selection actually sent at completion. */
    model?: string | null;
    reasoningEffort?: string | null;
}): ModelAttemptReservation;
export declare function finishModelAttempt(db: Database.Database, input: FinishModelAttemptInput): boolean;
/** Mark a known budget exhausted without reserving a synthetic provider call. */
export declare function exhaustModelBudget(db: Database.Database, input: {
    budgetId: string;
    reason: ModelBudgetExhaustionReason;
    now?: Date;
}): ModelBudgetExhaustedError;
export declare function isModelBudgetExhausted(error: unknown): error is ModelBudgetError;
export declare function modelBudgetErrorFromUnknown(error: unknown): ModelBudgetError | null;
/** One rolling cap across all automatic maintenance waves in this data root. */
export declare function automaticMaintenanceWindow(db: Database.Database, now?: Date): {
    maxAttempts: number;
    used: number;
    remaining: number;
    retryAt: string | null;
};
/** Coalesce prompt/startup wakeups before scanning queues; no model call. */
export declare function claimMaintenanceWake(db: Database.Database, now?: Date): boolean;
/**
 * SessionStart continuation. Selection, rollover and target moves are one
 * write transaction; simultaneous sessions cannot mint independent budgets.
 * Explicit worker/operator budgets retain their existing resume contract.
 */
export declare function getOrCreateAutomaticMaintenanceModelBudget(db: Database.Database, input?: {
    parentWaveId?: string;
    limits?: Partial<ModelBudgetLimits>;
    now?: Date;
}): ModelWorkBudget;
/** Stable budget used by the SessionStart maintenance sibling wave. */
export declare function getOrCreateMaintenanceModelBudget(db: Database.Database, input?: {
    parentWaveId?: string;
    limits?: Partial<ModelBudgetLimits>;
}): ModelWorkBudget;
/** Stable direct-worker budget; restart reuses its named wave. */
export declare function getOrCreateWorkerModelBudget(db: Database.Database, input: {
    stage: string;
    parentWaveId?: string;
    budgetId?: string;
    limits?: Partial<ModelBudgetLimits>;
}): ModelWorkBudget;
export interface ModelAttemptDiagnostic {
    attemptId: string;
    budgetId: string;
    parentWaveId: string;
    attemptNo: number;
    stage: string;
    jobId: string | null;
    targetId: string | null;
    state: ModelAttemptState;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    inputChars: number | null;
    outputChars: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    tokenUsageStatus: "observed" | "partial" | "NOT_PROVEN" | null;
    errorClass: string | null;
    errorMessage: string | null;
    /** Issue #31. `null` on rows recorded before this release. */
    model: string | null;
    reasoningEffort: string | null;
    /** `'config_rejected'` for an attempt excluded from budget accounting. */
    outcome: string | null;
}
export interface ModelWorkStageDiagnostics {
    stage: string;
    reserved: number;
    completed: number;
    failed: number;
    unknown: number;
    /** Issue #31: refused envelopes, reported apart from real failures. */
    configRejected: number;
    durationMs: number | null;
    inputChars: number | null;
    outputChars: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    tokenUsageObserved: number;
    tokenUsagePartial: number;
    tokenUsageUnknown: number;
}
export interface ModelWorkDiagnostics {
    automaticMaintenance?: ReturnType<typeof automaticMaintenanceWindow>;
    budgets: ModelWorkBudget[];
    attempts: ModelAttemptDiagnostic[];
    pending: Array<{
        stage: string;
        jobId: string | null;
        targetId: string | null;
        state: string;
        reason: string | null;
    }>;
    /** Derived backlog with no evidence tying it to the requested budget. */
    unassigned: Array<{
        stage: string;
        targetId: string;
        state: "pending";
        reason: string;
    }>;
    totals: {
        reserved: number;
        completed: number;
        failed: number;
        unknown: number;
        /** Issue #31: its own bucket, SUBTRACTED from `failed` — a refused envelope
         *  is not a failed model call and must not read as one. */
        configRejected: number;
        pending: number;
        durationMs: number | null;
        inputChars: number | null;
        outputChars: number | null;
        inputTokens: number | null;
        outputTokens: number | null;
        cachedInputTokens: number | null;
        tokenUsageObserved: number;
        tokenUsagePartial: number;
        tokenUsageUnknown: number;
        unassigned: number;
    };
    stages: ModelWorkStageDiagnostics[];
}
/** Read-only, content-free parent-wave → stage/job/target diagnostics. */
export declare function getModelWorkDiagnostics(db: Database.Database, filter?: {
    budgetId?: string;
    parentWaveId?: string;
}): ModelWorkDiagnostics;
export declare function formatModelWorkDiagnostics(diagnostics: ModelWorkDiagnostics): string;
/** Resolve a context's DB and budget, then run one bounded model operation. */
export declare function withResolvedModelWorkContext<T>(requested: Partial<ModelWorkContext>, fn: () => T | Promise<T>): Promise<T>;
