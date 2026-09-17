// Issue #162 (Codex diff review) — the hook budget has to bind every phase, and
// "done" has to mean delivered.
//
// The 0.7.24 first pass chose ONE busy_timeout at connect time and then ran
// every later phase without ever looking at the clock again, so a hook whose
// budget had already expired still advanced the context epoch and reported
// `ok`. It also treated an ordinary capture failure as a success (marker
// deleted, outcome `ok`), and wrote the done row plus deleted the marker BEFORE
// stdout was delivered — which is exactly the window a host kill lands in.
//
// Every test here uses an isolated MEMEX_HOME under a temp dir and never the
// real data root.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";

import { initDatabase } from "../src/db.js";
import {
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  handleContinuityHook,
  HookDeadlineExceeded,
} from "../src/continuity-core.js";
import { captureGapDir } from "../src/capture-gap-markers.js";

const require_ = createRequire(import.meta.url);
const SESSION = "session-hook-deadline-1";

let root: string;
let home: string;
let dbPath: string;
let sessions: string;
let transcript: string;
let db: Database.Database;

function rollout(sessionId = SESSION): string {
  return (
    [
      { type: "session_meta", payload: { id: sessionId, cwd: "/project" } },
      {
        type: "response_item",
        timestamp: "2026-09-17T00:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Bind every phase to the budget" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-09-17T00:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Next: re-check the deadline" }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n"
  );
}

function payload(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: transcript,
    cwd: "/project",
    hook_event_name: event,
    turn_id: "turn-1",
    ...extra,
  };
}

function hookEventRows(): Array<Record<string, unknown>> {
  const file = path.join(home, "logs", "hook-events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function doneRows(): Array<Record<string, unknown>> {
  return hookEventRows().filter((row) => row.phase === "done");
}

function markerFiles(): string[] {
  try {
    return fs.readdirSync(captureGapDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

function contextEpoch(): number {
  return (
    db
      .prepare("SELECT context_epoch FROM session_memory_state WHERE session_id = ?")
      .get(SESSION) as { context_epoch: number }
  ).context_epoch;
}

function spinUntil(untilMs: number): void {
  while (Date.now() <= untilMs) {
    /* burn the budget the way a slow fsync-bound write does */
  }
}

/**
 * A second PROCESS holding `BEGIN IMMEDIATE`. It has to be a process: the
 * waiting side blocks its thread inside SQLite, so a timer in this process
 * could never fire to release the lock.
 */
function holdWriteLock(holdMs: number): { marker: string; done: Promise<void> } {
  const script = path.join(root, "hold-lock.cjs");
  const marker = path.join(root, "locked");
  fs.writeFileSync(
    script,
    `
const fs = require("node:fs");
const Database = require(${JSON.stringify(require_.resolve("better-sqlite3"))});
const db = new Database(${JSON.stringify(dbPath)});
db.pragma("busy_timeout = 5000");
db.exec("BEGIN IMMEDIATE");
fs.writeFileSync(${JSON.stringify(marker)}, "1");
setTimeout(() => { db.exec("COMMIT"); db.close(); }, ${holdMs});
`,
  );
  const child = spawn(process.execPath, [script], { stdio: "inherit" });
  return { marker, done: new Promise<void>((resolve) => child.on("exit", () => resolve())) };
}

async function awaitLock(lock: { marker: string }): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(lock.marker)) {
    if (Date.now() > deadline) throw new Error("the lock holder never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-hook-deadline-"));
  home = path.join(root, "memex-home");
  dbPath = path.join(root, "memex.sqlite");
  sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  transcript = path.join(sessions, `rollout-${SESSION}.jsonl`);
  fs.writeFileSync(transcript, rollout());
  process.env.MEMEX_HOME = home;
  process.env.MEMEX_DB_PATH = dbPath;
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = sessions;
  delete process.env.MEMEX_HOOK_BUDGET_MS;
  delete process.env.MEMEX_HOOK_INGEST_BYTES_PER_MS;
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  delete process.env.MEMEX_HOOK_BUDGET_MS;
  delete process.env.MEMEX_HOOK_INGEST_BYTES_PER_MS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the hook deadline binds every phase (issue #162 review P1)", () => {
  it("refuses a SessionStart(clear) whose budget expired before the phase started", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const before = contextEpoch();

    const result = handleContinuityHook(payload("SessionStart", { source: "clear" }), {
      db,
      // The budget ran out 10 s ago: the host has long since killed a real hook.
      startedAt: Date.now() - 10_000,
      budgetMs: 2_000,
    });

    expect(result.stdout).toBe("");
    expect(contextEpoch()).toBe(before);
    const done = doneRows();
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe("deadline");
    // The skipped transition stays visible for doctor and for #163.
    expect(markerFiles()).toHaveLength(1);
  });

  it("refuses a Stop capture whose budget expired before the phase started", () => {
    const result = handleContinuityHook(payload("Stop"), {
      db,
      startedAt: Date.now() - 10_000,
      budgetMs: 2_000,
    });
    expect(result.capture).toBeUndefined();
    expect(doneRows()[0].outcome).toBe("deadline");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("the capture commit is bounded too (issue #162 review P2)", () => {
  it("rolls back when the deadline passes while the checkpoint rows are written", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const deadlineAt = Date.now() + 5_000;

    expect(() =>
      captureTranscriptPrefix(db, {
        sessionId: SESSION,
        project: "/project",
        transcriptPath: transcript,
        kind: "stop",
        turnId: "turn-1",
        deadlineAt,
        // The journal is already fsynced here and the write lock is held: this
        // is the most expensive place to overrun, and it used to commit anyway.
        afterCheckpoint: () => spinUntil(deadlineAt + 50),
      }),
    ).toThrow(HookDeadlineExceeded);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM journal_streams").get() as { n: number }).n,
    ).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it("stops in the reverse line scan before copying a single journal byte", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    // > one 4 MiB scan buffer of trailing bytes with no newline, so the reverse
    // scan for the last complete JSONL line takes more than one iteration.
    fs.appendFileSync(transcript, "x".repeat(5 * 1024 * 1024));
    const deadlineAt = Date.now() + 1_000;
    let copiedChunks = 0;
    const realRead = fs.readSync;
    let burned = false;
    const read = vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
      const returned = (realRead as (...a: unknown[]) => number)(...args);
      // The first big read is the reverse scan's first buffer.
      if (!burned && typeof args[3] === "number" && args[3] >= 1024 * 1024) {
        burned = true;
        spinUntil(deadlineAt + 50);
      }
      return returned;
    }) as never);
    try {
      expect(() =>
        captureTranscriptPrefix(db, {
          sessionId: SESSION,
          project: "/project",
          transcriptPath: transcript,
          kind: "stop",
          turnId: "turn-1",
          deadlineAt,
          afterJournalChunk: () => { copiedChunks++; },
        }),
      ).toThrow(HookDeadlineExceeded);
    } finally {
      read.mockRestore();
    }
    expect(copiedChunks).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM journal_streams").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("an ordinary capture failure is not a success (issue #162 review P2)", () => {
  it("keeps the marker, reports outcome error, and writes the gap exactly once", () => {
    // A transcript whose session_meta names a different session: the capture
    // throws an ordinary Error, not SQLITE_BUSY and not a deadline.
    fs.writeFileSync(transcript, rollout("some-other-session"));
    const prepare = vi.spyOn(db, "prepare");

    const result = handleContinuityHook(payload("Stop"), { db });

    const gapWrites = prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" && /INTO capture_gaps/.test(sql),
    ).length;
    prepare.mockRestore();

    expect(result.warning).toContain("does not match");
    expect(result.capture).toBeUndefined();
    // The marker is the durable record that this capture never happened.
    expect(markerFiles()).toHaveLength(1);
    const done = doneRows();
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe("error");
    expect(String(done[0].error)).toContain("does not match");
    expect(gapWrites).toBe(1);
  });
});

describe("finalization happens after delivery (issue #162 review P2)", () => {
  it("defers the done row and the marker deletion to the returned handle", () => {
    const result = handleContinuityHook(payload("Stop"), { db });
    expect(result.capture?.created).toBe(true);

    // Nothing is final yet: a host kill here must still look like a kill.
    expect(doneRows()).toHaveLength(0);
    expect(markerFiles()).toHaveLength(1);

    result.finalize?.();
    expect(doneRows().map((row) => row.outcome)).toEqual(["ok"]);
    expect(markerFiles()).toHaveLength(0);
  });

  it("records an error and keeps the marker when delivery fails", () => {
    const result = handleContinuityHook(payload("Stop"), { db });
    result.finalize?.(new Error("stdout closed before the host read it"));

    const done = doneRows();
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe("error");
    expect(String(done[0].error)).toContain("stdout closed");
    expect(markerFiles()).toHaveLength(1);
  });

  it("is idempotent, so a second call cannot overwrite the first verdict", () => {
    const result = handleContinuityHook(payload("Stop"), { db });
    result.finalize?.();
    result.finalize?.(new Error("late"));
    expect(doneRows()).toHaveLength(1);
    expect(doneRows()[0].outcome).toBe("ok");
  });
});

describe("db_wait_ms counts the real lock waits (issue #162 review P2)", () => {
  it("includes the capture transaction's own wait, not just the connection", async () => {
    // Shorter than the 800 ms ceiling one hook wait may spend, so the capture
    // SUCCEEDS after waiting: the case the old accounting reported as 0.
    const lock = holdWriteLock(600);
    await awaitLock(lock);

    const result = handleContinuityHook(payload("Stop"), {
      db,
      budgetMs: 60_000,
    });
    result.finalize?.();
    await lock.done;

    expect(result.capture?.created).toBe(true);
    const done = doneRows();
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe("ok");
    expect(Number(done[0].db_wait_ms)).toBeGreaterThan(250);
  }, 20_000);
});
