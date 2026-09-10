/**
 * Issue #92 — keep a gate run's embedding model cache out of the REAL data root.
 *
 * Since 0.6.5 the model weights are cached in the data root (`<data root>/models`,
 * src/model-cache.ts) instead of under the plugin root's `node_modules`. That is
 * the right answer in production and a trap for a harness: a suite that isolates
 * only `TEST_DB_PATH` leaves `MEMEX_HOME` pointing at the developer's real
 * `~/.config/memex`, and the first model load would put 129 MB there — exactly
 * what `scripts/check-real-root-untouched.mjs` exists to catch. A suite with its
 * own temp data root has the opposite problem: one download per temp root.
 *
 * Importing this module pins the cache at the checkout's own transformers cache —
 * the pre-0.6.5 location, which a dev checkout already has — so nothing is
 * downloaded, nothing is copied, and the real data root is untouched. The
 * `vitest.config.ts` `env` block does the same for the TypeScript suites.
 *
 * Side-effect import, before anything that can load the model:
 *   import './model-cache-pin.mjs';
 *
 * An explicit `MEMEX_MODEL_CACHE_DIR` from the caller always wins, so a test that
 * means to exercise the resolution itself is not overridden.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.env.MEMEX_MODEL_CACHE_DIR ??= path.join(
  REPO,
  'node_modules',
  '@xenova',
  'transformers',
  '.cache',
);

export const PINNED_MODEL_CACHE_DIR = process.env.MEMEX_MODEL_CACHE_DIR;
