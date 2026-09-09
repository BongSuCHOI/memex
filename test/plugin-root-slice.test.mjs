/**
 * Issue #53 — the installed plugin root must not depend on WHERE the CLI runs.
 *
 * Observed in the 0.6.0 real-data verification: `~/.local/bin/memex` is
 * `npx --yes --package=github:BongSuCHOI/memex#main memex "$@"`, so the CLI
 * executed from `~/.npm/_npx/<hash>/node_modules/memex`. `memex doctor` resolved
 * "the installed plugin root" as `__dirname/..` and therefore reported
 *   FAIL dependencies: missing at <npx cache>/node_modules … run: memex install
 * while the real installation at ~/.codex/plugins/cache/memex/memex/0.6.0 was
 * complete. Running the same command from the plugin root reported OK.
 *
 * These tests pin the fix: a shim-like invocation and a plugin-root invocation
 * resolve, and report, the SAME root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const { resolveInstalledPluginRoot, missingRuntimeDependencies, readManifestVersion } =
  await import(path.join(REPO, 'dist/plugin-root.js'));

const RUNTIME_DEPS = ['better-sqlite3', '@xenova/transformers', 'sqlite-vec'];
const VERSION = '9.9.9';

/**
 * A temp $CODEX_HOME holding one materialized installation, plus a separate
 * "npx cache" copy of the same version whose dependencies are hoisted away —
 * the exact shape npm produces for `npx --package=github:...`.
 */
function fixture(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memex-plugin-root-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const codexHome = path.join(tmp, 'codex-home');
  const installed = path.join(codexHome, 'plugins', 'cache', 'memex', 'memex', VERSION);
  const npxRoot = path.join(tmp, 'npx-cache', 'node_modules', 'memex');
  for (const root of [installed, npxRoot]) {
    fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ version: VERSION, name: 'memex' }),
    );
    fs.writeFileSync(path.join(root, 'cli', 'memex.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'memex', version: VERSION }));
  }
  // Only the installed root carries the runtime closure; npm hoisted the npx
  // copy's dependencies to `<npx cache>/node_modules/*`, one level up.
  for (const dependency of RUNTIME_DEPS) {
    const dir = path.join(installed, 'node_modules', dependency);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: dependency }));
    const hoisted = path.join(npxRoot, '..', dependency);
    fs.mkdirSync(hoisted, { recursive: true });
    fs.writeFileSync(path.join(hoisted, 'package.json'), JSON.stringify({ name: dependency }));
  }
  return { tmp, codexHome, installed, npxRoot };
}

/** MEMEX_PLUGIN_ROOT must not leak in from the harness that runs the suite. */
function withoutPluginRootEnv(t) {
  const previous = process.env.MEMEX_PLUGIN_ROOT;
  delete process.env.MEMEX_PLUGIN_ROOT;
  t.after(() => {
    if (previous === undefined) delete process.env.MEMEX_PLUGIN_ROOT;
    else process.env.MEMEX_PLUGIN_ROOT = previous;
  });
}

test('the npx shim root and the plugin root resolve to the same installed root', (t) => {
  const f = fixture(t);
  withoutPluginRootEnv(t);

  const fromShim = resolveInstalledPluginRoot({
    fallbackRoot: f.npxRoot,
    codexHome: f.codexHome,
  });
  const fromPlugin = resolveInstalledPluginRoot({
    fallbackRoot: f.installed,
    codexHome: f.codexHome,
  });

  assert.equal(fromShim.root, f.installed);
  assert.equal(fromShim.root, fromPlugin.root);
  assert.equal(fromShim.source, 'codex-cache');
  assert.equal(fromShim.version, VERSION);
  // And the dependency verdict is therefore the same from both invocations.
  assert.deepEqual(missingRuntimeDependencies(fromShim.root), []);
  assert.deepEqual(missingRuntimeDependencies(fromPlugin.root), []);
  // The pre-fix answer — the npx copy itself — is the state that produced the
  // false FAIL; keep it observable so the regression stays legible.
  assert.deepEqual(missingRuntimeDependencies(f.npxRoot), RUNTIME_DEPS);
});

test('an explicit MEMEX_PLUGIN_ROOT still wins over the Codex cache', (t) => {
  const f = fixture(t);
  const previous = process.env.MEMEX_PLUGIN_ROOT;
  process.env.MEMEX_PLUGIN_ROOT = f.npxRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.MEMEX_PLUGIN_ROOT;
    else process.env.MEMEX_PLUGIN_ROOT = previous;
  });
  const resolved = resolveInstalledPluginRoot({
    fallbackRoot: f.installed,
    codexHome: f.codexHome,
  });
  assert.equal(resolved.root, f.npxRoot);
  assert.equal(resolved.source, 'env');
});

test('a host with no Codex installation falls back to the launcher root', (t) => {
  const f = fixture(t);
  withoutPluginRootEnv(t);
  const empty = path.join(f.tmp, 'no-codex-home');
  fs.mkdirSync(empty, { recursive: true });
  const resolved = resolveInstalledPluginRoot({
    fallbackRoot: f.npxRoot,
    codexHome: empty,
  });
  assert.equal(resolved.root, f.npxRoot);
  assert.equal(resolved.source, 'launcher');
  assert.equal(readManifestVersion(f.npxRoot), VERSION);
});

/**
 * The other half of the same defect: doctor judged the RUNNING process's root.
 * This suite runs from the repository checkout — which does have node_modules —
 * so the pre-fix check would report `ok … materialized at <repo>/node_modules`
 * for an installation that is in fact unusable. The verdict must belong to the
 * installed root Codex loads.
 */
test('doctor judges the installed plugin root, not the copy that is running', async (t) => {
  const f = fixture(t);
  const memexHome = path.join(f.tmp, 'memex-home');
  fs.mkdirSync(memexHome, { recursive: true });
  fs.rmSync(path.join(f.installed, 'node_modules'), { recursive: true, force: true });

  const previous = {
    plugin: process.env.MEMEX_PLUGIN_ROOT,
    codex: process.env.CODEX_HOME,
    home: process.env.MEMEX_HOME,
  };
  delete process.env.MEMEX_PLUGIN_ROOT;
  process.env.CODEX_HOME = f.codexHome;
  process.env.MEMEX_HOME = memexHome;
  t.after(() => {
    for (const [key, value] of [
      ['MEMEX_PLUGIN_ROOT', previous.plugin],
      ['CODEX_HOME', previous.codex],
      ['MEMEX_HOME', previous.home],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { doctor } = await import(path.join(REPO, 'dist/lifecycle.js'));
  const dependencies = doctor().json.find((check) => check.name === 'dependencies');
  assert.equal(dependencies.status, 'fail');
  assert.ok(dependencies.detail.includes(f.installed), dependencies.detail);
  assert.ok(!dependencies.detail.includes(path.join(REPO, 'node_modules')), dependencies.detail);
  // The advice must name a command that can actually be run against that root.
  assert.match(dependencies.detail, /memex deps materialize --root/);
  assert.match(dependencies.detail, /run: memex install/);
});

test('memex deps materialize --dry-run names the resolved root and changes nothing', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.installed, 'node_modules'), { recursive: true, force: true });
  const env = { ...process.env, CODEX_HOME: f.codexHome };
  delete env.MEMEX_PLUGIN_ROOT;
  const result = spawnSync(
    process.execPath,
    [path.join(REPO, 'cli', 'memex.js'), 'deps', 'materialize', '--dry-run', '--json'],
    { env, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.root, f.installed);
  assert.equal(plan.command, 'npm install --omit=dev --no-audit --no-fund');
  assert.deepEqual(plan.missing, RUNTIME_DEPS);
  assert.equal(fs.existsSync(path.join(f.installed, 'node_modules')), false);
});
