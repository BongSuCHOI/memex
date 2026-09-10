/**
 * Issue #92 — the user-facing surfaces of the embedding model cache.
 *
 * `memex doctor`'s `embedding-cache` check, `memex deps warm`, and the warm step
 * `memex deps materialize` (and therefore `memex update`) runs after installing
 * the dependency closure.
 *
 * Nothing here downloads a model. Every case either points the cache at a
 * directory of FAKE files, runs in `MEMEX_EMBEDDING_STUB=1` (where no model is
 * loaded at all), or asks for a model id that cannot exist — so the warm step's
 * failure path is exercised without touching the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = path.join(REPO, 'cli', 'memex.js');
const MATERIALIZE = path.join(REPO, 'scripts', 'materialize-deps.mjs');
/** The model id every default resolution uses; the cache is keyed on it. */
const MODEL = 'Xenova/multilingual-e5-small';

function isolated(t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memex-mc-slice-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const memexHome = path.join(tmp, 'memex-home');
  const codexHome = path.join(tmp, 'codex-home');
  const cacheDir = path.join(tmp, 'model-cache');
  fs.mkdirSync(memexHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  return {
    tmp,
    memexHome,
    codexHome,
    cacheDir,
    modelDir: path.join(cacheDir, ...MODEL.split('/')),
    env: {
      ...process.env,
      MEMEX_HOME: memexHome,
      CODEX_HOME: codexHome,
      MEMEX_PLUGIN_ROOT: REPO,
      // Every case decides for itself what the cache holds; nothing may fall
      // back to the developer's real `~/.config/memex/models`.
      MEMEX_MODEL_CACHE_DIR: cacheDir,
      // A stalled warm must never hold a test open for the 900s default.
      MEMEX_WARM_TIMEOUT_MS: '30000',
    },
  };
}

/** A transformers-shaped cache of fake files: `<cacheDir>/<org>/<name>/…`. */
function fakeModel(modelDir, { weights = true } = {}) {
  fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{"model_type":"bert"}');
  fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), '{"fake":"tokenizer"}');
  if (weights) fs.writeFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'), 'ONNX'.repeat(256));
}

function run(env, args, extraEnv = {}) {
  return spawnSync(process.execPath, args, { env: { ...env, ...extraEnv }, encoding: 'utf8' });
}

function embeddingCacheCheck(env, extraEnv = {}) {
  const result = run(env, [CLI, 'doctor', '--json'], extraEnv);
  const parsed = JSON.parse(result.stdout);
  const check = parsed.checks.find((entry) => entry.name === 'embedding-cache');
  assert.ok(check, `doctor must always report embedding-cache:\n${result.stdout}\n${result.stderr}`);
  return check;
}

// ---------------------------------------------------------------------------
// doctor: embedding-cache
// ---------------------------------------------------------------------------

test('doctor warns that the first prompt will be slow when the model is missing', (t) => {
  const fixture = isolated(t);
  const check = embeddingCacheCheck(fixture.env);
  assert.equal(check.status, 'warn', check.detail);
  assert.match(check.detail, /^missing —/);
  assert.match(check.detail, /first prompt will be slow/);
  assert.match(check.detail, /Run: memex deps warm/);
  assert.match(check.detail, new RegExp(fixture.cacheDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Read-only: asking must not create the directory it is reporting on.
  assert.equal(fs.existsSync(fixture.cacheDir), false);
});

test('doctor reports a cached model with its size and where it lives', (t) => {
  const fixture = isolated(t);
  fakeModel(fixture.modelDir);
  const check = embeddingCacheCheck(fixture.env);
  assert.equal(check.status, 'ok', check.detail);
  assert.match(check.detail, /^ok —/);
  assert.match(check.detail, /3 file\(s\)/);
  assert.match(check.detail, /plugin updates keep it/);
  assert.doesNotMatch(check.detail, /memex deps warm/);
});

test('doctor names an interrupted download instead of calling it absent', (t) => {
  const fixture = isolated(t);
  fakeModel(fixture.modelDir, { weights: false });
  const check = embeddingCacheCheck(fixture.env);
  assert.equal(check.status, 'warn', check.detail);
  assert.match(check.detail, /interrupted download/);
  assert.match(check.detail, /2 file\(s\)/);
});

test('doctor treats stub mode as ok — there is no model to cache', (t) => {
  const fixture = isolated(t);
  const check = embeddingCacheCheck(fixture.env, { MEMEX_EMBEDDING_STUB: '1' });
  assert.equal(check.status, 'ok', check.detail);
  assert.match(check.detail, /^stub —/);
  assert.doesNotMatch(check.detail, /memex deps warm/);
});

test('doctor says the cache directory came from the env override', (t) => {
  const fixture = isolated(t);
  fakeModel(fixture.modelDir);
  assert.match(embeddingCacheCheck(fixture.env).detail, /via env/);
  // Without the override the data root decides, and says so.
  const viaHome = embeddingCacheCheck(fixture.env, { MEMEX_MODEL_CACHE_DIR: '' });
  assert.match(viaHome.detail, /via data-root/);
  assert.match(viaHome.detail, new RegExp(path.join(fixture.memexHome, 'models').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ---------------------------------------------------------------------------
// memex deps warm
// ---------------------------------------------------------------------------

test('memex deps warm --help prints usage, exits 0 and writes nothing', (t) => {
  const fixture = isolated(t);
  for (const flag of ['--help', '-h']) {
    const result = run(fixture.env, [CLI, 'deps', 'warm', flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: memex deps warm \[--force\] \[--json\]/);
    // The guard must reach the SUBCOMMAND: the generic `deps` help would not
    // mention the warm flags, and running the script would start a download.
    assert.match(result.stdout, /--force/);
    assert.doesNotMatch(result.stdout, /Warming/);
    assert.doesNotMatch(result.stdout, /npm install/);
    assert.equal(fs.existsSync(fixture.cacheDir), false, 'help must not create the cache');
  }
});

test('memex deps materialize --help still reaches its own script', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [CLI, 'deps', 'materialize', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: memex deps materialize/);
  assert.match(result.stdout, /--no-warm/);
  assert.doesNotMatch(result.stdout, /Running: npm/);
});

test('memex deps --help documents both subcommands', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [CLI, 'deps', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /memex deps materialize/);
  assert.match(result.stdout, /memex deps warm/);
});

test('an unknown deps subcommand is refused with the usage, not run', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [CLI, 'deps', 'bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /memex deps materialize/);
  assert.match(result.stderr, /memex deps warm/);
});

test('memex deps warm is a no-op when the cache already holds the model', (t) => {
  const fixture = isolated(t);
  fakeModel(fixture.modelDir);
  const before = fs.readdirSync(path.join(fixture.modelDir, 'onnx'));
  const result = run(fixture.env, [CLI, 'deps', 'warm', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.warmed, false);
  assert.equal(parsed.skipped, 'already-warm');
  assert.equal(parsed.dir, fixture.cacheDir);
  assert.deepEqual(fs.readdirSync(path.join(fixture.modelDir, 'onnx')), before);
});

test('memex deps warm skips stub mode instead of downloading', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [CLI, 'deps', 'warm', '--json'], { MEMEX_EMBEDDING_STUB: '1' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.skipped, 'stub');
  assert.equal(parsed.warmed, false);
  assert.equal(fs.existsSync(fixture.cacheDir), false);
});

test('memex deps warm reports a model it cannot load as a failure', (t) => {
  const fixture = isolated(t);
  // `=fail` is the harness seam for "the model is unavailable"; the nonexistent
  // model id keeps the legacy-cache adoption from finding anything to copy.
  const result = run(fixture.env, [CLI, 'deps', 'warm', '--json'], {
    MEMEX_EMBEDDING_STUB: 'fail',
    MEMEX_EMBEDDING_MODEL: 'Xenova/memex-no-such-model',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /"ok": false/);
  assert.match(result.stdout, /MEMEX_EMBEDDING_STUB=fail/);
});

// ---------------------------------------------------------------------------
// the warm step inside materialize (and therefore `memex update`)
// ---------------------------------------------------------------------------

test('--no-warm skips the warm step and leaves the cache alone', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [MATERIALIZE, '--no-warm', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.warm, { ran: false, skipped: 'no-warm' });
  assert.equal(fs.existsSync(fixture.cacheDir), false, 'the cache must not be created');
});

test('the warm step runs even when the dependency closure is already complete', (t) => {
  const fixture = isolated(t);
  // The two kinds of "materialized" are independent: after an update the closure
  // is often already copied while the model cache is empty.
  fakeModel(fixture.modelDir);
  const result = run(fixture.env, [MATERIALIZE, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.changed, false, 'this fixture must not trigger an npm install');
  assert.equal(parsed.warm.skipped, 'already-warm');
  assert.equal(parsed.warm.dir, fixture.cacheDir);
});

test('a failed warm is a warning, not a failed materialize', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [MATERIALIZE, '--json'], {
    MEMEX_EMBEDDING_STUB: 'fail',
    MEMEX_EMBEDDING_MODEL: 'Xenova/memex-no-such-model',
  });
  // The dependencies are materialized either way; a host with no network must
  // not see `memex update` fail because a download did not finish.
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.warm.ran, true);
  assert.equal(parsed.warm.ok, false);
  assert.match(parsed.warm.warning, /first prompt will be slow/);
  assert.match(parsed.warm.warning, /memex deps warm/);
});

test('--dry-run changes nothing and says the warm step would run', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [MATERIALIZE, '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would then warm the embedding model cache when it is empty/);
  assert.match(result.stdout, /Dry run — nothing was changed\./);
  assert.equal(fs.existsSync(fixture.cacheDir), false);

  const skipped = run(fixture.env, [MATERIALIZE, '--dry-run', '--no-warm']);
  assert.match(skipped.stdout, /skipped \(--no-warm\)/);
});

test('memex update --help documents --no-warm', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, [CLI, 'update', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--no-warm/);
  // The #36 guard still holds: help may not do the work.
  assert.doesNotMatch(result.stdout, /Updated:/);
});
