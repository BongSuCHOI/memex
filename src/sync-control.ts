/**
 * Issue #35 / #48 — the one place cross-device sync is switched on, inspected,
 * and run.
 *
 * Before this, `exportForSync()` had exactly one caller
 * (`scripts/sync-export-hook.js`) and that script was registered in no hook, no
 * bin entry and no CLI command, while `memex doctor` reported `sync-export: ok`
 * and told the user to wait for a SessionEnd that would never call it. Sync
 * imported and never exported.
 *
 * Every surface goes through this module: the CLI (`memex sync
 * enable|disable|status|export|import`), the SessionEnd and maintenance hooks,
 * doctor, and the Web UI sync tab that is built on top of it later. The four
 * exported entry points — getSyncStatus, setSyncEnabled, runSyncExport,
 * runSyncImport — are the complete read/write surface.
 *
 * Off by default (#48 decision 5): with sync disabled every automatic path is a
 * one-line no-op and nothing leaves the machine.
 */
import fs from "node:fs";
import path from "node:path";
import { initDatabase } from "./db.js";
import {
  ExportLockedError,
  durableStateFingerprint,
  exportForSync,
  readExportStatus,
  recordExportStatus,
  type ExportStatus,
  type SyncExportResult,
} from "./sync-export.js";
import { importFromSync, type SyncImportResult } from "./sync-import.js";
import {
  readSyncConfig,
  resolveSyncDir,
  syncConfigPath,
  syncDirSource,
  writeSyncConfig,
  type SyncConfig,
} from "./sync-paths.js";

export {
  readSyncConfig,
  resolveSyncDir,
  syncConfigPath,
  syncDirSource,
  type SyncConfig,
} from "./sync-paths.js";

/** Why an automatic run did nothing. `null` means it ran. */
export type SyncSkipReason = "disabled" | "unchanged" | "locked" | null;

export interface SyncPeer {
  deviceId: string;
  /** Generation the peer's CURRENT manifest names, or null when unreadable. */
  generation: string | null;
  exportedAt: string | null;
  hostname: string | null;
  /** Row counts the peer's manifest pins, when it is readable. */
  counts: { facts: number; revisions: number; tombstones: number; recallEvents: number } | null;
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

function localDeviceId(): string | null {
  try {
    const db = initDatabase();
    try {
      const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get() as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function directoryWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readPeers(dir: string, selfDeviceId: string | null): SyncPeer[] {
  const devicesDir = path.join(dir, "devices");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const peers: SyncPeer[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(".tmp")) continue;
    const deviceDir = path.join(devicesDir, entry.name);
    let generation: string | null = null;
    let exportedAt: string | null = null;
    try {
      const current = JSON.parse(fs.readFileSync(path.join(deviceDir, "CURRENT"), "utf8")) as {
        generation?: unknown;
        exported_at?: unknown;
      };
      generation = typeof current.generation === "string" ? current.generation : null;
      exportedAt = typeof current.exported_at === "string" ? current.exported_at : null;
    } catch {
      /* a device with no readable CURRENT has no committed generation */
    }
    let hostname: string | null = null;
    let counts: SyncPeer["counts"] = null;
    if (generation) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(path.join(deviceDir, "generations", generation, "meta.json"), "utf8"),
        ) as Record<string, unknown>;
        hostname = typeof meta.hostname === "string" ? meta.hostname : null;
        counts = {
          facts: Number(meta.facts_count ?? 0),
          revisions: Number(meta.revisions_count ?? 0),
          tombstones: Number(meta.tombstones_count ?? 0),
          recallEvents: Number(meta.recall_events_count ?? 0),
        };
      } catch {
        /* unreadable manifest: reported as counts=null, never invented */
      }
    }
    peers.push({
      deviceId: entry.name,
      generation,
      exportedAt,
      hostname,
      counts,
      isSelf: selfDeviceId !== null && entry.name === selfDeviceId,
    });
  }
  return peers.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

/** Read-only view for `memex sync status`, doctor, and the Web UI sync tab. */
export function getSyncStatus(): SyncStatus {
  const config = readSyncConfig();
  const dir = resolveSyncDir(config);
  const deviceId = localDeviceId();
  const dirExists = fs.existsSync(dir);
  return {
    enabled: config.enabled,
    dir,
    dirSource: syncDirSource(config),
    dirExists,
    dirWritable: dirExists && directoryWritable(dir),
    configPath: syncConfigPath(),
    updatedAt: config.updatedAt,
    deviceId,
    lastExport: readExportStatus(),
    peers: dirExists ? readPeers(dir, deviceId) : [],
  };
}

/**
 * Turn sync on or off, optionally pinning the shared folder.
 *
 * Enabling verifies the folder is usable NOW rather than discovering it in a
 * detached SessionEnd hook whose stderr nobody reads.
 */
export function setSyncEnabled(input: { enabled: boolean; dir?: string | null }): SyncStatus {
  const current = readSyncConfig();
  const nextDir =
    input.dir === undefined ? current.dir : input.dir === null ? null : path.resolve(input.dir);
  const next: SyncConfig = {
    enabled: input.enabled,
    dir: nextDir,
    updatedAt: new Date().toISOString(),
  };
  if (next.enabled) {
    const dir = resolveSyncDir(next);
    fs.mkdirSync(dir, { recursive: true });
    if (!directoryWritable(dir)) {
      throw new Error(`shared sync folder is not writable: ${dir}`);
    }
  }
  const previousDir = resolveSyncDir(current);
  writeSyncConfig(next);
  // Issue #68: the recorded fingerprint is a statement about the OLD folder —
  // "everything the DB holds already reached it". Pointing sync at a new,
  // empty folder used to inherit that verdict, so the first automatic export
  // reported `unchanged` and the new folder stayed empty until the DB moved.
  if (resolveSyncDir(next) !== previousDir) {
    const previous = readExportStatus();
    if (previous?.stateFingerprint !== undefined) {
      const { stateFingerprint: _discarded, ...rest } = previous;
      recordExportStatus(rest);
    }
  }
  return getSyncStatus();
}

/**
 * Publish one generation when sync is on and the durable state moved.
 *
 * `force` is the explicit `memex sync export` / Web UI button: a user asking
 * for an export gets one even when nothing changed. The automatic callers
 * (SessionEnd, the maintenance wake) leave it off so an idle machine never
 * publishes an empty generation (#48 B).
 */
export function runSyncExport(options: { force?: boolean } = {}): SyncExportOutcome {
  const config = readSyncConfig();
  if (!config.enabled) return { skipped: "disabled", result: null, error: null };

  const dir = resolveSyncDir(config);
  let fingerprint: string | null = null;
  let deviceId: string | null = null;
  try {
    const db = initDatabase();
    try {
      fingerprint = durableStateFingerprint(db);
      deviceId = (db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get() as
        | { value: string }
        | undefined)?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    // Unreadable DB: let the export itself fail and record the real reason.
    fingerprint = null;
  }
  const previous = readExportStatus();
  // Issue #68: "nothing changed" is a claim about a DESTINATION, not about the
  // DB alone. The status file is local, so after `memex sync enable --dir B`
  // the fingerprint recorded for folder A skipped the first export to B and B
  // stayed empty. Require the same folder, and require that this device's own
  // generation pointer is actually there.
  const destinationHasThisDevice = deviceId !== null &&
    fs.existsSync(path.join(dir, "devices", deviceId, "CURRENT"));
  if (
    !options.force &&
    fingerprint !== null &&
    previous?.ok === true &&
    previous.stateFingerprint === fingerprint &&
    previous.dir === dir &&
    destinationHasThisDevice
  ) {
    return { skipped: "unchanged", result: null, error: null };
  }

  try {
    const result = exportForSync();
    recordExportStatus({
      ok: true,
      at: new Date().toISOString(),
      counts: result,
      dir,
      ...(fingerprint ? { stateFingerprint: fingerprint } : {}),
    });
    return { skipped: null, result, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A concurrent exporter is a normal skip, not a failure to report.
    if (error instanceof ExportLockedError) {
      return { skipped: "locked", result: null, error: message };
    }
    try {
      recordExportStatus({ ok: false, at: new Date().toISOString(), error: message });
    } catch {
      /* status recording is best-effort; the caller still gets the error */
    }
    return { skipped: null, result: null, error: message };
  }
}

/** Reconcile peer generations when sync is on. */
export async function runSyncImport(): Promise<SyncImportOutcome> {
  if (!readSyncConfig().enabled) return { skipped: "disabled", result: null, error: null };
  try {
    return { skipped: null, result: await importFromSync(), error: null };
  } catch (error) {
    return {
      skipped: null,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One-line human summary shared by the CLI and the hook scripts. */
export function formatSyncStatus(status: SyncStatus): string {
  const lines: string[] = [];
  lines.push(`Sync: ${status.enabled ? "ON" : "OFF"} (config: ${status.configPath})`);
  lines.push(
    `Shared folder: ${status.dir} (${status.dirSource})` +
      `${status.dirExists ? (status.dirWritable ? "" : " — NOT WRITABLE") : " — does not exist yet"}`,
  );
  lines.push(`This device: ${status.deviceId ?? "not assigned yet (assigned on first export)"}`);
  if (!status.lastExport) {
    lines.push(
      status.enabled
        ? "Last export: never — SessionEnd and the maintenance wake export when durable state changed"
        : "Last export: never (sync is off)",
    );
  } else if (status.lastExport.ok) {
    const counts = status.lastExport.counts;
    lines.push(
      `Last export: ok at ${status.lastExport.at}` +
        (counts
          ? ` (${counts.facts} facts, ${counts.revisions} revisions, ${counts.tombstones} tombstones, ${counts.recallEvents} recall events)`
          : ""),
    );
  } else {
    lines.push(`Last export: FAILED at ${status.lastExport.at}: ${status.lastExport.error ?? "unknown"}`);
  }
  if (status.peers.length === 0) {
    lines.push("Devices in the shared folder: none yet");
  } else {
    lines.push(`Devices in the shared folder: ${status.peers.length}`);
    for (const peer of status.peers) {
      lines.push(
        `  ${peer.deviceId}${peer.isSelf ? " (this device)" : ""}` +
          ` generation=${peer.generation ?? "none"} exported_at=${peer.exportedAt ?? "-"}` +
          (peer.hostname ? ` host=${peer.hostname}` : "") +
          (peer.counts ? ` facts=${peer.counts.facts}` : " manifest=unreadable"),
      );
    }
  }
  return lines.join("\n");
}
