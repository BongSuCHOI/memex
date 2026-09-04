import Database from "better-sqlite3";
import type { Fact, FactCategory, FactContextDependency, FactRevision } from "./types.js";
type FactVecTable = "vec_facts" | "vec_facts_kr" | "vec_categories";
/** Dtype-aware MATCH/INSERT parameter for a fact-side vector table. */
export declare function vecParamFor(db: Database.Database, table: FactVecTable, embedding: number[]): {
    sql: string;
    blob: Buffer<ArrayBufferLike>;
    dt: import("./db.js").VecDtype;
};
interface InsertFactParams {
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    source_exchange_ids: string[];
    embedding: number[] | null;
    fact_kr?: string | null;
    embedding_kr?: number[] | null;
    project_id?: string | null;
    workspace_id?: string | null;
    workstream_id?: string | null;
    subject_key?: string | null;
    promotion_state?: Fact['promotion_state'];
    promotion_evidence?: 'explicit-decision' | 'merged' | 'validated' | 'experimental';
}
interface UpdateFactParams {
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
export declare function insertFactContextDependencies(db: Database.Database, factId: string, dependencies: FactContextDependency[]): void;
/** Copy local interpretive lineage into a survivor. Caller owns transaction. */
export declare function mergeFactContextDependencies(db: Database.Database, targetFactId: string, sourceFactIds: string[]): void;
export declare function clearFactContextDependencies(db: Database.Database, factId: string): void;
export interface ResolvedFactInsertIdentity {
    projectId: string | null;
    workspaceId: string | null;
    workstreamId: string | null;
    promotionState: NonNullable<Fact['promotion_state']>;
}
/**
 * Stable identity and promotion placement for a fact about to be inserted.
 * Shared by insertFact and the extractor's subject-slot resolver so both see
 * the same slot before deciding whether to insert, merge, change or contradict.
 */
export declare function resolveFactInsertIdentity(db: Database.Database, params: Pick<InsertFactParams, 'scope_type' | 'scope_project' | 'source_exchange_ids' | 'project_id' | 'workspace_id' | 'workstream_id' | 'promotion_state' | 'promotion_evidence'>): ResolvedFactInsertIdentity;
export declare function insertFact(db: Database.Database, params: InsertFactParams): string;
export declare function getActiveFacts(db: Database.Database): Fact[];
export declare function getFactsByProject(db: Database.Database, project: string): Fact[];
export declare function updateFact(db: Database.Database, id: string, params: UpdateFactParams): void;
export declare function deactivateFact(db: Database.Database, id: string): void;
export declare function deleteFact(db: Database.Database, id: string): void;
/**
 * Compatibility writer for callers that only know the released revision
 * shape. It appends a Chronicle CHANGED event; the free-text reason is a
 * classifier note because this path carries no source-cited cause.
 */
export declare function insertRevision(db: Database.Database, params: InsertRevisionParams & {
    actor?: "extractor" | "consolidator" | "user" | "legacy";
}): string;
/** Released revision view over the Chronicle: newest effective change first. */
export declare function getRevisions(db: Database.Database, factId: string): FactRevision[];
export type FactSearchScope = {
    type: "project";
    project: string;
} | {
    type: "global";
} | {
    type: "all";
} | {
    type: "exact-project";
    project: string;
} | {
    type: "other-projects";
    project: string;
} | {
    type: "other-project-id";
    projectId: string;
} | {
    type: "project-id";
    projectId: string;
    includeGlobal?: boolean;
} | {
    type: "workspace-id";
    projectId: string;
    workspaceId: string;
    includeGlobal?: boolean;
} | {
    type: "workstream-id";
    projectId: string;
    workspaceId?: string | null;
    workstreamId: string;
    includeGlobal?: boolean;
} | {
    type: "session-id";
    projectId: string;
    sessionId: string;
    includeGlobal?: boolean;
};
interface FactSearchFilters {
    category?: FactCategory;
}
export declare function listFactsByScope(db: Database.Database, scope: FactSearchScope): Fact[];
export declare function factMatchesScope(db: Database.Database, fact: Fact, scope: FactSearchScope): boolean;
/**
 * Scope-aware semantic fact search SSOT.
 *
 * Scope and optional category filters are applied before the caller's limit.
 * sqlite-vec cannot join the fact metadata into MATCH, so the search grows its
 * KNN window until it either collects enough eligible facts or exhausts both
 * language indexes. This prevents a dense out-of-scope population from
 * starving a valid project/global result.
 */
export declare function searchFactsByScope(db: Database.Database, embedding: number[], scope: FactSearchScope, limit?: number, threshold?: number, filters?: FactSearchFilters): Array<{
    fact: Fact;
    distance: number;
}>;
/** @deprecated Use searchFactsByScope with an explicit project/global/all scope. */
export declare function searchSimilarFacts(db: Database.Database, embedding: number[], project: string | null, limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
/** @deprecated Use searchFactsByScope with global or exact-project scope. */
export declare function searchSimilarFactsSameScope(db: Database.Database, embedding: number[], scope: {
    type: "global";
} | {
    type: "project";
    project: string;
}, limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
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
export declare function getTopFacts(db: Database.Database, project: string, limit?: number): Fact[];
export declare function getNewFactsSince(db: Database.Database, project: string, since: string): Fact[];
/**
 * Local consolidation dirty queue. Membership is explicit and independent of
 * historical fact timestamps, so a late sync import cannot land behind a
 * persisted cursor. updated_at/id only provide deterministic bounded draining.
 */
export declare function getPendingConsolidationFacts(db: Database.Database, limit?: number, project?: string): Fact[];
/** @deprecated Use searchFactsByScope with all scope. */
export declare function searchAllFacts(db: Database.Database, embedding: number[], limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
export declare function rowToFact(row: Record<string, unknown>): Fact;
export {};
