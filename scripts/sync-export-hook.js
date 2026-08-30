#!/usr/bin/env node

/**
 * SessionEnd Hook: Export reconciliable knowledge/safety state for cross-device sync.
 * Runs after extraction completes in scripts/session-end-hook.js.
 *
 * P2-6: export must never wedge the session lifecycle, but it must also never
 * fail silently — every attempt (ok or failed) is recorded to the durable
 * export-status file that the parent hook, `memex doctor`, and the next
 * lifecycle can observe.
 */

import { exportForSync, recordExportStatus } from '../dist/sync-export.js';

try {
  const result = exportForSync();
  if (result.facts > 0 || result.tombstones > 0 || result.recallEvents > 0) {
    console.log(
      `sync-export: ${result.facts} facts, ${result.revisions} revisions, ` +
      `${result.tombstones} tombstones, ${result.recallEvents} recall events`,
    );
  }
  try {
    recordExportStatus({ ok: true, at: new Date().toISOString(), counts: result });
  } catch (statusError) {
    console.error('sync-export: status record failed:',
      statusError instanceof Error ? statusError.message : statusError);
  }
} catch (error) {
  // Non-fatal for the session lifecycle, but durably recorded and loud.
  const message = error instanceof Error ? error.message : String(error);
  console.error('sync-export: Error:', message);
  try {
    recordExportStatus({
      ok: false,
      at: new Date().toISOString(),
      error: message,
    });
  } catch (statusError) {
    console.error('sync-export: status record failed:',
      statusError instanceof Error ? statusError.message : statusError);
  }
  process.exit(0);
}
