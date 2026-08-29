// Public API for the Memex package
export * from './types.js';
export * from './db.js';
export * from './embeddings.js';
export * from './indexer.js';
export * from './parser.js';
export * from './search.js';
export * from './summarizer.js';
export * from './paths.js';
// P2-2: the public package surface exposes read/search primitives only. Raw
// fact writers (insertFact/updateFact/deactivateFact/deleteFact/insertRevision)
// stay internal — every semantic mutation must go through fact-management's
// transactional service so the revision/vector/ontology/relation invariants
// cannot be bypassed by package consumers. In-repo callers import fact-db.js
// directly.
export {
  getActiveFacts,
  getFactsByProject,
  getRevisions,
  searchFactsByScope,
  searchSimilarFacts,
  searchSimilarFactsSameScope,
  getTopFacts,
  getNewFactsSince,
  getPendingConsolidationFacts,
  searchAllFacts,
} from './fact-db.js';
export type { FactSearchScope } from './fact-db.js';
export * from './fact-extractor.js';
export * from './fact-management.js';
export * from './consolidator.js';
export * from './llm.js';
