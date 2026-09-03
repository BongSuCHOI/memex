import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

/**
 * R6 HIGH E2E — 훅↔워커 중복 추출 회귀.
 *
 * 다른 테스트들이 워커 SQL 을 문자열로 복제해 검증하는 것과 달리(그러면 실제
 * 스크립트가 바뀌어도 초록으로 남는다), 이 테스트는 **실제 파이프라인 2개를 동시에**
 * 돌려 저장된 fact 수를 센다. 수정 전 코드에서 실측: fact 2건·LLM 2회 → FAIL.
 * 수정 후: fact 1건·LLM 1회 (한쪽이 claim 에 막혀 skip).
 */

let calls = 0;
let sourceIndicesPerFact: number[][] | null = null;
let factNameForCall: ((call: number, index: number) => string) | null = null;
vi.mock('../src/llm.js', async (io) => ({ ...(await io<typeof import('../src/llm.js')>()),
  callMemoryModel: async () => { calls++; await new Promise(r => setTimeout(r, 60));
    return JSON.stringify(Array.from({ length: factsPerCall }, (_, i) =>
      ({ fact: factNameForCall?.(calls, i) ?? `dup-probe-${calls}-${i}`, category: 'preference', scope_type: 'project', confidence: 0.9,
        source_exchange_indices: sourceIndicesPerFact?.[i] ?? [1] }))); } }));
let factsPerCall = 1;
let embedCalls = 0;
let stealAtEmbedCall = 0; // >0 이면 그 호출 시점에 claim 을 탈취(결정론적 재현)
let stealHook: (() => void) | null = null;
vi.mock('../src/embeddings.js', async (io) => ({ ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => {
    embedCalls++;
    if (stealAtEmbedCall && embedCalls === stealAtEmbedCall) stealHook?.();
    return new Array(384).fill(0.01);
  } }));
vi.mock('../src/ontology-classifier.js', async (io) => ({ ...(await io<typeof import('../src/ontology-classifier.js')>()), classifyAndLinkFact: async () => {} }));

let tmp: string; let db: import('better-sqlite3').Database;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-claim-e2e-'));
  process.env.MEMEX_HOME = tmp;
  process.env.MEMEX_DB_PATH = path.join(tmp, 't.sqlite');
  calls = 0; factsPerCall = 1; sourceIndicesPerFact = null; factNameForCall = null; embedCalls = 0; stealAtEmbedCall = 0; stealHook = null;
  const { initDatabase } = await import('../src/db.js');
  db = initDatabase();
  const ins = db.prepare(`INSERT INTO exchanges (id,project,timestamp,user_message,assistant_message,archive_path,line_start,line_end,session_id,is_sidechain) VALUES (?,?,?,?,?,?,?,?,?,0)`);
  for (let i = 0; i < 2; i++) ins.run(`e${i}`, '/tmp/p', new Date().toISOString(),
    'Flutter 상태관리를 Riverpod 과 Bloc 중 무엇으로 할지 결정해야 합니다. 이유도 알려주세요.',
    'Riverpod 을 권장합니다. 컴파일 타임 안전성과 테스트 용이성 때문입니다.', `/tmp/a${i}.jsonl`, 1, 10, 'S1');
});
afterEach(() => { try { db.close(); } catch {} ; delete process.env.MEMEX_HOME; delete process.env.MEMEX_DB_PATH; fs.rmSync(tmp, {recursive:true,force:true}); });

describe('claim E2E', () => {
  it('각 fact에는 모델이 지목한 source exchange UUID만 저장한다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    factsPerCall = 2;
    sourceIndicesPerFact = [[1], [2]];

    await runFactExtraction(db, 'S1', '/tmp/p');

    const rows = db.prepare(
      "SELECT fact, source_exchange_ids FROM facts WHERE fact LIKE 'dup-probe%' ORDER BY fact",
    ).all() as Array<{ fact: string; source_exchange_ids: string }>;
    expect(rows.map((row) => [row.fact, JSON.parse(row.source_exchange_ids)])).toEqual([
      ['dup-probe-1-0', ['e0']],
      ['dup-probe-1-1', ['e1']],
    ]);
  });

  it('source exchange index 누락·범위 이탈 fact는 저장하지 않고 중복 index는 정규화한다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    factsPerCall = 4;
    sourceIndicesPerFact = [[], [0], [3], [2, 2]];

    const result = await runFactExtraction(db, 'S1', '/tmp/p');

    expect(result.extracted).toBe(1);
    const rows = db.prepare(
      "SELECT fact, source_exchange_ids FROM facts WHERE fact LIKE 'dup-probe%'",
    ).all() as Array<{ fact: string; source_exchange_ids: string }>;
    expect(rows.map((row) => [row.fact, JSON.parse(row.source_exchange_ids)])).toEqual([
      ['dup-probe-1-3', ['e1']],
    ]);
  });

  it('같은 fact가 여러 배치에서 재추출되면 각 배치의 검증된 source UUID를 합친다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const insert = db.prepare(`
      INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path,
         line_start, line_end, session_id, is_sidechain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    for (let i = 2; i < 6; i++) {
      insert.run(
        `e${i}`, '/tmp/p', new Date(Date.now() + i * 1000).toISOString(),
        `교환 ${i}에서 프로젝트 전반에 같은 상태관리 결정을 명시합니다.`,
        'Riverpod 결정을 확인합니다.', `/tmp/a${i}.jsonl`, i * 10, i * 10 + 9, 'S1',
      );
    }
    factNameForCall = () => 'cross-batch-fact';

    await runFactExtraction(db, 'S1', '/tmp/p');

    const row = db.prepare(
      "SELECT source_exchange_ids FROM facts WHERE fact = 'cross-batch-fact'",
    ).get() as { source_exchange_ids: string };
    expect(JSON.parse(row.source_exchange_ids)).toEqual(['e0', 'e5']);
  });

  it('동일 SessionEnd는 no-op이고 재개 세션은 새 exchange만 증분 처리한다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');

    await runFactExtraction(db, 'S1', '/tmp/p');
    const firstWatermark = (db.prepare(
      'SELECT last_exchange_rowid FROM extraction_log WHERE session_id = ?',
    ).get('S1') as { last_exchange_rowid: number }).last_exchange_rowid;
    expect(calls).toBe(1);
    expect(firstWatermark).toBe(2);

    await runFactExtraction(db, 'S1', '/tmp/p');
    expect(calls, '동일 transcript 재실행은 LLM을 다시 호출하지 않아야 한다').toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(1);

    db.prepare(`
      INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path,
         line_start, line_end, session_id, is_sidechain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      'e2', '/tmp/p', new Date(Date.now() + 1000).toISOString(),
      '새 요구사항으로 Riverpod provider 범위를 프로젝트 전체에서 화면 단위로 제한하기로 결정했습니다.',
      '화면 단위 ProviderScope를 사용하면 수명주기와 테스트 격리가 더 명확해집니다.',
      '/tmp/a2.jsonl', 11, 20, 'S1',
    );

    await runFactExtraction(db, 'S1', '/tmp/p');
    expect(calls, '재개 세션은 새 exchange 배치에 대해 한 번만 호출해야 한다').toBe(2);
    const incremental = db.prepare(
      "SELECT source_exchange_ids FROM facts WHERE fact = 'dup-probe-2-0'",
    ).get() as { source_exchange_ids: string };
    expect(JSON.parse(incremental.source_exchange_ids)).toEqual(['e2']);
    const finalWatermark = (db.prepare(
      'SELECT last_exchange_rowid FROM extraction_log WHERE session_id = ?',
    ).get('S1') as { last_exchange_rowid: number }).last_exchange_rowid;
    expect(finalWatermark).toBe(3);
  });

  it('훅과 워커가 같은 세션을 동시에 처리해도 fact 는 한 벌만 저장된다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const [a, b] = await Promise.all([
      runFactExtraction(db, 'S1', '/tmp/p'),
      // options 는 4번째 인자다(재감사 P1-8). 5번째로 넘기면 JS 가 버려서
      // 이 테스트가 hook-vs-hook 이 되어 worker 변형을 전혀 검증하지 못했다.
      runFactExtraction(db, 'S1', '/tmp/p', { claimVariant: 'worker' }),
    ]);
    const n = (db.prepare("SELECT COUNT(*) c FROM facts WHERE fact LIKE 'dup-probe%'").get() as {c:number}).c;
    console.log(`  → 저장된 fact ${n}건, saved=(${a.saved},${b.saved}), LLM 호출 ${calls}회`);
    expect(n, '한쪽은 claim 에 막혀 skip 되어야 한다').toBeLessThanOrEqual(1);
    expect(Math.min(a.saved, b.saved)).toBe(0);
  });

  it('재감사 P1-8/T11: worker 변형은 훅이 정리한 세션을 다시 열지 않는다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');

    // SessionEnd(hook 변형)가 세션을 settle한다 — 성공 마커 + 현재 워터마크.
    await runFactExtraction(db, 'S1', '/tmp/p');
    const settledCalls = calls;
    expect(settledCalls).toBe(1);

    // backfill worker 변형: settled + 워터마크 현재 → no-op 게이트에서 종료 (LLM 0회).
    const settled = await runFactExtraction(db, 'S1', '/tmp/p', { claimVariant: 'worker' });
    expect(settled.skipped).toBeUndefined();
    expect(calls).toBe(settledCalls);
    expect((db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(1);

    // seed 마커 위에 suffix 가 쌓인 상태: worker 변형은 선점을 거절한다 —
    // seed suffix 의 재추출은 SessionEnd 훅이 담당한다는 설계 계약(pending-extraction).
    // LLM 0회, fact 0건.
    db.prepare(
      "UPDATE extraction_log SET extracted = -1, saved = -1 WHERE session_id = 'S1'",
    ).run();
    db.prepare(`
      INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path,
         line_start, line_end, session_id, is_sidechain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      'e2', '/tmp/p', new Date(Date.now() + 1000).toISOString(),
      '새 요구사항으로 Riverpod provider 범위를 화면 단위로 제한하기로 결정했습니다.',
      '화면 단위 ProviderScope를 사용하면 테스트 격리가 명확해집니다.',
      '/tmp/a2.jsonl', 11, 20, 'S1',
    );
    const refused = await runFactExtraction(db, 'S1', '/tmp/p', { claimVariant: 'worker' });
    expect(refused.skipped).toBe('claim_not_acquired');
    expect(calls).toBe(settledCalls);
    expect((db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(1);

    // 대조: hook 변형은 같은 상태에서 suffix 를 회수한다 — 변형이 동작을 바꾼다.
    const hookRun = await runFactExtraction(db, 'S1', '/tmp/p');
    expect(hookRun.skipped).toBeUndefined();
    expect(calls).toBe(settledCalls + 1);
  });

  it('R7 HIGH-1: 리스를 빼앗기면 즉시 중단해 중복 저장하지 않는다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    // 추출 시작 직후 다른 러너가 claim 을 탈취한 상황을 재현:
    // 첫 배치 LLM 호출 중에 claim_owner 를 바꿔치기한다.
    setTimeout(() => {
      try { db.prepare("UPDATE extraction_log SET claim_owner = 'thief' WHERE session_id = 'S1'").run(); }
      catch { /* ignore */ }
    }, 20);
    await expect(runFactExtraction(db, 'S1', '/tmp/p')).rejects.toThrow(/claim lost/i);
    const n = (db.prepare("SELECT COUNT(*) c FROM facts WHERE fact LIKE 'dup-probe%'").get() as {c:number}).c;
    console.log(`  → 탈취 후 저장된 fact ${n}건 (중단되어야 하므로 0)`);
    expect(n, 'claim 을 잃고도 계속 저장하면 중복이 된다').toBe(0);
  });

  it('R8 HIGH: 저장 구간에서 리스를 빼앗겨도 중단한다 (가장 긴 단계 보호)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    factsPerCall = 4; // 저장 루프가 여러 번 돌도록
    // 결정론적 재현: 2번째 임베딩(=2번째 fact 저장 중) 시점에 claim 탈취.
    // 타이머는 임베딩이 스텁이라 저장이 먼저 끝나 재현이 안 된다(플레이키).
    stealAtEmbedCall = 2;
    stealHook = () => { db.prepare("UPDATE extraction_log SET claim_owner = 'thief' WHERE session_id = 'S1'").run(); };
    await expect(runFactExtraction(db, 'S1', '/tmp/p')).rejects.toThrow(/claim lost/i);
    const n = (db.prepare("SELECT COUNT(*) c FROM facts WHERE fact LIKE 'dup-probe%'").get() as {c:number}).c;
    console.log(`  → 저장 중 탈취: fact ${n}건에서 중단 (4건 전부 저장되면 실패)`);
    expect(n, '탈취 후에도 계속 저장하면 새 소유자와 중복된다').toBeLessThan(4);
  });


  it('R9 HIGH: 마지막(유일) fact 구간에서 탈취돼도 저장이 남지 않는다 (원자적 커밋)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    factsPerCall = 1;               // fact 1건 = 루프 꼬리 = 체크포인트 사각
    stealAtEmbedCall = 1;           // 그 유일한 fact 의 임베딩 중 탈취
    stealHook = () => { db.prepare("UPDATE extraction_log SET claim_owner = 'thief' WHERE session_id = 'S1'").run(); };

    // 체크포인트 방식이면 여기서 예외 없이 성공 반환 + fact 1건이 남는다.
    // 원자적 커밋이면 마커가 0행 → 트랜잭션 롤백 → fact 0건.
    let saved = -1;
    try { saved = (await runFactExtraction(db, 'S1', '/tmp/p')).saved; } catch { saved = -1; }
    const n = (db.prepare("SELECT COUNT(*) c FROM facts WHERE fact LIKE 'dup-probe%'").get() as {c:number}).c;
    console.log(`  → 루프 꼬리 탈취: 저장된 fact ${n}건 (saved=${saved})`);
    expect(n, '탈취 후 남은 fact 는 새 소유자의 재추출과 중복된다').toBe(0);
  });

  it('R10 MEDIUM: claim 이양은 ClaimLostError 로 구분돼 내부 실패로 오분류되지 않는다', async () => {
    const { runFactExtraction, ClaimLostError } = await import('../src/fact-extractor.js');
    factsPerCall = 1; stealAtEmbedCall = 1;
    stealHook = () => { db.prepare("UPDATE extraction_log SET claim_owner = 'thief' WHERE session_id = 'S1'").run(); };

    let caught: unknown;
    try { await runFactExtraction(db, 'S1', '/tmp/p'); } catch (e) { caught = e; }
    expect(caught, '이양은 전용 타입이어야 소비자가 3분류할 수 있다').toBeInstanceOf(ClaimLostError);

    const row = db.prepare('SELECT extracted, saved FROM extraction_log WHERE session_id = ?')
      .get('S1') as { extracted: number; saved: number };
    console.log(`  → 이양 후 상태: extracted=${row.extracted} saved=${row.saved}`);
    expect(row.extracted, '남의 claim(-3)이 유지돼야 한다 — 예산(-4) 소모 금지').toBe(-3);
  });
});

/**
 * R11 MEDIUM — **소비자측** 분류 검증.
 * 기존 테스트는 producer(전용 타입 throw)만 덮었고, 워커가 그 타입을 어떻게 읽는지는
 * 검증되지 않았다. 두 워커가 표현식을 각자 인라인으로 들면 드리프트하므로(R6 계열),
 * 분류를 단일 소스 함수로 두고 그 함수를 직접 고정한다.
 */
describe('R11: 소비자 분류 단일 소스', () => {
  it('4분류: 예산을 태우는 실패와 아닌 실패를 정확히 가른다', async () => {
    const { classifyExtractionFailure, failureConsumesBudget, FAILURE_REPORT, ClaimLostError } =
      await import('../src/fact-extractor.js');
    const { LlmCallError } = await import('../src/llm-error-class.js');

    const cases: Array<[unknown, string, boolean]> = [
      [new ClaimLostError('taken'), 'handoff', false],
      [new LlmCallError(Object.assign(new Error('service unavailable'), { status: 503 })), 'provider_transient', false],
      [new LlmCallError(Object.assign(new Error('prompt is too long'), { status: 413 })), 'provider_deterministic', true],
      [new Error('embedding runtime blew up'), 'internal', true],
      [new TypeError('undefined is not a function'), 'internal', true],
    ];
    for (const [err, kind, burns] of cases) {
      expect(classifyExtractionFailure(err), String(kind)).toBe(kind);
      // 🚨 R12 HIGH 회귀: deterministic 거절은 예산을 **태운다**. 이걸 'provider' 로
      // 뭉개면 워커가 "will retry next run" 이라 보고하는 동안 예산이 조용히 소진된다.
      expect(failureConsumesBudget(kind as never), `${kind} 예산 판정`).toBe(burns);
      // 보고 문구도 같은 소스에서 나와야 라우팅과 어긋나지 않는다
      expect(FAILURE_REPORT[kind as never]).toBeDefined();
    }
  });

  // ⚠️ 이 테스트는 **분류기 분기 수**를 세는 것이지 파이프라인 도달성을 주장하지 않는다.
  //    provider_deterministic 은 현 파이프라인에서 도달하지 않는다(배치 루프가 드롭) —
  //    손으로 만든 에러로 도달성을 주장하면 vacuous 다(Codex R13 LOW).
  it('보고 표가 모든 분류를 덮는다 (새 분류 추가 시 누락 방지)', async () => {
    const { FAILURE_REPORT, failureConsumesBudget } = await import('../src/fact-extractor.js');
    const kinds = Object.keys(FAILURE_REPORT) as Array<keyof typeof FAILURE_REPORT>;
    expect(kinds.length, '표가 분류를 전부 덮어야 한다').toBe(4);
    for (const k of kinds) {
      const rep = FAILURE_REPORT[k];
      expect(rep.note, `${k} 문구 누락`).toBeTruthy();
      expect(['handoff', 'transient', 'budget'], `${k} 버킷`).toContain(rep.bucket);
      // 표와 술어가 어긋나면 "예산은 타는데 카운터는 재시도"가 된다
      expect(failureConsumesBudget(k), `${k} 술어↔표 불일치`).toBe(rep.consumesBudget);
      // budget 버킷 ⇔ 예산 소모 (버킷을 잘못 붙이면 집계가 거짓말한다)
      expect(rep.bucket === 'budget', `${k} 버킷↔예산 불일치`).toBe(rep.consumesBudget);
    }
    expect(FAILURE_REPORT.handoff.label, '이양은 로그에서 실패와 구분돼야 한다').toBe('HANDOFF');
    // 운영 에스컬레이션은 internal 에만 — 예산 회계에 섞이면 손댈 실패가 묻힌다
    expect(FAILURE_REPORT.internal.escalate).toBe(true);
    expect(FAILURE_REPORT.provider_deterministic.escalate).toBe(false);
    expect(FAILURE_REPORT.provider_transient.escalate).toBe(false);
    expect(FAILURE_REPORT.handoff.escalate).toBe(false);
  });

  it('워커가 카운팅 분기를 자체 구현하지 않는다 (반대로 붙어도 통과하는 테스트 방지)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('scripts/backfill-extract-worker.js', 'utf8');
    // 버킷을 표에서 그대로 읽어야 한다 — 조건 분기가 있으면 반전 실수를 잡을 수 없다
    expect(src, '버킷 집계가 표 기반이어야 한다').toContain('buckets[rep.bucket]');
    expect(src.includes('failureConsumesBudget('), '워커가 예산 판정을 재구현').toBe(false);
    // 운영 경보가 요약줄에 남아 있어야 한다(R12 수정 중 사라졌던 회귀의 고정)
    expect(src, 'INTERNAL 경보 누락').toContain('INTERNAL failures');
    expect(src, 'escalate 신호 미사용').toContain('rep.escalate');
  });

  it('훅 워커는 로깅이 깨져도 훅 실패로 표면화하지 않는다', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('scripts/fact-extract-worker.js', 'utf8');
    // exitCode 확정이 표 역참조보다 앞서야 한다 — 스큐로 TypeError 가 나도 불변식 유지
    const iExit = src.indexOf('process.exitCode = 0');
    const iRep = src.indexOf('FAILURE_REPORT?.[cls]');
    expect(iExit).toBeGreaterThan(-1);
    expect(iRep).toBeGreaterThan(-1);
    expect(iExit, 'exitCode 확정이 역참조보다 뒤면 불변식이 깨진다').toBeLessThan(iRep);
    expect(src, '최상위 rejection 미처리').toContain('main().catch(');
  });

  it('두 워커가 같은 단일 소스를 사용한다 (드리프트 차단)', async () => {
    const fs = await import('node:fs');
    for (const w of ['scripts/fact-extract-worker.js', 'scripts/backfill-extract-worker.js']) {
      const src = fs.readFileSync(w, 'utf8');
      expect(src, `${w} 가 분류를 인라인으로 재구현하면 드리프트한다`).toContain('classifyExtractionFailure');
      expect(src.includes('instanceof ClaimLostError'), `${w} 인라인 분기 잔존`).toBe(false);
      // 라벨/예산 판정도 자체 구현하면 분류와 어긋난다 — 단일 소스 사용을 강제
      expect(src, `${w} 가 보고 문구를 자체 정의`).toContain('FAILURE_REPORT');
    }
  });
});
