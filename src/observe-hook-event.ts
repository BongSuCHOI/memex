// CX-01 lifecycle event observation log (privacy-safe).
//
// Appends one line per hook event to <data root>/logs/hook-events.jsonl with
// ONLY: event name, ISO timestamp, session id, cwd, and an optional machine
// `detail` (an errno, a byte count — see `recordHookEvent`). Never logs the
// prompt, transcript contents, or extracted facts.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getMemexHome } from "./paths.js";

/** Outcomes a hook may report on its done row. Never a host-timeout claim. */
export type HookOutcome =
  | "ok"
  | "busy"
  | "oversize"
  | "deadline"
  | "error"
  | "empty-prompt"
  | "daemon"
  | "fallback"
  | "skipped";

export function newInvocationId(): string {
  try {
    return randomUUID();
  } catch {
    return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function dataRoot(): string {
  // Single-source resolution — see getMemexHome() for the precedence chain.
  return getMemexHome();
}

export function observationLogPath(): string {
  return path.join(dataRoot(), "logs", "hook-events.jsonl");
}

/**
 * Issue #26 (item 6) — `hook-events.jsonl` collected rows with
 * `event: "Unknown"` and empty session_id/cwd, because the CLI entry below
 * defaulted a missing `process.argv[2]` to the string "Unknown". `memex
 * doctor`'s `lifecycle-observed` then printed `Lifecycle Unknown: observed …`
 * beside seven real events whose own timestamps looked empty.
 *
 * An unlabeled call is not an observation: it says an unidentified hook ran at
 * some time, which no diagnosis can use. Such a call is refused (and the caller
 * is told) rather than written down.
 *
 * Returns whether a line was written.
 *
 * `info.detail` (issue #99) is for a MACHINE fact about the event that a later
 * diagnosis needs and cannot recover — an errno, a path length, a reason string
 * the code itself wrote. It is written only when it is a non-empty string, and it
 * must never carry user content; everything this log already refuses (prompts,
 * transcripts, facts) stays refused.
 */
export function recordHookEvent(
  event: string,
  info: {
    sessionId?: unknown;
    cwd?: unknown;
    detail?: unknown;
    /**
     * Issue #162 (R5). A hook that the host kills leaves no done row at all, so
     * the START row — written before any database access — is the only proof
     * the hook ran. `invocation_id` pairs the two rows and `pid` is what lets
     * doctor tell "killed by host" from "still running".
     */
    phase?: "start" | "done";
    invocationId?: unknown;
    pid?: unknown;
    outcome?: unknown;
    durationMs?: unknown;
    dbWaitMs?: unknown;
    /**
     * Issue #166 — process entry to just before the FIRST database call: node
     * start, dist import, the connection open with its migration pass. On the
     * machine that reported this it was 1.45-1.9 s, which is why a 2,000 ms
     * budget ran out with `db_wait_ms: 0`. A budget is unreadable without it.
     */
    startupMs?: unknown;
    /**
     * Issue #166 (final review) — WHERE an inject failure happened, because
     * `outcome: "error"` on a UserPromptSubmit row means three different things:
     * `receipt` (the context was delivered and only its recall receipt stayed
     * `prepared` — #44's documented fallback), `compute` (retrieval failed, so
     * nothing reached the user) and `startup` (the imports failed before any of
     * it). Doctor may not call the last two a delivered injection.
     */
    stage?: unknown;
    /** Whether this invocation actually wrote context to stdout. */
    contextDelivered?: unknown;
    error?: unknown;
  },
): boolean {
  const name = typeof event === "string" ? event.trim() : "";
  if (!name || name === "Unknown") return false;
  try {
    const detail = typeof info.detail === "string" ? info.detail.trim() : "";
    const num = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
    const errorText = typeof info.error === "string" ? info.error.trim().slice(0, 200) : "";
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        event: name,
        session_id: typeof info.sessionId === "string" ? info.sessionId : "",
        cwd: typeof info.cwd === "string" ? info.cwd : "",
        ...(detail ? { detail } : {}),
        ...(info.phase ? { phase: info.phase } : {}),
        ...(typeof info.invocationId === "string" && info.invocationId
          ? { invocation_id: info.invocationId }
          : {}),
        ...(num(info.pid) !== undefined ? { pid: num(info.pid) } : {}),
        ...(typeof info.outcome === "string" && info.outcome ? { outcome: info.outcome } : {}),
        ...(num(info.durationMs) !== undefined ? { duration_ms: num(info.durationMs) } : {}),
        ...(num(info.dbWaitMs) !== undefined ? { db_wait_ms: num(info.dbWaitMs) } : {}),
        ...(num(info.startupMs) !== undefined ? { startup_ms: num(info.startupMs) } : {}),
        ...(typeof info.stage === "string" && info.stage ? { stage: info.stage } : {}),
        ...(typeof info.contextDelivered === "boolean"
          ? { context_delivered: info.contextDelivered }
          : {}),
        ...(errorText ? { error: errorText } : {}),
      }) + "\n";
    const file = observationLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
    return true;
  } catch {
    // Observation must never break the hook pipeline.
    return false;
  }
}

/**
 * The pre-DB start row. Returns the invocation id to carry into the done row.
 */
export function recordHookStart(
  event: string,
  info: { sessionId?: unknown; cwd?: unknown; invocationId?: string; detail?: unknown },
): string {
  const invocationId = info.invocationId ?? newInvocationId();
  recordHookEvent(event, {
    ...info,
    phase: "start",
    invocationId,
    pid: process.pid,
  });
  return invocationId;
}

/** The completion row. Absent in the log = the hook never got here. */
export function recordHookDone(
  event: string,
  info: {
    sessionId?: unknown;
    cwd?: unknown;
    invocationId?: string;
    outcome: HookOutcome;
    durationMs?: number;
    dbWaitMs?: number;
    startupMs?: number;
    stage?: string;
    contextDelivered?: boolean;
    error?: unknown;
    detail?: unknown;
  },
): boolean {
  return recordHookEvent(event, { ...info, phase: "done", pid: process.pid });
}

export interface HookEventRow {
  ts: string;
  event: string;
  session_id?: string;
  cwd?: string;
  phase?: string;
  invocation_id?: string;
  pid?: number;
  outcome?: string;
  duration_ms?: number;
  db_wait_ms?: number;
  /** #166: entry -> first database call, the hook's fixed cost on this machine. */
  startup_ms?: number;
  /** #166: which stage an inject failure happened at — receipt/compute/startup. */
  stage?: string;
  /** #166: whether context actually reached stdout on an inject failure. */
  context_delivered?: boolean;
  error?: string;
}

/** Last `limit` parseable rows of hook-events.jsonl, oldest first. */
export function readHookEventTail(limit: number): HookEventRow[] {
  try {
    const file = observationLogPath();
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const out: HookEventRow[] = [];
    for (const line of lines.slice(Math.max(0, lines.length - limit))) {
      try {
        const row = JSON.parse(line) as HookEventRow;
        if (row && typeof row.ts === "string" && typeof row.event === "string") out.push(row);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function lastObserved(event: string): string | null {
  try {
    const file = observationLogPath();
    if (!fs.existsSync(file)) return null;
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.event === event && typeof rec.ts === "string") return rec.ts;
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Bundle-safe entry guard: inside the esbuild bundle (dist/mcp-server.js) every
// inlined module shares the bundle's import.meta.url, so comparing argv[1] with
// it alone fired this block whenever the MCP server started — that is how the
// "Unknown" rows got into hook-events.jsonl, and after #26 it would have exited
// the server with the usage error. Require the script itself to be argv[1].
if (
  process.argv[1] &&
  path.basename(process.argv[1]) === "observe-hook-event.js" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Manual invocation:
  //   node dist/observe-hook-event.js <event> [session_id] [cwd]
  // The event name is REQUIRED (issue #26 item 6). It used to default to
  // "Unknown", which is how unlabeled rows entered the log at all.
  const [event, sessionId, cwd] = process.argv.slice(2);
  if (!recordHookEvent(event ?? "", { sessionId, cwd })) {
    process.stderr.write(
      "usage: observe-hook-event.js <hook_event_name> [session_id] [cwd]\n" +
        "refusing to log an unlabeled hook invocation\n",
    );
    process.exit(2);
  }
}
