/**
 * CX-01 — Codex lifecycle registration, diagnosis, removal.
 *
 * Contract (documented in docs/CONVERSATION-LIFECYCLE.md, codex-cli 0.150.1):
 *  - The hook config owner is $CODEX_HOME/hooks.json (user scope). Plugin
 *    marketplace plugins declare hooks through plugin.json; explicit setup is
 *    retained only as a fingerprinted fallback for non-plugin hosts.
 *  - Registered commands use ABSOLUTE paths resolved at setup time.
 *    `${PLUGIN_ROOT}` is not assumed to expand inside Codex hooks.
 *  - Ownership: every Memex entry carries a fingerprint marker comment
 *    field `"_memex": true` plus the exact command string recorded in
 *    lifecycle-registration.json under the Memex data root. remove only
 *    touches entries whose command matches a registered fingerprint; foreign
 *    entries are preserved byte-for-byte (2-space JSON indent, key order kept).
 *  - Idempotent: running setup twice produces zero new entries.
 *  - Never installs dependencies or plugins; never mutates anything outside
 *    $CODEX_HOME/hooks.json and the Memex data root.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { lastObserved, readHookEventTail } from "./observe-hook-event.js";
import { scanCaptureGapMarkers, } from "./capture-gap-markers.js";
import { hookBudgetMs, hookHostTimeoutMs, NO_TRANSCRIPT_CAPTURE_REASON, } from "./hook-budget.js";
import { getDbPath, getMemexHome } from "./paths.js";
import { CURRENT_SCHEMA_VERSION } from "./schema-version.js";
import { resolveLlmSelection } from "./model-settings.js";
import { readExportStatus } from "./sync-export.js";
import { readSyncConfig, resolveSyncDir } from "./sync-paths.js";
import { getInjectLogPath } from "./inject-log.js";
import { recallGateOverlayChecks } from "./recall-gate-overlay.js";
import { extractionRulesChecks } from "./extraction-rules.js";
import { missingRuntimeDependencies, RUNTIME_DEPENDENCIES, resolveInstalledPluginRoot, } from "./plugin-root.js";
import { embeddingCacheStatus, formatCacheBytes, legacyEmbeddingCacheCandidates, } from "./model-cache.js";
const runtimeRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "Interrupt",
    "PreCompact",
    "PostCompact",
    "SessionEnd",
];
/** Relative-to-plugin-root commands registered for each event. */
/**
 * Issue #166 — `timeout` is the HOST timeout in seconds, and the hook budget in
 * src/hook-budget.ts is derived from it (timeout - one exit margin). These
 * numbers, hooks.json and HOOK_HOST_TIMEOUT_MS are pinned together by a test:
 * a budget derived from a timeout the host does not grant is worse than none.
 * Per learn.chatgpt.com/docs/hooks the cap is 600 s for SessionStart, Stop,
 * PreCompact, PostCompact and UserPromptSubmit; SessionEnd and Interrupt are the
 * only two events that default to 1 s and accept at most 3 s, so those two stay
 * at 3 (#166 review).
 */
export const LIFECYCLE_COMMANDS = {
    SessionStart: [
        { script: "scripts/continuity-hook.js", matcher: "startup|resume|clear|compact", timeout: 10 },
        { script: "scripts/version-drift-check.js", async: true, matcher: "startup|resume" },
        { script: "cli/memex.js", args: ["sync", "--background"], async: true, matcher: "startup|resume" },
        { script: "scripts/sync-import-hook.js", async: true, matcher: "startup|resume" },
        { script: "scripts/session-start-maintenance.js", async: true, matcher: "startup|resume" },
    ],
    UserPromptSubmit: [
        { script: "scripts/inject-context-hook.sh" },
        { script: "scripts/session-start-maintenance.js", args: ["--prompt"], async: true },
    ],
    Stop: [{ script: "scripts/continuity-hook.js", timeout: 10 }],
    Interrupt: [{ script: "scripts/continuity-hook.js", timeout: 3 }],
    PreCompact: [{ script: "scripts/continuity-hook.js", matcher: "manual|auto", timeout: 15 }],
    PostCompact: [{ script: "scripts/continuity-hook.js", matcher: "manual|auto", timeout: 10 }],
    // Issue #35: SessionEnd is still a bounded final capture fence — the export
    // is a SEPARATE async entry that Codex does not wait for. It is a no-op
    // unless cross-device sync is enabled AND durable state changed since the
    // last export, so the common case costs one process that exits immediately.
    SessionEnd: [
        { script: "scripts/continuity-hook.js", timeout: 3 },
        // #110/#112: a synchronous timed entry — Codex runs SessionEnd hooks synchronously
        // regardless (warned when this was `async`) and clamps SessionEnd timeouts to 3 s
        // (warned when this said 10).
        { script: "scripts/sync-export-hook.js", timeout: 3 },
    ],
};
/** Hook scripts that must be registered for cross-device sync to work at all. */
export const SYNC_LIFECYCLE_SCRIPTS = {
    export: "scripts/sync-export-hook.js",
    import: "scripts/sync-import-hook.js",
};
/** True when `script` is registered for at least one lifecycle event. */
export function isLifecycleScriptRegistered(script) {
    return HOOK_EVENTS.some((event) => LIFECYCLE_COMMANDS[event].some((command) => command.script === script));
}
const OWNERSHIP_KEY = "_memex";
function codexHome() {
    return process.env.CODEX_HOME
        ? path.resolve(process.env.CODEX_HOME)
        : path.join(os.homedir(), ".codex");
}
export function hooksFilePath() {
    return path.join(codexHome(), "hooks.json");
}
export function dataRoot() {
    // Single-source resolution (MEMEX_HOME > XDG > default).
    const dir = getMemexHome();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function registrationPath() {
    return path.join(dataRoot(), "lifecycle-registration.json");
}
export function pluginRoot() {
    const override = process.env.MEMEX_PLUGIN_ROOT;
    return override
        ? path.resolve(override)
        : path.resolve(HERE, "..");
}
export function fingerprintOf(command) {
    return crypto.createHash("sha256").update(command).digest("hex").slice(0, 16);
}
function readHooksFile(file) {
    if (!fs.existsSync(file))
        return {};
    let raw = "";
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (e) {
        throw new Error(`cannot read ${file}: ${e.message}`);
    }
    if (!raw.trim())
        return {};
    // A malformed config must fail loud, never be silently clobbered by setup.
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object")
            return parsed;
        throw new Error("not a JSON object");
    }
    catch {
        throw new Error(`${file} is not valid JSON — fix or remove it manually; refusing to touch it`);
    }
}
function serializeHooksFile(hooks) {
    // Preserve foreign key order via JSON.stringify on plain objects (insertion
    // order) and keep the file byte-stable when nothing changed.
    return JSON.stringify(hooks, null, 2) + "\n";
}
export function commandFor(root, c) {
    const runner = c.script.endsWith(".sh") ? "bash" : "node";
    const scriptPath = path.join(root, c.script);
    const extraArgs = c.args && c.args.length > 0
        ? " " +
            c.args
                .map((a) => (a.includes(" ") && !a.startsWith('"') ? `"${a}"` : a))
                .join(" ")
        : "";
    return `${runner} "${scriptPath}"${extraArgs}`;
}
/** Build the desired entry list for a given plugin root (absolute commands). */
export function desiredEntries(root = pluginRoot()) {
    const entries = [];
    for (const event of HOOK_EVENTS) {
        for (const c of LIFECYCLE_COMMANDS[event]) {
            entries.push({
                event,
                command: commandFor(root, c),
                ...(c.async ? { async: true } : {}),
                ...(c.matcher ? { matcher: c.matcher } : {}),
                ...(c.timeout ? { timeout: c.timeout } : {}),
            });
        }
    }
    return entries;
}
/** Compute the exact add/remove diff against the current hooks.json. */
export function planSetup(root = pluginRoot()) {
    const hooks = readHooksFile(hooksFilePath());
    const desired = desiredEntries(root);
    const desiredCmds = new Set(desired.map((d) => d.command));
    const existingKeys = new Set();
    let preservedForeign = 0;
    let staleOwned = 0;
    for (const event of HOOK_EVENTS) {
        for (const block of hooks.hooks?.[event] ?? []) {
            for (const h of block.hooks ?? []) {
                if (!h.command || typeof h.command !== "string")
                    continue;
                if (h[OWNERSHIP_KEY] === true) {
                    existingKeys.add(`${event}\0${block.matcher ?? ""}\0${h.command}`);
                    // Owned entry pointing at a path that no longer exists or not desired -> stale
                    const m = h.command.match(/"([^"]+)"/);
                    const p = m ? m[1] : "";
                    if ((p && !fs.existsSync(p)) || !desiredCmds.has(h.command))
                        staleOwned++;
                }
                else {
                    preservedForeign++;
                }
            }
        }
    }
    const add = desired
        .filter((d) => !existingKeys.has(`${d.event}\0${d.matcher ?? ""}\0${d.command}`))
        .map(({ event, command, matcher, timeout }) => ({ event, command, matcher, timeout }));
    return {
        targetFile: hooksFilePath(),
        add,
        remove: [],
        preservedForeignEntries: preservedForeign,
        staleOwnedEntries: staleOwned,
    };
}
/** Apply the idempotent setup. Returns what changed. Never runs installers. */
export function setupHooks({ dryRun = false, root = pluginRoot(), } = {}) {
    // Fail loud when the handler scripts are not resolvable at this root.
    for (const d of desiredEntries(root)) {
        const m = d.command.match(/"([^"]+)"/);
        const p = m ? m[1] : "";
        if (!p || !fs.existsSync(p)) {
            throw new Error(`handler not found: ${p || d.command}\n` +
                "Build first: npm install && npm run build (never run automatically)");
        }
    }
    const file = hooksFilePath();
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const hooks = readHooksFile(file);
    const diff = planSetup(root);
    if (!dryRun) {
        const desired = desiredEntries(root);
        const desiredKeys = new Set(desired.map((d) => `${d.event}\0${d.matcher ?? ""}\0${d.command}`));
        // Prune owned entries whose registered path no longer exists (plugin
        // relocation / cache-version bump) or that are not in desired commands,
        // then re-add at the current root.
        if (hooks.hooks)
            for (const event of HOOK_EVENTS) {
                const blocks = hooks.hooks?.[event];
                if (!Array.isArray(blocks))
                    continue;
                for (const block of blocks) {
                    if (!block.hooks)
                        continue;
                    block.hooks = block.hooks.filter((h) => {
                        if (h[OWNERSHIP_KEY] !== true)
                            return true;
                        const m = h.command ? h.command.match(/"([^"]+)"/) : null;
                        if (m && !fs.existsSync(m[1]))
                            return false;
                        return desiredKeys.has(`${event}\0${block.matcher ?? ""}\0${h.command ?? ""}`);
                    });
                }
                hooks.hooks[event] = blocks.filter((b) => (b.hooks ?? []).length > 0);
                if (hooks.hooks[event]?.length === 0)
                    delete hooks.hooks[event];
            }
    }
    if (!dryRun && diff.add.length > 0) {
        if (!hooks.hooks)
            hooks.hooks = {};
        for (const { event, command, async, matcher, timeout } of desiredEntries(root).filter((x) => diff.add.some((a) => a.event === x.event && a.command === x.command &&
            (a.matcher ?? "") === (x.matcher ?? "")))) {
            if (!hooks.hooks[event])
                hooks.hooks[event] = [];
            let block = hooks.hooks[event].find((b) => (b.matcher ?? "") === (matcher ?? ""));
            if (!block) {
                block = { matcher: matcher ?? "", hooks: [] };
                hooks.hooks[event].push(block);
            }
            if (!block.hooks)
                block.hooks = [];
            block.hooks.push({
                type: "command",
                command,
                ...{ [OWNERSHIP_KEY]: true },
                ...(async ? { async: true } : {}),
                ...(timeout ? { timeout } : {}),
            });
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, serializeHooksFile(hooks), { mode: 0o644 });
    }
    // Persist/refresh the ownership record regardless (cheap, local).
    const reg = {
        schemaVersion: 2,
        installedAt: new Date().toISOString(),
        pluginRoot: root,
        codexHome: codexHome(),
        hooksFile: file,
        entries: desiredEntries(root).map(({ event, command, ...rest }) => ({
            event,
            command,
            fingerprint: fingerprintOf(command),
            ...rest,
        })),
    };
    const after = dryRun
        ? before
        : fs.existsSync(file)
            ? fs.readFileSync(file, "utf8")
            : "";
    if (!dryRun) {
        fs.writeFileSync(registrationPath(), JSON.stringify(reg, null, 2) + "\n");
    }
    const changed = !dryRun && after !== before;
    return { changed, diff, registrationPath: registrationPath() };
}
/** Remove only Memex-owned entries (exact fingerprint match). */
export function removeHooks({ dryRun = false, } = {}) {
    const file = hooksFilePath();
    const owned = new Set();
    try {
        const reg = JSON.parse(fs.readFileSync(registrationPath(), "utf8"));
        for (const e of reg.entries)
            owned.add(e.command);
    }
    catch {
        /* no registration record: fall back to ownership flag */
    }
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const hooks = readHooksFile(file);
    let removed = 0;
    let preservedForeign = 0;
    if (hooks.hooks) {
        for (const event of Object.keys(hooks.hooks)) {
            const blocks = hooks.hooks[event];
            if (!Array.isArray(blocks))
                continue;
            const keptBlocks = [];
            for (const block of blocks) {
                const kept = [];
                for (const h of block.hooks ?? []) {
                    const isOurs = h[OWNERSHIP_KEY] === true ||
                        (typeof h.command === "string" && owned.has(h.command));
                    if (isOurs)
                        removed++;
                    else {
                        kept.push(h);
                        if (typeof h.command === "string")
                            preservedForeign++;
                    }
                }
                // Keep foreign matcher blocks untouched; drop blocks we emptied.
                if (kept.length > 0 || (block.hooks?.length ?? 0) === 0) {
                    keptBlocks.push(kept.length === (block.hooks?.length ?? 0)
                        ? block
                        : { ...block, hooks: kept });
                }
            }
            if (keptBlocks.length > 0)
                hooks.hooks[event] = keptBlocks;
            else
                delete hooks.hooks[event];
        }
        if (Object.keys(hooks.hooks).length === 0)
            delete hooks.hooks;
    }
    const serialized = serializeHooksFile(hooks);
    const changed = !dryRun && serialized !== before;
    if (changed) {
        fs.writeFileSync(file, serialized, { mode: 0o644 });
        try {
            fs.rmSync(registrationPath(), { force: true });
        }
        catch {
            /* ignore */
        }
    }
    // `removed` is the observed/would-observe count in both dry-run and apply.
    void dryRun;
    return { removed, preservedForeignEntries: preservedForeign, dryRun };
}
function trustStateLines() {
    try {
        const cfg = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
        return cfg.split("\n").filter((l) => l.trim().startsWith("[hooks.state."));
    }
    catch {
        return [];
    }
}
function hasTrustFor(_event) {
    return trustStateLines().some((l) => l.includes(hooksFilePath()));
}
function trustedEventsConfigured() {
    return trustStateLines().length > 0;
}
function pluginManagedHookEvents() {
    try {
        const root = pluginRoot();
        const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
        if (!fs.existsSync(manifestPath))
            return [];
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (typeof manifest.hooks !== "string")
            return [];
        const hookPath = path.resolve(root, manifest.hooks);
        if (!hookPath.startsWith(root + path.sep) || !fs.existsSync(hookPath))
            return [];
        const config = JSON.parse(fs.readFileSync(hookPath, "utf8"));
        return HOOK_EVENTS.filter((event) => Array.isArray(config.hooks?.[event]) && config.hooks[event].length > 0);
    }
    catch {
        return [];
    }
}
/** How many recent injection-log lines the injection checks read. */
const INJECT_LOG_WINDOW = 20;
/** Parse the tail of the injection log; malformed lines are skipped, never thrown. */
function readInjectLogTail(limit) {
    try {
        const logPath = getInjectLogPath();
        if (!fs.existsSync(logPath))
            return [];
        const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
        const out = [];
        for (const line of lines.slice(-limit)) {
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed === "object")
                    out.push(parsed);
            }
            catch {
                /* a truncated tail line is not a diagnosis */
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
/** Count rows without importing the heavy db.js chain; null when unreadable. */
function countRows(table) {
    try {
        const dbPath = getDbPath();
        if (!fs.existsSync(dbPath))
            return null;
        const Database = runtimeRequire("better-sqlite3");
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const exists = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
                .get(table);
            if (!exists)
                return null;
            return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
        }
        finally {
            db.close();
        }
    }
    catch {
        return null;
    }
}
/**
 * Issue #41 — `IndexRepairError` says "manual repair required", and that
 * sentence used to live only in logs/backfill-ontology.log, a file no
 * diagnostic reads. Read its durable marker with the same lightweight
 * connection countRows uses (never the heavy db.js chain).
 */
function readOntologyIndexRepairMarker() {
    try {
        const dbPath = getDbPath();
        if (!fs.existsSync(dbPath))
            return null;
        const Database = runtimeRequire("better-sqlite3");
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const exists = db
                .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'ontology_index_repair_state'")
                .get();
            if (!exists)
                return null;
            const row = db
                .prepare("SELECT state, blocked_reason, detected_at FROM ontology_index_repair_state WHERE id = 1")
                .get();
            if (!row)
                return { blocked: false, reason: null, detectedAt: null };
            return {
                blocked: row.state === "blocked",
                reason: row.blocked_reason ?? null,
                detectedAt: row.detected_at ?? null,
            };
        }
        finally {
            db.close();
        }
    }
    catch {
        return null;
    }
}
/**
 * Issue #44 — the injection log and `recall_events` can diverge completely.
 *
 * The observed data root emitted 7 bundles (`status: "injected"`) and held 0
 * `recall_events` rows, with no privacy purge to explain it. Every emission is
 * supposed to be backed by a durable `prepared` receipt
 * (RETRIEVAL-AND-CONTEXT.md §43-48), so post-hoc audit — which fact entered
 * which session, when — was impossible. Nothing compared the two numbers.
 */
function recallProvenanceCheck(recent) {
    const emitted = recent.filter((entry) => entry.status === "injected" || entry.status === "context-only").length;
    const receiptFailures = recent.filter((entry) => entry.status === "receipt-failed").length;
    const receipts = countRows("recall_events");
    if (receipts === null) {
        return {
            name: "recall-provenance",
            status: emitted > 0 ? "warn" : "ok",
            detail: emitted > 0
                ? `${emitted} emitted bundle(s) in the last ${recent.length} log lines but recall_events is unreadable`
                : "no recall_events table yet (no injection observed)",
        };
    }
    if (receiptFailures > 0) {
        return {
            name: "recall-provenance",
            status: "fail",
            detail: `${receiptFailures} of the last ${recent.length} injections emitted context whose recall receipt stayed 'prepared' ` +
                `(recall_events rows=${receipts}). Post-hoc audit of those emissions is impossible.`,
        };
    }
    if (emitted > 0 && receipts === 0) {
        return {
            name: "recall-provenance",
            status: "fail",
            detail: `${emitted} emitted bundle(s) in the last ${recent.length} log lines but recall_events is empty — ` +
                "the injection provenance contract is broken (no privacy purge explains an empty table).",
        };
    }
    if (emitted > receipts) {
        return {
            name: "recall-provenance",
            status: "warn",
            detail: `${emitted} emitted bundle(s) in the last ${recent.length} log lines vs ${receipts} recall_events row(s)`,
        };
    }
    return {
        name: "recall-provenance",
        status: "ok",
        detail: `${receipts} recall_events row(s) back ${emitted} emitted bundle(s) in the last ${recent.length} log lines`,
    };
}
/** A run that produced no facts, whatever else it emitted. */
const ZERO_FACT_STATUSES = new Set(["context-only", "no-match", "deduped"]);
/** Consecutive zero-fact runs before the pipeline is reported as not delivering. */
const ZERO_FACT_STREAK_LIMIT = 8;
/**
 * Issue #32 — "the memory system is running" was indistinguishable from
 * "no fact has ever been injected".
 *
 * The observed data root ran the pipeline 12 times over five days: candidates
 * = 5 every time, injected facts = 0 every time, sum of `injected_facts`
 * telemetry = 0. Seven of those runs emitted a bundle (Capsule or assistant
 * context) and were logged as `injected`, so the number of injected facts was
 * unreadable from the log. Doctor read only the LAST line, whose `no-match`
 * status is a normal outcome, and reported `inject-output: ok`.
 */
function injectionYieldCheck(recent) {
    const retrievals = recent.filter((entry) => entry.status === "injected" ||
        ZERO_FACT_STATUSES.has(String(entry.status)));
    if (retrievals.length === 0) {
        return {
            name: "injection-yield",
            status: "ok",
            detail: "no retrieval recorded yet in the injection log",
        };
    }
    const facts = retrievals.reduce((sum, entry) => sum + Number(entry.injected ?? 0), 0);
    let streak = 0;
    for (let i = retrievals.length - 1; i >= 0; i--) {
        if (Number(retrievals[i].injected ?? 0) > 0)
            break;
        streak++;
    }
    const contextOnly = retrievals.filter((entry) => entry.status === "context-only").length;
    const lexicalDead = recent.filter((entry) => entry.lexical_lane === "unavailable").length;
    const suffix = (contextOnly > 0 ? ` context-only=${contextOnly}` : "") +
        (lexicalDead > 0 ? ` lexical_lane=unavailable×${lexicalDead}` : "");
    if (streak >= ZERO_FACT_STREAK_LIMIT && facts === 0) {
        return {
            name: "injection-yield",
            status: "warn",
            detail: `${streak} consecutive retrievals injected 0 facts (candidates were found).` +
                `${suffix} Inspect the relevance gate: telemetry metric baseline_margin_gap, ` +
                "override MEMEX_INJECT_BASELINE_MARGIN.",
        };
    }
    return {
        name: "injection-yield",
        status: lexicalDead > 0 ? "warn" : "ok",
        detail: `${facts} fact(s) injected across the last ${retrievals.length} retrieval(s), current zero-fact streak ${streak}.${suffix}`,
    };
}
/**
 * Who owns the injection fast-path socket, and is it this installation (#84)?
 *
 * Read-only by construction: the probe asks for an identity, never for an
 * injection, so running `doctor` cannot produce a recall receipt or a log line.
 *
 * Observed on the real data root: a development checkout's MCP server, started
 * by another host from a pre-0.6.0 `dist`, held the socket and answered every
 * prompt the 0.6.2 hook sent. Nothing in `doctor` or `status` showed it — this
 * check exists so that state is visible instead of inferred from odd log lines.
 */
async function injectDaemonCheck() {
    const name = "inject-daemon";
    let daemon;
    try {
        // Dynamic: keeps the injection core (and the embedding model chain) off
        // every other doctor check's import path.
        daemon = await import("./inject-daemon.js");
    }
    catch (error) {
        return {
            name, status: "warn",
            detail: `unable to inspect the inject daemon: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const policy = daemon.injectDaemonPolicy();
    // The identity that MATTERS is the one `scripts/inject-context.js` computes,
    // and that script runs from the INSTALLED root. This process is frequently not
    // that root: `~/.local/bin/memex` is an npx shim (issue #53), so judging the
    // owner against doctor's own copy would report a perfectly healthy
    // installation as "a different build" and point the operator at a pid to kill.
    // `probeCodex: true` is allowed here — a diagnostic may spawn.
    const installedRoot = (() => {
        try {
            return resolveInstalledPluginRoot({ fallbackRoot: pluginRoot(), probeCodex: true }).root;
        }
        catch {
            return pluginRoot();
        }
    })();
    const expected = daemon.injectDaemonIdentityFor(installedRoot);
    const self = daemon.injectDaemonIdentity();
    const where = `socket ${daemon.injectSocketPath()}; hooks run from ${expected.pluginRoot} ` +
        `(version ${expected.version ?? "unknown"})` +
        (self.pluginRoot === expected.pluginRoot
            ? ""
            : `; this diagnostic runs from ${self.pluginRoot}`) +
        `; listener here ${policy.open ? "on" : "off"}: ${policy.reason}`;
    // Issue #99: an over-long socket path makes bind(2) AND connect(2) fail for
    // every process, so there is no owner to find and no reclaim that can ever
    // succeed — `sun_path` is a fixed 104/108-byte array and a long data root is
    // all it takes. Reported before the probe, because the probe's own
    // EINVAL/ENAMETOOLONG would otherwise be dressed up as a `hung` listener.
    const tooLong = daemon.injectSocketPathTooLong();
    if (tooLong) {
        return {
            name, status: "warn",
            detail: `socket path too long (${tooLong.bytes} bytes; this platform allows ${tooLong.limit}) — ` +
                `bind() cannot succeed, so no daemon can open the fast path and every prompt pays the cold ` +
                `in-process path (~2.3s). Shorten the data root (MEMEX_HOME, or XDG_CONFIG_HOME) and restart ` +
                `the host; the daemon records the same reason in logs/hook-events.jsonl ` +
                `(event InjectDaemonBindFailed). ${where}`,
        };
    }
    let probe;
    try {
        probe = await daemon.probeInjectDaemon(undefined, daemon.INJECT_DAEMON_DIAGNOSTIC_TIMEOUT_MS);
    }
    catch (error) {
        return {
            name, status: "warn",
            detail: `could not probe the inject daemon: ${error instanceof Error ? error.message : String(error)} — ${where}`,
        };
    }
    if (!probe.listening) {
        // Issue #89 split this. `no daemon` used to cover both "nothing has started
        // yet", which is ordinary, and "the owner exited and left its socket file
        // behind", which on the observed data root meant every prompt paid the 70s
        // cold path for as long as the host kept running — and was reported as ok.
        if (probe.code === "ENOENT") {
            return {
                name, status: "ok",
                detail: `absent — no socket file; every prompt pays the cold in-process path (~2.3s). ${where}`,
            };
        }
        const candidates = daemon.readInjectDaemonCandidates();
        const stale = `stale — a socket file exists but nothing listens on it (${probe.code ?? "unreachable"}): ` +
            `its owner exited. Every prompt pays the cold in-process path (~2.3s) until it is reclaimed.`;
        if (candidates.length === 0) {
            return {
                name, status: "warn",
                detail: `${stale} NO live MCP server is waiting to reclaim it, so nothing will: start a host with this ` +
                    `plugin (or restart the one you have) to reopen the fast path. ${where}`,
            };
        }
        const who = candidates
            .map((candidate) => `pid ${candidate.pid} version ${candidate.version ?? "unknown"} root ${candidate.pluginRoot}` +
            (candidate.reprobeMs > 0 ? ` (re-probes every ${candidate.reprobeMs}ms)` : ""))
            .join("; ");
        return {
            name, status: "ok",
            detail: `${stale} Reacquisition is pending — ${candidates.length} live server(s) re-probe it on a timer and ` +
                `on their next MCP request: ${who}. ${where}`,
        };
    }
    // A pid identifies the WHOLE MCP server, not a daemon thread: stopping it
    // stops that host's memory tools too, and pids are reused, so the advice
    // always names the build as well.
    const pidNote = "the pid is the whole MCP server process (stopping it affects that host's Memex tools), and pids can be reused — confirm the owner before acting";
    // Issue #134: EPERM/EACCES on connect(2) say that THIS process may not talk to
    // the socket — a sandboxed diagnostic (an agent running `memex doctor` inside
    // its sandbox) sees exactly that on a perfectly healthy daemon. Reporting it as
    // `hung` named a pid to stop for a problem the daemon did not have. The probe's
    // reclaim decision is unchanged (a socket we cannot speak to is never unlinked).
    if (!probe.owner && (probe.code === "EPERM" || probe.code === "EACCES")) {
        return {
            name, status: "warn",
            detail: `not reachable from this process — connect() was denied (${probe.code}). This is what a ` +
                `sandboxed diagnostic sees (for example \`memex doctor\` run by an agent inside its sandbox); ` +
                `the daemon itself may be healthy. Re-run doctor from a plain terminal before acting on any pid. ${where}`,
        };
    }
    if (!probe.owner) {
        return {
            name, status: "warn",
            detail: `hung — a listener holds the socket but did not identify itself within ` +
                `${daemon.INJECT_DAEMON_DIAGNOSTIC_TIMEOUT_MS}ms (${probe.problem ?? "no answer"}). ` +
                `Hooks fall back in-process, so injection is correct but slow until it exits. ${pidNote}. ${where}`,
        };
    }
    const owner = probe.owner;
    const ownerNote = `owner pid ${owner.pid} version ${owner.version ?? "unknown"} build ${owner.buildId ?? "unknown"} ` +
        `root ${owner.pluginRoot} db ${owner.dbPath} started ${owner.startedAt || "unknown"}`;
    if (daemon.injectDaemonIdentityMatches(expected, owner)) {
        // Issue #92: a 0.6.5+ owner says whether it is still loading the embedding
        // model. That is a transient start-up state of a CORRECT owner — prompts
        // that arrive inside it are answered `warming` in microseconds and fall back
        // in-process — so it is reported, never counted as a daemon problem.
        if (owner.warming) {
            return {
                name, status: "ok",
                detail: `ok — served by this installation, still warming its embedding model: prompts fall back ` +
                    `in-process (logged daemon.reason=warming) until it finishes. On a cold model cache this ` +
                    `is the 129 MB download — run: memex deps warm — ${ownerNote}. ${where}`,
            };
        }
        return { name, status: "ok", detail: `ok — served by this installation — ${ownerNote}. ${where}` };
    }
    return {
        name, status: "warn",
        detail: `mismatch — the socket is owned by a DIFFERENT build, so the fast path is refused and every prompt ` +
            `falls back in-process: ${ownerNote}. ${pidNote}. ${where}`,
    };
}
/**
 * Issue #31 — which model is Memex using, and is anything waiting on it?
 *
 * Two things were invisible before. Which model and reasoning level this
 * installation resolves (and from WHERE — env, models.json, or the built-in
 * default), and whether a rejected selection has quietly paused model work. The
 * second matters most: a hold fails no job and consumes no attempt, so without
 * this check the only symptom is "nothing is being extracted any more".
 */
/**
 * Issue #162 — what a skipped capture actually costs, stated once.
 *
 * NOT "content is never lost". Skipping a capture only delays that turn's fence
 * IF a later capture of the same session succeeds. When the last Stop/SessionEnd
 * of a session are all skipped, the worker reads only the existing journal
 * boundary: the tail never reaches the continuity journal/capsule, and the last
 * open/interrupted turn stays out of extraction (#149 settles only turns
 * followed by a later main-line exchange). `memex sync` still indexes the
 * rollout file, so search/RAG see the content — continuity and the final turn's
 * extraction do not until #163 lands.
 */
export const CAPTURE_GAP_LOSS_STATEMENT = "continuity/extraction of the tail is pending #163";
/** How many marker lines the detail spells out before summarising. */
const CAPTURE_GAP_DETAIL_LIMIT = 5;
/** Events whose skipped hook actually costs a capture (#162 review 10). */
const CAPTURE_MARKER_EVENTS = new Set(["Stop", "Interrupt", "PreCompact", "SessionEnd"]);
/** The classes a leftover marker is warned about; the rest are recorded only. */
const CAPTURE_GAP_AT_STAKE_CLASSES = ["capture", "epoch"];
function captureGapMarkerClass(marker) {
    if (CAPTURE_MARKER_EVENTS.has(marker.event)) {
        // Issue #168 — `codex exec --ephemeral` has no transcript file, so its
        // Stop/SessionEnd payload carries no path and the marker no byte count.
        // Reporting that as a skipped capture printed "0 uncaptured bytes" and
        // claimed a pending continuity tail for thirty days; there was never
        // anything at stake. A marker that DOES name a transcript stays a capture
        // even with an unknown byte count — that hook had work to do.
        if (!marker.transcriptPath && !marker.transcriptBytes)
            return "no-transcript";
        return "capture";
    }
    if (marker.event === "SessionStart" && (marker.source === "clear" || marker.source === "compact")) {
        return "epoch";
    }
    return "neutral";
}
function captureGapMarkerLine(marker) {
    switch (captureGapMarkerClass(marker)) {
        case "capture":
            // `transcriptBytes` is the transcript size the invocation saw; with no
            // database reachable at marker time there is no committed boundary to
            // subtract, so this is the bound on what the skip left uncaptured.
            return `capture skipped at ${marker.event} ${marker.ts} (${marker.transcriptBytes ?? 0} uncaptured bytes); ${CAPTURE_GAP_LOSS_STATEMENT}`;
        case "no-transcript":
            // #168: the event happened, the session had no transcript. Named, not
            // alarmed about — these age out on their own.
            return `no transcript at ${marker.event} ${marker.ts} ` +
                "(ephemeral session; nothing to capture)";
        case "epoch":
            // Not a capture: the epoch advance. It heals itself on the next injection,
            // which is why this says so instead of quoting the tail statement.
            return `epoch advance skipped at SessionStart(${marker.source}) ${marker.ts}; ` +
                "repaired by the next injection";
        default:
            return `hook did not finish at ${marker.event} ${marker.ts} (no capture at stake)`;
    }
}
export function captureGapCheck() {
    const name = "capture-gap";
    let scan;
    try {
        // The COUNT, the OLDEST and the per-class tallies all come from the whole
        // matched set, not from the first page a directory listing happened to
        // return (#162 review 10, #165 post-release review).
        scan = scanCaptureGapMarkers({ classify: captureGapMarkerClass });
    }
    catch {
        return { name, status: "warn", detail: "unable to read the capture gap markers" };
    }
    if (scan.total === 0) {
        return { name, status: "ok", detail: "no skipped captures recorded" };
    }
    // The verdict is read from the tallies, never from the page: 500 telemetry-only
    // markers older than one unprocessed Stop fill the returned 500 exactly, and
    // classifying only those reported `501 skipped capture(s)` with `status: ok`.
    const atStakeClasses = CAPTURE_GAP_AT_STAKE_CLASSES.filter((cls) => (scan.classes[cls]?.count ?? 0) > 0);
    // Each at-stake class contributes its oldest marker to the wording first, so
    // the marker that decided the verdict is named even when it is off the page.
    const examples = [];
    const seen = new Set();
    for (const cls of atStakeClasses) {
        const oldest = scan.classes[cls]?.oldest;
        if (!oldest || seen.has(oldest.file))
            continue;
        seen.add(oldest.file);
        examples.push(oldest);
    }
    for (const entry of scan.markers) {
        if (examples.length >= CAPTURE_GAP_DETAIL_LIMIT)
            break;
        if (seen.has(entry.file))
            continue;
        seen.add(entry.file);
        examples.push(entry);
    }
    const lines = examples
        .slice(0, CAPTURE_GAP_DETAIL_LIMIT)
        .map(({ marker }) => captureGapMarkerLine(marker));
    const more = scan.total - lines.length;
    const atStake = atStakeClasses.length > 0;
    return {
        name,
        // Markers whose hook had nothing durable at stake are recorded, not alarmed
        // about: they expire on their own and no repair is pending.
        status: atStake ? "warn" : "ok",
        detail: 
        // #171: an ok verdict counts MARKERS. Calling them "skipped capture(s)" —
        // which is what an ok line said for eleven ephemeral `codex exec` runs — puts
        // the alarming noun on the line that just decided nothing was wrong.
        `${scan.total} ${atStake ? "skipped capture(s)" : "marker(s)"}${scan.truncated ? "+" : ""}${atStake ? "" : ", nothing at stake"}, oldest ${scan.markers[0].marker.ts} — ` +
            lines.join(" | ") + (more > 0 ? ` | +${more} more` : ""),
    };
}
/**
 * Issue #166 (third review) — `memex update` can exit 3 with "the migration did
 * not complete", and doctor had nothing to say about it.
 *
 * Read-only and migration-free by construction: it opens the file with the same
 * lightweight connection `countRows` uses and reads one pragma. A doctor run must
 * never be the thing that migrates a database.
 */
export function schemaVersionCheck() {
    const name = "schema-version";
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
        return { name, status: "ok", detail: `unknown (no database yet at ${dbPath})` };
    }
    let recorded = null;
    try {
        const Database = runtimeRequire("better-sqlite3");
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const value = Number(db.pragma("user_version", { simple: true }));
            recorded = Number.isFinite(value) ? value : null;
        }
        finally {
            db.close();
        }
    }
    catch {
        recorded = null;
    }
    if (recorded === null) {
        return { name, status: "warn", detail: `unknown (cannot read ${dbPath})` };
    }
    if (recorded >= CURRENT_SCHEMA_VERSION) {
        return { name, status: "ok", detail: `current (v${CURRENT_SCHEMA_VERSION})` };
    }
    return {
        name,
        status: "warn",
        detail: `pending migrations: v${recorded} < v${CURRENT_SCHEMA_VERSION} — will retry on ` +
            "next open or run memex update",
    };
}
/** A hook killed by the host is only visible as a start row with no done row. */
const HOOK_LATENCY_WINDOW_ROWS = 200;
/** Grace beyond the budget before an unpaired start counts as a host kill. */
const HOOK_KILL_GRACE_MS = 10_000;
/** Skew allowance on the END of a killed hook's own window (#166 third review). */
const HOOK_KILL_WINDOW_MARGIN_MS = 500;
/** A done row above this much lock wait is worth naming. */
const HOOK_DB_WAIT_WARN_MS = 1_000;
/** UserPromptSubmit has no host timeout in hooks.json — never claim one. */
const UNTIMED_HOOK_EVENTS = new Set(["UserPromptSubmit"]);
/**
 * Issue #166 — done-row outcomes that did NOT skip anything.
 *
 * Every other outcome (busy, deadline, oversize, error) is a hook that ran to
 * completion and captured nothing. The work Mac skipped 3 of 3 captures and
 * `hook-latency` reported `ok: 4 hook run(s) completed, max 8755 ms`, because
 * the check read durations and lock waits but never the outcome it had itself
 * written. `daemon`/`fallback`/`empty-prompt`/`skipped` are the inject hook's
 * normal paths, not skipped captures.
 */
const HEALTHY_HOOK_OUTCOMES = new Set([
    // #168: `no-transcript` is a capture event with no transcript to capture —
    // a completed hook, not a skipped capture. Counting it produced
    // `11 skipped (error 11) last error: capture hook requires transcript_path`.
    "ok", "daemon", "fallback", "empty-prompt", "skipped", "no-transcript",
]);
/** Fixed order so the counts read the same way every time. */
const SKIPPED_OUTCOME_ORDER = ["busy", "deadline", "oversize", "error"];
/**
 * #166 third review — the inject lane's `error` is not a skipped capture.
 *
 * UserPromptSubmit reports `error` for three different things, and the row's
 * `stage` (#166 final review) is what tells them apart:
 *
 *  - `receipt`: the context WAS delivered and only its durable recall receipt
 *    could not be marked emitted (#44's documented fallback);
 *  - `compute`: retrieval failed, so nothing reached the user;
 *  - `startup`: the imports failed before any of it.
 *
 * Calling all three "context delivered" said an injection had landed when none
 * had. A row written before 0.7.25 carries no stage and is not claimed either way.
 */
const INJECT_LANE_EVENTS = new Set(["UserPromptSubmit"]);
/**
 * Issue #171 — a done row 0.7.24/0.7.25 wrote for a capture event that never had a
 * transcript.
 *
 * Those versions had no `no-transcript` outcome, so they recorded `error` with this
 * exact message. 0.7.26 writes the new outcome on NEW rows only, which left a root
 * with eleven ephemeral runs reporting `11 skipped (error 11) last error: capture
 * hook requires transcript_path` until the old rows fell out of the 200-row window.
 * Nothing was skipped: there was nothing to capture.
 *
 * The ABSENCE of a stage is what dates the row. 0.7.26 STRICT mode writes the same
 * outcome and message WITH `stage: "no-transcript"`, and #168's post-fix review
 * made it do that precisely so this check keeps reporting it — a loud opt-in
 * failure is not an old silent row. (A non-strict 0.7.26 run records
 * `outcome: "no-transcript"` and never reaches here.) So #171's suggestion to
 * exclude that stage as well is deliberately NOT followed: it would undo #168.
 */
function isLegacyNoTranscriptRow(row) {
    return (String(row.outcome ?? "") === "error" &&
        String(row.error ?? "").trim() === NO_TRANSCRIPT_CAPTURE_REASON &&
        !row.stage);
}
/** `3 skipped (busy 1, deadline 1, oversize 1) last error: …`, or "". */
function skippedCaptureLine(rows) {
    const failing = rows.filter((row) => row.phase === "done" &&
        !HEALTHY_HOOK_OUTCOMES.has(String(row.outcome ?? "")) &&
        !isLegacyNoTranscriptRow(row));
    const injectFailures = failing.filter((row) => INJECT_LANE_EVENTS.has(row.event));
    const skipped = failing.filter((row) => !INJECT_LANE_EVENTS.has(row.event));
    const receiptFailures = injectFailures.filter((row) => row.stage === "receipt");
    const undelivered = injectFailures.filter((row) => row.stage === "compute" || row.stage === "startup");
    const unknownStage = injectFailures.filter((row) => row.stage !== "receipt" && row.stage !== "compute" && row.stage !== "startup");
    if (failing.length === 0)
        return "";
    const parts = [];
    if (skipped.length > 0) {
        const counts = new Map();
        for (const row of skipped) {
            const outcome = String(row.outcome ?? "unknown");
            counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
        }
        const ordered = [...counts.keys()].sort((a, b) => {
            const ai = SKIPPED_OUTCOME_ORDER.indexOf(a);
            const bi = SKIPPED_OUTCOME_ORDER.indexOf(b);
            if (ai !== bi)
                return (ai < 0 ? SKIPPED_OUTCOME_ORDER.length : ai) -
                    (bi < 0 ? SKIPPED_OUTCOME_ORDER.length : bi);
            return a < b ? -1 : 1;
        });
        parts.push(`${skipped.length} skipped (${ordered.map((outcome) => `${outcome} ${counts.get(outcome)}`).join(", ")})`);
    }
    if (receiptFailures.length > 0) {
        parts.push(`${receiptFailures.length} receipt failure${receiptFailures.length === 1 ? "" : "s"} (context delivered)`);
    }
    if (undelivered.length > 0) {
        parts.push(`${undelivered.length} injection failed (no context delivered)`);
    }
    if (unknownStage.length > 0) {
        // A pre-0.7.25 row: neither claim can be made about it.
        parts.push(`${unknownStage.length} inject error (stage unknown)`);
    }
    const lastError = [...failing].reverse().find((row) => String(row.error ?? "").trim());
    return ` — ${parts.join(", ")}` +
        (lastError ? ` last error: ${String(lastError.error).slice(0, 120)}` : "");
}
/**
 * The lock holder, read from the worker's own transaction log (written by the
 * worker lane). "Held the write lock for N ms" is said ONLY from `held_ms`:
 * `wait_ms` is time the worker itself spent blocked, which names a victim, not
 * a holder. A missing file is the normal case on a healthy install.
 */
/** Clock skew and log-write lag between two processes (#162 review 10). */
const WORKER_OVERLAP_MARGIN_MS = 250;
function workerLockHolderLine(window) {
    try {
        const file = path.join(getMemexHome(), "logs", "worker-transactions.jsonl");
        if (!fs.existsSync(file))
            return "";
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        let top = null;
        for (const line of lines.slice(Math.max(0, lines.length - 100))) {
            try {
                const row = JSON.parse(line);
                const held = Number(row?.held_ms ?? 0);
                if (!Number.isFinite(held) || held <= 0)
                    continue;
                // The holder has to have been holding WHILE this hook ran. Naming the
                // heaviest row in the log regardless of time pointed at transactions
                // that had finished hours earlier.
                //
                // The row is written when the transaction ENDS, so its `ts` is the end
                // and the held interval is `[ts - held_ms, ts]`. Reading `ts` as the
                // start was wrong both ways (#165 post-release review): the worker that
                // was still holding when the hook gave up sits past `toMs` and was
                // skipped, and one that had already finished looked like it started as
                // the hook began.
                const endedAt = Date.parse(String(row.ts ?? ""));
                if (!Number.isFinite(endedAt))
                    continue;
                const startedAt = endedAt - held;
                if (endedAt < window.fromMs - WORKER_OVERLAP_MARGIN_MS)
                    continue;
                if (startedAt > window.toMs + WORKER_OVERLAP_MARGIN_MS)
                    continue;
                if (!top || held > Number(top.held_ms ?? 0))
                    top = row;
            }
            catch {
                /* skip malformed */
            }
        }
        if (!top)
            return " — no worker transaction overlapped this hook";
        return ` — worker transaction ${top.label ?? "unknown"} held the write lock for ${Math.round(Number(top.held_ms))} ms`;
    }
    catch {
        return "";
    }
}
export function hookLatencyCheck(now = Date.now()) {
    const name = "hook-latency";
    const rows = readHookEventTail(HOOK_LATENCY_WINDOW_ROWS);
    const doneIds = new Set();
    for (const row of rows) {
        if (row.phase === "done" && row.invocation_id)
            doneIds.add(row.invocation_id);
    }
    const killed = [];
    const waited = [];
    let maxDuration = 0;
    let maxStartup = null;
    let paired = 0;
    rows.forEach((row, index) => {
        if (row.phase === "done") {
            paired++;
            maxDuration = Math.max(maxDuration, Number(row.duration_ms ?? 0));
            if (typeof row.startup_ms === "number" && Number.isFinite(row.startup_ms)) {
                maxStartup = Math.max(maxStartup ?? 0, row.startup_ms);
            }
            if (Number(row.db_wait_ms ?? 0) > HOOK_DB_WAIT_WARN_MS)
                waited.push(row);
            return;
        }
        if (row.phase !== "start" || !row.invocation_id)
            return;
        if (doneIds.has(row.invocation_id))
            return;
        if (UNTIMED_HOOK_EVENTS.has(row.event))
            return;
        const startedAt = Date.parse(row.ts);
        if (!Number.isFinite(startedAt))
            return;
        if (now - startedAt <= hookBudgetMs(row.event) + HOOK_KILL_GRACE_MS)
            return;
        // A later row from the same pid proves the process outlived this hook, so
        // the missing done row is a bug elsewhere, not a kill.
        const survived = rows
            .slice(index + 1)
            .some((later) => typeof later.pid === "number" && later.pid === row.pid);
        if (!survived)
            killed.push(row);
    });
    if (rows.length === 0) {
        return { name, status: "ok", detail: "no hook runs observed yet" };
    }
    // #166: a skipped capture has a done row, so it is never a reason to stop
    // reporting a kill or a lock wait — it is added to whichever verdict applies.
    const skipped = skippedCaptureLine(rows);
    if (killed.length > 0) {
        const markers = (() => {
            try {
                return scanCaptureGapMarkers().total;
            }
            catch {
                return 0;
            }
        })();
        const worst = killed[killed.length - 1];
        // A killed hook has no done row, so its window is its start plus the time the
        // HOST allowed it — its timeout, plus a small skew margin. The 10 s grace
        // above decides "no done row means killed"; using it here made a transaction
        // that started seconds after the kill a candidate holder (#166 third review).
        const startedAt = Date.parse(worst.ts);
        const holder = workerLockHolderLine({
            fromMs: startedAt,
            toMs: startedAt + hookHostTimeoutMs(worst.event) + HOOK_KILL_WINDOW_MARGIN_MS,
        });
        return {
            name,
            status: "warn",
            detail: `${killed.length} hook run(s) started and never finished — killed by host ` +
                `(latest ${worst.event} ${worst.ts}); ${markers} capture gap marker(s)` + holder + skipped,
        };
    }
    if (waited.length > 0) {
        const worst = waited.reduce((a, b) => Number(a.db_wait_ms ?? 0) >= Number(b.db_wait_ms ?? 0) ? a : b);
        // The done row's ts is the END of the run; `duration_ms` walks it back.
        const endedAt = Date.parse(worst.ts);
        const holder = workerLockHolderLine({
            fromMs: endedAt - Number(worst.duration_ms ?? 0),
            toMs: endedAt,
        });
        return {
            name,
            status: "warn",
            detail: `hooks waited on the database — ${waited.length}/${paired} runs over ` +
                `${HOOK_DB_WAIT_WARN_MS} ms (worst ${worst.event} ${Math.round(Number(worst.db_wait_ms))} ms, ${worst.ts})` + holder + skipped,
        };
    }
    // Nothing went wrong, so there is no hook to correlate a holder with: naming
    // one here was the inaccuracy, not the omission.
    return {
        name,
        // A completed run that captured nothing is not ok, however fast it was (#166).
        status: skipped ? "warn" : "ok",
        detail: `${paired} hook run(s) completed, max ${maxDuration} ms` +
            // #166: the fixed cost before the first database call, per machine. This
            // is the number that decides whether a budget is generous or already gone.
            (maxStartup === null ? "" : `, max startup ${maxStartup} ms`) + skipped,
    };
}
export function llmModelCheck() {
    const name = "llm-model";
    let selection;
    try {
        selection = resolveLlmSelection();
    }
    catch (error) {
        return {
            name, status: "warn",
            detail: `unable to resolve the model selection: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const where = `model ${selection.model} (via ${selection.modelSource}), reasoning ` +
        `${selection.reasoning ?? "unset"} (via ${selection.reasoningSource})`;
    // Read-only and library-light, the same lightweight connection countRows uses:
    // doctor must answer here even when the heavy db.js chain cannot load.
    let holds = [];
    let heldJobs = [];
    try {
        const dbPath = getDbPath();
        if (fs.existsSync(dbPath)) {
            const Database = runtimeRequire("better-sqlite3");
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const has = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== undefined;
                if (has("model_config_holds")) {
                    holds = db.prepare("SELECT * FROM model_config_holds WHERE cleared_at IS NULL ORDER BY held_at").all();
                }
                if (has("memory_jobs")) {
                    const columns = new Set(db.prepare("PRAGMA table_info(memory_jobs)").all()
                        .map((row) => row.name));
                    if (columns.has("hold_reason")) {
                        heldJobs = db.prepare(`
              SELECT hold_reason, COUNT(*) AS jobs FROM memory_jobs
              WHERE hold_reason IS NOT NULL AND state NOT IN ('completed','superseded','dead')
              GROUP BY hold_reason ORDER BY hold_reason
            `).all();
                    }
                }
            }
            finally {
                db.close();
            }
        }
    }
    catch {
        return { name, status: "ok", detail: `ok — ${where} (hold state unreadable)` };
    }
    const current = holds.find((hold) => hold.selection_fingerprint === selection.fingerprint);
    const heldSummary = heldJobs.length > 0
        ? ` Held jobs: ${heldJobs.map((row) => `${row.hold_reason}=${row.jobs}`).join(", ")}.`
        : "";
    if (current) {
        return {
            name, status: "warn",
            detail: `held — the provider rejected the request envelope for model "${current.model}"` +
                (current.reasoning_effort ? ` at reasoning effort "${current.reasoning_effort}"` : "") +
                ` (${current.provider_status ?? "?"} ${current.provider_type ?? "provider error"}: ` +
                `"${current.provider_message ?? ""}"), first seen ${current.held_at}, ` +
                `${current.observed_count} occurrence(s). Model work is paused — no job was failed and ` +
                `no attempt was consumed. Fix the selection and it resumes automatically. ` +
                `Run: memex models show -> memex models set --model <id> -> memex models test.` +
                heldSummary + ` ${where}`,
        };
    }
    if (holds.length > 0) {
        return {
            name, status: "ok",
            detail: `ok — ${where}. ${holds.length} hold(s) recorded for OTHER selections ` +
                `(${holds.map((hold) => hold.model).join(", ")}); none of them blocks this one.` + heldSummary,
        };
    }
    if (heldJobs.length > 0) {
        return {
            name, status: "warn",
            detail: `ok — ${where}, no model-config hold. But work is held for another reason:` +
                heldSummary + " See: memex status",
        };
    }
    return { name, status: "ok", detail: `ok — ${where}` };
}
/**
 * Issue #92 — is the embedding model on disk, and where?
 *
 * The state this reports was completely invisible. On the observed data root the
 * model cache lived inside each plugin root's `node_modules`, so every update
 * started cold and the next six prompts took 68-74s each while `doctor` reported
 * every check green. Nothing said "the 129 MB is missing and the first prompt
 * will pay for it".
 *
 * Read-only and library-free: `./model-cache.js` needs node builtins only, so
 * this answers even on a host whose runtime closure is missing — which is exactly
 * when a cold cache is most likely.
 */
function embeddingCacheCheck() {
    const name = "embedding-cache";
    let status;
    try {
        status = embeddingCacheStatus();
    }
    catch (error) {
        return {
            name, status: "warn",
            detail: `unable to resolve the embedding model cache: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const where = `cache ${status.dir} (via ${status.source}), model ${status.model}`;
    if (status.stub) {
        return {
            name, status: "ok",
            detail: `stub — MEMEX_EMBEDDING_STUB=1 replaces the model with a deterministic vector, so no weights ` +
                `are needed. ${where}`,
        };
    }
    if (status.present) {
        return {
            name, status: "ok",
            detail: `ok — ${formatCacheBytes(status.bytes)} in ${status.files} file(s) at ${status.modelDir}. ` +
                `It lives in the data root, so plugin updates keep it. ${where}`,
        };
    }
    // A legacy per-root cache means the first model load will COPY rather than
    // download, which is seconds instead of a minute — worth saying, because it
    // changes what the user should expect from the advice.
    const legacy = (() => {
        try {
            return legacyEmbeddingCacheCandidates();
        }
        catch {
            return [];
        }
    })();
    const partial = status.files > 0
        ? ` ${status.modelDir} holds ${status.files} file(s) / ${formatCacheBytes(status.bytes)} but no usable weights (an interrupted download).`
        : "";
    return {
        name, status: "warn",
        detail: `missing — the embedding model is not cached, so the first prompt will be slow (~68s for the ` +
            `129 MB download; measured) and a session's daemon and its hook fallback can download it at the ` +
            `same time. Run: memex deps warm.${partial}` +
            (legacy.length > 0
                ? ` A pre-0.6.5 per-root cache exists at ${legacy[0].cacheDir} (${legacy[0].kind}) and is COPIED ` +
                    `on first use, so warming should take seconds rather than a download.`
                : "") +
            ` ${where}`,
    };
}
/** Read-only diagnosis. Distinguishes configured vs observed. */
/**
 * Per-reason held-job counts, read the same library-light read-only way the rest
 * of doctor reads the database: doctor has to answer even when the heavy db.js
 * chain will not load, which is exactly the state a held queue can accompany.
 */
function readHeldJobCounts() {
    try {
        const dbPath = getDbPath();
        if (!fs.existsSync(dbPath))
            return [];
        const Database = runtimeRequire("better-sqlite3");
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'memory_jobs'").get() !==
                undefined;
            if (!hasTable)
                return [];
            const columns = new Set(db.prepare("PRAGMA table_info(memory_jobs)").all().map((row) => row.name));
            if (!columns.has("hold_reason"))
                return [];
            return db.prepare(`
        SELECT hold_reason AS reason, COUNT(*) AS jobs FROM memory_jobs
        WHERE hold_reason IS NOT NULL AND state NOT IN ('completed','superseded','dead')
        GROUP BY hold_reason ORDER BY hold_reason
      `).all().map((row) => ({
                reason: String(row.reason),
                jobs: Number(row.jobs),
            }));
        }
        finally {
            db.close();
        }
    }
    catch {
        return [];
    }
}
export async function doctor() {
    const checks = [];
    // Dependency + build readiness (report-only; never auto-install).
    // Issue #40: check the INSTALLED plugin root, not the running process. A
    // marketplace install whose dependencies were never materialized has no
    // node_modules beside the launcher, so every hook falls back to
    // `npx github:BongSuCHOI/memex#main` — an unpinned revision. Resolving from
    // the running process passes inside that very npx copy, which is exactly the
    // state this check has to report.
    // Issue #53: the running process is frequently the npx cache copy itself
    // (`~/.local/bin/memex` is an npx shim), so `__dirname/..` named the WRONG
    // root and reported a failure that belonged to nothing. Resolution now lives
    // in src/plugin-root.ts, shared with `memex install`, `memex deps
    // materialize` and the cli/runtime-exec.js fallback message.
    const installed = resolveInstalledPluginRoot({
        fallbackRoot: pluginRoot(),
        probeCodex: true,
    });
    const dependencyRoot = installed.root;
    const missingAtPluginRoot = missingRuntimeDependencies(dependencyRoot);
    const resolvableHere = RUNTIME_DEPENDENCIES.every((dependency) => {
        try {
            runtimeRequire.resolve(dependency);
            return true;
        }
        catch {
            return false;
        }
    });
    // Issue #69: say when the root came from the cache scan while the cache held
    // more than one version — that pick is keyed on the running copy's version,
    // not on what Codex loaded, so the operator has to see the ambiguity.
    const ambiguousCache = installed.source === "codex-cache" && installed.cacheVersions.length > 1
        ? `, ${installed.cacheVersions.length} cached versions (${installed.cacheVersions.join(", ")})` +
            " — codex plugin list --json did not answer, so this root is the closest match, not a confirmed load"
        : "";
    const rootNote = `installed plugin root ${dependencyRoot} (via ${installed.source}` +
        (installed.version ? `, version ${installed.version}` : "") +
        ambiguousCache +
        ")";
    checks.push({
        name: "dependencies",
        status: missingAtPluginRoot.length === 0 ? "ok" : "fail",
        detail: missingAtPluginRoot.length === 0
            ? `runtime dependencies materialized at ${path.join(dependencyRoot, "node_modules")} — ${rootNote}`
            : `missing at ${path.join(dependencyRoot, "node_modules")}: ${missingAtPluginRoot.join(", ")} — ` +
                "every hook silently falls back to npx github:BongSuCHOI/memex#main (an unpinned revision) — " +
                `run: memex deps materialize --root "${dependencyRoot}" (or run: memex install) — ${rootNote}` +
                (resolvableHere
                    ? " (this process resolved them elsewhere, i.e. from the npx copy rather than the pinned plugin)"
                    : ""),
    });
    const distEntry = fs.existsSync(path.join(pluginRoot(), "dist", "db.js"));
    checks.push({
        name: "build",
        status: distEntry ? "ok" : "fail",
        detail: distEntry
            ? "dist/ present"
            : `missing — run: cd ${pluginRoot()} && npm run build`,
    });
    // Codex home + hooks file
    const file = hooksFilePath();
    const hooks = readHooksFile(file);
    const foundCommands = new Set();
    if (hooks.hooks) {
        for (const event of HOOK_EVENTS) {
            for (const block of hooks.hooks[event] ?? []) {
                for (const h of block.hooks ?? []) {
                    if (typeof h.command === "string")
                        foundCommands.add(h.command);
                }
            }
        }
    }
    const configuredEvents = HOOK_EVENTS.filter((ev) => LIFECYCLE_COMMANDS[ev].every((c) => foundCommands.has(commandFor(pluginRoot(), c))));
    const pluginEvents = pluginManagedHookEvents();
    const activeEvents = [...new Set([...configuredEvents, ...pluginEvents])];
    checks.push({
        name: "codex-home",
        status: fs.existsSync(codexHome()) ? "ok" : "fail",
        detail: codexHome(),
    });
    checks.push({
        name: "lifecycle-configured",
        status: activeEvents.length === HOOK_EVENTS.length
            ? "ok"
            : activeEvents.length > 0
                ? "warn"
                : "fail",
        detail: pluginEvents.length === HOOK_EVENTS.length
            ? `${pluginEvents.join(", ")} (plugin manifest)`
            : configuredEvents.length
                ? `${configuredEvents.join(", ")} (${file})`
                : `not configured — run: memex setup-hooks`,
    });
    const observedDetail = HOOK_EVENTS.map((ev) => {
        const ts = lastObserved(ev);
        return `${ev}: ${ts ? `observed ${ts}` : "never observed"}`;
    }).join("; ");
    checks.push({
        name: "lifecycle-observed",
        status: HOOK_EVENTS.every((ev) => lastObserved(ev)) ? "ok" : "warn",
        detail: observedDetail,
    });
    // Inject output parse/consumption — distinguishes valid injection vs error vs no-match
    //
    // Issue #84: the `inject-daemon` check probes the socket, and a pre-0.6.3
    // daemon answers that probe by running `computeInjectContext("")`, which
    // appends `status:"no-session-provenance", via:"daemon", prompt_len:0`. Left
    // in, the NEXT `memex doctor` would read that line as the log tail and warn
    // about a line doctor itself wrote. A real prompt is never empty — the hook
    // returns before any daemon call for a blank prompt — so an empty-prompt
    // provenance line can only be a probe artifact, and is dropped here.
    const recent = readInjectLogTail(INJECT_LOG_WINDOW).filter((entry) => !(entry.status === "no-session-provenance" && Number(entry.prompt_len ?? 0) === 0));
    try {
        const logPath = getInjectLogPath();
        if (fs.existsSync(logPath)) {
            const last = recent.length ? recent[recent.length - 1] : null;
            if (last) {
                // Issue #165: `context-only` belongs here. It is the status #32 added
                // for an emission that carried Capsule/continuity context and zero
                // facts — a normal retrieval outcome that `injection-yield`
                // (ZERO_FACT_STATUSES) already owns and `recall-provenance` counts as an
                // emitted bundle. Missing from this map it fell through to "unknown
                // status", so a healthy install was reported as `inject-output: warn`.
                const okStatuses = {
                    injected: true,
                    "context-only": true,
                    "no-match": true,
                    deduped: true,
                    skipped: true,
                };
                // Issue #44: a broken provenance receipt is a contract violation, not a
                // benign outcome. It used to exist only on a hook's discarded stderr.
                const receiptFailures = recent.filter((entry) => entry.status === "receipt-failed").length;
                const failing = last.status === "error" || last.status === "receipt-failed";
                checks.push({
                    name: "inject-output",
                    status: failing
                        ? "fail"
                        : okStatuses[String(last.status)]
                            ? receiptFailures > 0
                                ? "warn"
                                : "ok"
                            : "warn",
                    detail: `${last.status} via=${last.via ?? "unknown"} ${last.ts ?? ""} ${last.error ? `error=${String(last.error).slice(0, 80)}` : ""}`.trim() +
                        (receiptFailures > 0
                            ? ` — ${receiptFailures}/${recent.length} recent runs emitted context with no durable recall receipt`
                            : ""),
                });
            }
            else {
                checks.push({
                    name: "inject-output",
                    status: "warn",
                    detail: "inject log empty — no UserPromptSubmit observed yet",
                });
            }
        }
        else {
            checks.push({
                name: "inject-output",
                status: "warn",
                detail: "no inject log yet — UserPromptSubmit not yet observed",
            });
        }
    }
    catch {
        checks.push({
            name: "inject-output",
            status: "warn",
            detail: "unable to read inject log",
        });
    }
    // Issue #162: a hook the host killed, and the captures it skipped.
    checks.push(captureGapCheck());
    checks.push(hookLatencyCheck());
    checks.push(schemaVersionCheck());
    checks.push(recallProvenanceCheck(recent));
    checks.push(injectionYieldCheck(recent));
    checks.push(llmModelCheck());
    checks.push(embeddingCacheCheck());
    checks.push(await injectDaemonCheck());
    // Persisted hook trust lives in config.toml [hooks.state."<file>:<event>:…"].
    let trustedEntries = 0;
    const configToml = path.join(codexHome(), "config.toml");
    try {
        if (fs.existsSync(configToml)) {
            const marker = `hooks.state.`;
            let section = false;
            for (const line of fs.readFileSync(configToml, "utf8").split("\n")) {
                const t = line.trim();
                if (t.startsWith("[")) {
                    section = t.includes(marker) && t.includes(hooksFilePath());
                    if (section)
                        trustedEntries++;
                }
            }
            void section;
        }
    }
    catch {
        /* unreadable config: treat as untrusted */
    }
    checks.push({
        name: "hook-trust",
        status: trustedEventsConfigured()
            ? configuredEvents.every((ev) => hasTrustFor(ev))
                ? "ok"
                : "warn"
            : "warn",
        detail: trustedEntries > 0
            ? `${trustedEntries} trusted hook state entries reference ${hooksFilePath()}`
            : "no persisted hook trust found in config.toml — Codex will prompt for trust on the next session start",
    });
    checks.push({
        name: "mcp-manifest",
        status: fs.existsSync(path.join(pluginRoot(), ".codex-plugin", "plugin.json"))
            ? "ok"
            : "fail",
        detail: ".codex-plugin/plugin.json present (MCP servers declared there)",
    });
    // Issue #41: the ontology category vec index can be broken in a way
    // self-heal cannot fix. Classification then stops entirely while status
    // used to keep printing `Ontology: READY`.
    const ontologyRepair = readOntologyIndexRepairMarker();
    if (ontologyRepair) {
        checks.push({
            name: "ontology-index",
            status: ontologyRepair.blocked ? "fail" : "ok",
            detail: ontologyRepair.blocked
                ? `ontology category index repair FAILED (${ontologyRepair.reason ?? "unknown"}${ontologyRepair.detectedAt ? `, detected ${ontologyRepair.detectedAt}` : ""}) — classification is blocked; rebuild vectors: memex backfill embeddings`
                : "ontology category index reconciled",
        });
    }
    // P2-6: the last sync export attempt is recorded durably by the
    // SessionEnd chain — a failed export must surface here instead of
    // disappearing behind the hook's exit 0.
    try {
        // Issue #35: "no status file" used to be reported as ok with the advice to
        // wait for a SessionEnd — but no hook ever invoked the exporter, so that
        // was a wiring failure reported as health. The check now distinguishes
        // three states: off (skipped, not a warning — #48 decision 5), on but never
        // exported (warn), and on with a recorded result (ok/fail). It also
        // verifies the export script is actually registered in a lifecycle event.
        const syncConfig = readSyncConfig();
        const exportStatus = readExportStatus();
        const registered = isLifecycleScriptRegistered(SYNC_LIFECYCLE_SCRIPTS.export);
        if (!syncConfig.enabled) {
            checks.push({
                name: "sync-export",
                status: "ok",
                detail: `skipped(off) — cross-device sync is disabled; enable it with: ` +
                    `memex sync enable --dir <shared folder>`,
            });
        }
        else if (!registered) {
            checks.push({
                name: "sync-export",
                status: "warn",
                detail: `sync is enabled but ${SYNC_LIFECYCLE_SCRIPTS.export} is not registered in any hook — ` +
                    "nothing exports automatically; run: memex sync export",
            });
        }
        else if (!exportStatus) {
            checks.push({
                name: "sync-export",
                status: "warn",
                detail: `sync is enabled (shared folder ${resolveSyncDir(syncConfig)}) but nothing has been ` +
                    "exported yet — run: memex sync export, or end one session to trigger the SessionEnd export",
            });
        }
        else {
            checks.push({
                name: "sync-export",
                status: exportStatus.ok ? "ok" : "fail",
                detail: exportStatus.ok
                    ? `last export ok at ${exportStatus.at} (shared folder ${resolveSyncDir(syncConfig)})`
                    : `last export FAILED at ${exportStatus.at}: ${exportStatus.error ?? "unknown"}`,
            });
        }
    }
    catch {
        checks.push({
            name: "sync-export",
            status: "warn",
            detail: "unable to read sync export status",
        });
    }
    // Issue #29 (0.7.0) — the recall-gate overlay's three checks. The check
    // FUNCTIONS live in src/recall-gate-overlay.ts so the overlay lane owns their
    // wording and this file stays the single place that assembles the report.
    //
    // A quarantined pattern is a `fail`, not a `warn`: it is the operator's own
    // rule silently switched off, which is exactly the "stopped quietly" class of
    // bug doctor exists to surface.
    try {
        for (const check of await recallGateOverlayChecks())
            checks.push(check);
    }
    catch {
        checks.push({
            name: "recall-gate-overlay",
            status: "warn",
            detail: "unable to inspect the recall-gate overlay",
        });
    }
    // Issue #30 (0.7.0) — the extraction-rules overlay's two checks, same shape
    // and for the same reason: the wording lives with the lane that owns the
    // overlay, this file only assembles.
    //
    // `extraction-rules-hold` is a `fail` because a held job is invisible
    // otherwise: it is neither `retry` nor `dead`, so every existing status
    // surface reports it as ordinary pending work while nothing is being stored.
    try {
        for (const check of extractionRulesChecks(readHeldJobCounts()))
            checks.push(check);
    }
    catch {
        checks.push({
            name: "extraction-rules-overlay",
            status: "warn",
            detail: "unable to inspect the extraction-rules overlay",
        });
    }
    const hasFail = checks.some((c) => c.status === "fail");
    const allOk = checks.every((c) => c.status === "ok");
    return {
        json: checks.map(({ name, status, detail }) => ({ name, status, detail })),
        overall: hasFail ? "FAIL" : allOk ? "PASS" : "PARTIAL",
    };
}
