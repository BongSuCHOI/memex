#!/usr/bin/env node

/**
 * Local meaning-evidence receipt backfill (issue #45).
 *
 * MODEL-FREE and resumable. `recordLocalMeaningEvidence` only ever ran at
 * extraction/edit time, so a fact created before that binding existed (or one
 * whose receipt was dropped by a remote semantic win) never got one — 118 of
 * 127 facts in the audited data root. Those facts are silently excluded from
 * automatic consolidation and lose every sync tie-break.
 *
 * The receipt row is its own resume marker: an interrupted run re-selects the
 * remainder on the next invocation.
 *
 * Usage: node scripts/backfill-receipts-worker.js [--max N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import {
  backfillEvidenceReceipts,
  countFactsWithoutLocalEvidence,
} from '../dist/evidence-backfill.js';
import { getIndexDir } from '../dist/paths.js';

function boundedInt(raw, def, cap) {
  const s = raw == null ? '' : String(raw);
  const v = /^\d+$/.test(s) ? parseInt(s, 10) : def;
  return Math.min(v, cap);
}

const maxArg = process.argv.indexOf('--max');
const MAX_FACTS = maxArg > -1
  ? boundedInt(process.argv[maxArg + 1], 1000, 20000)
  : boundedInt(process.env.BACKFILL_RECEIPTS_MAX, 1000, 20000);

const LOCK = path.join(getIndexDir(), 'backfill-receipts.lock');

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
        if (pid && !Number.isNaN(pid)) {
          try { process.kill(pid, 0); return false; } // alive → don't run
          catch { /* stale lock */ }
        }
        fs.unlinkSync(LOCK);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK);
  } catch { /* ignore */ }
}

function main() {
  if (!acquireLock()) {
    console.log('backfill-receipts: another worker is running, exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  let db;
  try {
    db = initDatabase();
    const before = countFactsWithoutLocalEvidence(db);
    const result = backfillEvidenceReceipts(db, { limit: MAX_FACTS });
    const after = countFactsWithoutLocalEvidence(db);
    console.log(
      `backfill-receipts: scanned ${result.scanned}, recorded ${result.recorded}, failed ${result.failed} ` +
        `(facts without local evidence ${before} -> ${after})`,
    );
    if (result.failed > 0) {
      // Not fatal: a fact whose source evidence changed under us is simply
      // re-selected next run. It must still be VISIBLE — the silent return is
      // exactly what hid 118 missing receipts.
      console.error(
        `backfill-receipts: ${result.failed} fact(s) could not be re-verified this run (evidence changed); they stay selected`,
      );
    }
  } catch (error) {
    console.error(`backfill-receipts: FATAL ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
