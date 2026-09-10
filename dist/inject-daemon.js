import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureIndexDir, getDbPath, getIndexDir } from './paths.js';
import { computeInjectContext } from './inject-core.js';
import { initEmbeddings } from './embeddings.js';
import { readManifestVersion, resolveInstalledPluginRoot } from './plugin-root.js';
/**
 * Warm inject daemon — a unix-socket sidecar inside the long-lived MCP server.
 *
 * Why: the UserPromptSubmit hook pays ~2.3s PER PROMPT as a cold node process
 * (measured: model load 1,130ms + node startup ~400ms + imports 186ms dominate;
 * the actual search is ~30ms). Every Codex session with the plugin runs an MCP server
 * with the embedding model warm — this sidecar lets the hook reuse it: the hook
 * connects, sends the prompt, and gets the context back in ~150ms warm.
 *
 * Lifecycle safety (this plugin's orphan-flood history makes this explicit):
 *  - The daemon lives INSIDE the MCP server process — no new detached process,
 *    no new lifecycle to leak. server.unref() so it never keeps the process
 *    alive on its own; it dies exactly when the MCP server dies.
 *  - Only ONE server binds the socket, and binding is serialized by a lock
 *    file so two starters cannot probe-then-bind over each other.
 *  - Socket mode 600 — same-user only; the payload is the user's own prompt.
 *  - Requests are line-delimited JSON; a malformed request gets a refusal and
 *    never throws into the MCP server.
 *
 * IDENTITY (issue #84) — the socket used to be "whoever got there first".
 *
 * The daemon is a sidecar of *any* running MCP server, and several hosts
 * compete for one socket path under the data root. Observed on the real data
 * root: a Claude Code session had started `Documents/memex/dist/mcp-server.js`
 * from a development checkout (a pre-0.6.0 `dist`), that process owned the
 * socket, and all four prompts from Codex's 0.6.2 hook were answered by the old
 * code — `status:"injected", injected:0, via:"daemon"` (the 0.6.2
 * `context-only` split was not in that build), zero `baseline_margin_gap`
 * telemetry, and that build's tier-read rules. Updating the plugin and
 * restarting Codex did not help, because the stale process still held the
 * socket, and nothing in `doctor` or `status` showed it.
 *
 * Two mechanisms close that:
 *  1. The hook and the daemon exchange identities on the same connection
 *     BEFORE any computation. The daemon answers a prompt only when protocol,
 *     version, build id, plugin root and resolved DB path all match; otherwise
 *     it replies `mismatch` having computed nothing and touched no receipt, and
 *     the hook falls back in-process. An old daemon (no handshake in its reply)
 *     is treated the same way, so correctness holds before both sides update.
 *  2. A development checkout does not open the listener at all unless asked:
 *     only the resolved INSTALLED plugin root serves (see `injectDaemonPolicy`).
 */
/** Wire protocol version. Bumped only for an incompatible message change. */
export const INJECT_DAEMON_PROTOCOL = 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
function realpathOrSelf(target) {
    try {
        return fs.realpathSync(target);
    }
    catch {
        return path.resolve(target);
    }
}
/**
 * Root of the copy that is EXECUTING, derived from this module's own URL.
 *
 * Deliberately not `resolveInstalledPluginRoot`: that answers "which plugin did
 * Codex install", and a daemon must describe the code it is actually running —
 * those differing is the entire defect. Holds for every shape this module
 * loads in, since all of them sit one level below the root: the esbuild bundle
 * (`dist/mcp-server.js`), the plain build (`dist/inject-daemon.js`) and a
 * TypeScript run (`src/inject-daemon.ts`).
 */
export function injectDaemonExecutionRoot() {
    return realpathOrSelf(path.resolve(HERE, '..'));
}
/**
 * Build identity of the running code: SHA-256 of the shipped bundle.
 *
 * The version alone cannot separate two builds of the same version — a
 * development checkout and the installed 0.6.3 both say `0.6.3` while running
 * different code. Hashing the bundle does. When there is no bundle to hash
 * (a source run), the version plus the entry's mtime is the honest fallback;
 * when there is no entry at all the field is `null`, and the remaining three
 * fields still gate.
 */
export function injectDaemonBuildId(root = injectDaemonExecutionRoot()) {
    const bundle = path.join(root, 'dist', 'mcp-server.js');
    try {
        return `sha256:${createHash('sha256').update(fs.readFileSync(bundle)).digest('hex')}`;
    }
    catch { /* no bundle here — fall through to the mtime form */ }
    for (const entry of [path.join(root, 'dist', 'inject-daemon.js'), path.join(root, 'src', 'inject-daemon.ts')]) {
        try {
            return `mtime:${readManifestVersion(root) ?? 'unknown'}:${Math.trunc(fs.statSync(entry).mtimeMs)}`;
        }
        catch { /* try the next shape */ }
    }
    return null;
}
const identityCache = new Map();
/**
 * The identity a daemon running out of `root` would present.
 *
 * Memoized per root: the bundle hash is computed once, never on the request
 * path. `dbPath` is read per call because a test harness may move the data root
 * between daemons in one process; the three code fields cannot change.
 */
export function injectDaemonIdentityFor(root) {
    const pluginRoot = realpathOrSelf(root);
    let code = identityCache.get(pluginRoot);
    if (!code) {
        code = {
            protocol: INJECT_DAEMON_PROTOCOL,
            version: readManifestVersion(pluginRoot),
            buildId: injectDaemonBuildId(pluginRoot),
            pluginRoot,
        };
        identityCache.set(pluginRoot, code);
    }
    return { ...code, dbPath: path.resolve(getDbPath()) };
}
/** This process's own identity — what a daemon started here would present. */
export function injectDaemonIdentity() {
    return injectDaemonIdentityFor(injectDaemonExecutionRoot());
}
/** Identity equality — all five fields, compared exactly. */
export function injectDaemonIdentityMatches(expected, actual) {
    if (!expected || !actual)
        return false;
    return expected.protocol === actual.protocol &&
        expected.version === actual.version &&
        expected.buildId === actual.buildId &&
        expected.pluginRoot === actual.pluginRoot &&
        expected.dbPath === actual.dbPath;
}
/**
 * May this process own the socket?
 *
 * Only the resolved installed plugin root serves. A development checkout (the
 * `.mcp.json` of a repository, opened by another host) runs perfectly good code
 * that is simply not the code Codex's hooks belong to, and its owning the
 * socket is how an entire session's injections end up on the wrong build.
 * `probeCodex: false` keeps this a pure filesystem decision — the MCP server's
 * startup path must not spawn `codex`. A `launcher` resolution means nothing
 * authoritative was found (the running copy resolved to itself), which is not
 * evidence of an installation, so the listener stays closed.
 *
 * `MEMEX_INJECT_DAEMON=1` forces it open and `=0` forces it closed, for an
 * operator who knows which root they mean.
 */
export function injectDaemonPolicy() {
    const executionRoot = injectDaemonExecutionRoot();
    let installedRoot = executionRoot;
    let installedSource = 'unknown';
    try {
        const resolved = resolveInstalledPluginRoot({ fallbackRoot: executionRoot, probeCodex: false });
        installedRoot = realpathOrSelf(resolved.root);
        installedSource = resolved.source;
    }
    catch { /* resolution is best-effort; the env override still applies */ }
    const base = { executionRoot, installedRoot, installedSource };
    const forced = process.env.MEMEX_INJECT_DAEMON;
    if (forced === '1')
        return { ...base, open: true, reason: 'MEMEX_INJECT_DAEMON=1' };
    if (forced === '0')
        return { ...base, open: false, reason: 'MEMEX_INJECT_DAEMON=0' };
    if (installedSource === 'launcher') {
        return { ...base, open: false, reason: 'no installed plugin root resolved (source=launcher)' };
    }
    if (installedRoot !== executionRoot) {
        return { ...base, open: false, reason: `execution root is not the installed root (${installedSource})` };
    }
    return { ...base, open: true, reason: `execution root is the installed root (${installedSource})` };
}
export function injectSocketPath() {
    return path.join(getIndexDir(), 'inject-daemon.sock');
}
/** Serializes probe→bind across starters. Never held across a request. */
export function injectDaemonLockPath() {
    return path.join(getIndexDir(), 'inject-daemon.lock');
}
const CLIENT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 500;
/** `doctor`'s budget: long enough to outlast an owner's embedding-model load. */
export const INJECT_DAEMON_DIAGNOSTIC_TIMEOUT_MS = 3_000;
function note(message) {
    // stderr: a hook's stdout is injected into the session as context.
    console.error(`[memex] inject-daemon: ${message}`);
}
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means it exists and belongs to someone else: still alive.
        return error.code === 'EPERM';
    }
}
/** Single line-delimited JSON exchange on a fresh connection. */
function askSocket(sockPath, request, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (reply, error) => {
            if (settled)
                return;
            settled = true;
            resolve({ reply, error });
        };
        let conn;
        try {
            conn = net.connect(sockPath);
        }
        catch (error) {
            return done(null, error);
        }
        conn.setTimeout(timeoutMs, () => { conn.destroy(); done(null, null); });
        conn.on('error', (error) => done(null, error));
        conn.on('connect', () => {
            conn.write(`${JSON.stringify(request)}\n`);
            let buf = '';
            conn.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const nl = buf.indexOf('\n');
                if (nl < 0) {
                    if (buf.length > 1_000_000) {
                        conn.destroy();
                        done(null, null);
                    }
                    return;
                }
                try {
                    done(JSON.parse(buf.slice(0, nl)), null);
                }
                catch {
                    done(null, null);
                }
                conn.destroy();
            });
            conn.on('end', () => done(null, null));
        });
    });
}
function ownerFrom(reply) {
    if (!reply || typeof reply.pluginRoot !== 'string' || typeof reply.dbPath !== 'string')
        return null;
    if (typeof reply.protocol !== 'number')
        return null;
    return {
        protocol: reply.protocol,
        version: typeof reply.version === 'string' ? reply.version : null,
        buildId: typeof reply.buildId === 'string' ? reply.buildId : null,
        pluginRoot: reply.pluginRoot,
        dbPath: reply.dbPath,
        pid: typeof reply.pid === 'number' ? reply.pid : -1,
        instanceId: typeof reply.instanceId === 'string' ? reply.instanceId : '',
        startedAt: typeof reply.startedAt === 'string' ? reply.startedAt : '',
    };
}
/**
 * Read-only identity probe — the question `doctor` and a starting server ask.
 *
 * Never `inject`: that would make the owner compute, and a diagnostic must not
 * produce a recall receipt. `listening: false` distinguishes "nothing is there"
 * (ENOENT / ECONNREFUSED, the normal state) from a socket that exists and
 * cannot be spoken to.
 */
export async function probeInjectDaemon(sockPath = injectSocketPath(), 
/**
 * The bind path wants a short budget (not serving is always correct, and a
 * starting MCP server must not stall). A diagnostic wants a generous one: the
 * kernel accepts into the listen backlog even while the owner's event loop is
 * busy — an embedding model load is ~1.1s — so a short timeout would report a
 * perfectly healthy owner as one that "did not identify itself".
 */
timeoutMs = PROBE_TIMEOUT_MS) {
    const { reply, error } = await askSocket(sockPath, {
        type: 'identify', protocol: INJECT_DAEMON_PROTOCOL,
    }, timeoutMs);
    if (error) {
        // ENOENT: no socket. ECONNREFUSED: a socket file whose owner is gone (what a
        // SIGKILL leaves). ENOTSOCK: something at the path that was never a socket.
        // None of the three can be a live owner, so all three are "nothing there"
        // and the path is safe to reclaim. EACCES and friends are NOT: a socket we
        // are not allowed to speak to may still have a live process behind it.
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK') {
            return { listening: false, owner: null, problem: null };
        }
        return { listening: true, owner: null, problem: error.code ?? error.message };
    }
    const owner = ownerFrom(reply);
    if (!owner) {
        return {
            listening: true,
            owner: null,
            problem: reply === null
                ? 'no identity answer (a pre-0.6.3 daemon, or a foreign listener)'
                : `unexpected reply type ${String(reply.type ?? 'none')}`,
        };
    }
    return { listening: true, owner, problem: null };
}
export function startInjectDaemon() {
    const policy = injectDaemonPolicy();
    if (!policy.open) {
        note(`listener not opened — ${policy.reason} (execution root ${policy.executionRoot}, installed root ${policy.installedRoot})`);
        return null;
    }
    // The sidecar can be the first Memex writer in a brand-new installation:
    // create its owned directory before binding instead of silently losing the
    // daemon to listen(2) ENOENT.
    ensureIndexDir();
    const sockPath = injectSocketPath();
    const identity = injectDaemonIdentity();
    const self = {
        ...identity,
        pid: process.pid,
        instanceId: randomUUID(),
        startedAt: new Date().toISOString(),
    };
    let retired = false;
    const server = net.createServer((conn) => {
        let buf = '';
        conn.setTimeout(CLIENT_TIMEOUT_MS, () => conn.destroy());
        conn.on('error', () => { });
        conn.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl < 0) {
                if (buf.length > 1_000_000)
                    conn.destroy(); // absurd request — drop
                return;
            }
            const line = buf.slice(0, nl);
            void (async () => {
                const reply = (payload) => {
                    try {
                        conn.end(`${JSON.stringify(payload)}\n`);
                    }
                    catch { /* gone */ }
                };
                // `identity()` is re-read per request so a moved data root is visible.
                const mine = () => ({
                    ...injectDaemonIdentity(), pid: self.pid, instanceId: self.instanceId, startedAt: self.startedAt,
                });
                try {
                    const req = JSON.parse(line);
                    if (req.type === 'identify')
                        return reply({ type: 'identity', ...mine() });
                    if (req.type === 'retire')
                        return reply(handleRetire(req, mine()));
                    if (req.type !== 'inject') {
                        // A request without the handshake cannot be trusted to be for this
                        // build, so it is refused BEFORE any computation — issue #84's whole
                        // point. A pre-0.6.3 hook lands here and falls back in-process.
                        return reply({ type: 'mismatch', ...mine(), reason: 'missing inject handshake' });
                    }
                    const asked = {
                        protocol: typeof req.protocol === 'number' ? req.protocol : undefined,
                        version: typeof req.version === 'string' ? req.version : null,
                        buildId: typeof req.buildId === 'string' ? req.buildId : null,
                        pluginRoot: typeof req.pluginRoot === 'string' ? req.pluginRoot : undefined,
                        dbPath: typeof req.dbPath === 'string' ? req.dbPath : undefined,
                    };
                    const current = mine();
                    if (!injectDaemonIdentityMatches(asked, current)) {
                        // No computation, no receipt, no log line: nothing happened here.
                        return reply({ type: 'mismatch', ...current, reason: 'identity mismatch' });
                    }
                    let receiptId = null;
                    const context = await computeInjectContext(String(req.prompt ?? ''), String(req.cwd ?? process.cwd()), 'daemon', req.sessionId ? String(req.sessionId) : undefined, {
                        onPreparedReceipt: (id) => { receiptId = id; },
                        daemon: { version: current.version, buildId: current.buildId, pid: current.pid },
                    });
                    reply({ type: 'ok', ...current, ok: true, context, receiptId });
                }
                catch {
                    try {
                        conn.end(`${JSON.stringify({ type: 'error', ok: false })}\n`);
                    }
                    catch { /* gone */ }
                }
            })();
        });
    });
    /**
     * Cooperative handover. A 0.6.3+ owner steps aside for the INSTALLED root and
     * for nobody else: honouring any caller would turn the socket into a
     * free-for-all in the other direction.
     */
    function handleRetire(req, current) {
        const from = ownerFrom(req.from && typeof req.from === 'object' && !Array.isArray(req.from)
            ? req.from
            : null);
        if (req.protocol !== INJECT_DAEMON_PROTOCOL || !from) {
            return { type: 'refused', ...current, reason: 'unreadable retire request' };
        }
        if (injectDaemonIdentityMatches(from, current)) {
            return { type: 'duplicate', ...current, reason: 'caller runs this same build' };
        }
        const installed = injectDaemonPolicy().installedRoot;
        if (from.pluginRoot !== installed) {
            return { type: 'refused', ...current, reason: 'caller is not the installed plugin root' };
        }
        retired = true;
        try {
            server.close();
        }
        catch { /* already closing */ }
        // Unlink our own socket so the caller can bind; it is ours to remove.
        try {
            if (fs.existsSync(sockPath))
                fs.unlinkSync(sockPath);
        }
        catch { /* raced */ }
        note(`retired in favour of the installed root ${from.pluginRoot} (version ${from.version ?? 'unknown'})`);
        return { type: 'retired', ...current };
    }
    const onListen = () => {
        try {
            fs.chmodSync(sockPath, 0o600);
        }
        catch { /* best-effort */ }
        // Pre-warm the embedding model so even the FIRST prompt after session
        // start gets the fast path (load happens once, off the request path).
        void initEmbeddings().catch(() => { });
    };
    /**
     * Claim the socket under an `O_EXCL` lock so two starting servers cannot both
     * decide the socket is dead and both bind. A lock left by a process that is
     * gone (SIGKILL) is replaced; a lock held by a live process means another
     * starter is mid-probe and this one simply does not serve.
     */
    const withLock = async (claim) => {
        const lockPath = injectDaemonLockPath();
        const mine = JSON.stringify({ pid: process.pid, startedAt: self.startedAt });
        const holdsOurLock = () => {
            try {
                return fs.readFileSync(lockPath, 'utf8') === mine;
            }
            catch {
                return false;
            }
        };
        let held = false;
        for (let attempt = 0; attempt < 2 && !held; attempt++) {
            try {
                // Create AND fill in one call: an `openSync` followed by a separate
                // write leaves a window in which the lock exists but is empty, and a
                // second starter reading it then takes the "unreadable means stale"
                // branch below and deletes a live holder's lock.
                fs.writeFileSync(lockPath, mine, { flag: 'wx' });
                held = true;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
                let holder = -1;
                try {
                    holder = Number(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid);
                }
                catch { /* unreadable lock counts as stale */ }
                if (pidAlive(holder)) {
                    note(`another starter holds ${lockPath} (pid ${holder}) — not serving`);
                    return;
                }
                try {
                    fs.unlinkSync(lockPath);
                }
                catch { /* raced another reclaimer */ }
            }
        }
        if (!held) {
            note('could not take the bind lock — not serving');
            return;
        }
        try {
            await claim();
        }
        finally {
            // Only ever remove OUR lock: by now another starter may have decided ours
            // was stale and replaced it with its own.
            if (holdsOurLock()) {
                try {
                    fs.unlinkSync(lockPath);
                }
                catch { /* someone reclaimed it */ }
            }
        }
    };
    const bind = () => {
        if (retired)
            return;
        try {
            server.listen(sockPath, onListen);
            server.unref();
        }
        catch { /* sidecar is best-effort */ }
    };
    // The reclaim ends in another `listen`, which can itself raise EADDRINUSE if a
    // racer won in between. One attempt only: retrying would loop against whoever
    // keeps winning, and not serving is always a correct outcome here.
    let reclaimAttempted = false;
    server.on('error', (err) => {
        if (err.code !== 'EADDRINUSE')
            return; // best-effort sidecar — never crash the MCP server
        if (reclaimAttempted) {
            note('socket was claimed by another starter during the handover — not serving');
            return;
        }
        reclaimAttempted = true;
        void withLock(async () => {
            const probe = await probeInjectDaemon(sockPath);
            if (!probe.listening) {
                // Stale socket file (the owner was SIGKILLed): reclaim and bind.
                try {
                    fs.unlinkSync(sockPath);
                }
                catch { /* raced another reclaimer */ }
                return bind();
            }
            if (probe.owner && injectDaemonIdentityMatches(probe.owner, injectDaemonIdentity())) {
                note(`socket already served by this same build (pid ${probe.owner.pid}) — not serving`);
                return;
            }
            if (!probe.owner) {
                // Something is listening and will not identify itself. It may be a
                // pre-0.6.3 daemon or another program entirely; unlinking a socket we
                // cannot attribute would break a live owner, so it is left alone. Hooks
                // fall back in-process, so correctness holds until it exits.
                note(`socket held by an unidentified listener (${probe.problem ?? 'no answer'}) — left alone, hooks will use the in-process fallback`);
                return;
            }
            const { reply } = await askSocket(sockPath, {
                type: 'retire', protocol: INJECT_DAEMON_PROTOCOL, from: { ...injectDaemonIdentity(), pid: process.pid, instanceId: self.instanceId, startedAt: self.startedAt },
            });
            if (reply?.type === 'retired') {
                note(`took over from ${String(reply.version ?? 'unknown')} at ${String(reply.pluginRoot ?? '?')} (pid ${String(reply.pid ?? '?')})`);
                try {
                    if (fs.existsSync(sockPath))
                        fs.unlinkSync(sockPath);
                }
                catch { /* already gone */ }
                return bind();
            }
            note(`owner ${probe.owner.version ?? 'unknown'} at ${probe.owner.pluginRoot} (pid ${probe.owner.pid}) refused handover (${String(reply?.reason ?? reply?.type ?? 'no answer')}) — not serving`);
        }).catch(() => { });
    });
    bind();
    return server;
}
