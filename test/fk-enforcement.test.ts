import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase, insertExchange, deleteExchange, openReadDb, getVecTableDtype, embeddingToVecBlob, vecParamSql } from '../src/db.js';
import { insertFact, insertRevision } from '../src/fact-db.js';
import { createRelation } from '../src/ontology-db.js';
import { purgeConversationFromIndex } from '../src/conversation-policy.js';
import { repairForeignKeyViolations } from '../src/verify.js';
import type { ConversationExchange } from '../src/types.js';
import type DatabaseType from 'better-sqlite3';

type FkViolation = { table: string; rowid: number; parent: string; fkid: number };

function fkCheck(db: DatabaseType.Database): FkViolation[] {
  return db.pragma('foreign_key_check') as FkViolation[];
}

describe('foreign key enforcement (P2-1, adjusted: FK is already ON)', () => {
  let db: DatabaseType.Database;
  let tmpDir: string;
  let dbPath: string;
  let oldDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-fk-'));
    oldDbPath = process.env.MEMEX_DB_PATH;
    dbPath = path.join(tmpDir, 'test.db');
    process.env.MEMEX_DB_PATH = dbPath;
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    if (oldDbPath === undefined) delete process.env.MEMEX_DB_PATH;
    else process.env.MEMEX_DB_PATH = oldDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('declares FK enforcement explicitly on every connection', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const reader = openReadDb(dbPath);
    try {
      expect(reader.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('exchange delete path leaves zero FK violations', () => {
    const exchange: ConversationExchange = {
      id: 'ex-1',
      project: '/proj/a',
      timestamp: '2026-03-01T00:00:00.000Z',
      userMessage: 'question',
      assistantMessage: 'answer',
      archivePath: '/tmp/archives/ex-1.jsonl',
      lineStart: 1,
      lineEnd: 2,
      toolCalls: [
        {
          id: 'tc-1',
          exchangeId: 'ex-1',
          toolName: 'bash',
          toolInput: 'ls',
          toolResult: 'ok',
          isError: false,
          timestamp: '2026-03-01T00:00:00.000Z',
        },
      ],
    };
    insertExchange(db, exchange, new Array<number>(384).fill(0));
    expect((db.prepare('SELECT COUNT(*) c FROM tool_calls').get() as { c: number }).c).toBe(1);

    deleteExchange(db, 'ex-1');

    expect(fkCheck(db)).toEqual([]);
  });

  it('privacy purge path removes fact children first and leaves zero FK violations', () => {
    const archivePath = '/tmp/archives/purge.jsonl';
    const makeExchange = (id: string): ConversationExchange => ({
      id,
      project: '/proj/a',
      timestamp: '2026-03-01T00:00:00.000Z',
      userMessage: `question ${id}`,
      assistantMessage: 'answer',
      archivePath,
      lineStart: 1,
      lineEnd: 2,
      sessionId: 'sess-purge',
    });
    insertExchange(db, makeExchange('purge-ex-1'), new Array<number>(384).fill(0));
    insertExchange(db, makeExchange('purge-ex-2'), new Array<number>(384).fill(0));

    const factA = insertFact(db, {
      fact: 'purged fact a',
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: ['purge-ex-1'],
      embedding: null,
    });
    const factB = insertFact(db, {
      fact: 'surviving fact b',
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: null,
    });
    createRelation(db, factA, 'SUPPORTS', factB);
    insertRevision(db, {
      fact_id: factA,
      previous_fact: 'before',
      new_fact: 'after',
      reason: null,
      source_exchange_id: 'purge-ex-1',
    });

    purgeConversationFromIndex(db, { archivePath, sessionId: 'sess-purge' });

    expect((db.prepare('SELECT COUNT(*) c FROM facts WHERE id = ?').get(factA) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(factA, factA) as { c: number }).c).toBe(0);
    expect(fkCheck(db)).toEqual([]);
  });

  it('privacy purge invalidates the whole derived taxonomy and rebuilds overlays from public facts (재감사 P1-4 v4)', () => {
    const archivePath = '/tmp/archives/purge-taxonomy.jsonl';
    const makeExchange = (id: string): ConversationExchange => ({
      id,
      project: '/proj/a',
      timestamp: '2026-03-01T00:00:00.000Z',
      userMessage: `question ${id}`,
      assistantMessage: 'answer',
      archivePath,
      lineStart: 1,
      lineEnd: 2,
      sessionId: 'sess-purge-taxonomy',
    });
    insertExchange(db, makeExchange('purge-tax-ex'), new Array<number>(384).fill(0));

    const purgedFact = insertFact(db, {
      fact: 'private fact behind the exclusion',
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: ['purge-tax-ex'],
      embedding: null,
    });
    const survivingFact = insertFact(db, {
      fact: 'public fact that survives',
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: null,
    });
    // LLM이 private fact를 보고 만든 taxonomy — description과 벡터가 파생 증거다.
    const now = '2026-03-01T00:00:00.000Z';
    db.prepare(
      "INSERT INTO ontology_domains (id, name, description, created_at) VALUES ('dom-private', 'Infra', 'derived from a private conversation', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES ('cat-private', 'dom-private', 'Caching', 'derived description', ?)",
    ).run(now);
    const dtype = getVecTableDtype(db, 'vec_categories');
    db.prepare(
      `INSERT INTO vec_categories (id, embedding) VALUES ('cat-private', ${vecParamSql(dtype)})`,
    ).run(embeddingToVecBlob(new Array(384).fill(0.01), dtype));
    db.prepare('UPDATE facts SET ontology_category_id = ? WHERE id IN (?, ?)')
      .run('cat-private', purgedFact, survivingFact);

    purgeConversationFromIndex(db, { archivePath, sessionId: 'sess-purge-taxonomy' });

    // taxonomy는 derived 상태이므로 전면 invalidate된다 — private 유래
    // description/벡터가 잔존하면 purge 계약("model-derived state is removed")이
    // 깨지고, sync로도 더 이상 전파되지 않는다(v4: taxonomy 비동행).
    expect((db.prepare('SELECT COUNT(*) c FROM ontology_domains').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM ontology_categories').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM vec_categories').get() as { c: number }).c).toBe(0);
    // 잔존 fact의 overlay는 끊긴다 — 분류 백필이 공개 facts만으로 재구축한다.
    expect(db.prepare('SELECT ontology_category_id FROM facts WHERE id = ?').get(survivingFact))
      .toEqual({ ontology_category_id: null });
    expect((db.prepare('SELECT COUNT(*) c FROM facts WHERE id = ?').get(purgedFact) as { c: number }).c).toBe(0);
    expect(fkCheck(db)).toEqual([]);
  });

  it('detects and repairs pre-existing orphans in a legacy fixture', () => {
    // Simulate a database that foreign tooling edited with FKs off: create
    // the schema with Memex, then reopen raw, disable FKs, and delete parents
    // whose child rows stay behind.
    db.close();
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = OFF');

    raw.prepare(
      `INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
       VALUES ('ex-legacy', '/proj/a', '2026-03-01T00:00:00.000Z', 'u', 'a', '/tmp/archives/legacy.jsonl', 1, 2)`,
    ).run();
    raw.prepare(
      `INSERT INTO tool_calls (id, exchange_id, tool_name, timestamp)
       VALUES ('tc-legacy', 'ex-legacy', 'bash', '2026-03-01T00:00:00.000Z')`,
    ).run();

    const factA = insertFact(raw as unknown as DatabaseType.Database, {
      fact: 'legacy fact a',
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: null,
    });
    const factB = insertFact(raw as unknown as DatabaseType.Database, {
      fact: 'legacy fact b',
      category: 'general',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: null,
    });
    raw.prepare(
      `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id)
       VALUES ('rel-legacy', ?, 'SUPPORTS', ?)`,
    ).run(factA, factB);
    insertRevision(raw as unknown as DatabaseType.Database, {
      fact_id: factA,
      previous_fact: 'before',
      new_fact: 'after',
      reason: null,
      source_exchange_id: null,
    });

    raw.prepare('DELETE FROM exchanges WHERE id = ?').run('ex-legacy');
    raw.prepare('DELETE FROM facts WHERE id = ? OR id = ?').run(factA, factB);
    raw.close();

    // Reopen through Memex (FK ON) — the pre-existing violations must surface.
    db = initDatabase();
    const violations = fkCheck(db);
    const tables = violations.map((v) => v.table);
    expect(tables).toContain('tool_calls');
    expect(tables).toContain('fact_revisions');
    expect(tables).toContain('ontology_relations');

    const removed = repairForeignKeyViolations(db, violations);
    expect(removed).toBe(violations.length);
    expect(fkCheck(db)).toEqual([]);
  });
});
