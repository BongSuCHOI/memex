import { type CodexTokenUsage } from './codex-exec.js';
export declare function llmWorkdir(): string;
export interface MemoryModelObservation {
    attempts: number;
    total_latency_ms: number;
    token_usage: CodexTokenUsage | null;
    token_usage_status: 'observed' | 'partial' | 'NOT_PROVEN';
}
export interface ObservedMemoryModelResult {
    text: string;
    observation: MemoryModelObservation;
}
export declare function callMemoryModelObserved(systemPrompt: string, userMessage: string, maxTokens?: number): Promise<ObservedMemoryModelResult>;
export declare function callMemoryModel(systemPrompt: string, userMessage: string, maxTokens?: number): Promise<string>;
export declare function parseJsonResponse<T>(text: string): T | null;
