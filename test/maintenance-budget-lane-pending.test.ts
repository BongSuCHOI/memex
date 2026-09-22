import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { initDatabase } from "../src/db.js";
import {
  AUTOMATIC_MAINTENANCE_COOLDOWN_MS,
  ensureModelBudgetSchema,
  exhaustModelBudget,
  finishModelAttempt,
  getOrCreateAutomaticMaintenanceModelBudget,
  reserveModelAttempt,
} from "../src/model-budget.js";

/**
 * Issue #175 — automatic fact extraction deadlocks once the job queue drains.
 *
 * `getOrCreateAutomaticMaintenanceModelBudget` decided "is there pending work?"
 * from `memory_jobs` / `model_work_targets` alone. But a `fact_extract` job is
 * only ever CREATED by the extraction worker, and the worker only spawns while
 * the maintenance budget is `active`. So the moment the queue drained the wake
 * marked the budget `completed`, the worker never spawned, no job was ever
 * created, and the next wake saw the same empty queue — seven sessions pending
 * since 2026-09-17 on the work Mac, maintenance#23–#25 all `completed` with
 * 0–1 attempts and an empty 24h window.
 *
 * The lane predicates (a pending extraction SESSION, a pending ontology FACT)
 * live one level above the job queue, so the caller passes them in.
 *
 * Wall-clock independent: every fixture time is relative to `new Date()`.
 */

const T0 = new Date();
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const HOUR = AUTOMATIC_MAINTENANCE_COOLDOWN_MS;
/** Far enough ahead that no fixture call meets a clock-dead `active` run. */
const limits = { maxAttempts: 8, deadlineAt: at(6 * HOUR).toISOString() };

describe("issue #175 — a completed automatic budget reopens for lane-level work", () => {
  let root: string;
  let db: Database.Database;

  const budgetCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get() as { n: number }).n;

  /**
   * The exact durable state from the issue: the latest automatic maintenance
   * budget is `completed` and the job queue is empty, because the previous
   * wake found nothing to do.
   */
  const drainedToCompleted = () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    expect(first.state).toBe("active");
    expect(first.runSeq).toBe(1);
    // The next wake sees no job and no derived target: the run is retired.
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
    });
    expect(drained.budgetId).toBe(first.budgetId);
    expect(drained.state).toBe("completed");
    expect(budgetCount()).toBe(1);
    return drained;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-lane-pending-"));
    process.env.MEMEX_HOME = root;
    process.env.MEMEX_DB_PATH = path.join(root, "memex.sqlite");
    delete process.env.MEMEX_MODEL_BUDGET_ID;
    delete process.env.MEMEX_MAINTENANCE_WAVE_ID;
    db = initDatabase();
    ensureModelBudgetSchema(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    vi.unstubAllEnvs();
    delete process.env.MEMEX_HOME;
    delete process.env.MEMEX_DB_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rolls a completed run over to a new active run when a lane has work", () => {
    const drained = drainedToCompleted();

    // A new session arrives. There is still no `fact_extract` job — only the
    // worker creates one — so the queue is the wrong place to ask.
    const reopened = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: true,
    });
    expect(
      reopened.state,
      "a pending extraction session must reopen the drained maintenance wave",
    ).toBe("active");
    expect(reopened.budgetId).not.toBe(drained.budgetId);
    expect(reopened.parentWaveId).toBe("maintenance#2");
    expect(reopened.rootWaveId).toBe("maintenance");
    expect(reopened.runSeq).toBe(2);
    expect(reopened.automatic).toBe(true);
    expect(budgetCount()).toBe(2);
    // Nothing failed, so the rollover is a clock-only stop: no 60-minute wait.
    expect(Date.parse(reopened.createdAt)).toBeLessThan(Date.parse(drained.createdAt) + HOUR);
    // The retired run keeps its own ledger.
    expect(
      db.prepare("SELECT state FROM model_work_budgets WHERE budget_id = ?").get(drained.budgetId),
    ).toEqual({ state: "completed" });
  });

  it("without lane work the completed run stays completed (no new run)", () => {
    const drained = drainedToCompleted();

    const explicit = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: false,
    });
    expect(explicit.budgetId).toBe(drained.budgetId);
    expect(explicit.state).toBe("completed");

    // Every pre-#175 caller omits the flag and must keep its behaviour.
    const omitted = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * HOUR),
    });
    expect(omitted.budgetId).toBe(drained.budgetId);
    expect(omitted.state).toBe("completed");
    expect(budgetCount()).toBe(1);
  });

  it("the 24h rolling cap outranks lane work", () => {
    vi.stubEnv("MEMEX_AUTO_MODEL_MAX_ATTEMPTS", "1");
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    // Spend the window's single automatic attempt while the run was live.
    const attempt = reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1, now: T0 });
    finishModelAttempt(db, {
      attemptId: attempt.attemptId,
      state: "completed",
      finishedAt: T0.toISOString(),
    });
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
    });
    expect(drained.budgetId).toBe(first.budgetId);
    expect(drained.state).toBe("completed");

    const capped = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: true,
    });
    expect(capped.state, "the 24h cap is unconditional").not.toBe("active");
    expect(capped.budgetId).toBe(first.budgetId);
    expect(budgetCount()).toBe(1);

    // Once the window rolls off, the same lane work opens the next run.
    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 8, deadlineAt: at(25 * HOUR).toISOString() },
      now: at(24 * HOUR + 60_000),
      lanePending: true,
    });
    expect(rolled.budgetId).not.toBe(first.budgetId);
    expect(rolled.state).toBe("active");
    expect(rolled.runSeq).toBe(2);
  });

  /**
   * Codex review of the #175 fix: `completed` is not proof that nothing was
   * spent. The `!pending` block rewrites ANY non-completed row to `completed`
   * (the status attention counter reads `state = 'exhausted'`), so a run that
   * burned its last allowed attempt and then met an empty queue also reads
   * `completed` — and a state-only clock-only rule let it reopen two minutes
   * later, skipping the hour it had genuinely earned.
   */
  it("a run that spent its attempt cap still serves the 60-minute cooldown", () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 1, deadlineAt: at(6 * HOUR).toISOString() },
      now: T0,
    });
    // Spend the run's whole cap on a real provider call.
    const attempt = reserveModelAttempt(db, { budgetId: first.budgetId, inputChars: 1, now: T0 });
    finishModelAttempt(db, {
      attemptId: attempt.attemptId,
      state: "completed",
      finishedAt: T0.toISOString(),
    });

    // The next wake settles the spent run AND retires it, because the queue is
    // empty by then: one row that is `completed` with a spend on its ledger.
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
    });
    expect(drained.budgetId).toBe(first.budgetId);
    expect(drained.state).toBe("completed");
    // `reserveModelAttempt` writes `state = 'exhausted'` on the reservation
    // that fills the cap without recording a reason, so the row that reaches
    // the wake carries NO reason at all: the attempt ledger below is the only
    // witness of the spend, which is why the cooldown rule has to read it.
    expect(drained.exhaustedReason).toBeNull();
    expect(drained.reservedAttempts).toBeGreaterThanOrEqual(drained.maxAttempts);

    const early = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: true,
    });
    expect(
      early.budgetId,
      "a run that spent its cap must serve the cooldown, `completed` or not",
    ).toBe(first.budgetId);
    expect(early.state).not.toBe("active");
    expect(budgetCount()).toBe(1);

    // 61 minutes after the spend the cooldown is over and the lane reopens.
    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 8, deadlineAt: at(7 * HOUR).toISOString() },
      now: at(61 * 60_000),
      lanePending: true,
    });
    expect(rolled.budgetId).not.toBe(first.budgetId);
    expect(rolled.state).toBe("active");
    expect(rolled.runSeq).toBe(2);
  });

  /** The other spend witness: a recorded reason, with the cap still unspent. */
  it("a run retired after a recorded spend keeps its cooldown too", () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    exhaustModelBudget(db, { budgetId: first.budgetId, reason: "attempts", now: T0 });
    const drained = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
    });
    expect(drained.state).toBe("completed");
    expect(drained.exhaustedReason, "the reason survives the retirement").toBe("attempts");
    expect(drained.reservedAttempts).toBeLessThan(drained.maxAttempts);

    const early = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(2 * 60_000),
      lanePending: true,
    });
    expect(early.budgetId, "a recorded spend outranks the `completed` state").toBe(first.budgetId);
    expect(early.state).not.toBe("active");
    expect(budgetCount()).toBe(1);

    const rolled = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { maxAttempts: 8, deadlineAt: at(7 * HOUR).toISOString() },
      now: at(61 * 60_000),
      lanePending: true,
    });
    expect(rolled.budgetId).not.toBe(first.budgetId);
    expect(rolled.state).toBe("active");
  });

  it("an active run with lane work is returned unchanged", () => {
    const first = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: T0,
    });
    expect(first.state).toBe("active");

    const same = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits,
      now: at(60_000),
      lanePending: true,
    });
    expect(same.budgetId, "lane work must not mint a second run beside a live one").toBe(
      first.budgetId,
    );
    expect(same.state).toBe("active");
    expect(budgetCount()).toBe(1);
  });
});

/**
 * The wiring half of #175, on the real hook script: a drained `completed`
 * automatic budget plus a pending extraction SESSION must spawn
 * `backfill-extract-worker.js`. Slice pattern follows
 * `test/maintenance-prompt-wake.test.ts`: the script is copied into a temp root
 * whose `dist/` holds stubs, so nothing touches a real data root.
 */
describe("issue #175 — session-start-maintenance spawns the extract lane", () => {
  const roots: string[] = [];
  /** Generous by design: node startup on a loaded CI box is not a deadline. */
  const SPAWN_TIMEOUT_MS = 15_000;
  /** Headroom after the control child proves children have had their turn. */
  const SETTLE_MS = 2_000;

  afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  });

  const fixture = (sessionPending: boolean) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-lane-slice-"));
    roots.push(root);
    const scripts = path.join(root, "scripts");
    const dist = path.join(root, "dist");
    // 🚨 The child runs the REAL hook, which reads the data root (models.json,
    // via `currentModelConfigHold`). Both roots therefore point INSIDE the
    // fixture: removing `MEMEX_HOME` would have let it read the developer's own
    // `~/.config/memex`.
    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg");
    for (const dir of [scripts, dist, home, xdg]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.copyFileSync(
      "scripts/session-start-maintenance.js",
      path.join(scripts, "session-start-maintenance.js"),
    );
    const dbFile = path.join(root, "state.sqlite");
    const budgetModule = pathToFileURL(path.resolve("dist/model-budget.js")).href;
    fs.writeFileSync(
      path.join(dist, "model-budget.js"),
      `export * from ${JSON.stringify(budgetModule)};`,
    );
    fs.writeFileSync(
      path.join(dist, "db.js"),
      `import {createRequire} from 'node:module';
       const Database=createRequire(${JSON.stringify(path.resolve("package.json"))})('better-sqlite3');
       export function initDatabase(){const db=new Database(${JSON.stringify(dbFile)});db.pragma('busy_timeout=5000');return db;}`,
    );
    fs.writeFileSync(
      path.join(dist, "reembed-selector.js"),
      "export const buildCategoryReembedPending=()=>({}),buildFactReembedPending=()=>({}),buildReembedPending=()=>({});",
    );
    // The session-level extraction predicate: one pending session, or none.
    fs.writeFileSync(
      path.join(dist, "pending-extraction.js"),
      `export const getExtractionConfig=()=>({});
       export const pendingExtractionCoreQuery=()=>({sql:'SELECT 1 AS session_id WHERE ${sessionPending ? 1 : 0}',params:[]});`,
    );
    fs.writeFileSync(path.join(dist, "embeddings.js"), "export const EMBEDDING_VERSION='fixture';");
    fs.writeFileSync(path.join(dist, "observe-hook-event.js"), "export function recordHookEvent(){}");
    fs.writeFileSync(path.join(dist, "fact-management.js"), "export function reconcileFactTiers(){}");
    // The CONTROL spawn: sync export is gated only on this stub, so it fires on
    // every run, before the lane gates. It is the instrument's own positive
    // control — a run whose log holds this line was definitely being recorded.
    fs.writeFileSync(path.join(dist, "sync-paths.js"), "export const readSyncConfig=()=>({enabled:true});");
    const control = path.join(root, "control-spawned");
    fs.writeFileSync(
      path.join(scripts, "sync-export-hook.js"),
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(control)},'spawned');`,
    );
    // 🚨 The spawn LEDGER, so the negative case is a fact and not a wait.
    //
    // `spawnDetached` hands the child to the OS and unrefs it, so "no marker
    // file yet" can never prove "no spawn" — only that the child has not
    // written yet. This CJS preload patches `child_process` in the hook process
    // BEFORE its ESM entry is evaluated (the builtin's ESM facade reads the
    // CJS export when it is first evaluated, so the named `spawn` import the
    // hook holds is the patched one) and appends one line per call
    // SYNCHRONOUSLY, inside the same tick as the call. Once the hook process
    // has exited, the log is complete by construction: a spawn it never
    // recorded is a spawn it never made.
    const spawnLog = path.join(root, "spawn-log.jsonl");
    fs.writeFileSync(
      path.join(root, "spawn-log.cjs"),
      `const cp = require('node:child_process');
       const fs = require('node:fs');
       const LOG = ${JSON.stringify(spawnLog)};
       for (const name of ['spawn', 'spawnSync', 'fork']) {
         const real = cp[name];
         if (typeof real !== 'function') continue;
         cp[name] = function (file, args) {
           try {
             fs.appendFileSync(LOG, JSON.stringify({
               fn: name,
               file: String(file),
               args: Array.isArray(args) ? args.map(String) : [],
             }) + '\\n');
           } catch { /* the ledger must never break the run it observes */ }
           return real.apply(this, arguments);
         };
       }`,
    );
    const spawned = path.join(root, "spawned");
    fs.writeFileSync(
      path.join(scripts, "backfill-extract-worker.js"),
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(spawned)},process.env.MEMEX_MODEL_BUDGET_ID ?? '');`,
    );
    // The drained state: one automatic maintenance run, `completed`, no jobs.
    const seed = new Database(dbFile);
    try {
      ensureModelBudgetSchema(seed);
      const first = getOrCreateAutomaticMaintenanceModelBudget(seed, { parentWaveId: "maintenance" });
      seed
        .prepare("UPDATE model_work_budgets SET state = 'completed', automatic = 1 WHERE budget_id = ?")
        .run(first.budgetId);
    } finally {
      seed.close();
    }
    return { root, scripts, spawned, control, spawnLog, dbFile, home, xdg };
  };

  /** Runs the hook to completion; every path it can read stays in the fixture. */
  const runHook = async (f: ReturnType<typeof fixture>) => {
    // A regression here would point the real hook at a real data root, so it is
    // asserted, not just intended.
    expect(f.home.startsWith(os.tmpdir()) && f.xdg.startsWith(os.tmpdir())).toBe(true);
    const run = promisify(execFile);
    // `--require` on argv, not NODE_OPTIONS: the shim then observes THIS process
    // only, instead of being inherited by every worker it spawns.
    const out = await run(process.execPath, [
      "--require",
      path.join(f.root, "spawn-log.cjs"),
      path.join(f.scripts, "session-start-maintenance.js"),
    ], {
      timeout: 60_000,
      env: {
        ...process.env,
        MEMEX_HOME: f.home,
        XDG_CONFIG_HOME: f.xdg,
        MEMEX_DB_PATH: f.dbFile,
        MEMEX_MODEL_BUDGET_ID: undefined,
        MEMEX_MAINTENANCE_WAVE_ID: undefined,
      } as NodeJS.ProcessEnv,
    });
    expect(out.stdout).toBe("");
    return out;
  };

  /** Every script the hook process actually handed to `child_process`. */
  const spawnedScripts = (f: ReturnType<typeof fixture>): string[] =>
    (fs.existsSync(f.spawnLog) ? fs.readFileSync(f.spawnLog, "utf8") : "")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => (JSON.parse(line) as { args: string[] }).args)
      .map((arg) => path.basename(arg));

  const waitFor = async (file: string, timeoutMs = SPAWN_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return fs.existsSync(file);
  };

  it("reopens the drained wave and spawns the worker for a pending session", async () => {
    const f = fixture(true);
    await runHook(f);
    // Primary: the hook's own spawn ledger, complete once it has exited.
    expect(
      spawnedScripts(f),
      "a pending extraction session must spawn backfill-extract-worker.js",
    ).toContain("backfill-extract-worker.js");
    // Secondary: the child really ran. Generous — node startup is not a deadline.
    expect(await waitFor(f.spawned), "the spawned worker must reach the disk").toBe(true);
    const check = new Database(f.dbFile);
    try {
      expect(
        check
          .prepare("SELECT state, run_seq FROM model_work_budgets ORDER BY run_seq DESC LIMIT 1")
          .get(),
      ).toEqual({ state: "active", run_seq: 2 });
      // The child is bound to the run the hook just opened.
      expect(fs.readFileSync(f.spawned, "utf8")).toBe(
        (check.prepare("SELECT budget_id FROM model_work_budgets WHERE run_seq = 2").get() as {
          budget_id: string;
        }).budget_id,
      );
    } finally {
      check.close();
    }
  });

  it("stays drained when no session is pending", async () => {
    const f = fixture(false);
    // The hook process has fully exited, so its spawn ledger is final: no
    // polling, no settle, nothing left that could still append to it.
    await runHook(f);
    const spawns = spawnedScripts(f);
    // The instrument's positive control: this run WAS being recorded.
    expect(spawns, "the ledger must prove it was recording").toContain("sync-export-hook.js");
    expect(spawns, "no pending session means no extract worker, ever").not.toContain(
      "backfill-extract-worker.js",
    );
    // Belt and braces: nothing reached the disk either, after a generous settle.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(fs.existsSync(f.spawned)).toBe(false);
    const check = new Database(f.dbFile);
    try {
      expect(check.prepare("SELECT COUNT(*) AS n FROM model_work_budgets").get()).toEqual({ n: 1 });
    } finally {
      check.close();
    }
  });
});
