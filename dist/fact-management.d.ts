import type Database from 'better-sqlite3';
import { type MutationPolicy } from './fact-policy.js';
export { StaleFactMutationError } from './fact-policy.js';
import { type ChronicleActor, type ChronicleEvent, type EffectiveAtSource, type EvidenceAuthority, type GroundedField } from './chronicle.js';
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
/** ISO timestamp LWW comparator (재감사 P1-2/P1-3 v4): shared by the local
 * mutation paths and the sync lifecycle reconciliation so every surface
 * orders lifecycle events identically. */
export declare function compareTimestamps(a: string, b: string): number;
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
    /** Required by the core. The legacy entry point only adapts explicit user edits. */
    policy?: MutationPolicy;
    /** Synchronous policy validation, run inside the final writer transaction. */
    commitGuard?: () => void;
    factId: string;
    newText: string;
    reason?: string;
    source?: FactMutationSource;
    lineageMode?: 'preserve-identity';
    expectedPreviousFact?: string;
    /** Semantic CAS on the mutation target: the caller's comparison was made
     * against this generation — a newer one means the verdict is stale. */
    expectedSemanticGeneration?: number;
    /** Lifecycle CAS on the mutation target (재감사 P1-4 v4): consolidation
     * compared ACTIVE participants — a participant whose lifecycle moved
     * (deactivate/restore/replicated event) during the LLM await invalidates
     * the verdict even though semantic_generation is unchanged. */
    expectedLifecycleGeneration?: number;
    consolidatedCountIncrement?: boolean;
    /** Consolidation preserves the target's context and unions these facts'
     * local interpretive lineage. Other semantic rewrites clear stale context. */
    mergeContextFromFactIds?: string[];
    /** Facts to deactivate in the same transaction, each with the semantic AND
     * lifecycle generation its deactivation was decided against. A fact whose
     * meaning moved (edit, sync import) OR whose activation state moved
     * (deactivate/restore during the comparison await) must never be
     * deactivated by a stale verdict — the whole mutation rolls back instead
     * (재감사 P1-2, P1-4 v4). */
    deactivateFacts?: Array<{
        id: string;
        expectedSemanticGeneration: number;
        expectedLifecycleGeneration?: number;
    }>;
    /** Chronicle context for the CHANGED event written in the same transaction. */
    chronicle?: ChronicleMutationContext;
}
/**
 * Who changed the projection and what the evidence proves. `reason` on the
 * mutation is model/consolidator text and lands in `classifier_note`; only
 * `grounded` fields verified against a stored source, or a rationale typed by
 * the user, become authoritative cause/rationale.
 */
export interface ChronicleMutationContext {
    actor: ChronicleActor;
    grounded?: {
        problem?: GroundedField;
        cause?: GroundedField;
        rationale?: GroundedField;
    };
    userStatedRationale?: string | null;
    classifierNote?: string | null;
    evidenceAuthority?: EvidenceAuthority;
    effectiveAt?: string | null;
    /** How `effectiveAt` was established; a caller passing a worker clock must say `recorded`. */
    effectiveAtSource?: EffectiveAtSource;
    sourceEvidenceIds?: string[];
    revertsEventId?: string | null;
    relatedEventIds?: string[];
    outcome?: Record<string, unknown> | null;
}
export interface SemanticMutationResult extends EditResult {
    deactivatedFactIds: string[];
}
/**
 * Replace one fact's meaning while preserving its identity and revision chain.
 * Embedding generation happens before the write; every durable generation
 * transition, its Chronicle CHANGED event, and invalidation commit in one
 * transaction.
 */
export declare function mutateFactMeaning(db: Database.Database, opts: MutateFactMeaningOptions): Promise<SemanticMutationResult>;
export declare function mutateFactMeaningWithPolicy(db: Database.Database, opts: MutateFactMeaningOptions & {
    policy: MutationPolicy;
}): Promise<SemanticMutationResult>;
/**
 * Synchronous core of the semantic mutation. Callers that already hold a
 * vector (the extractor's slot resolver) run it inside their own transaction;
 * better-sqlite3 nests it as a savepoint. The CHANGED event is appended after
 * the projection UPDATE inside the same transaction, so a failed projection
 * update leaves no event and a failed event leaves no projection change.
 */
export declare function applyFactMeaningMutation(db: Database.Database, opts: MutateFactMeaningOptions, embedding: number[]): SemanticMutationResult;
export declare function applyFactMeaningMutationWithPolicy(db: Database.Database, opts: MutateFactMeaningOptions & {
    policy: MutationPolicy;
}, embedding: number[]): SemanticMutationResult;
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
export interface LifecycleChronicleOptions {
    /**
     * `false` absorbs the row silently (consolidation merged its meaning into a
     * survivor, so no truth was retired). Otherwise a RETIRED/RESTORED event is
     * appended in the same transaction; user surfaces are the default actor.
     */
    chronicle?: false | {
        actor: ChronicleActor;
        userStatedRationale?: string | null;
        classifierNote?: string | null;
        sourceExchangeIds?: string[];
        effectiveAt?: string | null;
        evidenceAuthority?: EvidenceAuthority;
    };
}
export declare function deactivateFactTransactional(db: Database.Database, id: string, options?: LifecycleChronicleOptions): {
    deactivated: true;
    removedFromVectorIndex: boolean;
    eventId: string | null;
};
export declare function restoreFact(db: Database.Database, id: string, options?: LifecycleChronicleOptions): Promise<{
    restored: true;
    vectorRestored: boolean;
    reembedded: boolean;
    eventId: string | null;
}>;
export type ReplicatedLifecycleOutcome = 'applied' | 'moot';
/**
 * Apply a REPLICATED lifecycle event (재감사 P1-2/P1-3 v4). Replication is not
 * a new event: the remote event's original clock (`eventAt`) is preserved —
 * stamping local `now` here fabricated a future timestamp that permanently
 * rejected every genuine older-clocked event behind it. The commit re-reads
 * the live row and RE-JUDGES the LWW inside the transaction, so a local
 * lifecycle event that lands during a vector-await race cannot be overwritten
 * by a stale plan: a strictly newer remote clock wins, an exact tie resolves
 * to INACTIVE (the safe default), and a same-state newer event converges the
 * clock without rewriting activation state. Any tombstone makes the event
 * moot — resurrecting a deleted fact is the SEMANTIC axis's job, never the
 * lifecycle axis's. Local user actions keep using deactivate/restoreFact,
 * which stamp `now` because they genuinely ARE new events.
 */
export declare function applyReplicatedLifecycle(db: Database.Database, id: string, desiredActive: 0 | 1, eventAt: string): Promise<ReplicatedLifecycleOutcome>;
/** Chronicle timeline for one fact in effective order (oldest first). */
export declare function factHistory(db: Database.Database, id: string): ChronicleEvent[];
export interface HardDeleteImpact {
    exists: boolean;
    revisions: number;
    relations: number;
    contextDependencies: number;
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
export type FactTier = 'workstream' | 'project' | 'global';
export type TierActor = 'user' | 'auto' | 'user-directive';
/** A one-rung rule violation. Never thrown for a legal `user-directive` skip. */
export declare class TierStepError extends Error {
    readonly from: FactTier;
    readonly to: FactTier;
    constructor(from: FactTier, to: FactTier);
}
/**
 * #77 — the fact moved (or its row changed) between the caller's read and this
 * write. A caller that names the tier and row version it saw gets the move
 * refused instead of a second rung applied on top of a concurrent winner.
 */
export declare class TierStaleError extends Error {
    readonly id: string;
    readonly expectedTier: FactTier | null;
    readonly actualTier: FactTier;
    constructor(id: string, expected: {
        tier?: FactTier;
        updatedAt?: string;
    }, actual: {
        tier: FactTier;
        updatedAt: string | null;
    });
}
export interface FactTierState {
    id: string;
    tier: FactTier;
    scopeType: string;
    promotionState: string;
    projectId: string | null;
    workspaceId: string | null;
    workstreamId: string | null;
    subjectKey: string | null;
    tierReason: string | null;
    isActive: boolean;
}
export declare function factTierOf(row: {
    scope_type: string;
    promotion_state: string | null;
}): FactTier;
export declare function readFactTier(db: Database.Database, id: string): FactTierState;
export interface TierMoveOptions {
    actor: TierActor;
    reason?: string | null;
    /** Exchange ids that ground the move. */
    evidence?: string[];
    /** Facts whose existence grounds an automatic move; a later pass demotes when they die. */
    evidenceFactIds?: string[];
    /** Target rung. Defaults to one step; only `user-directive` may span two. */
    to?: FactTier;
    /** Required to bring a global fact back into a project when it cannot be derived. */
    projectId?: string | null;
    /** Required to push a project fact onto a branch when it cannot be derived. */
    workstreamId?: string | null;
    /**
     * #77 — optimistic concurrency. The tier and/or `facts.updated_at` the caller
     * read before deciding this move; a mismatch raises `TierStaleError` and
     * nothing is written.
     */
    expected?: {
        tier?: FactTier;
        updatedAt?: string;
    };
    now?: string;
}
export interface TierMoveResult {
    id: string;
    from: FactTier;
    to: FactTier;
    steps: Array<{
        from: FactTier;
        to: FactTier;
        eventId: string;
    }>;
}
export declare function promoteFact(db: Database.Database, id: string, options: TierMoveOptions): TierMoveResult;
export declare function demoteFact(db: Database.Database, id: string, options: TierMoveOptions): TierMoveResult;
/** Move a fact to the tier an in-session scope directive named. No-op when already there. */
export declare function applyScopeDirective(db: Database.Database, id: string, directive: FactTier, options?: {
    reason?: string | null;
    evidence?: string[];
    now?: string;
}): TierMoveResult | null;
export interface TierReconcileResult {
    promoted: Array<{
        id: string;
        from: FactTier;
        to: FactTier;
        reason: string;
    }>;
    demoted: Array<{
        id: string;
        from: FactTier;
        to: FactTier;
        reason: string;
    }>;
    skipped: Array<{
        id: string;
        reason: string;
    }>;
}
/**
 * Evidence-based automatic ladder pass. Model-free: every decision below is a
 * SQL fact about the projection, never a judgement about meaning.
 *
 *   workstream → project : the same subject_key is confirmed outside this
 *                          workstream (another branch, or a project-common
 *                          session with no branch signal).
 *   project → global     : the same fact text is confirmed in ≥2 projects.
 *   demotion             : the upper evidence an automatic promotion cited is
 *                          gone — every cited fact is inactive or deleted.
 */
export declare function reconcileFactTiers(db: Database.Database, options?: {
    now?: string;
}): TierReconcileResult;
export interface TierMigrationCandidate {
    id: string;
    fact: string;
    projectId: string;
    subjectKey: string;
    workstreamId: string | null;
    branchHint: string | null;
    tierReason: string;
}
export declare function listTierMigrationCandidates(db: Database.Database): TierMigrationCandidate[];
export interface TierMigrationResult {
    promoted: string[];
    skipped: Array<{
        id: string;
        reason: string;
    }>;
}
export declare function applyTierMigration(db: Database.Database, options?: {
    now?: string;
}): TierMigrationResult;
