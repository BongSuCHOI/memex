/**
 * Issue #114 — keep the e2e gates off the network and out of the real data root.
 *
 * Since 0.6.5 (#92) the embedding model weights are cached in the DATA ROOT
 * (`<data root>/models`, src/model-cache.ts). Every e2e script here runs against
 * a fresh temp `MEMEX_HOME`, so without a pin each run resolves an EMPTY cache
 * and downloads 129 MB — the gate then depends on the network (0.6.9's
 * `package-runtime-e2e` failure) and costs ~82s per run.
 *
 * `test/model-cache-pin.mjs` already solves this for the `.mjs` suites and
 * `vitest.config.ts` for the `.ts` ones, both by pinning
 * `MEMEX_MODEL_CACHE_DIR` at the CHECKOUT's transformers cache — a directory a
 * dev checkout already has warm. This module is the same pin for the five e2e
 * scripts, which spawn child processes and therefore only need the variable set
 * on `process.env` before the first spawn.
 *
 * Side-effect-free import; call the pin explicitly, before any spawn:
 *   import { pinModelCacheForE2E } from './e2e-model-cache-pin.mjs';
 *   pinModelCacheForE2E('package-runtime-e2e');
 *
 * Rules:
 *   - An explicit `MEMEX_MODEL_CACHE_DIR` from the caller always wins (a gate
 *     runner pointing at a shared cache is not overridden).
 *   - A COLD checkout cache fails fast, naming `memex deps warm`, rather than
 *     letting the gate download the model into a temp root.
 *   - `MEMEX_EMBEDDING_STUB=1` replaces the model entirely, so the pin is still
 *     applied (nothing may be written to a temp root) but no weights are
 *     required.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same directory `test/model-cache-pin.mjs` and `vitest.config.ts` pin. */
export const CHECKOUT_MODEL_CACHE_DIR = path.join(
  REPO,
  "node_modules",
  "@xenova",
  "transformers",
  ".cache",
);

/** Kept in sync with `DEFAULT_EMBEDDING_MODEL` (src/model-cache.ts). */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";

/**
 * Is `<cacheDir>/<model>` a USABLE cache?
 *
 * Same verdict as `inspectModelCacheDir()` (src/model-cache.ts): a directory holding
 * only `config.json` is an interrupted download, not a warm cache. Re-implemented
 * on node builtins so the pin works before `npm run build` and without loading
 * the model library.
 */
export function inspectPinnedModelCache(
  cacheDir = CHECKOUT_MODEL_CACHE_DIR,
  model = DEFAULT_EMBEDDING_MODEL,
) {
  const modelDir = path.join(cacheDir, ...model.split("/"));
  let files = 0;
  let weights = false;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      files++;
      if (full.toLowerCase().endsWith(".onnx") && size > 0) weights = true;
    }
  };
  walk(modelDir);
  const config = (() => {
    try {
      return fs.statSync(path.join(modelDir, "config.json")).size > 0;
    } catch {
      return false;
    }
  })();
  return { modelDir, files, present: weights && config };
}

/**
 * Decide the pin without touching `process.env` — the unit-testable half.
 *
 * Returns `{ dir, source }`; throws when the checkout cache is cold, with a
 * message naming `memex deps warm`. Read-only: it never creates a directory.
 */
export function resolveE2EModelCachePin({
  env = process.env,
  cacheDir = CHECKOUT_MODEL_CACHE_DIR,
  model = env.MEMEX_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
  label = "e2e",
} = {}) {
  const explicit = env.MEMEX_MODEL_CACHE_DIR?.trim();
  if (explicit) return { dir: path.resolve(explicit), source: "caller" };
  if (env.MEMEX_EMBEDDING_STUB === "1") {
    return { dir: cacheDir, source: "stub" };
  }
  const { modelDir, files, present } = inspectPinnedModelCache(cacheDir, model);
  if (!present) {
    const partial =
      files > 0
        ? ` ${modelDir} holds ${files} file(s) but no usable weights (an interrupted download).`
        : "";
    throw new Error(
      `${label}: the embedding model cache is cold at ${modelDir}.${partial}\n` +
        `This gate pins MEMEX_MODEL_CACHE_DIR at the checkout cache so it never downloads the ` +
        `129 MB model into its temporary data root (issue #114). Warm it once with ` +
        `'memex deps warm' (or 'node scripts/warm-embedding-cache.mjs') and re-run the gate. ` +
        `To use a different cache, set MEMEX_MODEL_CACHE_DIR yourself.`,
    );
  }
  return { dir: cacheDir, source: "checkout" };
}

/**
 * Apply the pin to `env` (default `process.env`), or exit 1 with the advice.
 *
 * Call it before the first spawn: every e2e script builds child environments
 * from `...process.env`, so one assignment covers the whole run.
 */
export function pinModelCacheForE2E(label = "e2e", options = {}) {
  const env = options.env ?? process.env;
  let pin;
  try {
    pin = resolveE2EModelCachePin({ ...options, env, label });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  env.MEMEX_MODEL_CACHE_DIR = pin.dir;
  return pin;
}
