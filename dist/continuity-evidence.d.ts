import type Database from "better-sqlite3";
export declare const CAPSULE_PAGE_CHARS = 24000;
export declare const CAPSULE_POLICY_VERSION = "continuity-capsule-v2";
export interface CapsulePage {
    fromSeq: number;
    throughSeq: number;
    targetSeq: number;
    revision: number;
    evidence: Array<Record<string, unknown>>;
}
export declare function appendExchangeEvidence(db: Database.Database, exchangeId: string): number;
export declare function appendSessionEvidence(db: Database.Database, sessionId: string): void;
export declare function readCapsulePage(db: Database.Database, checkpointId: string): CapsulePage;
export declare function commitCapsulePage(db: Database.Database, workstreamId: string, page: CapsulePage): boolean;
export declare function capsulePageIsCurrent(db: Database.Database, workstreamId: string, page: CapsulePage): boolean;
