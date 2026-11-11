import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { materializePluginDependencies, sanitizePluginDependencies } from '../scripts/materialize-plugin-dependencies.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const PACKAGES = ['@modelcontextprotocol/sdk', '@xenova/transformers', 'better-sqlite3', 'marked', 'sqlite-vec', 'zod'];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'plugin');
  const modules = path.join(plugin, 'node_modules');
  for (const pkg of PACKAGES) {
    fs.mkdirSync(path.join(modules, pkg), { recursive: true });
    fs.writeFileSync(path.join(modules, pkg, 'package.json'), JSON.stringify({ name: pkg }));
  }
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"name":"memex"}');
  fs.writeFileSync(path.join(modules, 'marked', 'cli.js'), 'original target');
  const link = (relative, target = '../marked/cli.js') => {
    const dest = path.join(modules, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(target, dest);
    return dest;
  };
  return { root, plugin, modules, link };
}

test('removes top-level, nested and dangling npm bin links without touching targets or regular launchers', (t) => {
  const f = fixture(t);
  const links = [f.link('.bin/marked'), f.link('marked/node_modules/.bin/nested'), f.link('.bin/dangling', '../missing')];
  const regular = path.join(f.modules, '.bin/regular');
  fs.writeFileSync(regular, '#!/bin/sh\nexit 0\n');
  assert.equal(sanitizePluginDependencies(f.modules), 3);
  for (const link of links) assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
  assert.equal(fs.readFileSync(path.join(f.modules, 'marked/cli.js'), 'utf8'), 'original target');
  assert.equal(fs.readFileSync(regular, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(sanitizePluginDependencies(f.modules), 0);
});

test('refuses non-bin symlinks before any deletion and never follows an external tree', (t) => {
  const f = fixture(t);
  const bin = f.link('.bin/marked');
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'unchanged');
  f.link('external', outside);
  assert.throws(() => sanitizePluginDependencies(f.modules), /unsupported plugin dependency entry: .*external/);
  assert.equal(fs.lstatSync(bin).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'unchanged');
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.modules, alias);
  assert.throws(() => sanitizePluginDependencies(alias), /unsupported plugin dependency entry/);
  assert.equal(fs.lstatSync(bin).isSymbolicLink(), true);
});

test('copy materialization repairs an already-complete installation idempotently', (t) => {
  const f = fixture(t);
  f.link('.bin/marked');
  assert.deepEqual(materializePluginDependencies('/unused-source', f.plugin), { changed: true, packages: 0, removedBinLinks: 1 });
  assert.deepEqual(materializePluginDependencies('/unused-source', f.plugin), { changed: false, packages: 0, removedBinLinks: 0 });
});

function fakeNpm(f) {
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const packages = ${JSON.stringify(PACKAGES)};
if (process.argv[2] === 'ls') {
  console.log([process.cwd(), ...packages.map(p => path.join(process.cwd(), 'node_modules', p))].join('\\n'));
} else {
  const modules = path.join(process.cwd(), 'node_modules');
  for (const pkg of packages) {
    fs.mkdirSync(path.join(modules, pkg), { recursive: true });
    fs.writeFileSync(path.join(modules, pkg, 'package.json'), JSON.stringify({name: pkg}));
  }
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.symlinkSync('../marked/package.json', path.join(modules, '.bin/marked'));
}
`, { mode: 0o755 });
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

test('fresh production copy strips nested bin links without mutating source dependencies', (t) => {
  const f = fixture(t);
  const sourceLink = f.link('marked/node_modules/.bin/nested');
  const previous = process.env.PATH;
  process.env.PATH = fakeNpm(f);
  t.after(() => { process.env.PATH = previous; });
  const installed = path.join(f.root, 'installed');
  fs.mkdirSync(installed);
  assert.equal(materializePluginDependencies(f.plugin, installed).changed, true);
  assert.equal(fs.lstatSync(sourceLink).isSymbolicLink(), true);
  assert.equal(sanitizePluginDependencies(path.join(installed, 'node_modules')), 0);
  assert.equal(fs.existsSync(path.join(installed, 'node_modules/marked/node_modules/.bin/nested')), false);
});

test('npm materialization strips new links, repairs complete installs, and preserves dry-run', (t) => {
  const f = fixture(t);
  fs.rmSync(f.modules, { recursive: true });
  const env = { ...process.env, PATH: fakeNpm(f), MEMEX_PLUGIN_ROOT: f.plugin, CODEX_HOME: path.join(f.root, 'codex'), MEMEX_HOME: path.join(f.root, 'data') };
  const run = (...args) => spawnSync(process.execPath, [path.join(REPO, 'scripts/materialize-deps.mjs'), '--no-warm', '--json', ...args], { env, encoding: 'utf8' });
  const fresh = run();
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).removedBinLinks, 1);
  const link = f.link('.bin/marked');
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  const repaired = run();
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).changed, true);
  assert.equal(JSON.parse(repaired.stdout).removedBinLinks, 1);
  assert.equal(JSON.parse(run().stdout).changed, false);
});
