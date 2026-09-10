/**
 * "Try this model once" (#31 §3.4).
 *
 * A model id cannot be validated any other way. Measured: a bogus id and a bogus
 * reasoning level both come back as exit 0 with an empty body and a 400 inside
 * the JSONL stream, so the catalog can only say what it last knew — one real
 * call is the only proof.
 *
 * Three things make this the right shape:
 *  - it goes THROUGH the model budget (`stage: 'model_probe'`), so a probe is
 *    one honest row in the ledger rather than an untracked provider call. The
 *    stage name deliberately avoids the three literals the derived-backlog SQL
 *    matches on (`ontology`, `consolidation`, `relation`);
 *  - it is the ONLY caller that passes an active config hold. Otherwise a user
 *    could never verify a fix — the hold would refuse the very call that proves
 *    it should be lifted;
 *  - a successful probe clears the hold for that selection AND releases the jobs
 *    held on it, so "test" is also the repair.
 */
import type Database from "better-sqlite3";
import { type CodexTurnError } from "./codex-exec.js";
import { type ReasoningEffort } from "./model-settings.js";
export declare const MODEL_PROBE_STAGE = "model_probe";
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
