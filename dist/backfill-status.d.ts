export interface BackfillWorkStatus {
    /** Retryable or currently processable work left after the foreground run. */
    total: number;
    stages: {
        extract: number;
        ontology: number;
        embeddings: number;
    };
    active: {
        total: number;
        extract: number;
    };
    unresolved: {
        total: number;
        extract: number;
        failedVisibleRanges: number;
        legacyPermanentSessions: number;
    };
    details: {
        extractionSessions: number;
        ontologyFacts: number;
        relationTargets: number;
        categoryVectors: number;
        factVectors: number;
        koreanFactVectors: number;
        exchangeVectors: number;
    };
}
export declare function getBackfillWorkStatus(opts?: {
    dbPath?: string;
}): BackfillWorkStatus;
