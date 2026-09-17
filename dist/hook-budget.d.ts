export declare const HOOK_BUDGET_MS = 2000;
export declare const HOOK_BUDGET_PRECOMPACT_MS = 3800;
/** A second bounded attempt (the capture-gap row) needs at least this much. */
export declare const HOOK_RETRY_FLOOR_MS = 150;
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
export declare function isSqliteBusyError(error: unknown): boolean;
