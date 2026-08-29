import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, statSync, utimesSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncConversations } from '../src/sync.js';
import { projectStorageKey } from '../src/project-identity.js';
import Database from 'better-sqlite3';

// 요약 내용은 LLM 결과라 테스트에서 결정론화한다 — freshness 판정(mtime)과
// 재생성 여부가 이 테스트의 관찰 대상이다.
vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async (exchanges: unknown[]) => `summary of ${exchanges.length} exchange(s)`),
}));

// Sync consumes Codex rollout transcripts found recursively under the session
// root. Project key = basename of session_meta.cwd; archive layout stays
// <project>/<file>.jsonl.

describe('sync command', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memex-sync-test-'));
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

    const destFile = join(destDir, projectStorageKey('/x/project-a'), 'rollout-one.jsonl');
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

    // CX-02: exclusion list is exact-match on the canonical project path;
    // a basename entry must not exclude an unrelated same-named project.
    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = '/x/project-a';
    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;

    expect(result.copied).toBe(1);
    expect(existsSync(join(destDir, projectStorageKey('/x/project-a')))).toBe(false);
    expect(existsSync(join(destDir, projectStorageKey('/x/project-b'), 'rollout-b-keep.jsonl'))).toBe(true);
    // basename-only entry does NOT match the canonical path: the previously
    // excluded project-a AND the new /y/other both get copied now.
    writeRollout('c-basename', '/y/other');
    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'other';
    const result2 = await syncConversations(sourceDir, destDir, { skipIndex: true });
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;
    expect(result2.copied).toBe(2);
    expect(existsSync(join(destDir, projectStorageKey('/y/other')))).toBe(true);

    // canonical exact-match entry DOES exclude its own project only.
    writeRollout('d-other2', '/y/other');
    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = '/y/other';
    const result3 = await syncConversations(sourceDir, destDir, { skipIndex: true });
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;
    expect(result3.copied).toBe(0);
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

  it('regenerates a stale summary when the archive grew (재감사 §6 — sync 경로)', async () => {
    // syncConversations도 summaryNeedsRefresh를 써야 한다 — 존재 여부만 보던
    // 이전 구현은 resume으로 자란 rollout의 요약을 영구히 stale로 두었다.
    const src = writeRollout('fresh', '/x/project-a');
    const first = await syncConversations(sourceDir, destDir);
    expect(first.summarized).toBe(1);

    const destFile = join(destDir, projectStorageKey('/x/project-a'), 'rollout-fresh.jsonl');
    const summaryPath = destFile.replace('.jsonl', '-summary.txt');
    expect(existsSync(summaryPath)).toBe(true);
    const firstSummary = readFileSync(summaryPath, 'utf-8');

    // rollout resume: 새 턴(user+assistant)이 붙어 archive가 자란다.
    appendFileSync(
      src,
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Follow-up' }] },
      }) + '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Follow-up answer' }] },
      }) + '\n',
      'utf-8',
    );

    const second = await syncConversations(sourceDir, destDir);
    expect(second.summarized).toBe(1); // summary가 존재해도 stale면 재생성
    expect(readFileSync(summaryPath, 'utf-8')).not.toBe(firstSummary);
  });

  it('reindexes current archives when the database was deleted', async () => {
    writeRollout('recover', '/x/recovery-project');
    const first = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(first.indexed).toBe(1);

    unlinkSync(dbPath);
    const recovered = await syncConversations(sourceDir, destDir, { skipSummaries: true });
    expect(recovered.copied).toBe(0);
    expect(recovered.skipped).toBe(1);
    expect(recovered.indexed).toBe(1);

    const dbCheck = new Database(dbPath, { readonly: true });
    try {
      expect(dbCheck.prepare('SELECT COUNT(*) AS count FROM exchanges').get()).toEqual({ count: 1 });
    } finally {
      dbCheck.close();
    }
  });
});
