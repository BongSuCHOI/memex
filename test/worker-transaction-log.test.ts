// Issue #162 — the worker's slow-transaction log names the write-lock holder.
//
// hook-events.jsonl could say a hook was slow but never who held the lock, and
// a single elapsed number cannot tell "this worker sat on the lock for 4 s"
// apart from "this worker waited 4 s for someone else". Those need opposite
// fixes, so they are measured separately:
//
//   wait_ms  call -> transaction body starts (this process WAITED)
//   held_ms  body start -> commit (this process HELD it; everyone else waited)
//
// The row format {ts, pid, label, wait_ms, held_ms} is read by `memex doctor`.
import { afterEach, beforeEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase } from "../src/db.js";
import { timeWorkerTransaction, workerTransactionLogPath } from "../src/continuity-worker.js";

const require_ = createRequire(import.meta.url);

let root: string;
let dbPath: string;
let db: Database.Database;

/** Block this thread the way a real transaction body does — inside the lock. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rows(): Array<{ ts: string; pid: number; label: string; wait_ms: number; held_ms: number }> {
  const file = workerTransactionLogPath();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function write(label: string, body: () => void): void {
  timeWorkerTransaction(label, (markStart) => db.transaction(() => {
    markStart();
    db.prepare("INSERT OR REPLACE INTO lock_probe(k, v) VALUES ('probe', ?)").run(label);
    body();
  }).immediate());
}

/**
 * A second PROCESS holding `BEGIN IMMEDIATE`. It has to be a process: the
 * waiting side blocks the thread inside SQLite, so a timer in this process
 * could never fire to release the lock.
 */
function holdWriteLock(holdMs: number): { marker: string; done: Promise<void> } {
  const script = path.join(root, "hold-lock.cjs");
  const marker = path.join(root, "locked");
  fs.writeFileSync(script, `
const fs = require("node:fs");
const Database = require(${JSON.stringify(require_.resolve("better-sqlite3"))});
const db = new Database(${JSON.stringify(dbPath)});
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
fs.writeFileSync(${JSON.stringify(marker)}, "1");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});
`);
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  return {
    marker,
    done: new Promise<void>((resolve) => child.on("exit", () => resolve())),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-txlog-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  dbPath = path.join(root, "db.sqlite");
  process.env.MEMEX_DB_PATH = dbPath;
  db = initDatabase();
  db.exec("CREATE TABLE IF NOT EXISTS lock_probe(k TEXT PRIMARY KEY, v TEXT)");
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

it("a fast transaction writes no row at all", () => {
  write("fast", () => { /* nothing slow */ });
  expect(rows()).toEqual([]);
  expect(fs.existsSync(workerTransactionLogPath())).toBe(false);
});

it("a 400 ms body is recorded as held, not as wait", () => {
  write("slow-body", () => sleepSync(400));

  const recorded = rows();
  expect(recorded.length).toBe(1);
  expect(recorded[0].label).toBe("slow-body");
  expect(recorded[0].pid).toBe(process.pid);
  expect(Number.isNaN(Date.parse(recorded[0].ts))).toBe(false);
  expect(recorded[0].held_ms).toBeGreaterThanOrEqual(400);
  expect(recorded[0].wait_ms).toBeLessThan(300);
});

it("a body blocked by another connection is recorded as wait, not as held", async () => {
  const lock = holdWriteLock(1_400);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(lock.marker)) {
    if (Date.now() > deadline) throw new Error("the lock holder never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  write("blocked", () => { /* fast once the lock is granted */ });
  await lock.done;

  const recorded = rows();
  expect(recorded.length).toBe(1);
  expect(recorded[0].label).toBe("blocked");
  expect(recorded[0].wait_ms).toBeGreaterThan(1_000);
  expect(recorded[0].held_ms).toBeLessThan(300);
});
