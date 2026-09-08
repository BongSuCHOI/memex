#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));

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

async function markRecallEmitted(sessionId, receipt) {
  if (!sessionId || !receipt?.id || !receipt?.prompt) return;
  try {
    const { initDatabase, markRecallEventEmitted } = await import(
      path.join(here, "../dist/db.js")
    );
    const db = initDatabase();
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
    process.stderr.write(
      `[memex continuity] recall receipt remained prepared: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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
  { stdout = process.stdout, markEmitted = markRecallEmitted } = {},
) {
  if (result.stdout) await writeStdout(result.stdout, stdout);
  if (result.recallReceipt) await markEmitted(sessionId, result.recallReceipt);
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
  const { handleContinuityHook } = await import(
    path.join(here, "../dist/continuity-core.js")
  );
  const result = handleContinuityHook(payload);
  if (result.warning) {
    process.stderr.write(`[memex continuity] capture gap: ${result.warning}\n`);
  }
  await emitContinuityResult(
    result,
    String(payload.session_id ?? payload.sessionId ?? ""),
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
