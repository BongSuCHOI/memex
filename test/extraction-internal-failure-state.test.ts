import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pendingExtractionCoreQuery, getExtractionConfig,
  EXTRACTION_STATE, MAX_INTERNAL_RETRIES,
} from '../src/pending-extraction.js';

/**
 * 제3의 터미널 상태 회귀 테스트 (Codex 적대 리뷰 R4 CRITICAL).
 *
 * 배경 — 두 라운드가 서로의 수정을 되돌리는 **진동**이 있었다:
 *   R3 HIGH : 내부 실패를 이연했더니 런타임이 깨진 동안 최신 세션만 매 run 재시도되고
 *             오래된 백로그가 기아했다.
 *   R4 CRIT : 그래서 영구 마커(-2)를 남겼더니 임베딩/DB 가 한 번 튄 세션의 fact 가
 *             pending 쿼리에서 영구 제외돼 영영 추출되지 않았다.
 *
 * 어느 한쪽을 고르면 반대편이 재발하므로, 내부 실패에는 **재시도 예산을 가진 별도
 * 상태(-4)**를 준다. 이 테스트는 그 계약의 양끝을 고정한다:
 *   ① 예산이 남은 -4 세션은 여전히 pending 이다 (손실 없음 = R4 방어)
 *   ② 예산을 소진하면 pending 에서 빠진다   (큐 물림 없음 = R3 방어)
 */

let tmp: string;
let dbPath: string;

function makeDb(): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE exchanges (
      id INTEGER PRIMARY KEY, session_id TEXT, timestamp TEXT,
      is_sidechain INTEGER DEFAULT 0, cwd TEXT
    );
    CREATE TABLE extraction_log (
      session_id TEXT PRIMARY KEY, processed_at TEXT,
      extracted INTEGER, saved INTEGER
    );
  `);
  return db;
}

/** 최소 교환 수를 넘기도록 세션 하나에 n 개 교환을 넣는다. */
function seedSession(db: Database.Database, sid: string, n: number): void {
  const ins = db.prepare('INSERT INTO exchanges (session_id, timestamp, is_sidechain, cwd) VALUES (?, ?, 0, ?)');
  for (let i = 0; i < n; i++) ins.run(sid, `2026-07-17T0${i % 10}:00:00Z`, '/tmp/proj');
}

function pendingIds(db: Database.Database): string[] {
  const cfg = getExtractionConfig();
  const { sql, params } = pendingExtractionCoreQuery(cfg);
  return (db.prepare(sql).all(...params) as Array<{ sid: string }>).map(r => r.sid);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-internal-state-'));
  dbPath = path.join(tmp, 'db.sqlite');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('내부 실패 = 재시도 예산을 가진 제3 상태 (-4)', () => {
  it('R4 회귀: 내부 실패 마커가 있어도 예산이 남으면 세션은 여전히 pending 이다', () => {
    const db = makeDb();
    try {
      seedSession(db, 'sess-internal', 12);
      // 워커가 임베딩/DB throw 를 만나 1회차 실패를 기록한 상태
      db.prepare('INSERT INTO extraction_log VALUES (?, ?, ?, ?)')
        .run('sess-internal', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, 1);

      expect(pendingIds(db)).toContain('sess-internal');
    } finally { db.close(); }
  });

  it('예산 경계: 소진 직전(=MAX-1)까지는 pending, 소진(MAX)하면 빠진다', () => {
    const db = makeDb();
    try {
      seedSession(db, 'sess-a', 12);
      const upd = db.prepare(`
        INSERT INTO extraction_log VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET saved = excluded.saved
      `);
      for (let attempts = 1; attempts < MAX_INTERNAL_RETRIES; attempts++) {
        upd.run('sess-a', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, attempts);
        expect(pendingIds(db), `attempt ${attempts} 는 아직 예산이 남음`).toContain('sess-a');
      }
      upd.run('sess-a', new Date().toISOString(), EXTRACTION_STATE.RETRIABLE_INTERNAL, MAX_INTERNAL_RETRIES);
      expect(pendingIds(db), 'R3 방어: 예산 소진 후에는 큐가 물리지 않는다').not.toContain('sess-a');
    } finally { db.close(); }
  });

  it('다른 상태는 영향받지 않는다 — 성공/seed/영구실패는 계속 제외된다', () => {
    const db = makeDb();
    try {
      for (const sid of ['done', 'seed', 'permanent', 'fresh']) seedSession(db, sid, 12);
      const ins = db.prepare('INSERT INTO extraction_log VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      ins.run('done', now, 3, 3);                            // 정상 추출 완료
      ins.run('seed', now, EXTRACTION_STATE.SEED, 0);        // 과거 fact 보유
      ins.run('permanent', now, EXTRACTION_STATE.PERMANENT, 0); // 결정론적 거절

      const pending = pendingIds(db);
      expect(pending).toEqual(['fresh']); // 기록 없는 세션만 pending
    } finally { db.close(); }
  });

  it('상태 코드는 서로 겹치지 않는다 (마커 오독 방지)', () => {
    const codes = Object.values(EXTRACTION_STATE);
    expect(new Set(codes).size).toBe(codes.length);
    // 전부 음수여야 한다 — 0 이상은 "성공적으로 추출한 fact 수" 의미로 예약됨
    for (const c of codes) expect(c).toBeLessThan(0);
    expect(MAX_INTERNAL_RETRIES).toBeGreaterThan(0);
  });
});
