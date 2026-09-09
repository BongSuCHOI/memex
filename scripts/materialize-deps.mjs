#!/usr/bin/env node
/**
 * Issue #53 — `memex deps materialize`.
 *
 * `memex doctor` told users to "run: memex install" when the installed plugin
 * had no `node_modules`, but `memex install` treated dependencies as a
 * PRECONDITION and refused with "node_modules missing — run manually: cd <root>
 * && npm install". The advice was unexecutable, and the root it named was the
 * npx cache copy rather than the plugin Codex loads. This command is the
 * missing executable step: it resolves the installed plugin root exactly the
 * way doctor does and runs the production install there.
 *
 * Scope: `npm install --omit=dev --no-audit --no-fund` inside the resolved
 * root. Nothing else is touched — no marketplace, plugin registry, hook file,
 * or Memex data root.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_ROOT = path.resolve(HERE, '..');
const NPM_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund'];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const JSON_OUT = args.includes('--json');
const FORCE = args.includes('--force');

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: memex deps materialize [--root <path>] [--dry-run] [--force] [--json]

Install the production runtime dependencies into the INSTALLED plugin root so
every Codex hook runs the pinned installation instead of falling back to
\`npx github:BongSuCHOI/memex#main\`.

Runs: npm ${NPM_ARGS.join(' ')}

Options:
  --root <path>  Materialize into this root instead of the resolved one
  --dry-run      Print the resolved root and the exact command; change nothing
  --force        Run npm even when the dependency closure is already complete
  --json         Print a machine-readable result`);
  process.exit(0);
}

const { resolveInstalledPluginRoot, missingRuntimeDependencies } = await import(
  pathToFileURL(path.join(LAUNCHER_ROOT, 'dist', 'plugin-root.js')).href
);

const resolved = resolveInstalledPluginRoot({
  fallbackRoot: LAUNCHER_ROOT,
  probeCodex: true,
  explicitRoot: option('--root'),
});
const root = resolved.root;

function fail(message) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, root, error: message }, null, 2));
  else console.error(`memex deps materialize failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(root, 'package.json'))) {
  fail(`no package.json at ${root} — pass --root <installed plugin root>`);
}

const missingBefore = missingRuntimeDependencies(root);
const alreadyComplete = missingBefore.length === 0;

if (DRY) {
  const result = {
    ok: true,
    dryRun: true,
    root,
    source: resolved.source,
    version: resolved.version,
    missing: missingBefore,
    command: `npm ${NPM_ARGS.join(' ')}`,
  };
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Installed plugin root: ${root} (via ${resolved.source})`);
    console.log(`Missing runtime packages: ${missingBefore.join(', ') || 'none'}`);
    console.log(`Would run: cd "${root}" && npm ${NPM_ARGS.join(' ')}`);
    console.log('Dry run — nothing was changed.');
  }
  process.exit(0);
}

if (alreadyComplete && !FORCE) {
  const result = { ok: true, root, source: resolved.source, changed: false, missing: [] };
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else console.log(`Runtime dependencies already materialized at ${path.join(root, 'node_modules')} (${resolved.source}).`);
  process.exit(0);
}

if (!JSON_OUT) {
  console.log(`Installed plugin root: ${root} (via ${resolved.source})`);
  console.log(`Running: npm ${NPM_ARGS.join(' ')}`);
}
const install = spawnSync('npm', NPM_ARGS, {
  cwd: root,
  encoding: 'utf8',
  stdio: JSON_OUT ? 'pipe' : 'inherit',
});
if (install.error || install.status !== 0) {
  fail(
    `npm ${NPM_ARGS.join(' ')} in ${root} failed (${install.status})` +
      `: ${(install.stderr || install.error?.message || '').trim().slice(-500)}`,
  );
}

const missingAfter = missingRuntimeDependencies(root);
if (missingAfter.length > 0) {
  fail(`runtime closure still incomplete after npm install: ${missingAfter.join(', ')}`);
}

const result = { ok: true, root, source: resolved.source, changed: true, missing: [] };
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else console.log(`Runtime dependencies materialized at ${path.join(root, 'node_modules')}.`);
