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
}): boolean;
export declare function lastObserved(event: string): string | null;
