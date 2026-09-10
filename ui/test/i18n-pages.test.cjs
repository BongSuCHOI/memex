'use strict';
/**
 * en 스모크 — 셸 표면 (#109, 0.7.0 i18n L1 · 설계 §9.2).
 *
 * 기존 테스트는 `useKo()`로 한국어 단정을 그대로 통과시킨다(§9.2). 그것만으로는 **en 쪽의
 * 회귀를 하나도 잡지 못한다**: 이관을 빼먹은 문자열은 ko에서 멀쩡하고 en에서만 한국어로
 * 남는다. 그래서 같은 렌더를 `useEn()`으로 한 번 더 돌려 세 가지를 본다.
 *
 *   1. 출력에 한글이 0건            — 이관 누락
 *   2. 미번역 키 패턴이 0건          — t()가 키를 그대로 내보낸 자리(= 사전에 없는 키)
 *   3. 랜드마크 문구가 en 사전 값과 일치 — 사전을 실제로 읽고 있는지
 *
 * 페이지 본문(L2·L3·L4 소유)은 각 레인이 같은 파일에 자기 블록을 더한다. 여기 있는 것은
 * L1이 소유한 셸·포맷터·배지·오류 표면이다.
 */
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {useEn,en,ko}=require('./helpers/locale.cjs');
const {NAMESPACES,PREFIXES}=require('../public/i18n/registry.mjs');
const {TABLES}=require('../public/i18n/load.mjs');
const ui=require('../public/ui.mjs');
const extract=require('../../scripts/i18n-extract.mjs');

const ROOT=path.resolve(__dirname,'../..');
const HANGUL=/[가-힣ㄱ-ㅎㅏ-ㅣ]/;
/** 텍스트로 새어 나온 번역 키. `pages.facts.title`처럼 세 토막 이상인 점 표기를 찾는다. */
const KEY_LEAK=/\b[a-z][a-z0-9]*(?:\.[a-zA-Z0-9_-]+){2,}\b/;
/** 키 누수 검사 전에 지울 것: 속성값, 클래스·스타일, SVG path, 태그 이름. */
const textOf=html=>String(html)
  .replace(/<svg[\s\S]*?<\/svg>/g,' ')
  .replace(/<[^>]*>/g,' ')
  .replace(/&[a-z]+;|&#\d+;/g,' ');

const L1_NAMESPACES=['common','shell','ui','badge','errors'];

/**
 * `badge()`의 툴팁은 `help.mjs`의 `badgeHelp()`가 만든다. L1은 `badge.<v>.help` 142키를 사전에
 * 넣었고, 그 테이블을 지우고 사전을 읽게 바꾸는 2줄은 **L4 소유**다(설계 §12.3 X1, 머지 L1→L4).
 *
 * 그래서 검사를 둘로 나눈다: 사전 쪽 준비는 **지금** 강제하고, 툴팁 텍스트의 한글은 L4가
 * 들어오는 순간 자동으로 검사 대상이 된다 — 예외가 영구히 남지 않는다.
 */
const badgeHelpReadsDictionary=()=>require('../public/help.mjs').badgeHelp('dead')===en['badge.dead.help'];

// ── (1) L1 사전의 en 쪽에 한글이 0건 ─────────────────────────────────────────
test('en 사전의 L1 네임스페이스에 한글이 없다',()=>{
 const leaks=[];
 for(const ns of L1_NAMESPACES)
  for(const [key,value] of Object.entries(TABLES.en[ns]))
   if(HANGUL.test(value))leaks.push(`${ns}/${key}: ${value}`);
 assert.deepEqual(leaks,[],'en 사전에 한글이 남아 있습니다');
 // 거울 검사: ko 쪽이 통째로 영어면 번역을 빼먹은 것이다. 고유명사·단위만 있는 키는 제외한다.
 const untranslated=Object.keys(TABLES.ko.shell).filter(key=>{
  const value=TABLES.ko.shell[key];
  return !HANGUL.test(value)&&TABLES.en.shell[key]===value;
 });
 assert.deepEqual(untranslated,['shell.documentTitle'],'ko shell 사전에 en 값이 그대로 남아 있습니다');
});

// ── (2) L1이 소유한 모든 키가 자기 네임스페이스의 접두사를 쓴다 ──────────────
test('L1 네임스페이스의 키가 접두사 규율을 지킨다',()=>{
 const problems=[];
 for(const tag of ['en','ko'])
  for(const ns of L1_NAMESPACES)
   for(const key of Object.keys(TABLES[tag][ns]))
    if(!PREFIXES[ns].some(p=>key.startsWith(p)))problems.push(`${tag}/${ns}: ${key}`);
 assert.deepEqual(problems,[]);
 assert.ok(NAMESPACES.includes('badge'));
});

// ── (3) index.html 부팅 셸의 키가 en·ko 양쪽에 있다 ─────────────────────────
test('index.html의 data-i18n 키가 양쪽 사전에서 해소된다',()=>{
 const harvested=extract.harvestHtmlKeys();
 assert.ok(harvested.length>=9,'부팅 셸 키 수집 실패: '+harvested.length);
 for(const [key] of harvested){
  assert.ok(key in en,'en 사전에 없는 부팅 키: '+key);
  assert.ok(key in ko,'ko 사전에 없는 부팅 키: '+key);
 }
 // 서버가 치환하는 토큰 2개는 en 원문이어야 한다 — localizeHtml()이 정확 일치 리터럴로 바꾼다.
 const html=fs.readFileSync(path.join(ROOT,'ui/public/index.html'),'utf8');
 assert.ok(html.includes('<html lang="en" data-lang="en"'));
 assert.ok(html.includes('<meta name="memex-ui-lang" content="en">'));
 assert.equal(HANGUL.test(html),false,'index.html에 한글이 남아 있습니다');
});

// ── (4) ui.mjs 표면을 en으로 렌더해 한글·키 누수 0건 ────────────────────────
const FACT={id:'11111111-2222-3333-4444-555555555555',fact:'The release gate runs twice.',
 fact_kr:'릴리스 게이트는 두 번 돈다.',category:'decision',is_active:1,scope_type:'project',
 scope_project:'/repo/memex',promotion_state:'workstream',tier_reason:'branch:feat/i18n'};
const EVENT={event_kind:'SYNC_IMPORTED',actor:'sync',fact_id:FACT.id,recorded_at:'2026-09-10T04:05:06.000Z',
 effective_at:'2026-09-09T04:05:06.000Z',projection_applied:0,
 outcome_json:JSON.stringify({source_device_id:'device-aaaaaaaa',generation:'gen-bbbbbbbb',winner:'peer',reason:'peer-newer'})};

test('en 셸 표면에 한글이 0건이고 미번역 키가 노출되지 않는다',()=>{
 useEn();
 ui.setPreferTranslatedFacts(false);
 const surfaces={
  tierBadge:ui.tierBadge(FACT,'/repo/memex'),
  tierBadgeGlobal:ui.tierBadge({...FACT,scope_type:'global'},null),
  tierBadgeWorkspace:ui.tierBadge({...FACT,promotion_state:'workspace',tier_reason:null},'/repo/memex'),
  tierBadgeProject:ui.tierBadge({...FACT,promotion_state:'project-current',tier_reason:null},null),
  badge:ui.badge('dead')+ui.badge('no-match')+ui.badge('NOT_PROVEN')+ui.badge('SYNC_IMPORTED'),
  name:ui.name(null)+' '+ui.name('project-current')+' '+ui.name('capsule_update'),
  basename:ui.basename('')+' '+ui.basename('/repo/memex'),
  dates:ui.date('2026-09-10T04:05:06.000Z')+' '+ui.date(null)+' '+ui.relative(null),
  units:ui.duration(null)+' '+ui.duration(400)+' '+ui.duration(4000)+' '+ui.duration(400000)
   +' '+ui.bytes(null)+' '+ui.bytes(12)+' '+ui.bytes(2048)+' '+ui.bytes(3*1024**2),
  pagination:ui.pagination({total:1,offset:0,limit:40},{})+ui.pagination({total:4210,offset:40,limit:40},{}),
  eventRow:ui.eventRow(EVENT),
  syncOriginTag:ui.syncOriginTag(EVENT),
  errorCard:ui.errorCard({code:'DB_INDEX_MISSING',key:'error.db.indexMissing',message:'Index database is missing.'}),
  errorCardFromCore:ui.errorCard({code:'DB_UNAVAILABLE',key:null,message:'SQLITE_CANTOPEN: unable to open database file'}),
  renderIssues:ui.renderIssues([{key:'error.issue.warning',severity:'warning',path:'patterns.add[2].source'}]),
  factLink:ui.factLink(FACT),
  searchField:ui.searchField(),
  raw:ui.raw({a:1}),
  markdown:ui.markdown('**bold** and `code`'),
 };
 // L4가 badgeHelp를 사전으로 돌리기 전까지만, 그리고 title 속성에 한해서 예외를 둔다.
 const tooltipsPending=!badgeHelpReadsDictionary();
 const forHangul=html=>tooltipsPending?String(html).replace(/ title="[^"]*"/g,''):String(html);
 for(const [label,html] of Object.entries(surfaces)){
  assert.equal(HANGUL.test(forHangul(html)),false,`${label}: en 렌더에 한글이 남았습니다 — ${html}`);
  const leak=textOf(html).match(KEY_LEAK);
  assert.equal(leak,null,`${label}: 미번역 키가 노출됐습니다 — ${leak&&leak[0]}`);
 }
 // 예외를 쓰는 동안에도 사전 쪽은 준비돼 있어야 한다 — L4는 모듈 2줄만 바꾸면 끝이다.
 for(const kind of ['dead','no-match','NOT_PROVEN','SYNC_IMPORTED']){
  assert.ok(en[`badge.${kind}.help`],`badge.${kind}.help이 en 사전에 없습니다`);
  assert.equal(HANGUL.test(en[`badge.${kind}.help`]),false);
 }
 // (3) 랜드마크가 사전 값과 정확히 일치한다 — 사전을 실제로 읽고 있다는 증거.
 assert.ok(surfaces.tierBadgeGlobal.includes(en['tier.global.label']));
 assert.ok(surfaces.tierBadge.includes('Branch: feat/i18n'));
 assert.ok(surfaces.badge.includes(en['badge.dead.label']));
 assert.equal(ui.name(null),en['common.unknown']);
 assert.equal(ui.basename(''),en['common.commonMemory']);
 assert.ok(surfaces.pagination.includes('1 row')&&surfaces.pagination.includes('4,210 rows'),
  '영어 복수형·천 단위 구분이 적용되지 않았습니다: '+surfaces.pagination);
 assert.ok(surfaces.errorCard.includes(en['error.card.title']));
 assert.ok(surfaces.errorCardFromCore.includes(en['error.fromCore']),'코어 원문 캡션이 없습니다');
 assert.ok(!surfaces.errorCard.includes(en['error.fromCore']),'분류된 오류에 코어 캡션이 붙었습니다');
 assert.ok(surfaces.factLink.includes(FACT.fact)&&!surfaces.factLink.includes(FACT.fact_kr),
  'en에서 fact_kr가 우선됐습니다');
 assert.ok(surfaces.units.includes('6m 40s')&&surfaces.units.includes('3.0 MB'));
});

// ── (5) ko에서도 같은 표면이 키를 노출하지 않는다 ───────────────────────────
test('ko 셸 표면에 미번역 키가 노출되지 않고 fact_kr가 우선된다',()=>{
 require('./helpers/locale.cjs').useKo();
 ui.setPreferTranslatedFacts(true);
 const html=[ui.tierBadge(FACT,'/repo/memex'),ui.badge('dead'),ui.eventRow(EVENT),
  ui.pagination({total:4210,offset:40,limit:40},{}),ui.factLink(FACT),
  ui.errorCard({code:'X',key:null,message:'SQLITE_CANTOPEN'})].join('');
 const leak=textOf(html).match(KEY_LEAK);
 assert.equal(leak,null,'ko 렌더에 미번역 키가 노출됐습니다 — '+(leak&&leak[0]));
 assert.ok(html.includes(FACT.fact_kr),'ko에서 fact_kr가 우선되지 않았습니다');
 assert.ok(html.includes('총 4,210개'),'ko 페이지네이션 문구가 바뀌었습니다: '+html);
 assert.ok(html.includes(ko['error.fromCore']));
 ui.setPreferTranslatedFacts(null);
});
