import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportForSync, getSyncDir } from '../src/sync-export.js';
import { importFromSync } from '../src/sync-import.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import type DatabaseType from 'better-sqlite3';

/**
 * 재감사 P2-5/P2-7 — sync snapshot generation 원자성과 malformed 보고.
 *
 * 한 export는 하나의 generation: 단일 read transaction → generations/<uuid>.tmp
 * 작성 → 원자적 rename commit → CURRENT manifest 원자 교체. importer는 committed
 * generation만 읽는다. 완료되지 않은(또는 CURRENT가 가리키지 않는) 파일 집합은
 * 존재하지 않았던 것처럼 무시되고, malformed 행은 유효 행 import와 함께
 * file/line 보고된다.
 */

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mx-gen-'));
}

let home: string;
let dbPath: string;
let priorHome: string | undefined;
let priorDb: string | undefined;
let db: DatabaseType.Database;

beforeEach(() => {
  home = tmpHome();
  dbPath = path.join(home, 'conversation-index', 'db.sqlite');
  priorHome = process.env.MEMEX_HOME;
  priorDb = process.env.MEMEX_DB_PATH;
  process.env.MEMEX_HOME = home;
  process.env.MEMEX_DB_PATH = dbPath;
  db = initDatabase();
});

afterEach(() => {
  db.close();
  if (priorHome === undefined) delete process.env.MEMEX_HOME;
  else process.env.MEMEX_HOME = priorHome;
  if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
  else process.env.MEMEX_DB_PATH = priorDb;
  fs.rmSync(home, { recursive: true, force: true });
});

function deviceId(): string {
  return fs.readdirSync(path.join(getSyncDir(), 'devices'))[0];
}

function committedGeneration(): { deviceDir: string; genDir: string; id: string } {
  const deviceDir = path.join(getSyncDir(), 'devices', deviceId());
  const id = (JSON.parse(fs.readFileSync(path.join(deviceDir, 'CURRENT'), 'utf8')) as {
    generation: string;
  }).generation;
  return { deviceDir, genDir: path.join(deviceDir, 'generations', id), id };
}

function seedFact(text: string): string {
  return insertFact(db, {
    fact: text,
    category: 'decision',
    scope_type: 'global',
    scope_project: null,
    source_exchange_ids: [],
    embedding: null,
  });
}

/** A valid export-format fact row, for handcrafted peer device snapshots. */
function fixtureFact(id: string, fact: string): string {
  return JSON.stringify({
    id,
    fact,
    category: 'decision',
    scope_type: 'global',
    scope_project: null,
    source_exchange_ids: '[]',
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    semantic_updated_at: '2026-08-30T00:00:00.000Z',
    consolidated_count: 1,
    is_active: 1,
    ontology_category_id: null,
  }) + '\n';
}

/** Craft a peer device snapshot exactly the way the exporter commits one. */
function craftGeneration(deviceId: string, generation: string, factsBody: string): string {
  const deviceDir = path.join(getSyncDir(), 'devices', deviceId);
  const genDir = path.join(deviceDir, 'generations', generation);
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, 'facts.jsonl'), factsBody);
  for (const name of [
    'fact-revisions.jsonl',
    'fact-tombstones.jsonl',
    'recall-events.jsonl',
    'ontology-domains.jsonl',
    'ontology-categories.jsonl',
    'ontology-relations.jsonl',
  ]) {
    fs.writeFileSync(path.join(genDir, name), '');
  }
  return deviceDir;
}

function flipCurrent(deviceDir: string, generation: string): void {
  fs.writeFileSync(
    path.join(deviceDir, 'CURRENT'),
    JSON.stringify({ generation, exported_at: '2026-08-30T00:00:00.000Z' }, null, 2),
  );
}

function localFactCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM facts').get() as { c: number }).c;
}

describe('sync export generation atomicity (P2-5)', () => {
  it('commits one generation, names it in CURRENT, and keeps the root mirror', () => {
    seedFact('generation contract fact');
    const result = exportForSync();
    expect(result.facts).toBe(1);

    const { genDir, id } = committedGeneration();
    expect(fs.existsSync(genDir)).toBe(true);
    for (const name of [
      'facts.jsonl',
      'fact-revisions.jsonl',
      'fact-tombstones.jsonl',
      'recall-events.jsonl',
      'ontology-domains.jsonl',
      'ontology-categories.jsonl',
      'ontology-relations.jsonl',
      'meta.json',
    ]) {
      expect(fs.existsSync(path.join(genDir, name)), name).toBe(true);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(genDir, 'meta.json'), 'utf-8')) as {
      generation: string;
    };
    expect(meta.generation).toBe(id);

    // New layout never leaves a partial device-root payload set.
    expect(
      fs.existsSync(path.join(getSyncDir(), 'devices', deviceId(), 'facts.jsonl')),
    ).toBe(false);
    // v1 root mirror stays refreshed for old readers.
    expect(fs.existsSync(path.join(getSyncDir(), 'facts.jsonl'))).toBe(true);
  });

  it('import reads only the committed generation — crashed exports are ignored', async () => {
    const deviceDir = craftGeneration(
      'dev-a',
      'gen-committed',
      fixtureFact('fact-committed', 'fact from the committed generation'),
    );
    flipCurrent(deviceDir, 'gen-committed');

    // (a) crashed export: a .tmp generation whose payload would import if seen
    const crashedTmp = path.join(deviceDir, 'generations', 'deadbeef.tmp');
    fs.mkdirSync(crashedTmp, { recursive: true });
    fs.writeFileSync(
      path.join(crashedTmp, 'facts.jsonl'),
      fixtureFact('tmp-crash-fact', 'fact from a crashed export'),
    );
    // (b) a fully written generation that CURRENT does not name
    fs.mkdirSync(path.join(deviceDir, 'generations', 'notcurrent'), { recursive: true });
    fs.writeFileSync(
      path.join(deviceDir, 'generations', 'notcurrent', 'facts.jsonl'),
      fixtureFact('uncommitted-fact', 'fact from an uncommitted generation'),
    );

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(1); // only the committed generation's fact
    expect(imported.malformedRows).toEqual([]);
  });

  it('the CURRENT flip is the commit point — an unflipped set is invisible', async () => {
    const deviceDir = craftGeneration(
      'dev-b',
      'gen-1',
      fixtureFact('fact-a', 'fact A from dev B'),
    );
    flipCurrent(deviceDir, 'gen-1');

    expect((await importFromSync()).newFacts).toBe(1);
    expect(localFactCount()).toBe(1);

    // Write the next generation completely but DO NOT flip CURRENT yet:
    // the new file set must be invisible to importers.
    craftGeneration(
      'dev-b',
      'gen-2',
      fixtureFact('fact-a', 'fact A from dev B') + fixtureFact('fact-b', 'fact B from dev B'),
    );
    expect((await importFromSync()).newFacts).toBe(0); // gen-2 ignored
    expect(localFactCount()).toBe(1);

    flipCurrent(deviceDir, 'gen-2');
    await importFromSync();
    expect(localFactCount()).toBe(2); // both facts now reconciled
  });
});

describe('malformed sync payload reporting (P2-7)', () => {
  it('imports valid rows and reports malformed rows with file and line', async () => {
    const valid = {
      id: 'row-valid-fact',
      fact: 'valid imported fact',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: '[]',
      created_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T00:00:00.000Z',
      consolidated_count: 1,
      is_active: 1,
      ontology_category_id: null,
    };
    const syncDir = getSyncDir();
    fs.writeFileSync(
      path.join(syncDir, 'facts.jsonl'),
      JSON.stringify(valid) + '\n{broken json line\n',
    );

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(1);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].file.endsWith('facts.jsonl')).toBe(true);
    expect(imported.malformedRows[0].line).toBe(2);
  });

  it('reports a broken CURRENT manifest instead of silently skipping the device', async () => {
    const deviceDir = craftGeneration(
      'dev-c',
      'gen-broken',
      fixtureFact('fact-from-dev-c', 'fact behind a broken manifest'),
    );
    flipCurrent(deviceDir, 'gen-broken');
    fs.writeFileSync(path.join(deviceDir, 'CURRENT'), '{ not json');

    const imported = await importFromSync();
    // The device is skipped (fallback device root has no payload) — but the
    // damage is reported, never silent.
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].file.endsWith('CURRENT')).toBe(true);
    expect(imported.malformedRows[0].error).toContain('unreadable');
  });
});
