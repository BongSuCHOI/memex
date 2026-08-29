import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase, insertExchange, deleteExchange } from "../src/db.js";
import { commitExchangeReembed, exchangeContentHash } from "../src/exchange-reembed.js";
import type Database from "better-sqlite3";

/**
 * 재감사 P1-2 — exchange reembed content CAS 회귀.
 *
 * stable exchange id는 in-place content 갱신(assistant partial → complete →
 * tool evidence 추가)과 privacy purge를 허용한다. reembed commit은 임베딩
 * 대기 전에 캡처한 content hash로 CAS해야 한다: 내용이 변했거나 행이
 * 지워졌으면 벡터를 통째로 폐기한다 — 그렇지 않으면 (a) 옛 턴의 벡터가
 * 완성된 문장에 embedding_version=current로 붙거나, (b) 삭제된 대화의
 * vec 행이 부활한다(vec0에는 FK가 없다).
 */

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mx-exchange-reembed-"));
  process.env.MEMEX_HOME = tmp;
  process.env.MEMEX_DB_PATH = path.join(tmp, "t.sqlite");
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EMB = () => new Array(384).fill(0.05);

function vecRowCount(id: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM vec_exchanges_rowids WHERE id = ?").get(id) as { n: number }).n;
}

function seedExchange(opts: { withTool?: boolean } = {}): {
  id: string;
  user: string;
  assistant: string;
  tools: string[];
} {
  const id = `ex-cas-${opts.withTool ? "tool" : "plain"}`;
  insertExchange(
    db,
    {
      id,
      project: "/tmp/project",
      timestamp: "2026-08-30T00:00:00.000Z",
      userMessage: "deploy the service",
      assistantMessage: "deployed",
      archivePath: "/tmp/archive.jsonl",
      lineStart: 1,
      lineEnd: 2,
      toolCalls: opts.withTool
        ? [
            {
              id: `${id}-tc-1`,
              exchangeId: id,
              toolName: "Bash",
              toolInput: { cmd: "deploy" },
              toolResult: "ok",
              isError: false,
              timestamp: "2026-08-30T00:00:00.000Z",
            },
          ]
        : undefined,
    },
    EMB(),
    opts.withTool ? ["Bash"] : undefined,
  );
  return {
    id,
    user: "deploy the service",
    assistant: "deployed",
    tools: opts.withTool ? ["Bash"] : [],
  };
}

describe("exchange reembed content CAS (재감사 P1-2)", () => {
  it("commits when the content is unchanged", () => {
    const ex = seedExchange();
    const hash = exchangeContentHash(ex.user, ex.assistant, ex.tools);

    expect(commitExchangeReembed(db, ex.id, hash, EMB(), 3, 1234)).toBe(true);
    expect(vecRowCount(ex.id)).toBe(1);
    expect(
      (db.prepare("SELECT embedding_version, last_indexed FROM exchanges WHERE id = ?").get(ex.id) as {
        embedding_version: number;
        last_indexed: number;
      }),
    ).toEqual({ embedding_version: 3, last_indexed: 1234 });
  });

  it("discards the vector when the turn grew in place during the embed await", () => {
    const ex = seedExchange();
    const hash = exchangeContentHash(ex.user, ex.assistant, ex.tools);
    // 동기 reindex가 같은 id로 턴을 완성시킨다(assistant partial → complete).
    db.prepare("UPDATE exchanges SET assistant_message = ? WHERE id = ?").run(
      "deployed\n\ndeployment finished with 3 replicas",
      ex.id,
    );

    expect(commitExchangeReembed(db, ex.id, hash, EMB(), 3, 1234)).toBe(false);
    // 기존 벡터는 그대로고(재작성 안 함), 스탬프도 움직이지 않는다.
    expect(vecRowCount(ex.id)).toBe(1);
    expect(
      (db.prepare("SELECT embedding_version, last_indexed FROM exchanges WHERE id = ?").get(ex.id) as {
        embedding_version: number;
        last_indexed: number;
      }),
    ).not.toEqual({ embedding_version: 3, last_indexed: 1234 });
  });

  it("discards the vector when ordered tool evidence changed during the embed await", () => {
    const ex = seedExchange({ withTool: true });
    const hash = exchangeContentHash(ex.user, ex.assistant, ex.tools);
    // sync reindex가 tool_calls desired set을 교체한다(P1-6 delete+insert).
    // 임베딩 텍스트의 재료는 tool 이름이므로 이름이 바뀌면 벡터도 stale다.
    db.prepare("DELETE FROM tool_calls WHERE exchange_id = ?").run(ex.id);
    db.prepare(
      "INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(`${ex.id}-tc-1`, ex.id, "Tools", "{}", "retried", 0, "2026-08-30T00:00:01.000Z");

    expect(commitExchangeReembed(db, ex.id, hash, EMB(), 3, 1234)).toBe(false);
  });

  it("never resurrects a vec row for an exchange purged during the embed await", () => {
    const ex = seedExchange();
    const hash = exchangeContentHash(ex.user, ex.assistant, ex.tools);
    // privacy purge가 exchange + 파생 vec/tool 행을 전부 지운다.
    deleteExchange(db, ex.id);
    expect(vecRowCount(ex.id)).toBe(0);

    // 대기가 끝난 reembed commit — purge 이전에 읽은 hash로는 절대 쓰지 않는다.
    expect(commitExchangeReembed(db, ex.id, hash, EMB(), 3, 1234)).toBe(false);
    expect(vecRowCount(ex.id)).toBe(0);
  });
});
