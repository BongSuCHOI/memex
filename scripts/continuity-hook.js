#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));

// Issue #162 — the hook budget starts HERE, at process entry, not at the first
// database call. Everything before the DB (stdin read, dist import) is time the
// host's 3 s timer is already spending, and ignoring it is exactly how a 5 s
// busy_timeout turned into "Hook failed — hook timed out after 3s".
const STARTED_AT = Date.now();

function readStdin(timeoutMs = 1_500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) process.stdin.destroy();
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function markRecallEmitted(sessionId, receipt, deadlineAt) {
  if (!sessionId || !receipt?.id || !receipt?.prompt) return;
  try {
    const { initDatabase, markRecallEventEmitted } = await import(
      path.join(here, "../dist/db.js")
    );
    // The receipt write is inside the same hook budget as everything else: on
    // BUSY it must leave the receipt `prepared` (the documented fallback) and
    // log that, never sit on the 5 s default until the host kills the hook.
    const { busyTimeoutForRemaining } = await import(
      path.join(here, "../dist/continuity-core.js")
    );
    const db = initDatabase({
      busyTimeoutMs: busyTimeoutForRemaining(
        (deadlineAt ?? Date.now()) - Date.now(),
      ),
    });
    try {
      if (!markRecallEventEmitted(db, {
        id: receipt.id,
        sessionId,
        prompt: receipt.prompt,
      })) {
        throw new Error("prepared receipt not found");
      }
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Issue #44: the same provenance break as the injection hook, and the same
    // reason it was invisible — Codex discards hook stderr. Record it where
    // `memex doctor` looks.
    try {
      const { appendInjectLog } = await import(path.join(here, "../dist/inject-log.js"));
      appendInjectLog({
        status: "receipt-failed",
        via: "continuity",
        prompt_len: receipt.prompt.length,
        error: message,
      });
    } catch {
      /* observability is best-effort */
    }
    process.stderr.write(`[memex continuity] recall receipt remained prepared: ${message}\n`);
  }
}

/** Resolve after stdout's write callback succeeds; host consumption is separate. */
export function writeStdout(data, stdout = process.stdout) {
  return new Promise((resolve, reject) => {
    try {
      stdout.write(data, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

/** Keep receipt state prepared until stdout delivery succeeds. */
export async function emitContinuityResult(
  result,
  sessionId,
  { stdout = process.stdout, markEmitted = markRecallEmitted, deadlineAt } = {},
) {
  if (result.stdout) await writeStdout(result.stdout, stdout);
  if (result.recallReceipt) await markEmitted(sessionId, result.recallReceipt, deadlineAt);
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) throw new Error("empty hook payload");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("hook payload is not valid JSON");
  }
  const { handleContinuityHook, hookBudgetMs } = await import(
    path.join(here, "../dist/continuity-core.js")
  );
  const budgetMs = hookBudgetMs(String(payload.hook_event_name ?? payload.hookEventName ?? ""));
  const result = handleContinuityHook(payload, { startedAt: STARTED_AT, budgetMs });
  if (result.warning) {
    process.stderr.write(`[memex continuity] capture gap: ${result.warning}\n`);
  }
  await emitContinuityResult(
    result,
    String(payload.session_id ?? payload.sessionId ?? ""),
    { deadlineAt: STARTED_AT + budgetMs },
  );
  if (process.env.MEMEX_CONTINUITY_NO_WAKE !== "1") {
    try {
      const child = spawn(process.execPath, [path.join(here, "continuity-worker.js")], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.unref();
    } catch {
      // The durable outbox is the correctness boundary; startup/resume retry.
    }
  }
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
const isEntrypoint = entryPath === import.meta.url ||
  (path.basename(process.argv[1] ?? "") === "session-end-hook.js" &&
    entryPath.endsWith("/scripts/session-end-hook.js"));
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(
      `[memex continuity] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
