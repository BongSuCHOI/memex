import type Database from 'better-sqlite3';
import { getSyncDir } from './sync-paths.js';
/** Thrown when another process is mid-export. The SessionEnd hook records it
 * to export-status (visible to doctor) and the next session retries. */
export declare class ExportLockedError extends Error {
    constructor();
}
/**
 * Serialize one local device's exporters with SQLite's process-owned write
 * transaction. The local DB is the device identity boundary, so unrelated
 * devices never contend and no lock artifact enters cloud sync. SQLite drops
 * the lock automatically when a process exits; there is no stat→unlink stale
 * break that can delete a successor's lock (재감사 P2 hardening).
 */
export declare function withExportTransaction<T>(db: Database.Database, operation: () => T): T;
/**
 * Every promotion state a project fact can hold. Before 0.6.1 the export
 * carried only the project-wide three, so branch/workspace-tier memories never
 * reached a second device while their tombstones did (#37 problems 2 and 3).
 * #48 decision 3: branch-tier memories ARE exported with their tier, workspace
 * and branch metadata; the receiving device simply does not inject them unless
 * it is on that branch.
 */
export declare const EXPORTED_PROMOTION_STATES: readonly ["legacy-project", "decision", "project-current", "workspace", "workstream"];
/**
 * Protocol 5 = protocol 4 plus the tier scope keys on each fact row
 * (`workspace_id`, `workstream_id`, `workstream_branch`) and the two extra
 * `promotion_state` values that now travel. The version is bumped rather than
 * carried additively on purpose: a 0.6.0 importer rewrites any unknown
 * promotion_state to `legacy-project`, which would silently widen a branch
 * memory into project-wide scope on the older device. Fail closed instead —
 * an older peer rejects the whole generation and says why.
 */
export declare const SYNC_PROTOCOL_VERSION = 5;
/** The payload files a committed generation must carry (meta.json excluded —
 * it is the integrity manifest OF these files). Protocol v5: ontology
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
/**
 * The shared generation folder. Resolution (MEMEX_SYNC_DIR > configured shared
 * folder > the historical local default) lives in sync-paths.ts so the
 * exporter, the importer and `memex sync status` cannot disagree (#35/#48).
 */
export { getSyncDir };
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
    /**
     * Fingerprint of the durable state this export published (#48 B). The next
     * automatic export compares against it and skips when nothing changed, so
     * SessionEnd never publishes an empty generation.
     */
    stateFingerprint?: string;
    /**
     * Resolved shared folder this export published to (#68). The fingerprint
     * above describes what reached THAT destination, so a new folder must not
     * inherit its "nothing changed" verdict.
     */
    dir?: string;
}
/**
 * Cheap fingerprint of everything the payload carries. Counts alone would miss
 * an in-place semantic edit, so each table contributes its row count and its
 * newest clock.
 */
export declare function durableStateFingerprint(db: Database.Database): string;
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
