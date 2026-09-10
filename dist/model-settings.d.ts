/** Schema version of `models.json`. Anything else is ignored wholesale. */
export declare const MODEL_SETTINGS_VERSION = 1;
/**
 * Core default memory model. This constant lives here rather than in
 * `codex-exec.ts` so the resolver chain has one bottom, and `codex-exec.ts`
 * re-exports it as `DEFAULT_CODEX_MODEL` for its existing callers.
 */
export declare const DEFAULT_LLM_MODEL = "gpt-5.6-luna";
/**
 * Reasoning levels the provider accepts. Measured 2026-09-11 from a rejected
 * request's own 400 body: `none, minimal, low, medium, high, xhigh, max`.
 * `ultra` is offered by at least one catalog entry (`gpt-6-astra`), so the
 * union is the server list plus `ultra`. A model's OWN allowed subset comes
 * from the catalog (`codex-catalog.ts`) — this is only the outer bound.
 */
export declare const ALLOWED_REASONING_EFFORTS: readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export type ReasoningEffort = (typeof ALLOWED_REASONING_EFFORTS)[number];
export declare const LLM_MODEL_ENV = "MEMEX_CODEX_MODEL";
export declare const LLM_REASONING_ENV = "MEMEX_CODEX_REASONING";
export interface ModelSettings {
    version: number;
    updatedAt: string | null;
    llm: {
        model: string | null;
        reasoning: ReasoningEffort | null;
        /** Reserved for per-stage profiles (§16 Q1). Non-empty earns one warning. */
        stages: Record<string, never>;
    };
    /** 0.7.1 only. 0.7.0 neither reads nor writes these values. */
    embedding: {
        desiredModel: string | null;
        desiredDims: number | null;
        desiredProtocol: 'e5' | 'plain' | null;
    };
}
export interface ModelSettingsPatch {
    llm?: {
        model?: string | null;
        reasoning?: ReasoningEffort | null;
        stages?: Record<string, never>;
    };
    embedding?: {
        desiredModel?: string | null;
        desiredDims?: number | null;
        desiredProtocol?: 'e5' | 'plain' | null;
    };
}
export type SettingSource = 'env' | 'file' | 'default' | 'explicit';
export interface ResolvedSetting<T> {
    value: T;
    source: SettingSource;
}
export interface LlmSelectionOverride {
    /** Per-call model override (wins over env). */
    model?: string | null;
    /** Per-call reasoning override. `null` means "explicitly no flag". */
    reasoningEffort?: string | null;
}
export interface LlmSelection {
    model: string;
    reasoning: ReasoningEffort | null;
    modelSource: SettingSource;
    reasoningSource: SettingSource;
    /** sha256 of the resolved values AND their sources — see below. */
    fingerprint: string;
}
export declare function defaultModelSettings(): ModelSettings;
/** `<data root>/models.json`. Never inside `<data root>/models/` — that tree is
 *  a weights cache a cleanup tool may delete wholesale. */
export declare function modelSettingsPath(): string;
/**
 * A model id is checked for SHAPE only — non-empty, no control characters, at
 * most 256 chars, `[\w./:@+-]+`. Real availability is proven by exactly one
 * thing: a test call (measured — a bogus id returns exit 0 with an empty body
 * and a 400 inside the JSONL stream).
 */
export declare function isValidModelId(id: unknown): id is string;
export declare function isReasoningEffort(value: unknown): value is ReasoningEffort;
/** `null` for anything this build does not accept — callers decide whether that
 *  is a refusal (settings write) or a silent fall-through (env read). */
export declare function normalizeReasoningEffort(raw: unknown): ReasoningEffort | null;
/** Drop the in-process memo. Called by every write here; exported because the
 *  CLI/UI write path wants the next read in the same process to be fresh. */
export declare function invalidateModelSettingsCache(): void;
/**
 * Always succeeds. A missing/corrupt/unsupported file is "nothing was chosen".
 */
export declare function readModelSettings(options?: {
    now?: number;
}): ModelSettings;
/**
 * Merge `patch` into the file and write it atomically (`tmp` + `rename`, mode
 * 0o600 — the `writeSyncConfig()` precedent). Keys this build does not know are
 * carried through untouched.
 *
 * Throws on an invalid value: a settings write is the one place where refusing
 * is better than silently normalizing (§3.3).
 */
export declare function writeModelSettings(patch: ModelSettingsPatch, now?: Date): ModelSettings;
/** `models reset` — delete the file. Every value returns to the core default.
 *  The 0.7.1 embedding identity lives in the DB and is NOT affected. */
export declare function resetModelSettings(): ModelSettings;
export declare function resolveLlmModel(options?: {
    now?: number;
}): ResolvedSetting<string>;
export declare function resolveReasoningEffort(options?: {
    now?: number;
}): ResolvedSetting<ReasoningEffort | null>;
/**
 * The resolved selection plus its provenance.
 *
 * A per-call override (`options.model` / `options.reasoningEffort` on a model
 * call) is part of the selection: v2 of this design computed the hold
 * fingerprint from the DEFAULT resolution only, so an override's rejection was
 * recorded against — and blocked — a selection it never used.
 */
export declare function resolveLlmSelection(overrides?: LlmSelectionOverride, options?: {
    now?: number;
}): LlmSelection;
/**
 * Comparison key for a config hold.
 *
 * The SOURCE is part of it on purpose: moving the same id from `models.json` to
 * `MEMEX_CODEX_MODEL` is a user action that deserves a fresh attempt, and an env
 * change is as much a "the user fixed it" signal as a file edit. A new
 * fingerprint means no active hold row matches, so work resumes with no
 * explicit clear — and, because each process only ever touches its OWN
 * fingerprint's row, two processes with different env can never delete each
 * other's hold (2nd review (b)5).
 */
export declare function llmSelectionFingerprint(overrides?: LlmSelectionOverride, options?: {
    now?: number;
}): string;
