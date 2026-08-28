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
}
/**
 * Reconcile protocol-v2 sync files into the local DB.
 *
 * Conflict order: event timestamp, then a deterministic canonical fact key;
 * hard-delete tombstones win exact-time ties. Source-created timestamps remain
 * historical data and are never used as local processing cursors.
 */
export declare function importFromSync(): Promise<SyncImportResult>;
