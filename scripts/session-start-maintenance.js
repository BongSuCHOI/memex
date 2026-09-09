#!/usr/bin/env node

/**
 * Codex startup/prompt maintenance (asynchronous).
 *
 * Spawned independently from hooks.json. Owns everything that
 * must resume across sessions but must never block or emit context:
 *   1. Continuity capture index + Work Capsule queue (P0/P1)
 *   2. fact extraction (P2)
 *   3. fact consolidation / re-embed / ontology maintenance
 *
 * Context injection does NOT live here — UserPromptSubmit inject-context owns it.
 * Emits nothing on stdout; every failure is non-fatal and retried next session.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import {
  buildCategoryReembedPending,
  buildFactReembedPending,
  buildReembedPending,
} from '../dist/reembed-selector.js';
import { getExtractionConfig, pendingExtractionCoreQuery } from '../dist/pending-extraction.js';
import {
  getOrCreateAutomaticMaintenanceModelBudget,
  isAutomaticOntologyEnabled,
  claimMaintenanceWake,
} from '../dist/model-budget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  let db;
  try {
    // 1. Offload LLM-based consolidation to a detached worker (non-blocking)
    // CX-01: privacy-safe event observation (event/ts/session/cwd only).
    try {
      const { recordHookEvent } = await import('../dist/observe-hook-event.js');
      recordHookEvent(process.argv.includes('--prompt') ? 'UserPromptSubmit' : 'SessionStart', {
        sessionId: process.env.SESSION_ID || '',
        cwd: process.env.CWD || '',
      });
    } catch { /* observation is best-effort */ }

    db = initDatabase();
    // Shared across sessions and both entry points. A failed/crashed launch
    // becomes eligible again after three minutes; it never refunds model budget.
    if (!claimMaintenanceWake(db)) return;
    // One named maintenance wave is shared by detached sibling workers. The
    // durable row survives restarts. Conditional rollover preserves its ledger
    // and is limited by a cooldown plus the shared rolling attempt cap.
    const maintenanceBudget = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: process.env.MEMEX_MAINTENANCE_WAVE_ID || 'maintenance',
    });
    const childEnv = {
      ...process.env,
      MEMEX_MAINTENANCE_WAVE_ID: maintenanceBudget.parentWaveId,
      MEMEX_MODEL_BUDGET_ID: maintenanceBudget.budgetId,
    };

    const spawnDetached = (script) => {
      try {
        const child = spawn(process.execPath, [path.join(HERE, script)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: childEnv,
        });
        child.unref();
      } catch {
        // Non-fatal: background work resumes on a later session
      }
    };

    // 0.6.1 cross-device sync (#35/#48 decision 2): the maintenance wake is the
    // second automatic export trigger beside SessionEnd. Detached and gated —
    // the child exits immediately unless sync is enabled AND durable state
    // changed since the last export, so an idle machine publishes nothing.
    try {
      const { readSyncConfig } = await import('../dist/sync-paths.js');
      if (readSyncConfig().enabled) spawnDetached('sync-export-hook.js');
    } catch { /* non-fatal: SessionEnd is the other trigger */ }

    // 0.6.0 tier ladder (#19): evidence-based automatic promotion/demotion.
    // Model-free and bounded — a few indexed SQL passes over the projection —
    // so it runs before the priority gate below and never spends model budget.
    try {
      const { reconcileFactTiers } = await import('../dist/fact-management.js');
      reconcileFactTiers(db);
    } catch { /* non-fatal: the ladder retries on a later session */ }

    // P0/P1 always outrank fact/derived maintenance. The Continuity worker
    // itself claims only durable queue rows and is restart-safe.
    let continuityPending = false;
    try {
      const pendingContinuity = db.prepare(`
        SELECT 1 FROM memory_jobs
        WHERE kind IN ('capture_index','capsule_update')
          AND ((state IN ('pending','retry') AND available_at <= ?)
            OR (state = 'running' AND (lease_until IS NULL OR lease_until <= ?)))
        LIMIT 1
      `).get(new Date().toISOString(), new Date().toISOString());
      if (pendingContinuity) {
        continuityPending = true;
        spawnDetached('continuity-worker.js');
      }
    } catch { /* non-fatal */ }

    // Keep process-level priority strict: lower lanes resume on the next
    // SessionStart after P0/P1 has drained instead of competing for SQLite or
    // local model capacity in the same maintenance invocation.
    if (continuityPending) {
      return;
    }

    // Derived work begins only when the Continuity queue is currently drained.
    if (maintenanceBudget.state === 'active') {
      spawnDetached('fact-consolidate-worker.js');
    }

    // 2. Auto-resume vector upgrades: stale/missing category, fact, Korean,
    // and exchange vectors (selectors are the shared generation contract).
    try {
      const { EMBEDDING_VERSION } = await import('../dist/embeddings.js');
      const { clause: factClause, params: factParams } = buildFactReembedPending(EMBEDDING_VERSION);
      const pendingFact = db.prepare(`
        SELECT 1 FROM facts f WHERE (${factClause})
          OR (f.is_active = 1 AND f.fact_kr IS NOT NULL AND f.fact_kr != ''
              AND NOT EXISTS (SELECT 1 FROM vec_facts_kr_rowids v WHERE v.id = f.id))
        LIMIT 1
      `).get(...factParams);
      const { clause: categoryClause, params: categoryParams } = buildCategoryReembedPending(EMBEDDING_VERSION);
      const pendingCategory = db.prepare(
        `SELECT 1 FROM ontology_categories c WHERE ${categoryClause} LIMIT 1`,
      ).get(...categoryParams);
      const { clause, params } = buildReembedPending(EMBEDDING_VERSION);
      const pendingEx = db.prepare(`SELECT 1 FROM exchanges e WHERE ${clause} LIMIT 1`).get(...params);
      if (pendingCategory || pendingFact || pendingEx) spawnDetached('reembed-worker.js');
    } catch {
      // Non-fatal: re-embedding resumes on a later session
    }

    // 3. Auto-resume ontology classification backfill.
    try {
      const pendingOnto = db.prepare(
        'SELECT 1 FROM facts WHERE is_active = 1 AND ontology_category_id IS NULL LIMIT 1'
      ).get();
      // Existing relation memberships are durable pending work. The
      // BACKFILL_RELATIONS switch controls creating new relation probes while
      // classifying an ontology page; it must not hide already queued work.
      const pendingRelation = db.prepare(`
        SELECT 1
        FROM model_work_targets t
        JOIN facts f ON f.id = t.target_id
        WHERE t.budget_id = ? AND t.stage = 'relation' AND t.state = 'pending'
          AND f.is_active = 1
        LIMIT 1
      `).get(maintenanceBudget.budgetId);
      if ((pendingOnto || pendingRelation) && isAutomaticOntologyEnabled() && maintenanceBudget.state === 'active') {
        spawnDetached('backfill-ontology-worker.js');
      }
    } catch { /* non-fatal */ }

    // 4. Auto-resume cross-project extraction backfill (worker's own pending
    // predicate — never spawns for phantom sessions it could not clear).
    try {
      const { sql: exSql, params: exParams } = pendingExtractionCoreQuery(
        getExtractionConfig(),
        'continuity',
      );
      const pendingExtract = db.prepare(`SELECT 1 FROM (${exSql}) LIMIT 1`).get(...exParams);
      if (pendingExtract && maintenanceBudget.state === 'active') spawnDetached('backfill-extract-worker.js');
    } catch { /* non-fatal */ }

  } catch (error) {
    console.error('session-start-maintenance: Error:', error instanceof Error ? error.message : error);
    // Non-fatal: another start/prompt retries after the short wake interval.
  } finally {
    db?.close();
  }
}

main();
