import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let sandbox: string;

function writeStubs(mode: "relation" | "budget" | "relation-transient"): string {
  const dist = path.join(sandbox, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(path.join(sandbox, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, "index"), { recursive: true });
  const callsPath = path.join(sandbox, "relation-calls.jsonl");
  const ids = mode === "budget"
    ? []
    : mode === "relation-transient"
      ? ["relation-1", "relation-2", "relation-3", "relation-4"]
      : ["relation-1"];
  const ontologyIds = mode === "budget" ? [{ id: "fact-budget" }] : [];
  fs.writeFileSync(path.join(dist, "db.js"), `
export function initDatabase() {
  return {
    prepare(sql) {
      return {
        all() {
          if (String(sql).includes('model_work_targets')) return ${JSON.stringify(ids)}.map((id) => ({ id }));
          if (String(sql).includes('FROM facts')) return ${JSON.stringify(ontologyIds)};
          return [];
        },
        get() { return undefined; },
      };
    },
    close() {},
  };
}
`);
  fs.writeFileSync(path.join(dist, "ontology-classifier.js"), `
import fs from 'node:fs';
export const MAX_CLASSIFY_ATTEMPTS = 3;
export function parkExhaustedFacts() { return 0; }
export function backfillClassifyBatch() {
  ${mode === "budget" ? "throw { code: 'MEMEX_MODEL_BUDGET' };" : "return Promise.resolve({ classified: 0, deterministic: 0, fallback: 0, failed: 0, transient: 0 });"}
}
export async function backfillRelationBatch(_db, ids) {
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(ids) + '\\n');
  return ${mode === "relation-transient" ? "{ completed: 0, pending: ids.length }" : "{ completed: ids.length, pending: 0 }"};
}
`);
  fs.writeFileSync(path.join(dist, "model-budget.js"), `
export function getModelWorkBudget() { return null; }
export function getOrCreateMaintenanceModelBudget() {
  return { budgetId: 'budget-1', parentWaveId: 'maintenance', state: 'active' };
}
export function isModelBudgetExhausted(error) { return error?.code === 'MEMEX_MODEL_BUDGET'; }
`);
  fs.writeFileSync(
    path.join(dist, "paths.js"),
    `export function getIndexDir() { return ${JSON.stringify(path.join(sandbox, "index"))}; }\n`,
  );
  const sourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "backfill-ontology-worker.js",
  );
  fs.writeFileSync(path.join(sandbox, "scripts", "backfill-ontology-worker.js"), fs.readFileSync(sourcePath, "utf8"));
  return callsPath;
}

function runWorker(): { out: string; calls: string[][] } {
  const env = { ...process.env, BACKFILL_CONCURRENCY: "1", BACKFILL_BATCH_SIZE: "1", BACKFILL_ONTOLOGY_MAX: "10" };
  delete env.BACKFILL_RELATIONS;
  const out = execFileSync(process.execPath, ["scripts/backfill-ontology-worker.js"], {
    cwd: sandbox,
    encoding: "utf8",
    timeout: 30_000,
    env,
  });
  const callsPath = path.join(sandbox, "relation-calls.jsonl");
  const calls = fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
  return { out, calls };
}

beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mb-ontology-relation-")); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe("ontology relation-only worker regressions", () => {
  it("drains existing relation memberships without BACKFILL_RELATIONS", () => {
    writeStubs("relation");
    const { out, calls } = runWorker();
    expect(calls).toEqual([["relation-1"]]);
    expect(out).toMatch(/relations pending-only/);
    expect(out).toMatch(/done this run \(llm 1/);
  });

  it("reports a budget stop with a finite batch count", () => {
    writeStubs("budget");
    const { out } = runWorker();
    expect(out).toMatch(/budget-exhausted 1/);
    expect(out).not.toMatch(/NaN/);
  });

  it("opens the transient circuit breaker for relation-only batches", () => {
    writeStubs("relation-transient");
    const { out, calls } = runWorker();
    expect(calls).toHaveLength(3);
    expect(out).toMatch(/circuit breaker OPEN/);
  });
});
