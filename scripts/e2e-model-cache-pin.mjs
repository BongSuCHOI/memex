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
 *   - A COLD checkout cache fails fast, naming the ONE command that fills the
 *     directory the check just looked at (`npm run warm:model-cache`), rather
 *     than letting the gate download the model into a temp root. A bare `memex
 *     deps warm` is NOT that command: with the default environment it resolves
 *     `<data root>/models` (`embeddingCacheDir()`, src/model-cache.ts) and so
 *     downloads 129 MB into the operator's REAL data root while leaving the
 *     checkout cache — and therefore the gate — exactly as cold as before.
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
 * Exactly the files the default embedding pipeline loads, every one of them
 * required — derived, not guessed:
 *
 *   - `src/embeddings.ts` calls `pipeline('feature-extraction', EMBEDDING_MODEL)`
 *     with NO options, so `@xenova/transformers` applies its own defaults.
 *   - `quantized` defaults to `true` (node_modules/@xenova/transformers/src/models.js),
 *     and the weights path is `onnx/${fileName}${quantized ? '_quantized' : ''}.onnx`
 *     — so the file loaded is `onnx/model_quantized.onnx`, and a cache holding
 *     only the full-precision `onnx/model.onnx` still has to download.
 *   - the tokenizer loads `tokenizer.json` and `tokenizer_config.json` with
 *     `fatal: true` (…/src/tokenizers.js), and the model config `config.json`.
 *
 * A "some .onnx file exists" check passed caches missing any of these, and
 * `env.allowRemoteModels` is deliberately left at `true` (see `applyEmbeddingCacheDir`
 * in src/embeddings.ts), so the pipeline would quietly fetch the rest from the
 * Hub — exactly the network dependency this pin exists to remove.
 */
export const REQUIRED_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  path.join("onnx", "model_quantized.onnx"),
];

/**
 * Is `<cacheDir>/<model>` a USABLE cache?
 *
 * STRICTER than `inspectModelCacheDir()` (src/model-cache.ts), on purpose: that
 * one answers "has this root ever held the model" for `doctor` and the legacy
 * adoption, where a non-empty `.onnx` plus `config.json` is the useful signal.
 * A gate that must not touch the network needs the whole file list, because any
 * one missing file is a download. Re-implemented on node builtins so the pin
 * works before `npm run build` and without loading the model library.
 */
export function inspectPinnedModelCache(
  cacheDir = CHECKOUT_MODEL_CACHE_DIR,
  model = DEFAULT_EMBEDDING_MODEL,
) {
  const modelDir = path.join(cacheDir, ...model.split("/"));
  let files = 0;
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
      try {
        fs.statSync(full);
      } catch {
        continue;
      }
      files++;
    }
  };
  walk(modelDir);
  const missing = REQUIRED_MODEL_FILES.filter((relative) => {
    try {
      return fs.statSync(path.join(modelDir, relative)).size <= 0;
    } catch {
      return true;
    }
  });
  return { modelDir, files, missing, present: missing.length === 0 };
}

/**
 * The `npm run` alias that fills `cacheDir`, and the raw command behind it.
 *
 * `scripts/warm-checkout-model-cache.mjs` pins `MEMEX_MODEL_CACHE_DIR` at
 * `CHECKOUT_MODEL_CACHE_DIR` before delegating to `memex deps warm`, which is
 * the whole point: the warm and the check then agree on one directory, and no
 * default-env run can put the download in the operator's real data root.
 */
export function warmCommands(cacheDir = CHECKOUT_MODEL_CACHE_DIR) {
  return [
    "npm run warm:model-cache",
    `MEMEX_MODEL_CACHE_DIR=${JSON.stringify(cacheDir)} node scripts/warm-embedding-cache.mjs`,
  ];
}

/**
 * Decide the pin without touching `process.env` — the unit-testable half.
 *
 * Returns `{ dir, source }`; throws when the checkout cache is cold or
 * incomplete, naming a command that fills the directory it just checked.
 * Read-only: it never creates a directory.
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
  const { modelDir, files, missing, present } = inspectPinnedModelCache(cacheDir, model);
  if (!present) {
    const [alias, raw] = warmCommands(cacheDir);
    const state =
      files > 0
        ? `it holds ${files} file(s) but is INCOMPLETE (an interrupted download): ` +
          `missing ${missing.join(", ")}`
        : "it is empty";
    throw new Error(
      `${label}: the embedding model cache at ${modelDir} is not usable — ${state}.\n` +
        `Every one of ${REQUIRED_MODEL_FILES.join(", ")} is required: the default pipeline ` +
        `loads all of them and would fetch any missing one from the Hub, which is the network ` +
        `dependency this pin exists to remove (issue #114).\n` +
        `Warm THIS directory once — a bare 'memex deps warm' fills <data root>/models instead ` +
        `and leaves the gate cold:\n` +
        `  ${alias}\n` +
        `  (equivalently: ${raw})\n` +
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
