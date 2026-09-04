import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { initDatabase } from "../src/db.js";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-db-init-race-"));
  dbPath = path.join(root, "memex.sqlite");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const CONTENT_TRIGGER = /AFTER UPDATE OF user_message, assistant_message ON exchanges/i;

function readAuTriggerSql(): string | undefined {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const row = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'exchanges_fts_au'")
      .get() as { sql?: string } | undefined;
    return row?.sql;
  } finally {
    raw.close();
  }
}

function runInitInChild(): Promise<void> {
  const dbUrl = pathToFileURL(path.resolve("src/db.ts")).href;
  const childCode = `
    import { initDatabase } from ${JSON.stringify(dbUrl)};
    const childDb = initDatabase({ dbPath: process.env.MEMEX_TEST_DB_PATH });
    childDb.close();
  `;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
      cwd: process.cwd(),
      env: { ...process.env, MEMEX_TEST_DB_PATH: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
}

describe("initDatabase under concurrent hook/MCP processes", () => {
  it("initializes a fresh database from six processes at once without a trigger collision", async () => {
    await Promise.all(Array.from({ length: 6 }, () => runInitInChild()));
    expect(readAuTriggerSql()).toMatch(CONTENT_TRIGGER);
  }, 60_000);

  it("replaces a legacy broad FTS update trigger exactly once across concurrent processes", async () => {
    const seeded = initDatabase({ dbPath });
    seeded.exec(`
      DROP TRIGGER IF EXISTS exchanges_fts_au;
      CREATE TRIGGER exchanges_fts_au AFTER UPDATE ON exchanges BEGIN
        INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
        VALUES('delete', old.rowid, old.user_message, old.assistant_message);
        INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
        VALUES (new.rowid, new.user_message, new.assistant_message);
      END;
    `);
    seeded.close();
    expect(readAuTriggerSql()).not.toMatch(CONTENT_TRIGGER);

    await Promise.all(Array.from({ length: 6 }, () => runInitInChild()));

    const sql = readAuTriggerSql();
    expect(sql).toMatch(CONTENT_TRIGGER);
    const raw = new Database(dbPath, { readonly: true });
    try {
      const count = raw
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'exchanges_fts_%'")
        .get() as { n: number };
      expect(count.n).toBe(3);
    } finally {
      raw.close();
    }
  }, 60_000);

  it("keeps the content-column trigger untouched on a repeated in-process init", () => {
    const first = initDatabase({ dbPath });
    first.close();
    const before = readAuTriggerSql();
    const second = initDatabase({ dbPath });
    second.close();
    expect(readAuTriggerSql()).toBe(before);
    expect(before).toMatch(CONTENT_TRIGGER);
  });
});
