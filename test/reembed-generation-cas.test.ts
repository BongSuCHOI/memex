import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 재감사 P1-2 / T04·T05 — reembed worker의 의미 세대 CAS 회귀.
 *
 * worker를 **자식 프로세스로 실제 실행**한다(실제 dist + 임베딩만 게이트 스텁).
 * 실패 시나리오: worker가 fact A를 읽고 임베딩을 기다리는 동안 동시 의미 변이가
 * A → B로 바꾸면, 수정 전 worker는 "B 문장 + A 임베딩 + embedding_version=current"
 * 를 만들었다. 수정 후 UPDATE ... WHERE semantic_generation=? CAS가 0행이면
 * vec 스왑까지 통째로 폐기된다. KR 벡터도 동일하다(변이는 fact_kr을 무효화한다).
 */

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.05),
  generateExchangeEmbedding: async () => new Array(384).fill(0.05),
}));

import { initDatabase } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import { mutateFactMeaning } from "../src/fact-management.js";
import { EMBEDDING_VERSION } from "../src/embeddings.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tmp: string | undefined;
let sandbox: string | undefined;
let db: Database.Database;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  sandbox = undefined;
});

/**
 * 실제 dist 복사본 + 임베딩 게이트 스텁. 각 generateEmbedding 호출은
 * <sig>/embed-<n>.txt 에 호출 텍스트를 남기고 <sig>/go 가 나타날 때까지
 * 기다린다 — 테스트가 대기 중에 의미를 변이시킬 수 있다.
 */
function writeWorkerSandbox(): { root: string; sig: string; dbPath: string; home: string } {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "memex-reembed-gen-"));
  const root = sandbox;
  fs.cpSync(path.join(REPO, "dist"), path.join(root, "dist"), { recursive: true });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts", "reembed-worker.js"), path.join(root, "scripts", "reembed-worker.js"));
  const sig = path.join(root, "sig");
  fs.mkdirSync(sig, { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist", "embeddings.js"),
    [
      `export const EMBEDDING_MODEL = 'deterministic-test-model';`,
      `export const EMBEDDING_VERSION = ${EMBEDDING_VERSION};`,
      "export const BACKGROUND_PROBES = [];",
      "let n = 0;",
      `const SIG = ${JSON.stringify(sig)};`,
      "import fs from 'node:fs';",
      "export async function initEmbeddings() {}",
      "export async function generateEmbedding(text, mode) {",
      "  n += 1;",
      "  fs.writeFileSync(SIG + '/embed-' + n + '.txt', String(text));",
      "  while (!fs.existsSync(SIG + '/go')) await new Promise((r) => setTimeout(r, 15));",
      "  const seed = Math.max(1, String(text ?? '').length % 127);",
      "  return Array.from({ length: 384 }, (_, i) => ((seed + i) % 127) / 127);",
      "}",
      "export async function generateExchangeEmbedding(user, assistant) {",
      "  return generateEmbedding(String(user) + String(assistant));",
      "}",
      "export async function queryBaseline() { return 0; }",
    ].join("\n") + "\n",
  );
  const home = path.join(root, "home");
  const dbPath = path.join(home, "conversation-index", "db.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return { root, sig, dbPath, home };
}

async function runWorker(root: string, home: string, dbPath: string): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [path.join(root, "scripts", "reembed-worker.js"), "--facts-only"], {
    cwd: root,
    env: { ...process.env, MEMEX_HOME: home, MEMEX_DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.on("close", (code) => resolve({ code }));
  });
  const timeout = new Promise<{ code: number | null }>((resolve) => setTimeout(() => {
    child.kill("SIGKILL");
    resolve({ code: -1 });
  }, 60_000));
  const result = await Promise.race([done, timeout]);
  return { code: result.code, out };
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("reembed worker semantic generation CAS (P1-2 / T04·T05)", () => {
  it("T04: discards the EN re-embed when the meaning changes during the embedding await", async () => {
    const { root, sig, dbPath, home } = writeWorkerSandbox();
    const priorDb = process.env.MEMEX_DB_PATH;
    const priorHome = process.env.MEMEX_HOME;
    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = home;
    let factId = "";
    try {
      db = initDatabase();
      factId = insertFact(db, {
        fact: "Fact A written before the re-embed",
        category: "decision",
        scope_type: "global",
        scope_project: null,
        source_exchange_ids: [],
        embedding: new Array(384).fill(0.05),
      });
      // pending 선정(NOT EXISTS vec_facts row): 벡터 행만 삭제해 누락 벡터 상태를 만든다.
      db.prepare("DELETE FROM vec_facts WHERE id = ?").run(factId);
    } finally {
      db.close();
    }

    const worker = runWorker(root, home, dbPath);
    await waitUntil(() => fs.existsSync(path.join(sig, "embed-1.txt")), "worker embedding call");
    expect(fs.readFileSync(path.join(sig, "embed-1.txt"), "utf8")).toBe("Fact A written before the re-embed");

    // 임베딩 대기 중 동시 의미 변이: A → B (세대 2, 새 벡터 스왑 포함).
    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = home;
    db = initDatabase();
    try {
      await mutateFactMeaning(db, { factId, newText: "Fact B written during the re-embed await" });
    } finally {
      const gen = db.prepare("SELECT semantic_generation AS g FROM facts WHERE id = ?").get(factId) as { g: number };
      expect(gen.g).toBe(2);
      db.close();
    }

    fs.writeFileSync(path.join(sig, "go"), "1");
    const { code, out } = await worker;
    expect(code).toBe(0);
    expect(out).toMatch(/stale discard/);

    // 재검증: worker의 stale 결과가 새 의미를 덮지 않았다.
    db = initDatabase();
    try {
      const row = db
        .prepare("SELECT fact, semantic_generation, embedding_version, embedding FROM facts WHERE id = ?")
        .get(factId) as { fact: string; semantic_generation: number; embedding_version: number; embedding: Buffer };
      expect(row.fact).toBe("Fact B written during the re-embed await");
      expect(row.semantic_generation).toBe(2);
      expect(row.embedding_version).toBe(EMBEDDING_VERSION);
      // facts.embedding은 변이가 쓴 값(테스트 mock의 0.05 float32)이어야 한다 —
      // worker 스텁 값은 (len%127+i)%127/127 로 0.05와 구별된다.
      const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      expect(stored[0]).toBeCloseTo(0.05, 5);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM vec_facts_rowids WHERE id = ?").get(factId) as { n: number }).n,
      ).toBe(1);
    } finally {
      db.close();
      if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = priorDb;
      if (priorHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = priorHome;
    }
  });

  it("T05: discards the KR vector when the meaning changes during the embedding await", async () => {
    const { root, sig, dbPath, home } = writeWorkerSandbox();
    const priorDb = process.env.MEMEX_DB_PATH;
    const priorHome = process.env.MEMEX_HOME;
    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = home;
    let factId = "";
    try {
      db = initDatabase();
      factId = insertFact(db, {
        fact: "Primary meaning stays current",
        fact_kr: "기본 의미는 현재로 유지된다",
        category: "decision",
        scope_type: "global",
        scope_project: null,
        source_exchange_ids: [],
        embedding: new Array(384).fill(0.05),
      });
      // EN 벡터는 현재(재선정 대상 아님), KR 벡터만 누락 → embedKoreanFacts 경로.
      db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(factId);
    } finally {
      db.close();
    }

    const worker = runWorker(root, home, dbPath);
    await waitUntil(() => fs.existsSync(path.join(sig, "embed-1.txt")), "worker KR embedding call");
    expect(fs.readFileSync(path.join(sig, "embed-1.txt"), "utf8")).toBe("기본 의미는 현재로 유지된다");

    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = home;
    db = initDatabase();
    try {
      // 변이는 fact_kr을 NULL로 무효화하고 세대를 올린다.
      await mutateFactMeaning(db, { factId, newText: "Primary meaning replaced mid-await" });
    } finally {
      db.close();
    }

    fs.writeFileSync(path.join(sig, "go"), "1");
    const { code, out } = await worker;
    expect(code).toBe(0);
    expect(out).toMatch(/facts-kr: stale discard/);

    db = initDatabase();
    try {
      const row = db
        .prepare("SELECT fact_kr, semantic_generation FROM facts WHERE id = ?")
        .get(factId) as { fact_kr: string | null; semantic_generation: number };
      expect(row.fact_kr).toBeNull();
      expect(row.semantic_generation).toBe(2);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM vec_facts_kr WHERE id = ?").get(factId) as { n: number }).n,
      ).toBe(0);
    } finally {
      db.close();
      if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = priorDb;
      if (priorHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = priorHome;
    }
  });
});
