import { type CodexExecOptions, type CodexTokenUsage } from './codex-exec.js';
import { type ModelWorkContext } from './model-budget.js';
export declare function llmWorkdir(): string;
export interface MemoryModelOptions extends Pick<CodexExecOptions, 'outputSchema'> {
    /** Durable model-work context. Existing callers may omit this; a stable
     * standalone budget is created for the enclosing call. */
    modelContext?: Partial<ModelWorkContext>;
    /** Issue #31: per-call model override, so the evaluation harness and the
     *  settings probe can name a model without mutating process env globally. */
    model?: string | null;
    /** Per-call reasoning effort. `null` means "send no flag". */
    reasoningEffort?: string | null;
    /** Issue #31: the ONLY way past an active config hold. The settings probe
     *  sets it, because otherwise the user could never verify a fix. */
    bypassConfigHold?: boolean;
}
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
export declare function callMemoryModelObserved(systemPrompt: string, userMessage: string, maxTokens?: number, options?: MemoryModelOptions): Promise<ObservedMemoryModelResult>;
export declare function callMemoryModel(systemPrompt: string, userMessage: string, maxTokens?: number, options?: MemoryModelOptions): Promise<string>;
export declare function parseJsonResponse<T>(text: string): T | null;
