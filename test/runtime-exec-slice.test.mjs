import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const launcher = path.resolve('cli/runtime-exec.js');

test('MCP runtime uses a cache isolated from concurrent hook launches', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-runtime-exec-'));
  const bin = path.join(temp, 'bin');
  const cache = path.join(temp, 'cache');
  const npx = path.join(bin, 'npx');

  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      npx,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), cache: process.env.npm_config_cache || null }));\n',
    );
    fs.chmodSync(npx, 0o755);

    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      XDG_CACHE_HOME: cache,
      MEMEX_RUNTIME_FORCE_REMOTE: '1',
    };
    delete env.npm_config_cache;

    const result = spawnSync(process.execPath, [launcher, 'memex-mcp-server'], {
      cwd: path.dirname(launcher),
      env,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.cache, path.join(cache, 'memex', 'npm-mcp'));
    assert.deepEqual(observed.args, [
      '--yes',
      '--package=github:BongSuCHOI/memex#main',
      'memex-mcp-server',
    ]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

/**
 * Issue #40 — the npx fallback was completely silent.
 *
 * Observed at ~/.codex/plugins/cache/memex/memex/0.5.2/ on 2026-09-10: the
 * marketplace-installed plugin had dist/ but no node_modules, so every hook ran
 * the unpinned `#main` package through npx and no log line anywhere said so.
 */
test('a plugin root without node_modules names the npx fallback and its fix on stderr', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-runtime-silent-'));
  const bin = path.join(temp, 'bin');
  const cli = path.join(temp, 'cli');
  const scripts = path.join(temp, 'scripts');
  const localLauncher = path.join(cli, 'runtime-exec.js');
  const npx = path.join(bin, 'npx');
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(cli, { recursive: true });
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(launcher, localLauncher);
    fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}\n');
    // The launch target exists; only the runtime dependencies are absent.
    fs.writeFileSync(path.join(scripts, 'continuity-hook.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(npx, '#!/usr/bin/env node\nprocess.stdout.write("npx-ran");\n');
    fs.chmodSync(npx, 0o755);

    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    delete env.MEMEX_RUNTIME_FORCE_REMOTE;
    const result = spawnSync(process.execPath, [localLauncher, 'memex-hook-continuity'], {
      env,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'npx-ran');
    const warnings = result.stderr
      .trim()
      .split('\n')
      .filter((line) => line.includes('[memex] runtime deps missing'));
    assert.equal(warnings.length, 1, result.stderr);
    // macOS resolves the temp dir through /private; compare the leaf name.
    assert.ok(warnings[0].includes(`runtime deps missing at `), warnings[0]);
    assert.ok(warnings[0].includes(path.basename(temp)), warnings[0]);
    assert.ok(warnings[0].includes('falling back to npx'), warnings[0]);
    assert.match(warnings[0], /run: memex install/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a materialized plugin root stays silent', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-runtime-quiet-'));
  const cli = path.join(temp, 'cli');
  const scripts = path.join(temp, 'scripts');
  const dependency = path.join(temp, 'node_modules', 'better-sqlite3');
  const localLauncher = path.join(cli, 'runtime-exec.js');
  try {
    fs.mkdirSync(cli, { recursive: true });
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(dependency, { recursive: true });
    fs.copyFileSync(launcher, localLauncher);
    fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"name":"better-sqlite3"}\n');
    fs.writeFileSync(path.join(scripts, 'continuity-hook.js'), 'process.stdout.write("local");\n');

    const result = spawnSync(process.execPath, [localLauncher, 'memex-hook-continuity'], {
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'local');
    assert.doesNotMatch(result.stderr, /runtime deps missing/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('materialized plugin runs its pinned local hook instead of moving github main', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-runtime-local-'));
  const cli = path.join(temp, 'cli');
  const scripts = path.join(temp, 'scripts');
  const dependency = path.join(temp, 'node_modules', 'better-sqlite3');
  const localLauncher = path.join(cli, 'runtime-exec.js');
  try {
    fs.mkdirSync(cli, { recursive: true });
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(dependency, { recursive: true });
    fs.copyFileSync(launcher, localLauncher);
    fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(dependency, 'package.json'), '{"name":"better-sqlite3"}\n');
    fs.writeFileSync(
      path.join(scripts, 'continuity-hook.js'),
      'let input="";process.stdin.on("data",d=>input+=d);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({input,args:process.argv.slice(2),pkg:process.env.MEMEX_RUNTIME_PACKAGE})));\n',
    );

    const result = spawnSync(process.execPath, [localLauncher, 'memex-hook-continuity', '--probe'], {
      input: '{"hook_event_name":"Stop"}',
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      input: '{"hook_event_name":"Stop"}',
      args: ['--probe'],
      pkg: 'github:BongSuCHOI/memex#main',
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
