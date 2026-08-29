import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../src/db.js";
import { EMBEDDING_VERSION } from "../src/embeddings.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SESSION_ID = "01a00004-aaaa-4bbb-8ccc-ccccccccccc4";
const PROJECT = "/tmp/session-end-worker-p0/project";
let tmp: string | undefined;

function rollout(): string {
  return [
    JSON.stringify({
      timestamp: "2026-08-28T01:00:00.000Z",
      type: "session_meta",
      payload: { id: SESSION_ID, cwd: PROJECT, cli_version: "0.149.0" },
    }),
    JSON.stringify({
      timestamp: "2026-08-28T01:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "실제 indexed exchange입니다." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-08-28T01:02:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "확인했습니다." }],
      },
    }),
  ].join("\n") + "\n";
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("P0 SessionEnd worker runtime", () => {
  it("reads an indexed exchange, emits canonical success, then allows SessionEnd export", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-session-end-p0-"));
    const dbPath = path.join(tmp, "conversation-index", "db.sqlite");
    const transcript = path.join(tmp, `rollout-${SESSION_ID}.jsonl`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(transcript, rollout());

    const priorDb = process.env.MEMEX_DB_PATH;
    const priorHome = process.env.MEMEX_HOME;
    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = tmp;
    const db = initDatabase();
    try {
      const inserted = db.prepare(`
        INSERT INTO exchanges
          (id, project, timestamp, user_message, assistant_message, archive_path,
           line_start, line_end, session_id, cwd, is_sidechain)
        VALUES ('p0-exchange', ?, ?, '실제 indexed exchange입니다.', '확인했습니다.',
                ?, 1, 3, ?, ?, 0)
      `).run(PROJECT, new Date().toISOString(), transcript, SESSION_ID, PROJECT);
      db.prepare(`
        INSERT INTO extraction_log
          (session_id, processed_at, extracted, saved, last_exchange_rowid)
        VALUES (?, ?, 0, 0, ?)
      `).run(SESSION_ID, new Date().toISOString(), Number(inserted.lastInsertRowid));
    } finally {
      db.close();
      if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = priorDb;
      if (priorHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = priorHome;
    }

    const env = {
      ...process.env,
      MEMEX_HOME: tmp,
      MEMEX_DB_PATH: dbPath,
      SESSION_ID,
      CWD: PROJECT,
      MB_TRANSCRIPT_PATH: transcript,
    };
    const worker = spawnSync(process.execPath, ["scripts/fact-extract-worker.js"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(worker.status).toBe(0);
    expect(worker.stdout).toMatch(
      new RegExp(`worker: session=${SESSION_ID} extracted=0 saved=0`),
    );
    expect(worker.stdout).not.toMatch(/\b(ERROR|FATAL|SKIPPED)\b/);

    const hook = spawnSync(process.execPath, ["scripts/session-end-hook.js"], {
      cwd: process.cwd(),
      env: {
        ...env,
        MEMEX_PLUGIN_ROOT: process.cwd(),
        MEMEX_STABILIZE_POLL_MS: "5",
        MEMEX_STABILIZE_QUIET_MS: "10",
        MEMEX_STABILIZE_MAX_WAIT_MS: "1000",
      },
      input: JSON.stringify({
        transcript_path: transcript,
        session_id: SESSION_ID,
        cwd: PROJECT,
      }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(hook.status).toBe(0);
    expect(hook.stderr).not.toContain("no completion evidence");
    // P1-1: export commits one generation per device — probe it there.
    {
      const deviceDir = path.join(
        tmp, "conversation-index", "sync", "devices",
        fs.readdirSync(path.join(tmp, "conversation-index", "sync", "devices"))[0],
      );
      expect(
        fs.existsSync(
          path.join(
            deviceDir, "generations",
            (JSON.parse(fs.readFileSync(path.join(deviceDir, "CURRENT"), "utf8")) as { generation: string })
              .generation,
            "meta.json",
          ),
        ),
      ).toBe(true);
    }
    const log = fs.readFileSync(
      path.join(tmp, "conversation-index", "fact-extract.log"),
      "utf8",
    );
    expect(log).toMatch(
      new RegExp(`worker: session=${SESSION_ID} extracted=0 saved=0`),
    );
    expect(log).not.toMatch(/\b(ERROR|FATAL|SKIPPED)\b/);
  });
});

describe("P0 worker full extraction through the real LLM path", () => {
  const EXTRACT_PROJECT = "/tmp/session-end-worker-p0/extract-project";
  const FACT_TEXT =
    "SessionEnd worker regression check uses a deterministic stub model";
  let sandbox: string | undefined;
  let codexStub: string | undefined;

  afterEach(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
    codexStub = undefined;
  });

  /**
   * Run the production worker script against a full copy of dist with only the
   * embedding backend swapped for a deterministic stub — extraction must be
   * observable end-to-end (claim → LLM → save → marker) without onnx/network.
   */
  function writeWorkerSandbox(): { root: string; dbPath: string; home: string } {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "memex-worker-extract-n-"));
    const root = sandbox;
    fs.cpSync(path.join(REPO, "dist"), path.join(root, "dist"), {
      recursive: true,
    });
    // Native deps must still resolve from the copied dist.
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "dir");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.copyFileSync(
      path.join(REPO, "scripts", "fact-extract-worker.js"),
      path.join(root, "scripts", "fact-extract-worker.js"),
    );
    fs.writeFileSync(
      path.join(root, "dist", "embeddings.js"),
      [
        "export const EMBEDDING_MODEL = 'deterministic-test-model';",
        `export const EMBEDDING_VERSION = ${EMBEDDING_VERSION};`,
        "export const BACKGROUND_PROBES = [];",
        "export async function initEmbeddings() {}",
        "export async function generateEmbedding(text) {",
        "  const seed = Math.max(1, String(text ?? '').length % 127);",
        "  return Array.from({ length: 384 }, (_, i) => ((seed + i) % 127) / 127);",
        "}",
        "export async function generateExchangeEmbedding(user, assistant) {",
        "  return generateEmbedding(String(user) + String(assistant));",
        "}",
        "export async function queryBaseline() { return 0; }",
      ].join("\n") + "\n",
    );

    // Deterministic `codex exec` stub: writes the extraction response to the
    // `-o` output file the real CLI contract guarantees.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    codexStub = path.join(bin, "codex-stub.mjs");
    fs.writeFileSync(
      codexStub,
      [
        "#!/usr/bin/env node",
        'import fs from "node:fs";',
        "const args = process.argv.slice(2);",
        'const out = args.includes("-o") ? args[args.indexOf("-o") + 1] : null;',
        "if (!out) process.exit(2);",
        "const response = JSON.stringify([{",
        `  fact: ${JSON.stringify(FACT_TEXT)},`,
        '  fact_kr: "SessionEnd 워커 회귀 검증은 결정론적 스텁 모델을 사용한다",',
        '  category: "decision",',
        '  scope_type: "project",',
        "  confidence: 0.9,",
        "  source_exchange_indices: [1],",
        "}]);",
        "fs.writeFileSync(out, response);",
      ].join("\n") + "\n",
    );
    fs.chmodSync(codexStub, 0o755);

    const home = path.join(root, "home");
    const dbPath = path.join(home, "conversation-index", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return { root, dbPath, home };
  }

  it("claims an indexed session, saves a fact, and reports extracted=1 saved=1", () => {
    const { root, dbPath, home } = writeWorkerSandbox();
    const transcript = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, rollout());

    const priorDb = process.env.MEMEX_DB_PATH;
    const priorHome = process.env.MEMEX_HOME;
    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = home;
    const db = initDatabase();
    try {
      // Indexed exchange with NO extraction_log row — the worker must run the
      // full claim → extract → save path, not the idempotent no-op gate.
      db.prepare(`
        INSERT INTO exchanges
          (id, project, timestamp, user_message, assistant_message, archive_path,
           line_start, line_end, session_id, cwd, is_sidechain)
        VALUES ('p0-extract-exchange', ?, ?, '실제 indexed exchange입니다.', '확인했습니다.',
                ?, 1, 3, ?, ?, 0)
      `).run(EXTRACT_PROJECT, new Date().toISOString(), transcript, SESSION_ID, EXTRACT_PROJECT);
    } finally {
      db.close();
      if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = priorDb;
      if (priorHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = priorHome;
    }

    const env = {
      ...process.env,
      MEMEX_HOME: home,
      MEMEX_DB_PATH: dbPath,
      SESSION_ID,
      CWD: EXTRACT_PROJECT,
      MB_TRANSCRIPT_PATH: transcript,
      MEMEX_CODEX_BIN: codexStub!,
      MEMEX_LLM_RETRIES: "0",
      MEMEX_CODEX_EXEC_TIMEOUT_MS: "15000",
    };
    const worker = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "fact-extract-worker.js")],
      { cwd: root, env, encoding: "utf8", timeout: 60_000 },
    );
    expect(worker.status).toBe(0);
    expect(worker.stdout).toMatch(
      new RegExp(`worker: session=${SESSION_ID} extracted=1 saved=1`),
    );
    expect(worker.stdout).not.toMatch(/\b(ERROR|FATAL|SKIPPED)\b/);

    // Vector contract: the saved fact carries its stored embedding, primary
    // vector row, source-exchange provenance, and a settled completion marker.
    const check = new Database(dbPath, { readonly: true });
    sqliteVec.load(check);
    try {
      const fact = check
        .prepare(
          `SELECT id, fact, scope_project, embedding_version,
                  embedding IS NOT NULL AS has_embedding, source_exchange_ids
           FROM facts`,
        )
        .get() as {
        id: string;
        fact: string;
        scope_project: string;
        embedding_version: number;
        has_embedding: number;
        source_exchange_ids: string;
      };
      expect(fact.fact).toBe(FACT_TEXT);
      expect(fact.scope_project).toBe(EXTRACT_PROJECT);
      expect(fact.embedding_version).toBe(EMBEDDING_VERSION);
      expect(fact.has_embedding).toBe(1);
      expect(JSON.parse(fact.source_exchange_ids)).toEqual([
        "p0-extract-exchange",
      ]);
      expect(
        check
          .prepare("SELECT COUNT(*) AS n FROM vec_facts_rowids WHERE id = ?")
          .get(fact.id),
      ).toEqual({ n: 1 });
      const marker = check
        .prepare(
          `SELECT extracted, saved, claim_owner, last_exchange_rowid
           FROM extraction_log WHERE session_id = ?`,
        )
        .get(SESSION_ID) as {
        extracted: number;
        saved: number;
        claim_owner: string | null;
        last_exchange_rowid: number;
      };
      expect(marker).toMatchObject({ extracted: 1, saved: 1, claim_owner: null });
      expect(marker.last_exchange_rowid).toBeGreaterThan(0);
    } finally {
      check.close();
    }

    // The same success must survive the real SessionEnd path: the hook
    // requires the canonical success line before exporting.
    const hook = spawnSync(process.execPath, ["scripts/session-end-hook.js"], {
      cwd: process.cwd(),
      env: {
        ...env,
        MEMEX_PLUGIN_ROOT: process.cwd(),
        MEMEX_STABILIZE_POLL_MS: "5",
        MEMEX_STABILIZE_QUIET_MS: "10",
        MEMEX_STABILIZE_MAX_WAIT_MS: "1000",
      },
      input: JSON.stringify({
        transcript_path: transcript,
        session_id: SESSION_ID,
        cwd: EXTRACT_PROJECT,
      }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(hook.status).toBe(0);
    expect(hook.stderr).not.toContain("no completion evidence");
    // P1-1: export commits one generation per device — probe it there.
    {
      const deviceDir = path.join(
        home, "conversation-index", "sync", "devices",
        fs.readdirSync(path.join(home, "conversation-index", "sync", "devices"))[0],
      );
      expect(
        fs.existsSync(
          path.join(
            deviceDir, "generations",
            (JSON.parse(fs.readFileSync(path.join(deviceDir, "CURRENT"), "utf8")) as { generation: string })
              .generation,
            "meta.json",
          ),
        ),
      ).toBe(true);
    }
    const log = fs.readFileSync(
      path.join(home, "conversation-index", "fact-extract.log"),
      "utf8",
    );
    expect(log).toMatch(
      new RegExp(`worker: session=${SESSION_ID} extracted=1 saved=1`),
    );
    expect(log).not.toMatch(/\b(ERROR|FATAL|SKIPPED)\b/);
  });
});
