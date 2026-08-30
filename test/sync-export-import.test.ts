import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';
import { craftCommittedGeneration, readCurrentGeneration } from './sync-fixture.js';

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
    expect(result.revisions).toBe(0);
    expect(result.tombstones).toBe(0);
    expect(result.recallEvents).toBe(0);
  });

  it('should create sync directory', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const dir = getSyncDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain('sync');
  });

  it('should export facts to JSONL — ontology does not travel (v4)', async () => {
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
    expect(result.revisions).toBe(0);
    expect(result.tombstones).toBe(0);

    // Verify the committed generation carries the payload — and that the
    // root mirror is gone: committed generations are the whole protocol (P1-1).
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const exportedDeviceDir = path.join(syncDir, 'devices', fs.readdirSync(path.join(syncDir, 'devices'))[0]);
    const exportedGenDir = path.join(exportedDeviceDir, 'generations', readCurrentGeneration(exportedDeviceDir));
    for (const name of ['facts.jsonl', 'fact-revisions.jsonl', 'fact-tombstones.jsonl', 'recall-events.jsonl', 'meta.json']) {
      expect(fs.existsSync(path.join(exportedGenDir, name)), name).toBe(true);
    }
    // Protocol v4: taxonomy/relations are derived state and never leave the device.
    for (const name of ['ontology-domains.jsonl', 'ontology-categories.jsonl', 'ontology-relations.jsonl']) {
      expect(fs.existsSync(path.join(exportedGenDir, name)), name).toBe(false);
    }
    expect(fs.existsSync(path.join(syncDir, 'facts.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(syncDir, 'meta.json'))).toBe(false);

    // Verify meta.json contents (inside the committed generation)
    const meta = JSON.parse(fs.readFileSync(path.join(exportedGenDir, 'meta.json'), 'utf-8'));
    expect(meta.facts_count).toBe(1);
    expect(meta.protocol_version).toBe(4);
    expect(meta.hostname).toBeTruthy();
    expect(meta.exported_at).toBeTruthy();
  });

  it('should import returns zeros when no sync files exist', async () => {
    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.newRevisions).toBe(0);
  });

  // 공통 시드: 로컬 fact를 넣고 반환된 실제 id/created_at으로 원격 payload를
  // 맞춘다 — semanticConflictKey는 (fact, category, scope, created_at)이므로
  // tie 시나리오는 이 둘이 일치해야 한다.
  async function seedLocalFact(opts: {
    fact?: string;
    sources: string[];
    count?: number;
    semanticAt?: string;
  }): Promise<{ id: string; createdAt: string }> {
    const { initDatabase } = await import('../src/db.js');
    const { insertFact } = await import('../src/fact-db.js');
    const db = initDatabase();
    let id: string;
    let createdAt: string;
    try {
      id = insertFact(db, {
        fact: opts.fact ?? 'Metrics are exported once per minute',
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: opts.sources,
        embedding: new Array(384).fill(0.05),
      });
      const row = db.prepare('SELECT created_at FROM facts WHERE id = ?').get(id) as { created_at: string };
      createdAt = row.created_at;
      const semanticAt = opts.semanticAt ?? '2026-08-30T00:00:00.000Z';
      db.prepare(
        'UPDATE facts SET semantic_updated_at = ?, updated_at = ?, consolidated_count = ?, needs_consolidation = 0 WHERE id = ?',
      ).run(semanticAt, semanticAt, opts.count ?? 1, id);
    } finally {
      db.close();
    }
    return { id, createdAt };
  }

  function remoteFactPayload(opts: {
    id: string;
    createdAt: string;
    fact?: string;
    sources: string[];
    count?: number;
    semanticAt?: string;
    is_active?: 0 | 1;
    lifecycleAt?: string;
  }): string {
    const semanticAt = opts.semanticAt ?? '2026-08-30T00:00:00.000Z';
    return JSON.stringify({
      id: opts.id,
      fact: opts.fact ?? 'Metrics are exported once per minute',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: JSON.stringify(opts.sources),
      created_at: opts.createdAt,
      updated_at: semanticAt,
      semantic_updated_at: semanticAt,
      lifecycle_updated_at: opts.lifecycleAt ?? semanticAt,
      consolidated_count: opts.count ?? 1,
      is_active: opts.is_active ?? 1,
    }) + '\n';
  }

  it('a peer with fewer sources cannot regress local provenance on a semantic tie', async () => {
    // 재감사 P1-1 보강 핵심 시나리오: 로컬은 DUPLICATE consolidation으로
    // provenance를 union했고(ex-b), 원격은 여전히 [ex-a]다. semantic clock이
    // 같으면(consolidation은 semantic event가 아니다) 구 lexical tie-break은
    // ["ex-a"] 쪽이 이겨 ex-b provenance를 소실시켰다 — 그러면 conversation
    // exclusion purge가 ex-b 연결 fact를 못 찾는다. 이제 metadata는
    // monotone convergence다: union/max, 결코 회귀하지 않는다.
    const { id, createdAt } = await seedLocalFact({ sources: ['ex-a', 'ex-b'], count: 2 });
    craftCommittedGeneration('dev-a', {
      'facts.jsonl': remoteFactPayload({ id, createdAt, sources: ['ex-a'], count: 1 }),
    });

    const { importFromSync } = await import('../src/sync-import.js');
    await importFromSync();

    const { initDatabase } = await import('../src/db.js');
    const check = initDatabase();
    try {
      expect(check.prepare(
        'SELECT source_exchange_ids, consolidated_count, semantic_generation, fact FROM facts WHERE id = ?',
      ).get(id)).toEqual({
        source_exchange_ids: '["ex-a","ex-b"]', // union — 결코 회귀하지 않는다
        consolidated_count: 2, // max
        semantic_generation: 1, // metadata merge는 semantic event가 아니다
        fact: 'Metrics are exported once per minute',
      });
    } finally {
      check.close();
    }
  });

  it('metadata-only convergence does not touch vectors, relations or the consolidation queue', async () => {
    const { id, createdAt } = await seedLocalFact({ sources: ['ex-a'], count: 1 });
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      db.prepare(`
        INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
        VALUES ('conv-rel', ?, 'SUPPORTS', ?, 'must survive metadata merge', '2026-08-30T00:00:00.000Z')
      `).run(id, id);
    } finally {
      db.close();
    }

    craftCommittedGeneration('dev-a', {
      'facts.jsonl': remoteFactPayload({ id, createdAt, sources: ['ex-a', 'ex-b'], count: 1 }),
    });

    const { importFromSync } = await import('../src/sync-import.js');
    const imported = await importFromSync();
    expect(imported.updatedFacts).toBe(1);

    const check = initDatabase();
    try {
      // metadata merge는 semantic event가 아니다 — relation 삭제, ontology
      // reset, vector 재생성, dirty queue 재등록이 없어야 한다.
      expect((check.prepare('SELECT COUNT(*) AS n FROM ontology_relations').get() as { n: number }).n).toBe(1);
      expect((check.prepare('SELECT COUNT(*) AS n FROM vec_facts_rowids WHERE id = ?').get(id) as { n: number }).n).toBe(1);
      expect(check.prepare('SELECT needs_consolidation, ontology_category_id FROM facts WHERE id = ?').get(id))
        .toEqual({ needs_consolidation: 0, ontology_category_id: null });
      expect(check.prepare('SELECT source_exchange_ids FROM facts WHERE id = ?').get(id))
        .toEqual({ source_exchange_ids: '["ex-a","ex-b"]' });
    } finally {
      check.close();
    }
  });

  it('a locally newer meaning still absorbs peer provenance monotonically', async () => {
    // 로컬 의미 편집(T2, 더 새로움) + 원격은 옛 의미이지만 provenance가 더 풍부하다.
    const { id, createdAt } = await seedLocalFact({
      fact: 'Metrics are exported on demand',
      sources: ['ex-a'],
      count: 1,
      semanticAt: '2026-08-31T00:00:00.000Z',
    });
    craftCommittedGeneration('dev-a', {
      'facts.jsonl': remoteFactPayload({
        id,
        createdAt,
        fact: 'Metrics are exported once per minute',
        sources: ['ex-a', 'ex-c'],
        count: 3,
        semanticAt: '2026-08-30T00:00:00.000Z',
      }),
    });

    const { importFromSync } = await import('../src/sync-import.js');
    await importFromSync();

    const { initDatabase } = await import('../src/db.js');
    const check = initDatabase();
    try {
      expect(check.prepare(
        'SELECT fact, source_exchange_ids, consolidated_count, semantic_generation FROM facts WHERE id = ?',
      ).get(id)).toEqual({
        fact: 'Metrics are exported on demand', // 로컬 의미 유지
        source_exchange_ids: '["ex-a","ex-c"]', // peer provenance 수렴
        consolidated_count: 3, // max
        semantic_generation: 1,
      });
    } finally {
      check.close();
    }
  });

  it('a semantic replacement carries the merged provenance along with the new meaning', async () => {
    // 원격 의미 편집이 더 새롭다 — replacement가 일어나도 로컬 provenance(ex-a)는
    // 원격 승자 행에서 사라지지 않는다.
    const { id, createdAt } = await seedLocalFact({ sources: ['ex-a'], count: 1 });
    craftCommittedGeneration('dev-a', {
      'facts.jsonl': remoteFactPayload({
        id,
        createdAt,
        fact: 'Metrics are exported on demand',
        sources: ['ex-c'],
        count: 1,
        semanticAt: '2026-08-31T00:00:00.000Z',
      }),
    });

    const { importFromSync } = await import('../src/sync-import.js');
    await importFromSync();

    const { initDatabase } = await import('../src/db.js');
    const check = initDatabase();
    try {
      expect(check.prepare(
        'SELECT fact, source_exchange_ids FROM facts WHERE id = ?',
      ).get(id)).toEqual({
        fact: 'Metrics are exported on demand',
        source_exchange_ids: '["ex-a","ex-c"]',
      });
    } finally {
      check.close();
    }
  });

  it('applies imported recall provenance only after the receipt is emitted', async () => {
    const { importFromSync } = await import('../src/sync-import.js');
    const { hashRecallPrompt, initDatabase, insertExchange } = await import('../src/db.js');
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
    craftCommittedGeneration('dev-a', {
      'recall-events.jsonl': JSON.stringify(event) + '\n',
    });

    expect((await importFromSync()).newRecallEvents).toBe(1);
    let check = initDatabase();
    try {
      expect(check.prepare(
        'SELECT has_memex_recall FROM exchanges WHERE id = ?',
      ).get('sync-recall-exchange')).toEqual({ has_memex_recall: 0 });
    } finally {
      check.close();
    }

    craftCommittedGeneration('dev-a', {
      'recall-events.jsonl': JSON.stringify({ ...event, status: 'emitted', emitted_at: now }) + '\n',
    });
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

  it('should import facts from JSONL files (v4 carries no derived state)', async () => {
    const now = '2026-08-30T00:00:00.000Z';

    craftCommittedGeneration('dev-a', {
      'facts.jsonl':
        JSON.stringify({
          id: 'imp-fact-1', fact: 'Use REST for APIs', category: 'decision',
          scope_type: 'project', scope_project: '/tmp/api-proj', source_exchange_ids: '[]',
          created_at: now, updated_at: now, semantic_updated_at: now,
          lifecycle_updated_at: now, consolidated_count: 1, is_active: 1,
        }) + '\n',
    });

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();

    expect(result.newFacts).toBe(1);
    // Derived overlay rebuilds locally: imported facts start unclassified.
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      expect(db.prepare('SELECT ontology_category_id FROM facts WHERE id = ?').get('imp-fact-1'))
        .toEqual({ ontology_category_id: null });
    } finally {
      db.close();
    }
  });

  it('queues a late historical sync fact for local consolidation', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const { importFromSync } = await import('../src/sync-import.js');
    const { initDatabase } = await import('../src/db.js');
    craftCommittedGeneration('dev-a', {
      'facts.jsonl': JSON.stringify({
        id: 'late-historical-fact',
      fact: 'Historical truth imported after local processing',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: '[]',
        created_at: '1999-01-01T00:00:00.000Z',
        updated_at: '2026-08-28T02:00:00.000Z',
        semantic_updated_at: '2026-08-28T02:00:00.000Z',
        lifecycle_updated_at: '2026-08-28T02:00:00.000Z',
        consolidated_count: 1,
        is_active: 1,
      }) + '\n',
    });

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

    craftCommittedGeneration('dev-a', {
      'facts.jsonl':
        JSON.stringify({
          id: 'dup-fact', fact: 'Use Docker', category: 'decision',
          scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
          created_at: now, updated_at: now, semantic_updated_at: now,
          lifecycle_updated_at: now, consolidated_count: 1, is_active: 1,
        }) + '\n',
    });

    const { importFromSync } = await import('../src/sync-import.js');

    // First import
    const first = await importFromSync();
    expect(first.newFacts).toBe(1);

    // Second import - should skip duplicates
    const second = await importFromSync();
    expect(second.newFacts).toBe(0);
  });

  it('fails closed on a malformed JSONL row — the whole generation is rejected', async () => {
    // P1-4 보강: exporter만이 payload를 만들므로 malformed 행은 곧 손상이다.
    // 유효 행만 골라 import하면(구 P2-7 계약) 부분 전송 generation이
    // 조용히 부분 commit될 수 있다 — 이제 generation 전체를 reject한다.
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    craftCommittedGeneration('dev-a', {
      'facts.jsonl':
        'not valid json\n' +
        JSON.stringify({
          id: 'valid-fact', fact: 'Valid fact', category: 'decision',
          scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
          created_at: now, updated_at: now, semantic_updated_at: now,
          lifecycle_updated_at: now, consolidated_count: 1, is_active: 1,
        }) + '\n',
    });

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.malformedRows).toHaveLength(1);
    // generation 거부는 하나의 이슈로 보고된다(CURRENT 기준) — 손상 파일명은
    // 오류 본문에 들어간다.
    expect(result.malformedRows[0].file.endsWith('CURRENT')).toBe(true);
    expect(result.malformedRows[0].error).toContain('facts.jsonl malformed JSON at line 1');
    expect(result.malformedRows[0].error).toContain('rejected');
  });

  it('rejects a generation whose payload does not match its integrity manifest', async () => {
    // cloud sync가 generation 디렉터리를 파일 단위로 전송하는 동안 잘린
    // tombstones 파일이 유효한 generation으로 읽히면 privacy tombstone이
    // 누락된다 — hash/rows 불일치는 generation 전체 reject여야 한다.
    const now = '2026-08-30T00:00:00.000Z';
    const gen = craftCommittedGeneration('dev-a', {
      'facts.jsonl': JSON.stringify({
        id: 'tamper-fact', fact: 'Tamper probe', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, semantic_updated_at: now,
        lifecycle_updated_at: now, consolidated_count: 1, is_active: 1,
      }) + '\n',
      'fact-tombstones.jsonl': JSON.stringify({
        fact_id: 'some-fact', deleted_at: now, reason: 'hard_delete',
      }) + '\n',
    });
    // 부분 전송 흉내: tombstones 내용을 자른다(존재하지만 prefix만 도착).
    fs.writeFileSync(path.join(gen.genDir, 'fact-tombstones.jsonl'), '');

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.malformedRows).toHaveLength(1);
    expect(result.malformedRows[0].error).toContain('fact-tombstones.jsonl');
    expect(result.malformedRows[0].error).toContain('rejected');
  });

  it('rejects a generation whose meta.json is missing or does not match CURRENT', async () => {
    const now = '2026-08-30T00:00:00.000Z';
    const gen = craftCommittedGeneration('dev-a', {
      'facts.jsonl': JSON.stringify({
        id: 'manifest-fact', fact: 'Manifest probe', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, semantic_updated_at: now,
        lifecycle_updated_at: now, consolidated_count: 1, is_active: 1,
      }) + '\n',
    });
    fs.unlinkSync(path.join(gen.genDir, 'meta.json'));
    const missing = await import('../src/sync-import.js').then((m) => m.importFromSync());
    expect(missing.newFacts).toBe(0);
    expect(missing.malformedRows[0].error).toContain('unreadable meta.json');
    expect(missing.malformedRows[0].error).toContain('rejected');

    // meta.json이 CURRENT가 가리키는 generation과 다르면(전송 순서 어긋남) 거부.
    const gen2 = craftCommittedGeneration('dev-b', {
      'facts.jsonl': JSON.stringify({
        id: 'manifest-fact-2', fact: 'Manifest probe 2', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, semantic_updated_at: now,
        lifecycle_updated_at: now, consolidated_count: 1, is_active: 1,
      }) + '\n',
    });
    const manifestPath = path.join(gen2.genDir, 'meta.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.generation = 'a-different-generation-id';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const mismatched = await import('../src/sync-import.js').then((m) => m.importFromSync());
    expect(mismatched.newFacts).toBe(0);
    // dev-a의 거부 이슈가 앞선다 — dev-b의 manifest 불일치 이슈를 찾아 단언한다.
    const mismatchIssue = mismatched.malformedRows.find((row) =>
      row.error.includes('does not match the CURRENT-named generation'),
    );
    expect(mismatchIssue).toBeTruthy();
    expect(mismatchIssue!.error).toContain('dev-b');
    expect(mismatchIssue!.error).toContain('rejected');
  });

  it('imported facts start with a NULL derived overlay for local reclassification (v4)', async () => {
    // 재감사 P1-4 v4: ontology는 sync payload에서 완전히 제거되었다 — 원격
    // 분류가 로컬 taxonomy와 무관해지고, overlay는 로컬 백필이 다시 채운다.
    const now = '2026-08-30T00:00:00.000Z';
    craftCommittedGeneration('dev-a', {
      'facts.jsonl': JSON.stringify({
        id: 'overlay-fact', fact: 'Use CDN for static assets', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, semantic_updated_at: now,
        lifecycle_updated_at: now, consolidated_count: 1, is_active: 1,
      }) + '\n',
    });

    const { importFromSync } = await import('../src/sync-import.js');
    const imported = await importFromSync();
    expect(imported.newFacts).toBe(1);

    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      expect(db.prepare(
        'SELECT ontology_category_id, ontology_attempts, is_active FROM facts WHERE id = ?',
      ).get('overlay-fact')).toEqual({
        ontology_category_id: null,
        ontology_attempts: 0,
        is_active: 1,
      });
    } finally {
      db.close();
    }
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
    // v4: semantic replacement(1) + lifecycle deactivate(1)가 독립 축으로 적용된다.
    expect(imported.updatedFacts).toBe(2);
    expect(imported.newRevisions).toBe(1);

    db = initDatabase();
    try {
      expect(db.prepare(
        'SELECT fact, source_exchange_ids, is_active FROM facts WHERE id = ?',
      ).get('shared-fact')).toEqual({
        fact: 'New current truth',
        // P1-1 보강: semantic replacement라도 provenance는 monotone union이다 —
        // 로컬 증거(ex-old)가 원격 승자 행에서 사라지지 않는다.
        source_exchange_ids: '["ex-new","ex-old"]',
        // P1-3 v4: is_active는 lifecycle 축이 원격의 더 새로운 deactivate를
        // 적용해 0으로 수렴한다 — semantic 교체가 is_active를 덮지 않는다.
        is_active: 0,
      });
      // lifecycle deactivate는 로컬 행 touch 시각(updated_at)을 지금으로 기록한다.
      const touched = db.prepare('SELECT updated_at FROM facts WHERE id = ?').get('shared-fact') as { updated_at: string };
      expect(Date.parse(touched.updated_at)).toBeGreaterThan(Date.parse(updatedAt));
      expect(db.prepare(
        'SELECT previous_fact, new_fact FROM fact_revisions WHERE id = ?',
      ).get('revision-1')).toEqual({ previous_fact: 'Old truth', new_fact: 'New current truth' });
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
    craftCommittedGeneration('dev-a', {
      'facts.jsonl': JSON.stringify({
        id: 'stale-fact', fact: 'Stale remote truth', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: older, updated_at: older, semantic_updated_at: older,
        lifecycle_updated_at: older, consolidated_count: 1, is_active: 0,
      }) + '\n',
    });

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
    const makeFact = (fact: string, updated_at: string, is_active: 0 | 1) => ({
      id: 'multi-device-fact', fact, category: 'decision',
      scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
      created_at: '2026-08-28T00:00:00.000Z', updated_at,
      semantic_updated_at: updated_at, lifecycle_updated_at: updated_at,
      consolidated_count: 1, is_active,
    });
    craftCommittedGeneration('device-a', {
      'facts.jsonl': JSON.stringify(makeFact('Older device truth', '2026-08-28T01:00:00.000Z', 1)) + '\n',
    });
    craftCommittedGeneration('device-b', {
      'facts.jsonl': JSON.stringify(makeFact('Newer device truth', '2026-08-28T02:00:00.000Z', 0)) + '\n',
    });

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(1);
    const db = initDatabase();
    try {
      expect(db.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get('multi-device-fact'))
        .toEqual({ fact: 'Newer device truth', is_active: 0 });
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
      semantic_updated_at: tie,
      lifecycle_updated_at: tie,
      consolidated_count: 1,
      is_active,
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
      craftCommittedGeneration('dev-a', {
        'facts.jsonl': JSON.stringify(makeTieFact('Zulu decision', 1)) + '\n',
      });
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
      craftCommittedGeneration('dev-a', {
        'facts.jsonl': JSON.stringify(makeTieFact('Aardvark decision', 1)) + '\n',
      });
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

    it('an exact-time tie resolves to inactive on the lifecycle axis, meaning untouched', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');
      await seedLocalFact();

      // 재감사 P1-3 v4: lifecycle tie는 inactive가 이긴다(안전한 기본값).
      // 의미 축에서 'Aardvark' < 'Alpha'이므로 로컬 meaning은 유지되고,
      // lifecycle 축에서만 deactivate가 적용된다 — 두 축이 독립임의 증명.
      craftCommittedGeneration('dev-a', {
        'facts.jsonl': JSON.stringify(makeTieFact('Aardvark decision', 0)) + '\n',
      });
      const imported = await importFromSync();
      expect(imported.updatedFacts).toBe(1);

      const db = initDatabase();
      try {
        expect(db.prepare('SELECT fact, is_active FROM facts WHERE id = ?').get('tie-break-fact'))
          .toEqual({ fact: 'Alpha decision', is_active: 0 });
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
      craftCommittedGeneration('dev-a', {
        'fact-tombstones.jsonl': JSON.stringify({
          fact_id: 'tie-break-fact',
          deleted_at: tie,
          reason: 'hard_delete',
        }) + '\n',
      });
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
      craftCommittedGeneration('dev-b', {
        'facts.jsonl': JSON.stringify({
          id: 'privacy-fact',
          fact: 'Redis에서 세션 캐시를 사용한다',
          category: 'decision',
          scope_type: 'global',
          scope_project: null,
          source_exchange_ids: '[]',
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: peerEdit,
          semantic_updated_at: peerEdit,
          lifecycle_updated_at: peerEdit,
          consolidated_count: 1,
          is_active: 1,
        }) + '\n',
      });

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

      craftCommittedGeneration('dev-a', {
        'fact-tombstones.jsonl': JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: PRIVACY }) + '\n',
      });

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

      craftCommittedGeneration('dev-a', {
        'facts.jsonl': JSON.stringify({
          id: 'privacy-fact',
          fact: 'Redis에서 세션 캐시를 사용한다',
          category: 'decision',
          scope_type: 'global',
          scope_project: null,
          source_exchange_ids: '[]',
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: peerEdit,
          semantic_updated_at: peerEdit,
          lifecycle_updated_at: peerEdit,
          consolidated_count: 1,
          is_active: 1,
        }) + '\n',
      });

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

      craftCommittedGeneration('dev-a', {
        'fact-tombstones.jsonl': JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: 'hard_delete' }) + '\n',
      });

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

      craftCommittedGeneration('dev-a', {
        'fact-tombstones.jsonl': JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: 'hard_delete' }) + '\n',
      });

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
      craftCommittedGeneration('dev-a', {
        'fact-tombstones.jsonl': JSON.stringify({ fact_id: 'privacy-fact', deleted_at: purge, reason: PRIVACY }) + '\n',
      });
      craftCommittedGeneration('dev-b', {
        'fact-tombstones.jsonl': JSON.stringify({
          fact_id: 'privacy-fact',
          deleted_at: peerEdit,
          reason: 'hard_delete',
        }) + '\n',
      });

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

  describe('semantic conflict clock (재감사 P1-3 / T07)', () => {
    const SEMANTIC_LOCAL = '2026-08-29T02:00:00.000Z';
    const SEMANTIC_REMOTE_OLDER = '2026-08-29T01:00:00.000Z';
    const SEMANTIC_REMOTE_NEWER = '2026-08-29T03:00:00.000Z';
    const TOUCH_NEWER = '2026-08-29T04:00:00.000Z';
    const TOUCH_OLDER = '2026-08-29T00:30:00.000Z';

    function insertLocalFact(
      db: import('better-sqlite3').Database,
      overrides: { id?: string; fact?: string; updatedAt?: string; semanticUpdatedAt?: string } = {},
    ): void {
      db.prepare(`
        INSERT INTO facts
          (id, fact, category, scope_type, scope_project, source_exchange_ids,
           created_at, updated_at, consolidated_count, is_active, semantic_updated_at)
        VALUES (?, ?, 'decision', 'global', null, '[]',
                '2026-08-01T00:00:00.000Z', ?, 1, 1, ?)
      `).run(
        overrides.id ?? 'clock-fact',
        overrides.fact ?? 'Redis에서 세션 캐시를 사용한다',
        overrides.updatedAt ?? SEMANTIC_LOCAL,
        overrides.semanticUpdatedAt ?? SEMANTIC_LOCAL,
      );
    }

    function writeRemoteFact(
      overrides: { id?: string; fact?: string; updatedAt?: string; semanticUpdatedAt?: string },
    ): void {
      const semanticAt = overrides.semanticUpdatedAt ?? SEMANTIC_REMOTE_OLDER;
      craftCommittedGeneration('dev-a', {
      'facts.jsonl': JSON.stringify({
        id: overrides.id ?? 'clock-fact',
        fact: overrides.fact ?? 'Redis에서 세션 캐시를 사용한다',
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: '[]',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: overrides.updatedAt ?? TOUCH_NEWER,
        semantic_updated_at: semanticAt,
        lifecycle_updated_at: overrides.updatedAt ?? TOUCH_NEWER,
        consolidated_count: 1,
        is_active: 1,
      }) + '\n',
      });
    }

    it('T07: 로컬 의미 편집은 더 새로운 원격 metadata touch를 이긴다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      let db = initDatabase();
      try {
        // 로컬: 의미 편집(T2). 원격: 옛 문장(Redis)에 분류만 붙여 updated_at 만 T3.
        insertLocalFact(db, {
          fact: 'Postgres에서 세션 캐시를 사용한다',
          updatedAt: SEMANTIC_LOCAL,
          semanticUpdatedAt: SEMANTIC_LOCAL,
        });
      } finally {
        db.close();
      }

      writeRemoteFact({
        fact: 'Redis에서 세션 캐시를 사용한다',
        updatedAt: TOUCH_NEWER, // updated_at 만 더 새롭다 (metadata touch)
        semanticUpdatedAt: SEMANTIC_REMOTE_OLDER, // 의미는 더 오래됐다
      });

      const imported = await importFromSync();
      expect(imported.updatedFacts).toBe(0);

      db = initDatabase();
      try {
        const row = db
          .prepare('SELECT fact, semantic_updated_at FROM facts WHERE id = ?')
          .get('clock-fact') as { fact: string; semantic_updated_at: string };
        expect(row.fact).toBe('Postgres에서 세션 캐시를 사용한다');
        expect(row.semantic_updated_at).toBe(SEMANTIC_LOCAL);
      } finally {
        db.close();
      }
    });

    it('T07: 원격 의미 편집은 더 새로운 로컬 metadata touch를 이긴다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      let db = initDatabase();
      try {
        // 로컬: 옛 의미(T1)에 metadata touch 만 updated_at T3 로 밀었다.
        insertLocalFact(db, {
          fact: 'Redis에서 세션 캐시를 사용한다',
          updatedAt: TOUCH_NEWER,
          semanticUpdatedAt: SEMANTIC_REMOTE_OLDER,
        });
      } finally {
        db.close();
      }

      writeRemoteFact({
        fact: 'Postgres에서 세션 캐시를 사용한다',
        updatedAt: SEMANTIC_REMOTE_NEWER, // updated_at 은 로컬보다 오래됐다
        semanticUpdatedAt: SEMANTIC_REMOTE_NEWER, // 의미는 더 새롭다
      });

      const imported = await importFromSync();
      expect(imported.updatedFacts).toBe(1);

      db = initDatabase();
      try {
        const row = db
          .prepare('SELECT fact, semantic_updated_at FROM facts WHERE id = ?')
          .get('clock-fact') as { fact: string; semantic_updated_at: string };
        expect(row.fact).toBe('Postgres에서 세션 캐시를 사용한다');
        expect(row.semantic_updated_at).toBe(SEMANTIC_REMOTE_NEWER);
      } finally {
        db.close();
      }
    });

    it('가져온 fact는 원격의 semantic clock을 채택한다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      writeRemoteFact({
        id: 'fresh-remote-fact',
        fact: '완전히 새로 들어온 원격 fact',
        updatedAt: TOUCH_OLDER,
        semanticUpdatedAt: SEMANTIC_REMOTE_NEWER,
      });

      await importFromSync();

      const db = initDatabase();
      try {
        const row = db
          .prepare('SELECT semantic_updated_at, updated_at FROM facts WHERE id = ?')
          .get('fresh-remote-fact') as { semantic_updated_at: string; updated_at: string };
        expect(row.semantic_updated_at).toBe(SEMANTIC_REMOTE_NEWER);
        expect(row.updated_at).toBe(TOUCH_OLDER);
      } finally {
        db.close();
      }
    });

    it('v4 payload는 semantic_updated_at 결측을 폴백하지 않고 generation을 reject한다', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { getSyncDir } = await import('../src/sync-export.js');
      const { importFromSync } = await import('../src/sync-import.js');

      let db = initDatabase();
      try {
        insertLocalFact(db, {
          fact: 'Redis에서 세션 캐시를 사용한다',
          updatedAt: SEMANTIC_LOCAL,
          semanticUpdatedAt: SEMANTIC_LOCAL,
        });
      } finally {
        db.close();
      }

      // v4 strict: 시계 필드가 없는 행은 구버전 입력이 아니라 손상이다 —
      // updated_at 폴백 대신 generation 전체가 reject된다.
      const remoteRow = JSON.parse(JSON.stringify({
        id: 'clock-fact',
        fact: 'Postgres에서 세션 캐시를 사용한다',
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: '[]',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: TOUCH_NEWER,
        lifecycle_updated_at: TOUCH_NEWER,
        consolidated_count: 1,
        is_active: 1,
      }));
      delete remoteRow.semantic_updated_at;
      craftCommittedGeneration('dev-a', { 'facts.jsonl': JSON.stringify(remoteRow) + '\n' });

      const imported = await importFromSync();
      expect(imported.updatedFacts).toBe(0);
      expect(imported.malformedRows).toHaveLength(1);
      expect(imported.malformedRows[0].error).toContain('protocol v4 schema validation');

      db = initDatabase();
      try {
        const row = db
          .prepare('SELECT fact, semantic_updated_at FROM facts WHERE id = ?')
          .get('clock-fact') as { fact: string; semantic_updated_at: string };
        expect(row.fact).toBe('Redis에서 세션 캐시를 사용한다');
        expect(row.semantic_updated_at).toBe(SEMANTIC_LOCAL);
      } finally {
        db.close();
      }
    });


  describe('independent lifecycle axis (재감사 P1-3 v4)', () => {
    async function seedLocalFact(opts: {
      fact?: string;
      sources?: string[];
      semanticAt?: string;
      lifecycleAt?: string;
      isActive?: 0 | 1;
    }): Promise<{ id: string; createdAt: string }> {
      const { initDatabase } = await import('../src/db.js');
      const { insertFact } = await import('../src/fact-db.js');
      const db = initDatabase();
      let id: string;
      let createdAt: string;
      try {
        id = insertFact(db, {
          fact: opts.fact ?? 'Metrics are exported once per minute',
          category: 'decision',
          scope_type: 'global',
          scope_project: null,
          source_exchange_ids: opts.sources ?? ['ex-a'],
          embedding: new Array(384).fill(0.05),
        });
        const row = db.prepare('SELECT created_at FROM facts WHERE id = ?').get(id) as { created_at: string };
        createdAt = row.created_at;
        const semanticAt = opts.semanticAt ?? '2026-08-30T00:00:00.000Z';
        const lifecycleAt = opts.lifecycleAt ?? semanticAt;
        db.prepare(
          'UPDATE facts SET semantic_updated_at = ?, updated_at = ?, lifecycle_updated_at = ?, is_active = ?, needs_consolidation = 0 WHERE id = ?',
        ).run(semanticAt, semanticAt, lifecycleAt, opts.isActive ?? 1, id);
        if (opts.isActive === 0) db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
      } finally {
        db.close();
      }
      return { id, createdAt };
    }

    function remotePayload(opts: {
      id: string;
      createdAt: string;
      fact?: string;
      sources?: string[];
      semanticAt?: string;
      lifecycleAt?: string;
      is_active?: 0 | 1;
    }): string {
      const semanticAt = opts.semanticAt ?? '2026-08-30T00:00:00.000Z';
      return JSON.stringify({
        id: opts.id,
        fact: opts.fact ?? 'Metrics are exported once per minute',
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: JSON.stringify(opts.sources ?? ['ex-a']),
        created_at: opts.createdAt,
        updated_at: semanticAt,
        semantic_updated_at: semanticAt,
        lifecycle_updated_at: opts.lifecycleAt ?? semanticAt,
        consolidated_count: 1,
        is_active: opts.is_active ?? 1,
      }) + '\n';
    }

    it('a remote deactivation propagates through the lifecycle clock alone', async () => {
      // 로컬: T1 활성. 원격: 같은 의미, T5 deactivate. lifecycle 시계만 움직인다.
      const { id, createdAt } = await seedLocalFact({
        semanticAt: '2026-08-30T00:00:00.000Z',
        lifecycleAt: '2026-08-30T00:00:00.000Z',
      });
      craftCommittedGeneration('dev-a', {
        'facts.jsonl': remotePayload({
          id, createdAt, lifecycleAt: '2026-08-30T05:00:00.000Z', is_active: 0,
        }),
      });

      const { importFromSync } = await import('../src/sync-import.js');
      const imported = await importFromSync();

      const { initDatabase } = await import('../src/db.js');
      const db = initDatabase();
      try {
        expect(imported.updatedFacts).toBe(1);
        expect(db.prepare(
          'SELECT fact, is_active, lifecycle_generation, semantic_generation FROM facts WHERE id = ?',
        ).get(id)).toEqual({
          fact: 'Metrics are exported once per minute',
          is_active: 0,
          lifecycle_generation: 2, // deactivate는 lifecycle 시계를 올린다
          semantic_generation: 1,  // 의미는 변하지 않았다
        });
        expect((db.prepare('SELECT COUNT(*) AS n FROM vec_facts WHERE id = ?').get(id) as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    });

    it('a remote restore propagates and the fact becomes searchable again', async () => {
      // A deactivate → sync → restore 시나리오의 수렴 절반: 로컬 비활성 행이
      // 원격의 더 새로운 활성 이벤트를 받아 벡터와 함께 복원된다.
      const { id, createdAt } = await seedLocalFact({
        semanticAt: '2026-08-30T00:00:00.000Z',
        lifecycleAt: '2026-08-30T01:00:00.000Z', // 로컬 deactivate가 T1에 일어났다
        isActive: 0,
      });
      craftCommittedGeneration('dev-a', {
        'facts.jsonl': remotePayload({
          id, createdAt, lifecycleAt: '2026-08-30T05:00:00.000Z', is_active: 1,
        }),
      });

      const { importFromSync } = await import('../src/sync-import.js');
      await importFromSync();

      const { initDatabase } = await import('../src/db.js');
      const db = initDatabase();
      try {
        expect(db.prepare(
          'SELECT is_active, lifecycle_generation, embedding_version FROM facts WHERE id = ?',
        ).get(id)).toEqual({
          is_active: 1,
          lifecycle_generation: 2,
          embedding_version: 2, // mock의 현재 모델 버전
        });
        expect((db.prepare('SELECT COUNT(*) AS n FROM vec_facts WHERE id = ?').get(id) as { n: number }).n).toBe(1);
      } finally {
        db.close();
      }
    });

    it('a local lifecycle event survives a remote semantic win (Postgres + inactive)', async () => {
      // 재감사 P1-3 v4의 핵심 시나리오: 원격이 의미를 편집했고(semantic 승자),
      // 로컬이 그보다 나중에 deactivate했다(lifecycle 승자). 최종 수렴은
      // "원격 의미 + 로컬 비활성" — 어느 축도 롤백하지 않는다.
      const { id, createdAt } = await seedLocalFact({
        fact: 'Redis에서 세션 캐시를 사용한다',
        semanticAt: '2026-08-30T01:00:00.000Z',
        lifecycleAt: '2026-08-30T09:00:00.000Z', // 로컬 deactivate가 의미 편집보다 나중
        isActive: 0,
      });
      craftCommittedGeneration('dev-a', {
        'facts.jsonl': remotePayload({
          id, createdAt,
          fact: 'Postgres에서 세션 캐시를 사용한다',
          semanticAt: '2026-08-30T05:00:00.000Z',
          lifecycleAt: '2026-08-30T01:00:00.000Z',
          is_active: 1,
        }),
      });

      const { importFromSync } = await import('../src/sync-import.js');
      await importFromSync();

      const { initDatabase } = await import('../src/db.js');
      const db = initDatabase();
      try {
        expect(db.prepare(
          'SELECT fact, is_active, semantic_updated_at FROM facts WHERE id = ?',
        ).get(id)).toEqual({
          fact: 'Postgres에서 세션 캐시를 사용한다', // semantic 축: 원격 의미 수용
          is_active: 0,                              // lifecycle 축: 로컬 deactivate 유지
          semantic_updated_at: '2026-08-30T05:00:00.000Z',
        });
        // 비활성 fact는 벡터를 점유하지 않는다.
        expect((db.prepare('SELECT COUNT(*) AS n FROM vec_facts WHERE id = ?').get(id) as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe('commit-time live lineage merge (재감사 P1-2 v4)', () => {
    it('absorbs a concurrent DUPLICATE provenance merge during the embedding await', async () => {
      const { initDatabase } = await import('../src/db.js');
      const { insertFact } = await import('../src/fact-db.js');
      const { updateFact } = await import('../src/fact-db.js');
      const { generateEmbedding } = await import('../src/embeddings.js');
      const db = initDatabase();
      let id: string;
      let createdAt: string;
      try {
        id = insertFact(db, {
          fact: 'Metrics are exported once per minute',
          category: 'decision',
          scope_type: 'global',
          scope_project: null,
          source_exchange_ids: ['ex-a'],
          embedding: new Array(384).fill(0.05),
        });
        const row = db.prepare('SELECT created_at FROM facts WHERE id = ?').get(id) as { created_at: string };
        createdAt = row.created_at;
        db.prepare(
          "UPDATE facts SET semantic_updated_at = '2026-08-30T00:00:00.000Z', updated_at = '2026-08-30T00:00:00.000Z', needs_consolidation = 0 WHERE id = ?",
        ).run(id);
      } finally {
        db.close();
      }

      // 원격: 더 새로운 의미 + provenance [ex-c].
      craftCommittedGeneration('dev-a', {
        'facts.jsonl': remoteFactPayload({
          id, createdAt,
          fact: 'Metrics are exported on demand',
          sources: ['ex-c'],
          semanticAt: '2026-08-30T05:00:00.000Z',
        }),
      });

      // import의 embedding await을 gate로 잡고, 그 사이 consolidation과 같은
      // metadata 쓰기(semantic_generation 불변)가 provenance를 union한다.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
        await gate;
        return new Array(384).fill(0.05);
      });

      const { importFromSync } = await import('../src/sync-import.js');
      const pending = importFromSync();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const mid = initDatabase();
      try {
        updateFact(mid, id, {
          consolidated_count_increment: true,
          source_exchange_ids: ['ex-a', 'ex-b'], // DUPLICATE merge 흉내
        });
      } finally {
        mid.close();
      }
      release();
      await pending;

      const check = initDatabase();
      try {
        expect(check.prepare(
          'SELECT fact, source_exchange_ids, consolidated_count FROM facts WHERE id = ?',
        ).get(id)).toEqual({
          fact: 'Metrics are exported on demand',
          // commit 시점 live union: ex-b는 결코 유실되지 않는다.
          source_exchange_ids: '["ex-a","ex-b","ex-c"]',
          consolidated_count: 2, // max(remote 1, current 1+1)
        });
      } finally {
        check.close();
      }
    });
  });
  });
});
