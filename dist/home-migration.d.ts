export interface MigrateHomeOptions {
    /** Explicit source data root. Defaults to detectLegacyDataRoot(). */
    from?: string;
    /** Plan everything, write nothing. */
    dryRun?: boolean;
}
export interface MigrateHomeResult {
    /** 'ok' = migrated & verified; 'already-at-target' = nothing to do. */
    status: "ok" | "already-at-target";
    dryRun: boolean;
    sourceRoot: string;
    targetRoot: string;
    dirsCopied: string[];
    filesCopied: number;
    bytesCopied: number;
    sqliteIntegrityChecked: boolean;
    /** Read-only row-count comparison result across both roots. */
    rowsCompared: {
        table: string;
        source: number;
        target: number;
    }[];
}
export declare function migrateHome(
    opts?: MigrateHomeOptions,
): MigrateHomeResult;
