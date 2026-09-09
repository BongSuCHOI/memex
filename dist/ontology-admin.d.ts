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
