// Issue #166 — the version of the WHOLE schema pass, and the gate that keeps it
// from running when there is nothing to do.
//
// `initDatabase()` used to re-run every migration on every open. The DDL is
// cheap (`CREATE TABLE IF NOT EXISTS` on an existing table is under a
// millisecond); the data backfills behind it are not. Measured on a 92 MB
// fixture with 15,000 exchanges, one open cost 1,040 ms: `UPDATE exchanges SET
// project_id …` 371 ms, `refreshExchangeMetadata`'s per-row UPDATE 197 ms across
// 15,000 calls, 173 ms of COMMIT for those dirty pages, 146 ms for the scan that
// drives them. Every hook, CLI call and MCP request paid it, under the write
// lock, which is how five hooks at SessionStart produced a 930 ms lock wait and a
// skipped capture on a machine with a large database.
//
// The file now carries the version of the pass that has run, in
// `PRAGMA user_version`, and the pass is skipped when the file is current.
//
// Kept in a leaf module (no imports) so the CLI, the update script and the
// migration itself can name the same number.
/**
 * Bump this whenever the migration list changes — a new table, a new column, a
 * new backfill, a changed guard. Forgetting to bump it would leave every
 * existing database on the fast path, so the new migration would never run:
 * `test/schema-fast-path.test.ts` fingerprints the statements the pass executes
 * and fails until both this number and the fingerprint are updated together.
 *
 * v9 (#166 gate): the data-normalizing statements now run from one exported
 * list, and `insertFact` sets `lifecycle_updated_at` itself. A file written at v8
 * by this unreleased branch can still hold a fact whose lifecycle clock is empty,
 * so it re-runs the pass once.
 *
 * v10 (#168): a new repair in that list closes the `capture_gaps` rows 0.7.24 and
 * 0.7.25 opened for capture events that never had a transcript. No later capture
 * can recover them, so without the bump every existing file would stay on the fast
 * path and carry them as `open` for ever in pipeline-status `captureGapsOpen`.
 *
 * Deliberately above CONTINUITY_SCHEMA_VERSION (7), which
 * `ensureContinuitySchema` writes as its own stage marker when it is called on
 * its own: a file at 7 has had the continuity migration but not necessarily the
 * whole pass, and must not be treated as current.
 */
export const CURRENT_SCHEMA_VERSION = 10;
/**
 * sha256(first 16 hex) of every MIGRATION statement one pass executes on a
 * brand-new database, in order. The transaction envelope (BEGIN/COMMIT/SAVEPOINT)
 * and the `PRAGMA user_version` gate are excluded: how the pass is DECIDED is not
 * a schema change. Update this in the SAME commit as CURRENT_SCHEMA_VERSION; see
 * the test named above for how it is computed.
 */
export const MIGRATION_LIST_FINGERPRINT = "e24e5531f920b792";
