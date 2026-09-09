import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { rowToFact } from './fact-db.js';
import { hardDeleteFact } from './fact-management.js';

type FindingCode = 'mixed-workstream-lineage' | 'foreign-workstream-lineage' | 'unproven-promotion' |
  'semantic-revalidation-needed' | 'legacy-identity' | 'missing-source' | 'privacy-resurrection' |
  'orphan-vector' | 'orphan-relation' | 'orphan-context';
export interface IntegrityFinding {
  id: string;
  code: FindingCode;
  disposition: 'review' | 'repairable';
  target: { table: string; id: string; exchangeId?: string; dependencyKind?: string };
  evidence: Record<string, unknown>;
}
export interface IntegrityReport {
  version: 1;
  planId: string;
  factsExamined: number;
  findings: IntegrityFinding[];
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tableExists = (db: Database.Database, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'").get(name);
function strings(raw: unknown): string[] | null {
  try { const values: unknown = JSON.parse(String(raw ?? '[]')); return Array.isArray(values) && values.every(v => typeof v === 'string') ? values : null; }
  catch { return null; }
}

/** Read-only, deterministic structural audit. Review candidates are not diagnoses. */
export function auditMemoryIntegrity(db: Database.Database): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  const add = (code: FindingCode, disposition: IntegrityFinding['disposition'], target: IntegrityFinding['target'], evidence: Record<string, unknown>) => {
    findings.push({ id: fingerprint([code, target, evidence]), code, disposition, target, evidence });
  };
  const rows = db.prepare('SELECT * FROM facts ORDER BY id').all() as Record<string, unknown>[];
  for (const row of rows) {
    const fact = rowToFact(row);
    const target = { table: 'facts', id: fact.id };
    const state = { semanticGeneration: fact.semantic_generation, lifecycleGeneration: fact.lifecycle_generation,
      active: fact.is_active, meaningHash: fingerprint(fact.fact), projectId: fact.project_id,
      workspaceId: fact.workspace_id, workstreamId: fact.workstream_id, promotionState: fact.promotion_state };
    const tombstone = db.prepare('SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?').get(fact.id) as { deleted_at: string; reason: string } | undefined;
    if (tombstone?.reason === 'source_conversation_excluded') add('privacy-resurrection', 'repairable', target, { ...state, tombstone });
    if (fact.scope_type === 'project' && (!fact.project_id || !fact.promotion_state || fact.promotion_state === 'legacy-project' ||
        (fact.promotion_state === 'workstream' && !fact.workstream_id) || (fact.promotion_state === 'workspace' && !fact.workspace_id))) {
      add('legacy-identity', 'review', target, state);
    }
    const sourceIds = strings(row.source_exchange_ids);
    if (!sourceIds) { add('missing-source', 'review', target, { ...state, reason: 'malformed lineage JSON' }); continue; }
    const sources = sourceIds.map(id => db.prepare('SELECT id, project_id, workspace_id, workstream_id, session_id FROM exchanges WHERE id = ?')
      .get(id) as { id: string; project_id: string | null; workspace_id: string | null; workstream_id: string | null; session_id: string | null } | undefined);
    const missing = sourceIds.filter((_, i) => !sources[i]);
    if (missing.length) add('missing-source', 'review', target, { ...state, sourceIds: missing });
    const workstreams = [...new Set(sources.flatMap(source => source?.workstream_id ? [source.workstream_id] : []))].sort();
    if (workstreams.length > 1) add('mixed-workstream-lineage', 'review', target, { ...state, workstreamIds: workstreams, sourceIds });
    if (fact.promotion_state === 'workstream' && workstreams.some(id => id !== fact.workstream_id)) {
      add('foreign-workstream-lineage', 'review', target, { ...state, workstreamIds: workstreams, sourceIds });
    }
    if (['decision', 'project-current'].includes(fact.promotion_state ?? '') && workstreams.length > 0) {
      const promotion = db.prepare("SELECT detail_json FROM project_identity_audit WHERE reason = 'explicit fact placement' ORDER BY created_at DESC").all() as Array<{ detail_json: string }>;
      const hasPromotion = promotion.some(row => {
        try { const detail = JSON.parse(row.detail_json); return detail.factId === fact.id && detail.promotionState === fact.promotion_state; }
        catch { return false; }
      });
      if (!hasPromotion) add('unproven-promotion', 'review', target, { ...state, workstreamIds: workstreams, reason: 'no recorded explicit promotion action; inspect original evidence and revisions' });
    }
    const revisions = db.prepare("SELECT id, new_fact, outcome_json FROM fact_revisions WHERE fact_id = ? AND actor IN ('consolidator','legacy') AND event_kind = 'CHANGED' ORDER BY id")
      .all(fact.id) as Array<{ id: string; new_fact: string; outcome_json: string | null }>;
    const unverified = revisions.filter(revision => {
      try { return !JSON.parse(revision.outcome_json ?? '{}').verified_input_fact_id; } catch { return true; }
    });
    if (unverified.length) add('semantic-revalidation-needed', 'review', target,
      { ...state, revisionIds: unverified.map(revision => revision.id), reason: 'historical automatic or unknown-origin rewrite; semantic overreach is NOT_PROVEN until original evidence review' });
  }
  for (const table of ['vec_facts', 'vec_facts_kr']) if (tableExists(db, table)) {
    const orphans = db.prepare(`SELECT v.id FROM ${table} v LEFT JOIN facts f ON f.id = v.id WHERE f.id IS NULL OR f.is_active = 0 ORDER BY v.id`).all() as Array<{ id: string }>;
    for (const row of orphans) add('orphan-vector', 'repairable', { table, id: row.id }, { reason: 'vector belongs to absent or inactive fact' });
  }
  if (tableExists(db, 'ontology_relations')) {
    const orphans = db.prepare(`SELECT r.* FROM ontology_relations r
      LEFT JOIN facts a ON a.id = r.source_fact_id LEFT JOIN facts b ON b.id = r.target_fact_id
      WHERE a.id IS NULL OR b.id IS NULL OR a.is_active = 0 OR b.is_active = 0 ORDER BY r.id`).all() as Array<Record<string, unknown>>;
    for (const row of orphans) add('orphan-relation', 'repairable', { table: 'ontology_relations', id: String(row.id) },
      { sourceId: row.source_fact_id, targetId: row.target_fact_id, fingerprint: fingerprint(row) });
  }
  if (tableExists(db, 'fact_context_dependencies')) {
    const orphans = db.prepare(`SELECT c.* FROM fact_context_dependencies c
      LEFT JOIN facts f ON f.id = c.fact_id LEFT JOIN exchanges e ON e.id = c.exchange_id
      WHERE f.id IS NULL OR e.id IS NULL ORDER BY c.fact_id, c.exchange_id, c.dependency_kind`).all() as Array<Record<string, unknown>>;
    for (const row of orphans) add('orphan-context', 'repairable', { table: 'fact_context_dependencies', id: String(row.fact_id),
      exchangeId: String(row.exchange_id), dependencyKind: String(row.dependency_kind) }, { fingerprint: fingerprint(row) });
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, planId: fingerprint(findings), factsExamined: rows.length, findings };
}

/** Preview selection is exact and replay-safe. Ambiguous meaning/identity is never repaired automatically. */
export function applyIntegrityRepairs(db: Database.Database, report: IntegrityReport, selectedIds: readonly string[]): { applied: string[]; alreadyApplied: string[] } {
  if (report.version !== 1 || report.planId !== fingerprint(report.findings)) throw new Error('invalid integrity preview fingerprint');
  const selected = [...new Set(selectedIds)].map(id => {
    const finding = report.findings.find(f => f.id === id);
    if (!finding || finding.disposition !== 'repairable') throw new Error('selection must name a repairable finding from the preview');
    return finding;
  });
  const tx = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS fact_integrity_repairs (
      finding_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, reason TEXT NOT NULL,
      target_json TEXT NOT NULL, evidence_json TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const current = new Map(auditMemoryIntegrity(db).findings.map(f => [f.id, f]));
    const result: { applied: string[]; alreadyApplied: string[] } = { applied: [], alreadyApplied: [] };
    for (const finding of selected) {
      if (db.prepare('SELECT 1 FROM fact_integrity_repairs WHERE finding_id = ?').get(finding.id)) {
        if (current.has(finding.id)) throw new Error('previously repaired damage has recurred; create a fresh recovery review');
        result.alreadyApplied.push(finding.id); continue;
      }
      if (!current.has(finding.id)) throw new Error('integrity preview is stale; audit again before applying');
      const { target } = finding;
      if (finding.code === 'privacy-resurrection') hardDeleteFact(db, target.id, { confirm: true });
      else if (finding.code === 'orphan-vector' && ['vec_facts', 'vec_facts_kr'].includes(target.table)) {
        db.prepare(`DELETE FROM ${target.table} WHERE id = ?`).run(target.id);
      } else if (finding.code === 'orphan-relation') db.prepare('DELETE FROM ontology_relations WHERE id = ?').run(target.id);
      else if (finding.code === 'orphan-context') db.prepare('DELETE FROM fact_context_dependencies WHERE fact_id = ? AND exchange_id = ? AND dependency_kind = ?')
        .run(target.id, target.exchangeId, target.dependencyKind);
      else throw new Error('unsupported integrity repair');
      db.prepare('INSERT INTO fact_integrity_repairs VALUES (?, ?, ?, ?, ?, ?)')
        .run(finding.id, report.planId, finding.code, JSON.stringify(target), JSON.stringify(finding.evidence), new Date().toISOString());
      result.applied.push(finding.id);
    }
    const after = auditMemoryIntegrity(db);
    if (after.findings.some(f => result.applied.includes(f.id))) throw new Error('repair postcondition failed');
    return result;
  });
  return tx.immediate();
}
