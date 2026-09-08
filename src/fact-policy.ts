import type Database from 'better-sqlite3';
import type { Fact, FactRelation } from './types.js';
import { createHash } from 'node:crypto';
export const SUBJECT_KEY_PATTERN = /^(state|decision|constraint|preference|pattern)(\.[a-z0-9_]{1,40}){1,4}$/;
export function isSemanticSubjectKey(key: string | null | undefined): boolean {
  return !!key && SUBJECT_KEY_PATTERN.test(key) && !/\.fact\.[0-9a-f-]{36}$/.test(key);
}

export class StaleFactMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleFactMutationError';
  }
}

/** Explicit writer intent, separate from the caller's broader ReadScope. */
export interface MutationPolicy {
  kind: 'user-correction' | 'verified-extraction' | 'consolidation' | 'replicated' | 'identity';
  targets: ReadonlyArray<{ id: string; state: string | null }>;
  sources?: SourceSnapshot;
  /** Automatic text changes may only adopt this already verified input. */
  verifiedText?: string;
}

function mutationState(db: Database.Database, id: string, kind: MutationPolicy['kind']): string | null {
  const row = db.prepare(`SELECT fact, scope_type, project_id, workspace_id, workstream_id,
    promotion_state, subject_key, semantic_generation, lifecycle_generation, is_active
    FROM facts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  // Replication's semantic/lifecycle axes are independent. Local lifecycle
  // changes must not prevent a valid remote semantic update.
  if (kind === 'replicated') { delete row.lifecycle_generation; delete row.is_active; }
  return JSON.stringify(row);
}

export function captureMutationPolicy(db: Database.Database, kind: MutationPolicy['kind'], factIds: readonly string[],
  options: { sourceExchangeIds?: readonly string[]; verifiedText?: string } = {}): MutationPolicy {
  if (factIds.length === 0 || factIds.some(id => typeof id !== 'string' || !id)) throw new Error('MutationPolicy requires exact target IDs');
  const sources = options.sourceExchangeIds === undefined ? undefined : captureSourceSnapshot(db, options.sourceExchangeIds);
  if (sources === null) throw new StaleFactMutationError('mutation evidence is missing');
  return { kind, targets: [...new Set(factIds)].map(id => ({ id, state: mutationState(db, id, kind) })),
    ...(sources ? { sources } : {}), ...(options.verifiedText !== undefined ? { verifiedText: options.verifiedText.trim() } : {}) };
}

/** Every meaning/placement writer calls this inside its final DB transaction. */
export function assertMutationPolicy(db: Database.Database, policy: MutationPolicy, factId: string, newText?: string): void {
  if (!policy || !['user-correction', 'verified-extraction', 'consolidation', 'replicated', 'identity'].includes(policy.kind)) {
    throw new Error('MutationPolicy is required');
  }
  if (!Array.isArray(policy.targets) || !policy.targets.some(target => target.id === factId)) throw new Error('fact is outside MutationPolicy');
  for (const target of policy.targets) {
    if (mutationState(db, target.id, policy.kind) !== target.state) throw new StaleFactMutationError('mutation participant meaning, lifecycle or scope changed');
    if (policy.kind === 'consolidation') {
      const row = db.prepare('SELECT is_active FROM facts WHERE id = ?').get(target.id) as { is_active: number } | undefined;
      if (row?.is_active !== 1) throw new StaleFactMutationError('consolidation participant is inactive');
    }
  }
  if (policy.sources && !sourceSnapshotValid(db, policy.sources)) throw new StaleFactMutationError('mutation source evidence changed');
  if (newText !== undefined && (policy.kind === 'consolidation' || policy.kind === 'verified-extraction') && newText.trim() !== policy.verifiedText) {
    throw new Error('automatic mutation cannot rewrite verified text');
  }
  if (newText !== undefined && policy.kind === 'identity') throw new Error('identity policy cannot rewrite meaning');
}

/** Read permission is deliberately insufficient for automatic consolidation. */
export function consolidationEligibility(a: Fact, b: Fact, relation?: FactRelation): string | null {
  if (a.id === b.id) return 'same participant';
  if (!a.is_active || !b.is_active) return 'inactive participant';
  if (a.scope_type !== b.scope_type) return 'different scope types';
  if (a.scope_type === 'project') {
    if (!a.project_id || !b.project_id || a.promotion_state === 'legacy-project' || b.promotion_state === 'legacy-project' ||
        !a.promotion_state || !b.promotion_state) return 'legacy or incomplete project identity';
    if (a.project_id !== b.project_id || a.promotion_state !== b.promotion_state ||
        (a.workspace_id ?? null) !== (b.workspace_id ?? null) ||
        (a.workstream_id ?? null) !== (b.workstream_id ?? null)) return 'different mutation scope';
    if (a.promotion_state === 'workstream' && !a.workstream_id) return 'missing workstream identity';
    if (a.promotion_state === 'workspace' && (!a.workspace_id || a.workstream_id)) return 'invalid workspace identity';
    if ((a.promotion_state === 'project-current' || a.promotion_state === 'decision') &&
        (a.workspace_id || a.workstream_id)) return 'invalid project-wide identity';
  } else if (a.project_id || b.project_id || a.workspace_id || b.workspace_id || a.workstream_id || b.workstream_id) {
    return 'global fact has project identity';
  }
  if (isSemanticSubjectKey(a.subject_key) && isSemanticSubjectKey(b.subject_key) && a.subject_key !== b.subject_key) return 'different subjects';
  if ((relation === 'CONTRADICTION' || relation === 'EVOLUTION') &&
      (!isSemanticSubjectKey(a.subject_key) || a.subject_key !== b.subject_key)) return 'unresolved competing subject';
  return null;
}

const placement = ['scope_type', 'project_id', 'workspace_id', 'workstream_id', 'promotion_state', 'subject_key'] as const;

/** Validate both snapshots inside the writer transaction, including identity-only changes. */
export function consolidationSnapshotValid(db: Database.Database, snapshots: readonly Fact[]): boolean {
  return snapshots.every(snapshot => {
    const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(snapshot.id) as Record<string, unknown> | undefined;
    return !!row && row.is_active === 1 &&
      row.semantic_generation === (snapshot.semantic_generation ?? 1) &&
      row.lifecycle_generation === (snapshot.lifecycle_generation ?? 1) &&
      placement.every(key => (row[key] ?? null) === (snapshot[key] ?? null));
  });
}

export type SourceSnapshot = ReadonlyArray<{ id: string; hash: string }>;

/** Exact source identity across model/embedding awaits; absent evidence fails closed. */
export function captureSourceSnapshot(db: Database.Database, ids: readonly string[]): SourceSnapshot | null {
  const result: Array<{ id: string; hash: string }> = [];
  for (const id of [...new Set(ids)].sort()) {
    const row = db.prepare(`SELECT id, timestamp, user_message, assistant_message, provenance,
      assistant_learnable, has_memex_recall, project_id, workspace_id, workstream_id
      FROM exchanges WHERE id = ?`).get(id);
    if (!row) return null;
    const toolRows = db.prepare('SELECT * FROM tool_calls WHERE exchange_id = ? ORDER BY id').all(id);
    result.push({ id, hash: createHash('sha256').update(JSON.stringify([row, toolRows])).digest('hex') });
  }
  return result;
}

export function sourceSnapshotValid(db: Database.Database, snapshot: SourceSnapshot): boolean {
  return JSON.stringify(captureSourceSnapshot(db, snapshot.map(row => row.id))) === JSON.stringify(snapshot);
}

/** Imported authority is retained as peer evidence, never mistaken for local verification. */
export function hasLocalMeaningEvidence(db: Database.Database, fact: Fact): boolean {
  const receipt = db.prepare('SELECT semantic_generation, fact_hash, source_snapshot_json FROM fact_evidence_receipts WHERE fact_id = ?')
    .get(fact.id) as { semantic_generation: number; fact_hash: string; source_snapshot_json: string } | undefined;
  if (!receipt || receipt.semantic_generation !== fact.semantic_generation ||
      receipt.fact_hash !== createHash('sha256').update(fact.fact).digest('hex')) return false;
  try { return sourceSnapshotValid(db, JSON.parse(receipt.source_snapshot_json) as SourceSnapshot); }
  catch { return false; }
}

/** Local verification receipt; never exported/imported as durable peer truth. */
export function recordLocalMeaningEvidence(db: Database.Database, factId: string, text: string,
  method: 'extractor' | 'user' | 'consolidator', sourceIds: readonly string[]): void {
  const row = db.prepare('SELECT fact, semantic_generation FROM facts WHERE id = ?').get(factId) as { fact: string; semantic_generation: number } | undefined;
  const sources = captureSourceSnapshot(db, sourceIds);
  if (!row || row.fact !== text || !sources) return;
  db.prepare(`INSERT INTO fact_evidence_receipts VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET semantic_generation = excluded.semantic_generation,
      fact_hash = excluded.fact_hash, source_snapshot_json = excluded.source_snapshot_json,
      method = excluded.method, verified_at = excluded.verified_at`).run(factId, row.semantic_generation,
    createHash('sha256').update(text).digest('hex'), JSON.stringify(sources), method, new Date().toISOString());
}
