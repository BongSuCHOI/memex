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
export const DERIVED_LANE_FORCE_AFTER = 3;

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
export function describeDerivedLaneSkipReason(reason: string): string {
  return reason === 'continuity_backlog' ? 'continuity backlog' : reason.replace(/_/g, ' ');
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined
  );
}

/** Idempotent; the maintenance hook may run against a pre-0.6.1 database. */
export function ensureDerivedLaneSkipTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS derived_lane_skips (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reason TEXT NOT NULL,
      consecutive INTEGER NOT NULL DEFAULT 0,
      total_skips INTEGER NOT NULL DEFAULT 0,
      last_skipped_at TEXT,
      last_forced_at TEXT
    )
  `);
}

/**
 * Record one skip of the derived lanes and decide whether this invocation must
 * let them through anyway.
 *
 * Returns `forced: true` on the Nth consecutive skip for the same reason. The
 * counter resets on that pass, so the lanes are released once per N skips —
 * priority is preserved, starvation is not.
 */
export function recordDerivedLaneSkip(
  db: Database.Database,
  reason: DerivedLaneSkipReason | string,
  now: Date = new Date(),
): { consecutive: number; forced: boolean; totalSkips: number } {
  ensureDerivedLaneSkipTable(db);
  const nowIso = now.toISOString();
  const apply = db.transaction(() => {
    const current = db
      .prepare('SELECT reason, consecutive, total_skips FROM derived_lane_skips WHERE id = 1')
      .get() as { reason: string; consecutive: number; total_skips: number } | undefined;
    // A different reason is a different backlog: its own run of skips starts here.
    const sameReason = current?.reason === reason;
    const consecutive = (sameReason ? Number(current?.consecutive ?? 0) : 0) + 1;
    const totalSkips = (sameReason ? Number(current?.total_skips ?? 0) : 0) + 1;
    const forced = consecutive >= DERIVED_LANE_FORCE_AFTER;
    db.prepare(`
      INSERT INTO derived_lane_skips (id, reason, consecutive, total_skips, last_skipped_at, last_forced_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        reason = excluded.reason,
        consecutive = excluded.consecutive,
        total_skips = excluded.total_skips,
        last_skipped_at = excluded.last_skipped_at,
        last_forced_at = COALESCE(excluded.last_forced_at, derived_lane_skips.last_forced_at)
    `).run(reason, forced ? 0 : consecutive, totalSkips, nowIso, forced ? nowIso : null);
    return { consecutive, forced, totalSkips };
  });
  return apply.immediate();
}

/** The backlog drained: the derived lanes are running normally again. */
export function clearDerivedLaneSkips(db: Database.Database): void {
  if (!tableExists(db, 'derived_lane_skips')) return;
  db.prepare('UPDATE derived_lane_skips SET consecutive = 0, total_skips = 0 WHERE id = 1').run();
}

/** Read-only view for `memex status`; null when nothing has ever been skipped. */
export function readDerivedLaneSkips(db: Database.Database): DerivedLaneSkipState | null {
  if (!tableExists(db, 'derived_lane_skips')) return null;
  const row = db
    .prepare(
      'SELECT reason, consecutive, total_skips, last_skipped_at, last_forced_at FROM derived_lane_skips WHERE id = 1',
    )
    .get() as
    | {
        reason: string;
        consecutive: number;
        total_skips: number;
        last_skipped_at: string | null;
        last_forced_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    reason: row.reason,
    consecutive: Number(row.consecutive),
    totalSkips: Number(row.total_skips),
    lastSkippedAt: row.last_skipped_at ?? null,
    lastForcedAt: row.last_forced_at ?? null,
  };
}
