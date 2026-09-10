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
const NO_WARM = args.includes('--no-warm');

/**
 * Issue #92 — how long the warm step may take.
 *
 * Generous on purpose: it is a 129 MB download over whatever connection the user
 * has, and the alternative to finishing it here is paying the same bytes inside
 * the next prompt. The bound exists only so an update cannot hang for ever on a
 * stalled connection. `MEMEX_WARM_TIMEOUT_MS` shortens it for tests.
 */
const WARM_TIMEOUT_MS = (() => {
  const override = Number(process.env.MEMEX_WARM_TIMEOUT_MS);
  return Number.isFinite(override) && override >= 100 ? override : 900_000;
})();

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: memex deps materialize [--root <path>] [--dry-run] [--force] [--no-warm] [--json]

Install the production runtime dependencies into the INSTALLED plugin root so
every Codex hook runs the pinned installation instead of falling back to
\`npx github:BongSuCHOI/memex#main\`.

Runs: npm ${NPM_ARGS.join(' ')}

Then, when the stable embedding-model cache does not hold the model, runs
\`memex deps warm\` so the first prompt after an update does not pay the 129 MB
download itself (issue #92). A failed warm is a warning, never a failure: the
dependencies are materialized either way.

Options:
  --root <path>  Materialize into this root instead of the resolved one
  --dry-run      Print the resolved root and the exact command; change nothing
  --force        Run npm even when the dependency closure is already complete
  --no-warm      Skip the embedding-model warm step
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

/**
 * Issue #92 — leave the root with a warm embedding-model cache.
 *
 * `plugin add` unpacks a new version into a new cache directory, and before 0.6.5
 * the model cache lived INSIDE that directory, so every update started cold and
 * the first prompts paid ~68s each (measured). The cache now lives in the data
 * root, which means it can be filled once, here, instead of inside a prompt.
 *
 * Run from the root that was just materialized, not from this launcher: that is
 * the copy the hooks will load, and it is the one whose `node_modules` we just
 * completed. The launcher is the fallback for a root that does not ship the
 * script (an older installation being materialized by a newer CLI).
 *
 * Never fatal. Materializing dependencies succeeded either way, and a host with
 * no network must not see `memex update` fail because a download did not finish.
 */
async function warmStep() {
  if (NO_WARM) return { ran: false, skipped: 'no-warm' };
  const warmRoot = fs.existsSync(path.join(root, 'scripts', 'warm-embedding-cache.mjs')) &&
    fs.existsSync(path.join(root, 'dist', 'model-cache.js'))
    ? root
    : LAUNCHER_ROOT;
  const script = path.join(warmRoot, 'scripts', 'warm-embedding-cache.mjs');
  if (!fs.existsSync(script)) return { ran: false, skipped: 'unavailable' };

  // Ask before downloading: the status read is pure filesystem (node builtins
  // only — see src/model-cache.ts), so an already-warm cache costs nothing and
  // a missing runtime closure cannot make this check itself fail.
  let status = null;
  try {
    const cache = await import(pathToFileURL(path.join(warmRoot, 'dist', 'model-cache.js')).href);
    status = cache.embeddingCacheStatus();
  } catch {
    /* unreadable layout: let the warm script report it */
  }
  if (status?.stub) return { ran: false, skipped: 'stub', dir: status.dir };
  if (status?.present) {
    return { ran: false, skipped: 'already-warm', dir: status.dir, bytes: status.bytes };
  }

  if (!JSON_OUT) {
    console.log(
      `Embedding model cache is empty${status ? ` (${status.dir})` : ''} — warming it now so the first ` +
      'prompt does not have to (about 129 MB; skip with --no-warm).',
    );
  }
  const warm = spawnSync(process.execPath, [script, ...(JSON_OUT ? ['--json'] : [])], {
    cwd: warmRoot,
    encoding: 'utf8',
    stdio: JSON_OUT ? 'pipe' : 'inherit',
    timeout: WARM_TIMEOUT_MS,
  });
  if (warm.error || warm.status !== 0) {
    // With --json the warm script reports its failure on STDOUT (as the `error`
    // field), and stderr carries only incidental progress, so read the structured
    // answer first rather than a tail of whatever happened to be logged.
    const reported = (() => {
      if (!JSON_OUT || !warm.stdout) return null;
      try {
        const parsed = JSON.parse(warm.stdout);
        return typeof parsed?.error === 'string' ? parsed.error : null;
      } catch {
        return null;
      }
    })();
    const detail = (reported || warm.stderr || warm.error?.message || '').trim().slice(-300);
    const message =
      `embedding model was NOT warmed${detail ? `: ${detail}` : ''} — the first prompt will be slow. ` +
      'Run: memex deps warm';
    if (!JSON_OUT) console.error(`Warning: ${message}`);
    return { ran: true, ok: false, warning: message };
  }
  return { ran: true, ok: true };
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
    console.log(`Would then warm the embedding model cache${NO_WARM ? ' — skipped (--no-warm)' : ' when it is empty'}.`);
    console.log('Dry run — nothing was changed.');
  }
  process.exit(0);
}

if (alreadyComplete && !FORCE) {
  // The warm step still runs: the dependency closure and the model cache are two
  // different kinds of "materialized", and after an update the closure is often
  // already copied while the cache is empty.
  const warm = await warmStep();
  const result = { ok: true, root, source: resolved.source, changed: false, missing: [], warm };
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

const warm = await warmStep();
const result = { ok: true, root, source: resolved.source, changed: true, missing: [], warm };
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else console.log(`Runtime dependencies materialized at ${path.join(root, 'node_modules')}.`);
