#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const selfPath = fileURLToPath(import.meta.url);
const here = path.dirname(selfPath);

const USAGE =
  "Usage: continuity-worker.js [--max <n>] [--json] [--mode=hook|foreground]  (or: memex jobs drain)";

/**
 * Issue #162 — how long a hook-spawned worker waits before it opens the
 * database. A SessionStart hook spawns this worker and the UserPromptSubmit
 * inject hook follows within ~1–2 s; without the delay the worker's first write
 * transaction is the lock that hook then times out on.
 *
 * It cannot help against a worker that is ALREADY running — only shorter locks
 * (the evidence pre-scan, #162 R4) do that. Tests set it to 0.
 */
const DEFAULT_HOOK_START_DELAY_MS = 1_500;
/**
 * A hook-spawned worker must never sit on the 5 s default while a hook with a
 * 3 s host timeout needs the same lock. One retry, because a busy first open is
 * usually another process finishing its own short transaction.
 */
const HOOK_OPEN_BUSY_TIMEOUT_MS = 2_000;

/**
 * Issue #156 — this script is what `memex jobs drain` runs, so its flags are a
 * user-facing contract:
 *   --max <n>  integer >= 1; values above 32 are clamped to the worker ceiling.
 *              A missing/non-numeric/non-integer/<1 value is a usage error (2).
 *   --json     stdout carries EXACTLY one JSON array of results; every human
 *              line stays on stderr so the output stays machine-parseable.
 *   --mode     `hook` (spawned by a hook: start delay + bounded first open) or
 *              `foreground` (default — `memex jobs drain`, unchanged behaviour).
 *              The default is foreground so every pre-0.7.24 caller, including
 *              an installed `memex-continuity-worker` bin, keeps working.
 */
export function parseArgs(argv) {
  let maxJobs;
  let json = false;
  let mode = "foreground";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const raw = arg.startsWith("--mode=") ? arg.slice("--mode=".length) : argv[++i];
      if (raw !== "hook" && raw !== "foreground") {
        return { error: `--mode must be hook or foreground (got ${raw === undefined ? "no value" : raw})` };
      }
      mode = raw;
      continue;
    }
    if (arg === "--max") {
      const raw = argv[i + 1];
      i++;
      if (raw === undefined || raw.startsWith("-") || !/^\d+$/.test(raw)) {
        return { error: `--max must be an integer >= 1 (got ${raw === undefined ? "no value" : raw})` };
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        return { error: `--max must be an integer >= 1 (got ${raw})` };
      }
      if (value > 32) {
        process.stderr.write(
          `[continuity-worker] --max ${value} clamped to 32 (per-run ceiling)\n`,
        );
        maxJobs = 32;
      } else {
        maxJobs = value;
      }
      continue;
    }
    return { error: `unknown option ${arg}` };
  }
  return { maxJobs, json, mode };
}

/**
 * Milliseconds a hook-spawned worker sleeps before it touches the database.
 * `MEMEX_WORKER_START_DELAY_MS` overrides it (0 disables the wait); a
 * non-numeric or negative value falls back to the default rather than failing a
 * background worker on a typo. Foreground never waits.
 */
export function startDelayMs(mode, env = process.env) {
  if (mode !== "hook") return 0;
  const raw = env.MEMEX_WORKER_START_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOOK_START_DELAY_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_HOOK_START_DELAY_MS;
  return Math.trunc(value);
}

function isBusyError(error) {
  const code = error && typeof error === "object" ? String(error.code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return code.startsWith("SQLITE_BUSY") || /database is locked|database table is locked/i.test(message);
}

/** Hook mode: bounded first open plus exactly ONE retry. Foreground: unchanged. */
export function openWorkerDatabase(initDatabase, mode) {
  if (mode !== "hook") return initDatabase();
  try {
    return initDatabase({ busyTimeoutMs: HOOK_OPEN_BUSY_TIMEOUT_MS });
  } catch (error) {
    if (!isBusyError(error)) throw error;
    process.stderr.write("[continuity-worker] first open was busy; retrying once\n");
    return initDatabase({ busyTimeoutMs: HOOK_OPEN_BUSY_TIMEOUT_MS });
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`[continuity-worker] ${parsed.error}\n${USAGE}\n`);
    process.exit(2);
  }
  // Before the imports below, so the hook that spawned this process has the
  // whole delay — not what is left of it after loading better-sqlite3.
  const delayMs = startDelayMs(parsed.mode);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const [{ initDatabase }, { runContinuityWorker }] = await Promise.all([
    import(path.join(here, "../dist/db.js")),
    import(path.join(here, "../dist/continuity-worker.js")),
  ]);
  const db = openWorkerDatabase(initDatabase, parsed.mode);
  try {
    const results = await runContinuityWorker(db, {
      maxJobs: parsed.maxJobs ?? 8,
    });
    for (const result of results) {
      process.stderr.write(
        `[continuity-worker] ${result.kind} ${result.state}: ${result.detail}\n`,
      );
    }
    if (parsed.json) process.stdout.write(`${JSON.stringify(results)}\n`);
  } finally {
    db.close();
  }
}

/**
 * Only a direct run drains jobs; importing this file (the argument parser and
 * the start-delay policy are unit-tested) must not start a worker. `realpath`
 * on both sides, because an npm `bin` install invokes this through a symlink in
 * `node_modules/.bin` whose argv[1] is not this path.
 */
function isDirectRun() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(selfPath);
  } catch {
    return path.resolve(invoked) === selfPath;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stderr.write(
      `[continuity-worker] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
