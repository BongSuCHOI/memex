import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncConversations } from '../src/sync.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Sync consumes Codex rollout transcripts found recursively under the session
// root. Project key = basename of session_meta.cwd; archive layout stays
// <project>/<file>.jsonl.

describe('sync command', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memory-bank-sync-test-'));
    sourceDir = join(testDir, 'source');
    destDir = join(testDir, 'dest');
    dbPath = join(testDir, 'test.db');

    mkdirSync(join(sourceDir, '2026', '08', '24'), { recursive: true });

    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  /** Write one minimal-but-valid rollout transcript into the session tree. */
  function writeRollout(name: string, projectCwd: string, body?: string): string {
    const day = join(sourceDir, '2026', '08', '24');
    const file = join(day, `rollout-${name}.jsonl`);
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-08-24T01:00:00Z',
        payload: { id: `thr-${name}`, session_id: `sess-${name}`, cwd: projectCwd, source: 'cli' },
      }),
    ];
    if (body !== undefined) {
      lines.push(body); // pre-rendered extra records (marker cases etc.)
    } else {
      lines.push(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Question ${name}` }] },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Answer ${name}` }] },
        }),
      );
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
    return file;
  }

  it('should copy new files from source to destination', async () => {
    const src = writeRollout('one', '/x/project-a');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);

    const destFile = join(destDir, 'project-a', 'rollout-one.jsonl');
    expect(statSync(destFile).isFile()).toBe(true);
    expect(src).toContain('rollout-one.jsonl');
  });

  it('should skip files that have not been modified', async () => {
    writeRollout('keep', '/x/project-a');

    await syncConversations(sourceDir, destDir, { skipIndex: true });

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('should copy files that were modified after previous sync', async () => {
    const src = writeRollout('bump', '/x/project-a');

    await syncConversations(sourceDir, destDir, { skipIndex: true });

    const now = new Date();
    const future = new Date(now.getTime() + 5000);
    writeFileSync(src, '{"type":"session_meta","payload":{"cwd":"/x/project-a"}}\n', 'utf-8');
    utimesSync(src, future, future);

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('should handle multiple projects', async () => {
    writeRollout('a1', '/x/project-a');
    writeRollout('b1', '/x/project-b');
    writeRollout('c1', '/x/project-c');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('should only sync rollout jsonl files', async () => {
    const day = join(sourceDir, '2026', '08', '24');
    writeFileSync(join(day, 'rollout-good.jsonl'), '{}\n', 'utf-8');
    writeFileSync(join(day, 'notes.txt'), 'bad', 'utf-8');
    writeFileSync(join(day, 'data.json'), 'bad', 'utf-8');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(1);
  });

  it('should skip excluded projects', async () => {
    writeRollout('a-excl', '/x/project-a');
    writeRollout('b-keep', '/x/project-b');

    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'project-a';
    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;

    expect(result.copied).toBe(1);
    expect(existsSync(join(destDir, 'project-a'))).toBe(false);
    expect(existsSync(join(destDir, 'project-b', 'rollout-b-keep.jsonl'))).toBe(true);
  });

  it('should skip indexing conversations with DO NOT INDEX marker', async () => {
    const markerBody = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>\nSummarize this conversation...',
          }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Summary of conversation' }] },
      }),
    ].join('\n');
    writeRollout('marked', '/x/project-a', markerBody);
    writeRollout('normal', '/x/project-a');

    // Initialize test database
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE exchanges (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL,
        assistant_message TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        last_indexed INTEGER
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE vec_exchanges USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      )
    `);
    db.close();

    // Sync with indexing enabled
    const result = await syncConversations(sourceDir, destDir);

    // Both files should be copied
    expect(result.copied).toBe(2);

    // But only normal conversation should be indexed
    expect(result.indexed).toBe(1);

    // Verify in database
    const dbCheck = new Database(dbPath, { readonly: true });
    const count = dbCheck.prepare('SELECT COUNT(*) as count FROM exchanges').get() as { count: number };
    dbCheck.close();

    expect(count.count).toBe(1); // Only normal conversation indexed
  });
});
