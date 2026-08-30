import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportForSync, getSyncDir, pruneGenerations } from '../src/sync-export.js';
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
    lifecycle_updated_at: '2026-08-30T00:00:00.000Z',
    consolidated_count: 1,
    is_active: 1,
  }) + '\n';
}

/** Craft a peer device snapshot exactly the way the exporter commits one. */
function craftGeneration(deviceId: string, generation: string, factsBody: string): string {
  const deviceDir = path.join(getSyncDir(), 'devices', deviceId);
  const genDir = path.join(deviceDir, 'generations', generation);
  fs.mkdirSync(genDir, { recursive: true });
  const payloads: Record<string, string> = {
    'facts.jsonl': factsBody,
    'fact-revisions.jsonl': '',
    'fact-tombstones.jsonl': '',
    'recall-events.jsonl': '',
  };
  for (const [name, body] of Object.entries(payloads)) {
    fs.writeFileSync(path.join(genDir, name), body);
  }
  // integrity manifest(P1-4 보강) — importer가 fail-closed로 검증한다.
  const rows = (content: string) => content.split('\n').filter((line) => line.trim() !== '').length;
  const sha256 = (content: string) =>
    createHash('sha256').update(content, 'utf8').digest('hex');
  fs.writeFileSync(
    path.join(genDir, 'meta.json'),
    JSON.stringify({
      protocol_version: 4,
      generation,
      device_id: deviceId,
      exported_at: '2026-08-30T00:00:00.000Z',
      files: Object.fromEntries(
        Object.entries(payloads).map(([name, body]) => [name, { rows: rows(body), sha256: sha256(body) }]),
      ),
    }, null, 2),
  );
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
  it('commits one v4 generation, names it in CURRENT, and leaves no root mirror', () => {
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
      'meta.json',
    ]) {
      expect(fs.existsSync(path.join(genDir, name)), name).toBe(true);
    }
    // Protocol v4: ontology/translation are LOCAL DERIVED state — they no
    // longer travel (재감사 P1-4 v4), so they are not in the generation.
    for (const name of [
      'ontology-domains.jsonl',
      'ontology-categories.jsonl',
      'ontology-relations.jsonl',
    ]) {
      expect(fs.existsSync(path.join(genDir, name)), name).toBe(false);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(genDir, 'meta.json'), 'utf-8')) as {
      generation: string;
      protocol_version: number;
    };
    expect(meta.generation).toBe(id);
    expect(meta.protocol_version).toBe(4);

    // New layout never leaves a partial device-root payload set.
    expect(
      fs.existsSync(path.join(getSyncDir(), 'devices', deviceId(), 'facts.jsonl')),
    ).toBe(false);
    // Root mirror is gone (P1-1): committed generations are the whole protocol.
    expect(fs.existsSync(path.join(getSyncDir(), 'facts.jsonl'))).toBe(false);
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

describe('malformed sync payload reporting (P2-7 → P1-4 fail-closed)', () => {
  it('rejects the whole generation when a payload row is malformed', async () => {
    // exporter만이 payload를 만든다 — malformed 행은 곧 부분 전송/손상이다.
    // 유효 행만 살려 import하던 구 계약은 부분 commit을 허용했으므로, 이제
    // generation 전체가 reject되고 손상 위치가 보고된다.
    const valid = {
      id: 'row-valid-fact',
      fact: 'valid imported fact',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: '[]',
      created_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T00:00:00.000Z',
      semantic_updated_at: '2026-08-30T00:00:00.000Z',
      lifecycle_updated_at: '2026-08-30T00:00:00.000Z',
      consolidated_count: 1,
      is_active: 1,
    };
    craftGeneration(
      'dev-malformed',
      'gen-malformed',
      JSON.stringify(valid) + '\n{broken json line\n',
    );
    flipCurrent(path.join(getSyncDir(), 'devices', 'dev-malformed'), 'gen-malformed');

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].file.endsWith('CURRENT')).toBe(true);
    expect(imported.malformedRows[0].error).toContain('facts.jsonl malformed JSON at line 2');
    expect(imported.malformedRows[0].error).toContain('rejected');
  });

  it('fails closed on a broken CURRENT manifest: the device snapshot is rejected and reported', async () => {
    const deviceDir = craftGeneration(
      'dev-c',
      'gen-broken',
      fixtureFact('fact-from-dev-c', 'fact behind a broken manifest'),
    );
    flipCurrent(deviceDir, 'gen-broken');
    fs.writeFileSync(path.join(deviceDir, 'CURRENT'), '{ not json');

    const imported = await importFromSync();
    // Fail-closed (P1-4): even though the generation directory is intact, an
    // unreadable CURRENT means its commit point cannot be trusted — the whole
    // device snapshot is skipped, never fallen back to older payloads.
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].file.endsWith('CURRENT')).toBe(true);
    expect(imported.malformedRows[0].error).toContain('rejected');
    expect(imported.malformedRows[0].error).toContain('unreadable');
  });

  it('fails closed when CURRENT names a generation that is missing', async () => {
    const deviceDir = craftGeneration(
      'dev-d',
      'gen-vanished',
      fixtureFact('fact-from-dev-d', 'fact behind a vanished generation'),
    );
    flipCurrent(deviceDir, 'gen-vanished');
    fs.rmSync(path.join(deviceDir, 'generations', 'gen-vanished'), { recursive: true, force: true });

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].error).toContain('rejected');
  });
});

describe('generation reader pinning (재감사 P1-4)', () => {
  it('rejects a whole committed generation when one required payload file is missing', async () => {
    // A committed generation is set-atomic: a partially readable generation is
    // a pruning/corruption symptom, and importing the surviving files as
    // "empty tombstones, empty relations" would be a silent partial commit.
    const deviceDir = craftGeneration(
      'dev-e',
      'gen-partial',
      fixtureFact('fact-partial', 'fact inside an incomplete generation'),
    );
    flipCurrent(deviceDir, 'gen-partial');
    fs.rmSync(path.join(deviceDir, 'generations', 'gen-partial', 'fact-tombstones.jsonl'));

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].error).toContain('unreadable fact-tombstones.jsonl');
    expect(imported.malformedRows[0].error).toContain('rejected');
  });

  it('rejects a generation whose manifest declares an unsupported protocol version', async () => {
    // Protocol v4: v3 payloads (ontology files, legacy-tolerant fact rows) are
    // not readable — no legacy peers exist by decision.
    const deviceDir = craftGeneration(
      'dev-proto',
      'gen-v3',
      fixtureFact('fact-v3', 'fact written with protocol v3'),
    );
    flipCurrent(deviceDir, 'gen-v3');
    const metaPath = path.join(deviceDir, 'generations', 'gen-v3', 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { protocol_version: number };
    meta.protocol_version = 3;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].error).toContain('unsupported protocol_version 3');
  });

  it('rejects a whole generation when a fact row is schema-invalid (v4 strict rows)', async () => {
    // JSON은 valid하지만 v4 row schema가 아닌 행(semantic/lifecycle 시계 결손)은
    // 조용히 skip되지 않는다 — generation 전체 reject가 계약이다.
    const invalidRow = JSON.stringify({
      id: 'fact-no-clocks',
      fact: 'fact missing its clocks',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: '[]',
      created_at: '2026-08-30T00:00:00.000Z',
      updated_at: '2026-08-30T00:00:00.000Z',
      consolidated_count: 1,
      is_active: 1,
    }) + '\n';
    craftGeneration('dev-schema', 'gen-schema', invalidRow);
    flipCurrent(path.join(getSyncDir(), 'devices', 'dev-schema'), 'gen-schema');

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].file.endsWith('facts.jsonl')).toBe(true);
    expect(imported.malformedRows[0].error).toContain('protocol v4 schema validation');
    expect(imported.malformedRows[0].error).toContain('rejected');
  });

  it('ignores a stale root mirror when a committed generation exists (P1-1 regression)', async () => {
    // The exporter used to refresh a per-file root mirror after committing the
    // generation; a reader that consumed BOTH could see a mixed snapshot.
    // The importer now trusts committed generations only.
    craftGeneration('dev-f', 'gen-new', fixtureFact('fact-current', 'fact from the committed generation'));
    flipCurrent(path.join(getSyncDir(), 'devices', 'dev-f'), 'gen-new');
    const syncDir = getSyncDir();
    fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'), fixtureFact('fact-stale-root', 'fact from a stale root mirror'));
    fs.writeFileSync(
      path.join(syncDir, 'fact-tombstones.jsonl'),
      JSON.stringify({ fact_id: 'fact-current', deleted_at: '2026-08-30T01:00:00.000Z', reason: 'hard_delete' }) + '\n',
    );

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(1); // the generation's fact, not the root's
    expect(imported.malformedRows).toEqual([]);
    const db2 = initDatabase();
    try {
      const present = db2.prepare('SELECT fact FROM facts WHERE id = ?').get('fact-current');
      const rootFact = db2.prepare('SELECT fact FROM facts WHERE id = ?').get('fact-stale-root');
      expect(present).toEqual({ fact: 'fact from the committed generation' });
      expect(rootFact).toBeUndefined();
    } finally {
      db2.close();
    }
  });

  it('ignores and reports legacy device-root payloads (device-root reading removed)', async () => {
    const syncDir = getSyncDir();
    const legacyDevice = path.join(syncDir, 'devices', 'dev-legacy');
    fs.mkdirSync(legacyDevice, { recursive: true });
    fs.writeFileSync(path.join(legacyDevice, 'facts.jsonl'), fixtureFact('fact-legacy-root', 'legacy device-root fact'));

    const imported = await importFromSync();
    expect(imported.newFacts).toBe(0);
    expect(imported.malformedRows).toHaveLength(1);
    expect(imported.malformedRows[0].error).toContain('legacy device-root payload');
    expect(imported.malformedRows[0].error).toContain('dev-legacy');
  });
});

describe('concurrent export pruning protects the live CURRENT (재감사 P2 hardening)', () => {
  it('a stale exporter pruning with an old currentId never deletes the generation CURRENT names', () => {
    const ids: string[] = [];
    const utimesSync = require('node:fs').utimesSync as typeof import('node:fs').utimesSync;
    for (let i = 0; i < 4; i++) {
      seedFact(`prune probe fact ${i}`);
      exportForSync();
      ids.push(committedGeneration().id);
      // mtime을 인위적으로 격리한다 — 동시 export들은 밀리초 단위로 겹친다.
      const dir = path.join(getSyncDir(), 'devices', deviceId(), 'generations', ids[i]);
      const t = new Date(Date.now() - (4 - i) * 60_000);
      utimesSync(dir, t, t);
    }
    const generationsDir = path.join(getSyncDir(), 'devices', deviceId(), 'generations');
    // 시간이 늦은 exporter가 자기 currentId(ids[1])로 prune한다 — CURRENT는 이미 ids[3].
    pruneGenerations(generationsDir, ids[1]);
    const remaining = fs.readdirSync(generationsDir).filter((n) => !n.endsWith('.tmp'));
    expect(remaining).toContain(ids[3]); // live CURRENT — 결코 삭제되지 않는다
    expect(remaining).toContain(ids[2]); // keep=2 유예 윈도우 유지
    expect(remaining).not.toContain(ids[0]); // 윈도우 밖은 정리된다
  });
});

describe('local export transaction serialization (재감사 P2 hardening)', () => {
  it('leaves no cloud-synced lock artifact and allows the next export after commit', () => {
    seedFact('lock release probe fact');
    exportForSync();
    const lockPath = path.join(getSyncDir(), 'export.lock');
    expect(fs.existsSync(lockPath)).toBe(false);
    // SQLite transaction ownership is released at commit, so the next export succeeds.
    expect(exportForSync().facts).toBe(1);
  });
});
