/**
 * Issue #45 — local meaning receipts for facts that never got one.
 *
 * Observed in the audited data root: 127 facts, 9 `fact_evidence_receipts`
 * rows (all `method = 'extractor'`, all on `promotion_state = 'workstream'`
 * facts extracted after the commit that started binding evidence). The other
 * 118 had none, and there was no backfill path — `recordLocalMeaningEvidence`
 * only ran at extraction/edit time, so a fact that missed it missed it
 * forever.
 *
 * The consequence is not cosmetic: `hasLocalMeaningEvidence` gates automatic
 * consolidation in three places, so 93% of that corpus was silently excluded
 * from consolidation (visible to the user only as "duplicate facts keep
 * piling up") and loses every sync tie-break.
 *
 * The same audit confirmed the repair is free: 0 facts had empty
 * `source_exchange_ids` and all 135 referenced exchange ids resolved, so every
 * missing receipt could be rebuilt from local rows with NO model call.
 */
import type Database from 'better-sqlite3';
import { recordLocalMeaningEvidence } from './fact-policy.js';

export interface EvidenceBackfillResult {
  /** Facts examined this run. */
  scanned: number;
  /** Receipts actually written. */
  recorded: number;
  /**
   * Facts whose receipt could not be rebuilt (evidence changed under us
   * between selection and the write). Counted, never silent — that silence is
   * what let 118 missing receipts go unnoticed.
   */
  failed: number;
}

/**
 * Active facts that carry source evidence but have no CURRENT local receipt.
 *
 * A receipt is "current" only when it matches the fact's semantic generation
 * and is not demoted to peer authority. The exact-hash and source-snapshot
 * checks live in `hasLocalMeaningEvidence` (not expressible in SQL); this
 * predicate is the cheap superset status and the worker share, so both report
 * the same number.
 */
export function missingLocalEvidenceClause(alias = 'f'): string {
  return `${alias}.is_active = 1
    AND ${alias}.source_exchange_ids IS NOT NULL
    AND ${alias}.source_exchange_ids NOT IN ('', '[]')
    AND NOT EXISTS (
      SELECT 1 FROM fact_evidence_receipts r
      WHERE r.fact_id = ${alias}.id
        AND r.semantic_generation = ${alias}.semantic_generation
        AND r.authority IS NULL
    )`;
}

/** …of those, the ones whose every source exchange still resolves locally. */
export function repairableLocalEvidenceClause(alias = 'f'): string {
  return `${missingLocalEvidenceClause(alias)}
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${alias}.source_exchange_ids) je
      WHERE NOT EXISTS (SELECT 1 FROM exchanges e WHERE e.id = je.value)
    )`;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined
  );
}

/**
 * Hand-rolled fixture schemas and pre-receipt databases exist; every entry
 * point degrades to "nothing to report" rather than throwing inside read-only
 * status.
 */
export function hasEvidenceSchema(db: Database.Database): boolean {
  if (!tableExists(db, 'facts') || !tableExists(db, 'fact_evidence_receipts')) return false;
  const factColumns = new Set(
    (db.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!factColumns.has('source_exchange_ids') || !factColumns.has('semantic_generation')) return false;
  const receiptColumns = new Set(
    (db.prepare('PRAGMA table_info(fact_evidence_receipts)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  return receiptColumns.has('authority') && receiptColumns.has('semantic_generation');
}

/** Count for `memex status`; 0 when the tables do not exist yet. */
export function countFactsWithoutLocalEvidence(db: Database.Database): number {
  if (!hasEvidenceSchema(db)) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM facts f WHERE ${missingLocalEvidenceClause('f')}`)
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** …of which the model-free backfill can actually repair right now. */
export function countRepairableLocalEvidence(db: Database.Database): number {
  if (!hasEvidenceSchema(db) || !tableExists(db, 'exchanges')) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM facts f WHERE ${repairableLocalEvidenceClause('f')}`)
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Rebuild missing receipts. Model-free and resumable: the receipt row itself
 * is the resume marker, so an interrupted run simply re-selects the rest.
 */
export function backfillEvidenceReceipts(
  db: Database.Database,
  options: { limit?: number } = {},
): EvidenceBackfillResult {
  const result: EvidenceBackfillResult = { scanned: 0, recorded: 0, failed: 0 };
  if (!hasEvidenceSchema(db) || !tableExists(db, 'exchanges')) return result;
  const limit = Math.max(0, Math.trunc(options.limit ?? 1000));
  if (limit === 0) return result;

  const rows = db
    .prepare(
      `SELECT f.id, f.fact, f.source_exchange_ids
       FROM facts f
       WHERE ${repairableLocalEvidenceClause('f')}
       ORDER BY f.created_at, f.id
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; fact: string; source_exchange_ids: string }>;

  for (const row of rows) {
    result.scanned++;
    let sourceIds: string[];
    try {
      const parsed = JSON.parse(row.source_exchange_ids) as unknown;
      sourceIds = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      result.failed++;
      continue;
    }
    if (sourceIds.length === 0) {
      result.failed++;
      continue;
    }
    // 'extractor': the meaning came from the extraction pipeline and the
    // receipt is rebuilt from exactly the sources it recorded. A rebuilt
    // receipt asserts nothing new — it re-derives what the local rows say.
    if (recordLocalMeaningEvidence(db, row.id, row.fact, 'extractor', sourceIds)) result.recorded++;
    else result.failed++;
  }
  return result;
}
