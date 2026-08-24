#!/usr/bin/env node

/**
 * Codex SessionStart maintenance (non-blocking).
 *
 * Spawned from hooks.json after the background sync. Owns everything that
 * must resume across sessions but must never block or emit context:
 *   1. fact consolidation (LLM) — detached fact-consolidate-worker.js
 *   2. re-embed backlog (stale/missing vectors, exchanges + facts)
 *   3. ontology classification backfill
 *   4. cross-project fact-extraction backfill
 *
 * Context injection does NOT live here — UserPromptSubmit inject-context owns it.
 * Emits nothing on stdout; every failure is non-fatal and retried next session.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { buildReembedPending } from '../dist/reembed-selector.js';
import { getExtractionConfig, pendingExtractionCoreQuery } from '../dist/pending-extraction.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    // 1. Offload LLM-based consolidation to a detached worker (non-blocking)
    const worker = path.join(HERE, 'fact-consolidate-worker.js');
    try {
      const child = spawn(process.execPath, [worker], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env },
      });
      child.unref();
    } catch {
      // Non-fatal: consolidation is best-effort
    }

    const db = initDatabase();

    const spawnDetached = (script) => {
      try {
        const child = spawn(process.execPath, [path.join(HERE, script)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      } catch {
        // Non-fatal: background work resumes on a later session
      }
    };

    // 2. Auto-resume vector upgrades: stale-version embeddings, Korean-vector
    // gaps, and missing exchange vectors (single source: buildReembedPending).
    try {
      const { EMBEDDING_VERSION } = await import('../dist/embeddings.js');
      const pendingFact = db.prepare(`
        SELECT 1 FROM facts f WHERE f.is_active = 1 AND (
          f.embedding_version != ?
          OR (f.fact_kr IS NOT NULL AND f.fact_kr != ''
              AND NOT EXISTS (SELECT 1 FROM vec_facts_kr_rowids v WHERE v.id = f.id))
        ) LIMIT 1
      `).get(EMBEDDING_VERSION);
      const { clause, params } = buildReembedPending(EMBEDDING_VERSION);
      const pendingEx = db.prepare(`SELECT 1 FROM exchanges e WHERE ${clause} LIMIT 1`).get(...params);
      if (pendingFact || pendingEx) spawnDetached('reembed-worker.js');
    } catch {
      // Non-fatal: re-embedding resumes on a later session
    }

    // 3. Auto-resume ontology classification backfill.
    try {
      const pendingOnto = db.prepare(
        'SELECT 1 FROM facts WHERE is_active = 1 AND ontology_category_id IS NULL LIMIT 1'
      ).get();
      if (pendingOnto) spawnDetached('backfill-ontology-worker.js');
    } catch { /* non-fatal */ }

    // 4. Auto-resume cross-project extraction backfill (worker's own pending
    // predicate — never spawns for phantom sessions it could not clear).
    try {
      const { sql: exSql, params: exParams } = pendingExtractionCoreQuery(getExtractionConfig());
      const pendingExtract = db.prepare(`SELECT 1 FROM (${exSql}) LIMIT 1`).get(...exParams);
      if (pendingExtract) spawnDetached('backfill-extract-worker.js');
    } catch { /* non-fatal */ }

    db.close();
  } catch (error) {
    console.error('session-start-maintenance: Error:', error instanceof Error ? error.message : error);
    process.exit(0); // never block session start
  }
}

main();
