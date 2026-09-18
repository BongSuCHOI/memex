import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { initDatabase } from "../src/db.js";
import {
  advanceContextEpoch,
  applyPendingEpochAdvance,
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  handleContinuityHook,
  HookDeadlineExceeded,
  HookOversizeCapture,
} from "../src/continuity-core.js";
import {
  captureGapDir,
  listCaptureGapMarkers,
  pruneCaptureGapMarkers,
  writeCaptureGapMarker,
} from "../src/capture-gap-markers.js";
import { hookLatencyCheck } from "../src/lifecycle.js";
import {
  busyTimeoutForRemaining,
  hookBudgetMs,
  hookHostTimeoutMs,
  ingestFitsBudget,
  HOOK_EXIT_MARGIN_MS,
  HOOK_INGEST_RESERVE_MS,
  HOOK_PHASE_FLOOR_MS,
} from "../src/hook-budget.js";

/**
 * Issue #162 — the continuity hook must never hand the host a timeout.
 *
 * Every test here holds a REAL `BEGIN IMMEDIATE` from a second connection for
 * the whole hook run, which is exactly the production failure: a worker holding
 * the write lock longer than the host's 3 s kill timer while the hook waits on
 * sqlite's 5 s default. The hook has to give up inside its own budget, leave a
 * durable marker, and exit 0 with empty stdout.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "scripts", "continuity-hook.js");
const SESSION = "session-hook-budget-1";

let root: string;
let home: string;
let dbPath: string;
let sessions: string;
let transcript: string;
let db: Database.Database;
let locker: Database.Database | null = null;

function rollout(): string {
  return (
    [
      { type: "session_meta", payload: { id: SESSION, cwd: "/project" } },
      {
        type: "response_item",
        timestamp: "2026-09-17T00:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Bound the hook budget" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-09-17T00:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Next: hold the write lock" }],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n"
  );
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MEMEX_HOME: home,
    MEMEX_DB_PATH: dbPath,
    MEMEX_ALLOWED_TRANSCRIPT_ROOTS: sessions,
    // The worker spawn is a separate lane (#162 Lane B); keep it out of here.
    MEMEX_CONTINUITY_NO_WAKE: "1",
    ...extra,
  };
}

function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: transcript,
    cwd: "/project",
    hook_event_name: event,
    turn_id: "turn-1",
    ...extra,
  });
}

function holdWriteLock(): void {
  locker = new Database(dbPath);
  locker.pragma("busy_timeout = 0");
  locker.exec("BEGIN IMMEDIATE");
}

function releaseWriteLock(): void {
  if (!locker) return;
  try {
    locker.exec("ROLLBACK");
  } catch {
    /* already gone */
  }
  locker.close();
  locker = null;
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

function markerFiles(): string[] {
  try {
    return fs.readdirSync(captureGapDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-hook-budget-"));
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
  // Build the schema first so the hook run under test pays only for the lock.
  db = initDatabase();
});

afterEach(() => {
  releaseWriteLock();
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  delete process.env.MEMEX_HOOK_BUDGET_MS;
  delete process.env.MEMEX_HOOK_INGEST_BYTES_PER_MS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("continuity hook budget (issue #162)", () => {
  it("Stop under a held write lock exits 0 inside the default budget with a durable marker", () => {
    holdWriteLock();
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [HOOK], {
      input: payload("Stop"),
      encoding: "utf8",
      env: childEnv(),
    });
    const elapsed = Date.now() - startedAt;

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    // 10 s host timeout, 9,700 ms budget (#166): the process must exit inside the
    // budget with room for the host's timer, however long the lock is held.
    expect(elapsed).toBeLessThan(9_900);

    const markers = listCaptureGapMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].marker.event).toBe("Stop");
    expect(markers[0].marker.sessionId).toBe(SESSION);
    expect(markers[0].marker.transcriptBytes).toBe(fs.statSync(transcript).size);

    const done = hookEventRows().filter((row) => row.phase === "done");
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toBe("busy");
    expect(typeof done[0].db_wait_ms).toBe("number");
    const start = hookEventRows().filter((row) => row.phase === "start");
    expect(start).toHaveLength(1);
    expect(start[0].invocation_id).toBe(done[0].invocation_id);
    expect(typeof start[0].pid).toBe("number");

    // Nothing reached the database while the lock was held.
    releaseWriteLock();
    const streams = db
      .prepare("SELECT COUNT(*) AS n FROM journal_streams")
      .get() as { n: number };
    expect(streams.n).toBe(0);
    const checkpoints = db
      .prepare("SELECT COUNT(*) AS n FROM checkpoints")
      .get() as { n: number };
    expect(checkpoints.n).toBe(0);
  });

  it("PreCompact gets the larger budget and still exits 0 well before its host timeout", () => {
    holdWriteLock();
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [HOOK], {
      input: payload("PreCompact", { trigger: "auto" }),
      encoding: "utf8",
      env: childEnv(),
    });
    const elapsed = Date.now() - startedAt;

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(elapsed).toBeLessThan(14_900);
    expect(markerFiles()).toHaveLength(1);
  });

  it.each(["SessionEnd", "Interrupt"])("%s keeps the host's 3 s cap and exits inside it under a held lock (#166)", (event) => {
    holdWriteLock();
    const startedAt = Date.now();
    const run = spawnSync(process.execPath, [HOOK], {
      input: payload(event),
      encoding: "utf8",
      env: childEnv(),
    });
    const elapsed = Date.now() - startedAt;
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    // 3 s host cap, 2,700 ms budget: the two hooks the host will not let grow.
    // The budget bounds the hook's OWN clock (the done row); the exit margin is
    // what has to cover node's teardown after it, so both are asserted.
    const done = hookEventRows().find((row) => row.phase === "done")!;
    expect(done.outcome).toBe("busy");
    expect(Number(done.duration_ms)).toBeLessThanOrEqual(hookBudgetMs(event));
    expect(elapsed).toBeLessThan(2_900);
    expect(markerFiles()).toHaveLength(1);
  });

  it("SessionStart(resume) on a busy database exits 0 with empty stdout and a marker", () => {
    holdWriteLock();
    const run = spawnSync(process.execPath, [HOOK], {
      input: payload("SessionStart", { source: "resume" }),
      encoding: "utf8",
      env: childEnv(),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    const markers = listCaptureGapMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].marker.event).toBe("SessionStart");
    expect(markers[0].marker.source).toBe("resume");
    expect(
      hookEventRows().some((row) => row.phase === "done" && row.outcome === "busy"),
    ).toBe(true);
  });

  it("the success path writes the marker before the database and deletes it afterwards", () => {
    const realRename = fs.renameSync;
    const renamed: string[] = [];
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
      renamed.push(String(to));
      return realRename(from, to);
    }) as never);
    try {
      const result = handleContinuityHook(payload2("Stop"), { db });
      expect(result.capture).toBeTruthy();
      // #162 review: the marker outlives the hook until its output has been
      // delivered, so the success claim is the script's `finalize` call.
      result.finalize?.();
    } finally {
      rename.mockRestore();
    }
    expect(renamed.some((file) => file.startsWith(captureGapDir()))).toBe(true);
    expect(markerFiles()).toHaveLength(0);
    const rows = hookEventRows();
    expect(rows.some((row) => row.phase === "start")).toBe(true);
    expect(rows.some((row) => row.phase === "done" && row.outcome === "ok")).toBe(true);
  });

  it("a hook killed by the host leaves its marker and doctor names the kill", async () => {
    holdWriteLock();
    const child = spawn(process.execPath, [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      // A budget far past the test's patience: the hook is still waiting when
      // the simulated host kill arrives, exactly as SIGKILL at 3 s does.
      env: childEnv({ MEMEX_HOOK_BUDGET_MS: "60000" }),
    });
    child.stdin.end(payload("Stop"));
    const deadline = Date.now() + 10_000;
    while (markerFiles().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(markerFiles()).toHaveLength(1);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));

    expect(markerFiles()).toHaveLength(1);
    const rows = hookEventRows();
    expect(rows.some((row) => row.phase === "start")).toBe(true);
    expect(rows.some((row) => row.phase === "done")).toBe(false);

    // Doctor reads the pair; the unmatched start past budget + grace is the kill.
    const check = hookLatencyCheck(Date.now() + hookBudgetMs("Stop") + 10_000 + 1_000);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("killed by host");
    expect(check.detail).toContain("capture gap marker(s)");
  });

  /**
   * Issue #166 — on the work Mac the whole budget went to the fixed cost before
   * the first database call (node start, dist import, the DB open with its
   * migration pass, the marker fsync): `deadline` with 28 ms left and
   * `db_wait_ms: 0`. Nothing in the log said so, so the done row now measures it.
   */
  it("the done row measures the startup cost before the first database call (#166)", () => {
    const run = spawnSync(process.execPath, [HOOK], {
      input: payload("Stop"),
      encoding: "utf8",
      env: childEnv(),
    });
    expect(run.status).toBe(0);
    const done = hookEventRows().find((row) => row.phase === "done")!;
    expect(done.outcome).toBe("ok");
    expect(typeof done.startup_ms).toBe("number");
    const startup = Number(done.startup_ms);
    const duration = Number(done.duration_ms);
    expect(startup).toBeGreaterThan(0);
    expect(startup).toBeLessThanOrEqual(duration);
  });

  it("refuses to open the capture transaction when the delta cannot fit the budget", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    // 1 byte/ms against a ~100 ms usable window: this transcript cannot fit.
    process.env.MEMEX_HOOK_INGEST_BYTES_PER_MS = "1";
    expect(fs.statSync(transcript).size).toBeGreaterThan(200);
    const transaction = vi.spyOn(db, "transaction");
    try {
      expect(() =>
        captureTranscriptPrefix(db, {
          sessionId: SESSION,
          project: "/project",
          transcriptPath: transcript,
          kind: "stop",
          turnId: "turn-1",
          deadlineAt: Date.now() + 400,
        }),
      ).toThrow(HookOversizeCapture);
    } finally {
      transaction.mockRestore();
    }
    // No BEGIN IMMEDIATE: the pre-check refuses before the lock is taken.
    expect(transaction).not.toHaveBeenCalled();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM journal_streams").get() as { n: number }).n,
    ).toBe(0);
  });

  it("stops between journal chunks on the deadline and rolls the capture back", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    // Three copy chunks' worth (CAPTURE_CHUNK_BYTES = 4 MiB): a deadline that
    // is only consulted after the whole copy would still have written 9 MiB
    // under the write lock, which is the failure this bound exists to prevent.
    const filler = `{"type":"response_item","payload":{"type":"reasoning","text":"${"x".repeat(
      3 * 1024 * 1024,
    )}"}}\n`;
    fs.appendFileSync(transcript, filler.repeat(3));
    const deadlineAt = Date.now() + 5_000;
    let chunks = 0;
    expect(() =>
      captureTranscriptPrefix(db, {
        sessionId: SESSION,
        project: "/project",
        transcriptPath: transcript,
        kind: "stop",
        turnId: "turn-1",
        deadlineAt,
        afterJournalChunk: () => {
          chunks++;
          // Busy-wait past the deadline the way a large fsync-bound copy would.
          const until = deadlineAt + 50;
          while (Date.now() < until) { /* spin */ }
        },
      }),
    ).toThrow(HookDeadlineExceeded);
    expect(chunks).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM journal_streams").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n,
    ).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it("a skipped clear/compact epoch advance is replayed from the marker exactly once", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const before = db
      .prepare("SELECT context_epoch FROM session_memory_state WHERE session_id = ?")
      .get(SESSION) as { context_epoch: number };
    db.prepare(
      "UPDATE session_memory_state SET resident_fact_revisions_json = ? WHERE session_id = ?",
    ).run(JSON.stringify([["fact-1", 1, 1]]), SESSION);
    writeCaptureGapMarker({
      invocationId: "inv-compact-1",
      event: "SessionStart",
      source: "compact",
      sessionId: SESSION,
      cwd: "/project",
      transcriptPath: transcript,
      transcriptBytes: fs.statSync(transcript).size,
      turnId: null,
      ts: new Date().toISOString(),
    });

    expect(applyPendingEpochAdvance(db, SESSION)).toBe(1);
    const after = db
      .prepare(
        "SELECT context_epoch, resident_fact_revisions_json FROM session_memory_state WHERE session_id = ?",
      )
      .get(SESSION) as { context_epoch: number; resident_fact_revisions_json: string };
    expect(after.context_epoch).toBe(before.context_epoch + 1);
    expect(after.resident_fact_revisions_json).toBe("[]");
    expect(markerFiles()).toHaveLength(0);

    // Idempotent: a second run has no marker left and cannot advance again.
    expect(applyPendingEpochAdvance(db, SESSION)).toBe(0);
    expect(
      (db
        .prepare("SELECT context_epoch FROM session_memory_state WHERE session_id = ?")
        .get(SESSION) as { context_epoch: number }).context_epoch,
    ).toBe(before.context_epoch + 1);
    // The marker's invocationId is what makes the replay idempotent: the epoch
    // token derived from it refuses a repeat of the very same transition.
    expect(
      advanceContextEpoch(db, { sessionId: SESSION, source: "compact", turnId: "inv-compact-1" }),
    ).toBe(before.context_epoch + 1);
  });

  it("prunes only markers past the retention window", () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
    writeCaptureGapMarker({
      invocationId: "inv-old", event: "Stop", source: null, sessionId: SESSION,
      cwd: "/project", transcriptPath: transcript, transcriptBytes: 1, turnId: null, ts: old,
    });
    writeCaptureGapMarker({
      invocationId: "inv-new", event: "Stop", source: null, sessionId: SESSION,
      cwd: "/project", transcriptPath: transcript, transcriptBytes: 1, turnId: null,
      ts: new Date().toISOString(),
    });
    expect(pruneCaptureGapMarkers()).toBe(1);
    expect(listCaptureGapMarkers().map(({ marker }) => marker.invocationId)).toEqual(["inv-new"]);
  });
});

/**
 * Issue #166 — the work Mac skipped every capture with `db_wait_ms: 0`.
 *
 * The 0.7.24 budget was 2,000 ms of a 3 s host timeout, and the FIXED cost
 * before the first database call there is 1.45-1.9 s (node start, dist import,
 * the DB open with its per-open migration pass, the marker fsync). So the
 * budget was gone before the capture phase without a single lock wait: Stop
 * `deadline` with 28 ms left, SessionEnd `oversize` on 132,399 bytes — 6.6 ms of
 * ingest — because the 300 ms reserve made the usable window negative.
 */
describe("hook budget derivation (issue #166)", () => {
  it("derives the budget from the event's host timeout minus one exit margin", () => {
    // The margin covers what happens AFTER the budget — node's teardown measured
    // ~200 ms, and 150 ms left a 3 s hook exiting 84 ms before its kill.
    expect(HOOK_EXIT_MARGIN_MS).toBe(300);
    expect(hookHostTimeoutMs("Stop")).toBe(10_000);
    expect(hookBudgetMs("Stop")).toBe(9_700);
    expect(hookBudgetMs("SessionStart")).toBe(9_700);
    expect(hookBudgetMs("PostCompact")).toBe(9_700);
    expect(hookBudgetMs("PreCompact")).toBe(14_700);
    // SessionEnd and Interrupt are the two hooks the host caps at 3 s, so they
    // keep the small budget however generous the others become (#166 review).
    expect(hookHostTimeoutMs("SessionEnd")).toBe(3_000);
    expect(hookBudgetMs("SessionEnd")).toBe(2_700);
    expect(hookHostTimeoutMs("Interrupt")).toBe(3_000);
    expect(hookBudgetMs("Interrupt")).toBe(2_700);
    // The measured fixed cost must still leave a phase floor behind it.
    expect(hookBudgetMs("Stop") - 1_900).toBeGreaterThanOrEqual(HOOK_PHASE_FLOOR_MS);
    expect(hookBudgetMs("SessionEnd") - 1_900).toBeGreaterThanOrEqual(HOOK_PHASE_FLOOR_MS);
    // One lock wait may be generous now, but never eats the exit margin.
    expect(busyTimeoutForRemaining(9_700)).toBe(2_500);
    expect(busyTimeoutForRemaining(1_000)).toBe(700);
    expect(busyTimeoutForRemaining(250)).toBe(0);
    process.env.MEMEX_HOOK_BUDGET_MS = "1234";
    expect(hookBudgetMs("Stop")).toBe(1_234);
    delete process.env.MEMEX_HOOK_BUDGET_MS;
  });

  it("a delta whose ingest is ms of work is never oversize (#166)", () => {
    // The observed row, to scale: 132,399 bytes is 6.6 ms at 20,000 B/ms and
    // 267 ms of budget remained. Only the reserve made that "too large".
    expect(ingestFitsBudget(132_399, 267)).toEqual({ ok: true });
    expect(HOOK_INGEST_RESERVE_MS).toBe(100);

    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    const result = captureTranscriptPrefix(db, {
      sessionId: SESSION,
      project: "/project",
      transcriptPath: transcript,
      kind: "final",
      turnId: "turn-1",
      deadlineAt: Date.now() + 267,
    });
    expect(result).toBeTruthy();
  });

  it("calls an exhausted budget a deadline, not an oversize delta (#166)", () => {
    ensureSessionMemoryState(db, { sessionId: SESSION, project: "/project" });
    // Less left than the reserve: the budget is gone. Saying `oversize` blamed
    // the transcript for the clock and sent the reader after the wrong fix.
    const fit = ingestFitsBudget(132_399, 90);
    expect(fit.ok).toBe(false);
    expect(fit.ok === false && fit.reason).toBe("deadline");
    expect(() =>
      captureTranscriptPrefix(db, {
        sessionId: SESSION,
        project: "/project",
        transcriptPath: transcript,
        kind: "final",
        turnId: "turn-1",
        deadlineAt: Date.now() + 90,
      }),
    ).toThrow(HookDeadlineExceeded);
  });

  it("still refuses a delta that genuinely cannot be ingested in the budget", () => {
    const fit = ingestFitsBudget(200 * 1024 * 1024, 5_000);
    expect(fit.ok).toBe(false);
    expect(fit.ok === false && fit.reason).toBe("oversize");
  });
});

describe("inject hook observability (issue #162 R5)", () => {
  it("writes a paired start/done row for a prompt it drops", () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "inject-context.js")], {
      input: JSON.stringify({ prompt: "   ", cwd: "/project", session_id: SESSION }),
      encoding: "utf8",
      env: childEnv(),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    const rows = hookEventRows().filter((row) => row.event === "UserPromptSubmit");
    const start = rows.find((row) => row.phase === "start");
    const done = rows.find((row) => row.phase === "done");
    expect(start).toBeTruthy();
    expect(done).toBeTruthy();
    expect(done!.invocation_id).toBe(start!.invocation_id);
    expect(done!.outcome).toBe("empty-prompt");
    expect(typeof done!.duration_ms).toBe("number");
  });

  /**
   * #166 final review — an inject failure BEFORE stdout must not read as a
   * delivered injection. The done row names the stage it failed at.
   */
  it("records the failing stage when the cold path delivers no context (#166)", () => {
    // A database path that cannot be opened: computeInjectContext logs, returns
    // "" and nothing is emitted, so this prompt delivered nothing.
    const blocked = path.join(root, "blocked-db-dir");
    fs.mkdirSync(blocked, { recursive: true });
    const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "inject-context.js")], {
      input: JSON.stringify({
        prompt: "Configure the redis session store client", cwd: "/project", session_id: SESSION,
      }),
      encoding: "utf8",
      env: childEnv({ MEMEX_DB_PATH: blocked }),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    const done = hookEventRows().find(
      (row) => row.event === "UserPromptSubmit" && row.phase === "done")!;
    expect(done.outcome).toBe("error");
    expect(done.context_delivered).toBe(false);
    expect(["compute", "startup"]).toContain(done.stage);
  });
});

/** The in-process payload shape (the subprocess one is a JSON string). */
function payload2(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return JSON.parse(payload(event, extra)) as Record<string, unknown>;
}
