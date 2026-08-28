import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pendingExtractionCoreQuery,
  getExtractionConfig,
} from "../src/pending-extraction.js";

/**
 * LLM workdir cwd 게이트 회귀 테스트.
 *
 * 결함(2026-08-28): codex-exec.ts는 fs.mkdtempSync(tmpdir, "memory-bank-llm-")로
 * <tmpdir>/memory-bank-llm-XXXXXX (접미사 6자) 워크디렉터를 만드는데, 세 곳의
 * 예약-이름 술어(paths.ts isExcludedProject의 마지막 세그먼트 === 일치,
 * pendingExtractionCoreQuery와 pipeline-status의 `LIKE '%/memory-bank-llm'`)는
 * 정확한 basename만 매칭해 실제 생성 형태를 놓쳤다. 일단 실제로 인덱싱되는
 * worker rollout(cwd가 접미사 형태)은 어느 게이트로도 제외되지 않는다.
 *
 * 이 테스트는 pendingExtractionCoreQuery 게이트가 두 형태 모두 제외함을 고정한다.
 * (TS 쪽 isExcludedProject는 paths.test.ts가, status 쪽은 pipeline-status-slice가 소유.)
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
      extracted INTEGER, saved INTEGER, claim_owner TEXT,
      last_exchange_rowid INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function seedSession(
  db: Database.Database,
  sid: string,
  n: number,
  cwd: string,
): void {
  const ins = db.prepare(
    "INSERT INTO exchanges (session_id, timestamp, is_sidechain, cwd) VALUES (?, ?, 0, ?)",
  );
  for (let i = 0; i < n; i++) ins.run(sid, `2026-07-17T0${i % 10}:00:00Z`, cwd);
}

function pendingIds(db: Database.Database): string[] {
  const cfg = getExtractionConfig();
  const { sql, params } = pendingExtractionCoreQuery(cfg);
  return (db.prepare(sql).all(...params) as Array<{ sid: string }>).map(
    (r) => r.sid,
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-workdir-gate-"));
  dbPath = path.join(tmp, "db.sqlite");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("extraction gate: reserved LLM workdir cwd (basename + mkdtemp suffix)", () => {
  it("basename 형태(.../memory-bank-llm)의 세션은 pending에서 제외된다", () => {
    const db = makeDb();
    try {
      seedSession(db, "sess-plain", 3, "/tmp/x/memory-bank-llm");
      seedSession(db, "sess-normal", 3, "/tmp/real-project");
      const ids = pendingIds(db);
      expect(ids).toContain("sess-normal");
      expect(ids).not.toContain("sess-plain");
    } finally {
      db.close();
    }
  });

  it("mkdtemp 접미사 형태(memory-bank-llm-XXXXXX)의 세션도 pending에서 제외된다", () => {
    const db = makeDb();
    try {
      seedSession(db, "sess-mkdtemp", 3, "/tmp/memory-bank-llm-a1b2c3");
      seedSession(db, "sess-normal", 3, "/tmp/real-project");
      const ids = pendingIds(db);
      expect(ids).toContain("sess-normal");
      expect(ids).not.toContain("sess-mkdtemp");
    } finally {
      db.close();
    }
  });

  it("교환 중 하나라도 오염 cwd면 세션 전체가 제외된다(any-exchange 규칙 유지)", () => {
    const db = makeDb();
    try {
      // 첫 교환은 정상 프로젝트, 마지막 교환이 접미사 형태 workdir
      seedSession(db, "sess-mixed", 2, "/tmp/real-project");
      db.prepare(
        "UPDATE exchanges SET cwd = ? WHERE session_id = ? AND id = (SELECT MAX(id) FROM exchanges WHERE session_id = ?)",
      ).run("/tmp/memory-bank-llm-xyz9k1", "sess-mixed", "sess-mixed");
      const ids = pendingIds(db);
      expect(ids).not.toContain("sess-mixed");
    } finally {
      db.close();
    }
  });

  it("basename을 중간에 포함하는 slug는 실제 프로젝트로 남는다(과잉 매칭 방지)", () => {
    const db = makeDb();
    try {
      // 아카이브 slug 형태: 하나의 세그먼트 안에 basename이 중간 포함 — 실제 프로젝트
      seedSession(db, "sess-slug", 3, "/tmp/-Users-x-memory-bank-llm-docs");
      // 반면 마지막 세그먼트 자체가 memory-bank-llm- 접두사로 시작하면 예약
      // 네임스페이스로 제외한다(mkdtemp 폼 보호 — 문서화된 트레이드오프).
      seedSession(db, "sess-reserved", 3, "/tmp/real/memory-bank-llm-docs");
      const ids = pendingIds(db);
      expect(ids).toContain("sess-slug");
      expect(ids).not.toContain("sess-reserved");
    } finally {
      db.close();
    }
  });
});
