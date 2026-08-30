import { getRevisions, insertRevision, vecParamFor } from './fact-db.js';
import { generateEmbedding, EMBEDDING_VERSION } from './embeddings.js';
function tableExists(db, name) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}
/** ISO timestamp LWW comparator (재감사 P1-2/P1-3 v4): shared by the local
 * mutation paths and the sync lifecycle reconciliation so every surface
 * orders lifecycle events identically. */
export function compareTimestamps(a, b) {
    return Math.sign(Date.parse(a) - Date.parse(b));
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
function deactivateWithinTransaction(db, id, expectedSemanticGeneration, expectedLifecycleGeneration) {
    // 재감사 P1-3(protocol v4): 비활성화는 lifecycle 사건이다 — semantic 시계는
    // 건드리지 않고 lifecycle_generation을 올려 sync lifecycle reconcile과
    // restore의 dual CAS가 이 전환을 순서 있게 본다. CAS 토큰은 판정 근거인
    // semantic_generation(merge verdict가 세운 의미)에 둔다.
    // 재감사 P1-4(v4): consolidation은 active 참가자끼리 판정했다 — 참가자의
    // lifecycle이 비교 await 중 움직였으면(deactivate→restore) semantic
    // generation은 그대로여도 판정은 stale이다. 토큰을 제공한 호출자는 두
    // 축 모두 CAS한다.
    const result = db.prepare(`UPDATE facts SET is_active = 0, needs_consolidation = 0, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?
     WHERE id = ? AND is_active = 1 AND semantic_generation = ?${expectedLifecycleGeneration !== undefined ? ' AND lifecycle_generation = ?' : ''}`).run(...(expectedLifecycleGeneration !== undefined
        ? [new Date().toISOString(), new Date().toISOString(), id, expectedSemanticGeneration, expectedLifecycleGeneration]
        : [new Date().toISOString(), new Date().toISOString(), id, expectedSemanticGeneration]));
    if (result.changes === 0) {
        throw new StaleFactMutationError(`deactivation discarded: fact ${id} changed meaning, state, or lifecycle during the comparison`);
    }
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
    const deactivateFacts = [];
    const seenDeactivations = new Set();
    for (const d of opts.deactivateFacts ?? []) {
        if (d.id === opts.factId || seenDeactivations.has(d.id))
            continue;
        seenDeactivations.add(d.id);
        deactivateFacts.push(d);
    }
    const tx = db.transaction(() => {
        const current = db.prepare('SELECT fact, source_exchange_ids, semantic_generation, lifecycle_generation FROM facts WHERE id = ?').get(opts.factId);
        if (!current)
            throw new Error(`fact not found: ${opts.factId}`);
        if (opts.expectedPreviousFact !== undefined && current.fact !== opts.expectedPreviousFact) {
            throw new StaleFactMutationError(`fact changed before semantic mutation: ${opts.factId}`);
        }
        if (opts.expectedSemanticGeneration !== undefined &&
            current.semantic_generation !== opts.expectedSemanticGeneration) {
            throw new StaleFactMutationError(`fact changed before semantic mutation: ${opts.factId} (semantic generation moved)`);
        }
        if (opts.expectedLifecycleGeneration !== undefined &&
            current.lifecycle_generation !== opts.expectedLifecycleGeneration) {
            // 재감사 P1-4(v4): 비교 대상이 LLM 왕복 동안 deactivate/restore 됐다 —
            // active 참가자에 내린 판정은 폐기한다(의미를 다시 쓰고 vec을 재삽입하는
            // stale verdict가 inactive fact의 vector 불변식을 깨는 것을 막는다).
            throw new StaleFactMutationError(`fact changed before semantic mutation: ${opts.factId} (lifecycle generation moved)`);
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
        for (const d of deactivateFacts) {
            deactivateWithinTransaction(db, d.id, d.expectedSemanticGeneration, d.expectedLifecycleGeneration);
        }
        return { revisionId, affectedRelations };
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
export async function editFact(db, id, opts) {
    return mutateFactMeaning(db, {
        factId: id,
        newText: opts.text,
        reason: opts.reason,
        source: { exchangeId: opts.sourceExchangeId },
        lineageMode: 'preserve-identity',
    });
}
/** Deactivate (default delete). Removes from search/vector immediately.
 * Lifecycle 전환이므로 lifecycle_generation을 올린다(재감사 P1-3 v4) — sync는
 * 이 시계로 deactivate를 전파하고, restore은 이 토큰으로 await race를 폐기한다. */
export function deactivateFactTransactional(db, id) {
    const tx = db.transaction(() => {
        const r = db.prepare('UPDATE facts SET is_active = 0, needs_consolidation = 0, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ? WHERE id = ?').run(new Date().toISOString(), new Date().toISOString(), id);
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
function storedVectorIfCurrent(row) {
    if (!row.embedding)
        return null;
    if (Number(row.embedding_version) === EMBEDDING_VERSION) {
        // Same model version — the stored bytes are reusable as-is. (The facts
        // table stores float32 bytes; re-encode to the vec table's dtype below.)
        const f32 = new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength));
        return Array.from(f32);
    }
    return undefined; // model upgrade happened while inactive: re-embed
}
export async function restoreFact(db, id) {
    const row = db
        .prepare('SELECT fact, embedding, embedding_version, semantic_generation, lifecycle_generation FROM facts WHERE id = ? AND is_active = 0')
        .get(id);
    if (!row)
        throw new Error(`no inactive fact with id: ${id}`);
    let vector;
    let reembedded = false;
    const stored = storedVectorIfCurrent(row);
    if (stored === undefined) {
        vector = await generateEmbedding(row.fact, 'passage');
        reembedded = true;
    }
    else {
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
    const tx = db.transaction(() => {
        if (vector && tableExists(db, 'vec_facts')) {
            const now = new Date().toISOString();
            const claimed = db.prepare('UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?, embedding = ?, embedding_version = ? WHERE id = ? AND is_active = 0 AND semantic_generation = ? AND lifecycle_generation = ?').run(now, now, Buffer.from(new Float32Array(vector).buffer), EMBEDDING_VERSION, id, row.semantic_generation, row.lifecycle_generation);
            if (claimed.changes === 0)
                return 'stale';
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
        const claimed = db.prepare('UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ? WHERE id = ? AND is_active = 0 AND semantic_generation = ? AND lifecycle_generation = ?').run(new Date().toISOString(), new Date().toISOString(), id, row.semantic_generation, row.lifecycle_generation);
        return claimed.changes === 0 ? 'stale' : 'plain';
    });
    const outcome = tx();
    if (outcome === 'stale') {
        throw new StaleFactMutationError(`restore discarded: fact ${id} changed meaning or state during restore`);
    }
    return { restored: true, vectorRestored: outcome === 'vector', reembedded };
}
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
export async function applyReplicatedLifecycle(db, id, desiredActive, eventAt) {
    const preRow = db.prepare('SELECT is_active, lifecycle_updated_at FROM facts WHERE id = ?').get(id);
    if (!preRow)
        return 'moot';
    const preCmp = compareTimestamps(eventAt, preRow.lifecycle_updated_at);
    // Fast negative before any embedding work: the live row already carries a
    // strictly newer lifecycle event (or an equal one — a tie only helps an
    // arriving INACTIVE event over an active row).
    if (preCmp < 0)
        return 'moot';
    if (preCmp === 0 && !(desiredActive === 0 && Number(preRow.is_active) === 1))
        return 'moot';
    // Vector prep happens BEFORE the transaction (activation only). The commit
    // CAS re-reads the live row, so a meaning change during this await discards
    // the stale vector instead of pairing old-text vectors with new text.
    let capturedSemanticGeneration;
    let vector = null;
    if (desiredActive === 1 && Number(preRow.is_active) === 0) {
        const src = db.prepare('SELECT fact, embedding, embedding_version, semantic_generation FROM facts WHERE id = ? AND is_active = 0').get(id);
        if (!src)
            return 'moot';
        capturedSemanticGeneration = Number(src.semantic_generation);
        const stored = storedVectorIfCurrent(src);
        vector = stored === undefined ? await generateEmbedding(src.fact, 'passage') : stored;
    }
    const tx = db.transaction(() => {
        const tombstone = db.prepare('SELECT reason FROM fact_tombstones WHERE fact_id = ?').get(id);
        if (tombstone)
            return 'moot';
        const current = db.prepare('SELECT is_active, lifecycle_updated_at, semantic_generation FROM facts WHERE id = ?').get(id);
        if (!current)
            return 'moot';
        const cmp = compareTimestamps(eventAt, current.lifecycle_updated_at);
        const eventWins = cmp > 0 || (cmp === 0 && desiredActive === 0 && Number(current.is_active) === 1);
        if (!eventWins)
            return 'moot';
        const touchedAt = new Date().toISOString(); // local row touch only — never the lifecycle clock
        if (desiredActive === Number(current.is_active)) {
            // Same state, newer event: converge the lifecycle clock so later peers
            // order against the real event time. is_active never moved — no
            // generation bump, no vector work.
            db.prepare('UPDATE facts SET lifecycle_updated_at = ?, updated_at = ? WHERE id = ?').run(eventAt, touchedAt, id);
            return 'applied';
        }
        if (desiredActive === 0) {
            const claimed = db.prepare(`UPDATE facts SET is_active = 0, needs_consolidation = 0, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?
         WHERE id = ? AND is_active = 1`).run(eventAt, touchedAt, id);
            if (claimed.changes === 0)
                return 'moot';
            if (tableExists(db, 'vec_facts'))
                db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
            if (tableExists(db, 'vec_facts_kr'))
                db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
            return 'applied';
        }
        // Activation. The restored vector must belong to the CURRENT meaning: a
        // semantic bump during the vector await makes this reconciliation moot —
        // the next sync run re-delivers the snapshot and re-applies the event.
        if (capturedSemanticGeneration !== undefined && Number(current.semantic_generation) !== capturedSemanticGeneration) {
            return 'moot';
        }
        const claimed = db.prepare(`UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?
       WHERE id = ? AND is_active = 0 AND semantic_generation = ?`).run(eventAt, touchedAt, id, capturedSemanticGeneration ?? Number(current.semantic_generation));
        if (claimed.changes === 0)
            return 'moot';
        if (vector && tableExists(db, 'vec_facts')) {
            const vp = vecParamFor(db, 'vec_facts', vector);
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vp.sql})`).run(id, vp.blob);
        }
        // The KR translation vector has no stored source bytes; keep the KR side
        // empty so the standard reembed gap detection regenerates it.
        if (tableExists(db, 'vec_facts_kr'))
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
        return 'applied';
    });
    return tx();
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
