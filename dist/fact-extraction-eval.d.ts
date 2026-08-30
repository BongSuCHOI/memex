import Database from "better-sqlite3";
import type { EvidenceSourceType, ExtractedFact, FactCategory, FactScopeType } from "./types.js";
export type EvaluationIssue = "DROP-noise" | "DROP-unsupported" | "MISS-important" | "WRONG-category" | "WRONG-provenance" | "WRONG-scope" | "EVAL-error";
export interface FactExtractionEvalToolEvidence {
    id: string;
    tool_name: string;
    tool_result: string | null;
    source_type: EvidenceSourceType;
    learnable: boolean;
    is_error: boolean;
}
export interface FactExtractionEvalExchange {
    id: string;
    user_message: string;
    assistant_message: string;
    assistant_learnable?: boolean;
    has_memex_recall?: boolean;
    tool_evidence?: FactExtractionEvalToolEvidence[];
}
export interface ExpectedEvaluationFact {
    required_terms: string[];
    category: FactCategory;
    scope_type: FactScopeType;
    authoritative_exchange_ids: string[];
}
export type FactExtractionCaseExpectation = {
    outcome: "facts";
    facts: ExpectedEvaluationFact[];
} | {
    outcome: "none";
    false_positive_taxonomy: EvaluationIssue;
};
export interface FactExtractionEvaluationCase {
    id: string;
    title: string;
    tags: string[];
    exchanges: FactExtractionEvalExchange[];
    watermark_after_exchange_index?: number;
    expected: FactExtractionCaseExpectation;
}
export interface FactExtractionEvaluationFixture {
    schema_version: 1;
    name: string;
    description: string;
    cases: FactExtractionEvaluationCase[];
}
export interface EvaluationTokenUsage {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
}
export interface EvaluationModelInvocation {
    caseId: string;
    systemPrompt: string;
    userMessage: string;
    callIndex: number;
}
export interface EvaluationModelResult {
    text: string;
    tokenUsage?: EvaluationTokenUsage | null;
}
export type EvaluationModelInvoker = (invocation: EvaluationModelInvocation) => Promise<EvaluationModelResult>;
export interface EvaluationCallReport {
    call_index: number;
    prompt_sha256: string;
    input_characters: number;
    output_characters: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    latency_ms: number;
}
export interface FactExtractionEvaluationCaseReport {
    id: string;
    title: string;
    tags: string[];
    expected: FactExtractionCaseExpectation | null;
    observed_facts: ExtractedFact[];
    passed: boolean | null;
    issues: EvaluationIssue[];
    expected_fact_count: number;
    matched_fact_count: number;
    false_positive_count: number;
    execution_error?: string;
    calls: EvaluationCallReport[];
}
export interface EvaluationSummary {
    case_count: number;
    passed_cases: number;
    failed_cases: number;
    execution_error_count: number;
    expected_fact_count: number;
    matched_fact_count: number;
    observed_fact_count: number;
    false_positive_count: number;
    self_amplification_leakage_count: number;
    positive_fact_recall: number | null;
    negative_no_fact_accuracy: number | null;
    precision: number | null;
    ratification_resolution: number | null;
    verified_local_recall: number | null;
    exploration_false_positive_rate: number | null;
    model_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    token_usage_status: "observed" | "partial" | "NOT_PROVEN";
    input_characters: number;
    output_characters: number;
    total_latency_ms: number;
}
export interface FactExtractionEvaluationReport {
    schema_version: 1;
    created_at: string;
    mode: "curated" | "shadow";
    model: string;
    source: {
        kind: "fixture";
        name: string;
        sha256: string;
    } | {
        kind: "archive";
        session_ids_sha256: string;
        session_count: number;
    };
    summary: EvaluationSummary;
    cases: FactExtractionEvaluationCaseReport[];
    comparison?: FactExtractionReportComparison;
    run_context?: {
        git_head: string | null;
        git_dirty: boolean | null;
        node: string;
        platform: string;
        arch: string;
        extractor_profile: "production-current";
        database_mode: "not-opened" | "read-only";
    };
}
export interface FactExtractionReportComparison {
    baseline_model: string;
    baseline_created_at: string;
    improvements: string[];
    regressions: string[];
    unchanged_passes: string[];
    unchanged_failures: string[];
    deltas: {
        matched_fact_count: number;
        false_positive_count: number;
        self_amplification_leakage_count: number;
        model_calls: number;
        input_tokens: number | null;
        output_tokens: number | null;
        total_latency_ms: number;
    };
}
export declare function parseFactExtractionFixture(value: unknown): FactExtractionEvaluationFixture;
export interface EvaluateFixtureOptions {
    model: string;
    invokeModel: EvaluationModelInvoker;
    createdAt?: string;
}
export declare function evaluateFactExtractionFixture(fixture: FactExtractionEvaluationFixture, options: EvaluateFixtureOptions): Promise<FactExtractionEvaluationReport>;
export interface EvaluateArchiveOptions extends EvaluateFixtureOptions {
}
export declare function evaluateFactExtractionArchiveSessions(db: Database.Database, sessionIds: string[], options: EvaluateArchiveOptions): Promise<FactExtractionEvaluationReport>;
export declare function compareFactExtractionReports(current: FactExtractionEvaluationReport, baseline: FactExtractionEvaluationReport): FactExtractionReportComparison;
