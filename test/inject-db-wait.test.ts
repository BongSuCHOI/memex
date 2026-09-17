// Issue #162 (Codex diff review) — `db_wait_ms` has to mean the same thing on
// both hooks.
//
// The continuity hook's done row summed only the connection open and the
// capture-gap write, and the inject hook's done row had no `db_wait_ms` at all
// — while "database is locked, via=daemon, 5.2 s" is the single most useful
// line in the whole incident. Both now report the time actually spent BLOCKED
// before a write transaction body started.
//
// Isolated MEMEX_HOME under a temp dir. The root is kept SHORT on purpose:
// `sockaddr_un.sun_path` is 104 bytes on macOS and the daemon socket lives
// under MEMEX_HOME.
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { initDatabase } from "../src/db.js";
import { commitInjectionBundle } from "../src/inject-core.js";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "scripts", "inject-context.js");

let root: string;
let dbPath: string;
let server: net.Server | null = null;

function hookEventRows(): Array<Record<string, unknown>> {
  const file = path.join(root, "logs", "hook-events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * A daemon that answers the real handshake by echoing the identity it was
 * asked for, and reports the wait it paid inside its own process.
 */
function fakeDaemon(dbWaitMs: number): Promise<void> {
  const sock = path.join(root, "conversation-index", "inject-daemon.sock");
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  return new Promise((resolve, reject) => {
    server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        const identity = {
          protocol: request.protocol,
          version: request.version,
          buildId: request.buildId,
          pluginRoot: request.pluginRoot,
          dbPath: request.dbPath,
        };
        conn.write(JSON.stringify({ type: "ack", ...identity }) + "\n");
        conn.write(
          JSON.stringify({
            type: "ok",
            ...identity,
            ok: true,
            context: "",
            receiptId: null,
            dbWaitMs,
          }) + "\n",
        );
      });
    });
    server.on("error", reject);
    server.listen(sock, () => resolve());
  });
}

function holdWriteLock(holdMs: number): { marker: string; done: Promise<void> } {
  const script = path.join(root, "hold.cjs");
  const marker = path.join(root, "locked");
  fs.writeFileSync(
    script,
    `
const fs = require("node:fs");
const Database = require(${JSON.stringify(require_.resolve("better-sqlite3"))});
const db = new Database(${JSON.stringify(dbPath)});
db.pragma("busy_timeout = 10000");
db.exec("BEGIN IMMEDIATE");
fs.writeFileSync(${JSON.stringify(marker)}, "1");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});
`,
  );
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  return { marker, done: new Promise<void>((resolve) => child.on("exit", () => resolve())) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mxi-"));
  dbPath = path.join(root, "db.sqlite");
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = dbPath;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

it("the inject done row carries the wait the daemon paid", async () => {
  await fakeDaemon(137);
  // spawn, never spawnSync: the fake daemon runs on THIS event loop, and a
  // synchronous child would block it until the hook had already given up.
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MEMEX_HOME: root, MEMEX_DB_PATH: dbPath },
  });
  child.stdin.end(
    JSON.stringify({ prompt: "왜 Redis?", cwd: "/project", session_id: "s-inject-wait" }),
  );
  const status = await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  expect(status).toBe(0);

  const done = hookEventRows().find(
    (row) => row.event === "UserPromptSubmit" && row.phase === "done",
  );
  expect(done).toBeTruthy();
  expect(done!.outcome).toBe("daemon");
  expect(done!.db_wait_ms).toBe(137);
}, 30_000);

it("commitInjectionBundle reports the wait, and reports nothing when it never got the lock", async () => {
  const db: Database.Database = initDatabase();
  try {
    const lock = holdWriteLock(700);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(lock.marker)) {
      if (Date.now() > deadline) throw new Error("the lock holder never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Never got the lock: nothing is reported, so nothing can be mistaken for
    // time this process spent holding it.
    db.pragma("busy_timeout = 100");
    let enteredWhileBusy = false;
    await expect(
      commitInjectionBundle(db, () => { /* never reached */ }, {
        retries: 0,
        onTransactionStart: () => { enteredWhileBusy = true; },
      }),
    ).rejects.toThrow(/SQLITE_BUSY|database is locked/i);
    expect(enteredWhileBusy).toBe(false);

    // Waited, then got it: the wait is the span before the body started.
    db.pragma("busy_timeout = 5000");
    const calledAt = Date.now();
    let waitMs = -1;
    await commitInjectionBundle(db, () => { /* the bundle writes go here */ }, {
      onTransactionStart: () => { waitMs = Date.now() - calledAt; },
    });
    await lock.done;
    expect(waitMs).toBeGreaterThan(100);
  } finally {
    db.close();
  }
}, 30_000);
