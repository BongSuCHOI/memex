/**
 * `<data root>/models.json` — the user's LOCAL model selection (#31, 0.7.0).
 *
 * Three rules define this module and nothing else belongs in it:
 *
 *  1. **env always wins.** `MEMEX_CODEX_MODEL` / `MEMEX_CODEX_REASONING` are the
 *     host/shell/CI contract. The settings file is wedged BETWEEN env and the
 *     core default, never above env.
 *  2. **local only.** `models.json` has the same grade as `sync/config.json`: it
 *     never enters a sync generation, because the set of usable models differs
 *     per machine.
 *  3. **the file is a proposal, never effective state.** A missing, unreadable
 *     or unsupported-`version` file means "the user chose nothing" — core
 *     defaults apply and the file is LEFT ALONE (never repaired, never
 *     overwritten). The same fail-closed contract `readSyncConfig()` has.
 *
 * Dependencies are node builtins + `./paths.js` only, deliberately: this module
 * must stay loadable on a host with no runtime closure (doctor and `deps warm`
 * have to answer there), and `model-cache.ts` will import it in 0.7.1. That
 * also means **no audit-log call here** — auditing happens in the verb layer
 * (`models-cli.ts`, `model-settings-probe.ts`).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getModelSettingsPath } from './paths.js';

/** Schema version of `models.json`. Anything else is ignored wholesale. */
export const MODEL_SETTINGS_VERSION = 1;

/**
 * Core default memory model. This constant lives here rather than in
 * `codex-exec.ts` so the resolver chain has one bottom, and `codex-exec.ts`
 * re-exports it as `DEFAULT_CODEX_MODEL` for its existing callers.
 */
export const DEFAULT_LLM_MODEL = 'gpt-5.6-luna';

/**
 * Reasoning levels the provider accepts. Measured 2026-09-11 from a rejected
 * request's own 400 body: `none, minimal, low, medium, high, xhigh, max`.
 * `ultra` is offered by at least one catalog entry (`gpt-6-astra`), so the
 * union is the server list plus `ultra`. A model's OWN allowed subset comes
 * from the catalog (`codex-catalog.ts`) — this is only the outer bound.
 */
export const ALLOWED_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ReasoningEffort = (typeof ALLOWED_REASONING_EFFORTS)[number];

export const LLM_MODEL_ENV = 'MEMEX_CODEX_MODEL';
export const LLM_REASONING_ENV = 'MEMEX_CODEX_REASONING';

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

export function defaultModelSettings(): ModelSettings {
  return {
    version: MODEL_SETTINGS_VERSION,
    updatedAt: null,
    llm: { model: null, reasoning: null, stages: {} },
    embedding: { desiredModel: null, desiredDims: null, desiredProtocol: null },
  };
}

/** `<data root>/models.json`. Never inside `<data root>/models/` — that tree is
 *  a weights cache a cleanup tool may delete wholesale. */
export function modelSettingsPath(): string {
  return getModelSettingsPath();
}

/**
 * A model id is checked for SHAPE only — non-empty, no control characters, at
 * most 256 chars, `[\w./:@+-]+`. Real availability is proven by exactly one
 * thing: a test call (measured — a bogus id returns exit 0 with an empty body
 * and a 400 inside the JSONL stream).
 */
export function isValidModelId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 256) return false;
  return /^[\w./:@+-]+$/.test(trimmed);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' &&
    (ALLOWED_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** `null` for anything this build does not accept — callers decide whether that
 *  is a refusal (settings write) or a silent fall-through (env read). */
export function normalizeReasoningEffort(raw: unknown): ReasoningEffort | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return isReasoningEffort(trimmed) ? trimmed : null;
}

interface SettingsMemo {
  path: string;
  stamp: string;
  revalidatedAt: number;
  value: ModelSettings;
  /** Raw parsed object, so a write preserves keys this build does not know. */
  raw: Record<string, unknown> | null;
}

/**
 * Hot reload is the whole point of the memo (§6): long-lived processes (the MCP
 * server and the inject daemon) must see a new LLM selection on their NEXT
 * model call without a restart, while a model call must not cost more than one
 * `stat`. So: cache keyed on `(path, mtimeMs, size)`, revalidated at most once
 * per second.
 */
const REVALIDATE_MS = 1000;
let memo: SettingsMemo | null = null;

/** Drop the in-process memo. Called by every write here; exported because the
 *  CLI/UI write path wants the next read in the same process to be fresh. */
export function invalidateModelSettingsCache(): void {
  memo = null;
}

function statStamp(target: string): string {
  try {
    const stat = fs.statSync(target);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

let warnedUnsupportedVersion = false;
let warnedStages = false;
let warnedEnvReasoning: string | null = null;

function parseSettings(raw: unknown): { value: ModelSettings; raw: Record<string, unknown> | null } {
  const fallback = { value: defaultModelSettings(), raw: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const object = raw as Record<string, unknown>;
  if (object.version !== MODEL_SETTINGS_VERSION) {
    // Ignore the whole file, keep it on disk untouched, say so once.
    if (!warnedUnsupportedVersion) {
      warnedUnsupportedVersion = true;
      console.error(
        `[memex] ${modelSettingsPath()}: unsupported version ${String(object.version)} ` +
          `(this build understands ${MODEL_SETTINGS_VERSION}) — using core defaults; the file is left unchanged`,
      );
    }
    return fallback;
  }
  const llmRaw = object.llm && typeof object.llm === 'object' && !Array.isArray(object.llm)
    ? (object.llm as Record<string, unknown>)
    : {};
  const embeddingRaw =
    object.embedding && typeof object.embedding === 'object' && !Array.isArray(object.embedding)
      ? (object.embedding as Record<string, unknown>)
      : {};
  const stagesRaw = llmRaw.stages && typeof llmRaw.stages === 'object' && !Array.isArray(llmRaw.stages)
    ? (llmRaw.stages as Record<string, unknown>)
    : {};
  if (Object.keys(stagesRaw).length > 0 && !warnedStages) {
    warnedStages = true;
    console.error(
      `[memex] ${modelSettingsPath()}: llm.stages is reserved and ignored in this release`,
    );
  }
  const dims = typeof embeddingRaw.desired_dims === 'number' &&
    Number.isSafeInteger(embeddingRaw.desired_dims) &&
    embeddingRaw.desired_dims > 0
    ? embeddingRaw.desired_dims
    : null;
  const protocol = embeddingRaw.desired_protocol === 'e5' || embeddingRaw.desired_protocol === 'plain'
    ? embeddingRaw.desired_protocol
    : null;
  return {
    value: {
      version: MODEL_SETTINGS_VERSION,
      updatedAt: typeof object.updated_at === 'string' ? object.updated_at : null,
      llm: {
        model: isValidModelId(llmRaw.model) ? String(llmRaw.model).trim() : null,
        reasoning: normalizeReasoningEffort(llmRaw.reasoning),
        stages: {},
      },
      embedding: {
        desiredModel: typeof embeddingRaw.desired_model === 'string' && embeddingRaw.desired_model.trim()
          ? embeddingRaw.desired_model.trim()
          : null,
        desiredDims: dims,
        desiredProtocol: protocol,
      },
    },
    raw: object,
  };
}

/**
 * Always succeeds. A missing/corrupt/unsupported file is "nothing was chosen".
 */
export function readModelSettings(options?: { now?: number }): ModelSettings {
  const target = modelSettingsPath();
  const now = options?.now ?? Date.now();
  if (memo && memo.path === target && now - memo.revalidatedAt < REVALIDATE_MS) {
    return memo.value;
  }
  const stamp = statStamp(target);
  if (memo && memo.path === target && memo.stamp === stamp) {
    memo.revalidatedAt = now;
    return memo.value;
  }
  let parsed: { value: ModelSettings; raw: Record<string, unknown> | null };
  if (stamp === 'absent') {
    parsed = { value: defaultModelSettings(), raw: null };
  } else {
    try {
      parsed = parseSettings(JSON.parse(fs.readFileSync(target, 'utf8')));
    } catch {
      parsed = { value: defaultModelSettings(), raw: null };
    }
  }
  memo = { path: target, stamp, revalidatedAt: now, value: parsed.value, raw: parsed.raw };
  return parsed.value;
}

/** The raw on-disk object, so unknown keys survive a write (forward compat). */
function readRawSettings(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(modelSettingsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    /* absent or corrupt: start from an empty document */
  }
  return {};
}

/**
 * Merge `patch` into the file and write it atomically (`tmp` + `rename`, mode
 * 0o600 — the `writeSyncConfig()` precedent). Keys this build does not know are
 * carried through untouched.
 *
 * Throws on an invalid value: a settings write is the one place where refusing
 * is better than silently normalizing (§3.3).
 */
export function writeModelSettings(patch: ModelSettingsPatch, now = new Date()): ModelSettings {
  const raw = readRawSettings();
  const rawUnsupported = raw.version !== undefined && raw.version !== MODEL_SETTINGS_VERSION;
  const llmRaw = raw.llm && typeof raw.llm === 'object' && !Array.isArray(raw.llm) && !rawUnsupported
    ? { ...(raw.llm as Record<string, unknown>) }
    : {};
  const embeddingRaw =
    raw.embedding && typeof raw.embedding === 'object' && !Array.isArray(raw.embedding) && !rawUnsupported
      ? { ...(raw.embedding as Record<string, unknown>) }
      : {};

  if (patch.llm && 'model' in patch.llm) {
    const model = patch.llm.model;
    if (model === null || model === undefined) {
      llmRaw.model = null;
    } else {
      if (!isValidModelId(model)) {
        throw new Error(
          `invalid model id ${JSON.stringify(String(model))} — expected 1-256 characters matching [\\w./:@+-]`,
        );
      }
      llmRaw.model = model.trim();
    }
  }
  if (patch.llm && 'reasoning' in patch.llm) {
    const reasoning = patch.llm.reasoning;
    if (reasoning === null || reasoning === undefined) {
      llmRaw.reasoning = null;
    } else {
      const normalized = normalizeReasoningEffort(reasoning);
      if (!normalized) {
        throw new Error(
          `invalid reasoning effort ${JSON.stringify(String(reasoning))} — expected one of ${ALLOWED_REASONING_EFFORTS.join(', ')}`,
        );
      }
      llmRaw.reasoning = normalized;
    }
  }
  if (patch.embedding && 'desiredModel' in patch.embedding) {
    embeddingRaw.desired_model = patch.embedding.desiredModel ?? null;
  }
  if (patch.embedding && 'desiredDims' in patch.embedding) {
    embeddingRaw.desired_dims = patch.embedding.desiredDims ?? null;
  }
  if (patch.embedding && 'desiredProtocol' in patch.embedding) {
    embeddingRaw.desired_protocol = patch.embedding.desiredProtocol ?? null;
  }

  const document: Record<string, unknown> = {
    ...(rawUnsupported ? {} : raw),
    version: MODEL_SETTINGS_VERSION,
    updated_at: now.toISOString(),
    llm: llmRaw,
    ...(Object.keys(embeddingRaw).length > 0 ? { embedding: embeddingRaw } : {}),
  };

  const target = modelSettingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw error;
  }
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* a filesystem without POSIX modes is not a failure */
  }
  invalidateModelSettingsCache();
  return readModelSettings();
}

/** `models reset` — delete the file. Every value returns to the core default.
 *  The 0.7.1 embedding identity lives in the DB and is NOT affected. */
export function resetModelSettings(): ModelSettings {
  try {
    fs.rmSync(modelSettingsPath(), { force: true });
  } catch {
    /* nothing to remove is the same outcome */
  }
  invalidateModelSettingsCache();
  return readModelSettings();
}

function envModel(): string | null {
  const raw = process.env[LLM_MODEL_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function envReasoning(): ReasoningEffort | null {
  const raw = process.env[LLM_REASONING_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const normalized = normalizeReasoningEffort(raw);
  if (!normalized) {
    // An unusable env value must not silently become "the user chose nothing
    // AND we said nothing" — warn once, then fall through to the file layer.
    if (warnedEnvReasoning !== raw) {
      warnedEnvReasoning = raw;
      console.error(
        `[memex] ${LLM_REASONING_ENV}=${raw} is not one of ${ALLOWED_REASONING_EFFORTS.join(', ')} — ignored`,
      );
    }
    return null;
  }
  return normalized;
}

export function resolveLlmModel(options?: { now?: number }): ResolvedSetting<string> {
  const fromEnv = envModel();
  if (fromEnv) return { value: fromEnv, source: 'env' };
  const fromFile = readModelSettings(options).llm.model;
  if (fromFile) return { value: fromFile, source: 'file' };
  return { value: DEFAULT_LLM_MODEL, source: 'default' };
}

export function resolveReasoningEffort(
  options?: { now?: number },
): ResolvedSetting<ReasoningEffort | null> {
  const fromEnv = envReasoning();
  if (fromEnv) return { value: fromEnv, source: 'env' };
  const fromFile = readModelSettings(options).llm.reasoning;
  if (fromFile) return { value: fromFile, source: 'file' };
  return { value: null, source: 'default' };
}

/**
 * The resolved selection plus its provenance.
 *
 * A per-call override (`options.model` / `options.reasoningEffort` on a model
 * call) is part of the selection: v2 of this design computed the hold
 * fingerprint from the DEFAULT resolution only, so an override's rejection was
 * recorded against — and blocked — a selection it never used.
 */
export function resolveLlmSelection(
  overrides?: LlmSelectionOverride,
  options?: { now?: number },
): LlmSelection {
  let model: string;
  let modelSource: SettingSource;
  const overrideModel = typeof overrides?.model === 'string' ? overrides.model.trim() : '';
  if (overrideModel) {
    model = overrideModel;
    modelSource = 'explicit';
  } else {
    const resolved = resolveLlmModel(options);
    model = resolved.value;
    modelSource = resolved.source;
  }

  let reasoning: ReasoningEffort | null;
  let reasoningSource: SettingSource;
  if (overrides && 'reasoningEffort' in overrides && overrides.reasoningEffort !== undefined) {
    reasoning = normalizeReasoningEffort(overrides.reasoningEffort);
    reasoningSource = 'explicit';
  } else {
    const resolved = resolveReasoningEffort(options);
    reasoning = resolved.value;
    reasoningSource = resolved.source;
  }

  return {
    model,
    reasoning,
    modelSource,
    reasoningSource,
    fingerprint: fingerprintOf(model, reasoning, modelSource, reasoningSource),
  };
}

function fingerprintOf(
  model: string,
  reasoning: string | null,
  modelSource: SettingSource,
  reasoningSource: SettingSource,
): string {
  return createHash('sha256')
    .update(`${model}|${reasoning ?? ''}|${modelSource}|${reasoningSource}`)
    .digest('hex');
}

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
export function llmSelectionFingerprint(
  overrides?: LlmSelectionOverride,
  options?: { now?: number },
): string {
  return resolveLlmSelection(overrides, options).fingerprint;
}
