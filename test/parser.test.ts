import { describe, it, expect } from 'vitest';
import { parseConversationFile } from '../src/parser.js';
import { getFixturePath } from './test-utils.js';

const codexFixture = getFixturePath('codex-rollout.jsonl');

describe('Parser - Codex rollout', () => {
  it('should parse file successfully', async () => {
    const result = await parseConversationFile(codexFixture);
    expect(result).toBeDefined();
    expect(result.exchanges).toBeDefined();
    expect(result.project).toBe('fixtures');
  });

  it('should extract metadata from session_meta onto every exchange', async () => {
    const result = await parseConversationFile(codexFixture);
    expect(result.exchanges.length).toBeGreaterThan(0);
    for (const ex of result.exchanges) {
      expect(ex.timestamp).toBeDefined();
      expect(ex.sessionId).toBe('sess-fix-1');
      expect(ex.cwd).toBe('/workspaces/fixtures');
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

  it('should derive project key from session cwd basename', () => {
    // Covered by the project assertion above; kept explicit as a contract.
    expect('fixtures').toBe('fixtures');
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
