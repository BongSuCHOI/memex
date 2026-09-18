import Database from "better-sqlite3";
import type { ConversationExchange, EvidenceSourceType } from "./types.js";
export type VecDtype = "float32" | "int8";
export declare const VEC_INT8_SCALE = 127;
/** Authoritative dtype of any vec0 table — read from the ACTUAL schema in
 * sqlite_master (never a flag), so readers/writers can never disagree with a
 * Unknown/absent tables default to int8, matching the schema below. */
export declare function getVecTableDtype(db: Database.Database, table: string): VecDtype;
export declare function getVecDtype(db: Database.Database): VecDtype;
/** Convert a float embedding to the blob matching the table dtype. */
export declare function embeddingToVecBlob(embedding: number[], dtype: VecDtype): Buffer;
/** SQL placeholder for a vec_exchanges MATCH/INSERT param under the dtype. */
export declare function vecParamSql(dtype: VecDtype): string;
/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×127). */
export declare function normalizeVecDistance(distance: number, dtype: VecDtype): number;
/**
 * Convert a (float32-scale) L2 distance between UNIT vectors to cosine
 * similarity. e5 embeddings are L2-normalized, so ‖a-b‖² = 2(1 - cos) and
 * cos = 1 - d²/2. Single source of truth: every relevance gate / threshold in
 * search, fact search, repeat detection, ontology and the avatar responder
 * used to inline this identical expression (9 copies) — a metric change in one
 * place would silently make those gates disagree. Pass a NORMALIZED distance
 * (run it through normalizeVecDistance first for int8 tables).
 */
export declare function l2DistanceToSimilarity(distance: number): number;
/**
 * Install every connection-local runtime invariant. sqlite-vec registration
 * belongs to a connection, not the database file, so production callers must
 * use the factories below before touching vec0 tables.
 */
export declare const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** Open an existing database read-only with sqlite-vec registered. */
export declare function openReadDb(dbPath?: string): Database.Database;
/** Open a writable database with sqlite-vec and writer pragmas registered. */
export declare function openWriteDb(dbPath?: string, busyTimeoutMs?: number): Database.Database;
export declare function initDatabase(options?: {
    busyTimeoutMs?: number;
    dbPath?: string;
    /**
     * #166 review — what the pass did: whether it RAN at all (a concurrent opener
     * may have migrated first) and which migrations swallowed a failure. Callers
     * that REPORT the outcome (`applySchemaMigrations`, `memex update`) need it;
     * the hooks that just want a connection ignore it.
     */
    onSchemaMigration?: (outcome: {
        ran: boolean;
        skipped: string[];
    }) => void;
}): Database.Database;
/**
 * Issue #166 — apply the migration pass ONCE, outside anyone's budget.
 *
 * `memex update` calls this (through the installed root's dist) right after the
 * runtime dependencies are materialized, because the alternative is what was
 * observed: the first session after an update opens the database with five hooks
 * at once, the first connection runs the new-table migration under the write
 * lock, and the continuity hook waits 930 ms and gives up `busy`.
 *
 * Returns whether anything had to be migrated, so the caller can say so.
 */
export declare function applySchemaMigrations(options?: {
    dbPath?: string;
}): {
    migrated: boolean;
    version: number;
    skipped: string[];
    dbPath: string;
};
/**
 * Issue #166 (gate) — the data-normalizing statements of the migration pass, and
 * the invariant that makes the fast path safe.
 *
 * These repair rows written by OLDER code, and they stay in the pass for that.
 * But once the pass is skipped for a current file, a normalizer that a CURRENT
 * writer still depends on becomes a silent data bug: `insertFact` left
 * `lifecycle_updated_at = ''`, the every-open backfill filled it in on the next
 * open, and the moment that open stopped running the pass the Web UI import of a
 * freshly exported archive rejected its own facts.jsonl ("row failed protocol v4
 * schema validation"). So the invariant is: a row produced by a current writer
 * must already satisfy every entry here, and `test/row-normalization.test.ts`
 * iterates this list to prove it.
 */
export interface RowNormalizationInvariant {
    name: string;
    /** The migration statement, when it is a plain WHERE-filtered UPDATE. */
    repairSql?: string;
    /** Rows a parameterised or per-row normalizer would still rewrite. */
    pendingSql?: string;
    /**
     * Rows a normalizer would still rewrite when SQL cannot express the test —
     * #169's content hash needs sha256 over the row, which SQLite has no function
     * for. Read-only by contract, and asserted exactly like `pendingSql`.
     */
    pendingRows?: (db: Database.Database) => number;
    /** Why an entry carries no assertion (guarded, or not row normalization). */
    note?: string;
}
export declare const ROW_NORMALIZATION_INVARIANTS: RowNormalizationInvariant[];
export declare function insertExchange(db: Database.Database, exchange: ConversationExchange, embedding: number[], _toolNames?: string[]): boolean;
export declare function isMemexRecallToolName(toolName: string): boolean;
/**
 * Optional context that lets the trust classifier prove WHERE an observation
 * came from. Provenance is evidence-source-level: a read result is only
 * repository-local (learnable) evidence when its path resolves inside the
 * canonical project working directory AND outside every Memex data surface.
 */
export interface ToolEvidenceContext {
    /** Canonical project cwd of the exchange, when known. */
    cwd?: string | null;
}
export declare function classifyToolEvidence(toolName: string, toolInput?: unknown, ctx?: ToolEvidenceContext): {
    sourceType: EvidenceSourceType;
    learnable: boolean;
};
export declare function hashRecallPrompt(prompt: string): string;
export declare function recordRecallEvent(db: Database.Database, event: {
    sessionId: string;
    project: string;
    prompt: string;
    factIds: string[];
    projectId?: string | null;
    workspaceId?: string | null;
    workstreamId?: string | null;
    contextEpoch?: number;
    projectMemoryRevision?: number;
    /** Context-only delivery can be recorded even without fact IDs. The
     * context body is intentionally not persisted in this receipt. */
    context?: string;
    /** Issue #29: `gate:<sha8>` of the recall-gate overlay that decided this. */
    gateOverlayHash?: string | null;
}): string | null;
export declare function markRecallEventEmitted(db: Database.Database, event: {
    sessionId: string;
    prompt: string;
    id?: string;
}): boolean;
export declare function getAllExchanges(db: Database.Database): Array<{
    id: string;
    archivePath: string;
}>;
export declare function getFileLastIndexed(db: Database.Database, archivePath: string): number | null;
export declare function deleteExchange(db: Database.Database, id: string): void;
export interface ReconcileArchiveResult {
    renamed: number;
    deleted: number;
}
/**
 * 재감사 P1-6: 재색인 desired-set reconciliation. 새 파싱의 교환 집합(desired)과
 * 같은 archive의 DB 행 집합을 transaction으로 대조한다.
 *  - line 이 desired 에 없는 행 → 통합 삭제 primitive로 제거(stale state).
 *  - line 이 일치하지만 id 가 legacy(archivePath 기반) 행 → canonical id 로
 *    rename하고 모든 참조(tool_calls/vec/fact provenance/revision)를 재작성한다.
 *  - id 가 이미 일치하는 행 → 그대로(insertExchange upsert가 내용을 갱신한다).
 * 같은 line_start 에 행이 여러 개(구 scheme 의 growing-turn 중복)면, desired id 와
 * 정확히 일치하는 행을 남기고 없으면 last_indexed 가 최신인 행을 rename한 뒤
 * 나머지는 삭제한다. caller는 호출 뒤 desired 교환을 insertExchange 하면 된다.
 */
export declare function reconcileArchiveExchanges(db: Database.Database, input: {
    archivePath: string;
    desired: Array<{
        id: string;
        lineStart: number;
    }>;
}): ReconcileArchiveResult;
