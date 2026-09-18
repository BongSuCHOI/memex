// Issue #162 — ONE hook-wide deadline, not a per-connection busy_timeout.
//
// The host kills a continuity hook when its timeout expires and every hook
// connection used to wait on the 5 s sqlite default, so a lock held for 2 s
// turned into "Hook failed — hook timed out after 3s" instead of a bounded,
// logged skip. The budget below covers EVERYTHING the process does after entry
// — stdin read, dist import, connection open and its migration pass, the
// capture transaction, the marker write.
//
// Issue #166 — the budget is now DERIVED from the event's host timeout instead
// of being a hand-tuned number under it. 0.7.24 spent 2,000 ms of a 3 s timeout
// and kept 1 s of slack for an exit that costs tens of ms; on a machine whose
// fixed cost before the first database call is 1.45-1.9 s (node start, dist
// import, the DB open with its migration pass, the marker fsync) that budget was
// gone before the capture phase, with `db_wait_ms: 0`. So the manifest asks the
// host for the larger timeouts it allows (10 s, 15 s for PreCompact; SessionEnd
// is clamped to 3 s and warns above it) and the budget is that timeout minus ONE
// fixed exit margin. Generous by design: the budget exists to stop a hook from
// handing the host a timeout, not to make capture fail sooner.
//
// Kept in its own leaf module (no database import) so `memex doctor` can state
// the same budget it diagnoses against without pulling better-sqlite3 in.
/**
 * The host timeout each event's continuity entry is registered with, in ms.
 *
 * Must equal hooks.json and the doctor's LIFECYCLE_COMMANDS table — a test pins
 * all three together (#166), because a budget derived from a timeout the host
 * does not actually grant is worse than no budget at all.
 */
export const HOOK_HOST_TIMEOUT_MS = {
    SessionStart: 10_000,
    Stop: 10_000,
    PostCompact: 10_000,
    PreCompact: 15_000,
    // learn.chatgpt.com/docs/hooks: SessionStart, Stop, PreCompact, PostCompact,
    // UserPromptSubmit and the tool hooks default to 600 s and accept up to 600 s.
    // ONLY SessionEnd and Interrupt default to 1 s and accept at most 3 s, so
    // these two keep the small budget however generous the others become — asking
    // for more would be a budget the host never granted, and a hook killed
    // mid-capture is the failure the budget exists to prevent (#166 review).
    Interrupt: 3_000,
    SessionEnd: 3_000,
};
/** Events with no entry above (and UserPromptSubmit, which has no host timer). */
export const HOOK_HOST_TIMEOUT_DEFAULT_MS = 10_000;
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
export const HOOK_EXIT_MARGIN_MS = 300;
/** The host timeout for an event, in ms. */
export function hookHostTimeoutMs(hookEventName) {
    return HOOK_HOST_TIMEOUT_MS[hookEventName] ?? HOOK_HOST_TIMEOUT_DEFAULT_MS;
}
export const HOOK_BUDGET_MS = HOOK_HOST_TIMEOUT_DEFAULT_MS - HOOK_EXIT_MARGIN_MS;
export const HOOK_BUDGET_PRECOMPACT_MS = HOOK_HOST_TIMEOUT_MS.PreCompact - HOOK_EXIT_MARGIN_MS;
/** Never spend more than this on a single lock wait, whatever remains. */
const HOOK_MAX_SINGLE_WAIT_MS = 2_500;
/** A second bounded attempt (the capture-gap row) needs at least this much. */
export const HOOK_RETRY_FLOOR_MS = 150;
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
export const HOOK_PHASE_FLOOR_MS = 150;
/** Assumed ingest throughput for the oversize pre-check, bytes per millisecond. */
export const HOOK_INGEST_BYTES_PER_MS = 20_000;
/** Headroom subtracted from the remaining budget by the oversize pre-check. */
export const HOOK_INGEST_RESERVE_MS = 100;
function positiveEnvInt(name) {
    const raw = process.env[name];
    if (raw === undefined)
        return null;
    const text = String(raw).trim();
    if (!/^\d+$/.test(text))
        return null;
    const parsed = Number.parseInt(text, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
/** Total budget for one hook invocation, `MEMEX_HOOK_BUDGET_MS`-overridable. */
export function hookBudgetMs(hookEventName) {
    return (positiveEnvInt("MEMEX_HOOK_BUDGET_MS") ??
        hookHostTimeoutMs(hookEventName) - HOOK_EXIT_MARGIN_MS);
}
/** `MEMEX_HOOK_INGEST_BYTES_PER_MS` override for the oversize pre-check. */
export function hookIngestBytesPerMs() {
    return positiveEnvInt("MEMEX_HOOK_INGEST_BYTES_PER_MS") ?? HOOK_INGEST_BYTES_PER_MS;
}
/** The busy_timeout one DB wait may use, derived from what is left. */
export function busyTimeoutForRemaining(remainingMs) {
    return Math.max(0, Math.min(remainingMs - HOOK_EXIT_MARGIN_MS, HOOK_MAX_SINGLE_WAIT_MS));
}
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
export function ingestFitsBudget(bytesToIngest, remainingMs, bytesPerMs = hookIngestBytesPerMs()) {
    if (remainingMs < HOOK_INGEST_RESERVE_MS) {
        return {
            ok: false,
            reason: "deadline",
            detail: `hook budget exhausted before the capture could start (${Math.max(0, Math.round(remainingMs))} ms left, ${HOOK_INGEST_RESERVE_MS} ms reserved)`,
        };
    }
    const usableMs = remainingMs - HOOK_INGEST_RESERVE_MS;
    const estimateMs = Math.max(0, bytesToIngest) / bytesPerMs;
    if (estimateMs > usableMs) {
        return {
            ok: false,
            reason: "oversize",
            detail: `${bytesToIngest} pending bytes need about ${Math.round(estimateMs)} ms and only ${Math.round(usableMs)} ms of the hook budget is usable`,
        };
    }
    return { ok: true };
}
/** The hook ran out of its own budget; the caller must not commit anything. */
export class HookDeadlineExceeded extends Error {
    code = "MEMEX_HOOK_DEADLINE";
    constructor(message = "hook budget exhausted before the capture committed") {
        super(message);
        this.name = "HookDeadlineExceeded";
    }
}
/** The pending transcript delta cannot be ingested inside the budget. */
export class HookOversizeCapture extends Error {
    code = "MEMEX_HOOK_OVERSIZE";
    constructor(message = "transcript delta is too large for the remaining hook budget") {
        super(message);
        this.name = "HookOversizeCapture";
    }
}
/**
 * The capture failed for an ORDINARY reason (not BUSY, not the budget): the
 * transcript did not match, the journal was damaged, a guard rejected it.
 *
 * Wrapping it distinguishes "the hook completed" from "the hook returned a
 * warning", which the 0.7.24 first pass could not tell apart — it deleted the
 * intent marker and recorded outcome `ok` for a capture that never happened.
 */
export class HookCaptureFailed extends Error {
    code = "MEMEX_HOOK_CAPTURE_FAILED";
    cause;
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "HookCaptureFailed";
        this.cause = cause;
    }
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
export class HookCaptureNoTranscript extends Error {
    code = "MEMEX_HOOK_NO_TRANSCRIPT";
    constructor(message = "capture hook requires transcript_path") {
        super(message);
        this.name = "HookCaptureNoTranscript";
    }
}
/** Flag carried on an error whose capture gap has ALREADY been recorded. */
const CAPTURE_GAP_RECORDED = Symbol.for("memex.captureGapRecorded");
/** Mark an error so a caller does not spend a second lock wait on the same gap. */
export function markCaptureGapRecorded(error) {
    if (error && typeof error === "object") {
        try {
            error[CAPTURE_GAP_RECORDED] = true;
        }
        catch {
            /* frozen error objects simply lose the optimisation */
        }
    }
}
export function captureGapAlreadyRecorded(error) {
    return !!(error && typeof error === "object" &&
        error[CAPTURE_GAP_RECORDED] === true);
}
export function isSqliteBusyError(error) {
    const code = error?.code;
    if (typeof code === "string" && /^SQLITE_BUSY/.test(code))
        return true;
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /SQLITE_BUSY|database is locked|database table is locked/i.test(message);
}
