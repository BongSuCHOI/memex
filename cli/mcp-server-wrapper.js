#!/usr/bin/env node
/**
 * MCP server launcher for the memory-bank Codex plugin.
 *
 * Deliberately dependency-free of side effects: this wrapper NEVER installs
 * anything. If the runtime prerequisites are missing it fails loudly with the
 * exact manual commands, so installs only ever happen with explicit user
 * intent.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PLUGIN_ROOT = process.env.MEMORY_BANK_PLUGIN_ROOT || join(__dirname, '..');
const NODE_MODULES = join(PLUGIN_ROOT, 'node_modules');
const MCP_SERVER = join(PLUGIN_ROOT, 'dist', 'mcp-server.js');

function fail(message) {
  console.error(`[memory-bank] ERROR: ${message}`);
  process.exit(1);
}

if (!existsSync(NODE_MODULES)) {
  fail(
    `dependencies are not installed (${NODE_MODULES} missing).\n` +
      `Run manually:\n` +
      `  cd "${PLUGIN_ROOT}" && npm install`,
  );
}

if (!existsSync(MCP_SERVER)) {
  fail(
    `MCP server bundle not found at ${MCP_SERVER}\n` +
      `Run manually:\n` +
      `  cd "${PLUGIN_ROOT}" && npm install && npm run build`,
  );
}

const child = spawn(process.execPath, [MCP_SERVER], {
  cwd: PLUGIN_ROOT,
  stdio: 'inherit',
  shell: false,
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code || 0);
  }
});

child.on('error', (err) => {
  console.error(`[memory-bank] ERROR: failed to start MCP server: ${err.message}`);
  process.exit(1);
});
