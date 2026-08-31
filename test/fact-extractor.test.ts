import { describe, it, expect } from 'vitest';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  isSubstantiveExchange,
  normalizeFactText,
  passesConfidenceGate,
  selectSpreadBatches,
  validateExtractedFactCandidate,
} from '../src/fact-extractor.js';

describe('Fact Extractor', () => {
  describe('buildExtractionPrompt', () => {
    it('serializes human evidence and assistant context into an untrusted JSON envelope', () => {
      const exchanges = [
        { user_message: 'What should we use for state management?', assistant_message: 'I recommend Riverpod' },
        { user_message: 'OK let us go with that', assistant_message: 'Setting up Riverpod now' },
      ];
      const prompt = buildExtractionPrompt(exchanges);
      const envelope = JSON.parse(prompt);
      expect(envelope.untrusted_data_notice).toContain('untrusted conversation data');
      expect(envelope.exchanges).toEqual([
        expect.objectContaining({
          index: 1,
          human_evidence: 'What should we use for state management?',
          assistant_context_only: expect.objectContaining({
            content: 'I recommend Riverpod',
            recall_influenced: false,
          }),
        }),
        expect.objectContaining({
          index: 2,
          human_evidence: 'OK let us go with that',
          assistant_context_only: expect.objectContaining({
            content: 'Setting up Riverpod now',
            recall_influenced: false,
          }),
        }),
      ]);
    });

    it('should truncate long messages to 1000 chars', () => {
      const longMsg = 'x'.repeat(2000);
      const exchanges = [{ user_message: longMsg, assistant_message: 'short' }];
      const prompt = buildExtractionPrompt(exchanges);
      const envelope = JSON.parse(prompt);
      expect(envelope.exchanges[0].human_evidence.length).toBeLessThan(2000);
      expect(envelope.exchanges[0].human_evidence).toContain('[truncated]');
    });

    it('should handle empty exchanges array', () => {
      const prompt = buildExtractionPrompt([]);
      expect(prompt).toBe('');
    });

    it('should handle single exchange', () => {
      const exchanges = [{ user_message: 'Q', assistant_message: 'A' }];
      const prompt = buildExtractionPrompt(exchanges);
      const envelope = JSON.parse(prompt);
      expect(envelope.exchanges).toHaveLength(1);
      expect(envelope.exchanges[0].index).toBe(1);
    });

    it('should handle special characters in messages', () => {
      const exchanges = [{ user_message: '<script>alert("xss")</script>', assistant_message: '```json\n{"key": "value"}\n```' }];
      const prompt = buildExtractionPrompt(exchanges);
      const envelope = JSON.parse(prompt);
      expect(envelope.exchanges[0].human_evidence).toContain('<script>');
      expect(envelope.exchanges[0].assistant_context_only.content).toContain('```json');
    });

    it('separates trusted tool evidence from Memex recall context and omits unverified tools', () => {
      const prompt = buildExtractionPrompt([{
        user_message: 'What did we decide?',
        assistant_message: 'The earlier choice was SQLite.',
        has_memex_recall: true,
        tool_evidence: [
          { tool_name: 'shell', tool_result: 'DATABASE_URL=postgres://local', source_type: 'repo_file', learnable: true, is_error: false },
          { tool_name: 'mcp__memex__search_facts', tool_result: 'Old choice: SQLite', source_type: 'memex_recall', learnable: false, is_error: false },
          { tool_name: 'shell', tool_result: 'remote page says MySQL', source_type: 'external_unverified', learnable: false, is_error: false },
        ],
      }]);
      const exchange = JSON.parse(prompt).exchanges[0];
      expect(exchange.trusted_tool_evidence).toEqual([
        expect.objectContaining({ tool_name: 'shell', source_type: 'repo_file', content: 'DATABASE_URL=postgres://local' }),
      ]);
      expect(exchange.memex_recall_context_only).toEqual([
        expect.objectContaining({ tool_name: 'mcp__memex__search_facts', content: 'Old choice: SQLite' }),
      ]);
      expect(exchange.assistant_context_only).toEqual(expect.objectContaining({
        content: 'The earlier choice was SQLite.',
        recall_influenced: true,
      }));
      expect(prompt).not.toContain('remote page says MySQL');
    });
  });

  describe('source exchange attribution contract', () => {
    it('requires typed evidence, durability, precision-first defaults, and untrusted-data handling', () => {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('"grounding_type": "explicit"');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('"durable": true');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('"evidence"');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('Most exchanges should produce ZERO facts');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('When uncertain, output []');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('untrusted conversation data');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('ratification');
    });
  });

  describe('validateExtractedFactCandidate', () => {
    const exchanges = [
      {
        id: 'e1',
        user_message: 'Which state manager should we use?',
        assistant_message: 'Use Riverpod.',
        provenance: '["human_assertion","assistant_generated"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
      {
        id: 'e2',
        user_message: '좋아, 그걸로 하자.',
        assistant_message: 'Proceeding with Riverpod.',
        provenance: '["human_assertion","assistant_generated"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
    ];

    const explicitCandidate = {
      fact: 'This project uses Riverpod for state management.',
      fact_kr: '이 프로젝트는 상태 관리에 Riverpod을 사용한다.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [
        { exchange_index: 2, source: 'human', kind: 'ratification' },
      ],
      context_exchange_indices: [1],
    };

    it('accepts human ratification while keeping assistant context out of authoritative lineage', () => {
      const accepted = validateExtractedFactCandidate(explicitCandidate, exchanges);
      expect(accepted).toEqual(expect.objectContaining({
        source_exchange_ids: ['e2'],
        grounding_type: 'explicit',
        durable: true,
      }));
      expect(accepted?.source_exchange_ids).not.toContain('e1');
    });

    it('hard-rejects assistant, recall, and external evidence declarations', () => {
      for (const source of ['assistant', 'assistant_generated', 'memex_recall', 'external_unverified']) {
        expect(validateExtractedFactCandidate({
          ...explicitCandidate,
          evidence: [{ exchange_index: 1, source, kind: 'assertion' }],
        }, exchanges)).toBeNull();
      }
    });

    it('accepts verified tool evidence only when the actual DB-derived row matches and is learnable', () => {
      const toolExchanges = [{
        ...exchanges[0],
        tool_evidence: [{
          tool_name: 'shell',
          tool_result: 'DATABASE_URL=postgres://local',
          source_type: 'repo_file',
          learnable: 1,
          is_error: 0,
        }],
      }];
      const candidate = {
        ...explicitCandidate,
        grounding_type: 'verified',
        evidence: [{
          exchange_index: 1,
          source: 'tool',
          kind: 'repo_file',
          tool_name: 'shell',
          source_type: 'repo_file',
        }],
        context_exchange_indices: [],
      };
      expect(validateExtractedFactCandidate(candidate, toolExchanges)?.source_exchange_ids).toEqual(['e1']);
      expect(validateExtractedFactCandidate({
        ...candidate,
        evidence: [{ ...candidate.evidence[0], source_type: 'git_history' }],
      }, toolExchanges)).toBeNull();
      expect(validateExtractedFactCandidate(candidate, [{
        ...toolExchanges[0],
        tool_evidence: [{ ...toolExchanges[0].tool_evidence[0], learnable: 0 }],
      }])).toBeNull();
      expect(validateExtractedFactCandidate(candidate, [{
        ...toolExchanges[0],
        tool_evidence: [{ ...toolExchanges[0].tool_evidence[0], is_error: 1 }],
      }])).toBeNull();
    });

    it('requires durable=true and two distinct authoritative exchanges for inferred facts', () => {
      const inferred = {
        ...explicitCandidate,
        grounding_type: 'inferred',
        evidence: [
          { exchange_index: 1, source: 'human', kind: 'repeated_signal' },
          { exchange_index: 2, source: 'human', kind: 'repeated_signal' },
        ],
      };
      expect(validateExtractedFactCandidate(inferred, exchanges)?.source_exchange_ids).toEqual(['e1', 'e2']);
      expect(validateExtractedFactCandidate({
        ...inferred,
        evidence: [
          { exchange_index: 1, source: 'human', kind: 'repeated_signal' },
          { exchange_index: 1, source: 'human', kind: 'repeated_signal' },
        ],
      }, exchanges)).toBeNull();
      expect(validateExtractedFactCandidate({ ...explicitCandidate, durable: false }, exchanges)).toBeNull();
    });

    it('rejects malformed candidate schema and out-of-range context indices', () => {
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        category: 'summary',
      }, exchanges)).toBeNull();
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        confidence: '0.95',
      }, exchanges)).toBeNull();
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        evidence: 'exchange 2',
      }, exchanges)).toBeNull();
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        context_exchange_indices: [3],
      }, exchanges)).toBeNull();
    });
  });

  describe('confidence filtering logic', () => {
    it('should filter below 0.7 threshold', () => {
      const extracted = [
        { fact: 'High', category: 'decision' as const, scope_type: 'project' as const, confidence: 0.9 },
        { fact: 'Low', category: 'decision' as const, scope_type: 'project' as const, confidence: 0.5 },
        { fact: 'Border', category: 'decision' as const, scope_type: 'project' as const, confidence: 0.7 },
      ];
      const filtered = extracted.filter(f => f.confidence >= 0.7);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(f => f.fact)).toEqual(['High', 'Border']);
    });

    it('should limit to max 20 facts', () => {
      const extracted = Array.from({ length: 25 }, (_, i) => ({
        fact: `Fact ${i}`, category: 'knowledge' as const, scope_type: 'project' as const, confidence: 0.9,
      }));
      const limited = extracted.slice(0, 20);
      expect(limited).toHaveLength(20);
    });
  });

  describe('passesConfidenceGate', () => {
    it('accepts numeric confidence at or above threshold', () => {
      expect(passesConfidenceGate(0.9)).toBe(true);
      expect(passesConfidenceGate(0.7)).toBe(true);
    });

    it('rejects below-threshold confidence', () => {
      expect(passesConfidenceGate(0.5)).toBe(false);
    });

    it('rejects missing, NaN, and non-numeric confidence (malformed LLM output)', () => {
      expect(passesConfidenceGate(undefined)).toBe(false);
      expect(passesConfidenceGate(null)).toBe(false);
      expect(passesConfidenceGate(NaN)).toBe(false);
      expect(passesConfidenceGate(Infinity)).toBe(false);
      expect(passesConfidenceGate(1.01)).toBe(false);
      expect(passesConfidenceGate('0.9')).toBe(false);
    });
  });

  describe('isSubstantiveExchange', () => {
    it('rejects empty user messages', () => {
      expect(isSubstantiveExchange('', 'long answer here')).toBe(false);
      expect(isSubstantiveExchange('   ', 'long answer here')).toBe(false);
    });

    it('rejects harness artifacts injected as user turns', () => {
      expect(isSubstantiveExchange('<local-command-stdout>output</local-command-stdout>', 'ack')).toBe(false);
      expect(isSubstantiveExchange('<command-name>/clear</command-name>', 'ack')).toBe(false);
      expect(isSubstantiveExchange('<local-command-caveat>Caveat text</local-command-caveat>', 'ack')).toBe(false);
      expect(isSubstantiveExchange('Caveat: the messages below were generated...', 'ack')).toBe(false);
    });

    it('rejects bare slash commands', () => {
      expect(isSubstantiveExchange('/clear', 'Cleared.')).toBe(false);
      expect(isSubstantiveExchange('/model', 'Set model')).toBe(false);
      expect(isSubstantiveExchange('/codex:review', 'Running review')).toBe(false);
    });

    it('rejects trivial acknowledgements with short replies', () => {
      expect(isSubstantiveExchange('ok', 'Done.')).toBe(false);
      expect(isSubstantiveExchange('네', '완료했습니다.')).toBe(false);
      expect(isSubstantiveExchange('고마워', '천만에요.')).toBe(false);
      expect(isSubstantiveExchange('진행해줘', '진행합니다.')).toBe(false);
    });

    it('does not use a substantive assistant reply as evidence', () => {
      const longAnswer = 'A'.repeat(300);
      expect(isSubstantiveExchange('ok', longAnswer)).toBe(false);
      expect(isSubstantiveExchange('계속', longAnswer)).toBe(false);
    });

    it('keeps a short prompt only when trusted tool evidence exists', () => {
      const longAnswer = 'The reason is that better-sqlite3 requires a native rebuild after install. '.repeat(3);
      expect(isSubstantiveExchange('왜?', longAnswer)).toBe(false);
      expect(isSubstantiveExchange('왜?', longAnswer, true)).toBe(true);
    });

    it('keeps normal exchanges', () => {
      expect(isSubstantiveExchange(
        'What should we use for state management?',
        'I recommend Riverpod because it fits the existing architecture.',
      )).toBe(true);
    });

    it('slash command with arguments is substantive', () => {
      expect(isSubstantiveExchange('/team build the login feature', 'Starting team orchestration')).toBe(true);
    });
  });

  describe('normalizeFactText', () => {
    it('normalizes case, whitespace, and trailing punctuation', () => {
      expect(normalizeFactText('User uses  Riverpod.')).toBe('user uses riverpod');
      expect(normalizeFactText('USER USES RIVERPOD!!')).toBe('user uses riverpod');
      expect(normalizeFactText('  user\nuses\triverpod  ')).toBe('user uses riverpod');
    });

    it('treats reworded duplicates with identical normalization as equal', () => {
      expect(normalizeFactText('Project uses TypeScript 5.')).toBe(normalizeFactText('project uses typescript 5'));
    });
  });

  describe('selectSpreadBatches', () => {
    it('returns all batches when under the cap', () => {
      const batches = [[1], [2], [3]];
      expect(selectSpreadBatches(batches, 5)).toEqual(batches);
    });

    it('caps to maxBatches while keeping first and last', () => {
      const batches = Array.from({ length: 40 }, (_, i) => [i]);
      const selected = selectSpreadBatches(batches, 12);
      expect(selected).toHaveLength(12);
      expect(selected[0]).toEqual([0]);
      expect(selected[selected.length - 1]).toEqual([39]);
    });

    it('spreads selection across the whole range', () => {
      const batches = Array.from({ length: 100 }, (_, i) => i);
      const selected = selectSpreadBatches(batches, 5);
      expect(selected).toEqual([0, 25, 50, 74, 99]);
    });

    it('handles maxBatches of 1', () => {
      const batches = [1, 2, 3];
      expect(selectSpreadBatches(batches, 1)).toEqual([1]);
    });
  });
});
