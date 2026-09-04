import { randomUUID } from "crypto";
import { EMBEDDING_VERSION } from "./embeddings.js";
import { getVecTableDtype, embeddingToVecBlob, vecParamSql, normalizeVecDistance, l2DistanceToSimilarity, } from "./db.js";
import { resolveProjectWorkspace } from "./continuity-identity.js";
import { readChronicleTimeline, recordChronicleEvent } from "./chronicle.js";
/** Dtype-aware MATCH/INSERT parameter for a fact-side vector table. */
export function vecParamFor(db, table, embedding) {
    const dt = getVecTableDtype(db, table);
    return { sql: vecParamSql(dt), blob: embeddingToVecBlob(embedding, dt), dt };
}
export function insertFactContextDependencies(db, factId, dependencies) {
    if (dependencies.length === 0)
        return;
    const insert = db.prepare(`
    INSERT OR IGNORE INTO fact_context_dependencies
      (fact_id, exchange_id, dependency_kind, created_at)
    VALUES (?, ?, ?, ?)
  `);
    const now = new Date().toISOString();
    const seen = new Set();
    for (const dependency of dependencies) {
        const key = `${dependency.exchange_id}\u0000${dependency.dependency_kind}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        insert.run(factId, dependency.exchange_id, dependency.dependency_kind, now);
    }
}
/** Copy local interpretive lineage into a survivor. Caller owns transaction. */
export function mergeFactContextDependencies(db, targetFactId, sourceFactIds) {
    const copy = db.prepare(`
    INSERT OR IGNORE INTO fact_context_dependencies
      (fact_id, exchange_id, dependency_kind, created_at)
    SELECT ?, exchange_id, dependency_kind, created_at
    FROM fact_context_dependencies
    WHERE fact_id = ?
  `);
    for (const sourceFactId of new Set(sourceFactIds)) {
        if (sourceFactId === targetFactId)
            continue;
        copy.run(targetFactId, sourceFactId);
    }
}
export function clearFactContextDependencies(db, factId) {
    db.prepare("DELETE FROM fact_context_dependencies WHERE fact_id = ?").run(factId);
}
/**
 * Stable identity and promotion placement for a fact about to be inserted.
 * Shared by insertFact and the extractor's subject-slot resolver so both see
 * the same slot before deciding whether to insert, merge, change or contradict.
 */
export function resolveFactInsertIdentity(db, params) {
    const now = new Date().toISOString();
    let projectId = params.project_id ?? null;
    let workspaceId = params.workspace_id ?? null;
    let workstreamId = params.workstream_id ?? null;
    if (params.scope_type === "project" && params.source_exchange_ids.length > 0) {
        const placeholders = params.source_exchange_ids.map(() => "?").join(",");
        const sources = db.prepare(`
      SELECT DISTINCT project_id, workspace_id, workstream_id
      FROM exchanges WHERE id IN (${placeholders})
    `).all(...params.source_exchange_ids);
        const same = (key) => {
            const values = [...new Set(sources.map((row) => row[key]).filter(Boolean))];
            return values.length === 1 ? values[0] : null;
        };
        projectId ??= same("project_id");
        workspaceId ??= same("workspace_id");
        workstreamId ??= same("workstream_id");
    }
    if (params.scope_type === "project" && !projectId && params.scope_project) {
        const identity = resolveProjectWorkspace(db, { cwd: params.scope_project, now });
        projectId = identity.projectId;
        workspaceId ??= identity.workspaceId;
    }
    const promotionState = params.promotion_state ?? (params.scope_type === "project" && workstreamId ? "workstream" : "legacy-project");
    const promotionEvidence = params.promotion_evidence ?? (params.promotion_state === undefined && promotionState === "workstream" ? "experimental" : undefined);
    if (promotionState === "decision" && promotionEvidence !== "explicit-decision") {
        throw new Error("project decision requires explicit decision evidence");
    }
    if (promotionState === "project-current" &&
        promotionEvidence !== "merged" && promotionEvidence !== "validated") {
        throw new Error("project current state requires merged or validated evidence");
    }
    if (promotionState === "workspace" && (!workspaceId || promotionEvidence !== "validated")) {
        throw new Error("workspace state requires workspace_id and validated evidence");
    }
    if (promotionState === "workstream" && (!workstreamId || promotionEvidence !== "experimental")) {
        throw new Error("workstream state requires workstream_id and experimental evidence");
    }
    if ((promotionState === "decision" || promotionState === "project-current") &&
        (workspaceId || workstreamId)) {
        throw new Error("project-wide truth cannot retain workspace/workstream scope");
    }
    if (promotionState === "workspace" && workstreamId) {
        throw new Error("workspace truth cannot retain workstream scope");
    }
    if (params.scope_type === "project" && projectId && workspaceId) {
        const workspace = db.prepare("SELECT project_id FROM workspaces WHERE workspace_id = ?")
            .get(workspaceId);
        if (!workspace || workspace.project_id !== projectId) {
            throw new Error("fact workspace_id is outside project_id");
        }
    }
    if (params.scope_type === "project" && projectId && workstreamId) {
        const workstream = db.prepare("SELECT project_id FROM minimal_workstreams WHERE workstream_id = ?")
            .get(workstreamId);
        if (!workstream || workstream.project_id !== projectId) {
            throw new Error("fact workstream_id is outside project_id");
        }
    }
    return { projectId, workspaceId, workstreamId, promotionState };
}
export function insertFact(db, params) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { projectId, workspaceId, workstreamId, promotionState } = resolveFactInsertIdentity(db, params);
    const subjectKey = params.subject_key ?? (params.scope_type === "global" ? `global.fact.${id}` : `${promotionState}.fact.${id}`);
    db.prepare(`
    INSERT INTO facts (
      id, fact, category, scope_type, scope_project, source_exchange_ids, embedding,
      created_at, updated_at, consolidated_count, is_active, fact_kr,
      embedding_version, semantic_generation, semantic_updated_at,
      project_id, workspace_id, workstream_id, subject_key, promotion_state
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).run(id, params.fact, params.category, params.scope_type, params.scope_project, JSON.stringify(params.source_exchange_ids), params.embedding
        ? Buffer.from(new Float32Array(params.embedding).buffer)
        : null, now, now, params.fact_kr ?? null, EMBEDDING_VERSION, now, projectId, workspaceId, workstreamId, subjectKey, promotionState);
    // Insert into vector index (atomic DELETE+INSERT via transaction)
    if (params.embedding) {
        const p = vecParamFor(db, "vec_facts", params.embedding);
        const upsertVec = db.transaction((vecId, buf) => {
            db.prepare("DELETE FROM vec_facts WHERE id = ?").run(vecId);
            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${p.sql})`).run(vecId, buf);
        });
        upsertVec(id, p.blob);
    }
    // Korean-text vector index (same-language matching for Korean queries)
    if (params.embedding_kr) {
        const pk = vecParamFor(db, "vec_facts_kr", params.embedding_kr);
        const upsertVecKr = db.transaction((vecId, buf) => {
            db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(vecId);
            db.prepare(`INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${pk.sql})`).run(vecId, buf);
        });
        upsertVecKr(id, pk.blob);
    }
    return id;
}
export function getActiveFacts(db) {
    return db
        .prepare("SELECT * FROM facts WHERE is_active = 1 ORDER BY consolidated_count DESC")
        .all().map(rowToFact);
}
export function getFactsByProject(db, project) {
    return db
        .prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
  `)
        .all(project).map(rowToFact);
}
export function updateFact(db, id, params) {
    // Fact text is semantic state — changing it must swap every derived
    // generation (embedding, vectors, KR, ontology, relations, revision) in one
    // commit. That is the semantic mutation service's contract; this low-level
    // updater must never grow a text-only shortcut again.
    if ("fact" in params) {
        throw new Error("updateFact cannot change fact text — use the semantic mutation service (fact-management.mutateFactMeaning)");
    }
    const now = new Date().toISOString();
    const updates = ["updated_at = ?"];
    const values = [now];
    if (params.embedding !== undefined) {
        updates.push("embedding = ?");
        values.push(params.embedding
            ? Buffer.from(new Float32Array(params.embedding).buffer)
            : null);
    }
    if (params.consolidated_count_increment) {
        updates.push("consolidated_count = consolidated_count + 1");
    }
    if (params.source_exchange_ids !== undefined) {
        updates.push("source_exchange_ids = ?");
        values.push(JSON.stringify([...new Set(params.source_exchange_ids)]));
    }
    values.push(id);
    db.prepare(`UPDATE facts SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    // Update vector index (atomic DELETE+INSERT via transaction)
    if (params.embedding) {
        const p = vecParamFor(db, "vec_facts", params.embedding);
        const upsertVec = db.transaction((vecId, buf) => {
            db.prepare("DELETE FROM vec_facts WHERE id = ?").run(vecId);
            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${p.sql})`).run(vecId, buf);
        });
        upsertVec(id, p.blob);
    }
}
export function deactivateFact(db, id) {
    const now = new Date().toISOString();
    db.prepare(`
    UPDATE facts SET is_active = 0, needs_consolidation = 0,
      lifecycle_generation = lifecycle_generation + 1,
      lifecycle_updated_at = ?, updated_at = ?
    WHERE id = ? AND is_active = 1
  `).run(now, now, id);
    // Deactivated facts must not occupy vector index slots
    db.prepare("DELETE FROM vec_facts WHERE id = ?").run(id);
    db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(id);
}
export function deleteFact(db, id) {
    db.transaction(() => {
        db.prepare(`
      INSERT INTO fact_tombstones (fact_id, deleted_at, reason)
      VALUES (?, ?, 'legacy_delete')
      ON CONFLICT(fact_id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason
    `).run(id, new Date().toISOString());
        db.prepare("DELETE FROM vec_facts WHERE id = ?").run(id);
        db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(id);
        db.prepare("DELETE FROM fact_revisions WHERE fact_id = ?").run(id);
        db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    })();
}
/**
 * Compatibility writer for callers that only know the released revision
 * shape. It appends a Chronicle CHANGED event; the free-text reason is a
 * classifier note because this path carries no source-cited cause.
 */
export function insertRevision(db, params) {
    const fact = db.prepare("SELECT project_id, subject_key, semantic_generation FROM facts WHERE id = ?")
        .get(params.fact_id);
    const { event } = recordChronicleEvent(db, {
        kind: "CHANGED",
        projectId: fact?.project_id ?? null,
        subjectKey: fact?.subject_key ?? null,
        factId: params.fact_id,
        previousValue: params.previous_fact,
        newValue: params.new_fact,
        classifierNote: params.reason,
        sourceExchangeIds: params.source_exchange_id ? [params.source_exchange_id] : [],
        actor: params.actor ?? "legacy",
        projectionApplied: true,
        toSemanticGeneration: fact ? Number(fact.semantic_generation) : null,
    });
    return event.id;
}
/** Released revision view over the Chronicle: newest effective change first. */
export function getRevisions(db, factId) {
    const page = readChronicleTimeline(db, { factId, order: "desc", limit: 100 });
    return page.events.map((event) => ({
        id: event.id,
        fact_id: event.fact_id ?? factId,
        previous_fact: event.previous_value ?? "",
        new_fact: event.new_value ?? "",
        reason: event.rationale ?? event.grounded_cause ?? event.classifier_note ?? null,
        source_exchange_id: event.source_exchange_ids[0] ?? null,
        created_at: event.recorded_at,
        event_kind: event.event_kind,
        effective_at: event.effective_at,
        projection_applied: event.projection_applied,
    }));
}
function factMatchesSearch(fact, scope, filters, sessionExchangeIds) {
    if (filters.category && fact.category !== filters.category)
        return false;
    switch (scope.type) {
        case "global":
            return fact.scope_type === "global";
        case "all":
            return true;
        case "project":
            return (fact.scope_type === "global" ||
                (fact.scope_type === "project" && fact.scope_project === scope.project));
        case "exact-project":
            return (fact.scope_type === "project" && fact.scope_project === scope.project);
        case "other-projects":
            return (fact.scope_type === "project" && fact.scope_project !== scope.project);
        case "other-project-id":
            return fact.scope_type === "project" && fact.project_id !== scope.projectId;
        case "project-id":
            return (scope.includeGlobal !== false && fact.scope_type === "global") ||
                (fact.scope_type === "project" && fact.project_id === scope.projectId &&
                    (fact.promotion_state === "legacy-project" || fact.promotion_state === "decision" || fact.promotion_state === "project-current"));
        case "workspace-id":
            return (scope.includeGlobal !== false && fact.scope_type === "global") ||
                (fact.scope_type === "project" && fact.project_id === scope.projectId &&
                    (fact.promotion_state === "legacy-project" || fact.promotion_state === "decision" || fact.promotion_state === "project-current" ||
                        (fact.promotion_state === "workspace" && fact.workspace_id === scope.workspaceId)));
        case "workstream-id":
            return (scope.includeGlobal !== false && fact.scope_type === "global") ||
                (fact.scope_type === "project" && fact.project_id === scope.projectId &&
                    (fact.promotion_state === "legacy-project" || fact.promotion_state === "decision" || fact.promotion_state === "project-current" ||
                        (fact.promotion_state === "workspace" && !!scope.workspaceId && fact.workspace_id === scope.workspaceId) ||
                        (fact.promotion_state === "workstream" && fact.workstream_id === scope.workstreamId)));
        case "session-id":
            return (scope.includeGlobal !== false && fact.scope_type === "global") ||
                (fact.scope_type === "project" && fact.project_id === scope.projectId &&
                    fact.source_exchange_ids.some((id) => sessionExchangeIds?.has(id)));
    }
}
export function listFactsByScope(db, scope) {
    const sessionExchangeIds = scope.type === "session-id"
        ? new Set(db.prepare("SELECT id FROM exchanges WHERE session_id = ?").all(scope.sessionId).map((row) => row.id))
        : undefined;
    return db.prepare("SELECT * FROM facts WHERE is_active = 1").all()
        .map(rowToFact)
        .filter((fact) => factMatchesSearch(fact, scope, {}, sessionExchangeIds));
}
export function factMatchesScope(db, fact, scope) {
    const sessionExchangeIds = scope.type === "session-id"
        ? new Set(db.prepare("SELECT id FROM exchanges WHERE session_id = ?").all(scope.sessionId).map((row) => row.id))
        : undefined;
    return factMatchesSearch(fact, scope, {}, sessionExchangeIds);
}
/**
 * Scope-aware semantic fact search SSOT.
 *
 * Scope and optional category filters are applied before the caller's limit.
 * sqlite-vec cannot join the fact metadata into MATCH, so the search grows its
 * KNN window until it either collects enough eligible facts or exhausts both
 * language indexes. This prevents a dense out-of-scope population from
 * starving a valid project/global result.
 */
export function searchFactsByScope(db, embedding, scope, limit = 5, threshold = 0.85, filters = {}) {
    if (limit <= 0)
        return [];
    const sessionExchangeIds = scope.type === "session-id"
        ? new Set(db.prepare("SELECT id FROM exchanges WHERE session_id = ?").all(scope.sessionId).map((row) => row.id))
        : undefined;
    const fetch = (table, count) => {
        try {
            const p = vecParamFor(db, table, embedding);
            const rows = db
                .prepare(`
        SELECT id, distance FROM ${table}
        WHERE embedding MATCH ${p.sql}
        ORDER BY distance
        LIMIT ?
      `)
                .all(p.blob, count);
            for (const r of rows)
                r.distance = normalizeVecDistance(r.distance, p.dt);
            return { rows, exhausted: rows.length < count };
        }
        catch {
            return { rows: [], exhausted: true };
        }
    };
    const factCache = new Map();
    const loadFact = (id) => {
        if (factCache.has(id))
            return factCache.get(id) ?? null;
        const row = db
            .prepare("SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?")
            .get(id, EMBEDDING_VERSION);
        const fact = row ? rowToFact(row) : null;
        factCache.set(id, fact);
        return fact;
    };
    const vectorRowCount = (table) => {
        try {
            return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
        }
        catch {
            return 0;
        }
    };
    const maxVectorRows = Math.max(vectorRowCount("vec_facts"), vectorRowCount("vec_facts_kr"));
    let fetchCount = Math.max(limit * 4, 50);
    let results = [];
    for (;;) {
        const a = fetch("vec_facts", fetchCount);
        const b = fetch("vec_facts_kr", fetchCount);
        const best = new Map();
        for (const vr of [...a.rows, ...b.rows]) {
            const cur = best.get(vr.id);
            if (cur === undefined || vr.distance < cur)
                best.set(vr.id, vr.distance);
        }
        const merged = [...best.entries()]
            .map(([id, distance]) => ({ id, distance }))
            .sort((x, y) => x.distance - y.distance);
        results = [];
        for (const vr of merged) {
            const similarity = l2DistanceToSimilarity(vr.distance);
            if (similarity < threshold)
                break;
            const fact = loadFact(vr.id);
            if (!fact || !factMatchesSearch(fact, scope, filters, sessionExchangeIds))
                continue;
            results.push({ fact, distance: vr.distance });
            if (results.length >= limit)
                break;
        }
        if (results.length >= limit || (a.exhausted && b.exhausted))
            break;
        const nextFetchCount = Math.min(fetchCount * 4, maxVectorRows + 1);
        if (nextFetchCount <= fetchCount)
            break;
        fetchCount = nextFetchCount;
    }
    return results;
}
/** @deprecated Use searchFactsByScope with an explicit project/global/all scope. */
export function searchSimilarFacts(db, embedding, project, limit = 5, threshold = 0.85) {
    const scope = project
        ? { type: "project", project }
        : { type: "all" };
    return searchFactsByScope(db, embedding, scope, limit, threshold);
}
/** @deprecated Use searchFactsByScope with global or exact-project scope. */
export function searchSimilarFactsSameScope(db, embedding, scope, limit = 5, threshold = 0.85) {
    const exactScope = scope.type === "global"
        ? scope
        : { type: "exact-project", project: scope.project };
    return searchFactsByScope(db, embedding, exactScope, limit, threshold);
}
/**
 * Get top facts using a relevance score that combines:
 * - Confirmation count (consolidated_count) — how established is this fact
 * - Recency (updated_at) — how recent is this fact
 * - Scope priority — project-specific facts rank higher than global for that project
 *
 * Score = (log2(consolidated_count + 1) * 3) + recency_bonus + scope_bonus
 *   recency_bonus: 5 if updated in last 7 days, 3 if last 30 days, 1 if last 90 days, 0 otherwise
 *   scope_bonus: 2 for project-scoped facts, 0 for global
 *
 * Project facts are guaranteed up to half of the result slots: heavily-confirmed
 * global facts otherwise outscore any newly extracted project fact (count=1)
 * forever, so project context would never surface in injection.
 */
export function getTopFacts(db, project, limit = 10) {
    const now = new Date();
    const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
    const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
    const d90 = new Date(now.getTime() - 90 * 86400000).toISOString();
    // 재감사 P1-3: recency는 의미 사건의 시각으로 잰다 — 분류 같은 비의미
    // 메타데이터 쓰기가 오래된 fact를 최근 사실처럼 보이게 하지 않는다.
    const clockExpr = "COALESCE(NULLIF(semantic_updated_at, ''), updated_at)";
    const scoreExpr = `
      (
        CASE WHEN consolidated_count > 0 THEN (3.0 * (1.0 + LOG(consolidated_count + 1) / LOG(2))) ELSE 3.0 END
        + CASE WHEN ${clockExpr} >= ? THEN 5 WHEN ${clockExpr} >= ? THEN 3 WHEN ${clockExpr} >= ? THEN 1 ELSE 0 END
        + CASE WHEN scope_type = 'project' AND scope_project = ? THEN 2 ELSE 0 END
      ) as relevance_score`;
    const projectRows = db
        .prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'project' AND scope_project = ?
    ORDER BY relevance_score DESC
    LIMIT ?
  `)
        .all(d7, d30, d90, project, project, limit);
    const globalRows = db
        .prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'global'
    ORDER BY relevance_score DESC
    LIMIT ?
  `)
        .all(d7, d30, d90, project, limit);
    const reserved = Math.ceil(limit / 2);
    const guaranteed = projectRows.slice(0, reserved);
    const rest = [...projectRows.slice(reserved), ...globalRows]
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, Math.max(0, limit - guaranteed.length));
    return [...guaranteed, ...rest]
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .map(rowToFact);
}
export function getNewFactsSince(db, project, since) {
    return db
        .prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND created_at > ?
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY created_at ASC
  `)
        .all(since, project).map(rowToFact);
}
/**
 * Local consolidation dirty queue. Membership is explicit and independent of
 * historical fact timestamps, so a late sync import cannot land behind a
 * persisted cursor. updated_at/id only provide deterministic bounded draining.
 */
export function getPendingConsolidationFacts(db, limit = 2000, project) {
    const scopeClause = project
        ? " AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')"
        : "";
    const params = project ? [project, limit] : [limit];
    return db
        .prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND needs_consolidation = 1
      ${scopeClause}
    ORDER BY updated_at ASC, id ASC LIMIT ?
  `)
        .all(...params).map(rowToFact);
}
/** @deprecated Use searchFactsByScope with all scope. */
export function searchAllFacts(db, embedding, limit = 10, threshold = 0.6) {
    return searchFactsByScope(db, embedding, { type: "all" }, limit, threshold);
}
export function rowToFact(row) {
    const embeddingRaw = row["embedding"];
    let embedding = null;
    if (embeddingRaw instanceof Buffer) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    else if (embeddingRaw instanceof Uint8Array) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    // 손상된 JSON 은 fact 조회 전체를 죽이지 않는다 — provenance 만 비우고 계속한다.
    let sourceExchangeIds = [];
    if (row["source_exchange_ids"]) {
        try {
            const parsed = JSON.parse(row["source_exchange_ids"]);
            if (Array.isArray(parsed))
                sourceExchangeIds = parsed;
        }
        catch {
            // malformed provenance — 빈 배열로 대체
        }
    }
    return {
        id: row["id"],
        fact: row["fact"],
        category: row["category"],
        scope_type: row["scope_type"],
        scope_project: row["scope_project"] ?? null,
        project_id: row["project_id"] ?? null,
        workspace_id: row["workspace_id"] ?? null,
        workstream_id: row["workstream_id"] ?? null,
        subject_key: row["subject_key"] ?? null,
        promotion_state: row["promotion_state"] ?? 'legacy-project',
        source_exchange_ids: sourceExchangeIds,
        embedding,
        created_at: row["created_at"],
        updated_at: row["updated_at"],
        consolidated_count: row["consolidated_count"],
        is_active: Boolean(row["is_active"]),
        ontology_category_id: row["ontology_category_id"] ?? null,
        semantic_generation: Number(row["semantic_generation"] ?? 1),
        semantic_updated_at: row["semantic_updated_at"] ?? null,
        lifecycle_generation: Number(row["lifecycle_generation"] ?? 1),
        lifecycle_updated_at: row["lifecycle_updated_at"] ?? null,
    };
}
