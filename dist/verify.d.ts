import type Database from "better-sqlite3";
export interface VerificationResult {
    missing: Array<{
        path: string;
        reason: string;
    }>;
    orphaned: Array<{
        uuid: string;
        path: string;
    }>;
    outdated: Array<{
        path: string;
        fileTime: number;
        dbTime: number;
    }>;
    corrupted: Array<{
        path: string;
        error: string;
    }>;
    fkViolations: Array<{
        table: string;
        rowid: number;
        parent: string;
        fkid: number;
    }>;
}
/**
 * Repair pass for FK violations: orphaned child rows are derived local data
 * whose parent is gone, so removing them is the only safe repair. The three
 * tables below are the schema's fact/exchange FK children; anything else is
 * reported for manual review, never touched blindly. Returns the removed
 * count.
 */
export declare function repairForeignKeyViolations(db: Database.Database, violations: VerificationResult["fkViolations"]): number;
export declare function verifyIndex(): Promise<VerificationResult>;
export declare function repairIndex(issues: VerificationResult): Promise<void>;
