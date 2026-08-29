import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 재감사 §6 freshness — rollout이 resume으로 길어지면 요약을 재생성한다.
 *
 * 구동작은 summary 파일 존재 여부만 검사했으므로, resume으로 길어진 rollout의
 * 잘린 요약이 영원히 재사용됐다. 수정 후 계약: 아카이브 mtime이 요약보다 새로우면
 * 재색인 경로가 요약을 재생성한다.
 */

const { summaryQueue, summaryCalls } = vi.hoisted(() => ({
  summaryQueue: [] as string[],
  summaryCalls: [] as string[],
}));

vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: async () => {
    const next = summaryQueue.shift() ?? 'fallback summary';
    summaryCalls.push(next);
    return next;
  },
}));

vi.mock('../src/embeddings.js', async (io) => ({
  ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => Array.from({ length: 384 }, () => 0.01),
  generateExchangeEmbedding: async () => Array.from({ length: 384 }, () => 0.01),
}));

import { summaryNeedsRefresh } from '../src/archive-io.js';
import { indexSession } from '../src/indexer.js';

const SESSION_ID = '02b00007-aaaa-4bbb-8ccc-ccccccccccc8';
const PROJECT = '/tmp/summary-freshness/project';

function userTurn(text: string, ts: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }) + '\n';
}

function assistantTurn(text: string, ts: string): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  }) + '\n';
}

describe('summary freshness on resumed rollouts (재감사 §6)', () => {
  let home: string;
  let sessions: string;
  let prior: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-fresh-'));
    sessions = path.join(home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    prior = {
      MEMEX_HOME: process.env.MEMEX_HOME,
      MEMEX_DB_PATH: process.env.MEMEX_DB_PATH,
      TEST_SESSIONS_DIR: process.env.TEST_SESSIONS_DIR,
    };
    process.env.MEMEX_HOME = home;
    process.env.MEMEX_DB_PATH = path.join(home, 'conversation-index', 'db.sqlite');
    process.env.TEST_SESSIONS_DIR = sessions;
    summaryQueue.length = 0;
    summaryCalls.length = 0;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('summaryNeedsRefresh (decision helper)', () => {
    it('is true when the summary is missing', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-fresh-unit-'));
      try {
        const archive = path.join(dir, 'a.jsonl');
        fs.writeFileSync(archive, '{}\n');
        const summary = path.join(dir, 'a-summary.txt');
        expect(summaryNeedsRefresh(archive, summary)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('is false while the archive has not changed since the summary', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-fresh-unit-'));
      try {
        const archive = path.join(dir, 'a.jsonl');
        const summary = path.join(dir, 'a-summary.txt');
        fs.writeFileSync(archive, '{}\n');
        fs.writeFileSync(summary, 'current summary');
        const base = Date.now() - 10_000;
        fs.utimesSync(archive, new Date(base), new Date(base));
        fs.utimesSync(summary, new Date(base + 5_000), new Date(base + 5_000));
        expect(summaryNeedsRefresh(archive, summary)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('is true when the archive grew after the summary was written', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-fresh-unit-'));
      try {
        const archive = path.join(dir, 'a.jsonl');
        const summary = path.join(dir, 'a-summary.txt');
        fs.writeFileSync(archive, '{}\n');
        fs.writeFileSync(summary, 'stale summary');
        const base = Date.now() - 10_000;
        fs.utimesSync(summary, new Date(base), new Date(base));
        fs.utimesSync(archive, new Date(base + 5_000), new Date(base + 5_000));
        expect(summaryNeedsRefresh(archive, summary)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('indexSession regenerates the summary after a resume grows the rollout', async () => {
    const transcript = path.join(sessions, `rollout-2026-08-30T01-00-00-${SESSION_ID}.jsonl`);
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: SESSION_ID, cwd: PROJECT } }),
        userTurn('First question about the deploy pipeline.', '2026-08-30T01:01:00.000Z'),
        assistantTurn('First answer.', '2026-08-30T01:02:00.000Z'),
      ].join('\n'),
    );

    summaryQueue.push('summary v1');
    await indexSession(SESSION_ID, 1, false);

    const archiveDir = path.join(home, 'conversation-archive');
    const projectName = fs.readdirSync(archiveDir)[0];
    const archive = path.join(archiveDir, projectName, path.basename(transcript));
    const summary = archive.replace(/\.jsonl$/, '-summary.txt');
    expect(fs.existsSync(summary)).toBe(true);
    expect(fs.readFileSync(summary, 'utf-8')).toBe('summary v1');
    expect(summaryCalls).toEqual(['summary v1']);

    // Resume: the rollout grows. The next indexing pass must regenerate.
    fs.appendFileSync(
      transcript,
      userTurn('Follow-up about the rollback plan.', '2026-08-30T01:05:00.000Z') +
        assistantTurn('Second answer.', '2026-08-30T01:06:00.000Z'),
    );
    summaryQueue.push('summary v2');
    await indexSession(SESSION_ID, 1, false);
    expect(fs.readFileSync(summary, 'utf-8')).toBe('summary v2');

    // No further change → no regeneration (the summary stays current).
    await indexSession(SESSION_ID, 1, false);
    expect(summaryCalls).toEqual(['summary v1', 'summary v2']);
  });
});
