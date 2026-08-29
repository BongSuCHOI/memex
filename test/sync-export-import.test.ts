import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';

// Mock embeddings (avoid loading the model)
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

const originalEnv = { ...process.env };

describe('sync-export/import', () => {
  let tmpDir: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-sync-'));
    process.env.MEMEX_HOME = tmpDir;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMEX_DB_PATH;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should export empty database', async () => {
    const { exportForSync } = await import('../src/sync-export.js');
    const result = exportForSync();
    expect(result.facts).toBe(0);
    expect(result.domains).toBe(0);
    expect(result.categories).toBe(0);
    expect(result.relations).toBe(0);
  });

  it('should create sync directory', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const dir = getSyncDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain('sync');
  });

  it('should export facts and ontology to JSONL', async () => {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();

    try {
      // Insert test data
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(
        'dom-1', 'Frontend', 'Frontend dev', now
      );
      db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        'cat-1', 'dom-1', 'React', 'React patterns', now
      );
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active, ontology_category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'fact-1', 'Use React hooks', 'decision', 'project', 'test-proj', '[]', now, now, 1, 1, 'cat-1'
      );
      db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        'rel-1', 'fact-1', 'SUPPORTS', 'fact-1', 'self reference test', now
      );
    } finally {
      db.close();
    }

    const { exportForSync } = await import('../src/sync-export.js');
    const result = exportForSync();

    expect(result.facts).toBe(1);
    expect(result.domains).toBe(1);
    expect(result.categories).toBe(1);
    expect(result.relations).toBe(1);

    // Verify files exist
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    expect(fs.existsSync(path.join(syncDir, 'facts.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-domains.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-categories.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-relations.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'meta.json'))).toBe(true);

    // Verify meta.json contents
    const meta = JSON.parse(fs.readFileSync(path.join(syncDir, 'meta.json'), 'utf-8'));
    expect(meta.facts_count).toBe(1);
    expect(meta.hostname).toBeTruthy();
    expect(meta.exported_at).toBeTruthy();
  });

  it('should import returns zeros when no sync files exist', async () => {
    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.newDomains).toBe(0);
  });

  it('applies imported recall provenance only after the receipt is emitted', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const { importFromSync } = await import('../src/sync-import.js');
    const { hashRecallPrompt, initDatabase, insertExchange } = await import('../src/db.js');
    const syncDir = getSyncDir();
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), '');
    const prompt = 'Recall the deployment policy.';
    const now = '2026-08-29T00:00:00.000Z';
    const event = {
      id: 'sync-recall-status',
      session_id: 'sync-recall-session',
      project: '/tmp/project',
      prompt_hash: hashRecallPrompt(prompt),
      fact_ids: '["fact-deploy"]',
      source_type: 'memex_recall',
      learnable: 0,
      status: 'prepared',
      created_at: now,
      emitted_at: null,
    };
    const db = initDatabase();
    try {
      insertExchange(db, {
        id: 'sync-recall-exchange',
        project: '/tmp/project',
        timestamp: now,
        userMessage: prompt,
        assistantMessage: 'Response',
        archivePath: '/tmp/archive.jsonl',
        lineStart: 1,
        lineEnd: 2,
        sessionId: event.session_id,
      }, new Array(384).fill(0));
    } finally {
      db.close();
    }
    fs.writeFileSync(
      path.join(syncDir, 'recall-events.jsonl'),
      JSON.stringify(event) + '\n',
    );

    expect((await importFromSync()).newRecallEvents).toBe(1);
    let check = initDatabase();
    try {
      expect(check.prepare(
        'SELECT has_memex_recall FROM exchanges WHERE id = ?',
      ).get('sync-recall-exchange')).toEqual({ has_memex_recall: 0 });
    } finally {
      check.close();
    }

    fs.writeFileSync(
      path.join(syncDir, 'recall-events.jsonl'),
      JSON.stringify({ ...event, status: 'emitted', emitted_at: now }) + '\n',
    );
    expect((await importFromSync()).updatedRecallEvents).toBe(1);
    check = initDatabase();
    try {
      expect(check.prepare(
        'SELECT has_memex_recall FROM exchanges WHERE id = ?',
      ).get('sync-recall-exchange')).toEqual({ has_memex_recall: 1 });
    } finally {
      check.close();
    }
  });

  it('should import facts from JSONL files', async () => {
    // Create sync files manually
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    fs.writeFileSync(path.join(syncDir, 'ontology-domains.jsonl'),
      JSON.stringify({ id: 'imp-dom-1', name: 'Backend', description: 'Backend dev', created_at: now }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'ontology-categories.jsonl'),
      JSON.stringify({ id: 'imp-cat-1', domain_id: 'imp-dom-1', name: 'API', description: 'API patterns', created_at: now }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      JSON.stringify({
        id: 'imp-fact-1', fact: 'Use REST for APIs', category: 'decision',
        scope_type: 'project', scope_project: '/tmp/api-proj', source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: 'imp-cat-1'
      }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'ontology-relations.jsonl'),
      JSON.stringify({
        id: 'imp-rel-1', source_fact_id: 'imp-fact-1', relation_type: 'INFLUENCES',
        target_fact_id: 'imp-fact-1', reasoning: 'test', created_at: now
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();

    expect(result.newDomains).toBe(1);
    expect(result.newCategories).toBe(1);
    expect(result.newFacts).toBe(1);
    expect(result.newRelations).toBe(1);
  });

  it('queues a late historical sync fact for local consolidation', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const { importFromSync } = await import('../src/sync-import.js');
    const { initDatabase } = await import('../src/db.js');
    const syncDir = getSyncDir();
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), JSON.stringify({
      id: 'late-historical-fact',
      fact: 'Historical truth imported after local processing',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: '[]',
      created_at: '1999-01-01T00:00:00.000Z',
      updated_at: '2026-08-28T02:00:00.000Z',
      consolidated_count: 1,
      is_active: 1,
      ontology_category_id: null,
    }) + '\n');

    const result = await importFromSync();
    expect(result.newFacts).toBe(1);
    const db = initDatabase();
    try {
      expect(db.prepare(
        'SELECT created_at, needs_consolidation FROM facts WHERE id = ?',
      ).get('late-historical-fact')).toEqual({
        created_at: '1999-01-01T00:00:00.000Z',
        needs_consolidation: 1,
      });
    } finally {
      db.close();
    }
  });

  it('should skip duplicate records on re-import', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    const domainLine = JSON.stringify({ id: 'dup-dom', name: 'DevOps', description: 'DevOps', created_at: now });
    fs.writeFileSync(path.join(syncDir, 'ontology-domains.jsonl'), domainLine + '\n');
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      JSON.stringify({
        id: 'dup-fact', fact: 'Use Docker', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');

    // First import
    const first = await importFromSync();
    expect(first.newDomains).toBe(1);
    expect(first.newFacts).toBe(1);

    // Second import - should skip duplicates
    const second = await importFromSync();
    expect(second.newDomains).toBe(0);
    expect(second.newFacts).toBe(0);
  });

  it('should skip malformed JSONL lines', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      'not valid json\n' +
      JSON.stringify({
        id: 'valid-fact', fact: 'Valid fact', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1); // Only the valid line
  });

  it('should round-trip export then import', async () => {
    // Insert data and export
    const { initDatabase } = await import('../src/db.js');
    let db = initDatabase();
    const now = new Date().toISOString();

    try {
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'rt-fact', 'Round trip test', 'pattern', 'global', null, '["ex-1"]', now, now, 2, 1
      );
    } finally {
      db.close();
    }

    const { exportForSync } = await import('../src/sync-export.js');
    exportForSync();

    // Delete the fact from DB
    db = initDatabase();
    try {
      db.prepare('DELETE FROM facts WHERE id = ?').run('rt-fact');
    } finally {
      db.close();
    }

    // Import should restore it
    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1);

    // Verify fact is back
    db = initDatabase();
    try {
      const row = db.prepare('SELECT * FROM facts WHERE id = ?').get('rt-fact') as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row['fact']).toBe('Round trip test');
      expect(row['category']).toBe('pattern');
    } finally {
      db.close();
    }
  });

  it('rejects imported relations whose project endpoints belong to different scopes', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();
    const facts = [
      {
        id: 'scope-a-fact', fact: 'Project A decision', category: 'decision',
        scope_type: 'project', scope_project: '/tmp/team-a/shared', source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null,
      },
      {
        id: 'scope-b-fact', fact: 'Project B decision', category: 'decision',
        scope_type: 'project', scope_project: '/tmp/team-b/shared', source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null,
      },
    ];
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), facts.map((f) => JSON.stringify(f)).join('\n') + '\n');
    fs.writeFileSync(path.join(syncDir, 'ontology-relations.jsonl'), JSON.stringify({
      id: 'cross-project-relation', source_fact_id: 'scope-a-fact', relation_type: 'SUPPORTS',
      target_fact_id: 'scope-b-fact', reasoning: 'must be rejected', created_at: now,
    }) + '\n');

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(2);
    expect(result.newRelations).toBe(0);

    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      expect(db.prepare('SELECT COUNT(*) AS c FROM ontology_relations WHERE id = ?').get('cross-project-relation')).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });

  it('reconciles a newer inactive fact and its revision instead of skipping the existing id', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { exportForSync } = await import('../src/sync-export.js');
    const { importFromSync } = await import('../src/sync-import.js');
    const sourceDbPath = path.join(tmpDir, 'source.sqlite');
    const targetDbPath = path.join(tmpDir, 'target.sqlite');
    const createdAt = '2026-08-28T00:00:00.000Z';
    const updatedAt = '2026-08-28T01:00:00.000Z';

    process.env.MEMEX_DB_PATH = sourceDbPath;
    let db = initDatabase();
    try {
      db.prepare(`
        INSERT INTO facts
          (id, fact, category, scope_type, scope_project, source_exchange_ids,
           created_at, updated_at, consolidated_count, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'shared-fact', 'New current truth', 'decision', 'global', null, '["ex-new"]',
        createdAt, updatedAt, 2, 0,
      );
      db.prepare(`
        INSERT INTO fact_revisions
          (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'revision-1', 'shared-fact', 'Old truth', 'New current truth',
        'remote edit', 'ex-new', updatedAt,
      );
      db.prepare(`
        INSERT INTO ontology_relations
          (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'inactive-relation', 'shared-fact', 'SUPPORTS', 'shared-fact',
        'inactive endpoint stays referentially complete', updatedAt,
      );
    } finally {
      db.close();
    }
    const exported = exportForSync();
    expect(exported.facts).toBe(1);
    expect(exported.revisions).toBe(1);

    process.env.MEMEX_DB_PATH = targetDbPath;
    db = initDatabase();
    try {
      db.prepare(`
        INSERT INTO facts
          (id, fact, category, scope_type, scope_project, source_exchange_ids,
           created_at, updated_at, consolidated_count, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'shared-fact', 'Old truth', 'decision', 'global', null, '["ex-old"]',
        createdAt, createdAt, 1, 1,
      );
    } finally {
      db.close();
    }

    const imported = await importFromSync();
    expect(imported.updatedFacts).toBe(1);
    expect(imported.newRevisions).toBe(1);
    expect(imported.newRelations).toBe(1);

    db = initDatabase();
    try {
      expect(db.prepare(
        'SELECT fact, source_exchange_ids, updated_at, is_active FROM facts WHERE id = ?',
      ).get('shared-fact')).toEqual({
        fact: 'New current truth',
        source_exchange_ids: '["ex-new"]',
        updated_at: updatedAt,
        is_active: 0,
      });
      expect(db.prepare(
        'SELECT previous_fact, new_fact FROM fact_revisions WHERE id = ?',
      ).get('revision-1')).toEqual({ previous_fact: 'Old truth', new_fact: 'New current truth' });
      expect(db.prepare(
        'SELECT source_fact_id, target_fact_id FROM ontology_relations WHERE id = ?',
      ).get('inactive-relation')).toEqual({ source_fact_id: 'shared-fact', target_fact_id: 'shared-fact' });
    } finally {
      db.close();
    }
  });

  it('propagates hard-delete tombstones and durable recall receipts', async () => {
    const { initDatabase, hashRecallPrompt } = await import('../src/db.js');
    const { hardDeleteFact } = await import('../src/fact-management.js');
    const { exportForSync } = await import('../src/sync-export.js');
    const { importFromSync } = await import('../src/sync-import.js');
    const sourceDbPath = path.join(tmpDir, 'source-delete.sqlite');
    const targetDbPath = path.join(tmpDir, 'target-delete.sqlite');
    const factId = '11111111-1111-4111-8111-111111111111';
    const now = '2026-08-28T02:00:00.000Z';
    const recalledPrompt = 'prompt that received recalled context';
    const insertFact = (db: ReturnType<typeof initDatabase>) => db.prepare(`
      INSERT INTO facts
        (id, fact, category, scope_type, scope_project, source_exchange_ids,
         created_at, updated_at, consolidated_count, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(factId, 'Delete everywhere', 'decision', 'global', null, '[]', now, now, 1, 1);

    process.env.MEMEX_DB_PATH = sourceDbPath;
    let db = initDatabase();
    try {
      insertFact(db);
      db.prepare(`
        INSERT INTO recall_events
          (id, session_id, project, prompt_hash, fact_ids, status, created_at, emitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'recall-1', 'session-1', '/tmp/project', hashRecallPrompt(recalledPrompt),
        `["${factId}"]`, 'emitted', now, now,
      );
      hardDeleteFact(db, factId, { confirm: true });
    } finally {
      db.close();
    }
    const exported = exportForSync();
    expect(exported.tombstones).toBe(1);
    expect(exported.recallEvents).toBe(1);

    process.env.MEMEX_DB_PATH = targetDbPath;
    db = initDatabase();
    try {
      insertFact(db);
      db.prepare(`
        INSERT INTO exchanges
          (id, project, timestamp, user_message, assistant_message, archive_path,
           line_start, line_end, session_id, provenance, assistant_learnable, has_memex_recall)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'recalled-exchange', '/tmp/project', now, recalledPrompt, 'derived response',
        '/tmp/archive.jsonl', 1, 2, 'session-1',
        '["human_assertion","assistant_generated"]', 0, 0,
      );
    } finally {
      db.close();
    }

    const imported = await importFromSync();
    expect(imported.deletedFacts).toBe(1);
    expect(imported.newRecallEvents).toBe(1);

    db = initDatabase();
    try {
      expect(db.prepare('SELECT 1 FROM facts WHERE id = ?').get(factId)).toBeUndefined();
      expect(db.prepare('SELECT fact_id FROM fact_tombstones WHERE fact_id = ?').get(factId)).toEqual({ fact_id: factId });
      expect(db.prepare('SELECT status FROM recall_events WHERE id = ?').get('recall-1')).toEqual({ status: 'emitted' });
      const exchange = db.prepare(
        'SELECT provenance, assistant_learnable, has_memex_recall FROM exchanges WHERE id = ?',
      ).get('recalled-exchange') as { provenance: string; assistant_learnable: number; has_memex_recall: number };
      expect(JSON.parse(exchange.provenance)).toContain('memex_recall');
      expect(exchange.assistant_learnable).toBe(0);
      expect(exchange.has_memex_recall).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps a strictly newer local fact when an older payload arrives', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { getSyncDir } = await import('../src/sync-export.js');
    const { importFromSync } = await import('../src/sync-import.js');
    const syncDir = getSyncDir();
    const older = '2026-08-28T00:00:00.000Z';
    const newer = '2026-08-28T03:00:00.000Z';
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), JSON.stringify({
      id: 'stale-fact', fact: 'Stale remote truth', category: 'decision',
      scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
      created_at: older, updated_at: older, consolidated_count: 1,
      is_active: 0, ontology_category_id: null,
    }) + '\n');

    const db = initDatabase();
    try {
      db.prepare(`
        INSERT INTO facts
          (id, fact, category, scope_type, scope_project, source_exchange_ids,
           created_at, updated_at, consolidated_count, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('stale-fact', 'Newer local truth', 'decision', 'global', null, '[]', older, newer, 1, 1);
    } finally {
      db.close();
    }

    const imported = await importFromSync();
    expect(imported.updatedFacts).toBe(0);
    const check = initDatabase();
    try {
      expect(check.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get('stale-fact'))
        .toEqual({ fact: 'Newer local truth', is_active: 1 });
    } finally {
      check.close();
    }
  });

  it('merges disjoint device snapshots without last-writer overwrite', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const { importFromSync } = await import('../src/sync-import.js');
    const { initDatabase } = await import('../src/db.js');
    const devicesDir = path.join(getSyncDir(), 'devices');
    const deviceA = path.join(devicesDir, 'device-a');
    const deviceB = path.join(devicesDir, 'device-b');
    fs.mkdirSync(deviceA, { recursive: true });
    fs.mkdirSync(deviceB, { recursive: true });
    const makeFact = (fact: string, updated_at: string, is_active: 0 | 1) => ({
      id: 'multi-device-fact', fact, category: 'decision',
      scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
      created_at: '2026-08-28T00:00:00.000Z', updated_at,
      consolidated_count: 1, is_active, ontology_category_id: null,
    });
    fs.writeFileSync(
      path.join(deviceA, 'facts.jsonl'),
      JSON.stringify(makeFact('Older device truth', '2026-08-28T01:00:00.000Z', 1)) + '\n',
    );
    fs.writeFileSync(
      path.join(deviceA, 'ontology-relations.jsonl'),
      JSON.stringify({
        id: 'stale-device-relation', source_fact_id: 'multi-device-fact',
        relation_type: 'SUPPORTS', target_fact_id: 'multi-device-fact',
        reasoning: 'belongs to old endpoint generation',
        created_at: '2026-08-28T01:00:00.000Z',
        source_fact_updated_at: '2026-08-28T01:00:00.000Z',
        target_fact_updated_at: '2026-08-28T01:00:00.000Z',
      }) + '\n',
    );
    fs.writeFileSync(
      path.join(deviceB, 'facts.jsonl'),
      JSON.stringify(makeFact('Newer device truth', '2026-08-28T02:00:00.000Z', 0)) + '\n',
    );

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(1);
    expect(imported.newRelations).toBe(0);
    const db = initDatabase();
    try {
      expect(db.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get('multi-device-fact'))
        .toEqual({ fact: 'Newer device truth', is_active: 0 });
      expect(db.prepare('SELECT 1 FROM ontology_relations WHERE id = ?').get('stale-device-relation'))
        .toBeUndefined();
    } finally {
      db.close();
    }
  });

  // Exact-time ties must resolve identically on every device: canonical key
  // order (inactive first, then lexical field order), and a deletion event
  // beats a fact with the same timestamp. docs/CONVERSATION-LIFECYCLE.md §sync.
  describe('exact-time tie-break determinism', () => {
    const tie = '2026-08-28T03:00:00.000Z';
    const makeTieFact = (fact: string, is_active: 0 | 1) => ({
      id: 'tie-break-fact',
      fact,
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: '[]',
      created_at: tie,
      updated_at: tie,
      consolidated_count: 1,
      is_active,
      ontology_category_id: null,
    });

    async function seedLocalFact(): Promise<void> {
      const { initDatabase } = await import('../src/db.js');
      process.env.MEMEX_DB_PATH = path.join(tmpDir, 'tie.sqlite');
      const db = initDatabase();
      try {
        db.prepare(`
          INSERT INTO facts
            (id, fact, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('tie-break-fact', 'Alpha decision', 'decision', 'global', null, '[]', tie, tie, 1, 1);
      } finally {
        db.close();
      }
    }

    it('picks the lexically-greater canonical key on an exact-time tie', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');
      await seedLocalFact();

      // "Zulu..." sorts after "Alpha..." — the remote payload wins the tie.
      fs.writeFileSync(
        path.join(getSyncDir(), 'facts.jsonl'),
        JSON.stringify(makeTieFact('Zulu decision', 1)) + '\n',
      );
      const imported = await importFromSync();
      expect(imported.updatedFacts).toBe(1);

      const db = initDatabase();
      try {
        expect(db.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get('tie-break-fact'))
          .toEqual({ fact: 'Zulu decision', is_active: 1 });
      } finally {
        db.close();
      }
    });

    it('keeps the local fact when its canonical key wins the tie', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');
      await seedLocalFact();

      // "Aardvark..." sorts before "Alpha..." — the local fact keeps winning,
      // no matter which device imports first.
      fs.writeFileSync(
        path.join(getSyncDir(), 'facts.jsonl'),
        JSON.stringify(makeTieFact('Aardvark decision', 1)) + '\n',
      );
      const imported = await importFromSync();
      expect(imported.updatedFacts).toBe(0);

      const db = initDatabase();
      try {
        expect(db.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get('tie-break-fact'))
          .toEqual({ fact: 'Alpha decision', is_active: 1 });
      } finally {
        db.close();
      }
    });

    it('prefers the inactive state on an exact-time tie', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');
      await seedLocalFact();

      // Inactive wins the tie even when the text sorts lower.
      fs.writeFileSync(
        path.join(getSyncDir(), 'facts.jsonl'),
        JSON.stringify(makeTieFact('Aardvark decision', 0)) + '\n',
      );
      const imported = await importFromSync();
      expect(imported.updatedFacts).toBe(1);

      const db = initDatabase();
      try {
        expect(db.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get('tie-break-fact'))
          .toEqual({ fact: 'Aardvark decision', is_active: 0 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM vec_facts WHERE id = ?').get('tie-break-fact'))
          .toEqual({ n: 0 });
      } finally {
        db.close();
      }
    });

    it('lets a simultaneous tombstone beat a fact with the same updated_at', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');
      await seedLocalFact();

      // A real export always writes facts.jsonl (empty when the only event
      // is the hard delete), plus the tombstone payload.
      fs.writeFileSync(path.join(getSyncDir(), 'facts.jsonl'), '');
      fs.writeFileSync(
        path.join(getSyncDir(), 'fact-tombstones.jsonl'),
        JSON.stringify({
          fact_id: 'tie-break-fact',
          deleted_at: tie,
          reason: 'hard_delete',
        }) + '\n',
      );
      const imported = await importFromSync();
      expect(imported.deletedFacts).toBe(1);

      const db = initDatabase();
      try {
        expect(db.prepare('SELECT 1 FROM facts WHERE id = ?').get('tie-break-fact')).toBeUndefined();
        expect(db.prepare('SELECT reason FROM fact_tombstones WHERE fact_id = ?').get('tie-break-fact'))
          .toEqual({ reason: 'hard_delete' });
      } finally {
        db.close();
      }
    });
  });

  describe('terminal privacy tombstone (재감사 P1-7 / T02)', () => {
    const PRIVACY = 'source_conversation_excluded';
    const purge = '2026-08-29T00:00:00.000Z'; // A 기기의 conversation exclusion 시각
    const peerEdit = '2026-08-29T12:00:00.000Z'; // tombstone 을 모르는 B 기기의 이후 편집

    function writeRemoteFact(db: import('better-sqlite3').Database): void {
      db.prepare(`
        INSERT INTO facts
          (id, fact, category, scope_type, scope_project, source_exchange_ids,
           created_at, updated_at, consolidated_count, is_active)
        VALUES ('privacy-fact', 'Redis에서 세션 캐시를 사용한다', 'decision', 'global', null, '[]',
                '2026-08-01T00:00:00.000Z', ?, 1, 1)
      `).run(peerEdit);
    }

    it('strictly newer offline peer edit은 privacy tombstone을 부활시키지 않는다 (T02)', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      let db = initDatabase();
      try {
        db.prepare('INSERT INTO fact_tombstones (fact_id, deleted_at, reason) VALUES (?, ?, ?)')
          .run('privacy-fact', purge, PRIVACY);
      } finally {
        db.close();
      }

      // B 기기 스냅샷: tombstone 은 모르고 더 새로 편집된 fact 만 담고 있다.
      const syncDir = getSyncDir();
      fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), JSON.stringify({
        id: 'privacy-fact',
        fact: 'Redis에서 세션 캐시를 사용한다',
        fact_kr: null,
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: '[]',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: peerEdit,
        consolidated_count: 1,
        is_active: 1,
        ontology_category_id: null,
      }) + '\n');
      fs.writeFileSync(path.join(syncDir, 'fact-tombstones.jsonl'), '');

      const imported = await importFromSync();
      expect(imported.newFacts).toBe(0);

      db = initDatabase();
      try {
        expect(db.prepare('SELECT 1 FROM facts WHERE id = ?').get('privacy-fact')).toBeUndefined();
        expect(db.prepare('SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?').get('privacy-fact'))
          .toEqual({ deleted_at: purge, reason: PRIVACY });
      } finally {
        db.close();
      }
    });

    it('privacy tombstone은 더 새로운 로컬 fact를 지우고 대화 전반으로 전파된다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      let db = initDatabase();
      try {
        writeRemoteFact(db);
      } finally {
        db.close();
      }

      const syncDir = getSyncDir();
      fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), '');
      fs.writeFileSync(
        path.join(syncDir, 'fact-tombstones.jsonl'),
        JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: PRIVACY }) + '\n',
      );

      const imported = await importFromSync();
      expect(imported.deletedFacts).toBe(1);

      db = initDatabase();
      try {
        expect(db.prepare('SELECT 1 FROM facts WHERE id = ?').get('privacy-fact')).toBeUndefined();
        expect(db.prepare('SELECT reason FROM fact_tombstones WHERE fact_id = ?').get('privacy-fact'))
          .toEqual({ reason: PRIVACY });
      } finally {
        db.close();
      }
    });

    it('hard-delete LWW는 유지된다: tombstone보다 엄격히 새 fact는 복원된다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      let db = initDatabase();
      try {
        db.prepare('INSERT INTO fact_tombstones (fact_id, deleted_at, reason) VALUES (?, ?, ?)')
          .run('privacy-fact', purge, 'hard_delete');
      } finally {
        db.close();
      }

      const syncDir = getSyncDir();
      fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), JSON.stringify({
        id: 'privacy-fact',
        fact: 'Redis에서 세션 캐시를 사용한다',
        fact_kr: null,
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: '[]',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: peerEdit,
        consolidated_count: 1,
        is_active: 1,
        ontology_category_id: null,
      }) + '\n');
      fs.writeFileSync(path.join(syncDir, 'fact-tombstones.jsonl'), '');

      const imported = await importFromSync();
      expect(imported.newFacts).toBe(1);

      db = initDatabase();
      try {
        expect(db.prepare('SELECT 1 FROM facts WHERE id = ?').get('privacy-fact')).toBeDefined();
        expect((db.prepare('SELECT COUNT(*) AS n FROM fact_tombstones').get() as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    });

    it('hard-delete tombstone보다 최신 로컬 fact는 지워지지 않는다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      let db = initDatabase();
      try {
        writeRemoteFact(db);
      } finally {
        db.close();
      }

      const syncDir = getSyncDir();
      fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), '');
      fs.writeFileSync(
        path.join(syncDir, 'fact-tombstones.jsonl'),
        JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: 'hard_delete' }) + '\n',
      );

      const imported = await importFromSync();
      expect(imported.deletedFacts).toBe(0);

      db = initDatabase();
      try {
        expect(db.prepare('SELECT 1 FROM facts WHERE id = ?').get('privacy-fact')).toBeDefined();
        expect((db.prepare('SELECT COUNT(*) AS n FROM fact_tombstones').get() as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    });

    it('로컬 privacy tombstone은 더 새로운 비-privacy tombstone으로 강등되지 않는다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');
      const laterPurge = '2026-08-29T18:00:00.000Z';

      let db = initDatabase();
      try {
        db.prepare('INSERT INTO fact_tombstones (fact_id, deleted_at, reason) VALUES (?, ?, ?)')
          .run('privacy-fact', laterPurge, PRIVACY);
      } finally {
        db.close();
      }

      const syncDir = getSyncDir();
      fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), '');
      fs.writeFileSync(
        path.join(syncDir, 'fact-tombstones.jsonl'),
        JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: 'hard_delete' }) + '\n',
      );

      await importFromSync();

      db = initDatabase();
      try {
        expect(db.prepare('SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?').get('privacy-fact'))
          .toEqual({ deleted_at: laterPurge, reason: PRIVACY });
      } finally {
        db.close();
      }
    });

    it('payload 내 privacy tombstone은 더 새로운 hard-delete보다 이유에서 우선한다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');
      const newestEdit = '2026-08-29T20:00:00.000Z';

      let db = initDatabase();
      try {
        db.prepare(`
          INSERT INTO facts
            (id, fact, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, is_active)
          VALUES ('privacy-fact', 'Redis에서 세션 캐시를 사용한다', 'decision', 'global', null, '[]',
                  '2026-08-01T00:00:00.000Z', ?, 1, 1)
        `).run(newestEdit);
      } finally {
        db.close();
      }

      // 두 기기 스냅샷: dev-A 의 privacy 제거(T1)와 dev-B 의 더 새로운 hard delete(T2).
      const syncDir = getSyncDir();
      fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), '');
      fs.mkdirSync(path.join(syncDir, 'devices', 'dev-a'), { recursive: true });
      fs.mkdirSync(path.join(syncDir, 'devices', 'dev-b'), { recursive: true });
      fs.writeFileSync(
        path.join(syncDir, 'devices', 'dev-a', 'fact-tombstones.jsonl'),
        JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: PRIVACY }) + '\n',
      );
      fs.writeFileSync(
        path.join(syncDir, 'devices', 'dev-b', 'fact-tombstones.jsonl'),
        JSON.stringify({
          fact_id: 'privacy-fact',
          deleted_at: peerEdit,
          reason: 'hard_delete',
        }) + '\n',
      );

      const imported = await importFromSync();
      expect(imported.deletedFacts).toBe(1);

      db = initDatabase();
      try {
        expect(db.prepare('SELECT 1 FROM facts WHERE id = ?').get('privacy-fact')).toBeUndefined();
        // terminal 이유는 유지되고 timestamp 는 monotone max 다.
        expect(db.prepare('SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?').get('privacy-fact'))
          .toEqual({ deleted_at: peerEdit, reason: PRIVACY });
      } finally {
        db.close();
      }
    });
  });
});
