import type Database from "better-sqlite3";
export interface ContinuityWorkerResult {
    jobId: string;
    kind: "capture_index" | "capsule_update";
    state: "completed" | "retry" | "dead" | "stale" | "deferred";
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
