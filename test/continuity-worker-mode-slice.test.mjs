// Issue #162 — `continuity-worker.js --mode=hook|foreground`.
//
// Two very different callers run this same script:
//   - a HOOK spawns it detached, beside other hooks the host kills at 3 s. Such
//     a worker must not be the first thing to grab the write lock, and must not
//     sit on a 5 s busy wait while a hook needs that lock.
//   - `memex jobs drain` runs it in the FOREGROUND because the user asked for
//     it now. Delaying that would be a regression.
//
// The mode is therefore explicit, defaults to `foreground` (every pre-0.7.24
// caller keeps working), and both hook spawners pass `--mode=hook`.
//
// The two spawner tests copy `scripts/` into an isolated tree beside a symlink
// to the real `dist/` and replace the worker with a recorder: the spawner file
// under test is the real one, byte for byte, and the argv it passes is observed
// end to end. Never the developer's data root: MEMEX_HOME is always isolated.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?!\/)/, "/")),
  "..",
);
const WORKER = path.join(ROOT, "scripts", "continuity-worker.js");

let tmp;
let home;
let dbPath;

/** `<home>/conversation-index/db.sqlite` — the first file the worker creates. */
function workerDbPath(root) {
  return path.join(root, "conversation-index", "db.sqlite");
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Spawn the worker and report how long it took to OPEN the database — the
 * moment the delay exists to postpone.
 */
async function msUntilDatabaseOpens(args, extraEnv) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [WORKER, ...args], {
    env: { ...process.env, MEMEX_HOME: home, MEMEX_EMBEDDING_STUB: "1", ...extraEnv },
    stdio: "ignore",
  });
  const appeared = await waitFor(() => fs.existsSync(dbPath));
  const elapsed = Date.now() - startedAt;
  await new Promise((resolve) => child.on("exit", resolve));
  assert.ok(appeared, "the worker never opened the database");
  return elapsed;
}

/**
 * An isolated copy of `scripts/` whose `*-worker.js` files only record the argv
 * they were given, beside a symlink to the real `dist/`. `realpathSync` matters:
 * every one of these scripts compares `process.argv[1]` with its own
 * `import.meta.url`, and macOS `/var` -> `/private/var` would make them differ.
 */
function scriptHarness() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mb-worker-mode-")));
  fs.cpSync(path.join(ROOT, "scripts"), path.join(dir, "scripts"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "dist"), path.join(dir, "dist"), "dir");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  const record = path.join(dir, "worker-argv.jsonl");
  for (const name of fs.readdirSync(path.join(dir, "scripts"))) {
    if (!name.endsWith("-worker.js")) continue;
    fs.writeFileSync(
      path.join(dir, "scripts", name),
      `import fs from "node:fs";\n` +
        `fs.appendFileSync(${JSON.stringify(record)}, ` +
        `JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + "\\n");\n`,
    );
  }
  return {
    dir,
    recorded: () => (fs.existsSync(record)
      ? fs.readFileSync(record, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : []),
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mb-worker-mode-home-")));
  home = path.join(tmp, "home");
  dbPath = workerDbPath(home);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("continuity-worker --mode (#162)", () => {
  it("defaults to foreground and keeps the --max/--json contract", async () => {
    const { parseArgs } = await import(WORKER);
    assert.deepEqual(parseArgs([]), { maxJobs: undefined, json: false, mode: "foreground" });
    assert.deepEqual(parseArgs(["--mode=hook"]), { maxJobs: undefined, json: false, mode: "hook" });
    assert.deepEqual(parseArgs(["--mode", "hook"]), { maxJobs: undefined, json: false, mode: "hook" });
    assert.deepEqual(
      parseArgs(["--max", "3", "--json", "--mode=foreground"]),
      { maxJobs: 3, json: true, mode: "foreground" },
    );
    assert.match(parseArgs(["--mode=sideways"]).error, /--mode must be hook or foreground/);
    assert.match(parseArgs(["--mode"]).error, /--mode must be hook or foreground/);
  });

  it("an unsupported --mode value is a usage error, not a silent foreground run", () => {
    const result = spawnSync(process.execPath, [WORKER, "--mode=sideways"], {
      env: { ...process.env, MEMEX_HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--mode must be hook or foreground/);
    assert.match(result.stderr, /\[--mode=hook\|foreground\]/);
    assert.equal(fs.existsSync(dbPath), false, "a usage error must not open the database");
  });

  it("only hook mode waits, and only for the configured delay", async () => {
    const { startDelayMs } = await import(WORKER);
    assert.equal(startDelayMs("foreground", { MEMEX_WORKER_START_DELAY_MS: "9000" }), 0);
    assert.equal(startDelayMs("hook", {}), 1_500);
    assert.equal(startDelayMs("hook", { MEMEX_WORKER_START_DELAY_MS: "0" }), 0);
    assert.equal(startDelayMs("hook", { MEMEX_WORKER_START_DELAY_MS: "300" }), 300);
    // A typo must not keep a background worker from running at all.
    assert.equal(startDelayMs("hook", { MEMEX_WORKER_START_DELAY_MS: "soon" }), 1_500);
    assert.equal(startDelayMs("hook", { MEMEX_WORKER_START_DELAY_MS: "-5" }), 1_500);
  });

  it("hook mode opens the database only after the delay; foreground opens it at once", async () => {
    const delayMs = 1_200;
    const hook = await msUntilDatabaseOpens(["--mode=hook"], {
      MEMEX_WORKER_START_DELAY_MS: String(delayMs),
    });
    assert.ok(hook >= delayMs, `hook mode opened the database after ${hook}ms, before the ${delayMs}ms delay`);

    fs.rmSync(path.join(home, "conversation-index"), { recursive: true, force: true });
    const foreground = await msUntilDatabaseOpens(["--mode=foreground"], {
      MEMEX_WORKER_START_DELAY_MS: String(delayMs),
    });
    assert.ok(
      foreground < delayMs / 2,
      `foreground waited ${foreground}ms — 'memex jobs drain' must not be delayed`,
    );
  });

  it("the continuity hook spawns its worker with --mode=hook", async () => {
    const harness = scriptHarness();
    const project = path.join(harness.dir, "project");
    fs.mkdirSync(project, { recursive: true });
    const transcript = path.join(harness.dir, "session.jsonl");
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: "session_meta", payload: { id: "hook-session", cwd: project } }) + "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } }) + "\n",
    );

    const result = spawnSync(process.execPath, [path.join(harness.dir, "scripts", "continuity-hook.js")], {
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "hook-session",
        cwd: project,
        transcript_path: transcript,
      }),
      env: {
        ...process.env,
        MEMEX_HOME: home,
        MEMEX_EMBEDDING_STUB: "1",
        MEMEX_ALLOWED_TRANSCRIPT_ROOTS: harness.dir,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(await waitFor(() => harness.recorded().length > 0, 10_000), "the hook spawned no worker");
    assert.deepEqual(harness.recorded(), [["continuity-worker.js", "--mode=hook"]]);
    fs.rmSync(harness.dir, { recursive: true, force: true });
  });

  it("the SessionStart maintenance hook spawns its worker with --mode=hook", async () => {
    const harness = scriptHarness();
    const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
    const previousHome = process.env.MEMEX_HOME;
    process.env.MEMEX_HOME = home;
    const db = initDatabase();
    const now = new Date().toISOString();
    // The only thing the wake condition reads: one claimable continuity job.
    db.prepare(`INSERT INTO memory_jobs
      (job_id, kind, partition_key, policy_version, priority, state, available_at,
       idempotency_key, created_at, updated_at)
      VALUES ('mode-probe', 'capture_index', 'probe', 'v1', 100, 'pending', ?, 'mode-probe', ?, ?)`)
      .run(now, now, now);
    db.close();
    if (previousHome === undefined) delete process.env.MEMEX_HOME;
    else process.env.MEMEX_HOME = previousHome;

    const result = spawnSync(
      process.execPath,
      [path.join(harness.dir, "scripts", "session-start-maintenance.js")],
      {
        input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "maint", cwd: harness.dir }),
        env: { ...process.env, MEMEX_HOME: home, MEMEX_EMBEDDING_STUB: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(await waitFor(() => harness.recorded().length > 0, 10_000), "maintenance spawned no worker");
    assert.deepEqual(
      harness.recorded().filter((argv) => argv[0] === "continuity-worker.js"),
      [["continuity-worker.js", "--mode=hook"]],
    );
    fs.rmSync(harness.dir, { recursive: true, force: true });
  });

  it("memex jobs drain runs the worker with --mode=foreground", async () => {
    const harness = scriptHarness();
    fs.cpSync(path.join(ROOT, "cli"), path.join(harness.dir, "cli"), { recursive: true });

    const result = spawnSync(
      process.execPath,
      [path.join(harness.dir, "cli", "memex.js"), "jobs", "drain", "--max", "1", "--json"],
      {
        env: { ...process.env, MEMEX_HOME: home, MEMEX_EMBEDDING_STUB: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const [argv] = harness.recorded();
    assert.ok(argv, "jobs drain ran no worker");
    assert.ok(argv.includes("--mode=foreground"), `drain must run in foreground mode: ${JSON.stringify(argv)}`);
    assert.ok(!argv.includes("--mode=hook"));
    // #156's contract is untouched by the new flag.
    assert.deepEqual(argv.filter((arg) => arg !== "--mode=foreground"),
      ["continuity-worker.js", "--max", "1", "--json"]);
    fs.rmSync(harness.dir, { recursive: true, force: true });
  });
});
