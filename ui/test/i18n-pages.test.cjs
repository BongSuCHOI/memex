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
 * "화면 전체에 한글 0건"은 여기서 단정하지 않는다 — `ui.mjs`(pagination/badge/date)와
 * `guidance.mjs`·`help.mjs`가 아직 PENDING_MIGRATION이라 L1·L4 머지 전에는 성립하지 않는다.
 * 그 단정은 L1의 e2e probe(§9.4 (4))가 맡는다.
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
 * 페이지 헤더의 도움말 버튼은 `help.mjs`(L4, PENDING_MIGRATION)의 한국어 제목을 그대로
 * 싣는다. 한국어 잔존 검사에서만 잘라낸다 — 키 누출 검사는 전체 HTML을 본다.
 */
const stripPending = html => html.replace(/<button class="icon-btn help-toggle"[\s\S]*?<\/button>/g, '');

/** (a)+(c)를 한 번에 본다. 호출자는 en 랜드마크만 따로 단정하면 된다. */
function assertEnglish(html, migratedKorean, where) {
  assert.deepEqual(html.match(LEAKED_KEY) ?? [], [], `${where}: 미번역 키가 화면에 노출됐다`);
  const body = stripPending(html);
  for (const text of migratedKorean) assert.ok(!body.includes(text), `${where}: 이관한 한국어가 남아 있다 — ${text}`);
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
