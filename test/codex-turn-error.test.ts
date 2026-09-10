import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CodexRequestRejectedError,
  isEnvelopeRejection,
  runCodex,
  sanitizeProviderMessage,
  turnErrorFromEvents,
} from '../src/codex-exec.js';
import { classifyLlmError, LlmCallError } from '../src/llm-error-class.js';

/**
 * Risk R2 is the reason this file exists and the reason the predicate is narrow.
 *
 * A real input-too-large 400 MUST stay `deterministic`: that is the only path
 * that halves the extraction window and recovers a long conversation. If the
 * envelope predicate widened to "any 400", such a conversation would be held
 * forever instead — a permanent hold dressed up as a safety feature. So the
 * positive cases below are measured provider bodies, and the negative cases are
 * the ones that must NOT move.
 */

// Measured 2026-09-11, codex-cli 0.153.4: an invalid reasoning level.
const INVALID_EFFORT_STREAM = [
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'error',
    message:
      'unexpected status 400 Bad Request: {"error":{"message":"Invalid value for ' +
      "[reasoning.effort] [invalid_enum_value] Invalid value: 'bogus'. Supported values are: " +
      `'none','minimal','low','medium','high','xhigh','max'.","type":"invalid_request_error"}}`,
  }),
  JSON.stringify({ type: 'turn.failed', error: { message: 'turn aborted' } }),
].join('\n');

// Measured 2026-09-11: a model id this account cannot use.
const UNKNOWN_MODEL_STREAM = [
  JSON.stringify({
    type: 'error',
    message:
      'unexpected status 400 Bad Request: {"detail":"The \'totally-bogus-model-xyz\' model is ' +
      'not supported when using Codex with a ChatGPT account."}',
  }),
].join('\n');

// The shape that must NOT be reclassified: the request content is too big.
const INPUT_TOO_LARGE_STREAM = [
  JSON.stringify({
    type: 'error',
    message:
      'unexpected status 400 Bad Request: {"error":{"message":"Your input exceeds the context ' +
      'window of this model. Please adjust your input and try again.","type":"invalid_request_error",' +
      '"code":"context_length_exceeded"}}',
  }),
].join('\n');

describe('turnErrorFromEvents', () => {
  it('returns null for a clean stream', () => {
    const clean = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');
    expect(turnErrorFromEvents(clean)).toBeNull();
  });

  it('tolerates garbage lines and an empty stream', () => {
    expect(turnErrorFromEvents('')).toBeNull();
    expect(turnErrorFromEvents('not json\n{"type":"error"}\n')).toBeNull();
  });

  it('extracts status and provider type from the embedded body', () => {
    const error = turnErrorFromEvents(INVALID_EFFORT_STREAM)!;
    expect(error.status).toBe(400);
    expect(error.type).toBe('invalid_request_error');
    expect(error.message).toContain('[reasoning.effort]');
  });

  it('reads a turn.failed error object when no error event precedes it', () => {
    const stream = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'unexpected status 500 Internal Server Error' },
    });
    expect(turnErrorFromEvents(stream)).toEqual({
      message: 'unexpected status 500 Internal Server Error',
      status: 500,
      type: null,
    });
  });
});

describe('isEnvelopeRejection — narrow on purpose', () => {
  it('accepts a rejected reasoning level', () => {
    expect(isEnvelopeRejection(turnErrorFromEvents(INVALID_EFFORT_STREAM))).toBe(true);
  });

  it('accepts a rejected model id even though the body declares no type', () => {
    const error = turnErrorFromEvents(UNKNOWN_MODEL_STREAM)!;
    expect(error.type).toBeNull();
    expect(isEnvelopeRejection(error)).toBe(true);
  });

  it('leaves a real input-too-large 400 alone', () => {
    const error = turnErrorFromEvents(INPUT_TOO_LARGE_STREAM)!;
    expect(error.status).toBe(400);
    expect(error.type).toBe('invalid_request_error');
    expect(isEnvelopeRejection(error)).toBe(false);
  });

  it('refuses anything that is not a 400, and refuses null', () => {
    expect(isEnvelopeRejection(null)).toBe(false);
    expect(
      isEnvelopeRejection({ message: 'unknown model', status: 500, type: null }),
    ).toBe(false);
    expect(
      isEnvelopeRejection({ message: 'unknown model', status: null, type: null }),
    ).toBe(false);
  });

  it('refuses a 400 whose type names a different error family', () => {
    expect(
      isEnvelopeRejection({
        message: 'unknown model',
        status: 400,
        type: 'rate_limit_error',
      }),
    ).toBe(false);
  });
});

describe('classification', () => {
  it('classifies the rejection as config, not deterministic', () => {
    const error = new CodexRequestRejectedError({
      status: 400,
      providerType: 'invalid_request_error',
      providerMessage: "Invalid value: 'bogus'",
      model: 'gpt-6-astra',
      reasoningEffort: 'bogus',
    });
    expect(classifyLlmError(error)).toBe('config');
    // Wrapped by the extraction path, the verdict must not change.
    expect(classifyLlmError(new LlmCallError(error))).toBe('config');
  });

  it('keeps a plain input-too-large provider error deterministic', () => {
    const error = Object.assign(new Error('Your input exceeds the context window'), {
      status: 400,
    });
    expect(classifyLlmError(error)).toBe('deterministic');
  });

  it('names the model and effort in its message', () => {
    const error = new CodexRequestRejectedError({
      status: 400,
      providerType: null,
      providerMessage: 'nope',
      model: 'bad-model',
      reasoningEffort: null,
    });
    expect(error.message).toContain('bad-model');
    expect(error.code).toBe('MEMEX_MODEL_CONFIG');
    expect(error.name).toBe('CodexRequestRejectedError');
  });
});

/**
 * The connected path, which the unit tests above cannot see.
 *
 * Parser and classifier were both correct in isolation while the two were not
 * joined: `runCodex` only surfaced ENVELOPE rejections and dropped every other
 * turn error, so an exit-0 context-length 400 came back as `''` and `llm.ts`
 * turned it into `EmptyLlmResponseError` — 'transient'. The fixture below is the
 * same measured body the `isEnvelopeRejection` cases use.
 */
describe('input-too-large 400 stays deterministic from the provider stream to the caller', () => {
  const roots: string[] = [];

  function fakeCodex(stream: string, calls?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-turn-error-'));
    roots.push(dir);
    const bin = path.join(dir, 'fake-codex');
    // exit 0 with the error stream and NO final agent message — measured shape.
    fs.writeFileSync(
      bin,
      `#!${process.execPath}\n` +
        `const fs=require('node:fs');\n` +
        `fs.readFileSync(0,'utf8');\n` +
        (calls ? `fs.appendFileSync(${JSON.stringify(calls)},'call\\n');\n` : '') +
        `process.stdout.write(${JSON.stringify(stream + '\n')});\n`,
    );
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const key of ['MEMEX_HOME', 'MEMEX_DB_PATH', 'MEMEX_CODEX_BIN', 'MEMEX_LLM_RETRY_BASE_MS']) {
      delete process.env[key];
    }
  });

  it('runCodex rejects instead of returning an empty body, and the class is deterministic', async () => {
    // Pinned so the developer's real `<data root>/models.json` cannot decide which
    // model this case resolves; nothing here writes to a data root either way.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-turn-error-root-'));
    roots.push(home);
    process.env.MEMEX_HOME = home;
    const bin = fakeCodex(INPUT_TOO_LARGE_STREAM);
    const error = await runCodex({ codexBin: bin, userMessage: 'x', timeoutMs: 15_000 }).then(
      (text) => ({ returned: text }) as unknown,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('CodexTurnFailedError');
    expect((error as { status?: number | null }).status).toBe(400);
    expect(classifyLlmError(error)).toBe('deterministic');
    expect(classifyLlmError(new LlmCallError(error))).toBe('deterministic');
  });

  it('callMemoryModel spends ONE provider call on it — deterministic is never retried', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-turn-error-home-'));
    roots.push(root);
    const calls = path.join(root, 'calls.txt');
    process.env.MEMEX_HOME = root;
    process.env.MEMEX_DB_PATH = path.join(root, 'db.sqlite');
    process.env.MEMEX_CODEX_BIN = fakeCodex(INPUT_TOO_LARGE_STREAM, calls);
    process.env.MEMEX_LLM_RETRY_BASE_MS = '0';

    const { ensureModelBudgetSchema } = await import('../src/model-budget.js');
    const db = new Database(process.env.MEMEX_DB_PATH);
    ensureModelBudgetSchema(db);
    try {
      const { callMemoryModel } = await import('../src/llm.js');
      const error = await callMemoryModel('sys', 'user', 64, { modelContext: { db } }).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(classifyLlmError(error)).toBe('deterministic');
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

it('sanitizeProviderMessage strips control characters and bounds length', () => {
  expect(sanitizeProviderMessage('a\u0000b\nc\td')).toBe('a b c d');
  expect(sanitizeProviderMessage('x'.repeat(900)).length).toBe(400);
  expect(sanitizeProviderMessage('x'.repeat(900), 10).length).toBe(10);
});
