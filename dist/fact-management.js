import { getRevisions, insertRevision, vecParamFor } from './fact-db.js';
import { generateEmbedding, EMBEDDING_VERSION } from './embeddings.js';
function tableExists(db, name) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}
export function listFacts(db, opts = {}) {
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = [];
    const args = [];
    if (!opts.includeInactive)
        where.push('is_active = 1');
    if (opts.project) {
        // Canonical project + global scope contract (CX-02).
        where.push("((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')");
        args.push(opts.project);
    }
    else if (opts.scope !== 'all') {
        where.push("scope_type = 'global'");
    }
    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db.prepare(`SELECT id, fact, category, scope_type, scope_project, is_active, ontology_category_id,
            consolidated_count, created_at, updated_at
     FROM facts ${wc}
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
}
export function showFact(db, id) {
    const fact = db.prepare(`SELECT id, fact, fact_kr, category, scope_type, scope_project, is_active,
            ontology_category_id, source_exchange_ids, consolidated_count,
            embedding_version, created_at, updated_at
     FROM facts WHERE id = ?`).get(id);
    if (!fact)
        return null;
    let sources = [];
    try {
        const ids = JSON.parse(fact.source_exchange_ids || '[]');
        if (Array.isArray(ids) && ids.length > 0) {
            sources = db.prepare(`SELECT id, project, timestamp, substr(user_message,1,200) AS user_message, archive_path
         FROM exchanges WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        }
    }
    catch { /* unparseable provenance */ }
    return { ...fact, revisions: getRevisions(db, id), sources };
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
    constructor(message) {
        super(message);
        this.name = 'StaleFactMutationError';
    }
}
function parseSourceExchangeIds(raw) {
    if (!raw)
        return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
        throw new Error('fact source_exchange_ids must be a JSON string array');
    }
    return parsed;
}
function deactivateWithinTransaction(db, id) {
    const result = db.prepare('UPDATE facts SET is_active = 0, needs_consolidation = 0, updated_at = ? WHERE id = ? AND is_active = 1').run(new Date().toISOString(), id);
    if (result.changes === 0)
        throw new Error(`no active fact with id: ${id}`);
    if (tableExists(db, 'vec_facts'))
        db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
    if (tableExists(db, 'vec_facts_kr'))
        db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
}
/**
 * Replace one fact's meaning while preserving its identity and revision chain.
 * Embedding generation happens before the write; every durable generation
 * transition and invalidation commits in one transaction.
 */
export async function mutateFactMeaning(db, opts) {
    if (opts.lineageMode && opts.lineageMode !== 'preserve-identity') {
        throw new Error(`unsupported fact lineage mode: ${opts.lineageMode}`);
    }
    const newText = String(opts.newText || '').trim();
    if (newText.length < 4)
        throw new Error('new fact text too short (min 4 chars)');
    const exists = db.prepare('SELECT 1 FROM facts WHERE id = ?').get(opts.factId);
    if (!exists)
        throw new Error(`fact not found: ${opts.factId}`);
    if (!tableExists(db, 'vec_facts')) {
        throw new Error('semantic fact mutation requires an initialized vec_facts table');
    }
    const embedding = await generateEmbedding(newText, 'passage');
    const embBuffer = Buffer.from(new Float32Array(embedding).buffer);
    const vp = vecParamFor(db, 'vec_facts', embedding);
    const deactivateFactIds = [...new Set(opts.deactivateFactIds ?? [])]
        .filter((id) => id !== opts.factId);
    const tx = db.transaction(() => {
        const current = db.prepare('SELECT fact, source_exchange_ids, semantic_generation FROM facts WHERE id = ?').get(opts.factId);
        if (!current)
            throw new Error(`fact not found: ${opts.factId}`);
        if (opts.expectedPreviousFact !== undefined && current.fact !== opts.expectedPreviousFact) {
            throw new StaleFactMutationError(`fact changed before semantic mutation: ${opts.factId}`);
        }
        const sourceExchangeIds = [...new Set([
                ...parseSourceExchangeIds(current.source_exchange_ids),
                ...(opts.source?.exchangeIds ?? []),
            ])];
        const revisionId = insertRevision(db, {
            fact_id: opts.factId,
            previous_fact: current.fact,
            new_fact: newText,
            reason: opts.reason ?? null,
            source_exchange_id: opts.source?.exchangeId ?? null,
        });
        const countUpdate = opts.consolidatedCountIncrement
            ? ', consolidated_count = consolidated_count + 1'
            : '';
        const now = new Date().toISOString();
        // 재감사 P1-2: 의미 변경은 semantic_generation을 올린다 — 이 커밋 이후
        // 캡처된 구세대의 비동기 결과(분류/벡터/KR/관계)는 CAS에서 0행으로 폐기된다.
        db.prepare(`
      UPDATE facts
      SET fact = ?, source_exchange_ids = ?, embedding = ?, updated_at = ?, embedding_version = ?,
          ontology_category_id = NULL, fact_kr = NULL,
          ontology_attempts = 0, consolidation_attempts = 0, needs_consolidation = 1,
          ontology_last_attempt_at = NULL,
          semantic_generation = semantic_generation + 1, semantic_updated_at = ?
          ${countUpdate}
      WHERE id = ?
    `).run(newText, JSON.stringify(sourceExchangeIds), embBuffer, now, EMBEDDING_VERSION, now, opts.factId);
        db.prepare('DELETE FROM vec_facts WHERE id = ?').run(opts.factId);
        db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vp.sql})`).run(opts.factId, vp.blob);
        if (tableExists(db, 'vec_facts_kr')) {
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(opts.factId);
        }
        let affectedRelations = 0;
        if (tableExists(db, 'ontology_relations')) {
            const rel = db.prepare('SELECT COUNT(*) AS c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(opts.factId, opts.factId);
            affectedRelations = Number(rel?.c ?? 0);
            if (affectedRelations > 0) {
                db.prepare('DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').run(opts.factId, opts.factId);
            }
        }
        for (const id of deactivateFactIds)
            deactivateWithinTransaction(db, id);
        return { revisionId, affectedRelations };
    });
    const result = tx();
    return {
        id: opts.factId,
        revisionId: result.revisionId,
        embeddingRefreshed: true,
        ontologyPending: true,
        affectedRelations: result.affectedRelations,
        deactivatedFactIds: deactivateFactIds,
    };
}
/**
 * Edit a fact's text. One transaction covers:
 *   revision(old/new/reason) -> text update -> fresh embedding + vector swap ->
 *   ontology reclassification marked pending (observable NULL) -> commit.
 * Any failure rolls everything back.
 */
export async function editFact(db, id, opts) {
    return mutateFactMeaning(db, {
        factId: id,
        newText: opts.text,
        reason: opts.reason,
        source: { exchangeId: opts.sourceExchangeId },
        lineageMode: 'preserve-identity',
    });
}
/** Deactivate (default delete). Removes from search/vector immediately. */
export function deactivateFactTransactional(db, id) {
    const tx = db.transaction(() => {
        const r = db.prepare('UPDATE facts SET is_active = 0, needs_consolidation = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        if (r.changes === 0)
            throw new Error(`no active fact with id: ${id} (not found or already inactive)`);
        let removed = false;
        if (tableExists(db, 'vec_facts')) {
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
            removed = true;
        }
        if (tableExists(db, 'vec_facts_kr'))
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
        return removed;
    });
    const removedFromVectorIndex = tx();
    return { deactivated: true, removedFromVectorIndex };
}
/** Restore an inactive fact and rebuild its vector from stored embedding. */
export function restoreFact(db, id) {
    const tx = db.transaction(() => {
        const row = db.prepare('SELECT embedding FROM facts WHERE id = ? AND is_active = 0').get(id);
        if (!row)
            throw new Error(`no inactive fact with id: ${id}`);
        db.prepare('UPDATE facts SET is_active = 1, needs_consolidation = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
        let restored = false;
        if (row.embedding && tableExists(db, 'vec_facts')) {
            // The facts.embedding column stores float32 bytes; re-encode to the
            // vec table's dtype instead of inserting the raw blob.
            const f32 = new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength));
            const vp = vecParamFor(db, 'vec_facts', Array.from(f32));
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vp.sql})`).run(id, vp.blob);
            // The KR translation vector has no stored source bytes (the facts table
            // keeps only the primary embedding). Ensure the KR side stays empty so
            // the standard reembed gap detection
            // (fact_kr != '' AND NOT EXISTS vec_facts_kr row) regenerates it.
            if (tableExists(db, 'vec_facts_kr')) {
                db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
            }
            restored = true;
        }
        return restored;
    });
    const vectorRestored = tx();
    return { restored: true, vectorRestored };
}
export function factHistory(db, id) {
    return getRevisions(db, id);
}
export function recordFactTombstone(db, id, reason = null, deletedAt = new Date().toISOString()) {
    db.prepare(`
    INSERT INTO fact_tombstones (fact_id, deleted_at, reason)
    VALUES (?, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      reason = excluded.reason
    WHERE excluded.deleted_at > fact_tombstones.deleted_at
  `).run(id, deletedAt, reason);
}
export function hardDeleteImpact(db, id) {
    const exists = !!db.prepare('SELECT 1 FROM facts WHERE id = ?').get(id);
    const revisions = Number(db.prepare('SELECT COUNT(*) AS c FROM fact_revisions WHERE fact_id = ?').get(id).c);
    let relations = 0;
    try {
        relations = Number(db.prepare('SELECT COUNT(*) AS c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(id, id).c);
    }
    catch { /* no relations table */ }
    return { exists, revisions, relations };
}
/** Hard delete: exact UUID + explicit confirm required. One transaction. */
export function hardDeleteFact(db, id, opts) {
    if (!isFullUuid(id))
        throw new Error('hard delete requires the exact full UUID');
    if (!opts.confirm)
        throw new Error('hard delete requires explicit confirmation (--yes after reviewing impact)');
    const impact = hardDeleteImpact(db, id);
    if (!impact.exists)
        throw new Error(`fact not found: ${id}`);
    const tx = db.transaction(() => {
        recordFactTombstone(db, id, 'hard_delete');
        if (tableExists(db, 'vec_facts'))
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
        if (tableExists(db, 'vec_facts_kr'))
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
        db.prepare('DELETE FROM fact_revisions WHERE fact_id = ?').run(id);
        try {
            db.prepare('DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').run(id, id);
        }
        catch { /* no relations table */ }
        db.prepare('DELETE FROM facts WHERE id = ?').run(id);
    });
    tx();
    return { deleted: true, impact };
}
function isFullUuid(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
