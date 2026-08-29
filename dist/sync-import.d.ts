export interface SyncImportResult {
    newFacts: number;
    updatedFacts: number;
    deletedFacts: number;
    newRevisions: number;
    newTombstones: number;
    newRecallEvents: number;
    updatedRecallEvents: number;
    newDomains: number;
    newCategories: number;
    newRelations: number;
    /** P2-7: rows (or manifests) that could not be parsed, with their source
     * location. Valid rows still import; the damage is never silent. */
    malformedRows: PayloadIssue[];
}
export interface PayloadIssue {
    file: string;
    line: number;
    error: string;
}
/**
 * Reconcile protocol-v2 sync files into the local DB.
 *
 * Conflict order: semantic event clock (semantic_updated_at; legacy payloads
 * fall back to updated_at), then a deterministic canonical fact key;
 * hard-delete tombstones win exact-time ties. Source-created timestamps remain
 * historical data and are never used as local processing cursors.
 */
export declare function importFromSync(): Promise<SyncImportResult>;
