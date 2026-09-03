#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_PACKAGE = 'github:BongSuCHOI/memex#main';
const ALLOWED_BINARIES = new Set([
  'memex',
  'memex-mcp-server',
  'memex-ui',
  'memex-hook-version-drift',
  'memex-hook-sync-import',
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
const localReady = process.env.MEMEX_RUNTIME_FORCE_REMOTE !== '1'
  && fs.existsSync(path.join(ROOT, 'node_modules', 'better-sqlite3', 'package.json'))
  && localTarget !== null
  && fs.existsSync(localTarget);
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
