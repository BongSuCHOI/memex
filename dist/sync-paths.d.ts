export interface SyncConfig {
    /** #48 decision 5: default OFF. */
    enabled: boolean;
    /** Shared folder chosen by the user; null means the local default. */
    dir: string | null;
    updatedAt: string | null;
}
export declare const DEFAULT_SYNC_CONFIG: SyncConfig;
/** Local sync state directory inside the Memex data root (never shared). */
export declare function localSyncStateDir(): string;
export declare function syncConfigPath(): string;
export declare function readSyncConfig(): SyncConfig;
export declare function writeSyncConfig(config: SyncConfig): SyncConfig;
/**
 * Resolve the shared generation folder WITHOUT creating it.
 *
 * MEMEX_SYNC_DIR > configured folder > the historical local default
 * (`<data root>/conversation-index/sync`), so an installation that never
 * configures anything keeps exactly the path it had before 0.6.1.
 */
export declare function resolveSyncDir(config?: SyncConfig): string;
/** Resolve the shared folder and make sure it exists (exporter/importer entry). */
export declare function getSyncDir(): string;
/** How the shared folder was chosen — reported by `memex sync status`. */
export declare function syncDirSource(config?: SyncConfig): "env" | "configured" | "default";
