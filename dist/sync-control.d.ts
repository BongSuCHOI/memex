import { type ExportStatus, type SyncExportResult } from "./sync-export.js";
import { type SyncImportPreview, type SyncImportResult } from "./sync-import.js";
export { DEVICE_ALIAS_MAX_LENGTH, deviceAliasPath, readDeviceAliases, readSyncConfig, resolveSyncDir, setDeviceAlias, syncConfigPath, syncDirSource, type SyncConfig, } from "./sync-paths.js";
export { type SyncImportPreview } from "./sync-import.js";
/** Why an automatic run did nothing. `null` means it ran. */
export type SyncSkipReason = "disabled" | "unchanged" | "locked" | null;
export interface SyncPeer {
    deviceId: string;
    /**
     * Human name for this device id (#48, 0.6.3): the local `sync/devices.json`
     * entry if there is one, otherwise the alias the peer published in its
     * manifest, otherwise null. Never invented from the hostname.
     */
    alias: string | null;
    /** True when the alias came from this device's own local map. */
    aliasIsLocal: boolean;
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
    /** This device's own alias (#48, 0.6.3) — travels in every generation's manifest. */
    deviceAlias: string | null;
    /** Where `memex sync export --archive` writes by default. */
    archiveDir: string;
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
/** Generation archives this device wrote, inside the data root. */
export declare function archiveExportDir(): string;
export interface GenerationArchive {
    /** Absolute path of the zip this call wrote. */
    path: string;
    deviceId: string;
    deviceAlias: string | null;
    generation: string;
    exportedAt: string | null;
    bytes: number;
    counts: SyncExportResult;
}
/**
 * Publish one generation and hand back a single zip file.
 *
 * Works with sync OFF on purpose: the switch governs the AUTOMATIC paths and the
 * shared folder, while this is an explicit user action whose whole point is
 * having no shared folder. The generation is written through the normal
 * exporter, so the file a user carries is the same set-atomic, hash-pinned
 * generation a peer would have read from a shared folder.
 *
 * Issue #95 — it publishes into a PRIVATE staging directory inside the data
 * root, never into the shared folder. Before this it called the exporter with no
 * destination, so the exporter resolved the shared folder and `getSyncDir()`
 * CREATED it: with the switch off, and even after the user had deleted the
 * folder, one `--archive` re-created an iCloud/Dropbox folder and published
 * plaintext memories into it — while `memex sync status` still said `Sync: OFF`.
 * A hand-carried file has nothing to do with the shared destination, so it now
 * touches neither the folder nor what a peer would read from it. That also makes
 * the deliberate absence of an `export-status.json` update consistent: that
 * record states what reached the shared DESTINATION, and nothing does here.
 */
export declare function exportGenerationArchive(options?: {
    outPath?: string;
}): GenerationArchive;
export interface ArchivePreviewOutcome extends SyncImportPreview {
    source: string;
    deviceId: string;
    deviceAlias: string | null;
    generation: string;
}
/** Validate an archive and report what importing it WOULD do. Changes nothing. */
export declare function previewImportArchive(source: string): ArchivePreviewOutcome;
export interface ArchiveImportOutcome {
    source: string;
    deviceId: string;
    deviceAlias: string | null;
    generation: string;
    result: SyncImportResult;
}
/** Apply one archive through the normal importer. */
export declare function importArchive(source: string): Promise<ArchiveImportOutcome>;
/** One-line human summary shared by the CLI and the hook scripts. */
export declare function formatSyncStatus(status: SyncStatus): string;
