// Behavior tests for the Codex-only vertical slice. Zero external deps:
// runs with plain `node --test` against type-stripped TS modules.
// Covers: recursive discovery, turn assembly (reasoning/system exclusion,
// custom_tool_call + function_call, tool-only exchange preservation),
// subagent isolation, malformed-line tolerance, codex exec arg building,
// item.completed fallback parsing, recursion guard, fake-bin end-to-end,
// and transcript stabilization.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');

const {
  sessionsRoot,
  discoverSessionFiles,
  parseRolloutStream,
  parseConversation,
  isSubagentMeta,
  readRolloutMeta,
  extractSessionIdFromPath,
} = await import(path.join(REPO, 'src/codex-rollout.ts'));

test('extractSessionIdFromPath captures the trailing UUID of real Codex names', () => {
  const real = 'rollout-2026-08-24T03-47-58-01a02ff3-7077-7b91-905b-75b5d5d98031.jsonl';
  assert.equal(extractSessionIdFromPath(`/x/2026/08/24/${real}`), '01a02ff3-7077-7b91-905b-75b5d5d98031');
  assert.equal(extractSessionIdFromPath('/a/b/0f8f2c1e-1111-2222-3333-444455556666.jsonl'), '0f8f2c1e-1111-2222-3333-444455556666');
  assert.equal(extractSessionIdFromPath('/a/b/not-a-session.jsonl'), null);
});

const execMod = await import(path.join(REPO, 'src/codex-exec.ts'));
const { buildCodexExecArgs, lastAgentMessageFromEvents, runCodex, INNER_GUARD_ENV } = execMod;

const hookStdin = await import(path.join(REPO, 'scripts/hook-stdin.js'));
const { waitForFileStable } = hookStdin;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-slice-test-'));
}

function rolloutStream(lines) {
  return Readable.from(lines.map((l) => `${JSON.stringify(l)}\n`));
}

const meta = (extra = {}) => ({
  type: 'session_meta',
  timestamp: '2026-08-24T01:00:00Z',
  payload: { id: 'thr-1', session_id: 'sess-1', cwd: '/tmp/proj', source: 'cli', ...extra },
});

test('sessionsRoot prefers MEMEX_SESSIONS_DIR and keeps the historical fallback', () => {
  process.env.MEMORY_BANK_SESSIONS_DIR = '/legacy';
  process.env.MEMEX_SESSIONS_DIR = '/current';
  assert.equal(sessionsRoot(), '/current');
  delete process.env.MEMEX_SESSIONS_DIR;
  assert.equal(sessionsRoot(), '/legacy');
  delete process.env.MEMORY_BANK_SESSIONS_DIR;
  process.env.TEST_SESSIONS_DIR = '/b';
  assert.equal(sessionsRoot(), '/b');
  delete process.env.TEST_SESSIONS_DIR;
  process.env.CODEX_HOME = '/c';
  assert.equal(sessionsRoot(), path.join('/c', 'sessions'));
  delete process.env.CODEX_HOME;
  assert.equal(sessionsRoot(), path.join(os.homedir(), '.codex', 'sessions'));
});

test('discoverSessionFiles walks recursively and keeps only rollout-*.jsonl', () => {
  const root = tmpdir();
  const deep = path.join(root, '2026', '08', '24');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'rollout-2.jsonl'), '');
  fs.writeFileSync(path.join(root, 'rollout-1.jsonl'), '');
  fs.writeFileSync(path.join(deep, 'not-a-rollout.jsonl'), '');
  fs.writeFileSync(path.join(deep, 'rollout-no-ext.txt'), '');
  fs.mkdirSync(path.join(deep, 'nested'));
  fs.writeFileSync(path.join(deep, 'nested', 'rollout-3.jsonl'), '');
  const found = discoverSessionFiles(root).map((p) => path.relative(root, p));
  assert.deepEqual(found.sort(), ['2026/08/24/nested/rollout-3.jsonl', '2026/08/24/rollout-2.jsonl', 'rollout-1.jsonl'].sort());
});

test('turn assembly excludes reasoning/system and collects tool calls', async () => {
  const lines = [
    meta(),
    { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignore me' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello agent' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi human' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'shell', call_id: 'call-shell-1', input: JSON.stringify({ cmd: 'ls' }) } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-shell-1', output: 'a.ts' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: '{"path":"a.ts"}' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'event_msg', payload: { type: 'token_count' } },
  ];
  const { exchanges, isSubagent } = await parseRolloutStream(rolloutStream(lines), { archivePath: 'x' });
  assert.equal(isSubagent, false);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].userMessage, 'hello agent');
  assert.equal(exchanges[0].assistantMessage, 'hi human');
  assert.equal(exchanges[0].toolCalls.length, 1);
  assert.equal(exchanges[0].toolCalls[0].toolName, 'shell');
  assert.deepEqual(exchanges[0].toolCalls[0].toolInput, { cmd: 'ls' }); // input parsed
  assert.equal(exchanges[0].toolCalls[0].toolResult, 'a.ts');
  assert.equal(exchanges[1].toolCalls[0].toolName, 'read_file');
  assert.deepEqual(exchanges[1].toolCalls[0].toolInput, { path: 'a.ts' }); // arguments parsed
  const all = JSON.stringify(exchanges);
  assert.ok(!all.includes('reasoning-summary-marker'));
  assert.ok(!all.includes('<environment_context>'));
});

test('event_msg user_message is transport noise, not an alternate user-turn schema', async () => {
  const lines = [
    meta(),
    { type: 'event_msg', payload: { type: 'user_message', message: 'legacy ghost prompt' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'legacy ghost answer' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real prompt' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'real answer' }] } },
  ];
  const { exchanges } = await parseRolloutStream(rolloutStream(lines), { archivePath: 'event-msg-noise' });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].userMessage, 'real prompt');
  assert.equal(exchanges[0].assistantMessage, 'real answer');
  assert.ok(!JSON.stringify(exchanges).includes('legacy ghost'));
});

test('readRolloutMeta returns header metadata cheaply and flags subagents', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'rollout-h.jsonl');
  fs.writeFileSync(f, [
    meta({ cwd: '/Users/x/myproj', thread_source: 'subagent' }),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } },
  ].map((l) => `${JSON.stringify(l)}\n`).join(''));
  const hdr = await readRolloutMeta(f);
  assert.equal(hdr.isSubagent, true);
  assert.equal(hdr.meta.cwd, '/Users/x/myproj');
});

test('AGY-1b: tool-only turn is preserved even without assistant text', async () => {
  const lines = [
    meta(),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"pwd"}' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next topic' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ];
  const { exchanges } = await parseRolloutStream(rolloutStream(lines), { archivePath: 'y' });
  assert.equal(exchanges[0].assistantMessage, '');
  assert.equal(exchanges[0].userMessage, 'run it'); // non-empty prompt preserved verbatim
  assert.equal(exchanges[0].toolCalls.length, 1);
  assert.equal(exchanges[1].assistantMessage, 'ok');
});

test('AGY-1b fallback: truly empty user turn with tool calls gets placeholder', async () => {
  const lines = [
    meta(),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"pwd"}' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ];
  const { exchanges } = await parseRolloutStream(rolloutStream(lines), { archivePath: 'y2' });
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].userMessage, '(tool calls only)');
  assert.equal(exchanges[0].toolCalls.length, 1);
  assert.equal(exchanges[1].assistantMessage, 'ok');
});

test('AGY-2: codex internal context prefixes are filtered from user turns', async () => {
  for (const pre of ['<codex_internal_context x', '<codex_context y', '# AGENTS.md instructions z', 'The following is the Codex agent history q']) {
    const lines = [
      meta(),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: pre }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ghost reply' }] } },
    ];
    const { exchanges } = await parseRolloutStream(rolloutStream(lines));
    assert.equal(exchanges.length, 0, `prefix leaked: ${pre}`);
  }
});

test('subagent isolation via parent_thread_id and source markers', async () => {
  const a = await parseRolloutStream(rolloutStream([meta({ parent_thread_id: 'parent-9' })]));
  assert.equal(a.isSubagent, true);
  const b = await parseRolloutStream(rolloutStream([meta({ source: 'subagent' })]));
  assert.equal(b.isSubagent, true);
  const c = await parseRolloutStream(rolloutStream([meta()]));
  assert.equal(c.isSubagent, false);
  assert.equal(isSubagentMeta(null), false);
});

test('malformed lines are tolerated per-line', async () => {
  const input = Readable.from(['{broken json\n', `${JSON.stringify(meta())}\n`, '\n', 'not json at all\n', `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } })}\n`, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] } })}\n`]);
  const { exchanges } = await parseRolloutStream(input, { archivePath: 'z' });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].userMessage, 'q');
});

test('parseConversation stamps project and cwd from meta', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'rollout-t.jsonl');
  fs.writeFileSync(file, [meta(), { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] } }].map((l) => `${JSON.stringify(l)}\n`).join(''));
  const exchanges = await parseConversation(file, 'proj-name', file);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].project, 'proj-name');
  assert.equal(exchanges[0].cwd, '/tmp/proj');
  assert.equal(exchanges[0].sessionId, 'sess-1');
});

test('buildCodexExecArgs: safety flags always present; default model is gpt-5.6-luna', () => {
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMORY_BANK_CODEX_MODEL;
  const args = buildCodexExecArgs({ workdir: '/w' });
  assert.deepEqual(args.slice(0, 8), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--skip-git-repo-check', '-C']);
  const mi = args.indexOf('-m');
  assert.notEqual(mi, -1, 'DEFAULT_CODEX_MODEL must always be forwarded');
  assert.equal(args[mi + 1], 'gpt-5.6-luna');
  assert.deepEqual(args.slice(-2), ['--json', '-']);

  // Explicit option wins over the default.
  const withModel = buildCodexExecArgs({ workdir: '/w', model: ' gpt-5.7-mini ' });
  assert.equal(withModel[withModel.indexOf('-m') + 1], 'gpt-5.7-mini');

  // Current namespace wins over the historical compatibility override.
  process.env.MEMORY_BANK_CODEX_MODEL = 'legacy-model';
  process.env.MEMEX_CODEX_MODEL = 'env-model';
  const envModel = buildCodexExecArgs({ workdir: '/w' });
  assert.equal(envModel[envModel.indexOf('-m') + 1], 'env-model');
  delete process.env.MEMEX_CODEX_MODEL;
  const legacyModel = buildCodexExecArgs({ workdir: '/w' });
  assert.equal(legacyModel[legacyModel.indexOf('-m') + 1], 'legacy-model');
  delete process.env.MEMORY_BANK_CODEX_MODEL;
});

test('AGY-3: fallback parser handles item.completed agent_message shape', () => {
  const out = [
    JSON.stringify({ type: 'item.started', item: { type: 'agent_message', text: '' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'other', text: 'nope' } }),
    'garbage line',
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'older shape' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'oldest shape' }] } }),
  ].join('\n');
  assert.equal(lastAgentMessageFromEvents(out), 'oldest shape'); // last record wins across shapes
  assert.equal(lastAgentMessageFromEvents(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'only' } })), 'only');
});

test('INNER_GUARD refuses nested codex exec without spawning', async () => {
  process.env[INNER_GUARD_ENV] = '1';
  try {
    await assert.rejects(() => runCodex({ userMessage: 'x' }), /recursion guard/);
  } finally {
    delete process.env[INNER_GUARD_ENV];
  }
});

test('runCodex end-to-end against a fake codex binary (no network, no install)', async () => {
  const binDir = tmpdir();
  const bin = path.join(binDir, 'fake-codex');
  fs.writeFileSync(bin, '#!/bin/sh\n# consume stdin, emit 0.149 --json event stream; ignore -o\ncat >/dev/null\necho \'{"type":"item.completed","item":{"type":"agent_message","text":"FAKE-REPLY"}}\'\n');
  fs.chmodSync(bin, 0o755);
  const reply = await runCodex({ codexBin: bin, systemPrompt: 'sys', userMessage: 'usr', timeoutMs: 15_000 });
  assert.equal(reply, 'FAKE-REPLY');
});

test('runCodex surfaces timeout as error', async () => {
  const binDir = tmpdir();
  const bin = path.join(binDir, 'slow-codex');
  fs.writeFileSync(bin, '#!/bin/sh\nsleep 5\n');
  fs.chmodSync(bin, 0o755);
  await assert.rejects(() => runCodex({ codexBin: bin, userMessage: 'x', timeoutMs: 300 }), /timed out/);
}, { skip: process.platform === 'win32' });

test('waitForFileStable: growing file times out, quiet file stabilizes', async () => {
  const dir = tmpdir();
  const growing = path.join(dir, 'growing.jsonl');
  fs.writeFileSync(growing, 'x');
  const grower = setInterval(() => fs.appendFileSync(growing, 'more-data\n'), 80);
  try {
    const r1 = await waitForFileStable(growing, { pollMs: 40, quietMs: 150, maxWaitMs: 600 });
    assert.equal(r1, 'timeout');
  } finally {

    clearInterval(grower);
  }
  const quiet = path.join(dir, 'quiet.jsonl');
  fs.writeFileSync(quiet, 'stable-content');
  const t0 = Date.now();
  const r2 = await waitForFileStable(quiet, { pollMs: 40, quietMs: 150, maxWaitMs: 5_000 });
  assert.equal(r2, 'stable');
  assert.ok(Date.now() - t0 >= 140);
  const r3 = await waitForFileStable(path.join(dir, 'missing.jsonl'), { pollMs: 40, quietMs: 100, maxWaitMs: 300 });
  assert.equal(r3, 'missing');
});

test('inject-context no longer auto-installs: self-heal removed, fail-loud hint present', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/inject-context.js'), 'utf8');
  assert.ok(!/selfHealDeps|deps-heal/.test(src), 'self-heal remnants found');
  assert.ok(!/spawn\(\s*'npm'/.test(src), 'npm spawn still present');
  assert.ok(src.includes('npm install && npm run build'), 'manual command hint missing');
});

function makeHookFixture(name) {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'codex-rollout.js'),
    'export async function parseRolloutStream(_s,{archivePath=""}={}){return{meta:{cwd:"/p"},isSubagent:false,exchanges:archivePath.includes("EMPTY")?[]:[{id:"1"}]};}\n');
  const order = path.join(root, 'order.log');
  fs.writeFileSync(path.join(root, 'scripts', 'fact-extract-worker.js'), [
    `const fs=require('fs');`,
    `fs.appendFileSync(${JSON.stringify(order)},'extract\\n');`,
    `const tp=process.env.MB_TRANSCRIPT_PATH||'';`,
    `if(tp.includes('FAIL'))process.exit(3);`,
    `if(tp.includes('ZEROEXIT')){console.log('worker: session=x extracted=0 saved=0');console.log('ERROR: upstream refused');process.exit(0);}`,
    `console.log('worker: session='+(process.env.SESSION_ID||'')+' extracted=2 saved=2');`,
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts', 'sync-export-hook.js'),
    `require('fs').appendFileSync(${JSON.stringify(order)},'export\\n');\n`);
  const tp = path.join(tmpdir(), name);
  fs.writeFileSync(tp, 'x'); // stable transcript stand-in
  return { root, order, tp };
}

const hookEnv = (root) => ({
  ...process.env,
  MEMEX_PLUGIN_ROOT: root,
  MEMEX_HOME: path.join(root, 'memex-home'),
  MEMEX_STABILIZE_POLL_MS: '25',
  MEMEX_STABILIZE_QUIET_MS: '60',
  MEMEX_STABILIZE_MAX_WAIT_MS: '3000',
});

test('session-end hook: empty rollout skips worker (no marker, no export)', async () => {
  const fx = makeHookFixture('rollout-EMPTY-1.jsonl');
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/session-end-hook.js')], {
    input: JSON.stringify({ transcript_path: fx.tp, session_id: 's1', cwd: '/ignored' }),
    env: hookEnv(fx.root),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(fx.order), 'worker/export must not run for empty rollout');
});

test('session-end hook: export strictly after extraction evidence; failure blocks export', async () => {
  const okCase = makeHookFixture('rollout-ok-1.jsonl');
  const rOk = spawnSync(process.execPath, [path.join(REPO, 'scripts/session-end-hook.js')], {
    input: JSON.stringify({ transcript_path: okCase.tp, session_id: 's2', cwd: '/x' }),
    env: hookEnv(okCase.root),
    encoding: 'utf8',
  });
  assert.equal(rOk.status, 0);
  assert.equal(fs.readFileSync(okCase.order, 'utf8'), 'extract\nexport\n');

  const failCase = makeHookFixture('rollout-FAIL-1.jsonl');
  const rFail = spawnSync(process.execPath, [path.join(REPO, 'scripts/session-end-hook.js')], {
    input: JSON.stringify({ transcript_path: failCase.tp, session_id: 's3', cwd: '/x' }),
    env: hookEnv(failCase.root),
    encoding: 'utf8',
  });
  assert.equal(rFail.status, 0);
  assert.ok(rFail.stderr.includes('no completion marker'));
  assert.equal(fs.readFileSync(failCase.order, 'utf8'), 'extract\n');
});

test('session-end hook records exactly one SessionEnd event on the normal path', async () => {
  const fx = makeHookFixture('rollout-observation-ok.jsonl');
  const env = hookEnv(fx.root);
  const result = spawnSync(process.execPath, [path.join(REPO, 'scripts/session-end-hook.js')], {
    input: JSON.stringify({ transcript_path: fx.tp, session_id: 'observed-session', cwd: '/observed' }),
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const log = path.join(env.MEMEX_HOME, 'logs', 'hook-events.jsonl');
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.event === 'SessionEnd' && entry.session_id === 'observed-session');
  assert.equal(events.length, 1);
});

test('session-end hook: exit-0 with ERROR token blocks export despite success-shaped line', async () => {
  const fx = makeHookFixture('rollout-ZEROEXIT-1.jsonl');
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/session-end-hook.js')], {
    input: JSON.stringify({ transcript_path: fx.tp, session_id: 's4', cwd: '/x' }),
    env: hookEnv(fx.root),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes('no completion marker'));
  assert.equal(fs.readFileSync(fx.order, 'utf8'), 'extract\n');
});
