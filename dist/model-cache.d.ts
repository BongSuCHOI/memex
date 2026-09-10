/**
 * Multilingual retrieval model (Korean/English/100 langs), 384-dim — same
 * dimension as the original all-MiniLM-L6-v2 so vec tables are unchanged.
 *
 * Model selection (2026-06-12, measured on real-DB Korean/English pairs):
 *   - all-MiniLM-L6-v2: English-only — Korean queries score ~0 vs English facts
 *   - paraphrase-multilingual-MiniLM-L12-v2: top-1 ranking broke on real data
 *     (unrelated Korean pairs up to 0.82 — strong anisotropy)
 *   - multilingual-e5-small: perfect top-1 ranking on the hard set; absolute
 *     scores are compressed (~0.72-0.99) so consumers use either retuned
 *     thresholds (passage↔passage) or probe-baseline normalization (queries).
 *
 * e5 protocol: queries are embedded with a "query: " prefix, stored content
 * with "passage: ". Pass the mode explicitly at call sites.
 *
 * Vectors from different models are NOT comparable; EMBEDDING_VERSION (see
 * src/embeddings.ts) tracks which model produced a stored vector and the
 * re-embed worker upgrades rows.
 *
 * It lives here rather than in `src/embeddings.ts` because the cache layout is
 * keyed on the model id, and this module must stay loadable without the model
 * library.
 */
export declare const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export declare const EMBEDDING_MODEL: string;
export type EmbeddingCacheSource = "env" | "data-root";
/** How `embeddingCacheDir()` was resolved — reported verbatim by doctor. */
export declare function embeddingCacheSource(): EmbeddingCacheSource;
/**
 * The ONE directory every Memex process caches model weights in.
 *
 * `MEMEX_MODEL_CACHE_DIR` wins (an operator pointing at a shared or external
 * volume); otherwise `<data root>/models`, so `MEMEX_HOME` →
 * `$XDG_CONFIG_HOME/memex` → `~/.config/memex` decides it exactly as it decides
 * the archive and the index.
 */
export declare function embeddingCacheDir(): string;
/** Where `<cacheDir>` holds one model's files: `<cacheDir>/<org>/<name>`. */
export declare function embeddingModelCacheDir(model?: string, cacheDir?: string): string;
export interface EmbeddingCacheStatus {
    /** Resolved stable cache directory. */
    dir: string;
    source: EmbeddingCacheSource;
    model: string;
    /** `<dir>/<model>` — the subtree the files live in. */
    modelDir: string;
    /**
     * True only when BOTH the config and non-empty ONNX weights are present.
     *
     * A directory holding just `config.json` is an interrupted download, not a
     * warm cache, and reporting it as present is how a user gets told the first
     * prompt will be fast when it will not.
     */
    present: boolean;
    files: number;
    bytes: number;
    /**
     * `MEMEX_EMBEDDING_STUB=1`: a deterministic hashed vector replaces the model,
     * so no cache is needed and `present: false` is not a problem to report.
     *
     * Deliberately NOT true for `MEMEX_EMBEDDING_STUB=fail`, which means "the model
     * is unavailable" — a caller asking "do I need to warm?" must get `yes`, and
     * then watch the warm fail, rather than be told there is nothing to do.
     */
    stub: boolean;
}
/** `=1` only — see `EmbeddingCacheStatus.stub`. */
export declare function embeddingStubReplacesModel(): boolean;
/**
 * Is a model present in `modelDir`, and how big is it?
 *
 * Read-only: `doctor` and the warm gate both call it, and neither may create the
 * directory as a side effect of asking.
 */
export declare function inspectModelCacheDir(modelDir: string): {
    present: boolean;
    files: number;
    bytes: number;
};
export declare function embeddingCacheStatus(model?: string): EmbeddingCacheStatus;
export interface LegacyCacheCandidate {
    /** `<root>/node_modules/@xenova/transformers/.cache`. */
    cacheDir: string;
    /** Which rule produced it, for the migration log line. */
    kind: "execution-root" | "codex-cache" | "launcher";
    root: string;
}
/**
 * Every per-root cache a previous version could have left behind, best first.
 *
 * Three sources, in the order that makes the first hit the most likely to be
 * complete: the root that is running right now (it downloaded today's 129 MB),
 * then every installed version in the Codex plugin cache (the roots earlier
 * updates filled and abandoned), then the resolved installed/launcher root.
 *
 * Read-only and de-duplicated. A root with no cache directory is simply not
 * listed, so the caller never has to filter.
 */
export declare function legacyEmbeddingCacheCandidates(options?: {
    codexHome?: string;
    executionRoot?: string;
}): LegacyCacheCandidate[];
export interface LegacyCacheAdoption {
    copied: boolean;
    from: string | null;
    kind: LegacyCacheCandidate["kind"] | null;
    bytes: number;
    files: number;
    /** Why nothing was copied, when `copied` is false. */
    reason: "already-present" | "no-legacy-cache" | "copy-failed" | null;
    error?: string;
}
/**
 * One-time adoption of a legacy per-root cache into the stable directory.
 *
 * COPY, never move: the legacy cache belongs to an installation this process
 * does not own — in the `codex-cache` case to a DIFFERENT version's tree — and
 * moving or deleting files there would break that installation, which may be
 * running right now. Nothing outside `<cacheDir>` is written, and nothing
 * anywhere is removed.
 *
 * A no-op once the stable cache holds the model, which is what makes it
 * "one-time" without any marker file to keep honest.
 */
export declare function adoptLegacyEmbeddingCache(options?: {
    model?: string;
    codexHome?: string;
    executionRoot?: string;
}): LegacyCacheAdoption;
/** Create the stable cache directory. Returns it, whether or not it existed. */
export declare function ensureEmbeddingCacheDir(): string;
/** Human-readable size for log lines and doctor details. */
export declare function formatCacheBytes(bytes: number): string;
