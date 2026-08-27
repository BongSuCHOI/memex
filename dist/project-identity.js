/**
 * CX-02 — canonical project identity.
 *
 * Single source of truth for the project identity used by every domain
 * surface (exchanges.project, facts.scope_project, archive storage keys,
 * search filters, stats, analyze, UI, injection).
 *
 * Contract:
 *   canonical   = lexically normalized absolute cwd from session_meta.
 *                 No realpath: historical cwds may no longer exist and must
 *                 not be lost. Case is preserved verbatim (macOS is
 *                 case-insensitive but case-preserving; two casings of the
 *                 same directory stay one identity only if Codex reports
 *                 them identically — policy documented in SCHEMA.md).
 *   displayName = basename(canonical); UIs append a path tail on conflict.
 *   storageKey  = filesystem-safe basename + '-' + stable hash(canonical).
 *
 * storageKey is a filesystem representation, never the domain identity.
 */
import path from 'node:path';
import crypto from 'node:crypto';
/** Lexically normalize an absolute cwd. Never touches the filesystem. */
export function canonicalizeProjectPath(cwd) {
    if (typeof cwd !== 'string')
        return '';
    let p = cwd.trim();
    if (!p)
        return '';
    // Keep absolute paths absolute; relative input resolves against '/' so the
    // result stays deterministic regardless of process cwd.
    if (!path.isAbsolute(p))
        p = path.resolve('/', p);
    // Collapse duplicate slashes and resolve . / .. segments lexically.
    const resolved = path.normalize(p);
    // Strip trailing slash except root.
    return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}
function safeName(canonical) {
    const base = path.basename(canonical) || 'unknown';
    return base.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'unknown';
}
/** Collision-free archive storage key derived from the canonical path. */
export function projectStorageKey(canonical) {
    const c = canonicalizeProjectPath(canonical);
    const hash = crypto.createHash('sha256').update(c).digest('hex').slice(0, 8);
    return `${safeName(c)}--${hash}`;
}
export function projectIdentity(cwd) {
    const canonical = canonicalizeProjectPath(cwd);
    return {
        canonical,
        displayName: path.basename(canonical) || 'unknown',
        storageKey: projectStorageKey(canonical),
    };
}
/**
 * Display label that disambiguates same-basename projects:
 * `shared — …/team-a/shared`.
 */
export function displayLabel(canonical) {
    const id = projectIdentity(canonical);
    return `${id.displayName} — …${canonical}`;
}
/** Fallback identity when a rollout carries no usable cwd. */
export const UNKNOWN_PROJECT = 'unknown';
export function isUnknownProject(project) {
    return !project || project === UNKNOWN_PROJECT;
}
