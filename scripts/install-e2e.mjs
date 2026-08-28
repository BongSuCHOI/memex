#!/usr/bin/env node
// Executes the explicit installer against a real, isolated Codex registry.
// The user's Codex and Memex roots are read only for isolation checks.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = fs.mkdtempSync('/tmp/memex-install-e2e-');
const CODEX_HOME = path.join(TEMP, 'codex-home');
const MEMEX_HOME = path.join(TEMP, 'memex-home');
const MARKET = path.join(TEMP, 'marketplace');
const SOURCE = path.join(MARKET, 'plugins', 'memex');
const MARKET_NAME = 'memex-installer-e2e';
const PLUGIN_ID = `memex@${MARKET_NAME}`;
const RUN_MARKER = `MEMEX-INSTALL-E2E-${crypto.randomBytes(16).toString('hex')}`;
const USER_HOOKS = path.join(os.homedir(), '.codex', 'hooks.json');
const USER_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const USER_DATA_ROOT = path.join(os.homedir(), '.config', 'memex');
const sha256 = (file) => fs.existsSync(file)
  ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  : 'ABSENT';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim().slice(-1000);
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${detail}`);
  }
  return result;
}

function json(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function treeContains(root, needle) {
  if (!fs.existsSync(root)) return false;
  const target = Buffer.from(needle);
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return fs.readlinkSync(current).includes(needle);
    if (stat.isFile()) return fs.readFileSync(current).includes(target);
    if (!stat.isDirectory()) return false;
    return fs.readdirSync(current).some((name) => visit(path.join(current, name)));
  };
  return visit(root);
}

function stageMarketplace() {
  for (const directory of ['.codex-plugin', 'cli', 'dist', 'scripts', 'skills', 'ui']) {
    fs.cpSync(path.join(REPO, directory), path.join(SOURCE, directory), { recursive: true });
  }
  for (const file of ['.mcp.json', 'hooks.json', 'package.json']) {
    fs.copyFileSync(path.join(REPO, file), path.join(SOURCE, file));
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(SOURCE, 'node_modules'), 'dir');
  const manifestDirectory = path.join(MARKET, '.agents', 'plugins');
  fs.mkdirSync(manifestDirectory, { recursive: true });
  fs.writeFileSync(path.join(manifestDirectory, 'marketplace.json'), JSON.stringify({
    name: MARKET_NAME,
    plugins: [{
      name: 'memex',
      source: { source: 'local', path: './plugins/memex' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Engineering',
    }],
  }, null, 2) + '\n');
}

function normalizeRegistry(commandArgs, environment = process.env) {
  return JSON.stringify(json('codex', commandArgs, { env: environment }));
}

const userBefore = {
  hooks: sha256(USER_HOOKS),
  config: sha256(USER_CONFIG),
  plugins: normalizeRegistry(['plugin', 'list', '--json']),
  marketplaces: normalizeRegistry(['plugin', 'marketplace', 'list', '--json']),
};
const environment = { ...process.env, CODEX_HOME, MEMEX_HOME };
const installerArgs = [
  path.join(REPO, 'scripts', 'install-memex.mjs'),
  '--marketplace', MARKET,
  '--plugin-root', REPO,
];
let installedRoot = null;
let receipt = null;

try {
  fs.mkdirSync(path.join(CODEX_HOME, 'sessions', '2026', '08', '26'), { recursive: true });
  stageMarketplace();
  const rollout = path.join(CODEX_HOME, 'sessions', '2026', '08', '26', 'rollout-install-e2e.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-08-26T00:00:00Z', payload: {
      id: '01a039aa-2222-4333-8444-a55556666777',
      session_id: '01a039aa-2222-4333-8444-a55556666777',
      cwd: path.join(TEMP, RUN_MARKER), source: 'cli', originator: 'codex-tui',
    } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: `Installer isolation marker ${RUN_MARKER}` },
    ] } }),
  ].join('\n') + '\n');

  const dry = run(process.execPath, [...installerArgs, '--dry-run'], { cwd: REPO, env: environment, timeout: 120_000 });
  const dryState = {
    hooks_absent: !fs.existsSync(path.join(CODEX_HOME, 'hooks.json')),
    data_absent: !fs.existsSync(MEMEX_HOME),
    plugin_absent: json('codex', ['plugin', 'list', '--json'], { env: environment }).installed.length === 0,
    marketplace_absent: json('codex', ['plugin', 'marketplace', 'list', '--json'], { env: environment }).marketplaces.length === 0,
    completion_observed: dry.stdout.includes('Install dry-run complete — nothing was changed.'),
  };
  if (!Object.values(dryState).every(Boolean)) throw new Error(`dry-run mutation: ${JSON.stringify(dryState)}`);

  const real = run(process.execPath, installerArgs, { cwd: REPO, env: environment, timeout: 30 * 60 * 1000 });
  const match = real.stdout.match(/Install complete\. Authoritative plugin root: (.+)/);
  if (!match) throw new Error(`installer did not report installed root: ${real.stdout.slice(-500)}`);
  installedRoot = fs.realpathSync(match[1].trim());
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  const expectedRoot = fs.realpathSync(path.join(CODEX_HOME, 'plugins', 'cache', MARKET_NAME, 'memex', version));
  if (installedRoot !== expectedRoot) throw new Error(`non-cache installed root: ${installedRoot}`);
  const hooksFile = path.join(CODEX_HOME, 'hooks.json');
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installedRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const installedHooks = JSON.parse(fs.readFileSync(path.join(installedRoot, 'hooks.json'), 'utf8'));
  const realState = {
    installed_cache_authoritative: installedRoot === expectedRoot,
    plugin_manifest_declares_hooks: installedManifest.hooks === './hooks.json',
    plugin_hooks_complete: ['SessionStart', 'UserPromptSubmit', 'SessionEnd']
      .every((event) => Array.isArray(installedHooks.hooks?.[event]) && installedHooks.hooks[event].length > 0),
    fallback_hooks_absent: !fs.existsSync(hooksFile),
    mcp_nine_tools: /MCP handshake.*9 tools/.test(real.stdout),
    doctor_passed: /doctor gate.*critical checks ok/.test(real.stdout),
    first_sync_completed: /foreground first sync.*sync complete/.test(real.stdout),
    indexed_marker_in_temp_data: treeContains(MEMEX_HOME, RUN_MARKER),
  };
  if (!Object.values(realState).every(Boolean)) throw new Error(`real install assertion failed: ${JSON.stringify(realState)}`);

  const registryBeforeSecond = {
    plugins: normalizeRegistry(['plugin', 'list', '--json'], environment),
    marketplaces: normalizeRegistry(['plugin', 'marketplace', 'list', '--json'], environment),
  };
  const second = run(process.execPath, installerArgs, { cwd: REPO, env: environment, timeout: 30 * 60 * 1000 });
  const secondMatch = second.stdout.match(/Install complete\. Authoritative plugin root: (.+)/);
  const idempotentState = {
    same_installed_root: secondMatch && fs.realpathSync(secondMatch[1].trim()) === installedRoot,
    fallback_hooks_still_absent: !fs.existsSync(hooksFile),
    plugin_registry_identical: normalizeRegistry(['plugin', 'list', '--json'], environment) === registryBeforeSecond.plugins,
    marketplace_registry_identical: normalizeRegistry(['plugin', 'marketplace', 'list', '--json'], environment) === registryBeforeSecond.marketplaces,
    dependency_tree_reused: second.stdout.includes('installed cache dependency tree already complete'),
  };
  if (!Object.values(idempotentState).every(Boolean)) throw new Error(`idempotency failed: ${JSON.stringify(idempotentState)}`);

  run(process.execPath, [path.join(installedRoot, 'cli', 'memex.js'), 'remove-hooks'], {
    env: { ...environment, MEMEX_PLUGIN_ROOT: installedRoot },
  });
  run('codex', ['plugin', 'remove', PLUGIN_ID, '--json'], { env: environment });
  run('codex', ['plugin', 'marketplace', 'remove', MARKET_NAME, '--json'], { env: environment });
  fs.rmSync(MEMEX_HOME, { recursive: true, force: true });
  fs.rmSync(MARKET, { recursive: true, force: true });
  const cleanupState = {
    owned_hooks_absent: !fs.existsSync(hooksFile)
      || !fs.readFileSync(hooksFile, 'utf8').includes('_memex'),
    plugin_absent: json('codex', ['plugin', 'list', '--json'], { env: environment }).installed.length === 0,
    marketplace_absent: json('codex', ['plugin', 'marketplace', 'list', '--json'], { env: environment }).marketplaces.length === 0,
    data_absent: !fs.existsSync(MEMEX_HOME),
    source_checkout_preserved: fs.existsSync(path.join(REPO, 'package.json')),
  };
  if (!Object.values(cleanupState).every(Boolean)) throw new Error(`cleanup failed: ${JSON.stringify(cleanupState)}`);

  fs.rmSync(TEMP, { recursive: true, force: true });
  const userAfter = {
    hooks: sha256(USER_HOOKS),
    config: sha256(USER_CONFIG),
    plugins: normalizeRegistry(['plugin', 'list', '--json']),
    marketplaces: normalizeRegistry(['plugin', 'marketplace', 'list', '--json']),
  };
  const isolationState = {
    temp_root_absent: !fs.existsSync(TEMP),
    stable_user_surfaces_unchanged: JSON.stringify(userAfter) === JSON.stringify(userBefore),
    test_marker_absent_from_user_data: !treeContains(USER_DATA_ROOT, RUN_MARKER),
  };
  if (!Object.values(isolationState).every(Boolean)) throw new Error(`user isolation failed: ${JSON.stringify(isolationState)}`);

  receipt = {
    kind: 'memex-installer-e2e',
    recordedAt: new Date().toISOString(),
    environment: { codexCli: run('codex', ['--version']).stdout.trim(), node: process.version, platform: `${process.platform} ${process.arch}` },
    verdict: 'PASS',
    commands: {
      dryRun: 'node scripts/install-memex.mjs --dry-run --marketplace <isolated-marketplace> --plugin-root <repo>',
      real: 'node scripts/install-memex.mjs --marketplace <isolated-marketplace> --plugin-root <repo>',
      idempotentRerun: 'same real command, second invocation',
      rollbackRegression: 'node --test test/install-script-slice.test.mjs',
    },
    checks: { dryRun: dryState, realInstall: realState, idempotentRerun: idempotentState, removal: cleanupState, isolation: isolationState },
    installedRootContract: '$CODEX_HOME/plugins/cache/<marketplace>/memex/<version>',
    dependencyContract: 'copies the already-installed production closure into the Codex cache; no npm install or network',
  };
  console.log(`__INSTALL_RECEIPT__${JSON.stringify(receipt)}`);
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  if (fs.existsSync(TEMP)) {
    try {
      if (installedRoot && fs.existsSync(path.join(CODEX_HOME, 'hooks.json'))) {
        spawnSync(process.execPath, [path.join(installedRoot, 'cli', 'memex.js'), 'remove-hooks'], {
          env: { ...environment, MEMEX_PLUGIN_ROOT: installedRoot }, encoding: 'utf8',
        });
      }
      spawnSync('codex', ['plugin', 'remove', PLUGIN_ID, '--json'], { env: environment, encoding: 'utf8' });
      spawnSync('codex', ['plugin', 'marketplace', 'remove', MARKET_NAME, '--json'], { env: environment, encoding: 'utf8' });
    } finally {
      fs.rmSync(TEMP, { recursive: true, force: true });
    }
  }
}
