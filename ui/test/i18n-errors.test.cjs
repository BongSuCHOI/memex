'use strict';
/**
 * 오류 경로 통합 테스트 E1~E9 (#109, 0.7.0 lane-0 · 설계 §9.5).
 *
 * 하나의 봉투 `{code,key,params,message,details?}`가 서버에서 만들어지고 클라이언트에서
 * 번역·렌더되는 전 구간을 본다. E1~E4·E9는 **en·ko 양쪽에서** 같은 단정을 돌고, E5~E8은
 * 언어 무관이다.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {useEn, useKo, en, ko} = require('./helpers/locale.cjs');
const {Core} = require('../lib/core.cjs');
const {HttpError, normalizeErrorInfo} = require('../lib/util.cjs');
const {createServer, errorBody, redactIssues} = require('../lib/server.cjs');
const {ApiError, errorText, errorFromCore} = require('../public/api.mjs');
const {renderIssues} = require('../public/ui.mjs');
const {classify} = require('../public/guidance.mjs');

const LIB = ['core.cjs', 'server.cjs', 'store.cjs', 'util.cjs', 'operations.cjs', 'logs.cjs']
  .map(name => path.join(__dirname, '../lib', name));

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'memex-ui-i18n-')); }

/** bootstrap을 HTTP로 한 번 돌린다 — db.error는 HTTP 200 본문에 실린다. */
async function bootstrapOnce(core) {
  const app = createServer({core});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const first = await (await fetch(base + '/api/v2/bootstrap')).json();
    const second = await (await fetch(base + '/api/v2/bootstrap')).json();   // 3초 스로틀 경로
    return {first, second};
  } finally { app.close(); }
}

// ── E1 · E2 — DB 없음과 3초 스로틀 재시도 ────────────────────────────────────
test('E1·E2 DB가 없으면 bootstrap이 같은 봉투를 싣고, 스로틀 재시도도 같은 봉투다', async () => {
  const home = tmpHome();
  const core = new Core({root: home, home, dbPath: path.join(home, 'missing', 'db.sqlite')});
  try {
    const {first, second} = await bootstrapOnce(core);
    assert.equal(first.db.available, false);
    assert.equal(first.db.error.code, 'DB_INDEX_MISSING');
    assert.equal(first.db.error.key, 'error.db.indexMissing');
    assert.match(first.db.error.message, /^Index database is missing/);
    assert.ok(!/[가-힣]/.test(first.db.error.message), 'message는 en 한 줄이다');
    // 봉투 필드는 다섯 개뿐이고 origin은 없다 (C2.1).
    assert.deepEqual(Object.keys(first.db.error).sort(), ['code', 'key', 'message']);
    // E2: errorInfo 캐시가 code/key/message를 전부 복원한다.
    assert.deepEqual(second.db.error, first.db.error);
    // 클라이언트는 key로 번역한다 — 두 언어에서 각 사전 문장이 나온다.
    useEn(); assert.equal(errorText(first.db.error), en['error.db.indexMissing']);
    useKo(); assert.equal(errorText(first.db.error), ko['error.db.indexMissing']);
    assert.equal(errorFromCore(first.db.error), false);
    // E4: 코드 기반 분류가 살아 있다(한국어 match 없이).
    assert.equal(classify({error: first.db.error.code}).id, 'db-unavailable');
  } finally { core.close(); fs.rmSync(home, {recursive: true, force: true}); }
});

// ── E3 · E4 — 코어 원문 패스스루 ─────────────────────────────────────────────
test('E3·E4 코어 원문은 key:null로 그대로 올라가고 두 언어에서 같은 문장을 보여준다', async () => {
  const home = tmpHome();
  const dbPath = path.join(home, 'db.sqlite');
  fs.writeFileSync(dbPath, 'fixture marker');
  const core = new Core({root: home, home, dbPath});
  core.modules.set('db', {openReadDb() { throw new Error('SQLITE_CANTOPEN: unable to open database file'); }});
  try {
    const {first} = await bootstrapOnce(core);
    assert.equal(first.db.error.code, 'DB_UNAVAILABLE');
    assert.equal(first.db.error.key, null, 'key===null이 패스스루의 유일한 신호다');
    assert.equal(first.db.error.message, 'SQLITE_CANTOPEN: unable to open database file');
    assert.equal(errorFromCore(first.db.error), true);
    for (const use of [useEn, useKo]) { use(); assert.equal(errorText(first.db.error), first.db.error.message); }
    assert.equal(classify({error: first.db.error.message}).id, 'db-unavailable');
  } finally { core.close(); fs.rmSync(home, {recursive: true, force: true}); }
});

// ── E5 — 기존 코드는 한 글자도 바뀌지 않는다 (C1.6) ──────────────────────────
const CODES_0_6_9 = ['AMBIGUOUS_PROJECT', 'CONFIRMATION_REQUIRED', 'CORE_UNAVAILABLE', 'CSRF_REJECTED',
  'DB_UNAVAILABLE', 'HOST_REJECTED', 'INVALID_ARCHIVE', 'INVALID_ARCHIVE_PATH', 'INVALID_COMMAND', 'INVALID_ID',
  'INVALID_NUMBER', 'INVALID_SCOPE', 'INVALID_SYNC_DIR', 'MUTATION_BUSY', 'NOT_FOUND', 'OPERATION_BUSY',
  'ORIGIN_REJECTED', 'REQUEST_FAILED', 'SCHEMA_UNAVAILABLE', 'SCOPE_MISMATCH', 'STALE_FACT', 'SYNC_BUSY',
  'SYNC_DIR_UNWRITABLE', 'TIER_STEP', 'TIER_TARGET_REQUIRED'];

test('E5 0.6.9의 오류 코드 집합이 그대로 살아 있고 추가만 됐다', () => {
  const source = LIB.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const present = new Set();
  for (const m of source.matchAll(/'([A-Z_]{3,})'/g)) present.add(m[1]);
  const missing = CODES_0_6_9.filter(code => !present.has(code));
  assert.deepEqual(missing, [], '기존 코드는 변경·삭제하지 않는다');
  assert.ok(present.has('DB_INDEX_MISSING'), '인덱스 DB 누락에 안정적 코드가 추가됐다');
});

// ── E6 — params·message redaction ────────────────────────────────────────────
test('E6 params와 issues[].params에도 redact가 적용된다', () => {
  const body = errorBody(new HttpError(400, {
    code: 'X', key: 'k', params: {path: '/Users/x/s?api_key=abcdef12345'},
    message: 'token api_key=abcdef12345 leaked',
    details: {issues: [{key: 'i', params: {detail: 'Bearer abcdef123456'}, message: 'api_key=zzzzzzzzzzzz'}]},
  }));
  assert.match(body.params.path, /\[REDACTED\]/);
  assert.match(body.message, /\[REDACTED\]/);
  assert.match(body.details.issues[0].params.detail, /Bearer \[REDACTED\]/);
  assert.match(body.details.issues[0].message, /\[REDACTED\]/);
});

// ── E7 — 생성자 계약 ────────────────────────────────────────────────────────
test('E7 레거시 어댑터가 code를 잃지 않는다', () => {
  assert.equal(new HttpError(404, 'Not found', 'NOT_FOUND').code, 'NOT_FOUND');
  assert.equal(new HttpError(404, 'Not found').code, 'REQUEST_FAILED');
  assert.equal(new HttpError(404, 'Not found').key, null);
  assert.equal(new HttpError(404, 'Not found').message, 'Not found');
  // 부분 이관: info.code가 있으면 그것이 이긴다.
  assert.equal(new HttpError(404, {key: 'k', message: 'm'}, 'NOT_FOUND').code, 'NOT_FOUND');
  assert.equal(new HttpError(404, {code: 'WINS', key: 'k', message: 'm'}, 'NOT_FOUND').code, 'WINS');
  const full = new HttpError(422, {code: 'C', key: 'k', params: {a: 1}, message: 'm', details: {issues: []}});
  assert.equal(full.status, 422);
  assert.equal(full.uiMessage, 'm');
  assert.deepEqual(full.params, {a: 1});
  assert.throws(() => new HttpError(400, {code: 'C'}), TypeError);
  assert.throws(() => new HttpError(400, 42), TypeError);
  assert.deepEqual(normalizeErrorInfo('m', 'C'), {code: 'C', key: null, params: null, details: null, message: 'm'});
});

test('E7 ui/lib의 객체 인자 호출은 key를 명시하고 위치 인자는 3개를 넘지 않는다', () => {
  const ts = require('typescript');
  const problems = [];
  for (const file of LIB) {
    const src = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function visit(node) {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'HttpError') {
        const where = `${path.basename(file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        const args = node.arguments ?? [];
        // (status, message, code, key) 같은 4-위치 형태는 영어 문장이 key 자리에 들어가는
        // 조용한 오동작을 만든다 — 문법 수준에서 막는다.
        if (args.length > 3) problems.push(`${where}: 위치 인자 ${args.length}개`);
        const info = args[1];
        if (info && ts.isObjectLiteralExpression(info)) {
          const names = info.properties.filter(ts.isPropertyAssignment).map(p => p.name.getText(sf));
          if (!names.includes('message')) problems.push(`${where}: message 누락`);
          if (!names.includes('key')) problems.push(`${where}: key를 명시하지 않았다 (패스스루는 key:null)`);
        }
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  assert.deepEqual(problems, []);
});

// ── E8 — 서버는 key를 검증하지 않는다 ───────────────────────────────────────
test('E8 사전에 없는 key도 봉투를 그대로 통과하고 클라이언트가 키를 노출한다', () => {
  const body = errorBody(new HttpError(422, {code: 'OVERLAY_INVALID', key: 'overlays.error.madeUp', message: 'nope'}));
  assert.equal(body.key, 'overlays.error.madeUp', '서버가 null로 바꾸지 않는다');
  const original = console.error;
  const seen = [];
  console.error = message => seen.push(String(message));
  try {
    useKo();
    assert.equal(errorText(body), 'overlays.error.madeUp');
    assert.equal(seen.filter(m => m.includes('overlays.error.madeUp')).length, 1);
  } finally { console.error = original; }
});

// ── E9 — details.issues 왕복 ────────────────────────────────────────────────
const OVERLAY_ISSUE = {
  severity: 'error', code: 'QUANTIFIER_LIMIT', key: 'error.issue.at',
  params: {row: 3, field: 'pattern'}, path: 'patterns.add[2].source', message: 'too many quantifiers',
};

test('E9 실제 오버레이 검증 형태가 code만 잃고 5개 필드를 보존한다', () => {
  const error = new HttpError(422, {
    code: 'OVERLAY_INVALID', key: 'overlays.error.invalidRules', params: {count: 2},
    message: '2 overlay rules are invalid',
    details: {issues: [OVERLAY_ISSUE, {row: 7, field: 'pattern', key: 'error.issue.warning', severity: 'warning', extra: 'dropped'}]},
  });
  const body = errorBody(error);
  const [first, second] = body.details.issues;
  assert.deepEqual(Object.keys(first).sort(), ['key', 'message', 'params', 'path', 'severity']);
  assert.equal(first.path, 'patterns.add[2].source');
  assert.equal(first.severity, 'error');
  assert.equal(first.message, 'too many quantifiers');
  assert.equal('code' in first, false, 'code만 경계에서 버려진다');
  assert.deepEqual(Object.keys(second).sort(), ['field', 'key', 'row', 'severity']);
  assert.equal('extra' in second, false, '화이트리스트 밖 필드는 사라진다');

  const api = new ApiError('m', 422, body.code, body.details, body.key, body.params);
  assert.equal(api.issues.length, 2);
  assert.equal(api.issues[0].path, 'patterns.add[2].source');
  assert.deepEqual(api.params, {count: 2});

  for (const [tag, dict] of [['en', en], ['ko', ko]]) {
    if (tag === 'en') useEn(); else useKo();
    const html = renderIssues(api.issues);
    assert.match(html, /<ul class="issue-list">/);
    assert.ok(html.includes('patterns.add[2].source'), `${tag}: path가 그대로 출력된다`);
    assert.ok(html.includes(dict['error.issue.warning']), `${tag}: 경고 태그 문구가 사전에서 온다`);
    assert.match(html, /<span class="tag amber">/);
    assert.match(html, /<li class="muted">/);
  }
  assert.equal(renderIssues([]), '');
  assert.equal(renderIssues(undefined), '');
});

test('E9 issues는 200행에서 잘리고 key 없는 행은 원문 message로 떨어진다', () => {
  const many = Array.from({length: 250}, (_, i) => ({row: i + 1, key: 'error.issue.warning'}));
  assert.equal(redactIssues({issues: many}).issues.length, 200);
  assert.equal(redactIssues({}), undefined);
  assert.equal(redactIssues({issues: 'nope'}), undefined);
  const body = errorBody(new HttpError(422, {code: 'C', key: 'k', message: 'm', details: {issues: [{message: 'raw engine error'}]}}));
  assert.equal(body.details.issues[0].key, null);
  useKo();
  assert.ok(renderIssues(body.details.issues).includes('raw engine error'));
});

// ─────────────────────────────────────────────────────────────────────────────
// i18n L1이 더한 단정 (#109 · 설계 §9.5 E5 ① · E6 · E7 ①②).
// lane-0의 검사는 소스의 코드 문자열과 생성자 모양을 본다. 아래는 그 둘이 덮지 않는 것:
// 실제 응답으로 나오는 code·key, 보간 값의 타입 보존, 그리고 "문자열 첫 인자 0건"이다.
// ─────────────────────────────────────────────────────────────────────────────
const {fixture, FixtureCore} = require('./fixture.cjs');

test('E5 code가 없던 405·404·415 경로가 실제 응답에서 코드와 키를 싣는다', async () => {
  const f = fixture();
  const app = createServer({core: new FixtureCore(f)});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const envelope = async (url, init) => (await (await fetch(base + url, init)).json()).error;
  try {
    const csrf = {'X-Memex-CSRF': app.token};
    // 0.6.9에서 code가 없어 전부 REQUEST_FAILED로 뭉개졌던 대표 3계열.
    const method = await envelope('/api/v2/bootstrap', {method: 'DELETE', headers: csrf});
    assert.equal(method.code, 'METHOD_NOT_ALLOWED');
    assert.equal(method.key, 'error.method.getOnly');
    const asset = await envelope('/assets/does-not-exist.css');
    assert.equal(asset.code, 'NOT_FOUND');
    assert.equal(asset.key, 'error.asset.fileNotFound');
    const media = await envelope('/api/v2/facts/mutate', {method: 'POST', headers: csrf, body: '{}'});
    assert.equal(media.code, 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(media.key, 'error.request.contentTypeJson');
    // 기존 코드 경로는 그대로다 — 클라이언트가 이 값으로 분기한다.
    assert.equal((await envelope('/api/v2/facts/mutate', {method: 'POST'})).code, 'CSRF_REJECTED');
    assert.equal((await envelope('/api/v2/nope')).code, 'NOT_FOUND');
    // 모든 키가 사전에서 해소된다 — 서버가 key를 검증하지 않는 대가를 여기서 치른다.
    for (const e of [method, asset, media]) {
      assert.ok(e.key in en && e.key in ko, '사전에 없는 key: ' + e.key);
    }
  } finally { app.close(); fs.rmSync(f.home, {recursive: true, force: true}); }
});

test('E6 유한한 수·boolean·null 보간 값은 타입이 보존된다', () => {
  // 문자열로 바꾸면 복수형 선택(tn)과 숫자 포맷이 흔들린다 — 이 값들은 비밀을 담을 수 없다.
  const body = errorBody(new HttpError(400, {
    code: 'INVALID_NUMBER', key: 'error.validate.rangeExceeded',
    params: {min: 0, max: 500, ok: true, none: null}, message: 'Allowed range: 0-500',
  }));
  assert.deepEqual(body.params, {min: 0, max: 500, ok: true, none: null});
});

test('E7 ui/lib에 문자열 첫 인자 호출이 0건이고 패스스루 3곳만 key:null이다', () => {
  const ts = require('typescript');
  const stringFirst = [], passthrough = [], explicitNull = [];
  for (const file of LIB) {
    const src = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function visit(node) {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'HttpError') {
        const where = `${path.basename(file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
        const info = (node.arguments ?? [])[1];
        const text = node.getText(sf);
        // lane-0의 검사는 객체 인자일 때의 모양만 본다. 문자열 인자는 어댑터가 흡수하므로
        // 통과해 버리는데, 그것이 바로 이관이 끝나지 않았다는 신호다.
        if (info && (ts.isStringLiteral(info) || ts.isTemplateExpression(info)
          || ts.isNoSubstitutionTemplateLiteral(info))) stringFirst.push(where);
        if (/key:\s*null/.test(text)) explicitNull.push(where);
        // 코어·런타임 원문을 감싸는 곳은 key:null이 **코드에 보여야** 한다. 생략도 null로
        // 정규화되지만, 패스스루는 의도적 선택이다.
        if (/message:\s*(?:e|error)\.message/.test(text) && !/key:\s*null/.test(text)) passthrough.push(where);
      }
      ts.forEachChild(node, visit);
    })(sf);
  }
  assert.deepEqual(stringFirst, [], '위치 인자 호출이 남아 있습니다 — 어댑터가 조용히 흡수합니다');
  assert.deepEqual(passthrough, [], '패스스루에 key:null이 명시되지 않았습니다');
  // 4번째는 #29/#30의 `Core.overlayError()`다 — 분류되지 않은 오버레이 코어 오류(lock·검증기 밖의
  // 원문)를 그대로 보여주는 지점이며, 나머지 오버레이 오류는 모두 `overlays.error.*` key를 가진다.
  assert.equal(explicitNull.length, 4, '패스스루 지점 수가 바뀌었습니다: ' + explicitNull.join(', '));
});
