/**
 * Warm inject daemon: directory contract, identity handshake, socket ownership
 * and the dev-root policy.
 *
 * Issue #84 — the socket used to belong to whoever bound it first.
 *
 * Observed on the real data root (2026-09-10): a Claude Code session had started
 * `Documents/memex/dist/mcp-server.js` from a development checkout (a pre-0.6.0
 * `dist`) at 02:18; that process owned
 * `~/.config/memex/conversation-index/inject-daemon.sock`, and all four prompts
 * Codex's 0.6.2 hook sent were answered by the old build — logged as
 * `status:"injected", injected:0, via:"daemon"` (no 0.6.2 `context-only` split),
 * with zero `baseline_margin_gap` telemetry rows. `lsof -U` showed node 44184;
 * killing it and restarting Codex handed the socket to
 * `~/.codex/plugins/cache/memex/memex/0.6.2/dist/mcp-server` (pid 4579). Nothing
 * in `doctor` or `status` had shown any of it.
 *
 * macOS `sockaddr_un` paths are ~104 bytes, so every socket here lives under a
 * short `/tmp` directory rather than the repository's own temp tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const HOOK = path.join(REPO, 'scripts', 'inject-context.js');

function tempRoot(t, label) {
  const root = fs.realpathSync(fs.mkdtempSync(`/tmp/mb-daemon-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'conversation-index'), { recursive: true });
  return root;
}

function socketIn(root) {
  return path.join(root, 'conversation-index', 'inject-daemon.sock');
}

function logIn(root) {
  return path.join(root, 'conversation-index', 'logs', 'inject-context.jsonl');
}

function readLog(root) {
  try {
    return fs.readFileSync(logIn(root), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Run a snippet inside a child process with its own data root.
 *
 * `MEMEX_EMBEDDING_STUB=1` by default: `startInjectDaemon` pre-warms the
 * embedding model, and better-sqlite3 / transformers load synchronously, which
 * would block the event loop past the 500ms ownership probe and make these
 * socket assertions depend on model-load latency.
 */
function runModule(code, env, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: REPO,
      env: { MEMEX_EMBEDDING_STUB: '1', ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); });
  });
}

/** Drive the real hook against whatever is (or is not) listening. */
function runHook(root, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        MEMEX_HOME: root,
        TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * A stand-in daemon. `respond(request)` returns the object to reply with, or
 * null to answer nothing; `received` collects every request it saw, which is how
 * "the mismatching daemon was never asked to compute" is asserted.
 */
async function fakeDaemon(t, sockPath, respond) {
  const received = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += String(chunk);
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let request = null;
      try { request = JSON.parse(buf.slice(0, nl)); } catch { /* malformed */ }
      buf = buf.slice(nl + 1);
      received.push(request);
      const reply = respond(request);
      if (reply === null) return;
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(sockPath, resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { server, received };
}

test('inject daemon creates its index directory on a fresh data root', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/mb-daemon-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const code = `
    import fs from 'node:fs';
    import net from 'node:net';
    import path from 'node:path';
    import { startInjectDaemon } from './dist/inject-daemon.js';
    const socketPath = path.join(process.env.MEMEX_HOME, 'conversation-index', 'inject-daemon.sock');
    const timer = setTimeout(() => { console.error('socket timeout'); process.exit(2); }, 5000);
    const connect = () => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); server.close(); process.exit(0); });
      socket.once('error', (error) => { console.error('connect error', error.message); socket.destroy(); });
    };
    const server = startInjectDaemon();
    if (!server) { console.error('policy refused to open the listener'); process.exit(4); }
    const indexDir = path.dirname(socketPath);
    if (!fs.existsSync(indexDir)) { console.error('index directory missing'); process.exit(3); }
    server.on('error', (error) => console.error('server error', error.message));
    if (server.listening) connect(); else server.once('listening', connect);
  `;
  // This suite runs from the checkout, which is not an installed plugin root, so
  // the dev-root policy is overridden explicitly for the directory contract.
  const result = await runModule(code, {
    MEMEX_HOME: root,
    TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

// ---------------------------------------------------------------------------
// (a) identity mismatch — the observed defect
// ---------------------------------------------------------------------------

test('the hook refuses a daemon that cannot handshake and falls back in-process', async (t) => {
  const root = tempRoot(t, 'nohs');
  // Exactly the pre-0.6.3 reply shape: `{ok:true, context, receiptId}`.
  const daemon = await fakeDaemon(t, socketIn(root), () => ({
    ok: true, context: 'STALE BUILD CONTEXT', receiptId: null,
  }));

  const run = await runHook(root, { prompt: 'why did we choose SQLite?', cwd: root, session_id: 's-nohs' });
  assert.equal(run.exitCode, 0, run.stderr);
  // The old build's context never reached the model.
  assert.ok(!run.stdout.includes('STALE BUILD CONTEXT'), run.stdout);

  const lines = readLog(root);
  const last = lines.at(-1);
  assert.ok(last, 'the fallback must still write its line');
  assert.equal(last.via, 'fallback');
  assert.match(last.daemon.reason, /no handshake/);
  assert.equal(last.daemon.got, null);
  assert.ok(last.daemon.expected.pluginRoot.length > 0);
  // The request carried the handshake, so a 0.6.3 daemon could have matched.
  assert.equal(daemon.received[0].type, 'inject');
  assert.equal(daemon.received[0].protocol, 1);
});

test('a pre-0.6.3 daemon is given no session, so it cannot commit state the fallback needs', async (t) => {
  const root = tempRoot(t, 'nosess');
  // The 0.6.2 daemon read `session_id`. Handing it one would make it run
  // `computeInjectContext` to completion and COMMIT the bundle transaction —
  // prepared receipt, resident fact revisions, gate state — for a reply the hook
  // then refuses. The in-process fallback would find every fact already resident
  // at the same generation, dedup them all and emit nothing, leaving a dangling
  // `prepared` receipt per prompt. Omitting the field makes the old daemon stop
  // at its own `if (!sessionId)` guard, before it touches the database.
  const daemon = await fakeDaemon(t, socketIn(root), () => ({
    ok: true, context: 'STALE BUILD CONTEXT', receiptId: null,
  }));

  const run = await runHook(root, { prompt: 'why did we choose SQLite?', cwd: root, session_id: 's-nosess' });
  assert.equal(run.exitCode, 0, run.stderr);
  const asked = daemon.received[0];
  assert.equal(asked.sessionId, 's-nosess', 'a 0.6.3 daemon still gets the session');
  assert.ok(!('session_id' in asked), `the legacy alias must be absent: ${JSON.stringify(asked)}`);

  // And the fallback really did produce its own run rather than a deduped shell.
  const last = readLog(root).at(-1);
  assert.equal(last.via, 'fallback');
  assert.notEqual(last.status, 'deduped', JSON.stringify(last));
});

test('an ok reply that echoes a different identity is refused, not injected', async (t) => {
  const root = tempRoot(t, 'echo');
  // Saying `ok` is not proof of anything: the socket path is predictable and any
  // same-user process can squat it. Without checking the echo, the handshake
  // would gate only the daemon's willingness to answer.
  await fakeDaemon(t, socketIn(root), (request) => ({
    type: 'ok',
    protocol: request.protocol,
    version: request.version,
    buildId: 'sha256:not-the-build-you-asked-for',
    pluginRoot: request.pluginRoot,
    dbPath: request.dbPath,
    pid: 1234,
    ok: true,
    context: 'SQUATTER CONTEXT',
    receiptId: null,
  }));

  const run = await runHook(root, { prompt: 'why did we choose SQLite?', cwd: root, session_id: 's-echo' });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.ok(!run.stdout.includes('SQUATTER CONTEXT'), run.stdout);
  const last = readLog(root).at(-1);
  assert.equal(last.via, 'fallback');
  assert.match(last.daemon.reason, /ok reply carried a different identity/);
  assert.equal(last.daemon.got.buildId, 'sha256:not-the-build-you-asked-for');
});

test('the hook refuses each differing identity field and records what it got', async (t) => {
  for (const [label, override] of [
    ['version', { version: '0.0.1-other' }],
    ['buildId', { buildId: 'sha256:deadbeef' }],
    ['pluginRoot', { pluginRoot: '/somewhere/else' }],
    ['dbPath', { dbPath: '/somewhere/else/db.sqlite' }],
    ['protocol', { protocol: 99 }],
  ]) {
    const root = tempRoot(t, `mm-${label}`);
    const daemon = await fakeDaemon(t, socketIn(root), (request) => ({
      // A 0.6.3 daemon replies `mismatch` and computes nothing; this stands in
      // for one whose identity differs in exactly one field.
      type: 'mismatch',
      protocol: request.protocol, version: request.version, buildId: request.buildId,
      pluginRoot: request.pluginRoot, dbPath: request.dbPath, pid: 4242,
      reason: 'identity mismatch',
      ...override,
    }));

    const run = await runHook(root, { prompt: 'why Redis?', cwd: root, session_id: `s-${label}` });
    assert.equal(run.exitCode, 0, run.stderr);
    const last = readLog(root).at(-1);
    assert.ok(last, `${label}: a fallback line is required`);
    assert.equal(last.via, 'fallback', label);
    assert.equal(last.daemon.reason, 'identity mismatch', label);
    assert.equal(last.daemon.got.pid, 4242, label);
    assert.equal(daemon.received.length, 1, `${label}: exactly one handshake`);
  }
});

test('a matching identity is served on the fast path and attributed in the log', async (t) => {
  const root = tempRoot(t, 'match');
  await fakeDaemon(t, socketIn(root), (request) => ({
    type: 'ok',
    protocol: request.protocol, version: request.version, buildId: request.buildId,
    pluginRoot: request.pluginRoot, dbPath: request.dbPath, pid: 7,
    ok: true, context: 'WARM CONTEXT', receiptId: null,
  }));

  const run = await runHook(root, { prompt: 'why did we choose SQLite?', cwd: root, session_id: 's-match' });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /WARM CONTEXT/);
  // The fast path emitted with no receipt of its own, which is the pre-existing
  // `receipt-failed` contract (#44) — the point here is that it was SERVED.
  const lines = readLog(root);
  assert.ok(lines.some((line) => line.via === 'daemon' || line.status === 'receipt-failed'), JSON.stringify(lines));
});

test('no socket file at all is logged as reason "absent"', async (t) => {
  // Issue #89 changed this from "no daemon note at all". A cold start and "the
  // socket has been dead for an hour and every prompt pays 70s" produced the
  // same silence, so the state this bug actually created was invisible in the
  // one surface `doctor` reads. ENOENT now names itself.
  const root = tempRoot(t, 'empty');
  const run = await runHook(root, { prompt: 'why did we choose SQLite?', cwd: root, session_id: 's-empty' });
  assert.equal(run.exitCode, 0, run.stderr);
  const last = readLog(root).at(-1);
  assert.ok(last, 'the fallback must still write its line');
  assert.equal(last.via, 'fallback');
  assert.equal(last.daemon.reason, 'absent', JSON.stringify(last.daemon));
  assert.equal(last.daemon.got, null, 'there was nobody to report an identity');
});

// ---------------------------------------------------------------------------
// (b) socket ownership
// ---------------------------------------------------------------------------

test('a stale socket file is reclaimed, and a live same-build owner is not displaced', async (t) => {
  const root = tempRoot(t, 'stale');
  const sockPath = socketIn(root);
  // A real socket file with nobody behind it — exactly what the observed SIGKILL
  // left (`lsof -U` showed node 44184 and the file outlived it). Connecting gives
  // ECONNREFUSED, not ENOENT, which is why the probe has to distinguish them.
  const orphan = spawn(process.execPath, ['--input-type=module', '-e', `
    import net from 'node:net';
    const server = net.createServer(() => {});
    server.listen(${JSON.stringify(sockPath)}, () => { console.log('bound'); });
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    orphan.stdout.once('data', resolve);
    orphan.once('error', reject);
    setTimeout(() => reject(new Error('orphan never bound')), 5000);
  });
  orphan.kill('SIGKILL');
  await new Promise((resolve) => orphan.once('exit', resolve));
  assert.ok(fs.existsSync(sockPath), 'the SIGKILLed owner must leave its socket behind');

  const code = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { startInjectDaemon, injectSocketPath } from './dist/inject-daemon.js';
    const first = startInjectDaemon();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!first || !first.listening) { console.error('stale socket was not reclaimed'); process.exit(2); }
    // A second starter in the same process has the identical identity, so it
    // must step aside rather than fight for the socket.
    const second = startInjectDaemon();
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (second && second.listening) { console.error('two listeners bound the same socket'); process.exit(3); }
    if (fs.existsSync(path.join(process.env.MEMEX_HOME, 'conversation-index', 'inject-daemon.lock'))) {
      console.error('bind lock was left behind'); process.exit(4);
    }
    first.close();
    process.exit(0);
  `;
  const result = await runModule(code, {
    MEMEX_HOME: root,
    TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /same build/);
});

test('a non-socket file at the socket path is reclaimed too', async (t) => {
  const root = tempRoot(t, 'notsock');
  // Not a socket at all (ENOTSOCK): it cannot be a live owner, so it is garbage
  // the next starter clears rather than a path it must avoid forever.
  fs.writeFileSync(socketIn(root), 'not a socket');
  const result = await runModule(`
    import { startInjectDaemon } from './dist/inject-daemon.js';
    const server = startInjectDaemon();
    await new Promise((resolve) => setTimeout(resolve, 600));
    console.error('listening=' + Boolean(server && server.listening));
    if (server) server.close();
    process.exit(0);
  `, {
    MEMEX_HOME: root,
    TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /listening=true/);
});

test('a live lock held by another starter stops the bind, and a dead one is replaced', async (t) => {
  const root = tempRoot(t, 'lock');
  const lockPath = path.join(root, 'conversation-index', 'inject-daemon.lock');
  const sockPath = socketIn(root);
  // A live owner (so the starter reaches the lock at all) plus a lock claiming
  // to be held by THIS test process, which is certainly alive.
  await fakeDaemon(t, sockPath, () => null);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const code = `
    import { startInjectDaemon } from './dist/inject-daemon.js';
    const server = startInjectDaemon();
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (server && server.listening) { console.error('bound despite a live lock'); process.exit(2); }
    process.exit(0);
  `;
  const held = await runModule(code, {
    MEMEX_HOME: root, TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(held.exitCode, 0, held.stderr);
  assert.match(held.stderr, /another starter holds/);
  // The lock is still the other starter's: it must not have been removed.
  assert.ok(fs.existsSync(lockPath), 'a live starter’s lock must survive');

  // A lock from a pid that is gone is stale and gets replaced.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22, startedAt: new Date().toISOString() }));
  const stale = await runModule(code, {
    MEMEX_HOME: root, TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(stale.exitCode, 0, stale.stderr);
  assert.doesNotMatch(stale.stderr, /another starter holds/);
  // The live owner would not identify itself, so it is left alone either way.
  assert.match(stale.stderr, /unidentified listener/);
  assert.ok(!fs.existsSync(lockPath), 'a stale lock is released after the attempt');
});

test('the real daemon and the real hook agree on the handshake', async (t) => {
  const root = tempRoot(t, 'e2e');
  // The identity is computed twice from two files — src/inject-daemon.ts and
  // scripts/inject-context.js, which cannot import it without dragging the heavy
  // dist chain onto the fast path. This is the test that keeps the two mirrors
  // in step: any drift in a field name or a hash input shows up as a fallback.
  const daemon = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startInjectDaemon } from './dist/inject-daemon.js';
    const server = startInjectDaemon();
    if (!server) { console.error('policy refused'); process.exit(2); }
    const announce = () => console.log('ready ' + process.pid);
    if (server.listening) announce(); else server.once('listening', announce);
    setInterval(() => {}, 1000);
  `], {
    cwd: REPO,
    env: {
      ...process.env,
      MEMEX_HOME: root,
      TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
      MEMEX_INJECT_DAEMON: '1',
      MEMEX_EMBEDDING_STUB: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => daemon.kill('SIGKILL'));
  const pid = await new Promise((resolve, reject) => {
    let out = '';
    daemon.stdout.setEncoding('utf8');
    daemon.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/ready (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    daemon.once('error', reject);
    setTimeout(() => reject(new Error(`daemon never announced: ${out}`)), 10_000);
  });

  const run = await runHook(root, { prompt: 'why did we choose SQLite?', cwd: root, session_id: 's-e2e' },
    { MEMEX_EMBEDDING_STUB: '1' });
  assert.equal(run.exitCode, 0, run.stderr);
  const lines = readLog(root);
  const served = lines.find((line) => line.via === 'daemon');
  assert.ok(served, `the fast path must have served it: ${JSON.stringify(lines)}`);
  // The line is attributable to a build, not merely to "some MCP server".
  assert.equal(served.daemon.pid, pid);
  assert.ok(served.daemon.buildId.startsWith('sha256:'), served.daemon.buildId);
  assert.ok(!lines.some((line) => line.via === 'fallback'), JSON.stringify(lines));
});

test('an unreachable socket is never unlinked', async (t) => {
  const root = tempRoot(t, 'own');
  const sockPath = socketIn(root);

  // EACCES: a socket that exists and cannot be connected to. Removing it would
  // break a live owner we cannot attribute, so it must survive untouched.
  await fakeDaemon(t, sockPath, () => null);
  fs.chmodSync(sockPath, 0o000);
  const code = `
    import { startInjectDaemon } from './dist/inject-daemon.js';
    const server = startInjectDaemon();
    await new Promise((resolve) => setTimeout(resolve, 800));
    console.error('listening=' + Boolean(server && server.listening));
    process.exit(0);
  `;
  const denied = await runModule(code, {
    MEMEX_HOME: root, TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(denied.exitCode, 0, denied.stderr);
  assert.match(denied.stderr, /listening=false/);
  assert.ok(fs.existsSync(sockPath), 'an unreachable socket must not be unlinked');
  fs.chmodSync(sockPath, 0o600);
});

test('a 0.6.3 owner retires for the installed root and refuses everyone else', async (t) => {
  const root = tempRoot(t, 'retire');
  const sockPath = socketIn(root);
  const asks = [];
  // An owner that identifies itself as a DIFFERENT build, then accepts the
  // handover — the cooperative path a stale 0.6.3 daemon takes.
  const owner = {
    protocol: 1, version: '0.0.1-old', buildId: 'sha256:old', pluginRoot: '/old/root',
    dbPath: path.join(root, 'conversation-index', 'db.sqlite'),
    pid: 4242, instanceId: 'old-instance', startedAt: new Date().toISOString(),
  };
  const server = await fakeDaemon(t, sockPath, (request) => {
    asks.push(request);
    if (request.type === 'identify') return { type: 'identity', ...owner };
    if (request.type === 'retire') {
      // Step aside exactly as the real daemon does: close, unlink, reply.
      setImmediate(() => {
        server.server.close();
        try { fs.unlinkSync(sockPath); } catch { /* already gone */ }
      });
      return { type: 'retired', ...owner };
    }
    return { type: 'mismatch', ...owner };
  });

  const code = `
    import { startInjectDaemon } from './dist/inject-daemon.js';
    const server = startInjectDaemon();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    console.error('listening=' + Boolean(server && server.listening));
    if (server) server.close();
    process.exit(0);
  `;
  const result = await runModule(code, {
    MEMEX_HOME: root, TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(result.exitCode, 0, result.stderr);
  // Identity first (never an injection), then the retire request.
  assert.deepEqual(asks.map((a) => a.type), ['identify', 'retire']);
  assert.equal(asks[1].from.protocol, 1);
  assert.match(result.stderr, /took over from 0\.0\.1-old/);
  assert.match(result.stderr, /listening=true/);
});

test('a retire request from a root that is not the installed one is refused', async (t) => {
  const root = tempRoot(t, 'refuse');
  const code = `
    import net from 'node:net';
    import path from 'node:path';
    import { startInjectDaemon, injectSocketPath, injectDaemonIdentity } from './dist/inject-daemon.js';
    const server = startInjectDaemon();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!server || !server.listening) { console.error('listener did not open'); process.exit(2); }
    const ask = (request) => new Promise((resolve) => {
      const conn = net.connect(injectSocketPath());
      let buf = '';
      conn.on('connect', () => conn.write(JSON.stringify(request) + '\\n'));
      conn.on('data', (c) => {
        buf += String(c);
        const nl = buf.indexOf('\\n');
        if (nl < 0) return;
        conn.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      });
      conn.on('error', () => resolve(null));
    });
    const foreign = await ask({
      type: 'retire', protocol: 1,
      from: { protocol: 1, version: '9.9.9', buildId: 'sha256:x', pluginRoot: '/not/installed',
              dbPath: injectDaemonIdentity().dbPath, pid: 1, instanceId: 'x', startedAt: 'now' },
    });
    console.error('foreign=' + JSON.stringify(foreign.type) + ':' + JSON.stringify(foreign.reason));
    const mine = await ask({
      type: 'retire', protocol: 1,
      from: { ...injectDaemonIdentity(), pid: process.pid, instanceId: 'same', startedAt: 'now' },
    });
    console.error('same=' + JSON.stringify(mine.type));
    const identity = await ask({ type: 'identify', protocol: 1 });
    console.error('identity=' + JSON.stringify(identity.type) + ':' + (identity.pid === process.pid));
    if (!server.listening) { console.error('a refused retire closed the listener'); process.exit(3); }
    server.close();
    process.exit(0);
  `;
  const result = await runModule(code, {
    MEMEX_HOME: root, TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_INJECT_DAEMON: '1',
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stderr, /foreign="refused":"caller is not the installed plugin root"/);
  assert.match(result.stderr, /same="duplicate"/);
  assert.match(result.stderr, /identity="identity":true/);
});

// ---------------------------------------------------------------------------
// (c) dev-root policy and the doctor report
// ---------------------------------------------------------------------------

test('only the installed plugin root opens the listener, and the env forces either way', async (t) => {
  const root = tempRoot(t, 'policy');
  const codexHome = path.join(root, 'codex');
  const installed = path.join(codexHome, 'plugins', 'cache', 'memex', 'memex', '9.9.9');
  fs.mkdirSync(path.join(installed, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(installed, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(installed, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'memex', version: '9.9.9' }));
  fs.writeFileSync(path.join(installed, 'cli', 'memex.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'memex', version: '9.9.9' }));

  const code = `
    import { injectDaemonPolicy } from './dist/inject-daemon.js';
    console.log(JSON.stringify(injectDaemonPolicy()));
  `;
  const env = {
    MEMEX_HOME: root,
    TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    CODEX_HOME: codexHome,
  };
  delete env.MEMEX_PLUGIN_ROOT;

  // This checkout is not the installed root, so the listener stays closed.
  const checkout = await runModule(code, { ...env, MEMEX_PLUGIN_ROOT: '' });
  const checkoutPolicy = JSON.parse(checkout.stdout.trim());
  assert.equal(checkoutPolicy.open, false, checkout.stdout);
  assert.match(checkoutPolicy.reason, /not the installed root/);
  assert.equal(checkoutPolicy.executionRoot, fs.realpathSync(REPO));

  // Pointing the resolver at this very root makes it the installed one.
  const asInstalled = await runModule(code, { ...env, MEMEX_PLUGIN_ROOT: REPO });
  const installedPolicy = JSON.parse(asInstalled.stdout.trim());
  assert.equal(installedPolicy.open, true, asInstalled.stdout);
  assert.match(installedPolicy.reason, /is the installed root/);

  // With nothing resolvable the source is `launcher`, which is not evidence of
  // an installation: closed.
  const nowhere = await runModule(code, {
    ...env, MEMEX_PLUGIN_ROOT: '', CODEX_HOME: path.join(root, 'no-codex'),
  });
  const nowherePolicy = JSON.parse(nowhere.stdout.trim());
  assert.equal(nowherePolicy.open, false, nowhere.stdout);
  assert.match(nowherePolicy.reason, /source=launcher/);

  // The env override decides in both directions, whatever the roots say.
  const forcedOn = await runModule(code, { ...env, MEMEX_PLUGIN_ROOT: '', MEMEX_INJECT_DAEMON: '1' });
  assert.equal(JSON.parse(forcedOn.stdout.trim()).open, true, forcedOn.stdout);
  const forcedOff = await runModule(code, { ...env, MEMEX_PLUGIN_ROOT: REPO, MEMEX_INJECT_DAEMON: '0' });
  assert.equal(JSON.parse(forcedOff.stdout.trim()).open, false, forcedOff.stdout);
});

test('doctor judges the owner against the INSTALLED root, not its own copy', async (t) => {
  const root = tempRoot(t, 'shim');
  // `~/.local/bin/memex` is an npx shim (issue #53), so `memex doctor` routinely
  // runs from a copy that is NOT the root the hooks run from. The expected
  // identity has to describe the installed root; judging the owner against
  // doctor's own copy reports a healthy installation as "a DIFFERENT build" and
  // hands the operator a pid to kill.
  const installed = path.join(root, 'installed');
  fs.mkdirSync(path.join(installed, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(installed, 'cli'), { recursive: true });
  fs.mkdirSync(path.join(installed, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(installed, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'memex', version: '9.9.9' }));
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'memex', version: '9.9.9' }));
  fs.writeFileSync(path.join(installed, 'cli', 'memex.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(installed, 'dist', 'mcp-server.js'), '// a different build\n');

  const env = {
    MEMEX_HOME: root,
    TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_PLUGIN_ROOT: installed,
    CODEX_HOME: path.join(root, 'codex'),
  };
  // The identity a daemon running out of that installed root would present.
  const identity = JSON.parse((await runModule(`
    import { injectDaemonIdentityFor } from './dist/inject-daemon.js';
    console.log(JSON.stringify(injectDaemonIdentityFor(${JSON.stringify(installed)})));
  `, env)).stdout.trim());
  assert.equal(identity.version, '9.9.9');
  assert.notEqual(identity.pluginRoot, fs.realpathSync(REPO));

  await fakeDaemon(t, socketIn(root), (request) =>
    request.type === 'identify'
      ? { type: 'identity', ...identity, pid: 555, instanceId: 'i', startedAt: '2026-09-10T00:00:00.000Z' }
      : null);

  // doctor itself runs from this checkout, which is a third root entirely.
  const check = JSON.parse((await runModule(`
    const { doctor } = await import('./dist/lifecycle.js');
    const report = await doctor();
    console.log(JSON.stringify(report.json.find((c) => c.name === 'inject-daemon')));
  `, env)).stdout.trim());
  assert.equal(check.status, 'ok', check.detail);
  assert.match(check.detail, /served by this installation/);
  assert.match(check.detail, /hooks run from .*installed/);
  assert.match(check.detail, /this diagnostic runs from/);
});

test('doctor reports no daemon, this installation, and a foreign owner', async (t) => {
  const root = tempRoot(t, 'doctor');
  const code = `
    const { doctor } = await import('./dist/lifecycle.js');
    const report = await doctor();
    console.log(JSON.stringify(report.json.find((c) => c.name === 'inject-daemon')));
  `;
  const env = {
    MEMEX_HOME: root,
    TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite'),
    MEMEX_PLUGIN_ROOT: REPO,
    CODEX_HOME: path.join(root, 'codex'),
  };

  const none = JSON.parse((await runModule(code, env)).stdout.trim());
  assert.equal(none.status, 'ok');
  assert.match(none.detail, /absent — no socket file/);

  // An owner running this very build: ok, with its pid and version.
  const identity = JSON.parse((await runModule(`
    import { injectDaemonIdentity } from './dist/inject-daemon.js';
    console.log(JSON.stringify(injectDaemonIdentity()));
  `, env)).stdout.trim());
  const mine = await fakeDaemon(t, socketIn(root), (request) =>
    request.type === 'identify'
      ? { type: 'identity', ...identity, pid: 31337, instanceId: 'i', startedAt: '2026-09-10T00:00:00.000Z' }
      : null);
  const same = JSON.parse((await runModule(code, env)).stdout.trim());
  assert.equal(same.status, 'ok', same.detail);
  assert.match(same.detail, /served by this installation/);
  assert.match(same.detail, /owner pid 31337/);
  await new Promise((resolve) => mine.server.close(() => resolve()));
  fs.rmSync(socketIn(root), { force: true });

  // A foreign build: warn, naming version, root, db and the pid caveat.
  const foreign = await fakeDaemon(t, socketIn(root), (request) =>
    request.type === 'identify'
      ? {
          type: 'identity', protocol: 1, version: '0.5.9', buildId: 'sha256:old',
          pluginRoot: '/Users/someone/Documents/memex', dbPath: identity.dbPath,
          pid: 44184, instanceId: 'old', startedAt: '2026-09-10T02:18:00.000Z',
        }
      : null);
  const other = JSON.parse((await runModule(code, env)).stdout.trim());
  assert.equal(other.status, 'warn', other.detail);
  assert.match(other.detail, /owned by a DIFFERENT build/);
  assert.match(other.detail, /version 0\.5\.9/);
  assert.match(other.detail, /pid 44184/);
  assert.match(other.detail, /pids can be reused/);
  await new Promise((resolve) => foreign.server.close(() => resolve()));
});
