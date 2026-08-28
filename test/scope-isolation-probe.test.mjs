import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { searchConversations, getKnowledgeContext } from '../dist/search.js';
import { getRelatedFacts, getOntologyTree, createDomain, createCategory, createRelation } from '../dist/ontology-db.js';
import { insertFact } from '../dist/fact-db.js';

test('Phase 1 Probe: Project Scope Isolation & Graph Leaks', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-scope-probe-'));
  process.env.MEMORY_BANK_HOME = tmpDir;

  const db = initDatabase();

  // 1. Seed exchanges for ProjA and ProjB
  db.prepare(`
    INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, embedding_version)
    VALUES
      ('ex-a1', '/path/to/project-A', '2026-08-26T10:00:00Z', 'projA architecture decision about caching', 'We use Redis for caching in ProjA', '/path/to/a.jsonl', 1, 5, 0),
      ('ex-b1', '/path/to/project-B', '2026-08-26T10:05:00Z', 'projB architecture decision about caching', 'We use Memcached for caching in ProjB', '/path/to/b.jsonl', 1, 5, 0)
  `).run();

  db.prepare(`INSERT OR REPLACE INTO fts_meta (key, value) VALUES ('exchanges_fts_built', '1')`).run();

  // 2. Seed facts for ProjA, ProjB, and Global
  const d1 = createDomain(db, 'Architecture', 'System architecture');
  const c1 = createCategory(db, d1.id, 'Cache', 'Caching strategies');

  const factAId = insertFact(db, {
    fact: 'Project A uses Redis for distributed caching',
    category: 'Architecture',
    scope_type: 'project',
    scope_project: '/path/to/project-A',
    source_exchange_ids: ['ex-a1'],
  });
  db.prepare(`UPDATE facts SET ontology_category_id = ? WHERE id = ?`).run(c1.id, factAId);

  const factBId = insertFact(db, {
    fact: 'Project B uses Memcached for key-value store',
    category: 'Architecture',
    scope_type: 'project',
    scope_project: '/path/to/project-B',
    source_exchange_ids: ['ex-b1'],
  });
  db.prepare(`UPDATE facts SET ontology_category_id = ? WHERE id = ?`).run(c1.id, factBId);

  const factGlobalId = insertFact(db, {
    fact: 'All systems must enforce TLS 1.3 for external communication',
    category: 'Standard',
    scope_type: 'global',
    scope_project: null,
    source_exchange_ids: ['ex-a1'],
  });

  // Cross-project edges are rejected at the final relation write boundary.
  assert.throws(
    () => createRelation(db, factAId, 'CONTRADICTS', factBId, 'Different caching engines'),
    /cross-project/i,
  );

  await t.test('Conversation search with project scoping isolates results', async () => {
    const resultsA = await searchConversations('caching', { project: '/path/to/project-A', mode: 'text' });
    assert.equal(resultsA.length, 1);
    assert.equal(resultsA[0].exchange.project, '/path/to/project-A');

    const resultsB = await searchConversations('caching', { project: '/path/to/project-B', mode: 'text' });
    assert.equal(resultsB.length, 1);
    assert.equal(resultsB[0].exchange.project, '/path/to/project-B');
  });

  await t.test('rejected cross-project writes leave no traversal path in any scope', async () => {
    const relatedA = getRelatedFacts(db, factAId, 1, 0.6, 0.2, '/path/to/project-A');
    assert.equal(relatedA.length, 0, 'Cross-project target factB must not be returned');

    const relatedAll = getRelatedFacts(db, factAId, 1, 0.6, 0.2, null);
    assert.equal(relatedAll.length, 0, 'Rejected edge must not exist even for explicit all-project traversal');
  });

  await t.test('getOntologyTree with scopeType=global excludes project-private facts', async () => {
    const globalTree = getOntologyTree(db, null, 'global');
    const allFacts = globalTree.flatMap(d => d.categories.flatMap(c => c.facts));
    assert.ok(allFacts.every(f => f.scope_type === 'global'), 'All facts in global tree must have scope_type global');
    assert.ok(!allFacts.some(f => f.id === factAId || f.id === factBId));
  });

  await t.test('getOntologyTree with scopeProject includes project facts and global facts, excludes other projects', async () => {
    const projATree = getOntologyTree(db, '/path/to/project-A', 'project');
    const allFacts = projATree.flatMap(d => d.categories.flatMap(c => c.facts));
    assert.ok(allFacts.some(f => f.id === factAId), 'Project A facts must appear in Project A tree');
    assert.ok(!allFacts.some(f => f.id === factBId), 'Project B facts must not appear in Project A tree');
  });

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
