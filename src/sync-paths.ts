/**
 * Issue #35 / #48 — where the cross-device sync folder is, and whether sync is
 * on at all.
 *
 * Leaf module on purpose: `sync-export.ts` and `sync-import.ts` need the folder,
 * `sync-control.ts` needs the folder AND those two, so the configuration
 * primitives cannot live beside the exporter without a cycle.
 *
 * Two separate directories, deliberately:
 *  - The SHARED generation folder (`getSyncDir()`), which may live in iCloud
 *    Drive / Dropbox / Syncthing and is read and written by several devices.
 *  - The LOCAL sync state (`<data root>/sync/`), holding this device's on/off
 *    configuration. It must never move into the shared folder: two devices
 *    would then fight over one another's switch.
 *
 * Sync is OFF by default (#48 decision 5). Nothing leaves the machine until the
 * user runs `memex sync enable --dir <shared folder>`.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getMemexHome } from "./paths.js";

const SYNC_DIR_NAME = "sync";
const CONFIG_FILE = "config.json";

export interface SyncConfig {
  /** #48 decision 5: default OFF. */
  enabled: boolean;
  /** Shared folder chosen by the user; null means the local default. */
  dir: string | null;
  updatedAt: string | null;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  dir: null,
  updatedAt: null,
};

/** Local sync state directory inside the Memex data root (never shared). */
export function localSyncStateDir(): string {
  return path.join(getMemexHome(), SYNC_DIR_NAME);
}

export function syncConfigPath(): string {
  return path.join(localSyncStateDir(), CONFIG_FILE);
}

export function readSyncConfig(): SyncConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncConfigPath(), "utf8")) as Partial<SyncConfig>;
    return {
      enabled: parsed.enabled === true,
      dir: typeof parsed.dir === "string" && parsed.dir.trim() ? path.resolve(parsed.dir) : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    // Absent or unreadable configuration is the default: OFF. A sync switch
    // must fail closed, never fail open.
    return { ...DEFAULT_SYNC_CONFIG };
  }
}

export function writeSyncConfig(config: SyncConfig): SyncConfig {
  const target = syncConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const body = JSON.stringify(config, null, 2) + "\n";
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
  return config;
}

/**
 * Resolve the shared generation folder WITHOUT creating it.
 *
 * MEMEX_SYNC_DIR > configured folder > the historical local default
 * (`<data root>/conversation-index/sync`), so an installation that never
 * configures anything keeps exactly the path it had before 0.6.1.
 */
export function resolveSyncDir(config: SyncConfig = readSyncConfig()): string {
  const fromEnv = process.env.MEMEX_SYNC_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  if (config.dir) return config.dir;
  return path.join(getMemexHome(), "conversation-index", SYNC_DIR_NAME);
}

/** Resolve the shared folder and make sure it exists (exporter/importer entry). */
export function getSyncDir(): string {
  const dir = resolveSyncDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** How the shared folder was chosen — reported by `memex sync status`. */
export function syncDirSource(config: SyncConfig = readSyncConfig()): "env" | "configured" | "default" {
  const fromEnv = process.env.MEMEX_SYNC_DIR;
  if (fromEnv && fromEnv.trim()) return "env";
  return config.dir ? "configured" : "default";
}
