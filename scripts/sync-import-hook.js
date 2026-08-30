#!/usr/bin/env node

/**
 * SessionStart Hook: Reconcile knowledge/safety state from other devices.
 * Part of the SessionStart maintenance chain (scripts/session-start-maintenance.js).
 */

import { importFromSync } from '../dist/sync-import.js';

async function main() {
  try {
    const result = await importFromSync();
    const factChanges = result.newFacts + result.updatedFacts + result.deletedFacts;
    if (
      factChanges > 0 || result.newRevisions > 0 || result.newTombstones > 0 ||
      result.newRecallEvents > 0 || result.updatedRecallEvents > 0
    ) {
      console.log(
        `sync-import: facts +${result.newFacts}/~${result.updatedFacts}/-${result.deletedFacts}, ` +
        `+${result.newRevisions} revisions, +${result.newTombstones} tombstones, ` +
        `+${result.newRecallEvents}/~${result.updatedRecallEvents} recall events`,
      );
    }
    // Fail-closed contract: rejected generations/schema-invalid rows are
    // reported, never silent.
    for (const issue of result.malformedRows) {
      console.error(
        `sync-import: payload issue at ${issue.file}:${issue.line} — ${issue.error}`,
      );
    }
    if (result.malformedRows.length > 0) {
      console.log(`sync-import: ${result.malformedRows.length} payload issue(s) reported (see stderr)`);
    }
  } catch (error) {
    // Non-fatal
    console.error('sync-import: Error:', error instanceof Error ? error.message : error);
    process.exit(0);
  }
}

main();
