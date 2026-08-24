import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatConversationAsMarkdown, formatConversationAsHTML } from '../src/show.js';

// Single fixture: compact Codex rollout (session_meta + response_item records).
// sess-fix-1 / /workspaces/fixtures / cli 0.149.0
// Two exchanges, one shell tool call (call-1) with output, one filtered
// internal-context turn.
const fixturesDir = join(import.meta.dirname, 'fixtures');
const codexJsonl = () => readFileSync(join(fixturesDir, 'codex-rollout.jsonl'), 'utf-8');

describe('show command - markdown formatting', () => {
  it('should render user and assistant messages from a Codex rollout', () => {
    const markdown = formatConversationAsMarkdown(codexJsonl());
    expect(markdown).toMatch(/\*\*User\*\*/);
    expect(markdown).toContain('What pagination does list.ts use?');
    expect(markdown).toMatch(/\*\*Agent\*\*/);
    expect(markdown).toContain('keyset pagination with a cursor.');
    expect(markdown).toContain('Watch the WHERE clause ordering.');
  });

  it('should include tool calls in the output', () => {
    const markdown = formatConversationAsMarkdown(codexJsonl());
    expect(markdown).toContain('**Tool Use:** `shell`');
    expect(markdown).toContain('grep keyset src/list.ts');
    expect(markdown).toContain('keyset pagination with cursor');
  });

  it('should include session metadata', () => {
    const markdown = formatConversationAsMarkdown(codexJsonl());
    expect(markdown).toContain('**Session ID:** sess-fix-1');
    expect(markdown).toContain('**Working Directory:** /workspaces/fixtures');
    expect(markdown).toContain('**Codex CLI Version:** 0.149.0');
  });
});

describe('show command - edge cases', () => {
  it('should return empty string for empty input', () => {
    expect(formatConversationAsMarkdown('')).toBe('');
  });

  it('should return empty string for whitespace-only input', () => {
    expect(formatConversationAsMarkdown('   \n  \n  ')).toBe('');
  });

  it('should return empty string for malformed JSON lines', () => {
    expect(formatConversationAsMarkdown('not json\nalso not json')).toBe('');
  });

  it('should handle startLine and endLine range', () => {
    const markdown = formatConversationAsMarkdown(codexJsonl(), 2, 4);
    expect(markdown).toBeTruthy();
  });

  it('should handle out-of-bounds line range gracefully', () => {
    const jsonl = codexJsonl();
    const markdown = formatConversationAsMarkdown(jsonl, 999, 1005);
    expect(markdown).toBe('');
  });

  it('should skip internal context user turns', () => {
    const markdown = formatConversationAsMarkdown(codexJsonl());
    expect(markdown).not.toContain('<codex_internal_context>');
  });

  it('should surface the Codex CLI version label', () => {
    const markdown = formatConversationAsMarkdown(codexJsonl());
    expect(markdown).toContain('Codex CLI Version:** 0.149.0');
  });
});

describe('show command - HTML formatting', () => {
  it('should generate valid HTML with DOCTYPE and metadata', () => {
    const html = formatConversationAsHTML(codexJsonl());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('sess-fix-1');
  });

  it('should render user and assistant messages', () => {
    const html = formatConversationAsHTML(codexJsonl());
    expect(html).toContain('What pagination does list.ts use?');
    expect(html).toContain('keyset pagination with a cursor.');
  });

  it('should render tool calls with proper formatting', () => {
    const html = formatConversationAsHTML(codexJsonl());
    expect(html).toContain('Tool Use');
  });

  it('should surface the Codex CLI version label', () => {
    const html = formatConversationAsHTML(codexJsonl());
    expect(html).toContain('Codex CLI Version');
  });
});
