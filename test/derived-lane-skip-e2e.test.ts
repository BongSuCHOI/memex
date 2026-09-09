/**
 * Issue #43 — the real SessionStart maintenance script, run repeatedly against
 * a Continuity backlog that never drains.
 *
 * Before this change the script returned early on every invocation, so the
 * four derived lanes (consolidation, re-embed, ontology, extraction) never ran
 * once while a capsule job stayed claimable — and a deterministically failing
 * capsule job is re-created at every checkpoint.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ensureModelBudgetSchema } from '../src/model-budget.js';

const run = promisify(execFile);

function reexport(target: string): string {
  return `export * from ${JSON.stringify(pathToFileURL(path.resolve(target)).href)};`;
}

function sandbox(): { root: string; dbFile: string; spawnLog: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-derived-skip-'));
  const scripts = path.join(root, 'scripts');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(scripts);
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.copyFileSync('scripts/session-start-maintenance.js', path.join(scripts, 'session-start-maintenance.js'));

  const dbFile = path.join(root, 'state.sqlite');
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1,
      ontology_category_id TEXT, ontology_state TEXT, ontology_parked_version TEXT,
      ontology_attempts INTEGER NOT NULL DEFAULT 0,
      needs_consolidation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE memory_jobs (
      job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      target_id TEXT, checkpoint_id TEXT, available_at TEXT NOT NULL,
      lease_owner TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE continuity_telemetry (
      sample_id TEXT PRIMARY KEY, metric TEXT NOT NULL, value REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'count', project_id TEXT, session_id TEXT,
      dims_json TEXT NOT NULL DEFAULT '{}', recorded_at TEXT NOT NULL
    );
  `);
  ensureModelBudgetSchema(db);
  db.exec("INSERT INTO facts (id) VALUES ('pending-fact')");
  // A capsule job that is claimable RIGHT NOW, on every invocation.
  db.prepare(`INSERT INTO memory_jobs (job_id, kind, state, available_at, updated_at)
    VALUES ('capsule-1', 'capsule_update', 'pending', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`).run();
  db.close();

  const spawnLog = path.join(root, 'spawned.log');
  for (const worker of [
    'continuity-worker.js',
    'fact-consolidate-worker.js',
    'reembed-worker.js',
    'backfill-ontology-worker.js',
    'backfill-extract-worker.js',
  ]) {
    fs.writeFileSync(
      path.join(scripts, worker),
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(spawnLog)}, ${JSON.stringify(worker)} + '\\n');\n`,
    );
  }

  fs.writeFileSync(path.join(dist, 'model-budget.js'), reexport('dist/model-budget.js'));
  fs.writeFileSync(path.join(dist, 'derived-lane-skip.js'), reexport('dist/derived-lane-skip.js'));
  fs.writeFileSync(path.join(dist, 'chronicle.js'), reexport('dist/chronicle.js'));
  fs.writeFileSync(path.join(dist, 'ontology-selector.js'), reexport('dist/ontology-selector.js'));
  fs.writeFileSync(
    path.join(dist, 'db.js'),
    `import {createRequire} from 'node:module';
     const Database=createRequire(${JSON.stringify(path.resolve('package.json'))})('better-sqlite3');
     export function initDatabase(){const db=new Database(${JSON.stringify(dbFile)});db.pragma('busy_timeout=5000');return db;}`,
  );
  fs.writeFileSync(
    path.join(dist, 'reembed-selector.js'),
    "export const buildCategoryReembedPending=()=>({clause:'0',params:[]})," +
      "buildFactReembedPending=()=>({clause:'0',params:[]})," +
      "buildReembedPending=()=>({clause:'0',params:[]});",
  );
  fs.writeFileSync(
    path.join(dist, 'pending-extraction.js'),
    "export const getExtractionConfig=()=>({}),pendingExtractionCoreQuery=()=>({sql:'SELECT 1 WHERE 0',params:[]});",
  );
  fs.writeFileSync(path.join(dist, 'embeddings.js'), 'export const EMBEDDING_VERSION=3;');
  fs.writeFileSync(path.join(dist, 'observe-hook-event.js'), 'export function recordHookEvent(){}');
  fs.writeFileSync(path.join(dist, 'fact-management.js'), 'export function reconcileFactTiers(){}');
  return { root, dbFile, spawnLog };
}

/** The wake gate coalesces invocations for three minutes; open it explicitly. */
function reopenWake(dbFile: string) {
  const db = new Database(dbFile);
  try {
    db.prepare("UPDATE model_maintenance_wake SET wake_after = '2000-01-01T00:00:00.000Z'").run();
  } finally {
    db.close();
  }
}

function spawned(spawnLog: string): string[] {
  return fs.existsSync(spawnLog)
    ? fs.readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

describe('issue #43 — derived lanes are skipped, counted, and eventually released', () => {
  it('releases the derived lanes on the third consecutive continuity-backlog skip', async () => {
    const { root, dbFile, spawnLog } = sandbox();
    try {
      const script = path.join(root, 'scripts', 'session-start-maintenance.js');
      for (let invocation = 1; invocation <= 3; invocation++) {
        if (invocation > 1) reopenWake(dbFile);
        await run(process.execPath, [script], { timeout: 20_000 });
        // Detached children are unref'd; give them a moment to write.
        await new Promise((resolve) => setTimeout(resolve, 250));

        const seen = spawned(spawnLog);
        // P0/P1 always runs.
        expect(seen.filter((line) => line === 'continuity-worker.js').length).toBe(invocation);
        const derived = seen.filter((line) => line !== 'continuity-worker.js');
        if (invocation < 3) {
          expect(derived, `invocation ${invocation} must keep strict priority`).toEqual([]);
        } else {
          expect(derived.length).toBeGreaterThan(0);
          expect(derived).toContain('fact-consolidate-worker.js');
        }
      }

      const db = new Database(dbFile);
      try {
        const state = db
          .prepare('SELECT reason, consecutive, total_skips, last_forced_at FROM derived_lane_skips WHERE id = 1')
          .get() as {
            reason: string;
            consecutive: number;
            total_skips: number;
            last_forced_at: string | null;
          };
        expect(state.reason).toBe('continuity_backlog');
        expect(state.total_skips).toBe(3);
        expect(state.consecutive).toBe(0); // reset by the forced pass
        expect(state.last_forced_at).toBeTruthy();

        const samples = db
          .prepare("SELECT dims_json FROM continuity_telemetry WHERE metric = 'derived_lane_skipped' ORDER BY recorded_at")
          .all() as Array<{ dims_json: string }>;
        expect(samples.length).toBe(3);
        expect(JSON.parse(samples[0].dims_json).reason).toBe('continuity_backlog');
        expect(JSON.parse(samples[2].dims_json).forced).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
