/**
 * Issue #45 — `fact_evidence_receipts` had 9 rows for 127 facts.
 *
 * The audited data root:
 *   SELECT count(*) FROM facts;                    -- 127
 *   SELECT count(*) FROM fact_evidence_receipts;   -- 9   (all method='extractor')
 *   -- the 9 are exactly the promotion_state='workstream' facts extracted after
 *   -- the commit that started binding evidence; the other 118 predate it.
 *   -- 0 facts with empty source_exchange_ids, and all 135 referenced exchange
 *   -- ids resolve → every missing receipt is rebuildable with NO model call.
 *
 * Consequence: `hasLocalMeaningEvidence` gates automatic consolidation in
 * three places, so 118/127 facts were silently excluded from it and lose every
 * sync tie-break — and nothing reported that anywhere.
 */
import { describe, expect, it, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../src/db.js';
import {
  backfillEvidenceReceipts,
  countFactsWithoutLocalEvidence,
  countRepairableLocalEvidence,
} from '../src/evidence-backfill.js';
import { hasLocalMeaningEvidence, recordLocalMeaningEvidence } from '../src/fact-policy.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-receipts-'));
  dirs.push(dir);
  return initDatabase({ dbPath: path.join(dir, 'db.sqlite') });
}

const NOW = '2026-01-01T00:00:00.000Z';

function addExchange(db: Database.Database, id: string) {
  db.prepare(`INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, cwd)
    VALUES (?, '/tmp/p', ?, 'q', 'a', '/tmp/a.jsonl', 1, 2, 's1', '/tmp/p')`).run(id, NOW);
}

function addFact(db: Database.Database, id: string, sourceIds: string[]) {
  db.prepare(`INSERT INTO facts
      (id, fact, category, scope_type, source_exchange_ids, created_at, updated_at,
       semantic_updated_at, lifecycle_updated_at)
    VALUES (?, ?, 'decision', 'global', ?, ?, ?, ?, ?)`)
    .run(id, `fact ${id}`, JSON.stringify(sourceIds), NOW, NOW, NOW, NOW);
}

function factRow(db: Database.Database, id: string) {
  const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown>;
  return {
    id: String(row.id),
    fact: String(row.fact),
    semantic_generation: Number(row.semantic_generation),
  } as never;
}

describe('issue #45 — local evidence receipts are backfillable and visible', () => {
  it('rebuilds every missing receipt without a model call', () => {
    const db = freshDb();
    try {
      // 9 facts already verified at extraction time, 118 without a receipt —
      // the observed 127/9 split, scaled down but in the same proportions.
      for (let i = 0; i < 20; i++) addExchange(db, `e${i}`);
      for (let i = 0; i < 20; i++) addFact(db, `f${i}`, [`e${i}`]);
      for (let i = 0; i < 3; i++) {
        expect(recordLocalMeaningEvidence(db, `f${i}`, `fact f${i}`, 'extractor', [`e${i}`])).toBe(true);
      }
      expect(countFactsWithoutLocalEvidence(db)).toBe(17);
      expect(countRepairableLocalEvidence(db)).toBe(17);

      const result = backfillEvidenceReceipts(db);
      expect(result).toEqual({ scanned: 17, recorded: 17, failed: 0 });
      expect(countFactsWithoutLocalEvidence(db)).toBe(0);
      // The rebuilt receipts are real local verification, not a rubber stamp.
      expect(hasLocalMeaningEvidence(db, factRow(db, 'f19'))).toBe(true);

      // Idempotent: a second run has nothing left to do.
      expect(backfillEvidenceReceipts(db)).toEqual({ scanned: 0, recorded: 0, failed: 0 });
    } finally {
      db.close();
    }
  });

  it('never touches a fact whose source exchanges no longer resolve', () => {
    const db = freshDb();
    try {
      addExchange(db, 'e-live');
      addFact(db, 'f-live', ['e-live']);
      addFact(db, 'f-dangling', ['e-gone']);

      expect(countFactsWithoutLocalEvidence(db)).toBe(2);
      expect(countRepairableLocalEvidence(db)).toBe(1); // only the resolvable one

      const result = backfillEvidenceReceipts(db);
      expect(result.recorded).toBe(1);
      expect(result.failed).toBe(0);
      // The dangling fact stays counted, honestly, instead of being "fixed".
      expect(countFactsWithoutLocalEvidence(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('reports a failure instead of returning silently', () => {
    const db = freshDb();
    try {
      addExchange(db, 'e1');
      addFact(db, 'f1', ['e1']);
      // Text mismatch: the caller asserts a meaning the row does not hold.
      expect(recordLocalMeaningEvidence(db, 'f1', 'a different meaning', 'extractor', ['e1'])).toBe(false);
      // Unresolvable source.
      expect(recordLocalMeaningEvidence(db, 'f1', 'fact f1', 'extractor', ['e-gone'])).toBe(false);
      // Unknown fact.
      expect(recordLocalMeaningEvidence(db, 'nope', 'x', 'extractor', ['e1'])).toBe(false);
      // The happy path still returns true.
      expect(recordLocalMeaningEvidence(db, 'f1', 'fact f1', 'extractor', ['e1'])).toBe(true);
    } finally {
      db.close();
    }
  });

  it('treats a peer-authority receipt as absent local evidence and re-earns it', () => {
    const db = freshDb();
    try {
      addExchange(db, 'e1');
      addFact(db, 'f1', ['e1']);
      recordLocalMeaningEvidence(db, 'f1', 'fact f1', 'extractor', ['e1']);
      expect(countFactsWithoutLocalEvidence(db)).toBe(0);

      // What sync-import now does on a remote semantic win: demote, not delete.
      db.prepare("UPDATE fact_evidence_receipts SET authority = 'peer-authority' WHERE fact_id = 'f1'").run();
      expect(hasLocalMeaningEvidence(db, factRow(db, 'f1'))).toBe(false);
      expect(countFactsWithoutLocalEvidence(db)).toBe(1);
      // The receipt row survives, so what broke the binding is still on record.
      expect(
        Number((db.prepare('SELECT COUNT(*) AS n FROM fact_evidence_receipts').get() as { n: number }).n),
      ).toBe(1);

      // The backfill promotes it back to local verification.
      expect(backfillEvidenceReceipts(db).recorded).toBe(1);
      expect(
        (db.prepare('SELECT authority FROM fact_evidence_receipts WHERE fact_id = ?').get('f1') as {
          authority: string | null;
        }).authority,
      ).toBeNull();
      expect(hasLocalMeaningEvidence(db, factRow(db, 'f1'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('honours the per-run cap so one invocation stays bounded', () => {
    const db = freshDb();
    try {
      for (let i = 0; i < 5; i++) {
        addExchange(db, `e${i}`);
        addFact(db, `f${i}`, [`e${i}`]);
      }
      expect(backfillEvidenceReceipts(db, { limit: 2 })).toEqual({ scanned: 2, recorded: 2, failed: 0 });
      expect(countFactsWithoutLocalEvidence(db)).toBe(3);
    } finally {
      db.close();
    }
  });
});
