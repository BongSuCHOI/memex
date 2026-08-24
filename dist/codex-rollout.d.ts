/** Root directory that holds Codex rollout sessions (recursive layout). */
export declare function sessionsRoot(): string;
/** Recursively list rollout transcript files, oldest-first. */
export declare function discoverSessionFiles(root?: string): string[];
/** True when a parsed session_meta marks a subagent/child thread. */
export declare function isSubagentMeta(meta: Record<string, unknown> | null | undefined): boolean;
/**
 * Read just the session_meta header of a rollout file — cheap pre-parse used
 * by sync/index to route sessions before any exchange processing.
 */
export declare function readRolloutMeta(filePath: string): Promise<{
    meta: Record<string, unknown> | null;
    isSubagent: boolean;
}>;
/**
 * Session/thread id from a rollout filename. Codex names are
 * `rollout-<timestamp>-<uuid>.jsonl` where the timestamp block also contains
 * dashes, so the thread id is the LAST UUID in the basename.
 * Legacy bare-UUID transcript names keep working.
 */
export declare function extractSessionIdFromPath(filePath: string): string | null;
/** Pure single-source check for harness/developer context that must never be
 * indexed or displayed. Used by the parser and the show/read formatters. */
export declare function isInternalContextMessage(text: string): boolean;
export interface ParsedRollout {
    meta: Record<string, unknown> | null;
    isSubagent: boolean;
    /** Normalized exchanges compatible with the legacy ConversationExchange shape. */
    exchanges: Array<Record<string, unknown>>;
}
/**
 * Stream-parse one rollout file handle into normalized user/agent exchanges.
 * Malformed lines are tolerated per-line (same contract as the legacy parser).
 */
export declare function parseRolloutStream(input: NodeJS.ReadableStream, { archivePath }?: {
    archivePath?: string;
}): Promise<ParsedRollout>;
/**
 * Legacy-compatible entry point: parse one rollout transcript into exchanges.
 * projectName is stamped onto every exchange (project scoping stays with sync).
 */
export declare function parseConversation(filePath: string, projectName: string, archivePath?: string): Promise<Array<Record<string, unknown>>>;
