import type Database from "better-sqlite3";
export interface StageCounters {
    total: number;
    done: number;
    pending: number;
    /** Sessions the worker deliberately never picks (policy gate, not work). */
    excluded: number;
    /** …of which below BACKFILL_MIN_EXCHANGES. */
    excludedBelowMin: number;
    /** …of which in excluded/LLM-workdir projects. */
    excludedProject: number;
    /** Sessions with terminal legacy or failed-visible extraction state. */
    deferred: number;
    /**
     * Sessions whose extraction queue job is real, claimable work that is simply
     * not due yet (`available_at` in the future). A subset of `pending`, never of
     * `deferred`: `deferred` is terminal, backoff is a clock (issue #11).
     */
    backoff: number;
    /** Earliest `available_at` across `backoff` sessions, or null. */
    backoffEarliestAt: string | null;
    /** The configured min-exchange gate value, shown for actionability. */
    gateMinExchanges: number;
    claimed: number;
    failedPermanent: number;
    /** Exact Continuity ranges that failed deterministically; never completed. */
    failedVisible: number;
    retriable: number;
}
export interface PipelineStatus {
    dataRootEmpty: boolean;
    conversations: {
        sessionsIndexed: number;
        exchanges: number;
        archiveFiles: number;
        ready: boolean;
    };
    extraction: StageCounters & {
        lastSuccessAt: string | null;
        lastErrorAt: string | null;
    };
    embeddings: {
        activeFacts: number;
        factVectorsPending: number;
    };
    ontology: {
        classifiedFacts: number;
        pendingFacts: number;
    };
    relations: number;
    lifecycleLastEventAt: Partial<Record<string, string>>;
    readiness: {
        conversationReady: boolean;
        factReady: boolean;
        graphReady: boolean;
    };
}
export declare function getPipelineStatus(opts?: {
    dbPath?: string;
    db?: Database.Database;
}): PipelineStatus;
export declare function formatPipelineStatus(s: PipelineStatus): string;
