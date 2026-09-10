/** Longest alias a device may carry. Long enough for "회사 맥북 프로", short
 * enough to stay one line in `memex sync status` and the Web UI tables. */
export declare const DEVICE_ALIAS_MAX_LENGTH = 60;
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
 * Human names for device ids (#48, 0.6.3).
 *
 * `sync/devices.json` is LOCAL state beside the on/off switch: `{ "<device
 * id>": "회사 맥북" }`. A device id is a UUID, so without this every sync
 * screen and `memex sync status` line reads as hex the user cannot place.
 *
 * Two halves, deliberately:
 *  - The entry for THIS device's id travels: the exporter copies it into
 *    `meta.json` as `device_alias`, so a peer sees the name its owner chose.
 *  - Entries for OTHER device ids are this machine's private override. A peer's
 *    own name never overwrites the local map, so renaming a peer here cannot be
 *    undone by the peer's next export, and nothing this device writes changes a
 *    peer's configuration.
 */
export declare function deviceAliasPath(): string;
/** Normalize a user-typed alias. `null` means "no alias" (the entry is removed). */
export declare function normalizeDeviceAlias(alias: string | null | undefined): string | null;
export declare function readDeviceAliases(): Record<string, string>;
/** Set (or, with a blank alias, clear) one device's local name. */
export declare function setDeviceAlias(deviceId: string, alias: string | null): Record<string, string>;
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
