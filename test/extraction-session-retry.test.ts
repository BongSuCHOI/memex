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

const llmBehavior: { mode: 'transient' | 'deterministic' | 'ok' } = { mode: 'ok' };

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

  it('AC4c: deterministic 실패는 throw 하지 않고 진행해 기록한다 (큐 wedge 방지)', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    llmBehavior.mode = 'deterministic';

    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.extracted).toBe(0);
    // 같은 입력은 같은 결과 — 영원히 재시도하면 큐가 막히므로 완료로 기록한다.
    expect(loggedSessions()).toContain(SESSION);
  });
});
