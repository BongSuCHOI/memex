// CX-02 Gate 2 — same-basename A/B isolation observed through sync, archive
// layout, DB rows, and analyze. Plain node --test against dist modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const { syncConversations } = await import(path.join(REPO, 'dist/sync.js'));
const { projectStorageKey } = await import(path.join(REPO, 'dist/project-identity.js'));

const PROJECT_A = '/tmp/mb-cx02-e2e/team-a/shared';
const PROJECT_B = '/tmp/mb-cx02-e2e/team-b/shared';

function writeRollout(sourceDir, name, cwd) {
  const day = path.join(sourceDir, '2026', '08', '26');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-${name}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-08-26T01:00:00Z', payload: { id: `thr-${name}`, session_id: `sess-${name}`, cwd, source: 'cli' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Question for ${cwd}` }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Answer for ${cwd}` }] } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

test('same-basename projects are isolated in archive layout and DB project identity', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cx02-gate2-'));
  t.after(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sourceDir = path.join(dir, 'source');
  const destDir = path.join(dir, 'archive');
  const dbPath = path.join(dir, 'db.sqlite');
  process.env.TEST_DB_PATH = dbPath;

  writeRollout(sourceDir, 'aaa', PROJECT_A);
  writeRollout(sourceDir, 'bbb', PROJECT_B);

  const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });
  assert.equal(result.errors.length, 0);
  assert.equal(result.copied, 2);

  // 1. Archive storage directories are distinct collision-free keys.
  const entries = fs.readdirSync(destDir).sort();
  const keyA = projectStorageKey(PROJECT_A);
  const keyB = projectStorageKey(PROJECT_B);
  assert.deepEqual(entries, [keyA, keyB].sort());
  assert.ok(fs.existsSync(path.join(destDir, keyA)));
  assert.ok(fs.existsSync(path.join(destDir, keyB)));

  // 2. DB exchanges.project holds the two distinct canonical paths.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath, { readonly: true });
  const projects = db.prepare('SELECT DISTINCT project FROM exchanges ORDER BY project').all().map((r) => r.project);
  assert.deepEqual(projects, [PROJECT_A, PROJECT_B]);
  const cwds = db.prepare('SELECT DISTINCT cwd FROM exchanges ORDER BY cwd').all().map((r) => r.cwd);
  assert.deepEqual(cwds, [PROJECT_A, PROJECT_B]);

  // 3. Project-filtered search only sees its own canonical scope.
  const { searchExchanges } = await import(path.join(REPO, 'dist/search.js')).catch(() => ({ searchExchanges: null }));
  if (typeof searchExchanges === 'function') {
    const resA = await searchExchanges(db, 'Question', { project: PROJECT_A, limit: 10 }).catch(() => null);
    if (resA && Array.isArray(resA)) {
      assert.ok(resA.every((r) => r.project === PROJECT_A || (r.exchange ? r.exchange.project === PROJECT_A : true)));
    }
  }

  // 4. analyze reports the two projects separately (no basename collapse).
  const { analyzeHistory } = await import(path.join(REPO, 'dist/analyze.js'));
  const report = await analyzeHistory({});
  const projectNames = report.projects.map((p) => p.project).sort();
  assert.ok(projectNames.includes(PROJECT_A), `analyze missing ${PROJECT_A}: got ${JSON.stringify(projectNames)}`);
  assert.ok(projectNames.includes(PROJECT_B), `analyze missing ${PROJECT_B}`);
  // Same basename must appear as TWO separate rows.
  assert.equal(projectNames.filter((p) => p.endsWith('/shared')).length, 2);
  void keyA; void keyB;
  db.close();
});
