import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { initDatabase } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";

/**
 * backfill seedFromExistingFacts writes the SEED marker's watermark as the
 * SESSION max exchange rowid (docs/FACT-LIFECYCLE.md). A single-exchange
 * rowid would leave the settled no-op gate open, so a resumed session's
 * SessionEnd re-extracts already-factized exchanges.
 */

const SESSION_ID = "01b00001-aaaa-4bbb-8ccc-ccccccccccc1";
const PROJECT = "/tmp/backfill-seed-watermark/project";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("backfill seed marker watermark", () => {
  it("covers the whole session up to seed time", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-backfill-seed-"));
    const home = path.join(tmp, "home");
    const dbPath = path.join(home, "conversation-index", "db.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const priorDb = process.env.MEMEX_DB_PATH;
    const priorHome = process.env.MEMEX_HOME;
    process.env.MEMEX_DB_PATH = dbPath;
    process.env.MEMEX_HOME = home;
    const db = initDatabase();
    try {
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const id = `seed-exchange-${i}`;
        ids.push(id);
        db.prepare(
          `INSERT INTO exchanges
            (id, project, timestamp, user_message, assistant_message, archive_path,
             line_start, line_end, session_id, cwd, is_sidechain)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          id,
          PROJECT,
          new Date(Date.now() + i * 1000).toISOString(),
          `질문 ${i}`,
          `답변 ${i}`,
          "/tmp/seed-fixture.jsonl",
          i,
          i,
          SESSION_ID,
          PROJECT,
        );
      }
      // A fact sourced from the FIRST exchange only — the seed marker must
      // still cover the whole session, not just that exchange's rowid.
      insertFact(db, {
        fact: "시드 대상 사실",
        category: "decision",
        scope_type: "project",
        scope_project: PROJECT,
        source_exchange_ids: [ids[0]],
        embedding: null,
      });
    } finally {
      db.close();
      if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = priorDb;
      if (priorHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = priorHome;
    }

    // Safety net only — the seeded session is never picked for extraction.
    const stub = path.join(tmp, "codex-stub.mjs");
    fs.writeFileSync(stub, "#!/usr/bin/env node\nprocess.exit(0);\n");
    fs.chmodSync(stub, 0o755);

    const worker = spawnSync(
      process.execPath,
      ["scripts/backfill-extract-worker.js"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MEMEX_HOME: home,
          MEMEX_DB_PATH: dbPath,
          MEMEX_CODEX_BIN: stub,
          MEMEX_LLM_RETRIES: "0",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(worker.status).toBe(0);

    const check = new Database(dbPath, { readonly: true });
    try {
      const marker = check
        .prepare(
          "SELECT extracted, last_exchange_rowid FROM extraction_log WHERE session_id = ?",
        )
        .get(SESSION_ID) as { extracted: number; last_exchange_rowid: number };
      expect(marker.extracted).toBe(-1);
      const maxRowid = (
        check
          .prepare(
            "SELECT COALESCE(MAX(rowid), 0) AS m FROM exchanges WHERE session_id = ?",
          )
          .get(SESSION_ID) as { m: number }
      ).m;
      expect(marker.last_exchange_rowid).toBe(maxRowid);
    } finally {
      check.close();
    }
  });
});
