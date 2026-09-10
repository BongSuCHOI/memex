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
const DEVICES_FILE = "devices.json";
/** Longest alias a device may carry. Long enough for "회사 맥북 프로", short
 * enough to stay one line in `memex sync status` and the Web UI tables. */
export const DEVICE_ALIAS_MAX_LENGTH = 60;
export const DEFAULT_SYNC_CONFIG = {
    enabled: false,
    dir: null,
    updatedAt: null,
};
/** Local sync state directory inside the Memex data root (never shared). */
export function localSyncStateDir() {
    return path.join(getMemexHome(), SYNC_DIR_NAME);
}
export function syncConfigPath() {
    return path.join(localSyncStateDir(), CONFIG_FILE);
}
export function readSyncConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(syncConfigPath(), "utf8"));
        return {
            enabled: parsed.enabled === true,
            dir: typeof parsed.dir === "string" && parsed.dir.trim() ? path.resolve(parsed.dir) : null,
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        };
    }
    catch {
        // Absent or unreadable configuration is the default: OFF. A sync switch
        // must fail closed, never fail open.
        return { ...DEFAULT_SYNC_CONFIG };
    }
}
export function writeSyncConfig(config) {
    const target = syncConfigPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = JSON.stringify(config, null, 2) + "\n";
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
    return config;
}
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
export function deviceAliasPath() {
    return path.join(localSyncStateDir(), DEVICES_FILE);
}
/** Normalize a user-typed alias. `null` means "no alias" (the entry is removed). */
export function normalizeDeviceAlias(alias) {
    if (typeof alias !== "string")
        return null;
    // Control characters would break one-line status output and table cells.
    const trimmed = alias.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return trimmed ? trimmed.slice(0, DEVICE_ALIAS_MAX_LENGTH) : null;
}
export function readDeviceAliases() {
    try {
        const parsed = JSON.parse(fs.readFileSync(deviceAliasPath(), "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [deviceId, alias] of Object.entries(parsed)) {
            const normalized = normalizeDeviceAlias(typeof alias === "string" ? alias : null);
            if (normalized)
                out[deviceId] = normalized;
        }
        return out;
    }
    catch {
        // An absent or unreadable alias map is simply "no names yet" — never fatal.
        return {};
    }
}
/** Set (or, with a blank alias, clear) one device's local name. */
export function setDeviceAlias(deviceId, alias) {
    if (!deviceId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(deviceId)) {
        throw new Error(`device id is not a sync device identifier: ${JSON.stringify(deviceId)}`);
    }
    const aliases = readDeviceAliases();
    const normalized = normalizeDeviceAlias(alias);
    if (normalized)
        aliases[deviceId] = normalized;
    else
        delete aliases[deviceId];
    const target = deviceAliasPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(aliases, null, 2) + "\n");
    fs.renameSync(tmp, target);
    return aliases;
}
/**
 * Resolve the shared generation folder WITHOUT creating it.
 *
 * MEMEX_SYNC_DIR > configured folder > the historical local default
 * (`<data root>/conversation-index/sync`), so an installation that never
 * configures anything keeps exactly the path it had before 0.6.1.
 */
export function resolveSyncDir(config = readSyncConfig()) {
    const fromEnv = process.env.MEMEX_SYNC_DIR;
    if (fromEnv && fromEnv.trim())
        return path.resolve(fromEnv.trim());
    if (config.dir)
        return config.dir;
    return path.join(getMemexHome(), "conversation-index", SYNC_DIR_NAME);
}
/** Resolve the shared folder and make sure it exists (exporter/importer entry). */
export function getSyncDir() {
    const dir = resolveSyncDir();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
/** How the shared folder was chosen — reported by `memex sync status`. */
export function syncDirSource(config = readSyncConfig()) {
    const fromEnv = process.env.MEMEX_SYNC_DIR;
    if (fromEnv && fromEnv.trim())
        return "env";
    return config.dir ? "configured" : "default";
}
