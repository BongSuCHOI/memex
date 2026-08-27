// CX-02 — canonical project identity and same-basename isolation.
// Runs with plain `node --test` against dist modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const {
  canonicalizeProjectPath,
  projectStorageKey,
  projectIdentity,
  displayLabel,
} = await import(path.join(REPO, 'dist/project-identity.js'));
const { parseRolloutStream } = await import(path.join(REPO, 'dist/codex-rollout.js'));

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cx02-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('canonicalizeProjectPath is lexical, deterministic, existence-free', () => {
  assert.equal(canonicalizeProjectPath('/a/b/'), '/a/b');
  assert.equal(canonicalizeProjectPath('/a/b/../c'), '/a/c');
  assert.equal(canonicalizeProjectPath('/a/./b//c'), '/a/b/c');
  assert.equal(canonicalizeProjectPath('/'), '/');
  // Non-existent historical cwd must survive unchanged (no realpath).
  assert.equal(canonicalizeProjectPath('/gone/project-2024'), '/gone/project-2024');
  // Relative input resolves deterministically against / (not process cwd).
  assert.equal(canonicalizeProjectPath('work/app'), '/work/app');
});

test('same-basename projects get distinct storage keys; lexical equivalents collide on purpose', () => {
  const a = projectStorageKey('/tmp/w/team-a/shared');
  const b = projectStorageKey('/tmp/w/team-b/shared');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('shared--') && b.startsWith('shared--'));
  assert.notEqual(a.split('--')[1], b.split('--')[1]);
  // Lexical equivalents are the same identity -> same storage key.
  assert.equal(projectStorageKey('/w/x/'), projectStorageKey('/w/x'));
  assert.equal(projectIdentity('/w/x').canonical, '/w/x');
  // Display label disambiguates same basename.
  assert.ok(displayLabel('/tmp/w/team-a/shared').includes('team-a/shared'));
});

test('parseConversation stamps canonical cwd as exchange cwd', async (t) => {
  const dir = tmpdir(t);
  const f = path.join(dir, 'rollout-x.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'session_meta', timestamp: 't', payload: { id: 'i', session_id: 's', cwd: '/tmp/team-a/shared/', source: 'cli' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] } }),
  ].join('\n') + '\n');
  const stream = fs.createReadStream(f);
  try {
    const { meta } = await parseRolloutStream(stream, { archivePath: f });
    assert.equal(canonicalizeProjectPath(meta.cwd), '/tmp/team-a/shared');
  } finally {
    stream.close();
  }
});

test('migration plan: movable rows recomputed from cwd, ambiguous untouched', async (t) => {
  const dir = tmpdir(t);
  const dbPath = path.join(dir, 'mig.db');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE exchanges (
    id INTEGER PRIMARY KEY, project TEXT, cwd TEXT, archive_path TEXT);
    CREATE TABLE facts (
    id INTEGER PRIMARY KEY, scope_project TEXT, scope_type TEXT);`);
  const ins = db.prepare('INSERT INTO exchanges (id, project, cwd, archive_path) VALUES (?, ?, ?, ?)');
  ins.run(1, 'shared', '/tmp/w/team-a/shared', '/archive/shared/rollout-a.jsonl');   // legacy basename
  ins.run(2, 'shared', '/tmp/w/team-b/shared', '/archive/shared/rollout-b.jsonl');   // same basename, other cwd
  ins.run(3, '/tmp/w/team-a/shared', '/tmp/w/team-a/shared', '/x/y.jsonl');          // already canonical
  ins.run(4, 'unknown', null, '/archive/unknown/r.jsonl');                            // ambiguous
  ins.run(5, '-Users-me-app', '/Users/me/app', '/archive/slug/r.jsonl');              // absolute cwd, legacy basename project -> movable
  ins.run(6, 'old-slug', 'relative/path', '/archive/rel/r.jsonl');                    // relative cwd -> must stay ambiguous
  db.prepare("INSERT INTO facts (id, scope_project, scope_type) VALUES (1, '/tmp/w/team-a/shared/', 'project')").run();

  const { planMigration, applyMigration } = await import(path.join(REPO, 'dist/project-migration.js'));
  const plan = planMigration(db);
  assert.equal(plan.movable.length, 3);
  assert.ok(plan.movable.some((m) => m.id === 5 && m.to === '/Users/me/app'));
  assert.equal(plan.ambiguous.length, 2, 'relative-cwd row and no-cwd row are ambiguous, never guessed');
  assert.ok(plan.movable.some((m) => m.id === 1 && m.to === '/tmp/w/team-a/shared'));
  assert.ok(plan.movable.some((m) => m.id === 2 && m.to === '/tmp/w/team-b/shared'));
  assert.ok(plan.ambiguous.some((a) => a.id === 4));
  assert.ok(plan.ambiguous.some((a) => a.id === 6), 'relative-cwd row is ambiguous');
  assert.equal(plan.factsRescope.length, 1);

  const result = await applyMigration(db, dbPath);
  assert.equal(result.exchangesUpdated, 3);
  assert.equal(result.factsUpdated, 1);
  assert.equal(result.countsVerified, true);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));

  const relRow = db.prepare('SELECT project FROM exchanges WHERE id = 6').get();
  assert.equal(relRow.project, 'old-slug'); // relative-cwd row untouched
  // Ambiguous row was not guessed into a project.
  const amb = db.prepare('SELECT project FROM exchanges WHERE id = 4').get();
  assert.equal(amb.project, 'unknown');
  // Fact scope lexically normalized to the same canonical identity.
  const fact = db.prepare('SELECT scope_project FROM facts WHERE id = 1').get();
  assert.equal(fact.scope_project, '/tmp/w/team-a/shared');
  db.close();
  db.close();
});
