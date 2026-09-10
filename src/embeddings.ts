import { env as transformersEnv, pipeline, FeatureExtractionPipeline } from '@xenova/transformers';
import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_MODEL,
  adoptLegacyEmbeddingCache,
  embeddingCacheDir,
  ensureEmbeddingCacheDir,
  formatCacheBytes,
} from './model-cache.js';

/**
 * The model id and the cache layout live in `./model-cache.js` — see its header
 * for the 2026-06-12 model selection and for issue #92 (why the weights must not
 * live under `node_modules`). They are re-exported here because every consumer
 * has always asked this module for them.
 */
export { EMBEDDING_MODEL };
export {
  embeddingCacheDir,
  embeddingCacheStatus,
  embeddingModelCacheDir,
} from './model-cache.js';

/**
 * Curated model → version map:
 *   1 = all-MiniLM-L6-v2 (English-only)
 *   2 = paraphrase-multilingual-MiniLM-L12-v2 (rejected — anisotropy)
 *   3 = multilingual-e5-small (query/passage prefixes)
 *
 * The version is DERIVED from the model so a MEMEX_EMBEDDING_MODEL
 * override can never poison stored vectors: an unknown model gets its own
 * deterministic version (1000+), so switching back later re-embeds those
 * rows instead of silently mixing incompatible vector spaces.
 */
const KNOWN_MODEL_VERSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 1,
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 2,
  [DEFAULT_EMBEDDING_MODEL]: 3,
};

function modelVersion(model: string): number {
  const known = KNOWN_MODEL_VERSIONS[model];
  if (known !== undefined) return known;
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return 1000 + (h % 1000000);
}

export const EMBEDDING_VERSION = modelVersion(EMBEDDING_MODEL);

export type EmbeddingMode = 'query' | 'passage';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

/**
 * Reproducible-harness seam: `MEMEX_EMBEDDING_STUB=1` replaces the model with a
 * deterministic hashed bag-of-words vector. Never enabled by default; the
 * calibration benchmark and no-model test environments use it so gate
 * behaviour can be measured without network or model downloads.
 */
export function embeddingStubEnabled(): boolean {
  return process.env.MEMEX_EMBEDDING_STUB === '1' || process.env.MEMEX_EMBEDDING_STUB === 'fail';
}

/** Harness seam: `MEMEX_EMBEDDING_STUB=fail` simulates an unavailable model. */
function embeddingStubFails(): boolean {
  return process.env.MEMEX_EMBEDDING_STUB === 'fail';
}

export function stubEmbedding(text: string, dimensions = 384): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length >= 2);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    vector[hash % dimensions] += 1;
    vector[(hash >>> 8) % dimensions] += 0.5;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

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
export function applyEmbeddingCacheDir(): string {
  const dir = embeddingCacheDir();
  transformersEnv.cacheDir = dir;
  return dir;
}

applyEmbeddingCacheDir();

/** Migration runs at most once per process, however many callers race it. */
let cachePrepared = false;

/**
 * Make the stable cache usable: create it, and adopt a legacy per-root cache
 * once if this data root has never held the model.
 *
 * Called on the model-load path only, so a stub run and the hook's fast path pay
 * nothing and touch no filesystem.
 */
export function prepareEmbeddingCache(): void {
  if (cachePrepared) return;
  cachePrepared = true;
  applyEmbeddingCacheDir();
  ensureEmbeddingCacheDir();
  let adoption: ReturnType<typeof adoptLegacyEmbeddingCache>;
  try {
    adoption = adoptLegacyEmbeddingCache({ model: EMBEDDING_MODEL });
  } catch {
    return; // a failed migration only means the model is downloaded again
  }
  // stderr: stdout of hook scripts is injected into the session as context.
  if (adoption.copied) {
    console.error(
      `[memex] adopted the embedding model cache from ${adoption.from} ` +
      `(${adoption.kind}, ${formatCacheBytes(adoption.bytes)}, ${adoption.files} files) ` +
      `into ${embeddingCacheDir()} — the source was copied, not moved`,
    );
  } else if (adoption.reason === 'copy-failed') {
    console.error(
      `[memex] could not adopt the embedding model cache from ${adoption.from}: ` +
      `${adoption.error ?? 'incomplete copy'} — the model will be downloaded instead`,
    );
  }
}

export async function initEmbeddings(): Promise<void> {
  if (embeddingStubFails()) throw new Error('embedding model unavailable (MEMEX_EMBEDDING_STUB=fail)');
  if (embeddingStubEnabled()) return;
  if (!embeddingPipeline) {
    // Issue #92: the cache directory is settled before the pipeline exists —
    // transformers reads `env.cacheDir` while resolving each model file.
    prepareEmbeddingCache();
    // stderr: stdout of hook scripts is injected into the session as context,
    // so progress logs must never go to stdout.
    console.error(`Loading embedding model ${EMBEDDING_MODEL} (first run may take time)...`);
    embeddingPipeline = await pipeline(
      'feature-extraction',
      EMBEDDING_MODEL
    );
    console.error('Embedding model loaded');
  }
}

function applyModePrefix(text: string, mode: EmbeddingMode): string {
  // e5-family models require asymmetric prefixes; other models take raw text.
  if (EMBEDDING_MODEL.toLowerCase().includes('e5')) {
    return `${mode}: ${text}`;
  }
  return text;
}

// Small LRU memo for query embeddings. One MCP search embeds the SAME query
// text twice (searchConversations + getKnowledgeContext), each costing a full
// model inference (~35ms measured) — the memo collapses that to one. Also
// covers a user re-running the same query. 'query' mode only: passage-mode
// callers embed unique content (indexing), where a memo is pure overhead.
const QUERY_EMBED_MEMO_MAX = 32;
const queryEmbedMemo = new Map<string, number[]>();

// Process-wide inference accounting so callers can report exactly how many
// model calls a prompt cost (probe warm-up included) versus memo hits.
let modelCalls = 0;
let cacheHits = 0;

/** Cumulative counts for this process; sample the delta around a unit of work. */
export function embeddingCallStats(): { modelCalls: number; cacheHits: number } {
  return { modelCalls, cacheHits };
}

/**
 * @param mode 'passage' for stored/indexed content (facts, exchanges),
 *             'query' for search queries. Defaults to 'passage' because most
 *             call sites embed content; search paths must pass 'query'.
 */
export async function generateEmbedding(text: string, mode: EmbeddingMode = 'passage'): Promise<number[]> {
  if (mode === 'query') {
    const hit = queryEmbedMemo.get(text);
    if (hit) {
      // refresh LRU position
      queryEmbedMemo.delete(text);
      queryEmbedMemo.set(text, hit);
      cacheHits++;
      return hit.slice();
    }
  }

  if (embeddingStubFails()) throw new Error('embedding model unavailable (MEMEX_EMBEDDING_STUB=fail)');
  if (embeddingStubEnabled()) {
    modelCalls++;
    const stub = stubEmbedding(text);
    if (mode === 'query') queryEmbedMemo.set(text, stub.slice());
    return stub;
  }
  if (!embeddingPipeline) {
    await initEmbeddings();
  }

  // Truncate text to avoid token limits (512 tokens max for this model)
  const truncated = applyModePrefix(text.substring(0, 2000), mode);

  modelCalls++;
  const output = await embeddingPipeline!(truncated, {
    pooling: 'mean',
    normalize: true
  });

  const embedding = Array.from(output.data) as number[];
  if (mode === 'query') {
    queryEmbedMemo.set(text, embedding.slice());
    if (queryEmbedMemo.size > QUERY_EMBED_MEMO_MAX) {
      queryEmbedMemo.delete(queryEmbedMemo.keys().next().value as string);
    }
  }
  return embedding;
}

export async function generateExchangeEmbedding(
  userMessage: string,
  assistantMessage: string,
  toolNames?: string[]
): Promise<number[]> {
  // Combine user question, assistant answer, and tools used for better searchability
  let combined = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;

  // Include tool names in embedding for tool-based searches
  if (toolNames && toolNames.length > 0) {
    combined += `\n\nTools: ${toolNames.join(', ')}`;
  }

  return generateEmbedding(combined, 'passage');
}

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
export const BACKGROUND_PROBES = [
  '오늘 날씨가 참 좋네요',
  '주말에 뭐 할지 고민 중이야',
  '맛있는 저녁 식사를 했다',
  'The weather is nice today',
  'I went for a walk in the park',
  '음악을 들으면서 휴식을 취했다',
  '새로운 취미를 시작해볼까 생각 중',
  'Let me think about what to do next',
];

let probeEmbeddings: number[][] | null = null;

/** Max cosine similarity between the query embedding and the background probes. */
export async function queryBaseline(queryEmbedding: number[]): Promise<number> {
  if (!probeEmbeddings) {
    probeEmbeddings = [];
    for (const p of BACKGROUND_PROBES) {
      probeEmbeddings.push(await generateEmbedding(p, 'passage'));
    }
  }
  let max = -1;
  for (const probe of probeEmbeddings) {
    let dot = 0;
    for (let i = 0; i < probe.length; i++) dot += probe[i] * queryEmbedding[i];
    if (dot > max) max = dot;
  }
  return max;
}
