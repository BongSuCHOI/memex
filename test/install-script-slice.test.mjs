import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');

function fixture(t, { brokenMcp = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-install-slice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, 'codex-home');
  const memoryHome = path.join(dir, 'memory-home');
  const market = path.join(dir, 'marketplace');
  const installed = path.join(codexHome, 'plugins', 'cache', 'memex-test', 'memex', '0.1.0');
  const bin = path.join(dir, 'bin');
  const statePath = path.join(dir, 'codex-state.json');
  for (const d of [codexHome, path.join(codexHome, 'sessions'), memoryHome, path.join(market, '.agents', 'plugins'), path.join(market, 'plugins'), installed, bin]) {
    fs.mkdirSync(d, { recursive: true });
  }
  for (const name of ['.codex-plugin', 'cli', 'dist', 'scripts', 'ui']) {
    fs.cpSync(path.join(REPO, name), path.join(installed, name), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO, '.mcp.json'), path.join(installed, '.mcp.json'));
  fs.copyFileSync(path.join(REPO, 'hooks.json'), path.join(installed, 'hooks.json'));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(installed, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(installed, 'node_modules'), 'dir');
  if (brokenMcp) fs.writeFileSync(path.join(installed, 'dist', 'mcp-server.js'), 'process.exit(3);\n');
  fs.writeFileSync(path.join(market, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'memex-test',
    plugins: [{ name: 'memex', source: { source: 'local', path: './plugins/memex' } }],
  }));
  fs.symlinkSync(REPO, path.join(market, 'plugins', 'memex'), 'dir');
  fs.writeFileSync(statePath, JSON.stringify({ marketplace: false, plugin: false }));
  const fakeCodex = `#!/usr/bin/env node
const fs=require('node:fs');
const a=process.argv.slice(2), p=process.env.FAKE_CODEX_STATE;
const state=JSON.parse(fs.readFileSync(p,'utf8'));
const save=()=>fs.writeFileSync(p,JSON.stringify(state));
if(a[0]==='--version'){console.log('codex-cli 0.149.1');process.exit(0)}
if(a[0]!=='plugin'){process.exit(2)}
if(a[1]==='marketplace'&&a[2]==='list'){console.log(JSON.stringify({marketplaces:state.marketplace?[{name:'memex-test'}]:[]}));process.exit(0)}
if(a[1]==='marketplace'&&a[2]==='add'){state.marketplace=true;save();console.log(JSON.stringify({alreadyAdded:false,name:'memex-test'}));process.exit(0)}
if(a[1]==='marketplace'&&a[2]==='remove'){state.marketplace=false;save();console.log(JSON.stringify({removed:true}));process.exit(0)}
if(a[1]==='list'){
 const installed=state.plugin?[{pluginId:'memex@memex-test',name:'memex',marketplaceName:'memex-test',version:'0.1.0',installed:true,source:{source:'local',path:process.env.FAKE_SOURCE_ROOT}}]:[];
 if(a.includes('--json')) console.log(JSON.stringify({available:[],installed})); else if(state.plugin) console.log('memex@memex-test installed');
 process.exit(0)
}
if(a[1]==='add'){state.plugin=true;save();console.log(JSON.stringify({installedPath:process.env.FAKE_INSTALLED_ROOT}));process.exit(0)}
if(a[1]==='remove'){state.plugin=false;save();console.log(JSON.stringify({removed:true}));process.exit(0)}
process.exit(2);
`;
  const codexPath = path.join(bin, 'codex');
  fs.writeFileSync(codexPath, fakeCodex, { mode: 0o755 });
  return {
    dir, codexHome, memoryHome, market, installed, statePath,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: codexHome,
      MEMEX_HOME: memoryHome,
      FAKE_CODEX_STATE: statePath,
      FAKE_INSTALLED_ROOT: installed,
      FAKE_SOURCE_ROOT: path.join(market, 'plugins', 'memex'),
    },
  };
}

function runInstaller(f) {
  return spawnSync(process.execPath, [
    path.join(REPO, 'scripts', 'install-memex.mjs'),
    '--marketplace', f.market,
    '--plugin-root', REPO,
  ], { cwd: REPO, env: f.env, encoding: 'utf8', timeout: 120_000 });
}

test('installer rejects a broken installed-root MCP and rolls back registrations', (t) => {
  const f = fixture(t, { brokenMcp: true });
  const r = runInstaller(f);
  assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
  assert.deepEqual(state, { marketplace: false, plugin: false });
  const hooks = path.join(f.codexHome, 'hooks.json');
  assert.equal(fs.existsSync(hooks) && fs.readFileSync(hooks, 'utf8').includes('_memoryBank'), false);
});

test('installer uses the authoritative installed root for MCP, plugin hooks, sync and status', (t) => {
  const f = fixture(t);
  const r = runInstaller(f);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const state = JSON.parse(fs.readFileSync(f.statePath, 'utf8'));
  assert.deepEqual(state, { marketplace: true, plugin: true });
  assert.equal(fs.existsSync(path.join(f.codexHome, 'hooks.json')), false);
  assert.match(r.stdout, /plugin-managed lifecycle hooks.*SessionStart, UserPromptSubmit, SessionEnd/);
  assert.match(r.stdout, /MCP handshake.*9 tools/);

  const second = runInstaller(f);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'hooks.json')), false);
});
