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
export type RecallTrigger = "explicit_memory_intent" | "first_substantive_in_epoch" | "context_epoch_changed" | "compact_first_prompt" | "capsule_generation_changed" | "project_revision_stale" | "incident_signature_match" | "high_impact_intent" | "safety_refresh" | "topic_drift" | "low_resident_coverage" | "embedding_drift" | "no_topic_embedding";
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
    config?: Partial<RecallGateConfig>;
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
export declare function tokenizePrompt(text: string): string[];
export declare function jaccard(a: Iterable<string>, b: Iterable<string>): number;
export declare function detectPromptIntents(prompt: string): PromptIntents;
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
