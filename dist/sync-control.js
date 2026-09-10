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
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { initDatabase, openReadDb } from "./db.js";
import { getMemexHome } from "./paths.js";
import { createZip, readZip } from "./zip.js";
import { CURRENT_MANIFEST, ExportLockedError, GENERATIONS_DIR_NAME, SYNC_PAYLOAD_FILE_NAMES, durableStateFingerprint, exportForSync, readExportStatus, recordExportStatus, } from "./sync-export.js";
import { importFromSync, previewSyncImport, } from "./sync-import.js";
import { localSyncStateDir, readDeviceAliases, readSyncConfig, resolveSyncDir, syncConfigPath, syncDirSource, writeSyncConfig, } from "./sync-paths.js";
export { DEVICE_ALIAS_MAX_LENGTH, deviceAliasPath, readDeviceAliases, readSyncConfig, resolveSyncDir, setDeviceAlias, syncConfigPath, syncDirSource, } from "./sync-paths.js";
/**
 * This device's sync identity, or null when there is none to read.
 *
 * Read-only on purpose (#97): the callers are an identity QUESTION — "did this
 * machine write the file I am looking at?" — and one of them is reached from
 * `memex sync import --archive --dry-run`, which promises to change nothing.
 * `initDatabase()` would have created the database file and run every
 * `CREATE TABLE`/`ALTER TABLE` migration before the preview's own transaction
 * even opened, so a dry-run on a machine with no index left an empty one behind
 * and a dry-run on an old schema migrated it irreversibly. `openReadDb()` is
 * `fileMustExist`, so no index means no device id — which is the correct answer
 * to the question in both callers.
 */
function localDeviceId() {
    try {
        const db = openReadDb();
        try {
            const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get();
            return row?.value ?? null;
        }
        finally {
            db.close();
        }
    }
    catch {
        return null;
    }
}
function directoryWritable(dir) {
    try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
function readPeers(dir, selfDeviceId) {
    const devicesDir = path.join(dir, "devices");
    const localAliases = readDeviceAliases();
    let entries;
    try {
        entries = fs.readdirSync(devicesDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const peers = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.endsWith(".tmp"))
            continue;
        const deviceDir = path.join(devicesDir, entry.name);
        let generation = null;
        let exportedAt = null;
        try {
            const current = JSON.parse(fs.readFileSync(path.join(deviceDir, "CURRENT"), "utf8"));
            generation = typeof current.generation === "string" ? current.generation : null;
            exportedAt = typeof current.exported_at === "string" ? current.exported_at : null;
        }
        catch {
            /* a device with no readable CURRENT has no committed generation */
        }
        let hostname = null;
        let publishedAlias = null;
        let counts = null;
        if (generation) {
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(deviceDir, "generations", generation, "meta.json"), "utf8"));
                hostname = typeof meta.hostname === "string" ? meta.hostname : null;
                publishedAlias = typeof meta.device_alias === "string" && meta.device_alias.trim()
                    ? meta.device_alias.trim()
                    : null;
                counts = {
                    facts: Number(meta.facts_count ?? 0),
                    revisions: Number(meta.revisions_count ?? 0),
                    tombstones: Number(meta.tombstones_count ?? 0),
                    recallEvents: Number(meta.recall_events_count ?? 0),
                };
            }
            catch {
                /* unreadable manifest: reported as counts=null, never invented */
            }
        }
        peers.push({
            deviceId: entry.name,
            alias: localAliases[entry.name] ?? publishedAlias,
            aliasIsLocal: Object.hasOwn(localAliases, entry.name),
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
export function getSyncStatus() {
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
        deviceAlias: deviceId ? readDeviceAliases()[deviceId] ?? null : null,
        archiveDir: archiveExportDir(),
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
export function setSyncEnabled(input) {
    const current = readSyncConfig();
    const nextDir = input.dir === undefined ? current.dir : input.dir === null ? null : path.resolve(input.dir);
    const next = {
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
export function runSyncExport(options = {}) {
    const config = readSyncConfig();
    if (!config.enabled)
        return { skipped: "disabled", result: null, error: null };
    const dir = resolveSyncDir(config);
    let fingerprint = null;
    let deviceId = null;
    try {
        const db = initDatabase();
        try {
            fingerprint = durableStateFingerprint(db);
            deviceId = db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get()?.value ?? null;
        }
        finally {
            db.close();
        }
    }
    catch {
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
    if (!options.force &&
        fingerprint !== null &&
        previous?.ok === true &&
        previous.stateFingerprint === fingerprint &&
        previous.dir === dir &&
        destinationHasThisDevice) {
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A concurrent exporter is a normal skip, not a failure to report.
        if (error instanceof ExportLockedError) {
            return { skipped: "locked", result: null, error: message };
        }
        try {
            recordExportStatus({ ok: false, at: new Date().toISOString(), error: message });
        }
        catch {
            /* status recording is best-effort; the caller still gets the error */
        }
        return { skipped: null, result: null, error: message };
    }
}
/** Reconcile peer generations when sync is on. */
export async function runSyncImport() {
    if (!readSyncConfig().enabled)
        return { skipped: "disabled", result: null, error: null };
    try {
        return { skipped: null, result: await importFromSync(), error: null };
    }
    catch (error) {
        return {
            skipped: null,
            result: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
// ---------------------------------------------------------------------------
// Manual file transfer (#48, 0.6.3)
//
// The shared folder is the normal path, but it needs a folder both machines can
// see. A user with no iCloud/Dropbox/Syncthing — or one setting a second Mac up
// for the first time — needs a file they can AirDrop, mail or carry on a USB
// stick. These three helpers are that path, and they deliberately reuse the v5
// generation as-is: one zip holds exactly the files of one committed generation,
// so the import side runs the same manifest/hash/schema validation as the shared
// folder instead of a second, weaker format.
//
// Every failure message starts with "sync archive" so the Web UI can map the
// whole family to one guidance class.
// ---------------------------------------------------------------------------
/** Generation archives this device wrote, inside the data root. */
export function archiveExportDir() {
    return path.join(localSyncStateDir(), "exports");
}
/** Upper bound on an archive this device will read (a generation is JSONL). */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Upper bound on the payload inside it, after decompression. */
const MAX_ARCHIVE_PAYLOAD_BYTES = 256 * 1024 * 1024;
const ARCHIVE_FILE_NAMES = [...SYNC_PAYLOAD_FILE_NAMES, "meta.json"];
function archiveError(message) {
    return new Error(`sync archive ${message}`);
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
export function exportGenerationArchive(options = {}) {
    // Reject an impossible destination BEFORE exporting anything: a path the rule
    // forbids must not cost the user a generation (or leave staging behind).
    const requested = options.outPath ? resolveArchiveTarget(options.outPath) : null;
    if (!requested)
        assertInsideDataRoot(archiveExportDir());
    // Staging holds the same plaintext JSONL the zip does, so it is held to the
    // same rule as the output: if `<data root>/sync` is a link out of the data
    // root, refuse rather than write memories through it for even a moment.
    fs.mkdirSync(localSyncStateDir(), { recursive: true });
    assertInsideDataRoot(localSyncStateDir());
    const dir = fs.mkdtempSync(path.join(localSyncStateDir(), "archive-staging-"));
    try {
        const counts = exportForSync({ syncDir: dir });
        const deviceId = localDeviceId();
        if (!deviceId)
            throw archiveError("export found no device id after exporting — the local DB is unreadable");
        const deviceDir = path.join(dir, "devices", deviceId);
        let generation;
        try {
            generation = JSON.parse(fs.readFileSync(path.join(deviceDir, CURRENT_MANIFEST), "utf8")).generation;
        }
        catch (error) {
            throw archiveError(`export could not read the generation it just published: ${error instanceof Error ? error.message : String(error)}`);
        }
        const generationDir = path.join(deviceDir, GENERATIONS_DIR_NAME, generation);
        const entries = ARCHIVE_FILE_NAMES.map((name) => ({
            name,
            data: fs.readFileSync(path.join(generationDir, name)),
        }));
        let exportedAt = null;
        try {
            exportedAt = JSON.parse(entries[entries.length - 1].data.toString("utf8"))
                .exported_at;
        }
        catch {
            /* the manifest was just written by the exporter; treat an unreadable date as absent */
        }
        const target = requested ?? path.join(archiveExportDir(), `${deviceId}-${generation}.zip`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Issue #105 — re-check with every component really on disk. At entry the
        // data root may not have existed yet, so `requested` was judged against a
        // root that was only as real as its deepest existing ancestor; the root and
        // the output's own parent exist by now, so this is the check that sees what
        // the write will actually reach.
        assertArchiveTargetAllowed(target);
        const body = createZip(entries);
        // Same publish discipline as a generation: write beside, then rename, so a
        // reader (or a cloud folder watcher) never sees a half-written archive.
        const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, target);
        return {
            path: target,
            deviceId,
            deviceAlias: readDeviceAliases()[deviceId] ?? null,
            generation,
            exportedAt,
            bytes: body.length,
            counts,
        };
    }
    finally {
        // The zip holds the whole generation in memory by now; staging is scratch.
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch {
            /* a staging directory that refuses to go is not a reason to fail an export */
        }
    }
}
/**
 * Where `target` would really land: the real location of its deepest EXISTING
 * ancestor, with the components that do not exist yet kept on the end.
 *
 * Symlinks in the existing prefix are resolved, so this is the path a write
 * would truly reach. Issue #105 — keeping the non-existent remainder is the
 * whole point: 0.6.6 returned only the existing prefix, which made every path
 * under a data root that had not been created yet collapse onto that root's
 * deepest existing ancestor, and containment then compared two unrelated paths
 * that had both collapsed to `/tmp`.
 */
function deepestRealPath(target) {
    let probe = path.resolve(target);
    const missing = [];
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
        missing.unshift(path.basename(probe));
        probe = path.dirname(probe);
    }
    let real;
    try {
        real = fs.realpathSync(probe);
    }
    catch {
        real = probe;
    }
    return missing.length ? path.join(real, ...missing) : real;
}
/**
 * Issue #101 — containment compares REAL locations, not path strings.
 *
 * `path.resolve()` does not resolve symlinks, so a string prefix check let one
 * link inside the data root carry a write outside it (`<root>/link/x.zip` with
 * `<root>/link -> ~/Documents`). Resolving the root too fixes the mirror-image
 * misbehaviour: a data root reached through a link (macOS `/tmp` ->
 * `/private/tmp`) used to reject legitimate absolute paths naming its own files.
 */
function insideDataRoot(target) {
    const root = deepestRealPath(getMemexHome());
    const real = deepestRealPath(target);
    return real === root || real.startsWith(root + path.sep);
}
function assertInsideDataRoot(target) {
    if (!insideDataRoot(target)) {
        throw archiveError(`export path must stay inside the data root (${deepestRealPath(getMemexHome())})`);
    }
}
function assertArchiveTargetAllowed(target) {
    assertInsideDataRoot(target);
    // An existing final component that is itself a symlink is refused rather than
    // followed: the rule is about where bytes land, and a link's target is not
    // covered by the check above.
    let link = null;
    try {
        link = fs.lstatSync(target);
    }
    catch {
        /* nothing there yet is the normal case */
    }
    if (link?.isSymbolicLink())
        throw archiveError("export path is a symlink");
}
/**
 * Keep a server-side write inside the data root.
 *
 * The Web UI asks a loopback server to write a file the browser cannot download
 * (its sandbox blocks that), so the path comes from a text field. Confining it to
 * the data root means a typo — or a hostile page that got past the CSRF token —
 * cannot overwrite `~/.ssh/authorized_keys`. Reading is not restricted this way:
 * an imported file arrives wherever the user's download folder is.
 */
function resolveArchiveTarget(outPath) {
    if (!path.isAbsolute(outPath))
        throw archiveError("export path must be absolute");
    const resolved = path.resolve(outPath);
    assertArchiveTargetAllowed(resolved);
    if (!resolved.toLowerCase().endsWith(".zip"))
        throw archiveError("export path must end with .zip");
    return resolved;
}
/**
 * Materialize one archive (zip file, or an already-unpacked generation
 * directory) as a one-device shared folder in a temp dir.
 *
 * Only the five protocol-v5 file names are taken, matched on their basename, so
 * a zip made by Finder ("compress this folder", which nests everything under the
 * folder name and may add `__MACOSX/`) works without the user flattening it. The
 * manifest's own `device_id`/`generation` decide where the staged copy goes —
 * the integrity pass then re-checks that agreement, so a renamed file cannot
 * smuggle a generation in under another device's identity.
 */
function stageArchive(source) {
    if (!path.isAbsolute(source))
        throw archiveError("path must be absolute");
    const resolved = path.resolve(source);
    let stat;
    try {
        stat = fs.statSync(resolved);
    }
    catch {
        throw archiveError(`was not found at ${resolved}`);
    }
    const files = new Map();
    if (stat.isDirectory()) {
        for (const name of ARCHIVE_FILE_NAMES) {
            try {
                files.set(name, fs.readFileSync(path.join(resolved, name)));
            }
            catch {
                throw archiveError(`directory is missing ${name} — point at one generation directory or its zip`);
            }
        }
    }
    else {
        if (stat.size > MAX_ARCHIVE_BYTES) {
            throw archiveError(`is larger than the ${MAX_ARCHIVE_BYTES} bytes this device reads`);
        }
        let unpacked;
        try {
            unpacked = readZip(fs.readFileSync(resolved), { maxTotalBytes: MAX_ARCHIVE_PAYLOAD_BYTES });
        }
        catch (error) {
            throw archiveError(`is not a readable zip: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const [name, data] of unpacked) {
            const base = path.posix.basename(name);
            if (ARCHIVE_FILE_NAMES.includes(base) && !files.has(base))
                files.set(base, data);
        }
        const missing = ARCHIVE_FILE_NAMES.filter((name) => !files.has(name));
        if (missing.length > 0) {
            throw archiveError(`zip is missing ${missing.join(", ")} — it is not a Memex generation export`);
        }
    }
    let manifest;
    try {
        manifest = JSON.parse(files.get("meta.json").toString("utf8"));
    }
    catch (error) {
        throw archiveError(`has an unreadable meta.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    const deviceId = typeof manifest.device_id === "string" ? manifest.device_id : "";
    const generation = typeof manifest.generation === "string" ? manifest.generation : "";
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(deviceId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(generation)) {
        throw archiveError("meta.json does not name a device and a generation");
    }
    // Importing this device's own export would replay a snapshot of the local DB
    // over itself. The clocks make that harmless, but it is always a mistake —
    // say so instead of reporting a no-op import.
    if (deviceId === localDeviceId()) {
        throw archiveError("was exported by THIS device — import a file from the other Mac");
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-sync-archive-"));
    const deviceDir = path.join(dir, "devices", deviceId);
    const generationDir = path.join(deviceDir, GENERATIONS_DIR_NAME, generation);
    fs.mkdirSync(generationDir, { recursive: true });
    for (const name of ARCHIVE_FILE_NAMES)
        fs.writeFileSync(path.join(generationDir, name), files.get(name));
    fs.writeFileSync(path.join(deviceDir, CURRENT_MANIFEST), JSON.stringify({ generation }, null, 2));
    return {
        dir,
        deviceId,
        deviceAlias: readDeviceAliases()[deviceId] ??
            (typeof manifest.device_alias === "string" && manifest.device_alias.trim()
                ? manifest.device_alias.trim()
                : null),
        generation,
        source: resolved,
        cleanup: () => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            }
            catch {
                /* a temp directory that refuses to go is not a reason to fail an import */
            }
        },
    };
}
/** Validate an archive and report what importing it WOULD do. Changes nothing. */
export function previewImportArchive(source) {
    const staged = stageArchive(source);
    try {
        return {
            ...previewSyncImport({ syncDir: staged.dir }),
            source: staged.source,
            deviceId: staged.deviceId,
            deviceAlias: staged.deviceAlias,
            generation: staged.generation,
        };
    }
    finally {
        staged.cleanup();
    }
}
/** Apply one archive through the normal importer. */
export async function importArchive(source) {
    const staged = stageArchive(source);
    try {
        return {
            source: staged.source,
            deviceId: staged.deviceId,
            deviceAlias: staged.deviceAlias,
            generation: staged.generation,
            result: await importFromSync({ syncDir: staged.dir }),
        };
    }
    finally {
        staged.cleanup();
    }
}
/** One-line human summary shared by the CLI and the hook scripts. */
export function formatSyncStatus(status) {
    const lines = [];
    lines.push(`Sync: ${status.enabled ? "ON" : "OFF"} (config: ${status.configPath})`);
    lines.push(`Shared folder: ${status.dir} (${status.dirSource})` +
        `${status.dirExists ? (status.dirWritable ? "" : " — NOT WRITABLE") : " — does not exist yet"}`);
    lines.push(`This device: ${status.deviceId ?? "not assigned yet (assigned on first export)"}` +
        (status.deviceAlias ? ` "${status.deviceAlias}"` : " (no alias — memex sync alias <name>)"));
    if (!status.lastExport) {
        lines.push(status.enabled
            ? "Last export: never — SessionEnd and the maintenance wake export when durable state changed"
            : "Last export: never (sync is off)");
    }
    else if (status.lastExport.ok) {
        const counts = status.lastExport.counts;
        lines.push(`Last export: ok at ${status.lastExport.at}` +
            (counts
                ? ` (${counts.facts} facts, ${counts.revisions} revisions, ${counts.tombstones} tombstones, ${counts.recallEvents} recall events)`
                : ""));
    }
    else {
        lines.push(`Last export: FAILED at ${status.lastExport.at}: ${status.lastExport.error ?? "unknown"}`);
    }
    if (status.peers.length === 0) {
        lines.push("Devices in the shared folder: none yet");
    }
    else {
        lines.push(`Devices in the shared folder: ${status.peers.length}`);
        for (const peer of status.peers) {
            lines.push(`  ${peer.alias ? `"${peer.alias}" ` : ""}${peer.deviceId}${peer.isSelf ? " (this device)" : ""}` +
                ` generation=${peer.generation ?? "none"} exported_at=${peer.exportedAt ?? "-"}` +
                (peer.hostname ? ` host=${peer.hostname}` : "") +
                (peer.counts ? ` facts=${peer.counts.facts}` : " manifest=unreadable"));
        }
    }
    return lines.join("\n");
}
