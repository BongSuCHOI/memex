import Database from 'better-sqlite3';
export interface MigrationPlan {
    totalExchanges: number;
    alreadyCanonical: number;
    movable: Array<{
        id: number | bigint;
        from: string;
        to: string;
    }>;
    ambiguous: Array<{
        id: number | bigint;
        project: string;
        reason: string;
    }>;
    factsRescope: Array<{
        id: number | bigint;
        from: string;
        to: string;
    }>;
}
export declare function planMigration(db: Database.Database): MigrationPlan;
export interface MigrationResult {
    applied: boolean;
    backupPath: string | null;
    exchangesUpdated: number;
    factsUpdated: number;
    archivePathsUpdated: number;
    ambiguousCount: number;
    countsVerified: boolean;
}
export declare function applyMigration(db: Database.Database, dbPath: string): Promise<MigrationResult>;
