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

test('L4 en: 실패 분류 37개의 제목·원인·영향·다음 행동이 en으로 읽힌다', () => {
  locale.useEn();
  const entries = [];
  for (const cls of [...guidance.CLASSES, guidance.unknownClass('boom')])
    for (const field of ['title', 'cause', 'impact', 'next']) entries.push([`${cls.id}.${field}`, cls[field]]);
  assert.deepEqual(catalogueProblems(entries), []);
  assert.equal(guidance.CLASSES.length, 36, '실패 클래스 수가 바뀌었다');
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
