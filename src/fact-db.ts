import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { Fact, FactCategory, FactRevision } from "./types.js";
import { EMBEDDING_VERSION } from "./embeddings.js";
import {
  getVecTableDtype,
  embeddingToVecBlob,
  vecParamSql,
  normalizeVecDistance,
  l2DistanceToSimilarity,
} from "./db.js";

type FactVecTable = "vec_facts" | "vec_facts_kr" | "vec_categories";

/** Dtype-aware MATCH/INSERT parameter for a fact-side vector table. */
export function vecParamFor(
  db: Database.Database,
  table: FactVecTable,
  embedding: number[],
) {
  const dt = getVecTableDtype(db, table);
  return { sql: vecParamSql(dt), blob: embeddingToVecBlob(embedding, dt), dt };
}

interface InsertFactParams {
  fact: string;
  category: string;
  scope_type: string;
  scope_project: string | null;
  source_exchange_ids: string[];
  embedding: number[] | null; // number[] to match generateEmbedding() return type
  fact_kr?: string | null; // Korean translation — enables same-language matching for Korean queries
  embedding_kr?: number[] | null;
}

interface UpdateFactParams {
  fact?: string;
  embedding?: number[] | null;
  consolidated_count_increment?: boolean;
  source_exchange_ids?: string[];
}

interface InsertRevisionParams {
  fact_id: string;
  previous_fact: string;
  new_fact: string;
  reason: string | null;
  source_exchange_id: string | null;
}

export function insertFact(
  db: Database.Database,
  params: InsertFactParams,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, embedding, created_at, updated_at, consolidated_count, is_active, fact_kr, embedding_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(
    id,
    params.fact,
    params.category,
    params.scope_type,
    params.scope_project,
    JSON.stringify(params.source_exchange_ids),
    params.embedding
      ? Buffer.from(new Float32Array(params.embedding).buffer)
      : null,
    now,
    now,
    params.fact_kr ?? null,
    EMBEDDING_VERSION,
  );

  // Insert into vector index (atomic DELETE+INSERT via transaction)
  if (params.embedding) {
    const p = vecParamFor(db, "vec_facts", params.embedding);
    const upsertVec = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare("DELETE FROM vec_facts WHERE id = ?").run(vecId);
      db.prepare(
        `INSERT INTO vec_facts (id, embedding) VALUES (?, ${p.sql})`,
      ).run(vecId, buf);
    });
    upsertVec(id, p.blob);
  }

  // Korean-text vector index (same-language matching for Korean queries)
  if (params.embedding_kr) {
    const pk = vecParamFor(db, "vec_facts_kr", params.embedding_kr);
    const upsertVecKr = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(vecId);
      db.prepare(
        `INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${pk.sql})`,
      ).run(vecId, buf);
    });
    upsertVecKr(id, pk.blob);
  }

  return id;
}

export function getActiveFacts(db: Database.Database): Fact[] {
  return (
    db
      .prepare(
        "SELECT * FROM facts WHERE is_active = 1 ORDER BY consolidated_count DESC",
      )
      .all() as Record<string, unknown>[]
  ).map(rowToFact);
}

export function getFactsByProject(
  db: Database.Database,
  project: string,
): Fact[] {
  return (
    db
      .prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
  `)
      .all(project) as Record<string, unknown>[]
  ).map(rowToFact);
}

export function updateFact(
  db: Database.Database,
  id: string,
  params: UpdateFactParams,
): void {
  const now = new Date().toISOString();
  const updates: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  if (params.fact !== undefined) {
    updates.push("fact = ?");
    values.push(params.fact);
    updates.push("needs_consolidation = 1");
  }
  if (params.embedding !== undefined) {
    updates.push("embedding = ?");
    values.push(
      params.embedding
        ? Buffer.from(new Float32Array(params.embedding).buffer)
        : null,
    );
  }
  if (params.consolidated_count_increment) {
    updates.push("consolidated_count = consolidated_count + 1");
  }
  if (params.source_exchange_ids !== undefined) {
    updates.push("source_exchange_ids = ?");
    values.push(JSON.stringify([...new Set(params.source_exchange_ids)]));
  }

  values.push(id);
  db.prepare(`UPDATE facts SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values,
  );

  // Update vector index (atomic DELETE+INSERT via transaction)
  if (params.embedding) {
    const p = vecParamFor(db, "vec_facts", params.embedding);
    const upsertVec = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare("DELETE FROM vec_facts WHERE id = ?").run(vecId);
      db.prepare(
        `INSERT INTO vec_facts (id, embedding) VALUES (?, ${p.sql})`,
      ).run(vecId, buf);
    });
    upsertVec(id, p.blob);
  }
}

export function deactivateFact(db: Database.Database, id: string): void {
  db.prepare("UPDATE facts SET is_active = 0, needs_consolidation = 0, updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    id,
  );
  // Deactivated facts must not occupy vector index slots
  db.prepare("DELETE FROM vec_facts WHERE id = ?").run(id);
  db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(id);
}

export function deleteFact(db: Database.Database, id: string): void {
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

export function insertRevision(
  db: Database.Database,
  params: InsertRevisionParams,
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.fact_id,
    params.previous_fact,
    params.new_fact,
    params.reason,
    params.source_exchange_id,
    new Date().toISOString(),
  );
  return id;
}

export function getRevisions(
  db: Database.Database,
  factId: string,
): FactRevision[] {
  return db
    .prepare(
      "SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY created_at DESC",
    )
    .all(factId) as FactRevision[];
}

export type FactSearchScope =
  | { type: "project"; project: string }
  | { type: "global" }
  | { type: "all" }
  // Internal exact-scope modes keep consolidation and cross-project discovery
  // on the same search implementation without changing the public semantics
  // above: project means that project plus global facts.
  | { type: "exact-project"; project: string }
  | { type: "other-projects"; project: string };

interface FactSearchFilters {
  category?: FactCategory;
}

function factMatchesSearch(
  fact: Fact,
  scope: FactSearchScope,
  filters: FactSearchFilters,
): boolean {
  if (filters.category && fact.category !== filters.category) return false;

  switch (scope.type) {
    case "global":
      return fact.scope_type === "global";
    case "all":
      return true;
    case "project":
      return (
        fact.scope_type === "global" ||
        (fact.scope_type === "project" && fact.scope_project === scope.project)
      );
    case "exact-project":
      return (
        fact.scope_type === "project" && fact.scope_project === scope.project
      );
    case "other-projects":
      return (
        fact.scope_type === "project" && fact.scope_project !== scope.project
      );
  }
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
export function searchFactsByScope(
  db: Database.Database,
  embedding: number[],
  scope: FactSearchScope,
  limit: number = 5,
  threshold: number = 0.85,
  filters: FactSearchFilters = {},
): Array<{ fact: Fact; distance: number }> {
  if (limit <= 0) return [];

  const fetch = (
    table: FactVecTable,
    count: number,
  ): { rows: Array<{ id: string; distance: number }>; exhausted: boolean } => {
    try {
      const p = vecParamFor(db, table, embedding);
      const rows = db
        .prepare(`
        SELECT id, distance FROM ${table}
        WHERE embedding MATCH ${p.sql}
        ORDER BY distance
        LIMIT ?
      `)
        .all(p.blob, count) as Array<{ id: string; distance: number }>;
      for (const r of rows) r.distance = normalizeVecDistance(r.distance, p.dt);
      return { rows, exhausted: rows.length < count };
    } catch {
      return { rows: [], exhausted: true };
    }
  };

  const factCache = new Map<string, Fact | null>();
  const loadFact = (id: string): Fact | null => {
    if (factCache.has(id)) return factCache.get(id) ?? null;
    const row = db
      .prepare(
        "SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?",
      )
      .get(id, EMBEDDING_VERSION) as Record<string, unknown> | undefined;
    const fact = row ? rowToFact(row) : null;
    factCache.set(id, fact);
    return fact;
  };

  const vectorRowCount = (table: FactVecTable): number => {
    try {
      return (
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count;
    } catch {
      return 0;
    }
  };
  const maxVectorRows = Math.max(
    vectorRowCount("vec_facts"),
    vectorRowCount("vec_facts_kr"),
  );

  let fetchCount = Math.max(limit * 4, 50);
  let results: Array<{ fact: Fact; distance: number }> = [];
  for (;;) {
    const a = fetch("vec_facts", fetchCount);
    const b = fetch("vec_facts_kr", fetchCount);
    const best = new Map<string, number>();
    for (const vr of [...a.rows, ...b.rows]) {
      const cur = best.get(vr.id);
      if (cur === undefined || vr.distance < cur) best.set(vr.id, vr.distance);
    }
    const merged = [...best.entries()]
      .map(([id, distance]) => ({ id, distance }))
      .sort((x, y) => x.distance - y.distance);

    results = [];
    for (const vr of merged) {
      const similarity = l2DistanceToSimilarity(vr.distance);
      if (similarity < threshold) break;
      const fact = loadFact(vr.id);
      if (!fact || !factMatchesSearch(fact, scope, filters)) continue;
      results.push({ fact, distance: vr.distance });
      if (results.length >= limit) break;
    }

    if (results.length >= limit || (a.exhausted && b.exhausted)) break;
    const nextFetchCount = Math.min(fetchCount * 4, maxVectorRows + 1);
    if (nextFetchCount <= fetchCount) break;
    fetchCount = nextFetchCount;
  }

  return results;
}

/** @deprecated Use searchFactsByScope with an explicit project/global/all scope. */
export function searchSimilarFacts(
  db: Database.Database,
  embedding: number[],
  project: string | null,
  limit: number = 5,
  threshold: number = 0.85,
): Array<{ fact: Fact; distance: number }> {
  const scope: FactSearchScope = project
    ? { type: "project", project }
    : { type: "all" };
  return searchFactsByScope(db, embedding, scope, limit, threshold);
}

/** @deprecated Use searchFactsByScope with global or exact-project scope. */
export function searchSimilarFactsSameScope(
  db: Database.Database,
  embedding: number[],
  scope: { type: "global" } | { type: "project"; project: string },
  limit: number = 5,
  threshold: number = 0.85,
): Array<{ fact: Fact; distance: number }> {
  const exactScope: FactSearchScope =
    scope.type === "global"
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
export function getTopFacts(
  db: Database.Database,
  project: string,
  limit: number = 10,
): Fact[] {
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const d90 = new Date(now.getTime() - 90 * 86400000).toISOString();

  const scoreExpr = `
      (
        CASE WHEN consolidated_count > 0 THEN (3.0 * (1.0 + LOG(consolidated_count + 1) / LOG(2))) ELSE 3.0 END
        + CASE WHEN updated_at >= ? THEN 5 WHEN updated_at >= ? THEN 3 WHEN updated_at >= ? THEN 1 ELSE 0 END
        + CASE WHEN scope_type = 'project' AND scope_project = ? THEN 2 ELSE 0 END
      ) as relevance_score`;

  type ScoredRow = Record<string, unknown> & { relevance_score: number };

  const projectRows = db
    .prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'project' AND scope_project = ?
    ORDER BY relevance_score DESC
    LIMIT ?
  `)
    .all(d7, d30, d90, project, project, limit) as ScoredRow[];

  const globalRows = db
    .prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'global'
    ORDER BY relevance_score DESC
    LIMIT ?
  `)
    .all(d7, d30, d90, project, limit) as ScoredRow[];

  const reserved = Math.ceil(limit / 2);
  const guaranteed = projectRows.slice(0, reserved);
  const rest = [...projectRows.slice(reserved), ...globalRows]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, Math.max(0, limit - guaranteed.length));

  return [...guaranteed, ...rest]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .map(rowToFact);
}

export function getNewFactsSince(
  db: Database.Database,
  project: string,
  since: string,
): Fact[] {
  return (
    db
      .prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND created_at > ?
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY created_at ASC
  `)
      .all(since, project) as Record<string, unknown>[]
  ).map(rowToFact);
}

/**
 * Local consolidation dirty queue. Membership is explicit and independent of
 * historical fact timestamps, so a late sync import cannot land behind a
 * persisted cursor. updated_at/id only provide deterministic bounded draining.
 */
export function getPendingConsolidationFacts(
  db: Database.Database,
  limit: number = 2000,
  project?: string,
): Fact[] {
  const scopeClause = project
    ? " AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')"
    : "";
  const params: unknown[] = project ? [project, limit] : [limit];
  return (
    db
      .prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND needs_consolidation = 1
      ${scopeClause}
    ORDER BY updated_at ASC, id ASC LIMIT ?
  `)
      .all(...params) as Record<string, unknown>[]
  ).map(rowToFact);
}

/** @deprecated Use searchFactsByScope with all scope. */
export function searchAllFacts(
  db: Database.Database,
  embedding: number[],
  limit: number = 10,
  threshold: number = 0.6,
): Array<{ fact: Fact; distance: number }> {
  return searchFactsByScope(db, embedding, { type: "all" }, limit, threshold);
}

function rowToFact(row: Record<string, unknown>): Fact {
  const embeddingRaw = row["embedding"];
  let embedding: Float32Array | null = null;
  if (embeddingRaw instanceof Buffer) {
    embedding = new Float32Array(
      embeddingRaw.buffer,
      embeddingRaw.byteOffset,
      embeddingRaw.byteLength / 4,
    );
  } else if (embeddingRaw instanceof Uint8Array) {
    embedding = new Float32Array(
      embeddingRaw.buffer,
      embeddingRaw.byteOffset,
      embeddingRaw.byteLength / 4,
    );
  }

  // 손상된 JSON 은 fact 조회 전체를 죽이지 않는다 — provenance 만 비우고 계속한다.
  let sourceExchangeIds: string[] = [];
  if (row["source_exchange_ids"]) {
    try {
      const parsed = JSON.parse(row["source_exchange_ids"] as string);
      if (Array.isArray(parsed)) sourceExchangeIds = parsed;
    } catch {
      // malformed provenance — 빈 배열로 대체
    }
  }

  return {
    id: row["id"] as string,
    fact: row["fact"] as string,
    category: row["category"] as Fact["category"],
    scope_type: row["scope_type"] as Fact["scope_type"],
    scope_project: (row["scope_project"] as string | null) ?? null,
    source_exchange_ids: sourceExchangeIds,
    embedding,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    consolidated_count: row["consolidated_count"] as number,
    is_active: Boolean(row["is_active"]),
    ontology_category_id:
      (row["ontology_category_id"] as string | null) ?? null,
  };
}
