import type Database from "better-sqlite3";
import { type CodexTurnError } from "./codex-exec.js";
import { type ReasoningEffort } from "./model-settings.js";
export declare const MODEL_PROBE_STAGE = "model_probe";
/** One wave per probe — see the header note on budget inheritance. */
export declare const MODEL_PROBE_WAVE_PREFIX = "model-probe";
export interface ModelProbeResult {
    ok: boolean;
    model: string;
    reasoning: ReasoningEffort | null;
    latencyMs: number;
    answer: string | null;
    /** Present when the provider refused the request envelope. */
    rejection: CodexTurnError | null;
    /** Present for any other failure (outage, timeout, budget). */
    error: string | null;
    /** The LLM error class, so a caller can tell a bad setting from an outage. */
    errorClass: "transient" | "deterministic" | "unknown" | "config" | null;
    /** Set when this probe lifted at least one hold. */
    clearedHold: {
        fingerprint: string;
        clearedHolds: number;
        releasedJobs: number;
    } | null;
}
export declare function probeModel(db: Database.Database, opts: {
    model: string;
    reasoning?: string | null;
    timeoutMs?: number;
}): Promise<ModelProbeResult>;
