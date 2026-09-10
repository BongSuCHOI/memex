import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Issue #92 — pin the embedding model cache for the whole suite.
 *
 * The model cache now lives in the DATA ROOT (`<data root>/models`), which is the
 * right answer in production and the wrong one for a harness: a test that leaves
 * `MEMEX_HOME` alone would populate the developer's real `~/.config/memex`, and a
 * test with its own temp data root would fetch 129 MB per temp root. Pinning it
 * at the checkout's own transformers cache keeps every test reading the one copy
 * a dev checkout already has — the pre-0.6.5 location, so nothing is downloaded
 * or copied — and keeps the real data root untouched.
 */
const CHECKOUT_MODEL_CACHE = fileURLToPath(
  new URL('node_modules/@xenova/transformers/.cache', import.meta.url),
);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for embedding/indexing tests
    env: {
      MEMEX_MODEL_CACHE_DIR: CHECKOUT_MODEL_CACHE,
      // Issue #65: default-branch detection now also reads the user's global and
      // system git config. Neutralize both so a developer's `~/.gitconfig`
      // cannot decide whether a test's branch counts as the default one. Tests
      // that exercise the lookup set these to a temp file of their own.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  },
});
