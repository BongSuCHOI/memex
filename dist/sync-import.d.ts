export interface SyncImportResult {
    newFacts: number;
    updatedFacts: number;
    deletedFacts: number;
    newRevisions: number;
    newTombstones: number;
    newRecallEvents: number;
    updatedRecallEvents: number;
    /** P2-7: rows (or manifests) that could not be parsed, with their source
     * location. Valid data still imports; the damage is never silent. */
    malformedRows: PayloadIssue[];
}
export interface PayloadIssue {
    file: string;
    line: number;
    error: string;
}
/**
 * Reconcile protocol-v4 sync files into the local DB.
 *
 * Input contract (재감사 P1-1/P1-4): only committed device generations are
 * read, each pinned fully into memory before any DB mutation. The former root
 * JSONL mirror is no longer an input — mixing the exporter's per-file
 * non-atomic mirror with set-atomic generations re-opened the mixed-snapshot
 * hole the generations exist to close.
 *
 * v4 row schema is validated STRICTLY before any import: a schema-invalid row
 * is payload corruption (the exporter is the payload's only writer and this
 * repository has no legacy peers), so its whole generation is rejected —
 * nothing from it imports and the damage is reported.
 *
 * Conflict order, per independent axis: the SEMANTIC axis judges meaning by
 * the semantic event clock (semantic_updated_at) with a deterministic
 * canonical fact key on exact ties; the LIFECYCLE axis judges activation by
 * lifecycle_updated_at where an exact tie resolves to inactive (재감사
 * P1-3 v4); lineage metadata (source_exchange_ids union, consolidated_count
 * max) converges monotonically regardless of either clock. Hard-delete
 * tombstones win exact-time ties. Source-created timestamps remain historical
 * data and are never used as local processing cursors.
 */
export declare function importFromSync(): Promise<SyncImportResult>;
