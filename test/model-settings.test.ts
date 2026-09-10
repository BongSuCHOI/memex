import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_REASONING_EFFORTS,
  DEFAULT_LLM_MODEL,
  MODEL_SETTINGS_VERSION,
  invalidateModelSettingsCache,
  isValidModelId,
  llmSelectionFingerprint,
  modelSettingsPath,
  readModelSettings,
  resetModelSettings,
  resolveLlmModel,
  resolveLlmSelection,
  resolveReasoningEffort,
  writeModelSettings,
} from '../src/model-settings.js';

/**
 * `models.json` is the LOWEST-risk half of #31 and the one everything else
 * stands on: if the file layer can lose data, break on a corrupt document, or
 * out-rank env, every later contract (holds, budget refunds, auto-resume)
 * inherits the bug. These fix the four properties that matter — round trip,
 * fail-closed fallback, forward-compatible merge, and the precedence matrix.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-model-settings-'));
  process.env.MEMEX_HOME = root;
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMEX_CODEX_REASONING;
  invalidateModelSettingsCache();
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMEX_CODEX_REASONING;
  invalidateModelSettingsCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('models.json round trip', () => {
  it('writes atomically at 0600 and reads the same values back', () => {
    const written = writeModelSettings({ llm: { model: 'gpt-6-astra', reasoning: 'low' } });
    expect(written.llm).toEqual({ model: 'gpt-6-astra', reasoning: 'low', stages: {} });
    expect(written.version).toBe(MODEL_SETTINGS_VERSION);
    expect(written.updatedAt).toBeTruthy();

    const file = modelSettingsPath();
    expect(file).toBe(path.join(root, 'models.json'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // No temp file survives the rename.
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    invalidateModelSettingsCache();
    expect(readModelSettings().llm).toEqual({ model: 'gpt-6-astra', reasoning: 'low', stages: {} });
  });

  it('preserves keys this build does not know', () => {
    fs.writeFileSync(
      modelSettingsPath(),
      JSON.stringify({
        version: MODEL_SETTINGS_VERSION,
        llm: { model: 'gpt-6-astra', future_flag: 7 },
        experimental: { later: true },
      }),
    );
    invalidateModelSettingsCache();
    writeModelSettings({ llm: { reasoning: 'high' } });
    const raw = JSON.parse(fs.readFileSync(modelSettingsPath(), 'utf8'));
    expect(raw.experimental).toEqual({ later: true });
    expect(raw.llm.future_flag).toBe(7);
    expect(raw.llm.model).toBe('gpt-6-astra');
    expect(raw.llm.reasoning).toBe('high');
  });

  it('refuses an invalid model id or reasoning level instead of normalizing it', () => {
    expect(() => writeModelSettings({ llm: { model: 'bad id with spaces' } })).toThrow(/invalid model id/);
    expect(() => writeModelSettings({ llm: { reasoning: 'bogus' as never } })).toThrow(/invalid reasoning effort/);
    expect(fs.existsSync(modelSettingsPath())).toBe(false);
  });

  it('reset deletes the file and returns every value to the core default', () => {
    writeModelSettings({ llm: { model: 'gpt-6-astra', reasoning: 'max' } });
    const after = resetModelSettings();
    expect(fs.existsSync(modelSettingsPath())).toBe(false);
    expect(after.llm.model).toBeNull();
    expect(after.llm.reasoning).toBeNull();
    expect(resolveLlmModel().value).toBe(DEFAULT_LLM_MODEL);
  });
});

describe('fail-closed fallback', () => {
  it('falls back to defaults on corrupt JSON and does NOT overwrite the file', () => {
    const corrupt = '{ this is not json';
    fs.writeFileSync(modelSettingsPath(), corrupt);
    invalidateModelSettingsCache();

    expect(readModelSettings().llm.model).toBeNull();
    expect(resolveLlmModel()).toEqual({ value: DEFAULT_LLM_MODEL, source: 'default' });
    expect(fs.readFileSync(modelSettingsPath(), 'utf8')).toBe(corrupt);
  });

  it('ignores an unsupported version wholesale and leaves the file alone', () => {
    const body = JSON.stringify({ version: 99, llm: { model: 'gpt-from-the-future' } });
    fs.writeFileSync(modelSettingsPath(), body);
    invalidateModelSettingsCache();

    expect(readModelSettings().llm.model).toBeNull();
    expect(resolveLlmModel().source).toBe('default');
    expect(fs.readFileSync(modelSettingsPath(), 'utf8')).toBe(body);
  });

  it('drops a structurally valid but unusable value rather than trusting it', () => {
    fs.writeFileSync(
      modelSettingsPath(),
      JSON.stringify({
        version: MODEL_SETTINGS_VERSION,
        llm: { model: 'has spaces', reasoning: 'BOGUS' },
      }),
    );
    invalidateModelSettingsCache();
    const settings = readModelSettings();
    expect(settings.llm.model).toBeNull();
    expect(settings.llm.reasoning).toBeNull();
  });

  it('accepts a case-insensitive reasoning level from the file', () => {
    fs.writeFileSync(
      modelSettingsPath(),
      JSON.stringify({ version: MODEL_SETTINGS_VERSION, llm: { reasoning: 'HIGH' } }),
    );
    invalidateModelSettingsCache();
    expect(readModelSettings().llm.reasoning).toBe('high');
  });
});

describe('precedence: env > file > default', () => {
  const cases: Array<{ env: string | null; file: string | null; value: string; source: string }> = [
    { env: 'env-model', file: 'file-model', value: 'env-model', source: 'env' },
    { env: 'env-model', file: null, value: 'env-model', source: 'env' },
    { env: null, file: 'file-model', value: 'file-model', source: 'file' },
    { env: null, file: null, value: DEFAULT_LLM_MODEL, source: 'default' },
  ];

  for (const scenario of cases) {
    it(`model env=${scenario.env ?? '-'} file=${scenario.file ?? '-'} → ${scenario.value} (${scenario.source})`, () => {
      if (scenario.file) writeModelSettings({ llm: { model: scenario.file } });
      if (scenario.env) process.env.MEMEX_CODEX_MODEL = scenario.env;
      invalidateModelSettingsCache();
      expect(resolveLlmModel()).toEqual({ value: scenario.value, source: scenario.source });
    });
  }

  const reasoningCases: Array<{ env: string | null; file: string | null; value: string | null; source: string }> = [
    { env: 'high', file: 'low', value: 'high', source: 'env' },
    { env: 'high', file: null, value: 'high', source: 'env' },
    { env: null, file: 'low', value: 'low', source: 'file' },
    { env: null, file: null, value: null, source: 'default' },
    // An unusable env value must not silently win — it falls through.
    { env: 'bogus', file: 'low', value: 'low', source: 'file' },
  ];

  for (const scenario of reasoningCases) {
    it(`reasoning env=${scenario.env ?? '-'} file=${scenario.file ?? '-'} → ${scenario.value ?? 'none'} (${scenario.source})`, () => {
      if (scenario.file) writeModelSettings({ llm: { reasoning: scenario.file as never } });
      if (scenario.env) process.env.MEMEX_CODEX_REASONING = scenario.env;
      invalidateModelSettingsCache();
      expect(resolveReasoningEffort()).toEqual({ value: scenario.value, source: scenario.source });
    });
  }

  it('a per-call override outranks env and is reported as explicit', () => {
    process.env.MEMEX_CODEX_MODEL = 'env-model';
    process.env.MEMEX_CODEX_REASONING = 'high';
    const selection = resolveLlmSelection({ model: 'call-model', reasoningEffort: 'low' });
    expect(selection.model).toBe('call-model');
    expect(selection.reasoning).toBe('low');
    expect(selection.modelSource).toBe('explicit');
    expect(selection.reasoningSource).toBe('explicit');
  });
});

describe('llmSelectionFingerprint', () => {
  it('is stable for the same selection and changes when env changes', () => {
    const first = llmSelectionFingerprint();
    expect(llmSelectionFingerprint()).toBe(first);

    process.env.MEMEX_CODEX_MODEL = 'gpt-6-astra';
    invalidateModelSettingsCache();
    const withEnv = llmSelectionFingerprint();
    expect(withEnv).not.toBe(first);

    process.env.MEMEX_CODEX_REASONING = 'high';
    invalidateModelSettingsCache();
    expect(llmSelectionFingerprint()).not.toBe(withEnv);
  });

  it('separates the same model id reached through env from the file', () => {
    writeModelSettings({ llm: { model: 'gpt-6-astra' } });
    invalidateModelSettingsCache();
    const fromFile = llmSelectionFingerprint();

    resetModelSettings();
    process.env.MEMEX_CODEX_MODEL = 'gpt-6-astra';
    invalidateModelSettingsCache();
    const fromEnv = llmSelectionFingerprint();

    // Same id, different provenance: moving it is a user action and deserves a
    // fresh attempt rather than inheriting the old selection's hold.
    expect(fromEnv).not.toBe(fromFile);
  });

  it('gives a per-call override its own fingerprint', () => {
    const base = llmSelectionFingerprint();
    expect(llmSelectionFingerprint({ model: 'other-model' })).not.toBe(base);
    expect(llmSelectionFingerprint({ model: 'other-model' })).toBe(
      llmSelectionFingerprint({ model: 'other-model' }),
    );
  });
});

describe('shape validation', () => {
  it('accepts real model ids and rejects control characters and oversized input', () => {
    expect(isValidModelId('gpt-5.6-luna')).toBe(true);
    expect(isValidModelId('org/model:v1@2')).toBe(true);
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('bad id')).toBe(false);
    expect(isValidModelId('a b')).toBe(false);
    expect(isValidModelId('x'.repeat(257))).toBe(false);
  });

  it('exposes the measured provider level set', () => {
    expect([...ALLOWED_REASONING_EFFORTS]).toEqual([
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
  });
});
