import type Database from "better-sqlite3";
export interface StageCounters {
    total: number;
    done: number;
    pending: number;
    /** Sessions the worker deliberately never picks (policy gate, not work). */
    excluded: number;
    /** …of which below BACKFILL_MIN_EXCHANGES. */
    excludedBelowMin: number;
    /** …of which in excluded/LLM-workdir projects. */
    excludedProject: number;
    /** Sessions with terminal legacy or failed-visible extraction state. */
    deferred: number;
    /**
     * Sessions whose extraction queue job is real, claimable work that is simply
     * not due yet (`available_at` in the future). A subset of `pending`, never of
     * `deferred`: `deferred` is terminal, backoff is a clock (issue #11).
     */
    backoff: number;
    /** Earliest `available_at` across `backoff` sessions, or null. */
    backoffEarliestAt: string | null;
    /** The configured min-exchange gate value, shown for actionability. */
    gateMinExchanges: number;
    claimed: number;
    failedPermanent: number;
    /** Exact Continuity ranges that failed deterministically; never completed. */
    failedVisible: number;
    retriable: number;
}
/**
 * `memory_jobs` counted by kind × state (issue #46, 15.2).
 *
 * `byKind` is the full cross-tab keyed kind → state → count; `byState` is the
 * same rows folded across kinds. Both list only the pairs that exist, so an
 * empty queue reports `{}` instead of a grid of zeros.
 */
export interface JobCounters {
    total: number;
    byKind: Record<string, Record<string, number>>;
    byState: Record<string, number>;
}
export interface PipelineStatus {
    dataRootEmpty: boolean;
    conversations: {
        sessionsIndexed: number;
        exchanges: number;
        archiveFiles: number;
        ready: boolean;
    };
    extraction: StageCounters & {
        lastSuccessAt: string | null;
        lastErrorAt: string | null;
    };
    embeddings: {
        activeFacts: number;
        factVectorsPending: number;
    };
    /**
     * Issue #41. `classifiedFacts` counts only facts a classifier actually
     * placed; facts PARKED in General/Misc after bounded failures are their own
     * bucket. Before this split a parked fact was counted as classified, drove
     * `pendingFacts` to 0 and made status report `Ontology: READY` while the
     * overlay was silently stuck.
     */
    ontology: {
        classifiedFacts: number;
        pendingFacts: number;
        /** Facts held in General/Misc because classification exhausted its attempts. */
        parkedFacts: number;
        /** …of which still owed their one retry for the current policy/embedding token. */
        parkedRetryable: number;
        /**
         * `IndexRepairError` — "manual repair required" used to exist only inside
         * logs/backfill-ontology.log, which no status command reads.
         */
        indexRepair: {
            blocked: boolean;
            reason: string | null;
            detail: string | null;
            detectedAt: string | null;
        };
    };
    relations: number;
    /**
     * Terminal and retry state across the Continuity queue (issues #20, #39).
     *
     * `total` is the "needs a decision" count: dead jobs plus jobs waiting on a
     * retry. `memex jobs retry|dismiss` and `memex recover` both reduce it. The
     * `terminal` block is the rest of the eight terminal states that were
     * previously invisible everywhere — `extraction_failed_ranges` was the only
     * one status reported at all.
     */
    attention: {
        total: number;
        memoryJobsDead: number;
        memoryJobsRetry: number;
        /** Subset of `memoryJobsRetry` whose backoff has not elapsed. */
        memoryJobsBackoff: number;
        terminal: {
            checkpointsDeadLetter: number;
            checkpointsFailedVisible: number;
            extractionTargetsDead: number;
            extractionTargetItemsFailedVisible: number;
            capsuleCheckpointFailedVisible: number;
            extractionFailedRanges: number;
            captureGapsOpen: number;
            modelWorkBudgetsExhausted: number;
        };
    };
    /**
     * Issue #46 (15.2) — `memory_jobs` aggregated by kind × state.
     *
     * docs/GUIDE.md §15 promised `memex status --json` reported "단계별
     * pending/processing/retry/dead", but the JSON carried only the extraction
     * StageCounters: there was no per-job-kind breakdown anywhere, and
     * `attention` counts only the two states that need a decision. The runbook's
     * command could not answer the runbook's question.
     */
    jobs: JobCounters;
    /** #38 — projects isolated because their identity came from an untrusted cwd. */
    quarantinedProjects: Array<{
        projectId: string;
        displayName: string;
        facts: number;
    }>;
    lifecycleLastEventAt: Partial<Record<string, string>>;
    readiness: {
        conversationReady: boolean;
        factReady: boolean;
        graphReady: boolean;
    };
}
export declare function getPipelineStatus(opts?: {
    dbPath?: string;
    db?: Database.Database;
}): PipelineStatus;
/** Zero counters for a data root with no queue table yet. */
export declare function emptyJobCounters(): JobCounters;
/** Zero counters for a data root with no ontology overlay yet. */
export declare function emptyOntology(): PipelineStatus["ontology"];
/** Zero counters for a data root with no database yet. */
export declare function emptyAttention(): PipelineStatus["attention"];
export declare function formatPipelineStatus(s: PipelineStatus): string;
