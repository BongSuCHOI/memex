import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

function fixture(t, sourceType = 'git') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-update-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls.jsonl');
  fs.mkdirSync(bin, { recursive: true });
  const fake = [
    '#!/usr/bin/env node',
    "const fs=require('node:fs');",
    "const a=process.argv.slice(2),log=process.env.CALL_LOG;",
    "fs.appendFileSync(log,JSON.stringify(a)+'\\n');",
    "if(a[0]==='plugin'&&a[1]==='list'){console.log(JSON.stringify({installed:[{name:'memex',pluginId:'memex@memex',marketplaceName:'memex',version:'0.1.0',installed:true}]}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='marketplace'&&a[2]==='list'){console.log(JSON.stringify({marketplaces:[{name:'memex',marketplaceSource:{sourceType:process.env.SOURCE_TYPE}}]}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='marketplace'&&a[2]==='upgrade'){console.log(JSON.stringify({upgraded:true}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='remove'){console.log(JSON.stringify({removed:true}));process.exit(0)}",
    "if(a[0]==='plugin'&&a[1]==='add'){console.log(JSON.stringify({version:'0.2.0',installedPath:'/tmp/memex/0.2.0'}));process.exit(0)}",
    'process.exit(2)',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'codex'), fake, { mode: 0o755 });
  // The update script opens the data root database (#166), so every run here is
  // pinned to this temp directory. The real ~/.config/memex is never touched.
  const home = path.join(root, 'memex-home');
  const dbPath = path.join(home, 'conversation-index', 'db.sqlite');
  return {
    root,
    home,
    dbPath,
    log,
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      CALL_LOG: log,
      SOURCE_TYPE: sourceType,
      MEMEX_HOME: home,
      MEMEX_DB_PATH: dbPath,
    },
  };
}

function run(fixture, args = []) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'update-plugin.js'), ...args], {
    cwd: ROOT,
    env: fixture.env,
    encoding: 'utf8',
  });
}

function calls(fixture) {
  return fs.readFileSync(fixture.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('memex update refreshes a Git marketplace before reinstalling the plugin', (t) => {
  const f = fixture(t, 'git');
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(f), [
    ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'marketplace', 'upgrade', 'memex', '--json'],
    ['plugin', 'remove', 'memex@memex', '--json'],
    ['plugin', 'add', 'memex@memex', '--json'],
  ]);
  assert.match(result.stdout, /Restart Codex/);
});

test('memex update re-reads a local marketplace without an invalid Git upgrade', (t) => {
  const f = fixture(t, 'local');
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(f).some((args) => args[2] === 'upgrade'), false);
});

test('memex update --dry-run performs only read-only discovery', (t) => {
  const f = fixture(t, 'git');
  const result = run(f, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(f), [
    ['plugin', 'list', '--json'],
    ['plugin', 'marketplace', 'list', '--json'],
  ]);
  assert.match(result.stdout, /No registry, cache, hook, or data changes/);
});

/**
 * Issue #166 — after an update, the first session opened the database with five
 * hooks at once and the first connection ran the new-table migration under the
 * write lock: the continuity hook waited 930 ms and gave up `busy`. The update
 * knows the new code is in place, so it applies the migration once, there.
 */
test('memex update pre-applies the schema migration once (#166)', (t) => {
  const f = fixture(t, 'git');
  // A data root as an older release left it: built by this code, then knocked
  // back to the shape 0.7.23 had — without the table 0.7.24 added and with the
  // file's schema version cleared, which is exactly what an update walks into.
  const build = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'migrate-schema.mjs'), '--root', ROOT],
    { env: f.env, encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr);
  const older = new Database(f.dbPath);
  older.exec('DROP TABLE session_epoch_markers; PRAGMA user_version = 0;');
  older.close();

  const first = run(f);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Schema migrated for/);

  const db = new Database(f.dbPath, { readonly: true });
  try {
    // The 0.7.24 table whose migration the first session used to race.
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_epoch_markers'").get(),
      'session_epoch_markers must exist after the update',
    );
    assert.ok(Number(db.pragma('user_version', { simple: true })) > 0);
  } finally {
    db.close();
  }

  // Idempotent: the second update has nothing to migrate and says so.
  const second = run(f);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already current/);
});

test('memex update --dry-run does not open the database (#166)', (t) => {
  const f = fixture(t, 'git');
  const result = run(f, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Schema/);
  assert.equal(fs.existsSync(f.dbPath), false);
});

/**
 * #166 second review — `applySchemaMigrations()` reported `version: 8` from the
 * constant, so a run whose taxonomy migration was skipped (real `user_version`
 * still 7) printed "Schema migrated … (schema v8)" and exited 0. The number a
 * report states has to be the one the FILE carries.
 */
test('a skipped migration is reported with the recorded version and exit 3 (#166)', (t) => {
  const f = fixture(t, 'git');
  const migrate = (env = f.env) => spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'migrate-schema.mjs'), '--root', ROOT],
    { env, encoding: 'utf8' },
  );

  // A current file first, then the conflict the taxonomy migration cannot merge:
  // two case-duplicate domains whose categories collide when the merge reassigns
  // them, against the category unique index that is already there.
  assert.equal(migrate().status, 0);
  const seed = new Database(f.dbPath);
  seed.exec(`
    DROP INDEX IF EXISTS idx_ontology_domains_name;
    INSERT INTO ontology_domains (id, name, created_at)
      VALUES ('d-keep', 'Infra', '2026-01-01T00:00:00.000Z'),
             ('d-dup', 'infra', '2026-01-02T00:00:00.000Z');
    INSERT INTO ontology_categories (id, domain_id, name, created_at)
      VALUES ('c-keep', 'd-keep', 'Cache', '2026-01-01T00:00:00.000Z'),
             ('c-dup', 'd-dup', 'Cache', '2026-01-02T00:00:00.000Z');
    PRAGMA user_version = 0;
  `);
  seed.close();

  const skipped = migrate();
  assert.equal(skipped.status, 3, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /Schema migration incomplete: ontology-taxonomy-uniqueness/);
  assert.match(skipped.stdout, /will retry on next open/);
  // The version in the message is the one the file carries, never the constant.
  const db = new Database(f.dbPath, { readonly: true });
  const recorded = Number(db.pragma('user_version', { simple: true }));
  db.close();
  assert.ok(recorded < 8, `expected the file to stay behind, got ${recorded}`);
  assert.match(skipped.stdout, new RegExp(`schema v${recorded}\\)`));

  // `memex update` still succeeds — the install did — and ends with the warning.
  const update = run(f);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout + update.stderr, /Schema migration incomplete/);
  assert.match(update.stdout, /Restart Codex/);

  // Conflict gone: the next run completes the pass and says so with exit 0.
  const repaired = new Database(f.dbPath);
  repaired.exec("DELETE FROM ontology_categories WHERE id = 'c-dup'; DELETE FROM ontology_domains WHERE id = 'd-dup';");
  repaired.close();
  const clean = migrate();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /Schema migrated for/);
  assert.match(migrate().stdout, /Schema already current \(schema v\d+\)/);
});
