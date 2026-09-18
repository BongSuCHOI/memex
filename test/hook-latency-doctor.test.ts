import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CAPTURE_GAP_LOSS_STATEMENT,
  captureGapCheck,
  hookLatencyCheck,
} from "../src/lifecycle.js";
import {
  pruneCaptureGapMarkers,
  writeCaptureGapMarker,
} from "../src/capture-gap-markers.js";

/**
 * Issue #162 (R5) — doctor has to be able to say WHICH hook exceeded its budget
 * and WHO held the lock. Before 0.7.24 hook-events rows carried only
 * ts/event/session/cwd, and a killed hook left no row at all.
 */

let root: string;
let home: string;

function writeRows(rows: Array<Record<string, unknown>>): void {
  const file = path.join(home, "logs", "hook-events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function writeWorkerTransactions(rows: Array<Record<string, unknown>>): void {
  const file = path.join(home, "logs", "worker-transactions.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-hook-doctor-"));
  home = path.join(root, "memex-home");
  fs.mkdirSync(home, { recursive: true });
  process.env.MEMEX_HOME = home;
  delete process.env.MEMEX_HOOK_BUDGET_MS;
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("doctor capture-gap", () => {
  it("is ok with no markers", () => {
    const check = captureGapCheck();
    expect(check.name).toBe("capture-gap");
    expect(check.status).toBe("ok");
  });

  it("states the corrected loss wording per marker", () => {
    writeCaptureGapMarker({
      invocationId: "inv-1",
      event: "SessionEnd",
      source: null,
      sessionId: "session-doctor-1",
      cwd: "/project",
      transcriptPath: "/tmp/rollout.jsonl",
      transcriptBytes: 4_096,
      turnId: "turn-9",
      ts: "2026-09-17T08:04:00.000Z",
    });
    const check = captureGapCheck();
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(
      "capture skipped at SessionEnd 2026-09-17T08:04:00.000Z (4096 uncaptured bytes); " +
        CAPTURE_GAP_LOSS_STATEMENT,
    );
    // Not the withdrawn "content is never lost" claim (Revision 4).
    expect(check.detail).not.toMatch(/never lost/i);
  });

  it("says what is actually at stake for each class of marker (#162 review 10)", () => {
    const marker = (
      invocationId: string,
      event: string,
      source: string | null,
      ts: string,
    ) =>
      writeCaptureGapMarker({
        invocationId, event, source, sessionId: "session-doctor-classes",
        cwd: "/project", transcriptPath: "/tmp/rollout.jsonl", transcriptBytes: 2_048,
        turnId: null, ts,
      });
    marker("inv-capture", "Stop", null, "2026-09-17T08:00:00.000Z");
    marker("inv-epoch", "SessionStart", "compact", "2026-09-17T08:01:00.000Z");
    marker("inv-telemetry", "PostCompact", "auto", "2026-09-17T08:02:00.000Z");

    const detail = captureGapCheck().detail;
    // A capture event: the tail statement, unchanged.
    expect(detail).toContain(
      `capture skipped at Stop 2026-09-17T08:00:00.000Z (2048 uncaptured bytes); ${CAPTURE_GAP_LOSS_STATEMENT}`,
    );
    // A clear/compact SessionStart: not a capture — the epoch repair.
    expect(detail).toContain(
      "epoch advance skipped at SessionStart(compact) 2026-09-17T08:01:00.000Z; repaired by the next injection",
    );
    // PostCompact is telemetry only: nothing durable was at stake.
    expect(detail).toContain(
      "hook did not finish at PostCompact 2026-09-17T08:02:00.000Z (no capture at stake)",
    );
    // The telemetry line must not borrow either of the other two claims.
    expect(detail).not.toMatch(/capture skipped at PostCompact/);
    expect(detail).not.toMatch(/PostCompact[^|]*pending #163/);
  });

  it("is ok when only markers with nothing at stake are left (#162 review 10)", () => {
    writeCaptureGapMarker({
      invocationId: "inv-only-telemetry", event: "PostCompact", source: "manual",
      sessionId: "session-doctor-neutral", cwd: "/project", transcriptPath: null,
      transcriptBytes: null, turnId: null, ts: "2026-09-17T08:02:00.000Z",
    });
    const check = captureGapCheck();
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("no capture at stake");
  });

  it("counts and prunes EVERY marker, not the first 500 it happens to read (#162 review 10)", () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
    const fresh = new Date().toISOString();
    // 560 fresh + 40 expired. Which 500 a directory listing hands back first is
    // not something doctor may depend on.
    for (let i = 0; i < 560; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-fresh-${i}`, event: "Stop", source: null,
        sessionId: "session-doctor-scan", cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts: fresh,
      });
    }
    for (let i = 0; i < 40; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-old-${i}`, event: "Stop", source: null,
        sessionId: "session-doctor-scan", cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts: old,
      });
    }

    const before = captureGapCheck();
    expect(before.detail).toContain("600 skipped capture(s)");
    expect(before.detail).toContain(`oldest ${old}`);

    expect(pruneCaptureGapMarkers()).toBe(40);

    const after = captureGapCheck();
    expect(after.detail).toContain("560 skipped capture(s)");
    expect(after.detail).toContain(`oldest ${fresh}`);
  }, 30_000);

  it("classifies EVERY marker, not the first 500 the page returned (#165 post-release)", () => {
    // 500 telemetry-only markers older than one unprocessed Stop. The scan
    // returns the oldest 500, so before the fix the warn/ok decision was made
    // from a page that could not contain the Stop at all: `total: 501` with
    // `status: ok`, and a detail that never named the marker that mattered.
    const base = Date.parse("2026-09-17T08:00:00.000Z");
    for (let i = 0; i < 500; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-telemetry-${i}`, event: "PostCompact", source: "auto",
        sessionId: "session-doctor-page", cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts: new Date(base + i).toISOString(),
      });
    }
    const stopTs = new Date(base + 10 * 60 * 1_000).toISOString();
    writeCaptureGapMarker({
      invocationId: "inv-capture-behind-the-page", event: "Stop", source: null,
      sessionId: "session-doctor-page", cwd: "/project", transcriptPath: "/tmp/rollout.jsonl",
      transcriptBytes: 8_192, turnId: "turn-1", ts: stopTs,
    });

    const check = captureGapCheck();
    expect(check.detail).toContain("501 skipped capture(s)");
    expect(check.status).toBe("warn");
    // The at-stake marker is named even though it is off the returned page.
    expect(check.detail).toContain(
      `capture skipped at Stop ${stopTs} (8192 uncaptured bytes); ${CAPTURE_GAP_LOSS_STATEMENT}`,
    );
  }, 30_000);

  it("stays ok when all 501 markers have nothing at stake (#165 post-release)", () => {
    const base = Date.parse("2026-09-17T08:00:00.000Z");
    for (let i = 0; i < 501; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-telemetry-${i}`, event: "PostCompact", source: "auto",
        sessionId: "session-doctor-page-ok", cwd: "/project", transcriptPath: null,
        transcriptBytes: null, turnId: null, ts: new Date(base + i).toISOString(),
      });
    }
    const check = captureGapCheck();
    expect(check.detail).toContain("501 skipped capture(s)");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("no capture at stake");
    expect(check.detail).not.toMatch(/pending #163/);
  }, 30_000);
});

describe("doctor hook-latency", () => {
  const paired = (invocation: string, event: string, extra: Record<string, unknown> = {}) => [
    { ts: "2026-09-17T08:00:00.000Z", event, phase: "start", invocation_id: invocation, pid: 111 },
    {
      ts: "2026-09-17T08:00:01.000Z", event, phase: "done", invocation_id: invocation, pid: 111,
      outcome: "ok", duration_ms: 420, db_wait_ms: 12, ...extra,
    },
  ];

  it("is ok when every start has a done row inside budget", () => {
    writeRows([...paired("inv-a", "Stop"), ...paired("inv-b", "UserPromptSubmit")]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.name).toBe("hook-latency");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("2 hook run(s) completed");
  });

  it("warns when a hook waited on the database", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      ...paired("inv-c", "PreCompact", { db_wait_ms: 5_200, outcome: "busy" }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("hooks waited on the database");
    expect(check.detail).toContain("PreCompact");
    expect(check.detail).toContain("5200 ms");
  });

  it("names a start row with no done as killed by host", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-k", pid: 777 },
      ...paired("inv-a", "Stop"),
    ]);
    // budget (2,000 ms) + 10 s grace has passed and pid 777 wrote nothing later.
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:20.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("killed by host");
    expect(check.detail).toContain("Stop");
  });

  it("never claims a host timeout for UserPromptSubmit", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "UserPromptSubmit", phase: "start", invocation_id: "inv-u", pid: 888 },
      ...paired("inv-a", "Stop"),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T09:00:00.000Z"));
    expect(check.status).toBe("ok");
    expect(check.detail).not.toContain("killed by host");
  });

  it("does not treat a start as killed when the same pid wrote a later row", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-k", pid: 111 },
      ...paired("inv-a", "Stop"),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:20.000Z"));
    expect(check.status).toBe("ok");
  });

  it("names the lock holder only from held_ms, and tolerates a missing worker log", () => {
    // The offending hook ran 08:00:00.000 -> 08:00:01.000 (duration_ms 1000).
    const waited = [
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-w", pid: 111 },
      {
        ts: "2026-09-17T08:00:01.000Z", event: "Stop", phase: "done", invocation_id: "inv-w",
        pid: 111, outcome: "busy", duration_ms: 1_000, db_wait_ms: 5_200,
      },
    ];
    writeRows(waited);
    expect(hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z")).detail).not.toContain(
      "held the write lock",
    );
    writeWorkerTransactions([
      // Overlaps the hook: 08:00:00.200 + 940 ms.
      { ts: "2026-09-17T08:00:00.200Z", pid: 43, label: "readCapsulePage", wait_ms: 10, held_ms: 940 },
      // A blocked worker is a victim, not a holder, whenever it ran.
      { ts: "2026-09-17T08:00:00.300Z", pid: 42, label: "appendSessionEvidence", wait_ms: 4_800, held_ms: 90 },
    ]);
    const detail = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z")).detail;
    expect(detail).toContain("worker transaction readCapsulePage held the write lock for 940 ms");
    expect(detail).not.toContain("4800");
    expect(detail).not.toContain("appendSessionEvidence");
  });

  it("does not name a worker transaction that never overlapped the hook (#162 review 10)", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-w", pid: 111 },
      {
        ts: "2026-09-17T08:00:01.000Z", event: "Stop", phase: "done", invocation_id: "inv-w",
        pid: 111, outcome: "busy", duration_ms: 1_000, db_wait_ms: 5_200,
      },
    ]);
    writeWorkerTransactions([
      // An hour earlier and long finished: it cannot be what this hook waited on.
      { ts: "2026-09-17T07:00:00.000Z", pid: 43, label: "applyWorkCapsulePatch", wait_ms: 10, held_ms: 9_000 },
    ]);
    const detail = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z")).detail;
    expect(detail).toContain("hooks waited on the database");
    expect(detail).not.toContain("applyWorkCapsulePatch");
    expect(detail).not.toContain("held the write lock");
    expect(detail).toContain("no worker transaction overlapped this hook");
  });

  it("correlates the holder to a killed hook's own window (#162 review 10)", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-k", pid: 777 },
      ...paired("inv-a", "Stop"),
    ]);
    writeWorkerTransactions([
      { ts: "2026-09-17T05:00:00.000Z", pid: 43, label: "scheduleCapsuleBacklog#1", wait_ms: 5, held_ms: 8_000 },
      { ts: "2026-09-17T08:00:00.100Z", pid: 44, label: "appendSessionEvidence", wait_ms: 5, held_ms: 2_500 },
    ]);
    const detail = hookLatencyCheck(Date.parse("2026-09-17T08:00:20.000Z")).detail;
    expect(detail).toContain("killed by host");
    expect(detail).toContain("appendSessionEvidence held the write lock for 2500 ms");
    expect(detail).not.toContain("scheduleCapsuleBacklog#1");
  });

  /**
   * Issue #166 — the work Mac skipped 3 of 3 captures (busy, deadline, oversize)
   * and `hook-latency` said `ok: 4 hook run(s) completed, max 8755 ms`. Every
   * skipped capture HAS a done row; reading only duration and lock waits made the
   * one thing the user needed to know invisible.
   */
  it("warns when completed runs report skipped captures (#166)", () => {
    writeRows([
      { ts: "2026-09-18T01:57:00.000Z", event: "SessionStart", phase: "start", invocation_id: "inv-1", pid: 11 },
      {
        ts: "2026-09-18T01:57:01.000Z", event: "SessionStart", phase: "done", invocation_id: "inv-1",
        pid: 11, outcome: "busy", duration_ms: 1_045, db_wait_ms: 930, startup_ms: 110,
        error: "database is locked",
      },
      { ts: "2026-09-18T01:57:10.000Z", event: "Stop", phase: "start", invocation_id: "inv-2", pid: 12 },
      {
        ts: "2026-09-18T01:57:11.900Z", event: "Stop", phase: "done", invocation_id: "inv-2",
        pid: 12, outcome: "deadline", duration_ms: 1_972, db_wait_ms: 0, startup_ms: 1_700,
        error: "hook budget exhausted before the next phase (28 ms left)",
      },
      { ts: "2026-09-18T01:57:20.000Z", event: "SessionEnd", phase: "start", invocation_id: "inv-3", pid: 13 },
      {
        ts: "2026-09-18T01:57:21.700Z", event: "SessionEnd", phase: "done", invocation_id: "inv-3",
        pid: 13, outcome: "oversize", duration_ms: 1_733, db_wait_ms: 0, startup_ms: 1_450,
        error: "132399 pending bytes exceed the remaining 267 ms hook budget",
      },
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-18T01:58:00.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("3 skipped (busy 1, deadline 1, oversize 1)");
    // The last error text, so the reader does not have to open the log.
    expect(check.detail).toContain("132399 pending bytes");
  });

  it("keeps ok for outcomes that are not skipped captures (#166)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      { ts: "2026-09-18T01:57:00.000Z", event: "UserPromptSubmit", phase: "start", invocation_id: "inv-d", pid: 21 },
      {
        ts: "2026-09-18T01:57:08.800Z", event: "UserPromptSubmit", phase: "done", invocation_id: "inv-d",
        pid: 21, outcome: "daemon", duration_ms: 8_755, db_wait_ms: 0, startup_ms: 240,
      },
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-18T01:58:00.000Z"));
    expect(check.status).toBe("ok");
    expect(check.detail).not.toContain("skipped");
    // Issue #166: the fixed cost before the first database call is reported, so
    // "the budget was gone before the capture" is measurable per machine.
    expect(check.detail).toMatch(/max startup \d+ ms/);
  });

  it("names the skipped captures beside a database wait it already warned about (#166)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      ...paired("inv-c", "PreCompact", { db_wait_ms: 5_200, outcome: "busy" }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("warn");
    // The existing rule keeps its verdict; the skip is added, not substituted.
    expect(check.detail).toContain("hooks waited on the database");
    expect(check.detail).toContain("1 skipped (busy 1)");
  });

  /**
   * Post-release P2 (#165) — the worker-transactions row is written when the
   * transaction ENDS, so its `ts` is the end, and the held interval is
   * `[ts - held_ms, ts]`. Reading `ts` as the start made doctor wrong in both
   * directions: the holder that was still holding when the hook gave up sits
   * beyond `toMs` and was skipped, while a transaction that had already
   * finished before the hook began looked like it started right then.
   */
  it("reads the worker row's ts as the END of the transaction (#165 post-release)", () => {
    // The offending hook ran 08:00:00.000 -> 08:00:01.000 (duration_ms 1000).
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-w", pid: 111 },
      {
        ts: "2026-09-17T08:00:01.000Z", event: "Stop", phase: "done", invocation_id: "inv-w",
        pid: 111, outcome: "busy", duration_ms: 1_000, db_wait_ms: 5_200,
      },
    ]);
    writeWorkerTransactions([
      // Ended 100 ms after the hook's window began, so it held [07:59:58.100,
      // 08:00:00.100] — an overlap either way of reading `ts`.
      { ts: "2026-09-17T08:00:00.100Z", pid: 43, label: "appendSessionEvidence", wait_ms: 5, held_ms: 2_000 },
      // The real holder: [07:59:58.000, 08:00:03.000] covers the whole hook and
      // ends 2 s after it. Read as a START this row lands after the window and
      // was skipped, leaving the lighter row above named instead.
      { ts: "2026-09-17T08:00:03.000Z", pid: 44, label: "settleTurn", wait_ms: 5, held_ms: 5_000 },
    ]);
    const detail = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z")).detail;
    expect(detail).toContain("hooks waited on the database");
    expect(detail).toContain("worker transaction settleTurn held the write lock for 5000 ms");
    expect(detail).not.toContain("no worker transaction overlapped this hook");
  });

  it("does not name a worker transaction that had already ended (#165 post-release)", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-w", pid: 111 },
      {
        ts: "2026-09-17T08:00:01.000Z", event: "Stop", phase: "done", invocation_id: "inv-w",
        pid: 111, outcome: "busy", duration_ms: 1_000, db_wait_ms: 5_200,
      },
    ]);
    writeWorkerTransactions([
      // Held [07:59:57.000, 07:59:59.000]: over and done 1 s before the hook
      // began, which is outside the ±250 ms skew margin. Read as a START it
      // looked like it ran straight through the hook.
      { ts: "2026-09-17T07:59:59.000Z", pid: 43, label: "applyWorkCapsulePatch", wait_ms: 5, held_ms: 2_000 },
    ]);
    const detail = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z")).detail;
    expect(detail).toContain("hooks waited on the database");
    expect(detail).not.toContain("applyWorkCapsulePatch");
    expect(detail).toContain("no worker transaction overlapped this hook");
  });

  it("keeps the ±250 ms skew margin around the hook's window (#165 post-release)", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-w", pid: 111 },
      {
        ts: "2026-09-17T08:00:01.000Z", event: "Stop", phase: "done", invocation_id: "inv-w",
        pid: 111, outcome: "busy", duration_ms: 1_000, db_wait_ms: 5_200,
      },
    ]);
    writeWorkerTransactions([
      // Ended 100 ms BEFORE the window began: two processes, two clocks and a
      // log written after the fact, so this is still the holder to name.
      { ts: "2026-09-17T07:59:59.900Z", pid: 43, label: "appendSessionEvidence", wait_ms: 5, held_ms: 2_000 },
    ]);
    const detail = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z")).detail;
    expect(detail).toContain("worker transaction appendSessionEvidence held the write lock for 2000 ms");
  });
});
