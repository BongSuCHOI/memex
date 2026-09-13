#!/usr/bin/env node
/**
 * `npm run warm:model-cache` — fill the CHECKOUT cache the gates check.
 *
 * `memex deps warm` on its own resolves `embeddingCacheDir()`, whose default is
 * `<data root>/models` (src/model-cache.ts). Run in a dev checkout with the
 * default environment it therefore downloads 129 MB into the operator's REAL
 * data root and leaves `node_modules/@xenova/transformers/.cache` — the
 * directory `scripts/e2e-model-cache-pin.mjs`, `test/model-cache-pin.mjs` and
 * `vitest.config.ts` all pin — exactly as cold as before, so the gate that sent
 * you here fails again.
 *
 * This wrapper is that command with the one variable set, pinned at the SAME
 * constant the gate checks, so the warm and the check cannot drift apart. Flags
 * pass through: `npm run warm:model-cache -- --force --json`.
 *
 * An explicit `MEMEX_MODEL_CACHE_DIR` still wins, matching the pin's own rule: an
 * operator pointing at a shared cache is not overridden.
 */
import { CHECKOUT_MODEL_CACHE_DIR } from './e2e-model-cache-pin.mjs';

const explicit = process.env.MEMEX_MODEL_CACHE_DIR?.trim();
process.env.MEMEX_MODEL_CACHE_DIR = explicit || CHECKOUT_MODEL_CACHE_DIR;

// Imported, not spawned: `warm-embedding-cache.mjs` reads the variable from
// `process.env` at load time, and one process keeps the exit code honest.
await import('./warm-embedding-cache.mjs');
