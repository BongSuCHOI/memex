/**
 * Phase 5 pre-retrieval cheap gate (RFC §12.3).
 *
 * Runs before any embedding, vector search, relation expansion or model call.
 * It decides from local session state and a cheap lexical fingerprint whether
 * the prompt needs recall (`retrieve`), clearly does not (`skip`), or is
 * ambiguous (`ambiguous`: exactly one embedding is allowed, and that embedding
 * is reused for retrieval). The gate itself never calls an LLM.
 */
export interface RecallGateConfig {
    /** Prompts with at most this many tokens can be acknowledgements/continuations. */
    ackMaxTokens: number;
    /** Substantive prompts since the last retrieval that force a safety refresh. */
    safetyRefreshInterval: number;
    /** Jaccard below this against the topic fingerprint is significant drift (needs ≥ driftMinTokens). */
    driftJaccard: number;
    driftMinTokens: number;
    /** Prompt tokens needed before "no resident coverage" triggers. */
    coverageMinTokens: number;
    /**
     * Ambiguous path: the prompt is coherent with the current topic when
     * cos(prompt, topic) exceeds the prompt's own background baseline by this
     * margin (the same probe-relative rule retrieval uses, so it is not tied to
     * one embedding model's absolute scale).
     */
    coherentMargin: number;
    /** Tokens above which a prompt is substantive even without other signals. */
    substantiveMinTokens: number;
    /** Jaccard against the topic fingerprint at or above which a substantive prompt is a lexical continuation (no embedding). */
    lexicalCoherentJaccard: number;
}
export declare const DEFAULT_RECALL_GATE_CONFIG: RecallGateConfig;
export type RecallTrigger = "explicit_memory_intent" | "first_substantive_in_epoch" | "context_epoch_changed" | "compact_first_prompt" | "capsule_generation_changed" | "project_revision_stale" | "resident_revision_stale" | "hot_evidence_pending" | "incident_signature_match" | "high_impact_intent" | "safety_refresh" | "topic_drift" | "low_resident_coverage" | "embedding_drift" | "no_topic_embedding";
export type RecallSkipReason = "acknowledgement" | "continuation" | "minor_correction" | "coherent_topic" | "empty_prompt";
export interface PromptIntents {
    /** why / history / source / when / previous / repeated — explicit memory question. */
    memory: boolean;
    /** why / rationale / related decision / dependency / contradiction / architecture — enables graph/TRACE. */
    trace: boolean;
    /** decide / switch / migrate / rollback / change — high-impact decision prompt. */
    highImpact: boolean;
    acknowledgement: boolean;
    continuation: boolean;
}
export interface RecallGateState {
    contextEpoch: number;
    lastRetrievalEpoch: number;
    lastSource: string | null;
    capsuleGenerationSeen: number;
    memoryRevisionSeen: number;
    topicFingerprint: string[];
    hasTopicEmbedding: boolean;
    informativePromptsSinceRetrieval: number;
    residentTokens: Set<string>;
}
export interface RecallGateInput {
    prompt: string;
    state: RecallGateState;
    currentCapsuleGeneration: number;
    currentProjectRevision: number;
    incidentMatched: boolean;
    /**
     * A revision resident in this epoch moved to a newer semantic/lifecycle
     * generation or was deactivated. Workstream truth changes carry no project
     * revision token (BRANCH TRUTH), so residency itself is the invalidation
     * signal (RFC §11.4, §12.6).
     */
    residentRevisionStale?: boolean;
    hotEvidencePending?: boolean;
    config?: Partial<RecallGateConfig>;
    /**
     * Issue #29: the user overlay's contribution, already evaluated elsewhere.
     * Absent (the default, and every installation without an overlay file) means
     * this gate behaves exactly as it did in 0.6.9.
     */
    userHits?: UserIntentHits;
}
export interface RecallGateDecision {
    action: "retrieve" | "skip" | "ambiguous";
    triggers: RecallTrigger[];
    skipReason: RecallSkipReason | null;
    intents: PromptIntents;
    tokens: string[];
    substantive: boolean;
    /** Jaccard of the prompt tokens against the topic fingerprint (null when no fingerprint). */
    topicOverlap: number | null;
}
/**
 * Built-in gate catalogue (issue #29, 0.7.0) — a BEHAVIOUR-PRESERVING refactor.
 *
 * Until 0.6.9 the three intent detectors were single giant alternations, which
 * made two things impossible: turning ONE term off, and saying which term made
 * the gate fire. Both are the whole point of a user overlay, so the literals
 * are now id-bearing term lists that are COMPOSED back into the same regex.
 *
 * `test/recall-gate-catalog.test.ts` holds the v0.6.9 literals verbatim and
 * asserts the composed `source` is byte-identical to them. That golden is the
 * only direct evidence that decomposing the alternation did not move a single
 * gate verdict; keep it passing or the refactor has silently changed recall.
 *
 * `form`:
 *  - `alternative` — one branch of a composed alternation (the intent regexes).
 *  - `whole`       — a standalone regex that was already its own array element.
 */
export type GateIntent = "memory" | "trace" | "highImpact" | "acknowledgement" | "continuation" | "minorCorrection";
export type GateLexicon = "ack" | "continue" | "filler";
export interface BuiltinGatePattern {
    /** Stable, user-facing id: `<prefix>.<lang>.<slug>`. Never renumbered. */
    id: string;
    intent: GateIntent;
    source: string;
    flags: string;
    form: "alternative" | "whole";
}
/**
 * Hits the caller precomputed for the USER's overlay patterns.
 *
 * `recall-gate.ts` is a pure, synchronous, fs-free module and it NEVER executes
 * a user-authored regex: user patterns run only inside the time-boxed matcher
 * worker (src/overlay-matcher.ts), and only the resulting ids arrive here.
 */
export interface UserIntentHits {
    /** Overlay pattern ids that fired, per intent. */
    intents: Partial<Record<GateIntent, readonly string[]>>;
    /** Built-in catalogue ids the overlay disabled. */
    disabledPatterns?: readonly string[];
    /** Lexicon add/disable from the overlay (plain words — no regex involved). */
    words?: {
        add?: Partial<Record<GateLexicon, readonly string[]>>;
        disable?: Partial<Record<GateLexicon, readonly string[]>>;
    };
}
export declare const BUILTIN_GATE_PATTERNS: readonly BuiltinGatePattern[];
export interface ComposedGatePatterns {
    memory: RegExp | null;
    trace: RegExp | null;
    highImpact: RegExp | null;
    acknowledgement: Array<{
        id: string;
        re: RegExp;
    }>;
    continuation: Array<{
        id: string;
        re: RegExp;
    }>;
    minorCorrection: Array<{
        id: string;
        re: RegExp;
    }>;
}
export declare function composeGatePatterns(disabledIds?: readonly string[]): ComposedGatePatterns;
export declare function tokenizePrompt(text: string): string[];
export declare function jaccard(a: Iterable<string>, b: Iterable<string>): number;
/**
 * Built-in lexicons. The WORD ITSELF is the id — there is nothing to compose and
 * nothing to execute, so the overlay's word add/disable is applied on the main
 * thread (§2.5). `new Set(array)` preserves the literal order, so iteration
 * order is unchanged from 0.6.9.
 */
export declare const BUILTIN_GATE_WORDS: Readonly<Record<GateLexicon, readonly string[]>>;
/** Which catalogue/overlay ids fired, per intent — the basis of `memex gate test`. */
export interface IntentExplanation {
    intents: PromptIntents;
    matched: Record<GateIntent, Array<{
        id: string;
        origin: "builtin" | "user";
    }>>;
}
export declare function detectPromptIntents(prompt: string, hits?: UserIntentHits): PromptIntents;
export declare function explainPromptIntents(prompt: string, hits?: UserIntentHits): IntentExplanation;
export declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * Cheap gate decision. Order matters: explicit memory intent is never skipped
 * because a prompt is short; state-change triggers (epoch/Capsule/project
 * revision/incident) fire before lexical judgments — including for
 * acknowledgements, so the first "continue" of a new epoch still carries the
 * Capsule (the caller renders it without any vector work); otherwise
 * acknowledgements and continuations skip; everything else is judged by
 * fingerprint overlap and, when still unclear, deferred to one embedding
 * (`ambiguous`).
 */
export declare function decideRecall(input: RecallGateInput): RecallGateDecision;
/**
 * Resolve an ambiguous decision with the single embedding the caller computed.
 * `baseline` is the prompt's max similarity to the background probes; the
 * prompt is coherent with the current topic only when it beats that baseline
 * by `coherentMargin`, otherwise it drifted and retrieval runs.
 */
export declare function resolveAmbiguousDecision(decision: RecallGateDecision, promptEmbedding: number[], topicEmbedding: number[] | null, baseline: number, config?: Partial<RecallGateConfig>): RecallGateDecision;
export declare function embeddingToBlob(embedding: number[]): Buffer;
export declare function blobToEmbedding(blob: unknown): number[] | null;
