/**
 * Version drift guard — a plugin update must not leave old-version processes running.
 *
 * Incident (2026-07-14): a v1.3.3 sync-cli wedged for 23h kept the singleton lock,
 * silently starving every newer sync (indexing frozen), while the stale install
 * record kept spawning v1.3.3 into every new session after v1.4.3 shipped.
 *
 * Two enforcement points use this module:
 *  - sync-cli lock: the lock file carries {pid, version, startedAt} so a newer
 *    sync takes over from an older or wedged holder instead of skipping forever.
 *  - SessionStart sweep (scripts/version-drift-check.js): detached workers
 *    running from an older versioned plugin dir are terminated. MCP servers are
 *    never swept — killing one breaks a live session's tools; those only rotate
 *    on session restart.
 */
export interface LockMeta {
    pid: number;
    version: string | null;
    startedAt: number | null;
}
/** Small semver-compatible comparator for plugin cache version directories. */
export declare function compareVersions(a: string, b: string): number;
/**
 * Parse the JSON lock pid-file content: {pid, version, startedAt}.
 * Returns null when no usable pid can be extracted (caller treats the
 * lock as garbage: reclaim without killing anything).
 */
export declare function parseLockMeta(raw: string): LockMeta | null;
export type TakeoverDecision = 'takeover-stale-version' | 'takeover-wedged' | 'defer';
/**
 * Decide whether a live lock holder should be preempted.
 *  - Older known version → take over: stale code must not keep indexing.
 *  - Runtime above wedgeMaxMs → take over regardless of version: a wedged sync
 *    starves indexing either way (observed: 23h; normal incremental sync is
 *    minutes). holderRunMs null (unknown start) → no wedge judgement.
 */
export declare function decideTakeover(holder: LockMeta, myVersion: string, holderRunMs: number | null, wedgeMaxMs: number): TakeoverDecision;
/**
 * True only for a Node process whose executable script is a Memex sync CLI.
 */
export declare function isSyncCliCommand(command: string): boolean;
/**
 * If `command` is a Memex detached worker from a version OLDER than
 * `myVersion`, return that stale version string; otherwise null.
 */
export declare function staleWorkerVersion(command: string, myVersion: string): string | null;
