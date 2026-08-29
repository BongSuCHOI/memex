import Database from 'better-sqlite3';
import type { OntologyDomain, OntologyCategory, OntologyRelation, RelationType, DomainTree, Fact } from './types.js';
export declare function createDomain(db: Database.Database, name: string, description?: string): OntologyDomain;
export declare function listDomains(db: Database.Database): OntologyDomain[];
export declare function getDomain(db: Database.Database, id: string): OntologyDomain | null;
export declare function getDomainByName(db: Database.Database, name: string): OntologyDomain | null;
export declare function createCategory(db: Database.Database, domainId: string, name: string, description?: string): OntologyCategory;
export declare function listCategories(db: Database.Database, domainId?: string): OntologyCategory[];
export declare function getCategoryByName(db: Database.Database, name: string, domainId?: string): OntologyCategory | null;
/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export declare function upsertCategoryEmbedding(db: Database.Database, categoryId: string, embedding: number[]): void;
export declare function deleteCategoryEmbedding(db: Database.Database, categoryId: string): void;
/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export declare function searchSimilarCategories(db: Database.Database, embedding: number[], k?: number): Array<{
    category: OntologyCategory;
    domainName: string;
    distance: number;
}>;
/**
 * Persist a fact's ontology assignment. With `expectedSemanticGeneration`
 * the write becomes a CAS against the fact's meaning generation
 * (재감사 P1-2): a classification computed from an older meaning returns 0
 * changes and the caller must discard the stale result instead of stamping
 * it onto the newer meaning.
 */
export declare function classifyFact(db: Database.Database, factId: string, categoryId: string, expectedSemanticGeneration?: number): number;
export declare function getFactsByCategory(db: Database.Database, categoryId: string, scopeProject?: string | null, scopeType?: 'project' | 'global' | 'all'): Fact[];
export declare function getFactsByDomain(db: Database.Database, domainId: string): Fact[];
export interface CreateRelationOptions {
    /**
     * 재감사 P1-2: async relation writers (LLM 왕복을 기다린 뒤 쓴다)가 캡처한
     * 양 endpoint의 의미 세대. 제공되면 검증+삽입을 한 transaction으로 원자화하고,
     * 한쪽이라도 세대가 밀렸으면 관계를 만들지 않고 null을 돌려준다 — 이전 의미를
     * 근거로 한 edge가 새 의미에 붙는 것을 막는다.
     */
    expectedSourceGeneration?: number;
    expectedTargetGeneration?: number;
}
export declare function createRelation(db: Database.Database, sourceFactId: string, relationType: RelationType, targetFactId: string, reasoning?: string, opts?: CreateRelationOptions): OntologyRelation | null;
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
export declare function getRelatedFacts(db: Database.Database, factId: string, hops?: number, decay?: number, minRelevance?: number, scopeProject?: string | null, scopeType?: 'project' | 'global' | 'all'): Array<{
    fact: Fact;
    relation: OntologyRelation;
    relevance: number;
    hop: number;
}>;
export declare function getRelationsForFact(db: Database.Database, factId: string): OntologyRelation[];
export declare function getOntologyTree(db: Database.Database, scopeProject?: string | null, scopeType?: 'project' | 'global' | 'all'): DomainTree[];
