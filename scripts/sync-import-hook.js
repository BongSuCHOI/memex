#!/usr/bin/env node

/**
 * SessionStart Hook: Import facts/ontology from sync/ folder (from other devices).
 * Part of the SessionStart maintenance chain (scripts/session-start-maintenance.js).
 */

import { importFromSync } from '../dist/sync-import.js';

async function main() {
  try {
    const result = await importFromSync();
    if (result.newFacts > 0 || result.newDomains > 0) {
      console.log(`sync-import: +${result.newFacts} facts, +${result.newDomains} domains, +${result.newRelations} relations`);
    }
  } catch (error) {
    // Non-fatal
    console.error('sync-import: Error:', error instanceof Error ? error.message : error);
    process.exit(0);
  }
}

main();
