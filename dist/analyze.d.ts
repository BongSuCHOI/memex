/**
 * Full-history analysis over the conversation index.
 *
 * Deterministic (no LLM) aggregation used by `memory-bank analyze` and the
 * `analyzing-all-conversations` skill: coverage, per-project rollups,
 * fact breakdowns, ontology domains, monthly timeline, and gap
 * recommendations (which backfills to run).
 */
export interface ProjectRollup {
    project: string;
    conversations: number;
    sessions: number;
    exchanges: number;
    facts: number;
    firstActivity: string | null;
    lastActivity: string | null;
}
export interface MonthlyActivity {
    month: string;
    exchanges: number;
    sessions: number;
}
export interface AnalysisReport {
    generatedAt: string;
    coverage: {
        totalConversations: number;
        totalSessions: number;
        totalExchanges: number;
        projectCount: number;
        dateRange: {
            earliest: string;
            latest: string;
        } | null;
        /** retrying: 내부 실패 후 재시도 예산이 남아 아직 pending 인 세션 수 */
        extraction: {
            processed: number;
            seeded: number;
            errors: number;
            retrying: number;
            pending: number;
        };
        /** Summary coverage over main conversations only */
        summaries: {
            withSummary: number;
            withoutSummary: number;
        };
    };
    facts: {
        active: number;
        inactive: number;
        byCategory: Array<{
            category: string;
            count: number;
        }>;
        byScope: Array<{
            scope: string;
            count: number;
        }>;
    };
    domains: Array<{
        domain: string;
        facts: number;
    }>;
    projects: ProjectRollup[];
    timeline: MonthlyActivity[];
    recommendations: string[];
}
export interface AnalyzeOptions {
    dbPath?: string;
    topProjects?: number;
    timelineMonths?: number;
}
export declare function analyzeHistory(options?: AnalyzeOptions): Promise<AnalysisReport>;
export declare function formatAnalysisMarkdown(report: AnalysisReport): string;
