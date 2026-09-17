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
});
