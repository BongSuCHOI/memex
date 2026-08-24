/** Set to '1' inside any codex exec child we spawn. Nested calls refuse. */
export declare const INNER_GUARD_ENV = "MEMORY_BANK_CODEX_EXEC_INNER";
/** Official default memory-model id used when no override is provided. */
export declare const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
export interface CodexExecOptions {
    systemPrompt?: string;
    userMessage?: string;
    timeoutMs?: number;
    codexBin?: string;
    /** Explicit model override; when absent, MEMORY_BANK_CODEX_MODEL env, then
     *  DEFAULT_CODEX_MODEL (gpt-5.6-luna) applies. Always forwarded via -m. */
    model?: string | null;
}
/** Pure arg builder — unit-tested without spawning anything. */
export declare function buildCodexExecArgs(opts: {
    model?: string | null;
    workdir: string;
    outputLast?: string;
}): string[];
/** Pull the last agent answer out of --json JSONL events (fallback path). */
export declare function lastAgentMessageFromEvents(stdout: string): string;
/**
 * One-shot LLM call through the local codex CLI.
 * Returns the final agent message (non-empty guaranteed by callers' retry
 * policy in llm.ts callMemoryModel). Throws on spawn failure, timeout, or non-zero
 * exit with no recoverable answer.
 */
export declare function runCodex(opts?: CodexExecOptions): Promise<string>;
