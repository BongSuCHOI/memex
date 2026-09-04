#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  if (result.stdout) process.stdout.write(result.stdout);
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

main().catch((error) => {
  process.stderr.write(
    `[memex continuity] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
