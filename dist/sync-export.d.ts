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
/** Durable record of the last sync export attempt (P2-6). SessionEnd must
 * never wedge on export, so failures live here — visible to stderr, the
 * parent hook, and doctor — instead of vanishing with exit 0. */
export interface ExportStatus {
    ok: boolean;
    at: string;
    error?: string;
    counts?: SyncExportResult;
}
export declare function readExportStatus(): ExportStatus | null;
export declare function recordExportStatus(status: ExportStatus): void;
/**
 * Export current and historical fact state, durable recall receipts, ontology
 * domains/categories, and relations to JSONL files.
 * These JSONL files are durable cross-device state; the large local SQLite
 * index is not copied. Conversation indexes rebuild from rollouts/archives,
 * while facts, revisions, tombstones, and recall receipts reconcile from here.
 *
 * P2-5: one export is one *generation*. Every DB read happens inside a single
 * read transaction, the whole file set is written into
 * `devices/<id>/generations/<uuid>.tmp` and committed by an atomic directory
 * rename, and only then does the `CURRENT` manifest flip atomically — so a
 * crash, a cloud-sync observer, or a concurrent export can never surface a
 * mixed snapshot (facts=N+1 with revisions=N). The importer reads committed
 * generations only. The root JSONL mirror (v1 reader compatibility) is
 * refreshed per-file after the generation commit; it is a compat surface, not
 * the authoritative device state.
 */
export declare function exportForSync(): SyncExportResult;
