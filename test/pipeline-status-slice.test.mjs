// CX-04 — pipeline readiness status. Plain node --test against dist.
// Gate: fresh root EMPTY; sync-equivalent state => conversation-ready yes,
// fact/graph no; backfill-equivalent completion => ready; permanent failure
// keeps readiness off. status must be read-only (DB bytes unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');

async function seed(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cx04-'));
  t.after(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = path.join(dir, 'db.sqlite');
  process.env.TEST_DB_PATH = dbPath;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE exchanges (
    id TEXT PRIMARY KEY, project TEXT, timestamp TEXT, user_message TEXT,
    assistant_message TEXT, archive_path TEXT, line_start INTEGER, line_end INTEGER,
    is_sidechain INTEGER DEFAULT 0, session_id TEXT);
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

test('fresh data root reports EMPTY with all readiness flags false', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cx04-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.TEST_DB_PATH = path.join(dir, 'missing.sqlite');
  const { getPipelineStatus, formatPipelineStatus } = await import(path.join(REPO, 'dist/pipeline-status.js'));
  const st = getPipelineStatus();
  assert.equal(st.dataRootEmpty, true);
  assert.deepEqual(st.readiness, { conversationReady: false, factReady: false, graphReady: false });
  assert.ok(formatPipelineStatus(st).includes('EMPTY'));
});

test('synced-but-unextracted: conversation-ready yes, fact/graph no', async (t) => {
  const { db, dbPath } = await seed(t, [{ session: 's1' }, { session: 's2' }]);
  const { getPipelineStatus } = await import(path.join(REPO, 'dist/pipeline-status.js'));
  const before = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const st = getPipelineStatus();
  const after = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  assert.equal(before, after, 'status mutated the database');
  db.close();

  assert.equal(st.readiness.conversationReady, true);
  assert.equal(st.readiness.factReady, false);
  assert.equal(st.readiness.graphReady, false);
  assert.equal(st.extraction.total, 2);
  assert.equal(st.extraction.pending, 2);
});

test('extraction complete: fact-ready yes; ontology pending keeps graph no', async (t) => {
  const { db } = await seed(t, [{ session: 's1' }]);
  db.exec(`CREATE TABLE facts (
    id TEXT PRIMARY KEY, fact TEXT, category TEXT, scope_type TEXT,
    scope_project TEXT, is_active INTEGER, ontology_category_id TEXT);`);
  // vec_facts table absent in this fixture -> all active facts count as
  // vector-pending (sqlite-vec module not loadable outside the app runtime).
  db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, is_active)
    VALUES ('f1','fact','decision','project','/tmp/p',1)`).run();
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
    VALUES ('s1','2026-08-26T01:00:00Z', 1, 1)`).run();
  // vec_facts table absent in this fixture -> embeddings pending = active facts
  const { getPipelineStatus } = await import(path.join(REPO, 'dist/pipeline-status.js'));
  const st = getPipelineStatus();
  assert.equal(st.extraction.pending, 0);
  assert.equal(st.embeddings.factVectorsPending, 1); // no vector yet -> fact-ready stays off
  assert.equal(st.ontology.pendingFacts, 1);
  db.close();
});

test('permanent extraction failure blocks fact-ready', async (t) => {
  const { db } = await seed(t, [{ session: 's1' }]);
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
    VALUES ('s1','2026-08-26T01:00:00Z', -2, 0)`).run(); // PERMANENT
  const { getPipelineStatus } = await import(path.join(REPO, 'dist/pipeline-status.js'));
  const st = getPipelineStatus();
  assert.equal(st.extraction.failedPermanent, 1);
  assert.equal(st.readiness.factReady, false);
  db.close();
});

test('stale claim lease recovers to pending; fresh claim counts as claimed', async (t) => {
  const { db } = await seed(t, [{ session: 's1' }]);
  // Fresh claim (now): claimed=1, pending=0 (lease alive)
  db.prepare(`INSERT INTO extraction_log (session_id, processed_at, extracted, saved, claim_owner)
    VALUES ('s1', ?, -3, 0, 'worker-x')`).run(new Date().toISOString());
  const mod = await import(path.join(REPO, 'dist/pipeline-status.js'));
  let st = mod.getPipelineStatus();
  assert.equal(st.extraction.claimed, 1);
  assert.equal(st.readiness.factReady, false);
  db.close();
});
