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

    // 🚨 Issue #175 — the LANE predicates are read BEFORE the budget is minted.
    //
    // The budget used to answer "is there pending work?" from the job queue
    // alone, but a `fact_extract` job is only ever created by the extraction
    // worker, and that worker only spawns while the budget is `active`. So once
    // the queue drained the wave was retired to `completed`, the worker never
    // spawned, nothing refilled the queue, and session-level pending extraction
    // stopped forever (seven sessions pending for five days on the work Mac).
    //
    // These two predicates sit one level ABOVE the queue, so they are computed
    // here, handed to the budget as `lanePending`, and reused by the lanes
    // below instead of being asked twice. Each is non-fatal on its own, exactly
    // as it was inside its lane.
    let pendingExtract = false;
    try {
      // The extraction worker's own pending predicate — never spawns for
      // phantom sessions it could not clear.
      const { sql: exSql, params: exParams } = pendingExtractionCoreQuery(
        getExtractionConfig(),
        'continuity',
      );
      pendingExtract = Boolean(db.prepare(`SELECT 1 FROM (${exSql}) LIMIT 1`).get(...exParams));
    } catch { /* non-fatal: extraction resumes on a later session */ }
    let pendingOnto = false;
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
      pendingOnto = Boolean(
        db.prepare(`SELECT 1 FROM facts f WHERE ${ontoSelector.clause} LIMIT 1`)
          .get(...ontoSelector.params),
      );
    } catch { /* non-fatal: ontology backfill resumes on a later session */ }

    // Issue #31 — one lookup, used to gate the MODEL lanes only.
    //
    // A rejected model selection must stop model work and nothing else. So this
    // gates the three derived model workers below, and deliberately does NOT
    // gate sync-export, the re-embed worker, reconcileFactTiers, or the
    // Continuity worker: none of those spend a model call, and the Continuity
    // worker also drains P0 conversation capture (it gates its own capsule lane
    // internally instead).
    //
    // 🚨 이슈 #177 항목 2 — 이 조회는 예산 발행 **이전**이어야 한다. 이전에는 발행
    // 뒤에 읽었기 때문에, 지속적인 hold 아래에서도 pending 레인이 있으면 매 wake 가
    // 15분 데드라인을 넘긴 run 을 새로 열었다(시간당 4개, 하루 96개). 그 run 을 쓸
    // 워커는 없다 — 바로 이 hold 가 아래 모델 레인 전부를 건너뛰기 때문이다.
    let configHeld = null;
    try {
      const { currentModelConfigHold } = await import('../dist/model-budget.js');
      configHeld = currentModelConfigHold(db);
    } catch { /* non-fatal: a pre-0.7.0 database has no hold table */ }
    const skipForConfigHold = (script) => {
      console.error(
        `session-start-maintenance: skipping ${script} — model work is held on a model ` +
          `setting ("${configHeld.model}"). Fix it and it resumes automatically: memex models show`,
      );
    };

    // One named maintenance wave is shared by detached sibling workers. The
    // durable row survives restarts. Conditional rollover preserves its ledger
    // and is limited by a cooldown plus the shared rolling attempt cap.
    const maintenanceBudget = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: process.env.MEMEX_MAINTENANCE_WAVE_ID || 'maintenance',
      // #175: the relation predicate is deliberately NOT part of this. It is
      // scoped to a budget id that does not exist yet, and a pending relation
      // target already lives in the queue the budget reads itself — so it is
      // both impossible to ask here and redundant if it were.
      //
      // The ontology lane counts only while it is enabled, for the same reason
      // `countPendingModelWork` skips unbound ontology work when it is off: a
      // disabled lane is an intentional local backlog nothing will ever drain,
      // and it must not hold the shared maintenance wave open forever.
      //
      // #177 item 2: while a model-config hold is live the wave is NOT held
      // open for the lanes. The hold already stops every model lane below
      // (`skipForConfigHold`), so a run minted for them is a run nothing can
      // ever use — and the rollover would repeat on every wake past the
      // deadline. The lanes stay pending and reopen the wave once the hold is
      // cleared, which is the state the operator has to fix anyway.
      //
      // This flag covers the LANE half only. The queue half lives one level
      // down, in `countPendingModelWork`, which no longer counts a `memory_jobs`
      // row carrying a `hold_reason` — otherwise a single held job reopened the
      // run here no matter what this caller passed (Codex review of #177).
      lanePending: configHeld
        ? false
        : Boolean(pendingExtract || (pendingOnto && isAutomaticOntologyEnabled())),
      // 🚨 이슈 #184 — `lanePending: false` 만으로는 부족하다.
      //
      // 큐 쪽 절반(`countPendingModelWork`)은 hold 중인 `memory_jobs` 는 빼지만
      // `model_work_targets` 의 pending 행에는 hold 표시가 없다. 그래서 hold 아래
      // 에서도 파생 target 이 매 15분 데드라인마다 새 run 을 열었다(시간당 4개,
      // 모델 호출 0회). 이 플래그는 hold 동안 wave 를 얼려, 위의 `skipForConfigHold`
      // 가 건너뛸 레인을 위해 run 이 열리는 일이 없게 한다.
      holdActive: Boolean(configHeld),
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

    const spawnDetached = (script, args = []) => {
      try {
        const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
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
        // `--mode=hook` (#162): a maintenance-spawned worker is hook-spawned
        // too, so it waits before opening the database and bounds its first
        // open instead of racing the SessionStart/inject hooks for the lock.
        spawnDetached('continuity-worker.js', ['--mode=hook']);
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
      if (configHeld) skipForConfigHold('fact-consolidate-worker.js');
      else spawnDetached('fact-consolidate-worker.js');
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

    // 3. Auto-resume ontology classification backfill. `pendingOnto` was read
    // before the budget was minted (#175); only the budget-scoped relation
    // probe below has to wait until the budget exists.
    try {
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
        if (configHeld) skipForConfigHold('backfill-ontology-worker.js');
        else spawnDetached('backfill-ontology-worker.js');
      }
    } catch { /* non-fatal */ }

    // 4. Auto-resume cross-project extraction backfill. `pendingExtract` is the
    // same session-level predicate that was handed to the budget as
    // `lanePending` (#175), so the gate below can now actually open.
    try {
      if (pendingExtract && maintenanceBudget.state === 'active') {
        if (configHeld) skipForConfigHold('backfill-extract-worker.js');
        else spawnDetached('backfill-extract-worker.js');
      }
    } catch { /* non-fatal */ }

  } catch (error) {
    console.error('session-start-maintenance: Error:', error instanceof Error ? error.message : error);
    // Non-fatal: another start/prompt retries after the short wake interval.
  } finally {
    db?.close();
  }
}

main();
