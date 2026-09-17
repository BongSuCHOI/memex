// memex backfill CLI contract (v0.2 UX):
//   - default execution mode is FOREGROUND (completion observable from exit code)
//   - 'all' orchestrates extract -> ontology -> embeddings -> receipts
//     sequentially, stopping at the first failure (receipts is model-free, #45)
//   - --background detaches (kept as opt-in); output only reports start
//   - --foreground is accepted as a deprecated no-op for pre-v0.2 scripts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?!\/)/, "/")),
  "..",
);
const CLI = path.join(ROOT, "cli", "memex.js");

let tmpRoot;

function runMemex(args, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      MEMEX_HOME: path.join(tmpRoot, "home"),
      MEMEX_SESSIONS_DIR: path.join(tmpRoot, "sessions"),
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function seedPendingExtraction() {
  const home = path.join(tmpRoot, "home");
  const dbPath = path.join(home, "conversation-index", "db.sqlite");
  const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
  const db = initDatabase({ dbPath });
  const insert = db.prepare(`
    INSERT INTO exchanges (
      id, project, timestamp, user_message, assistant_message,
      archive_path, line_start, line_end, session_id, cwd
    ) VALUES (?, '/tmp/project', ?, 'question', 'answer', '/tmp/source.jsonl', 1, 2, ?, '/tmp/project')
  `);
  for (const sessionId of ["pending-a", "pending-b"]) {
    insert.run(`${sessionId}-1`, "2026-09-09T00:00:00.000Z", sessionId);
    insert.run(`${sessionId}-2`, "2026-09-09T00:01:00.000Z", sessionId);
  }
  // Below the min-exchanges policy gate: visible in status as excluded, never
  // counted as deferred work the backfill can process.
  insert.run("excluded-1", "2026-09-09T00:02:00.000Z", "excluded");
  db.close();

  // Keep the embedding stage deterministic and model-free. A live owner makes
  // the worker defer to the existing process, after which the CLI reads the
  // durable backlog instead of trusting the worker's zero exit code.
  fs.writeFileSync(
    path.join(home, "conversation-index", "reembed.lock"),
    String(process.pid),
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mb-backfill-cli-"));
  fs.mkdirSync(path.join(tmpRoot, "sessions"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memex backfill CLI 계약", () => {
  it('unknown target prints usage including "all" and fails', () => {
    let stderr = "";
    try {
      runMemex(["backfill", "bogus"]);
      assert.fail("expected nonzero exit");
    } catch (err) {
      assert.equal(err.status, 1);
      stderr = err.stderr;
    }
    assert.match(
      stderr,
      /Usage: memex backfill <all\|extract\|ontology\|embeddings\|receipts>/,
    );
    assert.match(stderr, /\[--background\]/);
  });

  it("missing target also fails with usage", () => {
    try {
      runMemex(["backfill"]);
      assert.fail("expected nonzero exit");
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /Usage: memex backfill/);
    }
  });

  it("default (no flag) runs every stage to completion in-process", () => {
    const out = runMemex(["backfill", "all"], {
      MEMEX_EMBEDDING_STUB: "1",
    });
    for (const stage of ["extract", "ontology", "embeddings", "receipts"]) {
      assert.match(
        out,
        new RegExp(`Running ${stage} backfill in foreground\\.\\.\\.`),
      );
    }
    assert.match(out, /All backfill stages completed; no outstanding work remains\./);
    assert.doesNotMatch(out, /another worker is running/);
    assert.ok(
      fs.existsSync(
        path.join(tmpRoot, "home", "conversation-index", "db.sqlite"),
      ),
    );
  });

  it("returns partial status and exact processable deferred count", async () => {
    await seedPendingExtraction();
    try {
      runMemex(["backfill", "all"], { BACKFILL_EXTRACT_MAX: "0" });
      assert.fail("expected partial-completion exit code");
    } catch (err) {
      assert.equal(err.status, 2);
      assert.match(
        err.stdout,
        /Backfill completed with deferred work: 8 item\(s\) remain \(extract=2, ontology=0, embeddings=6, receipts=0\)\./,
      );
      assert.match(err.stdout, /Check progress: memex status/);
      assert.doesNotMatch(err.stdout, /All backfill stages completed/);
    }
  });

  it("retry backoff still exits 2 and is reported as deferred, not as a handoff", async () => {
    // 이슈 #11 + #12 의 관측 상태를 그대로 재현한다: lease_owner 는 NULL 이고
    // 러너도 없는데 available_at 이 미래라 선점이 거절된다. exit 2 계약("완료했지만
    // 이연된 작업이 남음")은 그대로여야 하고, 문구는 "다른 러너가 처리 중"이면 안 된다.
    await seedPendingExtraction();
    const dbPath = path.join(tmpRoot, "home", "conversation-index", "db.sqlite");
    const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
    const { ensureExtractionTarget } = await import(
      path.join(ROOT, "dist", "continuity-store.js")
    );
    const db = initDatabase({ dbPath });
    const due = new Date(Date.now() + 3_600_000).toISOString();
    for (const sessionId of ["pending-a", "pending-b"]) {
      const target = ensureExtractionTarget(db, {
        sessionId,
        project: "/tmp/project",
      });
      assert.ok(target, `expected an extraction target for ${sessionId}`);
      db.prepare(
        "UPDATE memory_jobs SET state = 'retry', attempts = 1, available_at = ? WHERE job_id = ?",
      ).run(due, target.jobId);
    }
    db.close();

    try {
      runMemex(["backfill", "extract"]);
      assert.fail("expected deferred-work exit code");
    } catch (err) {
      assert.equal(err.status, 2);
      assert.match(err.stdout, /DEFERRED \(retry backoff until /);
      assert.match(err.stdout, /backoff-deferred 2 — 재시도 대기, 최이른 재시도 /);
      assert.doesNotMatch(err.stdout, /HANDOFF/);
      assert.doesNotMatch(err.stdout, /다른 러너가 처리 중/);
      assert.match(err.stdout, /Backfill completed with deferred work/);
    }
  });

  /**
   * Shared fixture for the two budget cases below — issue #14's observed
   * state: the automatic budget's deadline has passed, its durable state is
   * still `active`, and pending extraction jobs are bound to it.
   */
  async function seedClockDeadAutomaticBudget() {
    await seedPendingExtraction();
    const dbPath = path.join(tmpRoot, "home", "conversation-index", "db.sqlite");
    const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
    const { ensureExtractionTarget } = await import(
      path.join(ROOT, "dist", "continuity-store.js")
    );
    const { bindMemoryJobToBudget, getOrCreateAutomaticMaintenanceModelBudget } =
      await import(path.join(ROOT, "dist", "model-budget.js"));
    const db = initDatabase({ dbPath });
    const created = new Date(Date.now() - 3 * 60 * 60_000);
    const budget = getOrCreateAutomaticMaintenanceModelBudget(db, {
      parentWaveId: "maintenance",
      limits: { deadlineAt: new Date(created.getTime() + 900_000).toISOString() },
      now: created,
    });
    assert.equal(
      db
        .prepare("SELECT state FROM model_work_budgets WHERE budget_id = ?")
        .get(budget.budgetId).state,
      "active",
      "the fixture must reproduce the issue's durable state, not its fix",
    );
    const jobIds = [];
    for (const sessionId of ["pending-a", "pending-b"]) {
      const target = ensureExtractionTarget(db, {
        sessionId,
        project: "/tmp/project",
      });
      assert.ok(target, `expected an extraction target for ${sessionId}`);
      bindMemoryJobToBudget(db, {
        jobId: target.jobId,
        budgetId: budget.budgetId,
        parentWaveId: budget.parentWaveId,
      });
      jobIds.push(target.jobId);
    }
    db.close();
    return { budget, jobIds, dbPath };
  }

  function readBudgetState(dbPath, jobIds, budgetId) {
    // Read-only look at the durable outcome; better-sqlite3 via dist is fine here.
    return import(path.join(ROOT, "dist", "db.js")).then(({ initDatabase }) => {
      const db = initDatabase({ dbPath });
      try {
        const old = db
          .prepare("SELECT state, exhausted_reason FROM model_work_budgets WHERE budget_id = ?")
          .get(budgetId);
        const jobs = jobIds.map((jobId) =>
          db
            .prepare(
              `SELECT j.budget_id AS budget_id, b.root_wave_id AS root_wave_id, b.state AS state
               FROM memory_jobs j LEFT JOIN model_work_budgets b ON b.budget_id = j.budget_id
               WHERE j.job_id = ?`,
            )
            .get(jobId),
        );
        return { old, jobs };
      } finally {
        db.close();
      }
    });
  }

  it("a foreground run settles a clock-dead automatic budget and moves its jobs onto its own backfill run (#146)", async () => {
    const { budget, jobIds, dbPath } = await seedClockDeadAutomaticBudget();

    // The provider is absent in this harness, so extraction itself defers as
    // transient — what this case proves is that the operator's command no
    // longer stops on the hook lineage's spent run.
    let stdout = "";
    try {
      stdout = runMemex(["backfill", "extract"]);
    } catch (err) {
      assert.equal(err.status, 2, err.stderr);
      stdout = err.stdout;
    }
    assert.match(
      stdout,
      /backfill-extract: 이 실행 전용 model run backfill(?:#\d+)? \([0-9a-f-]+\) — 소진된 예산에 묶여 있던 job 2건을 이 run 으로 이관/,
    );
    assert.doesNotMatch(stdout, /DEFERRED \(budget_exhausted/);
    assert.doesNotMatch(stdout, /model-work resume/);

    const after = await readBudgetState(dbPath, jobIds, budget.budgetId);
    assert.deepEqual(after.old, { state: "exhausted", exhausted_reason: "deadline" });
    for (const job of after.jobs) {
      assert.notEqual(job.budget_id, budget.budgetId);
      assert.equal(job.root_wave_id, "backfill");
    }

    // The explicit resume still works on the settled budget; nothing is left on it.
    const resumed = runMemex(["model-work", "resume", budget.budgetId, "--new-run"]);
    assert.match(resumed, new RegExp(`Previous budget: ${budget.budgetId} \\(exhausted\\)`));
    assert.match(resumed, /Rebound lease-free jobs: 0/);
  });

  it("a pinned budget is not redirected: sessions defer and ONE line names the exact resume command (#14, #146)", async () => {
    const { budget, jobIds, dbPath } = await seedClockDeadAutomaticBudget();

    let stdout = "";
    try {
      runMemex(["backfill", "extract"], { MEMEX_MODEL_BUDGET_ID: budget.budgetId });
      assert.fail("expected deferred-work exit code");
    } catch (err) {
      assert.equal(err.status, 2, err.stderr);
      stdout = err.stdout;
    }
    assert.doesNotMatch(stdout, /이 실행 전용 model run/);
    assert.match(stdout, /session pending-[ab]: DEFERRED \(budget_exhausted: deadline\)/);
    assert.match(stdout, /budget-exhausted \d+ —/);
    const resume = `memex model-work resume ${budget.budgetId} --new-run`;
    const escaped = resume.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      stdout,
      new RegExp(
        `backfill-extract: model work budget ${budget.budgetId}(?: \\([^)]+\\))? is exhausted \\(deadline\\); 2 session\\(s\\) deferred — resume: ${escaped}`,
      ),
    );
    // Issue #146: the guidance is printed exactly once, not per session.
    assert.equal(stdout.split(resume).length - 1, 1);

    const after = await readBudgetState(dbPath, jobIds, budget.budgetId);
    assert.equal(after.old.state, "exhausted");
    for (const job of after.jobs) assert.equal(job.budget_id, budget.budgetId);

    // And that command must actually work — this is issue #14 itself.
    const resumed = runMemex(["model-work", "resume", budget.budgetId, "--new-run"]);
    assert.match(resumed, new RegExp(`Previous budget: ${budget.budgetId} \\(exhausted\\)`));
    assert.match(resumed, /Rebound lease-free jobs: 2/);
  });

  it("a foreground ontology stage also gets its own backfill run instead of the spent automatic one (#153)", async () => {
    const { budget } = await seedClockDeadAutomaticBudget();
    let stdout = "";
    try {
      stdout = runMemex(["backfill", "ontology"]);
    } catch (err) {
      assert.equal(err.status, 2, err.stderr);
      stdout = err.stdout;
    }
    assert.match(stdout, /backfill-ontology: 이 실행 전용 model run backfill(?:#\d+)? \([0-9a-f-]+\)/);
    assert.doesNotMatch(stdout, /model budget exhausted/);
    assert.doesNotMatch(stdout, new RegExp(budget.budgetId));
  });

  it("returns failure when a worker reports a fatal error", () => {
    try {
      runMemex(["backfill", "ontology"], {
        MEMEX_MODEL_BUDGET_ID: "missing-budget",
      });
      assert.fail("expected worker failure exit code");
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(err.stdout, /model budget missing-budget does not exist/);
      // #114: the stage's exit code and its last output travel into the failure
      // line, so the reason is visible without reading the worker's own log.
      assert.match(err.stderr, /ontology backfill failed: /);
      assert.match(err.stderr, /Command failed with exit code 1/);
      assert.match(err.stderr, /last output: .*model budget missing-budget does not exist/);
      assert.doesNotMatch(err.stdout, /completed/);
    }
  });

  it("--foreground remains accepted as deprecated no-op", () => {
    const out = runMemex(["backfill", "extract", "--foreground"]);
    assert.match(out, /Running extract backfill in foreground\.\.\./);
  });

  it("--background detaches and only claims to have started", () => {
    const out = runMemex(["backfill", "extract", "--background"]);
    assert.match(
      out,
      /started in background \(pid \d+\)\. Check progress: memex status/,
    );
    // No completion evidence in background mode's own output.
    assert.doesNotMatch(out, /completed/);
  });

  it("help text documents the orchestrated surface", () => {
    const out = runMemex(["--help"]);
    assert.match(
      out,
      /backfill\s+Run extract\/ontology\/embeddings\/receipts backlog explicitly \('all' runs each stage in order\)/,
    );
  });
});
