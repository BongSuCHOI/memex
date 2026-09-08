import type Database from 'better-sqlite3';
type FindingCode = 'mixed-workstream-lineage' | 'foreign-workstream-lineage' | 'unproven-promotion' | 'semantic-revalidation-needed' | 'legacy-identity' | 'missing-source' | 'privacy-resurrection' | 'orphan-vector' | 'orphan-relation' | 'orphan-context';
export interface IntegrityFinding {
    id: string;
    code: FindingCode;
    disposition: 'review' | 'repairable';
    target: {
        table: string;
        id: string;
        exchangeId?: string;
        dependencyKind?: string;
    };
    evidence: Record<string, unknown>;
}
export interface IntegrityReport {
    version: 1;
    planId: string;
    factsExamined: number;
    findings: IntegrityFinding[];
}
/** Read-only, deterministic structural audit. Review candidates are not diagnoses. */
export declare function auditMemoryIntegrity(db: Database.Database): IntegrityReport;
/** Preview selection is exact and replay-safe. Ambiguous meaning/identity is never repaired automatically. */
export declare function applyIntegrityRepairs(db: Database.Database, report: IntegrityReport, selectedIds: readonly string[]): {
    applied: string[];
    alreadyApplied: string[];
};
export {};
