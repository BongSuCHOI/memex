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
import { initDatabase, recordRecallEvent } from "../src/db.js";
import { commitInjectionBundle } from "../src/inject-core.js";
import { hookLatencyCheck } from "../src/lifecycle.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { writeCaptureGapMarker } from "../src/capture-gap-markers.js";

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
function fakeDaemon(
  dbWaitMs: number,
  options: { context?: string; receiptId?: string | null; beforeOk?: () => Promise<void> } = {},
): Promise<void> {
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
        void (async () => {
          // A seam that fires between the ack and the served context: the only
          // DB access left on the daemon path is the receipt write.
          if (options.beforeOk) await options.beforeOk();
          conn.write(
            JSON.stringify({
              type: "ok",
              ...identity,
              ok: true,
              context: options.context ?? "",
              receiptId: options.receiptId ?? null,
              dbWaitMs,
            }) + "\n",
          );
        })();
      });
    });
    server.on("error", reject);
    server.listen(sock, () => resolve());
  });
}

function holdWriteLock(holdMs: number): {
  marker: string; done: Promise<void>; release: () => void;
} {
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
  return {
    marker,
    done: new Promise<void>((resolve) => child.on("exit", () => resolve())),
    release: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
  };
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

it("commitInjectionBundle marks the instant the lock was granted, and never claims one it did not get", async () => {
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

it("reports the inject wait even when the lock was never granted", async () => {
  const db: Database.Database = initDatabase();
  try {
    const lock = holdWriteLock(60_000);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(lock.marker)) {
      if (Date.now() > deadline) throw new Error("the lock holder never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // A commit that times out is the case the incident logs recorded as
    // "database is locked ... 5.2 s", and it is precisely the wait that used to
    // be reported as nothing at all.
    db.pragma("busy_timeout = 600");
    let reported = -1;
    const startedAt = Date.now();
    await expect(
      commitInjectionBundle(db, () => { /* never reached */ }, {
        retries: 0,
        onDbWaitMs: (ms) => { reported = ms; },
      }),
    ).rejects.toThrow(/SQLITE_BUSY|database is locked/i);
    const elapsed = Date.now() - startedAt;

    expect(reported).toBeGreaterThanOrEqual(Math.round(elapsed * 0.9));
    lock.release();
    await lock.done;
  } finally {
    db.close();
  }
}, 30_000);

it("reports every database wait of a cold inject that never got the lock", async () => {
  // Schema first, so the run under test pays only for the lock.
  initDatabase().close();
  const lock = holdWriteLock(60_000);
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(lock.marker)) {
    if (Date.now() > deadline) throw new Error("the lock holder never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const startedAt = Date.now();
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MEMEX_HOME: root, MEMEX_DB_PATH: dbPath },
  });
  child.stdin.end(
    JSON.stringify({ prompt: "왜 Redis?", cwd: "/project", session_id: "s-inject-locked" }),
  );
  const status = await new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  const elapsed = Date.now() - startedAt;
  lock.release();
  await lock.done;

  // The hook never disrupts the prompt, so it still exits 0 — which is exactly
  // why the done row has to carry the failure and the wait.
  expect(status).toBe(0);
  const done = hookEventRows().find(
    (row) => row.event === "UserPromptSubmit" && row.phase === "done",
  );
  expect(done).toBeTruthy();
  expect(done!.outcome).toBe("error");
  // The busy_timeout the inject path spends on the lock, not zero.
  expect(Number(done!.db_wait_ms)).toBeGreaterThanOrEqual(4_500);
  expect(Number(done!.db_wait_ms)).toBeLessThanOrEqual(elapsed);

  // And doctor can finally see it.
  const check = hookLatencyCheck();
  expect(check.status).toBe("warn");
  expect(check.detail).toContain("waited on the database");
}, 60_000);

it("does not charge a slow but UNCONTENDED inject phase to the database wait", async () => {
  const db = initDatabase();
  ensureSessionMemoryState(db, { sessionId: "s-inject-slow", project: "/project" });
  db.close();
  // A pile of pending epoch markers: the replay phase then does hundreds of
  // real, uncontended write transactions plus the directory scan. Slow, but not
  // one millisecond of it is spent waiting for a lock.
  const padding = "p".repeat(16 * 1024);
  for (let i = 0; i < 500; i++) {
    writeCaptureGapMarker({
      invocationId: `inv-slow-${i}`, event: "SessionStart", source: "compact",
      sessionId: "s-inject-slow", cwd: padding, transcriptPath: null,
      transcriptBytes: null, turnId: null, ts: new Date().toISOString(),
    });
  }

  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MEMEX_HOME: root, MEMEX_DB_PATH: dbPath },
  });
  child.stdin.end(
    JSON.stringify({ prompt: "왜 Redis?", cwd: "/project", session_id: "s-inject-slow" }),
  );
  const status = await new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );

  expect(status).toBe(0);
  const done = hookEventRows().find(
    (row) => row.event === "UserPromptSubmit" && row.phase === "done",
  );
  expect(done).toBeTruthy();
  expect(done!.outcome).toBe("fallback");
  expect(Number(done!.db_wait_ms)).toBeLessThan(100);
  const check = hookLatencyCheck();
  expect(check.detail ?? "").not.toContain("waited on the database");
}, 60_000);

/**
 * A holder that waits for the epoch REPLAY to start before taking the lock.
 *
 * The replay is the only phase this test wants contended, and it sits between
 * the connection open and the session-state write with no externally visible
 * boundary — except one: the repair deletes each marker file as it applies it.
 * So the holder polls the marker directory and grabs the lock the moment the
 * count drops, which is inside the replay by construction.
 */
function holdLockOnceReplayStarts(
  markerDir: string,
  initialCount: number,
  holdMs: number,
): { marker: string; done: Promise<void>; release: () => void } {
  const script = path.join(root, "hold-on-replay.cjs");
  const marker = path.join(root, "locked-replay");
  fs.writeFileSync(
    script,
    `
const fs = require("node:fs");
const Database = require(${JSON.stringify(require_.resolve("better-sqlite3"))});
const startedAt = Date.now();
const count = () => { try { return fs.readdirSync(${JSON.stringify(markerDir)}).length; } catch { return ${initialCount}; } };
const grab = () => {
  const db = new Database(${JSON.stringify(dbPath)});
  db.pragma("busy_timeout = 20000");
  db.exec("BEGIN IMMEDIATE");
  fs.writeFileSync(${JSON.stringify(marker)}, "1");
  setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});
};
const poll = () => {
  // The timeout only exists so a broken run fails an assertion instead of hanging.
  if (count() < ${initialCount} || Date.now() - startedAt > 20000) return grab();
  setTimeout(poll, 3);
};
poll();
`,
  );
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  return {
    marker,
    done: new Promise<void>((resolve) => child.on("exit", () => resolve())),
    release: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
  };
}

it("carries the epoch repair's lock wait into the inject done row", async () => {
  const db = initDatabase();
  ensureSessionMemoryState(db, { sessionId: "s-inject-repair", project: "/project" });
  db.close();
  // Enough padded markers that the replay is a wide enough window for the
  // holder to land inside it, and enough left afterwards to actually block.
  const padding = "p".repeat(16 * 1024);
  const markers = 500;
  for (let i = 0; i < markers; i++) {
    writeCaptureGapMarker({
      invocationId: `inv-repair-${i}`, event: "SessionStart", source: "compact",
      sessionId: "s-inject-repair", cwd: padding, transcriptPath: null,
      transcriptBytes: null, turnId: null, ts: new Date().toISOString(),
    });
  }
  const markerDir = path.join(root, "continuity", "gaps");
  expect(fs.readdirSync(markerDir)).toHaveLength(markers);

  const lock = holdLockOnceReplayStarts(markerDir, markers, 1_400);
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MEMEX_HOME: root, MEMEX_DB_PATH: dbPath },
  });
  child.stdin.end(
    JSON.stringify({ prompt: "왜 Redis?", cwd: "/project", session_id: "s-inject-repair" }),
  );
  const status = await new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  lock.release();
  await lock.done;

  // The lock was released long before the hook needed anything else, so the
  // injection itself still succeeds — only the wait has to be visible.
  expect(status).toBe(0);
  const done = hookEventRows().find(
    (row) => row.event === "UserPromptSubmit" && row.phase === "done",
  );
  expect(done).toBeTruthy();
  expect(done!.outcome).toBe("fallback");
  expect(Number(done!.db_wait_ms)).toBeGreaterThanOrEqual(1_000);
  const check = hookLatencyCheck();
  expect(check.status).toBe("warn");
  expect(check.detail).toContain("waited on the database");
}, 60_000);

it("accounts the recall receipt's lock wait and failure in the done row", async () => {
  // A prepared receipt the hook will try to mark emitted.
  const db = initDatabase();
  const receiptId = recordRecallEvent(db, {
    sessionId: "s-inject-receipt",
    project: "/project",
    prompt: "왜 Redis?",
    factIds: [],
    context: "[CURRENT TRUTH] something",
  });
  db.close();
  expect(receiptId).toBeTruthy();

  // The lock is taken BEFORE the served context reaches the hook, so the only
  // thing it can block is the receipt write — the last step, after stdout.
  let lock: { marker: string; done: Promise<void>; release: () => void } | null = null;
  await fakeDaemon(3, {
    context: "[CURRENT TRUTH] something",
    receiptId,
    beforeOk: async () => {
      lock = holdWriteLock(60_000);
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync((lock as { marker: string }).marker)) {
        if (Date.now() > deadline) throw new Error("the lock holder never started");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  });

  const startedAt = Date.now();
  const child = spawn(process.execPath, [HOOK], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MEMEX_HOME: root, MEMEX_DB_PATH: dbPath },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stdin.end(
    JSON.stringify({ prompt: "왜 Redis?", cwd: "/project", session_id: "s-inject-receipt" }),
  );
  const status = await new Promise<number>((resolve) =>
    child.on("exit", (code) => resolve(code ?? -1)),
  );
  const elapsed = Date.now() - startedAt;
  (lock as unknown as { release: () => void } | null)?.release();
  if (lock) await (lock as { done: Promise<void> }).done;

  // The context WAS delivered; only its provenance could not be recorded.
  expect(status).toBe(0);
  expect(stdout).toContain("CURRENT TRUTH");
  const done = hookEventRows().find(
    (row) => row.event === "UserPromptSubmit" && row.phase === "done",
  );
  expect(done).toBeTruthy();
  expect(done!.outcome).toBe("error");
  expect(String(done!.error)).toMatch(/SQLITE_BUSY|database is locked/i);
  expect(Number(done!.db_wait_ms)).toBeGreaterThanOrEqual(4_500);
  expect(Number(done!.db_wait_ms)).toBeLessThanOrEqual(elapsed);
  const check = hookLatencyCheck();
  expect(check.status).toBe("warn");
  expect(check.detail).toContain("waited on the database");
}, 60_000);
