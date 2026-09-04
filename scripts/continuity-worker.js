#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const [{ initDatabase }, { runContinuityWorker }] = await Promise.all([
    import(path.join(here, "../dist/db.js")),
    import(path.join(here, "../dist/continuity-worker.js")),
  ]);
  const db = initDatabase();
  try {
    const results = await runContinuityWorker(db, { maxJobs: 8 });
    for (const result of results) {
      process.stderr.write(
        `[continuity-worker] ${result.kind} ${result.state}: ${result.detail}\n`,
      );
    }
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
