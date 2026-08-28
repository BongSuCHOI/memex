#!/usr/bin/env node

/**
 * Detached worker spawned by scripts/session-start-maintenance.js.
 * Runs LLM-based fact consolidation without blocking SessionStart.
 *
 * Environment:
 *   CWD - project path (canonical: absolute path)
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { consolidateAllPending } from '../dist/consolidator.js';
import { getIndexDir } from '../dist/paths.js';

// GLOBAL single-instance lock (NOT per-project): consolidation touches shared
// global-scope facts (the dirty queue spans every scope), so concurrent
// per-project workers would race on the same rows. One lock-holder processes
// the ENTIRE backlog in a single pass — every new fact once, one LLM budget —
// so no project is starved and shared globals aren't reprocessed per project.
// This kills the flood: the SessionStart hook re-spawns this worker on every
// session with no lock (measured 14 orphaned ppid=1 workers at once, each
// spawning a headless Codex session per LLM call).
const LOCK = path.join(getIndexDir(), 'fact-consolidate.lock');
function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-consolidate.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

// Atomic exclusive create ('wx') + pid-liveness check so a stale lock from a
// killed worker is cleared and re-acquired.
function acquireLock() {
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
        fs.unlinkSync(LOCK); // stale — remove and retry the exclusive create
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

async function main() {
  if (!acquireLock()) {
    // Another consolidate worker already holds the GLOBAL lock — exit cleanly.
    // It processes the whole backlog (every scope/project), so nothing is lost;
    // this session's spawn simply steps aside instead of piling up.
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  let db;
  try {
    db = initDatabase();
    // Queue membership is stored with each fact. Historical created_at never
    // controls local processing order, so late sync imports cannot be skipped.
    const result = await consolidateAllPending(db);
    if (result.processed > 0 || result.llmCalls > 0) {
      log(`worker: processed=${result.processed} llmCalls=${result.llmCalls} merged=${result.merged} contradictions=${result.contradictions} evolutions=${result.evolutions} remaining=${result.remaining}`);
    }
  } catch (error) {
    log(`worker: FATAL ${error instanceof Error ? error.message : error}`);
    process.exitCode = 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
