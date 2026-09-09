// CX-01 lifecycle event observation log (privacy-safe).
//
// Appends one line per hook event to <data root>/logs/hook-events.jsonl with
// ONLY: event name, ISO timestamp, session id, and cwd. Never logs the prompt,
// transcript contents, or extracted facts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMemexHome } from "./paths.js";
export function dataRoot() {
    // Single-source resolution — see getMemexHome() for the precedence chain.
    return getMemexHome();
}
export function observationLogPath() {
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
 */
export function recordHookEvent(event, info) {
    const name = typeof event === "string" ? event.trim() : "";
    if (!name || name === "Unknown")
        return false;
    try {
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            event: name,
            session_id: typeof info.sessionId === "string" ? info.sessionId : "",
            cwd: typeof info.cwd === "string" ? info.cwd : "",
        }) + "\n";
        const file = observationLogPath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line);
        return true;
    }
    catch {
        // Observation must never break the hook pipeline.
        return false;
    }
}
export function lastObserved(event) {
    try {
        const file = observationLogPath();
        if (!fs.existsSync(file))
            return null;
        const lines = fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const rec = JSON.parse(lines[i]);
                if (rec.event === event && typeof rec.ts === "string")
                    return rec.ts;
            }
            catch {
                /* skip malformed */
            }
        }
    }
    catch {
        /* ignore */
    }
    return null;
}
// Bundle-safe entry guard: inside the esbuild bundle (dist/mcp-server.js) every
// inlined module shares the bundle's import.meta.url, so comparing argv[1] with
// it alone fired this block whenever the MCP server started — that is how the
// "Unknown" rows got into hook-events.jsonl, and after #26 it would have exited
// the server with the usage error. Require the script itself to be argv[1].
if (process.argv[1] &&
    path.basename(process.argv[1]) === "observe-hook-event.js" &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // Manual invocation:
    //   node dist/observe-hook-event.js <event> [session_id] [cwd]
    // The event name is REQUIRED (issue #26 item 6). It used to default to
    // "Unknown", which is how unlabeled rows entered the log at all.
    const [event, sessionId, cwd] = process.argv.slice(2);
    if (!recordHookEvent(event ?? "", { sessionId, cwd })) {
        process.stderr.write("usage: observe-hook-event.js <hook_event_name> [session_id] [cwd]\n" +
            "refusing to log an unlabeled hook invocation\n");
        process.exit(2);
    }
}
