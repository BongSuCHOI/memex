/** Consecutive skips for one reason before the derived lanes run anyway. */
export const DERIVED_LANE_FORCE_AFTER = 3;
/** Human-readable form used by status; the stored value stays a stable key. */
export function describeDerivedLaneSkipReason(reason) {
    return reason === 'continuity_backlog' ? 'continuity backlog' : reason.replace(/_/g, ' ');
}
function tableExists(db, name) {
    return (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined);
}
/** Idempotent; the maintenance hook may run against a pre-0.6.1 database. */
export function ensureDerivedLaneSkipTable(db) {
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
export function recordDerivedLaneSkip(db, reason, now = new Date()) {
    ensureDerivedLaneSkipTable(db);
    const nowIso = now.toISOString();
    const apply = db.transaction(() => {
        const current = db
            .prepare('SELECT reason, consecutive, total_skips FROM derived_lane_skips WHERE id = 1')
            .get();
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
export function clearDerivedLaneSkips(db) {
    if (!tableExists(db, 'derived_lane_skips'))
        return;
    db.prepare('UPDATE derived_lane_skips SET consecutive = 0, total_skips = 0 WHERE id = 1').run();
}
/** Read-only view for `memex status`; null when nothing has ever been skipped. */
export function readDerivedLaneSkips(db) {
    if (!tableExists(db, 'derived_lane_skips'))
        return null;
    const row = db
        .prepare('SELECT reason, consecutive, total_skips, last_skipped_at, last_forced_at FROM derived_lane_skips WHERE id = 1')
        .get();
    if (!row)
        return null;
    return {
        reason: row.reason,
        consecutive: Number(row.consecutive),
        totalSkips: Number(row.total_skips),
        lastSkippedAt: row.last_skipped_at ?? null,
        lastForcedAt: row.last_forced_at ?? null,
    };
}
