import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initDatabase } from '../dist/db.js';
import { insertFact } from '../dist/fact-db.js';
import { createRelation } from '../dist/ontology-db.js';
import { snapshotAndRestore, hashFile } from '../scripts/memory-integrity-snapshot.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-recovery-e2e-'));
  const home = path.join(root, 'home'), sessions = path.join(root, 'sessions');
  fs.mkdirSync(path.join(home, 'conversation-index'), { recursive: true });
  fs.mkdirSync(sessions);
  const db = new Database(path.join(home, 'conversation-index/db.sqlite'));
  db.exec('CREATE TABLE facts(id TEXT PRIMARY KEY); INSERT INTO facts VALUES (\'preserve\')'); db.close();
  fs.mkdirSync(path.join(home, 'journal'));
  fs.mkdirSync(path.join(home, 'sync'));
  fs.writeFileSync(path.join(home, 'journal/closed.jsonl'), '{"journal":true}\n');
  fs.writeFileSync(path.join(home, 'sync/CURRENT'), 'generation');
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), '{"original":true}\n');
  return { root, home, sessions };
}

test('snapshot restores DB, journal, sync and original rollouts without source writes', async () => {
  const f = fixture();
  try {
    const source = path.join(f.sessions, 'rollout.jsonl');
    const before = await hashFile(source);
    const result = await snapshotAndRestore({ memexHome: f.home, sessionsRoot: f.sessions, output: path.join(f.root, 'backup') });
    assert.equal(result.status, 'RESTORE_VERIFIED');
    assert.equal(result.capture.crossRootAtomicity, 'NOT_PROVEN');
    assert.equal(result.restore.status, 'PASS');
    assert.equal(result.restore.hashesVerified, 4);
    assert.equal(await hashFile(source), before);
    const restored = new Database(path.join(f.root, 'backup/restored/memex/conversation-index/db.sqlite'), { readonly: true });
    assert.deepEqual(restored.prepare('SELECT * FROM facts').all(), [{ id: 'preserve' }]); restored.close();
    await assert.rejects(snapshotAndRestore({ memexHome: f.home, sessionsRoot: f.sessions, output: path.join(f.home, 'nested') }), /outside/);
    await assert.rejects(snapshotAndRestore({ memexHome: f.home, sessionsRoot: f.sessions, output: path.join(f.root, 'backup') }), /new directory/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('unstable source capture fails separately from successful byte restoration', async () => {
  const f = fixture(); const original = fs.copyFileSync;
  try {
    fs.copyFileSync = (input, ...args) => {
      original(input, ...args);
      if (String(input).endsWith('/sessions/rollout.jsonl')) fs.appendFileSync(input, 'concurrent write\n');
    };
    const result = await snapshotAndRestore({ memexHome: f.home, sessionsRoot: f.sessions, output: path.join(f.root, 'backup') });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.capture.fileStability, 'FAIL');
    assert.equal(result.restore.status, 'PASS');
    assert.deepEqual(result.unstable, ['sessions/rollout.jsonl']);
  } finally { fs.copyFileSync = original; fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('audit CLI does not initialize an unsupported database or emit a success report', () => {
  const f = fixture();
  try {
    const dbPath = path.join(f.home, 'conversation-index/db.sqlite');
    // A minimal schema is insufficient; failure must not initialize or migrate it.
    const before = fs.readFileSync(dbPath);
    const run = spawnSync(process.execPath, ['scripts/fact-integrity.mjs', 'audit', dbPath, path.join(f.root, 'report.json')], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.deepEqual(fs.readFileSync(dbPath), before);
    assert.equal(fs.existsSync(path.join(f.root, 'report.json')), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('audit/select/apply CLI repairs only previewed derived rows and is replay-safe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-integrity-cli-'));
  const savedHome = process.env.MEMEX_HOME, savedDb = process.env.TEST_DB_PATH;
  const dbPath = path.join(root, 'db.sqlite'), preview = path.join(root, 'preview.json'), selection = path.join(root, 'selection.json');
  process.env.MEMEX_HOME = path.join(root, 'home'); process.env.TEST_DB_PATH = dbPath;
  try {
    const db = initDatabase();
    const params = { category: 'knowledge', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: new Array(384).fill(0.1) };
    const a = insertFact(db, { ...params, fact: 'First fact stays unchanged' });
    const b = insertFact(db, { ...params, fact: 'Second fact stays unchanged' });
    const relation = createRelation(db, a, 'SUPPORTS', b);
    db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(b);
    const before = db.prepare('SELECT * FROM facts ORDER BY id').all(); db.close();
    const run = (...args) => {
      const child = spawnSync(process.execPath, ['scripts/fact-integrity.mjs', ...args], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
    };
    run('audit', dbPath, preview);
    const report = JSON.parse(fs.readFileSync(preview, 'utf8'));
    const ids = report.findings.filter(f => f.code === 'orphan-relation' && f.target.id === relation.id).map(f => f.id);
    assert.equal(ids.length, 1); fs.writeFileSync(selection, JSON.stringify(ids));
    assert.equal(run('apply', dbPath, preview, selection).applied.length, 1);
    const repeat = run('apply', dbPath, preview, selection);
    assert.deepEqual(repeat, { applied: [], alreadyApplied: ids });
    const after = new Database(dbPath, { readonly: true });
    assert.deepEqual(after.prepare('SELECT * FROM facts ORDER BY id').all(), before);
    assert.equal(after.prepare('SELECT COUNT(*) n FROM ontology_relations').get().n, 0); after.close();
    const overwrite = spawnSync(process.execPath, ['scripts/fact-integrity.mjs', 'audit', dbPath, preview], { encoding: 'utf8' });
    assert.notEqual(overwrite.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(preview, 'utf8')), report);
  } finally {
    if (savedHome === undefined) delete process.env.MEMEX_HOME; else process.env.MEMEX_HOME = savedHome;
    if (savedDb === undefined) delete process.env.TEST_DB_PATH; else process.env.TEST_DB_PATH = savedDb;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
