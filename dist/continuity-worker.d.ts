import type Database from "better-sqlite3";
/**
 * Issue #162 — name the write-lock holder.
 *
 * A hook killed by its host at 3 s left nothing behind that could say WHICH
 * process held the lock, or whether the worker was waiting for it or sitting on
 * it. These two numbers answer exactly that, and they are not interchangeable:
 *
 *   wait_ms  time from the transaction call to the moment its body starts —
 *            how long this worker WAITED for the write lock.
 *   held_ms  from the body's first statement to commit — how long this worker
 *            HELD it, i.e. how long everyone else waited on this process.
 *
 * Only `held_ms` may ever be reported as "held the write lock for N ms".
 *
 * The row format `{ts, pid, label, wait_ms, held_ms}` is a contract with
 * `memex doctor`'s hook-latency check, which reads this file.
 */
export declare const WORKER_SLOW_TRANSACTION_HELD_MS = 300;
export declare const WORKER_SLOW_TRANSACTION_WAIT_MS = 1000;
export declare function workerTransactionLogPath(): string;
/**
 * Time one write transaction. `run` receives `markStart`, which it must call as
 * the FIRST statement inside the transaction body — that is the instant the
 * write lock was granted, and the only way to separate waiting from holding.
 *
 * If `markStart` never fires the body never ran: either nothing needed a
 * transaction (nothing is recorded — no lock was taken) or acquiring it threw,
 * in which case the whole span was wait.
 *
 * Callees that open their OWN transaction (`applyWorkCapsulePatch`,
 * `completeEmptyCapsuleCheckpoint`, `scheduleCapsuleBacklog`, which live in
 * continuity-core) take an `onTransactionStart` callback for exactly this, and
 * the worker hands them `markStart`. Marking at the CALL instead — which is
 * what 0.7.24 first shipped — logged a call that died on SQLITE_BUSY without
 * ever entering the body as `wait_ms: 0, held_ms: 477`, and doctor reads
 * held_ms as "held the write lock for N ms": it accused the victim.
 */
export declare function timeWorkerTransaction<T>(label: string, run: (markStart: () => void) => T): T;
export interface ContinuityWorkerResult {
    jobId: string;
    kind: "capture_index" | "capsule_update";
    state: "completed" | "partial" | "retry" | "dead" | "stale" | "deferred" | "held";
    detail: string;
}
type ModelCall = (system: string, user: string) => Promise<string>;
export declare function runContinuityWorker(db: Database.Database, options?: {
    maxJobs?: number;
    owner?: string;
    now?: Date;
    model?: ModelCall;
    beforePrefixIngest?: () => void;
}): Promise<ContinuityWorkerResult[]>;
export {};
