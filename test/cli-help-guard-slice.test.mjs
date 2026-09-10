/**
 * Issue #36 — `--help` on a side-effecting command did the work.
 *
 * Observed in v0.5.2: `memex update --help` reinstalled the plugin,
 * `memex setup-hooks --help` wrote $CODEX_HOME/hooks.json, `memex remove-hooks
 * --help` removed entries, and `memex migrate-projects --help` rewrote
 * exchanges/facts/archive_paths — each decided dry-run purely from
 * `args.includes('--dry-run')` and never looked at `--help`, while the
 * top-level help told users to type exactly that.
 *
 * These tests run the real CLI in an isolated CODEX_HOME/MEMEX_HOME and assert
 * that nothing is written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = path.join(REPO, 'cli', 'memex.js');

function isolated(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-help-guard-'));
  const codexHome = path.join(tmp, 'codex-home');
  const memexHome = path.join(tmp, 'memex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(memexHome, { recursive: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return {
    tmp,
    codexHome,
    memexHome,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      MEMEX_HOME: memexHome,
      MEMEX_PLUGIN_ROOT: REPO,
      // Any accidental `codex` invocation must fail loudly rather than mutate.
      PATH: path.join(tmp, 'empty-bin'),
    },
  };
}

function run(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
}

/** Every command whose case has a side effect when the flag is not recognized. */
const SIDE_EFFECTING = [
  ['update', /Usage: memex update/],
  ['setup-hooks', /Usage: memex setup-hooks/],
  ['remove-hooks', /Usage: memex remove-hooks/],
  ['migrate-projects', /Usage: memex migrate-projects/],
  ['install', /Usage: memex install/],
];

for (const [command, usage] of SIDE_EFFECTING) {
  for (const flag of ['--help', '-h']) {
    test(`memex ${command} ${flag} prints usage, exits 0, and writes nothing`, (t) => {
      const fixture = isolated(t);
      const before = fs.readdirSync(fixture.codexHome);

      const result = run(fixture.env, [command, flag]);

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, usage);
      // The observed failure modes, each named:
      assert.doesNotMatch(result.stdout, /Lifecycle configured/);
      assert.doesNotMatch(result.stdout, /^Removed:/m);
      assert.doesNotMatch(result.stdout, /Applied: exchanges=/);
      assert.doesNotMatch(result.stdout, /Backup:/);
      assert.ok(!fs.existsSync(path.join(fixture.codexHome, 'hooks.json')), 'hooks.json must not be created');
      assert.deepEqual(fs.readdirSync(fixture.codexHome), before);
      assert.ok(
        !fs.existsSync(path.join(fixture.memexHome, 'lifecycle-registration.json')),
        'ownership record must not be written',
      );
    });
  }
}

test('migrate-projects --help leaves an existing database byte-identical', async (t) => {
  const fixture = isolated(t);
  const dbPath = path.join(fixture.memexHome, 'conversation-index', 'db.sqlite');
  const prev = { home: process.env.MEMEX_HOME, db: process.env.MEMEX_DB_PATH };
  process.env.MEMEX_HOME = fixture.memexHome;
  delete process.env.MEMEX_DB_PATH;
  const { initDatabase } = await import(path.join(REPO, 'dist/db.js'));
  const db = initDatabase();
  db.prepare(`INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path,
       line_start, line_end, session_id, cwd, is_sidechain)
    VALUES ('help-guard-exchange', '/tmp/help-guard', ?, 'q', 'a', '/tmp/help-guard/r.jsonl', 1, 2, 'session-1', '/tmp/help-guard', 0)`)
    .run(new Date().toISOString());
  db.close();
  if (prev.home === undefined) delete process.env.MEMEX_HOME; else process.env.MEMEX_HOME = prev.home;
  if (prev.db !== undefined) process.env.MEMEX_DB_PATH = prev.db;

  assert.ok(fs.existsSync(dbPath));
  const before = fs.readFileSync(dbPath);
  const filesBefore = fs.readdirSync(path.dirname(dbPath)).sort();

  const result = run(fixture.env, ['migrate-projects', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: memex migrate-projects/);
  assert.doesNotMatch(result.stdout, /Exchanges: \d+ total/);
  assert.ok(fs.readFileSync(dbPath).equals(before), 'database must be untouched');
  assert.deepEqual(fs.readdirSync(path.dirname(dbPath)).sort(), filesBefore, 'no backup may be written');
});

test('read-only commands answer --help with exit 0 instead of an error', (t) => {
  const fixture = isolated(t);
  for (const [command, usage] of [
    ['facts', /memex facts <list\|show\|edit/],
    ['backfill', /memex backfill <all\|extract\|ontology\|embeddings\|receipts>/],
    ['home', /Usage: memex home/],
    ['status', /Usage: memex status \[--json\]/],
    ['jobs', /memex jobs list/],
    ['recover', /Usage: memex recover/],
    ['doctor', /Usage: memex doctor/],
    ['model-work', /memex model-work status/],
    // Issue #31: the guard is KNOWN_COMMANDS membership, so a command missing
    // from the table is simply unguarded — `models set --help` would have saved.
    ['models', /memex models show \[--json\]/],
  ]) {
    const result = run(fixture.env, [command, '--help']);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, usage, command);
  }
  // `home --help` used to ignore the flag and print the data root instead.
  assert.doesNotMatch(run(fixture.env, ['home', '--help']).stdout, new RegExp(fixture.memexHome));
  // `doctor --help` used to run the full diagnosis.
  assert.doesNotMatch(run(fixture.env, ['doctor', '--help']).stdout, /Overall:/);
});

test('commands with their own richer help still print it, without doing work', (t) => {
  const fixture = isolated(t);
  for (const [command, usage] of [
    ['setup', /Usage: memex setup/],
    ['index', /index-conversations \[COMMAND\]/],
    ['search', /Usage: memex search/],
    ['show', /Usage: memex show/],
    ['sync', /Usage: memex sync/],
    // Delegated to src/models-cli.ts so the long text has a single source.
    ['models', /memex models test \[--model <id>\]/],
  ]) {
    const result = run(fixture.env, [command, '--help']);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, usage, command);
  }
  assert.ok(!fs.existsSync(path.join(fixture.memexHome, 'conversation-index')));
});

test('an unknown command with --help is still an unknown command', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['definitely-not-a-command', '--help']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});
