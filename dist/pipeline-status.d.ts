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
    /** Sessions whose marker is SEED(-1) or a terminal PERMANENT(-2) failure —
     * the worker's pending query excludes both, so they are never pending
     * work; they stay visible here instead of inflating pending. */
    deferred: number;
    /** The configured min-exchange gate value, shown for actionability. */
    gateMinExchanges: number;
    claimed: number;
    failedPermanent: number;
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
}): PipelineStatus;
export declare function formatPipelineStatus(s: PipelineStatus): string;
