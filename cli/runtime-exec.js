#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RUNTIME_PACKAGE = 'github:BongSuCHOI/memex#main';
const ALLOWED_BINARIES = new Set([
  'memex',
  'memex-mcp-server',
  'memex-ui',
  'memex-hook-version-drift',
  'memex-hook-sync-import',
  'memex-hook-sync-export',
  'memex-hook-maintenance',
  'memex-hook-inject',
  'memex-hook-continuity',
  'memex-continuity-worker',
  'memex-hook-session-end',
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_BINARIES = new Map([
  ['memex', 'cli/memex.js'],
  ['memex-mcp-server', 'cli/mcp-server'],
  ['memex-ui', 'ui/server.cjs'],
  ['memex-hook-version-drift', 'scripts/version-drift-check.js'],
  ['memex-hook-sync-import', 'scripts/sync-import-hook.js'],
  ['memex-hook-sync-export', 'scripts/sync-export-hook.js'],
  ['memex-hook-maintenance', 'scripts/session-start-maintenance.js'],
  ['memex-hook-inject', 'scripts/inject-context.js'],
  ['memex-hook-continuity', 'scripts/continuity-hook.js'],
  ['memex-continuity-worker', 'scripts/continuity-worker.js'],
  ['memex-hook-session-end', 'scripts/continuity-hook.js'],
]);

const [binary, ...args] = process.argv.slice(2);
if (!ALLOWED_BINARIES.has(binary)) {
  console.error(`Usage: runtime-exec.js <${[...ALLOWED_BINARIES].join('|')}> [args...]`);
  process.exit(2);
}

const childEnv = { ...process.env, MEMEX_RUNTIME_PACKAGE: RUNTIME_PACKAGE };
if (binary === 'memex-mcp-server') {
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  childEnv.npm_config_cache = path.join(cacheRoot, 'memex', 'npm-mcp');
}

// A normal Memex install materializes production dependencies beside this
// launcher. Prefer that version-pinned artifact: running github#main here would
// let an installed plugin silently execute a different revision and would add
// network/package-manager latency to every foreground hook. Keep the npx path
// only as a compatibility fallback for raw plugin registrations that have not
// completed `memex install` yet.
const localRelative = LOCAL_BINARIES.get(binary);
const localTarget = localRelative ? path.join(ROOT, localRelative) : null;
const forcedRemote = process.env.MEMEX_RUNTIME_FORCE_REMOTE === '1';
const runtimeDepsReady = fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'));
const localReady = !forcedRemote
  && runtimeDepsReady
  && localTarget !== null
  && fs.existsSync(localTarget);
// Issue #40: the fallback used to be completely silent. A marketplace install
// that never ran `memex install` has no node_modules, so every hook quietly ran
// `main` HEAD instead of the pinned revision and paid npx resolution on each
// foreground prompt. One stderr line names the condition and the fix. A
// deliberate MEMEX_RUNTIME_FORCE_REMOTE=1 is not a defect and stays quiet.
if (!localReady && !forcedRemote && !runtimeDepsReady) {
  // Issue #53: name the root that actually has to be materialized. When this
  // launcher IS the npx cache copy, ROOT is not the installed plugin, and
  // "run: memex install" against ROOT was advice nobody could act on. The
  // resolver is filesystem-only here (no `codex` spawn) so a foreground hook
  // never pays for a subprocess on its way to the fallback.
  let installedRoot = ROOT;
  try {
    const { resolveInstalledPluginRoot } = await import(
      pathToFileURL(path.join(ROOT, 'dist', 'plugin-root.js')).href
    );
    installedRoot = resolveInstalledPluginRoot({ fallbackRoot: ROOT }).root;
  } catch {
    // dist/ absent (raw checkout): ROOT is the only honest answer.
  }
  const target = installedRoot === ROOT ? '' : `; installed plugin root: ${installedRoot}`;
  process.stderr.write(
    `[memex] runtime deps missing at ${ROOT}${target}; falling back to npx ${RUNTIME_PACKAGE}` +
      ` — run: memex install (or: memex deps materialize --root "${installedRoot}")\n`,
  );
}
const executable = localReady && /\.(?:c?js|mjs)$/.test(localTarget)
  ? process.execPath
  : localReady
    ? localTarget
    : 'npx';
const childArgs = localReady
  ? (/\.(?:c?js|mjs)$/.test(localTarget) ? [localTarget, ...args] : args)
  : ['--yes', `--package=${RUNTIME_PACKAGE}`, binary, ...args];

const child = spawn(executable, childArgs, {
  stdio: 'inherit',
  shell: false,
  env: childEnv,
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
child.on('error', (error) => {
  console.error(`[memex] failed to launch ${binary} from ${RUNTIME_PACKAGE}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
