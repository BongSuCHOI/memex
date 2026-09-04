import { randomUUID } from 'crypto';
import { getVecTableDtype, embeddingToVecBlob, vecParamSql, normalizeVecDistance } from './db.js';
import { EMBEDDING_VERSION } from './embeddings.js';
import { factMatchesScope } from './fact-db.js';
// === Taxonomy epoch (재감사 Privacy-P1 v4) ===
/** Global taxonomy epoch — bumped on every FULL taxonomy invalidation (the
 * privacy purge). In-flight classification captures this value before its
 * LLM/embedding awaits and re-checks it at commit: a stale result must leave
 * nothing behind instead of re-creating private-derived taxonomy rows. The
 * table is created lazily so hand-rolled test schemas and pre-existing
 * databases work without a migration. */
export function getTaxonomyEpoch(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS taxonomy_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       epoch INTEGER NOT NULL DEFAULT 1
     )`);
    const row = db.prepare('SELECT epoch FROM taxonomy_state WHERE id = 1').get();
    return Number(row?.epoch ?? 1);
}
/** Advance the epoch by one. Must run INSIDE the invalidating transaction
 * (the privacy purge) so classifiers can never observe the wipe without the
 * epoch move, or the epoch move without the wipe. */
export function bumpTaxonomyEpoch(db) {
    getTaxonomyEpoch(db); // ensure table exists before the upsert
    db.prepare(`INSERT INTO taxonomy_state (id, epoch) VALUES (1, 2)
     ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1`).run();
}
// === Domain CRUD ===
export function createDomain(db, name, description) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(id, name, description ?? null, now);
    return { id, name, description: description ?? null, created_at: now };
}
export function listDomains(db) {
    return db.prepare(`SELECT * FROM ontology_domains ORDER BY name`).all();
}
export function getDomain(db, id) {
    return (db.prepare(`SELECT * FROM ontology_domains WHERE id = ?`).get(id) ?? null);
}
export function getDomainByName(db, name) {
    return (db
        .prepare(`SELECT * FROM ontology_domains WHERE name = ? COLLATE NOCASE`)
        .get(name) ?? null);
}
// === Category CRUD ===
export function createCategory(db, domainId, name, description) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, domainId, name, description ?? null, now);
    return { id, domain_id: domainId, name, description: description ?? null, created_at: now, embedding_version: 0 };
}
export function listCategories(db, domainId) {
    if (domainId) {
        return db
            .prepare(`SELECT * FROM ontology_categories WHERE domain_id = ? ORDER BY name`)
            .all(domainId);
    }
    return db.prepare(`SELECT * FROM ontology_categories ORDER BY name`).all();
}
export function getCategoryByName(db, name, domainId) {
    if (domainId) {
        return (db
            .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE AND domain_id = ?`)
            .get(name, domainId) ?? null);
    }
    return (db
        .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE`)
        .get(name) ?? null);
}
// === Category embeddings (candidate retrieval for the classifier) ===
/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export function upsertCategoryEmbedding(db, categoryId, embedding) {
    const dt = getVecTableDtype(db, 'vec_categories');
    const buf = embeddingToVecBlob(embedding, dt);
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
        db.prepare(`INSERT INTO vec_categories (id, embedding) VALUES (?, ${vecParamSql(dt)})`).run(categoryId, buf);
        const updated = db.prepare('UPDATE ontology_categories SET embedding_version = ? WHERE id = ?')
            .run(EMBEDDING_VERSION, categoryId);
        if (updated.changes !== 1)
            throw new Error(`ontology category not found: ${categoryId}`);
    });
    tx();
}
export function deleteCategoryEmbedding(db, categoryId) {
    try {
        const tx = db.transaction(() => {
            db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
            db.prepare('UPDATE ontology_categories SET embedding_version = 0 WHERE id = ?').run(categoryId);
        });
        tx();
    }
    catch { /* table may not exist on very old DBs */ }
}
/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export function searchSimilarCategories(db, embedding, k = 20) {
    let hits;
    try {
        const generationGap = db.prepare(`
      SELECT 1
      FROM ontology_categories c
      LEFT JOIN vec_categories_rowids v ON v.id = c.id
      WHERE c.embedding_version != ? OR v.id IS NULL
      LIMIT 1
    `).get(EMBEDDING_VERSION);
        const staleVector = db.prepare(`
      SELECT 1
      FROM vec_categories_rowids v
      LEFT JOIN ontology_categories c ON c.id = v.id
      WHERE c.id IS NULL
      LIMIT 1
    `).get();
        if (generationGap || staleVector)
            return [];
        const dt = getVecTableDtype(db, 'vec_categories');
        hits = db.prepare(`
      SELECT id, distance FROM vec_categories
      WHERE embedding MATCH ${vecParamSql(dt)} ORDER BY distance LIMIT ?
    `).all(embeddingToVecBlob(embedding, dt), k);
        // ×127-scaled int8 distances → float32-equivalent scale for callers.
        for (const h of hits)
            h.distance = normalizeVecDistance(h.distance, dt);
    }
    catch {
        return []; // index absent → caller uses the full category list
    }
    const results = [];
    const catStmt = db.prepare('SELECT * FROM ontology_categories WHERE id = ?');
    const domStmt = db.prepare('SELECT name FROM ontology_domains WHERE id = ?');
    for (const h of hits) {
        const category = catStmt.get(h.id);
        if (!category)
            continue; // stale vector row (category was merged/deleted)
        const dom = domStmt.get(category.domain_id);
        results.push({ category, domainName: dom?.name ?? '?', distance: h.distance });
    }
    return results;
}
// === Fact Classification ===
/**
 * Persist a fact's ontology assignment. With `expectedSemanticGeneration`
 * the write becomes a CAS against the fact's meaning generation
 * (재감사 P1-2): a classification computed from an older meaning returns 0
 * changes and the caller must discard the stale result instead of stamping
 * it onto the newer meaning.
 */
export function classifyFact(db, factId, categoryId, expectedSemanticGeneration, expectedTaxonomyEpoch) {
    // 재감사 Privacy-P1(v4): epoch 캡처 이후 purge로 taxonomy가 invalidate됐으면
    // 0행으로 폐기한다. 이 검사와 아래 UPDATE는 동기 실행이라 원자적이다 —
    // 경계는 LLM/embedding await이고 캡처가 그 앞에 있다.
    if (expectedTaxonomyEpoch !== undefined && getTaxonomyEpoch(db) !== expectedTaxonomyEpoch) {
        return 0;
    }
    if (expectedSemanticGeneration === undefined) {
        return db.prepare(`UPDATE facts SET ontology_category_id = ?, updated_at = ? WHERE id = ?`).run(categoryId, new Date().toISOString(), factId).changes;
    }
    return db.prepare(`UPDATE facts SET ontology_category_id = ?, updated_at = ?
     WHERE id = ? AND semantic_generation = ?`).run(categoryId, new Date().toISOString(), factId, expectedSemanticGeneration).changes;
}
export function getFactsByCategory(db, categoryId, scopeProject, scopeType, identityScope) {
    let query = `SELECT * FROM facts WHERE ontology_category_id = ? AND is_active = 1`;
    const params = [categoryId];
    if (!identityScope && scopeType === 'global') {
        query += ` AND scope_type = 'global'`;
    }
    else if (!identityScope && scopeProject && scopeType !== 'all') {
        query += ` AND (scope_type = 'global' OR (scope_type = 'project' AND scope_project = ?))`;
        params.push(scopeProject);
    }
    query += ` ORDER BY consolidated_count DESC`;
    const facts = db.prepare(query).all(...params).map(rowToFact);
    return identityScope ? facts.filter((fact) => factMatchesScope(db, fact, identityScope)) : facts;
}
export function getFactsByDomain(db, domainId) {
    return db
        .prepare(`SELECT f.* FROM facts f
       JOIN ontology_categories c ON f.ontology_category_id = c.id
       WHERE c.domain_id = ? AND f.is_active = 1
       ORDER BY f.consolidated_count DESC`)
        .all(domainId)
        .map(rowToFact);
}
export function createRelation(db, sourceFactId, relationType, targetFactId, reasoning, opts = {}) {
    const insertTx = db.transaction(() => {
        if (opts.expectedSourceGeneration !== undefined ||
            opts.expectedTargetGeneration !== undefined) {
            const genStmt = db.prepare('SELECT semantic_generation FROM facts WHERE id = ?');
            const sourceGen = opts.expectedSourceGeneration === undefined
                ? opts.expectedSourceGeneration
                : genStmt.get(sourceFactId)?.semantic_generation;
            const targetGen = opts.expectedTargetGeneration === undefined
                ? opts.expectedTargetGeneration
                : genStmt.get(targetFactId)?.semantic_generation;
            if ((opts.expectedSourceGeneration !== undefined && sourceGen !== opts.expectedSourceGeneration) ||
                (opts.expectedTargetGeneration !== undefined && targetGen !== opts.expectedTargetGeneration)) {
                return null; // stale endpoint — discard the relation, not the newer meaning
            }
        }
        // Idempotent on the TRIPLE (source, type, target) — matching the UNIQUE
        // index. Retries (classification re-runs under a held-back
        // IndexRepairError, backfill re-selection) must not stack duplicate rows
        // of the SAME type; distinct relation TYPES between the same facts remain
        // valid, user-visible graph data (a SUPPORTS b + a CONTRADICTS b) and are
        // deliberately NOT collapsed — an LLM type-flap across retries therefore
        // adds at most one row per type (bounded by the 4-type enum).
        const existing = db
            .prepare(`SELECT * FROM ontology_relations
         WHERE source_fact_id = ? AND relation_type = ? AND target_fact_id = ?`)
            .get(sourceFactId, relationType, targetFactId);
        if (existing)
            return existing;
        const id = randomUUID();
        const now = new Date().toISOString();
        try {
            db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`).run(id, sourceFactId, relationType, targetFactId, reasoning ?? null, now);
        }
        catch (error) {
            // Recover ONLY from the expected unique-constraint race (another process
            // inserted the same triple between our check and insert) — any other
            // failure (schema, CHECK violation, corruption) must surface, not be
            // laundered into a fake winner lookup.
            const code = error.code ?? '';
            if (!code.startsWith('SQLITE_CONSTRAINT'))
                throw error;
            const winner = db
                .prepare(`SELECT * FROM ontology_relations
           WHERE source_fact_id = ? AND relation_type = ? AND target_fact_id = ?`)
                .get(sourceFactId, relationType, targetFactId);
            if (winner)
                return winner;
            throw error;
        }
        return {
            id,
            source_fact_id: sourceFactId,
            relation_type: relationType,
            target_fact_id: targetFactId,
            reasoning: reasoning ?? null,
            created_at: now,
        };
    });
    return insertTx.immediate();
}
/**
 * Get related facts with relevance decay.
 *
 * Each hop reduces relevance by the decay factor:
 * - hop 0 (direct): relevance = 1.0
 * - hop 1: relevance = decay (default 0.6)
 * - hop 2: relevance = decay^2 (default 0.36)
 *
 * Results are sorted by relevance descending.
 * Facts below minRelevance are pruned.
 */
/**
 * @param scopeProject - If provided, only return facts from this project or global scope.
 *                       Prevents cross-project noise in graph traversal.
 *                       Pass null/undefined to allow cross-project traversal (e.g., explore_graph).
 */
export function getRelatedFacts(db, factId, hops = 1, decay = 0.6, minRelevance = 0.2, scopeProject, scopeType, identityScope) {
    const visited = new Set([factId]);
    const results = [];
    let frontier = [factId];
    for (let hop = 0; hop < hops; hop++) {
        const hopRelevance = Math.pow(decay, hop);
        if (hopRelevance < minRelevance)
            break; // Prune entire hop if too weak
        const nextFrontier = [];
        for (const currentId of frontier) {
            // Outgoing relations (source → target).
            // Multiple relation TYPES may connect the same pair; the visited-set is
            // keyed by fact id, so exactly ONE edge per neighbour is surfaced. The
            // ORDER BY makes that choice DETERMINISTIC and belief-safety-first:
            // CONTRADICTS/SUPERSEDES must never be silently hidden behind an
            // affirmative SUPPORTS/INFLUENCES row that happened to come first.
            const outgoing = db
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.target_fact_id = f.id
           WHERE r.source_fact_id = ? AND f.is_active = 1
           ORDER BY CASE r.relation_type
             WHEN 'CONTRADICTS' THEN 0 WHEN 'SUPERSEDES' THEN 1
             WHEN 'SUPPORTS' THEN 2 ELSE 3 END, r.created_at`)
                .all(currentId);
            // Group candidate edges per neighbour (rows arrive in belief-safety
            // order): the surfaced edge is the FIRST one whose relevance clears
            // minRelevance — a safety edge that fails the floor must not consume
            // the neighbour's single slot and hide a qualifying affirmative edge.
            const outByNeighbour = new Map();
            for (const row of outgoing) {
                const targetId = row['target_fact_id'];
                if (visited.has(targetId))
                    continue;
                const rows = outByNeighbour.get(targetId);
                if (rows)
                    rows.push(row);
                else
                    outByNeighbour.set(targetId, [row]);
            }
            for (const [targetId, rows] of outByNeighbour) {
                const fact = rowToFact(rows[0]);
                // Scope filter:
                if (identityScope && !factMatchesScope(db, fact, identityScope))
                    continue;
                if (!identityScope && scopeType === 'global' && fact.scope_type !== 'global')
                    continue;
                if (!identityScope && scopeProject && fact.scope_type === 'project' && fact.scope_project !== scopeProject)
                    continue;
                // Select the surfaced edge FIRST: a neighbour with no qualifying
                // edge is PRUNED — it must not enter the frontier, or traversal
                // would leak paths through edges the relevance floor rejected
                // ("Facts below minRelevance are pruned" is a path contract, not
                // just a display filter).
                let chosen = null;
                for (const row of rows) {
                    const relation = rowToRelation(row);
                    // Relation type weight: SUPPORTS/INFLUENCES stronger than CONTRADICTS/SUPERSEDES
                    const typeWeight = (relation.relation_type === 'SUPPORTS' || relation.relation_type === 'INFLUENCES') ? 1.0 : 0.7;
                    const relevance = hopRelevance * typeWeight;
                    if (relevance >= minRelevance) {
                        chosen = { relation, relevance };
                        break;
                    }
                }
                if (!chosen)
                    continue;
                visited.add(targetId);
                nextFrontier.push(targetId);
                results.push({ fact, relation: chosen.relation, relevance: chosen.relevance, hop: hop + 1 });
            }
            // Incoming relations (target ← source)
            const incoming = db
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.source_fact_id = f.id
           WHERE r.target_fact_id = ? AND f.is_active = 1
           ORDER BY CASE r.relation_type
             WHEN 'CONTRADICTS' THEN 0 WHEN 'SUPERSEDES' THEN 1
             WHEN 'SUPPORTS' THEN 2 ELSE 3 END, r.created_at`)
                .all(currentId);
            // Same per-neighbour grouping as the outgoing side (see comment above).
            const inByNeighbour = new Map();
            for (const row of incoming) {
                const sourceId = row['source_fact_id'];
                if (visited.has(sourceId))
                    continue;
                const rows = inByNeighbour.get(sourceId);
                if (rows)
                    rows.push(row);
                else
                    inByNeighbour.set(sourceId, [row]);
            }
            for (const [sourceId, rows] of inByNeighbour) {
                const fact = rowToFact(rows[0]);
                // Scope filter:
                if (identityScope && !factMatchesScope(db, fact, identityScope))
                    continue;
                if (!identityScope && scopeType === 'global' && fact.scope_type !== 'global')
                    continue;
                if (!identityScope && scopeProject && fact.scope_type === 'project' && fact.scope_project !== scopeProject)
                    continue;
                // Same pruning contract as the outgoing side: no qualifying edge →
                // no frontier entry, no path leak.
                let chosen = null;
                for (const row of rows) {
                    const relation = rowToRelation(row);
                    const typeWeight = (relation.relation_type === 'SUPPORTS' || relation.relation_type === 'INFLUENCES') ? 1.0 : 0.7;
                    const relevance = hopRelevance * typeWeight;
                    if (relevance >= minRelevance) {
                        chosen = { relation, relevance };
                        break;
                    }
                }
                if (!chosen)
                    continue;
                visited.add(sourceId);
                nextFrontier.push(sourceId);
                results.push({ fact, relation: chosen.relation, relevance: chosen.relevance, hop: hop + 1 });
            }
        }
        frontier = nextFrontier;
        if (frontier.length === 0)
            break;
    }
    // Sort by relevance descending
    results.sort((a, b) => b.relevance - a.relevance);
    return results;
}
export function getRelationsForFact(db, factId) {
    return db
        .prepare(`SELECT * FROM ontology_relations
       WHERE source_fact_id = ? OR target_fact_id = ?
       ORDER BY created_at DESC`)
        .all(factId, factId);
}
// === Ontology Tree ===
export function getOntologyTree(db, scopeProject, scopeType, identityScope) {
    const domains = listDomains(db);
    const tree = [];
    for (const domain of domains) {
        const categories = listCategories(db, domain.id);
        const domainEntry = {
            domain,
            categories: [],
        };
        for (const category of categories) {
            const facts = getFactsByCategory(db, category.id, scopeProject, scopeType, identityScope);
            if (facts.length > 0 || (!scopeProject && !scopeType)) {
                domainEntry.categories.push({ category, facts });
            }
        }
        if (domainEntry.categories.length > 0 || (!scopeProject && !scopeType)) {
            tree.push(domainEntry);
        }
    }
    return tree;
}
// === Row Mappers ===
function rowToFact(row) {
    const embeddingRaw = row['embedding'];
    let embedding = null;
    if (embeddingRaw instanceof Buffer) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    else if (embeddingRaw instanceof Uint8Array) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    return {
        id: row['id'],
        fact: row['fact'],
        category: row['category'],
        scope_type: row['scope_type'],
        scope_project: row['scope_project'] ?? null,
        project_id: row['project_id'] ?? null,
        workspace_id: row['workspace_id'] ?? null,
        workstream_id: row['workstream_id'] ?? null,
        subject_key: row['subject_key'] ?? null,
        promotion_state: row['promotion_state'] ?? 'legacy-project',
        source_exchange_ids: row['source_exchange_ids']
            ? JSON.parse(row['source_exchange_ids'])
            : [],
        embedding,
        created_at: row['created_at'],
        updated_at: row['updated_at'],
        consolidated_count: row['consolidated_count'],
        is_active: Boolean(row['is_active']),
        semantic_generation: Number(row['semantic_generation'] ?? 1),
        semantic_updated_at: row['semantic_updated_at'] ?? null,
        lifecycle_generation: Number(row['lifecycle_generation'] ?? 1),
        lifecycle_updated_at: row['lifecycle_updated_at'] ?? null,
    };
}
function rowToRelation(row) {
    return {
        id: (row['rel_id'] ?? row['id']),
        source_fact_id: row['source_fact_id'],
        relation_type: row['relation_type'],
        target_fact_id: row['target_fact_id'],
        reasoning: row['reasoning'] ?? null,
        created_at: (row['rel_created_at'] ?? row['created_at']),
    };
}
