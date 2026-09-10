export interface CodexModelOption {
    slug: string;
    displayName: string;
    description: string | null;
    defaultReasoning: string | null;
    /** Allowed reasoning levels for THIS model, in catalog order. */
    reasoningEfforts: string[];
    /** `visibility === 'list'`. Hidden entries stay selectable by typing them. */
    visible: boolean;
    priority: number;
}
export interface CodexCatalog {
    source: 'model_catalog_json' | 'models_cache' | 'none';
    path: string | null;
    fetchedAt: string | null;
    models: CodexModelOption[];
}
/** `$CODEX_HOME` or `~/.codex`. Same rule `lifecycle.ts` uses for hooks. */
export declare function codexHome(): string;
/** The path `config.toml` points at, or null. Never throws. */
export declare function catalogPathFromConfig(home?: string): string | null;
/**
 * User catalog first, then the fetched cache, then "none". Never throws.
 */
export declare function readCodexCatalog(home?: string): CodexCatalog;
/** Entries a picker should offer. Hidden ids stay typeable but unlisted. */
export declare function listableModels(catalog: CodexCatalog): CodexModelOption[];
export declare function findCatalogModel(catalog: CodexCatalog, slug: string): CodexModelOption | null;
/**
 * Allowed reasoning levels for one model, or `null` when this installation has
 * nothing to say about it.
 *
 * `null` is NOT "no levels are allowed" — the catalog can be stale, so a
 * settings write warns and proceeds instead of refusing (§3.3 rule 2).
 */
export declare function reasoningEffortsForModel(slug: string, catalog?: CodexCatalog): string[] | null;
