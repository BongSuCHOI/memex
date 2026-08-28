import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../src/db.js";

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
    expect(
      fs.existsSync(path.join(tmp, "conversation-index", "sync", "meta.json")),
    ).toBe(true);
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
