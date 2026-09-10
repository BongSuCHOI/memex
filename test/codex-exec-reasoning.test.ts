import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CODEX_MODEL,
  buildCodexExecArgs,
  resolveCodexSelection,
} from '../src/codex-exec.js';
import { invalidateModelSettingsCache, writeModelSettings } from '../src/model-settings.js';

/**
 * `buildCodexExecArgs` is the single interpretation point for model selection
 * (design principle 1), so the callers that bypass llm.ts entirely —
 * summarizer.ts and scripts/translate-facts.mjs — inherit the file layer here or
 * nowhere. These tests fix the flag, its absence, and the precedence.
 */

let root: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-codex-reasoning-'));
  process.env.MEMEX_HOME = root;
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMEX_CODEX_REASONING;
  invalidateModelSettingsCache();
  // The resolver layer is loaded lazily (see codex-exec.ts); prime it so the
  // synchronous arg builder sees the file layer, exactly as runCodex does.
  await resolveCodexSelection();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMEX_CODEX_REASONING;
  invalidateModelSettingsCache();
  fs.rmSync(root, { recursive: true, force: true });
});

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe('-c model_reasoning_effort', () => {
  it('is omitted entirely when nothing selects a level', () => {
    const args = buildCodexExecArgs({ workdir: '/w' });
    expect(args.includes('-c')).toBe(false);
    expect(flagValue(args, '-m')).toBe(DEFAULT_CODEX_MODEL);
  });

  it('lands after -m and before -o, and coexists with --ignore-user-config', () => {
    const args = buildCodexExecArgs({
      workdir: '/w',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      outputLast: '/w/last.txt',
    });
    expect(flagValue(args, '-c')).toBe('model_reasoning_effort=high');
    // `-c` is the CLI override layer, not the user's config.toml: the isolation
    // flag stays, and Memex supplies its own setting instead.
    expect(args.includes('--ignore-user-config')).toBe(true);
    expect(args.indexOf('-m')).toBeLessThan(args.indexOf('-c'));
    expect(args.indexOf('-c')).toBeLessThan(args.indexOf('-o'));
    expect(args.slice(-2)).toEqual(['--json', '-']);
  });

  it('drops an illegal value with one warning instead of killing the call', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = buildCodexExecArgs({ workdir: '/w', reasoningEffort: 'HIGH; rm -rf /' });
    expect(args.includes('-c')).toBe(false);
    // The call still goes out — a malformed setting is not a reason to lose work.
    expect(flagValue(args, '-m')).toBe(DEFAULT_CODEX_MODEL);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the level from models.json', async () => {
    writeModelSettings({ llm: { model: 'file-model', reasoning: 'xhigh' } });
    invalidateModelSettingsCache();
    await resolveCodexSelection();
    const args = buildCodexExecArgs({ workdir: '/w' });
    expect(flagValue(args, '-m')).toBe('file-model');
    expect(flagValue(args, '-c')).toBe('model_reasoning_effort=xhigh');
  });

  it('lets env beat the file and an explicit option beat env', async () => {
    writeModelSettings({ llm: { model: 'file-model', reasoning: 'low' } });
    process.env.MEMEX_CODEX_MODEL = 'env-model';
    process.env.MEMEX_CODEX_REASONING = 'medium';
    invalidateModelSettingsCache();
    await resolveCodexSelection();

    const fromEnv = buildCodexExecArgs({ workdir: '/w' });
    expect(flagValue(fromEnv, '-m')).toBe('env-model');
    expect(flagValue(fromEnv, '-c')).toBe('model_reasoning_effort=medium');

    const explicit = buildCodexExecArgs({
      workdir: '/w',
      model: 'call-model',
      reasoningEffort: 'max',
    });
    expect(flagValue(explicit, '-m')).toBe('call-model');
    expect(flagValue(explicit, '-c')).toBe('model_reasoning_effort=max');
  });

  it('an explicit null reasoning effort means "no flag", overriding the file', async () => {
    writeModelSettings({ llm: { reasoning: 'high' } });
    invalidateModelSettingsCache();
    await resolveCodexSelection();
    expect(buildCodexExecArgs({ workdir: '/w' }).includes('-c')).toBe(true);
    expect(buildCodexExecArgs({ workdir: '/w', reasoningEffort: null }).includes('-c')).toBe(false);
  });
});

describe('resolveCodexSelection', () => {
  it('reports the pair that will actually be sent', async () => {
    writeModelSettings({ llm: { model: 'file-model', reasoning: 'low' } });
    invalidateModelSettingsCache();
    expect(await resolveCodexSelection()).toEqual({
      model: 'file-model',
      reasoningEffort: 'low',
    });
    expect(await resolveCodexSelection({ model: 'other' })).toEqual({
      model: 'other',
      reasoningEffort: 'low',
    });
  });
});
