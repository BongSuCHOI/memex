import { describe, it, expect } from 'vitest';
import * as publicApi from '../src/index.js';

// P2-2: fact-management.ts is the single mutation SSOT. The package barrel
// must expose fact read/search primitives only — raw fact-db writers would
// let package consumers bypass the transactional service's
// revision/vector/ontology/relation invariants.
const RAW_FACT_WRITERS = [
  'insertFact',
  'updateFact',
  'deactivateFact',
  'deleteFact',
  'insertRevision',
];

const FACT_READ_PRIMITIVES = [
  'getActiveFacts',
  'getFactsByProject',
  'getRevisions',
  'searchFactsByScope',
  'searchSimilarFacts',
  'searchSimilarFactsSameScope',
  'getTopFacts',
  'getNewFactsSince',
  'getPendingConsolidationFacts',
  'searchAllFacts',
];

const FACT_EXTRACTION_COMPATIBILITY_EXPORTS = [
  'isSubstantiveExchange',
  'selectSpreadBatches',
];

describe('package public API surface (P2-2)', () => {
  it('does not export raw fact mutation primitives', () => {
    const api = publicApi as unknown as Record<string, unknown>;
    for (const name of RAW_FACT_WRITERS) {
      expect(api[name], `${name} must stay internal to fact-db.js`).toBeUndefined();
    }
  });

  it('still exports the fact read/search primitives', () => {
    const api = publicApi as unknown as Record<string, unknown>;
    for (const name of FACT_READ_PRIMITIVES) {
      expect(typeof api[name], `${name} must remain on the public surface`).toBe('function');
    }
  });

  it('retains the pre-Phase-3 fact extraction helper exports', () => {
    const api = publicApi as unknown as Record<string, unknown>;
    for (const name of FACT_EXTRACTION_COMPATIBILITY_EXPORTS) {
      expect(typeof api[name], `${name} must remain on the public surface`).toBe('function');
    }
  });
});
