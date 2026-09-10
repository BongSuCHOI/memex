/**
 * Time-boxed execution of user overlay regexes (decisions-v2 D1, decisions-v3 G3).
 *
 * THIS IS THE SAFETY BOUNDARY. Not the grammar subset — see
 * src/overlay-regex.ts's header for the counterexample that passes every
 * structural rule and still fails to terminate. The guarantee this module makes
 * is narrow and exact:
 *
 *   a slow user pattern cannot stop the matching thread.
 *
 * It is NOT "slow patterns do not exist". A pattern that burns its 50 ms
 * execution budget is QUARANTINED: the worker is terminated, the pattern is
 * recorded in `overlays/quarantine.json`, and every later load drops it from
 * matching until the operator fixes or clears it.
 *
 * Two handles, one implementation:
 *  - `persistentMatcher()` — one per inject daemon (it lives inside the MCP
 *    server, so the worker is resident for the session and the compiled regexes
 *    are memoised across prompts). Respawns at most once per 5 s after a death.
 *  - `oneShotMatcher()` — the cold hook, the CLI, the extraction worker. Creates
 *    its worker on first use and never respawns.
 *
 * Cost when there is no overlay: ZERO. `match()` with an empty pattern list
 * returns without constructing a worker or sending a message, so an installation
 * with no overlay file runs exactly the 0.6.9 path.
 *
 * `match()` NEVER throws and never rejects. Every failure is a field on the
 * result, because the gate's contract is that a prompt is never broken by the
 * overlay machinery (the extraction side reads the same fields and fails CLOSED
 * instead — §2.3.4's asymmetry).
 */
import { type OverlayName } from "./paths.js";
import type { GateIntent } from "./recall-gate.js";
/** Wall clock for ONE request's own execution window. Queue wait is excluded. */
export declare const MATCH_WALL_MS = 50;
/**
 * Budget for bringing a worker ONLINE, kept separate from MATCH_WALL_MS (G3).
 *
 * Spawning a Node worker measures at 10-40 ms, so folding it into the 50 ms
 * execution budget made the first prompt after a daemon start time out on
 * startup alone — and a startup timeout must never quarantine a pattern, so the
 * overlay would have been silently dropped on exactly the prompt that paid for
 * it. Exhausting THIS budget yields `unavailable` with no quarantine; only the
 * 50 ms that follows can attribute a timeout to a pattern.
 */
export declare const MATCHER_STARTUP_MS = 500;
/** Minimum interval between respawn attempts after an unexpected worker death. */
export declare const MATCHER_RESPAWN_MS = 5000;
/** Prompt prefix handed to the worker. A constant factor, NOT a defence. */
export declare const MATCH_INPUT_CHARS = 8000;
/** Entries kept in quarantine.json (§1.3). */
export declare const QUARANTINE_MAX_ENTRIES = 200;
export interface UserPatternSpec {
    id: string;
    intent?: GateIntent | null;
    source: string;
    flags: string;
    /** Which overlay the pattern came from — decides the quarantine row's owner. */
    overlay?: OverlayName;
}
export interface QuarantineEntry {
    overlay: OverlayName;
    pattern_id: string;
    /** sha8(source \0 flags): editing the regex changes it, which auto-clears. */
    source_sha8: string;
    at: string;
    elapsed_ms: number;
    input_chars: number;
    surface: string;
}
export interface UserPatternHits {
    /** Overlay pattern ids that fired, per intent (the gate's input). */
    intents: Partial<Record<GateIntent, string[]>>;
    /** Every pattern id that matched, intent or not (the extraction side's input). */
    matched: string[];
    /** True when this request's own 50 ms window ran out. */
    timedOut: boolean;
    /** Ids newly quarantined by THIS call. Only ever set on an execution timeout. */
    quarantined: string[];
    /** True when the worker could not be used at all (startup, death, queue drain). */
    unavailable: boolean;
    /**
     * True when the request's text was longer than the input cap and only the
     * prefix was evaluated.
     *
     * The cap is a COST bound for the recall path, where a prefix answer is the
     * right trade. It is not a safety property, so the storage boundary — which
     * must never let unexamined text through — reads this field and treats a
     * truncated answer as a check that did not finish (§3.4, G1).
     */
    truncated: boolean;
    /** EXECUTION window only — queue wait and worker startup are excluded. */
    elapsedMs: number;
    /**
     * Regexes this request had to compile. 0 means the resident worker's memo held,
     * which is the difference between the warm and the cold matcher cost.
     */
    compiledPatterns: number;
}
export interface MatchRequest {
    text: string;
    patterns: readonly UserPatternSpec[];
    /** Default overlay for quarantine rows when a spec does not name one. */
    overlay?: OverlayName;
    /** Free-form origin recorded on a quarantine row: 'daemon' | 'fallback' | … */
    surface?: string;
}
export interface MatcherHandle {
    /**
     * Evaluate `patterns` against `text`. Resolves even on timeout, worker death
     * or a missing worker_threads implementation — never throws, never rejects.
     */
    match(input: MatchRequest): Promise<UserPatternHits>;
    dispose(): void;
    state(): "ready" | "dead" | "unavailable";
}
export declare const EMPTY_USER_PATTERN_HITS: UserPatternHits;
/**
 * Narrow seams, used by test/overlay-matcher*.test.ts.
 *
 * Production callers pass nothing. `entry` lets a test stand in a worker that
 * dies or never answers, which is the only way to exercise the death and
 * queue-drain branches for real; `respawnMs` shortens the 5 s respawn window so
 * the suite does not have to wait it out.
 */
export interface MatcherOptions {
    respawnMs?: number;
    entry?: URL;
}
/** One resident worker per inject daemon; respawns at most once per 5 s. */
export declare function persistentMatcher(options?: MatcherOptions): MatcherHandle;
/** A throwaway worker for the cold hook, the CLI and the extraction worker. */
export declare function oneShotMatcher(options?: MatcherOptions): MatcherHandle;
/**
 * A handle that can never run a user pattern. Used where a matcher is structurally
 * required but overlays are switched off (`MEMEX_DISABLE_OVERLAYS=1`).
 */
export declare function disabledMatcher(): MatcherHandle;
export declare function quarantineKey(patternId: string, sourceSha8: string): string;
/** Bumped whenever an in-memory fallback row appears, so load caches invalidate. */
export declare function quarantineMemoryGeneration(): number;
/** File ∪ in-memory fallback, newest last, deduplicated by (pattern_id, sha8). */
export declare function readQuarantine(): QuarantineEntry[];
export declare function isQuarantinedPattern(entries: readonly QuarantineEntry[], patternId: string, source: string, flags: string): boolean;
/**
 * Record a quarantined pattern.
 *
 * The merge is a set union keyed on (pattern_id, source_sha8), but a union built
 * in local memory is NOT enough on its own: two processes that read the same
 * previous file and then both rename lose whichever entry the later rename did not
 * know about. So the write is read-merge-write with a compare-and-swap on the
 * file's identity and a retry when it moved.
 *
 * The in-memory row is also kept after a successful write, not dropped. It is this
 * process's own guarantee that the pattern stays excluded here even if a later
 * writer elsewhere overwrites the file — losing the row would silently re-enable a
 * pattern that already burned its budget.
 */
export declare function quarantinePattern(entry: QuarantineEntry): void;
/**
 * Replace the persisted set. Owned by src/overlay-admin.ts (`clearQuarantine`,
 * `clearQuarantineForChangedPatterns`); nothing on the read path calls it.
 */
export declare function replaceQuarantine(entries: readonly QuarantineEntry[]): boolean;
/** Test-only: forget the in-memory fallback rows of this process. */
export declare function resetQuarantineMemory(): void;
/** Directory the quarantine file lives in — exported for doctor's detail line. */
export declare function quarantineLocation(): string;
