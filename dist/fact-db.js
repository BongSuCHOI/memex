import { assertReadScope } from './read-scope.js';
import { adaptLegacyFactForRead, adaptLegacyReadScope } from './legacy-read-scope.js';
import { randomUUID } from "crypto";
import { EMBEDDING_VERSION } from "./embeddings.js";
import { getVecTableDtype, embeddingToVecBlob, vecParamSql, normalizeVecDistance, l2DistanceToSimilarity, } from "./db.js";
import { branchSignalFor, resolveProjectWorkspace } from "./continuity-identity.js";
import { readChronicleTimeline, recordChronicleEvent } from "./chronicle.js";
import { isInternalContextMessage } from "./codex-rollout.js";
import { captureSourceSnapshot, sourceSnapshotValid, } from "./fact-policy.js";
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
 * #18 default tier rule. A session with a real branch signal keeps its memory
 * on the branch tier; a session with none (non-git project, or the repository
 * default branch) writes project-common memory directly, because there is no
 * branch for it to be diluted by. "No branch signal" is itself the evidence.
 */
function defaultTierFor(db, input) {
    const stream = input.workstreamId
        ? db.prepare("SELECT branch_hint, workspace_id FROM minimal_workstreams WHERE workstream_id = ?")
            .get(input.workstreamId)
        : undefined;
    const workspaceId = input.workspaceId ?? stream?.workspace_id ?? null;
    const workspace = workspaceId
        ? db.prepare("SELECT default_branch FROM workspaces WHERE workspace_id = ?")
            .get(workspaceId)
        : undefined;
    const signal = branchSignalFor({
        branch: stream?.branch_hint ?? null,
        defaultBranch: workspace?.default_branch ?? null,
    });
    return signal.kind === "branch" && input.workstreamId
        ? { promotionState: "workstream", tierReason: signal.tierReason }
        : { promotionState: "project-current", tierReason: signal.tierReason };
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
    const derived = params.promotion_state === undefined && params.scope_type === "project" && workstreamId
        ? defaultTierFor(db, { workspaceId, workstreamId })
        : null;
    const promotionState = params.promotion_state ?? (derived?.promotionState ?? "legacy-project");
    // Project-wide truth never keeps workspace/workstream scope.
    if (derived?.promotionState === "project-current") {
        workspaceId = null;
        workstreamId = null;
    }
    const promotionEvidence = params.promotion_evidence ?? (params.promotion_state === undefined && promotionState === "workstream" ? "experimental"
        : params.promotion_state === undefined && derived?.promotionState === "project-current" ? "no-branch-signal"
            : undefined);
    const tierReason = params.tier_reason ?? derived?.tierReason ?? null;
    if (promotionState === "decision" && promotionEvidence !== "explicit-decision") {
        throw new Error("project decision requires explicit decision evidence");
    }
    if (promotionState === "project-current" &&
        promotionEvidence !== "merged" && promotionEvidence !== "validated" &&
        promotionEvidence !== "no-branch-signal") {
        throw new Error("project current state requires merged, validated or no-branch-signal evidence");
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
    return { projectId, workspaceId, workstreamId, promotionState, tierReason };
}
export function insertFact(db, params) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { projectId, workspaceId, workstreamId, promotionState, tierReason } = resolveFactInsertIdentity(db, params);
    const subjectKey = params.subject_key ?? (params.scope_type === "global" ? `global.fact.${id}` : `${promotionState}.fact.${id}`);
    db.prepare(`
    INSERT INTO facts (
      id, fact, category, scope_type, scope_project, source_exchange_ids, embedding,
      created_at, updated_at, consolidated_count, is_active, fact_kr,
      embedding_version, semantic_generation, semantic_updated_at,
      project_id, workspace_id, workstream_id, subject_key, promotion_state, tier_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.fact, params.category, params.scope_type, params.scope_project, JSON.stringify(params.source_exchange_ids), params.embedding
        ? Buffer.from(new Float32Array(params.embedding).buffer)
        : null, now, now, params.fact_kr ?? null, EMBEDDING_VERSION, now, projectId, workspaceId, workstreamId, subjectKey, promotionState, tierReason);
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
/** @deprecated Canonical path reader; new callers use listFactsInScope. */
export function getFactsByProject(db, project) {
    return listFactsByScope(db, { type: 'project', project }).sort((a, b) => b.consolidated_count - a.consolidated_count);
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
    if (filters.accept && !filters.accept(fact))
        return false;
    switch (scope.type) {
        case "global":
            return fact.scope_type === "global";
        case "all":
            return true;
        case "fact-ids":
            return scope.factIds.includes(fact.id);
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
export function listFactsInScope(db, scope) {
    assertReadScope(db, scope);
    const sessionExchangeIds = scope.type === "session-id"
        ? new Set(db.prepare("SELECT id FROM exchanges WHERE session_id = ?").all(scope.sessionId).map((row) => row.id))
        : undefined;
    return db.prepare("SELECT * FROM facts WHERE is_active = 1").all()
        .map(row => adaptLegacyFactForRead(db, rowToFact(row)))
        .filter((fact) => factMatchesSearch(fact, scope, {}, sessionExchangeIds));
}
export function factMatchesReadScope(db, fact, scope) {
    assertReadScope(db, scope);
    const sessionExchangeIds = scope.type === "session-id"
        ? new Set(db.prepare("SELECT id FROM exchanges WHERE session_id = ?").all(scope.sessionId).map((row) => row.id))
        : undefined;
    return factMatchesSearch(adaptLegacyFactForRead(db, fact), scope, {}, sessionExchangeIds);
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
export function searchFactsInScope(db, embedding, scope, limit = 5, threshold = 0.85, filters = {}) {
    assertReadScope(db, scope);
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
            const loaded = loadFact(vr.id);
            const fact = loaded ? adaptLegacyFactForRead(db, loaded) : null;
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
// Keep ordinary prose out of SQLite LIKE parameters. Identifier terms are
// still extracted below for long prompts, while semantic retrieval remains
// responsible for the broad meaning of the prompt.
const MAX_LITERAL_QUERY_CHARS = 512;
function escapeLikePattern(value) {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
function normalizeFactQuery(query) {
    return query
        .trim()
        .replace(/^[`'\"]+|[`'\"]+$/g, "")
        .replace(/[?!,;:]+$/g, "")
        .trim();
}
/**
 * Pull only concrete code-like tokens from a natural-language query. A
 * general word search would make every prompt a lexical retrieval request;
 * these shapes are bounded to paths, symbols, function calls and snake-case
 * identifiers commonly used for error/configuration names.
 */
function extractFactIdentifiers(query) {
    const value = normalizeFactQuery(query);
    if (!value)
        return [];
    const maxIdentifiers = 4;
    const found = new Set();
    const add = (token) => {
        const normalized = token
            .replace(/\(\)$/u, "")
            .replace(/^[`'\"]+|[`'\"]+$/g, "")
            .replace(/[.!?,;:]+$/u, "");
        if (normalized.length >= 2 && found.size < maxIdentifiers)
            found.add(normalized);
    };
    const patterns = [
        /(?:\/?[A-Za-z0-9_$.-]+[\\/])+(?:[A-Za-z0-9_$.-]+)/gu,
        /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/gu,
        /\b[A-Za-z_$][A-Za-z0-9_$]*\(\)/gu,
        /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu,
        /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu,
        /\b[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/gu,
    ];
    for (const pattern of patterns) {
        for (const match of value.matchAll(pattern))
            add(match[0]);
    }
    return [...found];
}
/** True for a concrete identifier query, including one embedded in prose. */
export function isExactFactIdentifierQuery(query) {
    const value = normalizeFactQuery(query);
    if (!value)
        return false;
    const identifiers = extractFactIdentifiers(value);
    return identifiers.length > 0 || (!/\s/u.test(value) && /\.[A-Za-z0-9]+$/u.test(value));
}
function isIdentifierCharacter(character) {
    return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}
function isPathCharacter(character) {
    return character !== undefined && /[A-Za-z0-9_$.\\/\\-]/u.test(character);
}
function exactIdentifierOffset(text, query) {
    const haystack = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
        const start = haystack.indexOf(needle, offset);
        if (start < 0)
            return -1;
        const end = start + needle.length;
        const pathLike = /[/\\.]/u.test(query);
        const before = text[start - 1];
        const after = text[end];
        const beforeMatches = pathLike ? isPathCharacter(before) : isIdentifierCharacter(before);
        let afterMatches = pathLike ? isPathCharacter(after) : isIdentifierCharacter(after);
        // A sentence-ending period is a boundary, while `.bak` after a path is a
        // longer path/filename and must not satisfy an exact path query.
        if (pathLike && after === "." && !isIdentifierCharacter(text[end + 1])) {
            afterMatches = false;
        }
        if (!beforeMatches && !afterMatches)
            return start;
        offset = start + 1;
    }
    return -1;
}
function containsExactIdentifier(text, query) {
    return exactIdentifierOffset(text, query) >= 0;
}
/**
 * Literal fact search with the same required ReadScope as the semantic lane.
 * The SQL pattern is parameterized/escaped, while exact identifier boundaries
 * are checked in memory so a symbol does not match a longer symbol or path.
 * Active/category/scope predicates are evaluated before `limit` is applied.
 */
export function searchFactsLexicallyInScope(db, query, scope, limit = 5, filters = {}) {
    assertReadScope(db, scope);
    if (limit <= 0)
        return [];
    const normalizedQuery = normalizeFactQuery(query);
    if (!normalizedQuery)
        return [];
    const sessionExchangeIds = scope.type === "session-id"
        ? new Set(db.prepare("SELECT id FROM exchanges WHERE session_id = ?").all(scope.sessionId).map((row) => row.id))
        : undefined;
    const categorySql = filters.category ? " AND category = ?" : "";
    const identifiers = extractFactIdentifiers(normalizedQuery);
    const lexicalTerms = [
        ...(normalizedQuery.length <= MAX_LITERAL_QUERY_CHARS ? [normalizedQuery] : []),
        ...identifiers.filter((identifier) => identifier !== normalizedQuery),
    ];
    if (lexicalTerms.length === 0)
        return [];
    const lexicalSql = lexicalTerms
        .map(() => "(LOWER(fact) LIKE LOWER(?) ESCAPE '\\' OR LOWER(COALESCE(fact_kr, '')) LIKE LOWER(?) ESCAPE '\\')")
        .join(" OR ");
    const patterns = lexicalTerms.flatMap((term) => {
        const pattern = `%${escapeLikePattern(term)}%`;
        return [pattern, pattern];
    });
    const rows = db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      ${categorySql}
      AND (${lexicalSql})
  `).all(...(filters.category ? [filters.category] : []), ...patterns);
    const results = [];
    for (const row of rows) {
        const rawTexts = [String(row.fact ?? ""), String(row.fact_kr ?? "")];
        const fact = adaptLegacyFactForRead(db, rowToFact(row));
        if (!factMatchesSearch(fact, scope, filters, sessionExchangeIds))
            continue;
        const match = identifiers.length > 0
            ? rawTexts.some((text) => identifiers.some((identifier) => containsExactIdentifier(text, identifier)))
            : rawTexts.some((text) => text.toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase()));
        if (!match)
            continue;
        results.push({ fact, lexicalScore: identifiers.length > 0 ? 2 : 1, distance: 0 });
    }
    results.sort((a, b) => b.lexicalScore - a.lexicalScore || a.fact.id.localeCompare(b.fact.id));
    return results.slice(0, limit);
}
// Shared workstreams can span workspaces. Both the source workspace and its
// session must still belong to the same project/workstream at read and commit.
function humanSourceRows(db, scope, identifier, exchangeId) {
    assertReadScope(db, scope);
    if (scope.type !== "workstream-id")
        return [];
    return db.prepare(`
    SELECT e.* FROM exchanges e
    JOIN session_memory_state s ON s.session_id = e.session_id
      AND s.project_id = e.project_id AND s.workspace_id = e.workspace_id
      AND s.workstream_id = e.workstream_id
    JOIN workspaces w ON w.workspace_id = e.workspace_id AND w.project_id = e.project_id
    WHERE e.project_id = ? AND e.workstream_id = ? AND COALESCE(e.is_sidechain, 0) = 0
      AND NOT EXISTS (SELECT 1 FROM conversation_exclusions x WHERE x.session_id = e.session_id)
      AND LOWER(e.user_message) LIKE LOWER(?) ESCAPE '\\'
      ${exchangeId ? "AND e.id = ?" : ""}
    ORDER BY e.timestamp DESC, e.id LIMIT 128
  `).all(scope.projectId, scope.workstreamId, `%${escapeLikePattern(identifier)}%`, ...(exchangeId ? [exchangeId] : []));
}
function humanSourceText(row) {
    // The indexed user field is assembled from real user messages, not tool or
    // replacement-history records. Recall in the assistant half of a turn does
    // not invalidate an independent human assertion in this field.
    try {
        const provenance = JSON.parse(String(row.provenance));
        if (!Array.isArray(provenance) || !provenance.includes("human_assertion"))
            return null;
    }
    catch {
        return null;
    }
    const text = String(row.user_message ?? "").trim();
    if (!text || isInternalContextMessage(text) ||
        /^(?:<local-command-stdout>|<local-command-caveat>|<command-name>|Caveat:|\/[\w:-]+$)/u.test(text))
        return null;
    return text.replace(/\s+/gu, " ");
}
function humanSourceCoordinates(row) {
    return JSON.stringify([row.session_id, row.archive_path, row.line_start, row.line_end,
        row.content_hash, row.content_generation]);
}
/** Exact-query escape hatch for lossy fact summaries; no learning or vector work. */
export function searchHumanSourceIdentifiersInScope(db, query, scope, limit = 2) {
    assertReadScope(db, scope);
    if (scope.type !== "workstream-id" || limit <= 0)
        return [];
    const results = [];
    const parsed = extractFactIdentifiers(query).filter(term => term.length <= MAX_LITERAL_QUERY_CHARS);
    const literal = normalizeFactQuery(query).replace(/\(\)$/u, "");
    const identifiers = parsed.includes(literal) ? [literal] : parsed;
    for (const identifier of identifiers) {
        // The broader fact lane may also match a path's basename. Only a full
        // identifier match covers this source lookup request.
        if (searchFactsLexicallyInScope(db, identifier, scope, Number.MAX_SAFE_INTEGER)
            .some(({ fact }) => containsExactIdentifier(fact.fact, identifier)))
            continue;
        for (const row of humanSourceRows(db, scope, identifier)) {
            if (results.some(item => item.exchangeId === row.id && containsExactIdentifier(item.text, identifier)))
                continue;
            const source = humanSourceText(row);
            const offset = source === null ? -1 : exactIdentifierOffset(source, identifier);
            if (source === null || offset < 0)
                continue;
            const prefix = `[exchange ${row.id}:${row.line_start}-${row.line_end}] `;
            const available = 160 - prefix.length;
            // A partial literal or an unresolvable truncated source ID is not useful.
            if (identifier.length > available)
                continue;
            const start = Math.max(0, offset - Math.min(24, available - identifier.length));
            const snapshot = captureSourceSnapshot(db, [String(row.id)]);
            if (!snapshot)
                continue;
            results.push({ exchangeId: String(row.id), identifier,
                text: prefix + source.slice(start, start + available), snapshot,
                coordinates: humanSourceCoordinates(row) });
            break;
        }
        if (results.length >= Math.min(2, limit))
            break;
    }
    return results;
}
/** Called inside the receipt transaction after any intervening async work. */
export function validateHumanSourceIdentifierEvidence(db, evidence, scope) {
    const row = humanSourceRows(db, scope, evidence.identifier, evidence.exchangeId)[0];
    if (!row || humanSourceCoordinates(row) !== evidence.coordinates)
        return false;
    const text = humanSourceText(row);
    return text !== null && containsExactIdentifier(text, evidence.identifier) && sourceSnapshotValid(db, evidence.snapshot);
}
/** Merge literal and semantic lanes with exact lexical hits taking priority. */
export function searchFactsCombinedInScope(db, query, embedding, scope, limit = 5, threshold = 0.85, filters = {}) {
    assertReadScope(db, scope);
    if (limit <= 0)
        return [];
    const lexical = searchFactsLexicallyInScope(db, query, scope, limit, filters);
    const semantic = embedding
        ? searchFactsInScope(db, embedding, scope, limit, threshold, filters)
        : [];
    const merged = new Map();
    for (const result of lexical) {
        merged.set(result.fact.id, {
            fact: result.fact,
            distance: result.distance,
            semanticSimilarity: null,
            lexicalScore: result.lexicalScore,
            lane: "lexical",
        });
    }
    for (const result of semantic) {
        const existing = merged.get(result.fact.id);
        const semanticSimilarity = l2DistanceToSimilarity(result.distance);
        if (existing) {
            existing.distance = result.distance;
            existing.semanticSimilarity = semanticSimilarity;
            existing.lane = "both";
        }
        else {
            merged.set(result.fact.id, {
                fact: result.fact,
                distance: result.distance,
                semanticSimilarity,
                lexicalScore: null,
                lane: "semantic",
            });
        }
    }
    return [...merged.values()]
        .sort((a, b) => {
        const aLexical = a.lexicalScore ?? 0;
        const bLexical = b.lexicalScore ?? 0;
        if ((aLexical > 0) !== (bLexical > 0))
            return aLexical > 0 ? -1 : 1;
        if (aLexical !== bLexical)
            return bLexical - aLexical;
        const aSemantic = a.semanticSimilarity ?? -Infinity;
        const bSemantic = b.semanticSimilarity ?? -Infinity;
        if (aSemantic !== bSemantic)
            return bSemantic - aSemantic;
        return a.fact.id.localeCompare(b.fact.id);
    })
        .slice(0, limit);
}
/** @deprecated Resolve legacy paths at the edge, then use listFactsInScope. */
export function listFactsByScope(db, scope) {
    return listFactsInScope(db, adaptLegacyReadScope(db, scope));
}
/** @deprecated Use factMatchesReadScope with a required ReadScope. */
export function factMatchesScope(db, fact, scope) {
    return factMatchesReadScope(db, fact, adaptLegacyReadScope(db, scope));
}
/** @deprecated Compatibility adapter; new core callers use searchFactsInScope. */
export function searchFactsByScope(db, embedding, scope, limit = 5, threshold = 0.85, filters = {}) {
    return searchFactsInScope(db, embedding, adaptLegacyReadScope(db, scope), limit, threshold, filters);
}
/** @deprecated Use searchFactsByScope with an explicit project/global/all scope. */
export function searchSimilarFacts(db, embedding, project, limit = 5, threshold = 0.85) {
    const scope = project
        ? { type: "project", project }
        : { type: "global" };
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
    const now = Date.now();
    const d7 = new Date(now - 7 * 86400000).toISOString();
    const d30 = new Date(now - 30 * 86400000).toISOString();
    const d90 = new Date(now - 90 * 86400000).toISOString();
    const ranked = getFactsByProject(db, project).map(fact => {
        const clock = fact.semantic_updated_at || fact.updated_at;
        const score = (fact.consolidated_count > 0 ? 3 * (1 + Math.log2(fact.consolidated_count + 1)) : 3)
            + (clock >= d7 ? 5 : clock >= d30 ? 3 : clock >= d90 ? 1 : 0)
            + (fact.scope_type === 'project' ? 2 : 0);
        return { fact, score };
    }).sort((a, b) => b.score - a.score);
    const projectRows = ranked.filter(row => row.fact.scope_type === 'project');
    const guaranteed = projectRows.slice(0, Math.ceil(limit / 2));
    const reservedIds = new Set(guaranteed.map(row => row.fact.id));
    const rest = ranked.filter(row => !reservedIds.has(row.fact.id)).slice(0, Math.max(0, limit - guaranteed.length));
    return [...guaranteed, ...rest].sort((a, b) => b.score - a.score).map(row => row.fact);
}
/** @deprecated Canonical path reader; new callers use listFactsInScope. */
export function getNewFactsSince(db, project, since) {
    return getFactsByProject(db, project).filter(fact => fact.created_at > since)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
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
