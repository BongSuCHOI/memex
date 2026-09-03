import type Database from "better-sqlite3";
export declare const CONTINUITY_SCHEMA_VERSION = 1;
export declare const FACT_EXTRACTION_POLICY_VERSION = "continuity-fact-v1";
export type ClosureState = "open" | "interrupted" | "closed" | "final";
export type MemoryJobState = "pending" | "running" | "retry" | "completed" | "superseded" | "dead";
export type ContinuityMigrationStage = "exchange-seq-column" | "content-hash-column" | "content-generation-column" | "closure-state-column" | "parser-version-column" | "continuity-tables" | "continuity-indexes" | "fts-rebuild" | "exchange-metadata" | "schema-meta" | "user-version";
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
export declare function claimMemoryJobById(db: Database.Database, input: {
    jobId: string;
    owner: string;
    now?: Date;
    leaseMs?: number;
}): ClaimedMemoryJob | null;
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
export declare function failMemoryJob(db: Database.Database, input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    error: string;
    retry: boolean;
    availableAt?: Date;
    now?: Date;
}): boolean;
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
export declare function claimExtractionTarget(db: Database.Database, target: ExtractionTarget, owner?: `${string}-${string}-${string}-${string}-${string}`, now?: Date): {
    target: ExtractionTarget;
    owner: string;
    leaseGeneration: number;
} | null;
