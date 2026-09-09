import Database from "better-sqlite3";
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
export declare function getModelWorkContext(): ModelWorkContext | undefined;
/** Run work with context merged into the current async context. */
export declare function withModelWorkContext<T>(context: Partial<ModelWorkContext>, fn: () => T | Promise<T>): Promise<T>;
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
 */
export declare function startNewModelWorkRunForBudget(db: Database.Database, input: {
    budgetId: string;
    parentWaveId?: string;
    limits?: Partial<ModelBudgetLimits>;
    now?: Date;
    automatic?: boolean;
}): ModelWorkRunResumeResult;
/**
 * Release a claimed queue item because its parent model budget is exhausted.
 * This transition intentionally does not increment queue attempts, move a
 * cursor, or mark a target dead. The scheduler filters the exhausted budget
 * until bounded automatic maintenance or an explicit operator run rebinds it.
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
}
export interface ModelWorkStageDiagnostics {
    stage: string;
    reserved: number;
    completed: number;
    failed: number;
    unknown: number;
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
