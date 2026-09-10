#!/usr/bin/env node
/**
 * Issue #92 — `memex deps warm`.
 *
 * Download the embedding model into the stable cache (`<data root>/models`, see
 * src/model-cache.ts) BEFORE a prompt needs it. Without this step the first
 * prompt after an update pays the whole 129 MB itself: measured on the real data
 * root, the first six `inject` runs on a fresh plugin root took 69.6s / 74.0s /
 * 69.8s / 68.2s / 68.6s / 67.9s, against 321-1,204 ms warm.
 *
 * Scope: reads and writes the model cache directory and nothing else. No
 * marketplace, plugin registry, hook file, index DB or archive is touched. It is
 * a no-op when the cache already holds the model, and under
 * `MEMEX_EMBEDDING_STUB` (no model is ever loaded there).
 *
 * `scripts/materialize-deps.mjs` runs it as its last step, which is how
 * `memex update` leaves a root whose first prompt is fast.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const FORCE = args.includes('--force');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: memex deps warm [--force] [--json]

Download the embedding model into the stable cache so the FIRST prompt does not
have to. The cache lives in the Memex data root (\`<data root>/models\`,
\`MEMEX_MODEL_CACHE_DIR\` overrides) and therefore survives every plugin update —
before 0.6.5 it lived under the plugin root's node_modules and every update
re-downloaded 129 MB, making the first prompts take ~68s (issue #92).

Already warm is a success and does nothing. Nothing outside the cache directory
is read or written.

Options:
  --force   Load the model even when the cache already looks complete
  --json    Print a machine-readable result`);
  process.exit(0);
}

function out(result, lines) {
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else for (const line of lines) console.log(line);
}

function fail(result, message) {
  if (JSON_OUT) console.log(JSON.stringify({ ...result, ok: false, error: message }, null, 2));
  else console.error(`memex deps warm failed: ${message}`);
  process.exit(1);
}

const distUrl = (name) => pathToFileURL(path.join(ROOT, 'dist', `${name}.js`)).href;

let cache;
try {
  cache = await import(distUrl('model-cache'));
} catch (error) {
  fail({ root: ROOT }, `cannot read the model cache layout from ${path.join(ROOT, 'dist')}: ` +
    `${error instanceof Error ? error.message : String(error)} — run: cd "${ROOT}" && npm run build`);
}

const before = cache.embeddingCacheStatus();
const base = { ok: true, dir: before.dir, source: before.source, model: before.model };

if (before.stub) {
  out({ ...base, warmed: false, skipped: 'stub' }, [
    `MEMEX_EMBEDDING_STUB is set — no embedding model is loaded, so there is nothing to warm.`,
  ]);
  process.exit(0);
}

if (before.present && !FORCE) {
  out({ ...base, warmed: false, skipped: 'already-warm', bytes: before.bytes, files: before.files }, [
    `Embedding model already cached at ${before.modelDir} ` +
    `(${cache.formatCacheBytes(before.bytes)}, ${before.files} files). Nothing to do.`,
  ]);
  process.exit(0);
}

if (!JSON_OUT) {
  console.log(`Model cache: ${before.dir} (via ${before.source})`);
  console.log(`Warming ${before.model} — the first download is about 129 MB and can take a minute.`);
}

let embeddings;
try {
  embeddings = await import(distUrl('embeddings'));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(
    base,
    /Cannot find (package|module)|ERR_MODULE_NOT_FOUND/.test(message)
      ? `the runtime dependencies are missing at ${path.join(ROOT, 'node_modules')} ` +
        `(${message}) — run: memex deps materialize --root "${ROOT}"`
      : `cannot load the embedding module: ${message}`,
  );
}

// The one-time adoption of a legacy per-root cache happens here, before any
// download: on a host that updated from <=0.6.4 the weights already exist
// somewhere and copying them locally is seconds instead of a minute.
try {
  embeddings.prepareEmbeddingCache();
} catch { /* adoption is best-effort; the download below is the real answer */ }

const adopted = cache.embeddingCacheStatus();
if (adopted.present && !FORCE && !before.present) {
  if (!JSON_OUT) {
    console.log(
      `Adopted an existing cache (${cache.formatCacheBytes(adopted.bytes)}, ${adopted.files} files) ` +
      `— no download needed.`,
    );
  }
}

/**
 * Progress from the filesystem, not from the library.
 *
 * `@xenova/transformers` exposes a `progress_callback` only on the pipeline
 * constructor, which `initEmbeddings` owns; the bytes on disk answer the same
 * question ("is it moving?") without threading a callback through the module
 * every other consumer shares.
 */
const startedAt = Date.now();
const heartbeat = JSON_OUT ? null : setInterval(() => {
  const now = cache.inspectModelCacheDir(adopted.modelDir);
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`  … ${seconds}s — ${cache.formatCacheBytes(now.bytes)} cached (${now.files} files)`);
}, 5_000);
heartbeat?.unref?.();

try {
  await embeddings.initEmbeddings();
  // One real inference, so the ONNX graph allocation is paid here too and the
  // first prompt is genuinely fast rather than only download-free.
  const vector = await embeddings.generateEmbedding('memex embedding warm-up probe', 'passage');
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('the model loaded but produced no vector');
  }
} catch (error) {
  if (heartbeat) clearInterval(heartbeat);
  fail(base, error instanceof Error ? error.message : String(error));
} finally {
  if (heartbeat) clearInterval(heartbeat);
}

const after = cache.embeddingCacheStatus();
const elapsedMs = Date.now() - startedAt;
if (!after.present) {
  // The model loaded, so it is usable, but nothing landed in the cache — a
  // read-only or full cache directory. Say so instead of promising a fast
  // first prompt that will not happen.
  fail(
    { ...base, warmed: false, elapsedMs },
    `the model loaded but ${after.modelDir} holds no cached files ` +
    `(${after.files} files, ${cache.formatCacheBytes(after.bytes)}) — is the cache directory writable?`,
  );
}

out(
  { ...base, warmed: true, bytes: after.bytes, files: after.files, elapsedMs },
  [
    `Embedding model cached at ${after.modelDir} ` +
    `(${cache.formatCacheBytes(after.bytes)}, ${after.files} files) in ${Math.round(elapsedMs / 1000)}s.`,
    'The first prompt of the next session uses this cache; it survives plugin updates.',
  ],
);
