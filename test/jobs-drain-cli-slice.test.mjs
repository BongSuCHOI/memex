// Issue #156 — `memex jobs drain` contract.
//
// The defect: `memex recover` / `memex jobs retry` / `memex model-work resume`
// and docs/GUIDE.md all told the user to run `memex-continuity-worker`, which is
// an npm `bin` — it exists only under `node_modules/.bin` of an `npm pack`
// install. The supported install (Codex plugin cache + the `memex` shim) exposes
// ONLY `memex`, so the observed failure was `command not found` with a
// capsule_update job sitting in retry and no supported way to drain it.
//
// What this slice proves:
//   - `memex jobs drain --max 1 --json` runs the worker HERE (foreground) and
//     drains exactly ONE claimable job out of two, exit 0, stdout = one JSON array
//   - the `--max` contract: usage error (exit 2) for missing/non-numeric/
//     non-integer/<1, and a clamp to 32 above the worker's ceiling
//   - every recovery hint now names `memex jobs drain` and none names
//     `memex-continuity-worker`
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?!\/)/, "/")),
  "..",
);
const CLI = path.join(ROOT, "cli", "memex.js");

let tmpRoot;
let home;
let dbPath;
let codexBin;
const savedEnv = {};
const ENV_KEYS = [
  "MEMEX_HOME",
  "MEMEX_EMBEDDING_STUB",
  "MEMEX_ALLOWED_TRANSCRIPT_ROOTS",
  "MEMEX_CODEX_BIN",
];

// A deterministic, model-free Capsule patch: the fake provider below answers
// with exactly this, so no real model is ever called.
const PATCH = {
  objective: "Maintain continuity",
  currentState: "Captured work",
  verifiedProgress: [],
  hypotheses: [],
  blockers: [],
  openQuestions: [],
  nextActions: ["Verify the next step"],
  touchedAreas: [],
  carryFactRevisions: [],
  sourceExchangeIds: [],
};

function runMemex(args, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      MEMEX_HOME: home,
      MEMEX_EMBEDDING_STUB: "1",
      MEMEX_ALLOWED_TRANSCRIPT_ROOTS: tmpRoot,
      MEMEX_CODEX_BIN: codexBin,
      MEMEX_CODEX_EXEC_TIMEOUT_MS: "15000",
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Same environment as runMemex, but stderr is observable on success too. */
function spawnMemex(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      MEMEX_HOME: home,
      MEMEX_EMBEDDING_STUB: "1",
      MEMEX_ALLOWED_TRANSCRIPT_ROOTS: tmpRoot,
      MEMEX_CODEX_BIN: codexBin,
      MEMEX_CODEX_EXEC_TIMEOUT_MS: "15000",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function openDb() {
  return import(path.join(ROOT, "dist", "db.js")).then(({ initDatabase }) =>
    initDatabase({ dbPath }),
  );
}

function capsuleJobStates(db) {
  return db
    .prepare(
      "SELECT job_id, state FROM memory_jobs WHERE kind = 'capsule_update' ORDER BY job_id",
    )
    .all();
}

/**
 * Two claimable `capsule_update` jobs in two distinct workstreams (one project
 * each — a single project would collapse into one workstream, and then `--max 1`
 * would pass even with the flag dropped). The model-free P0 `capture_index`
 * jobs are marked completed, as in test/continuity-evidence.test.ts, so the only
 * claimable work is the capsule lane this command is meant to drain.
 */
async function seedTwoClaimableCapsuleJobs() {
  const { initDatabase, insertExchange } = await import(
    path.join(ROOT, "dist", "db.js")
  );
  const { ensureSessionMemoryState, captureTranscriptPrefix, scheduleCapsuleBacklog } =
    await import(path.join(ROOT, "dist", "continuity-core.js"));
  const db = initDatabase({ dbPath });
  const vector = new Array(384).fill(0.01);
  for (const session of ["drain-a", "drain-b"]) {
    const project = path.join(tmpRoot, `project-${session}`);
    fs.mkdirSync(project, { recursive: true });
    const transcript = path.join(tmpRoot, `${session}.jsonl`);
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: "session_meta", payload: { id: session, cwd: project } }) + "\n",
    );
    ensureSessionMemoryState(db, { sessionId: session, project });
    insertExchange(
      db,
      {
        id: `${session}-1`,
        sessionId: session,
        project,
        cwd: project,
        archivePath: transcript,
        timestamp: new Date().toISOString(),
        userMessage: "question",
        assistantMessage: "answer",
        lineStart: 2,
        lineEnd: 2,
      },
      vector,
    );
    fs.appendFileSync(
      transcript,
      JSON.stringify({ type: "event_msg", payload: { type: "note", text: "x" } }) + "\n",
    );
    captureTranscriptPrefix(db, {
      sessionId: session,
      project,
      transcriptPath: transcript,
      kind: "final",
    });
  }
  db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
  scheduleCapsuleBacklog(db);
  const jobs = capsuleJobStates(db);
  db.close();
  assert.equal(jobs.length, 2, "the fixture must offer MORE work than --max 1");
  for (const job of jobs) assert.equal(job.state, "pending");
  return jobs;
}

function writeFakeCodex() {
  const bin = path.join(tmpRoot, "fake-codex");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(
      JSON.stringify(PATCH),
    )} } }));
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mb-jobs-drain-"));
  home = path.join(tmpRoot, "home");
  dbPath = path.join(home, "conversation-index", "db.sqlite");
  codexBin = writeFakeCodex();
  // The in-process seeding below must never resolve the developer's real data
  // root, so pin the isolated one for this process too.
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.MEMEX_HOME = home;
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = tmpRoot;
  process.env.MEMEX_CODEX_BIN = codexBin;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memex jobs drain (#156)", () => {
  it("--max 1 --json drains exactly one of two claimable jobs and prints one JSON array", async () => {
    const before = await seedTwoClaimableCapsuleJobs();

    const stdout = runMemex(["jobs", "drain", "--max", "1", "--json"]);

    // A1: stdout is EXACTLY one JSON array — no header, no worker line.
    const results = JSON.parse(stdout);
    assert.ok(Array.isArray(results), "stdout must parse as an array");
    assert.equal(results.length, 1);
    assert.equal(results[0].kind, "capsule_update");
    assert.equal(results[0].state, "completed");

    const db = await openDb();
    const after = capsuleJobStates(db);
    db.close();
    const changed = after.filter(
      (row, index) => row.state !== before[index].state,
    );
    assert.equal(changed.length, 1, `exactly one job may change state: ${JSON.stringify(after)}`);
    assert.equal(changed[0].job_id, results[0].jobId);
    assert.equal(
      after.filter((row) => row.state === "pending").length,
      1,
      "the second job must stay claimable for the next drain",
    );
  });

  it("without --json the foreground header is on stdout and the run still drains", async () => {
    await seedTwoClaimableCapsuleJobs();
    const stdout = runMemex(["jobs", "drain", "--max", "1"]);
    assert.match(stdout, /Running Continuity worker in foreground \(max 1 job\)\.\.\./);
    const db = await openDb();
    const after = capsuleJobStates(db);
    db.close();
    assert.equal(after.filter((row) => row.state === "pending").length, 1);
  });

  for (const [label, argv] of [
    ["a missing value", ["jobs", "drain", "--max"]],
    ["a flag where the value belongs", ["jobs", "drain", "--max", "--json"]],
    ["a non-numeric value", ["jobs", "drain", "--max", "abc"]],
    ["a non-integer value", ["jobs", "drain", "--max", "1.5"]],
    ["zero", ["jobs", "drain", "--max", "0"]],
    ["a negative value", ["jobs", "drain", "--max", "-3"]],
  ]) {
    it(`--max rejects ${label} with exit 2 and a usage line`, () => {
      try {
        runMemex(argv);
        assert.fail("expected the --max usage exit code");
      } catch (err) {
        assert.equal(err.status, 2, err.stderr);
        assert.match(err.stderr, /--max must be an integer >= 1/);
        assert.match(err.stderr, /Usage: memex jobs drain \[--max <n>\] \[--json\]/);
        assert.equal(err.stdout, "", "a usage error must not start the worker");
      }
    });
  }

  it("--max above the worker ceiling is clamped to 32, says so on stderr, and still drains", async () => {
    await seedTwoClaimableCapsuleJobs();
    const result = spawnMemex(["jobs", "drain", "--max", "100", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /memex jobs drain: --max 100 clamped to 32 \(the worker's per-run ceiling\)/,
    );
    const results = JSON.parse(result.stdout);
    assert.equal(results.length, 2, "a clamped ceiling still drains everything claimable");
    assert.ok(
      result.stdout.trim().startsWith("[") && result.stdout.trim().endsWith("]"),
      "stdout stays a single JSON array even when stderr carries the clamp note",
    );
  });

  // `drain` spends model calls and changes durable state, so an argument it
  // does not implement must stop it, not be ignored. `--dry-run` is the case
  // that matters: it reads as "show me what it would do".
  for (const [label, argv] of [
    ["--dry-run", ["jobs", "drain", "--dry-run", "--json"]],
    ["an unknown flag", ["jobs", "drain", "--all-dead"]],
    ["a positional argument", ["jobs", "drain", "foo"]],
  ]) {
    it(`rejects ${label} with exit 2 before touching anything`, () => {
      try {
        runMemex(argv);
        assert.fail("expected the unsupported-argument exit code");
      } catch (err) {
        assert.equal(err.status, 2, err.stderr);
        assert.match(err.stderr, /memex jobs drain: unsupported argument/);
        assert.match(err.stderr, /Usage: memex jobs drain \[--max <n>\] \[--json\]/);
        assert.equal(err.stdout, "", "nothing may reach stdout");
      }
      assert.equal(
        fs.existsSync(dbPath),
        false,
        "a rejected invocation must not open or create the database",
      );
    });
  }

  it("jobs and recover help name 'memex jobs drain' and no npm-only bin", () => {
    const jobsHelp = runMemex(["jobs", "--help"]);
    assert.match(jobsHelp, /memex jobs drain \[--max <n>\] \[--json\]/);
    assert.doesNotMatch(jobsHelp, /memex-continuity-worker/);

    const recoverHelp = runMemex(["recover", "--help"]);
    assert.match(recoverHelp, /memex jobs drain/);
    assert.doesNotMatch(recoverHelp, /memex-continuity-worker/);

    const top = runMemex(["--help"]);
    assert.match(top, /jobs\s+Inspect and recover memory jobs: list\|show\|retry\|dismiss\|drain/);
    assert.doesNotMatch(top, /memex-continuity-worker/);
  });

  it("the recover/retry epilogue points at 'memex jobs drain'", async () => {
    await seedTwoClaimableCapsuleJobs();
    const db = await openDb();
    db.prepare("UPDATE memory_jobs SET state = 'dead' WHERE kind = 'capsule_update'").run();
    db.close();

    const stdout = runMemex(["recover", "--all-dead"]);
    assert.match(stdout, /Run the worker to drain the recovered work:/);
    assert.match(stdout, /memex jobs drain/);
    assert.doesNotMatch(stdout, /memex-continuity-worker/);
  });

  it("model-work resume prints 'memex jobs drain' for a rebound capsule job (A4)", async () => {
    const [job] = await seedTwoClaimableCapsuleJobs();
    const { bindMemoryJobToBudget, getOrCreateAutomaticMaintenanceModelBudget } =
      await import(path.join(ROOT, "dist", "model-budget.js"));
    const db = await openDb();
    const created = new Date(Date.now() - 3 * 60 * 60_000);
    const budget = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { deadlineAt: new Date(created.getTime() + 900_000).toISOString() },
      now: created,
    });
    bindMemoryJobToBudget(db, {
      jobId: job.job_id,
      budgetId: budget.budgetId,
      parentWaveId: budget.parentWaveId,
    });
    db.close();

    const stdout = runMemex(["model-work", "resume", budget.budgetId, "--new-run"]);
    assert.match(stdout, /Rebound lease-free jobs: 1/);
    assert.match(stdout, /memex jobs drain/);
    assert.doesNotMatch(stdout, /memex-continuity-worker/);
  });
});
