import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LLM_WORKDIR_BASENAME } from './paths.js';
import { classifyLlmError, EmptyLlmResponseError } from './llm-error-class.js';
import {
  runCodex,
  sanitizeProviderMessage,
  type CodexExecObservation,
  type CodexExecOptions,
  type CodexRequestRejectedError,
  type CodexTokenUsage,
} from './codex-exec.js';
import {
  activeModelConfigHold,
  finishModelAttempt,
  exhaustModelBudget,
  getModelWorkContext,
  ModelBudgetInputLimitError,
  ModelBudgetOutputLimitError,
  ModelBudgetOutputSchemaError,
  ModelConfigHeldError,
  recordModelConfigHold,
  touchModelConfigHold,
  reserveModelAttempt,
  settleConfigRejectedAttempt,
  withResolvedModelWorkContext,
  type ModelWorkContext,
  type ModelAttemptReservation,
} from './model-budget.js';
import { resolveLlmSelection } from './model-settings.js';

// Stable containment directory for LLM-side artifacts. CodexExec gives every
// call its own mkdtemp workdir and runs codex exec with --ephemeral +
// --ignore-user-config, so the child persists no session rollout and nothing
// accumulates here to prune.
const LLM_WORKDIR = path.join(os.tmpdir(), LLM_WORKDIR_BASENAME);
export function llmWorkdir(): string {
  try {
    fs.mkdirSync(LLM_WORKDIR, { recursive: true });
  } catch {
    /* fall through — caller cwd is an acceptable anchor */
  }
  return LLM_WORKDIR;
}


/** 재시도 횟수(= 총 시도 - 1). 0 이면 재시도 없음. 상한 5 — 무한 폭주 방지. */
function retryBudget(): number {
  const raw = process.env.MEMEX_LLM_RETRIES;
  if (raw != null && /^\d+$/.test(raw.trim())) return Math.min(5, parseInt(raw.trim(), 10));
  return 2; // 기본 총 3회 시도
}

/**
 * 지수 백오프(500ms → 1500ms …). 테스트는 MEMEX_LLM_RETRY_BASE_MS=0 으로 즉시.
 * base 와 결과 모두 상한을 둔다 — 오타 하나(예: 500000)로 워커가 사실상 정지하는
 * 것을 막기 위해서다 (Codex 리뷰 MEDIUM 2026-07-17).
 */
const MAX_BACKOFF_BASE_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
function backoffMs(attempt: number): number {
  const raw = process.env.MEMEX_LLM_RETRY_BASE_MS;
  const parsed = raw != null && /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : 500;
  const base = Math.min(parsed, MAX_BACKOFF_BASE_MS);
  return Math.min(base * Math.pow(3, attempt), MAX_BACKOFF_MS);
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

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

/**
 * One-shot LLM call through the local Codex CLI (CodexExec provider).
 * maxTokens kept for signature compatibility; the CLI manages its own budget.
 *
 * Issue #31: this function no longer resolves the model. `buildCodexExecArgs`
 * is the single interpretation point, so a per-call override is forwarded and
 * everything else (env, models.json, the core default) is decided there — the
 * callers that bypass this module entirely get the same answer.
 */
async function callOnce(
  systemPrompt: string,
  userMessage: string,
  _maxTokens: number,
  onObservation?: (observation: CodexExecObservation) => void,
  options: MemoryModelOptions = {},
  reservation?: ModelAttemptReservation,
): Promise<string> {
  const timeoutRaw = process.env.MEMEX_CODEX_EXEC_TIMEOUT_MS;
  const timeoutMs =
    timeoutRaw != null && /^\d+$/.test(timeoutRaw.trim()) ? parseInt(timeoutRaw.trim(), 10) : 180_000;
  return runCodex({
    systemPrompt,
    userMessage,
    model: options.model ?? null,
    ...('reasoningEffort' in options ? { reasoningEffort: options.reasoningEffort } : {}),
    timeoutMs,
    deadlineAt: reservation?.deadlineAt,
    maxInputChars: reservation?.maxInputChars,
    maxOutputChars: reservation?.maxOutputChars,
    onObservation,
    outputSchema: options.outputSchema,
  });
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

function matchesJsonSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    return anyOf.some((candidate) =>
      candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
      matchesJsonSchema(value, candidate as Record<string, unknown>));
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return false;
  }
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.some((key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(object, key))) {
        return false;
      }
      const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
        ? schema.properties as Record<string, unknown>
        : {};
      if (schema.additionalProperties === false && Object.keys(object).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) {
        return false;
      }
      return Object.entries(properties).every(([key, child]) =>
        !Object.prototype.hasOwnProperty.call(object, key) ||
        !child || typeof child !== 'object' || Array.isArray(child) ||
        matchesJsonSchema(object[key], child as Record<string, unknown>),
      );
    }
    case 'array':
      return Array.isArray(value) && (schema.items == null ||
        (typeof schema.items === 'object' && !Array.isArray(schema.items) &&
          (value as unknown[]).every((item) => matchesJsonSchema(item, schema.items as Record<string, unknown>))));
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function validateOutputSchema(text: string, schema: Record<string, unknown>): boolean {
  try {
    const value = JSON.parse(text);
    return matchesJsonSchema(value, schema);
  } catch {
    return false;
  }
}

function errorClassFor(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return String((error as { code: string }).code);
  }
  return 'unknown';
}

/**
 * Write the durable hold for the selection this call used, and one audit line.
 *
 * The provider's own sentence is the most useful thing a user can be shown
 * here ("the 'X' model is not supported when using Codex with a ChatGPT
 * account"), so it is stored — bounded and control-character stripped by
 * `sanitizeProviderMessage` before it ever reaches a row.
 */
function recordConfigHold(
  db: NonNullable<ModelWorkContext['db']>,
  selection: ReturnType<typeof resolveLlmSelection>,
  error: unknown,
  context: ModelWorkContext,
): void {
  const detail = (error as { detail?: CodexRequestRejectedError['detail'] })?.detail;
  const held = (error as { hold?: { status: number | null; providerType: string | null; providerMessage: string } })?.hold;
  recordModelConfigHold(db, {
    fingerprint: selection.fingerprint,
    model: selection.model,
    reasoningEffort: selection.reasoning,
    status: detail?.status ?? held?.status ?? null,
    providerType: detail?.providerType ?? held?.providerType ?? null,
    providerMessage:
      detail?.providerMessage ??
      held?.providerMessage ??
      (error instanceof Error ? sanitizeProviderMessage(error.message) : String(error)),
    stage: context.stage ?? null,
    jobId: context.jobId ?? null,
  });
  console.error(
    `callMemoryModel: model work held — the provider rejected the request envelope for ` +
      `model "${selection.model}"${selection.reasoning ? ` at reasoning effort "${selection.reasoning}"` : ''}. ` +
      'No job failed and no attempt was consumed. Fix the selection and it resumes automatically: memex models show',
  );
  // Audit is best-effort by construction: a missing log must not turn a held
  // call into a crashed one.
  void (async () => {
    try {
      const { appendUiAuditLine } = await import('./ontology-admin.js');
      appendUiAuditLine('models.llm.hold', {
        model: selection.model,
        reasoning: selection.reasoning,
        provider_status: detail?.status ?? held?.status ?? null,
        provider_type: detail?.providerType ?? held?.providerType ?? null,
        stage: context.stage ?? null,
        fingerprint_prefix: selection.fingerprint.slice(0, 12),
      });
    } catch {
      /* the hold itself is the durable record */
    }
  })();
}

function summarizeObservations(
  attempts: number,
  started: number,
  observations: CodexExecObservation[],
): MemoryModelObservation {
  const withUsage = observations.filter(
    (observation): observation is CodexExecObservation & { token_usage: CodexTokenUsage } =>
      observation.token_usage !== null,
  );
  const withCachedUsage = withUsage.filter(
    (observation) => observation.token_usage.cached_input_tokens !== undefined,
  );
  const status =
    withUsage.length === 0
      ? 'NOT_PROVEN'
      : withUsage.length === attempts && withCachedUsage.length === withUsage.length
        ? 'observed'
        : 'partial';
  return {
    attempts,
    total_latency_ms: performance.now() - started,
    token_usage:
      status === 'NOT_PROVEN'
        ? null
        : {
            input_tokens: withUsage.reduce(
              (sum, observation) => sum + observation.token_usage.input_tokens,
              0,
            ),
            output_tokens: withUsage.reduce(
              (sum, observation) => sum + observation.token_usage.output_tokens,
              0,
            ),
            ...(withCachedUsage.length === withUsage.length
              ? {
                cached_input_tokens: withUsage.reduce(
                    (sum, observation) =>
                      sum + (observation.token_usage.cached_input_tokens ?? 0),
                    0,
                  ),
                }
              : {}),
          },
    token_usage_status: status,
  };
}

/**
 * One LLM call through the local Codex CLI (CodexExec) — authenticated by the
 * user's local Codex login; no API key involved.
 *
 * 복구 계약 (2026-07-17 — 사용자 피드백 "에러나거나 0바이트인데 재시도·복구가 없다"):
 *  - **빈 응답('')도 실패**다. 모든 호출자가 JSON 을 요구하므로 빈 본문은 유효한 답이
 *    될 수 없는데, 예전엔 '' 를 반환해 호출자가 "정상적으로 아무것도 없음"으로 소비했다
 *    (consolidator 는 verdict 'none' 으로 확정+예산 소모, fact-extractor 는 배치를 조용히
 *    버리고 세션을 extraction_log 에 완료 기록 → 그 대화의 fact 영구 손실).
 *  - transient(빈 응답·429/5xx/네트워크/타임아웃)와 unknown 은 **유한 재시도**(기본 2회,
 *    지수 백오프)로 일회성 flake 를 흡수한다. 같은 파일 계열의 임베딩 경로는 이미
 *    probe+재시도로 flake 를 흡수하고 있었고(ontology-classifier), LLM 경로만 없었다.
 *  - deterministic(400/413/max_tokens 등 이 요청 자체가 잘못됨)은 **재시도하지 않는다** —
 *    같은 입력은 같은 결과이고 재시도는 예산 낭비다.
 *  - 재시도를 소진하면 '' 가 아니라 **throw** 한다. 그래야 호출자의 3분류(transient 는
 *    보류·재시도, deterministic 은 attempt 소모)가 비로소 작동한다 (fail-loud).
 * 호출자 계약: 성공 반환값은 **비어있지 않음이 보장**된다.
 */
async function callMemoryModelInternal(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
  options: MemoryModelOptions = {},
): Promise<ObservedMemoryModelResult> {
  const existingContext = getModelWorkContext();
  if (!existingContext?.db || !existingContext.budgetId) {
    return withResolvedModelWorkContext(
      options.modelContext ?? {},
      () => callMemoryModelInternal(systemPrompt, userMessage, maxTokens, options),
    );
  }

  const retries = retryBudget();
  let lastError: unknown;
  const observations: CodexExecObservation[] = [];
  const started = performance.now();
  const context = existingContext;
  const db = context.db!;
  const budgetId = context.budgetId!;
  const inputChars = (systemPrompt
    ? `${systemPrompt}\n\n---\n\n${userMessage}`
    : userMessage).length;

  // Issue #31 — the config-hold gate, placed BEFORE the first reservation.
  //
  // The fingerprint covers a per-call override, so an evaluation harness's
  // one-off model is gated on its own selection and cannot be blocked by (or
  // block) the default one. Past this point a held selection costs nothing at
  // all: no reservation, no provider call.
  const selection = resolveLlmSelection({
    model: options.model,
    ...('reasoningEffort' in options ? { reasoningEffort: options.reasoningEffort } : {}),
  });
  //
  // `bypassConfigHold` only skips the REFUSAL. Lifting the hold and releasing the
  // jobs behind it belongs to the probe, after it knows the call succeeded —
  // releasing here would free work on the strength of a call that may be about
  // to be refused again.
  if (!options.bypassConfigHold) {
    const hold = activeModelConfigHold(db, selection.fingerprint);
    if (hold) {
      touchModelConfigHold(db, selection.fingerprint);
      throw new ModelConfigHeldError(hold);
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const attemptStarted = performance.now();
    // Reservation is deliberately outside the provider catch. Exhaustion is
    // scheduling state, not a provider failure: it must hold the work item
    // pending and must never be converted into a dead/failed job by callers.
    const reservation = reserveModelAttempt(db, {
      budgetId,
      stage: context.stage ?? 'model',
      jobId: context.jobId ?? null,
      targetId: context.targetId ?? null,
      inputChars,
      model: selection.model,
      reasoningEffort: selection.reasoning,
    });
    let attemptObservation: CodexExecObservation | undefined;
    try {
      const text = await callOnce(
        systemPrompt,
        userMessage,
        maxTokens,
        (observation) => {
          attemptObservation = observation;
          observations.push(observation);
        },
        options,
        reservation,
      );
      if (!text || text.trim() === '') {
        throw new EmptyLlmResponseError(
          `LLM returned an empty response (attempt ${attempt + 1}/${retries + 1})`,
        );
      }
      if (text.length > reservation.maxOutputChars) {
        throw new ModelBudgetOutputLimitError(text.length, reservation.maxOutputChars);
      }
      if (options.outputSchema && !validateOutputSchema(text, options.outputSchema)) {
        throw new ModelBudgetOutputSchemaError();
      }
      finishModelAttempt(db, {
        attemptId: reservation.attemptId,
        state: 'completed',
        durationMs: attemptObservation?.duration_ms ?? performance.now() - attemptStarted,
        outputChars: text.length,
        tokenUsage: attemptObservation?.token_usage ?? null,
        tokenUsageStatus: attemptObservation?.token_usage ? 'observed' : 'NOT_PROVEN',
        model: attemptObservation?.model ?? null,
        ...(attemptObservation && 'reasoning_effort' in attemptObservation
          ? { reasoningEffort: attemptObservation.reasoning_effort }
          : {}),
      });
      return {
        text,
        observation: summarizeObservations(
          attempt + 1,
          started,
          observations,
        ),
      };
    } catch (error) {
      const localDeterministic =
        error instanceof ModelBudgetOutputLimitError ||
        error instanceof ModelBudgetOutputSchemaError ||
        error instanceof ModelBudgetInputLimitError;
      const errorClass = classifyLlmError(error);
      if (errorClass === 'config') {
        // Issue #31: the provider refused the ENVELOPE, so this reservation
        // bought nothing. Keep the row as evidence, return the reservation to
        // the budget (and lift the exhaustion it may have caused), and record
        // the hold so the next call does not pay for the same mistake.
        settleConfigRejectedAttempt(db, {
          attemptId: reservation.attemptId,
          durationMs: attemptObservation?.duration_ms ?? performance.now() - attemptStarted,
          errorClass: errorClassFor(error),
        });
        recordConfigHold(db, selection, error, context);
      } else {
        finishModelAttempt(db, {
          attemptId: reservation.attemptId,
          state: localDeterministic ? 'failed' : 'unknown',
          durationMs: attemptObservation?.duration_ms ?? performance.now() - attemptStarted,
          outputChars: attemptObservation ? undefined : null,
          tokenUsage: attemptObservation?.token_usage ?? null,
          tokenUsageStatus: attemptObservation?.token_usage ? 'observed' : 'NOT_PROVEN',
          errorClass: errorClassFor(error),
          model: attemptObservation?.model ?? null,
        });
      }
      lastError = error;
      // This request cannot succeed by retrying: local output/input/schema
      // bounds, recognized deterministic provider rejections, and a rejected
      // request envelope all stop here. Retrying a 'config' error would just
      // buy three identical refusals per call.
      if (localDeterministic || errorClass === 'deterministic' || errorClass === 'config') {
        throw error;
      }
    }
    if (attempt < retries) {
      const remaining = reservation.deadlineAt
        ? Math.max(0, Date.parse(reservation.deadlineAt) - Date.now())
        : null;
      const backoff = backoffMs(attempt);
      if (remaining !== null && remaining <= backoff) {
        throw exhaustModelBudget(db, {
          budgetId: reservation.budgetId,
          reason: 'deadline',
        });
      }
      console.error(
        `callMemoryModel: attempt ${attempt + 1}/${retries + 1} failed (${lastError instanceof Error ? lastError.message : lastError}) — retrying`,
      );
      await sleep(backoff);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function callMemoryModelObserved(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
  options: MemoryModelOptions = {},
): Promise<ObservedMemoryModelResult> {
  return callMemoryModelInternal(systemPrompt, userMessage, maxTokens, options);
}

export async function callMemoryModel(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
  options: MemoryModelOptions = {},
): Promise<string> {
  return (await callMemoryModelInternal(systemPrompt, userMessage, maxTokens, options)).text;
}

export function parseJsonResponse<T>(text: string): T | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
    || text.match(/(\[[\s\S]*\])/)
    || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error('parseJsonResponse: no JSON found in LLM response:', text.substring(0, 200));
    return null;
  }

  try {
    return JSON.parse(jsonMatch[1]) as T;
  } catch (e) {
    console.error('parseJsonResponse: invalid JSON:', (e as Error).message, jsonMatch[1].substring(0, 200));
    return null;
  }
}
