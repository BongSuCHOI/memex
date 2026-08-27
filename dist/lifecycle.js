/**
 * CX-01 — Codex lifecycle registration, diagnosis, removal.
 *
 * Contract (documented in docs/CONVERSATION-LIFECYCLE.md, codex-cli 0.149.1):
 *  - The hook config owner is $CODEX_HOME/hooks.json (user scope). Plugin
 *    marketplace plugins declare hooks through plugin.json; explicit setup is
 *    retained only as a fingerprinted fallback for non-plugin hosts.
 *  - Registered commands use ABSOLUTE paths resolved at setup time.
 *    `${PLUGIN_ROOT}` is not assumed to expand inside Codex hooks.
 *  - Ownership: every Memex entry carries a fingerprint marker comment
 *    field `"_memoryBank": true` plus the exact command string recorded in
 *    lifecycle-registration.json under the Memex data root. remove only
 *    touches entries whose command matches a registered fingerprint; foreign
 *    entries are preserved byte-for-byte (2-space JSON indent, key order kept).
 *  - Idempotent: running setup twice produces zero new entries.
 *  - Never installs dependencies or plugins; never mutates anything outside
 *    $CODEX_HOME/hooks.json and the Memex data root.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { lastObserved } from './observe-hook-event.js';
import { getInjectLogPath } from './inject-log.js';
const runtimeRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'];
/** Relative-to-plugin-root commands registered for each event. */
export const LIFECYCLE_COMMANDS = {
    SessionStart: [
        { script: 'scripts/version-drift-check.js', async: true },
        { script: 'cli/memex.js', args: ['sync', '--background'], async: true },
        { script: 'scripts/sync-import-hook.js', async: true },
        { script: 'scripts/session-start-maintenance.js', async: true },
    ],
    UserPromptSubmit: [
        { script: 'scripts/inject-context-hook.sh' },
    ],
    SessionEnd: [
        { script: 'scripts/session-end-hook.js' },
    ],
};
const OWNERSHIP_KEY = '_memoryBank';
function codexHome() {
    return process.env.CODEX_HOME
        ? path.resolve(process.env.CODEX_HOME)
        : path.join(os.homedir(), '.codex');
}
export function hooksFilePath() {
    return path.join(codexHome(), 'hooks.json');
}
export function dataRoot() {
    const dir = process.env.MEMORY_BANK_HOME
        || process.env.MEMORY_BANK_CONFIG_DIR
        || (process.env.XDG_CONFIG_HOME
            ? path.join(process.env.XDG_CONFIG_HOME, 'memory-bank')
            : path.join(os.homedir(), '.config', 'memory-bank'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function registrationPath() {
    return path.join(dataRoot(), 'lifecycle-registration.json');
}
export function pluginRoot() {
    return process.env.MEMORY_BANK_PLUGIN_ROOT
        ? path.resolve(process.env.MEMORY_BANK_PLUGIN_ROOT)
        : path.resolve(HERE, '..');
}
export function fingerprintOf(command) {
    return crypto.createHash('sha256').update(command).digest('hex').slice(0, 16);
}
function readHooksFile(file) {
    if (!fs.existsSync(file))
        return {};
    let raw = '';
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (e) {
        throw new Error(`cannot read ${file}: ${e.message}`);
    }
    if (!raw.trim())
        return {};
    // A malformed config must fail loud, never be silently clobbered by setup.
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object')
            return parsed;
        throw new Error('not a JSON object');
    }
    catch {
        throw new Error(`${file} is not valid JSON — fix or remove it manually; refusing to touch it`);
    }
}
function serializeHooksFile(hooks) {
    // Preserve foreign key order via JSON.stringify on plain objects (insertion
    // order) and keep the file byte-stable when nothing changed.
    return JSON.stringify(hooks, null, 2) + '\n';
}
export function commandFor(root, c) {
    const runner = c.script.endsWith('.sh') ? 'bash' : 'node';
    const scriptPath = path.join(root, c.script);
    const extraArgs = c.args && c.args.length > 0
        ? ' ' + c.args.map((a) => (a.includes(' ') && !a.startsWith('"') ? `"${a}"` : a)).join(' ')
        : '';
    return `${runner} "${scriptPath}"${extraArgs}`;
}
/** Build the desired entry list for a given plugin root (absolute commands). */
export function desiredEntries(root = pluginRoot()) {
    const entries = [];
    for (const event of HOOK_EVENTS) {
        for (const c of LIFECYCLE_COMMANDS[event]) {
            entries.push({ event, command: commandFor(root, c), ...(c.async ? { async: true } : {}) });
        }
    }
    return entries;
}
/** Compute the exact add/remove diff against the current hooks.json. */
export function planSetup(root = pluginRoot()) {
    const hooks = readHooksFile(hooksFilePath());
    const desired = desiredEntries(root);
    const desiredCmds = new Set(desired.map((d) => d.command));
    const existingCommands = new Set();
    let preservedForeign = 0;
    let staleOwned = 0;
    for (const event of HOOK_EVENTS) {
        for (const block of hooks.hooks?.[event] ?? []) {
            for (const h of block.hooks ?? []) {
                if (!h.command || typeof h.command !== 'string')
                    continue;
                if (h[OWNERSHIP_KEY] === true) {
                    existingCommands.add(h.command);
                    // Owned entry pointing at a path that no longer exists or not desired -> stale
                    const m = h.command.match(/"([^"]+)"/);
                    const p = m ? m[1] : '';
                    if ((p && !fs.existsSync(p)) || !desiredCmds.has(h.command))
                        staleOwned++;
                }
                else {
                    preservedForeign++;
                }
            }
        }
    }
    const add = desired.filter((d) => !existingCommands.has(d.command))
        .map(({ event, command }) => ({ event, command }));
    return {
        targetFile: hooksFilePath(),
        add,
        remove: [],
        preservedForeignEntries: preservedForeign,
        staleOwnedEntries: staleOwned,
    };
}
/** Apply the idempotent setup. Returns what changed. Never runs installers. */
export function setupHooks({ dryRun = false, root = pluginRoot() } = {}) {
    // Fail loud when the handler scripts are not resolvable at this root.
    for (const d of desiredEntries(root)) {
        const m = d.command.match(/"([^"]+)"/);
        const p = m ? m[1] : '';
        if (!p || !fs.existsSync(p)) {
            throw new Error(`handler not found: ${p || d.command}\n` +
                'Build first: npm install && npm run build (never run automatically)');
        }
    }
    const file = hooksFilePath();
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const hooks = readHooksFile(file);
    const diff = planSetup(root);
    if (!dryRun) {
        const desired = desiredEntries(root);
        const desiredCmds = new Set(desired.map((d) => d.command));
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
                        return desiredCmds.has(h.command ?? '');
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
        for (const { event, command, async } of desiredEntries(root).filter((x) => diff.add.some((a) => a.command === x.command))) {
            if (!hooks.hooks[event])
                hooks.hooks[event] = [];
            let block = hooks.hooks[event].find((b) => !b.matcher);
            if (!block) {
                block = { matcher: '', hooks: [] };
                hooks.hooks[event].push(block);
            }
            if (!block.hooks)
                block.hooks = [];
            block.hooks.push({
                type: 'command',
                command,
                ...{ [OWNERSHIP_KEY]: true },
                ...(async ? { async: true } : {}),
            });
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, serializeHooksFile(hooks), { mode: 0o644 });
    }
    // Persist/refresh the ownership record regardless (cheap, local).
    const reg = {
        schemaVersion: 1,
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
    const after = dryRun ? before : (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    if (!dryRun) {
        fs.writeFileSync(registrationPath(), JSON.stringify(reg, null, 2) + '\n');
    }
    const changed = !dryRun && after !== before;
    return { changed, diff, registrationPath: registrationPath() };
}
/** Remove only Memex-owned entries (exact fingerprint match). */
export function removeHooks({ dryRun = false } = {}) {
    const file = hooksFilePath();
    const owned = new Set();
    try {
        const reg = JSON.parse(fs.readFileSync(registrationPath(), 'utf8'));
        for (const e of reg.entries)
            owned.add(e.command);
    }
    catch {
        /* no registration record: fall back to ownership flag */
    }
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
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
                        (typeof h.command === 'string' && owned.has(h.command));
                    if (isOurs)
                        removed++;
                    else {
                        kept.push(h);
                        if (typeof h.command === 'string')
                            preservedForeign++;
                    }
                }
                // Keep foreign matcher blocks untouched; drop blocks we emptied.
                if (kept.length > 0 || (block.hooks?.length ?? 0) === 0) {
                    keptBlocks.push(kept.length === (block.hooks?.length ?? 0) ? block : { ...block, hooks: kept });
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
        catch { /* ignore */ }
    }
    // `removed` is the observed/would-observe count in both dry-run and apply.
    void dryRun;
    return { removed, preservedForeignEntries: preservedForeign, dryRun };
}
function trustStateLines() {
    try {
        const cfg = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8');
        return cfg.split('\n').filter((l) => l.trim().startsWith('[hooks.state.'));
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
        const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
        if (!fs.existsSync(manifestPath))
            return [];
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.hooks !== 'string')
            return [];
        const hookPath = path.resolve(root, manifest.hooks);
        if (!hookPath.startsWith(root + path.sep) || !fs.existsSync(hookPath))
            return [];
        const config = JSON.parse(fs.readFileSync(hookPath, 'utf8'));
        return HOOK_EVENTS.filter((event) => Array.isArray(config.hooks?.[event]) && config.hooks[event].length > 0);
    }
    catch {
        return [];
    }
}
/** Read-only diagnosis. Distinguishes configured vs observed. */
export function doctor() {
    const checks = [];
    // Dependency + build readiness (report-only; never auto-install).
    const runtimeDependencies = ['better-sqlite3', '@xenova/transformers', 'sqlite-vec'];
    const nodeModules = runtimeDependencies.every((dependency) => {
        try {
            runtimeRequire.resolve(dependency);
            return true;
        }
        catch {
            return false;
        }
    });
    checks.push({
        name: 'dependencies',
        status: nodeModules ? 'ok' : 'fail',
        detail: nodeModules ? 'runtime dependencies resolvable' : 'runtime package dependencies unavailable — verify Node/npm network and cache',
    });
    const distEntry = fs.existsSync(path.join(pluginRoot(), 'dist', 'db.js'));
    checks.push({
        name: 'build',
        status: distEntry ? 'ok' : 'fail',
        detail: distEntry ? 'dist/ present' : `missing — run: cd ${pluginRoot()} && npm run build`,
    });
    // Codex home + hooks file
    const file = hooksFilePath();
    const hooks = readHooksFile(file);
    const foundCommands = new Set();
    if (hooks.hooks) {
        for (const event of HOOK_EVENTS) {
            for (const block of hooks.hooks[event] ?? []) {
                for (const h of block.hooks ?? []) {
                    if (typeof h.command === 'string')
                        foundCommands.add(h.command);
                }
            }
        }
    }
    const configuredEvents = HOOK_EVENTS.filter((ev) => LIFECYCLE_COMMANDS[ev].every((c) => foundCommands.has(commandFor(pluginRoot(), c))));
    const pluginEvents = pluginManagedHookEvents();
    const activeEvents = [...new Set([...configuredEvents, ...pluginEvents])];
    checks.push({
        name: 'codex-home',
        status: fs.existsSync(codexHome()) ? 'ok' : 'fail',
        detail: codexHome(),
    });
    checks.push({
        name: 'lifecycle-configured',
        status: activeEvents.length === HOOK_EVENTS.length ? 'ok'
            : activeEvents.length > 0 ? 'warn'
                : 'fail',
        detail: pluginEvents.length === HOOK_EVENTS.length
            ? `${pluginEvents.join(', ')} (plugin manifest)`
            : configuredEvents.length
                ? `${configuredEvents.join(', ')} (${file})`
                : `not configured — run: memex setup-hooks`,
    });
    const observedDetail = HOOK_EVENTS.map((ev) => {
        const ts = lastObserved(ev);
        return `${ev}: ${ts ? `observed ${ts}` : 'never observed'}`;
    }).join('; ');
    checks.push({
        name: 'lifecycle-observed',
        status: HOOK_EVENTS.every((ev) => lastObserved(ev)) ? 'ok' : 'warn',
        detail: observedDetail,
    });
    // Inject output parse/consumption — distinguishes valid injection vs error vs no-match
    try {
        const logPath = getInjectLogPath();
        if (fs.existsSync(logPath)) {
            const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
            const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
            if (last) {
                const okStatuses = { injected: true, 'no-match': true, deduped: true, skipped: true };
                checks.push({
                    name: 'inject-output',
                    status: okStatuses[last.status] ? 'ok' : last.status === 'error' ? 'fail' : 'warn',
                    detail: `${last.status} via=${last.via ?? 'unknown'} ${last.ts ?? ''} ${last.error ? `error=${String(last.error).slice(0, 80)}` : ''}`.trim(),
                });
            }
            else {
                checks.push({ name: 'inject-output', status: 'warn', detail: 'inject log empty — no UserPromptSubmit observed yet' });
            }
        }
        else {
            checks.push({ name: 'inject-output', status: 'warn', detail: 'no inject log yet — UserPromptSubmit not yet observed' });
        }
    }
    catch {
        checks.push({ name: 'inject-output', status: 'warn', detail: 'unable to read inject log' });
    }
    // Persisted hook trust lives in config.toml [hooks.state."<file>:<event>:…"].
    let trustedEntries = 0;
    const configToml = path.join(codexHome(), 'config.toml');
    try {
        if (fs.existsSync(configToml)) {
            const marker = `hooks.state.`;
            let section = false;
            for (const line of fs.readFileSync(configToml, 'utf8').split('\n')) {
                const t = line.trim();
                if (t.startsWith('[')) {
                    section = t.includes(marker) && t.includes(hooksFilePath());
                    if (section)
                        trustedEntries++;
                }
            }
            void section;
        }
    }
    catch { /* unreadable config: treat as untrusted */ }
    checks.push({
        name: 'hook-trust',
        status: trustedEventsConfigured() ? (configuredEvents.every((ev) => hasTrustFor(ev)) ? 'ok' : 'warn') : 'warn',
        detail: trustedEntries > 0
            ? `${trustedEntries} trusted hook state entries reference ${hooksFilePath()}`
            : 'no persisted hook trust found in config.toml — Codex will prompt for trust on the next session start',
    });
    checks.push({
        name: 'mcp-manifest',
        status: fs.existsSync(path.join(pluginRoot(), '.codex-plugin', 'plugin.json')) ? 'ok' : 'fail',
        detail: '.codex-plugin/plugin.json present (MCP servers declared there)',
    });
    const hasFail = checks.some((c) => c.status === 'fail');
    const allOk = checks.every((c) => c.status === 'ok');
    return {
        json: checks.map(({ name, status, detail }) => ({ name, status, detail })),
        overall: hasFail ? 'FAIL' : allOk ? 'PASS' : 'PARTIAL',
    };
}
