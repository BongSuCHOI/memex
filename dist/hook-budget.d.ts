/**
 * The host timeout each event's continuity entry is registered with, in ms.
 *
 * Must equal hooks.json and the doctor's LIFECYCLE_COMMANDS table — a test pins
 * all three together (#166), because a budget derived from a timeout the host
 * does not actually grant is worse than no budget at all.
 */
export declare const HOOK_HOST_TIMEOUT_MS: Record<string, number>;
/** Events with no entry above (and UserPromptSubmit, which has no host timer). */
export declare const HOOK_HOST_TIMEOUT_DEFAULT_MS = 10000;
/**
 * The only slack between the budget and the host's timer: process exit, not work.
 *
 * It is also the margin every lock wait leaves behind, so a wait can never end
 * after the deadline it was derived from.
 *
 * 300 ms, not 150: the done row lands AT the deadline by design, and node's own
 * teardown after it measured ~200 ms, so a SessionEnd or Interrupt hook against a
 * 3 s host cap was observed exiting at 2,916 ms — 84 ms from a kill. The margin
 * covers what happens after the budget, so it has to cover that.
 */
export declare const HOOK_EXIT_MARGIN_MS = 300;
/** The host timeout for an event, in ms. */
export declare function hookHostTimeoutMs(hookEventName: string): number;
export declare const HOOK_BUDGET_MS: number;
export declare const HOOK_BUDGET_PRECOMPACT_MS: number;
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
export declare const HOOK_INGEST_RESERVE_MS = 100;
/** Total budget for one hook invocation, `MEMEX_HOOK_BUDGET_MS`-overridable. */
export declare function hookBudgetMs(hookEventName: string): number;
/** `MEMEX_HOOK_INGEST_BYTES_PER_MS` override for the oversize pre-check. */
export declare function hookIngestBytesPerMs(): number;
/** The busy_timeout one DB wait may use, derived from what is left. */
export declare function busyTimeoutForRemaining(remainingMs: number): number;
/** Why a pending delta may not be ingested now. */
export type IngestFit = {
    ok: true;
} | {
    ok: false;
    reason: "deadline" | "oversize";
    detail: string;
};
/**
 * Issue #166 — can this delta be ingested inside what is LEFT of the budget?
 *
 * The two answers are different diagnoses and must not be confused. `oversize`
 * says the transcript is too large for a healthy budget; `deadline` says there
 * is no budget left, whatever the size. The 0.7.24 pre-check subtracted the
 * reserve from the remaining time and compared the result to the ingest
 * estimate, so a budget that was already gone came back as `oversize`: the work
 * Mac's SessionEnd reported "132399 pending bytes exceed the remaining 267 ms
 * hook budget" for 6.6 ms of ingest, because 267 - 300 is negative. The reserve
 * is headroom, not a size limit — when less than the reserve remains, the
 * outcome is the deadline.
 */
export declare function ingestFitsBudget(bytesToIngest: number, remainingMs: number, bytesPerMs?: number): IngestFit;
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
/**
 * Issue #168 — a capture event whose payload carries no `transcript_path`.
 *
 * `codex exec --ephemeral` sessions have no transcript file, so their
 * Stop/Interrupt/PreCompact/SessionEnd payload has no path. There is nothing to
 * capture and nothing left uncaptured, which is NOT the same thing as a capture
 * that was skipped: 0.7.24/0.7.25 recorded `outcome: "error"`, kept the intent
 * marker, and `memex doctor` reported eleven ephemeral review runs as skipped
 * captures with "0 uncaptured bytes" for thirty days.
 *
 * Its own class so the hook can end as `no-transcript` (an ok-class outcome, no
 * marker, no capture-gap row) while `MEMEX_STRICT_CAPTURE=1` still throws.
 */
export declare class HookCaptureNoTranscript extends Error {
    readonly code = "MEMEX_HOOK_NO_TRANSCRIPT";
    constructor(message?: string);
}
/** Mark an error so a caller does not spend a second lock wait on the same gap. */
export declare function markCaptureGapRecorded(error: unknown): void;
export declare function captureGapAlreadyRecorded(error: unknown): boolean;
export declare function isSqliteBusyError(error: unknown): boolean;
