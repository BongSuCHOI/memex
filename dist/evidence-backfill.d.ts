/**
 * Issue #45 — local meaning receipts for facts that never got one.
 *
 * Observed in the audited data root: 127 facts, 9 `fact_evidence_receipts`
 * rows (all `method = 'extractor'`, all on `promotion_state = 'workstream'`
 * facts extracted after the commit that started binding evidence). The other
 * 118 had none, and there was no backfill path — `recordLocalMeaningEvidence`
 * only ran at extraction/edit time, so a fact that missed it missed it
 * forever.
 *
 * The consequence is not cosmetic: `hasLocalMeaningEvidence` gates automatic
 * consolidation in three places, so 93% of that corpus was silently excluded
 * from consolidation (visible to the user only as "duplicate facts keep
 * piling up").
 *
 * The same audit confirmed the repair is free: 0 facts had empty
 * `source_exchange_ids` and all 135 referenced exchange ids resolved, so every
 * missing receipt could be rebuilt from local rows with NO model call.
 */
import type Database from 'better-sqlite3';
export interface EvidenceBackfillResult {
    /** Facts examined this run. */
    scanned: number;
    /** Receipts actually written. */
    recorded: number;
    /**
     * Facts whose receipt could not be rebuilt (evidence changed under us
     * between selection and the write). Counted, never silent — that silence is
     * what let 118 missing receipts go unnoticed.
     */
    failed: number;
}
/**
 * Active facts that carry source evidence but have no CURRENT local receipt.
 *
 * A receipt is "current" only when it matches the fact's semantic generation
 * and is not demoted to peer authority. The exact-hash and source-snapshot
 * checks live in `hasLocalMeaningEvidence` (not expressible in SQL); this
 * predicate is the cheap superset status and the worker share, so both report
 * the same number.
 */
export declare function missingLocalEvidenceClause(alias?: string): string;
/** …of those, the ones whose every source exchange still resolves locally. */
export declare function repairableLocalEvidenceClause(alias?: string): string;
/**
 * Hand-rolled fixture schemas and pre-receipt databases exist; every entry
 * point degrades to "nothing to report" rather than throwing inside read-only
 * status.
 */
export declare function hasEvidenceSchema(db: Database.Database): boolean;
/** Count for `memex status`; 0 when the tables do not exist yet. */
export declare function countFactsWithoutLocalEvidence(db: Database.Database): number;
/** …of which the model-free backfill can actually repair right now. */
export declare function countRepairableLocalEvidence(db: Database.Database): number;
/**
 * Rebuild missing receipts. Model-free and resumable: the receipt row itself
 * is the resume marker, so an interrupted run simply re-selects the rest.
 */
export declare function backfillEvidenceReceipts(db: Database.Database, options?: {
    limit?: number;
}): EvidenceBackfillResult;
