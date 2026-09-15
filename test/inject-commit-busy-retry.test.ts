import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { commitInjectionBundle, isSqliteBusy } from "../src/inject-core.js";

/**
 * Issue #133: the injection commit waited its whole busy_timeout behind another
 * writer (a worker's WAL TRUNCATE checkpoint) and failed with `database is
 * locked` — the prompt received no memory, with no retry. The bundle is
 * retryable by design, so one short retry must carry it over a writer that
 * releases the lock in the meantime.
 */
let dir = "";
let file = "";
const handles: Database.Database[] = [];

function open(busyMs: number): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${busyMs}`);
  handles.push(db);
  return db;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-busy-retry-"));
  file = path.join(dir, "db.sqlite");
  const db = open(50);
  db.exec("CREATE TABLE receipts(id INTEGER PRIMARY KEY, v TEXT)");
});

afterEach(() => {
  for (const db of handles.splice(0)) {
    try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* already closed */ }
    try { db.close(); } catch { /* already closed */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

it("isSqliteBusy recognizes only the lock errors", () => {
  expect(isSqliteBusy(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))).toBe(true);
  expect(isSqliteBusy(Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }))).toBe(true);
  expect(isSqliteBusy(Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT" }))).toBe(false);
  expect(isSqliteBusy(new Error("no code"))).toBe(false);
  expect(isSqliteBusy(null)).toBe(false);
});

it("retries the commit once when another writer releases the lock in time", async () => {
  const holder = open(50);
  holder.exec("BEGIN IMMEDIATE");
  setTimeout(() => { try { holder.exec("COMMIT"); } catch { /* test teardown */ } }, 120);
  const writer = open(50);
  await commitInjectionBundle(
    writer,
    () => { writer.prepare("INSERT INTO receipts(v) VALUES ('prepared')").run(); },
    { retries: 1, delayMs: 250 },
  );
  expect(writer.prepare("SELECT COUNT(*) AS n FROM receipts").get()).toEqual({ n: 1 });
});

it("surfaces SQLITE_BUSY when the retry budget is spent", async () => {
  const holder = open(50);
  holder.exec("BEGIN IMMEDIATE");
  const writer = open(50);
  let attempts = 0;
  await expect(commitInjectionBundle(
    writer,
    () => { attempts++; writer.prepare("INSERT INTO receipts(v) VALUES ('prepared')").run(); },
    { retries: 1, delayMs: 20 },
  )).rejects.toMatchObject({ code: "SQLITE_BUSY" });
  // BEGIN IMMEDIATE fails before the body runs: the body never observed a lock.
  expect(attempts).toBe(0);
  holder.exec("ROLLBACK");
  expect(writer.prepare("SELECT COUNT(*) AS n FROM receipts").get()).toEqual({ n: 0 });
});

it("the retry waits for the lock only briefly and restores the connection's busy_timeout", async () => {
  const holder = open(50);
  holder.exec("BEGIN IMMEDIATE");
  const writer = open(50);
  writer.pragma("busy_timeout = 400");
  const started = Date.now();
  await expect(commitInjectionBundle(
    writer,
    () => { writer.prepare("INSERT INTO receipts(v) VALUES ('prepared')").run(); },
    { retries: 1, delayMs: 20, retryBusyMs: 100 },
  )).rejects.toMatchObject({ code: "SQLITE_BUSY" });
  // first attempt ≤ 400 ms, pause 20 ms, retry ≤ 100 ms — never a second full wait
  expect(Date.now() - started).toBeLessThan(900);
  expect(Number(writer.pragma("busy_timeout", { simple: true }))).toBe(400);
  holder.exec("ROLLBACK");
});

it("does not retry a non-lock failure", async () => {
  const writer = open(50);
  let attempts = 0;
  await expect(commitInjectionBundle(
    writer,
    () => { attempts++; throw Object.assign(new Error("fact meaning changed"), { code: "MEMEX_STALE" }); },
    { retries: 3, delayMs: 5 },
  )).rejects.toThrow(/fact meaning changed/);
  expect(attempts).toBe(1);
});
