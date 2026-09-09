import { type ExportStatus, type SyncExportResult } from "./sync-export.js";
import { type SyncImportResult } from "./sync-import.js";
export { readSyncConfig, resolveSyncDir, syncConfigPath, syncDirSource, type SyncConfig, } from "./sync-paths.js";
/** Why an automatic run did nothing. `null` means it ran. */
export type SyncSkipReason = "disabled" | "unchanged" | "locked" | null;
export interface SyncPeer {
    deviceId: string;
    /** Generation the peer's CURRENT manifest names, or null when unreadable. */
    generation: string | null;
    exportedAt: string | null;
    hostname: string | null;
    /** Row counts the peer's manifest pins, when it is readable. */
    counts: {
        facts: number;
        revisions: number;
        tombstones: number;
        recallEvents: number;
    } | null;
    /** True for this device's own directory. */
    isSelf: boolean;
}
export interface SyncStatus {
    enabled: boolean;
    /** Shared folder in use, and how it was chosen. */
    dir: string;
    dirSource: "env" | "configured" | "default";
    dirExists: boolean;
    dirWritable: boolean;
    configPath: string;
    updatedAt: string | null;
    deviceId: string | null;
    lastExport: ExportStatus | null;
    peers: SyncPeer[];
}
export interface SyncExportOutcome {
    skipped: SyncSkipReason;
    result: SyncExportResult | null;
    error: string | null;
}
export interface SyncImportOutcome {
    skipped: SyncSkipReason;
    result: SyncImportResult | null;
    error: string | null;
}
/** Read-only view for `memex sync status`, doctor, and the Web UI sync tab. */
export declare function getSyncStatus(): SyncStatus;
/**
 * Turn sync on or off, optionally pinning the shared folder.
 *
 * Enabling verifies the folder is usable NOW rather than discovering it in a
 * detached SessionEnd hook whose stderr nobody reads.
 */
export declare function setSyncEnabled(input: {
    enabled: boolean;
    dir?: string | null;
}): SyncStatus;
/**
 * Publish one generation when sync is on and the durable state moved.
 *
 * `force` is the explicit `memex sync export` / Web UI button: a user asking
 * for an export gets one even when nothing changed. The automatic callers
 * (SessionEnd, the maintenance wake) leave it off so an idle machine never
 * publishes an empty generation (#48 B).
 */
export declare function runSyncExport(options?: {
    force?: boolean;
}): SyncExportOutcome;
/** Reconcile peer generations when sync is on. */
export declare function runSyncImport(): Promise<SyncImportOutcome>;
/** One-line human summary shared by the CLI and the hook scripts. */
export declare function formatSyncStatus(status: SyncStatus): string;
