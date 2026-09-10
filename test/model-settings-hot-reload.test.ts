import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  invalidateModelSettingsCache,
  modelSettingsPath,
  readModelSettings,
  resolveLlmModel,
} from '../src/model-settings.js';

/**
 * §6 — the LLM half of #31 gets hot reload for free, and that is a CONTRACT:
 * the MCP server and the inject daemon live as long as the host session, so a
 * `memex models set` that only took effect after a restart would read as "the
 * setting did nothing". The cost bound is the other half of the contract: one
 * `stat` per model call at most, never a read.
 */

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-model-hot-'));
  process.env.MEMEX_HOME = root;
  delete process.env.MEMEX_CODEX_MODEL;
  invalidateModelSettingsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MEMEX_HOME;
  invalidateModelSettingsCache();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRaw(model: string): void {
  fs.writeFileSync(
    modelSettingsPath(),
    JSON.stringify({ version: 1, llm: { model, reasoning: null } }),
  );
}

it('sees a new selection on the next call once the revalidation window passes', () => {
  writeRaw('first-model');
  const t0 = 1_000_000;
  expect(readModelSettings({ now: t0 }).llm.model).toBe('first-model');

  writeRaw('second-model');
  // Inside the 1s window the memo still answers — that is the cost bound.
  expect(readModelSettings({ now: t0 + 500 }).llm.model).toBe('first-model');
  // Past it, the same long-lived process picks the new value up with no restart.
  expect(readModelSettings({ now: t0 + 2_000 }).llm.model).toBe('second-model');
  expect(resolveLlmModel({ now: t0 + 3_000 })).toEqual({ value: 'second-model', source: 'file' });
});

it('an unchanged file costs one stat and zero reads per revalidation', () => {
  writeRaw('steady-model');
  const t0 = 2_000_000;
  readModelSettings({ now: t0 });

  const stat = vi.spyOn(fs, 'statSync');
  const read = vi.spyOn(fs, 'readFileSync');
  // Past the window: revalidate by stat, find the same (mtime, size), reuse.
  expect(readModelSettings({ now: t0 + 2_000 }).llm.model).toBe('steady-model');
  expect(stat).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();

  // Inside the next window not even the stat happens.
  expect(readModelSettings({ now: t0 + 2_100 }).llm.model).toBe('steady-model');
  expect(stat).toHaveBeenCalledTimes(1);
});

it('treats file creation and deletion as a change', () => {
  const t0 = 3_000_000;
  expect(readModelSettings({ now: t0 }).llm.model).toBeNull();

  writeRaw('appeared');
  expect(readModelSettings({ now: t0 + 2_000 }).llm.model).toBe('appeared');

  fs.rmSync(modelSettingsPath());
  expect(readModelSettings({ now: t0 + 4_000 }).llm.model).toBeNull();
});
