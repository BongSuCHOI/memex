import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 세션 영구 손실 회귀 테스트 (C1).
 *
 * 예전 동작: 공급자 장애로 모든 배치가 실패해도 extractFactsFromExchanges 가 빈 배열을
 * 반환 → extractAndSaveFacts 가 extraction_log 에 '완료(0건)'로 기록 → pending 쿼리가
 * 그 세션을 영구 제외 → **그 대화의 fact 는 영원히 추출되지 않음**.
 *
 * Continuity v1: transient 는 retry target으로 남고 completion cursor를 쓰지 않는다.
 * deterministic 은 recursive split 뒤 exact failed-visible range가 되며 completed가 아니다.
 */

const llmBehavior: {
  mode:
    | 'transient'
    | 'verifier_transient'
    | 'deterministic'
    | 'ok'
    | 'unknown'
    | 'input_limit'
    // Issue #146: the budget refused the reservation mid-window. `_wrapped` is
    // the shape the outer handler used to receive — an LlmCallError around the
    // budget error — and it must be read exactly like the bare one.
    | 'budget_deadline'
    | 'budget_deadline_wrapped';
  calls: number;
} = { mode: 'ok', calls: 0 };

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callMemoryModel: async (
      systemPrompt: string,
      userMessage: string,
      _maxTokens?: number,
      // #146: the budget modes below need the caller's model context, exactly
      // as llm.ts uses it to resolve the budget before the first reservation.
      { modelContext }: { modelContext?: Partial<import('../src/model-budget.js').ModelWorkContext> } = {},
    ) => {
      llmBehavior.calls += 1;
      if (llmBehavior.mode === 'input_limit' && !systemPrompt.includes('authoritative-entailment-v3')) {
        // Issue #144: the durable input budget rejects any window wider than
        // one exchange, exactly as model-budget does before the provider call.
        const { ModelBudgetInputLimitError } = await import('../src/model-budget.js');
        const payload = JSON.parse(userMessage) as { local_exchanges: unknown[] };
        if (payload.local_exchanges.length > 1) throw new ModelBudgetInputLimitError(126_792, 120_000);
      }
      if (
        llmBehavior.mode === 'budget_deadline' ||
        llmBehavior.mode === 'budget_deadline_wrapped'
      ) {
        // Reproduce llm.ts exactly up to the refusal: resolve the work context
        // (which binds the job to its budget), then throw the way
        // reserveModelAttempt does — BEFORE any model_work_attempts row exists,
        // so this claim has spent nothing at all.
        const mb = await import('../src/model-budget.js');
        return await mb.withResolvedModelWorkContext(
          modelContext ?? {},
          async () => {
            const resolved = mb.getModelWorkContext()!;
            const budgetError = new mb.ModelBudgetExhaustedError(
              resolved.budgetId!, resolved.parentWaveId!, 'deadline',
            );
            if (llmBehavior.mode === 'budget_deadline_wrapped') {
              const { LlmCallError } = await import('../src/llm-error-class.js');
              throw new LlmCallError(budgetError);
            }
            throw budgetError;
          },
        );
      }
      if (llmBehavior.mode === 'transient') {
        throw Object.assign(new Error('service unavailable'), { status: 503 });
      }
      if (llmBehavior.mode === 'deterministic') {
        throw Object.assign(new Error('prompt is too long'), { status: 413 });
      }
      if (llmBehavior.mode === 'unknown') {
        // 분류기가 인식 못 하는 shape (status 없음, 알려진 문구 없음)
        throw new Error('weird provider hiccup xyz');
      }
      if (systemPrompt.includes('authoritative-entailment-v3')) {
        if (llmBehavior.mode === 'verifier_transient') {
          throw Object.assign(new Error('verifier service unavailable'), { status: 503 });
        }
        const envelope = JSON.parse(userMessage) as { candidates: Array<{
          selected_context_dependencies: Array<{ context_id: string; relation: string }>;
          local_context_before_authority: Array<{ exchange_index: number }>;
          authoritative_evidence: Array<{ kind: string }>;
        }> };
        return JSON.stringify(envelope.candidates.map((candidate, index) => ({
          candidate_index: index + 1,
          verdict: 'ENTAILED',
          used_context_dependencies: candidate.selected_context_dependencies,
          used_local_context_exchange_indices:
            candidate.selected_context_dependencies.length === 0 &&
            candidate.authoritative_evidence.some(({ kind }) => kind === 'ratification') &&
            candidate.local_context_before_authority.length > 0
              ? [candidate.local_context_before_authority.at(-1)!.exchange_index]
              : [],
        })));
      }
      return JSON.stringify([
        { fact: 'User prefers Riverpod for Flutter state management', category: 'preference', scope_type: 'project', confidence: 0.9,
          grounding_type: 'explicit', durable: true,
          evidence: [{
            exchange_index: 1,
            source: 'human',
            kind: 'assertion',
            supporting_span: 'Riverpod',
          }] },
      ]);
    },
  };
});
// 임베딩(ONNX 모델 로드)은 이 테스트의 관심사가 아니므로 결정론 스텁으로 대체.
vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateEmbedding: async () => new Array(384).fill(0.01),
  };
});
// 온톨로지 분류는 별도 LLM 경로 — 추출 결과 판정과 무관하므로 no-op.
vi.mock('../src/ontology-classifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ontology-classifier.js')>();
  return { ...actual, classifyAndLinkFact: async () => {} };
});

let tmpDir: string;
let db: import('better-sqlite3').Database;
const SESSION = 'sess-transient-loss-test';
const PROJECT = '/tmp/some-project';

async function setupDb() {
  const { initDatabase } = await import('../src/db.js');
  const database = initDatabase();
  const now = new Date().toISOString();
  const insert = database.prepare(`
    INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  // 실질적(substantive) 교환 2건 — 추출 대상이 되도록 충분히 길게.
  for (let i = 0; i < 2; i++) {
    insert.run(
      `ex-${i}`, PROJECT, now,
      `Flutter 프로젝트의 상태관리는 Riverpod으로 결정했습니다.`,
      `Riverpod 결정을 확인합니다.`,
      `/tmp/archive-${i}.jsonl`, 1, 10, SESSION,
    );
  }
  return database;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-extract-retry-'));
  process.env.MEMEX_HOME = tmpDir;
  process.env.MEMEX_DB_PATH = path.join(tmpDir, 'test.sqlite');
  llmBehavior.mode = 'ok';
  llmBehavior.calls = 0;
  db = await setupDb();
});
afterEach(() => {
  try { db?.close(); } catch { /* already closed */ }
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const loggedSessions = () =>
  (db.prepare('SELECT session_id FROM extraction_log').all() as Array<{ session_id: string }>)
    .map((r) => r.session_id);

describe('세션 영구 손실 방지 (transient vs deterministic)', () => {
  it('AC4: transient 실패 시 throw 하고 extraction_log 를 기록하지 않는다 (다음 run 재시도 가능)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'transient';

    await expect(runFactExtraction(db, SESSION, PROJECT)).rejects.toThrow(/service unavailable/);
    // 핵심: 세션이 '처리됨'으로 기록되지 않아야 다음 run 이 다시 집어간다.
    expect(loggedSessions()).not.toContain(SESSION);
  });

  it('AC4b: transient 회복 후 재실행하면 정상 추출되고 그때 기록된다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'transient';
    await expect(runFactExtraction(db, SESSION, PROJECT)).rejects.toThrow();
    expect(loggedSessions()).not.toContain(SESSION);

    llmBehavior.mode = 'ok'; // 공급자 회복
    db.prepare("UPDATE memory_jobs SET available_at = '1970-01-01T00:00:00.000Z'").run();
    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.extracted).toBeGreaterThan(0);
    expect(loggedSessions()).toContain(SESSION); // 이제서야 완료 기록
  });

  it('AC4g: verifier transient 실패도 완료 마커 없이 다음 run으로 이연한다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'verifier_transient';

    await expect(runFactExtraction(db, SESSION, PROJECT)).rejects.toThrow(/verifier service unavailable/);
    expect(loggedSessions()).not.toContain(SESSION);
  });

  it('AC4d: 인식 못 한 에러(unknown)도 세션을 잃지 않는다 (Codex 리뷰 회귀 고정)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'unknown';

    // 추출은 consolidation 과 달리 건너뛰면 fact 가 아예 안 생긴다 → 이연이 옳다.
    await expect(runFactExtraction(db, SESSION, PROJECT)).rejects.toThrow(/weird provider hiccup/);
    expect(loggedSessions()).not.toContain(SESSION);
  });

  it('AC4c: irreducible deterministic 실패는 completed가 아닌 failed-visible이다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'deterministic';

    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.extracted).toBe(0);
    expect(result.skipped).toBe('failed_visible');
    expect(loggedSessions()).not.toContain(SESSION);
    expect(db.prepare(
      "SELECT state FROM extraction_targets WHERE session_id = ?",
    ).get(SESSION)).toEqual({ state: 'dead' });
  });

  it('#144: an oversized window is split, not deferred — the session still completes with facts', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'input_limit';

    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.extracted).toBeGreaterThan(0);
    expect(result.skipped).toBeUndefined();
    expect(loggedSessions()).toContain(SESSION);
    expect(db.prepare("SELECT state FROM extraction_targets WHERE session_id = ?").get(SESSION))
      .toEqual({ state: 'completed' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM extraction_failed_ranges").get()).toEqual({ n: 0 });
    // one rejected two-exchange window, then two singleton windows
    expect(llmBehavior.calls).toBeGreaterThanOrEqual(3);
  });

  it('AC4e: 폐기된 배치는 dead-letter 로 기록돼 조회 가능하다 (무음 손실 금지)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'deterministic';

    await runFactExtraction(db, SESSION, PROJECT);
    const rows = db.prepare(`
      SELECT from_ordinal, through_ordinal, payload_fingerprint, state
      FROM extraction_failed_ranges
      WHERE target_id = (SELECT target_id FROM extraction_targets WHERE session_id = ?)
      ORDER BY from_ordinal
    `).all(SESSION) as Array<{
      from_ordinal: number;
      through_ordinal: number;
      payload_fingerprint: string;
      state: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.from_ordinal === row.through_ordinal)).toBe(true);
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.payload_fingerprint))).toBe(true);
    expect(rows.every((row) => row.state === 'failed-visible')).toBe(true);
  });

  it('historical context singleton failure cannot escape durable target accounting', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const { refreshExchangeMetadata } = await import('../src/continuity-store.js');
    const firstRowid = (db.prepare(
      "SELECT MIN(rowid) AS rowid FROM exchanges WHERE session_id = ?",
    ).get(SESSION) as { rowid: number }).rowid;
    db.prepare(`
      INSERT INTO extraction_log
        (session_id, processed_at, extracted, saved, last_exchange_rowid)
      VALUES (?, ?, 0, 0, ?)
    `).run(SESSION, new Date().toISOString(), firstRowid);
    refreshExchangeMetadata(db, SESSION);
    db.prepare(`
      INSERT INTO exchange_extraction_state
        (exchange_id, content_generation, policy_version, state, processed_at)
      SELECT id, content_generation, 'continuity-fact-v1', 'processed', ?
      FROM exchanges WHERE rowid = ?
    `).run(new Date().toISOString(), firstRowid);
    llmBehavior.mode = 'deterministic';

    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.skipped).toBe('failed_visible');
    const target = db.prepare(`
      SELECT target_id, state, cursor_ordinal, item_count
      FROM extraction_targets WHERE session_id = ?
    `).get(SESSION) as {
      target_id: string;
      state: string;
      cursor_ordinal: number;
      item_count: number;
    };
    expect(target).toEqual(expect.objectContaining({
      state: 'dead', cursor_ordinal: 0, item_count: 1,
    }));
    expect(db.prepare(`
      SELECT from_ordinal, through_ordinal, state
      FROM extraction_failed_ranges WHERE target_id = ?
    `).get(target.target_id)).toEqual({
      from_ordinal: 1,
      through_ordinal: 1,
      state: 'failed-visible',
    });
  });

  it('AC4f: 정상 처리 세션은 dropped_batches 가 0 이다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'ok';

    await runFactExtraction(db, SESSION, PROJECT);
    const row = db.prepare(
      'SELECT dropped_batches FROM extraction_log WHERE session_id = ?',
    ).get(SESSION) as { dropped_batches: number } | undefined;
    expect(row?.dropped_batches).toBe(0);
  });
});

/**
 * Issue #146 — a budget stop that spent nothing must cost the session nothing.
 *
 * Observed on the work Mac (0.7.15, 08:11Z): `memex backfill extract` joined a
 * clock-dead automatic maintenance run, every window failed with
 * `ModelBudgetExhaustedError` before a single provider call, and the sessions
 * ended up in `retry` with a one-hour backoff and a spent attempt each.
 */
describe('#146: 예산 이연은 backoff 도 attempt 도 태우지 않는다', () => {
  // A5: 예산 소진은 window 마다 스택 트레이스를 찍으면 안 된다 — 관측된 실패의
  // 절반은 "같은 예산 이야기를 9번 반복한 로그"였다.
  const consoleErrors: string[] = [];
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrors.length = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map((arg) => String(arg)).join(' '));
    });
  });
  afterEach(() => errorSpy.mockRestore());

  const factExtractJob = () => db.prepare(
    "SELECT state, attempts, available_at, budget_id FROM memory_jobs WHERE kind = 'fact_extract'",
  ).get() as { state: string; attempts: number; available_at: string; budget_id: string | null };

  for (const mode of ['budget_deadline', 'budget_deadline_wrapped'] as const) {
    it(`${mode}: 세션은 즉시 pending 으로 돌아가고 attempt 는 환불된다`, async () => {
      const { runFactExtraction } = await import('../src/fact-extractor.js');
      llmBehavior.mode = mode;
      const before = Date.now();

      const result = await runFactExtraction(db, SESSION, PROJECT);
      expect(result.skipped).toBe('budget_exhausted');
      // 래퍼에서 읽으면 reason 은 **에러 객체**, budgetId 는 undefined 였다.
      expect(result.budgetReason).toBe('deadline');
      expect(typeof result.budgetId).toBe('string');

      const job = factExtractJob();
      expect(job.state).toBe('pending'); // 'retry' 였다
      expect(job.attempts).toBe(0); // 선점이 태운 1이 환불된다
      // available_at 은 '지금'이다 — 1시간 backoff 는 이 세션의 잘못이 아니다.
      expect(Date.parse(job.available_at)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(job.available_at) - before).toBeLessThan(60_000);
      expect(db.prepare(
        'SELECT state, attempts FROM extraction_targets WHERE session_id = ?',
      ).get(SESSION)).toEqual({ state: 'pending', attempts: 0 });
      // 완료 마커는 없어야 다음 run 이 다시 집어간다.
      expect(loggedSessions()).not.toContain(SESSION);
      // A5: 예산 소진은 분류기에 가기 전에 그대로 다시 던져진다 — window 단위
      // 실패 로그(스택 트레이스)가 한 줄도 남으면 안 된다.
      expect(
        consoleErrors.filter((line) => /Window \d+ extraction failed/.test(line)),
      ).toEqual([]);
    });
  }

  it('예산이 새 run 을 열면 같은 세션이 그대로 추출된다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'budget_deadline';
    await runFactExtraction(db, SESSION, PROJECT);

    const { exhaustModelBudget, startNewModelWorkRunForBudget } =
      await import('../src/model-budget.js');
    const stranded = factExtractJob().budget_id!;
    // 실제 경로에서는 reserveModelAttempt 가 이 전이를 남긴다 — 목 호출은
    // 예약 직전에서 끊기므로 여기서 같은 전이를 만든다.
    exhaustModelBudget(db, { budgetId: stranded, reason: 'deadline' });
    startNewModelWorkRunForBudget(db, {
      budgetId: stranded,
      limits: { maxAttempts: 5, deadlineAt: null },
    });
    llmBehavior.mode = 'ok';
    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.extracted).toBeGreaterThan(0);
    expect(loggedSessions()).toContain(SESSION);
  });

  it('A4: 다른 활성 예산에 묶인 job 도 wave 만 넘기면 affinity 오류 없이 추출된다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const { ensureExtractionTarget } = await import('../src/continuity-store.js');
    const { bindMemoryJobToBudget, startNewModelWorkRun } = await import('../src/model-budget.js');
    // 이 job 은 자기 run 에 이미 묶여 있고, 그 run 은 멀쩡히 살아 있다.
    const own = startNewModelWorkRun(db, {
      parentWaveId: 'worker:already-bound',
      limits: { maxAttempts: 5, deadlineAt: null },
    });
    const target = ensureExtractionTarget(db, { sessionId: SESSION, project: PROJECT });
    expect(target).not.toBeNull();
    bindMemoryJobToBudget(db, {
      jobId: target!.jobId,
      budgetId: own.budgetId,
      parentWaveId: own.parentWaveId,
    });

    // 전경 backfill 이 하는 것과 동일하게 **wave 만** 넘긴다 — budgetId 까지
    // 넘기면 여기서 ModelBudgetAffinityError 가 났다.
    llmBehavior.mode = 'ok';
    const result = await runFactExtraction(db, SESSION, PROJECT, {
      modelContext: { parentWaveId: 'backfill' },
    });
    expect(result.skipped).toBeUndefined();
    expect(result.saved).toBeGreaterThan(0);
    // 묶임은 그대로 — 살아 있는 예산을 빼앗지 않는다.
    expect(factExtractJob().budget_id).toBe(own.budgetId);
  });
});

/**
 * Codex 적대 리뷰 R5 회귀 — 마커 쓰기의 동시성/스키마 가정.
 *
 * 공통 뿌리: **마커를 쓰는 쪽이 "내가 마지막 상태 관측자"라고 가정**한다.
 *  HIGH-1 컬럼이 없으면(마이그레이션 락 지연) INSERT 가 통째로 실패 → 마커 미기록
 *         → 세션 영구 pending → 매 run 재추출 → 중복 fact 누적
 *  HIGH-2 세션 선정 후 다른 라이터가 성공 마커를 썼는데 실패 상태로 덮어씀 → 재추출
 */
describe('R5: 마커 쓰기 견고성', () => {

  it('HIGH-2: 내부 실패 UPSERT 는 다른 라이터의 성공 마커를 덮지 않는다', () => {
    // 워커의 내부-실패 UPSERT 와 동일한 SQL. 성공 마커(extracted>=0)가 이미 있는 상태.
    db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?,?,?,?)')
      .run('sess-race', new Date().toISOString(), 5, 5);

    db.prepare(`
      INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
      VALUES (?, ?, -4, 1)
      ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
        extracted = excluded.extracted, saved = excluded.saved
      WHERE extraction_log.extracted = -4
    `).run('sess-race', new Date().toISOString());

    const row = db.prepare('SELECT extracted, saved FROM extraction_log WHERE session_id = ?')
      .get('sess-race') as { extracted: number; saved: number };
    expect(row.extracted, '성공 마커가 -4 로 퇴행하면 재추출→중복 fact').toBe(5);
    expect(row.saved).toBe(5);
  });

  it('HIGH-2 대칭: 재시도 상태(-4)는 정상적으로 갱신된다 (가드가 과잉차단 아님)', () => {
    db.prepare('INSERT INTO extraction_log (session_id, processed_at, extracted, saved) VALUES (?,?,?,?)')
      .run('sess-retry', new Date().toISOString(), -4, 1);

    db.prepare(`
      INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
      VALUES (?, ?, -4, 2)
      ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
        extracted = excluded.extracted, saved = excluded.saved
      WHERE extraction_log.extracted = -4
    `).run('sess-retry', new Date().toISOString());

    const row = db.prepare('SELECT extracted, saved FROM extraction_log WHERE session_id = ?')
      .get('sess-retry') as { extracted: number; saved: number };
    expect(row.saved, '예산 카운터는 증가해야 한다').toBe(2);
  });
});

/**
 * R7 HIGH-3 — claim 실패의 2분류.
 * 전부 "구버전 DB"로 보고 선점 없이 진행하면 SQLITE_BUSY 같은 **일시 오류가
 * 상호배제를 우회**해 중복 LLM 호출·중복 insert 를 낸다. 일시 오류는 통과가 아니라
 * 보류다(external-probe-gate-classification).
 */

/**
 * R20 — 제외 판정의 경로 경계.
 *
 * raw prefix 로 비교하면 형제 프로젝트가 함께 배제된다: '/…/project-a' 가
 * '/…/project-a-sibling' 을 삼켜 그 프로젝트 세션이 영구 0/0 마커를 받고 fact 가
 * 영영 추출되지 않았다(실측 적격 8세션 전건). pending SQL 은 exact 매칭이라 선정은
 * 되고 여기서만 걸러져 **무음**이었다.
 */
const EX_BASE = path.join(os.tmpdir(), 'r20-exclude');
const SELF_PROJECT = path.join(EX_BASE, 'project-a');

describe('R20: 제외 판정은 경로 경계로', () => {
  beforeEach(() => {
    process.env.BACKFILL_EXCLUDE_PROJECTS = [
      SELF_PROJECT,
      path.join(SELF_PROJECT, 'scripts'),
    ].join(',');
  });
  afterEach(() => {
    delete process.env.BACKFILL_EXCLUDE_PROJECTS;
  });

  it('형제 프로젝트를 배제하지 않는다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'ok';
    const sibling = path.join(EX_BASE, 'project-a-sibling');
    const res = await runFactExtraction(db, SESSION, sibling);
    expect(res.skipped, 'project-a-sibling 은 별개 프로젝트다 — 배제되면 안 된다').toBeUndefined();
    expect(res.saved, '정상 추출돼야 한다').toBeGreaterThan(0);
  });

  it('자기 자신과 그 하위 경로는 계속 배제한다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'ok';
    for (const p of [SELF_PROJECT, path.join(SELF_PROJECT, 'scripts')]) {
      const res = await runFactExtraction(db, `${SESSION}-${p.length}`, p);
      expect(res.skipped, `${p} 는 배제 대상`).toBe('excluded_project');
    }
  });

  it('제외 마커를 못 썼으면 정상 제외와 구분해 알린다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'ok';
    db.exec('DROP TABLE IF EXISTS extraction_log'); // INSERT 실패 재현
    const res = await runFactExtraction(db, SESSION, SELF_PROJECT);
    // 마커가 없으면 다음 run 에 다시 선정된다 — '정상 제외'로 보고하면 무음 무진전.
    expect(res.skipped).toBe('excluded_project_unmarked');
  });
});
