#!/usr/bin/env node

/**
 * Cross-device sync export (issue #35).
 *
 * Registered as an ASYNC SessionEnd entry and spawned detached by the
 * maintenance wake, so it never blocks the bounded SessionEnd capture fence.
 * Before 0.6.1 this script existed but was registered nowhere: `exportForSync`
 * had exactly one caller and that caller was in no hook, no bin entry and no
 * CLI command, while doctor reported `sync-export: ok` and told users to wait
 * for a SessionEnd that would never call it.
 *
 * Two gates, both in src/sync-control.ts so every surface shares them:
 *   1. cross-device sync must be ON (it is OFF by default, #48 decision 5)
 *   2. durable state must have changed since the last successful export, so an
 *      idle machine never publishes an empty generation (#48 B)
 *
 * P2-6: every attempt (ok or failed) is recorded to the durable export-status
 * file that `memex doctor` and `memex sync status` read — a failure must never
 * vanish behind this hook's exit 0.
 */

import { runSyncExport } from '../dist/sync-control.js';

try {
  const outcome = runSyncExport();
  if (outcome.skipped === 'disabled') {
    console.error('sync-export: skipped (cross-device sync is off)');
  } else if (outcome.skipped === 'unchanged') {
    console.error('sync-export: skipped (no durable change since the last export)');
  } else if (outcome.skipped === 'locked') {
    console.error('sync-export: skipped (another export is in progress)');
  } else if (outcome.error) {
    console.error('sync-export: Error:', outcome.error);
  } else {
    const result = outcome.result;
    console.error(
      `sync-export: ${result.facts} facts, ${result.revisions} revisions, ` +
      `${result.tombstones} tombstones, ${result.recallEvents} recall events`,
    );
  }
} catch (error) {
  // Non-fatal for the session lifecycle; runSyncExport already recorded what it
  // could, so this only covers a failure to load or call it at all.
  console.error('sync-export: Error:', error instanceof Error ? error.message : error);
}
process.exit(0);
