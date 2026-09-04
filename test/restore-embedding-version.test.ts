import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Deterministic angle-vector embedding: text "…@<angle>" maps to a unit
// vector [cos θ, sin θ, 0…]. Calls are recorded so tests can prove whether
// restore reused the stored embedding or re-embedded.
const { embedCalls } = vi.hoisted(() => ({ embedCalls: [] as string[] }));
vi.mock('../src/embeddings.js', () => {
  const DIM = 384;
  const angleVector = (text: string): number[] => {
    const m = /@(-?\d+(?:\.\d+)?)/.exec(text);
    const angle = m ? parseFloat(m[1]) : 0;
    const v = new Array<number>(DIM).fill(0);
    v[0] = Math.cos(angle);
    v[1] = Math.sin(angle);
    return v;
  };
  return {
    EMBEDDING_MODEL: 'test-restore-model',
    EMBEDDING_VERSION: 777,
    initEmbeddings: async () => {},
    generateEmbedding: async (text: string) => {
      embedCalls.push(text);
      return angleVector(text);
    },
    generateExchangeEmbedding: async (user: string, assistant: string) =>
      angleVector(`${user} ${assistant}`),
  };
});

import { initDatabase } from '../src/db.js';
import { insertFact, searchFactsByScope } from '../src/fact-db.js';
import { deactivateFactTransactional, restoreFact } from '../src/fact-management.js';
import type DatabaseType from 'better-sqlite3';

function vec(angle: number): number[] {
  const v = new Array<number>(384).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
}

describe('inactive fact restore vs embedding model upgrade (P2-3)', () => {
  let db: DatabaseType.Database;
  let tmpDir: string;
  let oldDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-restore-'));
    oldDbPath = process.env.MEMEX_DB_PATH;
    process.env.MEMEX_DB_PATH = path.join(tmpDir, 'test.db');
    db = initDatabase();
    embedCalls.length = 0;
  });

  afterEach(() => {
    db.close();
    if (oldDbPath === undefined) delete process.env.MEMEX_DB_PATH;
    else process.env.MEMEX_DB_PATH = oldDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedFact(angle: number, opts: { embeddingVersion?: number } = {}): string {
    const id = insertFact(db, {
      fact: `fact@${angle}`,
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: vec(angle),
    });
    if (opts.embeddingVersion !== undefined) {
      db.prepare('UPDATE facts SET embedding_version = ? WHERE id = ?').run(opts.embeddingVersion, id);
    }
    return id;
  }

  it('re-embeds a stale-version fact on restore and makes it searchable immediately', async () => {
    const id = seedFact(0.3, { embeddingVersion: 999 }); // model upgraded while inactive
    deactivateFactTransactional(db, id);
    expect(embedCalls).toHaveLength(0);
    expect((db.prepare('SELECT COUNT(*) c FROM vec_facts WHERE id = ?').get(id) as { c: number }).c).toBe(0);

    const result = await restoreFact(db, id);

    expect(result).toEqual({ restored: true, vectorRestored: true, reembedded: true, eventId: expect.any(String) });
    expect(embedCalls).toEqual(['fact@0.3']); // re-embedded with the current model
    const row = db.prepare('SELECT embedding_version, is_active FROM facts WHERE id = ?').get(id) as {
      embedding_version: number;
      is_active: number;
    };
    expect(row.embedding_version).toBe(777); // vector + stamp restored together
    expect(row.is_active).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM vec_facts WHERE id = ?').get(id) as { c: number }).c).toBe(1);

    // The report's regression contract: searchable right after restore.
    const hits = searchFactsByScope(db, vec(0.3), { type: 'all' }, 5, 0.85);
    expect(hits.map((h) => h.fact.id)).toContain(id);
  });

  it('reuses the stored embedding without a model call when the version is current', async () => {
    const id = seedFact(0.5); // stamped with the current (mocked) version
    deactivateFactTransactional(db, id);

    const result = await restoreFact(db, id);

    expect(result).toEqual({ restored: true, vectorRestored: true, reembedded: false, eventId: expect.any(String) });
    expect(embedCalls).toHaveLength(0); // no re-embed — bytes are reusable
    const hits = searchFactsByScope(db, vec(0.5), { type: 'all' }, 5, 0.85);
    expect(hits.map((h) => h.fact.id)).toContain(id);
  });

  it('activates a fact without stored embedding and restores no vector', async () => {
    const id = insertFact(db, {
      fact: 'fact@0.7',
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: null,
    });
    deactivateFactTransactional(db, id);

    const result = await restoreFact(db, id);

    expect(result).toEqual({ restored: true, vectorRestored: false, reembedded: false, eventId: expect.any(String) });
    expect(embedCalls).toHaveLength(0);
    const row = db.prepare('SELECT is_active FROM facts WHERE id = ?').get(id) as { is_active: number };
    expect(row.is_active).toBe(1);
  });
});
