import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
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
          if (String(sql).includes('SELECT DISTINCT t.target_id')) return ${JSON.stringify(ids)}.map((id) => ({ id }));
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
  // Issue #41: the worker now selects through the shared ontology selector,
  // so the sandbox needs that (dependency-free) module and an embedding version.
  fs.writeFileSync(path.join(dist, "ontology-selector.js"), `
export const MAX_CLASSIFY_ATTEMPTS = 3;
export function buildOntologyPendingClause() {
  return { clause: "f.is_active = 1 AND f.ontology_category_id IS NULL", params: [] };
}
`);
  fs.writeFileSync(path.join(dist, "embeddings.js"), `export const EMBEDDING_VERSION = 3;\n`);
  fs.writeFileSync(path.join(dist, "ontology-classifier.js"), `
import fs from 'node:fs';
export { MAX_CLASSIFY_ATTEMPTS } from './ontology-selector.js';
export function parkExhaustedFacts() { return 0; }
export function backfillClassifyBatch() {
  ${mode === "budget" ? "throw { code: 'MEMEX_MODEL_BUDGET' };" : "return Promise.resolve({ classified: 0, deterministic: 0, fallback: 0, failed: 0, transient: 0, released: 0 });"}
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

function runWorker(max = "10"): { out: string; calls: string[][] } {
  const env = { ...process.env, BACKFILL_CONCURRENCY: "1", BACKFILL_BATCH_SIZE: "1", BACKFILL_ONTOLOGY_MAX: max };
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
  it("uses the real SQL to prioritize pending relation and ontology work over new facts", () => {
    const callsPath = writeStubs("relation");
    const dbPath = path.join(sandbox, "queue.sqlite");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE facts(id TEXT PRIMARY KEY,is_active INTEGER,ontology_category_id TEXT,
          ontology_attempts INTEGER,created_at TEXT,updated_at TEXT);
        CREATE TABLE model_work_targets(budget_id TEXT,stage TEXT,state TEXT,target_id TEXT);
        INSERT INTO facts VALUES ('relation',1,'category',0,'2026-09-02','2026-09-02'),
          ('pending',1,NULL,0,'2026-09-03','2026-09-03'),('unbound',1,NULL,0,'2026-09-01','2026-09-01');
        INSERT INTO model_work_targets VALUES ('budget-1','relation','pending','relation'),
          ('budget-1','ontology','pending','pending');
      `);
      fs.writeFileSync(path.join(sandbox, "dist/db.js"), `
        import {createRequire} from 'node:module';
        const Database=createRequire(${JSON.stringify(path.join(process.cwd(), "package.json"))})('better-sqlite3');
        export function initDatabase(){return new Database(${JSON.stringify(dbPath)});}
      `);
      fs.writeFileSync(path.join(sandbox, "dist/ontology-classifier.js"), `
        import fs from 'node:fs';
        export const MAX_CLASSIFY_ATTEMPTS=3;
        export function parkExhaustedFacts(){return 0;}
        export async function backfillRelationBatch(_db,ids){
          fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(ids)+'\\n');
          return {completed:ids.length,pending:0};
        }
        export async function backfillClassifyBatch(_db,ids){
          fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(ids)+'\\n');
          return {classified:ids.length,deterministic:0,fallback:0,failed:0,transient:0};
        }
      `);
      expect(runWorker("1").calls).toEqual([["relation"]]);
      db.exec("UPDATE model_work_targets SET state='completed' WHERE stage='relation'");
      fs.writeFileSync(callsPath, "");
      expect(runWorker("1").calls).toEqual([["pending"]]);
    } finally { db.close(); }
  });

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
