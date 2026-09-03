import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'test',
}));

import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { handleToolCall } from '../src/mcp-server.js';

describe('MCP scope-aware fact search', () => {
  let db: Database.Database;
  let testDir: string;
  const embedding = new Array(384).fill(0.1);

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fact-scope-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('search_facts(scope=global) reaches a global fact behind a project crowd', async () => {
    for (let i = 0; i < 240; i++) {
      insertFact(db, {
        fact: `project crowd ${i}`,
        category: 'decision',
        scope_type: 'project',
        scope_project: `/project-${i}`,
        source_exchange_ids: [],
        embedding,
      });
    }
    insertFact(db, {
      fact: 'global target decision',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.101),
    });

    const response = await handleToolCall('search_facts', {
      query: 'global target decision',
      scope: 'global',
      limit: 5,
    });
    const text = response.content[0].text;

    expect(response.isError).not.toBe(true);
    expect(text).toContain('global target decision');
    expect(text).toContain('Results: 1');
    expect(text).not.toContain('project crowd');
  });

  it('search_facts applies category before limit', async () => {
    for (let i = 0; i < 60; i++) {
      insertFact(db, {
        fact: `decision crowd ${i}`,
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding,
      });
    }
    insertFact(db, {
      fact: 'global preference target',
      category: 'preference',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.101),
    });

    const response = await handleToolCall('search_facts', {
      query: 'global preference target',
      scope: 'global',
      category: 'preference',
      limit: 1,
    });
    const text = response.content[0].text;

    expect(response.isError).not.toBe(true);
    expect(text).toContain('global preference target');
    expect(text).toContain('Results: 1');
    expect(text).not.toContain('decision crowd');
  });
});
