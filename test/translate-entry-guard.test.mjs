/**
 * post-0.7.6 review P2 #1 — `scripts/translate-facts.mjs` is a batch CLI that
 * does its work at module top level, and its entry guard compared BASENAMES.
 *
 * That is the wrong question in both directions:
 *   - any other file named `translate-facts.mjs` could `import()` this one and
 *     the whole translation batch ran against the importer's data root;
 *   - the real file run through a symlink named anything else was refused even
 *     though it was the process entry point.
 *
 * These tests run the script in child processes with an isolated `MEMEX_HOME`
 * that does NOT exist, so the very first thing after the guard — `openWriteDb()`
 * — cannot succeed. That makes the two outcomes distinguishable without any DB
 * or model work ever happening: the guard's own message means "refused before
 * touching anything", and anything else means the guard let the run through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'translate-facts.mjs');
const GUARD = 'runs only as a CLI entry point';
const BUILT = fs.existsSync(path.join(REPO, 'dist', 'db.js'));

function sandbox(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-translate-guard-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Deliberately NOT created: a data root that does not exist cannot be opened,
  // so a run that gets past the guard fails with sqlite's message, not ours.
  return { tmp, home: path.join(tmp, 'absent-home') };
}

function run(t, { entry, cwd, home, args = [] }) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMEX_HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'xdg'),
      TRANSLATE_CONCURRENCY: '1',
    },
    timeout: 30000,
  });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

test('동명 래퍼가 import 하면 가드가 거절한다 (basename은 정체성이 아니다)', { skip: !BUILT && 'dist가 없다' }, (t) => {
  const { tmp, home } = sandbox(t);
  // A DIFFERENT file that merely shares the basename. Under the old guard
  // `basename(argv[1]) === basename(self)` held and the batch started.
  const wrapper = path.join(tmp, 'translate-facts.mjs');
  fs.writeFileSync(wrapper, `await import(${JSON.stringify(SCRIPT)});\n`);
  const out = run(t, { entry: wrapper, cwd: tmp, home });
  assert.match(out, new RegExp(GUARD), '동명 래퍼의 import가 가드를 통과했다');
});

test('다른 이름의 심볼릭 링크로 직접 실행하면 가드가 통과시킨다', { skip: !BUILT && 'dist가 없다' }, (t) => {
  const { tmp, home } = sandbox(t);
  const link = path.join(tmp, 'translate-ko.mjs');
  fs.symlinkSync(SCRIPT, link);
  const out = run(t, { entry: link, cwd: tmp, home });
  assert.doesNotMatch(out, new RegExp(GUARD), '진입점인 심볼릭 링크를 가드가 거절했다');
  // It still must not have done any work: the absent data root stops it at the
  // first DB open, which is the line right after the guard.
  assert.doesNotMatch(out, /Found \d+ untranslated facts/, '없는 데이터 루트에서 배치가 시작됐다');
});

test('다른 cwd에서 절대 경로로 실행하면 가드가 통과시킨다', { skip: !BUILT && 'dist가 없다' }, (t) => {
  const { tmp, home } = sandbox(t);
  const out = run(t, { entry: SCRIPT, cwd: os.tmpdir(), home });
  assert.doesNotMatch(out, new RegExp(GUARD), '다른 cwd의 직접 실행을 가드가 거절했다');
});

test('상대 경로·`.`/`..` 섞인 진입점도 같은 파일로 인정한다', { skip: !BUILT && 'dist가 없다' }, (t) => {
  const { home } = sandbox(t);
  const out = run(t, { entry: path.join('.', 'scripts', '..', 'scripts', 'translate-facts.mjs'), cwd: REPO, home });
  assert.doesNotMatch(out, new RegExp(GUARD), '정규화 전 경로를 가드가 거절했다');
});

test('진입점이 없는 실행(node -e)은 여전히 거절한다', { skip: !BUILT && 'dist가 없다' }, (t) => {
  const { tmp, home } = sandbox(t);
  const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(SCRIPT)}).catch(e=>{console.error(e.message);process.exit(1);})`], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, MEMEX_HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') },
    timeout: 30000,
  });
  assert.match(`${result.stdout || ''}${result.stderr || ''}`, new RegExp(GUARD), '진입점 없는 import가 가드를 통과했다');
});
