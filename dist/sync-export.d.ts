export declare function getSyncDir(): string;
export interface SyncExportResult {
    facts: number;
    revisions: number;
    tombstones: number;
    recallEvents: number;
    domains: number;
    categories: number;
    relations: number;
}
/**
 * Export current and historical fact state, durable recall receipts, ontology
 * domains/categories, and relations to JSONL files.
 * These JSONL files are durable cross-device state; the large local SQLite
 * index is not copied. Conversation indexes rebuild from rollouts/archives,
 * while facts, revisions, tombstones, and recall receipts reconcile from here.
 */
export declare function exportForSync(): SyncExportResult;
