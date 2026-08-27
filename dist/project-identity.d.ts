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
