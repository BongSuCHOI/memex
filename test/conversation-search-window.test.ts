import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Deterministic angle-vector embedding: text "…@<angle>" maps to a unit
// vector [cos θ, sin θ, 0…]. L2 distance from the @0 query is monotone in θ,
// so tests can place rows at exact global ranks.
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
    EMBEDDING_MODEL: 'test-window-model',
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

import { initDatabase, insertExchange } from '../src/db.js';
import { searchConversations } from '../src/search.js';
import type { ConversationExchange } from '../src/types.js';
import type DatabaseType from 'better-sqlite3';

const DECOY_PROJECT = '/proj/decoy';
const TARGET_PROJECT = '/proj/target';
const DECOY_TS = '2030-01-01T00:00:00.000Z'; // outside every test date filter
const TARGET_TS = '2026-03-01T00:00:00.000Z';

function makeExchange(id: string, project: string, timestamp: string, angle: number): ConversationExchange {
  return {
    id,
    project,
    timestamp,
    userMessage: `probe@${angle}`,
    assistantMessage: `answer ${id}`,
    archivePath: `/tmp/archives/${id}.jsonl`,
    lineStart: 1,
    lineEnd: 2,
  };
}

describe('conversation vector search expanding KNN window (P1-9)', () => {
  let db: DatabaseType.Database;
  let tmpDir: string;
  let oldDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-window-'));
    oldDbPath = process.env.MEMEX_DB_PATH;
    process.env.MEMEX_DB_PATH = path.join(tmpDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    if (oldDbPath === undefined) delete process.env.MEMEX_DB_PATH;
    else process.env.MEMEX_DB_PATH = oldDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedDecoysAndTarget(decoyCount: number): void {
    for (let i = 0; i < decoyCount; i++) {
      // Angles grow with i → every decoy is closer to the @0 query than the
      // target at angle 0.9, so decoys always own the nearest ranks.
      insertExchange(db, makeExchange(`decoy-${i}`, DECOY_PROJECT, DECOY_TS, 0.01 + i * 0.01), (() => {
        const v = new Array<number>(384).fill(0);
        v[0] = Math.cos(0.01 + i * 0.01);
        v[1] = Math.sin(0.01 + i * 0.01);
        return v;
      })());
    }
    insertExchange(db, makeExchange('target', TARGET_PROJECT, TARGET_TS, 0.9), (() => {
      const v = new Array<number>(384).fill(0);
      v[0] = Math.cos(0.9);
      v[1] = Math.sin(0.9);
      return v;
    })());
  }

  it('project-scoped search rescues a target sitting at global rank limit+1', async () => {
    seedDecoysAndTarget(3);

    // Geometry sanity: unfiltered limit=3 returns only the three nearest
    // decoys (decoy-0 has the smallest angle → closest; the target at angle
    // 0.9 is genuinely rank 4 = limit+1); limit=4 finally surfaces it, last.
    const unfiltered = await searchConversations('probe@0', { limit: 3, mode: 'vector' });
    expect(unfiltered.map((r) => r.exchange.id)).toEqual(['decoy-0', 'decoy-1', 'decoy-2']);
    const deeper = await searchConversations('probe@0', { limit: 4, mode: 'vector' });
    expect(deeper[deeper.length - 1].exchange.id).toBe('target');

    // The fix: the scoped search must expand past the decoy-filled window.
    const scoped = await searchConversations('probe@0', { limit: 3, mode: 'vector', project: TARGET_PROJECT });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].exchange.id).toBe('target');
    expect(scoped[0].exchange.project).toBe(TARGET_PROJECT);
  });

  it('date-filtered search rescues a target hidden behind out-of-range candidates', async () => {
    seedDecoysAndTarget(3);

    const dated = await searchConversations('probe@0', { limit: 3, mode: 'vector', before: '2027-01-01' });
    expect(dated).toHaveLength(1);
    expect(dated[0].exchange.id).toBe('target');
    expect(dated[0].exchange.timestamp).toBe(TARGET_TS);
  });

  it('expands past the initial window when decoys alone exceed it', async () => {
    // 60 closer decoys > initial fetch window (max(limit*4, 50) = 50): the
    // first KNN pass cannot see the target; only the expansion loop can.
    seedDecoysAndTarget(60);

    const scoped = await searchConversations('probe@0', { limit: 3, mode: 'vector', project: TARGET_PROJECT });
    expect(scoped.map((r) => r.exchange.id)).toContain('target');
  });
});
