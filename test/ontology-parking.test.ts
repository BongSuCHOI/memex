/**
 * Issue #41 — parking must be a distinguishable, BOUNDED state.
 *
 * Reproduces the audited real-root shape (5 domains / 20 categories / 127
 * facts, 3 of them in General/Misc with ontology_attempts = 0 and
 * ontology_last_attempt_at = NULL, i.e. the LLM genuinely chose Misc) and
 * proves the three regressions the audit found:
 *
 *   1. a fact PARKED after bounded failures is not reported as classified,
 *      and is not confused with an LLM-chosen Misc assignment;
 *   2. parking is retried exactly ONCE per (classifier policy, embedding
 *      generation) token instead of being permanent;
 *   3. an output-token budget overflow splits the batch and retries instead
 *      of charging every fact in it a content failure (which used to park up
 *      to BATCH_HARD_CAP=50 innocent facts after three batches).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createTestDb, suppressConsole } from './test-utils.js';

vi.mock('../src/llm.js', () => ({
  callMemoryModel: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

import { callMemoryModel, parseJsonResponse } from '../src/llm.js';
import {
  backfillClassifyBatch,
  countParkedRetryable,
  persistFallbackClassification,
  recordOntologyAttempt,
  releaseParkedFact,
  MAX_CLASSIFY_ATTEMPTS,
} from '../src/ontology-classifier.js';
import { createCategory, createDomain, classifyFact } from '../src/ontology-db.js';
import { ontologyParkToken, buildOntologyPendingClause } from '../src/ontology-selector.js';

const EMBEDDING_VERSION = 2; // matches the mock above
const CURRENT_TOKEN = ontologyParkToken(EMBEDDING_VERSION);

function initSchema(db: Database.Database) {
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, fact TEXT NOT NULL, category TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global', scope_project TEXT,
      source_exchange_ids TEXT DEFAULT '[]', embedding BLOB,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      consolidated_count INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      ontology_category_id TEXT, fact_kr TEXT,
      embedding_version INTEGER NOT NULL DEFAULT 2,
      ontology_attempts INTEGER NOT NULL DEFAULT 0,
      ontology_last_attempt_at TEXT,
      ontology_state TEXT, ontology_parked_at TEXT, ontology_parked_version TEXT,
      ontology_similarity REAL,
      semantic_generation INTEGER NOT NULL DEFAULT 1,
      semantic_updated_at TEXT NOT NULL DEFAULT '',
      project_id TEXT, workspace_id TEXT, workstream_id TEXT, subject_key TEXT,
      promotion_state TEXT DEFAULT 'legacy-project',
      lifecycle_generation INTEGER NOT NULL DEFAULT 1
    );
    CREATE VIRTUAL TABLE vec_facts USING vec0(id TEXT PRIMARY KEY, embedding float[384]);
    CREATE VIRTUAL TABLE vec_categories USING vec0(id TEXT PRIMARY KEY, embedding float[384]);
    CREATE TABLE ontology_domains (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE ontology_categories (
      id TEXT PRIMARY KEY, domain_id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
      description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ontology_relations (
      id TEXT PRIMARY KEY, source_fact_id TEXT NOT NULL, relation_type TEXT NOT NULL,
      target_fact_id TEXT NOT NULL, reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
}

function insertFact(db: Database.Database, id: string, text = `fact ${id}`) {
  const now = '2026-01-01T00:00:00.000Z';
  const embedding = Buffer.from(new Float32Array(new Array(384).fill(0.1)).buffer);
  db.prepare(`INSERT INTO facts (id, fact, category, created_at, updated_at, embedding)
    VALUES (?, ?, 'decision', ?, ?, ?)`).run(id, text, now, now, embedding);
  db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(id, embedding);
}

function factRow(db: Database.Database, id: string) {
  return db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown>;
}

/** The audited real root: 5 domains, 20 categories, 3 LLM-chosen Misc facts. */
function seedRealRootTaxonomy(db: Database.Database) {
  const domains = ['Architecture', 'Frontend', 'Backend', 'DevOps', 'General'];
  const ids: Record<string, string> = {};
  for (const name of domains) ids[name] = createDomain(db, name, `${name} facts`).id;
  let created = 0;
  for (const name of domains) {
    for (let i = 0; created < 20; i++) {
      createCategory(db, ids[name], `${name} topic ${i}`, null as unknown as undefined);
      created++;
      if (created % 4 === 0) break;
    }
  }
  const misc = createCategory(db, ids.General, 'Misc', 'Miscellaneous facts');
  return { domainIds: ids, miscId: misc.id };
}

describe('issue #41 — ontology parking is a distinct, bounded state', () => {
  let db: Database.Database;
  let cleanup: () => void;
  let restoreConsole: () => void;

  beforeEach(() => {
    ({ db, cleanup } = createTestDb());
    initSchema(db);
    restoreConsole = suppressConsole();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreConsole();
    cleanup();
  });

  it('records parking as its own state, distinguishable from an LLM-chosen Misc', () => {
    const { miscId } = seedRealRootTaxonomy(db);

    // Three facts the LLM genuinely placed in General/Misc — attempts 0, no
    // last-attempt stamp. This is exactly the audited real-root state.
    for (const id of ['llm-misc-1', 'llm-misc-2', 'llm-misc-3']) {
      insertFact(db, id);
      classifyFact(db, id, miscId);
    }
    // One fact parked because classification exhausted its attempts.
    insertFact(db, 'parked-1');
    for (let i = 0; i < MAX_CLASSIFY_ATTEMPTS; i++) recordOntologyAttempt(db, 'parked-1');
    persistFallbackClassification(db, 'parked-1');

    const parked = factRow(db, 'parked-1');
    expect(parked.ontology_state).toBe('parked');
    expect(parked.ontology_parked_version).toBe(CURRENT_TOKEN);
    expect(parked.ontology_parked_at).toBeTruthy();
    expect(parked.ontology_category_id).toBe(miscId);

    for (const id of ['llm-misc-1', 'llm-misc-2', 'llm-misc-3']) {
      const row = factRow(db, id);
      expect(row.ontology_state).toBeNull();
      expect(row.ontology_attempts).toBe(0);
      expect(row.ontology_last_attempt_at).toBeNull();
    }

    // The counters status derives: 3 classified, 1 parked, 0 pending.
    const classified = db.prepare(`SELECT COUNT(*) AS c FROM facts
      WHERE is_active = 1 AND ontology_category_id IS NOT NULL
        AND (ontology_state IS NULL OR ontology_state <> 'parked')`).get() as { c: number };
    const parkedCount = db.prepare(
      "SELECT COUNT(*) AS c FROM facts WHERE is_active = 1 AND ontology_state = 'parked'",
    ).get() as { c: number };
    expect(classified.c).toBe(3);
    expect(parkedCount.c).toBe(1);
  });

  it('retries a parked fact exactly once per policy/embedding generation', () => {
    seedRealRootTaxonomy(db);
    insertFact(db, 'parked-1');
    for (let i = 0; i < MAX_CLASSIFY_ATTEMPTS; i++) recordOntologyAttempt(db, 'parked-1');
    persistFallbackClassification(db, 'parked-1');

    // Parked under the CURRENT token → the retry for this generation is spent.
    expect(countParkedRetryable(db)).toBe(0);
    expect(releaseParkedFact(db, 'parked-1')).toBe(0);

    // Simulate an embedding-model upgrade / policy bump: the cause may have
    // cleared, so exactly one retry is owed.
    db.prepare("UPDATE facts SET ontology_parked_version = 'p1:e1' WHERE id = ?").run('parked-1');
    expect(countParkedRetryable(db)).toBe(1);

    const selector = buildOntologyPendingClause({
      embeddingVersion: EMBEDDING_VERSION,
      maxAttempts: MAX_CLASSIFY_ATTEMPTS,
      alias: 'f',
    });
    const selected = db
      .prepare(`SELECT f.id FROM facts f WHERE ${selector.clause}`)
      .all(...selector.params) as Array<{ id: string }>;
    expect(selected.map((r) => r.id)).toEqual(['parked-1']);

    expect(releaseParkedFact(db, 'parked-1')).toBe(1);
    const released = factRow(db, 'parked-1');
    expect(released.ontology_category_id).toBeNull();
    expect(released.ontology_attempts).toBe(0);
    expect(released.ontology_state).toBeNull();
    // Stamped with the current token at release time: a crash mid-retry can
    // never yield a SECOND retry inside the same generation.
    expect(released.ontology_parked_version).toBe(CURRENT_TOKEN);
    expect(releaseParkedFact(db, 'parked-1')).toBe(0);
    expect(countParkedRetryable(db)).toBe(0);
  });

  it('splits the batch on an output-token budget overflow instead of charging every fact', async () => {
    seedRealRootTaxonomy(db);
    const ids = ['o-0', 'o-1', 'o-2', 'o-3'];
    for (const id of ids) insertFact(db, id);

    // The provider bound is a function of BATCH SIZE, not of the real answer
    // length: any call carrying more than two facts overflows here.
    const seen: number[] = [];
    (callMemoryModel as ReturnType<typeof vi.fn>).mockImplementation(
      async (_system: string, user: string) => {
        const size = (JSON.parse(user) as { facts: unknown[] }).facts.length;
        seen.push(size);
        if (size > 2) {
          const error = new Error('output limit') as Error & { code: string };
          error.code = 'MEMEX_MODEL_OUTPUT_LIMIT';
          throw error;
        }
        return JSON.stringify({ ok: true });
      },
    );
    (parseJsonResponse as ReturnType<typeof vi.fn>).mockImplementation(() => [
      { index: 0, domain: 'Architecture', category: 'Split A' },
      { index: 1, domain: 'Architecture', category: 'Split B' },
    ]);

    const totals = await backfillClassifyBatch(db, ids);

    expect(seen[0]).toBe(4); // one overflowing call…
    expect(seen.slice(1)).toEqual([2, 2]); // …then the halves
    expect(totals.classified).toBe(4);
    expect(totals.failed).toBe(0);
    expect(totals.fallback).toBe(0);
    for (const id of ids) {
      const row = factRow(db, id);
      expect(row.ontology_attempts).toBe(0); // no fact was charged for a system limit
      expect(row.ontology_state).toBeNull();
      expect(row.ontology_category_id).toBeTruthy();
    }
  });

  it('charges the ledger only when a SINGLE fact still overflows the bound', async () => {
    seedRealRootTaxonomy(db);
    insertFact(db, 'huge-0');
    (callMemoryModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const error = new Error('output limit') as Error & { code: string };
      error.code = 'MEMEX_MODEL_OUTPUT_LIMIT';
      throw error;
    });

    const totals = await backfillClassifyBatch(db, ['huge-0']);
    expect(totals.failed).toBe(1);
    expect(factRow(db, 'huge-0').ontology_attempts).toBe(1);
  });
});
