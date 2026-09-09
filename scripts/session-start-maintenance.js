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

/**
 * Issue #26 (item 6) — this hook logged `SessionStart` rows with an empty
 * session_id and cwd because it read `process.env.SESSION_ID`/`CWD`, which
 * Codex does not set. The identity is on stdin, in the hook payload, like every
 * other hook. Bounded and non-blocking: a manual run without stdin waits at
 * most this long and then proceeds with what it has.
 */
async function readHookPayload() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  try {
    const read = (async () => {
      for await (const chunk of process.stdin) chunks.push(chunk);
    })();
    await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 250))]);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  } finally {
    // The pipe stays open after the race; leaving it referenced would keep this
    // async hook alive well past its work.
    try { process.stdin.pause(); process.stdin.destroy(); } catch { /* already closed */ }
  }
}

async function main() {
  let db;
  try {
    // 1. Offload LLM-based consolidation to a detached worker (non-blocking)
    // CX-01: privacy-safe event observation (event/ts/session/cwd only).
    try {
      const payload = await readHookPayload();
      const { recordHookEvent } = await import('../dist/observe-hook-event.js');
      // The payload's own event name is authoritative; the --prompt flag is the
      // fallback for a host that sends no payload.
      const event = typeof payload.hook_event_name === 'string' && payload.hook_event_name.trim()
        ? payload.hook_event_name.trim()
        : process.argv.includes('--prompt') ? 'UserPromptSubmit' : 'SessionStart';
      recordHookEvent(event, {
        sessionId: typeof payload.session_id === 'string' ? payload.session_id : process.env.SESSION_ID || '',
        cwd: typeof payload.cwd === 'string' ? payload.cwd : process.env.CWD || '',
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
      // Issue #42: children receive the ROOT wave id, never the rolled-over
      // one. Passing the expanded id made each detached worker append another
      // `:run:<uuid>` to it AND narrowed its lineage lookup to that prefix,
      // which silently detached the worker from the shared rolling attempt cap
      // (the deepest row in the audited data root was created by exactly this
      // path — it carried automatic = 0).
      MEMEX_MAINTENANCE_WAVE_ID: maintenanceBudget.rootWaveId ?? maintenanceBudget.parentWaveId,
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

    // Issue #43: keep process-level priority strict, but BOUNDED and visible.
    //
    // The old code returned here, so a Capsule job that fails deterministically
    // — and is re-created at every new checkpoint — could skip all four derived
    // lanes indefinitely, with no log, no telemetry sample and nothing in
    // `memex status` connecting "fact extraction is not progressing" to the
    // Continuity backlog that actually caused it.
    //
    // Now every skip is counted durably; after DERIVED_LANE_FORCE_AFTER
    // consecutive skips for the SAME reason the lanes are let through once and
    // the counter resets. P0/P1 still wins the other N-1 invocations.
    if (continuityPending) {
      let forced = false;
      try {
        const { recordDerivedLaneSkip } = await import('../dist/derived-lane-skip.js');
        const skip = recordDerivedLaneSkip(db, 'continuity_backlog');
        forced = skip.forced;
        try {
          const { recordTelemetrySample } = await import('../dist/chronicle.js');
          recordTelemetrySample(db, {
            metric: 'derived_lane_skipped',
            value: 1,
            dims: {
              reason: 'continuity_backlog',
              consecutive: skip.consecutive,
              forced: skip.forced,
            },
          });
        } catch { /* telemetry is best-effort; never blocks maintenance */ }
      } catch {
        // The counter itself is unavailable (pre-0.6.1 database, read-only
        // filesystem): fall back to the historical strict-priority behaviour.
        return;
      }
      if (!forced) return;
      console.error(
        'session-start-maintenance: derived lanes forced through after ' +
          'consecutive skips (reason: continuity backlog)',
      );
    } else {
      try {
        const { clearDerivedLaneSkips } = await import('../dist/derived-lane-skip.js');
        clearDerivedLaneSkips(db);
      } catch { /* non-fatal */ }
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
      // Issue #41: a fact parked in General/Misc after bounded failures keeps
      // a category id, so the old `IS NULL` probe could never re-spawn the
      // worker for it. The shared selector reopens each parked fact exactly
      // once per (classifier policy, embedding generation) token.
      const { buildOntologyPendingClause, MAX_CLASSIFY_ATTEMPTS } = await import('../dist/ontology-selector.js');
      const { EMBEDDING_VERSION: ontologyEmbeddingVersion } = await import('../dist/embeddings.js');
      const ontoSelector = buildOntologyPendingClause({
        embeddingVersion: ontologyEmbeddingVersion,
        maxAttempts: MAX_CLASSIFY_ATTEMPTS,
        alias: 'f',
      });
      const pendingOnto = db.prepare(
        `SELECT 1 FROM facts f WHERE ${ontoSelector.clause} LIMIT 1`
      ).get(...ontoSelector.params);
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
