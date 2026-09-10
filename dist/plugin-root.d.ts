/** The production packages a hook needs before it can run without npx. */
export declare const RUNTIME_DEPENDENCIES: readonly ["better-sqlite3", "@xenova/transformers", "sqlite-vec"];
export type PluginRootSource = "env" | "codex-cache" | "codex-plugin-list" | "launcher";
export interface InstalledPluginRoot {
    /** Absolute path to the root whose `node_modules` the hooks actually use. */
    root: string;
    /** How `root` was resolved — reported verbatim by doctor. */
    source: PluginRootSource;
    /** Manifest version the resolution was keyed on, when one was readable. */
    version: string | null;
    /**
     * Every version directory the Codex cache holds, newest first (issue #69).
     *
     * More than one means the cache scan is a guess rather than a fact, so doctor
     * says so instead of presenting its pick as the loaded plugin.
     */
    cacheVersions: string[];
}
export declare function codexHomeDir(codexHome?: string): string;
/** Version declared by a checkout/installation, manifest first, package second. */
export declare function readManifestVersion(root: string): string | null;
/**
 * Every `<codex home>/plugins/cache/<market>/memex/<version>` that carries a
 * real installation, newest version first. Exported for the resolution test.
 */
export declare function codexCacheCandidates(codexHome?: string): Array<{
    root: string;
    marketplace: string;
    version: string;
}>;
export interface ResolveOptions {
    /** Root of the copy that is executing (the historical `PLUGIN_ROOT`). */
    fallbackRoot?: string;
    /** Allow spawning `codex plugin list --json` when the cache lookup fails. */
    probeCodex?: boolean;
    /** Override `$CODEX_HOME` (tests, isolated harnesses). */
    codexHome?: string;
    /** Explicit `--root` from the CLI; wins over everything, including the env. */
    explicitRoot?: string | null;
}
/**
 * Resolve the plugin root Codex actually loads. Never throws: the launcher root
 * is always an answer, so a diagnostic can report *something* even on a host
 * with no Codex installation at all.
 */
export declare function resolveInstalledPluginRoot(options?: ResolveOptions): InstalledPluginRoot;
/** Runtime packages absent from `<root>/node_modules`. */
export declare function missingRuntimeDependencies(root: string): string[];
