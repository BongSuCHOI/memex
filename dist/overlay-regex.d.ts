/**
 * Overlay regex grammar subset — DEFENCE IN DEPTH, NOT A SAFETY PROOF.
 *
 * Read this before trusting anything below (decisions-v2 D1).
 *
 * The 0.7.0 v2 design called this a "safe regex subset" and claimed it ruled out
 * catastrophic backtracking. It does not. The reviewer's counterexample
 *
 *   ^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$
 *
 * has no groups, no backreferences, no lookaround, and no two ADJACENT quantified
 * atoms whose first-character sets intersect — it passes every structural rule
 * here — and on the input `'a'.repeat(80) + '!'` it does not terminate in any
 * useful time. Lowering the quantifier budget from 20 to 8 does not fix it
 * either: `^a+b?a+b?a+b?a+$` has seven quantifiers and the same shape.
 *
 * So this module makes NO safety claim. What keeps a user pattern from stopping
 * the hook is src/overlay-matcher.ts: user patterns execute ONLY inside a
 * worker_thread under a 50 ms wall clock, and a pattern that burns that budget
 * is quarantined and dropped from matching. This parser exists to:
 *
 *  - reject constructs the overlay has no use for (backreferences, lookaround);
 *  - catch the ORDINARY author mistake early, with a stable code and a useful
 *    message, instead of at match time as a quarantine;
 *  - bound the work the parser itself does (it is pure, linear and terminating,
 *    so the load path can run it on every request).
 *
 * Every real-world shape in the design's acceptance list passes:
 *   배포\s*이력 · \bsk-[A-Za-z0-9_-]{16,} · (확정|최종 결정) · ^(ok|okay)$ ·
 *   (?:re)?deploy · [가-힣]{2,10} · .*배포
 */
/**
 * The validation issue contract, shared by both overlays and by the Web UI
 * (decisions-v3 G5 / I2).
 *
 * `path` is part of the contract and survives the HTTP boundary unchanged: v3's
 * serializer only whitelisted `row`/`field`, so `patterns.add[2].source` was
 * dropped and the operator could not tell WHICH row to fix. There is no
 * `path → row/field` translation at the server edge.
 *
 * `key` is an i18n dictionary key the server passes through WITHOUT looking it
 * up (C2); `message` is the one English line that logs and `curl` show.
 */
export interface Issue {
    severity: "error" | "warning";
    /** Stable machine code, e.g. `PATTERN_TOO_LONG`. */
    code: string;
    /** i18n key — always `overlays.issue.<camelCode>` for this validator. */
    key: string;
    params?: Record<string, unknown>;
    /** Dotted location inside the document, e.g. `patterns.add[2].source`. */
    path?: string;
    /** One English line. Required. */
    message: string;
    row?: number;
    field?: string;
}
/** Build an `Issue`, deriving the i18n key from the code so the two cannot drift. */
export declare function overlayIssue(severity: Issue["severity"], code: string, message: string, extra?: {
    path?: string;
    params?: Record<string, unknown>;
    row?: number;
    field?: string;
}): Issue;
export declare const OVERLAY_REGEX_LIMITS: Readonly<{
    /** `source` characters (§1.3). */
    sourceChars: 200;
    /** Total quantifiers anywhere in the pattern (§1.3, lowered from 20 in v2). */
    quantifiers: 8;
    /** Group nesting depth. */
    depth: 5;
    /** Alternation branches, summed over the whole pattern. */
    branches: 32;
    /** Upper bound of `{n,m}`. */
    repeatMax: 100;
    /** Flags an overlay pattern may carry. */
    flags: "isu";
}>;
export type OverlayRegexCode = "REGEX_BACKREFERENCE" | "REGEX_LOOKAROUND" | "REGEX_QUANTIFIED_GROUP" | "REGEX_ADJACENT_OVERLAP" | "REGEX_QUANTIFIER_BUDGET" | "REGEX_UNSUPPORTED_SYNTAX" | "PATTERN_TOO_LONG" | "PATTERN_FLAGS_REJECTED" | "PATTERN_UNCOMPILABLE";
export interface OverlayRegexProblem {
    code: OverlayRegexCode;
    /** One English line for logs and `curl`; the UI translates by `code`. */
    message: string;
    /** Zero-based offset in `source`, when the parser can attribute one. */
    at?: number;
    params?: Record<string, unknown>;
}
export interface OverlayRegexCheck {
    ok: boolean;
    problems: OverlayRegexProblem[];
    /** Observed counts, reported even when `ok` so `validate` can show headroom. */
    quantifiers: number;
    depth: number;
    branches: number;
}
/**
 * Structural check for one overlay pattern. Pure, linear in `source.length`, and
 * guaranteed to terminate — which is why the load path runs it on every request
 * while the measuring probe (§2.3.2) only runs on writes.
 */
export declare function checkOverlayRegex(source: string, flags: string): OverlayRegexCheck;
/** `sha8(intent \0 source \0 flags)` — the deterministic id of a user pattern (§2.2). */
export declare function userPatternId(intent: string, source: string, flags: string): string;
/** First 8 hex characters of the sha256 of `text`. */
export declare function sha8(text: string): string;
/** `source_sha8` — the quarantine key's second half, so a FIX auto-clears it. */
export declare function patternSourceSha8(source: string, flags: string): string;
/**
 * Canonical JSON: object keys sorted, no whitespace. The overlay hash must not
 * move when a re-save reorders keys, or the extraction drift warning fires for
 * nothing.
 */
export declare function canonicalJson(value: unknown): string;
