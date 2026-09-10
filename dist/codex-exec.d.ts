/** Set to '1' inside any codex exec child we spawn. Nested calls refuse. */
export declare const INNER_GUARD_ENV = "MEMEX_CODEX_EXEC_INNER";
/**
 * Official default memory-model id used when no override is provided.
 *
 * The constant itself lives in `./model-settings.ts` so the resolver chain has
 * exactly one bottom; this name is kept for existing callers and tests.
 * Duplicated as a literal rather than imported for the reason explained at
 * `loadSelectionResolvers` below: this module must stay loadable from source.
 */
export declare const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
export interface CodexExecOptions {
    systemPrompt?: string;
    userMessage?: string;
    timeoutMs?: number;
    codexBin?: string;
    /** Explicit model override; when absent, MEMEX_CODEX_MODEL then
     *  models.json then DEFAULT_CODEX_MODEL applies. */
    model?: string | null;
    /** Explicit reasoning effort; when absent, MEMEX_CODEX_REASONING then
     *  models.json then "no flag at all" applies. */
    reasoningEffort?: string | null;
    /** Opt-in native response structure; callers still validate domain semantics. */
    outputSchema?: Record<string, unknown>;
    /** Durable model-work input bound, measured in UTF-16 code units. */
    maxInputChars?: number;
    /** Durable model-work final-answer bound, measured in UTF-16 code units. */
    maxOutputChars?: number;
    /** Absolute ISO deadline inherited from the durable model-work budget. */
    deadlineAt?: string | null;
    /** Explicit compatibility escape hatch for providers that exit non-zero
     * after writing a complete answer. Normal memory work leaves this false. */
    allowOutputOnNonzero?: boolean;
    /** Best-effort provider telemetry. Failure to observe never fails the call. */
    onObservation?: (observation: CodexExecObservation) => void;
}
export interface CodexTokenUsage {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
}
export interface CodexExecObservation {
    duration_ms: number;
    token_usage: CodexTokenUsage | null;
    /** The model id this call ACTUALLY forwarded (#31 §5): the attempt ledger
     *  records the intention at reservation and this value at completion.
     *  Optional so existing provider stubs stay valid. */
    model?: string;
    reasoning_effort?: string | null;
}
/**
 * A provider rejection of the request ENVELOPE — the model id or the reasoning
 * level, not the content. Measured 2026-09-11: codex-cli answers such a request
 * with exit 0, an EMPTY `-o` file, and a 400 inside the `--json` stream, which
 * is indistinguishable from "the model said nothing" unless the stream is read.
 *
 * This is its own error class because no consumer should treat it like a bad
 * request: the conversation did nothing wrong, so its extraction must not be
 * split, failed, parked, or dead-lettered. See llm-error-class's `'config'`.
 */
export declare class CodexRequestRejectedError extends Error {
    readonly name = "CodexRequestRejectedError";
    readonly code = "MEMEX_MODEL_CONFIG";
    readonly detail: {
        status: number | null;
        providerType: string | null;
        providerMessage: string;
        model: string;
        reasoningEffort: string | null;
    };
    constructor(detail: CodexRequestRejectedError['detail']);
}
/** Design-document name for the class above; both refer to one identity. */
export { CodexRequestRejectedError as MemexModelConfigError };
/**
 * The turn failed and the CLI still exited 0 with no final message.
 *
 * Measured: the Codex CLI reports a provider rejection inside the JSONL stream
 * and exits 0, so WITHOUT this class the only thing left to return was `''` —
 * which `llm.ts` turns into `EmptyLlmResponseError`, i.e. 'transient'. That is
 * the wrong verdict for the whole deterministic family: an input-too-large 400
 * must stay 'deterministic' so the extractor halves its window and recovers the
 * conversation instead of retrying the identical oversized request three times
 * and then holding it forever (design §3.2).
 *
 * It is deliberately NOT `CodexRequestRejectedError`: the envelope predicate
 * stays narrow, and everything it refuses is classified from the provider's own
 * status and sentence by `classifyLlmError`, which is the single classifier.
 */
export declare class CodexTurnFailedError extends Error {
    readonly name = "CodexTurnFailedError";
    /** Read by `extractStatus` in llm-error-class, so 400/413/429/5xx decide. */
    readonly status: number | null;
    readonly providerType: string | null;
    constructor(turnError: CodexTurnError);
}
export interface CodexTurnError {
    message: string;
    status: number | null;
    type: string | null;
}
export declare function buildCodexPrompt(systemPrompt: string, userMessage: string): string;
export declare function loadSelectionResolvers(): Promise<void>;
/** Resolved selection this process would use right now, for the arg builder and
 *  for the attempt ledger's "what did we actually send" record. */
export declare function resolveCodexSelection(opts?: {
    model?: string | null;
    reasoningEffort?: string | null;
}): Promise<{
    model: string;
    reasoningEffort: string | null;
}>;
/** Pure arg builder — unit-tested without spawning anything. */
export declare function buildCodexExecArgs(opts: {
    model?: string | null;
    reasoningEffort?: string | null;
    workdir: string;
    outputLast?: string;
    outputSchemaPath?: string;
}): string[];
/**
 * Pull the provider's turn-level failure out of a `--json` stream.
 *
 * Measured shapes: `{"type":"error","message":"<provider body>"}` followed by
 * `{"type":"turn.failed","error":{...}}`. The status and the error type live
 * INSIDE the message text (the CLI passes the provider body through), so they
 * are sniffed rather than read from a field. Last failure wins.
 */
export declare function turnErrorFromEvents(stdout: string): CodexTurnError | null;
export declare function isEnvelopeRejection(error: CodexTurnError | null): boolean;
/** Strip control characters and bound the provider's own sentence before it
 *  reaches a durable row or a terminal line. */
export declare function sanitizeProviderMessage(message: string, limit?: number): string;
/** Pull the last agent answer out of --json JSONL events (fallback path). */
export declare function lastAgentMessageFromEvents(stdout: string): string;
/** Read the final Codex `turn.completed` token counters from a JSONL stream. */
export declare function tokenUsageFromEvents(stdout: string): CodexTokenUsage | null;
/**
 * One-shot LLM call through the local codex CLI.
 * Returns the final agent message (non-empty guaranteed by callers' retry
 * policy in llm.ts callMemoryModel). Throws on spawn failure, timeout, or non-zero
 * exit with no recoverable answer.
 */
export declare function runCodex(opts?: CodexExecOptions): Promise<string>;
