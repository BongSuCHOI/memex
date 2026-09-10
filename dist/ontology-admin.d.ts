import type Database from 'better-sqlite3';
export interface CategoryMergePlan {
    dryRun: boolean;
    fromCategoryId: string;
    fromName: string;
    toCategoryId: string;
    toName: string;
    /** True when the two categories live under different domains. */
    crossDomain: boolean;
    /** Active + inactive facts re-pointed (or that would be). */
    factsMoved: number;
}
export interface CategoryRenameResult {
    categoryId: string;
    previousName: string;
    name: string;
    /** Renaming changes the embedded "name: description" text, so the vector is
     * invalidated and healCategoryIndex / the re-embed worker rebuild it. */
    embeddingInvalidated: boolean;
}
/**
 * Metadata-only audit line; never fact text, category description or prompts.
 *
 * Exported under a NEUTRAL name (decisions-v2 C5): `src/` already carried three
 * private copies of this same writer (here, `fact-management.ts:1068`,
 * `job-recovery.ts:485`), and 0.7.0's overlays would have made a fourth. New
 * callers import this one. The two existing ontology call sites below still pass
 * through it, so their behaviour is unchanged.
 *
 * The 1 MB rotation comes from `job-recovery.ts`'s copy, which had it and this
 * one did not. Folding the other two copies into this function is out of scope
 * (0.7.1 candidate).
 *
 * IMPORTANT for callers: this module pulls in `ontology-db`, so only WRITE-side
 * modules may import it. The overlay READ path (recall-gate-overlay.ts,
 * overlay-matcher.ts) must stay free of it — it is loaded on the injection fast
 * path (§1.4).
 */
export declare function appendUiAuditLine(action: string, detail: Record<string, unknown>): void;
/**
 * Fold `fromCategoryId` into `toCategoryId`: every fact filed under the source
 * moves to the target, the source row and its vector are removed.
 *
 * `deleteCategoryEmbedding` finally gets a caller here — it has been exported
 * dead code documenting a delete path that was never implemented.
 */
export declare function mergeCategories(db: Database.Database, input: {
    fromCategoryId: string;
    toCategoryId: string;
    dryRun?: boolean;
}): CategoryMergePlan;
/**
 * Rename one category in place. Facts keep their assignment (this is a label
 * change, not a re-classification); only the derived vector is invalidated,
 * because the embedded text is "name: description".
 */
export declare function renameCategory(db: Database.Database, input: {
    categoryId: string;
    name: string;
}): CategoryRenameResult;
