/**
 * Issue #43 — strict priority without indefinite, silent starvation.
 *
 * The SessionStart / UserPromptSubmit maintenance script returned early
 * whenever ANY P0/P1 job (capture_index, capsule_update) was claimable, which
 * skipped all four derived lanes at once: fact consolidation, re-embed,
 * ontology backfill and extraction backfill. The policy itself is sound —
 * those lanes compete for SQLite and local model capacity — but it was
 * unbounded and left no trace anywhere: no log, no telemetry sample, and
 * `memex status` showed only "pending isn't going down" with the cause sitting
 * in a completely different pipeline.
 *
 * A capsule job that fails deterministically is re-created at every new
 * checkpoint, so the skip could repeat indefinitely. This module keeps the
 * priority but bounds it: after N consecutive skips for the SAME reason the
 * derived lanes are let through exactly once, and every skip is durably
 * counted so status can name the cause.
 */
import type Database from 'better-sqlite3';
/** Consecutive skips for one reason before the derived lanes run anyway. */
export declare const DERIVED_LANE_FORCE_AFTER = 3;
export type DerivedLaneSkipReason = 'continuity_backlog';
export interface DerivedLaneSkipState {
    reason: string;
    /** Consecutive skips NOT yet released by a forced pass. */
    consecutive: number;
    lastSkippedAt: string | null;
    lastForcedAt: string | null;
    /** Skips observed since the counter last reset — monotone per reason run. */
    totalSkips: number;
}
/** Human-readable form used by status; the stored value stays a stable key. */
export declare function describeDerivedLaneSkipReason(reason: string): string;
/** Idempotent; the maintenance hook may run against a pre-0.6.1 database. */
export declare function ensureDerivedLaneSkipTable(db: Database.Database): void;
/**
 * Record one skip of the derived lanes and decide whether this invocation must
 * let them through anyway.
 *
 * Returns `forced: true` on the Nth consecutive skip for the same reason. The
 * counter resets on that pass, so the lanes are released once per N skips —
 * priority is preserved, starvation is not.
 */
export declare function recordDerivedLaneSkip(db: Database.Database, reason: DerivedLaneSkipReason | string, now?: Date): {
    consecutive: number;
    forced: boolean;
    totalSkips: number;
};
/** The backlog drained: the derived lanes are running normally again. */
export declare function clearDerivedLaneSkips(db: Database.Database): void;
/** Read-only view for `memex status`; null when nothing has ever been skipped. */
export declare function readDerivedLaneSkips(db: Database.Database): DerivedLaneSkipState | null;
