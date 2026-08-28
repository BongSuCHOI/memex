export declare const HOOK_EVENTS: readonly ["SessionStart", "UserPromptSubmit", "SessionEnd"];
export type HookEvent = (typeof HOOK_EVENTS)[number];
export interface LifecycleCommandConfig {
    script: string;
    args?: string[];
    async?: boolean;
}
/** Relative-to-plugin-root commands registered for each event. */
export declare const LIFECYCLE_COMMANDS: Record<HookEvent, LifecycleCommandConfig[]>;
export interface LifecycleRegistration {
    schemaVersion: 1;
    installedAt: string;
    pluginRoot: string;
    codexHome: string;
    hooksFile: string;
    entries: Array<{
        event: HookEvent;
        command: string;
        fingerprint: string;
        async?: boolean;
    }>;
}
export declare function hooksFilePath(): string;
export declare function dataRoot(): string;
export declare function registrationPath(): string;
export declare function pluginRoot(): string;
export declare function fingerprintOf(command: string): string;
export declare function commandFor(root: string, c: LifecycleCommandConfig): string;
/** Build the desired entry list for a given plugin root (absolute commands). */
export declare function desiredEntries(root?: string): Array<{
    event: HookEvent;
    command: string;
    async?: boolean;
}>;
export interface PlanDiff {
    targetFile: string;
    add: Array<{
        event: HookEvent;
        command: string;
    }>;
    remove: Array<{
        event: HookEvent;
        command: string;
    }>;
    preservedForeignEntries: number;
    staleOwnedEntries: number;
}
/** Compute the exact add/remove diff against the current hooks.json. */
export declare function planSetup(root?: string): PlanDiff;
export interface SetupResult {
    changed: boolean;
    diff: PlanDiff;
    registrationPath: string;
}
/** Apply the idempotent setup. Returns what changed. Never runs installers. */
export declare function setupHooks({ dryRun, root, }?: {
    dryRun?: boolean;
    root?: string;
}): SetupResult;
export interface RemoveResult {
    removed: number;
    preservedForeignEntries: number;
    dryRun: boolean;
}
/** Remove only Memex-owned entries (exact fingerprint match). */
export declare function removeHooks({ dryRun, }?: {
    dryRun?: boolean;
}): RemoveResult;
export interface DoctorReport {
    json: unknown[];
    overall: "PASS" | "PARTIAL" | "FAIL";
}
/** Read-only diagnosis. Distinguishes configured vs observed. */
export declare function doctor(): DoctorReport;
