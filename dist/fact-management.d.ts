/**
 * CX-07 — transactional fact management service.
 *
 * Single mutation SSOT for CLI, Web UI and any other surface. Every mutation
 * is one better-sqlite3 transaction: partial commits are impossible.
 *
 * Delete policy: deactivate is the default; hard delete requires the exact
 * full UUID plus an explicit confirmation flag, and reports the affected
 * counts (revisions/relations/vectors) before removing anything.
 */
import type Database from 'better-sqlite3';
export interface FactRow {
    id: string;
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    is_active: number;
    ontology_category_id: string | null;
    consolidated_count: number;
    created_at: string;
    updated_at: string;
}
export declare function listFacts(db: Database.Database, opts?: {
    project?: string | null;
    scope?: 'global' | 'all';
    includeInactive?: boolean;
    limit?: number;
    offset?: number;
}): FactRow[];
export declare function showFact(db: Database.Database, id: string): Record<string, unknown> | null;
export interface EditResult {
    id: string;
    revisionId: string;
    embeddingRefreshed: boolean;
    ontologyPending: boolean;
    affectedRelations: number;
}
export interface FactMutationSource {
    exchangeId?: string;
    exchangeIds?: string[];
}
export interface MutateFactMeaningOptions {
    factId: string;
    newText: string;
    reason?: string;
    source?: FactMutationSource;
    lineageMode?: 'preserve-identity';
    expectedPreviousFact?: string;
    /** Semantic CAS on the mutation target: the caller's comparison was made
     * against this generation — a newer one means the verdict is stale. */
    expectedSemanticGeneration?: number;
    consolidatedCountIncrement?: boolean;
    /** Facts to deactivate in the same transaction, each with the semantic
     * generation its deactivation was decided against. A fact whose generation
     * moved (edit, sync import) must never be deactivated by a stale verdict —
     * the whole mutation rolls back instead (재감사 P1-2). */
    deactivateFacts?: Array<{
        id: string;
        expectedSemanticGeneration: number;
    }>;
}
export interface SemanticMutationResult extends EditResult {
    deactivatedFactIds: string[];
}
/**
 * Thrown when a semantic mutation loses a race: the fact's text changed
 * between the caller's read and the mutation commit
 * (`expectedPreviousFact` mismatch), or an async derived writer's final
 * write found a newer semantic generation. The stale result must be
 * discarded — callers treat this as "someone else moved the fact", not as
 * an internal failure.
 */
export declare class StaleFactMutationError extends Error {
    constructor(message: string);
}
/**
 * Replace one fact's meaning while preserving its identity and revision chain.
 * Embedding generation happens before the write; every durable generation
 * transition and invalidation commits in one transaction.
 */
export declare function mutateFactMeaning(db: Database.Database, opts: MutateFactMeaningOptions): Promise<SemanticMutationResult>;
/**
 * Edit a fact's text. One transaction covers:
 *   revision(old/new/reason) -> text update -> fresh embedding + vector swap ->
 *   ontology reclassification marked pending (observable NULL) -> commit.
 * Any failure rolls everything back.
 */
export declare function editFact(db: Database.Database, id: string, opts: {
    text: string;
    reason?: string;
    sourceExchangeId?: string;
}): Promise<EditResult>;
/** Deactivate (default delete). Removes from search/vector immediately.
 * Lifecycle 전환이므로 lifecycle_generation을 올린다(재감사 P1-3 v4) — sync는
 * 이 시계로 deactivate를 전파하고, restore은 이 토큰으로 await race를 폐기한다. */
export declare function deactivateFactTransactional(db: Database.Database, id: string): {
    deactivated: true;
    removedFromVectorIndex: boolean;
};
/**
 * Restore an inactive fact and rebuild its vector. The stored embedding is
 * reusable only when it was produced by the current model — search
 * (searchFactsByScope) reads current-embedding_version rows exclusively, so a
 * fact that aged through a model upgrade while inactive would otherwise be
 * "restored" into an invisible state until the reembed worker ran. Stale
 * versions are re-embedded with the current model and the vector + stamp are
 * restored together in one commit.
 */
export declare function restoreFact(db: Database.Database, id: string): Promise<{
    restored: true;
    vectorRestored: boolean;
    reembedded: boolean;
}>;
export declare function factHistory(db: Database.Database, id: string): Array<Record<string, unknown>>;
export interface HardDeleteImpact {
    exists: boolean;
    revisions: number;
    relations: number;
}
export declare function recordFactTombstone(db: Database.Database, id: string, reason?: string | null, deletedAt?: string): void;
export declare function hardDeleteImpact(db: Database.Database, id: string): HardDeleteImpact;
/** Hard delete: exact UUID + explicit confirm required. One transaction. */
export declare function hardDeleteFact(db: Database.Database, id: string, opts: {
    confirm: boolean;
}): {
    deleted: true;
    impact: HardDeleteImpact;
};
