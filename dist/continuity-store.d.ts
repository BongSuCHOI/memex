import type Database from "better-sqlite3";
export declare const CONTINUITY_SCHEMA_VERSION = 7;
export declare const FACT_EXTRACTION_POLICY_VERSION = "continuity-fact-v1";
export type ClosureState = "open" | "interrupted" | "closed" | "final";
export type MemoryJobState = "pending" | "running" | "retry" | "completed" | "superseded" | "dead";
export type ContinuityMigrationStage = "exchange-seq-column" | "content-hash-column" | "content-generation-column" | "closure-state-column" | "parser-version-column" | "continuity-tables" | "continuity-core-tables" | "journal-source-mtime-column" | "journal-source-guard-columns" | "identity-tables" | "identity-columns" | "identity-backfill" | "identity-triggers" | "continuity-indexes" | "continuity-core-indexes" | "chronicle-table" | "chronicle-backfill" | "incident-tables" | "telemetry-table" | "chronicle-indexes" | "recall-gate-columns" | "evidence-sequence" | "capsule-terminal-state-repair" | "fts-rebuild" | "exchange-metadata" | "schema-meta" | "user-version";
export type ExtractionCommitStage = "target-items" | "generation-state" | "target-cursor" | "compatibility-watermark" | "checkpoint" | "job";
export declare function exchangeContentHash(exchange: {
    userMessage: string;
    assistantMessage: string;
    lineEnd: number;
    toolCalls?: Array<{
        id: string;
        toolName: string;
        toolInput?: unknown;
        toolResult?: string;
        isError: boolean;
    }>;
}): string;
/**
 * Additive, idempotent Continuity v1 schema migration. Existing exchange rowids
 * and every fact/provenance row remain in place. The version is written only
 * after all DDL and deterministic exchange backfill finish successfully.
 */
export declare function ensureContinuitySchema(db: Database.Database, options?: {
    afterStructuralDdl?: () => void;
    afterMigrationStage?: (stage: ContinuityMigrationStage) => void;
}): void;
export declare const CHRONICLE_EVENT_KINDS: readonly ["ASSERTED", "CHANGED", "RETIRED", "RESTORED", "VALIDATED", "INCIDENT", "CONTRADICTED"];
/** Backfill rows inserted by legacy readers or direct migration fixtures. */
export declare function refreshExchangeMetadata(db: Database.Database, sessionId?: string): void;
export interface CheckpointJobInput {
    checkpoint: {
        checkpointId: string;
        sessionId: string;
        ordinal: number;
        kind: "stop" | "interrupt" | "precompact" | "final" | "extraction";
        idempotencyKey: string;
        fromCursor?: number;
        throughCursor?: number;
        parserVersion?: number;
        closureState?: ClosureState;
    };
    job: {
        kind: string;
        partitionKey: string;
        policyVersion: string;
        priority: number;
        idempotencyKey: string;
        targetId?: string;
        maxAttempts?: number;
    };
    now?: string;
    /** Test-only crash seam. A thrown error rolls back both rows. */
    afterCheckpoint?: () => void;
    /** Test-only crash seam after the job write but before transaction commit. */
    afterJob?: () => void;
}
export declare function createCheckpointWithJob(db: Database.Database, input: CheckpointJobInput): {
    checkpointId: string;
    jobId: string;
    created: boolean;
};
export interface ClaimedMemoryJob {
    job_id: string;
    kind: string;
    partition_key: string;
    checkpoint_id: string | null;
    target_id: string | null;
    from_cursor: number | null;
    through_cursor: number | null;
    policy_version: string;
    priority: number;
    lease_owner: string;
    lease_until: string;
    lease_generation: number;
    attempts: number;
}
/**
 * Why a claim was refused. `claimMemoryJobById` returns null for four
 * structurally different situations, and consumers used to report every one of
 * them as "another runner is processing" (issue #11). The distinction is
 * observable at the call site only if the claim reports it, so the reason is
 * derived from the *same* row read the claim predicate already performs — no
 * extra query, no extra write, and no change to what is or is not claimable.
 *
 *  - `lease_held`         another job in this partition owns the lane (a live
 *                         lease, or an earlier queue item that must drain
 *                         first) — a true handoff, not a failure.
 *  - `backoff`            the job is claimable, but not yet: `available_at`
 *                         is in the future. `availableAt` carries that instant.
 *  - `attempts_exhausted` `attempts >= max_attempts` — the queue gave up; the
 *                         claim path already recorded the terminal state.
 *  - `cas`                the row vanished/settled, or a concurrent writer won
 *                         the compare-and-swap.
 */
export type MemoryJobClaimReason = "lease_held" | "backoff" | "attempts_exhausted" | "cas";
export interface MemoryJobClaimRejection {
    reason: MemoryJobClaimReason;
    /** Only for `backoff`: when the job becomes claimable again (ISO-8601). */
    availableAt?: string;
}
export interface MemoryJobClaimOutcome {
    job: ClaimedMemoryJob | null;
    rejection: MemoryJobClaimRejection | null;
}
export declare function claimMemoryJobById(db: Database.Database, input: {
    jobId: string;
    owner: string;
    now?: Date;
    leaseMs?: number;
}): ClaimedMemoryJob | null;
export declare function claimMemoryJobByIdWithReason(db: Database.Database, input: {
    jobId: string;
    owner: string;
    now?: Date;
    leaseMs?: number;
}): MemoryJobClaimOutcome;
export declare function renewMemoryJobLease(db: Database.Database, input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    now?: Date;
    leaseMs?: number;
}): boolean;
export declare function completeMemoryJob(db: Database.Database, input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    now?: Date;
}): boolean;
/**
 * Which transition a failed claim actually took (issue #34).
 *
 * `failMemoryJob` used to answer `true` for both, so callers that wanted to
 * write "retry" alongside it could not tell that the queue had just made the
 * job terminal — and they overwrote the store's own `failed-visible` with
 * `retry`. `null` still means the CAS found no owned running row.
 */
export type MemoryJobFailureTransition = "retry" | "dead";
export declare function failMemoryJob(db: Database.Database, input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    error: string;
    retry: boolean;
    availableAt?: Date;
    now?: Date;
}): MemoryJobFailureTransition | null;
export interface ExtractionTargetItem {
    ordinal: number;
    exchange_id: string;
    exchange_rowid: number;
    content_generation: number;
    content_hash: string;
}
export interface ExtractionTarget {
    targetId: string;
    jobId: string;
    sessionId: string;
    fromRowid: number;
    throughRowid: number;
    cursorOrdinal: number;
    itemCount: number;
    policyVersion: string;
    state: MemoryJobState;
}
/** Create one immutable target from a claim-time snapshot, never live completion MAX. */
export declare function ensureExtractionTarget(db: Database.Database, input: {
    sessionId: string;
    project: string;
    policyVersion?: string;
    now?: string;
}): ExtractionTarget | null;
export declare function readExtractionTargetItems(db: Database.Database, targetId: string, afterOrdinal: number, limit: number): ExtractionTargetItem[];
export declare function recordExtractionFailure(db: Database.Database, input: {
    targetId: string;
    items: ExtractionTargetItem[];
    payloadFingerprint: string;
    errorKind: string;
    errorMessage: string;
    retry: boolean;
    owner: string;
    leaseGeneration: number;
    now?: string;
}): boolean;
/**
 * Retire a claim whose immutable exchange generation changed while async work
 * was running. This is not a failed-visible extraction: the captured
 * generation is obsolete, and the current generation must form a new target.
 */
export declare function supersedeStaleExtractionTarget(db: Database.Database, input: {
    targetId: string;
    owner: string;
    leaseGeneration: number;
    now?: string;
}): boolean;
export declare function commitExtractionPage(db: Database.Database, input: {
    target: ExtractionTarget;
    items: ExtractionTargetItem[];
    owner: string;
    leaseGeneration: number;
    extracted: number;
    saved: number;
    now?: string;
    /** Test-only crash seam. Throwing rolls the complete page transaction back. */
    afterWrite?: (stage: ExtractionCommitStage) => void;
}): boolean;
export interface ExtractionTargetClaim {
    target: ExtractionTarget;
    owner: string;
    leaseGeneration: number;
}
export interface ExtractionTargetClaimOutcome {
    claim: ExtractionTargetClaim | null;
    rejection: MemoryJobClaimRejection | null;
}
export declare function claimExtractionTarget(db: Database.Database, target: ExtractionTarget, owner?: `${string}-${string}-${string}-${string}-${string}`, now?: Date): ExtractionTargetClaim | null;
/**
 * Same claim, with the refusal reason the caller needs in order to report
 * handoff, retry backoff, and attempt-cap distinctly (issue #11).
 */
export declare function claimExtractionTargetWithReason(db: Database.Database, target: ExtractionTarget, owner?: `${string}-${string}-${string}-${string}-${string}`, now?: Date): ExtractionTargetClaimOutcome;
