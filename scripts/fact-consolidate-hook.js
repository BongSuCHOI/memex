#!/usr/bin/env node

/**
 * SessionStart Hook: Consolidate facts and inject context.
 *
 * Claude Code passes hook input as JSON on stdin:
 *   { "session_id": "...", "cwd": "...", "hook_event_name": "SessionStart", ... }
 *
 * Env vars (CWD / PROJECT_DIR / LAST_CONSOLIDATED_AT) remain as fallback
 * for manual invocation.
 *
 * Context injection (top facts, continuity, intent) runs synchronously so its
 * stdout reaches the session. LLM-based consolidation is offloaded to a
 * detached worker so SessionStart is never blocked by slow LLM calls.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { getTopFacts } from '../dist/fact-db.js';
import { getLastSessionContext, formatSessionContinuity } from '../dist/session-continuity.js';
import { predictIntent, formatIntentContext } from '../dist/intent-predictor.js';

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* not JSON — fall back to env */ }

  const project = input.cwd || process.env.CWD || process.env.PROJECT_DIR || process.cwd();

  try {
    // 1. Offload LLM-based consolidation to a detached worker (non-blocking)
    const here = path.dirname(fileURLToPath(import.meta.url));
    const worker = path.join(here, 'fact-consolidate-worker.js');
    try {
      const child = spawn(process.execPath, [worker], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CWD: project },
      });
      child.unref();
    } catch {
      // Non-fatal: consolidation is best-effort
    }

    // 2. Inject top facts as context (fast, no LLM)
    const db = initDatabase();

    // 2a. Auto-resume vector upgrades: if any rows still carry old-model
    // embeddings, spawn the resumable re-embed worker (its pid lockfile
    // prevents concurrent runs, so spawning is safe to attempt every start).
    const spawnDetached = (script) => {
      try {
        const child = spawn(process.execPath, [path.join(here, script)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env },
        });
        child.unref();
      } catch {
        // Non-fatal: background work resumes on a later session
      }
    };
    try {
      const { EMBEDDING_VERSION } = await import('../dist/embeddings.js');
      const pendingFact = db.prepare(
        'SELECT 1 FROM facts WHERE is_active = 1 AND embedding_version != ? LIMIT 1'
      ).get(EMBEDDING_VERSION);
      const pendingEx = db.prepare(
        'SELECT 1 FROM exchanges WHERE embedding_version != ? LIMIT 1'
      ).get(EMBEDDING_VERSION);
      if (pendingFact || pendingEx) spawnDetached('reembed-worker.js');
    } catch {
      // Non-fatal: re-embedding resumes on a later session
    }

    // 2b. Auto-resume ontology classification backfill (historic facts saved
    // without classification).
    try {
      const pendingOnto = db.prepare(
        'SELECT 1 FROM facts WHERE is_active = 1 AND ontology_category_id IS NULL LIMIT 1'
      ).get();
      if (pendingOnto) spawnDetached('backfill-ontology-worker.js');
    } catch { /* non-fatal */ }

    // 2c. Auto-resume cross-project extraction backfill (sessions that ended
    // before the fixed SessionEnd hook existed).
    try {
      const pendingExtract = db.prepare(`
        SELECT 1 FROM exchanges e
        WHERE e.is_sidechain = 0 AND e.session_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM extraction_log l WHERE l.session_id = e.session_id)
        LIMIT 1
      `).get();
      if (pendingExtract) spawnDetached('backfill-extract-worker.js');
    } catch { /* non-fatal */ }
    const topFacts = getTopFacts(db, project, 10);
    if (topFacts.length > 0) {
      console.log('');
      console.log('# Project Key Facts (auto-recalled)');
      for (const fact of topFacts) {
        console.log(`- [${fact.category}] ${fact.fact} (${fact.consolidated_count}x confirmed)`);
      }
    }
    db.close();

    // 3. Inject last session context (for continuity)
    try {
      const lastSession = getLastSessionContext(project);
      if (lastSession) {
        console.log('');
        console.log(formatSessionContinuity(lastSession));
      }
    } catch {
      // Non-fatal: session continuity is best-effort
    }

    // 4. Inject project intent profile
    try {
      const intent = predictIntent(project);
      const intentCtx = formatIntentContext(intent);
      if (intentCtx) {
        console.log('');
        console.log(intentCtx);
      }
    } catch {
      // Non-fatal: intent prediction is best-effort
    }
  } catch (error) {
    console.error('fact-consolidate: Error:', error instanceof Error ? error.message : error);
    // Don't block session start on consolidation failure
    process.exit(0);
  }
}

main();
