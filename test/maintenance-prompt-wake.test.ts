import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { claimMaintenanceWake, ensureModelBudgetSchema, MAINTENANCE_WAKE_INTERVAL_MS } from "../src/model-budget.js";
import { LIFECYCLE_COMMANDS } from "../src/lifecycle.js";

describe("prompt-triggered maintenance", () => {
  it("registers a separate async maintenance hook in both plugin and explicit fallback", () => {
    const manifest = JSON.parse(fs.readFileSync("hooks.json", "utf8"));
    const commands = manifest.hooks.UserPromptSubmit.flatMap((block: { hooks: object[] }) => block.hooks);
    expect(commands).toHaveLength(2);
    expect(commands.find((c: { command: string }) => c.command.includes("memex-hook-maintenance")))
      .toMatchObject({ async: true, command: 'node "${PLUGIN_ROOT}/cli/runtime-exec.js" memex-hook-maintenance --prompt' });
    expect(commands.find((c: { command: string }) => c.command.endsWith("memex-hook-inject"))).not.toHaveProperty("async");
    expect(LIFECYCLE_COMMANDS.UserPromptSubmit).toContainEqual({ script: "scripts/session-start-maintenance.js", args: ["--prompt"], async: true });
  });

  it("shares a durable wake interval across connections and recovers after idle or a crashed launcher", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-prompt-wake-"));
    const file = path.join(root, "state.sqlite");
    const first = new Database(file);
    const second = new Database(file);
    try {
      ensureModelBudgetSchema(first);
      const now = new Date("2026-09-09T00:00:00Z");
      expect(claimMaintenanceWake(first, now)).toBe(true);
      expect(claimMaintenanceWake(second, now)).toBe(false);
      expect(claimMaintenanceWake(second, new Date(now.getTime() + MAINTENANCE_WAKE_INTERVAL_MS - 1))).toBe(false);
      expect(claimMaintenanceWake(second, new Date(now.getTime() + MAINTENANCE_WAKE_INTERVAL_MS))).toBe(true);
      expect(claimMaintenanceWake(first, new Date(now.getTime() + 2 * 60 * 60_000))).toBe(true);
      expect(first.prepare("SELECT COUNT(*) n FROM model_work_budgets").get()).toEqual({ n: 0 });
      expect(first.prepare("SELECT COUNT(*) n FROM model_work_attempts").get()).toEqual({ n: 0 });
    } finally { first.close(); second.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("coalesces real prompt/startup processes, emits no context and does not await its worker", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-prompt-launch-"));
    const scripts = path.join(root, "scripts");
    const dist = path.join(root, "dist");
    fs.mkdirSync(scripts); fs.mkdirSync(dist);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.copyFileSync("scripts/session-start-maintenance.js", path.join(scripts, "session-start-maintenance.js"));
    const budgetModule = pathToFileURL(path.resolve("dist/model-budget.js")).href;
    const dbFile = path.join(root, "state.sqlite");
    const db = new Database(dbFile); ensureModelBudgetSchema(db); db.close();
    fs.writeFileSync(path.join(dist, "model-budget.js"), `export * from ${JSON.stringify(budgetModule)};`);
    fs.writeFileSync(path.join(dist, "db.js"), `
      import {createRequire} from 'node:module';
      const Database=createRequire(${JSON.stringify(path.resolve("package.json"))})('better-sqlite3');
      export function initDatabase(){const db=new Database(${JSON.stringify(dbFile)});db.pragma('busy_timeout=5000');return db;}
    `);
    fs.writeFileSync(path.join(dist, "reembed-selector.js"), "export const buildCategoryReembedPending=()=>({}),buildFactReembedPending=()=>({}),buildReembedPending=()=>({});");
    fs.writeFileSync(path.join(dist, "pending-extraction.js"), "export const getExtractionConfig=()=>({}),pendingExtractionCoreQuery=()=>({sql:'SELECT 1 WHERE 0',params:[]});");
    fs.writeFileSync(path.join(dist, "embeddings.js"), "export const EMBEDDING_VERSION='fixture';");
    const events = path.join(root, "events.jsonl");
    fs.writeFileSync(path.join(dist, "observe-hook-event.js"), `import fs from 'node:fs';export function recordHookEvent(event){fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(event)+'\\n');}`);
    const started = path.join(root, "worker-started");
    const done = path.join(root, "worker-done");
    const release = path.join(root, "release-worker");
    fs.writeFileSync(path.join(scripts, "fact-consolidate-worker.js"), `
      import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(started)},'started\\n');
      const startedAt=Date.now();
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}) || Date.now()-startedAt>10000){clearInterval(timer);fs.writeFileSync(${JSON.stringify(done)},'done');}},20);
    `);
    try {
      const run = promisify(execFile);
      const outputs = await Promise.all([
        run(process.execPath, [path.join(scripts, "session-start-maintenance.js"), "--prompt"], { timeout: 5000 }),
        run(process.execPath, [path.join(scripts, "session-start-maintenance.js")], { timeout: 5000 }),
      ]);
      for (const out of outputs) { expect(out.stdout).toBe(""); expect(out.stderr).toBe(""); }
      for (let i = 0; i < 100 && !fs.existsSync(started); i++) await new Promise(r => setTimeout(r, 20));
      expect(fs.readFileSync(started, "utf8")).toBe("started\n");
      expect(fs.existsSync(done)).toBe(false);
      expect(fs.readFileSync(events, "utf8").trim().split("\n").map(l => JSON.parse(l)).sort())
        .toEqual(["SessionStart", "UserPromptSubmit"]);
    } finally {
      fs.writeFileSync(release, "release");
      for (let i = 0; i < 150 && !fs.existsSync(done); i++) await new Promise(r => setTimeout(r, 20));
      if (fs.existsSync(done)) fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
