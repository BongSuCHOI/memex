/**
 * Issue #92 — where the embedding model weights live, and how they get there.
 *
 * Observed on the real data root (2026-09-10): `@xenova/transformers` caches into
 * `<node_modules/@xenova/transformers>/.cache`, a path relative to the PACKAGE, so
 * every plugin version got its own 129 MB cache and `memex update` threw the old
 * one away. The `0.6.2` and `0.6.3` roots held no cache, the fresh `0.6.4` root
 * downloaded 129 MB on first use, and its first six `inject` runs took 69,596 /
 * 74,010 / 69,792 / 68,238 / 68,647 / 67,941 ms — all download, against
 * 321-1,204 ms warm.
 *
 * Nothing here downloads or loads a model: the cache is made of FAKE files, which
 * is enough for every question these tests ask (which directory, is it present,
 * was it copied, was the source left alone).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env as transformersEnv } from '@xenova/transformers';
import {
  adoptLegacyEmbeddingCache,
  embeddingCacheDir,
  embeddingCacheSource,
  embeddingCacheStatus,
  embeddingModelCacheDir,
  ensureEmbeddingCacheDir,
  formatCacheBytes,
  inspectModelCacheDir,
  legacyEmbeddingCacheCandidates,
} from '../src/model-cache.js';
import { applyEmbeddingCacheDir, EMBEDDING_MODEL } from '../src/embeddings.js';

/** Every variable that can move the answer, so a test can never leak into the next. */
const OWNED_ENV = [
  'MEMEX_MODEL_CACHE_DIR',
  'MEMEX_HOME',
  'XDG_CONFIG_HOME',
  'MEMEX_EMBEDDING_STUB',
  'MEMEX_PLUGIN_ROOT',
  'CODEX_HOME',
] as const;

let saved: Record<string, string | undefined> = {};
const temps: string[] = [];

function tmpDir(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `memex-mc-${label}-`)));
  temps.push(dir);
  return dir;
}

/**
 * A transformers-shaped model cache of fake files.
 *
 * The real layout is `<cacheDir>/<org>/<name>/{config.json,tokenizer*.json,
 * onnx/model_quantized.onnx}` (verified against the 129 MB cache on the observed
 * root). `weights: false` reproduces an interrupted download — config present,
 * no ONNX — which must NOT count as a usable cache.
 */
function fakeModelCache(cacheDir: string, options: { weights?: boolean; model?: string } = {}): string {
  const model = options.model ?? EMBEDDING_MODEL;
  const modelDir = path.join(cacheDir, ...model.split('/'));
  fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'config.json'), '{"model_type":"bert"}');
  fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), '{"fake":"tokenizer"}');
  if (options.weights !== false) {
    fs.writeFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'), 'ONNX'.repeat(64));
  }
  return modelDir;
}

/** A plugin root whose legacy per-root cache holds the model. */
function fakeLegacyRoot(label: string, options: { weights?: boolean } = {}): { root: string; cacheDir: string } {
  const root = tmpDir(label);
  const cacheDir = path.join(root, 'node_modules', '@xenova', 'transformers', '.cache');
  fakeModelCache(cacheDir, options);
  return { root, cacheDir };
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
  for (const key of OWNED_ENV) delete process.env[key];
});

afterEach(() => {
  for (const key of OWNED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('embedding cache directory resolution', () => {
  it('follows the data root, not the plugin root', () => {
    const home = tmpDir('home');
    process.env.MEMEX_HOME = home;
    expect(embeddingCacheDir()).toBe(path.join(home, 'models'));
    expect(embeddingCacheSource()).toBe('data-root');
    // The whole defect: nothing in the path may come from node_modules.
    expect(embeddingCacheDir()).not.toContain('node_modules');
  });

  it('uses $XDG_CONFIG_HOME/memex when MEMEX_HOME is unset', () => {
    const xdg = tmpDir('xdg');
    process.env.XDG_CONFIG_HOME = xdg;
    expect(embeddingCacheDir()).toBe(path.join(xdg, 'memex', 'models'));
  });

  it('defaults to ~/.config/memex/models', () => {
    expect(embeddingCacheDir()).toBe(path.join(os.homedir(), '.config', 'memex', 'models'));
  });

  it('MEMEX_MODEL_CACHE_DIR overrides the data root and is reported as env', () => {
    const home = tmpDir('home');
    const override = tmpDir('override');
    process.env.MEMEX_HOME = home;
    process.env.MEMEX_MODEL_CACHE_DIR = override;
    expect(embeddingCacheDir()).toBe(override);
    expect(embeddingCacheSource()).toBe('env');
    expect(embeddingCacheStatus().dir).toBe(override);
  });

  it('resolves a relative override against the cwd rather than passing it through', () => {
    process.env.MEMEX_MODEL_CACHE_DIR = './relative-cache';
    expect(path.isAbsolute(embeddingCacheDir())).toBe(true);
    expect(embeddingCacheDir()).toBe(path.resolve('./relative-cache'));
  });

  it('ignores a blank override instead of caching in the filesystem root', () => {
    const home = tmpDir('home');
    process.env.MEMEX_HOME = home;
    process.env.MEMEX_MODEL_CACHE_DIR = '   ';
    expect(embeddingCacheDir()).toBe(path.join(home, 'models'));
    expect(embeddingCacheSource()).toBe('data-root');
  });

  it('lays the model out as <cacheDir>/<org>/<name>', () => {
    const cacheDir = tmpDir('layout');
    expect(embeddingModelCacheDir('Xenova/multilingual-e5-small', cacheDir))
      .toBe(path.join(cacheDir, 'Xenova', 'multilingual-e5-small'));
  });

  it('creates the directory only when asked', () => {
    const home = tmpDir('home');
    process.env.MEMEX_HOME = home;
    expect(fs.existsSync(path.join(home, 'models'))).toBe(false);
    // Reading the status must never be a write — doctor calls it.
    embeddingCacheStatus();
    expect(fs.existsSync(path.join(home, 'models'))).toBe(false);
    expect(ensureEmbeddingCacheDir()).toBe(path.join(home, 'models'));
    expect(fs.existsSync(path.join(home, 'models'))).toBe(true);
  });

  it('points @xenova/transformers at the resolved directory before any pipeline exists', () => {
    const override = tmpDir('wiring');
    process.env.MEMEX_MODEL_CACHE_DIR = override;
    expect(applyEmbeddingCacheDir()).toBe(override);
    expect(transformersEnv.cacheDir).toBe(override);
    // Remote fetching is what fills a cold cache; it must stay enabled.
    expect(transformersEnv.allowRemoteModels).toBe(true);

    const moved = tmpDir('wiring-moved');
    process.env.MEMEX_MODEL_CACHE_DIR = moved;
    applyEmbeddingCacheDir();
    expect(transformersEnv.cacheDir).toBe(moved);
  });
});

describe('embedding cache status', () => {
  it('reports an empty cache as not present', () => {
    const home = tmpDir('home');
    process.env.MEMEX_HOME = home;
    const status = embeddingCacheStatus();
    expect(status.present).toBe(false);
    expect(status.files).toBe(0);
    expect(status.bytes).toBe(0);
    expect(status.stub).toBe(false);
  });

  it('reports a populated cache with its size', () => {
    const cacheDir = tmpDir('full');
    process.env.MEMEX_MODEL_CACHE_DIR = cacheDir;
    fakeModelCache(cacheDir);
    const status = embeddingCacheStatus();
    expect(status.present).toBe(true);
    expect(status.files).toBe(3);
    expect(status.bytes).toBeGreaterThan(0);
    expect(status.modelDir).toBe(embeddingModelCacheDir(EMBEDDING_MODEL, cacheDir));
  });

  it('does not call an interrupted download present', () => {
    const cacheDir = tmpDir('partial');
    process.env.MEMEX_MODEL_CACHE_DIR = cacheDir;
    fakeModelCache(cacheDir, { weights: false });
    const status = embeddingCacheStatus();
    expect(status.present).toBe(false);
    // The files are still reported, so doctor can say "interrupted" not "absent".
    expect(status.files).toBe(2);
  });

  it('does not call a zero-byte ONNX file present', () => {
    const cacheDir = tmpDir('zero');
    process.env.MEMEX_MODEL_CACHE_DIR = cacheDir;
    const modelDir = fakeModelCache(cacheDir, { weights: false });
    fs.writeFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'), '');
    expect(embeddingCacheStatus().present).toBe(false);
  });

  it('reports stub mode for =1 but not for =fail', () => {
    const home = tmpDir('home');
    process.env.MEMEX_HOME = home;
    process.env.MEMEX_EMBEDDING_STUB = '1';
    expect(embeddingCacheStatus().stub).toBe(true);
    // `fail` means "the model is unavailable", so a caller asking whether it
    // needs to warm must get yes — and then watch the warm fail.
    process.env.MEMEX_EMBEDDING_STUB = 'fail';
    expect(embeddingCacheStatus().stub).toBe(false);
  });

  it('keys the cache on the model id, so a model override gets its own subtree', () => {
    const cacheDir = tmpDir('bymodel');
    process.env.MEMEX_MODEL_CACHE_DIR = cacheDir;
    fakeModelCache(cacheDir, { model: 'Xenova/all-MiniLM-L6-v2' });
    expect(embeddingCacheStatus('Xenova/all-MiniLM-L6-v2').present).toBe(true);
    expect(embeddingCacheStatus('Xenova/multilingual-e5-small').present).toBe(false);
  });

  it('formats sizes the way the log line and doctor detail read them', () => {
    expect(formatCacheBytes(0)).toBe('0 B');
    expect(formatCacheBytes(2048)).toBe('2 KB');
    expect(formatCacheBytes(135 * 1024 * 1024)).toBe('135 MB');
    expect(formatCacheBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

describe('legacy per-root cache adoption', () => {
  it('copies a legacy cache and never touches the source', () => {
    const stable = tmpDir('stable');
    const legacy = fakeLegacyRoot('legacy');
    process.env.MEMEX_MODEL_CACHE_DIR = stable;

    const sourceFiles = fs.readdirSync(
      path.join(legacy.cacheDir, ...EMBEDDING_MODEL.split('/')),
    ).sort();
    const sourceWeights = fs.readFileSync(
      path.join(legacy.cacheDir, ...EMBEDDING_MODEL.split('/'), 'onnx', 'model_quantized.onnx'),
    );

    const adoption = adoptLegacyEmbeddingCache({ executionRoot: legacy.root, codexHome: tmpDir('codex') });

    expect(adoption.copied).toBe(true);
    expect(adoption.kind).toBe('execution-root');
    expect(adoption.from).toBe(path.join(legacy.cacheDir, ...EMBEDDING_MODEL.split('/')));
    expect(adoption.files).toBe(3);
    expect(adoption.bytes).toBeGreaterThan(0);
    expect(embeddingCacheStatus().present).toBe(true);

    // COPY, never move: the legacy cache belongs to an installation this process
    // does not own, and it may be running right now.
    expect(fs.existsSync(legacy.cacheDir)).toBe(true);
    expect(fs.readdirSync(path.join(legacy.cacheDir, ...EMBEDDING_MODEL.split('/'))).sort())
      .toEqual(sourceFiles);
    expect(fs.readFileSync(
      path.join(legacy.cacheDir, ...EMBEDDING_MODEL.split('/'), 'onnx', 'model_quantized.onnx'),
    ).equals(sourceWeights)).toBe(true);
    // And the copy is the same bytes, so the next load is a cache hit.
    expect(fs.readFileSync(
      path.join(stable, ...EMBEDDING_MODEL.split('/'), 'onnx', 'model_quantized.onnx'),
    ).equals(sourceWeights)).toBe(true);
  });

  it('writes nothing outside the stable cache directory', () => {
    const stableParent = tmpDir('parent');
    const stable = path.join(stableParent, 'models');
    const legacy = fakeLegacyRoot('legacy');
    process.env.MEMEX_MODEL_CACHE_DIR = stable;

    adoptLegacyEmbeddingCache({ executionRoot: legacy.root, codexHome: tmpDir('codex') });

    expect(fs.readdirSync(stableParent)).toEqual(['models']);
    expect(fs.readdirSync(legacy.root).sort()).toEqual(['node_modules']);
  });

  it('is a no-op once the stable cache holds the model', () => {
    const stable = tmpDir('stable');
    const legacy = fakeLegacyRoot('legacy');
    process.env.MEMEX_MODEL_CACHE_DIR = stable;
    fakeModelCache(stable);

    const adoption = adoptLegacyEmbeddingCache({ executionRoot: legacy.root, codexHome: tmpDir('codex') });
    expect(adoption.copied).toBe(false);
    expect(adoption.reason).toBe('already-present');
    expect(adoption.from).toBe(null);
  });

  it('reports no-legacy-cache when no root has one', () => {
    const stable = tmpDir('stable');
    process.env.MEMEX_MODEL_CACHE_DIR = stable;
    const adoption = adoptLegacyEmbeddingCache({
      executionRoot: tmpDir('bare'),
      codexHome: tmpDir('codex'),
    });
    expect(adoption.copied).toBe(false);
    expect(adoption.reason).toBe('no-legacy-cache');
    expect(fs.existsSync(path.join(stable, ...EMBEDDING_MODEL.split('/')))).toBe(false);
  });

  it('refuses to adopt an incomplete legacy cache', () => {
    const stable = tmpDir('stable');
    const legacy = fakeLegacyRoot('partial', { weights: false });
    process.env.MEMEX_MODEL_CACHE_DIR = stable;

    const adoption = adoptLegacyEmbeddingCache({ executionRoot: legacy.root, codexHome: tmpDir('codex') });

    // Adopting a half-downloaded tree would make the stable cache LOOK present
    // while transformers still had to fetch the weights.
    expect(adoption.copied).toBe(false);
    expect(adoption.reason).toBe('no-legacy-cache');
    expect(embeddingCacheStatus().present).toBe(false);
  });

  it('finds other versions in the Codex plugin cache', () => {
    const stable = tmpDir('stable');
    const codexHome = tmpDir('codex');
    // `codexCacheCandidates` only counts a directory that looks installed.
    const older = path.join(codexHome, 'plugins', 'cache', 'memex', 'memex', '0.6.3');
    fs.mkdirSync(path.join(older, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(older, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(older, 'cli', 'memex.js'), '');
    fs.writeFileSync(path.join(older, '.codex-plugin', 'plugin.json'), '{"version":"0.6.3"}');
    const legacyCache = path.join(older, 'node_modules', '@xenova', 'transformers', '.cache');
    fakeModelCache(legacyCache);
    process.env.MEMEX_MODEL_CACHE_DIR = stable;

    const candidates = legacyEmbeddingCacheCandidates({ codexHome, executionRoot: tmpDir('bare') });
    expect(candidates.map((c) => c.cacheDir)).toContain(legacyCache);

    const adoption = adoptLegacyEmbeddingCache({ executionRoot: tmpDir('bare'), codexHome });
    expect(adoption.copied).toBe(true);
    expect(adoption.kind).toBe('codex-cache');
    // The other version's tree is left exactly as it was — it may be running.
    expect(inspectModelCacheDir(path.join(legacyCache, ...EMBEDDING_MODEL.split('/'))).present).toBe(true);
  });

  it('prefers the running root over an older cached version', () => {
    const stable = tmpDir('stable');
    const codexHome = tmpDir('codex');
    const older = path.join(codexHome, 'plugins', 'cache', 'memex', 'memex', '0.6.3');
    fs.mkdirSync(path.join(older, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(older, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(older, 'cli', 'memex.js'), '');
    fs.writeFileSync(path.join(older, '.codex-plugin', 'plugin.json'), '{"version":"0.6.3"}');
    fakeModelCache(path.join(older, 'node_modules', '@xenova', 'transformers', '.cache'));
    const running = fakeLegacyRoot('running');
    process.env.MEMEX_MODEL_CACHE_DIR = stable;

    const candidates = legacyEmbeddingCacheCandidates({ codexHome, executionRoot: running.root });
    expect(candidates[0].kind).toBe('execution-root');
    expect(adoptLegacyEmbeddingCache({ executionRoot: running.root, codexHome }).kind)
      .toBe('execution-root');
  });

  it('lists no candidate for a root without a cache directory', () => {
    expect(legacyEmbeddingCacheCandidates({
      codexHome: tmpDir('codex'),
      executionRoot: tmpDir('bare'),
    })).toEqual([]);
  });

  it('completes a partially adopted stable cache without rewriting what is there', () => {
    const stable = tmpDir('stable');
    const legacy = fakeLegacyRoot('legacy');
    process.env.MEMEX_MODEL_CACHE_DIR = stable;
    // A previous attempt copied the config and then died.
    const stableModelDir = path.join(stable, ...EMBEDDING_MODEL.split('/'));
    fs.mkdirSync(stableModelDir, { recursive: true });
    fs.writeFileSync(path.join(stableModelDir, 'config.json'), 'ALREADY THERE');

    const adoption = adoptLegacyEmbeddingCache({ executionRoot: legacy.root, codexHome: tmpDir('codex') });

    expect(adoption.copied).toBe(true);
    expect(embeddingCacheStatus().present).toBe(true);
    // Existing files are skipped, never truncated — a concurrent adopter may be
    // reading them.
    expect(fs.readFileSync(path.join(stableModelDir, 'config.json'), 'utf8')).toBe('ALREADY THERE');
  });
});
