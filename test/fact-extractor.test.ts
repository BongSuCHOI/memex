import { describe, it, expect } from 'vitest';
import {
  EXTRACTION_POLICY_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  FACT_ENTAILMENT_VERIFIER_PROMPT,
  buildExtractionWindows,
  buildExtractionPrompt,
  buildFactEntailmentVerifierPrompt,
  isCandidateAnchorExchange,
  isContextEligibleExchange,
  normalizeFactText,
  passesConfidenceGate,
  selectSpreadWindows,
  validateExtractedFactCandidate,
  verifyExtractedFactCandidates,
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
      expect(envelope.local_exchanges).toEqual([
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
      expect(envelope.local_exchanges[0].human_evidence.length).toBeLessThan(2000);
      expect(envelope.local_exchanges[0].human_evidence).toContain('[truncated]');
    });

    it('preserves claim-bearing tails when human and tool evidence exceed prompt limits', () => {
      const prompt = buildExtractionPrompt([{
        user_message: `${'background '.repeat(220)}TAIL_DECISION_USE_SQLITE`,
        assistant_message: 'Acknowledged.',
        tool_evidence: [{
          id: 'tool-tail-1',
          tool_name: 'shell',
          tool_result: `${'diagnostic '.repeat(180)}TAIL_TEST_RESULT_PASS`,
          source_type: 'test_execution',
          learnable: true,
          is_error: false,
        }],
      }]);
      const exchange = JSON.parse(prompt).local_exchanges[0];

      expect(exchange.human_evidence).toContain('TAIL_DECISION_USE_SQLITE');
      expect(exchange.trusted_tool_evidence[0].content).toContain('TAIL_TEST_RESULT_PASS');
    });

    it('should handle empty exchanges array', () => {
      const prompt = buildExtractionPrompt([]);
      expect(prompt).toBe('');
    });

    it('should handle single exchange', () => {
      const exchanges = [{ user_message: 'Q', assistant_message: 'A' }];
      const prompt = buildExtractionPrompt(exchanges);
      const envelope = JSON.parse(prompt);
      expect(envelope.local_exchanges).toHaveLength(1);
      expect(envelope.local_exchanges[0].index).toBe(1);
    });

    it('should handle special characters in messages', () => {
      const exchanges = [{ user_message: '<script>alert("xss")</script>', assistant_message: '```json\n{"key": "value"}\n```' }];
      const prompt = buildExtractionPrompt(exchanges);
      const envelope = JSON.parse(prompt);
      expect(envelope.local_exchanges[0].human_evidence).toContain('<script>');
      expect(envelope.local_exchanges[0].assistant_context_only.content).toContain('```json');
    });

    it('separates trusted tool evidence from Memex recall context and omits unverified tools', () => {
      const prompt = buildExtractionPrompt([{
        user_message: 'What did we decide?',
        assistant_message: 'The earlier choice was SQLite.',
        has_memex_recall: true,
        tool_evidence: [
          { id: 'tool-1', tool_name: 'shell', tool_result: 'DATABASE_URL=postgres://local', source_type: 'repo_file', learnable: true, is_error: false },
          { id: 'tool-2', tool_name: 'mcp__memex__search_facts', tool_result: 'Old choice: SQLite', source_type: 'memex_recall', learnable: false, is_error: false },
          { id: 'tool-3', tool_name: 'shell', tool_result: 'remote page says MySQL', source_type: 'external_unverified', learnable: false, is_error: false },
        ],
      }]);
      const exchange = JSON.parse(prompt).local_exchanges[0];
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

    it('marks pre-watermark rows as context-only and withholds their human/tool authority', () => {
      const prompt = buildExtractionPrompt([{
        user_message: 'Which database should we use?',
        assistant_message: 'SQLite is the best fit.',
        context_only_due_to_watermark: true,
        tool_evidence: [{
          id: 'tool-prefix-1',
          tool_name: 'shell',
          tool_result: 'package.json contains better-sqlite3',
          source_type: 'repo_file',
          learnable: true,
          is_error: false,
        }],
      }]);
      const exchange = JSON.parse(prompt).local_exchanges[0];

      expect(exchange).toEqual(expect.objectContaining({
        context_only_due_to_watermark: true,
        human_evidence: null,
        human_context_only: 'Which database should we use?',
        trusted_tool_evidence: [],
      }));
      expect(exchange.assistant_context_only.content).toBe('SQLite is the best fit.');
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
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('supporting_span');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('tool_call_id');
    });

    it('publishes the Phase 5 precision/durability decision gates as a versioned policy', () => {
      expect(EXTRACTION_POLICY_VERSION).toBe('precision-durability-v4');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(`policy_version: ${EXTRACTION_POLICY_VERSION}`);
      for (const gate of [
        'GATE_1_GROUNDING',
        'GATE_2_DURABILITY',
        'GATE_3_CATEGORY_SCOPE',
        'GATE_4_CONFIDENCE',
        'NO_FACT_QUOTA',
        'CORRECTION_CURRENT_STATE',
        'RECALL_RATIFICATION',
        'RECALL_NO_NEW_HUMAN',
        'RECALL_NEW_ADOPTION',
        'REPEATED_PREFERENCE_LINEAGE',
      ]) {
        expect(EXTRACTION_SYSTEM_PROMPT).toContain(gate);
      }
    });

    it('publishes semantic tuning markers only for observed real-model failures', () => {
      for (const marker of [
        'CATEGORY_DIRECTIVE_CONSTRAINT',
        'CATEGORY_PROJECT_ADOPTION',
        'LOCAL_RECALL_NEW_ADOPTION',
        'SHORT_CONTINUE_RATIFICATION',
        'WORKFLOW_SEQUENCE_ADOPTION',
        'ORDINAL_REFERENCE_RESOLUTION',
        'HUMAN_ORIGIN_REAFFIRMATION',
        'TAG_QUESTION_DIRECTIVE',
      ]) {
        expect(EXTRACTION_SYSTEM_PROMPT).toContain(marker);
        expect(FACT_ENTAILMENT_VERIFIER_PROMPT).toContain(marker);
      }
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('MAX_THREE_CONTEXT_DEPENDENCIES');
      expect(FACT_ENTAILMENT_VERIFIER_PROMPT).toContain('SEQUENCE_REFERENCE_COMPLETENESS');
      expect(FACT_ENTAILMENT_VERIFIER_PROMPT).toContain('RECURRING_APPLICABILITY_NOT_TENSE');
    });
  });

  describe('generator context dependency policy', () => {
    it('requires a dependency when a referenced workflow defines the fact', () => {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('REFERENCED_WORKFLOW_DEPENDENCY_REQUIRED');
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('LOCAL_CONTEXT_REMAINS_DEPENDENCY_FREE');
      expect(FACT_ENTAILMENT_VERIFIER_PROMPT).not.toContain('REFERENCED_WORKFLOW_DEPENDENCY_REQUIRED');
      expect(FACT_ENTAILMENT_VERIFIER_PROMPT).not.toContain('LOCAL_CONTEXT_REMAINS_DEPENDENCY_FREE');
    });

    it('keeps a standalone durable fact free of unrelated dependencies', () => {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('STANDALONE_FACT_NO_DEPENDENCY');
      expect(FACT_ENTAILMENT_VERIFIER_PROMPT).not.toContain('STANDALONE_FACT_NO_DEPENDENCY');
    });

    it('emits no fact when required referents remain ambiguous', () => {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('AMBIGUOUS_REQUIRED_REFERENT_NO_FACT');
      expect(FACT_ENTAILMENT_VERIFIER_PROMPT).not.toContain('AMBIGUOUS_REQUIRED_REFERENT_NO_FACT');
    });

    it('declares only the minimum context needed to complete the claim', () => {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain('MINIMAL_NECESSARY_DEPENDENCIES');
      expect(FACT_ENTAILMENT_VERIFIER_PROMPT).not.toContain('MINIMAL_NECESSARY_DEPENDENCIES');
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
        {
          exchange_index: 2,
          source: 'human',
          kind: 'ratification',
          supporting_span: '좋아, 그걸로 하자.',
        },
      ],
      context_dependencies: [{
        context_id: 'ctx-1',
        relation: 'ratified_proposition',
      }],
    };

    const referents = [{
      context_id: 'ctx-1',
      exchange_id: 'e1',
      anchor_exchange_ids: ['e2'],
      distance: 1,
      source: 'assistant_context_only' as const,
      human_context: exchanges[0].user_message,
      content: exchanges[0].assistant_message,
      context_only_due_to_watermark: false,
    }];

    it('accepts human ratification while keeping assistant context out of authoritative lineage', () => {
      const accepted = validateExtractedFactCandidate(explicitCandidate, exchanges, referents);
      expect(accepted).toEqual(expect.objectContaining({
        source_exchange_ids: ['e2'],
        context_dependencies: [{
          exchange_id: 'e1',
          dependency_kind: 'ratified_proposition',
        }],
        grounding_type: 'explicit',
        durable: true,
      }));
      expect(accepted?.source_exchange_ids).not.toContain('e1');
      expect(accepted?.fact_kr).toBeUndefined();
    });

    it('accepts immediate local ratification without inventing a persisted context dependency', () => {
      const { context_dependencies: _contextDependencies, ...localCandidate } = explicitCandidate;
      const accepted = validateExtractedFactCandidate(localCandidate, exchanges);

      expect(accepted).toEqual(expect.objectContaining({
        source_exchange_ids: ['e2'],
        grounding_type: 'explicit',
        durable: true,
      }));
      expect(accepted?.context_dependencies).toBeUndefined();
      expect(accepted?.source_exchange_ids).not.toContain('e1');
    });

    it('rejects ratification with neither earlier local context nor a selected referent', () => {
      const { context_dependencies: _contextDependencies, ...localCandidate } = explicitCandidate;
      expect(validateExtractedFactCandidate({
        ...localCandidate,
        evidence: [{
          exchange_index: 1,
          source: 'human',
          kind: 'ratification',
          supporting_span: '좋아, 그걸로 하자.',
        }],
      }, [exchanges[1]])).toBeNull();
    });

    it('hard-rejects assistant, recall, and external evidence declarations', () => {
      for (const source of ['assistant', 'assistant_generated', 'memex_recall', 'external_unverified']) {
        expect(validateExtractedFactCandidate({
          ...explicitCandidate,
          evidence: [{ exchange_index: 1, source, kind: 'assertion' }],
        }, exchanges)).toBeNull();
      }
    });

    it('leaves question-shaped evidence semantics to the mandatory verifier', async () => {
      const questionExchanges = [{
        ...exchanges[0],
        user_message: 'Should this project use Riverpod?',
      }];
      const accepted = validateExtractedFactCandidate({
        ...explicitCandidate,
        fact: 'This project uses Riverpod.',
        evidence: [{
          exchange_index: 1,
          source: 'human',
          kind: 'assertion',
          supporting_span: 'Riverpod',
        }],
        context_dependencies: [],
      }, questionExchanges);
      expect(accepted).toEqual(expect.objectContaining({ fact: 'This project uses Riverpod.' }));
      expect(await verifyExtractedFactCandidates(
        [accepted!],
        questionExchanges,
        async () => '[{"candidate_index":1,"verdict":"NOT_ENOUGH"}]',
      )).toEqual([false]);
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        evidence: [{ exchange_index: 2, source: 'human', kind: 'ratification' }],
      }, exchanges)).toBeNull();
    });

    it('keeps fact_kr out of structural acceptance and leaves semantic mismatch to the verifier', async () => {
      const sqliteAssertion = [{
        ...exchanges[0],
        user_message: 'This project uses SQLite.',
      }];
      const accepted = validateExtractedFactCandidate({
        ...explicitCandidate,
        fact: 'This project uses Redis.',
        fact_kr: '이 프로젝트는 SQLite를 사용한다.',
        evidence: [{
          exchange_index: 1,
          source: 'human',
          kind: 'assertion',
          supporting_span: 'SQLite',
        }],
        context_dependencies: [],
      }, sqliteAssertion);

      expect(accepted).toEqual(expect.objectContaining({ fact: 'This project uses Redis.' }));
      expect(accepted?.fact_kr).toBeUndefined();
      expect(await verifyExtractedFactCandidates(
        [accepted!],
        sqliteAssertion,
        async () => '[{"candidate_index":1,"verdict":"CONTRADICTED"}]',
      )).toEqual([false]);
    });

    it('leaves negative ratification semantics to the mandatory verifier', async () => {
      const negativeExchanges = [exchanges[0], {
        ...exchanges[1],
        user_message: '아니, 그건 쓰지 마.',
      }];
      const accepted = validateExtractedFactCandidate({
        ...explicitCandidate,
        evidence: [{
          exchange_index: 2,
          source: 'human',
          kind: 'ratification',
          supporting_span: '아니, 그건 쓰지 마.',
        }],
      }, negativeExchanges, referents);
      expect(accepted).toEqual(expect.objectContaining({ source_exchange_ids: ['e2'] }));
      expect(await verifyExtractedFactCandidates(
        [accepted!],
        negativeExchanges,
        async () => '[{"candidate_index":1,"verdict":"CONTRADICTED"}]',
        referents,
      )).toEqual([false]);
    });

    it('leaves unrelated trusted tool semantics to the mandatory verifier', async () => {
      const toolExchanges = [{
        ...exchanges[0],
        tool_evidence: [{
          id: 'tool-unrelated-1',
          tool_name: 'shell',
          tool_result: 'DATABASE_URL=postgres://local',
          source_type: 'repo_file',
          learnable: 1,
          is_error: 0,
        }],
      }];
      const accepted = validateExtractedFactCandidate({
        ...explicitCandidate,
        fact: 'This project uses SQLite.',
        grounding_type: 'verified',
        evidence: [{
          exchange_index: 1,
          source: 'tool',
          kind: 'repo_file',
          tool_call_id: 'tool-unrelated-1',
          tool_name: 'shell',
          source_type: 'repo_file',
          supporting_span: 'DATABASE_URL=postgres://local',
        }],
        context_dependencies: [],
      }, toolExchanges);

      expect(accepted).toEqual(expect.objectContaining({
        fact: 'This project uses SQLite.',
        source_exchange_ids: ['e1'],
      }));
      expect(await verifyExtractedFactCandidates(
        [accepted!],
        toolExchanges,
        async () => '[{"candidate_index":1,"verdict":"NOT_ENOUGH"}]',
      )).toEqual([false]);
    });

    it('rejects irrelevant or non-ratification context dependencies', () => {
      const unrelatedContext = {
        ...exchanges[0],
        user_message: 'What color should the logo use?',
        assistant_message: 'Use blue for the logo.',
      };
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        evidence: [{
          exchange_index: 2,
          source: 'human',
          kind: 'ratification',
          supporting_span: '좋아, 그걸로 하자.',
        }],
      }, [unrelatedContext, exchanges[1]])).toBeNull();

      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        fact: 'This project uses SQLite.',
        evidence: [{
          exchange_index: 2,
          source: 'human',
          kind: 'assertion',
          supporting_span: '좋아, 그걸로 하자.',
        }],
        context_exchange_indices: [1],
      }, exchanges)).toBeNull();
    });

    it('accepts verified tool evidence only when the actual DB-derived row matches and is learnable', () => {
      const toolExchanges = [{
        ...exchanges[0],
        tool_evidence: [{
          id: 'tool-valid-1',
          tool_name: 'shell',
          tool_result: 'DATABASE_URL=postgres://local',
          source_type: 'repo_file',
          learnable: 1,
          is_error: 0,
        }],
      }];
      const candidate = {
        ...explicitCandidate,
        fact: 'This project uses PostgreSQL.',
        fact_kr: '이 프로젝트는 PostgreSQL을 사용한다.',
        grounding_type: 'verified',
        evidence: [{
          exchange_index: 1,
          source: 'tool',
          kind: 'repo_file',
          tool_call_id: 'tool-valid-1',
          tool_name: 'shell',
          source_type: 'repo_file',
          supporting_span: 'DATABASE_URL=postgres://local',
        }],
        context_dependencies: [],
      };
      expect(validateExtractedFactCandidate(candidate, toolExchanges)?.source_exchange_ids).toEqual(['e1']);
      expect(validateExtractedFactCandidate({
        ...candidate,
        evidence: [{ ...candidate.evidence[0], tool_call_id: 'wrong-tool-id' }],
      }, toolExchanges)).toBeNull();
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
      const signalExchanges = [
        {
          ...exchanges[0],
          user_message: 'Keep responses concise across projects.',
          assistant_message: 'Acknowledged.',
        },
        {
          ...exchanges[1],
          user_message: 'Use concise responses in other projects too.',
          assistant_message: 'Acknowledged.',
        },
      ];
      const inferred = {
        ...explicitCandidate,
        fact: 'The user prefers concise responses across projects.',
        fact_kr: '사용자는 여러 프로젝트에서 간결한 답변을 선호한다.',
        grounding_type: 'inferred',
        evidence: [
          { exchange_index: 1, source: 'human', kind: 'repeated_signal', supporting_span: 'concise' },
          { exchange_index: 2, source: 'human', kind: 'repeated_signal', supporting_span: 'concise' },
        ],
        context_dependencies: [],
      };
      expect(validateExtractedFactCandidate(inferred, signalExchanges)?.source_exchange_ids).toEqual(['e1', 'e2']);
      expect(validateExtractedFactCandidate({
        ...inferred,
        evidence: [
          { exchange_index: 1, source: 'human', kind: 'repeated_signal', supporting_span: 'concise' },
          { exchange_index: 1, source: 'human', kind: 'repeated_signal', supporting_span: 'concise' },
        ],
      }, signalExchanges)).toBeNull();
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
        context_dependencies: [{ context_id: 'missing', relation: 'ratified_proposition' }],
      }, exchanges)).toBeNull();
    });

    it('rejects pre-watermark human/tool evidence while allowing the row as context', () => {
      const prefixHuman = [{
        ...exchanges[0],
        context_only_due_to_watermark: true,
      }];
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        evidence: [{ exchange_index: 1, source: 'human', kind: 'assertion' }],
        context_exchange_indices: [1],
      }, prefixHuman)).toBeNull();

      const prefixTool = [{
        ...exchanges[0],
        context_only_due_to_watermark: true,
        tool_evidence: [{
          id: 'tool-prefix-1',
          tool_name: 'shell',
          tool_result: 'package.json contains better-sqlite3',
          source_type: 'repo_file',
          learnable: 1,
          is_error: 0,
        }],
      }];
      expect(validateExtractedFactCandidate({
        ...explicitCandidate,
        grounding_type: 'verified',
        evidence: [{
          exchange_index: 1,
          source: 'tool',
          kind: 'repo_file',
          tool_call_id: 'tool-prefix-1',
          tool_name: 'shell',
          source_type: 'repo_file',
          supporting_span: 'better-sqlite3',
        }],
        context_exchange_indices: [1],
      }, prefixTool)).toBeNull();

      const watermarkReferents = [{
        ...referents[0],
        context_only_due_to_watermark: true,
      }];
      const accepted = validateExtractedFactCandidate(explicitCandidate, [
        prefixHuman[0],
        exchanges[1],
      ], watermarkReferents);
      expect(accepted?.context_dependencies).toEqual([{
        exchange_id: 'e1',
        dependency_kind: 'ratified_proposition',
      }]);
      expect(accepted?.source_exchange_ids).toEqual(['e2']);
    });

    it('derives recall-influenced context dependency kinds from server rows', () => {
      const recallCandidate = {
        ...explicitCandidate,
        context_dependencies: [{
          context_id: 'ctx-1',
          relation: 'recall_reference',
        }],
      };
      const accepted = validateExtractedFactCandidate(recallCandidate, [
        { ...exchanges[0], has_memex_recall: 1 },
        exchanges[1],
      ], [{
        ...referents[0],
        source: 'recall_context_only',
      }]);
      expect(accepted?.context_dependencies).toEqual([{
        exchange_id: 'e1',
        dependency_kind: 'recall_reference',
      }]);
    });
  });

  describe('semantic entailment verifier', () => {
    const verifierExchanges = [
      {
        id: 'v1',
        user_message: 'We do not use SQLite.',
        assistant_message: 'Acknowledged.',
        provenance: '["human_assertion"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
      {
        id: 'v2',
        user_message: 'SQLite랑 PostgreSQL 비교해줘.',
        assistant_message: 'Comparing them.',
        provenance: '["human_assertion"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
      {
        id: 'v3',
        user_message: '이번 패키지만 pnpm으로 설치해줘.',
        assistant_message: 'Installing it.',
        provenance: '["human_assertion"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
      {
        id: 'v4',
        user_message: 'Which database should we use?',
        assistant_message: 'SQLite로 가는 게 좋겠습니다.',
        provenance: '["human_assertion"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
      {
        id: 'v5',
        user_message: '아니, 그건 쓰지 마.',
        assistant_message: 'Understood.',
        provenance: '["human_assertion"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
      {
        id: 'v6',
        user_message: 'This project uses PostgreSQL.',
        assistant_message: 'Acknowledged.',
        provenance: '["human_assertion"]',
        assistant_learnable: 0,
        has_memex_recall: 0,
        tool_evidence: [],
      },
    ];
    const candidates = [
      {
        fact: 'This project uses SQLite.',
        fact_kr: '이 프로젝트는 SQLite를 사용한다.',
        category: 'knowledge' as const,
        scope_type: 'project' as const,
        confidence: 0.95,
        grounding_type: 'explicit' as const,
        durable: true,
        evidence: [{ exchange_index: 1, source: 'human' as const, kind: 'assertion' as const, supporting_span: 'SQLite' }],
        source_exchange_ids: ['v1'],
      },
      {
        fact: 'This project uses SQLite.',
        category: 'decision' as const,
        scope_type: 'project' as const,
        confidence: 0.95,
        grounding_type: 'explicit' as const,
        durable: true,
        evidence: [{ exchange_index: 2, source: 'human' as const, kind: 'assertion' as const, supporting_span: 'SQLite' }],
        source_exchange_ids: ['v2'],
      },
      {
        fact: 'The user prefers pnpm across projects.',
        category: 'preference' as const,
        scope_type: 'global' as const,
        confidence: 0.95,
        grounding_type: 'explicit' as const,
        durable: true,
        evidence: [{ exchange_index: 3, source: 'human' as const, kind: 'assertion' as const, supporting_span: 'pnpm' }],
        source_exchange_ids: ['v3'],
      },
      {
        fact: 'This project will use SQLite.',
        category: 'decision' as const,
        scope_type: 'project' as const,
        confidence: 0.95,
        grounding_type: 'explicit' as const,
        durable: true,
        evidence: [{ exchange_index: 5, source: 'human' as const, kind: 'ratification' as const, supporting_span: '아니, 그건 쓰지 마.' }],
        context_dependencies: [{
          exchange_id: 'v4',
          dependency_kind: 'ratified_proposition' as const,
        }],
        source_exchange_ids: ['v5'],
      },
      {
        fact: 'This project uses PostgreSQL.',
        category: 'knowledge' as const,
        scope_type: 'project' as const,
        confidence: 0.95,
        grounding_type: 'explicit' as const,
        durable: true,
        evidence: [{ exchange_index: 6, source: 'human' as const, kind: 'assertion' as const, supporting_span: 'PostgreSQL' }],
        source_exchange_ids: ['v6'],
      },
    ];

    const verifierReferents = [{
      context_id: 'ctx-1',
      exchange_id: 'v4',
      anchor_exchange_ids: ['v5'],
      distance: 1,
      source: 'assistant_context_only' as const,
      human_context: verifierExchanges[3].user_message,
      content: verifierExchanges[3].assistant_message,
      context_only_due_to_watermark: false,
    }];

    it('sends canonical facts with full authoritative sentences and bounded ratification context', () => {
      const prompt = buildFactEntailmentVerifierPrompt(candidates, verifierExchanges, verifierReferents);
      expect(prompt).toContain('We do not use SQLite.');
      expect(prompt).toContain('SQLite랑 PostgreSQL 비교해줘.');
      expect(prompt).toContain('이번 패키지만 pnpm으로 설치해줘.');
      expect(prompt).toContain('Which database should we use?');
      expect(prompt).toContain('SQLite로 가는 게 좋겠습니다.');
      expect(prompt).not.toContain('이 프로젝트는 SQLite를 사용한다.');
    });

    it('sends only pre-authority local context for immediate ratification verification', () => {
      const localCandidate = {
        ...candidates[3],
        evidence: [{
          exchange_index: 2,
          source: 'human' as const,
          kind: 'ratification' as const,
          supporting_span: '아니, 그건 쓰지 마.',
        }],
        context_dependencies: undefined,
        source_exchange_ids: ['v5'],
      };
      const prompt = buildFactEntailmentVerifierPrompt(
        [localCandidate],
        [verifierExchanges[3], verifierExchanges[4]],
      );
      const envelope = JSON.parse(prompt);

      expect(envelope.candidates[0].local_context_before_authority).toEqual([{
        exchange_index: 1,
        human_context: 'Which database should we use?',
        assistant_context: 'SQLite로 가는 게 좋겠습니다.',
        recall_context: [],
      }]);
      expect(prompt).not.toContain('Understood.');
    });

    it('accepts only one complete ENTAILED verdict and fails closed on semantic adversaries', async () => {
      const accepted = await verifyExtractedFactCandidates(
        candidates,
        verifierExchanges,
        async () => JSON.stringify([
          { candidate_index: 1, verdict: 'CONTRADICTED' },
          { candidate_index: 2, verdict: 'NOT_ENOUGH' },
          { candidate_index: 3, verdict: 'CONTRADICTED' },
          { candidate_index: 4, verdict: 'CONTRADICTED' },
          { candidate_index: 5, verdict: 'ENTAILED' },
        ]),
      );
      expect(accepted).toEqual([false, false, false, false, true]);

      expect(await verifyExtractedFactCandidates(
        [candidates[4]],
        verifierExchanges,
        async () => JSON.stringify([
          { candidate_index: 1, verdict: 'ENTAILED' },
          { candidate_index: 1, verdict: 'ENTAILED' },
        ]),
      )).toEqual([false]);
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

  describe('context eligibility and candidate anchors', () => {
    it('rejects empty user messages from context', () => {
      expect(isContextEligibleExchange('')).toBe(false);
      expect(isContextEligibleExchange('   ')).toBe(false);
    });

    it('rejects harness artifacts injected as user turns from context', () => {
      expect(isContextEligibleExchange('<local-command-stdout>output</local-command-stdout>')).toBe(false);
      expect(isContextEligibleExchange('<command-name>/clear</command-name>')).toBe(false);
      expect(isContextEligibleExchange('<local-command-caveat>Caveat text</local-command-caveat>')).toBe(false);
      expect(isContextEligibleExchange('Caveat: the messages below were generated...')).toBe(false);
    });

    it('rejects bare slash commands from context', () => {
      expect(isContextEligibleExchange('/clear')).toBe(false);
      expect(isContextEligibleExchange('/model')).toBe(false);
      expect(isContextEligibleExchange('/codex:review')).toBe(false);
    });

    it('keeps short replies in context and anchors possible ratification', () => {
      for (const reply of ['ok', 'yes', '응', '네', '좋아', '그래', '아니']) {
        expect(isContextEligibleExchange(reply)).toBe(true);
        expect(isCandidateAnchorExchange(reply)).toBe(true);
      }
    });

    it('keeps pure social and bridge replies as context without making them anchors', () => {
      for (const reply of ['고마워', '감사합니다', '계속', '진행해줘', '왜?']) {
        expect(isContextEligibleExchange(reply)).toBe(true);
        expect(isCandidateAnchorExchange(reply)).toBe(false);
      }
    });

    it('makes trusted tool evidence an anchor even when the human text is not substantive', () => {
      expect(isCandidateAnchorExchange('왜?')).toBe(false);
      expect(isCandidateAnchorExchange('왜?', true)).toBe(true);
    });

    it('makes normal human exchanges candidate anchors', () => {
      expect(isCandidateAnchorExchange('What should we use for state management?')).toBe(true);
    });

    it('keeps a slash command with arguments as context and an anchor', () => {
      expect(isContextEligibleExchange('/team build the login feature')).toBe(true);
      expect(isCandidateAnchorExchange('/team build the login feature')).toBe(true);
    });
  });

  describe('buildExtractionWindows', () => {
    const exchange = (id: number, user: string) => ({
      id: `e${id}`,
      user_message: user,
      assistant_message: `assistant ${id}`,
    });

    it('preserves the immediate raw neighbor for short ratification', () => {
      const windows = buildExtractionWindows([
        exchange(0, 'Which state manager should we use?'),
        exchange(1, '왜?'),
        exchange(2, '응'),
      ]);

      expect(windows).toHaveLength(1);
      expect(windows[0].map((item) => item.id)).toEqual(['e0', 'e1', 'e2']);
    });

    it('does not let an ineligible transport artifact bridge non-adjacent context', () => {
      const windows = buildExtractionWindows([
        exchange(0, 'Use Riverpod for this project.'),
        exchange(1, '<local-command-stdout>transport</local-command-stdout>'),
        exchange(2, '응'),
      ]);

      expect(windows.map((window) => window.map((item) => item.id))).toEqual([
        ['e0'],
        ['e2'],
      ]);
    });

    it('builds bounded semantic windows and overlaps only for neighbor context', () => {
      const windows = buildExtractionWindows(
        Array.from({ length: 8 }, (_, index) => exchange(index, `Durable project decision ${index}`)),
      );

      expect(windows.map((window) => window.map((item) => item.id))).toEqual([
        ['e0', 'e1', 'e2', 'e3', 'e4'],
        ['e3', 'e4', 'e5', 'e6', 'e7'],
      ]);
      expect(windows.every((window) => window.length <= 5)).toBe(true);
    });

    it('returns no windows when exchanges contain only social or question bridges', () => {
      expect(buildExtractionWindows([
        exchange(0, '고마워'),
        exchange(1, '왜?'),
      ])).toEqual([]);
    });

    it('uses a pre-watermark row only as the immediate context of a new anchor', () => {
      const prefix = {
        ...exchange(0, 'Which database should we use?'),
        context_only_due_to_watermark: true,
      };
      expect(buildExtractionWindows([prefix])).toEqual([]);

      const windows = buildExtractionWindows([
        prefix,
        exchange(1, '좋아, 그걸로 결정하자.'),
      ]);
      expect(windows.map((window) => window.map((item) => item.id))).toEqual([
        ['e0', 'e1'],
      ]);
    });

    it('keeps a two-turn watermark antecedent and still opens long-range proceed replies', () => {
      const proposal = {
        ...exchange(0, 'Which database should we use?'),
        assistant_message: 'Use SQLite for this project.',
        context_only_due_to_watermark: true,
      };
      const rationale = {
        ...exchange(1, '왜?'),
        assistant_message: 'SQLite keeps the local-first deployment simple.',
        context_only_due_to_watermark: true,
      };

      expect(buildExtractionWindows([
        proposal,
        rationale,
        exchange(2, '진행해줘'),
      ]).map((window) => window.map((item) => item.id))).toEqual([
        ['e0', 'e1', 'e2'],
      ]);
      expect(buildExtractionWindows([exchange(2, '진행해줘')])).toEqual([
        [exchange(2, '진행해줘')],
      ]);
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

  describe('selectSpreadWindows', () => {
    it('returns all semantic windows when under the cap', () => {
      const batches = [[1], [2], [3]];
      expect(selectSpreadWindows(batches, 5)).toEqual(batches);
    });

    it('caps semantic windows while keeping first and last', () => {
      const batches = Array.from({ length: 40 }, (_, i) => [i]);
      const selected = selectSpreadWindows(batches, 12);
      expect(selected).toHaveLength(12);
      expect(selected[0]).toEqual([0]);
      expect(selected[selected.length - 1]).toEqual([39]);
    });

    it('spreads selection across the whole range', () => {
      const batches = Array.from({ length: 100 }, (_, i) => i);
      const selected = selectSpreadWindows(batches, 5);
      expect(selected).toEqual([0, 25, 50, 74, 99]);
    });

    it('handles maxBatches of 1', () => {
      const batches = [1, 2, 3];
      expect(selectSpreadWindows(batches, 1)).toEqual([1]);
    });
  });
});
