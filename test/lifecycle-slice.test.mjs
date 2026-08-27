// CX-01 lifecycle contract tests: idempotent merge, foreign-entry byte
// preservation, ownership-scoped removal, dry-run, stale-path detection.
// Runs with plain `node --test` against dist/lifecycle.js (no vitest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const { setupHooks, removeHooks, doctor, desiredEntries, registrationPath } =
  await import(path.join(REPO, 'dist/lifecycle.js'));

function isolatedEnv(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-lifecycle-test-'));
  const codexHome = path.join(tmp, 'codex-home');
  const mbHome = path.join(tmp, 'mb-home');
  const pluginRoot = path.join(tmp, 'plugin-root');
  for (const d of [codexHome, mbHome, path.join(pluginRoot, 'scripts'), path.join(pluginRoot, 'cli')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // Canary handler scripts at the exact registered names.
  fs.writeFileSync(path.join(pluginRoot, 'scripts', 'version-drift-check.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(pluginRoot, 'cli', 'memex.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(pluginRoot, 'scripts', 'sync-import-hook.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(pluginRoot, 'scripts', 'session-start-maintenance.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(pluginRoot, 'scripts', 'session-end-hook.js'), '#!/usr/bin/env node\n');
  fs.copyFileSync(
    path.join(REPO, 'scripts', 'inject-context-hook.sh'),
    path.join(pluginRoot, 'scripts', 'inject-context-hook.sh'),
  );
  const env = {
    CODEX_HOME: codexHome,
    MEMORY_BANK_HOME: mbHome,
    MEMORY_BANK_PLUGIN_ROOT: pluginRoot,
  };
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  t.after(() => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return { tmp, codexHome, mbHome, pluginRoot, env };
}

const FOREIGN_HOOKS = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: '^Bash$', hooks: [{ command: 'atuin hook codex', type: 'command' }] },
    ],
    SessionStart: [
      { matcher: '', hooks: [{ command: 'foreign-canary --start', type: 'command', async: true }] },
    ],
  },
}, null, 2) + '\n';

test('setup-hooks registers all three events and is idempotent; foreign entries preserved', (t) => {
  const { codexHome } = isolatedEnv(t);
  const file = path.join(codexHome, 'hooks.json');
  fs.writeFileSync(file, FOREIGN_HOOKS);

  const r1 = setupHooks();
  assert.equal(r1.diff.add.length, 6);
  assert.equal(r1.changed, true);
  const afterFirst = fs.readFileSync(file, 'utf8');

  // Foreign entry untouched.
  assert.ok(afterFirst.includes('atuin hook codex'));
  assert.ok(afterFirst.includes('foreign-canary --start'));

  // Second run: no new entries.
  const r2 = setupHooks();
  assert.equal(r2.diff.add.length, 0);
  assert.equal(r2.changed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), afterFirst);

  // Ownership record exists with fingerprints.
  const reg = JSON.parse(fs.readFileSync(registrationPath(), 'utf8'));
  assert.equal(reg.entries.length, 6);
  assert.ok(reg.entries.every((e) => e.fingerprint && /"(.+)"/.test(e.command)));

  // Desired commands use absolute paths under the plugin root.
  for (const d of desiredEntries()) {
    const p = d.command.match(/"([^"]+)"/)[1];
    assert.ok(path.isAbsolute(p));
  }
});
test('dry-run mutates nothing', (t) => {
  const { codexHome } = isolatedEnv(t);
  const file = path.join(codexHome, 'hooks.json');
  fs.writeFileSync(file, FOREIGN_HOOKS);

  const r = setupHooks({ dryRun: true });
  assert.equal(r.diff.add.length, 6);
  assert.equal(fs.readFileSync(file, 'utf8'), FOREIGN_HOOKS);
  assert.ok(!fs.existsSync(registrationPath()));
});

test('remove-hooks removes only owned entries and keeps foreign bytes intact', (t) => {
  const { codexHome } = isolatedEnv(t);
  const file = path.join(codexHome, 'hooks.json');
  fs.writeFileSync(file, FOREIGN_HOOKS);
  setupHooks();

  const dry = removeHooks({ dryRun: true });
  assert.equal(dry.removed, 6);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart[0].hooks.length, 5); // foreign + 4 ours

  const r = removeHooks();
  assert.equal(r.removed, 6);
  assert.equal(r.preservedForeignEntries, 2); // atuin + foreign-canary
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.hooks.PreToolUse[0].hooks[0].command, 'atuin hook codex');
  assert.deepEqual(after.hooks.SessionStart[0].hooks[0].command, 'foreign-canary --start');
  assert.equal(after.hooks.SessionStart[0].hooks.length, 1);
  assert.ok(!fs.existsSync(registrationPath()));

  // Idempotent removal.
  assert.equal(removeHooks().removed, 0);
});

test('doctor distinguishes missing build vs configured lifecycle', (t) => {
  const { env } = isolatedEnv(t);
  const before = doctor();
  assert.equal(before.overall, 'FAIL'); // no dist in fake plugin root

  fs.mkdirSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, 'dist', 'db.js'), '');
  fs.mkdirSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), '{}');
  fs.mkdirSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, 'node_modules'), { recursive: true });

  setupHooks();
  const after = doctor();
  const byName = Object.fromEntries(after.json.map((c) => [c.name, c.status]));
  assert.equal(byName['lifecycle-configured'], 'ok');
  assert.equal(byName['build'], 'ok');
  assert.equal(byName['lifecycle-observed'], 'warn'); // never observed in this home
  assert.equal(after.overall, 'PARTIAL');
});

test('doctor recognizes plugin-managed hooks without mutating CODEX_HOME/hooks.json', (t) => {
  const { env } = isolatedEnv(t);
  fs.mkdirSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, 'dist', 'db.js'), '');
  fs.mkdirSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), JSON.stringify({ hooks: './hooks.json' }));
  fs.writeFileSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{}], UserPromptSubmit: [{}], SessionEnd: [{}] },
  }));
  fs.mkdirSync(path.join(env.MEMORY_BANK_PLUGIN_ROOT, 'node_modules'), { recursive: true });

  const report = doctor();
  const lifecycle = report.json.find((check) => check.name === 'lifecycle-configured');
  assert.equal(lifecycle.status, 'ok');
  assert.match(lifecycle.detail, /plugin manifest/);
  assert.ok(!fs.existsSync(path.join(env.CODEX_HOME, 'hooks.json')));
});

test('hook handlers record privacy-safe observation events', async (t) => {
  isolatedEnv(t);
  const { recordHookEvent, lastObserved, observationLogPath } =
    await import(path.join(REPO, 'dist/observe-hook-event.js'));
  recordHookEvent('SessionStart', { sessionId: 'sess-x', cwd: '/p' });
  const line = fs.readFileSync(observationLogPath(), 'utf8').trim();
  const rec = JSON.parse(line);
  assert.deepEqual(Object.keys(rec).sort(), ['cwd', 'event', 'session_id', 'ts']);
  assert.notEqual(lastObserved('SessionStart'), null);
  assert.equal(lastObserved('SessionEnd'), null);
});

test('commandFor separates script and args without path.join corruption and handles spaced roots', async () => {
  const { commandFor } = await import(path.join(REPO, 'dist/lifecycle.js'));
  const rootWithSpaces = '/Users/test user/my plugins/memory bank';
  const cmd = commandFor(rootWithSpaces, {
    script: 'scripts/worker.js',
    args: ['--flag', 'value with space'],
  });
  assert.equal(cmd, 'node "/Users/test user/my plugins/memory bank/scripts/worker.js" --flag "value with space"');

  const shCmd = commandFor(rootWithSpaces, {
    script: 'scripts/hook.sh',
    args: ['--dry-run'],
  });
  assert.equal(shCmd, 'bash "/Users/test user/my plugins/memory bank/scripts/hook.sh" --dry-run');
});
