import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000, // 30 seconds for embedding/indexing tests
    env: {
      // Issue #65: default-branch detection now also reads the user's global and
      // system git config. Neutralize both so a developer's `~/.gitconfig`
      // cannot decide whether a test's branch counts as the default one. Tests
      // that exercise the lookup set these to a temp file of their own.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  },
});
