/**
 * Shared ontology work selection (issue #41).
 *
 * Before this module every retry selector spelled out
 * `ontology_category_id IS NULL`, which made a fact PARKED in General/Misc
 * after bounded failures indistinguishable from a fact the LLM genuinely
 * classified as Misc — and permanently invisible to every retry path. The
 * selection rule now lives in one place so the worker, the SessionStart hook,
 * the maintenance budget and status all agree on what "pending" means.
 *
 * Parking is bounded, not permanent: a parked fact re-enters the queue exactly
 * ONCE per (classifier policy, embedding generation) pair. The token that was
 * current when it was parked is stored on the row, so a re-park under the same
 * token can never produce a second retry — only a policy bump or an embedding
 * model upgrade (i.e. a plausible change of cause) reopens it.
 */
/**
 * Bump when the classifier's prompt/parsing contract changes in a way that
 * could make a previously unclassifiable fact classifiable. This is NOT a
 * database schema version: it only gates parked-fact retries.
 */
export const ONTOLOGY_POLICY_VERSION = 1;
/**
 * Max classification attempts before a fact is parked in the General/Misc
 * fallback. Lives here (not in the classifier) so hooks and status can build
 * the selection predicate without loading the LLM/embedding runtime.
 */
export const MAX_CLASSIFY_ATTEMPTS = 3;
/** Marker written into `facts.ontology_state` by the fallback parking path. */
export const ONTOLOGY_STATE_PARKED = "parked";
/** Opaque, comparable token: identical token ⇒ no retry is owed. */
export function ontologyParkToken(embeddingVersion) {
    return `p${ONTOLOGY_POLICY_VERSION}:e${embeddingVersion}`;
}
/**
 * Facts the classification backfill must still work on:
 *   (a) never classified and still under the attempt cap, OR
 *   (b) parked under a STALE policy/embedding token — owed exactly one retry.
 *
 * Callers embed the clause as `WHERE ${clause}` and pass `params` first.
 */
export function buildOntologyPendingClause(options) {
    const f = options.alias ?? "f";
    const clause = `${f}.is_active = 1 AND (
      (${f}.ontology_category_id IS NULL AND COALESCE(${f}.ontology_attempts, 0) < ?)
      OR (${f}.ontology_state = '${ONTOLOGY_STATE_PARKED}'
          AND COALESCE(${f}.ontology_parked_version, '') <> ?)
    )`;
    return {
        clause,
        params: [options.maxAttempts, ontologyParkToken(options.embeddingVersion)],
    };
}
/** Parked facts that are still owed their one retry for the current token. */
export function buildOntologyParkedRetryClause(options) {
    const f = options.alias ?? "f";
    return {
        clause: `${f}.is_active = 1 AND ${f}.ontology_state = '${ONTOLOGY_STATE_PARKED}'
      AND COALESCE(${f}.ontology_parked_version, '') <> ?`,
        params: [ontologyParkToken(options.embeddingVersion)],
    };
}
/** Every parked fact, retryable or not — the number status reports. */
export function buildOntologyParkedClause(alias = "f") {
    return `${alias}.is_active = 1 AND ${alias}.ontology_state = '${ONTOLOGY_STATE_PARKED}'`;
}
/**
 * "This fact still owes the ontology lane work", fully inlined.
 *
 * The token is built from two integers (policy version, embedding version) and
 * matches /^p\d+:e\d+$/, so inlining it is injection-free. Callers that already
 * thread a long positional parameter list (the maintenance budget's pending
 * queries) use this form rather than re-numbering their placeholders.
 */
export function ontologyPendingSqlInline(alias, embeddingVersion) {
    const token = ontologyParkToken(embeddingVersion);
    if (!/^p\d+:e\d+$/.test(token))
        throw new Error(`unsafe ontology park token: ${token}`);
    return `(${alias}.ontology_category_id IS NULL
      OR (${alias}.ontology_state = '${ONTOLOGY_STATE_PARKED}'
          AND COALESCE(${alias}.ontology_parked_version, '') <> '${token}'))`;
}
