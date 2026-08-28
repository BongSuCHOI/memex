import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// sync's indexing path needs embeddings and the summary path needs the LLM.
// Mock both so the test exercises only the exclusion-marker semantics.
vi.mock("../src/embeddings.js", async () => {
  return {
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () =>
      Array.from({ length: 384 }, () => 0.01),
    generateEmbedding: async () => Array.from({ length: 384 }, () => 0.01),
    EMBEDDING_VERSION: 999,
  };
});
vi.mock("../src/summarizer.js", async () => {
  return {
    summarizeConversation: async () => "sync exclusion test summary",
  };
});

import { syncConversations } from "../src/sync.js";
import { initDatabase } from "../src/db.js";
import { insertFact, insertRevision } from "../src/fact-db.js";

let testDir: string | undefined;
const origDbPath = process.env.MEMEX_DB_PATH;

const MARKER =
  "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>";
const CWD = "/tmp/sync-marker-fixture/proj-x";
// Real UUIDs — extractSessionIdFromPath requires the canonical
// 8-4-4-4-12 hex format to find a rollout's session id.
const UUID_1 = "01a00001-aaaa-4bbb-8ccc-ccccccccccc1";
const UUID_2 = "01a00002-aaaa-4bbb-8ccc-ccccccccccc2";
const UUID_3 = "01a00003-aaaa-4bbb-8ccc-ccccccccccc3";

function rollout(
  sessionId: string,
  opts: { markerIn?: "user-message" | "tool-result" | "none" },
): string {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      timestamp: "2026-08-28T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd: CWD, cli_version: "0.149.0" },
    }),
  );
  lines.push(
    JSON.stringify({
      timestamp: "2026-08-28T00:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "text",
            text:
              opts.markerIn === "user-message"
                ? `${MARKER} 이 대화는 인덱싱하지 마세요.`
                : "프로젝트 x에서 PostgreSQL을 채택하기로 했다.",
          },
        ],
      },
    }),
  );
  if (opts.markerIn === "tool-result") {
    // The agent read a file that happens to contain the marker string
    // (e.g. memex's own sync.ts source). Recorded as a tool output —
    // this must NOT exclude the session.
    lines.push(
      JSON.stringify({
        timestamp: "2026-08-28T00:02:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: `const EXCLUSION_MARKERS = ['${MARKER}'];`,
        },
      }),
    );
  }
  lines.push(
    JSON.stringify({
      timestamp: "2026-08-28T00:03:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "결정을 반영했습니다." }],
      },
    }),
  );
  return lines.join("\n") + "\n";
}

function writeRollout(
  dir: string,
  sessionId: string,
  opts: { markerIn?: "user-message" | "tool-result" | "none" },
): string {
  const file = path.join(dir, `rollout-2026-08-28T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, rollout(sessionId, opts));
  return file;
}

function useIsolatedDb(): string {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "memex-sync-marker-db-")),
    "test.db",
  );
  process.env.MEMEX_DB_PATH = dbPath;
  return dbPath;
}

function countSummaries(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile() && e.name.endsWith("-summary.txt")) n++;
    }
  };
  walk(dir);
  return n;
}

describe("sync exclusion markers honor user messages only", () => {
  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-sync-marker-"));
  });

  afterAll(() => {
    if (origDbPath === undefined) delete process.env.MEMEX_DB_PATH;
    else process.env.MEMEX_DB_PATH = origDbPath;
    if (testDir) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("indexes a session whose transcript contains a marker only in tool output", async () => {
    const source = path.join(testDir!, "sessions-tool-marker");
    const dest = path.join(testDir!, "archive-tool-marker");
    fs.mkdirSync(source, { recursive: true });
    writeRollout(source, UUID_1, { markerIn: "tool-result" });
    useIsolatedDb();

    const result = await syncConversations(source, dest);

    expect(result.errors).toHaveLength(0);
    expect(result.indexed).toBe(1);

    const db = initDatabase();
    try {
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      db.close();
    }
    expect(countSummaries(dest)).toBe(1);
  });

  it("excludes a session when the marker appears in a user message", async () => {
    const source = path.join(testDir!, "sessions-user-marker");
    const dest = path.join(testDir!, "archive-user-marker");
    fs.mkdirSync(source, { recursive: true });
    writeRollout(source, UUID_2, { markerIn: "user-message" });
    useIsolatedDb();

    const result = await syncConversations(source, dest);

    expect(result.errors).toHaveLength(0);
    expect(result.indexed).toBe(0);

    const db = initDatabase();
    try {
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as { n: number }
      ).n;
      expect(n).toBe(0);
    } finally {
      db.close();
    }
    // Copying still happens; indexing and summary generation are skipped.
    expect(
      fs
        .readdirSync(dest, { recursive: true })
        .some((f) => String(f).endsWith(".jsonl")),
    ).toBe(true);
    expect(countSummaries(dest)).toBe(0);
  });

  it("purges an already indexed conversation when a user adds the marker later", async () => {
    const source = path.join(testDir!, "sessions-late-marker");
    const dest = path.join(testDir!, "archive-late-marker");
    fs.mkdirSync(source, { recursive: true });
    const sourceFile = writeRollout(source, UUID_3, { markerIn: "none" });
    useIsolatedDb();

    const first = await syncConversations(source, dest);
    expect(first.errors).toHaveLength(0);
    expect(first.indexed).toBe(1);
    expect(countSummaries(dest)).toBe(1);

    const db = initDatabase();
    try {
      const exchange = db
        .prepare("SELECT id FROM exchanges WHERE session_id = ?")
        .get(UUID_3) as { id: string };
      db.prepare(`
        INSERT INTO tool_calls
          (id, exchange_id, tool_name, timestamp)
        VALUES ('late-tool', ?, 'read_file', ?)
      `).run(exchange.id, new Date().toISOString());
      db.prepare(`
        INSERT INTO extraction_log
          (session_id, processed_at, extracted, saved, last_exchange_rowid)
        VALUES (?, ?, 1, 1, 1)
      `).run(UUID_3, new Date().toISOString());
      db.prepare(`
        INSERT INTO recall_events
          (id, session_id, project, prompt_hash, fact_ids, created_at)
        VALUES ('late-recall', ?, ?, 'hash', '[]', ?)
      `).run(UUID_3, CWD, new Date().toISOString());
      const excludedFact = insertFact(db, {
        fact: "이 대화에서만 나온 비공개 결정",
        category: "decision",
        scope_type: "project",
        scope_project: CWD,
        source_exchange_ids: [exchange.id],
        embedding: Array.from({ length: 384 }, () => 0.01),
      });
      const retainedFact = insertFact(db, {
        fact: "다른 대화의 결정",
        category: "decision",
        scope_type: "project",
        scope_project: CWD,
        source_exchange_ids: ["other-exchange"],
        embedding: null,
      });
      insertRevision(db, {
        fact_id: excludedFact,
        previous_fact: "이전 비공개 결정",
        new_fact: "이 대화에서만 나온 비공개 결정",
        reason: "excluded source revision",
        source_exchange_id: exchange.id,
      });
      db.prepare(`
        INSERT INTO ontology_relations
          (id, source_fact_id, relation_type, target_fact_id, created_at)
        VALUES ('late-relation', ?, 'SUPPORTS', ?, ?)
      `).run(excludedFact, retainedFact, new Date().toISOString());
    } finally {
      db.close();
    }

    fs.writeFileSync(sourceFile, rollout(UUID_3, { markerIn: "user-message" }));
    const later = new Date(Date.now() + 2_000);
    fs.utimesSync(sourceFile, later, later);

    const second = await syncConversations(source, dest);
    expect(second.errors).toHaveLength(0);
    expect(second.indexed).toBe(0);

    const check = initDatabase();
    try {
      for (const table of [
        "exchanges",
        "vec_exchanges",
        "tool_calls",
        "extraction_log",
        "recall_events",
        "fact_revisions",
        "ontology_relations",
      ]) {
        const n = (
          check.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n;
        expect(n, `${table} should be purged`).toBe(0);
      }
      expect(
        (check.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n,
      ).toBe(1);
      expect(
        (check.prepare("SELECT COUNT(*) AS n FROM vec_facts").get() as {
          n: number;
        }).n,
      ).toBe(0);
      expect(
        (
          check
            .prepare(
              "SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'PostgreSQL'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(0);
    } finally {
      check.close();
    }
    expect(countSummaries(dest)).toBe(0);
  });
});
