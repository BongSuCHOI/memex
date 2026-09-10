import { describe, expect, it } from 'vitest';
import {
  CodexRequestRejectedError,
  isEnvelopeRejection,
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

it('sanitizeProviderMessage strips control characters and bounds length', () => {
  expect(sanitizeProviderMessage('a\u0000b\nc\td')).toBe('a b c d');
  expect(sanitizeProviderMessage('x'.repeat(900)).length).toBe(400);
  expect(sanitizeProviderMessage('x'.repeat(900), 10).length).toBe(10);
});
