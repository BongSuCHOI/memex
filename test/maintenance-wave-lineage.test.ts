/**
 * Issue #42 — the automatic maintenance wave id grew forever.
 *
 * Observed in the audited data root (`model_work_budgets`, 3 rows):
 *
 *   fe4a61c1… | maintenance                                       | exhausted | automatic 1
 *   15af9e61… | maintenance:run:f11b5103-…                        | exhausted | automatic 1
 *   9ea87280… | maintenance:run:f11b5103-…:run:7344dd28-…         | active    | automatic 0
 *
 * 41 characters per rollover (`:run:` + a uuid), no cap and no delete path.
 * The deepest row carries automatic = 0, which is the fingerprint of the WORKER
 * path: the SessionStart hook exported the already-expanded id through
 * MEMEX_MAINTENANCE_WAVE_ID, and the detached worker appended to it again while
 * ALSO narrowing its lineage lookup to that prefix — detaching itself from the
 * shared rolling attempt cap.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureModelBudgetSchema,
  getOrCreateAutomaticMaintenanceModelBudget,
  getOrCreateWorkerModelBudget,
  rootWaveIdOf,
} from '../src/model-budget.js';

const ROOT = 'maintenance';
const RUN_A = 'f11b5103-f18a-4a30-a633-890e5a4713cf';
const RUN_B = '7344dd28-0819-4a0a-98ae-c31cd2e84b10';
const NESTED_1 = `${ROOT}:run:${RUN_A}`;
const NESTED_2 = `${NESTED_1}:run:${RUN_B}`;

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1,
      ontology_category_id TEXT, needs_consolidation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memory_jobs (
      job_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'fact_extract',
      state TEXT NOT NULL, target_id TEXT, checkpoint_id TEXT,
      available_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL
    );
  `);
  ensureModelBudgetSchema(db);
  // Rebuild the exact pre-migration rows, then strip the new columns so the
  // migration has to derive the lineage from the strings alone.
  const insert = db.prepare(`
    INSERT INTO model_work_budgets
      (budget_id, parent_wave_id, root_wave_id, run_seq, state, max_attempts, reserved_attempts,
       max_input_chars, max_output_chars, deadline_at, created_at, updated_at, automatic)
    VALUES (?, ?, NULL, NULL, ?, 8, 0, 1000, 1000, NULL, ?, ?, ?)
  `);
  insert.run('fe4a61c1', ROOT, 'exhausted', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1);
  insert.run('15af9e61', NESTED_1, 'exhausted', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1);
  insert.run('9ea87280', NESTED_2, 'active', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 0);
  db.prepare(`INSERT INTO memory_jobs (job_id, state, available_at, updated_at)
    VALUES ('j1', 'pending', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`).run();
  // ensureModelBudgetSchema added memory_jobs.maintenance_wave_id above.
  db.prepare('UPDATE memory_jobs SET maintenance_wave_id = ? WHERE job_id = ?').run(NESTED_2, 'j1');
  return db;
}

/** The v0.5.2 table shape: no root_wave_id / run_seq columns at all. */
function v052Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE model_work_budgets (
      budget_id TEXT PRIMARY KEY,
      parent_wave_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active'
        CHECK(state IN ('active','exhausted','completed','cancelled')),
      max_attempts INTEGER NOT NULL CHECK(max_attempts >= 0),
      reserved_attempts INTEGER NOT NULL DEFAULT 0
        CHECK(reserved_attempts >= 0 AND reserved_attempts <= max_attempts),
      max_input_chars INTEGER NOT NULL CHECK(max_input_chars >= 0),
      max_output_chars INTEGER NOT NULL CHECK(max_output_chars >= 0),
      deadline_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(parent_wave_id)
    );
  `);
  return db;
}

function insertWave(db: Database.Database, budgetId: string, parentWaveId: string, at: string): void {
  db.prepare(`
    INSERT INTO model_work_budgets
      (budget_id, parent_wave_id, max_attempts, max_input_chars, max_output_chars, created_at, updated_at)
    VALUES (?, ?, 6, 1000, 1000, ?, ?)
  `).run(budgetId, parentWaveId, at, at);
}

function lineageIndexExists(db: Database.Database): boolean {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_model_work_budgets_run') !== undefined
  );
}

function waves(db: Database.Database): Array<{ parent: string; root: string; seq: number }> {
  return (
    db
      .prepare('SELECT parent_wave_id, root_wave_id, run_seq FROM model_work_budgets ORDER BY created_at, budget_id')
      .all() as Array<{ parent_wave_id: string; root_wave_id: string; run_seq: number }>
  ).map((row) => ({ parent: row.parent_wave_id, root: row.root_wave_id, seq: row.run_seq }));
}

describe('issue #42 — maintenance wave lineage lives in columns', () => {
  it('normalizes the observed 3-level nesting without losing the rolling-cap linkage', () => {
    const db = legacyDb();
    try {
      ensureModelBudgetSchema(db); // idempotent migration
      expect(waves(db)).toEqual([
        { parent: 'maintenance', root: ROOT, seq: 1 },
        { parent: 'maintenance#2', root: ROOT, seq: 2 },
        { parent: 'maintenance#3', root: ROOT, seq: 3 },
      ]);
      // Every run stays in ONE lineage, which is what the shared rolling
      // attempt cap is computed over.
      expect(
        Number(
          (db.prepare('SELECT COUNT(*) AS n FROM model_work_budgets WHERE root_wave_id = ?').get(ROOT) as {
            n: number;
          }).n,
        ),
      ).toBe(3);
      // The queue's wave marker follows the rewritten name.
      expect(
        (db.prepare('SELECT maintenance_wave_id FROM memory_jobs WHERE job_id = ?').get('j1') as {
          maintenance_wave_id: string;
        }).maintenance_wave_id,
      ).toBe('maintenance#3');

      // Re-running changes nothing.
      ensureModelBudgetSchema(db);
      expect(waves(db).map((w) => w.parent)).toEqual(['maintenance', 'maintenance#2', 'maintenance#3']);
    } finally {
      db.close();
    }
  });

  it('resolves a legacy nested id to the same lineage instead of forking it', () => {
    const db = legacyDb();
    try {
      ensureModelBudgetSchema(db);
      expect(rootWaveIdOf(NESTED_2)).toBe(ROOT);
      expect(rootWaveIdOf('maintenance#7')).toBe(ROOT);
      expect(rootWaveIdOf(ROOT)).toBe(ROOT);

      // A worker that inherited the OLD expanded id via the environment must
      // still land on the existing lineage, not mint a private one.
      const budget = getOrCreateWorkerModelBudget(db, { stage: 'ontology', parentWaveId: NESTED_2 });
      expect(budget.rootWaveId).toBe(ROOT);
      expect(
        Number((db.prepare('SELECT COUNT(*) AS n FROM model_work_budgets').get() as { n: number }).n),
      ).toBe(3);
    } finally {
      db.close();
    }
  });

  it('rolls over with a bounded run number and hands children the ROOT id', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE facts (
          id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1,
          ontology_category_id TEXT, needs_consolidation INTEGER NOT NULL DEFAULT 0
        );
      `);
      ensureModelBudgetSchema(db);
      db.exec("INSERT INTO facts(id) VALUES ('pending')");

      const start = new Date('2026-09-09T00:00:00.000Z');
      const limits = { maxAttempts: 1, deadlineAt: null };
      const first = getOrCreateAutomaticMaintenanceModelBudget(db, { now: start, limits });
      expect(first.parentWaveId).toBe('maintenance');
      expect(first.rootWaveId).toBe('maintenance');
      expect(first.runSeq).toBe(1);

      // Spend it, then roll over an hour later (past the cooldown).
      db.prepare(`INSERT INTO model_work_attempts
        (attempt_id, budget_id, attempt_no, stage, state, started_at, finished_at)
        VALUES ('a1', ?, 1, 'ontology', 'completed', ?, ?)`)
        .run(first.budgetId, start.toISOString(), start.toISOString());
      db.prepare("UPDATE model_work_budgets SET state = 'exhausted' WHERE budget_id = ?").run(first.budgetId);

      const later = new Date(start.getTime() + 61 * 60_000);
      const second = getOrCreateAutomaticMaintenanceModelBudget(db, {
        now: later,
        limits: { maxAttempts: 8, deadlineAt: null },
      });
      expect(second.budgetId).not.toBe(first.budgetId);
      // Bounded: the name grew by 2 characters, not 41, and carries no uuid.
      expect(second.parentWaveId).toBe('maintenance#2');
      expect(second.parentWaveId).not.toContain(':run:');
      expect(second.rootWaveId).toBe('maintenance');
      expect(second.runSeq).toBe(2);
      // What the hook exports to detached children is the ROOT, so the next
      // worker cannot deepen the chain.
      expect(rootWaveIdOf(second.parentWaveId)).toBe('maintenance');
    } finally {
      db.close();
    }
  });
});

/**
 * Issue #72 — observed on a v0.5.2-shaped table holding both names:
 *
 *   A (both names present before the migration):
 *     MIGRATION FAILED -> UNIQUE constraint failed:
 *       model_work_budgets.root_wave_id, model_work_budgets.run_seq
 *   C (0.6.1-migrated, then an old worker appends `:run:` to `maintenance#2`):
 *     MIGRATION FAILED -> UNIQUE constraint failed: ...
 *
 * `ensureModelBudgetSchema` runs unguarded from `initDatabase()` (src/db.ts),
 * so the rolled-back migration threw on every DB open: CLI, hooks and UI.
 */
describe('issue #72 — mixed-version wave names cannot wedge the migration', () => {
  const MIXED_RUN = '7344dd28-0819-4a0a-98ae-c31cd2e84b10';

  it('splits `maintenance#2` and `maintenance#2:run:<uuid>` onto distinct run numbers', () => {
    const db = v052Db();
    try {
      insertWave(db, 'b-0', 'maintenance#2', '2026-01-01T00:00:00.000Z');
      insertWave(db, 'b-1', `maintenance#2:run:${MIXED_RUN}`, '2026-01-02T00:00:00.000Z');

      expect(() => ensureModelBudgetSchema(db)).not.toThrow();
      expect(waves(db)).toEqual([
        { parent: 'maintenance#2', root: ROOT, seq: 2 },
        { parent: 'maintenance#3', root: ROOT, seq: 3 },
      ]);
      // Same lineage, so the rolling attempt cap still covers both runs.
      expect(lineageIndexExists(db)).toBe(true);

      // Idempotent.
      expect(() => ensureModelBudgetSchema(db)).not.toThrow();
      expect(waves(db).map((w) => w.seq)).toEqual([2, 3]);
    } finally {
      db.close();
    }
  });

  it('accepts a `:run:` row appended to an already-migrated compact name', () => {
    const db = v052Db();
    try {
      insertWave(db, 'b-0', ROOT, '2026-01-01T00:00:00.000Z');
      ensureModelBudgetSchema(db); // first upgrade: maintenance -> (maintenance, 1)
      insertWave(db, 'b-1', 'maintenance#2', '2026-01-02T00:00:00.000Z');
      db.prepare("UPDATE model_work_budgets SET root_wave_id = ?, run_seq = 2 WHERE budget_id = 'b-1'").run(ROOT);
      // A v0.5.2 copy still on PATH rolls over from the compact name.
      insertWave(db, 'b-2', `maintenance#2:run:${MIXED_RUN}`, '2026-01-03T00:00:00.000Z');

      expect(() => ensureModelBudgetSchema(db)).not.toThrow();
      expect(waves(db)).toEqual([
        { parent: 'maintenance', root: ROOT, seq: 1 },
        { parent: 'maintenance#2', root: ROOT, seq: 2 },
        { parent: 'maintenance#3', root: ROOT, seq: 3 },
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps the DB openable when the lineage index cannot be created', () => {
    const db = v052Db();
    try {
      insertWave(db, 'b-0', 'wave-a', '2026-01-01T00:00:00.000Z');
      insertWave(db, 'b-1', 'wave-b', '2026-01-02T00:00:00.000Z');
      ensureModelBudgetSchema(db);
      // Force a pair the index can never accept, the way a mixed-version
      // rollover used to: the migration leaves these rows alone (both lineage
      // columns are already filled and neither name carries `:run:`).
      db.exec('DROP INDEX idx_model_work_budgets_run');
      db.prepare("UPDATE model_work_budgets SET root_wave_id = 'wave', run_seq = 9").run();

      expect(() => ensureModelBudgetSchema(db)).not.toThrow();
      expect(lineageIndexExists(db)).toBe(false);
      // The lineage columns survive, so the rolling cap still reads.
      expect(
        Number(
          (db.prepare('SELECT COUNT(*) AS n FROM model_work_budgets WHERE root_wave_id = ?').get('wave') as {
            n: number;
          }).n,
        ),
      ).toBe(2);
    } finally {
      db.close();
    }
  });
});
