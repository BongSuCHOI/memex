import { EMBEDDING_MODEL } from './model-cache.js';
/**
 * The model id and the cache layout live in `./model-cache.js` — see its header
 * for the 2026-06-12 model selection and for issue #92 (why the weights must not
 * live under `node_modules`). They are re-exported here because every consumer
 * has always asked this module for them.
 */
export { EMBEDDING_MODEL };
export { embeddingCacheDir, embeddingCacheStatus, embeddingModelCacheDir, } from './model-cache.js';
export declare const EMBEDDING_VERSION: number;
export type EmbeddingMode = 'query' | 'passage';
/**
 * Reproducible-harness seam: `MEMEX_EMBEDDING_STUB=1` replaces the model with a
 * deterministic hashed bag-of-words vector. Never enabled by default; the
 * calibration benchmark and no-model test environments use it so gate
 * behaviour can be measured without network or model downloads.
 */
export declare function embeddingStubEnabled(): boolean;
export declare function stubEmbedding(text: string, dimensions?: number): number[];
/**
 * Point `@xenova/transformers` at the stable cache (issue #92).
 *
 * Assignment only — no filesystem work — so it is safe at module scope, which is
 * what guarantees it happens BEFORE any `pipeline()` call however this module is
 * reached. `initEmbeddings` re-applies it because a test harness (and the MCP
 * server's own fixtures) can move `MEMEX_HOME` / `MEMEX_MODEL_CACHE_DIR` after
 * import, and the value must follow the data root rather than the import order.
 *
 * `env.allowRemoteModels` is deliberately left at its default `true`: the model
 * is fetched from the Hub on a cold cache, and that is the behaviour being made
 * cheap here, not removed. `env.localModelPath` is left alone as well — Memex
 * ships no local model directory, so the only thing pointing it at the cache
 * would change is which empty directory transformers stats first.
 */
export declare function applyEmbeddingCacheDir(): string;
/**
 * Make the stable cache usable: create it, and adopt a legacy per-root cache
 * once if this data root has never held the model.
 *
 * Called on the model-load path only, so a stub run and the hook's fast path pay
 * nothing and touch no filesystem.
 */
export declare function prepareEmbeddingCache(): void;
export declare function initEmbeddings(): Promise<void>;
/** Cumulative counts for this process; sample the delta around a unit of work. */
export declare function embeddingCallStats(): {
    modelCalls: number;
    cacheHits: number;
};
/**
 * @param mode 'passage' for stored/indexed content (facts, exchanges),
 *             'query' for search queries. Defaults to 'passage' because most
 *             call sites embed content; search paths must pass 'query'.
 */
export declare function generateEmbedding(text: string, mode?: EmbeddingMode): Promise<number[]>;
export declare function generateExchangeEmbedding(userMessage: string, assistantMessage: string, toolNames?: string[]): Promise<number[]>;
/**
 * Query-side anisotropy normalization (probe baseline).
 *
 * e5 similarity scores sit in a compressed band (~0.72-0.9 even for unrelated
 * pairs), so a fixed absolute threshold cannot separate relevant from
 * irrelevant. Instead, compare each query↔fact score against the query's own
 * baseline: its best similarity to a fixed set of neutral "background probe"
 * sentences. A fact is relevant only if it beats that baseline by a margin
 * (measured: related pairs +0.047~+0.123, unrelated pairs -0.028~-0.091).
 */
export declare const BACKGROUND_PROBES: string[];
/** Max cosine similarity between the query embedding and the background probes. */
export declare function queryBaseline(queryEmbedding: number[]): Promise<number>;
