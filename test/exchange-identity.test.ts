import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 재감사 P1-5·P1-6 / T08·T09·T10 — exchange identity와 재색인 reconciliation.
 *
 * T08: 교환 신원은 (세션, user turn 행)에서 결정론적으로 파생된다 — 서로 다른
 *      archive 경로에서 같은 rollout 을 파싱하면 같은 ID, turn 이 자라도(assistant/
 *      tool 행 추가) 같은 논리 교환 ID.
 * T09: 재색인이 desired set 을 reconcile 한다 — legacy(archivePath 기반) 행은
 *      canonical id 로 rename 되며 모든 참조가 재작성되고, desired 밖 행은 삭제되며,
 *      growing turn 중복은 한 논리 교환만 남는다.
 * T10: 재색인 시 tool_calls 는 per-exchange desired set 으로 대체된다 — parse 사이에
 *      사라진 call 이 고아 증거로 남지 않는다.
 */

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.05),
  generateExchangeEmbedding: async () => new Array(384).fill(0.05),
}));

import { initDatabase, insertExchange, reconcileArchiveExchanges } from "../src/db.js";
import { parseRolloutStream } from "../src/codex-rollout.js";
import { insertFact } from "../src/fact-db.js";
import { syncConversations } from "../src/sync.js";

const SESSION_ID = "01a00008-aaaa-4bbb-8ccc-ccccccccccc8";
const PROJECT = "/tmp/exchange-identity/project";

function rolloutLines(opts: { withTools: boolean }): string[] {
  const lines = [
    JSON.stringify({
      timestamp: "2026-08-29T01:00:00.000Z",
      type: "session_meta",
      payload: { id: SESSION_ID, session_id: SESSION_ID, cwd: PROJECT, cli_version: "0.149.0" },
    }),
    JSON.stringify({
      timestamp: "2026-08-29T01:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ZebraQuery 집계 파이프라인을 표준화하기로 결정했습니다." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-29T01:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ZebraQuery 결정을 확인했습니다." }],
      },
    }),
  ];
  if (opts.withTools) {
    lines.push(
      JSON.stringify({
        timestamp: "2026-08-29T01:03:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-grown",
          name: "shell",
          input: "echo growing turn",
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-29T01:04:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-grown",
          output: "ok",
        },
      }),
    );
  }
  return lines;
}

async function parseWith(archivePath: string, lines: string[]) {
  return parseRolloutStream(Readable.from(lines.map((l) => l + "\n")), { archivePath });
}

let tmp: string;
let db: import("better-sqlite3").Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-exchange-id-"));
  process.env.MEMEX_HOME = tmp;
  process.env.MEMEX_DB_PATH = path.join(tmp, "t.sqlite");
  db = initDatabase();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("T08: exchange identity is archive-path independent and growth stable", () => {
  it("same rollout parsed under different archive roots yields identical exchange ids", async () => {
    const lines = rolloutLines({ withTools: true });
    const deviceA = await parseWith("/home-a/.config/memex/conversation-archive/p/x.jsonl", lines);
    const deviceB = await parseWith("/home-b/deeper/archive/p/x.jsonl", lines);
    expect(deviceA.exchanges.length).toBe(1);
    expect(deviceA.exchanges.map((e) => e.id)).toEqual(deviceB.exchanges.map((e) => e.id));
  });

  it("a growing turn keeps the same logical exchange id (assistant/tool rows are content)", async () => {
    const short = await parseWith("/arch/x.jsonl", rolloutLines({ withTools: false }));
    const grown = await parseWith("/arch/x.jsonl", rolloutLines({ withTools: true }));
    expect(short.exchanges.length).toBe(1);
    expect(grown.exchanges.length).toBe(1);
    expect(grown.exchanges[0].id).toBe(short.exchanges[0].id);
    // 내용 세대는 진행된다 — line_end 가 tool output 행까지 늘어난다.
    expect((grown.exchanges[0].lineEnd as number)).toBeGreaterThan(
      short.exchanges[0].lineEnd as number,
    );
  });

  it("exchanges without session_meta fall back to a path-independent content key", async () => {
    const orphanLines = [
      JSON.stringify({
        timestamp: "2026-08-29T01:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "헤더 없는 rollout의 유일한 user turn" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-29T01:02:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "응답" }],
        },
      }),
    ];
    const a = await parseWith("/somewhere/a.jsonl", orphanLines);
    const b = await parseWith("/elsewhere/b.jsonl", orphanLines);
    expect(a.exchanges[0].id).toBe(b.exchanges[0].id);
  });
});

describe("T09: reindex reconciles the desired exchange set", () => {
  it("renames a legacy archive-path-derived row with full reference rewrite", () => {
    // legacy scheme 흔적: archive 경로 기반 id, 같은 line 의 growing-turn 중복.
    const archivePath = "/arch/p/x.jsonl";
    const insertLegacy = (
      id: string,
      user: string,
      assistant: string,
      lineEnd: number,
      callIds: string[],
    ) => {
      insertExchange(
        db,
        {
          id,
          project: PROJECT,
          timestamp: "2026-08-29T01:02:00.000Z",
          userMessage: user,
          assistantMessage: assistant,
          archivePath,
          lineStart: 5,
          lineEnd,
          sessionId: SESSION_ID,
          toolCalls: callIds.map((cid) => ({
            id: cid,
            exchangeId: id,
            toolName: "shell",
            toolInput: {},
            toolResult: "ok",
            isError: false,
            timestamp: "2026-08-29T01:03:00.000Z",
          })),
        },
        new Array(384).fill(0.05),
      );
    };
    insertLegacy("legacy-partial", "부분 turn", "부분 응답", 6, ["call-old"]);
    insertLegacy("legacy-complete", "완성 turn", "완성 응답", 9, ["call-grown"]);
    db.prepare("UPDATE exchanges SET last_indexed = ? WHERE id = 'legacy-partial'").run(1000);
    db.prepare("UPDATE exchanges SET last_indexed = ? WHERE id = 'legacy-complete'").run(2000);
    const factId = insertFact(db, {
      fact: "A fact citing the legacy exchange",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: ["legacy-partial", "legacy-complete"],
      embedding: new Array(384).fill(0.05),
    });
    db.prepare(`
      INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
      VALUES ('rev-1', ?, 'old', 'new', 'r', 'legacy-complete', '2026-08-29T01:00:00.000Z')
    `).run(factId);
    db.prepare(`
      INSERT INTO fact_context_dependencies
        (fact_id, exchange_id, dependency_kind, created_at)
      VALUES (?, 'legacy-partial', 'assistant_context', '2026-08-29T01:00:00.000Z')
    `).run(factId);
    db.prepare(`
      INSERT INTO fact_context_dependencies
        (fact_id, exchange_id, dependency_kind, created_at)
      VALUES (?, 'legacy-complete', 'watermark_prefix', '2026-08-29T01:00:00.000Z')
    `).run(factId);

    const CANON = "canonical-id-for-line-5";
    const result = reconcileArchiveExchanges(db, {
      archivePath,
      desired: [{ id: CANON, lineStart: 5 }],
    });
    expect(result.renamed).toBe(1);
    expect(result.deleted).toBe(1);

    // 논리 교환은 CANON 하나뿐이다.
    const exchanges = db
      .prepare("SELECT id, last_indexed FROM exchanges")
      .all() as Array<{ id: string; last_indexed: number }>;
    expect(exchanges).toEqual([{ id: CANON, last_indexed: 2000 }]);
    // fact provenance 와 revision 참조가 재작성됐다 — 삭제된 중복 참조는 정리된다.
    const fact = db
      .prepare("SELECT source_exchange_ids FROM facts WHERE id = ?")
      .get(factId) as { source_exchange_ids: string };
    expect(JSON.parse(fact.source_exchange_ids)).toEqual([CANON]);
    expect(
      db.prepare("SELECT source_exchange_id FROM fact_revisions WHERE id = 'rev-1'").get(),
    ).toEqual({ source_exchange_id: CANON });
    expect(db.prepare(`
      SELECT exchange_id, dependency_kind FROM fact_context_dependencies
      WHERE fact_id = ?
    `).all(factId)).toEqual([{
      exchange_id: CANON,
      dependency_kind: 'watermark_prefix',
    }]);
    // 살아남은 행의 tool_calls 만 새 id 로 옮겨진다(삭제된 행의 call 은 함께 삭제).
    expect(
      db.prepare("SELECT id FROM tool_calls").all() as Array<{ id: string }>,
    ).toEqual([{ id: "call-grown" }]);
    // vector 집합이 exchange 집합과 같다.
    expect(
      db.prepare("SELECT id FROM vec_exchanges").all() as Array<{ id: string }>,
    ).toEqual([{ id: CANON }]);
  });

  it("deletes rows whose line is no longer in the desired set", () => {
    const archivePath = "/arch/p/y.jsonl";
    db.prepare(`
      INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path,
         line_start, line_end, last_indexed, session_id, is_sidechain)
      VALUES ('kept', ?, 't', 'u', 'a', ?, 3, 4, 1, ?, 0)
    `).run(PROJECT, archivePath, SESSION_ID);
    db.prepare(`
      INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path,
         line_start, line_end, last_indexed, session_id, is_sidechain)
      VALUES ('stale', ?, 't', 'old u', 'old a', ?, 7, 8, 1, ?, 0)
    `).run(PROJECT, archivePath, SESSION_ID);

    const result = reconcileArchiveExchanges(db, {
      archivePath,
      desired: [{ id: "kept", lineStart: 3 }],
    });
    expect(result).toEqual({ renamed: 0, deleted: 1 });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT id FROM exchanges").get() as { id: string }).id,
    ).toBe("kept");
  });

  it("growing turn reindex through the real sync path keeps one logical exchange with refreshed tools", async () => {
    const sessions = path.join(tmp, "sessions");
    const archive = path.join(tmp, "archive");
    fs.mkdirSync(sessions, { recursive: true });
    const rollout = path.join(sessions, `rollout-2026-08-29T01-00-00-${SESSION_ID}.jsonl`);
    fs.writeFileSync(rollout, rolloutLines({ withTools: false }).join("\n") + "\n");

    process.env.TEST_SESSIONS_DIR = sessions;
    process.env.TEST_ARCHIVE_DIR = archive;
    let factId = "";
    try {
      await syncConversations(sessions, archive, { skipSummaries: true });
      let exchange = db
        .prepare("SELECT id, line_end FROM exchanges WHERE session_id = ?")
        .get(SESSION_ID) as { id: string; line_end: number };
      factId = insertFact(db, {
        fact: "Fact provenance must survive reindex",
        category: "decision",
        scope_type: "global",
        scope_project: null,
        source_exchange_ids: [exchange.id],
        embedding: new Array(384).fill(0.05),
      });

      // turn 이 자란다 — tool call/output 행이 붙는다(append-only).
      fs.writeFileSync(rollout, rolloutLines({ withTools: true }).join("\n") + "\n");
      await syncConversations(sessions, archive, { skipSummaries: true });

      exchange = db
        .prepare("SELECT id, line_end FROM exchanges WHERE session_id = ?")
        .get(SESSION_ID) as { id: string; line_end: number };
      // 논리 교환은 여전히 하나, 같은 id — 중복 없이 in-place 갱신.
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as { n: number }).n,
      ).toBe(1);
      // tool_calls 는 새 desired set 으로 대체됐다(T10).
      expect(
        db.prepare("SELECT id FROM tool_calls").all() as Array<{ id: string }>,
      ).toEqual([{ id: "call-grown" }]);
      // fact provenance 가 살아 있다 — 재색인 후에도 source trace 가 연결된다.
      const fact = db
        .prepare("SELECT source_exchange_ids FROM facts WHERE id = ?")
        .get(factId) as { source_exchange_ids: string };
      expect(JSON.parse(fact.source_exchange_ids)).toEqual([exchange.id]);
      // FTS/vector 집합 동일성.
      expect(
        (db.prepare(
          "SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'ZebraQuery'",
        ).get() as { n: number }).n,
      ).toBe(1);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM vec_exchanges").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      delete process.env.TEST_SESSIONS_DIR;
      delete process.env.TEST_ARCHIVE_DIR;
    }
  });
});

describe("T10: tool_calls are replaced as a per-exchange desired set", () => {
  it("drops tool calls that the fresh parse no longer reports", () => {
    const base = {
      project: PROJECT,
      timestamp: "2026-08-29T01:02:00.000Z",
      userMessage: "user",
      assistantMessage: "assistant",
      archivePath: "/arch/z.jsonl",
      lineStart: 2,
      lineEnd: 9,
      sessionId: SESSION_ID,
    };
    const mk = (callId: string) => ({
      id: callId,
      exchangeId: "same-exchange",
      toolName: "shell",
      toolInput: {},
      toolResult: "ok",
      isError: false,
      timestamp: "2026-08-29T01:03:00.000Z",
    });
    insertExchange(db, { ...base, id: "same-exchange", toolCalls: [mk("call-a"), mk("call-b")] }, new Array(384).fill(0.05));
    // 재파싱: call-a 가 사라지고 call-c 가 생겼다.
    insertExchange(db, { ...base, id: "same-exchange", toolCalls: [mk("call-b"), mk("call-c")] }, new Array(384).fill(0.05));

    const calls = db
      .prepare("SELECT id FROM tool_calls WHERE exchange_id = ? ORDER BY id")
      .all("same-exchange") as Array<{ id: string }>;
    expect(calls.map((c) => c.id)).toEqual(["call-b", "call-c"]);
  });
});
