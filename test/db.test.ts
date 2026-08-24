import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, insertExchange } from '../src/db.js';
import { ConversationExchange } from '../src/types.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Suppress console output for clean test runs
const restoreConsole = suppressConsole();

describe('insertExchange with last_indexed', () => {
  const testDir = path.join(os.tmpdir(), 'insert-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('sets last_indexed timestamp when inserting exchange', () => {
    const db = initDatabase();

    const exchange: ConversationExchange = {
      id: 'test-id-1',
      project: 'test-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello',
      assistantMessage: 'Hi there!',
      archivePath: '/test/path.jsonl',
      lineStart: 1,
      lineEnd: 2
    };

    const beforeInsert = Date.now();
    // Create proper 384-dimensional embedding
    const embedding = new Array(384).fill(0.1);
    insertExchange(db, exchange, embedding);
    const afterInsert = Date.now();

    // Query the exchange
    const row = db.prepare(`SELECT last_indexed FROM exchanges WHERE id = ?`).get('test-id-1') as any;

    expect(row.last_indexed).toBeDefined();
    expect(row.last_indexed).toBeGreaterThanOrEqual(beforeInsert);
    expect(row.last_indexed).toBeLessThanOrEqual(afterInsert);

    db.close();
  });

  it('preserves rowid when re-indexing an existing exchange', () => {
    const db = initDatabase();
    const embedding = new Array(384).fill(0.1);
    const exchange: ConversationExchange = {
      id: 'stable-rowid',
      project: 'test-project',
      timestamp: '2026-08-24T00:00:00Z',
      userMessage: 'Original user message',
      assistantMessage: 'Original answer',
      archivePath: '/test/rollout.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sessionId: 'stable-session',
    };

    insertExchange(db, exchange, embedding);
    const before = db.prepare('SELECT rowid FROM exchanges WHERE id = ?')
      .get(exchange.id) as { rowid: number };
    insertExchange(db, { ...exchange, assistantMessage: 'Updated answer', lineEnd: 3 }, embedding);
    const after = db.prepare('SELECT rowid, assistant_message FROM exchanges WHERE id = ?')
      .get(exchange.id) as { rowid: number; assistant_message: string };

    expect(after.rowid).toBe(before.rowid);
    expect(after.assistant_message).toBe('Updated answer');
    db.close();
  });
});
