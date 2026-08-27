#!/usr/bin/env node
import { spawn } from 'node:child_process';

const RUNTIME_PACKAGE = 'github:BongSuCHOI/memex#main';
const ALLOWED_BINARIES = new Set([
  'memex',
  'memex-mcp-server',
  'memex-ui',
  'memex-hook-version-drift',
  'memex-hook-sync-import',
  'memex-hook-maintenance',
  'memex-hook-inject',
  'memex-hook-session-end',
]);

const [binary, ...args] = process.argv.slice(2);
if (!ALLOWED_BINARIES.has(binary)) {
  console.error(`Usage: runtime-exec.js <${[...ALLOWED_BINARIES].join('|')}> [args...]`);
  process.exit(2);
}

const child = spawn('npx', ['--yes', `--package=${RUNTIME_PACKAGE}`, binary, ...args], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, MEMEX_RUNTIME_PACKAGE: RUNTIME_PACKAGE },
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
