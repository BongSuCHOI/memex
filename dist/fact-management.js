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
import fs from 'node:fs';
import path from 'node:path';
import { getMemexHome } from './paths.js';
import { assertMutationPolicy, captureMutationPolicy, recordLocalMeaningEvidence, StaleFactMutationError } from './fact-policy.js';
export { StaleFactMutationError } from './fact-policy.js';
import { clearFactContextDependencies, getRevisions, mergeFactContextDependencies, vecParamFor, } from './fact-db.js';
import { generateEmbedding, EMBEDDING_VERSION } from './embeddings.js';
import { assignFactSubject, branchSignalFor } from './continuity-identity.js';
import { normalizeSlotText, purgeChronicleForSources, readChronicleTimeline, recordChronicleEvent, } from './chronicle.js';
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
      `).all(id)
        : [];
    return {
        ...fact,
        revisions: getRevisions(db, id),
        sources,
        context_dependencies: contextDependencies,
    };
}
/**
 * Thrown when a semantic mutation loses a race: the fact's text changed
 * between the caller's read and the mutation commit
 * (`expectedPreviousFact` mismatch), or an async derived writer's final
 * write found a newer semantic generation. The stale result must be
 * discarded — callers treat this as "someone else moved the fact", not as
 * an internal failure.
 */
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
 * transition, its Chronicle CHANGED event, and invalidation commit in one
 * transaction.
 */
export async function mutateFactMeaning(db, opts) {
    const policy = opts.policy ?? (opts.chronicle?.actor === 'user'
        ? captureMutationPolicy(db, 'user-correction', [opts.factId, ...(opts.deactivateFacts ?? []).map(fact => fact.id)]) : null);
    if (!policy)
        throw new Error('MutationPolicy is required; explicit user edits may use editFact');
    return mutateFactMeaningWithPolicy(db, { ...opts, policy });
}
export async function mutateFactMeaningWithPolicy(db, opts) {
    assertMutationPolicy(db, opts.policy, opts.factId, opts.newText);
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
    return applyFactMeaningMutationWithPolicy(db, opts, embedding);
}
/**
 * Synchronous core of the semantic mutation. Callers that already hold a
 * vector (the extractor's slot resolver) run it inside their own transaction;
 * better-sqlite3 nests it as a savepoint. The CHANGED event is appended after
 * the projection UPDATE inside the same transaction, so a failed projection
 * update leaves no event and a failed event leaves no projection change.
 */
export function applyFactMeaningMutation(db, opts, embedding) {
    if (!opts.policy)
        throw new Error('MutationPolicy is required for synchronous semantic mutation');
    return applyFactMeaningMutationWithPolicy(db, { ...opts, policy: opts.policy }, embedding);
}
export function applyFactMeaningMutationWithPolicy(db, opts, embedding) {
    const newText = String(opts.newText || '').trim();
    if (newText.length < 4)
        throw new Error('new fact text too short (min 4 chars)');
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
    const chronicle = opts.chronicle ?? { actor: 'consolidator' };
    const tx = db.transaction(() => {
        assertMutationPolicy(db, opts.policy, opts.factId, newText);
        opts.commitGuard?.();
        const current = db.prepare('SELECT fact, source_exchange_ids, semantic_generation, lifecycle_generation, project_id, subject_key FROM facts WHERE id = ?').get(opts.factId);
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
                // Absorbed participants can gain monotonic peer lineage during embedding.
                ...deactivateFacts.flatMap(({ id }) => {
                    const row = db.prepare('SELECT source_exchange_ids FROM facts WHERE id = ?').get(id);
                    return parseSourceExchangeIds(row?.source_exchange_ids ?? null);
                }),
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
    `).run(newText, JSON.stringify(sourceExchangeIds), embBuffer, now, EMBEDDING_VERSION, now, opts.factId, current.semantic_generation);
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
      `).all(opts.factId);
            const target = normalizeSlotText(newText);
            const fromValue = normalizeSlotText(current.fact);
            const reverted = candidates.find((row) => row.previous_fact !== null && normalizeSlotText(row.previous_fact) === target &&
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
        // A Chronicle transition may cite one primary exchange, but the local
        // verification receipt must retain the entire evidence set used by the policy.
        if (opts.policy.sources && ['verified-extraction', 'consolidation'].includes(opts.policy.kind)) {
            // 이슈 #45: 예전에는 void였고 실패가 조용했다 — 영수증 없는 fact는
            // 자동 통합에서 제외되는데 아무도 몰랐다(sync 충돌은 영수증이 아니라 이벤트 시각으로 판정).
            const recorded = recordLocalMeaningEvidence(db, opts.factId, newText, opts.policy.kind === 'consolidation' ? 'consolidator' : 'extractor', opts.policy.sources.map(source => source.id));
            if (!recorded) {
                console.error(`local meaning evidence NOT recorded for fact ${opts.factId} (${opts.policy.kind}): ` +
                    'source evidence changed or is unresolvable — rebuild with: memex backfill receipts');
            }
        }
        if (tableExists(db, 'fact_context_dependencies')) {
            if ((opts.mergeContextFromFactIds?.length ?? 0) > 0) {
                mergeFactContextDependencies(db, opts.factId, opts.mergeContextFromFactIds ?? []);
            }
            else {
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
            const rel = db.prepare('SELECT COUNT(*) AS c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(opts.factId, opts.factId);
            affectedRelations = Number(rel?.c ?? 0);
            if (affectedRelations > 0) {
                db.prepare('DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').run(opts.factId, opts.factId);
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
export async function editFact(db, id, opts) {
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
export function deactivateFactTransactional(db, id, options = {}) {
    const chronicle = options.chronicle === undefined ? { actor: 'user' } : options.chronicle;
    let eventId = null;
    const tx = db.transaction(() => {
        const now = new Date().toISOString();
        const current = db.prepare('SELECT fact, project_id, subject_key, semantic_generation, lifecycle_generation FROM facts WHERE id = ? AND is_active = 1')
            .get(id);
        const r = db.prepare('UPDATE facts SET is_active = 0, needs_consolidation = 0, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ? WHERE id = ? AND is_active = 1').run(now, now, id);
        if (r.changes === 0 || !current)
            throw new Error(`no active fact with id: ${id} (not found or already inactive)`);
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
        if (tableExists(db, 'vec_facts_kr'))
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
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
export async function restoreFact(db, id, options = {}) {
    const chronicle = options.chronicle === undefined ? { actor: 'user' } : options.chronicle;
    const row = db
        .prepare('SELECT fact, embedding, embedding_version, semantic_generation, lifecycle_generation, project_id, subject_key FROM facts WHERE id = ? AND is_active = 0')
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
    let eventId = null;
    const recordRestored = (now) => {
        if (!chronicle)
            return;
        const retired = db.prepare(`
      SELECT id FROM fact_revisions WHERE fact_id = ? AND event_kind = 'RETIRED'
      ORDER BY effective_at DESC, recorded_at DESC, COALESCE(chronicle_seq, rowid) DESC LIMIT 1
    `).get(id);
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
    const tx = db.transaction(() => {
        if (vector && tableExists(db, 'vec_facts')) {
            const now = new Date().toISOString();
            const claimed = db.prepare('UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ?, embedding = ?, embedding_version = ? WHERE id = ? AND is_active = 0 AND semantic_generation = ? AND lifecycle_generation = ?').run(now, now, Buffer.from(new Float32Array(vector).buffer), EMBEDDING_VERSION, id, row.semantic_generation, row.lifecycle_generation);
            if (claimed.changes === 0)
                return 'stale';
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
        const claimed = db.prepare('UPDATE facts SET is_active = 1, needs_consolidation = 1, lifecycle_generation = lifecycle_generation + 1, lifecycle_updated_at = ?, updated_at = ? WHERE id = ? AND is_active = 0 AND semantic_generation = ? AND lifecycle_generation = ?').run(plainNow, plainNow, id, row.semantic_generation, row.lifecycle_generation);
        if (claimed.changes === 0)
            return 'stale';
        recordRestored(plainNow);
        return 'plain';
    });
    const outcome = tx();
    if (outcome === 'stale') {
        throw new StaleFactMutationError(`restore discarded: fact ${id} changed meaning or state during restore`);
    }
    return { restored: true, vectorRestored: outcome === 'vector', reembedded, eventId };
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
/** Chronicle timeline for one fact in effective order (oldest first). */
export function factHistory(db, id) {
    return readChronicleTimeline(db, { factId: id, order: 'asc', limit: 100 }).events;
}
export function recordFactTombstone(db, id, reason = null, deletedAt = new Date().toISOString()) {
    db.prepare(`
    INSERT INTO fact_tombstones (fact_id, deleted_at, reason)
    VALUES (?, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      reason = CASE WHEN fact_tombstones.reason = 'source_conversation_excluded'
        THEN fact_tombstones.reason ELSE excluded.reason END
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
    const contextDependencies = tableExists(db, 'fact_context_dependencies')
        ? Number(db.prepare('SELECT COUNT(*) AS c FROM fact_context_dependencies WHERE fact_id = ?').get(id).c)
        : 0;
    return { exists, revisions, relations, contextDependencies };
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
        const prior = db.prepare('SELECT reason FROM fact_tombstones WHERE fact_id = ?').get(id);
        const reason = prior?.reason === 'source_conversation_excluded' ? prior.reason : 'hard_delete';
        recordFactTombstone(db, id, reason);
        if (tableExists(db, 'vec_facts'))
            db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
        if (tableExists(db, 'vec_facts_kr'))
            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
        purgeChronicleForSources(db, { exchangeIds: new Set(), factIds: new Set([id]), reason });
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
const TIER_ORDER = ['workstream', 'project', 'global'];
/** A one-rung rule violation. Never thrown for a legal `user-directive` skip. */
export class TierStepError extends Error {
    from;
    to;
    constructor(from, to) {
        super(`tier ladder moves one step at a time: ${from} → ${to} is not adjacent`);
        this.name = 'TierStepError';
        this.from = from;
        this.to = to;
    }
}
export function factTierOf(row) {
    if (row.scope_type === 'global')
        return 'global';
    const state = row.promotion_state ?? 'legacy-project';
    return state === 'workstream' || state === 'workspace' ? 'workstream' : 'project';
}
export function readFactTier(db, id) {
    const row = db.prepare(`
    SELECT id, scope_type, promotion_state, project_id, workspace_id, workstream_id,
           subject_key, tier_reason, is_active
    FROM facts WHERE id = ?
  `).get(id);
    if (!row)
        throw new Error(`fact not found: ${id}`);
    return {
        id: String(row.id),
        tier: factTierOf({ scope_type: String(row.scope_type), promotion_state: row.promotion_state }),
        scopeType: String(row.scope_type),
        promotionState: String(row.promotion_state ?? 'legacy-project'),
        projectId: row.project_id ?? null,
        workspaceId: row.workspace_id ?? null,
        workstreamId: row.workstream_id ?? null,
        subjectKey: row.subject_key ?? null,
        tierReason: row.tier_reason ?? null,
        isActive: Number(row.is_active) === 1,
    };
}
function globalSubjectKey(current, factId) {
    if (current && current.startsWith('global.'))
        return current.slice(0, 160);
    const base = current && /^[a-z][a-z0-9_.-]*$/.test(current)
        ? current.replace(/^(workstream|workspace|project-current|decision|legacy-project)\./, '')
        : `fact.${factId}`;
    return `global.${base}`.slice(0, 160);
}
function projectSubjectKey(current, factId) {
    const stripped = current?.startsWith('global.') ? current.slice('global.'.length) : current;
    return stripped && /^[a-z][a-z0-9_.-]{2,160}$/.test(stripped) ? stripped : `project-current.fact.${factId}`;
}
function projectScopePath(db, projectId) {
    const row = db.prepare(`
    SELECT canonical_path FROM workspaces WHERE project_id = ? ORDER BY created_at, workspace_id LIMIT 1
  `).get(projectId);
    return row?.canonical_path ?? null;
}
/** Project/workstream a fact came from, read back from its own source exchanges. */
function originScope(db, factId) {
    const raw = db.prepare('SELECT source_exchange_ids FROM facts WHERE id = ?').get(factId)?.source_exchange_ids;
    const ids = parseSourceExchangeIds(raw ?? null);
    if (ids.length === 0)
        return { projectId: null, workspaceId: null, workstreamId: null };
    const row = db.prepare(`
    SELECT project_id, workspace_id, workstream_id FROM exchanges
    WHERE id IN (${ids.map(() => '?').join(',')}) AND project_id IS NOT NULL
    ORDER BY timestamp DESC, rowid DESC LIMIT 1
  `).get(...ids);
    return {
        projectId: row?.project_id ?? null,
        workspaceId: row?.workspace_id ?? null,
        workstreamId: row?.workstream_id ?? null,
    };
}
function appendUiAudit(action, detail) {
    try {
        const dir = path.join(getMemexHome(), 'logs');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, 'ui-audit.jsonl');
        const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
        if (stat?.isSymbolicLink())
            return;
        // Metadata only, matching ui/lib/logs.cjs: never fact text or prompts.
        fs.appendFileSync(file, `${JSON.stringify({
            ts: new Date().toISOString(), source: 'memex-core', action,
            status: detail.status, id: detail.id, project: detail.project,
            operation: null, error_code: null,
        })}\n`, { mode: 0o600 });
    }
    catch { /* auditing is best-effort and never blocks the mutation */ }
}
/** One rung. Must run inside the caller's transaction. */
function applyTierStep(db, state, to, options, recordedAt) {
    const from = state.tier;
    const evidence = options.evidence ?? [];
    const reason = options.reason?.trim() || null;
    let projectId = state.projectId;
    let subjectKey = state.subjectKey;
    if (to === 'global') {
        subjectKey = globalSubjectKey(state.subjectKey, state.id);
        db.prepare(`
      UPDATE facts SET scope_type = 'global', scope_project = NULL, project_id = NULL,
        workspace_id = NULL, workstream_id = NULL, promotion_state = 'legacy-project',
        subject_key = ?, tier_reason = ?,
        semantic_generation = semantic_generation + 1, semantic_updated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(subjectKey, `tier:${options.actor}`, recordedAt, recordedAt, state.id);
    }
    else if (from === 'global') {
        const target = options.projectId ?? originScope(db, state.id).projectId;
        if (!target)
            throw new Error('demoting a global fact requires a target project');
        projectId = target;
        subjectKey = projectSubjectKey(state.subjectKey, state.id);
        db.prepare(`
      UPDATE facts SET scope_type = 'project', scope_project = ?, project_id = ?,
        workspace_id = NULL, workstream_id = NULL, promotion_state = 'project-current',
        subject_key = ?, tier_reason = ?,
        semantic_generation = semantic_generation + 1, semantic_updated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(projectScopePath(db, target), target, subjectKey, `tier:${options.actor}`, recordedAt, recordedAt, state.id);
    }
    else if (to === 'project') {
        if (!projectId || !subjectKey)
            throw new Error('promoting to project requires project identity');
        assignFactSubject(db, {
            factId: state.id, projectId, subjectKey,
            promotionState: 'project-current', evidence: 'validated',
            tierReason: `tier:${options.actor}`,
        });
    }
    else {
        const workstreamId = options.workstreamId ?? originScope(db, state.id).workstreamId;
        if (!projectId || !subjectKey)
            throw new Error('demoting to workstream requires project identity');
        if (!workstreamId)
            throw new Error('demoting to the branch tier requires a workstream');
        assignFactSubject(db, {
            factId: state.id, projectId, subjectKey,
            promotionState: 'workstream', evidence: 'experimental',
            workstreamId, tierReason: `tier:${options.actor}`,
        });
    }
    const { event } = recordChronicleEvent(db, {
        kind: TIER_ORDER.indexOf(to) > TIER_ORDER.indexOf(from) ? 'PROMOTED' : 'DEMOTED',
        projectId,
        subjectKey,
        factId: state.id,
        outcome: {
            from_tier: from,
            to_tier: to,
            actor: options.actor,
            reason,
            evidence_ids: [...evidence].sort(),
            ...(options.evidenceFactIds?.length ? { evidence_fact_ids: [...options.evidenceFactIds].sort() } : {}),
        },
        sourceExchangeIds: evidence,
        userStatedRationale: (options.actor === 'user' || options.actor === 'user-directive') ? reason : null,
        actor: options.actor === 'user-directive' ? 'user-directive' : options.actor === 'auto' ? 'auto' : 'user',
        evidenceAuthority: options.actor === 'auto' ? 'unknown' : 'human-decision',
        effectiveAt: recordedAt,
        effectiveAtSource: 'recorded',
        recordedAt,
        projectionApplied: true,
    });
    return { eventId: event.id, next: readFactTier(db, state.id) };
}
function moveFactTier(db, id, direction, options) {
    const recordedAt = options.now ?? new Date().toISOString();
    const start = readFactTier(db, id);
    const fromIndex = TIER_ORDER.indexOf(start.tier);
    const target = options.to ?? TIER_ORDER[fromIndex + direction];
    if (!target)
        throw new TierStepError(start.tier, direction > 0 ? 'global' : 'workstream');
    if (!TIER_ORDER.includes(target)) {
        throw new Error(`unknown tier: ${String(target)} (expected ${TIER_ORDER.join(' | ')})`);
    }
    const toIndex = TIER_ORDER.indexOf(target);
    if (toIndex === fromIndex)
        throw new TierStepError(start.tier, target);
    if (Math.sign(toIndex - fromIndex) !== direction)
        throw new TierStepError(start.tier, target);
    const distance = Math.abs(toIndex - fromIndex);
    // Only an explicit in-session scope directive may name a rung two steps
    // away; it is still executed one rung at a time and leaves two events.
    if (distance > 1 && options.actor !== 'user-directive')
        throw new TierStepError(start.tier, target);
    const steps = [];
    const tx = db.transaction(() => {
        let state = start;
        for (let i = fromIndex; i !== toIndex; i += direction) {
            const next = TIER_ORDER[i + direction];
            const applied = applyTierStep(db, state, next, options, recordedAt);
            steps.push({ from: state.tier, to: next, eventId: applied.eventId });
            state = applied.next;
        }
    });
    db.inTransaction ? tx() : tx.immediate();
    if (options.actor === 'user') {
        appendUiAudit(direction > 0 ? 'fact.promote' : 'fact.demote', {
            id, project: start.projectId, status: 'ok',
        });
    }
    return { id, from: start.tier, to: target, steps };
}
export function promoteFact(db, id, options) {
    return moveFactTier(db, id, 1, options);
}
export function demoteFact(db, id, options) {
    return moveFactTier(db, id, -1, options);
}
/** Move a fact to the tier an in-session scope directive named. No-op when already there. */
export function applyScopeDirective(db, id, directive, options = {}) {
    const state = readFactTier(db, id);
    if (state.tier === directive)
        return null;
    const move = {
        actor: 'user-directive',
        reason: options.reason ?? `in-session scope directive: ${directive}`,
        evidence: options.evidence,
        to: directive,
        now: options.now,
    };
    return TIER_ORDER.indexOf(directive) > TIER_ORDER.indexOf(state.tier)
        ? promoteFact(db, id, move)
        : demoteFact(db, id, move);
}
/**
 * Evidence-based automatic ladder pass. Model-free: every decision below is a
 * SQL fact about the projection, never a judgement about meaning.
 *
 *   workstream → project : the same subject_key is confirmed outside this
 *                          workstream (another branch, or a project-common
 *                          session with no branch signal).
 *   project → global     : the same fact text is confirmed in ≥2 projects.
 *   demotion             : the upper evidence an automatic promotion cited is
 *                          gone — every cited fact is inactive or deleted.
 */
export function reconcileFactTiers(db, options = {}) {
    const result = { promoted: [], demoted: [], skipped: [] };
    const now = options.now ?? new Date().toISOString();
    if (!tableExists(db, 'facts') || !tableExists(db, 'fact_revisions'))
        return result;
    const step = (id, direction, reason, evidenceFactIds, to) => {
        try {
            const options = { actor: 'auto', reason, evidenceFactIds, now, ...(to ? { to } : {}) };
            const move = direction > 0
                ? promoteFact(db, id, options)
                : demoteFact(db, id, options);
            (direction > 0 ? result.promoted : result.demoted).push({
                id, from: move.from, to: move.to, reason,
            });
        }
        catch (error) {
            result.skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
        }
    };
    // #60 — a slot whose active branch facts disagree on their text holds two
    // competing branch truths, not one re-confirmed truth. No SQL fact says which
    // sentence is right, so nothing is promoted and the slot is reported instead.
    const conflictingSlots = db.prepare(`
    SELECT f.project_id AS projectId, f.subject_key AS subjectKey, GROUP_CONCAT(f.id) AS ids
    FROM facts f
    WHERE f.is_active = 1 AND f.promotion_state = 'workstream'
      AND f.project_id IS NOT NULL AND f.subject_key IS NOT NULL
    GROUP BY f.project_id, f.subject_key
    HAVING COUNT(DISTINCT LOWER(TRIM(f.fact))) >= 2
    ORDER BY f.project_id, f.subject_key
  `).all();
    const conflictedSlots = new Set();
    for (const slot of conflictingSlots) {
        conflictedSlots.add(`${slot.projectId} ${slot.subjectKey}`);
        for (const id of String(slot.ids ?? '').split(',').filter(Boolean).sort()) {
            result.skipped.push({ id, reason: 'slot has conflicting branch truths' });
        }
    }
    // 1. Branch truth re-confirmed outside its own branch becomes project truth.
    //    Only the slot's earliest branch fact moves, so a slot confirmed from two
    //    branches promotes one deterministic row instead of racing for the slot.
    //    #60 — "re-confirmed" means the SAME normalized text (the normalizer pass
    //    2 already uses); without it, two branches that disagree on one slot read
    //    as confirmation and whichever row was created first became the project
    //    truth.
    const confirmedOutsideBranch = db.prepare(`
    SELECT f.id AS id, f.project_id AS projectId, f.subject_key AS subjectKey, MIN(g.id) AS witness
    FROM facts f
    JOIN facts g ON g.project_id = f.project_id AND g.subject_key = f.subject_key
      AND g.id <> f.id AND g.is_active = 1
      AND COALESCE(g.workstream_id, '') <> COALESCE(f.workstream_id, '')
      AND LOWER(TRIM(g.fact)) = LOWER(TRIM(f.fact))
    WHERE f.is_active = 1 AND f.promotion_state = 'workstream'
      AND f.project_id IS NOT NULL AND f.subject_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM facts h
        WHERE h.is_active = 1 AND h.promotion_state = 'workstream'
          AND h.project_id = f.project_id AND h.subject_key = f.subject_key
          AND (h.created_at, h.id) < (f.created_at, f.id)
      )
    GROUP BY f.id
    ORDER BY f.id
  `).all();
    for (const row of confirmedOutsideBranch) {
        if (conflictedSlots.has(`${row.projectId} ${row.subjectKey}`))
            continue;
        step(row.id, 1, 'subject re-confirmed outside this workstream', [row.witness]);
    }
    // 2. The same project truth confirmed in two or more projects becomes global.
    //    The GROUP BY is the content check: every witness in a group shares the
    //    same LOWER(TRIM(fact)), so #60's conflicting-text case cannot arise here.
    const crossProject = db.prepare(`
    SELECT MIN(f.id) AS id, COUNT(DISTINCT f.project_id) AS projects,
           GROUP_CONCAT(f.id) AS witnesses
    FROM facts f
    WHERE f.is_active = 1 AND f.scope_type = 'project' AND f.project_id IS NOT NULL
      AND f.promotion_state IN ('project-current','decision','legacy-project')
    GROUP BY LOWER(TRIM(f.fact))
    HAVING projects >= 2
    ORDER BY id
  `).all();
    for (const row of crossProject) {
        const witnesses = String(row.witnesses ?? '').split(',').filter((v) => v && v !== row.id);
        step(row.id, 1, `confirmed in ${row.projects} projects`, witnesses);
    }
    const tierEvents = db.prepare(`
    SELECT r.id AS eventId, r.fact_id AS id, r.event_kind AS eventKind, r.actor AS actor,
           r.outcome_json AS outcomeJson
    FROM fact_revisions r
    JOIN facts f ON f.id = r.fact_id AND f.is_active = 1
    WHERE r.event_kind IN ('PROMOTED', 'DEMOTED') AND r.fact_id IS NOT NULL
    ORDER BY r.chronicle_seq DESC
  `).all();
    const latestTierEvent = new Map();
    const latestAutoPromotion = new Map();
    for (const row of tierEvents) {
        if (!latestTierEvent.has(row.id))
            latestTierEvent.set(row.id, row);
        if (row.eventKind === 'PROMOTED' && row.actor === 'auto' && !latestAutoPromotion.has(row.id)) {
            latestAutoPromotion.set(row.id, row);
        }
    }
    for (const factId of [...latestAutoPromotion.keys()].sort()) {
        const promotion = latestAutoPromotion.get(factId);
        let cited = [];
        let fromTier = null;
        let toTier = null;
        try {
            const parsed = JSON.parse(promotion.outcomeJson ?? '{}');
            cited = Array.isArray(parsed.evidence_fact_ids)
                ? parsed.evidence_fact_ids.filter((v) => typeof v === 'string')
                : [];
            fromTier = typeof parsed.from_tier === 'string' ? parsed.from_tier : null;
            toTier = typeof parsed.to_tier === 'string' ? parsed.to_tier : null;
        }
        catch {
            cited = [];
        }
        if (cited.length === 0)
            continue;
        const alive = db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND id IN (${cited.map(() => '?').join(',')})`).get(...cited).n;
        if (alive > 0)
            continue;
        const latest = latestTierEvent.get(factId);
        if (!latest || latest.eventId !== promotion.eventId) {
            result.skipped.push({
                id: factId,
                reason: latest?.actor === 'user' || latest?.actor === 'user-directive'
                    ? 'superseded by a user decision'
                    : `superseded by a later ${latest?.actor ?? 'unknown'} tier event`,
            });
            continue;
        }
        if (!fromTier || !TIER_ORDER.includes(fromTier) || toTier !== readFactTier(db, factId).tier) {
            result.skipped.push({ id: factId, reason: 'recorded promotion no longer matches the current tier' });
            continue;
        }
        step(factId, -1, 'upper evidence is no longer active', cited, fromTier);
    }
    return result;
}
export function listTierMigrationCandidates(db) {
    if (!tableExists(db, 'minimal_workstreams') || !tableExists(db, 'workspaces'))
        return [];
    const rows = db.prepare(`
    SELECT f.id, f.fact, f.project_id, f.subject_key, f.workstream_id,
           w.branch_hint, ws.default_branch
    FROM facts f
    LEFT JOIN minimal_workstreams w ON w.workstream_id = f.workstream_id
    LEFT JOIN workspaces ws ON ws.workspace_id = COALESCE(f.workspace_id, w.workspace_id)
    WHERE f.is_active = 1 AND f.promotion_state = 'workstream' AND f.project_id IS NOT NULL
    ORDER BY f.created_at, f.id
  `).all();
    const candidates = [];
    for (const row of rows) {
        const signal = branchSignalFor({ branch: row.branch_hint, defaultBranch: row.default_branch });
        if (signal.kind === 'branch')
            continue;
        candidates.push({
            id: row.id,
            fact: row.fact,
            projectId: row.project_id,
            subjectKey: row.subject_key ?? `workstream.fact.${row.id}`,
            workstreamId: row.workstream_id,
            branchHint: row.branch_hint,
            tierReason: signal.tierReason,
        });
    }
    return candidates;
}
export function applyTierMigration(db, options = {}) {
    const result = { promoted: [], skipped: [] };
    const recordedAt = options.now ?? new Date().toISOString();
    for (const candidate of listTierMigrationCandidates(db)) {
        const tx = db.transaction(() => {
            assignFactSubject(db, {
                factId: candidate.id,
                projectId: candidate.projectId,
                subjectKey: candidate.subjectKey,
                promotionState: 'project-current',
                evidence: 'no-branch-signal',
                tierReason: 'no-branch-signal',
            });
            recordChronicleEvent(db, {
                kind: 'PROMOTED',
                projectId: candidate.projectId,
                subjectKey: candidate.subjectKey,
                factId: candidate.id,
                outcome: {
                    from_tier: 'workstream',
                    to_tier: 'project-current',
                    actor: 'migration',
                    reason: 'no-branch-signal',
                    evidence_ids: [],
                },
                actor: 'migration',
                evidenceAuthority: 'unknown',
                recordedAt,
                effectiveAt: recordedAt,
                effectiveAtSource: 'recorded',
                projectionApplied: true,
            });
        });
        try {
            tx();
            result.promoted.push(candidate.id);
        }
        catch (error) {
            result.skipped.push({ id: candidate.id, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return result;
}
