'use strict';
/** Page modules render to strings, so the browser HTML is checked without a DOM. */
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {name,badge}=require('../public/ui.mjs');const {logStatus}=require('../public/pages/activity.mjs');
const activityPage=require('../public/pages/activity.mjs');const conversationsPage=require('../public/pages/conversations.mjs');
const facts=require('../public/pages/facts.mjs');const taxonomyPage=require('../public/pages/taxonomy.mjs');
const ROOT=path.resolve(__dirname,'../..');
// app.mjs boots against a real document on import, so its shell decisions are asserted on the source.
const APP=fs.readFileSync(path.join(__dirname,'../public/app.mjs'),'utf8');
const TAXONOMY={available:true,unclassified:2,
 domains:[{id:'engineering',name:'엔지니어링',facts:3},{id:'product',name:'제품 · 경험',facts:1}],
 categories:[{id:'storage',domain_id:'engineering',name:'데이터 저장소',description:'SQLite 접근',facts:3},{id:'navigation',domain_id:'product',name:'정보 구조',description:null,facts:1}]};
const row=extra=>({id:'11111111-1111-4111-8111-111111111111',fact:'Local first storage stays on the device.',fact_kr:'로컬 우선 저장은 기기에 남는다.',category:'decision',scope_type:'project',scope_project:'/workspace/memex',promotion_state:'legacy-project',ontology_category_id:'storage',is_active:1,source_count:2,updated_at:'2026-09-01T00:00:00.000Z',...extra});
const factsPage=(items,extra={})=>({available:true,items,total:items.length,limit:50,offset:0,scopeTotal:items.length,...extra});
function ctx(params,data,extra={}){
 const p=new URLSearchParams(params);
 return {p,prefs:{korean:true,density:'comfortable',live:false},scope:{scope:'all'},bootstrap:{environment:{mutable:true}},...extra,
  href:(pathname,query={})=>{const u=new URL(pathname,'http://127.0.0.1');for(const [k,v] of Object.entries(query))if(v!==null&&v!==undefined&&v!=='')u.searchParams.set(k,String(v));return u.pathname+u.search;},
  api:async key=>{if(!(key in data))throw new Error('unexpected api call: '+key);return data[key];},
  update(){},open(){},toast(){}};
}
const renderFacts=(params,data)=>facts.render(ctx(params,{taxonomy:TAXONOMY,...data}));

test('기억 페이지는 도메인 › 카테고리 분류 선택을 노출한다',async()=>{
 const {html}=await renderFacts('',{facts:factsPage([row()])});
 assert(html.includes('<select name="taxonomy"'),'분류 select 없음');
 assert(!/type="hidden" name="taxonomy"/.test(html),'숨겨진 taxonomy 입력이 남아 있음');
 assert(html.includes('>전체 분류</option>'));
 assert(html.includes('value="unclassified"'));
 assert(html.includes('<optgroup label="엔지니어링">')&&html.includes('<optgroup label="제품 · 경험">'));
 assert(html.includes('엔지니어링 › 데이터 저장소'));
});
test('딥링크 taxonomy 값이 선택 상태로 유지된다',async()=>{
 const {html}=await renderFacts('taxonomy=storage',{facts:factsPage([row()])});
 assert(html.includes('<option value="storage" selected>'));
 assert(html.includes('분류 필터가 적용됐습니다'));
});
test('현재 범위 밖의 분류 ID도 선택값을 잃지 않는다',async()=>{
 const {html}=await renderFacts('taxonomy=ghost-category',{facts:factsPage([row()])});
 assert(html.includes('<option value="ghost-category" selected>'));
 assert(html.includes('현재 범위 밖'));
});
test('분류 테이블이 없어도 분류 선택은 안전하게 축소된다',async()=>{
 const {html}=await renderFacts('',{facts:factsPage([row()]),taxonomy:{available:false,domains:[],categories:[],unclassified:null}});
 assert(html.includes('<select name="taxonomy"'));
 assert(!html.includes('value="unclassified"'));
});
test('승격 상태는 한국어로만 표시하고 기본값은 반복하지 않는다',async()=>{
 const base=await renderFacts('',{facts:factsPage([row()])});
 assert(!base.html.includes('legacy-project'),'기본 승격 상태의 원문 값이 노출됨');
 const promoted=await renderFacts('',{facts:factsPage([row({promotion_state:'workspace'})])});
 assert(promoted.html.includes('· 워크스페이스'));
 assert(!promoted.html.includes('>workspace<')&&!promoted.html.includes('· workspace'));
});
test('범위 자체가 비었을 때와 필터가 걸러낸 경우를 구분한다',async()=>{
 const emptyScope=await renderFacts('',{facts:factsPage([],{scopeTotal:0})});
 assert(emptyScope.html.includes('이 범위에 저장된 기억이 없습니다'));
 assert(emptyScope.html.includes('tab=actions'),'추출·동기화로 가는 안내가 없음');
 assert(!emptyScope.html.includes('reset-facts-filter'));
 const filtered=await renderFacts('q=없는검색어',{facts:factsPage([],{scopeTotal:12})});
 assert(filtered.html.includes('조건에 맞는 기억이 없습니다'));
 assert(filtered.html.includes('data-action="reset-facts-filter"'),'필터 초기화 동작이 없음');
});
test('분류 카드는 기억 목록과 지식 지도로 각각 연결된다',async()=>{
 const {html}=await taxonomyPage.render(ctx('',{taxonomy:TAXONOMY}));
 assert(html.includes('지도에서 보기'));
 assert(html.includes('href="/graph?domain=engineering"'));
 assert(html.includes('href="/facts?taxonomy=storage"'));
 // 카드 안에 링크가 두 개이므로 카드 자체는 앵커가 아니어야 한다(중첩 <a> 금지).
 assert(html.includes('<article class="card taxonomy-card">'));
 assert(!html.includes('<a class="card taxonomy-card"'));
 const scoped=await taxonomyPage.render(ctx('domain=product',{taxonomy:TAXONOMY}));
 assert(scoped.html.includes('href="/graph?domain=product"'));
});
test('기억 0개를 제공한 inject-context 행은 성공 색을 쓰지 않는다',()=>{
 const zero={status:'injected',data:{injected:0,candidates:0}};
 assert.equal(logStatus(zero),'no-inject');
 assert.equal(badge(logStatus(zero)),'<span class="tag ">제공 없음</span>');
 const provided={status:'injected',data:{injected:3}};
 assert.equal(logStatus(provided),'injected');
 assert.match(badge(logStatus(provided)),/class="tag green"/);
 assert.equal(logStatus({status:'no-match',data:{injected:0}}),'no-match');
});
test('코어가 기록하는 promotion_state 값에는 모두 한국어 라벨이 있다',()=>{
 const source=fs.readFileSync(path.join(ROOT,'src','continuity-store.ts'),'utf8');
 const declared=new Set();
 for(const m of source.matchAll(/promotion_state IN \(([^)]*)\)/g))for(const v of m[1].match(/'[^']+'/g)||[])declared.add(v.slice(1,-1));
 for(const m of source.matchAll(/"promotion_state", "TEXT NOT NULL DEFAULT '([^']+)'"/g))declared.add(m[1]);
 declared.add('workstream'); // src/fact-db.ts: workstream 범위 팩트의 기본 승격 상태
 assert(declared.size>=5,'src에서 promotion_state 값을 찾지 못했습니다: '+[...declared]);
 for(const value of declared)assert.notEqual(name(value),value,'한국어 라벨 없음: '+value);
});

// --- #24 메뉴 이름 · 기본 범위 · 주입 범위 안내 · 공통 범위 원클릭 전환 ---
test('사이드바 메뉴와 기억 페이지 제목이 기억·사실로 통일된다',async()=>{
 assert(APP.includes("['/facts','memory','기억·사실']"),'app.mjs navigation 라벨이 바뀌지 않음');
 assert(!/\['\/facts','memory','기억'\]/.test(APP),'옛 메뉴 라벨이 남아 있음');
 const {html}=await renderFacts('',{facts:factsPage([row()])});
 assert(html.includes('<h1>기억·사실</h1>'),'페이지 제목이 바뀌지 않음');
});
test('조회 기본 범위는 공통 기억이 아니라 전체 프로젝트다',()=>{
 assert(APP.includes("export const DEFAULT_SCOPE='all'"),'기본 범위 상수가 all이 아님');
 assert(/const type=p\.get\('scope'\)\|\|\(p\.get\('project'\)\?'project':DEFAULT_SCOPE\)/.test(APP),'currentScope가 기본 범위 상수를 쓰지 않음');
 assert(APP.includes("u.searchParams.set('scope',DEFAULT_SCOPE)"),'기본 범위를 주소에 명시하지 않음');
});
test('범위 선택 옆에 주입 범위 안내를 상시 표시한다',()=>{
 const hint=APP.match(/export const SCOPE_HINT='([^']+)'/);
 assert(hint,'SCOPE_HINT 상수 없음');
 assert(hint[1].includes('공통 기억')&&hint[1].includes('조회'),'안내 문구가 주입·조회 범위를 설명하지 않음: '+hint[1]);
 assert(APP.includes('id="scope-hint"'),'상시 안내 요소가 렌더링되지 않음');
});
test('범위 드롭다운은 전체 → 공통 → 프로젝트 순서로 기억 수와 함께 나열한다',()=>{
 const shell=APP.slice(APP.indexOf('const scopeOptions='));
 assert(shell.indexOf("'all','전체 프로젝트 (조회)'")<shell.indexOf("'global','공통 기억'"),'전체 프로젝트가 공통 기억보다 뒤에 있음');
 assert(shell.includes('optgroup label="프로젝트"'),'프로젝트 목록 그룹이 없음');
 assert(APP.includes("' · 기억 '+number(n)+'개'"),'항목별 기억 수 표시가 없음');
});
test('/facts?fact=<id> 딥링크가 상세 패널을 연다',()=>{
 assert(/u\.pathname==='\/facts'&&u\.searchParams\.get\('fact'\)/.test(APP),'fact= 딥링크 정규화가 없음');
 assert(APP.includes("u.searchParams.set('item',u.searchParams.get('fact'));u.searchParams.delete('fact')"));
});
test('공통 기억 범위의 대화·활동은 원클릭 전환 버튼을 준다',async()=>{
 const global={scope:{scope:'global'}};
 const emptyPage={available:true,items:[],total:0,limit:40,offset:0};
 const conversations=await conversationsPage.render(ctx('',{sessions:emptyPage},global));
 assert(conversations.html.includes('data-action="scope-all"'),'대화 원장에 전환 버튼 없음');
 assert(conversations.html.includes('공통 기억 범위에는 대화가 없습니다'));
 const activity=await activityPage.render(ctx('',{chronicle:emptyPage},global));
 assert(activity.html.includes('data-action="scope-all"'),'활동·추적에 전환 버튼 없음');
 assert(activity.html.includes('공통 기억 범위에는 활동 기록이 없습니다'));
 const wide=await activityPage.render(ctx('',{chronicle:emptyPage}));
 assert(!wide.html.includes('data-action="scope-all"'),'전체 범위에서 불필요한 배너가 표시됨');
});
