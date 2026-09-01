import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_POLICY_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  FACT_ENTAILMENT_VERIFIER_PROMPT,
  buildExtractionPrompt,
  selectLongRangeReferentCandidates,
  validateExtractedFactCandidate,
  type LongRangeReferentCandidate,
} from '../src/fact-extractor.js';

const base = (id: string, user: string, assistant: string, extra = {}) => ({
  id,
  user_message: user,
  assistant_message: assistant,
  provenance: '["human_assertion","assistant_generated"]',
  assistant_learnable: 0,
  has_memex_recall: 0,
  tool_evidence: [],
  ...extra,
});

describe('P2 long-range context and global scope', () => {
  it('publishes the complete subject-based scope and long-range prompt policy', () => {
    expect(EXTRACTION_POLICY_VERSION).toBe('precision-durability-v4');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('## Scope determination');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Conversation location does not determine scope');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('A statement does NOT need to mention multiple projects explicitly to be global');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('I use a Mac.');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('I am interested in philosophy.');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Nietzsche');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('## Long-range context');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('If multiple earlier candidates could plausibly be the referent');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('workflow_reference | recall_reference');
    expect(FACT_ENTAILMENT_VERIFIER_PROMPT).toContain('conversation location');
    expect(FACT_ENTAILMENT_VERIFIER_PROMPT).toContain('multiple plausible');
  });

  it('activates a bounded selector and keeps the first recommendation among competing alternatives', () => {
    const session = [
      base('e1', 'Which state manager fits?', 'I recommend Riverpod for this app.'),
      base('e2', 'What are its tradeoffs?', 'Riverpod is testable but adds providers.'),
      base('e3', 'Compare another option.', 'Bloc is another option.'),
      base('e4', 'Any simpler option?', 'Provider is the simplest option.'),
      base('e5', 'What about testing?', 'All three can be tested.'),
      base('e6', 'Summarize the tradeoffs.', 'Riverpod balances the constraints best.'),
      base('e7', 'Anything else?', 'No additional blocker.'),
      base('e8', '그럼 처음 추천한 걸로 하자.', 'Riverpod으로 진행하겠습니다.'),
    ];

    const candidates = selectLongRangeReferentCandidates([session[7]], session);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(candidates[0]).toEqual(expect.objectContaining({
      exchange_id: 'e1',
      source: 'assistant_context_only',
    }));
    expect(candidates[0].content).toContain('Riverpod');
    expect(candidates.every((entry) => entry.distance > 0 && entry.distance <= 30)).toBe(true);
  });

  it('does not retrieve context for a standalone explicit global assertion', () => {
    const session = [
      base('e1', 'What machine do you use?', 'Tell me when useful.'),
      base('e2', '난 Mac을 사용해.', '기억하겠습니다.'),
    ];
    expect(selectLongRangeReferentCandidates([session[1]], session)).toEqual([]);
  });

  it('lets a cross-language explicit global assertion reach semantic verification', () => {
    const exchanges = [base('g1', '난 철학에 관심이 있어.', '기억하겠습니다.')];
    const accepted = validateExtractedFactCandidate({
      fact: 'The user is interested in philosophy.',
      category: 'preference',
      scope_type: 'global',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'assertion',
        supporting_span: '난 철학에 관심이 있어.',
      }],
    }, exchanges);

    expect(accepted).toEqual(expect.objectContaining({
      fact: 'The user is interested in philosophy.',
      scope_type: 'global',
      source_exchange_ids: ['g1'],
    }));
  });

  it('allows an explicit human adoption to bind context without requiring the ratification label', () => {
    const exchanges = [base(
      'a8',
      '지금 방식이 딱 좋네. 앞으로도 계속 이렇게 해줘.',
      '앞으로 이 응답 스타일을 유지하겠습니다.',
    )];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-style',
      exchange_id: 'a3',
      anchor_exchange_ids: ['a8'],
      distance: 5,
      source: 'assistant_context_only',
      human_context: '예시는 조금 더 줘.',
      content: '간결한 설명에 구체적인 예시를 추가했습니다.',
      context_only_due_to_watermark: false,
    }];

    const accepted = validateExtractedFactCandidate({
      fact: 'The user prefers concise responses with concrete examples.',
      category: 'preference',
      scope_type: 'global',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.96,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'assertion',
        supporting_span: '지금 방식이 딱 좋네. 앞으로도 계속 이렇게 해줘.',
      }],
      context_dependencies: [{
        context_id: 'ctx-style',
        relation: 'style_reference',
      }],
    }, exchanges, referents);

    expect(accepted).toEqual(expect.objectContaining({
      source_exchange_ids: ['a8'],
      context_dependencies: [{
        exchange_id: 'a3',
        dependency_kind: 'style_reference',
      }],
    }));
  });

  it('separates local evidence from non-authoritative referent candidates in the envelope', () => {
    const local = [base('e8', '처음 추천한 걸로 하자.', 'Riverpod으로 진행합니다.')];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-1',
      exchange_id: 'e1',
      anchor_exchange_ids: ['e8'],
      distance: 7,
      source: 'assistant_context_only',
      human_context: 'Which state manager fits?',
      content: 'I recommend Riverpod for this app.',
      context_only_due_to_watermark: true,
    }];

    const envelope = JSON.parse(buildExtractionPrompt(local, referents));
    expect(envelope.local_exchanges).toHaveLength(1);
    expect(envelope.local_exchanges[0].human_evidence).toBe('처음 추천한 걸로 하자.');
    expect(envelope.referent_candidates).toEqual([expect.objectContaining({
      context_id: 'ctx-1',
      source: 'assistant_context_only',
      content: 'I recommend Riverpod for this app.',
      context_only_due_to_watermark: true,
    })]);
    expect(envelope.referent_candidates[0]).not.toHaveProperty('exchange_id');
  });

  it('resolves a long-range dependency to UUID without adding it to authority lineage', () => {
    const local = [base('e8', '그럼 처음 추천한 걸로 하자.', 'Riverpod으로 진행합니다.')];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-1',
      exchange_id: 'e1',
      anchor_exchange_ids: ['e8'],
      distance: 7,
      source: 'assistant_context_only',
      human_context: 'Which state manager fits?',
      content: 'I recommend Riverpod for this app.',
      context_only_due_to_watermark: true,
    }];
    const accepted = validateExtractedFactCandidate({
      fact: 'This project uses Riverpod for state management.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'ratification',
        supporting_span: '그럼 처음 추천한 걸로 하자.',
      }],
      context_dependencies: [{
        context_id: 'ctx-1',
        relation: 'ratified_proposition',
      }],
    }, local, referents);

    expect(accepted).toEqual(expect.objectContaining({
      source_exchange_ids: ['e8'],
      context_dependencies: [{
        exchange_id: 'e1',
        dependency_kind: 'ratified_proposition',
      }],
    }));
    expect(accepted?.source_exchange_ids).not.toContain('e1');
  });

  it('fails closed for unknown, duplicate, after-anchor, and over-cap dependencies', () => {
    const local = [base('e8', '그걸로 하자.', '진행합니다.')];
    const referent = (id: string, exchangeId: string, anchors = ['e8']): LongRangeReferentCandidate => ({
      context_id: id,
      exchange_id: exchangeId,
      anchor_exchange_ids: anchors,
      distance: 3,
      source: 'assistant_context_only',
      human_context: '',
      content: `Proposal ${id}`,
      context_only_due_to_watermark: false,
    });
    const referents = [
      referent('ctx-1', 'e1'),
      referent('ctx-2', 'e2'),
      referent('ctx-3', 'e3'),
      referent('ctx-4', 'e4'),
      referent('ctx-after', 'e9', []),
    ];
    const candidate = {
      fact: 'This project adopts Proposal ctx-1.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{ exchange_index: 1, source: 'human', kind: 'ratification', supporting_span: '그걸로 하자.' }],
    };

    for (const context_dependencies of [
      [{ context_id: 'missing', relation: 'ratified_proposition' }],
      [{ context_id: 'ctx-1', relation: 'ratified_proposition' }, { context_id: 'ctx-1', relation: 'ratified_proposition' }],
      [{ context_id: 'ctx-after', relation: 'ratified_proposition' }],
      ['ctx-1', 'ctx-2', 'ctx-3', 'ctx-4'].map((context_id) => ({ context_id, relation: 'ratified_proposition' })),
    ]) {
      expect(validateExtractedFactCandidate({ ...candidate, context_dependencies }, local, referents)).toBeNull();
    }
  });
});
