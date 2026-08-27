import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

function fixture(t, sourceType = 'git') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-update-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.jsonl');
  fs.mkdirSync(bin, { recursive: true });
  const fake = [
    '#!/usr/bin/env node',
    "const fs=require('node:fs');",
    "const a=process.argv.slice(2),log=process.env.CALL_LOG;",
    "fs.appendFileSync(log,JSON.stringify(a)+'\\n');",
    "if(a[0]==='plugin'&&a[1]==='list'){console.log(JSON.stringify({installed:[{name:'memex',pluginId:'memex@memex',marketplaceName:'memex',version:'0.1.0',installed:true}]}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='marketplace'&&a[2]==='list'){console.log(JSON.stringify({marketplaces:[{name:'memex',marketplaceSource:{sourceType:process.env.SOURCE_TYPE}}]}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='marketplace'&&a[2]==='upgrade'){console.log(JSON.stringify({upgraded:true}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='remove'){console.log(JSON.stringify({removed:true}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='add'){console.log(JSON.stringify({version:'0.2.0',installedPath:'/tmp/memex/0.2.0'}));process.exit(0)}",
    'process.exit(2)',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'codex'), fake, { mode: 0o755 });
  return {
    log,
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      CALL_LOG: log,
      SOURCE_TYPE: sourceType,
    },
  };
}

function run(fixture, args = []) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'update-plugin.js'), ...args], {
    cwd: ROOT,
    env: fixture.env,
    encoding: 'utf8',
  });
}

function calls(fixture) {
  return fs.readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('memex update refreshes a Git marketplace before reinstalling the plugin', (t) => {
  const f = fixture(t, 'git');
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(f), [
    ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'marketplace', 'upgrade', 'memex', '--json'],
    ['plugin', 'remove', 'memex@memex', '--json'],
    ['plugin', 'add', 'memex@memex', '--json'],
  ]);
  assert.match(result.stdout, /Restart Codex/);
});

test('memex update re-reads a local marketplace without an invalid Git upgrade', (t) => {
  const f = fixture(t, 'local');
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(f).some((args) => args[2] === 'upgrade'), false);
});

test('memex update --dry-run performs only read-only discovery', (t) => {
  const f = fixture(t, 'git');
  const result = run(f, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(f), [
    ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', 'list', '--json'],
  ]);
  assert.match(result.stdout, /No registry, cache, hook, or data changes/);
});
