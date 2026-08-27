import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(REPO, 'scripts', 'setup-memex.js');

function fixture(t, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-setup-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const state = path.join(root, 'state');
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(state, enabled ? 'true' : 'false');
  const fake = `#!/usr/bin/env node
const fs=require('fs');const state=process.env.MEMEX_TEST_MEMORY_STATE;const log=process.env.MEMEX_TEST_CODEX_LOG;
fs.appendFileSync(log,JSON.stringify(process.argv.slice(2))+'\\n');
const a=process.argv.slice(2);
if(a.join(' ')==='features list'){const on=fs.readFileSync(state,'utf8').trim();console.log('memories stable '+on);process.exit(0)}
if(a.join(' ')==='features disable memories'){fs.writeFileSync(state,'false');console.log('Feature memories disabled in config.toml.');process.exit(0)}
process.exit(2);
`;
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, fake, { mode: 0o755 });
  return {
    state, log,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MEMEX_TEST_MEMORY_STATE: state, MEMEX_TEST_CODEX_LOG: log },
  };
}

test('setup detects enabled built-in Memory but never disables it without approval', (t) => {
  const f = fixture(t, true);
  const r = spawnSync(process.execPath, [SETUP], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Codex built-in Memory is enabled/);
  assert.match(r.stdout, /--disable-codex-memory/);
  assert.equal(fs.readFileSync(f.state, 'utf8'), 'true');
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [['features', 'list']]);
});

test('explicit setup approval disables built-in Memory and verifies the result', (t) => {
  const f = fixture(t, true);
  const out = execFileSync(process.execPath, [SETUP, '--disable-codex-memory'], { env: f.env, encoding: 'utf8' });
  assert.match(out, /disabled and verified/);
  assert.equal(fs.readFileSync(f.state, 'utf8'), 'false');
  const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls, [
    ['features', 'list'],
    ['features', 'disable', 'memories'],
    ['features', 'list'],
  ]);
});

test('setup reports an already-disabled feature as an idempotent no-op', (t) => {
  const f = fixture(t, false);
  const out = execFileSync(process.execPath, [SETUP], { env: f.env, encoding: 'utf8' });
  assert.match(out, /already disabled/);
  assert.equal(fs.readFileSync(f.state, 'utf8'), 'false');
});

test('setup --help is available without invoking Codex', (t) => {
  const f = fixture(t, true);
  const out = execFileSync(process.execPath, [SETUP, '--help'], { env: f.env, encoding: 'utf8' });
  assert.match(out, /Usage: memex setup/);
  assert.equal(fs.existsSync(f.log), false);
});
