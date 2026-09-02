import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_POLICY_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  FACT_ENTAILMENT_VERIFIER_PROMPT,
  buildExtractionWindows,
  buildExtractionPrompt,
  selectLongRangeReferentCandidates,
  validateExtractedFactCandidate,
  verifyAndCanonicalizeExtractedFactCandidates,
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

  it('retrieves a human-origin referent without requiring an allowlisted phrase', () => {
    const session = [
      base('e1', '이 프로젝트는 DB 선택을 SQLite로 결정하자.', '좋습니다.'),
      base('e2', '마이그레이션 비용은?', '별도 migration은 필요 없습니다.'),
      base('e3', '운영 문서를 정리해줘.', '정리했습니다.'),
      base('e4', '테스트 상태는?', '통과했습니다.'),
      base('e5', '배포 절차도 확인해줘.', '확인했습니다.'),
      base('e6', '남은 위험은?', '없습니다.'),
      base('e7', '마지막으로 요약해줘.', '준비됐습니다.'),
      base('e8', 'DB 원안 유지.', '기존 결정을 유지하겠습니다.'),
    ];

    const candidates = selectLongRangeReferentCandidates([session[7]], session);

    expect(candidates[0]).toEqual(expect.objectContaining({
      exchange_id: 'e1',
      human_context: '이 프로젝트는 DB 선택을 SQLite로 결정하자.',
    }));
  });

  it('retrieves an open-vocabulary Korean recommendation for a deictic approval', () => {
    const session = [
      base('e1', '현재 규모에 맞는 저장소는?', '이 정도 규모라면 SQLite 쪽이 더 적합합니다.'),
      ...Array.from({ length: 6 }, (_, index) =>
        base(`e${index + 2}`, `중간 점검 ${index + 1}`, '특이사항은 없습니다.'),
      ),
      base('e8', '그걸로 하자.', 'SQLite로 진행하겠습니다.'),
    ];

    const candidates = selectLongRangeReferentCandidates([session[7]], session);

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ exchange_id: 'e1', content: expect.stringContaining('SQLite') }),
    ]));
    expect(candidates.length).toBeLessThanOrEqual(5);
  });

  it('retrieves bounded English candidates while ambiguous approval stays fail-closed', async () => {
    const session = [
      base('e1', 'Which option fits?', "I'd pick B for this project."),
      base('e2', 'What about A?', 'A may be better for portability.'),
      ...Array.from({ length: 4 }, (_, index) =>
        base(`e${index + 3}`, `Check ${index + 1}`, 'No blocker.'),
      ),
      base('e7', "Let's do that.", 'Proceeding.'),
    ];

    const candidates = selectLongRangeReferentCandidates([session[6]], session);

    expect(candidates.map((entry) => entry.exchange_id)).toEqual(
      expect.arrayContaining(['e1', 'e2']),
    );
    expect(candidates.length).toBeLessThanOrEqual(5);

    const candidate = validateExtractedFactCandidate({
      fact: 'This project uses B.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'ratification',
        supporting_span: "Let's do that.",
      }],
      context_dependencies: [],
    }, [session[6]], candidates);
    expect(candidate).not.toBeNull();
    expect(await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      [session[6]],
      async () => '[{"candidate_index":1,"verdict":"NOT_ENOUGH"}]',
      candidates,
    )).toEqual([null]);
  });

  it('binds every selected step to a later Korean sequence adoption', () => {
    const session = [
      base('e1', '이번 작업은 먼저 조사해줘.', '관련 코드를 조사하겠습니다.'),
      base('e2', '대안도 비교해줘.', '두 구현 대안을 비교했습니다.'),
      base('e3', '구현 전에 계획 검토해줘.', '구현 계획을 먼저 검토했습니다.'),
      base('e4', '이제 구현해줘.', '검토된 계획대로 구현했습니다.'),
      base('e5', '테스트도 해줘.', '관련 테스트를 실행했습니다.'),
      base('e6', '앞으로 작업할 때도 이 순서로 해줘.', '같은 순서를 유지하겠습니다.'),
    ];

    const candidates = selectLongRangeReferentCandidates(session.slice(3), session);

    for (const exchangeId of ['e1', 'e2', 'e3']) {
      expect(candidates.find((entry) => entry.exchange_id === exchangeId))
        .toEqual(expect.objectContaining({ anchor_exchange_ids: expect.arrayContaining(['e6']) }));
    }
  });

  it('does not let a generic pronoun flood retrieval with unrelated history', () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      base(`e${index + 1}`, `Budget note ${index + 1}.`, 'Recorded.'),
    );
    const anchor = base(
      'e11',
      'I think SQLite is better because it is simpler.',
      'Acknowledged.',
    );

    expect(selectLongRangeReferentCandidates([anchor], [...history, anchor])).toEqual([]);
  });

  it('keeps a standalone persistence constraint free of unrelated history', () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      base(`e${index + 1}`, `Budget note ${index + 1}.`, 'Recorded.'),
    );
    const anchor = base(
      'e7',
      '앞으로는 항상 작업 끝나면 더블체크해줘.',
      '기억하겠습니다.',
    );

    expect(selectLongRangeReferentCandidates([anchor], [...history, anchor])).toEqual([]);
  });

  it('resolves a Korean long-range continue approval', () => {
    const session = [
      base('e1', 'Which database fits this project?', 'I recommend SQLite.'),
      base('e2', '비용은?', '추가 비용은 없습니다.'),
      base('e3', '운영은?', '단순합니다.'),
      base('e4', '테스트는?', '지원됩니다.'),
      base('e5', '마이그레이션은?', '필요 없습니다.'),
      base('e6', '위험은?', '낮습니다.'),
      base('e7', '요약해줘.', 'SQLite가 적합합니다.'),
      base('e8', '계속', '진행하겠습니다.'),
    ];
    const windows = buildExtractionWindows([session[7]]);
    const candidates = windows[0]
      ? selectLongRangeReferentCandidates(windows[0], session)
      : [];

    expect(windows).toEqual([[session[7]]]);
    expect(candidates[0]).toEqual(expect.objectContaining({ exchange_id: 'e1' }));
  });

  it('opens a window for a context-dependent approval without a local antecedent', () => {
    const approval = base('e8', '진행해줘', '진행하겠습니다.');

    expect(buildExtractionWindows([approval])).toEqual([[approval]]);
  });

  it('does not retrieve context for a standalone explicit global assertion', () => {
    const session = [
      base('e1', 'What machine do you use?', 'Tell me when useful.'),
      base('e2', '난 Mac을 사용해.', '기억하겠습니다.'),
    ];
    expect(selectLongRangeReferentCandidates([session[1]], session)).toEqual([]);
  });

  it('does not treat a standalone project decision as a deictic context reference', async () => {
    const exchanges = [base(
      'e1',
      'We will use Riverpod for state management in this project.',
      'I will proceed with Riverpod.',
    )];
    const candidate = validateExtractedFactCandidate({
      fact: 'This project uses Riverpod for state management.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'decision',
        supporting_span: 'We will use Riverpod for state management in this project.',
      }],
      context_dependencies: [],
    }, exchanges);

    expect(selectLongRangeReferentCandidates(exchanges, exchanges)).toEqual([]);
    expect(await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      exchanges,
      async () => JSON.stringify([{
        candidate_index: 1,
        verdict: 'ENTAILED',
        used_context_dependencies: [],
        used_local_context_exchange_indices: [],
      }]),
    )).toEqual([expect.objectContaining({ source_exchange_ids: ['e1'] })]);
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

  it('lets cross-language project evidence reach semantic verification', () => {
    const exchanges = [base(
      'p1',
      '이 프로젝트에서는 배포 전에 항상 테스트를 실행해.',
      '이 프로젝트의 배포 전 테스트 규칙을 기억하겠습니다.',
    )];
    const accepted = validateExtractedFactCandidate({
      fact: 'Always run tests before deployment in this project.',
      category: 'constraint',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'assertion',
        supporting_span: '이 프로젝트에서는 배포 전에 항상 테스트를 실행해.',
      }],
    }, exchanges);

    expect(accepted).toEqual(expect.objectContaining({
      fact: 'Always run tests before deployment in this project.',
      scope_type: 'project',
      source_exchange_ids: ['p1'],
    }));
  });

  it('lets a question-shaped durable constraint reach semantic verification', () => {
    const user = '앞으로 항상 작업 끝나면 더블체크하는 걸로, 알겠지?';
    const exchanges = [base('q1', user, '기억하겠습니다.')];
    const accepted = validateExtractedFactCandidate({
      fact: 'Always double-check completed work.',
      category: 'constraint',
      scope_type: 'global',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'assertion',
        supporting_span: user,
      }],
    }, exchanges);

    expect(accepted).toEqual(expect.objectContaining({ source_exchange_ids: ['q1'] }));
  });

  it('lets a negative replacement reach semantic verification', () => {
    const user = '아니, SQLite 말고 PostgreSQL로 가자.';
    const exchanges = [base('r8', user, 'PostgreSQL로 변경하겠습니다.')];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-db',
      exchange_id: 'r1',
      anchor_exchange_ids: ['r8'],
      distance: 7,
      source: 'assistant_context_only',
      human_context: 'Which database should we use?',
      content: 'I recommend SQLite.',
      context_only_due_to_watermark: true,
    }];
    const accepted = validateExtractedFactCandidate({
      fact: 'This project uses PostgreSQL.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'ratification',
        supporting_span: user,
      }],
      context_dependencies: [{
        context_id: 'ctx-db',
        relation: 'ratified_proposition',
      }],
    }, exchanges, referents);

    expect(accepted).toEqual(expect.objectContaining({ source_exchange_ids: ['r8'] }));
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

  it('canonicalizes verifier-used context when the generator omitted the dependency', async () => {
    const exchanges = [
      base('e1', 'Which database fits?', 'SQLite is the better fit.'),
      base('e2', '그걸로 하자.', 'SQLite로 진행하겠습니다.'),
    ];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-1',
      exchange_id: 'e1',
      anchor_exchange_ids: ['e2'],
      distance: 1,
      source: 'assistant_context_only',
      human_context: exchanges[0].user_message,
      content: exchanges[0].assistant_message,
      context_only_due_to_watermark: false,
    }];
    const candidate = validateExtractedFactCandidate({
      fact: 'This project uses SQLite.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'ratification',
        supporting_span: '그걸로 하자.',
      }],
      context_dependencies: [],
    }, [exchanges[1]], referents);

    expect(candidate).not.toBeNull();
    const canonical = await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      [exchanges[1]],
      async () => JSON.stringify([{
        candidate_index: 1,
        verdict: 'ENTAILED',
        used_context_dependencies: [{
          context_id: 'ctx-1',
          relation: 'ratified_proposition',
        }],
        used_local_context_exchange_indices: [],
      }]),
      referents,
    );

    expect(canonical[0]).toEqual(expect.objectContaining({
      source_exchange_ids: ['e2'],
      context_dependencies: [{
        exchange_id: 'e1',
        dependency_kind: 'ratified_proposition',
      }],
    }));
  });

  it('fails closed when a reference-dependent verdict omits its resolution lineage', async () => {
    const exchanges = [
      base('e1', 'Which database fits?', 'SQLite is the better fit.'),
      base('e2', '그걸로 하자.', 'SQLite로 진행하겠습니다.'),
    ];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-1',
      exchange_id: 'e1',
      anchor_exchange_ids: ['e2'],
      distance: 1,
      source: 'assistant_context_only',
      human_context: exchanges[0].user_message,
      content: exchanges[0].assistant_message,
      context_only_due_to_watermark: false,
    }];
    const candidate = validateExtractedFactCandidate({
      fact: 'This project uses SQLite.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'ratification',
        supporting_span: '그걸로 하자.',
      }],
      context_dependencies: [],
    }, [exchanges[1]], referents);

    expect(candidate).not.toBeNull();
    expect(await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      [exchanges[1]],
      async () => '[{"candidate_index":1,"verdict":"ENTAILED"}]',
      referents,
    )).toEqual([null]);

    expect(await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      [exchanges[1]],
      async () => JSON.stringify([{
        candidate_index: 1,
        verdict: 'ENTAILED',
        used_context_dependencies: [{
          context_id: 'ctx-unknown',
          relation: 'ratified_proposition',
        }],
        used_local_context_exchange_indices: [],
      }]),
      referents,
    )).toEqual([null]);

    expect(await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      [exchanges[1]],
      async () => JSON.stringify([{
        candidate_index: 1,
        verdict: 'ENTAILED',
        used_context_dependencies: [
          { context_id: 'ctx-1', relation: 'ratified_proposition' },
          { context_id: 'ctx-1', relation: 'ratified_proposition' },
        ],
        used_local_context_exchange_indices: [],
      }]),
      referents,
    )).toEqual([null]);
  });

  it('requires the verifier to identify historical context despite irrelevant local context', async () => {
    const exchanges = [
      base('local-1', '로고 색상도 확인해줘.', '파란색 후보를 확인했습니다.'),
      base('e2', '그걸로 하자.', 'SQLite로 진행하겠습니다.'),
    ];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-1',
      exchange_id: 'historical-1',
      anchor_exchange_ids: ['e2'],
      distance: 8,
      source: 'assistant_context_only',
      human_context: 'Which database fits?',
      content: 'SQLite is the better fit.',
      context_only_due_to_watermark: true,
    }];
    const candidate = validateExtractedFactCandidate({
      fact: 'This project uses SQLite.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 2,
        source: 'human',
        kind: 'ratification',
        supporting_span: '그걸로 하자.',
      }],
      context_dependencies: [],
    }, exchanges, referents);

    const canonical = await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      exchanges,
      async () => JSON.stringify([{
        candidate_index: 1,
        verdict: 'ENTAILED',
        used_context_dependencies: [{
          context_id: 'ctx-1',
          relation: 'ratified_proposition',
        }],
        used_local_context_exchange_indices: [],
      }]),
      referents,
    );

    expect(canonical[0]?.context_dependencies).toEqual([{
      exchange_id: 'historical-1',
      dependency_kind: 'ratified_proposition',
    }]);
  });

  it('accepts exact verifier-used local context without persisting it as lineage', async () => {
    const exchanges = [
      base('e1', 'Which database fits?', 'SQLite is the better fit.'),
      base('e2', '그걸로 하자.', 'SQLite로 진행하겠습니다.'),
    ];
    const candidate = validateExtractedFactCandidate({
      fact: 'This project uses SQLite.',
      category: 'decision',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 2,
        source: 'human',
        kind: 'ratification',
        supporting_span: '그걸로 하자.',
      }],
      context_dependencies: [],
    }, exchanges);

    const canonical = await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      exchanges,
      async () => JSON.stringify([{
        candidate_index: 1,
        verdict: 'ENTAILED',
        used_context_dependencies: [],
        used_local_context_exchange_indices: [1],
      }]),
    );

    expect(canonical[0]).toEqual(expect.objectContaining({
      source_exchange_ids: ['e2'],
    }));
    expect(canonical[0]?.context_dependencies).toBeUndefined();
  });

  it('drops generator-only dependencies that the verifier did not use', async () => {
    const exchanges = [
      base('e1', 'What color should the logo use?', 'Blue is an option.'),
      base('e2', 'This project uses SQLite.', 'Acknowledged.'),
    ];
    const referents: LongRangeReferentCandidate[] = [{
      context_id: 'ctx-1',
      exchange_id: 'e1',
      anchor_exchange_ids: ['e2'],
      distance: 1,
      source: 'assistant_context_only',
      human_context: exchanges[0].user_message,
      content: exchanges[0].assistant_message,
      context_only_due_to_watermark: false,
    }];
    const candidate = validateExtractedFactCandidate({
      fact: 'This project uses SQLite.',
      category: 'knowledge',
      scope_type: 'project',
      grounding_type: 'explicit',
      durable: true,
      confidence: 0.95,
      evidence: [{
        exchange_index: 1,
        source: 'human',
        kind: 'assertion',
        supporting_span: 'This project uses SQLite.',
      }],
      context_dependencies: [{ context_id: 'ctx-1', relation: 'referent_definition' }],
    }, [exchanges[1]], referents);

    expect(candidate?.context_dependencies).toHaveLength(1);
    const canonical = await verifyAndCanonicalizeExtractedFactCandidates(
      [candidate!],
      [exchanges[1]],
      async () => JSON.stringify([{
        candidate_index: 1,
        verdict: 'ENTAILED',
        used_context_dependencies: [],
        used_local_context_exchange_indices: [],
      }]),
      referents,
    );

    expect(canonical[0]?.context_dependencies).toBeUndefined();
  });
});
