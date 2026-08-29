import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 재감사 P1-2 / T03·T04·T05 — semantic_generation CAS 회귀.
 *
 * 계약: fact 의미가 바뀌면 semantic_generation이 올라가고, 그 의미에서 파생된
 * 비동기 결과(ontology 분류, 관계, 벡터)는 시작 시 캡처한 세대로 최종 쓰기를
 * CAS한다 — 0행이면 stale 결과는 폐기된다. sync import는 embedding await 이후
 * commit 직전에 로컬 세대를 재검증한다.
 *
 * 재현 방식: LLM/embedding mock을 게이트로 막아 놓고 대기 중에 의미를 변이시킨다.
 */

const embedGate: { block: boolean; calls: number; release: (() => void) | null } = {
  block: false,
  calls: 0,
  release: null,
};
const llmGate: { block: boolean; release: (() => void) | null; response: string } = {
  block: false,
  release: null,
  response: "[]",
};

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => {
    embedGate.calls++;
    if (embedGate.block) {
      // 첫 호출자만 게이트를 거친다 — 대기 중 테스트가 돌리는 변이의
      // 임베딩 호출까지 막으면 서로 교착된다.
      embedGate.block = false;
      await new Promise<void>((resolve) => {
        embedGate.release = resolve;
      });
    }
    return new Array(384).fill(0.05);
  },
  generateExchangeEmbedding: async () => new Array(384).fill(0.05),
}));

vi.mock("../src/llm.js", async (io) => ({
  ...(await io<typeof import("../src/llm.js")>()),
  callMemoryModel: async () => {
    if (llmGate.block) {
      llmGate.block = false;
      await new Promise<void>((resolve) => {
        llmGate.release = resolve;
      });
    }
    return llmGate.response;
  },
}));

import { initDatabase } from "../src/db.js";
import { getActiveFacts, insertFact } from "../src/fact-db.js";
import { mutateFactMeaning, StaleFactMutationError } from "../src/fact-management.js";
import { classifyFactsBatch, detectRelations } from "../src/ontology-classifier.js";
import { importFromSync } from "../src/sync-import.js";
import { getSyncDir } from "../src/sync-export.js";

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-semantic-gen-"));
  process.env.MEMEX_HOME = tmp;
  process.env.MEMEX_DB_PATH = path.join(tmp, "t.sqlite");
  embedGate.block = false;
  embedGate.calls = 0;
  embedGate.release = null;
  llmGate.block = false;
  llmGate.release = null;
  llmGate.response = "[]";
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

function genOf(factId: string): number {
  return (
    db.prepare("SELECT semantic_generation AS g FROM facts WHERE id = ?").get(factId) as { g: number }
  ).g;
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("semantic generation lifecycle", () => {
  it("insertFact starts at generation 1 and semantic mutation bumps it; activation changes do not", async () => {
    const id = insertFact(db, {
      fact: "The deploy pipeline runs on ephemeral runners",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.05),
    });
    expect(genOf(id)).toBe(1);

    await mutateFactMeaning(db, { factId: id, newText: "The deploy pipeline runs on bare metal runners" });
    expect(genOf(id)).toBe(2);
    const row = db
      .prepare("SELECT semantic_updated_at, updated_at FROM facts WHERE id = ?")
      .get(id) as { semantic_updated_at: string; updated_at: string };
    expect(row.semantic_updated_at).toBe(row.updated_at);

    // 비의미 상태 전이(deactivate/restore)는 generation을 올리지 않는다 —
    // 파생 표현이 stale해지지 않으므로 CAS 토큰도 움직이면 안 된다.
    db.prepare("UPDATE facts SET is_active = 0 WHERE id = ?").run(id);
    db.prepare("UPDATE facts SET is_active = 1 WHERE id = ?").run(id);
    expect(genOf(id)).toBe(2);
  });

  it("migrates legacy rows: generation 1, semantic_updated_at backfilled from updated_at", () => {
    db.close();
    const legacyPath = path.join(tmp, "legacy.sqlite");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        fact TEXT NOT NULL,
        category TEXT,
        scope_type TEXT NOT NULL DEFAULT 'project',
        scope_project TEXT,
        source_exchange_ids TEXT,
        embedding BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        consolidated_count INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 1,
        ontology_category_id TEXT,
        fact_kr TEXT,
        embedding_version INTEGER NOT NULL DEFAULT 1,
        ontology_attempts INTEGER NOT NULL DEFAULT 0,
        consolidation_attempts INTEGER NOT NULL DEFAULT 0,
        needs_consolidation INTEGER NOT NULL DEFAULT 1,
        ontology_last_attempt_at TEXT
      );
    `);
    legacy
      .prepare(
        `INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids,
           created_at, updated_at, consolidated_count, is_active, needs_consolidation)
         VALUES ('legacy-1', 'Legacy meaning', 'decision', 'global', NULL, '[]',
           '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 1, 1, 0)`,
      )
      .run();
    legacy.close();

    process.env.MEMEX_DB_PATH = legacyPath;
    db = initDatabase();
    const row = db
      .prepare("SELECT semantic_generation, semantic_updated_at FROM facts WHERE id = ?")
      .get("legacy-1") as { semantic_generation: number; semantic_updated_at: string };
    expect(row.semantic_generation).toBe(1);
    expect(row.semantic_updated_at).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("T03: ontology classification generation race", () => {
  it("discards the classification when the meaning changes during the LLM call", async () => {
    const id = insertFact(db, {
      fact: "Metrics are exported once per minute",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.05),
    });
    llmGate.block = true;
    llmGate.response = JSON.stringify([
      {
        index: 0,
        domain: "Observability",
        category: "Metrics",
        is_new_domain: true,
        is_new_category: true,
        domain_description: "Monitoring topics",
        category_description: "Metric pipelines",
      },
    ]);

    const batch = classifyFactsBatch(db, getActiveFacts(db));
    await waitUntil(() => llmGate.release !== null, "LLM call to start");
    // LLM 대기 중 의미가 바뀐다 — 세대 2, 분류 pending 리셋.
    await mutateFactMeaning(db, { factId: id, newText: "Metrics are exported once per second" });
    llmGate.release!();

    const result = await batch;
    expect(result.stale).toEqual([id]);
    expect(result.classified).toEqual([]);
    // stale 분류는 새 의미에 stamp 되지 않는다 — 변이가 리셋한 pending 유지.
    const row = db
      .prepare("SELECT ontology_category_id, ontology_attempts, semantic_generation FROM facts WHERE id = ?")
      .get(id) as { ontology_category_id: string | null; ontology_attempts: number; semantic_generation: number };
    expect(row.ontology_category_id).toBeNull();
    expect(row.ontology_attempts).toBe(0); // stale은 시도 ledger를 태우지 않는다
    expect(row.semantic_generation).toBe(2);
  });
});

describe("relation writer generation race", () => {
  it("discards the relation when the target changes meaning during detection", async () => {
    const emb = new Array(384).fill(0.05);
    const sourceId = insertFact(db, {
      fact: "Rate limiting uses a token bucket",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: [...emb],
    });
    const targetId = insertFact(db, {
      fact: "Rate limiting uses a token bucket per tenant",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: [...emb],
    });
    const [source, target] = getActiveFacts(db).filter((f) => f.id === sourceId || f.id === targetId);

    llmGate.block = true;
    llmGate.response = JSON.stringify({
      has_relation: true,
      relation_type: "SUPPORTS",
      reasoning: "Same limiting strategy",
    });
    const detection = detectRelations(db, source);
    await waitUntil(() => llmGate.release !== null, "relation LLM call to start");
    await mutateFactMeaning(db, { factId: targetId, newText: "Rate limiting moved to a sliding window" });
    llmGate.release!();
    await detection;

    const relations = db
      .prepare("SELECT COUNT(*) AS n FROM ontology_relations")
      .get() as { n: number };
    expect(relations.n).toBe(0);
    expect(genOf(targetId)).toBe(2);
  });

  it("discards the relation when the source changes meaning during detection", async () => {
    const emb = new Array(384).fill(0.05);
    const sourceId = insertFact(db, {
      fact: "Queues are drained with at-least-once delivery",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: [...emb],
    });
    const targetId = insertFact(db, {
      fact: "Queue consumers commit offsets after processing",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: [...emb],
    });
    const [source] = getActiveFacts(db).filter((f) => f.id === sourceId);

    llmGate.block = true;
    llmGate.response = JSON.stringify({
      has_relation: true,
      relation_type: "INFLUENCES",
      reasoning: "Delivery semantics drive offset handling",
    });
    const detection = detectRelations(db, source);
    await waitUntil(() => llmGate.release !== null, "relation LLM call to start");
    await mutateFactMeaning(db, { factId: sourceId, newText: "Queues are drained with exactly-once delivery" });
    llmGate.release!();
    await detection;

    const relations = db
      .prepare("SELECT COUNT(*) AS n FROM ontology_relations")
      .get() as { n: number };
    expect(relations.n).toBe(0);
  });

  it("StaleFactMutationError surfaces from expectedPreviousFact mismatches", async () => {
    const id = insertFact(db, {
      fact: "The API version is v2",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.05),
    });
    await expect(
      mutateFactMeaning(db, {
        factId: id,
        newText: "The API version is v3",
        expectedPreviousFact: "The API version is v1",
      }),
    ).rejects.toBeInstanceOf(StaleFactMutationError);
  });
});

describe("sync import commit-time revalidation (T06 CAS half)", () => {
  it("does not overwrite a local semantic edit that lands during the embedding await", async () => {
    const localId = insertFact(db, {
      fact: "The session store is Redis",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.05),
    });

    const syncDir = getSyncDir();
    fs.writeFileSync(
      path.join(syncDir, "facts.jsonl"),
      JSON.stringify({
        id: localId,
        fact: "The session store is Postgres",
        fact_kr: null,
        category: "decision",
        scope_type: "global",
        scope_project: null,
        source_exchange_ids: "[]",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-29T12:00:00.000Z",
        consolidated_count: 1,
        is_active: 1,
        ontology_category_id: null,
      }) + "\n",
    );

    embedGate.block = true;
    const importing = importFromSync();
    await waitUntil(() => embedGate.release !== null, "import embedding to start");
    // 원격 승자 판정 이후 embedding 대기 중에 로컬 의미 편집이 일어난다.
    await mutateFactMeaning(db, { factId: localId, newText: "The session store is SQLite" });
    embedGate.release!();
    const result = await importing;

    expect(result.updatedFacts).toBe(0);
    const row = db
      .prepare("SELECT fact, semantic_generation, updated_at FROM facts WHERE id = ?")
      .get(localId) as { fact: string; semantic_generation: number; updated_at: string };
    expect(row.fact).toBe("The session store is SQLite");
    expect(row.semantic_generation).toBe(2); // 로컬 편집의 세대가 유지된다
    expect(row.updated_at).not.toBe("2026-08-29T12:00:00.000Z"); // 원격 시각으로 덮이지 않는다
  });

  it("discards the import when a privacy tombstone lands during the embedding await", async () => {
    const localId = insertFact(db, {
      fact: "A fact that will be excluded mid-await",
      category: "decision",
      scope_type: "global",
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.05),
    });

    const syncDir = getSyncDir();
    fs.writeFileSync(
      path.join(syncDir, "facts.jsonl"),
      JSON.stringify({
        id: localId,
        fact: "A fact that will be excluded mid-await",
        fact_kr: null,
        category: "decision",
        scope_type: "global",
        scope_project: null,
        source_exchange_ids: "[]",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-29T14:00:00.000Z",
        consolidated_count: 1,
        is_active: 1,
        ontology_category_id: null,
      }) + "\n",
    );

    embedGate.block = true;
    const importing = importFromSync();
    await waitUntil(() => embedGate.release !== null, "import embedding to start");
    // 대기 중 대화 전체 exclusion purge가 tombstone을 남긴다(다른 프로세스 시나리오).
    db.prepare(
      "INSERT INTO fact_tombstones (fact_id, deleted_at, reason) VALUES (?, ?, ?)",
    ).run(localId, "2026-08-29T14:30:00.000Z", "source_conversation_excluded");
    embedGate.release!();
    const result = await importing;

    expect(result.updatedFacts).toBe(0);
    // terminal tombstone은 import가 지우지 않고, fact도 그대로다.
    const tomb = db
      .prepare("SELECT reason FROM fact_tombstones WHERE fact_id = ?")
      .get(localId) as { reason: string } | undefined;
    expect(tomb?.reason).toBe("source_conversation_excluded");
    const row = db
      .prepare("SELECT fact, semantic_generation FROM facts WHERE id = ?")
      .get(localId) as { fact: string; semantic_generation: number } | undefined;
    expect(row?.fact).toBe("A fact that will be excluded mid-await");
    expect(row?.semantic_generation).toBe(1);
  });
});
