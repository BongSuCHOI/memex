// CX-01 lifecycle event observation log (privacy-safe).
//
// Appends one line per hook event to <data root>/logs/hook-events.jsonl with
// ONLY: event name, ISO timestamp, session id, and cwd. Never logs the prompt,
// transcript contents, or extracted facts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMemexHome } from "./paths.js";

export function dataRoot(): string {
  // Single-source resolution — see getMemexHome() for the precedence chain.
  return getMemexHome();
}

export function observationLogPath(): string {
  return path.join(dataRoot(), "logs", "hook-events.jsonl");
}

export function recordHookEvent(
  event: string,
  info: { sessionId?: unknown; cwd?: unknown },
): void {
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        session_id: typeof info.sessionId === "string" ? info.sessionId : "",
        cwd: typeof info.cwd === "string" ? info.cwd : "",
      }) + "\n";
    const file = observationLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch {
    // Observation must never break the hook pipeline.
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

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Manual invocation: node dist/observe-hook-event.js <event>
  recordHookEvent(process.argv[2] || "Unknown", {});
}
