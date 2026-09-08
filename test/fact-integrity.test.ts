import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { initDatabase, insertExchange } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { auditMemoryIntegrity, applyIntegrityRepairs } from '../src/fact-integrity.js';
import { recordFactTombstone } from '../src/fact-management.js';
import { createRelation } from '../src/ontology-db.js';
import { ensureSessionMemoryState } from '../src/continuity-core.js';
import { createWorkstream } from '../src/continuity-identity.js';
import { recordChronicleEvent } from '../src/chronicle.js';

let db: Database.Database;
let root: string;
const embedding = new Array(384).fill(0.1);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-integrity-audit-'));
  process.env.TEST_DB_PATH = path.join(root, 'db.sqlite');
  process.env.MEMEX_HOME = path.join(root, 'home');
  db = initDatabase();
});
afterEach(() => {
  db.close(); delete process.env.TEST_DB_PATH; delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});
function globalFact(text: string): string {
  return insertFact(db, { fact: text, category: 'knowledge', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding });
}

it('audit is deterministic, read-only and labels semantic uncertainty for review', () => {
  const id = insertFact(db, { fact: 'A broad historical statement', category: 'knowledge', scope_type: 'project', scope_project: '/legacy', source_exchange_ids: ['missing-source'], embedding });
  recordChronicleEvent(db, { factId: id, kind: 'CHANGED', actor: 'consolidator', newValue: 'A broad historical statement', projectionApplied: true });
  const before = db.prepare('SELECT total_changes() n').get();
  const first = auditMemoryIntegrity(db);
  const second = auditMemoryIntegrity(db);
  expect(second).toEqual(first);
  expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
  expect(first.findings.map(f => f.code).sort()).toEqual(['legacy-identity', 'missing-source', 'semantic-revalidation-needed']);
  expect(first.findings.every(f => f.disposition === 'review')).toBe(true);
  expect(() => applyIntegrityRepairs(db, first, [first.findings[0].id])).toThrow('repairable finding');
  expect(db.prepare('SELECT fact FROM facts WHERE id = ?').get(id)).toEqual({ fact: 'A broad historical statement' });
});

it('reports mixed workstreams and unproven project-wide promotion without mapping by path', () => {
  const s = ensureSessionMemoryState(db, { sessionId: 'audit-a', project: '/audit/shared' });
  const b = createWorkstream(db, { projectId: s.projectId, workspaceId: s.workspaceId, projectPath: '/audit/shared', ownerSessionId: 'audit-b', workstreamId: 'audit-b-workstream' });
  for (const [id, workstream] of [['a', s.workstreamId], ['b', b]]) {
    insertExchange(db, { id, project: '/audit/shared', cwd: '/audit/shared', userMessage: 'Use SQLite for this experiment', assistantMessage: '',
      timestamp: '2026-09-01T00:00:00.000Z', archivePath: path.join(root, `${id}.jsonl`), lineStart: 1, lineEnd: 2 }, embedding);
    db.prepare('UPDATE exchanges SET project_id = ?, workspace_id = ?, workstream_id = ? WHERE id = ?').run(s.projectId, s.workspaceId, workstream, id);
  }
  const id = insertFact(db, { fact: 'Every deployment uses SQLite', category: 'knowledge', scope_type: 'project', scope_project: '/audit/shared',
    project_id: s.projectId, promotion_state: 'project-current', promotion_evidence: 'validated', source_exchange_ids: [], embedding });
  db.prepare("UPDATE facts SET source_exchange_ids = '[\"a\",\"b\"]', consolidated_count = 2 WHERE id = ?").run(id);
  const report = auditMemoryIntegrity(db);
  expect(report.findings.map(f => f.code).sort()).toEqual(['mixed-workstream-lineage', 'unproven-promotion']);
  expect(report.findings.every(f => f.disposition === 'review')).toBe(true);
});

it('repairs only selected derived orphans, logs atomically and is idempotent', () => {
  const a = globalFact('Inactive first fact'); const b = globalFact('Active second fact');
  createRelation(db, a, 'SUPPORTS', b);
  db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(a);
  const report = auditMemoryIntegrity(db);
  const selected = report.findings.filter(f => f.disposition === 'repairable').map(f => f.id);
  expect(selected).toHaveLength(2);
  const first = applyIntegrityRepairs(db, report, selected);
  expect(first.applied.sort()).toEqual([...selected].sort());
  expect(auditMemoryIntegrity(db).findings).toEqual([]);
  expect(applyIntegrityRepairs(db, report, selected)).toEqual({ applied: [], alreadyApplied: selected });
  expect(db.prepare('SELECT COUNT(*) n FROM facts').get()).toEqual({ n: 2 });
  expect(db.prepare('SELECT COUNT(*) n FROM fact_integrity_repairs').get()).toEqual({ n: 2 });
});

it('rejects a stale preview rather than removing a newly restored vector', () => {
  const id = globalFact('Restorable fact');
  db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(id);
  const report = auditMemoryIntegrity(db);
  db.prepare('UPDATE facts SET is_active = 1 WHERE id = ?').run(id);
  expect(() => applyIntegrityRepairs(db, report, report.findings.map(f => f.id))).toThrow('preview is stale');
  expect(db.prepare('SELECT COUNT(*) n FROM vec_facts').get()).toEqual({ n: 1 });
});

it('enforces a terminal privacy tombstone and never downgrades its reason', () => {
  const id = globalFact('Previously excluded fact that a stale writer recreated');
  recordChronicleEvent(db, { factId: id, kind: 'ASSERTED', actor: 'extractor', newValue: 'Private text', projectionApplied: true });
  recordFactTombstone(db, id, 'source_conversation_excluded', '2026-01-01T00:00:00.000Z');
  recordFactTombstone(db, id, 'hard_delete', '2026-02-01T00:00:00.000Z');
  const report = auditMemoryIntegrity(db);
  const selected = report.findings.filter(f => f.code === 'privacy-resurrection').map(f => f.id);
  expect(selected).toHaveLength(1);
  applyIntegrityRepairs(db, report, selected);
  expect(db.prepare('SELECT * FROM facts WHERE id = ?').get(id)).toBeUndefined();
  expect(db.prepare('SELECT reason FROM fact_tombstones WHERE fact_id = ?').get(id)).toEqual({ reason: 'source_conversation_excluded' });
  expect(db.prepare('SELECT reason FROM chronicle_tombstones').all()).toEqual([{ reason: 'source_conversation_excluded' }]);
  expect(applyIntegrityRepairs(db, report, selected).alreadyApplied).toEqual(selected);
});

it('rolls back repairs and their ledger on a later write failure', () => {
  const a = globalFact('Inactive first fact'); const b = globalFact('Inactive second fact');
  db.prepare('UPDATE facts SET is_active = 0 WHERE id IN (?, ?)').run(a, b);
  const report = auditMemoryIntegrity(db);
  db.exec(`CREATE TABLE fact_integrity_repairs (finding_id TEXT PRIMARY KEY, plan_id TEXT, reason TEXT, target_json TEXT, evidence_json TEXT, applied_at TEXT);
    CREATE TRIGGER fail_repair_ledger BEFORE INSERT ON fact_integrity_repairs BEGIN SELECT RAISE(ABORT, 'ledger failure'); END;`);
  expect(() => applyIntegrityRepairs(db, report, report.findings.map(f => f.id))).toThrow('ledger failure');
  expect(db.prepare('SELECT COUNT(*) n FROM vec_facts').get()).toEqual({ n: 2 });
  expect(db.prepare('SELECT COUNT(*) n FROM fact_integrity_repairs').get()).toEqual({ n: 0 });
});
