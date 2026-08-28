#!/usr/bin/env node

/**
 * SessionEnd Hook: Export reconciliable knowledge/safety state for cross-device sync.
 * Runs after extraction completes in scripts/session-end-hook.js.
 */

import { exportForSync } from '../dist/sync-export.js';

try {
  const result = exportForSync();
  if (result.facts > 0 || result.tombstones > 0 || result.recallEvents > 0) {
    console.log(
      `sync-export: ${result.facts} facts, ${result.revisions} revisions, ` +
      `${result.tombstones} tombstones, ${result.recallEvents} recall events, ` +
      `${result.domains} domains, ${result.relations} relations`,
    );
  }
} catch (error) {
  // Non-fatal
  console.error('sync-export: Error:', error instanceof Error ? error.message : error);
  process.exit(0);
}
