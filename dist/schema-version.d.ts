/**
 * Bump this whenever the migration list changes — a new table, a new column, a
 * new backfill, a changed guard. Forgetting to bump it would leave every
 * existing database on the fast path, so the new migration would never run:
 * `test/schema-fast-path.test.ts` fingerprints the statements the pass executes
 * and fails until both this number and the fingerprint are updated together.
 *
 * Deliberately above CONTINUITY_SCHEMA_VERSION (7), which
 * `ensureContinuitySchema` writes as its own stage marker when it is called on
 * its own: a file at 7 has had the continuity migration but not necessarily the
 * whole pass, and must not be treated as current.
 */
export declare const CURRENT_SCHEMA_VERSION = 8;
/**
 * sha256(first 16 hex) of every SQL statement one migration pass executes on a
 * brand-new database, in order. Update it in the SAME commit as
 * CURRENT_SCHEMA_VERSION; see the test named above for how it is computed.
 */
export declare const MIGRATION_LIST_FINGERPRINT = "2cb2261bac8c3348";
