/**
 * Read side of the recall-gate overlay (issue #29, §1.6 / §2).
 *
 * A LEAF module: `fs`, `path`, `crypto`, `./paths.js`, `./overlay-regex.js`,
 * `./overlay-matcher.js`, `./recall-gate.js`. No database, no audit writer, no
 * lock — the injection hook loads this on every prompt, and pulling
 * `ontology-admin` (and through it `ontology-db`) into the fast path would undo
 * the whole point of the warm daemon (§1.4's "fast path 오염 금지").
 *
 * FAIL-SAFE, deliberately asymmetric with the extraction overlay (G1): a gate
 * overlay that will not load, or a pattern that got quarantined, degrades to the
 * BUILT-IN defaults and the prompt is still served. The gate only changes what is
 * RECALLED; it never decides what is stored, so fail-open is the correct
 * direction here. The extraction rules overlay does the opposite.
 *
 * Nothing here ever executes a user regex. Loading runs the structural parser
 * (pure, linear, terminating) and hands the surviving specs to the time-boxed
 * matcher; `loadRecallGateOverlay()` does NOT run the measuring probe.
 */
import { type Issue } from "./overlay-regex.js";
import { type MatcherHandle, type QuarantineEntry, type UserPatternSpec } from "./overlay-matcher.js";
import { BUILTIN_GATE_PATTERNS, type GateIntent, type GateLexicon, type RecallGateDecision, type RecallGateState, type UserIntentHits } from "./recall-gate.js";
export declare const RECALL_GATE_OVERLAY_SCHEMA = "memex.recall-gate-overlay";
export declare const RECALL_GATE_OVERLAY_VERSION = 1;
/** §1.3 / §2.2 — the complete limit table, also served to the Web UI. */
export declare const OVERLAY_LIMITS: Readonly<{
    fileBytes: 32768;
    patternSource: 200;
    quantifiers: 8;
    groupDepth: 5;
    alternationBranches: 32;
    noteChars: 200;
    counts: Readonly<{
        patternsAdd: 64;
        patternsAddPerIntent: 32;
        patternsDisable: 256;
        wordsAddPerLexicon: 128;
        wordsDisablePerLexicon: 256;
        wordChars: 32;
    }>;
}>;
export interface UserGatePattern {
    id: string;
    intent: GateIntent;
    source: string;
    flags: string;
    note?: string;
    created_at?: string;
}
export interface RecallGateOverlayDoc {
    schema: string;
    version: number;
    revision: number;
    updated_at?: string;
    updated_by?: {
        surface?: string;
    };
    patterns?: {
        add?: UserGatePattern[];
        disable?: string[];
    };
    words?: {
        add?: Partial<Record<GateLexicon, string[]>>;
        disable?: Partial<Record<GateLexicon, string[]>>;
    };
}
export interface LoadedRecallGateOverlay {
    /** The file exists (even if it failed to load). */
    present: boolean;
    /** `gate:<sha8>` of the applied rules, or null when nothing is applied. */
    hash: string | null;
    revision: number;
    /** Patterns to hand to the matcher. Empty on any error-severity issue. */
    patterns: UserPatternSpec[];
    /** Built-in catalogue ids this overlay turns off. */
    disabled: string[];
    words: {
        add: Record<GateLexicon, string[]>;
        disable: Record<GateLexicon, string[]>;
    };
    /** Quarantined rows relevant to this overlay (already excluded from `patterns`). */
    quarantined: QuarantineEntry[];
    issues: Issue[];
    /** The document as applied, for `gate show` / the Web UI. Null when not applied. */
    doc: RecallGateOverlayDoc | null;
}
export declare function emptyRecallGateOverlay(): LoadedRecallGateOverlay;
/**
 * `gate:<sha8>` over the RULES only.
 *
 * `revision`, `updated_at` and `updated_by` are excluded on purpose: re-saving
 * the same rules must not move the hash, or the extraction drift warning fires
 * for a no-op and every recall receipt looks like a new rule set.
 */
export declare function recallGateOverlayHash(doc: RecallGateOverlayDoc): string;
export interface ValidationResult {
    ok: boolean;
    issues: Issue[];
    /** The document with defaults filled in, when `ok`. */
    doc: RecallGateOverlayDoc | null;
}
/**
 * Structural validation. `forWrite` adds the warnings that only matter when an
 * operator is saving (`PATTERN_SHADOWED`), and a caller that also wants the
 * measuring probe runs `probeRecallGateOverlay()` from overlay-admin.ts.
 */
export declare function validateRecallGateOverlayDoc(raw: unknown, opts?: {
    forWrite?: boolean;
    bytes?: number;
}): ValidationResult;
/** §2.4 — async signature so the write path can add the measuring probe later. */
export declare function validateRecallGateOverlay(doc: unknown, opts?: {
    probe?: boolean;
    forWrite?: boolean;
}): Promise<ValidationResult>;
export declare function overlaysDisabled(): boolean;
export declare function readRecallGateOverlayFile(file?: string): {
    raw: unknown;
    bytes: number;
    present: boolean;
    readError: string | null;
};
/**
 * The hook's entry point. Two `statSync` calls per request (~20-60 µs) against a
 * warm budget of ~150 ms, and `ino` in the key so the atomic tmp+rename of a
 * write is always observed even when `mtimeMs:size` happen to repeat.
 *
 * No `fs.watch`: the MCP server must not put a watcher on the data root.
 */
export declare function loadRecallGateOverlay(): LoadedRecallGateOverlay;
/** Cache-bypassing read of the applied revision (the write path's CAS input). */
export declare function currentRecallGateRevision(): number;
/** Test/transition hook: forget the cached load. */
export declare function resetRecallGateOverlayCache(): void;
export interface GateCatalog {
    builtin: readonly (typeof BUILTIN_GATE_PATTERNS)[number][];
    words: Readonly<Record<GateLexicon, readonly string[]>>;
    limits: typeof OVERLAY_LIMITS;
}
export declare function gateCatalog(): GateCatalog;
/**
 * Fold a loaded overlay plus the matcher's answer into the gate's input.
 *
 * The word lists travel even when the matcher was unavailable: they are plain
 * strings, were never going to run in a worker, and dropping them because a
 * worker died would be an unrelated regression.
 */
export declare function toUserIntentHits(overlay: LoadedRecallGateOverlay, hits: {
    intents: Partial<Record<GateIntent, string[]>>;
}): UserIntentHits | undefined;
export interface ExplainInput {
    prompt: string;
    /**
     * Gate state to judge against. Omitted means a NEUTRAL state (epoch 0, no
     * fingerprint, no resident coverage) — the CLI reads a real one from
     * `session_memory_state` when `--session` is given, which is why this module
     * (a leaf with no database) takes it as a parameter.
     */
    state?: RecallGateState;
    /** Also run the decision with the overlay switched off, and diff the two. */
    compareBuiltin?: boolean;
}
export interface RecallExplanation {
    prompt: {
        chars: number;
        tokens: string[];
    };
    overlay: {
        present: boolean;
        hash: string | null;
        revision: number;
    };
    matcher: {
        elapsedMs: number;
        timedOut: boolean;
        unavailable: boolean;
        quarantined: string[];
    };
    intents: Record<GateIntent, {
        fired: boolean;
        matched: Array<{
            id: string;
            source: string;
            origin: "builtin" | "user";
        }>;
    }>;
    decision: RecallGateDecision;
    builtinOnly?: RecallGateDecision;
    /** Rules present in the overlay run and absent from the built-in-only run. */
    diffCause?: Array<{
        id: string;
        source: string;
        intent: GateIntent;
    }>;
    stateSource: "neutral" | "session";
}
export declare function neutralGateState(): RecallGateState;
/**
 * Explain one prompt against the built-ins and the overlay. Writes NOTHING — no
 * inject log, no recall receipt, no telemetry, no gate state. The one exception
 * is the quarantine file: user patterns go through the real matcher, so a
 * pattern that blows its budget here is quarantined exactly as it would be in
 * production, and that fact is recorded.
 */
export declare function explainRecall(input: ExplainInput, matcher: MatcherHandle): Promise<RecallExplanation>;
export interface OverlayCheck {
    name: string;
    status: "ok" | "warn" | "fail";
    detail: string;
}
/**
 * The three gate-side doctor checks. `src/lifecycle.ts` is owned by the
 * diagnostics lane, so this module exports the checks rather than pushing them.
 *
 * `matcherProbe` lets the caller decide whether to pay for a worker spawn; the
 * default spawns one only when there is a user pattern to run.
 */
export declare function recallGateOverlayChecks(matcherProbe?: () => Promise<boolean>): Promise<OverlayCheck[]>;
