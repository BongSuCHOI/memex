/**
 * Issue #26 (item 5) — the gate-time isolation probe.
 *
 * Observed in 0.5.0 QA: `test/web-ui-db-factory.test.mjs` isolated only
 * `MEMEX_DB_PATH`, so the suite appended 21 audit lines to the real
 * `~/.config/memex/logs/ui-audit.jsonl`. Nothing checked that scripts and tests
 * actually put `MEMEX_HOME` *and* `XDG_CONFIG_HOME` on a temporary path.
 *
 * These tests run the probe against a fake root, so the real data root is never
 * involved — which is also the property the probe itself must have.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const PROBE = path.join(REPO, 'scripts', 'check-real-root-untouched.mjs');

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-root-probe-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'memex');
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conversation-index'), { recursive: true });
  fs.mkdirSync(path.join(root, 'run-locks', 'memex-sync.lock'), { recursive: true });
  fs.writeFileSync(path.join(root, 'logs', 'ui-audit.jsonl'), '{"action":"pre-existing"}\n');
  fs.writeFileSync(path.join(root, 'conversation-index', 'db.sqlite'), 'sqlite bytes\n');
  return { tmp, root, baseline: path.join(tmp, 'baseline.json') };
}

function run(args) {
  return spawnSync(process.execPath, [PROBE, ...args], { encoding: 'utf8' });
}

function snapshot(f, extra = []) {
  const result = run(['snapshot', '--root', f.root, '--out', f.baseline, ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('a clean run reports the real root untouched and writes nothing inside it', (t) => {
  const f = fixture(t);
  snapshot(f);
  const before = fs.readdirSync(f.root).sort();

  const compare = run(['compare', '--baseline', f.baseline]);
  assert.equal(compare.status, 0, compare.stderr);
  assert.match(compare.stdout, /real data root untouched/);
  // The probe is read-only: the baseline lives outside the root.
  assert.deepEqual(fs.readdirSync(f.root).sort(), before);
  assert.equal(fs.existsSync(path.join(f.root, path.basename(f.baseline))), false);
});

test('the exact 0.5.0 leak — an appended audit log — fails the check', (t) => {
  const f = fixture(t);
  snapshot(f);
  fs.appendFileSync(path.join(f.root, 'logs', 'ui-audit.jsonl'), '{"action":"leaked_by_test"}\n');

  const compare = run(['compare', '--baseline', f.baseline, '--json']);
  assert.equal(compare.status, 1);
  const result = JSON.parse(compare.stdout);
  assert.equal(result.ok, false);
  assert.deepEqual(result.modified.map((item) => item.path), [path.join('logs', 'ui-audit.jsonl')]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
});

test('added and removed files are both reported', (t) => {
  const f = fixture(t);
  snapshot(f);
  fs.writeFileSync(path.join(f.root, 'conversation-index', 'new-file.jsonl'), 'x\n');
  fs.rmSync(path.join(f.root, 'conversation-index', 'db.sqlite'));

  const compare = run(['compare', '--baseline', f.baseline, '--json']);
  assert.equal(compare.status, 1);
  const result = JSON.parse(compare.stdout);
  assert.deepEqual(result.added.map((item) => item.path), [path.join('conversation-index', 'new-file.jsonl')]);
  assert.deepEqual(result.removed.map((item) => item.path), [path.join('conversation-index', 'db.sqlite')]);
});

test('a read that changes only mtime is not a violation; --strict still watches run-locks', (t) => {
  const f = fixture(t);
  snapshot(f);
  // Same bytes, newer mtime — what reading and rewriting an unchanged file does.
  const target = path.join(f.root, 'conversation-index', 'db.sqlite');
  const bytes = fs.readFileSync(target);
  fs.writeFileSync(target, bytes);
  fs.utimesSync(target, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  assert.equal(run(['compare', '--baseline', f.baseline]).status, 0);

  // Runtime lock artifacts are ignored by default and compared under --strict.
  fs.writeFileSync(path.join(f.root, 'run-locks', 'memex-sync.lock', 'pid'), '{"pid":1}');
  assert.equal(run(['compare', '--baseline', f.baseline]).status, 0);
  snapshot(f, ['--strict']);
  fs.writeFileSync(path.join(f.root, 'run-locks', 'memex-sync.lock', 'pid'), '{"pid":2}');
  assert.equal(run(['compare', '--baseline', f.baseline, '--strict']).status, 1);
});
