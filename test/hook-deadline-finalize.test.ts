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
  applyPendingEpochAdvance,
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  handleContinuityHook,
  HookDeadlineExceeded,
} from "../src/continuity-core.js";
import {
  captureGapDir,
  listEpochAdvanceMarkers,
  writeCaptureGapMarker,
} from "../src/capture-gap-markers.js";

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

/**
 * Let the wall clock pass the deadline the way a slow fsync-bound write does,
 * blocking this thread WITHOUT burning a core — a busy loop here starves the
 * sibling vitest workers and makes their timing assertions flake.
 */
function spinUntil(untilMs: number): void {
  const remaining = untilMs - Date.now();
  if (remaining <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
}

/**
 * A second PROCESS holding `BEGIN IMMEDIATE`. It has to be a process: the
 * waiting side blocks its thread inside SQLite, so a timer in this process
 * could never fire to release the lock.
 */
function holdWriteLock(holdMs: number): {
  marker: string; done: Promise<void>; release: () => void;
} {
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
  return {
    marker,
    done: new Promise<void>((resolve) => child.on("exit", () => resolve())),
    release: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
  };
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
    const deadlineAt = Date.now() + 600;

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
    const deadlineAt = Date.now() + 800;
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

describe("the epoch replay is idempotent against a moving checkpoint (#162 review 2)", () => {
  it("cannot advance the epoch a second time from a marker whose advance committed", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const before = contextEpoch();

    // The hook advances the epoch and is then killed: no finalize(), so its
    // marker survives exactly as a host kill leaves it.
    handleContinuityHook(payload("SessionStart", { source: "compact" }), { db });
    expect(contextEpoch()).toBe(before + 1);
    expect(markerFiles()).toHaveLength(1);

    // A later Stop moves latest_checkpoint_id, which is what the compact epoch
    // token used to be derived from — so the marker's transition suddenly
    // looked unapplied.
    const stop = handleContinuityHook(payload("Stop"), { db });
    stop.finalize?.();
    expect(stop.capture?.created).toBe(true);
    expect(markerFiles()).toHaveLength(1);

    // The next injection replays the SAME marker.
    applyPendingEpochAdvance(db, SESSION);
    expect(contextEpoch()).toBe(before + 1);
    expect(markerFiles()).toHaveLength(0);
  });

  it("cannot replay an older applied marker after a NEWER advance moved on", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const before = contextEpoch();

    // A: a compact advance whose hook was killed before it could finalize.
    handleContinuityHook(payload("SessionStart", { source: "compact", turn_id: "turn-A" }), { db });
    expect(contextEpoch()).toBe(before + 1);
    expect(markerFiles()).toHaveLength(1);

    // B: a later clear advance, killed the same way. Remembering only the LAST
    // marker id is what made A look unapplied again from here on.
    handleContinuityHook(payload("SessionStart", { source: "clear", turn_id: "turn-B" }), { db });
    expect(contextEpoch()).toBe(before + 2);
    expect(markerFiles()).toHaveLength(2);

    // Residency the session legitimately rebuilt after B. A wrongful replay of
    // A would clear exactly this.
    db.prepare(
      "UPDATE session_memory_state SET resident_fact_revisions_json = ? WHERE session_id = ?",
    ).run(JSON.stringify([["fact-1", 1, 1]]), SESSION);

    applyPendingEpochAdvance(db, SESSION);

    expect(contextEpoch()).toBe(before + 2);
    expect(
      (db
        .prepare("SELECT resident_fact_revisions_json AS j FROM session_memory_state WHERE session_id = ?")
        .get(SESSION) as { j: string }).j,
    ).toBe(JSON.stringify([["fact-1", 1, 1]]));
    expect(markerFiles()).toHaveLength(0);

    // A second injection has nothing left to replay and changes nothing.
    applyPendingEpochAdvance(db, SESSION);
    expect(contextEpoch()).toBe(before + 2);
  });

  it("never re-applies a marker whose history row the prune has retired", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });

    // A advances and its marker survives a host kill.
    handleContinuityHook(payload("SessionStart", { source: "compact", turn_id: "turn-A" }), { db });
    const aFile = path.join(captureGapDir(), markerFiles()[0]);
    // Age BOTH halves of A past the history prune's cutoff, keeping the file:
    // that is the state a month-old killed hook leaves behind.
    const aged = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
    const aMarker = JSON.parse(fs.readFileSync(aFile, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(aFile, JSON.stringify({ ...aMarker, ts: aged }) + "\n");
    db.prepare("UPDATE session_epoch_markers SET applied_at = ? WHERE marker_id = ?")
      .run(aged, String(aMarker.invocationId));

    // B advances, and its prune is what retires A's history row.
    handleContinuityHook(payload("SessionStart", { source: "clear", turn_id: "turn-B" }), { db });
    const epochAfterB = contextEpoch();
    db.prepare(
      "UPDATE session_memory_state SET resident_fact_revisions_json = ? WHERE session_id = ?",
    ).run(JSON.stringify([["fact-1", 1, 1]]), SESSION);

    applyPendingEpochAdvance(db, SESSION);

    expect(contextEpoch()).toBe(epochAfterB);
    expect(
      (db
        .prepare("SELECT resident_fact_revisions_json AS j FROM session_memory_state WHERE session_id = ?")
        .get(SESSION) as { j: string }).j,
    ).toBe(JSON.stringify([["fact-1", 1, 1]]));
    // The expired marker is retired rather than left to be re-read for ever.
    expect(fs.existsSync(aFile)).toBe(false);
    expect(markerFiles()).toHaveLength(0);
  });

  it("history still wins for a marker just inside the retention window", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    handleContinuityHook(payload("SessionStart", { source: "compact", turn_id: "turn-A" }), { db });
    const file = path.join(captureGapDir(), markerFiles()[0]);
    const marker = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // One hour short of retention, so the file is still replayable — while its
    // history row reads two hours PAST retention. The two stamps come from
    // different clocks (the marker from the hook's start, the row from the
    // advance's `now`, which a caller may supply), so they can disagree, and
    // only the prune's margin keeps the row that far out of the cutoff.
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...marker,
        ts: new Date(Date.now() - (30 * 24 - 1) * 60 * 60 * 1_000).toISOString(),
      }) + "\n",
    );
    db.prepare("UPDATE session_epoch_markers SET applied_at = ? WHERE marker_id = ?")
      .run(
        new Date(Date.now() - (30 * 24 + 2) * 60 * 60 * 1_000).toISOString(),
        String(marker.invocationId),
      );

    // A later advance runs the prune. With no margin it would take A's row and
    // leave A's still-replayable file with nothing to say it was applied.
    handleContinuityHook(payload("SessionStart", { source: "clear", turn_id: "turn-B" }), { db });
    const epochAfterB = contextEpoch();
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM session_epoch_markers WHERE marker_id = ?")
        .get(String(marker.invocationId)) as { n: number },
    ).toEqual({ n: 1 });

    applyPendingEpochAdvance(db, SESSION);

    expect(contextEpoch()).toBe(epochAfterB);
    expect(markerFiles()).toHaveLength(0);
  });

  it("deletes an expired marker with no history instead of applying it", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const before = contextEpoch();
    writeCaptureGapMarker({
      invocationId: "inv-expired",
      event: "SessionStart",
      source: "compact",
      sessionId: SESSION,
      cwd: "/project",
      transcriptPath: null,
      transcriptBytes: null,
      turnId: null,
      ts: new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString(),
    });

    applyPendingEpochAdvance(db, SESSION);

    expect(contextEpoch()).toBe(before);
    expect(markerFiles()).toHaveLength(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM session_epoch_markers").get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it("still repairs a marker whose advance never happened", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const before = contextEpoch();
    writeCaptureGapMarker({
      invocationId: "inv-never-applied",
      event: "SessionStart",
      source: "compact",
      sessionId: SESSION,
      cwd: "/project",
      transcriptPath: transcript,
      transcriptBytes: fs.statSync(transcript).size,
      turnId: null,
      ts: new Date().toISOString(),
    });
    applyPendingEpochAdvance(db, SESSION);
    expect(contextEpoch()).toBe(before + 1);
    expect(markerFiles()).toHaveLength(0);
  });
});

describe("the rehydration commit is bounded inside its body (#162 review 2)", () => {
  it("rolls back and reports deadline when the budget dies mid-transaction", () => {
    const scope = ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    db.prepare(
      `INSERT INTO work_capsules
         (workstream_id, generation, objective, current_state, next_actions_json, updated_at)
       VALUES (?, 1, ?, ?, ?, ?)`,
    ).run(
      scope.workstreamId,
      "Bound the rehydration commit",
      "Captured work",
      JSON.stringify(["Check the deadline inside the body"]),
      new Date().toISOString(),
    );

    // The clock jumps 10 s the moment the transaction body writes the recall
    // receipt — i.e. INSIDE the transaction, past a 2 s budget.
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const realPrepare = db.prepare.bind(db);
    const prepare = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (typeof sql === "string" && /INTO recall_events/i.test(sql)) offset += 10_000;
      return realPrepare(sql);
    }) as never);
    let result;
    try {
      result = handleContinuityHook(payload("SessionStart", { source: "resume" }), {
        db,
        budgetMs: 2_000,
      });
    } finally {
      prepare.mockRestore();
      now.mockRestore();
    }

    expect(result.stdout).toBe("");
    const done = doneRows();
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe("deadline");
    // Nothing from the rolled-back bundle survives.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM recall_events").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db
        .prepare("SELECT resident_fact_revisions_json AS j FROM session_memory_state WHERE session_id = ?")
        .get(SESSION) as { j: string }).j,
    ).toBe("[]");
  });
});

describe("db_wait_ms counts waits that never got the lock (#162 review 2)", () => {
  it("accounts for the whole time a persistent lock blocked the hook", async () => {
    const lock = holdWriteLock(60_000);
    await awaitLock(lock);
    try {
      const startedAt = Date.now();
      const result = handleContinuityHook(payload("Stop"), { db, budgetMs: 2_500 });
      const elapsed = Date.now() - startedAt;

      expect(result.capture).toBeUndefined();
      const done = doneRows();
      expect(done).toHaveLength(1);
      expect(done[0].outcome).toBe("busy");
      // Every acquisition attempt is a wait, whether or not it succeeded: the
      // capture's 800 ms AND the capture-gap row's, not just the one that ran.
      expect(Number(done[0].db_wait_ms)).toBeGreaterThanOrEqual(Math.round(elapsed * 0.9));
    } finally {
      lock.release();
      await lock.done;
    }
  }, 30_000);
});

describe("SessionStart write phases are measured too (#162 review 5)", () => {
  it("counts the wait a lock imposed on the session-state write", async () => {
    // The session row exists before the lock: the hook's own write is then the
    // FIRST thing the lock blocks, which is the shape the incident had.
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const lock = holdWriteLock(60_000);
    await awaitLock(lock);
    try {
      const startedAt = Date.now();
      const result = handleContinuityHook(payload("SessionStart", { source: "startup" }), {
        db,
        budgetMs: 2_500,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.stdout).toBe("");
      const done = doneRows();
      expect(done).toHaveLength(1);
      expect(["busy", "deadline"]).toContain(done[0].outcome);
      // SessionStart is not a capture, so nothing else could have contributed:
      // this number is the blocked session-state write or it is zero.
      expect(Number(done[0].db_wait_ms)).toBeGreaterThanOrEqual(Math.round(elapsed * 0.9));
    } finally {
      lock.release();
      await lock.done;
    }
  }, 30_000);
});

describe("marker lookup never loses the target session (#162 review 2)", () => {
  it("finds every epoch marker of one session behind hundreds of foreign ones", () => {
    const ts = new Date().toISOString();
    for (let i = 0; i < 600; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-foreign-${i}`, event: "Interrupt", source: null,
        sessionId: `other-session-${i}`, cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts,
      });
    }
    for (let i = 0; i < 40; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-target-${i}`, event: "SessionStart", source: "compact",
        sessionId: SESSION, cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts,
      });
    }

    const found = listEpochAdvanceMarkers(SESSION);
    expect(found).toHaveLength(40);
    expect(found.every(({ marker }) => marker.sessionId === SESSION)).toBe(true);
  });

  it("finds them behind hundreds of the session's OWN non-epoch markers", () => {
    const ts = new Date().toISOString();
    // Same session, so the session filter does not thin these out at all: only
    // the event/source predicate distinguishes them, and it has to run BEFORE
    // the bound or the epoch markers fall out of the window.
    for (let i = 0; i < 600; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-interrupt-${i}`, event: "Interrupt", source: null,
        sessionId: SESSION, cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts,
      });
    }
    for (let i = 0; i < 40; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-epoch-${i}`, event: "SessionStart", source: "compact",
        sessionId: SESSION, cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts,
      });
    }

    const found = listEpochAdvanceMarkers(SESSION);
    expect(found).toHaveLength(40);
    expect(found.every(({ marker }) => marker.event === "SessionStart")).toBe(true);
  });
});
