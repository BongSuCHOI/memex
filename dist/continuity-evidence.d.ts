import type Database from "better-sqlite3";
export declare const CAPSULE_PAGE_CHARS = 24000;
export declare const CAPSULE_PAGE_ITEMS = 8;
/**
 * Smallest page a shrinking retry may reach (issue #33). One evidence fragment
 * is the indivisible unit: below this the only remaining move is to record the
 * failure and step over that fragment.
 */
export declare const CAPSULE_MIN_PAGE_ITEMS = 1;
export declare const CAPSULE_POLICY_VERSION = "continuity-capsule-v2";
export interface CapsulePage {
    fromSeq: number;
    throughSeq: number;
    targetSeq: number;
    revision: number;
    evidence: Array<Record<string, unknown>>;
}
export declare function appendExchangeEvidence(db: Database.Database, exchangeId: string): number;
export declare function appendSessionEvidence(db: Database.Database, sessionId: string): void;
export declare function readCapsulePage(db: Database.Database, checkpointId: string): CapsulePage;
export declare function commitCapsulePage(db: Database.Database, workstreamId: string, page: CapsulePage): boolean;
/**
 * Halve the next page for this checkpoint (issue #33).
 *
 * `commitCapsulePage` is the only writer of `through_seq`, and it runs inside
 * the successful patch application. A failed attempt therefore left the
 * frontier exactly where it was, and the next `readCapsulePage` re-read the
 * identical rows: `max_attempts` retries of a deterministic failure. Feeding
 * the failure back as a smaller page makes the retry meaningfully different.
 *
 * Returns the page budget the next attempt will use, and whether that budget
 * is already at the floor (nothing left to shrink).
 */
export declare function shrinkCapsulePageHint(db: Database.Database, checkpointId: string): {
    items: number;
    chars: number;
    atFloor: boolean;
} | null;
/**
 * Has shrinking already reached one fragment (issue #71)?
 *
 * The terminal skip below is only defensible once the page cannot get any
 * smaller: until then the failure may still be about the page, not about the
 * head fragment, and stepping over that fragment throws away evidence that a
 * smaller page would have distilled. The dead path never shrinks, so the hint
 * this reads is the budget the failed attempt actually used.
 */
export declare function capsulePageHintAtFloor(db: Database.Database, checkpointId: string): boolean;
/** A drained or successfully committed page restores the full page budget. */
export declare function clearCapsulePageHint(db: Database.Database, checkpointId: string): void;
/**
 * Record partial progress past a fragment that cannot be distilled (issue #33).
 *
 * When shrinking has reached one fragment and that fragment still fails
 * terminally, leaving the frontier at `fromSeq` freezes the whole workstream:
 * every later Capsule read starts on the same unusable row and every capsule
 * is reported permanently stale. Stepping the frontier over exactly that one
 * fragment keeps the stream moving. The skipped `seq` is returned so the caller
 * records what was not distilled — it is never silently dropped.
 */
export declare function skipCapsuleEvidenceHead(db: Database.Database, workstreamId: string, page: CapsulePage): number | null;
export declare function capsulePageIsCurrent(db: Database.Database, workstreamId: string, page: CapsulePage): boolean;
