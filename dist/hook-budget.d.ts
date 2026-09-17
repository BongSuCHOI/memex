export declare const HOOK_BUDGET_MS = 2000;
export declare const HOOK_BUDGET_PRECOMPACT_MS = 3800;
/** A second bounded attempt (the capture-gap row) needs at least this much. */
export declare const HOOK_RETRY_FLOOR_MS = 150;
/**
 * The floor a PHASE needs before it may start at all.
 *
 * The budget is re-read at the entry of every phase and before every lock wait,
 * because one busy_timeout chosen at connect time bounds only the first wait:
 * the second, third and fourth lock acquisition each get the whole timeout
 * again, and the hook-wide deadline it was derived from is long gone by then.
 * Starting a phase with less than this left cannot finish it and can only spend
 * someone else's lock time, so the phase is skipped with outcome "deadline".
 */
export declare const HOOK_PHASE_FLOOR_MS = 150;
/** Assumed ingest throughput for the oversize pre-check, bytes per millisecond. */
export declare const HOOK_INGEST_BYTES_PER_MS = 20000;
/** Headroom subtracted from the remaining budget by the oversize pre-check. */
export declare const HOOK_INGEST_RESERVE_MS = 300;
/** Total budget for one hook invocation, `MEMEX_HOOK_BUDGET_MS`-overridable. */
export declare function hookBudgetMs(hookEventName: string): number;
/** `MEMEX_HOOK_INGEST_BYTES_PER_MS` override for the oversize pre-check. */
export declare function hookIngestBytesPerMs(): number;
/** The busy_timeout one DB wait may use, derived from what is left. */
export declare function busyTimeoutForRemaining(remainingMs: number): number;
/** The hook ran out of its own budget; the caller must not commit anything. */
export declare class HookDeadlineExceeded extends Error {
    readonly code = "MEMEX_HOOK_DEADLINE";
    constructor(message?: string);
}
/** The pending transcript delta cannot be ingested inside the budget. */
export declare class HookOversizeCapture extends Error {
    readonly code = "MEMEX_HOOK_OVERSIZE";
    constructor(message?: string);
}
/**
 * The capture failed for an ORDINARY reason (not BUSY, not the budget): the
 * transcript did not match, the journal was damaged, a guard rejected it.
 *
 * Wrapping it distinguishes "the hook completed" from "the hook returned a
 * warning", which the 0.7.24 first pass could not tell apart — it deleted the
 * intent marker and recorded outcome `ok` for a capture that never happened.
 */
export declare class HookCaptureFailed extends Error {
    readonly code = "MEMEX_HOOK_CAPTURE_FAILED";
    readonly cause: unknown;
    constructor(cause: unknown);
}
/** Mark an error so a caller does not spend a second lock wait on the same gap. */
export declare function markCaptureGapRecorded(error: unknown): void;
export declare function captureGapAlreadyRecorded(error: unknown): boolean;
export declare function isSqliteBusyError(error: unknown): boolean;
