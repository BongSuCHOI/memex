#!/usr/bin/env node
// Explicit isolated substitute for Codex CLI versions that do not expose
// `codex plugin validate`. It never touches the user's real Codex registry.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializePluginDependencies } from './materialize-plugin-dependencies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = fs.mkdtempSync('/tmp/memex-plugin-validate-');
const CODEX_HOME = path.join(TEMP, 'codex-home');
const MEMORY_HOME = path.join(TEMP, 'memex-home');
const MARKET = path.join(TEMP, 'marketplace');
const SOURCE = path.join(MARKET, 'plugins', 'memex');
const MARKET_NAME = 'memex-validator';
const PLUGIN_ID = `memex@${MARKET_NAME}`;
const EXPECTED_TOOLS = [
  'ask_avatar', 'cross_project_insights', 'explore_graph', 'graph_stats', 'read',
  'search', 'search_facts', 'search_ontology', 'trace_fact',
];
const ENV = { ...process.env, CODEX_HOME, MEMORY_BANK_HOME: MEMORY_HOME };
let pluginAdded = false;
let marketAdded = false;

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, { cwd: ROOT, env: ENV, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${commandName} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  }
  return result;
}

function jsonCommand(commandName, args, options = {}) {
  return JSON.parse(command(commandName, args, options).stdout);
}

function stageMarketplace() {
  for (const directory of [CODEX_HOME, MEMORY_HOME, SOURCE]) fs.mkdirSync(directory, { recursive: true });
  for (const directory of ['.codex-plugin', 'cli', 'dist', 'scripts', 'skills', 'ui']) {
    fs.cpSync(path.join(ROOT, directory), path.join(SOURCE, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, '.mcp.json'), path.join(SOURCE, '.mcp.json'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(SOURCE, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'hooks.json'), path.join(SOURCE, 'hooks.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(SOURCE, 'node_modules'), 'dir');
  const manifestDir = path.join(MARKET, '.agents', 'plugins');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'marketplace.json'), JSON.stringify({
    name: MARKET_NAME,
    plugins: [{
      name: 'memex',
      source: { source: 'local', path: './plugins/memex' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
      category: 'Engineering',
    }],
  }, null, 2) + '\n');
}

function validateManifest(installedRoot) {
  const manifestPath = path.join(installedRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const key of ['name', 'version', 'description', 'mcpServers', 'skills', 'hooks']) {
    if (!manifest[key]) throw new Error(`plugin manifest missing ${key}`);
  }
  if ('plugin_hooks' in manifest) throw new Error('plugin manifest contains unsupported plugin_hooks field');
  if (manifest.name !== 'memex') throw new Error(`unexpected plugin name: ${manifest.name}`);
  const hooksPath = path.resolve(installedRoot, manifest.hooks);
  if (!hooksPath.startsWith(installedRoot + path.sep) || !fs.existsSync(hooksPath)) {
    throw new Error(`hooks path does not resolve inside installed root: ${hooksPath}`);
  }
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SessionEnd']) {
    if (!Array.isArray(hooks?.[event]) || hooks[event].length === 0) {
      throw new Error(`hooks manifest missing ${event}`);
    }
  }
  return { name: manifest.name, version: manifest.version, hooks: Object.keys(hooks).sort() };
}

function validateMcpManifest(installedRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(installedRoot, '.mcp.json'), 'utf8'));
  const server = manifest.mcpServers?.memex;
  if (server?.command !== 'node' || !Array.isArray(server.args)
      || server.args[0] !== 'cli/runtime-exec.js' || server.args[1] !== 'memex-mcp-server'
      || server.args.length !== 2 || server.cwd !== '.') {
    throw new Error('invalid .mcp.json memex server contract');
  }
  const resolved = path.resolve(installedRoot, server.args[0]);
  if (!resolved.startsWith(installedRoot + path.sep) || !fs.existsSync(resolved)) {
    throw new Error(`MCP command does not resolve inside installed root: ${resolved}`);
  }
  return resolved;
}

function validateSkills(installedRoot) {
  const skillsRoot = path.join(installedRoot, 'skills');
  const checked = [];
  for (const name of fs.readdirSync(skillsRoot).sort()) {
    const skillPath = path.join(skillsRoot, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const source = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatter) throw new Error(`${name}/SKILL.md lacks YAML frontmatter`);
    const skillName = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (skillName !== name) throw new Error(`${name}/SKILL.md name mismatch: ${skillName}`);
    if (!description) throw new Error(`${name}/SKILL.md lacks description`);
    checked.push(name);
  }
  if (!checked.length) throw new Error('no skills found');
  return checked;
}

function mcpHandshake(installedRoot) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-validator', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'graph_stats', arguments: { scope: 'all' } } },
  ];
  const result = command(process.execPath, [path.join(installedRoot, 'cli', 'mcp-server-wrapper.js')], {
    cwd: installedRoot,
    env: {
      ...ENV,
      MEMORY_BANK_PLUGIN_ROOT: installedRoot,
      TEST_DB_PATH: path.join(MEMORY_HOME, 'conversation-index', 'db.sqlite'),
    },
    input: messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
    timeout: 20_000,
  });
  const responses = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const initialize = responses.find((response) => response.id === 1);
  const list = responses.find((response) => response.id === 2);
  const call = responses.find((response) => response.id === 3);
  if (!initialize?.result?.serverInfo) throw new Error('MCP initialize response missing serverInfo');
  const tools = (list?.result?.tools || []).map((tool) => tool.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) throw new Error(`MCP tool mismatch: ${tools.join(', ')}`);
  if (!call?.result || call.result.isError) throw new Error(`MCP graph_stats call failed: ${JSON.stringify(call)}`);
  return { tools, called: 'graph_stats' };
}

async function main() {
  stageMarketplace();
  const codexVersion = command('codex', ['--version']).stdout.trim();
  const validatorProbe = spawnSync('codex', ['plugin', 'validate', '--help'], { cwd: ROOT, env: ENV, encoding: 'utf8' });
  const validatorOutput = `${validatorProbe.stderr || ''}${validatorProbe.stdout || ''}`.trim();
  const validatorAbsent = validatorProbe.status !== 0 && /unrecognized subcommand ['"]validate['"]|unknown subcommand/i.test(validatorOutput);
  if (!validatorAbsent) throw new Error(`version-bound substitute is not allowed: validator probe was not an absent-command result\n${validatorOutput}`);

  command('codex', ['plugin', 'marketplace', 'add', MARKET, '--json']);
  marketAdded = true;
  const added = jsonCommand('codex', ['plugin', 'add', PLUGIN_ID, '--json']);
  pluginAdded = true;
  if (!added.installedPath || !path.isAbsolute(added.installedPath)) throw new Error('plugin add did not return installedPath');
  const installedRoot = fs.realpathSync(added.installedPath);
  const installed = jsonCommand('codex', ['plugin', 'list', '--json']).installed.find((plugin) => plugin.pluginId === PLUGIN_ID);
  if (!installed?.version) throw new Error('plugin list did not return installed version');
  const expectedCache = fs.realpathSync(path.join(CODEX_HOME, 'plugins', 'cache', MARKET_NAME, 'memex', installed.version));
  if (installedRoot !== expectedCache) throw new Error(`installedPath is not the Codex cache root: ${installedRoot}`);

  const packagedDependencies = materializePluginDependencies(ROOT, installedRoot);

  const pluginManifest = validateManifest(installedRoot);
  const mcpCommand = validateMcpManifest(installedRoot);
  const skills = validateSkills(installedRoot);
  for (const relative of ['ui/server.cjs', 'ui/relations/index.html', 'ui/relations/app.js']) {
    if (!fs.existsSync(path.join(installedRoot, relative))) throw new Error(`installed Web UI missing ${relative}`);
  }
  const mcp = mcpHandshake(installedRoot);

  command('codex', ['plugin', 'remove', PLUGIN_ID, '--json']);
  pluginAdded = false;
  command('codex', ['plugin', 'marketplace', 'remove', MARKET_NAME, '--json']);
  marketAdded = false;
  const pluginsAfter = jsonCommand('codex', ['plugin', 'list', '--json']).installed || [];
  const marketsAfter = jsonCommand('codex', ['plugin', 'marketplace', 'list', '--json']).marketplaces || [];
  const cleanup = {
    plugin_absent: !pluginsAfter.some((plugin) => plugin.pluginId === PLUGIN_ID),
    marketplace_absent: !marketsAfter.some((market) => market.name === MARKET_NAME),
    temp_root_absent: false,
  };
  fs.rmSync(TEMP, { recursive: true, force: true });
  cleanup.temp_root_absent = !fs.existsSync(TEMP);
  if (!Object.values(cleanup).every(Boolean)) throw new Error(`cleanup failed: ${JSON.stringify(cleanup)}`);

  const receipt = {
    kind: 'plugin-validation-receipt',
    recordedAt: new Date().toISOString(),
    environment: { codexCli: codexVersion, node: process.version, platform: `${os.platform()} ${os.arch()}` },
    verdict: 'PASS-WITH-NOTES (version-bound)',
    validator: {
      available: false,
      command: 'codex plugin validate --help',
      exitCode: validatorProbe.status,
      observed: validatorOutput.split('\n')[0],
      policy: 'Codex CLI lacks the command; the acceptance SSOT authorizes the isolated substitute contract below for this version only.',
    },
    checks: [
      { name: 'manifest schema and plugin hook discovery', status: 'PASS', observed: pluginManifest },
      { name: 'isolated marketplace add', status: 'PASS', observed: MARKET_NAME },
      { name: 'isolated plugin add installedPath', status: 'PASS', observed: installedRoot },
      { name: 'Codex cache identity', status: 'PASS', observed: expectedCache },
      { name: 'production dependency packaging', status: 'PASS', observed: { ...packagedDependencies, method: 'local copy, no npm install/network' } },
      { name: 'MCP manifest installed-root resolution', status: 'PASS', observed: mcpCommand },
      { name: 'MCP initialize and tools/list', status: 'PASS', observed: mcp.tools },
      { name: 'MCP tools/call graph_stats', status: 'PASS', observed: mcp.called },
      { name: 'skill frontmatter', status: 'PASS', observed: skills },
      { name: 'installed Web UI assets', status: 'PASS', observed: ['ui/server.cjs', 'ui/relations/index.html', 'ui/relations/app.js'] },
      { name: 'isolated registration cleanup', status: 'PASS', observed: cleanup },
    ],
    cleanup,
    conclusion: 'The formal validator command is unavailable in this exact CLI version; every pre-authorized installed-artifact substitute check passed. Re-run the formal validator when a future CLI exposes it.',
  };
  const receiptPath = path.join(ROOT, 'docs', 'verification', 'plugin-validation.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}

main().catch((error) => {
  try { if (pluginAdded) command('codex', ['plugin', 'remove', PLUGIN_ID, '--json']); } catch {}
  try { if (marketAdded) command('codex', ['plugin', 'marketplace', 'remove', MARKET_NAME, '--json']); } catch {}
  fs.rmSync(TEMP, { recursive: true, force: true });
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
