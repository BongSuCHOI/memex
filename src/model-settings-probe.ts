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
import { sanitizeProviderMessage, type CodexTurnError } from "./codex-exec.js";
import { classifyLlmError } from "./llm-error-class.js";
import { callMemoryModelObserved } from "./llm.js";
import {
  clearModelConfigHoldsForSelection,
  releaseHeldJobs,
  withResolvedModelWorkContext,
  type ModelConfigHold,
} from "./model-budget.js";
import { appendUiAuditLine } from "./ontology-admin.js";
import {
  llmSelectionFingerprint,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "./model-settings.js";

/** Fixed, tiny, and schema-free: the probe proves reachability, not quality. */
const PROBE_SYSTEM_PROMPT = "Answer with exactly the requested token and nothing else.";
const PROBE_USER_MESSAGE = "Reply with exactly: MEMEX_OK";
const PROBE_EXPECTED = "MEMEX_OK";
const PROBE_MAX_OUTPUT_CHARS = 64;
/** A settings screen must not hang for the full 180s provider timeout. */
const PROBE_DEFAULT_TIMEOUT_MS = 60_000;

export const MODEL_PROBE_STAGE = "model_probe";

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
  clearedHold: { fingerprint: string; clearedHolds: number; releasedJobs: number } | null;
}

export async function probeModel(
  db: Database.Database,
  opts: { model: string; reasoning?: string | null; timeoutMs?: number },
): Promise<ModelProbeResult> {
  const model = opts.model.trim();
  const reasoning = opts.reasoning == null ? null : normalizeReasoningEffort(opts.reasoning);
  const fingerprint = llmSelectionFingerprint({ model, reasoningEffort: reasoning });
  const started = Date.now();

  const previousTimeout = process.env.MEMEX_CODEX_EXEC_TIMEOUT_MS;
  process.env.MEMEX_CODEX_EXEC_TIMEOUT_MS = String(opts.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS);
  try {
    const result = await withResolvedModelWorkContext(
      { db, stage: MODEL_PROBE_STAGE, parentWaveId: "model-probe" },
      () =>
        callMemoryModelObserved(PROBE_SYSTEM_PROMPT, PROBE_USER_MESSAGE, 64, {
          model,
          reasoningEffort: reasoning,
          // The one legitimate bypass: this call exists to test a fix.
          bypassConfigHold: true,
        }),
    );
    const answer = result.text.trim().slice(0, PROBE_MAX_OUTPUT_CHARS);
    // The probe succeeded as soon as the provider ACCEPTED the envelope and
    // answered. An imperfect answer is a model-quality observation, not a
    // configuration failure, so it does not keep work paused.
    // Match on the SELECTION, not the fingerprint: the probe's own selection is
    // `explicit`, while the hold it is meant to lift was recorded under `env` or
    // `file`. Fingerprint scoping is what keeps background lookups from
    // interfering; a deliberate repair is exactly the case that should cross it.
    const cleared = clearModelConfigHoldsForSelection(db, { model, reasoningEffort: reasoning }, "probe-ok");
    const releasedJobs = cleared > 0 ? releaseHeldJobs(db, "model_config_rejected") : 0;
    auditProbe({ model, reasoning, ok: true, latencyMs: Date.now() - started, rejectionType: null });
    return {
      ok: true,
      model,
      reasoning,
      latencyMs: Date.now() - started,
      answer: answer.includes(PROBE_EXPECTED) ? PROBE_EXPECTED : answer,
      rejection: null,
      error: null,
      errorClass: null,
      clearedHold: cleared > 0 ? { fingerprint, clearedHolds: cleared, releasedJobs } : null,
    };
  } catch (error) {
    const errorClass = classifyLlmError(error);
    const detail = (error as { detail?: {
      status: number | null; providerType: string | null; providerMessage: string;
    } })?.detail;
    const hold = (error as { hold?: ModelConfigHold })?.hold;
    const rejection: CodexTurnError | null =
      errorClass === "config"
        ? {
            message: detail?.providerMessage ?? hold?.providerMessage ??
              (error instanceof Error ? sanitizeProviderMessage(error.message) : String(error)),
            status: detail?.status ?? hold?.status ?? null,
            type: detail?.providerType ?? hold?.providerType ?? null,
          }
        : null;
    auditProbe({
      model, reasoning, ok: false, latencyMs: Date.now() - started,
      rejectionType: rejection?.type ?? errorClass,
    });
    return {
      ok: false,
      model,
      reasoning,
      latencyMs: Date.now() - started,
      answer: null,
      rejection,
      error: error instanceof Error ? error.message : String(error),
      errorClass,
      clearedHold: null,
    };
  } finally {
    if (previousTimeout === undefined) delete process.env.MEMEX_CODEX_EXEC_TIMEOUT_MS;
    else process.env.MEMEX_CODEX_EXEC_TIMEOUT_MS = previousTimeout;
  }
}

/** Metadata only — never the probe's answer text. Best-effort by construction. */
function auditProbe(input: {
  model: string;
  reasoning: string | null;
  ok: boolean;
  latencyMs: number;
  rejectionType: string | null;
}): void {
  try {
    appendUiAuditLine("models.llm.probe", {
      model: input.model,
      reasoning: input.reasoning,
      ok: input.ok,
      latency_ms: input.latencyMs,
      rejection_type: input.rejectionType,
    });
  } catch {
    /* the attempt ledger is the durable record */
  }
}
