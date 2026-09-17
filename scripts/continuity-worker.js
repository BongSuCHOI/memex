#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = "Usage: continuity-worker.js [--max <n>] [--json]  (or: memex jobs drain)";

/**
 * Issue #156 — this script is what `memex jobs drain` runs, so its flags are a
 * user-facing contract:
 *   --max <n>  integer >= 1; values above 32 are clamped to the worker ceiling.
 *              A missing/non-numeric/non-integer/<1 value is a usage error (2).
 *   --json     stdout carries EXACTLY one JSON array of results; every human
 *              line stays on stderr so the output stays machine-parseable.
 */
function parseArgs(argv) {
  let maxJobs;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
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
  return { maxJobs, json };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`[continuity-worker] ${parsed.error}\n${USAGE}\n`);
    process.exit(2);
  }
  const [{ initDatabase }, { runContinuityWorker }] = await Promise.all([
    import(path.join(here, "../dist/db.js")),
    import(path.join(here, "../dist/continuity-worker.js")),
  ]);
  const db = initDatabase();
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

main().catch((error) => {
  process.stderr.write(
    `[continuity-worker] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
