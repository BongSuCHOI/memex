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
 * 수정 후: transient 는 throw 되어 extraction_log 가 기록되지 않고(=다음 run 재시도),
 * deterministic 은 그 배치만 버리고 진행한다(=큐를 막지 않음).
 */

const llmBehavior: { mode: 'transient' | 'deterministic' | 'ok' | 'unknown' } = { mode: 'ok' };

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callHaiku: async () => {
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
      return JSON.stringify([
        { fact: 'User prefers Riverpod for Flutter state management', category: 'preference', scope_type: 'project', confidence: 0.9 },
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
      `Flutter 프로젝트에서 상태관리를 무엇으로 할지 결정해야 합니다. Riverpod 과 Bloc 중 어느 쪽이 좋을까요? 이유도 알려주세요.`,
      `Riverpod 을 권장합니다. 이유는 컴파일 타임 안전성과 테스트 용이성 때문입니다. Bloc 은 보일러플레이트가 많습니다.`,
      `/tmp/archive-${i}.jsonl`, 1, 10, SESSION,
    );
  }
  return database;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-extract-retry-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmpDir, 'test.sqlite');
  llmBehavior.mode = 'ok';
  db = await setupDb();
});
afterEach(() => {
  try { db?.close(); } catch { /* already closed */ }
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.MEMORY_BANK_DB_PATH;
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
    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.extracted).toBeGreaterThan(0);
    expect(loggedSessions()).toContain(SESSION); // 이제서야 완료 기록
  });

  it('AC4d: 인식 못 한 에러(unknown)도 세션을 잃지 않는다 (Codex 리뷰 회귀 고정)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'unknown';

    // 추출은 consolidation 과 달리 건너뛰면 fact 가 아예 안 생긴다 → 이연이 옳다.
    await expect(runFactExtraction(db, SESSION, PROJECT)).rejects.toThrow(/weird provider hiccup/);
    expect(loggedSessions()).not.toContain(SESSION);
  });

  it('AC4c: deterministic 실패는 throw 하지 않고 진행해 기록한다 (큐 wedge 방지)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'deterministic';

    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.extracted).toBe(0);
    // 같은 입력은 같은 결과 — 영원히 재시도하면 큐가 막히므로 완료로 기록한다.
    expect(loggedSessions()).toContain(SESSION);
  });

  it('AC4e: 폐기된 배치는 dead-letter 로 기록돼 조회 가능하다 (무음 손실 금지)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'deterministic';

    await runFactExtraction(db, SESSION, PROJECT);
    const row = db.prepare(
      'SELECT dropped_batches FROM extraction_log WHERE session_id = ?',
    ).get(SESSION) as { dropped_batches: number } | undefined;
    // 폐기 사실이 DB 에 남아야 "왜 이 세션엔 fact 가 없나"를 사후에 답할 수 있다.
    expect(row?.dropped_batches).toBeGreaterThan(0);
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
 * Codex 적대 리뷰 R5 회귀 — 마커 쓰기의 동시성/스키마 가정.
 *
 * 공통 뿌리: **마커를 쓰는 쪽이 "내가 마지막 상태 관측자"라고 가정**한다.
 *  HIGH-1 컬럼이 없으면(마이그레이션 락 지연) INSERT 가 통째로 실패 → 마커 미기록
 *         → 세션 영구 pending → 매 run 재추출 → 중복 fact 누적
 *  HIGH-2 세션 선정 후 다른 라이터가 성공 마커를 썼는데 실패 상태로 덮어씀 → 재추출
 */
describe('R5: 마커 쓰기 견고성', () => {
  it('HIGH-1: dropped_batches 컬럼이 없어도 마커는 반드시 기록된다 (재추출/중복 차단)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'ok';
    // 마이그레이션이 락으로 지연된 상태를 재현: 컬럼만 없는 extraction_log
    db.exec('DROP TABLE IF EXISTS extraction_log');
    // dropped_batches 만 없는 상태(= 그 마이그레이션만 지연). claim_owner 는 있다.
    db.exec(`CREATE TABLE extraction_log (
      session_id TEXT PRIMARY KEY, processed_at TEXT, extracted INTEGER, saved INTEGER,
      claim_owner TEXT
    )`);

    await runFactExtraction(db, SESSION, PROJECT);

    const row = db.prepare('SELECT extracted FROM extraction_log WHERE session_id = ?')
      .get(SESSION) as { extracted: number } | undefined;
    // 수정 전에는 'no such column: dropped_batches' 로 INSERT 가 죽고 catch 가 삼켜
    // 이 행이 아예 없었다 → 세션이 영구 pending.
    expect(row, '컬럼이 없어도 멱등성 마커는 남아야 한다').toBeDefined();
    expect(row!.extracted).toBeGreaterThanOrEqual(0);
  });

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
describe('R7: claim 실패 분류', () => {
  it('스키마 오류(일시)는 선점 없이 진행하지 않고 보류한다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'ok';
    // claim_owner 가 없는 테이블 → claim SQL 이 'no such column' 으로 실패
    db.exec('DROP TABLE IF EXISTS extraction_log');
    db.exec(`CREATE TABLE extraction_log (
      session_id TEXT PRIMARY KEY, processed_at TEXT, extracted INTEGER, saved INTEGER
    )`);

    const before = (db.prepare('SELECT COUNT(*) c FROM facts').get() as { c: number }).c;
    const res = await runFactExtraction(db, SESSION, PROJECT);
    const after = (db.prepare('SELECT COUNT(*) c FROM facts').get() as { c: number }).c;

    expect(res, '선점 못 했으면 이번 실행은 아무것도 하지 않는다').toEqual({ extracted: 0, saved: 0 });
    expect(after, '가드 없이 진행하면 다른 러너와 중복 저장한다').toBe(before);
  });

  it('테이블 자체가 없는 구버전 DB 는 기존대로 진행한다 (하위호환)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'ok';
    db.exec('DROP TABLE IF EXISTS extraction_log');

    const res = await runFactExtraction(db, SESSION, PROJECT);
    expect(res.saved, '구버전 DB 에서도 추출은 동작해야 한다').toBeGreaterThan(0);
  });
});
