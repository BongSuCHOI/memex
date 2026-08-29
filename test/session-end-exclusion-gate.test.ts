import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 재감사 P1-1 / T01 — SessionEnd 추출 경로의 user exclusion gate 회귀.
 *
 * 실패 시나리오(재감사 보고서): 이미 일부 turn 이 인덱싱된 장기 세션에서 마지막
 * user turn 이 DO NOT INDEX 를 선언하면, 수정 전 워커는 purge 보다 먼저 기존
 * pending exchange 에서 fact 를 추출하고 sync-export 까지 수행했다. purge 는 다음
 * SessionStart 의 background sync 에서야 일어났다.
 *
 * 수정 후 계약(순서 고정): marker 관측 → purge(exchange/fact/요약) → 추출 금지 →
 * sync-export 는 privacy tombstone 만 남긴 payload 를 내보낸다.
 *
 * 워커와 SessionEnd 훅을 **실제 프로세스로** 실행한다(실제 dist, 실제 purge).
 * 추출 LLM 이 호출되면 canary stub 이 마커 파일을 남기므로 gate 누수가 즉시 드러난다.
 */

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => Array.from({ length: 384 }, () => 0.01),
  generateExchangeEmbedding: async () => Array.from({ length: 384 }, () => 0.01),
}));

import { initDatabase } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import { syncConversations } from "../src/sync.js";

const SESSION_ID = "01a00007-aaaa-4bbb-8ccc-ccccccccccc7";
const PROJECT = "/tmp/session-end-exclusion-gate/project";
const MARKER =
  "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>";
const FACT_TEXT =
  "The metrics pipeline standardizes on ZebraQuery for all aggregate exports";
let tmp: string | undefined;

function cleanRollout(): string {
  return [
    JSON.stringify({
      timestamp: "2026-08-29T01:00:00.000Z",
      type: "session_meta",
      payload: { id: SESSION_ID, cwd: PROJECT, cli_version: "0.149.0" },
    }),
    JSON.stringify({
      timestamp: "2026-08-29T01:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "We decided to standardize on ZebraQuery for the metrics pipeline.",
          },
        ],
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
  ].join("\n") + "\n";
}

function finalMarkerTurn(): string {
  return JSON.stringify({
    timestamp: "2026-08-29T01:03:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${MARKER}\n이 세션은 이제 인덱싱하지 마세요.` }],
    },
  }) + "\n";
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("SessionEnd extraction user exclusion gate (P1-1 / T01)", () => {
  it("purges before extraction, saves no fact, and exports only the privacy tombstone", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-end-exclusion-"));
    const dbPath = path.join(tmp, "conversation-index", "db.sqlite");
    const sessions = path.join(tmp, "sessions");
    const archive = path.join(tmp, "conversation-archive");
    fs.mkdirSync(sessions, { recursive: true });
    const transcript = path.join(sessions, `rollout-2026-08-29T01-00-00-${SESSION_ID}.jsonl`);
    fs.writeFileSync(transcript, cleanRollout());

    const priorDb = process.env.MEMEX_DB_PATH;
    const priorHome = process.env.MEMEX_HOME;
    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = tmp;
    try {
      // 1단계: 세션의 앞부분이 이미 인덱싱된 상태(부분 인덱싱)를 만든다 — 실제 sync 경로.
      await syncConversations(sessions, archive, { skipSummaries: true });
      let factId = "";
      let archiveCopy = "";
      {
        const db = initDatabase();
        try {
          const exchange = db
            .prepare("SELECT id, archive_path FROM exchanges WHERE session_id = ?")
            .get(SESSION_ID) as { id: string; archive_path: string };
          expect(exchange).toBeTruthy();
          // marker 추가 전 검색 가능 상태가 존재한다(단언의 무결성 확인).
          expect(
            (db.prepare("SELECT COUNT(*) AS n FROM vec_exchanges").get() as { n: number }).n,
          ).toBe(1);
          expect(
            (db.prepare(
              "SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'ZebraQuery'",
            ).get() as { n: number }).n,
          ).toBe(1);
          factId = insertFact(db, {
            fact: FACT_TEXT,
            category: "decision",
            scope_type: "project",
            scope_project: PROJECT,
            source_exchange_ids: [exchange.id],
            embedding: Array.from({ length: 384 }, () => 0.01),
          });
          // 아카이브 사본 옆 요약 — purge 가 이것도 제거해야 한다.
          fs.writeFileSync(
            exchange.archive_path.replace(/\.jsonl$/, "-summary.txt"),
            "stale summary of the now-excluded conversation",
          );
          archiveCopy = exchange.archive_path;
        } finally {
          db.close();
        }
      }

      // 2단계: SessionEnd 직전에 마지막 user turn 이 DO NOT INDEX 를 선언한다.
      fs.appendFileSync(transcript, finalMarkerTurn());

      // 추출 LLM canary — gate 가 새면 이 파일이 생기고 사후 단언이 실패한다.
      const canary = path.join(tmp, "llm-invoked");
      const codexBin = path.join(tmp, "codex-canary.mjs");
      fs.writeFileSync(
        codexBin,
        [
          "#!/usr/bin/env node",
          'import fs from "node:fs";',
          `fs.writeFileSync(${JSON.stringify(canary)}, String(process.pid));`,
          'const out = process.argv.includes("-o") ? process.argv[process.argv.indexOf("-o") + 1] : null;',
          'if (out) fs.writeFileSync(out, "[]");',
        ].join("\n") + "\n",
      );
      fs.chmodSync(codexBin, 0o755);

      const env = {
        ...process.env,
        MEMEX_HOME: tmp,
        MEMEX_DB_PATH: dbPath,
        SESSION_ID,
        CWD: PROJECT,
        MB_TRANSCRIPT_PATH: transcript,
        MEMEX_CODEX_BIN: codexBin,
      };

      // 3단계: 실제 SessionEnd worker — gate → purge → 추출 금지.
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
      expect(
        fs.existsSync(canary),
        "exclusion gate 가 추출 LLM 을 막지 못했다",
      ).toBe(false);

      // 4단계: 검색 가능 상태 0 + privacy tombstone 존재 + 완료 마커 잔존 없음.
      const check = initDatabase();
      try {
        expect(
          (check.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as { n: number }).n,
        ).toBe(0);
        expect(
          (check.prepare("SELECT COUNT(*) AS n FROM vec_exchanges").get() as { n: number }).n,
        ).toBe(0);
        expect(
          (check.prepare(
            "SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'ZebraQuery'",
          ).get() as { n: number }).n,
        ).toBe(0);
        expect(
          (check.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n,
        ).toBe(0);
        expect(
          (check.prepare("SELECT COUNT(*) AS n FROM vec_facts").get() as { n: number }).n,
        ).toBe(0);
        expect(
          (check.prepare(
            "SELECT COUNT(*) AS n FROM extraction_log WHERE session_id = ?",
          ).get(SESSION_ID) as { n: number }).n,
        ).toBe(0);
        const tombstone = check
          .prepare("SELECT fact_id, reason FROM fact_tombstones")
          .all() as Array<{ fact_id: string; reason: string }>;
        expect(tombstone).toEqual([
          { fact_id: factId, reason: "source_conversation_excluded" },
        ]);
      } finally {
        check.close();
      }
      // purge 는 아카이브 요약도 제거한다(아카이브 사본 자체는 파생 데이터로 유지).
      expect(archiveCopy.startsWith(archive)).toBe(true);
      expect(fs.existsSync(archiveCopy.replace(/\.jsonl$/, "-summary.txt"))).toBe(false);
      expect(fs.existsSync(archiveCopy)).toBe(true);

      // 5단계: 실제 SessionEnd 훅 — 성공줄 증거로 sync-export 가 실행되고,
      // 내보내는 payload 는 privacy tombstone 만 남긴다.
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

      const syncDir = path.join(tmp, "conversation-index", "sync");
      expect(fs.existsSync(path.join(syncDir, "meta.json"))).toBe(true);
      const exportedFacts = fs
        .readFileSync(path.join(syncDir, "facts.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim());
      expect(exportedFacts, "purge 된 fact 는 payload 에 남지 않는다").toEqual([]);
      const exportedTombstones = fs
        .readFileSync(path.join(syncDir, "fact-tombstones.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { fact_id: string; reason: string });
      expect(exportedTombstones).toEqual([
        { fact_id: factId, reason: "source_conversation_excluded", deleted_at: expect.any(String) },
      ]);
    } finally {
      if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = priorDb;
      if (priorHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = priorHome;
    }
  });
});
