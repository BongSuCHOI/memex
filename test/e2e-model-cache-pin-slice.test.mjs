/**
 * Issue #114 — the e2e gates pin the embedding model cache, and say so loudly.
 *
 * `scripts/e2e-model-cache-pin.mjs` is the e2e counterpart of
 * `test/model-cache-pin.mjs`: every e2e script runs against a temp `MEMEX_HOME`,
 * so without the pin each run downloads 129 MB into that temp root — a gate that
 * depends on the network (0.6.9's `package-runtime-e2e` failure).
 *
 * Nothing here downloads anything: the warm case is a directory of FAKE files
 * shaped like a cache, the cold case is an empty directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  CHECKOUT_MODEL_CACHE_DIR,
  DEFAULT_EMBEDDING_MODEL,
  inspectPinnedModelCache,
  pinModelCacheForE2E,
  resolveE2EModelCachePin,
} from '../scripts/e2e-model-cache-pin.mjs';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const PIN_MODULE = path.join(REPO, 'scripts', 'e2e-model-cache-pin.mjs');
const E2E_SCRIPTS = [
  'install-e2e.mjs',
  'marketplace-e2e.mjs',
  'package-runtime-e2e.mjs',
  'lifecycle-e2e.mjs',
  'web-ui-browser-e2e.mjs',
];

function tmpdir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A cache that passes the same check `src/model-cache.ts` applies. */
function writeWarmCache(cacheDir, model = DEFAULT_EMBEDDING_MODEL) {
  const modelDir = path.join(cacheDir, ...model.split('/'));
  fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{"model_type":"bert"}');
  fs.writeFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'), 'fake weights');
  return modelDir;
}

test('a cold cache fails fast and names `memex deps warm`', (t) => {
  const cacheDir = path.join(tmpdir(t, 'memex-e2e-pin-cold-'), 'model-cache');
  let error;
  try {
    resolveE2EModelCachePin({ env: {}, cacheDir, label: 'package-runtime-e2e' });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof Error, 'a cold cache must throw');
  assert.match(error.message, /cold/);
  assert.match(error.message, /memex deps warm/);
  assert.match(error.message, /package-runtime-e2e/);
  assert.match(error.message, /MEMEX_MODEL_CACHE_DIR/);
  // Read-only: asking must not create the directory it is asking about.
  assert.equal(fs.existsSync(cacheDir), false);
});

test('an interrupted download is reported as such, not as a warm cache', (t) => {
  const cacheDir = path.join(tmpdir(t, 'memex-e2e-pin-partial-'), 'model-cache');
  const modelDir = path.join(cacheDir, ...DEFAULT_EMBEDDING_MODEL.split('/'));
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{}');
  assert.equal(inspectPinnedModelCache(cacheDir).present, false);
  assert.throws(
    () => resolveE2EModelCachePin({ env: {}, cacheDir }),
    /interrupted download/,
  );
});

test('a warm cache pins MEMEX_MODEL_CACHE_DIR at the checkout', (t) => {
  const cacheDir = path.join(tmpdir(t, 'memex-e2e-pin-warm-'), 'model-cache');
  writeWarmCache(cacheDir);
  assert.equal(inspectPinnedModelCache(cacheDir).present, true);

  const env = {};
  const pin = pinModelCacheForE2E('install-e2e', { env, cacheDir });
  assert.deepEqual(pin, { dir: cacheDir, source: 'checkout' });
  assert.equal(env.MEMEX_MODEL_CACHE_DIR, cacheDir);
});

test('an explicit MEMEX_MODEL_CACHE_DIR from the caller always wins', (t) => {
  const tmp = tmpdir(t, 'memex-e2e-pin-explicit-');
  const caller = path.join(tmp, 'shared-cache');
  // Cold, and never inspected: the caller owns the decision.
  const env = { MEMEX_MODEL_CACHE_DIR: caller };
  const pin = pinModelCacheForE2E('lifecycle-e2e', {
    env,
    cacheDir: path.join(tmp, 'unused'),
  });
  assert.deepEqual(pin, { dir: caller, source: 'caller' });
  assert.equal(env.MEMEX_MODEL_CACHE_DIR, caller);
});

test('MEMEX_EMBEDDING_STUB=1 pins without requiring weights', (t) => {
  const cacheDir = path.join(tmpdir(t, 'memex-e2e-pin-stub-'), 'model-cache');
  const env = { MEMEX_EMBEDDING_STUB: '1' };
  const pin = pinModelCacheForE2E('marketplace-e2e', { env, cacheDir });
  assert.deepEqual(pin, { dir: cacheDir, source: 'stub' });
});

test('the pin helper exits 1 on a cold cache instead of downloading', (t) => {
  const cacheDir = path.join(tmpdir(t, 'memex-e2e-pin-exit-'), 'model-cache');
  const source = [
    `import { pinModelCacheForE2E } from ${JSON.stringify(pathToFileURL(PIN_MODULE).href)};`,
    `pinModelCacheForE2E('package-runtime-e2e', { env: {}, cacheDir: ${JSON.stringify(cacheDir)} });`,
    `console.log('UNREACHABLE');`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, MEMEX_MODEL_CACHE_DIR: '' },
    timeout: 30_000,
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /UNREACHABLE/);
  assert.match(result.stderr, /memex deps warm/);
});

test('all five e2e scripts apply the pin before their first spawn', () => {
  for (const script of E2E_SCRIPTS) {
    const text = fs.readFileSync(path.join(REPO, 'scripts', script), 'utf8');
    assert.match(
      text,
      /import \{ pinModelCacheForE2E \} from ['"]\.\/e2e-model-cache-pin\.mjs['"];/,
      `${script} does not import the pin`,
    );
    assert.match(text, /pinModelCacheForE2E\(/, `${script} does not call the pin`);
  }
});

test('the checkout cache is the same directory the .mjs suites pin', async () => {
  const expected = path.join(REPO, 'node_modules', '@xenova', 'transformers', '.cache');
  assert.equal(CHECKOUT_MODEL_CACHE_DIR, expected);
  // `test/model-cache-pin.mjs` yields to a caller-set variable, so only compare
  // when nothing outside this suite has already chosen a cache.
  if (!process.env.MEMEX_MODEL_CACHE_DIR?.trim()) {
    const { PINNED_MODEL_CACHE_DIR } = await import('./model-cache-pin.mjs');
    assert.equal(path.resolve(PINNED_MODEL_CACHE_DIR), expected);
  }
});
