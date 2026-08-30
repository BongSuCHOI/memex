import { describe, expect, it } from 'vitest';
import { validateTranslationBatch } from '../scripts/translation-response.mjs';

describe('translation batch response validation', () => {
  it('accepts exactly one non-empty string per source fact', () => {
    expect(validateTranslationBatch(['하나', '둘'], 2)).toEqual(['하나', '둘']);
  });

  it.each([
    { response: ['하나'], expectedCount: 2 },
    { response: ['하나', '둘', '셋'], expectedCount: 2 },
    { response: ['하나', 2], expectedCount: 2 },
    { response: ['하나', '   '], expectedCount: 2 },
    { response: { translation: '하나' }, expectedCount: 1 },
  ])('rejects a malformed response without partially mapping it: $response', ({ response, expectedCount }) => {
    expect(validateTranslationBatch(response, expectedCount)).toBeNull();
  });
});
