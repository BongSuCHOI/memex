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

    // #171: these Stop markers carry no transcript and no bytes, so the line is
    // an ok line and may not call them skipped captures.
    const before = captureGapCheck();
    expect(before.detail).toContain("600 marker(s), nothing at stake");
    expect(before.detail).not.toContain("skipped");
    expect(before.detail).toContain(`oldest ${old}`);

    expect(pruneCaptureGapMarkers()).toBe(40);

    const after = captureGapCheck();
    expect(after.detail).toContain("560 marker(s), nothing at stake");
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
    // Something IS at stake here, so the skipped-capture wording stays (#171).
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
    // #171: an ok verdict says how many markers there are, not how many captures
    // were skipped — none were.
    expect(check.detail).toContain("501 marker(s), nothing at stake");
    expect(check.detail).not.toContain("skipped");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("no capture at stake");
    expect(check.detail).not.toMatch(/pending #163/);
  }, 30_000);

  /**
   * Issue #168 — `codex exec --ephemeral` sessions have no transcript file, so
   * their Stop/SessionEnd markers carry no path and no byte count. Reporting
   * them as skipped captures printed "0 uncaptured bytes" and claimed a pending
   * continuity tail for thirty days. There was never anything to capture.
   */
  it("a capture marker with no transcript has nothing at stake (#168)", () => {
    const ts = "2026-09-18T01:54:17.000Z";
    for (let i = 0; i < 11; i++) {
      writeCaptureGapMarker({
        invocationId: `inv-ephemeral-${i}`,
        event: i % 2 === 0 ? "Stop" : "SessionEnd",
        source: null,
        sessionId: `session-codex-exec-${i}`,
        cwd: "/project",
        transcriptPath: null,
        transcriptBytes: null,
        turnId: null,
        ts,
      });
    }
    const check = captureGapCheck();
    expect(check.status).toBe("ok");
    expect(check.detail).not.toMatch(/pending #163/);
    expect(check.detail).not.toMatch(/uncaptured bytes/);
    // Both capture events read the same way; which one the page names first is
    // a directory-order detail no verdict may depend on.
    expect(check.detail).toMatch(
      new RegExp(`no transcript at (Stop|SessionEnd) ${ts} \\(ephemeral session; nothing to capture\\)`),
    );
  });

  it("an explicit 0-byte transcript is nothing at stake either (#168)", () => {
    writeCaptureGapMarker({
      invocationId: "inv-zero-bytes", event: "SessionEnd", source: null,
      sessionId: "session-zero", cwd: "/project", transcriptPath: null,
      transcriptBytes: 0, turnId: null, ts: "2026-09-18T01:55:00.000Z",
    });
    expect(captureGapCheck().status).toBe("ok");
  });

  it("a marker that DID have bytes at stake still warns (#168 boundary)", () => {
    writeCaptureGapMarker({
      invocationId: "inv-real-skip", event: "Stop", source: null,
      sessionId: "session-real", cwd: "/project", transcriptPath: "/tmp/rollout.jsonl",
      transcriptBytes: 4_096, turnId: "turn-1", ts: "2026-09-18T01:56:00.000Z",
    });
    // A transcript path with no byte count is still a capture that did not run.
    writeCaptureGapMarker({
      invocationId: "inv-unknown-bytes", event: "Stop", source: null,
      sessionId: "session-real-2", cwd: "/project", transcriptPath: "/tmp/rollout.jsonl",
      transcriptBytes: null, turnId: "turn-2", ts: "2026-09-18T01:57:00.000Z",
    });
    const check = captureGapCheck();
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(
      `capture skipped at Stop 2026-09-18T01:56:00.000Z (4096 uncaptured bytes); ${CAPTURE_GAP_LOSS_STATEMENT}`,
    );
  });
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

  /**
   * #168 — `no-transcript` is a completed hook that had nothing to capture, so it
   * belongs to the healthy outcomes. Counting it as a skipped capture produced
   * `11 skipped (error 11) last error: capture hook requires transcript_path`.
   */
  it("does not count a no-transcript capture event as skipped (#168)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      ...paired("inv-nt", "Stop", { outcome: "no-transcript" }),
      ...paired("inv-nt2", "SessionEnd", {
        outcome: "no-transcript", error: "capture hook requires transcript_path",
      }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("ok");
    expect(check.detail).not.toContain("skipped");
    expect(check.detail).not.toContain("requires transcript_path");
  });

  /**
   * Issue #171 — the rows 0.7.24/0.7.25 already wrote for this situation.
   *
   * 0.7.26 records `no-transcript` on NEW rows only, so a root that had eleven
   * ephemeral runs kept `WARN hook-latency: 11 skipped (error 11) last error:
   * capture hook requires transcript_path` until the old rows fell out of the
   * 200-row window. A pre-0.7.26 row is recognised by its error text plus the
   * ABSENCE of a stage: nothing but that path ever wrote that message, and the
   * inject lane's stages are the only ones 0.7.25 could write.
   */
  it("does not count a pre-0.7.26 no-transcript error row as skipped (#171)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      ...paired("inv-legacy-1", "Stop", {
        outcome: "error", error: "capture hook requires transcript_path",
      }),
      ...paired("inv-legacy-2", "SessionEnd", {
        outcome: "error", error: "capture hook requires transcript_path",
      }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("ok");
    expect(check.detail).not.toContain("skipped");
    expect(check.detail).not.toContain("requires transcript_path");
    // #171 (second review): REPORTED, not hidden — 0.7.24/0.7.25 wrote a
    // strict-mode failure with the same outcome, message and missing stage, so
    // these rows cannot be proven benign and must stay visible.
    expect(check.detail).toContain(
      "2 legacy no-transcript row(s) (pre-0.7.26; strict-mode failures indistinguishable)",
    );
  });

  it("the legacy bucket alone is not a warn, and does not borrow another verdict", () => {
    writeRows([
      ...paired("inv-legacy", "Stop", {
        outcome: "error", error: "capture hook requires transcript_path",
      }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("1 legacy no-transcript row(s)");
    expect(check.detail).not.toContain("skipped");
    // The bucket may not supply a "last error" either: that line names a failure
    // this check is asserting, and it is asserting none.
    expect(check.detail).not.toContain("last error");
  });

  it("the legacy bucket sits beside a real skip without merging into it", () => {
    writeRows([
      ...paired("inv-legacy", "Stop", {
        outcome: "error", error: "capture hook requires transcript_path",
      }),
      ...paired("inv-busy", "Stop", { outcome: "busy" }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 skipped (busy 1)");
    expect(check.detail).toContain("1 legacy no-transcript row(s)");
  });

  /**
   * The boundary, and a deliberate departure from #171's wording. The issue
   * suggested excluding `stage: "no-transcript"` too, but that stage is written by
   * exactly ONE path: 0.7.26 STRICT mode, which #168's post-fix review made keep
   * its evidence precisely so `hook-latency` reports it. A non-strict 0.7.26 run
   * records `outcome: "no-transcript"`, never `error`. So the stage is what tells a
   * loud opt-in failure from an old silent row, and excluding it would undo #168.
   */
  it("still counts a 0.7.26 STRICT no-transcript failure as skipped (#168/#171)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      ...paired("inv-strict", "Stop", {
        outcome: "error",
        stage: "no-transcript",
        error: "capture hook requires transcript_path",
      }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 skipped (error 1)");
    expect(check.detail).toContain("requires transcript_path");
  });

  it("still counts an unrelated capture error as skipped (#171 boundary)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      ...paired("inv-real", "Stop", {
        outcome: "error", error: "transcript prefix does not match the journal",
      }),
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-17T08:00:05.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 skipped (error 1)");
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

  /**
   * #166 third review — a UserPromptSubmit `error` row is the documented recall
   * receipt fallback: the context WAS delivered and the receipt stayed `prepared`.
   * Counting it as a skipped capture told the reader a capture was lost.
   */
  it("calls an inject receipt failure what it is, not a skipped capture (#166)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      { ts: "2026-09-18T02:00:00.000Z", event: "UserPromptSubmit", phase: "start", invocation_id: "inv-r", pid: 31 },
      {
        ts: "2026-09-18T02:00:01.000Z", event: "UserPromptSubmit", phase: "done", invocation_id: "inv-r",
        pid: 31, outcome: "error", duration_ms: 900, db_wait_ms: 0, startup_ms: 200,
        // #166 final review: the stage is what makes this a DELIVERED injection.
        stage: "receipt", context_delivered: true, error: "prepared receipt not found",
      },
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-18T02:01:00.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 receipt failure (context delivered)");
    expect(check.detail).not.toContain("skipped");
    expect(check.detail).toContain("prepared receipt not found");
  });

  /**
   * #166 final review — `outcome: "error"` on a UserPromptSubmit row means three
   * different things. scripts/inject-context.js records it for a receipt that
   * stayed `prepared` AFTER the context was delivered (#44's fallback), for a
   * daemon/cold compute failure where nothing reached the user, and for an import
   * exception before any of it. Calling all three "context delivered" told the
   * reader an injection had landed when none had, so the row carries the stage.
   */
  it("separates a receipt failure from an injection that delivered nothing (#166)", () => {
    writeRows([
      ...paired("inv-a", "Stop"),
      {
        ts: "2026-09-18T03:00:01.000Z", event: "UserPromptSubmit", phase: "done", invocation_id: "inv-r",
        pid: 41, outcome: "error", duration_ms: 900, db_wait_ms: 0, startup_ms: 200,
        stage: "receipt", context_delivered: true, error: "prepared receipt not found",
      },
      {
        ts: "2026-09-18T03:00:02.000Z", event: "UserPromptSubmit", phase: "done", invocation_id: "inv-c",
        pid: 42, outcome: "error", duration_ms: 800, db_wait_ms: 0, startup_ms: 200,
        stage: "compute", context_delivered: false, error: "SQLITE_CANTOPEN: unable to open database file",
      },
      {
        ts: "2026-09-18T03:00:03.000Z", event: "UserPromptSubmit", phase: "done", invocation_id: "inv-s",
        pid: 43, outcome: "error", duration_ms: 300, db_wait_ms: 0,
        stage: "startup", context_delivered: false, error: "Cannot find package 'better-sqlite3'",
      },
      // A pre-0.7.25 row has no stage: it may not be claimed either way.
      {
        ts: "2026-09-18T03:00:04.000Z", event: "UserPromptSubmit", phase: "done", invocation_id: "inv-o",
        pid: 44, outcome: "error", duration_ms: 400, db_wait_ms: 0, error: "legacy row",
      },
    ]);
    const check = hookLatencyCheck(Date.parse("2026-09-18T03:01:00.000Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 receipt failure (context delivered)");
    expect(check.detail).toContain("2 injection failed (no context delivered)");
    expect(check.detail).toContain("1 inject error (stage unknown)");
    // None of them is a skipped capture, and the last error is still quoted.
    expect(check.detail).not.toContain("skipped");
    expect(check.detail).toContain("legacy row");
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

  /**
   * #166 third review — the killed-hook correlation window ran to
   * `budget + 10 s grace`. The grace exists to decide "no done row means killed",
   * not to widen who could have been holding the lock: a transaction that started
   * seconds AFTER the host had already killed the hook was named as its holder.
   */
  it("correlates a killed hook only inside the host's own timeout (#166 third review)", () => {
    writeRows([
      { ts: "2026-09-17T08:00:00.000Z", event: "Stop", phase: "start", invocation_id: "inv-k", pid: 777 },
      ...paired("inv-a", "Stop"),
    ]);
    writeWorkerTransactions([
      // Held [08:00:12.000, 08:00:14.000]: the host killed this hook at 08:00:10,
      // so this transaction cannot be what it waited on.
      { ts: "2026-09-17T08:00:14.000Z", pid: 45, label: "scheduleCapsuleBacklog#2", wait_ms: 5, held_ms: 2_000 },
    ]);
    const after = hookLatencyCheck(Date.parse("2026-09-17T08:00:30.000Z")).detail;
    expect(after).toContain("killed by host");
    expect(after).not.toContain("scheduleCapsuleBacklog#2");
    expect(after).toContain("no worker transaction overlapped this hook");

    // A transaction inside the host window is still named.
    writeWorkerTransactions([
      { ts: "2026-09-17T08:00:09.000Z", pid: 46, label: "appendSessionEvidence", wait_ms: 5, held_ms: 3_000 },
    ]);
    const inside = hookLatencyCheck(Date.parse("2026-09-17T08:00:30.000Z")).detail;
    expect(inside).toContain("appendSessionEvidence held the write lock for 3000 ms");
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
