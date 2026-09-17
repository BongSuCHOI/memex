import { type InjectLogEntry } from "./inject-log.js";
import { type RecallGateConfig } from "./recall-gate.js";
import { type MatcherHandle } from "./overlay-matcher.js";
/**
 * Issue #32 — the margin is now tunable and measurable.
 *
 * The observed data root ran the pipeline 12 times over five days with
 * `candidate_facts = 5` and `current_facts = 0` every single time: not one of
 * 127 extracted facts ever entered a prompt. Nothing recorded where those
 * candidates actually sat relative to the threshold, so the constant could not
 * be judged from data. `baseline_margin_gap` telemetry now records that
 * distribution, and this override lets it be moved once the data says where.
 * The default is unchanged: retuning it without evidence would be guessing.
 */
export declare const INJECT_BASELINE_MARGIN_DEFAULT = 0.045;
export declare function resolveBaselineMargin(): number;
export interface InjectOptions {
    /** Disable the cheap gate (calibration baseline only). */
    gate?: boolean;
    gateConfig?: Partial<RecallGateConfig>;
    now?: string;
    /** Receives the exact prepared receipt only after its transaction commits. */
    onPreparedReceipt?: (id: string) => void;
    /**
     * Last gate before the bundle transaction: return a reason and NOTHING is
     * written — no prepared receipt, no fact residency, no gate state, no cursor.
     *
     * Issue #89. The transaction accounts for a delivery that happens afterwards
     * over a transport which may already be gone: the daemon computed for 74s
     * while the hook gave up at 3s, committed a `prepared` receipt nobody could
     * ever mark emitted (#44's provenance failure), and left the in-process
     * fallback to find every fact already resident, dedup them all, and emit
     * nothing. Called INSIDE the transaction, so there is no window between the
     * check and the commit.
     */
    deliverable?: () => string | null;
    /**
     * Issue #84: daemon attribution for this run's log line — the answering
     * daemon's identity on the fast path, or the identity mismatch that sent the
     * hook in-process. Recorded on whichever line this call writes, so the
     * fast-path decision and its outcome are one record.
     */
    daemon?: InjectLogEntry["daemon"];
    /**
     * Issue #162 (review): total milliseconds this call spent BLOCKED on the
     * database — the bundle transaction's lock wait, including its one retry.
     * The inject hook's done row carries it so `memex doctor` can compare both
     * hooks on the same footing; without it the inject row reported no wait at
     * all, which is exactly the signal the "database is locked" incidents needed.
     */
    onDbWaitMs?: (ms: number) => void;
    /**
     * Issue #29: the time-boxed worker that evaluates USER overlay regexes.
     *
     * The warm daemon owns one resident matcher for its whole lifetime; the cold
     * fallback hands in a one-shot. When it is absent and an overlay actually has
     * patterns, a one-shot is created and disposed here. With no overlay patterns
     * nothing is created at all, so an installation without an overlay pays zero.
     */
    matcher?: MatcherHandle;
}
/** The shape `commitInjectionBundle` needs from a database handle. */
type CommitDb = {
    transaction?: (fn: () => void) => {
        (): void;
        immediate(): void;
    };
    inTransaction?: boolean;
    pragma?: (statement: string, options?: {
        simple?: boolean;
    }) => unknown;
};
/** Issue #133: how often the injection commit is retried when another writer holds the lock. */
export declare const INJECT_COMMIT_BUSY_RETRIES = 1;
/** Issue #133: pause before that retry. */
export declare const INJECT_COMMIT_BUSY_DELAY_MS = 300;
/**
 * Issue #133: the retry's own lock wait. The first attempt already spent the
 * connection's full busy_timeout (5 s); a second full wait would push the
 * request past the hook's compute budget (10 s, `INJECT_DAEMON_REQUEST_TIMEOUT_MS`)
 * and, being synchronous, hide a hook that disconnected meanwhile. The retry
 * therefore waits at most this long, and only when `deadlineAt` still leaves
 * room for pause + wait — the compute before the commit is not free.
 */
export declare const INJECT_COMMIT_RETRY_BUSY_MS = 1000;
/**
 * How long after the request started a retry may still begin (pause and lock
 * wait included). Below the daemon's 10 s request timeout with margin for
 * delivery; a request that is already this late gets the first attempt's
 * error, exactly as before 0.7.11.
 */
export declare const INJECT_COMMIT_DEADLINE_MS = 8000;
export declare function isSqliteBusy(error: unknown): boolean;
/**
 * Issue #133: run the injection commit (receipt, residency, cursor, gate state)
 * and retry it once when SQLite reports another writer.
 *
 * The bundle is designed to be retryable — nothing is delivered before it
 * commits and every guard (`deliverable`, generation checks) re-runs inside it.
 * Observed live: the inject daemon waited its whole 5 s busy_timeout behind a
 * worker's WAL checkpoint and logged `database is locked`; the prompt received
 * no memory at all, with no fallback and no retry. One short retry covers the
 * residual contention left after the checkpoint fix, well inside the hook's
 * compute budget. Never retried inside a caller-owned transaction.
 */
export declare function commitInjectionBundle(db: CommitDb, commit: () => void, options?: {
    retries?: number;
    delayMs?: number;
    retryBusyMs?: number;
    deadlineAt?: number;
    /**
     * Issue #162 (review): fired as the FIRST statement of the transaction
     * body, i.e. the instant the write lock was granted. Everything before it
     * — including the retry's pause — was this hook WAITING on the database,
     * and it is the number `db_wait_ms` has to report.
     */
    onTransactionStart?: () => void;
}): Promise<void>;
/**
 * Compute the UserPromptSubmit context block for a prompt.
 *
 * Phase 5 flow: cheap gate (no model, no embedding) → optional single
 * embedding on the ambiguous path → revision-aware delta retrieval → Memory
 * Bundle (CORRECTION, WORK NOW, CURRENT TRUTH, WATCH, TRACE, RECENT EVIDENCE,
 * ASSISTANT CONTEXT-ONLY) under a deterministic hard budget. Returns '' when
 * there is nothing to inject.
 *
 * Shared by BOTH execution paths:
 *  - the warm in-process daemon inside the MCP server (embeddings already
 *    loaded → ~150ms), and
 *  - the cold fallback in scripts/inject-context.js (fresh node process,
 *    ~2.3s dominated by model load) used when no MCP server is running.
 *
 * `via` tags the inject log so the two paths stay distinguishable.
 *
 * Provenance 계약(RETRIEVAL-AND-CONTEXT.md:43-48): 컨텍스트 발행 **전**에 durable
 * `prepared` recall 영수증이 있어야 한다. sessionId 없는 호출은 recall_events 행을
 * 남길 수 없어 provenance 가 단절되므로, fact 주입 자체를 생략한다(fail-closed).
 * "one recall must not taint sibling tools" 불변식의 추적 가능성이 이 영수증에 의존한다.
 */
export declare function computeInjectContext(userPrompt: string, project: string, via: "daemon" | "fallback", sessionId?: string, options?: InjectOptions): Promise<string>;
export {};
