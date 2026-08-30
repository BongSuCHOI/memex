/** Thrown when another process is mid-export. The SessionEnd hook records it
 * to export-status (visible to doctor) and the next session retries. */
export declare class ExportLockedError extends Error {
    constructor();
}
/** The payload files a committed generation must carry (meta.json excluded —
 * it is the integrity manifest OF these files). Protocol v4: ontology
 * domains/categories/relations and the KR translation are LOCAL DERIVED state
 * — every device rebuilds them from its own facts, so they no longer travel,
 * and private-derived taxonomy can never leak through sync (재감사 P1-4 v4). */
export declare const SYNC_PAYLOAD_FILE_NAMES: readonly ["facts.jsonl", "fact-revisions.jsonl", "fact-tombstones.jsonl", "recall-events.jsonl"];
/** Non-empty JSONL lines — a generation manifest pins this count per file. */
export declare function countPayloadRows(content: string): number;
/** SHA-256 of the exact bytes a generation file carries. Cloud sync moves a
 * generation directory file-by-file, so a locally-atomic rename proves
 * nothing about what the peer device receives — the importer must verify
 * content, not existence (재감사 P1-4 보강). */
export declare function payloadSha256(content: string): string;
export declare function getSyncDir(): string;
export interface SyncExportResult {
    facts: number;
    revisions: number;
    tombstones: number;
    recallEvents: number;
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
/** Delete old committed generations (keep current + one previous) and
 * crashed tmp dirs older than an hour. Exported for the concurrency test
 * suite; production callers pass this process's own current generation. */
export declare function pruneGenerations(generationsDir: string, currentId: string): void;
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
 * generations only. The former per-file root JSONL mirror is gone: the only
 * readers are Memex v2 importers, and writing a non-atomic mirror beside an
 * atomic generation re-opened the mixed-snapshot hole for the reader that
 * also read it (재감사 P1-1). Committed generations are the whole protocol.
 */
export declare function exportForSync(): SyncExportResult;
