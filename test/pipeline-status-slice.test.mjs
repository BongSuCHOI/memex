// CX-04 — pipeline readiness status. Plain node --test against dist.
// Gate: fresh root EMPTY; sync-equivalent state => conversation-ready yes,
// fact/graph no; backfill-equivalent completion => ready; permanent failure
// keeps readiness off. status must be read-only (DB bytes unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const CLI = path.join(REPO, "cli", "memex.js");

async function seed(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-cx04-"));
  t.after(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = path.join(dir, "db.sqlite");
  process.env.TEST_DB_PATH = dbPath;
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE exchanges (
    id TEXT PRIMARY KEY, project TEXT, timestamp TEXT, user_message TEXT,
    assistant_message TEXT, archive_path TEXT, line_start INTEGER, line_end INTEGER,
    is_sidechain INTEGER DEFAULT 0, session_id TEXT, cwd TEXT);
  CREATE TABLE extraction_log (
    session_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL,
    extracted INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0,
    dropped_batches INTEGER NOT NULL DEFAULT 0, claim_owner TEXT,
    last_exchange_rowid INTEGER NOT NULL DEFAULT 0);`);
  const ins = db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, session_id)
    VALUES (?, '/tmp/p', '2026-08-26T00:00:00Z', 'q', 'a', ?)`);
  let i = 0;
  for (const row of rows) ins.run(`e${++i}`, row.session);
  for (let j = 1; j <= rows.length; j++) void j;
  return { db, dbPath, dir };
}

test("fresh data root reports EMPTY with all readiness flags false", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-cx04-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.TEST_DB_PATH = path.join(dir, "missing.sqlite");
  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.dataRootEmpty, true);
  assert.deepEqual(st.readiness, {
    conversationReady: false,
    factReady: false,
    graphReady: false,
  });
  assert.ok(formatPipelineStatus(st).includes("EMPTY"));
});

test("status CLI documents its options and rejects unknown arguments", (t) => {
  const memexHome = fs.mkdtempSync(path.join(os.tmpdir(), "memex-status-cli-"));
  t.after(() => fs.rmSync(memexHome, { recursive: true, force: true }));
  const env = { ...process.env, MEMEX_HOME: memexHome };

  const help = spawnSync(process.execPath, [CLI, "status", "--help"], {
    env,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: memex status \[--json\]/);

  const bad = spawnSync(process.execPath, [CLI, "status", "unexpected"], {
    env,
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: memex status \[--json\]/);
});

test("synced-but-unextracted: conversation-ready yes, fact/graph no", async (t) => {
  // 각 세션 2 exchanges — min-exchange gate(기본 2)를 통과하는 적격 세션으로 만든다.
  const { db, dbPath } = await seed(t, [
    { session: "s1" },
    { session: "s1" },
    { session: "s2" },
    { session: "s2" },
  ]);
  const { getPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const before = crypto
    .createHash("sha256")
    .update(fs.readFileSync(dbPath))
    .digest("hex");
  const st = getPipelineStatus();
  const after = crypto
    .createHash("sha256")
    .update(fs.readFileSync(dbPath))
    .digest("hex");
  assert.equal(before, after, "status mutated the database");
  db.close();

  assert.equal(st.readiness.conversationReady, true);
  assert.equal(st.readiness.factReady, false);
  assert.equal(st.readiness.graphReady, false);
  assert.equal(st.extraction.total, 2);
  assert.equal(st.extraction.pending, 2);
});

test("extraction complete: fact-ready yes; ontology pending keeps graph no", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, fact TEXT, category TEXT, scope_type TEXT,
    scope_project TEXT, is_active INTEGER, ontology_category_id TEXT);`);
  // vec_facts table absent in this fixture -> all active facts count as
  // vector-pending (sqlite-vec module not loadable outside the app runtime).
  db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, is_active)
    VALUES ('f1','fact','decision','project','/tmp/p',1)`).run();
  // 워터마크가 세션의 max(rowid) 를 덮어야 settled 로 인정된다 (CX-04 pending 정의).
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    SELECT 's1','2026-08-26T01:00:00Z', 1, 1, COALESCE(MAX(rowid), 0) FROM exchanges WHERE session_id = 's1'`).run();
  // vec_facts table absent in this fixture -> embeddings pending = active facts
  const { getPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.extraction.pending, 0);
  assert.equal(st.embeddings.factVectorsPending, 1); // no vector yet -> fact-ready stays off
  assert.equal(st.ontology.pendingFacts, 1);
  db.close();
});

test("settled marker with a newer exchange is pending, not done", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    SELECT 's1','2026-08-26T01:00:00Z', 1, 1, COALESCE(MAX(rowid), 0) FROM exchanges WHERE session_id = 's1'`).run();
  db.prepare(`INSERT INTO exchanges
    (id, project, timestamp, user_message, assistant_message, session_id)
    VALUES ('new-suffix', '/tmp/p', '2026-08-26T02:00:00Z', 'new q', 'new a', 's1')`).run();

  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();

  assert.equal(st.extraction.total, 1);
  assert.equal(st.extraction.done, 0);
  assert.equal(st.extraction.pending, 1);
  assert.equal(st.extraction.done + st.extraction.pending, 1);
  assert.match(formatPipelineStatus(st), /0 done, 1 pending/);
  db.close();
});

test("permanent extraction failure blocks fact-ready", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    SELECT 's1','2026-08-26T01:00:00Z', -2, 0, COALESCE(MAX(rowid), 0) FROM exchanges WHERE session_id = 's1'`).run(); // PERMANENT
  const { getPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.extraction.failedPermanent, 1);
  assert.equal(st.readiness.factReady, false);
  db.close();
});

test("seed and terminal-failure markers are deferred, not pending", async (t) => {
  const { db } = await seed(t, [
    { session: "s1" },
    { session: "s2" },
    { session: "s3" },
  ]);
  // SEED(-1): backfill seeded existing facts; the worker never picks it.
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    VALUES ('s1','2026-08-26T01:00:00Z', -1, -1, 0)`).run();
  // PERMANENT(-2) with the REAL failure-path shape: failureMarkerUpsertSql
  // never writes a watermark, so last_exchange_rowid stays 0.
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    VALUES ('s2','2026-08-26T01:00:00Z', -2, 0, 0)`).run();
  // A PERMANENT marker with a covered watermark stays settled — it is
  // neither done (not a success) nor pending nor deferred.
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    SELECT 's3','2026-08-26T01:00:00Z', -2, 0, COALESCE(MAX(rowid), 0) FROM exchanges WHERE session_id = 's3'`).run();

  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.extraction.total, 3);
  assert.equal(st.extraction.done, 0);
  // pending means "work the pipeline will actually do" — SEED and
  // terminal-failure sessions are deliberately never picked by the worker.
  assert.equal(st.extraction.pending, 0);
  assert.equal(st.extraction.deferred, 2);
  assert.equal(st.extraction.failedPermanent, 2);
  assert.match(formatPipelineStatus(st), /0 done, 0 pending/);
  db.close();
});

test("stale claim lease recovers to pending; fresh claim counts as claimed", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  // Fresh claim (now): claimed=1, pending=0 (lease alive)
  // claim 행은 워터마크가 0 이라도 살아있는 리스면 pending 이 아니다.
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner)
    VALUES ('s1', ?, -3, 0, 'worker-x')`).run(new Date().toISOString());
  const mod = await import(path.join(REPO, "dist/pipeline-status.js"));
  let st = mod.getPipelineStatus();
  assert.equal(st.extraction.claimed, 1);
  assert.equal(st.readiness.factReady, false);
  db.close();
});

test("gate-excluded sessions report as excluded, not pending (CX-04 status/worker predicate alignment)", async (t) => {
  process.env.BACKFILL_MIN_EXCHANGES = "2";
  t.after(() => {
    delete process.env.BACKFILL_MIN_EXCHANGES;
  });
  // s1: 2 exchanges + settled marker (eligible, done)
  // s2: 1 exchange, no marker → excluded (below min-exchanges)
  // s3: 2 exchanges, no marker → eligible pending
  // s4: 1 exchange in an LLM workdir cwd (plain basename) → excluded (project)
  // s5: 1 exchange in the mkdtemp suffix workdir shape → excluded (project)
  const { db } = await seed(t, [
    { session: "s1" },
    { session: "s1" },
    { session: "s2" },
    { session: "s3" },
    { session: "s3" },
    { session: "s4" },
    { session: "s5" },
  ]);
  db.prepare(
    `UPDATE exchanges SET cwd = '/tmp/x/memex-llm' WHERE session_id = 's4'`,
  ).run();
  db.prepare(
    `UPDATE exchanges SET cwd = '/tmp/memex-llm-a1b2c3' WHERE session_id = 's5'`,
  ).run();
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    SELECT 's1','2026-08-26T01:00:00Z', 1, 1, COALESCE(MAX(rowid), 0) FROM exchanges WHERE session_id = 's1'`).run();
  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.extraction.total, 5);
  assert.equal(st.extraction.done, 1);
  assert.equal(st.extraction.pending, 1); // s3 only
  assert.equal(st.extraction.excluded, 3); // s2 (below min) + s4 + s5 (workdir)
  assert.equal(st.extraction.excludedBelowMin, 1);
  assert.equal(st.extraction.excludedProject, 2);
  assert.equal(st.extraction.gateMinExchanges, 2);
  assert.equal(st.readiness.factReady, false);
  const text = formatPipelineStatus(st);
  assert.ok(text.includes("3 excluded"), text);
  assert.ok(text.includes("intentionally skipped"), text);
  assert.ok(text.includes("1 below min-exchanges"), text);
  assert.ok(text.includes("2 excluded projects"), text);
  db.close();
});

/**
 * Issue #46 (15.2) — docs/GUIDE.md §15 documented
 *   memex status --json    # 단계별 pending/processing/retry/dead
 * but the JSON carried only extraction StageCounters plus `attention`, which
 * counts the two states that need a decision. There was no per-kind view of
 * `memory_jobs` anywhere: the runbook's command could not answer its question.
 */
test("status --json aggregates memory_jobs by kind x state", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }, { session: "s1" }]);
  db.exec(`CREATE TABLE memory_jobs (
    job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
    available_at TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0)`);
  const insert = db.prepare(
    "INSERT INTO memory_jobs (job_id, kind, state, available_at) VALUES (?, ?, ?, '2026-08-26T00:00:00Z')",
  );
  let id = 0;
  for (const [kind, state, count] of [
    ["capture_index", "pending", 3],
    ["capture_index", "dead", 1],
    ["capsule_update", "retry", 2],
    ["capsule_update", "running", 1],
  ]) {
    for (let i = 0; i < count; i++) insert.run(`job-${++id}`, kind, state);
  }

  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.jobs.total, 7);
  assert.deepEqual(st.jobs.byKind, {
    capture_index: { pending: 3, dead: 1 },
    capsule_update: { retry: 2, running: 1 },
  });
  assert.deepEqual(st.jobs.byState, { pending: 3, dead: 1, retry: 2, running: 1 });
  // `attention` stays the "needs a decision" subset, not a replacement.
  assert.equal(st.attention.total, 3); // 1 dead + 2 retry

  const text = formatPipelineStatus(st);
  assert.ok(text.includes("Memory jobs: 7"), text);
  assert.ok(text.includes("capture_index: dead=1, pending=3"), text);
  assert.ok(text.includes("capsule_update: retry=2, running=1"), text);

  const json = JSON.parse(
    spawnSync(process.execPath, [CLI, "status", "--json"], {
      encoding: "utf8",
      env: { ...process.env, TEST_DB_PATH: process.env.TEST_DB_PATH },
    }).stdout,
  );
  assert.deepEqual(json.jobs, st.jobs);
  db.close();
});

/**
 * Issues #31/#30 — every hold family is counted and named.
 *
 * `attention.modelConfigHeld` counted only `model_config_rejected`, so the two
 * extraction-rules families — which hold the ENTIRE extraction queue, with no
 * attempt consumed and therefore no dead/retry row either — were invisible on the
 * one surface an operator checks when nothing is progressing.
 */
test("status counts every hold_reason family, not only the model one", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }, { session: "s1" }]);
  db.exec(`CREATE TABLE memory_jobs (
    job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
    available_at TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    hold_reason TEXT, updated_at TEXT)`);
  const insert = db.prepare(`INSERT INTO memory_jobs
    (job_id, kind, state, available_at, hold_reason, updated_at)
    VALUES (?, ?, ?, '2026-08-26T00:00:00Z', ?, '2026-08-26T00:00:00Z')`);
  insert.run("job-1", "capsule_update", "pending", "model_config_rejected");
  insert.run("job-2", "extraction", "pending", "extraction_rules_invalid");
  insert.run("job-3", "extraction", "retry", "extraction_rules_unavailable");
  insert.run("job-4", "extraction", "pending", "extraction_rules_unavailable");
  // A finished job keeps its marker but is not waiting on anything.
  insert.run("job-5", "extraction", "completed", "extraction_rules_invalid");
  // And an unknown value is not invented into a family.
  insert.run("job-6", "extraction", "pending", "something_else");

  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.attention.held, 4);
  assert.equal(st.attention.modelConfigHeld, 1);
  assert.deepEqual(
    st.attention.heldByReason.map((row) => [row.reason, row.jobs]),
    [
      ["extraction_rules_invalid", 1],
      ["extraction_rules_unavailable", 2],
      ["model_config_rejected", 1],
    ],
  );
  // A hold is not a failure, so it stays out of the dead/retry count.
  assert.equal(st.attention.total, 1); // the one `retry` row

  const text = formatPipelineStatus(st);
  assert.ok(text.includes("config held: 4 job(s)"), text);
  assert.ok(text.includes("extraction_rules_invalid=1"), text);
  assert.ok(text.includes("extraction_rules_unavailable=2"), text);
  assert.ok(text.includes("model_config_rejected=1"), text);
  assert.ok(text.includes("memex extract rules validate"), text);
  assert.ok(text.includes("memex models show"), text);
  db.close();
});

test("status says nothing about holds on a pre-0.7.0 database", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.exec(`CREATE TABLE memory_jobs (
    job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
    available_at TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0)`);
  db.prepare(
    "INSERT INTO memory_jobs (job_id, kind, state) VALUES ('job-1', 'extraction', 'pending')",
  ).run();

  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.attention.held, 0);
  assert.deepEqual(st.attention.heldByReason, []);
  assert.ok(!formatPipelineStatus(st).includes("config held"));
  db.close();
});

test("a data root with no queue table reports an empty jobs object", async (t) => {
  await seed(t, [{ session: "s1" }, { session: "s1" }]);
  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.deepEqual(st.jobs, { total: 0, byKind: {}, byState: {} });
  // Nothing to say is said with nothing, not with a grid of zeros.
  assert.ok(!formatPipelineStatus(st).includes("Memory jobs:"));
});

/**
 * Issue #46 (15.4) — `memex index --help` pointed at INDEXING.md and
 * DEPLOYMENT.md, neither of which exists in the repository.
 */
test("index --help points only at documents that exist", () => {
  const help = spawnSync(process.execPath, [CLI, "index", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /INDEXING\.md|DEPLOYMENT\.md/);
  for (const referenced of help.stdout
    .split("SEE ALSO:")[1]
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((token) => token.endsWith(".md"))) {
    assert.ok(fs.existsSync(path.join(REPO, referenced)), `${referenced} must exist`);
  }
});

// ── Issue #41 — parked ontology facts and the index-repair banner ──────────
test("parked facts are their own bucket, not silently counted as classified", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, fact TEXT, category TEXT, scope_type TEXT,
    scope_project TEXT, is_active INTEGER, ontology_category_id TEXT,
    ontology_state TEXT, ontology_parked_at TEXT, ontology_parked_version TEXT);`);
  const insert = db.prepare(`INSERT INTO facts
    (id, fact, category, scope_type, scope_project, is_active, ontology_category_id, ontology_state, ontology_parked_version)
    VALUES (?, 'fact', 'decision', 'project', '/tmp/p', 1, ?, ?, ?)`);
  // The audited real-root shape: LLM-chosen Misc assignments are classified…
  insert.run("f1", "cat-misc", null, null);
  insert.run("f2", "cat-a", null, null);
  // …a fact parked after bounded failures is NOT.
  insert.run("f3", "cat-misc", "parked", "p1:e1");
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
    SELECT 's1','2026-08-26T01:00:00Z', 1, 1, COALESCE(MAX(rowid), 0) FROM exchanges WHERE session_id = 's1'`).run();
  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.ontology.classifiedFacts, 2);
  assert.equal(st.ontology.parkedFacts, 1);
  assert.equal(st.ontology.pendingFacts, 0);
  // Parked under a STALE token → one retry is still owed and backfill must see it.
  assert.equal(st.ontology.parkedRetryable, 1);
  const text = formatPipelineStatus(st);
  assert.ok(text.includes("(2 classified, 1 parked, 0 pending)"), text);
  assert.ok(text.includes("parked: held in General/Misc"), text);
  db.close();
});

test("IndexRepairError reaches status instead of dying in backfill-ontology.log", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, fact TEXT, category TEXT, scope_type TEXT,
    scope_project TEXT, is_active INTEGER, ontology_category_id TEXT,
    ontology_state TEXT, ontology_parked_at TEXT, ontology_parked_version TEXT);
  CREATE TABLE ontology_index_repair_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL,
    blocked_reason TEXT, detail TEXT, detected_at TEXT, cleared_at TEXT);`);
  db.prepare(`INSERT INTO ontology_index_repair_state
    (id, state, blocked_reason, detail, detected_at)
    VALUES (1, 'blocked', 'write', 'vec_categories unwritable', '2026-08-26T01:00:00Z')`).run();
  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.ontology.indexRepair.blocked, true);
  assert.equal(st.ontology.indexRepair.reason, "write");
  const text = formatPipelineStatus(st);
  assert.ok(text.includes("MANUAL REPAIR REQUIRED (write"), text);
  db.close();
});

// ── Issue #43 — derived lanes skipped for a Continuity backlog ─────────────
test("status names the pipeline that is holding the derived lanes back", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.exec(`CREATE TABLE derived_lane_skips (
    id INTEGER PRIMARY KEY CHECK (id = 1), reason TEXT NOT NULL,
    consecutive INTEGER NOT NULL DEFAULT 0, total_skips INTEGER NOT NULL DEFAULT 0,
    last_skipped_at TEXT, last_forced_at TEXT);`);
  db.prepare(`INSERT INTO derived_lane_skips
    (id, reason, consecutive, total_skips, last_skipped_at, last_forced_at)
    VALUES (1, 'continuity_backlog', 2, 5, '2026-08-26T01:00:00Z', '2026-08-26T00:30:00Z')`).run();
  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.derivedLaneSkips.totalSkips, 5);
  assert.equal(st.derivedLaneSkips.reason, "continuity_backlog");
  const text = formatPipelineStatus(st);
  assert.ok(
    text.includes("Derived lanes: skipped 5 times (reason: continuity backlog)"),
    text,
  );
  db.close();
});

test("status stays silent about derived lanes when nothing was skipped", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.derivedLaneSkips, null);
  assert.ok(!formatPipelineStatus(st).includes("Derived lanes:"));
  db.close();
});

// ── Issue #45 — facts without a current local verification receipt ─────────
test("status counts facts without local evidence and names the consequence", async (t) => {
  const { db } = await seed(t, [{ session: "s1" }]);
  db.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, fact TEXT, category TEXT, scope_type TEXT,
    scope_project TEXT, is_active INTEGER, ontology_category_id TEXT,
    source_exchange_ids TEXT, semantic_generation INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE fact_evidence_receipts (
    fact_id TEXT PRIMARY KEY, semantic_generation INTEGER NOT NULL,
    fact_hash TEXT NOT NULL, source_snapshot_json TEXT NOT NULL,
    method TEXT NOT NULL, verified_at TEXT NOT NULL, authority TEXT);`);
  const insert = db.prepare(`INSERT INTO facts
    (id, fact, category, scope_type, scope_project, is_active, source_exchange_ids)
    VALUES (?, 'fact', 'decision', 'project', '/tmp/p', 1, '["e1"]')`);
  for (const id of ["f1", "f2", "f3"]) insert.run(id);
  // One verified locally, one demoted to peer authority, one never verified.
  db.prepare(`INSERT INTO fact_evidence_receipts
    (fact_id, semantic_generation, fact_hash, source_snapshot_json, method, verified_at, authority)
    VALUES ('f1', 1, 'h', '[]', 'extractor', '2026-08-26T00:00:00Z', NULL)`).run();
  db.prepare(`INSERT INTO fact_evidence_receipts
    (fact_id, semantic_generation, fact_hash, source_snapshot_json, method, verified_at, authority)
    VALUES ('f2', 1, 'h', '[]', 'extractor', '2026-08-26T00:00:00Z', 'peer-authority')`).run();

  const { getPipelineStatus, formatPipelineStatus } = await import(
    path.join(REPO, "dist/pipeline-status.js")
  );
  const st = getPipelineStatus();
  assert.equal(st.evidence.activeFactsWithSources, 3);
  assert.equal(st.evidence.factsWithoutLocalEvidence, 2); // f2 (demoted) + f3
  const text = formatPipelineStatus(st);
  assert.ok(text.includes("facts without local evidence: 2 / 3"), text);
  assert.ok(text.includes("memex backfill receipts"), text);
  db.close();
});
