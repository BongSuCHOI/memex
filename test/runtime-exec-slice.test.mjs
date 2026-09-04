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
