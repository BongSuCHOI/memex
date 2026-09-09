import type Database from "better-sqlite3";
export interface MemoryJobSummary {
    jobId: string;
    kind: string;
    state: string;
    partitionKey: string;
    checkpointId: string | null;
    targetId: string | null;
    attempts: number;
    maxAttempts: number;
    availableAt: string;
    leaseOwner: string | null;
    leaseUntil: string | null;
    /** A lease held past its expiry: the row looks `running` but nobody owns it. */
    leaseExpired: boolean;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface RetryHistoryEntry {
    at: string;
    fromState: string;
    attempts: number;
    lastError: string | null;
    /** 'retry' (operator re-queued) or 'dismiss'. */
    action: "retry" | "dismiss";
}
export interface MemoryJobDetail extends MemoryJobSummary {
    retryHistory: RetryHistoryEntry[];
    checkpoint: {
        checkpointId: string;
        kind: string;
        state: string;
        sessionId: string;
    } | null;
    capsuleCheckpointState: {
        state: string;
        lastError: string | null;
    } | null;
    target: {
        targetId: string;
        sessionId: string;
        state: string;
        itemCount: number;
        lastError: string | null;
    } | null;
    targetItemStates: Record<string, number>;
    failedRanges: Array<{
        failureId: string;
        fromOrdinal: number;
        throughOrdinal: number;
        state: string;
        errorKind: string;
        errorMessage: string;
    }>;
}
export interface RecoveryEntry {
    jobId: string | null;
    targetId: string | null;
    kind: string;
    fromState: string;
    /** Rows this unit reset, per table. Reported identically for a dry run. */
    reset: Record<string, number>;
}
export interface RecoveryResult {
    dryRun: boolean;
    entries: RecoveryEntry[];
    /** Rows that stay terminal because their CHECK constraint has no recovered state. */
    notes: string[];
}
export interface DismissResult {
    jobId: string;
    fromState: string;
    reason: string;
    reset: Record<string, number>;
    auditPath: string | null;
}
/**
 * Additive: `retry_history` preserves the failure a retry clears.
 * A read-only connection (`memex jobs list|show`) never migrates.
 */
export declare function ensureJobRecoverySchema(db: Database.Database): void;
export declare function listMemoryJobs(db: Database.Database, options?: {
    state?: string;
    kind?: string;
    limit?: number;
    now?: Date;
}): MemoryJobSummary[];
export declare function showMemoryJob(db: Database.Database, jobId: string, options?: {
    now?: Date;
}): MemoryJobDetail | null;
/**
 * Reset one terminal unit — or every dead unit — back to claimable, in a single
 * transaction over the same tables that were made terminal together.
 */
export declare function recoverTerminalWork(db: Database.Database, input: {
    jobId?: string;
    targetId?: string;
    allDead?: boolean;
    kind?: string;
    dryRun?: boolean;
    now?: Date;
}): RecoveryResult;
/**
 * Retire a job the operator does not want retried (issue #20).
 *
 * `superseded` already means "past work that does not make current state
 * stale" (docs/CONTINUITY.md §2), so no CHECK-constraint migration is needed
 * and nothing is deleted: the cause stays in `last_error`.
 */
export declare function dismissMemoryJob(db: Database.Database, input: {
    jobId: string;
    reason: string;
    now?: Date;
}): DismissResult;
/** Audit line for an operator recovery; metadata only. */
export declare function recordRecoveryAudit(result: RecoveryResult, source: string): string | null;
