#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-package-e2e-'));
const CODEX_HOME = path.join(TEMP, 'codex-home');
const DATA_ROOT = path.join(TEMP, 'data');
const NPM_CACHE = path.join(TEMP, 'npm-cache');
const EXPECTED_TOOLS = [
  'ask_avatar', 'cross_project_insights', 'explore_graph', 'graph_stats', 'read',
  'search', 'search_facts', 'search_ontology', 'trace_fact',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME,
      MEMORY_BANK_HOME: DATA_ROOT,
      npm_config_cache: NPM_CACHE,
    },
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim().slice(-1200);
    throw new Error(command + ' ' + args.join(' ') + ' failed (' + result.status + '): ' + detail);
  }
  return result;
}

function npmExec(packageSpec, binary, args = [], options = {}) {
  return run('npm', ['exec', '--yes', '--package=' + packageSpec, '--', binary, ...args], options);
}

try {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', TEMP]).stdout);
  const tarball = path.join(TEMP, packed[0].filename);
  if (!fs.existsSync(tarball)) throw new Error('npm pack did not create a tarball');
  const packageSpec = 'file:' + tarball;

  const initialize = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'package-runtime-e2e', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  const mcp = npmExec(packageSpec, 'memex-mcp-server', [], {
    input: initialize.map((message) => JSON.stringify(message)).join('\n') + '\n',
    timeout: 10 * 60 * 1000,
  });
  const response = mcp.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.id === 2);
  const tools = (response?.result?.tools || []).map((tool) => tool.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error('packaged MCP tool mismatch: ' + (tools.join(', ') || 'none'));
  }

  const help = npmExec(packageSpec, 'memex', ['--help']);
  if (!help.stdout.includes('setup       Detect conflicting Codex built-in Memory')
      || !help.stdout.includes('sync        Sync conversations')
      || !help.stdout.includes('backfill    Run extraction')) {
    throw new Error('packaged CLI help is incomplete');
  }
  const setup = npmExec(packageSpec, 'memex', ['setup', '--dry-run']);
  if (!/Codex built-in Memory|already disabled/.test(setup.stdout)) {
    throw new Error('packaged setup did not inspect Codex built-in Memory');
  }
  const sync = npmExec(packageSpec, 'memex', ['sync'], { timeout: 2 * 60 * 1000 });
  if (!/Sync complete|No conversations|0/.test(sync.stdout)) {
    throw new Error('packaged empty-corpus sync output was unexpected: ' + sync.stdout.slice(-500));
  }
  for (const target of ['extract', 'ontology', 'embeddings']) {
    npmExec(packageSpec, 'memex', ['backfill', target, '--foreground'], { timeout: 2 * 60 * 1000 });
  }
  const status = npmExec(packageSpec, 'memex', ['status', '--json']);
  const parsedStatus = JSON.parse(status.stdout);
  if (!parsedStatus.conversations || !parsedStatus.extraction || !parsedStatus.readiness) {
    throw new Error('packaged status omitted readiness sections');
  }

  const hook = npmExec(packageSpec, 'memex-hook-inject', [], {
    input: JSON.stringify({ prompt: 'package runtime empty corpus hook validation prompt', cwd: ROOT, session_id: 'package-e2e' }) + '\n',
    timeout: 2 * 60 * 1000,
  });
  if (hook.stdout.trim()) JSON.parse(hook.stdout.trim().split('\n')[0]);

  console.log(JSON.stringify({
    status: 'PASS',
    artifact: packed[0].filename,
    packedBytes: packed[0].size,
    unpackedBytes: packed[0].unpackedSize,
    files: packed[0].entryCount,
    mcpTools: tools.length,
    onboarding: ['setup --dry-run', 'sync', 'backfill extract', 'backfill ontology', 'backfill embeddings', 'status'],
    hook: 'UserPromptSubmit valid-or-empty',
  }, null, 2));
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}
