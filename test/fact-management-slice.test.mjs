// CX-07 — transactional fact management service. Plain node --test on dist.
// AC-FACT-05: edit creates revision + fresh embedding consistently;
// deactivate removes from vector index; restore recovers it; hard delete is
// exact-ID + confirm gated; failures produce zero partial mutations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cx07-'));
  t.after(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const dbPath = path.join(dir, 'db.sqlite');
  process.env.TEST_DB_PATH = dbPath;
  const { initDatabase } = await import(path.join(REPO, 'dist/db.js'));
  const db = initDatabase();
  const { insertFact } = await import(path.join(REPO, 'dist/fact-db.js'));
  const id = insertFact(db, {
    fact: 'The API uses cursor pagination.',
    category: 'decision',
    scope_type: 'project',
    scope_project: '/tmp/p',
    source_exchange_ids: ['ex-1'],
    embedding: new Array(384).fill(0.1),
    embedding_kr: null,
    embedding_version: 1,
  });
  return { db, id };
}

test('edit writes revision + fresh embedding atomically; ontology goes observable-pending', async (t) => {
  const { db, id } = await setup(t);
  // classify first and set attempt counters so we can observe the pending transition
  db.prepare("UPDATE facts SET ontology_category_id = 'cat-old', ontology_attempts = 2, consolidation_attempts = 1, needs_consolidation = 0 WHERE id = ?").run(id);

  // create a relation to verify stale cleanup
  const { insertFact } = await import(path.join(REPO, 'dist/fact-db.js'));
  const { createRelation } = await import(path.join(REPO, 'dist/ontology-db.js'));
  const id2 = insertFact(db, {
    fact: 'Another related fact.',
    category: 'decision',
    scope_type: 'project',
    scope_project: '/tmp/p',
    source_exchange_ids: ['ex-2'],
  });
  createRelation(db, id, 'SUPPORTS', id2, 'initial relation');

  const fm = await import(path.join(REPO, 'dist/fact-management.js'));

  const beforeVec = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get(id);
  assert.ok(beforeVec, 'vector should exist after seed');

  const r = await fm.editFact(db, id, {
    text: 'The API uses keyset pagination with rotating encrypted cursors.',
    reason: 'decision updated after review',
  });
  assert.equal(r.revisionId.includes('-'), true);
  assert.equal(r.ontologyPending, true);
  assert.equal(r.affectedRelations, 1, 'Stale relation should be counted and removed');

  const row = db.prepare('SELECT fact, embedding, ontology_category_id, ontology_attempts, consolidation_attempts, needs_consolidation FROM facts WHERE id = ?').get(id);
  assert.ok(row.fact.startsWith('The API uses keyset'));
  assert.ok(row.embedding !== null, 'facts.embedding BLOB must be updated');
  assert.equal(row.ontology_category_id, null); // observable pending
  assert.equal(row.ontology_attempts, 0, 'ontology_attempts must be reset to 0');
  assert.equal(row.consolidation_attempts, 0, 'consolidation_attempts must be reset to 0');
  assert.equal(row.needs_consolidation, 1, 'semantic edit must requeue consolidation');

  // Verify relations are cleaned up
  const remainingRel = db.prepare('SELECT COUNT(*) c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(id, id).c;
  assert.equal(remainingRel, 0, 'Stale relation must be deleted');

  const revs = fm.factHistory(db, id);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].reason, 'decision updated after review');
  assert.equal(revs[0].previous_fact, 'The API uses cursor pagination.');

  const afterVec = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get(id);
  assert.ok(afterVec, 'vector must be refreshed');
  assert.notEqual(Buffer.from(afterVec.embedding).compare(Buffer.from(beforeVec.embedding)), 0, 'embedding bytes unchanged');
  db.close();
});


test('deactivate removes from search/vector; restore brings both back', async (t) => {
  const { db, id } = await setup(t);
  const fm = await import(path.join(REPO, 'dist/fact-management.js'));

  fm.deactivateFactTransactional(db, id);
  assert.deepEqual(db.prepare('SELECT is_active, needs_consolidation FROM facts WHERE id = ?').get(id), {
    is_active: 0,
    needs_consolidation: 0,
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM vec_facts WHERE id = ?').get(id).c, 0);

  fm.restoreFact(db, id);
  assert.deepEqual(db.prepare('SELECT is_active, needs_consolidation FROM facts WHERE id = ?').get(id), {
    is_active: 1,
    needs_consolidation: 1,
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM vec_facts WHERE id = ?').get(id).c, 1);
  db.close();
});

test('hard delete requires full UUID and explicit confirmation; reports impact', async (t) => {
  const { db, id } = await setup(t);
  const fm = await import(path.join(REPO, 'dist/fact-management.js'));

  assert.throws(() => fm.hardDeleteFact(db, id, { confirm: false }), /confirmation/);
  assert.throws(() => fm.hardDeleteFact(db, 'short-id', { confirm: true }), /exact full UUID/);

  const impact = fm.hardDeleteImpact(db, id);
  assert.equal(impact.exists, true);
  assert.equal(impact.revisions >= 0, true);

  const r = fm.hardDeleteFact(db, id, { confirm: true });
  assert.equal(r.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM facts WHERE id = ?').get(id).c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM vec_facts WHERE id = ?').get(id).c, 0);
  db.close();
});

test('failed edit leaves zero partial mutation (transaction rollback)', async (t) => {
  const { db, id } = await setup(t);
  const fm = await import(path.join(REPO, 'dist/fact-management.js'));
  const beforeFact = db.prepare('SELECT fact, updated_at FROM facts WHERE id = ?').get(id);
  const beforeRevCount = db.prepare('SELECT COUNT(*) c FROM fact_revisions').get().c;

  await assert.rejects(
    () => fm.editFact(db, 'missing-fact-id', { text: 'whatever text' }),
    /not found/,
  );
  await assert.rejects(
    () => fm.editFact(db, id, { text: 'ab' }),
    /too short/,
  );

  const afterFact = db.prepare('SELECT fact, updated_at FROM facts WHERE id = ?').get(id);
  assert.deepEqual(afterFact, beforeFact);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM fact_revisions').get().c, beforeRevCount);
  db.close();
});

test('fact listing defaults to global scope and requires explicit project or all scope', async (t) => {
  const { db, id: projectFactId } = await setup(t);
  const { insertFact } = await import(path.join(REPO, 'dist/fact-db.js'));
  const globalFactId = insertFact(db, {
    fact: 'Global preference.',
    category: 'preference',
    scope_type: 'global',
    scope_project: null,
    source_exchange_ids: ['ex-global'],
  });
  const otherProjectFactId = insertFact(db, {
    fact: 'Other project decision.',
    category: 'decision',
    scope_type: 'project',
    scope_project: '/tmp/other',
    source_exchange_ids: ['ex-other'],
  });
  const fm = await import(path.join(REPO, 'dist/fact-management.js'));

  assert.deepEqual(fm.listFacts(db).map((r) => r.id), [globalFactId]);
  assert.deepEqual(
    new Set(fm.listFacts(db, { project: '/tmp/p' }).map((r) => r.id)),
    new Set([globalFactId, projectFactId]),
  );
  assert.deepEqual(
    new Set(fm.listFacts(db, { scope: 'all' }).map((r) => r.id)),
    new Set([globalFactId, projectFactId, otherProjectFactId]),
  );
  db.close();
});
