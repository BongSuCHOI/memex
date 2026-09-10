'use strict';
/**
 * 사전·번역 런타임 게이트 (#109, 0.7.0 lane-0 · 설계 §9.1의 검사 11종).
 *
 * 이 파일은 **빈 사전 상태에서도 유효하다** — 병합·레지스트리·복수형·endonym·접두사 검사는
 * 문자열 이관과 무관하게 구조를 지킨다. 이관(L1~L4)이 진행되면 (1)(2)(7)이 실질적인 내용
 * 검사로 자라고, (3)의 미이관 목록은 줄어든다.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const i18n = require('../public/i18n/index.mjs');
const {loadDictionary, TABLES} = require('../public/i18n/load.mjs');
const {NAMESPACES, PREFIXES} = require('../public/i18n/registry.mjs');
const {ENDONYMS} = require('../public/i18n/endonyms.mjs');
const {DOC_ANCHORS} = require('../public/i18n/doc-anchors.mjs');
const extract = require('../../scripts/i18n-extract.mjs');
const settingsPage = require('../public/pages/settings.mjs');
const {SETTINGS_TABS, DEFAULT_TAB, visibleTabs, tabFor} = require('../public/pages/settings-tabs.mjs');

const ROOT = path.resolve(__dirname, '../..');
const en = loadDictionary('en').dict;
const ko = loadDictionary('ko').dict;
const DICTS = {en, ko};
const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;

// ── (1) 키 집합 동일 ───────────────────────────────────────────────────────────
test('(1) en/ko 사전의 키 집합이 같다 (복수형은 .other만 양쪽 필수)', () => {
  const a = new Set(Object.keys(en)), b = new Set(Object.keys(ko));
  const onlyEn = [...a].filter(k => !b.has(k) && !/\.(one|two|few|many|zero)$/.test(k));
  const onlyKo = [...b].filter(k => !a.has(k) && !/\.(one|two|few|many|zero)$/.test(k));
  assert.deepEqual(onlyEn, [], 'ko에 없는 키: ' + onlyEn.join(', '));
  assert.deepEqual(onlyKo, [], 'en에 없는 키: ' + onlyKo.join(', '));
});

// ── (2) 플레이스홀더·허용 태그 동일 ───────────────────────────────────────────
const holders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
const tags = s => [...String(s).matchAll(/<(\/?)([a-z]+)/g)].map(m => m[2]).sort();
const ALLOWED_TAGS = new Set(['strong', 'em', 'code', 'br', 'kbd']);

test('(2) 플레이스홀더가 en/ko 양쪽에서 일치한다', () => {
  const mismatched = [];
  for (const key of Object.keys(en)) {
    if (!(key in ko)) continue;
    const a = holders(en[key]), b = holders(ko[key]);
    // en에 있는 변수가 ko에 없으면 값이 사라진다 — 이 방향만 강제한다.
    for (const name of a) if (!b.includes(name)) mismatched.push(`${key}: ko에 {${name}} 없음`);
  }
  assert.deepEqual(mismatched, []);
});

test('(2) 사전 값의 마크업 구성이 일치하고 허용 태그만 쓴다', () => {
  const problems = [];
  for (const [tag, dict] of Object.entries(DICTS)) {
    for (const [key, value] of Object.entries(dict)) {
      for (const name of tags(value)) if (!ALLOWED_TAGS.has(name)) problems.push(`${tag} ${key}: <${name}> 허용 목록 밖`);
      if (/<a\s/i.test(value)) problems.push(`${tag} ${key}: <a href>는 금지 — 링크는 파라미터로 주입한다`);
    }
  }
  for (const key of Object.keys(en)) {
    if (!(key in ko)) continue;
    assert.deepEqual(tags(en[key]), tags(ko[key]), `${key}의 태그 구성이 다르다`);
  }
  assert.deepEqual(problems, []);
});

// ── (3) ko 사전 밖 한글 리터럴 0건 ────────────────────────────────────────────
test('(3) ko 사전 밖에 (미이관 목록을 제외하면) 한글 리터럴이 없다', () => {
  const {violations, stale} = extract.lint();
  assert.deepEqual(violations.map(h => `${h.file}:${h.line} ${h.text.slice(0, 40)}`), []);
  // 이관이 끝난 파일은 목록에서 지워야 한다 — 남겨 두면 게이트의 가림막이 된다.
  assert.deepEqual(stale, [], '이관 완료 파일을 PENDING_MIGRATION에서 지우세요');
});

// ── (4) 네임스페이스 간 중복 키 0건 ───────────────────────────────────────────
test('(4) mergeNamespaces는 중복 키에서 throw하고 owner로 귀속을 보고한다', () => {
  assert.throws(() => i18n.mergeNamespaces([['a', {'x.y': '1'}], ['b', {'x.y': '2'}]]), /duplicate key "x\.y": a and b/);
  const {dict, owner} = i18n.mergeNamespaces([['a', {'x.y': '1'}], ['b', {'z.w': '2'}]]);
  assert.deepEqual({...dict}, {'x.y': '1', 'z.w': '2'});   // 사전은 프로토타입 없는 객체다
  assert.equal(owner.get('z.w'), 'b');
  for (const tag of i18n.LOCALES) {
    const loaded = loadDictionary(tag);
    assert.equal(loaded.owner.size, Object.keys(loaded.dict).length);
  }
});

// ── (5) 레지스트리 정합 ───────────────────────────────────────────────────────
test('(5) registry.NAMESPACES와 load.mjs의 정적 import 표가 en/ko 양쪽에서 일치한다', () => {
  assert.equal(NAMESPACES.length, 13);
  for (const tag of i18n.LOCALES) {
    assert.deepEqual(Object.keys(TABLES[tag]).sort(), [...NAMESPACES].sort(), `${tag} 표가 레지스트리와 다르다`);
    for (const ns of NAMESPACES) assert.equal(typeof TABLES[tag][ns], 'object', `${tag}/${ns} 사전이 없다`);
    // 디렉터리 하나 = en/ko 두 파일. 한쪽만 있는 PR은 여기서 드러난다.
    for (const ns of NAMESPACES) assert.ok(fs.existsSync(path.join(ROOT, 'ui/public/i18n', ns, `${tag}.mjs`)));
  }
  assert.throws(() => loadDictionary('xx'), /unknown locale xx/);
});

// ── (6) 복수형 규칙 R1~R4 ────────────────────────────────────────────────────
test('(6) 복수 키는 .other가 양쪽에 있고 그 언어의 형태만 쓴다', () => {
  const problems = [];
  for (const [tag, dict] of Object.entries(DICTS)) {
    const categories = new Set(new Intl.PluralRules(tag === 'ko' ? 'ko-KR' : 'en-US').resolvedOptions().pluralCategories);
    for (const key of Object.keys(dict)) {
      const match = key.match(PLURAL_SUFFIX);
      if (!match) continue;
      const form = match[1], base = key.replace(PLURAL_SUFFIX, '');
      if (!categories.has(form)) problems.push(`${tag} ${key}: ${tag}에는 ${form} 형태가 없다 (죽은 키)`);
      if (!(`${base}.other` in dict)) problems.push(`${tag} ${base}: .other가 없다 (R1)`);
    }
  }
  assert.deepEqual(problems, []);
});

// ── (7) 사전 완전성 양방향 (R4 포함) ─────────────────────────────────────────
test('(7) 소스에서 쓰는 키와 사전이 양방향으로 맞는다', () => {
  assert.deepEqual(extract.checkKeys(DICTS), []);
});

// ── (8) data-endonym 마커가 번지지 않는다 ─────────────────────────────────────
test('(8) data-endonym은 언어 컨트롤 2곳에만 있다', () => {
  const hits = [];
  for (const file of [...extract.sourceFiles(['ui/public']), path.join(ROOT, 'ui/public/index.html')]) {
    const text = fs.readFileSync(file, 'utf8');
    // 속성으로 쓰인 것만 센다 — 주석의 `data-endonym` 언급(백틱 안)은 마커가 아니다.
    const count = [...text.matchAll(/\sdata-endonym[\s>]/g)].length;
    if (count) hits.push([path.relative(ROOT, file), count]);
  }
  const total = hits.reduce((sum, [, count]) => sum + count, 0);
  assert.ok(total <= 2, `data-endonym이 ${total}곳: ${JSON.stringify(hits)}`);
});

// ── (9) t() 계약 ─────────────────────────────────────────────────────────────
test('(9) 누락 키는 키 문자열 + console.error 1회이고 en으로 떨어지지 않는다', () => {
  const original = console.error;
  const seen = [];
  console.error = message => seen.push(String(message));
  try {
    // en 사전에만 있는 키를 만들어 ko 세션에서 조회한다 — 폴백이 있으면 영어가 나온다.
    i18n.setLocale('ko', {'a.b': '있음'});
    assert.equal(i18n.t('a.b'), '있음');
    assert.equal(i18n.t('only.in.en'), 'only.in.en');
    assert.equal(i18n.t('only.in.en'), 'only.in.en');
    assert.equal(seen.filter(m => m.includes('only.in.en')).length, 1, '같은 키는 한 번만 보고한다');
    assert.match(seen[0], /\[memex-ui\]\[i18n\] missing ko key: only\.in\.en/);
  } finally {
    console.error = original;
  }
});

test('(9) 보간·이스케이프·html 접두사·복수형 해소·미지원 로케일', () => {
  i18n.setLocale('en', {
    'greet': 'Hello {name}',
    'markup': 'Pick <strong>{what}</strong> or {htmlLink}',
    'row.other': '{count} rows',
    'row.one': '{count} row',
    'ko.only.other': '{count}개',
  });
  assert.equal(i18n.t('greet', {name: 'Memex'}), 'Hello Memex');
  assert.equal(i18n.t('greet'), 'Hello {name}', '파라미터가 없으면 슬롯을 그대로 둔다');
  assert.equal(i18n.tHtml('markup', {what: '<script>', htmlLink: '<a href="#">go</a>'}),
    'Pick <strong>&lt;script&gt;</strong> or <a href="#">go</a>');
  assert.equal(i18n.tn('row', 1), '1 row');
  assert.equal(i18n.tn('row', 4), '4 rows');
  // en에 .one이 없으면 같은 사전의 .other로 내려간다 — 언어 간 폴백이 아니다.
  assert.equal(i18n.tn('ko.only', 1), '1개');
  assert.throws(() => i18n.setLocale('xx', {}), /unknown locale xx/);
  assert.equal(i18n.intlTag(), 'en-US');
  i18n.setLocale('ko', ko);
  assert.equal(i18n.intlTag(), 'ko-KR');
  assert.equal(i18n.localeTag(), 'ko');
});

test('(9) resolveLocale은 브라우저 전역이 없으면 기본값 en이다', () => {
  assert.deepEqual(i18n.resolveLocale(), {tag: 'en', from: 'default'});
  assert.equal(i18n.serverLocale(), null);
  assert.deepEqual([...i18n.LOCALES], ['en', 'ko']);
  assert.equal(i18n.DEFAULT_LOCALE, 'en');
});

// ── (10) endonym 직접 테스트 ─────────────────────────────────────────────────
const ctxFor = (params, prefs = {}) => ({
  p: new URLSearchParams(params),
  prefs: {theme: 'light', density: 'comfortable', preferTranslatedFacts: true, live: false, help: 'always', ...prefs},
  bootstrap: {
    uiVersion: '1.0.0', environment: {version: '0.7.0', node: process.version, platform: process.platform, pid: 1,
      root: '/repo', home: '/home', dbPath: '/home/db.sqlite', values: {}, note: 'note', commands: false, sync: false, mutable: false},
    db: {available: true, error: null}, capabilities: {}, commands: {}, projects: [], factTotals: {},
  },
  href: (pathname, query = {}) => {
    const u = new URL(pathname, 'http://127.0.0.1');
    for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
    return u.pathname + u.search;
  },
  api: async () => ({items: []}),
  update() {}, open() {}, toast() {},
});

test('(10) 관리 › 화면 설정의 언어 이름은 en·ko 양쪽에서 원문 그대로 나온다', async () => {
  for (const tag of ['en', 'ko']) {
    i18n.setLocale(tag, DICTS[tag]);
    const {html} = await settingsPage.render(ctxFor('tab=interface'));
    assert.match(html, /data-endonym/, `${tag}: 언어 select에 data-endonym이 없다`);
    assert.ok(html.includes(ENDONYMS.en), `${tag}: English endonym이 없다`);
    assert.ok(html.includes(ENDONYMS.ko), `${tag}: 한국어 endonym이 없다`);
    assert.ok(html.includes(DICTS[tag]['settings.interface.language.title']));
    assert.ok(html.includes(DICTS[tag]['settings.tabs.interface']));
  }
  // ?lang로 들어온 세션은 왜 선택과 화면이 다른지 설명하는 태그를 단다.
  i18n.setLocale('ko', ko);
  const {html} = await settingsPage.render(ctxFor('tab=interface&lang=en'));
  assert.ok(html.includes(ko['settings.interface.language.fromUrl']));
});

// ── (11) 네임스페이스 접두사 규율 ────────────────────────────────────────────
test('(11) 각 네임스페이스의 모든 키가 그 네임스페이스의 접두사를 쓴다', () => {
  const problems = [];
  for (const tag of i18n.LOCALES) {
    for (const ns of NAMESPACES) {
      const allowed = PREFIXES[ns];
      assert.ok(Array.isArray(allowed) && allowed.length, `${ns}의 접두사 표가 없다`);
      for (const key of Object.keys(TABLES[tag][ns])) {
        if (!allowed.some(prefix => key.startsWith(prefix))) problems.push(`${tag}/${ns}: "${key}"는 ${allowed.join('|')} 가 아니다`);
      }
    }
  }
  assert.deepEqual(problems, []);
  // settings.* 의 유일한 소유자는 settings 네임스페이스다 (decisions-v3 I3).
  for (const tag of i18n.LOCALES) {
    for (const ns of NAMESPACES) {
      if (ns === 'settings') continue;
      const leaked = Object.keys(TABLES[tag][ns]).filter(key => key.startsWith('settings.'));
      assert.deepEqual(leaked, [], `${tag}/${ns}에 settings.* 키가 있다`);
    }
  }
});

// ── 탭 레지스트리 계약 ───────────────────────────────────────────────────────
test('관리 탭 레지스트리는 7항목이고 기존 id를 개명하지 않는다', () => {
  assert.deepEqual(SETTINGS_TABS.map(x => x.id),
    ['runtime', 'actions', 'sync', 'interface', 'diagnostics', 'overlays', 'models']);
  for (const tab of SETTINGS_TABS) {
    assert.equal(tab.labelKey, `settings.tabs.${tab.id}`);
    assert.ok(tab.labelKey in en && tab.labelKey in ko, `${tab.labelKey}가 사전에 없다`);
  }
  // overlays·models는 화면이 붙기 전까지 노출되지 않는다.
  assert.deepEqual(visibleTabs().map(x => x.id), ['runtime', 'actions', 'sync', 'interface', 'diagnostics']);
  assert.equal(DEFAULT_TAB, 'runtime');
  assert.equal(tabFor('actions').id, 'actions');
  assert.equal(tabFor('interface').id, 'interface');
  assert.equal(tabFor('overlays').id, 'runtime', '비활성 탭은 runtime으로 떨어진다');
  assert.equal(tabFor(null).id, 'runtime');
});

// ── 서버 기본 언어 주입 (§9.4 (5)의 브라우저 없는 대역) ──────────────────────
const {createServer, resolveServerLocale, resolveRequestLocale, localizeHtml} = require('../lib/server.cjs');
const {fixture, FixtureCore} = require('./fixture.cjs');

test('--lang / MEMEX_UI_LANG 해석은 화이트리스트를 통과한 값만 돌려주고 잘못된 값은 throw한다', () => {
  assert.equal(resolveServerLocale([], {}), 'en');
  assert.equal(resolveServerLocale(['--lang', 'ko'], {}), 'ko');
  assert.equal(resolveServerLocale(['--lang=ko'], {}), 'ko');
  assert.equal(resolveServerLocale(['--lang', 'ko-KR'], {}), 'ko');
  assert.equal(resolveServerLocale([], {MEMEX_UI_LANG: 'ko'}), 'ko');
  assert.equal(resolveServerLocale(['--lang', 'en'], {MEMEX_UI_LANG: 'ko'}), 'en', '플래그가 환경 변수를 이긴다');
  assert.throws(() => resolveServerLocale(['--lang', 'fr'], {}), /--lang must be one of en, ko/);
  assert.throws(() => resolveServerLocale([], {MEMEX_UI_LANG: 'fr'}), /--lang must be one of/);
  // 요청 단위 해석은 항상 'en'|'ko'다 — HTML 치환에 주입 경로가 없다.
  assert.equal(resolveRequestLocale(new URLSearchParams('lang=ko'), 'en'), 'ko');
  assert.equal(resolveRequestLocale(new URLSearchParams('lang=<script>'), 'ko'), 'ko');
  assert.equal(resolveRequestLocale(new URLSearchParams(''), 'ko'), 'ko');
  assert.equal(localizeHtml('<html lang="en" data-lang="en" x>', 'en'), '<html lang="en" data-lang="en" x>');
  assert.equal(localizeHtml('<html lang="en" data-lang="en" x>', 'ko'), '<html lang="ko" data-lang="ko" x>');
});

test('서버는 index.html에 언어를 심고 CSP는 그대로다 (인라인 스크립트 0개)', async () => {
  const f = fixture();
  const app = createServer({core: new FixtureCore(f), lang: 'ko'});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  try {
    assert.equal(app.lang, 'ko');
    const res = await fetch(base + '/settings');
    const html = await res.text();
    assert.ok(html.includes('<html lang="ko" data-lang="ko"'), '<html lang>·data-lang이 서버 기본 언어다');
    assert.ok(html.includes('<meta name="memex-ui-lang" content="ko">'), 'meta 이중화도 같은 값이다');
    assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(html, 'utf8'), 'Content-Length를 다시 센다');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes("'unsafe-inline'; script") && !/script-src[^;]*unsafe-inline/.test(csp), 'CSP를 완화하지 않는다');
    assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), '인라인 <script>가 없다');
    // ?lang이 서버 기본값을 이긴다. 알 수 없는 값은 기본값으로 떨어진다.
    assert.ok((await (await fetch(base + '/?lang=en')).text()).includes('<html lang="en" data-lang="en"'));
    assert.ok((await (await fetch(base + '/?lang=fr')).text()).includes('<html lang="ko" data-lang="ko"'));
    // API는 언어로 분기하지 않는다 — 언어의 진원지는 브라우저다.
    const bootstrap = await (await fetch(base + '/api/v2/bootstrap?lang=en')).json();
    assert.equal(bootstrap.db.available, true);
    assert.equal('lang' in bootstrap, false, '서버는 API 페이로드에 언어를 싣지 않는다');
  } finally { app.close(); fs.rmSync(f.home, {recursive: true, force: true}); }
});

test('문서 앵커는 언어 무관 상수 모듈 하나에 모여 있다', () => {
  assert.equal(Object.keys(DOC_ANCHORS).length, 16);
  for (const value of Object.values(DOC_ANCHORS)) assert.match(value, /^docs\/[A-Z-]+\.md#/);
  // 앵커는 사전에 들어가지 않는다 — 두 벌로 갈라지면 드리프트한다.
  for (const dict of Object.values(DICTS)) {
    for (const value of Object.values(dict)) assert.ok(!value.includes('docs/'), `사전 값에 문서 경로: ${value}`);
  }
});
