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
 * Edit a fact's text. One transaction covers:
 *   revision(old/new/reason) -> text update -> fresh embedding + vector swap ->
 *   ontology reclassification marked pending (observable NULL) -> commit.
 * Any failure rolls everything back.
 */
export async function editFact(db, id, opts) {
    const row = db.prepare('SELECT fact FROM facts WHERE id = ?').get(id);
    if (!row)
        throw new Error(`fact not found: ${id}`);
    const newText = String(opts.text || '').trim();
    if (newText.length < 4)
        throw new Error('new fact text too short (min 4 chars)');
    const embedding = await generateEmbedding(newText, 'passage');
    const vp = vecParamFor(db, 'vec_facts', embedding);
    const embBuffer = Buffer.from(new Float32Array(embedding).buffer);
    const tx = db.transaction(() => {
        const now = new Date().toISOString();
        const revisionId = insertRevision(db, {
            fact_id: id,
            previous_fact: row.fact,
            new_fact: newText,
            reason: opts.reason ?? null,
            source_exchange_id: opts.sourceExchangeId ?? null,
        });
        db.prepare(`
      UPDATE facts
      SET fact = ?, embedding = ?, updated_at = ?, embedding_version = ?,
          ontology_category_id = NULL, fact_kr = NULL,
          ontology_attempts = 0, consolidation_attempts = 0, ontology_last_attempt_at = NULL
      WHERE id = ?
    `).run(newText, embBuffer, now, EMBEDDING_VERSION, id);
        if (tableExists(db, 'vec_facts')) {
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vp.sql})`).run(id, vp.blob);
        }
        if (tableExists(db, 'vec_facts_kr')) {
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
        }
        let affectedRelations = 0;
        if (tableExists(db, 'ontology_relations')) {
            const rel = db.prepare('SELECT COUNT(*) AS c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(id, id);
            affectedRelations = Number(rel?.c ?? 0);
            if (affectedRelations > 0) {
                db.prepare('DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').run(id, id);
            }
        }
        return { revisionId, affectedRelations };
    });
    const r = tx();
    return {
        id,
        revisionId: r.revisionId,
        embeddingRefreshed: tableExists(db, 'vec_facts'),
        ontologyPending: true,
        affectedRelations: r.affectedRelations,
    };
}
/** Deactivate (default delete). Removes from search/vector immediately. */
export function deactivateFactTransactional(db, id) {
    const tx = db.transaction(() => {
        const r = db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
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
        db.prepare('UPDATE facts SET is_active = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
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
