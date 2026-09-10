/**
 * Read side of the extraction-rules overlay (issue #30, §3).
 *
 * A LEAF module: `fs`, `./paths.js`, `./overlay-regex.js`, `./overlay-matcher.js`.
 * No database, no audit writer, no lock, no `overlay-admin` at module scope —
 * `overlay-admin` pulls `ontology-admin` and through it `ontology-db`, and this
 * module is loaded by the extractor and by the Web UI's DB-free overlay read
 * path. The write wrappers at the bottom reach `overlay-admin` through a dynamic
 * import for exactly that reason (§1.4 "fast path 오염 금지").
 *
 * FAIL-CLOSED, deliberately the opposite of the recall-gate overlay (G1):
 *
 *   - the overlay will not load            → the extractor HOLDS before it claims
 *     (`extraction_rules_invalid`, no attempt consumed);
 *   - a `never_extract` pattern is quarantined → extraction HOLDS entirely. There
 *     is NO path that drops the slow pattern and stores the rest, because a
 *     forbidden string being saved "because the rule was slow" is the failure
 *     this feature exists to prevent;
 *   - the forbid check could not finish    → the claim is RETURNED unsaved
 *     (`extraction_rules_unavailable`), so the same input is checked again.
 *
 * STRUCTURED RULES ONLY. There is no raw-prompt field and there never will be
 * one here: everything an operator can write is a bounded list that renders into
 * the constraint clause (§3.2), and the clause can only SUPPRESS. The evidence
 * bar, the fail-closed entailment verifier and the precision gates above it are
 * untouched — `composeExtractionSystemPrompt` appends, it never edits.
 *
 * Nothing here executes a user regex. Validation runs the structural parser from
 * `overlay-regex.ts` (pure, linear, terminating); every actual match goes through
 * the time-boxed matcher worker in `overlay-matcher.ts`.
 */
import { type Issue } from "./overlay-regex.js";
import { type MatcherHandle, type QuarantineEntry } from "./overlay-matcher.js";
export declare const EXTRACTION_RULES_OVERLAY_SCHEMA = "memex.extraction-rules-overlay";
export declare const EXTRACTION_RULES_OVERLAY_VERSION = 1;
/** §1.3 / §3.1 — the complete limit table, also served to the Web UI. */
export declare const EXTRACTION_RULES_LIMITS: Readonly<{
    fileBytes: 32768;
    patternSource: 200;
    quantifiers: 8;
    noteChars: 200;
    counts: Readonly<{
        excludeTopics: 24;
        excludeTopicChars: Readonly<{
            min: 2;
            max: 80;
        }>;
        neverExtractPatterns: 32;
        decisionPatterns: 16;
        projectOverrides: 32;
    }>;
}>;
/** The four enforcement points the storage boundary covers (§3.3). */
export declare const EXTRACTION_RULE_ENFORCEMENT_POINTS: readonly ["fact_insert", "incident", "remediation", "chronicle"];
/** Where a `never_extract` pattern is matched. `both` is the default. */
export type NeverExtractScope = "fact_text" | "evidence" | "both";
export interface NeverExtractPattern {
    id: string;
    source: string;
    flags: string;
    scope: NeverExtractScope;
    note?: string;
}
export interface DecisionHintPattern {
    id: string;
    source: string;
    flags: string;
    note?: string;
}
export type PreferredLanguage = "ko" | "en" | null;
/** The four rule items an operator may set, globally or per project. */
export interface ExtractionRuleSet {
    preferred_language?: PreferredLanguage;
    exclude_topics?: string[];
    never_extract_patterns?: NeverExtractPattern[];
    always_treat_as_decision_patterns?: DecisionHintPattern[];
}
export interface ExtractionRulesDoc extends ExtractionRuleSet {
    schema: string;
    version: number;
    revision: number;
    updated_at?: string;
    updated_by?: {
        surface?: string;
    };
    project_overrides?: Record<string, ExtractionRuleSet>;
}
/** One project's effective rules — what the prompt clause and the block set use. */
export interface ResolvedExtractionRules {
    /** null for the global rule set. */
    projectId: string | null;
    hash: string | null;
    revision: number;
    preferredLanguage: PreferredLanguage;
    excludeTopics: string[];
    neverExtract: NeverExtractPattern[];
    decisionHints: DecisionHintPattern[];
}
export interface LoadedExtractionRules {
    /** The file exists (even if it failed to load). */
    present: boolean;
    /** `rules:<sha8>` of the applied rules, or null when nothing is applied. */
    hash: string | null;
    revision: number;
    /** The document as applied. Null on any error-severity issue. */
    doc: ExtractionRulesDoc | null;
    /** Global rules, already resolved (the default when no project is known). */
    global: ResolvedExtractionRules;
    issues: Issue[];
    /** Quarantine rows that belong to this overlay. */
    quarantined: QuarantineEntry[];
    /** True when `MEMEX_DISABLE_OVERLAYS=1` — "no overlay", NOT a hold (§1.8). */
    disabledByEnv: boolean;
}
export declare function emptyLoadedExtractionRules(): LoadedExtractionRules;
/**
 * The "nothing applied" document.
 *
 * `resetOverlay('extraction-rules')` needs this from us (lane A refuses to guess
 * another lane's schema), and a reset writes an EMPTY document at the next
 * revision rather than deleting the file, so the change keeps a revision, a
 * snapshot and a rollback target like every other change.
 */
export declare function emptyExtractionRulesDoc(): ExtractionRulesDoc;
/**
 * `rules:<sha8>` over the RULES only.
 *
 * `revision`, `updated_at` and `updated_by` are excluded on purpose: re-saving
 * the same rules must not move the hash, or `extraction-rules-drift` warns about
 * a no-op and every target looks like it was extracted under a new rule set.
 */
export declare function extractionRulesDocHash(doc: ExtractionRulesDoc): string;
/** The applied hash, or null when nothing is applied. Cache-aware. */
export declare function extractionRulesHash(): string | null;
/**
 * `precision-durability-v4` / `precision-durability-v4+rules:9c1e4d07`.
 *
 * This is a REPORTING identifier only. It is NOT the scheduling key — see
 * `test/extraction-policy-keying.test.ts`: mixing the rule hash into
 * `FACT_EXTRACTION_POLICY_VERSION` would turn one edited character into a
 * full-corpus re-extraction, because that constant is part of the
 * `exchange_extraction_state` primary key that decides what counts as processed.
 */
export declare function composeEffectivePolicyVersion(basePolicyVersion: string, rulesHash?: string | null): string;
export interface ExtractionRulesValidation {
    ok: boolean;
    issues: Issue[];
    /** The document with defaults filled in, when `ok`. */
    doc: ExtractionRulesDoc | null;
}
/**
 * Structural validation. Produces the shared `Issue[]` contract (G5/I2) — `path`
 * travels to the Web UI unchanged, so an operator is told WHICH row to fix.
 */
export declare function validateExtractionRulesDoc(raw: unknown, opts?: {
    forWrite?: boolean;
    bytes?: number;
}): ExtractionRulesValidation;
/**
 * §2.4-shaped async validator. This is the function lane A's
 * `applyOverlayChange('extraction-rules', …)` REQUIRES as `opts.validator`: the
 * write path refuses to guess this overlay's schema.
 */
export declare function validateExtractionRules(doc: unknown, opts?: {
    probe?: boolean;
    forWrite?: boolean;
    bytes?: number;
}): Promise<ExtractionRulesValidation>;
export declare function overlaysDisabled(): boolean;
export declare function readExtractionRulesFile(file?: string): {
    raw: unknown;
    bytes: number;
    present: boolean;
    readError: string | null;
};
/**
 * The extractor's entry point. Two `statSync` calls, `ino` in the key so the
 * atomic tmp+rename of a write is always observed, and no `fs.watch`.
 */
export declare function loadExtractionRules(): LoadedExtractionRules;
/**
 * The storage boundary's re-read (§3.4(2)).
 *
 * Identical to `loadExtractionRules()` except for the fallback: when the file is
 * now unparseable, the caller must not lose its claim-time rules, so the last
 * load that produced an applied document is returned with `staleRead` set. The
 * caller leaves one `rules.stale-read` audit line and keeps going — the union in
 * §3.4 already guarantees the claim snapshot is enforced either way.
 */
export declare function reloadExtractionRulesIfChanged(): LoadedExtractionRules & {
    staleRead: boolean;
};
/** Cache-bypassing read of the applied revision (the write path's CAS input). */
export declare function currentExtractionRulesRevision(): number;
/** Test/transition hook: forget the cached load AND the stale-read fallback. */
export declare function resetExtractionRulesCache(): void;
/** The effective rules for one project — what the clause and the block set use. */
export declare function resolveExtractionRules(projectId: string | null, loaded?: LoadedExtractionRules): ResolvedExtractionRules;
/** True when this rule set has nothing to say. The prompt clause is then empty. */
export declare function isEmptyExtractionRules(rules: ResolvedExtractionRules): boolean;
/**
 * Render the bounded structured block the extractor already consumes.
 *
 * Deterministic: same rules in, byte-identical block out, so a no-op re-save
 * cannot change a prompt. Returns `""` when there is nothing to say, and the
 * composer then returns the base prompt unchanged.
 */
export declare function renderExtractionConstraintClause(rules: ResolvedExtractionRules): string;
/**
 * `base` + `\n\n` + clause, or `base` unchanged.
 *
 * The base prompt constant is NEVER edited (`EXTRACTION_SYSTEM_PROMPT` stays
 * byte-identical, so `policy_version: precision-durability-v4` keeps meaning
 * what it meant), and the entailment verifier's prompts are not touched at all.
 */
export declare function composeExtractionSystemPrompt(base: string, rules: ResolvedExtractionRules | null | undefined): string;
/** Hold reasons this overlay owns. The value set itself lives in model-budget.ts. */
export type ExtractionRulesHoldReason = "extraction_rules_invalid" | "extraction_rules_unavailable";
/** The candidate shapes the block set inspects. Structural, to stay DB-free. */
export interface BlockCandidate {
    /** fact / fact_kr / summary / signature_text / subject_key / … */
    factText: string[];
    /** evidence supporting spans. */
    evidence: string[];
}
export interface BlockSetOk<T> {
    ok: true;
    /** Candidates to DROP. Identity-based, so nothing depends on array indices. */
    blocked: Set<T>;
    /** Which patterns fired, for the single audit line. */
    patternIds: string[];
    /** Matcher execution time of the whole check. */
    elapsedMs: number;
}
export interface BlockSetFailed {
    ok: false;
    reason: ExtractionRulesHoldReason;
    detail: string;
    /** Ids newly quarantined by this check (execution timeout only). */
    quarantined: string[];
}
export type BlockSetResult<T> = BlockSetOk<T> | BlockSetFailed;
/**
 * G2 — the block set is `claim snapshot ∪ the latest valid rules read just
 * before the worker evaluation`.
 *
 * The union is the whole point. Reading only the current file made a relaxation
 * take effect on a claim that was already running, which is the exact opposite
 * of the contract: a pattern that existed when the work was claimed stays in
 * force until that work finishes, so TIGHTENING applies from the read and
 * RELAXATION applies from the next claim, automatically.
 */
export declare function unionNeverExtract(snapshot: readonly NeverExtractPattern[], latest: readonly NeverExtractPattern[]): NeverExtractPattern[];
/**
 * Decide which candidates the commit must skip.
 *
 * Runs OUTSIDE the transaction, on purpose and without exception: better-sqlite3
 * transactions are synchronous so they cannot await a worker, and running an
 * un-time-boxed regex while holding a write lock is the worst possible place for
 * one. Inside the transaction there are only set lookups.
 *
 * Never throws. A check that could not finish returns `ok: false`, and the
 * caller then returns the claim unsaved rather than committing input it did not
 * manage to inspect (G1).
 */
export declare function buildBlockSet<T>(matcher: MatcherHandle, patterns: readonly NeverExtractPattern[], candidates: ReadonlyArray<{
    item: T;
    candidate: BlockCandidate;
}>, surface?: string): Promise<BlockSetResult<T>>;
/**
 * Is the matcher usable at all? The pre-claim gate (§3.5.2) asks this only when
 * there IS a `never_extract` pattern, because the answer costs a worker spawn
 * and an installation without forbid rules must pay nothing.
 */
export declare function extractionMatcherAvailable(patterns: readonly NeverExtractPattern[]): Promise<boolean>;
export interface PreClaimBlock {
    reason: ExtractionRulesHoldReason;
    detail: string;
}
/**
 * The synchronous half of the pre-claim gate: is the overlay itself unusable?
 *
 * Returns null when extraction may proceed. `MEMEX_DISABLE_OVERLAYS=1` always
 * proceeds (that is "no overlay", not "broken overlay").
 */
export declare function extractionRulesPreClaimBlock(rules?: LoadedExtractionRules): PreClaimBlock | null;
export interface ExtractionRulesWriteOptions {
    surface: "cli" | "web-ui";
    expectedRevision?: number;
    probe?: boolean;
    /**
     * Open write DB. A successful rules write lifts every hold this overlay put
     * on extraction; without it a fixed rule set leaves the queue parked forever.
     * Optional because the write must still succeed with no database (the 1 hour
     * safety-net backoff recovers it), and because the Web UI opens its own.
     */
    db?: unknown;
}
export interface ExtractionRulesWriteResult {
    revision: number;
    hash: string | null;
    issues: Issue[];
    /** Jobs taken off hold by this write. */
    released: number;
}
/**
 * Lift every hold this overlay owns.
 *
 * Reason isolation matters: a fixed rule set must not release jobs parked on a
 * rejected model selection, so both of OUR reasons are released and nothing
 * else. Best-effort — a missing or closed database must not fail a rules write.
 */
export declare function releaseExtractionRulesHold(db: unknown): Promise<number>;
/** §3.7 `memex extract rules set` / Web UI `set`. Full-document path. */
export declare function setExtractionRules(doc: unknown, opts: ExtractionRulesWriteOptions): Promise<ExtractionRulesWriteResult>;
/** §3.7 `memex extract rules reset`. Writes the empty document, never unlinks. */
export declare function resetExtractionRules(opts: ExtractionRulesWriteOptions): Promise<ExtractionRulesWriteResult>;
/** §3.7 `memex extract rules rollback --to <revision>`. */
export declare function rollbackExtractionRules(revision: number, opts: ExtractionRulesWriteOptions): Promise<ExtractionRulesWriteResult>;
export interface ExtractionRulesCheck {
    name: string;
    status: "ok" | "warn" | "fail";
    detail: string;
}
/** Per-reason held-job counts, as `heldJobSummary()` in model-budget.ts returns them. */
export interface HeldJobCount {
    reason: string;
    jobs: number;
}
/**
 * `extraction-rules-overlay` and `extraction-rules-hold`.
 *
 * A held job is the "stopped quietly" class of bug doctor exists to surface, so
 * it is a `fail` rather than a `warn`: nothing was stored, and nothing will be
 * until an operator fixes the rules or clears the quarantine.
 *
 * `heldJobs` is passed IN rather than read here. This module must stay DB-free:
 * `src/lifecycle.ts` answers doctor with a lightweight read-only connection
 * precisely so it can report when the heavy db chain will not load, and the Web
 * UI reads overlays with no database at all.
 */
export declare function extractionRulesChecks(heldJobs?: readonly HeldJobCount[]): ExtractionRulesCheck[];
export interface OverlayBenchmarkObservation {
    recall_gate: "present" | "absent";
    extraction_rules: "present" | "absent";
    quarantine: "present" | "absent";
    disabled_by_env: boolean;
}
/**
 * What the benchmark report's `environment.overlays` must say.
 *
 * Deliberately OBSERVED from the filesystem rather than echoed from the env var:
 * the contract validator then cannot be satisfied by a report that merely claims
 * the overlays were off.
 */
export declare function observeOverlayBenchmarkEnvironment(): OverlayBenchmarkObservation;
