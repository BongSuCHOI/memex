/** Outcomes a hook may report on its done row. Never a host-timeout claim. */
export type HookOutcome = "ok" | "busy" | "oversize" | "deadline" | "error"
/**
 * #168 — a capture event (Stop/Interrupt/PreCompact/SessionEnd) whose payload
 * carried no `transcript_path`, as `codex exec --ephemeral` sessions do. The
 * hook completed and there was nothing to capture, so this is an ok-class
 * outcome: doctor must not count it as a skipped capture.
 */
 | "no-transcript" | "empty-prompt" | "daemon" | "fallback" | "skipped";
export declare function newInvocationId(): string;
export declare function dataRoot(): string;
export declare function observationLogPath(): string;
/**
 * Issue #26 (item 6) — `hook-events.jsonl` collected rows with
 * `event: "Unknown"` and empty session_id/cwd, because the CLI entry below
 * defaulted a missing `process.argv[2]` to the string "Unknown". `memex
 * doctor`'s `lifecycle-observed` then printed `Lifecycle Unknown: observed …`
 * beside seven real events whose own timestamps looked empty.
 *
 * An unlabeled call is not an observation: it says an unidentified hook ran at
 * some time, which no diagnosis can use. Such a call is refused (and the caller
 * is told) rather than written down.
 *
 * Returns whether a line was written.
 *
 * `info.detail` (issue #99) is for a MACHINE fact about the event that a later
 * diagnosis needs and cannot recover — an errno, a path length, a reason string
 * the code itself wrote. It is written only when it is a non-empty string, and it
 * must never carry user content; everything this log already refuses (prompts,
 * transcripts, facts) stays refused.
 */
export declare function recordHookEvent(event: string, info: {
    sessionId?: unknown;
    cwd?: unknown;
    detail?: unknown;
    /**
     * Issue #162 (R5). A hook that the host kills leaves no done row at all, so
     * the START row — written before any database access — is the only proof
     * the hook ran. `invocation_id` pairs the two rows and `pid` is what lets
     * doctor tell "killed by host" from "still running".
     */
    phase?: "start" | "done";
    invocationId?: unknown;
    pid?: unknown;
    outcome?: unknown;
    durationMs?: unknown;
    dbWaitMs?: unknown;
    /**
     * Issue #166 — process entry to just before the FIRST database call: node
     * start, dist import, the connection open with its migration pass. On the
     * machine that reported this it was 1.45-1.9 s, which is why a 2,000 ms
     * budget ran out with `db_wait_ms: 0`. A budget is unreadable without it.
     */
    startupMs?: unknown;
    /**
     * Issue #166 (final review) — WHERE an inject failure happened, because
     * `outcome: "error"` on a UserPromptSubmit row means three different things:
     * `receipt` (the context was delivered and only its recall receipt stayed
     * `prepared` — #44's documented fallback), `compute` (retrieval failed, so
     * nothing reached the user) and `startup` (the imports failed before any of
     * it). Doctor may not call the last two a delivered injection.
     */
    stage?: unknown;
    /** Whether this invocation actually wrote context to stdout. */
    contextDelivered?: unknown;
    error?: unknown;
}): boolean;
/**
 * The pre-DB start row. Returns the invocation id to carry into the done row.
 */
export declare function recordHookStart(event: string, info: {
    sessionId?: unknown;
    cwd?: unknown;
    invocationId?: string;
    detail?: unknown;
}): string;
/** The completion row. Absent in the log = the hook never got here. */
export declare function recordHookDone(event: string, info: {
    sessionId?: unknown;
    cwd?: unknown;
    invocationId?: string;
    outcome: HookOutcome;
    durationMs?: number;
    dbWaitMs?: number;
    startupMs?: number;
    stage?: string;
    contextDelivered?: boolean;
    error?: unknown;
    detail?: unknown;
}): boolean;
export interface HookEventRow {
    ts: string;
    event: string;
    session_id?: string;
    cwd?: string;
    phase?: string;
    invocation_id?: string;
    pid?: number;
    outcome?: string;
    duration_ms?: number;
    db_wait_ms?: number;
    /** #166: entry -> first database call, the hook's fixed cost on this machine. */
    startup_ms?: number;
    /** #166: which stage an inject failure happened at — receipt/compute/startup. */
    stage?: string;
    /** #166: whether context actually reached stdout on an inject failure. */
    context_delivered?: boolean;
    error?: string;
}
/** Last `limit` parseable rows of hook-events.jsonl, oldest first. */
export declare function readHookEventTail(limit: number): HookEventRow[];
export declare function lastObserved(event: string): string | null;
