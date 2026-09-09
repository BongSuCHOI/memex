import Database from 'better-sqlite3';
import type { OntologyDomain, OntologyCategory, OntologyRelation, RelationType, DomainTree, Fact } from './types.js';
import { type FactSearchScope } from './fact-db.js';
import { type ReadScope } from './read-scope.js';
import { type MutationPolicy } from './fact-policy.js';
/** Global taxonomy epoch — bumped on every FULL taxonomy invalidation (the
 * privacy purge). In-flight classification captures this value before its
 * LLM/embedding awaits and re-checks it at commit: a stale result must leave
 * nothing behind instead of re-creating private-derived taxonomy rows. The
 * table is created lazily so hand-rolled test schemas and pre-existing
 * databases work without a migration. */
export declare function getTaxonomyEpoch(db: Database.Database): number;
/** Advance the epoch by one. Must run INSIDE the invalidating transaction
 * (the privacy purge) so classifiers can never observe the wipe without the
 * epoch move, or the epoch move without the wipe. */
export declare function bumpTaxonomyEpoch(db: Database.Database): void;
/**
 * Resolve-or-create a domain (이슈 #47).
 *
 * The old unconditional INSERT relied on the caller's prior
 * `getDomainByName` miss, and that read+write pair sat inside better-sqlite3's
 * DEFERRED transaction: two connections (insert-time extraction and the
 * detached backfill worker) could both observe "absent" and both insert.
 * `ON CONFLICT DO NOTHING` + re-select makes the loser adopt the winner's row
 * instead of forking the taxonomy — the unique index created in db.ts is what
 * turns the second INSERT into a no-op.
 */
export declare function createDomain(db: Database.Database, name: string, description?: string): OntologyDomain;
export declare function listDomains(db: Database.Database): OntologyDomain[];
export declare function getDomain(db: Database.Database, id: string): OntologyDomain | null;
export declare function getDomainByName(db: Database.Database, name: string): OntologyDomain | null;
/** Resolve-or-create a category. Same race contract as createDomain (이슈 #47). */
export declare function createCategory(db: Database.Database, domainId: string, name: string, description?: string): OntologyCategory;
export declare function listCategories(db: Database.Database, domainId?: string): OntologyCategory[];
export declare function getCategory(db: Database.Database, id: string): OntologyCategory | null;
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
export declare function classifyFact(db: Database.Database, factId: string, categoryId: string, expectedSemanticGeneration?: number, expectedTaxonomyEpoch?: number, 
/**
 * 이슈 #47: 할당 시점의 코사인 유사도. 저장해 두지 않으면 0.42로 붙은
 * 할당과 0.98로 붙은 할당이 사후 구분 불가다(재분류 대상 선별의 입력).
 * undefined면 기존 값을 유지하지 않고 NULL로 지운다 — 새 할당의 신뢰도를
 * 옛 할당의 값으로 설명하면 안 되기 때문이다.
 */
similarity?: number | null): number;
export declare function getFactsByCategory(db: Database.Database, categoryId: string, scopeProject?: string | null, scopeType?: 'project' | 'global' | 'all', identityScope?: FactSearchScope): Fact[];
export declare function getFactsByCategoryInScope(db: Database.Database, categoryId: string, scope: ReadScope): Fact[];
export declare function getFactsByDomain(db: Database.Database, domainId: string): Fact[];
export interface CreateRelationOptions {
    policy?: MutationPolicy;
    readScope?: ReadScope;
    /**
     * 재감사 P1-2: async relation writers (LLM 왕복을 기다린 뒤 쓴다)가 캡처한
     * 양 endpoint의 의미 세대. 제공되면 검증+삽입을 한 transaction으로 원자화하고,
     * 한쪽이라도 세대가 밀렸으면 관계를 만들지 않고 null을 돌려준다 — 이전 의미를
     * 근거로 한 edge가 새 의미에 붙는 것을 막는다.
     */
    expectedSourceGeneration?: number;
    expectedTargetGeneration?: number;
}
/** Automatic relation writers must supply both read scope and participant policy. */
export declare function createRelationInScope(db: Database.Database, sourceFactId: string, relationType: RelationType, targetFactId: string, scope: ReadScope, policy: MutationPolicy, reasoning?: string): OntologyRelation | null;
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
/** @deprecated Read-only positional adapter; missing scope defaults to global. */
export declare function getRelatedFacts(db: Database.Database, factId: string, hops?: number, decay?: number, minRelevance?: number, scopeProject?: string | null, scopeType?: 'project' | 'global' | 'all', identityScope?: FactSearchScope): Array<{
    fact: Fact;
    relation: OntologyRelation;
    relevance: number;
    hop: number;
}>;
/** Scope is mandatory for the seed and every node before it can enter the frontier. */
export declare function getRelatedFactsInScope(db: Database.Database, factId: string, scope: ReadScope, { hops, decay, minRelevance }?: {
    hops?: number;
    decay?: number;
    minRelevance?: number;
}): Array<{
    fact: Fact;
    relation: OntologyRelation;
    relevance: number;
    hop: number;
}>;
export declare function getRelationsForFact(db: Database.Database, factId: string): OntologyRelation[];
export declare function getOntologyTree(db: Database.Database, scopeProject?: string | null, scopeType?: 'project' | 'global' | 'all', identityScope?: FactSearchScope): DomainTree[];
