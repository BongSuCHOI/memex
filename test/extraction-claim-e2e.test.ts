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
vi.mock('../src/llm.js', async (io) => ({ ...(await io<typeof import('../src/llm.js')>()),
  callHaiku: async () => { calls++; await new Promise(r => setTimeout(r, 60));
    return JSON.stringify([{ fact: `dup-probe-${calls}`, category: 'preference', scope_type: 'project', confidence: 0.9 }]); } }));
vi.mock('../src/embeddings.js', async (io) => ({ ...(await io<typeof import('../src/embeddings.js')>()),
  initEmbeddings: async () => {}, generateEmbedding: async () => new Array(384).fill(0.01) }));
vi.mock('../src/ontology-classifier.js', async (io) => ({ ...(await io<typeof import('../src/ontology-classifier.js')>()), classifyAndLinkFact: async () => {} }));

let tmp: string; let db: import('better-sqlite3').Database;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-claim-e2e-'));
  process.env.MEMORY_BANK_CONFIG_DIR = tmp;
  process.env.MEMORY_BANK_DB_PATH = path.join(tmp, 't.sqlite');
  calls = 0;
  const { initDatabase } = await import('../src/db.js');
  db = initDatabase();
  const ins = db.prepare(`INSERT INTO exchanges (id,project,timestamp,user_message,assistant_message,archive_path,line_start,line_end,session_id,is_sidechain) VALUES (?,?,?,?,?,?,?,?,?,0)`);
  for (let i = 0; i < 2; i++) ins.run(`e${i}`, '/tmp/p', new Date().toISOString(),
    'Flutter 상태관리를 Riverpod 과 Bloc 중 무엇으로 할지 결정해야 합니다. 이유도 알려주세요.',
    'Riverpod 을 권장합니다. 컴파일 타임 안전성과 테스트 용이성 때문입니다.', `/tmp/a${i}.jsonl`, 1, 10, 'S1');
});
afterEach(() => { try { db.close(); } catch {} ; delete process.env.MEMORY_BANK_CONFIG_DIR; delete process.env.MEMORY_BANK_DB_PATH; fs.rmSync(tmp, {recursive:true,force:true}); });

describe('claim E2E', () => {
  it('훅과 워커가 같은 세션을 동시에 처리해도 fact 는 한 벌만 저장된다', async () => {
    const { runFactExtraction } = await import('../src/fact-extractor.js');
    const [a, b] = await Promise.all([
      runFactExtraction(db, 'S1', '/tmp/p'),
      runFactExtraction(db, 'S1', '/tmp/p', undefined, { claimVariant: 'worker' }),
    ]);
    const n = (db.prepare("SELECT COUNT(*) c FROM facts WHERE fact LIKE 'dup-probe%'").get() as {c:number}).c;
    console.log(`  → 저장된 fact ${n}건, saved=(${a.saved},${b.saved}), LLM 호출 ${calls}회`);
    expect(n, '한쪽은 claim 에 막혀 skip 되어야 한다').toBeLessThanOrEqual(1);
    expect(Math.min(a.saved, b.saved)).toBe(0);
  });
});
