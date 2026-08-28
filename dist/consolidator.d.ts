import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
export declare const CONSOLIDATION_SYSTEM_PROMPT = "Compare two facts and determine their relationship.\n\n## Relationship types (choose one)\n- DUPLICATE: same content - merge\n- CONTRADICTION: conflicting - new fact replaces old\n- EVOLUTION: old fact evolved - update\n- INDEPENDENT: separate - keep both\n\n## Output format\n{\n  \"relation\": \"DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT\",\n  \"merged_fact\": \"final sentence for merge/replace\",\n  \"reason\": \"one-line justification\"\n}";
export declare function buildConsolidationPrompt(existingFact: string, newFact: string): string;
export type { LlmErrorClass } from './llm-error-class.js';
export { LlmCallError, EmptyLlmResponseError, classifyLlmError, isTransientLlmError } from './llm-error-class.js';
interface ConsolidationDrainResult {
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
    llmCalls: number;
    remaining: number;
}
/**
 * @deprecated Back-compat wrapper for the removed per-project consolidator.
 * The timestamp argument is intentionally ignored: queue membership follows
 * local ingestion and semantic mutation, never historical created_at.
 */
export declare function consolidateFacts(db: Database.Database, project: string, _lastConsolidatedAt: string): Promise<{
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
}>;
/** Drain the durable local dirty queue across every project and global scope. */
export declare function consolidateAllPending(db: Database.Database): Promise<ConsolidationDrainResult>;
export declare function applyConsolidationResult(db: Database.Database, existingFact: Fact, newFact: Fact, result: ConsolidationResult): Promise<void>;
