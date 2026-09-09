export interface BackfillWorkStatus {
    /** Retryable or currently processable work left after the foreground run. */
    total: number;
    stages: {
        extract: number;
        ontology: number;
        embeddings: number;
        /** 이슈 #45: 지금 즉시 재구성 가능한 로컬 증거 영수증 수(model-free). */
        receipts: number;
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
        /** Facts with no CURRENT local receipt, whether repairable or not. */
        factsWithoutLocalEvidence: number;
        repairableReceipts: number;
    };
}
export declare function getBackfillWorkStatus(opts?: {
    dbPath?: string;
}): BackfillWorkStatus;
