// memex backfill CLI contract (v0.2 UX):
//   - default execution mode is FOREGROUND (completion observable from exit code)
//   - 'all' orchestrates extract -> ontology -> embeddings sequentially,
//     stopping at the first failure
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
      /Usage: memex backfill <all\|extract\|ontology\|embeddings>/,
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
    for (const stage of ["extract", "ontology", "embeddings"]) {
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
        /Backfill completed with deferred work: 8 item\(s\) remain \(extract=2, ontology=0, embeddings=6\)\./,
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

  it("returns failure when a worker reports a fatal error", () => {
    try {
      runMemex(["backfill", "ontology"], {
        MEMEX_MODEL_BUDGET_ID: "missing-budget",
      });
      assert.fail("expected worker failure exit code");
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(err.stdout, /model budget missing-budget does not exist/);
      assert.match(err.stderr, /ontology backfill failed\./);
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
      /backfill\s+Run extract\/ontology\/embeddings backlog explicitly \('all' runs each stage in order\)/,
    );
  });
});
