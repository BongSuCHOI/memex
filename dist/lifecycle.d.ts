export declare const HOOK_EVENTS: readonly ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "PreCompact", "PostCompact", "SessionEnd"];
export type HookEvent = (typeof HOOK_EVENTS)[number];
export interface LifecycleCommandConfig {
    script: string;
    args?: string[];
    async?: boolean;
    matcher?: string;
    timeout?: number;
}
/** Relative-to-plugin-root commands registered for each event. */
/**
 * Issue #166 — `timeout` is the HOST timeout in seconds, and the hook budget in
 * src/hook-budget.ts is derived from it (timeout - one exit margin). These
 * numbers, hooks.json and HOOK_HOST_TIMEOUT_MS are pinned together by a test:
 * a budget derived from a timeout the host does not grant is worse than none.
 * Per learn.chatgpt.com/docs/hooks the cap is 600 s for SessionStart, Stop,
 * PreCompact, PostCompact and UserPromptSubmit; SessionEnd and Interrupt are the
 * only two events that default to 1 s and accept at most 3 s, so those two stay
 * at 3 (#166 review).
 */
export declare const LIFECYCLE_COMMANDS: Record<HookEvent, LifecycleCommandConfig[]>;
/** Hook scripts that must be registered for cross-device sync to work at all. */
export declare const SYNC_LIFECYCLE_SCRIPTS: {
    readonly export: "scripts/sync-export-hook.js";
    readonly import: "scripts/sync-import-hook.js";
};
/** True when `script` is registered for at least one lifecycle event. */
export declare function isLifecycleScriptRegistered(script: string): boolean;
export interface LifecycleRegistration {
    schemaVersion: 2;
    installedAt: string;
    pluginRoot: string;
    codexHome: string;
    hooksFile: string;
    entries: Array<{
        event: HookEvent;
        command: string;
        fingerprint: string;
        async?: boolean;
        matcher?: string;
        timeout?: number;
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
    matcher?: string;
    timeout?: number;
}>;
export interface PlanDiff {
    targetFile: string;
    add: Array<{
        event: HookEvent;
        command: string;
        matcher?: string;
        timeout?: number;
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
export interface Check {
    name: string;
    status: "ok" | "warn" | "fail";
    detail: string;
}
/**
 * Issue #31 — which model is Memex using, and is anything waiting on it?
 *
 * Two things were invisible before. Which model and reasoning level this
 * installation resolves (and from WHERE — env, models.json, or the built-in
 * default), and whether a rejected selection has quietly paused model work. The
 * second matters most: a hold fails no job and consumes no attempt, so without
 * this check the only symptom is "nothing is being extracted any more".
 */
/**
 * Issue #162 — what a skipped capture actually costs, stated once.
 *
 * NOT "content is never lost". Skipping a capture only delays that turn's fence
 * IF a later capture of the same session succeeds. When the last Stop/SessionEnd
 * of a session are all skipped, the worker reads only the existing journal
 * boundary: the tail never reaches the continuity journal/capsule, and the last
 * open/interrupted turn stays out of extraction (#149 settles only turns
 * followed by a later main-line exchange). `memex sync` still indexes the
 * rollout file, so search/RAG see the content — continuity and the final turn's
 * extraction do not until #163 lands.
 */
export declare const CAPTURE_GAP_LOSS_STATEMENT = "continuity/extraction of the tail is pending #163";
export declare function captureGapCheck(): Check;
export declare function hookLatencyCheck(now?: number): Check;
export declare function llmModelCheck(): Check;
export declare function doctor(): Promise<DoctorReport>;
