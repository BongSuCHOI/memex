'use strict';
/**
 * en 스모크 — 페이지 모듈을 영어 로케일로 렌더해 이관 회귀를 구조적으로 덮는다
 * (#109, 0.7.0 · 설계 §9.2).
 *
 * 레인별로 **독립 섹션**을 둔다. 각 섹션은 자기 파일만 렌더하고, `useEn()`/`useKo()`를
 * 자기 테스트 안에서 직접 부르므로 섹션 순서에 의존하지 않는다. 다른 레인은 이 파일 끝에
 * 자기 섹션을 덧붙인다 — 기존 섹션을 수정하지 않는다.
 *
 * 단정은 세 가지다:
 *   (a) **키 누출 0건** — `pages.*`/`activity.*` 점 표기 키가 화면에 그대로 나오면 사전 누락이다.
 *   (b) **en 랜드마크 일치** — 사전 값이 실제로 화면에 꽂혔는지.
 *   (c) **이관한 한국어 0건** — 내가 사전으로 옮긴 문장이 en 화면에 남아 있으면 치환 누락이다.
 *
 * "화면 전체에 한글 0건"은 **페이지 섹션에서는** 단정하지 않는다 — `ui.mjs`(pagination/badge/
 * date)가 아직 PENDING_MIGRATION이라 L1 머지 전에는 성립하지 않는다. 그 단정은 L1의 e2e
 * probe(§9.4 (4))가 맡는다. 카탈로그만 렌더하는 L4 섹션은 자기 범위에서 직접 단정한다.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const locale = require('./helpers/locale.cjs');

const overview = require('../public/pages/overview.mjs');
const conversations = require('../public/pages/conversations.mjs');
const facts = require('../public/pages/facts.mjs');
const taxonomy = require('../public/pages/taxonomy.mjs');
const graph = require('../public/pages/graph.mjs');
const activity = require('../public/pages/activity.mjs');
const {KnowledgeGraph} = require('../public/graph-engine.mjs');

/** 미번역 키가 텍스트로 새어 나온 경우. `data-*`/클래스에는 이 형태가 쓰이지 않는다. */
const LEAKED_KEY = /\b(?:pages|activity)\.[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+/g;

function ctx(params, data, extra = {}) {
  const p = new URLSearchParams(params);
  return {
    p,
    prefs: {preferTranslatedFacts: false, density: 'comfortable', live: false, help: 'always'},
    scope: {scope: 'all'},
    bootstrap: {environment: {mutable: true, autoOntology: true}},
    ...extra,
    href: (pathname, query = {}) => {
      const u = new URL(pathname, 'http://127.0.0.1');
      for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
      return u.pathname + u.search;
    },
    api: async key => {
      if (!(key in data)) throw new Error('unexpected api call: ' + key);
      return data[key];
    },
    update() {}, open() {}, toast() {},
  };
}

/**
 * 화면 전체 한글 0건 (L5, #109).
 *
 * L1~L4가 전부 머지된 뒤로는 `ui.mjs`·`help.mjs` PENDING_MIGRATION 예외가 사라졌으므로,
 * "이관한 한국어 목록"을 열거하는 대신 **en 렌더에 한글이 한 글자도 없음**을 단정한다.
 * 열거 목록은 빼먹은 문장을 놓치지만, 전수 검사는 놓치지 않는다.
 *
 * 면제는 구조적으로 둘뿐이고 둘 다 텍스트 허용 목록이 아니다:
 *   · `doc-anchors.mjs`의 한국어 문서 앵커 — `docs/*.md`에 영문판이 없다 (설계 §6.4)
 *   · 픽스처의 사용자 콘텐츠(`fact_kr` 등) — UI 문구가 아니라 데이터다
 */
const PAGE_HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
/** 이 파일의 픽스처가 담은 한국어 "사용자 데이터". UI 문구가 아니므로 검사에서 뺀다. */
const FIXTURE_CONTENT = ['로컬 우선 저장은 기기에 남는다.', '번역만 있음'];

function assertNoHangul(html, where) {
  const anchors = require('../public/i18n/doc-anchors.mjs').DOC_ANCHORS;
  let body = String(html);
  for (const anchor of Object.values(anchors)) body = body.split(anchor).join('');
  for (const text of FIXTURE_CONTENT) body = body.split(text).join('');
  const hit = body.split(/\n/).find(line => PAGE_HANGUL.test(line));
  assert.equal(hit, undefined, `${where}: en 렌더에 한글이 남아 있다 — ${String(hit).trim().slice(0, 160)}`);
}

/** (a)+(c)를 한 번에 본다. 호출자는 en 랜드마크만 따로 단정하면 된다. */
function assertEnglish(html, migratedKorean, where) {
  assert.deepEqual(html.match(LEAKED_KEY) ?? [], [], `${where}: 미번역 키가 화면에 노출됐다`);
  for (const text of migratedKorean) assert.ok(!html.includes(text), `${where}: 이관한 한국어가 남아 있다 — ${text}`);
  assertNoHangul(html, where);
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ L3 · pages + activity (overview/conversations/facts/taxonomy/graph/      │
// │      activity + graph-engine)                                           │
// ╰──────────────────────────────────────────────────────────────────────────╯

const TAXONOMY = {
  available: true, unclassified: 2,
  domains: [{id: 'engineering', name: 'Engineering', facts: 3}],
  categories: [{id: 'storage', domain_id: 'engineering', name: 'Storage', description: 'SQLite access', facts: 3}],
};
const FACT = {
  id: 'f1', fact: 'Local first storage stays on the device.', fact_kr: '로컬 우선 저장은 기기에 남는다.',
  category: 'decision', scope_type: 'project', scope_project: '/workspace/memex', promotion_state: 'legacy-project',
  ontology_category_id: 'storage', is_active: 1, source_count: 2, updated_at: '2026-09-01T00:00:00.000Z',
};
const OVERVIEW = {
  activity: [], exchanges: 12, sessions: 3, facts: {active: 5, inactive: 1, unclassified: 2},
  running: 1, failed: 1, retry: 1, hiddenByTier: {workstream: 9, workspace: 2},
  recent: [], sessionsRecent: [{session_id: 's1', title: 'Session one', project: '/workspace/memex', exchanges: 4, ended_at: '2026-09-01T00:00:00.000Z'}],
  generated_at: '2026-09-01T00:00:00.000Z',
};
const PIPELINE = {
  readiness: {conversationReady: true, factReady: false, graphReady: true},
  conversations: {sessionsIndexed: 3, exchanges: 12},
  extraction: {pending: 1, retriable: 0, excluded: 2},
  embeddings: {factVectorsPending: 4},
  ontology: {classifiedFacts: 3, pendingFacts: 2},
};
const GRAPH = {
  total: 9, truncated: true, focus: null, nodes: [{id: 'f1', fact: 'Local first storage stays on the device.', fact_kr: '로컬 우선 저장은 기기에 남는다.', ontology_category_id: 'storage'}],
  edges: [], types: ['SUPPORTS', 'CONTRADICTS'], domains: TAXONOMY.domains, categories: TAXONOMY.categories, edgeTruncated: true,
};

test('L3 en: 개요는 en 사전으로 렌더되고 한국어·키 누출이 없다', async () => {
  locale.useEn();
  const {html} = await overview.render(ctx('', {overview: OVERVIEW, pipeline: PIPELINE}));
  assertEnglish(html, ['기억의 흐름을 한눈에', '선택 범위 요약', '파이프라인 상태', '최근 대화 원장', '자동 온톨로지'], 'overview');
  assert.ok(html.includes('How memory flows'));
  assert.ok(html.includes('Archived turns') && html.includes('Captured from 3 sessions'));
  assert.ok(html.includes('Conversation capture') && html.includes('4 embeddings pending'));
  assert.ok(html.includes('Automatic taxonomy') && html.includes('<strong>on</strong>'));
  // 복수형이 en에서 실제로 갈린다 — 11건은 복수, 1건은 단수.
  assert.ok(html.includes('11 branch and workstream memories sit outside this view'));
  assert.ok(html.includes('2 jobs need review'));
});

test('L3 en: 대화 원장 목록과 세션 상세가 en으로 렌더된다', async () => {
  locale.useEn();
  const sessions = {items: [{session_id: 's1', title: 'Session one', project: '/workspace/memex', exchanges: 1, branch: 'main', started_at: '2026-09-01T00:00:00.000Z', ended_at: '2026-09-01T01:00:00.000Z', extraction: {saved: 2}}], total: 1, limit: 30, offset: 0, engine: 'fts'};
  const list = await conversations.render(ctx('q=storage', {sessions}));
  assertEnglish(list.html, ['대화 원장', '개 세션', '추출 집계 있음', '날짜 필터는 UTC 기준입니다.'], 'conversations/list');
  assert.ok(list.html.includes('Conversation ledger'));
  assert.ok(list.html.includes('1 session') && list.html.includes('1 turn'), '단수형이 쓰여야 한다');
  assert.ok(list.html.includes('FTS word match'));

  const session = {project: '/workspace/memex', started_at: '2026-09-01T00:00:00.000Z', total: 2, limit: 20, offset: 0, branch: 'main',
    items: [{id: 'e1', user_message: 'hello', assistant_message: 'hi', timestamp: '2026-09-01T00:00:00.000Z', content_generation: 1, extraction_state: [{state: 'processed', content_generation: 1}]}],
    facts: [], jobs: [], recalls: [], capsule: {objective: 'Ship it', current_state: 'In review'}};
  const detail = await conversations.render(ctx('session=s1', {session}));
  assertEnglish(detail.html, ['대화 기록', '사용자', '어시스턴트', '작업 맥락 Capsule', '입력 버전'], 'conversations/session');
  assert.ok(detail.html.includes('Transcript') && detail.html.includes('Input version 1'));
  assert.ok(detail.html.includes('2 turns') && detail.html.includes('Workstream capsule'));
  assert.ok(detail.html.includes('No linked memory'), '빈 상태도 en이다');
});

test('L3 en: 기억·사실의 표머리·필터·빈 상태·계층 배너가 en으로 렌더된다', async () => {
  locale.useEn();
  const page = {available: true, items: [FACT], total: 1, limit: 50, offset: 0, scopeTotal: 1, hiddenByTier: {workstream: 9, workspace: 2}};
  const {html} = await facts.render(ctx('', {facts: page, taxonomy: TAXONOMY}));
  assertEnglish(html, ['기억·사실', '기억 내용', '직접 근거', '모든 유형', '브랜치 범위', '원문 표시'], 'facts');
  assert.ok(html.includes('<h1>Memory &amp; facts</h1>'));
  assert.ok(html.includes('Direct evidence') && html.includes('Injection tier') && html.includes('All kinds'));
  assert.ok(html.includes('This project holds 11 more memories in branch or workstream scope'));
  assert.ok(html.includes('9 in branch scope · 2 in workspace scope'));
  assert.ok(html.includes('Unclassified · awaiting classification · 2'));
  // preferTranslatedFacts=false이면 fact_kr을 앞세우지 않는다 (설계 §14.5).
  assert.ok(html.includes('Local first storage stays on the device.'));
  assert.ok(!html.includes('로컬 우선 저장은 기기에 남는다.'), 'en 기본에서 fact_kr이 강제되면 안 된다');

  const emptyScope = await facts.render(ctx('', {facts: {available: true, items: [], total: 0, limit: 50, offset: 0, scopeTotal: 0}, taxonomy: TAXONOMY}));
  assertEnglish(emptyScope.html, ['이 범위에 저장된 기억이 없습니다'], 'facts/empty');
  assert.ok(emptyScope.html.includes('No memory is stored in this scope'));
  assert.ok(emptyScope.html.includes('Open admin actions'));
});

test('L3 en: 주제 분류가 en으로 렌더되고 빈 상태도 번역된다', async () => {
  locale.useEn();
  const {html} = await taxonomy.render(ctx('', {taxonomy: TAXONOMY}));
  assertEnglish(html, ['주제 분류', '전체 도메인', '분류 대기', '지도에서 보기', '개 분류'], 'taxonomy');
  assert.ok(html.includes('<h1>Taxonomy</h1>') && html.includes('All domains'));
  assert.ok(html.includes('2 active memories still have no topic.'));
  assert.ok(html.includes('1 topic') && html.includes('3 active memories'));

  const empty = await taxonomy.render(ctx('q=nothing-matches', {taxonomy: TAXONOMY}));
  assert.ok(empty.html.includes('No topics to show'));
});

test('L3 en: 지식 지도의 필터·범례·요약이 en으로 렌더된다', async () => {
  locale.useEn();
  const {html} = await graph.render(ctx('', {graph: GRAPH}));
  assertEnglish(html, ['지식 지도', '의미 관계', '뒷받침', '드래그 이동', '도메인</span>'], 'graph');
  assert.ok(html.includes('<h1>Knowledge map</h1>'));
  assert.ok(html.includes('Supports') && html.includes('Contradicts'));
  assert.ok(html.includes('Drag to pan · scroll to zoom') && html.includes('Select a node → memory and evidence'));
  assert.ok(html.includes('<strong>1</strong> domain') && html.includes('<strong>1</strong> topic'), '복수형이 1에서 단수가 된다');
  assert.ok(html.includes('Relations are capped at 30,000.'));
  assert.ok(html.includes('WebGL knowledge map. Arrow keys pan'));
  // 노드 목록도 표시 설정을 존중한다.
  assert.ok(!html.includes('로컬 우선 저장은 기기에 남는다.</button>'), '노드 라벨에 fact_kr이 강제되면 안 된다');
});

test('L3 en: 활동 · 추적의 탭·표머리·배너가 en으로 렌더된다', async () => {
  locale.useEn();
  const chronicle = await activity.render(ctx('', {chronicle: {available: true, items: [], total: 0, limit: 40, offset: 0}}));
  assertEnglish(chronicle.html, ['활동 · 추적', '지식 변경', '처리 작업', '기억 변경 기록이 없습니다', '모든 이벤트'], 'activity/chronicle');
  assert.ok(chronicle.html.includes('Activity & tracing') || chronicle.html.includes('Activity &amp; tracing'));
  assert.ok(chronicle.html.includes('Knowledge changes') && chronicle.html.includes('Model attempts'));
  assert.ok(chronicle.html.includes('No memory changes recorded') && chronicle.html.includes('All events'));

  const jobs = await activity.render(ctx('tab=jobs', {jobs: {available: true, total: 1, limit: 40, offset: 0,
    items: [{job_id: 'j1', session_id: 's1', kind: 'fact_extract', state: 'completed', attempts: 1, max_attempts: 3, updated_at: '2026-09-01T00:00:00.000Z', last_error: null}]}}));
  assertEnglish(jobs.html, ['작업 · 종류', '다음 행동', '업데이트', '재시도 대기'], 'activity/jobs');
  assert.ok(jobs.html.includes('Job · kind') && jobs.html.includes('Next action') && jobs.html.includes('Waiting to retry'));

  const operations = await activity.render(ctx('tab=operations', {operations: {available: true, items: [], total: 0, limit: 40, offset: 0}}));
  assertEnglish(operations.html, ['관리 실행 내역이 없습니다', '전체 실행 기록', '명령'], 'activity/operations');
  assert.ok(operations.html.includes('No admin run history') && operations.html.includes('All run history'));

  const globalScope = await activity.render(ctx('', {chronicle: {available: true, items: [], total: 0, limit: 40, offset: 0}}, {scope: {scope: 'global'}}));
  assert.ok(globalScope.html.includes('The common memory scope holds no activity'));
  assert.ok(globalScope.html.includes('Switch to all projects'));
});

test('L3 en: 시스템 로그 배너는 조각을 en으로 이어 붙인다', async () => {
  locale.useEn();
  const {html} = await activity.render(ctx('tab=logs', {
    'log-files': {items: [{id: 'inject', name: 'inject-context', group: 'hooks'}]},
    logs: {available: true, items: [], total: 0, limit: 200, offset: 0, bytesRead: 4096, truncated: true, hiddenForScope: 3},
  }));
  assertEnglish(html, ['원시 로그에는', '표시 한도로', '개 행을 제외했습니다'], 'activity/logs');
  assert.ok(html.includes('Reading up to 200 entries from the last 4,096 bytes of the file.'));
  assert.ok(html.includes('The display limit leaves some entries out.'));
  assert.ok(html.includes('Excluded 3 rows that the current scope cannot confirm.'));
  assert.ok(html.includes('Raw logs may still contain sensitive values.'));
});

test('L3: graph-engine의 노드 라벨은 preferTranslated를 존중한다', () => {
  const label = (preferTranslated, node) => KnowledgeGraph.prototype.nodeLabel.call({preferTranslated}, node);
  const node = {fact: 'Local first storage stays on the device.', fact_kr: '로컬 우선 저장은 기기에 남는다.'};
  assert.equal(label(false, node), 'Local first storage stays on the device.');
  assert.equal(label(true, node), '로컬 우선 저장은 기기에 남는다.');
  // 원문이 없으면 번역으로 떨어진다 — 라벨이 빈 칸이 되는 것보다 낫다.
  assert.equal(label(false, {fact: null, fact_kr: '번역만 있음'}), '번역만 있음');
  assert.equal(label(true, {fact: 'only original'}), 'only original');
  assert.equal(label(false, null), '');
});

test('L3 ko: 같은 페이지가 ko 로케일에서 기존 문구를 그대로 낸다', async () => {
  locale.useKo();
  const {html} = await overview.render(ctx('', {overview: OVERVIEW, pipeline: PIPELINE}));
  assert.ok(html.includes('기억의 흐름을 한눈에') && html.includes('파이프라인 상태'));
  assert.ok(html.includes('브랜치/작업 흐름 범위 기억 11건이 이 화면 밖에 있습니다'));
  const page = await facts.render(ctx('', {facts: {available: true, items: [FACT], total: 1, limit: 50, offset: 0, scopeTotal: 1, hiddenByTier: {workstream: 9, workspace: 2}}, taxonomy: TAXONOMY}));
  assert.ok(page.html.includes('<h1>기억·사실</h1>'));
  assert.ok(page.html.includes('브랜치 범위 9건 · 워크스페이스 범위 2건'));
  const act = await activity.render(ctx('tab=jobs', {jobs: {available: true, items: [], total: 0, limit: 40, offset: 0}}));
  assert.ok(act.html.includes('활동 · 추적') && act.html.includes('처리 작업이 없습니다'));
});

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ L4 · help + guidance (help.mjs / guidance.mjs)                          │
// ╰──────────────────────────────────────────────────────────────────────────╯
//
// 이 두 파일은 페이지가 아니라 **카탈로그**다: 렌더러는 6개뿐이고 내용은 전부 사전에서 온다.
// 그래서 단정도 두 갈래다 — 카탈로그 항목의 값 자체를 훑고, 렌더러 출력에 한글이 없는지 본다.
//
// L3 섹션과 달리 **한글 0건을 직접 단정한다.** help/guidance는 PENDING_MIGRATION에서 빠졌고
// 두 모듈이 `ui.mjs`에서 쓰는 것은 `esc`·`icon`·`btn`·`kv`·`number`(문구 없음)뿐이다. 예외는
// 문서 앵커 하나로, `docs/*.md`에 영문판이 없어 en UI도 같은 한국어 앵커로 보내고 대신 한 줄
// 고지를 붙인다(설계 §6.4). 텍스트 허용 목록이 아니라 `doc-anchors.mjs`의 값을 빼는 **구조적
// 면제**라서, 다른 곳에 한글이 새면 여전히 잡힌다.
const help = require('../public/help.mjs');
const guidance = require('../public/guidance.mjs');
const {DOC_ANCHORS} = require('../public/i18n/doc-anchors.mjs');

const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
/** 누락 키는 en으로 떨어지지 않고 키 문자열 그대로 나온다(§2.2) — 그 모양을 찾는다. */
const LEAKED_CATALOGUE_KEY = /\b(?:help|guidance|badge|common)\.[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+/;
const withoutAnchors = html => Object.values(DOC_ANCHORS).reduce((out, anchor) => out.split(anchor).join(''), String(html));
const visibleText = html => withoutAnchors(html).replace(/<[^>]*>/g, ' ');
const guidanceCtx = {href: (p, q = {}) => p + '?' + new URLSearchParams(q), bootstrap: {environment: {commands: true}}};

/** 카탈로그 값 하나를 (a) 비어 있지 않은지 (b) 한글인지 (c) 키가 노출됐는지로 본다. */
function catalogueProblems(entries) {
  const problems = [];
  for (const [where, value] of entries) {
    if (typeof value !== 'string' || !value) { problems.push(`${where}: 값이 비었다`); continue; }
    if (HANGUL.test(value)) problems.push(`${where}: 한글이 남았다 — ${value.slice(0, 40)}`);
    if (LEAKED_CATALOGUE_KEY.test(value)) problems.push(`${where}: 미번역 키가 노출됐다 — ${value.slice(0, 60)}`);
  }
  return problems;
}

test('L4 en: 도움말 카탈로그 36항목과 용어집 17항목이 en으로 읽힌다', () => {
  locale.useEn();
  const entries = [];
  for (const [key, entry] of help.ALL) entries.push([key + '.title', entry.title], [key + '.body', entry.body]);
  for (const g of help.GLOSSARY) entries.push(['glossary:' + g.id + '.term', g.term], ['glossary:' + g.id + '.body', g.body]);
  assert.deepEqual(catalogueProblems(entries), []);
  assert.equal(help.ALL.length, 36, '도움말 항목 수가 바뀌었다');
  assert.equal(help.GLOSSARY.length, 17);
  // 모듈이 사전을 실제로 읽는지 — 게터가 아니라 굳은 값이면 여기서 어긋난다.
  assert.equal(help.PAGES['/facts'].title, locale.en['help.page.facts.title']);
  assert.equal(help.helpFor('header:nextAction').body, locale.en['help.header.nextAction.body']);
  assert.equal(help.badgeHelp('dead'), locale.en['badge.dead.help']);
});

test('L4 en: 실패 분류 38개의 제목·원인·영향·다음 행동이 en으로 읽힌다', () => {
  locale.useEn();
  const entries = [];
  for (const cls of [...guidance.CLASSES, guidance.unknownClass('boom')])
    for (const field of ['title', 'cause', 'impact', 'next']) entries.push([`${cls.id}.${field}`, cls[field]]);
  assert.deepEqual(catalogueProblems(entries), []);
  // 0.7.0 (#31/#30): `job-held`가 들어와 36 → 37이 됐다(+ unknown = 38).
  assert.equal(guidance.CLASSES.length, 37, '실패 클래스 수가 바뀌었다');
  assert.equal(guidance.guidanceFor('job-dead').title, locale.en['guidance.job-dead.title']);
});

test('L4 en: 안내 렌더러 출력에는 문서 앵커 말고 한글이 없다', () => {
  locale.useEn();
  const groups = guidance.attentionFromPipeline({
    attention: {memoryJobsDead: 7, memoryJobsRetry: 2, terminal: {modelWorkBudgetsExhausted: 3}},
    ontology: {parkedFacts: 4, indexRepair: {blocked: true, reason: 'write'}},
    evidence: {factsWithoutLocalEvidence: 118},
    derivedLaneSkips: {consecutive: 2},
    quarantinedProjects: [{projectId: 'p'}],
  });
  const html = [
    guidance.guidancePanel(guidance.guidanceFor('job-dead'), guidanceCtx),
    guidance.guidancePanel(guidance.unknownClass('LLM boom'), guidanceCtx),
    guidance.guidanceCell(guidance.guidanceFor('sync-export-failed'), guidanceCtx),
    guidance.attentionCard(groups, guidanceCtx),
  ].join('\n');
  const text = visibleText(html);
  assert.equal(HANGUL.test(text), false, '한글이 남았다: ' + (text.match(/.{0,30}[가-힣].{0,30}/) || [''])[0]);
  assert.deepEqual(html.match(LEAKED_CATALOGUE_KEY) ?? [], [], '미번역 키가 화면에 노출됐다');
  // 수량 라벨은 사전의 1슬롯 패턴이 어순까지 갖는다 — 타이포그래피 이어붙이기를 없앴다(§6.0).
  assert.equal(groups.find(g => g.cls.id === 'job-dead').detail,
    locale.en['guidance.attention.job-dead.detail'].replace('{count}', '7'));
  assert.ok(html.includes(locale.en['guidance.attention.heading']));
  assert.ok(html.includes(locale.en['guidance.kv.cause']));
  assert.ok(html.includes(locale.en['guidance.action.recoverDeadWork']), '액션 라벨이 en 사전 값이 아니다');
  assert.ok(html.includes(locale.en['guidance.ignorable.false']));
  // 코어가 남긴 원문은 번역하지 않고 그대로 보여준다.
  assert.ok(html.includes('LLM boom'), '알 수 없는 오류의 원문이 사라졌다');
});

test('L4: en에서는 문서가 한국어라는 고지를 붙이고 ko에서는 붙이지 않는다', () => {
  locale.useEn();
  assert.equal(help.docsNotice(), locale.en['help.docs.koreanOnly']);
  assert.ok(help.docsNotice().length > 0, 'en 고지가 비었다');
  assert.equal(HANGUL.test(help.docsNotice()), false);
  locale.useKo();
  assert.equal(help.docsNotice(), '', 'ko에서는 고지를 붙이지 않는다');
  // ko 쪽 산문도 같은 사전에서 온다.
  assert.equal(help.PAGES['/facts'].title, locale.ko['help.page.facts.title']);
  assert.equal(guidance.guidanceFor('job-dead').next, locale.ko['guidance.job-dead.next']);
});

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ L2 · details + settings (details.mjs, pages/settings.mjs) — 공용 헬퍼      │
// ╰──────────────────────────────────────────────────────────────────────────╯
//
// L3의 `assertEnglish`는 "이관한 한국어 목록"을 호출자가 손으로 적는다. L2는 그 목록을
// **자동으로 구한다**: `PENDING_MIGRATION`에 남은 파일의 리터럴에서 수확한 낱말만 관용하고
// 나머지 한글은 전부 실패로 본다. 레인이 파일을 끝내고 목록에서 지우면 관용 집합이 저절로
// 줄어, 마지막 레인이 끝나는 순간 "en 렌더 한글 0건"이 절대 조건이 된다.
const path = require('node:path');
const extract = require('../../scripts/i18n-extract.mjs');

/** `details.fact.tab.summary` 처럼 점이 2개 이상인 소문자 토큰 = 렌더된 사전 키. */
const {DOC_ANCHORS: L2_DOC_ANCHORS} = require('../public/i18n/doc-anchors.mjs');
const L2_KEYISH = /\b[a-z][a-z0-9]*(?:\.[a-zA-Z0-9]+){2,}\b/g;
/** `data-endonym` 서브트리는 언어 이름(English / 한국어)을 번역하지 않으므로 면제한다(설계 §7.1). */
const stripEndonyms = html => html.replace(/<select[^>]*\sdata-endonym[\s>][\s\S]*?<\/select>/g, '');

const PENDING_KOREAN = (() => {
  const words = new Set();
  for (const file of extract.PENDING_MIGRATION) {
    for (const hit of extract.literals(path.join(extract.ROOT, file))) {
      for (const word of hit.text.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]+/g) || []) words.add(word);
    }
  }
  return words;
})();

function assertEnglishOnly(label, html) {
  // 문서 앵커는 한국어 문서의 제목 조각이라 언어와 무관하게 한글을 담는다(href·본문 모두) — L4와 같은 예외.
  let withoutAnchors = stripEndonyms(html).replace(/\shref="[^"]*"/g, '');
  for (const anchor of Object.values(L2_DOC_ANCHORS)) withoutAnchors = withoutAnchors.split(anchor).join(' ');
  const hangul = [...new Set([...withoutAnchors.matchAll(/[가-힣ㄱ-ㅎㅏ-ㅣ]+/g)].map(m => m[0]))]
    .filter(word => !PENDING_KOREAN.has(word));
  assert.deepEqual(hangul, [], `${label}: en 렌더에 (이관 대기 모듈의 것이 아닌) 한글이 남았다`);
}

/** 사전 키가 화면 문구로 새는 것만 본다 — 속성·JSON 덤프는 제외한다. */
function assertNoRenderedKeys(label, html) {
  const text = stripEndonyms(html)
    .replace(/<details class="json-details">[\s\S]*?<\/details>/g, '')  // raw() 원시 데이터 덤프
    .replace(/<[^>]*>/g, ' ');                                     // 태그·속성 제거
  const leaked = [...new Set([...text.matchAll(L2_KEYISH)].map(m => m[0]))]
    .filter(token => token.startsWith('details.') || token.startsWith('settings.')
      || token.startsWith('common.') || token.startsWith('error.') || token.startsWith('unit.'));
  assert.deepEqual(leaked, [], `${label}: 미번역 키가 화면에 렌더됐다`);
}

const l2ctx = (params, data = {}, extra = {}) => ({
  p: new URLSearchParams(params),
  prefs: {theme: 'light', density: 'comfortable', preferTranslatedFacts: false, live: false, help: 'always'},
  scope: {scope: 'all'},
  bootstrap: {environment: {mutable: true}, commands: {}},
  href: (pathname, query = {}) => {
    const u = new URL(pathname, 'http://127.0.0.1');
    for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
    return u.pathname + u.search;
  },
  api: async key => { if (!(key in data)) throw new Error('unexpected api call: ' + key); return data[key]; },
  update() {}, open() {}, toast() {}, modal() {}, confirm() {}, invalidate() {}, refreshDetail() {}, closeDetail() {},
  ...extra,
});

// ══ L2 · 상세 패널 (ui/public/details.mjs · namespace `details`) ══════════════
const details = require('../public/details.mjs');

const L2_FACT = {
  id: '11111111-1111-4111-8111-111111111111', fact: 'Local first storage stays on the device.', fact_kr: null,
  category: 'decision', scope_type: 'project', scope_project: '/workspace/memex', promotion_state: 'project-current',
  is_active: 1, source_total: 2, semantic_generation: 2, lifecycle_generation: 1, subject_key: null, tier_reason: null,
  workspace_id: null, workstream_id: null, provenance_parse_valid: false,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z',
  sources: [{exchange_id: 'x-1', timestamp: '2026-09-01T00:00:00.000Z', user_message: 'Where does data live?', content_generation: 1},
            {exchange_id: 'x-2', timestamp: '2026-09-01T01:00:00.000Z', unavailable: true, reason: 'transcript pruned'}],
  context_dependencies: [{exchange_id: 'x-3', timestamp: '2026-09-01T00:00:00.000Z', user_message: 'context', dependency_kind: 'context-only'}],
  relations: [{relation_type: 'SUPPORTS', source_fact_id: '11111111-1111-4111-8111-111111111111', other_id: 'f-2', other_fact: 'Other memory', reasoning: 'shared evidence'}],
  receipt: {method: 'hash', verified_at: '2026-09-02T00:00:00.000Z', semantic_generation: 2, fact_hash: 'abc123'},
  recalls: [{status: 'emitted', emitted_at: '2026-09-02T00:00:00.000Z', session_id: 'session-1'}],
  revisions: [{event_kind: 'CHANGED', actor: 'user', recorded_at: '2026-09-02T00:00:00.000Z',
    effective_at: '2026-09-01T00:00:00.000Z', previous_fact: 'before', new_fact: 'after', rationale: 'clarified'}],
  limits: {sources: 500, revisions: 200, relations: 200, recalls: 100},
};
const EXCHANGE = {exchange: {timestamp: '2026-09-01T00:00:00.000Z', project: '/workspace/memex', content_generation: 1,
    content_hash: null, closure_state: null, session_id: 'session-1', user_message: 'user says', assistant_message: null},
  tools: [{tool_name: 'Bash', is_error: 0, timestamp: '2026-09-01T00:00:00.000Z', source_type: null, learnable: null, tool_input: 'ls', tool_result: 'ok'}],
  extraction: [{state: 'processed', content_generation: 1, policy_version: 'v1', processed_at: null, target_id: null}],
  targets: [{state: 'processed', target_id: 'target-1', item_count: 1, attempts: 1, last_error: null}],
  facts: [{id: 'f-1', fact: 'A memory'}]};
const JOB = {job: {state: 'failed', kind: 'fact_extract', created_at: '2026-09-01T00:00:00.000Z', updated_at: null,
    attempts: 1, max_attempts: 3, available_at: null, lease_until: null, last_error: 'model call failed', session_id: 'session-1'},
  checkpoint: null, target: {target_id: 'target-1', state: 'processed', item_count: 1, from_rowid: 1, through_rowid: 9, policy_version: 'v1'},
  items: [{state: 'processed', exchange_id: 'x-1', content_generation: 1, ordinal: 1, content_hash: null}], itemsTruncated: true,
  attempts: [{state: 'failed', stage: 'extract', started_at: null, duration_ms: 1200, input_chars: 1, error_message: 'boom'}],
  failures: [{state: 'failed', error_message: 'boom', from_ordinal: 1, through_ordinal: 2, attempts: 1}],
  relatedFactsBasis: 'Same transcript as evidence', relatedFacts: [{id: 'f-1', fact: 'A memory'}],
  budget: {state: 'active', reserved_attempts: 1, max_attempts: 3, max_input_chars: 10, max_output_chars: 10, deadline_at: null}};
const OPERATION = {id: 'op-1', label: 'Run doctor', command: 'doctor', status: 'running', started_at: '2026-09-01T00:00:00.000Z',
  finished_at: null, exit_code: null, timeoutSeconds: 1, output: '', truncated: true, outputLost: true};
const IMPORTED_EVENT = {id: 'event-1', event_kind: 'SYNC_IMPORTED', actor: 'sync', fact_id: 'f-1',
  previous_fact: 'before', new_fact: 'after', projection_applied: 0, effective_at: '2026-09-09T00:00:00.000Z',
  effective_at_source: 'peer', recorded_at: '2026-09-10T00:00:00.000Z', created_at: '2026-09-10T00:00:00.000Z',
  source_exchange_ids: '["x-1"]',
  outcome_json: JSON.stringify({source_device_id: 'device-bbb', source_device_alias: 'Work MacBook', generation: 'gen-9', winner: 'peer', reason: 'peer-newer'})};
const ATTEMPT = {state: 'failed', token_usage_status: null, stage: 'extract', attempt_no: 1, started_at: null,
  finished_at: null, duration_ms: 1200, input_chars: 1, output_chars: 0, error_class: null, error_message: null,
  budget_id: null, job_id: 'job-1', token_usage_json: null};

test('L2 · 상세 패널 6종이 en에서 한글 0건 · 미번역 키 0건으로 렌더된다', async () => {
  locale.useEn();
  const panels = [];
  for (const tab of ['summary', 'evidence', 'history', 'reuse']) {
    const {html} = await details.renderDetail(l2ctx('panelTab=' + tab, {fact: L2_FACT}), 'fact', L2_FACT.id);
    panels.push([`fact/${tab}`, html]);
  }
  panels.push(['exchange', (await details.renderDetail(l2ctx('', {exchange: EXCHANGE}), 'exchange', 'x-1')).html]);
  panels.push(['job', (await details.renderDetail(l2ctx('', {job: JOB}), 'job', 'job-1')).html]);
  panels.push(['operation', (await details.renderDetail(l2ctx('', {operation: OPERATION}), 'operation', 'op-1')).html]);
  panels.push(['event', (await details.renderDetail(l2ctx('', {}), 'event', 'event-1', IMPORTED_EVENT)).html]);
  panels.push(['attempt', (await details.renderDetail(l2ctx('', {}), 'attempt', 'attempt-1', ATTEMPT)).html]);
  for (const [label, html] of panels) {
    assertEnglishOnly('details:' + label, html);
    assertNoRenderedKeys('details:' + label, html);
  }
});

test('L2 · 상세 패널의 랜드마크 문구가 en 사전 값과 같다', async () => {
  locale.useEn();
  const summary = (await details.renderDetail(l2ctx('panelTab=summary', {fact: L2_FACT}), 'fact', L2_FACT.id)).html;
  for (const key of ['details.fact.title', 'details.fact.tab.summary', 'details.fact.meta.title',
    'details.fact.relations.title', 'details.fact.action.delete', 'details.fact.meta.generations']) {
    assert.ok(summary.includes(locale.en[key]), `summary에 ${key} 값이 없다: ${locale.en[key]}`);
  }
  // 복수형은 Intl.PluralRules가 고르므로 단수 형태가 실제로 쓰인다.
  const evidence = (await details.renderDetail(l2ctx('panelTab=evidence', {fact: L2_FACT}), 'fact', L2_FACT.id)).html;
  assert.ok(evidence.includes('Direct evidence · 2 sources'), '복수형 .other가 쓰이지 않았다');
  assert.ok(evidence.includes(locale.en['details.fact.evidence.parseWarning']));
  const job = (await details.renderDetail(l2ctx('', {job: JOB}), 'job', 'job-1')).html;
  assert.ok(job.includes('1 input char') && !job.includes('1 input chars'), '단수형 .one이 쓰이지 않았다');
  assert.ok(job.includes('· 1 attempt<'), '실패 구간의 단수형이 쓰이지 않았다');
  const operation = (await details.renderDetail(l2ctx('', {operation: OPERATION}), 'operation', 'op-1')).html;
  assert.ok(operation.includes('1 second') && !operation.includes('1 seconds'));
});

test('L2 · 상세 패널은 en에서도 마크업 강조를 유지한다', async () => {
  locale.useEn();
  const summary = (await details.renderDetail(l2ctx('panelTab=summary', {fact: L2_FACT}), 'fact', L2_FACT.id)).html;
  assert.match(summary, /<strong>one step at a time<\/strong>/, 'tHtml의 <strong>이 이스케이프됐다');
  const reuse = (await details.renderDetail(l2ctx('panelTab=reuse', {fact: L2_FACT}), 'fact', L2_FACT.id)).html;
  assert.match(reuse, /<strong>actually delivered<\/strong>/);
});

// ══ L2 · 관리 화면 (ui/public/pages/settings.mjs · namespace `settings`) ══════
const settingsPage = require('../public/pages/settings.mjs');

// 런타임 탭이 location.origin을 읽는다 — 브라우저 밖에서는 이 스텁이 그 자리를 채운다.
if (typeof globalThis.location === 'undefined') globalThis.location = {origin: 'http://127.0.0.1:7777'};

const ENV = {version: '0.7.0', node: 'v22.0.0', platform: 'darwin', pid: 4242, root: '/repo', home: '/home/me',
  dbPath: '/home/me/db.sqlite', values: {MEMEX_HOME: null, MEMEX_SYNC_DIR: '/shared'},
  note: 'Read from this process only.', commands: true, sync: true, mutable: true};
const COMMANDS = {
  doctor: {label: 'Doctor', args: ['doctor'], mutates: false, model: false},
  extract: {label: 'Backfill extraction', args: ['facts', 'backfill'], mutates: true, model: true},
  recover: {label: 'Recover failed jobs', args: ['jobs', 'recover'], mutates: true, model: false},
};
const SYNC_STATUS = extra => ({status: {enabled: true, dir: '/shared/memex-sync', dirSource: 'configured', dirExists: true,
  dirWritable: true, configPath: '/home/me/sync/config.json', updatedAt: '2026-09-10T00:00:00.000Z',
  deviceId: 'device-aaa', deviceAlias: 'Home Mac mini', archiveDir: '/home/me/sync/exports',
  lastExport: {ok: true, at: '2026-09-10T01:00:00.000Z', counts: {facts: 12, revisions: 4, tombstones: 1, recallEvents: 9}},
  peers: [{deviceId: 'device-bbb', alias: 'Work MacBook', aliasIsLocal: false, isSelf: false, generation: 'gen-2',
    exportedAt: '2026-09-09T00:00:00.000Z', hostname: 'other-mac', counts: {facts: 7, revisions: 2, tombstones: 0, recallEvents: 3}}],
  ...extra}});
const ARCHIVE = {path: '/home/me/sync/exports/device-aaa-gen-1.zip', bytes: 2048, deviceId: 'device-aaa',
  deviceAlias: 'Home Mac mini', generation: 'gen-1', counts: {facts: 12, revisions: 3, tombstones: 0, recallEvents: 5}};
const PREVIEW = {path: '/Users/me/Downloads/g.zip', at: '2026-09-10T03:00:00.000Z', preview: {
  source: '/Users/me/Downloads/g.zip', deviceId: 'device-bbb', deviceAlias: 'Work MacBook', generation: 'gen-9',
  newFacts: 4, updatedFacts: 2, deletedFacts: 1,
  conflicts: [{factId: 'f-1', deviceId: 'device-bbb', deviceAlias: 'Work MacBook', winner: 'peer', reason: 'peer-newer'}],
  generations: [{deviceId: 'device-bbb', generation: 'gen-9'}],
  rejected: [{file: 'devices/device-bbb/CURRENT', line: 0, error: 'generation gen-8 integrity check failed'}]}};
const RUN = {action: 'import', at: '2026-09-10T02:00:00.000Z', outcome: {skipped: null, error: null,
  result: {newFacts: 5, updatedFacts: 2, deletedFacts: 1, newRevisions: 3, newTombstones: 1, newRecallEvents: 4,
    updatedRecallEvents: 0, malformedRows: [{file: 'devices/device-bbb/CURRENT', line: 1, error: 'integrity check failed'}]}}};

const settingsCtx = params => l2ctx(params, {sync: SYNC_STATUS(), operations: {items: []}}, {
  bootstrap: {uiVersion: '1.2.3', environment: ENV, db: {available: true, error: null},
    capabilities: {memory_jobs: true, recall_events: false}, commands: COMMANDS},
  savePrefs() {},
});

test('L2 · 관리 5탭이 en에서 한글 0건 · 미번역 키 0건으로 렌더된다', async () => {
  locale.useEn();
  for (const tab of ['runtime', 'actions', 'sync', 'interface', 'diagnostics']) {
    const {html} = await settingsPage.render(settingsCtx('tab=' + tab));
    assertEnglishOnly('settings:' + tab, html);
    assertNoRenderedKeys('settings:' + tab, html);
  }
  // 동기화 탭의 상태 조합은 render() 한 번으로 다 나오지 않는다 — 직접 그린다.
  const variants = [
    ['sync/off', settingsPage.syncTab(settingsCtx('tab=sync'), {sync: true}, SYNC_STATUS({enabled: false, deviceId: null, deviceAlias: null, peers: [], lastExport: null, dirExists: false, dirWritable: false}), null, null)],
    ['sync/noCore', settingsPage.syncTab(settingsCtx('tab=sync'), {sync: false}, null, null, null)],
    ['sync/error', settingsPage.syncTab(settingsCtx('tab=sync'), {sync: true}, null, 'permission denied', null)],
    ['sync/run', settingsPage.syncTab(settingsCtx('tab=sync'), {sync: true}, SYNC_STATUS(), null, RUN, ARCHIVE, PREVIEW)],
    ['sync/skipped', settingsPage.syncTab(settingsCtx('tab=sync'), {sync: true}, SYNC_STATUS(), null, {action: 'export', at: null, outcome: {skipped: 'unchanged', result: null, error: null}})],
    ['migration/cold', settingsPage.migrationCard(settingsCtx(''), ENV, {})],
    ['migration/warm', settingsPage.migrationCard(settingsCtx(''), ENV, {preview: {id: 'op-1', command: 'tiers-preview', status: 'completed', started_at: '2026-09-10T00:00:00.000Z', exit_code: 0}, apply: {started_at: '2026-09-10T04:00:00.000Z', status: 'completed'}, previewOutput: '2 fact(s) would move'})],
  ];
  for (const [label, html] of variants) {
    assertEnglishOnly('settings:' + label, html);
    assertNoRenderedKeys('settings:' + label, html);
  }
});

test('L2 · 관리 화면의 랜드마크 문구가 en 사전 값과 같다', async () => {
  locale.useEn();
  const runtime = (await settingsPage.render(settingsCtx('tab=runtime'))).html;
  for (const key of ['settings.page.title', 'settings.page.subtitle', 'settings.tabs.runtime', 'settings.tabs.sync',
    'settings.runtime.env.title', 'settings.runtime.boundary.title', 'settings.runtime.envVars.unset']) {
    assert.ok(runtime.includes(locale.en[key]), `runtime에 ${key} 값이 없다: ${locale.en[key]}`);
  }
  const actions = (await settingsPage.render(settingsCtx('tab=actions'))).html;
  assert.ok(actions.includes(locale.en['settings.actions.description.doctor']), '명령 설명이 사전에서 오지 않았다');
  assert.ok(actions.includes(locale.en['settings.actions.modelTag']));
  const diagnostics = (await settingsPage.render(settingsCtx('tab=diagnostics'))).html;
  assert.ok(diagnostics.includes(locale.en['settings.diagnostics.capabilities.present'])
    && diagnostics.includes(locale.en['settings.diagnostics.capabilities.missing']));
  const sync = settingsPage.syncTab(settingsCtx('tab=sync'), {sync: true}, SYNC_STATUS(), null, RUN, ARCHIVE, PREVIEW);
  assert.ok(sync.includes('memories 12 · revisions 4'), '내보낸 행 수 보간이 en 어순을 따르지 않았다');
  assert.ok(sync.includes('memories +5 / ~2 / -1'), '가져오기 요약 보간이 없다');
  assert.ok(sync.includes('memories +4 / ~2 / -1'), '미리보기 요약 보간이 없다');
  assert.ok(sync.includes('1 conflict') && !sync.includes('1 conflicts'), '충돌 수의 단수형이 쓰이지 않았다');
  assert.ok(sync.includes(locale.en['settings.sync.dirSource.configured']), '경로 출처가 사전에서 오지 않았다');
  assert.ok(sync.includes(locale.en['settings.sync.winner.peer']), '충돌 승자 라벨이 사전에서 오지 않았다');
});

test('L2 · 관리 화면은 en에서도 마크업 강조와 endonym을 유지한다', async () => {
  locale.useEn();
  const sync = settingsPage.syncTab(settingsCtx('tab=sync'), {sync: true}, SYNC_STATUS(), null, null, ARCHIVE, null);
  assert.match(sync, /<strong>plain-text JSONL<\/strong>/, 'tHtml의 <strong>이 이스케이프됐다');
  assert.match(sync, /<strong>⇧⌘G<\/strong>/, 'Finder 안내의 키 조합이 사라졌다');
  const missing = settingsPage.syncTab(settingsCtx('tab=sync'), {sync: false}, null, null, null);
  assert.match(missing, /<code>dist\/sync-control\.js<\/code>/, '<code>가 이스케이프됐다');
  // 언어 이름은 두 언어 모두에서 번역하지 않는다 — (10) 검사와 같은 계약을 en 쪽에서 한 번 더 본다.
  const display = (await settingsPage.render(settingsCtx('tab=interface'))).html;
  assert.ok(display.includes('English') && display.includes('한국어'), 'endonym이 사라졌다');
  assert.match(display, /data-endonym/);
});

// ═════════════════════════════════════════════════════════════════════════════
// i18n L1 — 셸 · 포맷터 · 배지 · 오류 표면 (#109 · 설계 §9.2)
//
// 페이지 섹션이 "화면 전체 한글 0건"을 미룬 이유(`ui.mjs`가 미이관)는 이 레인이 들어오면서
// 사라졌다. 그래서 여기서는 **잘라내기 없이** 한글 0건을 단정한다.
//
// app.mjs는 모듈 최상위에서 DOM을 만지므로 require할 수 없다 — 셸 문구의 실제 렌더는 e2e가
// 맡고(§9.4), 여기서는 app.mjs가 쓰는 사전 키가 전부 해소되는지를 소스에서 수확해 본다.
// ═════════════════════════════════════════════════════════════════════════════
const ui = require('../public/ui.mjs');
const {PREFIXES} = require('../public/i18n/registry.mjs');
const {TABLES} = require('../public/i18n/load.mjs');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const L1_NAMESPACES = ['common', 'shell', 'ui', 'errors'];
/** 셸 표면에서 텍스트로 새어 나온 키. 페이지 섹션의 LEAKED_KEY와 접두사가 다르다. */
const LEAKED_SHELL_KEY = /\b(?:shell|common|unit|action|tier|a11y|pagination|sync|event|error)\.[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+/;
const shellText = html => String(html).replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]*>/g, ' ');

const L1_FACT = {
  id: '11111111-2222-3333-4444-555555555555', fact: 'The release gate runs twice.',
  fact_kr: '릴리스 게이트는 두 번 돈다.', category: 'decision', is_active: 1,
  scope_type: 'project', scope_project: '/repo/memex', promotion_state: 'workstream',
  tier_reason: 'branch:feat/i18n',
};
const L1_EVENT = {
  event_kind: 'SYNC_IMPORTED', actor: 'sync', fact_id: L1_FACT.id,
  recorded_at: '2026-09-10T04:05:06.000Z', effective_at: '2026-09-09T04:05:06.000Z', projection_applied: 0,
  outcome_json: JSON.stringify({source_device_id: 'device-aaaaaaaa', generation: 'gen-bbbbbbbb', winner: 'peer', reason: 'peer-newer'}),
};

/** 한 번에 렌더해 두 언어에서 같은 단정을 돌린다. */
function shellSurfaces() {
  return {
    tierBadgeBranch: ui.tierBadge(L1_FACT, '/repo/memex'),
    tierBadgeGlobal: ui.tierBadge({...L1_FACT, scope_type: 'global'}, null),
    tierBadgeWorkspace: ui.tierBadge({...L1_FACT, promotion_state: 'workspace', tier_reason: null}, '/repo/memex'),
    tierBadgeProject: ui.tierBadge({...L1_FACT, promotion_state: 'project-current', tier_reason: null}, null),
    badge: ui.badge('dead') + ui.badge('no-match') + ui.badge('NOT_PROVEN') + ui.badge('SYNC_IMPORTED'),
    name: [ui.name(null), ui.name('project-current'), ui.name('capsule_update'), ui.name('not-an-enum')].join(' '),
    basename: ui.basename('') + ' ' + ui.basename('/repo/memex'),
    dates: [ui.date('2026-09-10T04:05:06.000Z'), ui.date(null), ui.relative(null)].join(' '),
    units: [ui.duration(null), ui.duration(400), ui.duration(4000), ui.duration(400000),
      ui.bytes(null), ui.bytes(12), ui.bytes(2048), ui.bytes(3 * 1024 ** 2)].join(' '),
    pagination: ui.pagination({total: 1, offset: 0, limit: 40}, {}) + ui.pagination({total: 4210, offset: 40, limit: 40}, {}),
    eventRow: ui.eventRow(L1_EVENT),
    syncOriginTag: ui.syncOriginTag(L1_EVENT),
    errorCard: ui.errorCard({code: 'DB_INDEX_MISSING', key: 'error.db.indexMissing', message: 'Index database is missing.'}),
    errorCardFromCore: ui.errorCard({code: 'DB_UNAVAILABLE', key: null, message: 'SQLITE_CANTOPEN: unable to open database file'}),
    renderIssues: ui.renderIssues([{key: 'error.issue.warning', severity: 'warning', path: 'patterns.add[2].source'}]),
    factLink: ui.factLink(L1_FACT),
    searchField: ui.searchField(),
    raw: ui.raw({a: 1}),
    markdown: ui.markdown('**bold** and `code`'),
  };
}

test('L1 en 셸 표면에 한글이 0건이고 미번역 키가 노출되지 않는다', () => {
  locale.useEn();
  ui.setPreferTranslatedFacts(false);
  const surfaces = shellSurfaces();
  for (const [label, html] of Object.entries(surfaces)) {
    assert.equal(HANGUL.test(html), false, `${label}: en 렌더에 한글이 남았습니다 — ${html}`);
    const leak = shellText(html).match(LEAKED_SHELL_KEY);
    assert.equal(leak, null, `${label}: 미번역 키가 노출됐습니다 — ${leak && leak[0]}`);
  }
  // 랜드마크가 사전 값과 정확히 일치한다 — 사전을 실제로 읽고 있다는 증거.
  assert.ok(surfaces.tierBadgeGlobal.includes(locale.en['tier.global.label']));
  assert.ok(surfaces.tierBadgeBranch.includes('Branch: feat/i18n'), '브랜치 이름 보간이 깨졌습니다');
  assert.ok(surfaces.badge.includes(locale.en['badge.dead.label']));
  assert.equal(ui.name(null), locale.en['common.unknown']);
  assert.equal(ui.name('not-an-enum'), 'not-an-enum', '모르는 값의 이름을 지어내면 안 된다');
  assert.equal(ui.basename(''), locale.en['common.commonMemory']);
  // en 복수형과 천 단위 구분 — Intl을 실제로 통과했는지.
  assert.ok(surfaces.pagination.includes('1 row') && surfaces.pagination.includes('4,210 rows'),
    '영어 복수형·천 단위 구분이 적용되지 않았습니다: ' + surfaces.pagination);
  assert.ok(surfaces.units.includes('6m 40s') && surfaces.units.includes('3.0 MB'), surfaces.units);
  assert.ok(surfaces.errorCard.includes(locale.en['error.card.title']));
  // key===null일 때만 "코어가 보고한 내용" 캡션이 붙는다.
  assert.ok(surfaces.errorCardFromCore.includes(locale.en['error.fromCore']), '코어 원문 캡션이 없습니다');
  assert.ok(!surfaces.errorCard.includes(locale.en['error.fromCore']), '분류된 오류에 코어 캡션이 붙었습니다');
  // §14.5 — en 화면·스크린샷에 저장된 한국어 번역이 새어 나오지 않는다.
  assert.ok(surfaces.factLink.includes(L1_FACT.fact) && !surfaces.factLink.includes(L1_FACT.fact_kr),
    'en에서 fact_kr가 우선됐습니다');
});

test('L1 ko 셸 표면은 0.6.x 문구를 유지하고 fact_kr를 우선한다', () => {
  locale.useKo();
  ui.setPreferTranslatedFacts(true);
  const surfaces = shellSurfaces();
  for (const [label, html] of Object.entries(surfaces)) {
    const leak = shellText(html).match(LEAKED_SHELL_KEY);
    assert.equal(leak, null, `${label}: ko 렌더에 미번역 키가 노출됐습니다 — ${leak && leak[0]}`);
  }
  assert.ok(surfaces.factLink.includes(L1_FACT.fact_kr), 'ko에서 fact_kr가 우선되지 않았습니다');
  assert.ok(surfaces.pagination.includes('총 4,210개'), '페이지네이션 문구가 바뀌었습니다: ' + surfaces.pagination);
  assert.ok(surfaces.tierBadgeProject.includes('프로젝트 공용'));
  assert.ok(surfaces.errorCardFromCore.includes(locale.ko['error.fromCore']));
  ui.setPreferTranslatedFacts(null);
});

test('L1 사전의 en 쪽에 한글이 없고 키가 접두사 규율을 지킨다', () => {
  const leaks = [], prefixes = [];
  for (const ns of L1_NAMESPACES) {
    for (const [key, value] of Object.entries(TABLES.en[ns])) if (HANGUL.test(value)) leaks.push(`${ns}/${key}: ${value}`);
    for (const tag of ['en', 'ko']) {
      for (const key of Object.keys(TABLES[tag][ns])) {
        if (!PREFIXES[ns].some(p => key.startsWith(p))) prefixes.push(`${tag}/${ns}: ${key}`);
      }
    }
  }
  assert.deepEqual(leaks, [], 'en 사전에 한글이 남아 있습니다');
  assert.deepEqual(prefixes, [], '네임스페이스 접두사 규율을 어긴 키가 있습니다');
});

test('L1 app.mjs·index.html이 쓰는 셸 키가 양쪽 사전에서 해소된다', () => {
  // app.mjs는 DOM 없이 require할 수 없으므로 소스에서 키를 수확해 대조한다.
  const {used} = extract.harvestKeys(['ui/public/app.mjs']);
  const shellKeys = [...used.keys()].filter(key => key.startsWith('shell.'));
  assert.ok(shellKeys.length > 30, 'app.mjs의 shell 키 수집 실패: ' + shellKeys.length);
  for (const [key, where] of used) {
    assert.ok(key in locale.en, `en 사전에 없는 키: ${key} (${where[0]})`);
    assert.ok(key in locale.ko, `ko 사전에 없는 키: ${key} (${where[0]})`);
  }
  // 부팅 셸은 index.html의 data-i18n에 있고 app.mjs가 DOM에서 읽어 t()에 넘긴다.
  for (const [key] of extract.harvestHtmlKeys()) {
    assert.ok(key in locale.en && key in locale.ko, '부팅 셸 키가 사전에 없습니다: ' + key);
  }
  // 서버가 치환하는 토큰 2개는 en 원문이어야 한다 — localizeHtml()이 정확 일치 리터럴로 바꾼다.
  const html = nodeFs.readFileSync(nodePath.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('<html lang="en" data-lang="en"'));
  assert.ok(html.includes('<meta name="memex-ui-lang" content="en">'));
  assert.equal(HANGUL.test(html), false, 'index.html에 한글이 남아 있습니다');
});

// ═════════════════════════════════════════════════════════════════════════════
// 페이로드 프로즈 소비 지점 — 서버가 키만 실을 때 화면이 문장을 만든다 (#109 · 설계 §5.3 분류 c)
//
// L1이 서버에서 한국어 프로즈를 걷어내고 `<field>Key`(+`<field>Params`)만 싣도록 바꿨다.
// 다른 레인이 소유한 소비 지점은 `payloadText()`/`t()`로 읽지 않으면 **빈 칸**이 된다 —
// 빈 칸은 키 누출 검사에도, 한글 잔존 검사에도 걸리지 않으므로 여기서 따로 못질한다.
//
// 단정은 두 갈래다:
//   (a) **키만 실린** 페이로드가 en/ko에서 각 사전 문장으로 렌더된다.
//   (b) **원문이 실린** 페이로드는 원문이 이긴다(사용자·코어가 만든 값) — 두 언어 모두.
// ═════════════════════════════════════════════════════════════════════════════
const {COMMANDS: SERVER_COMMANDS} = require('../lib/operations.cjs');

/** raw() JSON 덤프와 태그·속성을 걷어낸 "화면에 보이는 글자". */
const visibleOf = html => String(html)
  .replace(/<details class="json-details">[\s\S]*?<\/details>/g, '')
  .replace(/<[^>]*>/g, ' ');

/** 사전 키가 문장 자리에 그대로 나오면 소비 지점이 payloadText()/t()를 안 쓴 것이다. */
const PAYLOAD_KEYS = ['label.session.untitled', 'state.schema.tableAbsent', 'state.fact.sourceUnavailable',
  'note.job.relatedFactsBasis', 'op.doctor.label', 'op.recover.label', 'op.recover.note', 'op.output.lostAcrossRestart'];
function assertNoPayloadKeys(label, html) {
  const text = visibleOf(html);
  for (const key of PAYLOAD_KEYS) assert.ok(!text.includes(key), `${label}: 페이로드 키가 화면에 렌더됐다 — ${key}`);
}

// 제목이 없는 세션: 서버는 `title:null` + `titleKey`만 싣는다(store.cjs sessions()).
const UNTITLED_SESSION = {session_id: 'session-key', project: '/workspace/memex', exchanges: 1, branch: 'main',
  started_at: '2026-09-01T00:00:00.000Z', ended_at: '2026-09-01T01:00:00.000Z',
  title: null, titleKey: 'label.session.untitled', extraction: null};
const TITLED_SESSION = {...UNTITLED_SESSION, session_id: 'session-text', title: 'Where does data live?'};
const SESSIONS_PAGE = {available: true, items: [UNTITLED_SESSION, TITLED_SESSION], total: 2, limit: 30, offset: 0, engine: 'fts'};

test('payload: 제목 없는 세션은 목록·개요에서 사전 문구로 채워진다', async () => {
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    const list = (await conversations.render(ctx('', {sessions: SESSIONS_PAGE}))).html;
    assert.ok(list.includes(dict['label.session.untitled']), `${tag} conversations: 대체 제목이 없다`);
    assert.ok(!list.includes('<h3></h3>'), `${tag} conversations: 제목이 빈 칸으로 렌더됐다`);
    assert.ok(list.includes('Where does data live?'), `${tag} conversations: 원문 제목이 사라졌다`);
    assertNoPayloadKeys(`${tag} conversations`, list);

    const over = (await overview.render(ctx('', {overview: {...OVERVIEW, sessionsRecent: [UNTITLED_SESSION, TITLED_SESSION]}, pipeline: PIPELINE}))).html;
    assert.ok(over.includes(dict['label.session.untitled']), `${tag} overview: 대체 제목이 없다`);
    assert.ok(!over.includes('<p class="title"></p>'), `${tag} overview: 제목이 빈 칸으로 렌더됐다`);
    assert.ok(over.includes('Where does data live?'), `${tag} overview: 원문 제목이 사라졌다`);
    assertNoPayloadKeys(`${tag} overview`, over);
  }
  // 두 언어가 실제로 다른 문장을 낸다 — 한쪽 사전만 읽고 있지 않다는 증거.
  assert.notEqual(locale.en['label.session.untitled'], locale.ko['label.session.untitled']);
});

test('payload: 상세 패널의 근거 주의·원문 없음 사유가 키에서 온다', async () => {
  const keyOnlyFact = {...L2_FACT, sources: [{exchange_id: 'x-2', timestamp: '2026-09-01T01:00:00.000Z',
    unavailable: true, reason: null, reasonKey: 'state.fact.sourceUnavailable'}]};
  const keyOnlyJob = {...JOB, relatedFactsBasis: null, relatedFactsBasisKey: 'note.job.relatedFactsBasis'};
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    const evidence = (await details.renderDetail(l2ctx('panelTab=evidence', {fact: keyOnlyFact}), 'fact', keyOnlyFact.id)).html;
    assert.ok(visibleOf(evidence).includes(dict['state.fact.sourceUnavailable']), `${tag} evidence: 원문 없음 사유가 비었다`);
    assertNoPayloadKeys(`${tag} evidence`, evidence);
    // 코어가 실제 사유를 실어 보내면 그 원문이 이긴다.
    const prose = (await details.renderDetail(l2ctx('panelTab=evidence', {fact: L2_FACT}), 'fact', L2_FACT.id)).html;
    assert.ok(visibleOf(prose).includes('transcript pruned'), `${tag} evidence: 서버 원문 사유가 사라졌다`);

    const job = (await details.renderDetail(l2ctx('', {job: keyOnlyJob}), 'job', 'job-1')).html;
    assert.ok(visibleOf(job).includes(dict['note.job.relatedFactsBasis']), `${tag} job: 관련 기억 근거 주의가 비었다`);
    assertNoPayloadKeys(`${tag} job`, job);
    const jobProse = (await details.renderDetail(l2ctx('', {job: JOB}), 'job', 'job-1')).html;
    assert.ok(jobProse.includes('Same transcript as evidence'), `${tag} job: 서버 원문 근거가 사라졌다`);
  }
});

test('payload: 관리 실행 상세의 명령 라벨은 사전 우선 · 저장된 label 차선이다', async () => {
  const fresh = {...OPERATION, label: undefined, command: 'doctor', status: 'completed', finished_at: '2026-09-01T00:01:00.000Z'};
  const legacy = {...fresh, label: 'Run doctor'};                     // 0.6.x가 영속화한 라벨
  const retired = {...fresh, command: 'retired-command', label: 'Stored legacy label'};
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    const html = (await details.renderDetail(l2ctx('', {operation: fresh}), 'operation', 'op-1')).html;
    assert.ok(html.includes(dict['op.doctor.label']), `${tag} operation: 명령 라벨이 비었다`);
    assertNoPayloadKeys(`${tag} operation`, html);
    // 사전이 이긴다 — 읽는 시점의 언어가 적용돼야 한다(operations.cjs COMMANDS 주석).
    const old = (await details.renderDetail(l2ctx('', {operation: legacy}), 'operation', 'op-1')).html;
    assert.ok(old.includes(dict['op.doctor.label']) && !old.includes('Run doctor'), `${tag} operation: 저장된 라벨이 사전을 덮었다`);
    // 카탈로그에서 사라진 명령은 저장된 라벨로 떨어진다 — 빈 칸보다 낫다.
    const gone = (await details.renderDetail(l2ctx('', {operation: retired}), 'operation', 'op-1')).html;
    assert.ok(gone.includes('Stored legacy label'), `${tag} operation: 레거시 라벨 폴백이 없다`);
  }
});

test('payload: 명령 확인 모달의 제목·주의가 labelKey/noteKey에서 온다', () => {
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    const opened = [];
    const mctx = l2ctx('', {}, {bootstrap: {environment: ENV, commands: SERVER_COMMANDS},
      modal: (title, body) => opened.push({title, body})});
    details.commandModal(mctx, 'recover');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].title, dict['op.recover.label'], `${tag} modal: 제목이 사전에서 오지 않았다`);
    assert.ok(opened[0].body.includes(dict['op.recover.note']), `${tag} modal: noteKey 주의가 비었다`);
    assertNoPayloadKeys(`${tag} modal`, opened[0].body);
    // note가 없는 명령은 주의 단락 자체를 만들지 않는다.
    const plain = [];
    const pctx = l2ctx('', {}, {bootstrap: {environment: ENV, commands: SERVER_COMMANDS}, modal: (title, body) => plain.push({title, body})});
    details.commandModal(pctx, 'doctor');
    assert.equal(plain[0].title, dict['op.doctor.label']);
    assert.ok(!plain[0].body.includes('<p class="caption mb">'), `${tag} modal: 빈 주의 단락이 생겼다`);
  }
});

test('payload: 관리 작업 카드 라벨과 잃은 출력 안내가 키에서 온다', async () => {
  const serverCtx = () => l2ctx('tab=actions', {sync: SYNC_STATUS(), operations: {items: []}}, {
    bootstrap: {uiVersion: '1.2.3', environment: ENV, db: {available: true, error: null},
      capabilities: {memory_jobs: true, recall_events: false}, commands: SERVER_COMMANDS},
    savePrefs() {},
  });
  // 재기동으로 출력을 잃은 실행: operations.cjs가 output:''·outputLost:true만 남긴다.
  const lost = {preview: {id: 'op-1', command: 'tiers-preview', status: 'unknown',
    started_at: '2026-09-10T00:00:00.000Z', exit_code: null, output: '', outputLost: true}};
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    const actions = (await settingsPage.render(serverCtx())).html;
    for (const key of ['op.doctor.label', 'op.recover.label']) {
      assert.ok(actions.includes(dict[key]), `${tag} settings/actions: ${key} 값이 카드에 없다`);
    }
    assert.ok(!actions.includes('<h2></h2>'), `${tag} settings/actions: 카드 제목이 빈 칸이다`);
    // group 명령은 전용 카드가 그리므로 일반 격자에 섞이지 않는다.
    assert.ok(!actions.includes(dict['op.tiers-apply.label']), `${tag} settings/actions: group 명령이 격자에 섞였다`);
    assertNoPayloadKeys(`${tag} settings/actions`, actions);

    const card = settingsPage.migrationCard(serverCtx(), ENV, lost);
    assert.ok(card.includes(dict['op.output.lostAcrossRestart']), `${tag} settings/migration: 잃은 출력 안내가 없다`);
    assert.ok(!card.includes(dict['settings.migration.noOutput']), `${tag} settings/migration: "출력 없음"으로 잘못 말했다`);
    assertNoPayloadKeys(`${tag} settings/migration`, card);
  }
  locale.useEn();
  assertEnglishOnly('settings:payload/actions', (await settingsPage.render(serverCtx())).html);
  assertEnglishOnly('settings:payload/migration', settingsPage.migrationCard(serverCtx(), ENV, lost));
});

test('payload: 표가 없는 탭의 사용 불가 사유는 표 이름을 지키고 번역된다', async () => {
  const missing = {available: false, items: [], total: null, limit: 50, offset: 0,
    reasonKey: 'state.schema.tableAbsent', reasonParams: {table: 'memory_jobs'}};
  const prose = {available: false, items: [], total: null, limit: 50, offset: 0, reason: 'core reported a closed database'};
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    const html = (await activity.render(ctx('tab=jobs', {jobs: missing}))).html;
    const expected = dict['state.schema.tableAbsent'].replace('{table}', 'memory_jobs');
    assert.ok(html.includes(expected), `${tag} activity: 표 이름이 들어간 사유가 없다 — ${expected}`);
    assert.ok(html.includes('memory_jobs'), `${tag} activity: 표 이름이 사라졌다`);
    assert.ok(!html.includes(dict['activity.unavailable.body']), `${tag} activity: 구체적 사유가 일반 문구로 덮였다`);
    assertNoPayloadKeys(`${tag} activity`, html);
    // 코어 원문 사유가 실려 오면 그대로 보여준다.
    const fromCore = (await activity.render(ctx('tab=jobs', {jobs: prose}))).html;
    assert.ok(fromCore.includes('core reported a closed database'), `${tag} activity: 서버 원문 사유가 사라졌다`);
  }
});

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ E · 관리 › 모델 (pages/model.mjs · namespace `models`) — #31 lane E       │
// ╰──────────────────────────────────────────────────────────────────────────╯
//
// 독립 섹션이다: 자기 로케일을 직접 꽂고, 자기 fixture만 쓰고, 위 섹션을 수정하지 않는다.
// 단정 3개 — (a) `models.*` 키가 화면 문구로 새지 않는다, (b) en 랜드마크가 사전 값과 같다,
// (c) ko에서 같은 화면이 한국어 사전 값으로 나온다. 상태(보류·대기 작업·환경 고정·capability
// 없음·카탈로그 없음)는 render() 한 번으로 다 나오지 않으므로 modelTab()을 직접 그린다.
const modelPage = require('../public/pages/model.mjs');

/** 점이 2개 이상인 `models.` 토큰 = 렌더된 사전 키. `models.json`(1개)은 화면 문구다. */
const MODEL_KEYISH = /\bmodels(?:\.[a-zA-Z0-9]+){2,}\b/g;
function assertNoModelKeys(label, html) {
  const text = html.replace(/<[^>]*>/g, ' ');
  const leaked = [...new Set([...text.matchAll(MODEL_KEYISH)].map(m => m[0]))];
  assert.deepEqual(leaked, [], `${label}: 미번역 키가 화면에 렌더됐다`);
}

const MODEL_STATUS = (llm = {}, extra = {}) => ({
  settingsPath: '/home/me/models.json', fileExists: true, version: 1, updatedAt: '2026-09-10T00:00:00.000Z',
  llm: {
    effective: {model: {value: 'gpt-6-astra', source: 'file'}, reasoning: {value: 'high', source: 'file'}},
    saved: {model: 'gpt-6-astra', reasoning: 'high'},
    defaults: {model: 'gpt-5.6-luna', reasoning: null},
    allowedReasoning: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    catalogReasoning: ['low', 'medium', 'high'],
    catalog: {source: 'models_cache', path: '/codex/models_cache.json', fetchedAt: '2026-09-09T00:00:00.000Z',
      codexHome: '/codex', models: [
        {slug: 'gpt-6-astra', displayName: 'GPT-6-Astra', visible: true, defaultReasoning: 'low', reasoningEfforts: ['low', 'medium', 'high']},
        {slug: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', visible: true, defaultReasoning: null, reasoningEfforts: ['low', 'high']},
        {slug: 'gpt-reserve', displayName: 'Reserve', visible: false, defaultReasoning: null, reasoningEfforts: ['low']}]},
    fingerprint: 'abcdef0123456789',
    hold: null, holds: [], heldJobs: [],
    lastProbe: {ok: true, at: '2026-09-10T02:00:00.000Z', latencyMs: 1234, model: 'gpt-6-astra', reasoning: 'high', errorClass: null},
    ...llm,
  },
  embedding: {readOnly: true, model: 'Xenova/multilingual-e5-small', source: 'default',
    cache: {present: true, files: 4, bytes: 2048, modelDir: '/home/me/models/Xenova/multilingual-e5-small', stub: false}},
  env: {MEMEX_CODEX_MODEL: null, MEMEX_CODEX_REASONING: null, MEMEX_EMBEDDING_MODEL: null, MEMEX_EMBEDDING_DIMS: null},
  db: {path: '/home/me/db.sqlite', exists: true},
  ...extra,
});
const HOLD = {fingerprint: 'abcdef0123456789', heldAt: '2026-09-10T01:00:00.000Z', model: 'gpt-6-astraX',
  reasoningEffort: 'max', status: 400, providerType: 'invalid_request_error',
  providerMessage: "The 'gpt-6-astraX' model is not supported when using Codex with a ChatGPT account.",
  observedCount: 3, lastObservedAt: '2026-09-10T02:00:00.000Z', current: true};
const MODEL_ENV = {...ENV, models: true};
/** 이 탭이 그리는 모든 상태. 한 번에 다 보이지 않으므로 조합마다 이름을 붙인다. */
const modelVariants = () => [
  ['models/normal', modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS(), null)],
  ['models/held', modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({
    hold: HOLD, holds: [HOLD, {...HOLD, fingerprint: 'other', current: false}],
    heldJobs: [{reason: 'model_config_rejected', jobs: 2, oldestHeldAt: '2026-09-10T01:00:00.000Z'}],
    lastProbe: {ok: false, at: '2026-09-10T02:00:00.000Z', latencyMs: 900, model: 'gpt-6-astraX', reasoning: 'max', errorClass: 'config'},
  }), null)],
  ['models/envPinned', modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({
    effective: {model: {value: 'env-model', source: 'env'}, reasoning: {value: null, source: 'env'}},
  }, {env: {MEMEX_CODEX_MODEL: 'env-model', MEMEX_CODEX_REASONING: 'low', MEMEX_EMBEDDING_MODEL: null, MEMEX_EMBEDDING_DIMS: null}}), null)],
  ['models/noCatalog', modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({
    catalogReasoning: null, saved: {model: null, reasoning: null},
    catalog: {source: 'none', path: null, fetchedAt: null, codexHome: '/codex', models: []},
    lastProbe: null,
  }, {fileExists: false, updatedAt: null}), null)],
  ['models/stubCache', modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({}, {
    embedding: {readOnly: true, model: 'Xenova/multilingual-e5-small', source: 'env',
      cache: {present: false, files: 0, bytes: 0, modelDir: '/home/me/models/x', stub: true}},
  }), null)],
  ['models/absentCache', modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({}, {
    embedding: {readOnly: true, model: 'Xenova/multilingual-e5-small', source: 'default',
      cache: {present: false, files: 0, bytes: 0, modelDir: '/home/me/models/x', stub: false}},
  }), null)],
  ['models/noCapability', modelPage.modelTab(l2ctx('tab=models'), {...ENV, models: false}, null, null)],
  ['models/readFailed', modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, null, 'EACCES: permission denied')],
];

test('E en: 모델 탭의 모든 상태가 en으로 렌더되고 한글·키 누출이 없다', () => {
  locale.useEn();
  for (const [label, html] of modelVariants()) {
    assertEnglishOnly(label, html);
    assertNoModelKeys(label, html);
  }
});

test('E en: 두 셀렉트가 카탈로그에서 채워지고 현재 값이 사라지지 않는다', () => {
  locale.useEn();
  const html = modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS(), null);
  assert.match(html, /<select name="model"/);
  assert.match(html, /<select name="reasoning"/);
  assert.match(html, /<option value="gpt-6-astra" selected>/, '현재 모델이 선택돼 있다');
  assert.match(html, /<option value="gpt-5.6-luna" /);
  assert.ok(!html.includes('value="gpt-reserve"'), '숨은 카탈로그 항목은 목록에 넣지 않는다');
  assert.match(html, /<option value="high" selected>/, '현재 강도가 선택돼 있다');
  assert.ok(html.includes(locale.en['models.reasoning.unsetOption']), '플래그 해제 선택지가 있다');
  assert.ok(!html.includes('value="ultra"'), '카탈로그가 말한 강도만 제시한다');
  // 카탈로그에 없는 현재 값도 항상 한 항목으로 들어간다 — 그러지 않으면 선택이 사라진다.
  const unknown = modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({
    effective: {model: {value: 'totally-bogus-model-xyz', source: 'file'}, reasoning: {value: 'ultra', source: 'file'}},
  }), null);
  assert.match(unknown, /<option value="totally-bogus-model-xyz" selected>/);
  assert.match(unknown, /<option value="ultra" selected>/);
  // 카탈로그 밖 강도는 거절이 아니라 경고다(§3.3 규칙 2).
  assert.ok(unknown.includes('Saved anyway'), '지원 목록 밖 강도에 경고가 붙는다');
});

test('E en: 랜드마크 문구가 en 사전 값과 같다', () => {
  locale.useEn();
  const html = modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({
    hold: HOLD, heldJobs: [{reason: 'model_config_rejected', jobs: 2, oldestHeldAt: '2026-09-10T01:00:00.000Z'}],
  }), null);
  for (const key of ['models.llm.title', 'models.llm.row.model', 'models.llm.row.reasoning', 'models.llm.save',
    'models.llm.test', 'models.llm.reset', 'models.row.effectiveModel', 'models.row.lastTest',
    'models.hold.title', 'models.hold.noDamage', 'models.held.title', 'models.embedding.title',
    'models.embedding.readOnly', 'models.source.file']) {
    assert.ok(html.includes(locale.en[key]), `${key} 값이 화면에 없다: ${locale.en[key]}`);
  }
  // 보류 배지는 lane-0의 공용 키를 쓴다 — 두 문서가 같은 배지를 공유한다(decisions-v3 H2).
  assert.ok(html.includes(locale.en['common.job.hold.model_config_rejected']));
  // 제공자 원문은 번역하지 않고 그대로 보여준다.
  assert.ok(html.includes('The &#39;gpt-6-astraX&#39; model is not supported'), '제공자 문장이 원문으로 실린다');
  assert.match(html, /<strong>local to this machine<\/strong>/, 'tHtml의 강조가 이스케이프됐다');
});

test('E en: 환경 변수로 고정된 값은 비활성 컨트롤로 정직하게 보인다', () => {
  locale.useEn();
  const [, pinned] = modelVariants().find(([label]) => label === 'models/envPinned');
  assert.match(pinned, /<select name="model" [^>]*disabled>/);
  assert.match(pinned, /<select name="reasoning" [^>]*disabled>/);
  assert.ok(pinned.includes(locale.en['models.envPinned']), '고정 태그가 없다');
  assert.ok(pinned.includes('MEMEX_CODEX_MODEL=env-model'), '어떤 변수가 이기는지 말해야 한다');
  assert.ok(pinned.includes(locale.en['models.saveDisabledByEnv']));
  assert.match(pinned, /type="submit" disabled/, '저장할 것이 없으면 버튼도 비활성이다');
  // capability가 없으면 탭을 비우지 않고 이유를 말한다.
  const [, missing] = modelVariants().find(([label]) => label === 'models/noCapability');
  assert.match(missing, /<div class="banner error">/);
  assert.match(missing, /<code>dist\/model-settings\.js<\/code>/);
  const [, failed] = modelVariants().find(([label]) => label === 'models/readFailed');
  assert.ok(failed.includes('EACCES: permission denied'), '조회 실패 사유를 그대로 싣는다');
});

test('E: 탭 레지스트리가 모델 탭을 그리고, 조회 실패도 화면으로 설명한다', async () => {
  locale.useEn();
  const ctx = l2ctx('tab=models', {operations: {items: []}}, {
    bootstrap: {uiVersion: '1.2.3', environment: MODEL_ENV, db: {available: true, error: null},
      capabilities: {}, commands: COMMANDS},
    savePrefs() {},
  });
  const {html} = await settingsPage.render(ctx);
  assert.ok(html.includes(locale.en['settings.tabs.models']), '탭 레이블은 lane-0의 settings 사전에서 온다');
  assert.match(html, /class="tab active" href="[^"]*tab=models"/, '모델 탭이 활성 탭이다');
  // l2ctx는 등록하지 않은 api 호출에 throw한다 — 그 사유가 화면에 남아야 한다.
  assert.match(html, /<div class="banner error">/);
  assert.ok(html.includes('unexpected api call: models'));
  const served = l2ctx('tab=models', {models: MODEL_STATUS(), operations: {items: []}}, {
    bootstrap: {uiVersion: '1.2.3', environment: MODEL_ENV, db: {available: true, error: null},
      capabilities: {}, commands: COMMANDS},
    savePrefs() {},
  });
  const ok = await settingsPage.render(served);
  assert.ok(ok.html.includes(locale.en['models.llm.title']), '레지스트리 render가 본문을 그린다');
  assertNoModelKeys('settings:tab=models', ok.html);
});

test('E ko: 같은 상태가 ko 사전 값으로 렌더된다', () => {
  locale.useKo();
  for (const [label, html] of modelVariants()) assertNoModelKeys(label, html);
  const html = modelPage.modelTab(l2ctx('tab=models'), MODEL_ENV, MODEL_STATUS({
    hold: HOLD, heldJobs: [{reason: 'model_config_rejected', jobs: 2, oldestHeldAt: '2026-09-10T01:00:00.000Z'}],
  }), null);
  for (const key of ['models.llm.title', 'models.llm.test', 'models.hold.title', 'models.held.title',
    'models.embedding.title', 'models.row.effectiveModel', 'common.job.hold.model_config_rejected']) {
    assert.ok(html.includes(locale.ko[key]), `${key} 의 ko 값이 화면에 없다: ${locale.ko[key]}`);
  }
  assert.ok(!html.includes(locale.en['models.llm.title']), 'ko 화면에 en 문구가 섞였다');
  assert.match(html, /<strong>이 기기 전용<\/strong>/, 'ko tHtml의 강조가 이스케이프됐다');
});

test('E: 경고 코드는 사전 문장으로 바뀌고, 모르는 코드는 코드 그대로 보인다', () => {
  locale.useEn();
  const lines = modelPage.warningLines([
    {code: 'MODEL_NOT_IN_CATALOG', params: {model: 'x', path: '/codex/catalog.json'}},
    {code: 'REASONING_UNSUPPORTED', params: {model: 'x', levels: 'low / high'}},
    {code: 'ENV_OVERRIDES_MODEL', params: {name: 'MEMEX_CODEX_MODEL', value: 'y', model: 'x'}},
    {code: 'HOLD_CLEARED', params: {holds: 1, jobs: 2}},
    {code: 'SOMETHING_NEW_FROM_A_LATER_RELEASE'},
  ]);
  assert.equal(lines.length, 5);
  assert.ok(lines[0].includes('/codex/catalog.json'));
  assert.ok(lines[1].includes('low / high'));
  assert.ok(lines[2].includes('MEMEX_CODEX_MODEL'));
  assert.ok(lines[3].includes('1') && lines[3].includes('2'));
  assert.equal(lines[4], 'SOMETHING_NEW_FROM_A_LATER_RELEASE', '모르는 코드를 빈 문장으로 숨기지 않는다');
  assert.deepEqual(modelPage.warningLines(undefined), []);
});

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ F · 관리 › 오버레이 (pages/settings-overlays.mjs · namespace `overlays`)  │
// │     — #29 회수 게이트 정규식 · #30 추출 규칙                              │
// ╰──────────────────────────────────────────────────────────────────────────╯
//
// 독립 섹션이다: 자기 로케일을 직접 꽂고, 자기 fixture만 쓰고, 위 섹션을 수정하지 않는다.
// 단정 4개 — (a) `overlays.*` 키가 화면 문구로 새지 않는다, (b) en 랜드마크가 사전 값과 같다,
// (c) ko에서 같은 화면이 한국어 사전 값으로 나온다, (d) 이 기능의 **정직함**을 문장으로 고정한다:
// 0.7.1 공유 연기 공지(R16), 격리 배너, 설정 대기 배너(lane-0의 `common.job.hold.*`), 모델 전용
// 규칙의 "로컬에서 판정 불가" 문구, 재추출 apply 버튼 없음.
const overlayPage = require('../public/pages/settings-overlays.mjs');

/** 점이 2개 이상인 `overlays.` 토큰 = 렌더된 사전 키. */
const OVERLAY_KEYISH = /\boverlays(?:\.[a-zA-Z0-9]+){2,}\b/g;
function assertNoOverlayKeys(label, html) {
  const text = html.replace(/<[^>]*>/g, ' ');
  const leaked = [...new Set([...text.matchAll(OVERLAY_KEYISH)].map(m => m[0]))];
  assert.deepEqual(leaked, [], `${label}: 미번역 키가 화면에 렌더됐다`);
}

const BUILTIN_PATTERN = {id: 'memory.en.why', intent: 'memory', source: '\\bwhy\\b', flags: 'i', form: 'alternative'};
const USER_PATTERN = {id: 'user.3f9a1c22', intent: 'memory', source: 'deploy\\s*history', flags: 'i',
  note: 'release questions', created_at: '2026-09-10T00:00:00.000Z'};
const QUARANTINE_ROW = {overlay: 'recall-gate', pattern_id: 'user.3f9a1c22', source_sha8: '9b2c1de0',
  at: '2026-09-10T12:31:02.400Z', elapsed_ms: 50, input_chars: 812, surface: 'daemon'};
const HISTORY_ROW = {ts: '2026-09-10T12:03:41.118Z', surface: 'web-ui', overlay: 'recall-gate',
  action: 'gate.pattern-add', from_revision: 7, to_revision: 8, from_hash: 'gate:1111aaaa',
  to_hash: 'gate:3f9a1c22', added: ['user.3f9a1c22']};
const RULES_DOC = {
  schema: 'memex.extraction-rules-overlay', version: 1, revision: 3,
  updated_at: '2026-09-10T12:10:00.000Z', updated_by: {surface: 'web-ui'},
  preferred_language: 'ko', exclude_topics: ['salary review'],
  never_extract_patterns: [{id: 'user.9c1e4d07', source: '\\bsk-[A-Za-z0-9_-]{16,}', flags: '', scope: 'both', note: 'api key shape'}],
  always_treat_as_decision_patterns: [{id: 'user.aa11bb22', source: '(final decision)', flags: 'i'}],
  project_overrides: {'project-atlas': {preferred_language: 'en'}},
};
const OVERLAY_STATUS = (gate = {}, rules = {}, extra = {}) => ({
  available: true, shared: false, disabledByEnv: false,
  limits: {fileBytes: 32768, patternSource: 200, quantifiers: 8, noteChars: 200, matchWallMs: 50, probeWallMs: 300,
    counts: {patternsAdd: 64}, rules: {fileBytes: 32768}, inputChars: 8000, historySnapshots: 20},
  paths: {dir: '/home/me/overlays', gate: '/home/me/overlays/recall-gate.json', history: '/home/me/overlays/history.jsonl'},
  gate: {
    present: true, revision: 8, hash: 'gate:3f9a1c22', updatedAt: '2026-09-10T12:03:41.118Z', updatedBy: 'web-ui',
    builtin: {patterns: [BUILTIN_PATTERN, {id: 'ack.en.1', intent: 'acknowledgement', source: '^(ok|okay)$', flags: 'i', form: 'whole'}],
      words: {ack: ['ok', 'sure'], continue: ['go on'], filler: ['well']}},
    user: {patterns: [USER_PATTERN], disabled: ['ack.en.1'],
      words: {add: {ack: ['ack'], continue: [], filler: []}, disable: {ack: ['sure'], continue: [], filler: []}}},
    quarantined: [], issues: [], history: [HISTORY_ROW], snapshots: [8],
    ...gate,
  },
  rules: {
    present: true, revision: 3, hash: 'rules:9c1e4d07', updatedAt: '2026-09-10T12:10:00.000Z', updatedBy: 'web-ui',
    schema: 'memex.extraction-rules-overlay', version: 1, doc: RULES_DOC,
    emptyDoc: {schema: 'memex.extraction-rules-overlay', version: 1, revision: 0},
    resolved: {preferredLanguage: 'ko', excludeTopics: ['salary review'],
      neverExtract: RULES_DOC.never_extract_patterns, decisionHints: RULES_DOC.always_treat_as_decision_patterns},
    clause: {chars: 180, text: '## User rule overlay (local, operator-authored)\nrules_hash: 9c1e4d07'},
    verifierUnchanged: true, enforcementPoints: ['fact_insert', 'incident', 'remediation', 'chronicle'],
    schedulingPolicyVersion: 'continuity-fact-v1', effectivePolicyVersion: 'continuity-fact-v1+rules:9c1e4d07',
    quarantined: [], issues: [], history: [{...HISTORY_ROW, overlay: 'extraction-rules', action: 'rules.set'}], snapshots: [3],
    drift: {available: true, staleTargets: 0, staleSessions: 0, heldJobs: []},
    ...rules,
  },
  ...extra,
});
const OVERLAY_ENV = {...ENV, overlays: true};
const ISSUE_ROWS = [
  {severity: 'error', code: 'REGEX_QUANTIFIED_GROUP', key: 'overlays.issue.regexQuantifiedGroup',
    path: 'patterns.add[1].source', message: 'a group may not be repeated'},
  {severity: 'warning', code: 'PATTERN_SHADOWED', key: 'overlays.issue.patternShadowed',
    path: 'patterns.add[0].source', message: 'a built-in already has this source'},
];
/** 이 탭이 그리는 모든 상태. 한 번에 다 보이지 않으므로 조합마다 이름을 붙인다. */
const overlayVariants = () => [
  ['overlays/gate', overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV, OVERLAY_STATUS(), null)],
  ['overlays/gateQuarantined', overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV,
    OVERLAY_STATUS({quarantined: [QUARANTINE_ROW], issues: ISSUE_ROWS}), null)],
  ['overlays/gateEmpty', overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV,
    OVERLAY_STATUS({present: false, revision: 0, hash: null, updatedAt: null, updatedBy: null,
      user: {patterns: [], disabled: [], words: {add: {ack: [], continue: [], filler: []}, disable: {ack: [], continue: [], filler: []}}},
      history: []}), null)],
  ['overlays/gateFiltered', overlayPage.overlayTab(l2ctx('tab=overlays&intent=trace'), OVERLAY_ENV, OVERLAY_STATUS(), null)],
  ['overlays/rules', overlayPage.overlayTab(l2ctx('tab=overlays&overlay=rules'), OVERLAY_ENV, OVERLAY_STATUS(), null)],
  ['overlays/rulesHeld', overlayPage.overlayTab(l2ctx('tab=overlays&overlay=rules'), OVERLAY_ENV, OVERLAY_STATUS({}, {
    issues: ISSUE_ROWS, quarantined: [{...QUARANTINE_ROW, overlay: 'extraction-rules', pattern_id: 'user.9c1e4d07'}],
    drift: {available: true, staleTargets: 4, staleSessions: 2,
      heldJobs: [{reason: 'extraction_rules_invalid', jobs: 2, oldestHeldAt: '2026-09-10T01:00:00.000Z'}]},
  }), null)],
  ['overlays/rulesEmpty', overlayPage.overlayTab(l2ctx('tab=overlays&overlay=rules'), OVERLAY_ENV, OVERLAY_STATUS({}, {
    present: false, revision: 0, hash: null, updatedAt: null, updatedBy: null, doc: null, history: [],
    resolved: {preferredLanguage: null, excludeTopics: [], neverExtract: [], decisionHints: []},
    clause: {chars: 0, text: ''}, effectivePolicyVersion: 'continuity-fact-v1',
    drift: {available: false, staleTargets: 0, staleSessions: 0, heldJobs: []},
  }), null)],
  ['overlays/disabledByEnv', overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV, OVERLAY_STATUS({}, {}, {disabledByEnv: true}), null)],
  ['overlays/noCapability', overlayPage.overlayTab(l2ctx('tab=overlays'), {...ENV, overlays: false}, null, null)],
  ['overlays/readFailed', overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV, null, 'EACCES: permission denied')],
  ['overlays/testResult', overlayPage.testResultHtml({
    prompt: {chars: 12, tokens: []}, overlay: {present: true, hash: 'gate:3f9a1c22', revision: 8},
    matcher: {elapsedMs: 3, timedOut: false, unavailable: false, quarantined: []},
    intents: {memory: {fired: true, matched: [{id: 'memory.en.why', source: '\\bwhy\\b', origin: 'builtin'}]},
      trace: {fired: false, matched: []}},
    decision: {action: 'retrieve', triggers: ['explicit_memory_intent']},
    builtinOnly: {action: 'skip', triggers: []},
    diffCause: [{id: 'user.3f9a1c22', source: 'deploy\\s*history', intent: 'memory'}], stateSource: 'neutral'})],
  ['overlays/simulation', overlayPage.simulationHtml({
    rulesHash: 'rules:9c1e4d07', clause: {chars: 180, text: 'clause'}, verifierUnchanged: true,
    enforcementPoints: ['fact_insert', 'incident', 'remediation', 'chronicle'],
    existingFacts: {scanned: 120, wouldBeBlocked: [{id: 'fact-1', category: 'knowledge', patternId: 'user.9c1e4d07', preview: 'the staging key is sk-...'}]},
    recentExchanges: {scanned: 50, matched: [{exchangeId: 'ex-1', sessionId: 's-1', patternId: 'user.9c1e4d07', preview: 'rotate sk-...'}]},
    matcher: {elapsedMs: 12, timedOut: false, unavailable: false, quarantined: []},
    advisoryOnly: {excludeTopics: ['salary review'], decisionHints: ['user.aa11bb22'], preferredLanguage: 'ko'},
    available: true})],
  ['overlays/simulationUnavailable', overlayPage.simulationHtml({available: false,
    reason: 'extraction_rules_unavailable', detail: 'the matcher worker could not be used',
    existingFacts: {scanned: 0, wouldBeBlocked: []}, recentExchanges: {scanned: 0, matched: []},
    matcher: {elapsedMs: 0, timedOut: true, unavailable: true, quarantined: []}})],
];

test('F en: 오버레이 탭의 모든 상태가 en으로 렌더되고 한글·키 누출이 없다', () => {
  locale.useEn();
  for (const [label, html] of overlayVariants()) {
    assertEnglishOnly(label, html);
    assertNoOverlayKeys(label, html);
  }
});

test('F en: 하위 내비가 두 화면을 가르고 딥링크로 고를 수 있다', () => {
  locale.useEn();
  const gate = overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV, OVERLAY_STATUS(), null);
  assert.match(gate, /<div class="filters" id="overlay-subnav"/);
  assert.match(gate, /class="filter-chip active" data-param-key="overlay" data-param-value="gate"/, '기본 화면은 회수 게이트다');
  assert.ok(gate.includes('id="gate-test-form"') && gate.includes('id="gate-patterns"') && gate.includes('id="gate-add-form"'));
  assert.ok(!gate.includes('id="rules-editor-form"'), '한 화면에 두 편집기를 함께 그리지 않는다');
  const rules = overlayPage.overlayTab(l2ctx('tab=overlays&overlay=rules'), OVERLAY_ENV, OVERLAY_STATUS(), null);
  assert.match(rules, /class="filter-chip active" data-param-key="overlay" data-param-value="rules"/);
  assert.ok(rules.includes('id="rules-editor-form"') && rules.includes('id="rules-clause"') && rules.includes('id="rules-simulate-form"'));
  assert.ok(!rules.includes('id="gate-test-form"'));
  // 새 CSS 컴포넌트를 만들지 않았다 — 기존 토큰만 쓴다.
  for (const token of ['class="card pad mt"', 'class="filter-chip', 'class="tag outline"', 'class="terminal mt"', 'class="check-row"'])
    assert.ok(gate.includes(token) || rules.includes(token), `기존 디자인 토큰이 사라졌다: ${token}`);
});

test('F en: 패턴 표가 내장·사용자·비활성·격리를 한 표에서 구분한다', () => {
  locale.useEn();
  const rows = overlayPage.gatePatternRows(OVERLAY_STATUS({quarantined: [QUARANTINE_ROW]}).gate);
  assert.deepEqual(rows.map(row => [row.id, row.origin, row.state]), [
    ['memory.en.why', 'builtin', 'active'],
    ['ack.en.1', 'builtin', 'disabled'],
    ['user.3f9a1c22', 'user', 'quarantined'],
  ]);
  const html = overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV, OVERLAY_STATUS({quarantined: [QUARANTINE_ROW]}), null);
  for (const key of ['overlays.gate.origin.builtin', 'overlays.gate.origin.user',
    'overlays.gate.state.disabled', 'overlays.gate.state.quarantined'])
    assert.ok(html.includes(locale.en[key]), `${key} 값이 표에 없다`);
  // 끈 내장 항목은 "다시 켜기", 사용자 항목은 "삭제"가 다음 행동이다.
  assert.match(html, /data-gate-enable="ack\.en\.1"/);
  assert.match(html, /data-gate-disable="user\.3f9a1c22" data-origin="user"/);
  assert.ok(html.includes(locale.en['overlays.gate.patterns.remove']));
  // 격리는 배너 + 표 + 다시 시도이고, 고치면 자동 해제된다는 사실을 말한다.
  assert.match(html, /data-quarantine-clear="user\.3f9a1c22" data-overlay="gate"/);
  assert.ok(html.includes(locale.en['overlays.quarantine.autoClear']));
  const filtered = overlayPage.overlayTab(l2ctx('tab=overlays&intent=trace'), OVERLAY_ENV, OVERLAY_STATUS(), null);
  assert.ok(filtered.includes(locale.en['overlays.gate.patterns.empty']), '필터가 비면 빈 상태를 말한다');
});

test('F en: 랜드마크 문구가 en 사전 값과 같고 422는 renderIssues로 그려진다', () => {
  locale.useEn();
  const [, quarantined] = overlayVariants().find(([label]) => label === 'overlays/gateQuarantined');
  for (const key of ['overlays.gate.test.title', 'overlays.gate.test.caption', 'overlays.gate.patterns.title',
    'overlays.gate.add.title', 'overlays.gate.words.title', 'overlays.history.title',
    'overlays.quarantine.title', 'overlays.notShared'])
    assert.ok(quarantined.includes(locale.en[key]), `${key} 값이 화면에 없다: ${locale.en[key]}`);
  assert.match(quarantined, /<strong>on top of<\/strong>/, 'tHtml의 강조가 이스케이프됐다');
  // 행별 사유는 lane-0의 renderIssues()가 그린다 — path가 보존돼 어느 행인지 말한다.
  assert.ok(quarantined.includes('<ul class="issue-list">'));
  assert.ok(quarantined.includes('patterns.add[1].source'));
  assert.ok(quarantined.includes(locale.en['overlays.issue.regexQuantifiedGroup']));
  assert.ok(quarantined.includes(locale.en['overlays.issue.patternShadowed']));
  assert.ok(quarantined.includes(locale.en['error.issue.warning']), '경고 배지는 lane-0의 공용 키를 쓴다');
  const [, explained] = overlayVariants().find(([label]) => label === 'overlays/testResult');
  assert.ok(explained.includes(locale.en['overlays.gate.test.fired']) && explained.includes(locale.en['overlays.gate.test.notFired']));
  assert.ok(explained.includes(locale.en['overlays.gate.intent.memory']));
  assert.ok(explained.includes('memory.en.why'), '어느 규칙이 발화시켰는지 말해야 한다');
  assert.ok(explained.includes(locale.en['overlays.gate.test.row.builtinOnly']) && explained.includes('skip'));
});

test('F en: 추출 규칙 화면은 불변 조건·적용 시점·모델 전용 규칙을 문장으로 말한다', () => {
  locale.useEn();
  const [, rules] = overlayVariants().find(([label]) => label === 'overlays/rules');
  for (const key of ['overlays.rules.verifierUnchanged', 'overlays.rules.timingBody', 'overlays.rules.clause.title',
    'overlays.rules.simulate.storedUnchanged', 'overlays.rules.simulate.modelOnly', 'overlays.rules.drift.noApply',
    'overlays.rules.row.schedulingNote'])
    assert.ok(rules.includes(locale.en[key].replace('{topics}', 'salary review')), `${key} 값이 화면에 없다`);
  assert.match(rules, /<strong>restrict<\/strong>/, '제한만 할 수 있다는 사실이 강조돼야 한다');
  // 강제 지점 4개와 스케줄 키가 그대로 보인다(해시를 섞지 않는다).
  for (const point of ['fact_insert', 'incident', 'remediation', 'chronicle']) assert.ok(rules.includes(point));
  assert.ok(rules.includes('continuity-fact-v1'));
  assert.ok(rules.includes('continuity-fact-v1+rules:9c1e4d07'));
  // 구조화 편집기만 있고 원시 프롬프트 입력은 없다 (#30의 범위).
  assert.match(rules, /<textarea name="exclude_topics"/);
  assert.match(rules, /<input name="neverSource"/);
  assert.match(rules, /<select name="preferred_language"/);
  assert.ok(!/name="(system_prompt|raw_prompt|prompt)"/.test(rules), '원시 프롬프트 편집 필드가 생겼다');
  assert.match(rules, /data-revision="3"/, '저장은 읽어 온 revision을 함께 보낸다');
  assert.ok(rules.includes(locale.en['overlays.rules.overrides'].replace('{projects}', 'project-atlas')));
  // 재추출은 버튼이 아니라 안내다 — 모델 호출을 쓰는 작업을 화면이 몰래 시작하지 않는다.
  assert.ok(!/data-rules="reextract"/.test(rules));
  const [, simulation] = overlayVariants().find(([label]) => label === 'overlays/simulation');
  assert.ok(simulation.includes(locale.en['overlays.rules.simulate.kindFact']));
  assert.ok(simulation.includes(locale.en['overlays.rules.simulate.kindExchange']));
  assert.ok(simulation.includes('user.9c1e4d07'), '어느 규칙이 막았는지 귀속해야 한다');
  const [, unavailable] = overlayVariants().find(([label]) => label === 'overlays/simulationUnavailable');
  assert.ok(unavailable.includes('extraction_rules_unavailable'), '검사를 끝내지 못한 사실을 숨기지 않는다');
});

test('F en: 설정 대기·드리프트·capability 없음이 모두 화면으로 설명된다', () => {
  locale.useEn();
  const [, held] = overlayVariants().find(([label]) => label === 'overlays/rulesHeld');
  assert.ok(held.includes(locale.en['overlays.rules.held.title']));
  assert.ok(held.includes(locale.en['common.job.hold.extraction_rules_invalid']), '보류 배지는 lane-0의 공용 키다');
  assert.ok(held.includes(locale.en['overlays.rules.held.body'].replace('{n}', '2')));
  assert.ok(held.includes(locale.en['overlays.rules.drift.banner'].replace('{targets}', '4').replace('{sessions}', '2')));
  const [, empty] = overlayVariants().find(([label]) => label === 'overlays/rulesEmpty');
  assert.ok(empty.includes(locale.en['overlays.rules.clause.empty']));
  assert.ok(empty.includes(locale.en['overlays.rules.drift.unavailable']), 'DB가 없으면 셀 수 없다고 말한다');
  assert.ok(empty.includes(locale.en['overlays.notApplied']));
  const [, disabled] = overlayVariants().find(([label]) => label === 'overlays/disabledByEnv');
  assert.ok(disabled.includes(locale.en['overlays.disabledByEnv']));
  const [, missing] = overlayVariants().find(([label]) => label === 'overlays/noCapability');
  assert.match(missing, /<div class="banner error">/);
  assert.match(missing, /<code>dist\/overlay-admin\.js<\/code>/);
  const [, failed] = overlayVariants().find(([label]) => label === 'overlays/readFailed');
  assert.ok(failed.includes('EACCES: permission denied'), '조회 실패 사유를 그대로 싣는다');
});

test('F: 탭 레지스트리가 오버레이 탭을 그리고, 조회 실패도 화면으로 설명한다', async () => {
  locale.useEn();
  const bootstrap = {uiVersion: '1.2.3', environment: OVERLAY_ENV, db: {available: true, error: null},
    capabilities: {}, commands: COMMANDS};
  const ctx = l2ctx('tab=overlays', {operations: {items: []}}, {bootstrap, savePrefs() {}});
  const {html} = await settingsPage.render(ctx);
  assert.ok(html.includes(locale.en['settings.tabs.overlays']), '탭 레이블은 lane-0의 settings 사전에서 온다');
  assert.match(html, /class="tab active" href="[^"]*tab=overlays"/, '오버레이 탭이 활성 탭이다');
  assert.match(html, /<div class="banner error">/);
  assert.ok(html.includes('unexpected api call: overlays'));
  const served = l2ctx('tab=overlays', {overlays: OVERLAY_STATUS(), operations: {items: []}}, {bootstrap, savePrefs() {}});
  const ok = await settingsPage.render(served);
  assert.ok(ok.html.includes(locale.en['overlays.gate.patterns.title']), '레지스트리 render가 본문을 그린다');
  assertNoOverlayKeys('settings:tab=overlays', ok.html);
  // mount는 이 탭이 아니면 no-op다 — 다른 탭에서 불려도 아무것도 찾지 못한다.
  overlayPage.mountOverlayTab({querySelector: () => null, querySelectorAll: () => []}, served);
});

test('F ko: 같은 상태가 ko 사전 값으로 렌더된다', () => {
  locale.useKo();
  for (const [label, html] of overlayVariants()) assertNoOverlayKeys(label, html);
  const gate = overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV, OVERLAY_STATUS({quarantined: [QUARANTINE_ROW]}), null);
  for (const key of ['overlays.gate.test.title', 'overlays.gate.patterns.title', 'overlays.quarantine.title',
    'overlays.notShared', 'overlays.gate.origin.builtin'])
    assert.ok(gate.includes(locale.ko[key]), `${key} 의 ko 값이 화면에 없다: ${locale.ko[key]}`);
  assert.ok(!gate.includes(locale.en['overlays.gate.patterns.title']), 'ko 화면에 en 문구가 섞였다');
  assert.match(gate, /<strong>위에<\/strong>/, 'ko tHtml의 강조가 이스케이프됐다');
  const rules = overlayPage.overlayTab(l2ctx('tab=overlays&overlay=rules'), OVERLAY_ENV, OVERLAY_STATUS({}, {
    drift: {available: true, staleTargets: 1, staleSessions: 1,
      heldJobs: [{reason: 'extraction_rules_unavailable', jobs: 1, oldestHeldAt: '2026-09-10T01:00:00.000Z'}]},
  }), null);
  for (const key of ['overlays.rules.verifierUnchanged', 'overlays.rules.timingBody', 'overlays.rules.held.title',
    'common.job.hold.extraction_rules_unavailable'])
    assert.ok(rules.includes(locale.ko[key]), `${key} 의 ko 값이 화면에 없다`);
});

test('F: 0.7.1 공유 연기 공지는 두 화면 모두에 항상 있다', () => {
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    for (const params of ['tab=overlays', 'tab=overlays&overlay=rules']) {
      const html = overlayPage.overlayTab(l2ctx(params), OVERLAY_ENV, OVERLAY_STATUS(), null);
      assert.ok(html.includes(locale[tag]['overlays.notShared']), `${tag} ${params}: 공유 연기 공지가 없다`);
    }
    // shared:true가 오면(0.7.1) 배너는 사라진다 — 문구를 조건 없이 박아 두지 않았다는 증거다.
    const shared = overlayPage.overlayTab(l2ctx('tab=overlays'), OVERLAY_ENV, OVERLAY_STATUS({}, {}, {shared: true}), null);
    assert.ok(!shared.includes(locale[tag]['overlays.notShared']));
  }
});

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ H · 보류된 작업 + 문서 고지 (#31/#30 · #109 §6.4)                         │
// ╰──────────────────────────────────────────────────────────────────────────╯
//
// 두 가지를 못질한다.
//   (1) `memory_jobs.hold_reason`이 붙은 작업은 `pending`이지만 **설정 대기**다. 처리 작업 표의
//       사유 배지와 소유 탭 링크, 개요 경고 카드의 설명이 두 로케일에서 모두 나와야 한다.
//   (2) `help.docs.koreanOnly`는 정의돼 있었지만 **아무도 렌더하지 않았다.** en에서만 한 줄이
//       붙고 ko에서는 빈 문자열이어야 한다.
const H_HOLD_REASONS = ['model_config_rejected', 'extraction_rules_invalid', 'extraction_rules_unavailable'];
const H_OWNER_HREF = {
  model_config_rejected: '/settings?tab=models',
  extraction_rules_invalid: '/settings?tab=overlays&amp;overlay=rules',
  extraction_rules_unavailable: '/settings?tab=overlays&amp;overlay=rules',
};
const hHeldJobs = hold_reason => ({available: true, total: 1, limit: 40, offset: 0,
  items: [{job_id: 'job-held-1', session_id: 'session-h', kind: 'fact_extract', state: 'pending',
    attempts: 0, max_attempts: 5, last_error: null, updated_at: '2026-09-10T00:00:00.000Z', hold_reason}]});

test('H: 보류된 작업의 사유 배지·다음 행동·소유 탭 링크가 두 로케일에서 나온다', async () => {
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    for (const reason of H_HOLD_REASONS) {
      const html = (await activity.render(ctx('tab=jobs', {jobs: hHeldJobs(reason)}))).html;
      assert.deepEqual(html.match(LEAKED_KEY) ?? [], [], `${tag} ${reason}: 미번역 키가 노출됐다`);
      assert.ok(html.includes(dict['common.job.hold.' + reason]), `${tag} ${reason}: 사유 배지가 없다`);
      assert.ok(html.includes(dict['activity.jobs.hold.next']), `${tag} ${reason}: 다음 행동 한 줄이 없다`);
      assert.ok(html.includes(`href="${H_OWNER_HREF[reason]}"`), `${tag} ${reason}: 소유 탭 링크가 없다`);
      assert.ok(html.includes(dict['guidance.job-held.title']), `${tag} ${reason}: 보류 클래스 제목이 없다`);
      assert.ok(html.includes(dict['guidance.ignorable.false']), `${tag} ${reason}: 무시 가능으로 표시됐다`);
    }
    // 보류가 없으면 아무것도 덧붙이지 않는다.
    const plain = (await activity.render(ctx('tab=jobs', {jobs: hHeldJobs(null)}))).html;
    assert.ok(!plain.includes(dict['activity.jobs.hold.next']), `${tag}: 보류가 아닌 작업에 보류 안내가 붙었다`);
  }
});

test('H: 개요 경고 카드가 세 사유의 보류를 합쳐 세고 두 로케일로 설명한다', () => {
  const held = H_HOLD_REASONS.map((reason, i) => ({reason, jobs: i + 1, oldestHeldAt: '2026-09-10T00:00:00.000Z'}));
  for (const [tag, use] of [['en', locale.useEn], ['ko', locale.useKo]]) {
    use();
    const dict = locale[tag];
    const groups = guidance.attentionFromPipeline({attention: {terminal: {}}, ontology: {indexRepair: {blocked: false}},
      evidence: {}, quarantinedProjects: [], heldJobs: held});
    const group = groups.find(g => g.cls.id === 'job-held');
    assert.ok(group, `${tag}: 보류 묶음이 없다`);
    assert.equal(group.count, 6, `${tag}: 사유 하나만 셌다`);
    assert.equal(group.detail, dict['guidance.attention.job-held.detail'].replace('{count}', '6'));
    const card = guidance.attentionCard(groups, guidanceCtx);
    assert.ok(card.includes(dict['guidance.job-held.title']), `${tag}: 제목이 없다`);
    assert.ok(card.includes(dict['guidance.job-held.next']), `${tag}: 다음 행동이 없다`);
    assert.ok(card.includes(dict['guidance.action.viewModelSettings']), `${tag}: 모델 설정 액션이 없다`);
    assert.ok(card.includes(dict['guidance.action.viewExtractionRules']), `${tag}: 추출 규칙 액션이 없다`);
    if (tag === 'en') assert.equal(HANGUL.test(visibleText(card)), false, 'en 카드에 한글이 남았다');
  }
});

test('H: 문서 링크 옆 고지는 en에서만 렌더되고 ko에서는 빈 문자열이다 (#109 §6.4)', () => {
  // app.mjs는 DOM 없이 require할 수 없으므로 **렌더는 컴포넌트로, 배치는 소스로** 본다
  // (L1 섹션의 app.mjs 키 수확과 같은 방식).
  locale.useEn();
  const rendered = ui.docsNoticeTag();
  assert.ok(rendered.includes(locale.en['help.docs.koreanOnly']), 'en 고지가 렌더되지 않았다');
  assert.equal(HANGUL.test(shellText(rendered)), false, '고지 자체에 한글이 있다');
  locale.useKo();
  assert.equal(ui.docsNoticeTag(), '', 'ko에서 고지를 그렸다');
  // 도움말 계층이 app.mjs에서 그리는 문서 링크 2곳(도움말 패널·용어집) 모두에 붙어 있다.
  const appSrc = nodeFs.readFileSync(nodePath.join(__dirname, '../public/app.mjs'), 'utf8');
  const docLinks = appSrc.match(/docUrl\(/g) ?? [];
  assert.equal(docLinks.length, 2, 'app.mjs의 문서 링크 수가 바뀌었다: ' + docLinks.length);
  assert.equal((appSrc.match(/docsNoticeTag\(\)/g) ?? []).length, 2, '문서 링크마다 고지가 붙어 있지 않다');
  assert.ok(/shell\.help\.docsLink[\s\S]{0,80}?docsNoticeTag\(\)/.test(appSrc), '도움말 패널 링크 옆에 고지가 없다');
  assert.ok(/docUrl\(g\.source,version\)[\s\S]{0,200}?docsNoticeTag\(\)/.test(appSrc), '용어집 링크 옆에 고지가 없다');
});
