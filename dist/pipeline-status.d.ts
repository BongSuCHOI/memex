export interface StageCounters {
    total: number;
    done: number;
    pending: number;
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
