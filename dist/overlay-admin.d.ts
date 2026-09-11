/**
 * Write side of the user overlays (§1.5, §2.4). WRITE-ONLY MODULE.
 *
 * Only the CLI and the Web UI server load this. It imports the ui-audit writer,
 * which drags in `ontology-db`, so it must never appear on the injection fast
 * path — the read leaf is src/recall-gate-overlay.ts (§1.4).
 *
 * The lock discipline follows `inject-daemon.ts:904-975`, with the three
 * corrections the v3 review forced:
 *
 *  - D3: `withOverlayLock(async body)` does `return await body()` and only then
 *    releases, so an async validation (probe included) finishes INSIDE the lock.
 *    v2's synchronous wrapper released in a `finally` that ran before the probe
 *    promise settled.
 *  - D3: the "unreadable lock" observation state is MODULE level and the second
 *    look happens 250 ms later IN THE SAME CALL. v2 rebuilt the set per call and
 *    threw on the first look, so a corrupt lock could never be recovered.
 *  - G4: observation count and acquisition attempts are separate budgets. After a
 *    successful removal the loop gets one more acquisition attempt, so a single
 *    CLI invocation actually performs the write it was asked for. v3 ended the
 *    loop right after the delete and raised `OverlayLockedError` anyway.
 *  - Reclaimers are serialized by `<lock>.reclaim`. The re-check and the `unlink`
 *    that reclaims an abandoned lock are two syscalls, and the gap between them
 *    is cross-process: a competitor that recovered and acquired in there had its
 *    LIVE lock deleted. Re-checking harder cannot fix a gap between the check and
 *    the act — only one reclaimer at a time can.
 *
 * A LIVE holder is never stolen from, in any branch.
 */
import { type OverlayName } from "./paths.js";
import { type Issue } from "./overlay-regex.js";
import { type UserGatePattern, type ValidationResult } from "./recall-gate-overlay.js";
import { type GateIntent, type GateLexicon } from "./recall-gate.js";
export type Surface = "cli" | "web-ui";
/** Snapshots kept per overlay, for `rollback` (§1.3). */
export declare const HISTORY_SNAPSHOT_LIMIT = 20;
/** Second look at an unreadable lock, in the same call (D3). */
export declare const SECOND_LOOK_MS = 250;
/** Extra wait for a caller that joins an existing unreadable-lock observation (see withOverlayLock). */
export declare const FOLLOWER_GRACE_MS = 25;
/** Wall clock for the write-path measuring probe (§2.3.2). */
export declare const PROBE_WALL_MS = 300;
export declare class OverlayLockedError extends Error {
    readonly holderPid: number | null;
    constructor(holderPid: number | null);
}
export declare class OverlayStaleError extends Error {
    readonly currentRevision: number;
    readonly expectedRevision: number;
    constructor(currentRevision: number, expectedRevision: number);
}
export declare class OverlayInvalidError extends Error {
    readonly issues: Issue[];
    constructor(issues: Issue[]);
}
/** Test-only: forget this process's unreadable-lock observations. */
export declare function resetOverlayLockObservations(): void;
/**
 * How long a reclaim mutex may be held before a dead holder's is broken.
 *
 * It is held for two syscalls in production, so anything in seconds is already
 * orders of magnitude of slack; it exists only so a reclaimer killed between the
 * `link` and the `unlink` cannot wedge the overlay for ever.
 */
export declare const RECLAIM_MUTEX_TTL_MS = 2000;
/** Wait before re-looking when another reclaimer is inside the mutex. */
export declare const RECLAIM_RETRY_MS = 30;
/** Test-only: install (or clear with `null`) the re-check/unlink interleave hook. */
export declare function setReclaimInterleaveHook(hook: (() => Promise<void>) | null): void;
/**
 * Run `body` under the overlay's write lock. Read-modify-write AND the whole
 * async validation happen inside.
 */
export declare function withOverlayLock<T>(file: string, body: () => Promise<T>): Promise<T>;
/** True while this process holds `file`'s lock. Exported for tests and doctor. */
export declare function overlayLockHolder(file: string): number | null;
export interface ProbeResult {
    ok: boolean;
    /** Worst single `.test()` in milliseconds across the corpus. */
    maxMs: number;
    /** Labels that exceeded the wall clock (the worker was terminated). */
    tooSlow: string[];
    /** True when no probe could be run at all (worker_threads unavailable). */
    unavailable: boolean;
}
/**
 * Deterministic probe corpus: fixed shapes, the pattern's own literal alphabet
 * repeated, and — the case that actually catches nullable-separator blowups —
 * FAILING SUFFIXES, where the engine must exhaust every split before reporting
 * no match.
 */
export declare function probeCorpus(sources: readonly string[]): string[];
export declare function probeRegexSafety(cases: ReadonlyArray<{
    label: string;
    source: string;
    flags: string;
}>, wallMs?: number): Promise<ProbeResult>;
export type OverlayValidator = (doc: unknown, opts: {
    probe?: boolean;
    forWrite?: boolean;
}) => Promise<ValidationResult>;
/**
 * Full validation for a write: structure, then the measuring probe over each
 * candidate AND over the composed pattern of its intent.
 *
 * Returns `Issue[]` with the `{severity, code, key, params, path, message}`
 * contract (G5/I2) — `path` survives to the client unchanged.
 */
export declare function validateOverlay(overlay: OverlayName, doc: unknown, opts?: {
    probe?: boolean;
    forWrite?: boolean;
    validator?: OverlayValidator;
}): Promise<ValidationResult>;
export interface HistoryEntry {
    ts: string;
    surface: Surface;
    overlay: OverlayName;
    action: string;
    from_revision: number;
    to_revision: number;
    from_hash: string | null;
    to_hash: string | null;
    added?: string[];
    disabled?: string[];
    removed?: string[];
    counts?: Record<string, number>;
}
export declare function listOverlayHistory(overlay: OverlayName, limit?: number): HistoryEntry[];
export declare function readOverlaySnapshot(overlay: OverlayName, revision: number): unknown | null;
export declare function listOverlaySnapshots(overlay: OverlayName): number[];
export interface WriteResult {
    revision: number;
    hash: string | null;
    issues: Issue[];
    /** Quarantine rows cleared because the pattern's source changed. */
    quarantineCleared: string[];
}
export interface GateDelta {
    patternsAdd?: UserGatePattern[];
    patternsDisable?: string[];
    patternsRemove?: string[];
    words?: {
        add?: Partial<Record<GateLexicon, string[]>>;
        disable?: Partial<Record<GateLexicon, string[]>>;
        removeAdd?: Partial<Record<GateLexicon, string[]>>;
        removeDisable?: Partial<Record<GateLexicon, string[]>>;
    };
}
export interface ApplyOptions {
    surface: Surface;
    expectedRevision?: number;
    /** `validate` only: skip the measuring probe (the default runs it). */
    probe?: boolean;
    /** Required for the `extraction-rules` overlay — lane C owns its validator. */
    validator?: OverlayValidator;
    /** Audit action name, e.g. `gate.pattern-add`. */
    auditAction: string;
    /** Extra metadata-only fields for the history index. */
    history?: Partial<Pick<HistoryEntry, "added" | "disabled" | "removed" | "counts">>;
}
/**
 * Read-modify-write under the lock with revision CAS.
 *
 * `input` is either a DELTA (merged inside the lock, so nothing read outside can
 * be written back) or a FULL DOCUMENT (the caller must pass `expectedRevision`
 * when a file already exists — §1.5's lost-update contract).
 */
export declare function applyOverlayChange(overlay: OverlayName, input: {
    delta?: GateDelta;
    doc?: unknown;
}, opts: ApplyOptions): Promise<WriteResult>;
export declare function addGatePattern(input: {
    intent: GateIntent;
    source: string;
    flags?: string;
    note?: string;
}, opts: {
    surface: Surface;
    expectedRevision?: number;
    probe?: boolean;
}): Promise<WriteResult>;
/**
 * `disable` is not `remove`: a built-in stays in the catalogue and is switched
 * off by id. A `user.*` id is deleted from `patterns.add` instead, and a regex
 * source is resolved to an id by exact `source+flags` match (a CLI convenience).
 */
export declare function disableGatePattern(idOrSource: string, opts: {
    surface: Surface;
    expectedRevision?: number;
    flags?: string;
    probe?: boolean;
}): Promise<WriteResult>;
/** Resolve an id, a `user.*` id, or an exact regex source to a catalogue id. */
export declare function resolveGatePatternId(idOrSource: string, flags?: string): string | null;
export declare function setGateWords(lexicon: GateLexicon, change: {
    add?: string[];
    disable?: string[];
    removeAdd?: string[];
    removeDisable?: string[];
}, opts: {
    surface: Surface;
    expectedRevision?: number;
    probe?: boolean;
}): Promise<WriteResult>;
/**
 * Reset an overlay to "nothing applied".
 *
 * The file is not deleted: it is written as an empty rule set at the next
 * revision, so the change has a revision, a snapshot and a rollback target like
 * every other change.
 */
export declare function resetOverlay(overlay: OverlayName, opts: {
    surface: Surface;
    intent?: GateIntent;
    expectedRevision?: number;
    /** The extraction-rules overlay's "nothing applied" document — lane C owns it. */
    emptyDoc?: unknown;
    validator?: OverlayValidator;
}): Promise<WriteResult>;
export declare function rollbackOverlay(overlay: OverlayName, revision: number, opts: {
    surface: Surface;
    expectedRevision?: number;
    validator?: OverlayValidator;
}): Promise<WriteResult>;
/**
 * Clear quarantine rows so the pattern gets another chance.
 *
 * The quarantine file is SHARED, LOCK-FREE, union-merged state (§2.3.4), so this
 * is a plain read-filter-write rather than a revision CAS.
 */
export declare function clearQuarantine(patternId?: string, opts?: {
    surface?: Surface;
    dryRun?: boolean;
}): Promise<{
    cleared: number;
    ids: string[];
    dryRun: boolean;
}>;
/** Where the overlay files live — for `gate show` and doctor detail lines. */
export declare function overlayPaths(): {
    dir: string;
    gate: string;
    history: string;
};
/** Canonical rule JSON of a document — the hash's pre-image, for `--json` output. */
export declare function overlayCanonicalJson(doc: unknown): string;
