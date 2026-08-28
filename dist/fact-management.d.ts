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
    consolidatedCountIncrement?: boolean;
    deactivateFactIds?: string[];
}
export interface SemanticMutationResult extends EditResult {
    deactivatedFactIds: string[];
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
/** Deactivate (default delete). Removes from search/vector immediately. */
export declare function deactivateFactTransactional(db: Database.Database, id: string): {
    deactivated: true;
    removedFromVectorIndex: boolean;
};
/** Restore an inactive fact and rebuild its vector from stored embedding. */
export declare function restoreFact(db: Database.Database, id: string): {
    restored: true;
    vectorRestored: boolean;
};
export declare function factHistory(db: Database.Database, id: string): Array<Record<string, unknown>>;
export interface HardDeleteImpact {
    exists: boolean;
    revisions: number;
    relations: number;
}
export declare function hardDeleteImpact(db: Database.Database, id: string): HardDeleteImpact;
/** Hard delete: exact UUID + explicit confirm required. One transaction. */
export declare function hardDeleteFact(db: Database.Database, id: string, opts: {
    confirm: boolean;
}): {
    deleted: true;
    impact: HardDeleteImpact;
};
