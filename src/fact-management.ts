/**
 * CX-07 — transactional fact management service.
 *
 * Single mutation SSOT for CLI, Web UI and any other surface. Every mutation
 * is one better-sqlite3 transaction: partial commits are impossible.
 *
 * Delete policy: deactivate is the default; hard delete requires the exact
 * full UUID plus an explicit confirmation flag, and reports the affected
 * counts (revisions/relations/vectors) before removing anything.
 */
import type Database from 'better-sqlite3';
import {
  clearFactContextDependencies,
  getRevisions,
  mergeFactContextDependencies,
  vecParamFor,
} from './fact-db.js';
import { generateEmbedding, EMBEDDING_VERSION } from './embeddings.js';
import {
  normalizeSlotText,
  purgeChronicleForSources,
  readChronicleTimeline,
  recordChronicleEvent,
  type ChronicleActor,
  type ChronicleEvent,
  type EffectiveAtSource,
  type EvidenceAuthority,
  type GroundedField,
} from './chronicle.js';

export interface FactRow {
  id: string;
  fact: string;
  category: string;
  scope_type: string;
  scope_project: string | null;
  is_active: number;
  ontology_category_id: string | null;
  consolidated_count: number;
  created_at: string;
  updated_at: string;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}

/** ISO timestamp LWW comparator (재감사 P1-2/P1-3 v4): shared by the local
 * mutation paths and the sync lifecycle reconciliation so every surface
 * orders lifecycle events identically. */
export function compareTimestamps(a: string, b: string): number {
  return Math.sign(Date.parse(a) - Date.parse(b));
}

export function listFacts(
  db: Database.Database,
  opts: {
    project?: string | null;
    scope?: 'global' | 'all';
    includeInactive?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): FactRow[] {
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts.includeInactive) where.push('is_active = 1');
  if (opts.project) {
    // Canonical project + global scope contract (CX-02).
    where.push("((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')");
    args.push(opts.project);
  } else if (opts.scope !== 'all') {
    where.push("scope_type = 'global'");
  }
  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT id, fact, category, scope_type, scope_project, is_active, ontology_category_id,
            consolidated_count, created_at, updated_at
     FROM facts ${wc}
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  ).all(...args, limit, offset) as unknown as FactRow[];
}

export function showFact(db: Database.Database, id: string): Record<string, unknown> | null {
  const fact = db.prepare(
    `SELECT id, fact, fact_kr, category, scope_type, scope_project, is_active,
            ontology_category_id, source_exchange_ids, consolidated_count,
            embedding_version, created_at, updated_at
     FROM facts WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!fact) return null;
  let sources: Array<Record<string, unknown>> = [];
  try {
    const ids = JSON.parse((fact.source_exchange_ids as string) || '[]');
    if (Array.isArray(ids) && ids.length > 0) {
      sources = db.prepare(
        `SELECT id, project, timestamp, substr(user_message,1,200) AS user_message, archive_path
         FROM exchanges WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).all(...ids) as Array<Record<string, unknown>>;
    }
  } catch { /* unparseable provenance */ }
  const contextDependencies = tableExists(db, 'fact_context_dependencies')
    ? db.prepare(`
        SELECT d.exchange_id, d.dependency_kind, d.created_at,
               'context_only' AS authority,
               e.project, e.timestamp,
               substr(e.user_message, 1, 200) AS user_message,
               substr(e.assistant_message, 1, 200) AS assistant_message,
               e.archive_path
        FROM fact_context_dependencies d
        JOIN exchanges e ON e.id = d.exchange_id
        WHERE d.fact_id = ?
        ORDER BY d.created_at, d.exchange_id, d.dependency_kind
      `).all(id) as Array<Record<string, unknown>>
    : [];
  return {
    ...fact,
    revisions: getRevisions(db, id),
    sources,
    context_dependencies: contextDependencies,
  };
}

export interface EditResult {
  id: string;
  revisionId: string;
  embeddingRefreshed: boolean;
  ontologyPending: boolean;
  affectedRelations: number;
}

export interface FactMutationSource {
  exchangeId?: string;
  exchangeIds?: string[];
}

export interface MutateFactMeaningOptions {
  factId: string;
  newText: string;
  reason?: string;
  source?: FactMutationSource;
  lineageMode?: 'preserve-identity';
  expectedPreviousFact?: string;
  /** Semantic CAS on the mutation target: the caller's comparison was made
   * against this generation — a newer one means the verdict is stale. */
  expectedSemanticGeneration?: number;
  /** Lifecycle CAS on the mutation target (재감사 P1-4 v4): consolidation
   * compared ACTIVE participants — a participant whose lifecycle moved
   * (deactivate/restore/replicated event) during the LLM await invalidates
   * the verdict even though semantic_generation is unchanged. */
  expectedLifecycleGeneration?: number;
  consolidatedCountIncrement?: boolean;
  /** Consolidation preserves the target's context and unions these facts'
   * local interpretive lineage. Other semantic rewrites clear stale context. */
  mergeContextFromFactIds?: string[];
  /** Facts to deactivate in the same transaction, each with the semantic AND
   * lifecycle generation its deactivation was decided against. A fact whose
   * meaning moved (edit, sync import) OR whose activation state moved
   * (deactivate/restore during the comparison await) must never be
   * deactivated by a stale verdict — the whole mutation rolls back instead
   * (재감사 P1-2, P1-4 v4). */
  deactivateFacts?: Array<{
    id: string;
    expectedSemanticGeneration: number;
    expectedLifecycleGeneration?: number;
  }>;
  /** Chronicle context for the CHANGED event written in the same transaction. */
  chronicle?: ChronicleMutationContext;
}

/**
 * Who changed the projection and what the evidence proves. `reason` on the
 * mutation is model/consolidator text and lands in `classifier_note`; only
 * `grounded` fields verified against a stored source, or a rationale typed by
 * the user, become authoritative cause/rationale.
 */
export interface ChronicleMutationContext {
  actor: ChronicleActor;
  grounded?: { problem?: GroundedField; cause?: GroundedField; rationale?: GroundedField };
  userStatedRationale?: string | null;
  classifierNote?: string | null;
  evidenceAuthority?: EvidenceAuthority;
  effectiveAt?: string | null;
  /** How `effectiveAt` was established; a caller passing a worker clock must say `recorded`. */
  effectiveAtSource?: EffectiveAtSource;
  sourceEvidenceIds?: string[];
  revertsEventId?: string | null;
  relatedEventIds?: string[];
  outcome?: Record<string, unknown> | null;
}

export interface SemanticMutationResult extends EditResult {
  deactivatedFactIds: string[];
}

/**
 * Thrown when a semantic mutation loses a race: the fact's text changed
 * between the caller's read and the mutation commit
 * (`expectedPreviousFact` mismatch), or an async derived writer's final
 * write found a newer semantic generation. The stale result must be
 * discarded — callers treat this as "someone else moved the fact", not as
 * an internal failure.
 */
export class StaleFactMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleFactMutationError';
  }
}

function parseSourceExchangeIds(raw: string | null): string[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
    throw new Error('fact source_exchange_ids must be a JSON string array');
  }
  return parsed;
}

function deactivateWithinTransaction(
  db: Database.Database,
  id: string,
  expectedSemanticGeneration: number,
  expectedLifecycleGeneration?: number,
): void {
  // 재감사 P1-3(protocol v4): 비활성화는 lifecycle 사건이다 — semantic 시계는
  // 건드리지 않고 lifecycle_generation을 올려 sync lifecycle reconcile과
  // restore의 dual CAS가 이 전환을 순서 있게 본다. CAS 토큰은 판정 근거인
  // semantic_generation(merge verdict가 세운 의미)에 둔다.
  // 재감사 P1-4(v4): consolidation은 active 참가자끼리 판정했다 — 참가자의
  // lifecycle이 비교 await 중 움직였으면(deactivate→restore) semantic
  // generation은 그대로여도 판정은 stale이다. 토큰을 제공한 호출자는 두
  // 축 모두 CAS한다.
  const result = db.prepare(
    `UPDATE facts SET is_active = 0, needs_consolidation = 0, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?
     WHERE id = ? AND is_active = 1 AND semantic_generation = ?${expectedLifecycleGeneration !== undefined ? ' AND lifecycle_generation = ?' : ''}`,
  ).run(...(expectedLifecycleGeneration !== undefined
    ? [new Date().toISOString(), new Date().toISOString(), id, expectedSemanticGeneration, expectedLifecycleGeneration]
    : [new Date().toISOString(), new Date().toISOString(), id, expectedSemanticGeneration]));
  if (result.changes === 0) {
    throw new StaleFactMutationError(
      `deactivation discarded: fact ${id} changed meaning, state, or lifecycle during the comparison`,
    );
  }
  if (tableExists(db, 'vec_facts')) db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
  if (tableExists(db, 'vec_facts_kr')) db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
}

/**
 * Replace one fact's meaning while preserving its identity and revision chain.
 * Embedding generation happens before the write; every durable generation
 * transition, its Chronicle CHANGED event, and invalidation commit in one
 * transaction.
 */
export async function mutateFactMeaning(
  db: Database.Database,
  opts: MutateFactMeaningOptions,
): Promise<SemanticMutationResult> {
  if (opts.lineageMode && opts.lineageMode !== 'preserve-identity') {
    throw new Error(`unsupported fact lineage mode: ${opts.lineageMode}`);
  }
  const newText = String(opts.newText || '').trim();
  if (newText.length < 4) throw new Error('new fact text too short (min 4 chars)');
  const exists = db.prepare('SELECT 1 FROM facts WHERE id = ?').get(opts.factId);
  if (!exists) throw new Error(`fact not found: ${opts.factId}`);
  if (!tableExists(db, 'vec_facts')) {
    throw new Error('semantic fact mutation requires an initialized vec_facts table');
  }
  const embedding = await generateEmbedding(newText, 'passage');
  return applyFactMeaningMutation(db, opts, embedding);
}

/**
 * Synchronous core of the semantic mutation. Callers that already hold a
 * vector (the extractor's slot resolver) run it inside their own transaction;
 * better-sqlite3 nests it as a savepoint. The CHANGED event is appended after
 * the projection UPDATE inside the same transaction, so a failed projection
 * update leaves no event and a failed event leaves no projection change.
 */
export function applyFactMeaningMutation(
  db: Database.Database,
  opts: MutateFactMeaningOptions,
  embedding: number[],
): SemanticMutationResult {
  const newText = String(opts.newText || '').trim();
  if (newText.length < 4) throw new Error('new fact text too short (min 4 chars)');
  const embBuffer = Buffer.from(new Float32Array(embedding).buffer);
  const vp = vecParamFor(db, 'vec_facts', embedding);
  const deactivateFacts: Array<{ id: string; expectedSemanticGeneration: number; expectedLifecycleGeneration?: number }> = [];
  const seenDeactivations = new Set<string>();
  for (const d of opts.deactivateFacts ?? []) {
    if (d.id === opts.factId || seenDeactivations.has(d.id)) continue;
    seenDeactivations.add(d.id);
    deactivateFacts.push(d);
  }
  const chronicle: ChronicleMutationContext = opts.chronicle ?? { actor: 'consolidator' };

  const tx = db.transaction(() => {
    const current = db.prepare(
      'SELECT fact, source_exchange_ids, semantic_generation, lifecycle_generation, project_id, subject_key FROM facts WHERE id = ?',
    ).get(opts.factId) as {
      fact: string; source_exchange_ids: string | null; semantic_generation: number; lifecycle_generation: number;
      project_id: string | null; subject_key: string | null;
    } | undefined;
    if (!current) throw new Error(`fact not found: ${opts.factId}`);
    if (opts.expectedPreviousFact !== undefined && current.fact !== opts.expectedPreviousFact) {
      throw new StaleFactMutationError(
        `fact changed before semantic mutation: ${opts.factId}`,
      );
    }
    if (
      opts.expectedSemanticGeneration !== undefined &&
      current.semantic_generation !== opts.expectedSemanticGeneration
    ) {
      throw new StaleFactMutationError(
        `fact changed before semantic mutation: ${opts.factId} (semantic generation moved)`,
      );
    }
    if (
      opts.expectedLifecycleGeneration !== undefined &&
      current.lifecycle_generation !== opts.expectedLifecycleGeneration
    ) {
      // 재감사 P1-4(v4): 비교 대상이 LLM 왕복 동안 deactivate/restore 됐다 —
      // active 참가자에 내린 판정은 폐기한다(의미를 다시 쓰고 vec을 재삽입하는
      // stale verdict가 inactive fact의 vector 불변식을 깨는 것을 막는다).
      throw new StaleFactMutationError(
        `fact changed before semantic mutation: ${opts.factId} (lifecycle generation moved)`,
      );
    }

    const sourceExchangeIds = [...new Set([
      ...parseSourceExchangeIds(current.source_exchange_ids),
      ...(opts.source?.exchangeIds ?? []),
    ])];
    const countUpdate = opts.consolidatedCountIncrement
      ? ', consolidated_count = consolidated_count + 1'
      : '';
    const now = new Date().toISOString();
    // 재감사 P1-2: 의미 변경은 semantic_generation을 올린다 — 이 커밋 이후
    // 캡처된 구세대의 비동기 결과(분류/벡터/KR/관계)는 CAS에서 0행으로 폐기된다.
    const updated = db.prepare(`
      UPDATE facts
      SET fact = ?, source_exchange_ids = ?, embedding = ?, updated_at = ?, embedding_version = ?,
          ontology_category_id = NULL, fact_kr = NULL,
          ontology_attempts = 0, consolidation_attempts = 0, needs_consolidation = 1,
          ontology_last_attempt_at = NULL,
          semantic_generation = semantic_generation + 1, semantic_updated_at = ?
          ${countUpdate}
      WHERE id = ? AND semantic_generation = ?
    `).run(
      newText,
      JSON.stringify(sourceExchangeIds),
      embBuffer,
      now,
      EMBEDDING_VERSION,
      now,
      opts.factId,
      current.semantic_generation,
    );
    if (updated.changes !== 1) {
      throw new StaleFactMutationError(`fact changed during semantic mutation: ${opts.factId}`);
    }

    // CURRENT VS HISTORY: the projection moved, so the Chronicle must record
    // the transition in this same commit. The new evidence for the change is
    // the mutation's own source, not the fact's accumulated provenance.
    // `source.exchangeId` is the exchange that carries the new evidence;
    // `source.exchangeIds` may be the merged provenance union (consolidation),
    // which belongs to the fact row, not to this transition.
    const eventSources = opts.source?.exchangeId
      ? [opts.source.exchangeId]
      : [...(opts.source?.exchangeIds ?? [])];
    // Rollback detection: returning to the value a previous CHANGED event
    // replaced links the two transitions (RFC §15.3) without deleting history.
    let revertsEventId = chronicle.revertsEventId ?? null;
    if (!revertsEventId) {
      const candidates = db.prepare(`
        SELECT id, previous_fact, new_fact FROM fact_revisions
        WHERE fact_id = ? AND projection_applied = 1 AND event_kind IN ('CHANGED','ASSERTED')
        ORDER BY effective_at DESC, recorded_at DESC, COALESCE(chronicle_seq, rowid) DESC LIMIT 20
      `).all(opts.factId) as Array<{ id: string; previous_fact: string | null; new_fact: string | null }>;
      const target = normalizeSlotText(newText);
      const fromValue = normalizeSlotText(current.fact);
      const reverted = candidates.find((row) =>
        row.previous_fact !== null && normalizeSlotText(row.previous_fact) === target &&
        row.new_fact !== null && normalizeSlotText(row.new_fact) === fromValue);
      revertsEventId = reverted?.id ?? null;
    }
    const { event } = recordChronicleEvent(db, {
      kind: 'CHANGED',
      projectId: current.project_id,
      subjectKey: current.subject_key,
      factId: opts.factId,
      fromSemanticGeneration: current.semantic_generation,
      toSemanticGeneration: current.semantic_generation + 1,
      previousValue: current.fact,
      newValue: newText,
      grounded: chronicle.grounded,
      userStatedRationale: chronicle.userStatedRationale ?? null,
      classifierNote: chronicle.classifierNote ?? opts.reason ?? null,
      outcome: chronicle.outcome ?? null,
      sourceExchangeIds: eventSources,
      sourceEvidenceIds: chronicle.sourceEvidenceIds ?? [],
      revertsEventId,
      relatedEventIds: chronicle.relatedEventIds ?? [],
      actor: chronicle.actor,
      evidenceAuthority: chronicle.evidenceAuthority ?? (chronicle.actor === 'user' ? 'human' : 'unknown'),
      effectiveAt: chronicle.effectiveAt ?? null,
      effectiveAtSource: chronicle.effectiveAtSource,
      recordedAt: now,
      projectionApplied: true,
    });

    if (tableExists(db, 'fact_context_dependencies')) {
      if ((opts.mergeContextFromFactIds?.length ?? 0) > 0) {
        mergeFactContextDependencies(
          db,
          opts.factId,
          opts.mergeContextFromFactIds ?? [],
        );
      } else {
        clearFactContextDependencies(db, opts.factId);
      }
    }

    db.prepare('DELETE FROM vec_facts WHERE id = ?').run(opts.factId);
    db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vp.sql})`).run(opts.factId, vp.blob);
    if (tableExists(db, 'vec_facts_kr')) {
      db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(opts.factId);
    }

    let affectedRelations = 0;
    if (tableExists(db, 'ontology_relations')) {
      const rel = db.prepare(
        'SELECT COUNT(*) AS c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?',
      ).get(opts.factId, opts.factId) as { c: number };
      affectedRelations = Number(rel?.c ?? 0);
      if (affectedRelations > 0) {
        db.prepare(
          'DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?',
        ).run(opts.factId, opts.factId);
      }
    }

    for (const d of deactivateFacts) {
      deactivateWithinTransaction(db, d.id, d.expectedSemanticGeneration, d.expectedLifecycleGeneration);
    }
    return { revisionId: event.id, affectedRelations };
  });

  const result = tx();
  return {
    id: opts.factId,
    revisionId: result.revisionId,
    embeddingRefreshed: true,
    ontologyPending: true,
    affectedRelations: result.affectedRelations,
    deactivatedFactIds: deactivateFacts.map((d) => d.id),
  };
}

/**
 * Edit a fact's text. One transaction covers:
 *   revision(old/new/reason) -> text update -> fresh embedding + vector swap ->
 *   ontology reclassification marked pending (observable NULL) -> commit.
 * Any failure rolls everything back.
 */
export async function editFact(
  db: Database.Database,
  id: string,
  opts: { text: string; reason?: string; sourceExchangeId?: string },
): Promise<EditResult> {
  return mutateFactMeaning(db, {
    factId: id,
    newText: opts.text,
    reason: undefined,
    source: { exchangeId: opts.sourceExchangeId },
    lineageMode: 'preserve-identity',
    // A reason typed by the user is an explicit human rationale, not a model note.
    chronicle: { actor: 'user', userStatedRationale: opts.reason ?? null, evidenceAuthority: 'human' },
  });
}


/** Deactivate (default delete). Removes from search/vector immediately.
 * Lifecycle 전환이므로 lifecycle_generation을 올린다(재감사 P1-3 v4) — sync는
 * 이 시계로 deactivate를 전파하고, restore은 이 토큰으로 await race를 폐기한다. */
export interface LifecycleChronicleOptions {
  /**
   * `false` absorbs the row silently (consolidation merged its meaning into a
   * survivor, so no truth was retired). Otherwise a RETIRED/RESTORED event is
   * appended in the same transaction; user surfaces are the default actor.
   */
  chronicle?: false | {
    actor: ChronicleActor;
    userStatedRationale?: string | null;
    classifierNote?: string | null;
    sourceExchangeIds?: string[];
    effectiveAt?: string | null;
    evidenceAuthority?: EvidenceAuthority;
  };
}

export function deactivateFactTransactional(
  db: Database.Database,
  id: string,
  options: LifecycleChronicleOptions = {},
): { deactivated: true; removedFromVectorIndex: boolean; eventId: string | null } {
  const chronicle = options.chronicle === undefined ? { actor: 'user' as ChronicleActor } : options.chronicle;
  let eventId: string | null = null;
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const current = db.prepare('SELECT fact, project_id, subject_key, semantic_generation, lifecycle_generation FROM facts WHERE id = ? AND is_active = 1')
      .get(id) as { fact: string; project_id: string | null; subject_key: string | null; semantic_generation: number; lifecycle_generation: number } | undefined;
    const r = db.prepare('UPDATE facts SET is_active = 0, needs_consolidation = 0, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ? WHERE id = ? AND is_active = 1').run(now, now, id);
    if (r.changes === 0 || !current) throw new Error(`no active fact with id: ${id} (not found or already inactive)`);
    if (chronicle) {
      const { event } = recordChronicleEvent(db, {
        kind: 'RETIRED',
        projectId: current.project_id,
        subjectKey: current.subject_key,
        factId: id,
        fromSemanticGeneration: current.semantic_generation,
        toSemanticGeneration: current.semantic_generation,
        lifecycleGeneration: current.lifecycle_generation + 1,
        previousValue: current.fact,
        newValue: null,
        userStatedRationale: chronicle.userStatedRationale ?? null,
        classifierNote: chronicle.classifierNote ?? null,
        sourceExchangeIds: chronicle.sourceExchangeIds ?? [],
        actor: chronicle.actor,
        evidenceAuthority: chronicle.evidenceAuthority ?? (chronicle.actor === 'user' ? 'human' : 'unknown'),
        effectiveAt: chronicle.effectiveAt ?? null,
        recordedAt: now,
        projectionApplied: true,
      });
      eventId = event.id;
    }
    let removed = false;
    if (tableExists(db, 'vec_facts')) {
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
      removed = true;
    }
    if (tableExists(db, 'vec_facts_kr')) db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
    return removed;
  });
  const removedFromVectorIndex = tx();
  return { deactivated: true, removedFromVectorIndex, eventId };
}

/**
 * Restore an inactive fact and rebuild its vector. The stored embedding is
 * reusable only when it was produced by the current model — search
 * (searchFactsByScope) reads current-embedding_version rows exclusively, so a
 * fact that aged through a model upgrade while inactive would otherwise be
 * "restored" into an invisible state until the reembed worker ran. Stale
 * versions are re-embedded with the current model and the vector + stamp are
 * restored together in one commit.
 */
/** Vector prep shared by local restore and replicated activation. Returns the
 * stored bytes when they were produced by the current model, `null` when the
 * fact has no vector at all, and `undefined` when a re-embed (an await) is
 * required — a stale-model vector is incomparable with current-model queries.
 * The caller keeps the fast path synchronous (no await) so fire-and-forget
 * callers observe completion deterministically. */
function storedVectorIfCurrent(row: {
  embedding: Buffer | null;
  embedding_version: number;
}): number[] | null | undefined {
  if (!row.embedding) return null;
  if (Number(row.embedding_version) === EMBEDDING_VERSION) {
    // Same model version — the stored bytes are reusable as-is. (The facts
    // table stores float32 bytes; re-encode to the vec table's dtype below.)
    const f32 = new Float32Array(
      row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength,
      ),
    );
    return Array.from(f32);
  }
  return undefined; // model upgrade happened while inactive: re-embed
}

export async function restoreFact(
  db: Database.Database,
  id: string,
  options: LifecycleChronicleOptions = {},
): Promise<{ restored: true; vectorRestored: boolean; reembedded: boolean; eventId: string | null }> {
  const chronicle = options.chronicle === undefined ? { actor: 'user' as ChronicleActor } : options.chronicle;
  const row = db
    .prepare(
      'SELECT fact, embedding, embedding_version, semantic_generation, lifecycle_generation, project_id, subject_key FROM facts WHERE id = ? AND is_active = 0',
    )
    .get(id) as
    | { fact: string; embedding: Buffer | null; embedding_version: number; semantic_generation: number; lifecycle_generation: number; project_id: string | null; subject_key: string | null }
    | undefined;
  if (!row) throw new Error(`no inactive fact with id: ${id}`);

  let vector: number[] | null;
  let reembedded = false;
  const stored = storedVectorIfCurrent(row);
  if (stored === undefined) {
    vector = await generateEmbedding(row.fact, 'passage');
    reembedded = true;
  } else {
    vector = stored;
  }

  // 재감사 P1-2: the embedding await is a race window. If the fact's meaning
  // changed (or it was restored by another path) while the new vector was
  // being computed, committing would pair the OLD text's vector with the NEW
  // text and stamp it embedding_version=current — a mismatch the self-heal
  // can never see. CAS on (is_active, semantic_generation) and discard.
  // 재감사 P1-3(protocol v4): restore은 lifecycle 전환이기도 하다 — lifecycle
  // 토큰까지 검사해 await 중인 deactivate/remote lifecycle import를 존중하고,
  // 커밋이 lifecycle_generation을 올려 다른 기기의 순서 판정을 가능하게 한다.
  let eventId: string | null = null;
  const recordRestored = (now: string): void => {
    if (!chronicle) return;
    const retired = db.prepare(`
      SELECT id FROM fact_revisions WHERE fact_id = ? AND event_kind = 'RETIRED'
      ORDER BY effective_at DESC, recorded_at DESC, COALESCE(chronicle_seq, rowid) DESC LIMIT 1
    `).get(id) as { id: string } | undefined;
    const { event } = recordChronicleEvent(db, {
      kind: 'RESTORED',
      projectId: row.project_id,
      subjectKey: row.subject_key,
      factId: id,
      fromSemanticGeneration: row.semantic_generation,
      toSemanticGeneration: row.semantic_generation,
      lifecycleGeneration: row.lifecycle_generation + 1,
      previousValue: null,
      newValue: row.fact,
      userStatedRationale: chronicle.userStatedRationale ?? null,
      classifierNote: chronicle.classifierNote ?? null,
      sourceExchangeIds: chronicle.sourceExchangeIds ?? [],
      revertsEventId: retired?.id ?? null,
      actor: chronicle.actor,
      evidenceAuthority: chronicle.evidenceAuthority ?? (chronicle.actor === 'user' ? 'human' : 'unknown'),
      effectiveAt: chronicle.effectiveAt ?? null,
      recordedAt: now,
      projectionApplied: true,
    });
    eventId = event.id;
  };
  const tx = db.transaction((): 'vector' | 'plain' | 'stale' => {
    if (vector && tableExists(db, 'vec_facts')) {
      const now = new Date().toISOString();
      const claimed = db.prepare(
        'UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?, embedding = ?, embedding_version = ? WHERE id = ? AND is_active = 0 AND semantic_generation = ? AND lifecycle_generation = ?',
      ).run(now, now, Buffer.from(new Float32Array(vector).buffer), EMBEDDING_VERSION, id, row.semantic_generation, row.lifecycle_generation);
      if (claimed.changes === 0) return 'stale';
      recordRestored(now);
      const vp = vecParamFor(db, 'vec_facts', vector);
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
      db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vp.sql})`).run(id, vp.blob);
      // The KR translation vector has no stored source bytes (the facts table
      // keeps only the primary embedding). Ensure the KR side stays empty so
      // the standard reembed gap detection
      // (fact_kr != '' AND NOT EXISTS vec_facts_kr row) regenerates it.
      if (tableExists(db, 'vec_facts_kr')) {
        db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
      }
      return 'vector';
    }
    const plainNow = new Date().toISOString();
    const claimed = db.prepare(
      'UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ? WHERE id = ? AND is_active = 0 AND semantic_generation = ? AND lifecycle_generation = ?',
    ).run(plainNow, plainNow, id, row.semantic_generation, row.lifecycle_generation);
    if (claimed.changes === 0) return 'stale';
    recordRestored(plainNow);
    return 'plain';
  });
  const outcome = tx();
  if (outcome === 'stale') {
    throw new StaleFactMutationError(
      `restore discarded: fact ${id} changed meaning or state during restore`,
    );
  }
  return { restored: true, vectorRestored: outcome === 'vector', reembedded, eventId };
}

export type ReplicatedLifecycleOutcome = 'applied' | 'moot';

/**
 * Apply a REPLICATED lifecycle event (재감사 P1-2/P1-3 v4). Replication is not
 * a new event: the remote event's original clock (`eventAt`) is preserved —
 * stamping local `now` here fabricated a future timestamp that permanently
 * rejected every genuine older-clocked event behind it. The commit re-reads
 * the live row and RE-JUDGES the LWW inside the transaction, so a local
 * lifecycle event that lands during a vector-await race cannot be overwritten
 * by a stale plan: a strictly newer remote clock wins, an exact tie resolves
 * to INACTIVE (the safe default), and a same-state newer event converges the
 * clock without rewriting activation state. Any tombstone makes the event
 * moot — resurrecting a deleted fact is the SEMANTIC axis's job, never the
 * lifecycle axis's. Local user actions keep using deactivate/restoreFact,
 * which stamp `now` because they genuinely ARE new events.
 */
export async function applyReplicatedLifecycle(
  db: Database.Database,
  id: string,
  desiredActive: 0 | 1,
  eventAt: string,
): Promise<ReplicatedLifecycleOutcome> {
  const preRow = db.prepare(
    'SELECT is_active, lifecycle_updated_at FROM facts WHERE id = ?',
  ).get(id) as { is_active: number; lifecycle_updated_at: string } | undefined;
  if (!preRow) return 'moot';
  const preCmp = compareTimestamps(eventAt, preRow.lifecycle_updated_at);
  // Fast negative before any embedding work: the live row already carries a
  // strictly newer lifecycle event (or an equal one — a tie only helps an
  // arriving INACTIVE event over an active row).
  if (preCmp < 0) return 'moot';
  if (preCmp === 0 && !(desiredActive === 0 && Number(preRow.is_active) === 1)) return 'moot';

  // Vector prep happens BEFORE the transaction (activation only). The commit
  // CAS re-reads the live row, so a meaning change during this await discards
  // the stale vector instead of pairing old-text vectors with new text.
  let capturedSemanticGeneration: number | undefined;
  let vector: number[] | null = null;
  if (desiredActive === 1 && Number(preRow.is_active) === 0) {
    const src = db.prepare(
      'SELECT fact, embedding, embedding_version, semantic_generation FROM facts WHERE id = ? AND is_active = 0',
    ).get(id) as { fact: string; embedding: Buffer | null; embedding_version: number; semantic_generation: number } | undefined;
    if (!src) return 'moot';
    capturedSemanticGeneration = Number(src.semantic_generation);
    const stored = storedVectorIfCurrent(src);
    vector = stored === undefined ? await generateEmbedding(src.fact, 'passage') : stored;
  }

  const tx = db.transaction((): ReplicatedLifecycleOutcome => {
    const tombstone = db.prepare(
      'SELECT reason FROM fact_tombstones WHERE fact_id = ?',
    ).get(id) as { reason: string | null } | undefined;
    if (tombstone) return 'moot';
    const current = db.prepare(
      'SELECT is_active, lifecycle_updated_at, semantic_generation FROM facts WHERE id = ?',
    ).get(id) as { is_active: number; lifecycle_updated_at: string; semantic_generation: number } | undefined;
    if (!current) return 'moot';
    const cmp = compareTimestamps(eventAt, current.lifecycle_updated_at);
    const eventWins = cmp > 0 || (cmp === 0 && desiredActive === 0 && Number(current.is_active) === 1);
    if (!eventWins) return 'moot';
    const touchedAt = new Date().toISOString(); // local row touch only — never the lifecycle clock
    if (desiredActive === Number(current.is_active)) {
      // Same state, newer event: converge the lifecycle clock so later peers
      // order against the real event time. is_active never moved — no
      // generation bump, no vector work.
      db.prepare('UPDATE facts SET lifecycle_updated_at = ?, updated_at = ? WHERE id = ?').run(eventAt, touchedAt, id);
      return 'applied';
    }
    if (desiredActive === 0) {
      const claimed = db.prepare(
        `UPDATE facts SET is_active = 0, needs_consolidation = 0, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?
         WHERE id = ? AND is_active = 1`,
      ).run(eventAt, touchedAt, id);
      if (claimed.changes === 0) return 'moot';
      if (tableExists(db, 'vec_facts')) db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
      if (tableExists(db, 'vec_facts_kr')) db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
      return 'applied';
    }
    // Activation. The restored vector must belong to the CURRENT meaning: a
    // semantic bump during the vector await makes this reconciliation moot —
    // the next sync run re-delivers the snapshot and re-applies the event.
    if (capturedSemanticGeneration !== undefined && Number(current.semantic_generation) !== capturedSemanticGeneration) {
      return 'moot';
    }
    const claimed = db.prepare(
      `UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?
       WHERE id = ? AND is_active = 0 AND semantic_generation = ?`,
    ).run(eventAt, touchedAt, id, capturedSemanticGeneration ?? Number(current.semantic_generation));
    if (claimed.changes === 0) return 'moot';
    if (vector && tableExists(db, 'vec_facts')) {
      const vp = vecParamFor(db, 'vec_facts', vector);
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
      db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vp.sql})`).run(id, vp.blob);
    }
    // The KR translation vector has no stored source bytes; keep the KR side
    // empty so the standard reembed gap detection regenerates it.
    if (tableExists(db, 'vec_facts_kr')) db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
    return 'applied';
  });
  return tx();
}

/** Chronicle timeline for one fact in effective order (oldest first). */
export function factHistory(db: Database.Database, id: string): ChronicleEvent[] {
  return readChronicleTimeline(db, { factId: id, order: 'asc', limit: 100 }).events;
}

export interface HardDeleteImpact {
  exists: boolean;
  revisions: number;
  relations: number;
  contextDependencies: number;
}

export function recordFactTombstone(
  db: Database.Database,
  id: string,
  reason: string | null = null,
  deletedAt = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO fact_tombstones (fact_id, deleted_at, reason)
    VALUES (?, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      reason = excluded.reason
    WHERE excluded.deleted_at > fact_tombstones.deleted_at
  `).run(id, deletedAt, reason);
}

export function hardDeleteImpact(db: Database.Database, id: string): HardDeleteImpact {
  const exists = !!db.prepare('SELECT 1 FROM facts WHERE id = ?').get(id);
  const revisions = Number((db.prepare('SELECT COUNT(*) AS c FROM fact_revisions WHERE fact_id = ?').get(id) as { c: number }).c);
  let relations = 0;
  try {
    relations = Number((db.prepare('SELECT COUNT(*) AS c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(id, id) as { c: number }).c);
  } catch { /* no relations table */ }
  const contextDependencies = tableExists(db, 'fact_context_dependencies')
    ? Number((db.prepare(
        'SELECT COUNT(*) AS c FROM fact_context_dependencies WHERE fact_id = ?',
      ).get(id) as { c: number }).c)
    : 0;
  return { exists, revisions, relations, contextDependencies };
}

/** Hard delete: exact UUID + explicit confirm required. One transaction. */
export function hardDeleteFact(db: Database.Database, id: string, opts: { confirm: boolean }): { deleted: true; impact: HardDeleteImpact } {
  if (!isFullUuid(id)) throw new Error('hard delete requires the exact full UUID');
  if (!opts.confirm) throw new Error('hard delete requires explicit confirmation (--yes after reviewing impact)');
  const impact = hardDeleteImpact(db, id);
  if (!impact.exists) throw new Error(`fact not found: ${id}`);
  const tx = db.transaction(() => {
    recordFactTombstone(db, id, 'hard_delete');
    if (tableExists(db, 'vec_facts')) db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
    if (tableExists(db, 'vec_facts_kr')) db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
    purgeChronicleForSources(db, { exchangeIds: new Set(), factIds: new Set([id]), reason: 'hard_delete' });
    try {
      db.prepare('DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').run(id, id);
    } catch { /* no relations table */ }
    db.prepare('DELETE FROM facts WHERE id = ?').run(id);
  });
  tx();
  return { deleted: true, impact };
}

function isFullUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
