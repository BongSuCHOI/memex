/** Lexically normalize an absolute cwd. Never touches the filesystem. */
export declare function canonicalizeProjectPath(cwd: string): string;
/** Collision-free archive storage key derived from the canonical path. */
export declare function projectStorageKey(canonical: string): string;
export interface ProjectIdentity {
    canonical: string;
    displayName: string;
    storageKey: string;
}
export declare function projectIdentity(cwd: string): ProjectIdentity;
/**
 * Display label that disambiguates same-basename projects:
 * `shared — …/team-a/shared`.
 */
export declare function displayLabel(canonical: string): string;
/** Fallback identity when a rollout carries no usable cwd. */
export declare const UNKNOWN_PROJECT = "unknown";
export declare function isUnknownProject(project: string | null | undefined): boolean;
/**
 * #38 — a path that cannot name a project. The filesystem root canonicalizes
 * to `/` and `path.basename('/')` is the empty string, so it used to pass the
 * `!canonical || canonical === 'unknown'` guard and create a catch-all project
 * named `unknown`. Every session whose host failed to report an absolute cwd
 * then landed in that one bucket and read its facts as its own project memory.
 * Any path with an empty basename is rejected for the same reason.
 */
export declare function isUntrustedProjectPath(cwd: string | null | undefined): boolean;
/** Thrown instead of attaching a session to a project it cannot name. */
export declare class UntrustedProjectPathError extends Error {
    constructor(cwd: string);
}
