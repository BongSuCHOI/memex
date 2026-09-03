import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversationFile } from '../src/parser.js';
import { getFixturePath } from './test-utils.js';

const codexFixture = getFixturePath('codex-rollout.jsonl');

describe('Parser - Codex rollout', () => {
  it('should parse file successfully', async () => {
    const result = await parseConversationFile(codexFixture);
    expect(result).toBeDefined();
    expect(result.exchanges).toBeDefined();
    expect(result.project).toBe('/workspaces/fixtures');
  });

  it('should extract metadata from session_meta onto every exchange', async () => {
    const result = await parseConversationFile(codexFixture);
    expect(result.exchanges.length).toBeGreaterThan(0);
    for (const ex of result.exchanges) {
      expect(ex.timestamp).toBeDefined();
      expect(ex.sessionId).toBe('sess-fix-1');
      expect(ex.cwd).toBe('/workspaces/fixtures');
      expect(ex.exchangeSeq).toBeGreaterThan(0);
      expect(ex.parserVersion).toBe(2);
      expect(['closed', 'interrupted']).toContain(ex.closureState);
    }
  });

  it('marks an EOF exchange with an unfinished tool call interrupted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-parser-open-'));
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'open-s', cwd: '/work/open' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"npm test"}' } }),
    ].join('\n') + '\n');
    try {
      const result = await parseConversationFile(file);
      expect(result.exchanges).toHaveLength(1);
      expect(result.exchanges[0]).toMatchObject({
        exchangeSeq: 1,
        closureState: 'interrupted',
        parserVersion: 2,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should extract user and assistant messages in order', async () => {
    const result = await parseConversationFile(codexFixture);
    expect(result.exchanges.length).toBe(2);

    expect(result.exchanges[0].userMessage).toContain('pagination does list.ts use?');
    expect(result.exchanges[0].assistantMessage).toContain('keyset pagination with a cursor.');

    expect(result.exchanges[1].userMessage).toContain('gotchas');
    expect(result.exchanges[1].assistantMessage).toContain('WHERE clause ordering.');
  });

  it('should collect tool calls and attach them to the exchange', async () => {
    const result = await parseConversationFile(codexFixture);
    const toolCalls = result.exchanges.flatMap((ex) => ex.toolCalls ?? []);
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].toolName).toBe('shell');
    expect((toolCalls[0].toolInput as Record<string, unknown>)).toMatchObject({ cmd: 'grep keyset src/list.ts' });
  });

  it('should filter harness context user turns', async () => {
    const result = await parseConversationFile(codexFixture);
    const all = JSON.stringify(result.exchanges);
    expect(all).not.toContain('<codex_internal_context>');
  });

  it('keeps same-basename projects distinct by canonical session cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-parser-identity-'));
    const writeRollout = (name: string, sessionId: string, cwd: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: sessionId, session_id: sessionId, cwd, source: 'cli' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] },
        }),
      ].join('\n') + '\n');
      return file;
    };

    try {
      const first = await parseConversationFile(
        writeRollout('rollout-a.jsonl', 'session-a', '/work/team-a/shared/'),
      );
      const second = await parseConversationFile(
        writeRollout('rollout-b.jsonl', 'session-b', '/work/team-b/shared'),
      );

      expect(first.project).toBe('/work/team-a/shared');
      expect(second.project).toBe('/work/team-b/shared');
      expect(first.project).not.toBe(second.project);
      expect(first.exchanges.every((exchange) => exchange.project === first.project)).toBe(true);
      expect(second.exchanges.every((exchange) => exchange.project === second.project)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Parser - error handling', () => {
  it('should throw on non-existent file', async () => {
    await expect(parseConversationFile('/nonexistent/file.jsonl')).rejects.toThrow();
  });

  it('should tolerate malformed lines inside a rollout', async () => {
    const result = await parseConversationFile(codexFixture);
    // Fixture itself is well-formed; per-line tolerance is exercised in
    // test/codex-slice.test.mjs with corrupted-line fixtures.
    expect(result.exchanges.length).toBeGreaterThan(0);
  });
});
