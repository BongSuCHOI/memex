'use strict';
const {ko}=require('./helpers/locale.cjs');
require('./helpers/locale.cjs').useKo();   // #109: 기존 한국어 단정은 ko 로케일에서 그대로 통과한다.
/** Page modules render to strings, so the browser HTML is checked without a DOM. */
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {name,badge,eventRow,syncOrigin,syncOriginTag,setCustomFactKinds,setCustomFactKindsHash,syncCustomFactKinds,scheduleCustomFactKindsSync,FACT_KINDS_SYNC_DEBOUNCE_MS,customFactKinds}=require('../public/ui.mjs');const {logStatus}=require('../public/pages/activity.mjs');
const details=require('../public/details.mjs');
const activityPage=require('../public/pages/activity.mjs');const conversationsPage=require('../public/pages/conversations.mjs');
const facts=require('../public/pages/facts.mjs');const taxonomyPage=require('../public/pages/taxonomy.mjs');const settingsPage=require('../public/pages/settings.mjs');
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
 return {p,prefs:{preferTranslatedFacts:true,density:'comfortable',live:false},scope:{scope:'all'},bootstrap:{environment:{mutable:true}},...extra,
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
test('계층 배지는 한국어 라벨 5종을 쓰고 코어 원문 값을 노출하지 않는다',async()=>{
 const label=async extra=>{const {html}=await renderFacts('',{facts:factsPage([row(extra)])});assert(!/legacy-project|>workspace<|>workstream</.test(html),'코어 원문 값이 노출됨: '+html.match(/legacy-project|>workspace<|>workstream</));return html;};
 assert((await label()).includes('>프로젝트 공용<'));
 assert((await label({promotion_state:'project-current'})).includes('>프로젝트 공용<'));
 assert((await label({promotion_state:'workspace'})).includes('>워크스페이스<'));
 assert((await label({promotion_state:'workstream',tier_reason:'branch:feature/x'})).includes('>브랜치: feature/x<'));
 assert((await label({promotion_state:'workstream',tier_reason:'tier:user',workstream_branch:'ui/redesign'})).includes('>브랜치: ui/redesign<'),'tier_reason에 브랜치가 없으면 workstream branch_hint로 대체해야 함');
 assert((await label({promotion_state:'workstream'})).includes('>브랜치<'),'브랜치 이름을 모르면 이름을 지어내지 않아야 함');
 assert((await label({scope_type:'global',scope_project:null})).includes('>글로벌 공용<'));
});
test('계층 배지 툴팁은 주입 조건을 한 문장으로 설명한다',async()=>{
 const {html}=await renderFacts('',{facts:factsPage([row({promotion_state:'workstream',tier_reason:'branch:feature/x'})])});
 assert(html.includes('title="브랜치 feature/x 세션에만 주입됩니다."'),'브랜치 계층 툴팁 없음');
 const project=await renderFacts('',{facts:factsPage([row()])});
 assert(project.html.includes('title="프로젝트 memex의 모든 세션에 주입됩니다."'),'프로젝트 계층 툴팁 없음');
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
 assert.match(badge(logStatus(zero)),/^<span class="tag " title="[^"]+">제공 없음<\/span>$/,'성공 색이 붙었거나 설명 툴팁이 빠짐');
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

// --- #22 계층으로 가려진 기억 배너 · tiers=all 토글 · 이관 카드 ---
test('가려진 계층 기억이 있으면 포함해서 보기 배너를 띄운다',async()=>{
 const {html}=await renderFacts('',{facts:factsPage([row()],{hiddenByTier:{workstream:9,workspace:2},tiers:'default'})});
 assert(html.includes('브랜치/작업 흐름 범위 기억 11건이 더 있습니다'),'가려진 총합이 표시되지 않음');
 assert(html.includes('브랜치 범위 9건 · 워크스페이스 범위 2건'),'계층별 내역이 없음');
 assert(html.includes('data-param-key="tiers" data-param-value="all"'),'포함해서 보기 토글이 없음');
});
test('tiers=all일 때는 되돌리는 쪽을 제안한다',async()=>{
 const {html}=await renderFacts('tiers=all',{facts:factsPage([row()],{hiddenByTier:{workstream:9,workspace:0},tiers:'all'})});
 assert(html.includes('포함해서 보고 있습니다'));
 assert(html.includes('data-param-key="tiers" data-param-value=""'),'기본 범위로 되돌리는 토글이 없음');
 assert(!html.includes('워크스페이스 범위 0건'),'0건 계층을 문장에 넣지 않아야 함');
});
test('가려진 기억이 없거나 프로젝트 범위가 아니면 배너를 만들지 않는다',async()=>{
 for(const extra of [{hiddenByTier:null},{hiddenByTier:{workstream:0,workspace:0}}]){
  const {html}=await renderFacts('',{facts:factsPage([row()],extra)});
  assert(!html.includes('data-param-key="tiers"'),'불필요한 계층 배너가 표시됨: '+JSON.stringify(extra));
 }
});
test('계층 이관 카드는 dry-run 출력을 그대로 보여주고 적용은 미리보기 뒤에 열린다',()=>{
 const env={commands:true};
 const cold=settingsPage.migrationCard(ctx('',{}),env,{});
 assert(cold.includes('data-command="tiers-preview"'));
 assert(/data-command="tiers-apply" disabled/.test(cold),'미리보기 전에는 적용이 잠겨 있어야 함');
 assert(cold.includes('아직 미리보기를 실행하지 않았습니다'));
 const warm=settingsPage.migrationCard(ctx('',{}),env,{preview:{id:'op-1',command:'tiers-preview',status:'completed',started_at:'2026-09-10T00:00:00.000Z',exit_code:0},previewOutput:'2 fact(s) would move workstream → project-current. Re-run with --apply.'});
 assert(warm.includes('2 fact(s) would move workstream'),'dry-run 출력이 카드에 없음');
 assert(!/data-command="tiers-apply" disabled/.test(warm),'미리보기 뒤에는 적용이 열려야 함');
 const noCli=settingsPage.migrationCard(ctx('',{}),{commands:false},{preview:{id:'op-1',status:'completed',started_at:null,exit_code:0}});
 assert(/data-command="tiers-preview" disabled/.test(noCli),'CLI가 없으면 실행할 수 없어야 함');
});
test('계층 승격·강등 이벤트에는 한국어 라벨이 있다',()=>{
 assert.equal(name('PROMOTED'),'계층 승격');
 assert.equal(name('DEMOTED'),'계층 강등');
});

test('보조 텍스트도 11px 아래로 내려가지 않는다',()=>{
 const dir=path.join(__dirname,'../public');
 const files=['style.css','app.mjs','ui.mjs','details.mjs','guidance.mjs','help.mjs','graph-engine.mjs',...fs.readdirSync(path.join(dir,'pages')).map(f=>'pages/'+f)];
 const small=[];
 for(const file of files){
  const text=fs.readFileSync(path.join(dir,file),'utf8');
  for(const m of text.matchAll(/font(?:-size)?:\s*(\d+(?:\.\d+)?)px/g))if(Number(m[1])<11)small.push(`${file}: ${m[0]}`);
 }
 assert.deepEqual(small,[],'스펙상 보조 텍스트도 읽혀야 합니다(#26): '+small.join(', '));
});

// --- #48 관리 › 동기화 탭 ---
const syncStatus=extra=>({status:{enabled:false,dir:'/shared/memex-sync',dirSource:'configured',dirExists:true,dirWritable:true,configPath:'/home/me/.config/memex/sync/config.json',updatedAt:'2026-09-10T00:00:00.000Z',deviceId:null,deviceAlias:null,archiveDir:'/home/me/.config/memex/sync/exports',lastExport:null,peers:[],...extra}});
/** 다른 기기 표의 행 텍스트만 — 상태 블록의 기기 ID와 섞이지 않게 한다. */
const peerRows=html=>[...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map(m=>m[1]);
const syncCtx=ctx('tab=sync',{});
test('동기화는 기본이 꺼짐이고, 꺼져 있으면 수동 실행 버튼이 잠긴다',()=>{
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus(),null,null);
 assert(html.includes('기본으로 꺼져 있습니다'),'기본값이 꺼짐이라는 설명이 없음');
 assert(/id="sync-switch"[^>]*>/.test(html)&&!/id="sync-switch"[^>]*checked/.test(html),'스위치가 꺼진 상태로 그려지지 않음');
 assert(/data-sync="export" disabled/.test(html)&&/data-sync="import" disabled/.test(html),'꺼짐 상태에서 실행 버튼이 잠기지 않음');
 assert(html.includes('먼저 켜세요'),'왜 잠겼는지 설명이 없음');
});
test('켜져 있으면 폴더·기기·마지막 내보내기를 그대로 보여준다',()=>{
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus({
  enabled:true,deviceId:'device-aaa',
  lastExport:{ok:true,at:'2026-09-10T01:00:00.000Z',counts:{facts:12,revisions:4,tombstones:1,recallEvents:9}},
  peers:[{deviceId:'device-aaa',alias:null,aliasIsLocal:false,isSelf:true,generation:'g-self',exportedAt:null,hostname:'mine',counts:null},
         {deviceId:'device-bbb',alias:null,aliasIsLocal:false,isSelf:false,generation:'generation-2222',exportedAt:'2026-09-09T00:00:00.000Z',hostname:'other-mac',counts:{facts:7,revisions:2,tombstones:0,recallEvents:3}}],
 }),null,null);
 assert(html.includes('/shared/memex-sync')&&html.includes('이 화면에서 지정'));
 assert(html.includes('device-aaa')&&html.includes('device-bbb')&&html.includes('other-mac'));
 assert(!/data-sync="export" disabled/.test(html),'켜짐 상태에서 실행 버튼이 잠김');
 assert(html.includes('기억 12'),'마지막 내보내기 행 수가 없음');
 assert(!peerRows(html).some(rows=>rows.includes('device-aaa')),'자기 기기를 다른 기기 목록에 넣지 않아야 합니다');
});
test('가져오기 결과와 거부된 세대 사유를 원문 그대로 보여준다',()=>{
 const run={action:'import',at:'2026-09-10T02:00:00.000Z',outcome:{skipped:null,error:null,result:{newFacts:5,updatedFacts:2,deletedFacts:1,newRevisions:3,newTombstones:1,newRecallEvents:4,updatedRecallEvents:0,
  malformedRows:[{file:'devices/device-bbb/CURRENT',line:1,error:'generation g-2 integrity check failed, device device-bbb snapshot rejected'}]}}};
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus({enabled:true}),null,run);
 assert(html.includes('기억 +5 / ~2 / -1'),'+N/~N/-N 요약이 없음');
 assert(html.includes('integrity check failed'),'거부 사유 원문이 없음');
 assert(html.includes('devices/device-bbb/CURRENT'));
 const skipped=settingsPage.syncTab(syncCtx,{sync:true},syncStatus({enabled:true}),null,{action:'export',at:null,outcome:{skipped:'unchanged',result:null,error:null}});
 assert(skipped.includes('durable 변경이 없습니다'),'건너뛴 사유를 설명하지 않음');
});
// --- #48 0.6.3: 수동 세대 파일 · 기기 별칭 · 충돌 이력 ---
test('남은 것은 실제 2기기 검증뿐이라고 각주에 밝힌다',()=>{
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus(),null,null);
 assert(html.includes('liveTwoDeviceRoundTrip: NOT_PROVEN'),'검증되지 않은 항목을 이름으로 밝히지 않음');
 assert(!html.includes('0.6.2에서 들어옵니다'),'이미 들어온 범위를 아직 미뤘다고 말함');
});
test('수동 파일 카드는 내보내기 경로와 검증 → 미리보기 → 확인 순서를 노출한다',()=>{
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus(),null,null);
 assert(html.includes('data-archive="export"'),'세대 파일 내보내기 버튼이 없음');
 assert(html.includes('id="archive-import-form"')&&html.includes('name="path"'),'가져올 파일 경로 입력이 없음');
 assert(/data-archive="import" disabled/.test(html),'미리보기 전에는 가져오기가 잠겨 있어야 함');
 // 폼 안의 버튼이 submit이면 클릭이 미리보기를 다시 보내고, 그 재렌더가 진행 중인 가져오기를 끊는다.
 assert(/type="button" data-archive="import"/.test(html),'가져오기 버튼이 폼을 submit하면 안 됩니다');
 assert(html.includes('/home/me/.config/memex/sync/exports'),'기본 저장 위치를 알려주지 않음');
 assert(html.includes('브라우저 다운로드는 이 UI에서 막혀 있으므로'),'왜 경로로 안내하는지 설명이 없음');
 assert(html.includes('평문 JSONL'),'평문 경고가 없음');
});
test('내보낸 세대 파일은 경로·크기·행 수와 Finder 안내를 보여준다',()=>{
 const archive={path:'/home/me/.config/memex/sync/exports/device-aaa-gen-1.zip',bytes:2048,deviceId:'device-aaa',deviceAlias:'집 맥미니',generation:'gen-1',counts:{facts:12,revisions:3,tombstones:0,recallEvents:5}};
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus({enabled:true,deviceId:'device-aaa',deviceAlias:'집 맥미니'}),null,null,archive,null);
 assert(html.includes(archive.path)&&html.includes('2.0 KB'));
 assert(html.includes('집 맥미니'),'별칭을 표시하지 않음');
 assert(html.includes(`data-copy-command="${archive.path}"`),'경로 복사 버튼이 없음');
 assert(html.includes('⇧⌘G'),'Finder에서 열기 안내가 없음');
});
test('미리보기는 +N/~N/-N·충돌·거부 사유를 보여주고 가져오기를 연다',()=>{
 const preview={path:'/Users/me/Downloads/g.zip',at:'2026-09-10T03:00:00.000Z',preview:{
  source:'/Users/me/Downloads/g.zip',deviceId:'device-bbb',deviceAlias:'회사 맥북',generation:'gen-9',
  newFacts:4,updatedFacts:2,deletedFacts:1,
  conflicts:[{factId:'11111111-1111-4111-8111-111111111111',deviceId:'device-bbb',deviceAlias:'회사 맥북',winner:'peer',reason:'peer-newer'}],
  generations:[{deviceId:'device-bbb',generation:'gen-9'}],
  rejected:[{file:'devices/device-bbb/CURRENT',line:0,error:'generation gen-8 integrity check failed'}]}};
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus({enabled:true}),null,null,null,preview);
 assert(html.includes('기억 +4 / ~2 / -1'),'미리보기 요약이 없음');
 assert(html.includes('회사 맥북'),'보낸 기기 이름이 없음');
 assert(html.includes('가져온 기기의 값'),'충돌 승자를 설명하지 않음');
 assert(html.includes('integrity check failed'),'거부 사유 원문이 없음');
 assert(!/data-archive="import" disabled/.test(html),'미리보기 뒤에는 가져오기가 열려야 함');
 assert(html.includes('축별로 세므로 더 클 수 있습니다'),'미리보기와 적용 결과의 셈 차이를 밝히지 않음');
 const failed=settingsPage.syncTab(syncCtx,{sync:true},syncStatus({enabled:true}),null,null,null,{path:'/x.zip',at:null,error:'sync archive is not a readable zip'});
 assert(failed.includes('sync archive is not a readable zip'),'검증 실패 사유를 그대로 보여주지 않음');
 assert(/data-archive="import" disabled/.test(failed),'검증이 실패했는데 가져오기가 열려 있음');
});
test('기기 이름은 이 기기와 다른 기기 모두에서 지정할 수 있다',()=>{
 const html=settingsPage.syncTab(syncCtx,{sync:true},syncStatus({enabled:true,deviceId:'device-aaa',deviceAlias:'집 맥미니',
  peers:[{deviceId:'device-bbb',alias:'회사 맥북',aliasIsLocal:false,isSelf:false,generation:'g2',exportedAt:null,hostname:'other',counts:null}]}),null,null);
 assert(html.includes('data-alias="device-aaa" data-alias-name="집 맥미니"'),'이 기기 이름 편집 버튼이 없음');
 assert(html.includes('data-alias="device-bbb" data-alias-name="회사 맥북"'),'다른 기기 이름 편집 버튼이 없음');
 assert(html.includes('상대 기기가 보낸 이름입니다'),'별칭의 출처를 구분하지 않음');
 const noId=settingsPage.syncTab(syncCtx,{sync:true},syncStatus(),null,null);
 assert(/data-alias="" data-alias-name="" disabled/.test(noId),'기기 ID가 없으면 이름 지정을 잠가야 함');
});
// --- #48 0.6.3: Chronicle SYNC_IMPORTED 충돌 이력 ---
const importedEvent=(outcome,extra={})=>({id:'event-sync-1',event_kind:'SYNC_IMPORTED',actor:'sync',fact_id:'11111111-1111-4111-8111-111111111111',
 previous_fact:'배포는 main에서 한다.',new_fact:'배포는 release 브랜치에서 한다.',projection_applied:0,
 effective_at:'2026-09-09T00:00:00.000Z',effective_at_source:'peer',recorded_at:'2026-09-10T00:00:00.000Z',created_at:'2026-09-10T00:00:00.000Z',
 outcome_json:outcome===null?null:JSON.stringify(outcome),...extra});
test('동기화 가져오기 이벤트는 어느 기기에서 왔고 누가 남았는지 밝힌다',()=>{
 assert.equal(name('SYNC_IMPORTED'),'동기화 가져옴');
 const peer=importedEvent({source_device_id:'device-bbb',source_device_alias:'회사 맥북',generation:'gen-9',winner:'peer',reason:'peer-newer'});
 const row=eventRow(peer);
 assert(row.includes('기기 회사 맥북에서 가져옴'),'출처 기기 라벨이 없음');
 assert(row.includes('가져온 값으로 대체됨'),'승자를 밝히지 않음');
 assert(row.includes('동기화 가져옴'),'이벤트 종류 라벨이 없음');
 const local=eventRow(importedEvent({source_device_id:'device-bbb',source_device_alias:null,generation:'gen-9',winner:'local',reason:'local-newer'}));
 assert(local.includes('기기 device-b에서 가져옴'),'별칭이 없으면 기기 ID 앞자리를 쓴다');
 assert(local.includes('이 기기의 값이 남음'),'로컬이 이긴 경우를 밝히지 않음');
 // 출처를 모르면 지어내지 않는다.
 assert.equal(syncOrigin(importedEvent(null)),null);
 assert.equal(syncOriginTag(importedEvent(null)),'');
 assert.equal(syncOrigin({event_kind:'CHANGED',outcome_json:'{"winner":"peer"}'}),null);
});
test('이벤트 상세는 가져온 기기·세대·판정 근거를 표로 보여준다',()=>{
 const html=details.eventDetail(ctx('',{}),importedEvent({source_device_id:'device-bbb',source_device_alias:'회사 맥북',generation:'generation-9999',winner:'peer',reason:'tie-broken-by-key'}));
 assert(html.includes('가져온 기기')&&html.includes('회사 맥북'));
 assert(html.includes('generati'),'세대 앞자리를 보여주지 않음');
 assert(html.includes('가져온 기기의 값'),'남은 값을 밝히지 않음');
 assert(html.includes('결정적 규칙'),'동시각 판정 근거를 설명하지 않음');
});
test('기억 상세 변경 이력에 기기 출처 라벨이 붙는다',async()=>{
 const fact={id:'11111111-1111-4111-8111-111111111111',fact:'배포는 release 브랜치에서 한다.',fact_kr:null,category:'decision',
  scope_type:'project',scope_project:'/workspace/memex',promotion_state:'project-current',is_active:1,source_total:0,
  sources:[],context_dependencies:[],relations:[],receipt:null,recalls:[],limits:{sources:500,revisions:200,relations:200,recalls:100},
  revisions:[importedEvent({source_device_id:'device-bbb',source_device_alias:'회사 맥북',generation:'gen-9',winner:'peer',reason:'peer-newer'})]};
 const {html}=await details.renderDetail(ctx('panelTab=history',{fact}),'fact',fact.id);
 assert(html.includes('기기 회사 맥북에서 가져옴'),'변경 이력에 출처 라벨이 없음');
 assert(html.includes('밀린 값')&&html.includes('남은 값'),'이전/이후를 충돌 의미로 바꿔 적지 않음');
 assert(html.includes('가져온 쪽의 의미 수정 시각이 더 최근입니다'),'판정 근거를 적지 않음');
});

test('코어에 동기화 서비스가 없으면 빈 화면 대신 이유를 말한다',()=>{
 const html=settingsPage.syncTab(syncCtx,{sync:false},null,null,null);
 assert(html.includes('dist/sync-control.js'));
 assert(!html.includes('data-sync='),'서비스가 없으면 실행 버튼을 만들지 않아야 합니다');
 const failed=settingsPage.syncTab(syncCtx,{sync:true},null,'권한이 없습니다',null);
 assert(failed.includes('권한이 없습니다'));
});

// --- #24 메뉴 이름 · 기본 범위 · 주입 범위 안내 · 공통 범위 원클릭 전환 ---
test('사이드바 메뉴와 기억 페이지 제목이 기억·사실로 통일된다',async()=>{
 // #109: 라벨은 사전으로 옮겼다 — 소스는 키를, 값은 ko 사전이 갖는다.
 assert(APP.includes("['/facts','memory',t('shell.nav.facts')]"),'app.mjs navigation이 사전 키를 쓰지 않음');
 assert.equal(ko['shell.nav.facts'],'기억·사실','ko 메뉴 라벨이 바뀌지 않음');
 const {html}=await renderFacts('',{facts:factsPage([row()])});
 assert(html.includes('<h1>기억·사실</h1>'),'페이지 제목이 바뀌지 않음');
});
test('조회 기본 범위는 공통 기억이 아니라 전체 프로젝트다',()=>{
 assert(APP.includes("export const DEFAULT_SCOPE='all'"),'기본 범위 상수가 all이 아님');
 assert(/const type=p\.get\('scope'\)\|\|\(p\.get\('project'\)\?'project':DEFAULT_SCOPE\)/.test(APP),'currentScope가 기본 범위 상수를 쓰지 않음');
 assert(APP.includes("u.searchParams.set('scope',DEFAULT_SCOPE)"),'기본 범위를 주소에 명시하지 않음');
});
test('범위 선택 옆에 주입 범위 안내를 상시 표시한다',()=>{
 // #109: 상수가 사전 조회 함수로 바뀌었다(설계 §2.6) — 문구는 shell 네임스페이스가 갖는다.
 assert(APP.includes("export const scopeHint=()=>t('shell.scope.hint')"),'scopeHint() 접근자 없음');
 const hint=ko['shell.scope.hint'];
 assert(hint,'shell.scope.hint 문구 없음');
 assert(hint.includes('공통 기억')&&hint.includes('조회'),'안내 문구가 주입·조회 범위를 설명하지 않음: '+hint);
 assert(APP.includes('id="scope-hint"'),'상시 안내 요소가 렌더링되지 않음');
});
test('범위 드롭다운은 전체 → 공통 → 프로젝트 순서로 기억 수와 함께 나열한다',()=>{
 const shell=APP.slice(APP.indexOf('const scopeOptions='));
 assert(shell.indexOf("'all',t('shell.scope.allProjectsOption')")<shell.indexOf("'global',t('common.commonMemory')"),'전체 프로젝트가 공통 기억보다 뒤에 있음');
 assert(shell.includes("t('shell.scope.projectGroup')"),'프로젝트 목록 그룹이 없음');
 assert(APP.includes("tn('shell.scope.factCount',n,{total:number(n)})"),'항목별 기억 수 표시가 없음');
 assert.equal(ko['shell.scope.allProjectsOption'],'전체 프로젝트 (조회)');
 assert.equal(ko['common.commonMemory'],'공통 기억');
 assert.equal(ko['shell.scope.factCount.other'],'기억 {total}개');
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

// ─────────────────────────────────────────────────────────────────────────────
// #31/#30 · 보류된 작업(memory_jobs.hold_reason) — 활동 · 추적 › 처리 작업
//
// 보류는 실패도 재시도 대기도 아니다. 상태만 보면 `pending`이라 "차례를 기다리는 중"으로
// 읽히지만, 사람이 설정을 고칠 때까지 시도조차 되지 않는다. 그래서 표는 (a) 사유 배지와
// (b) 그 사유를 **소유한 관리 탭**으로 가는 한 줄을 함께 실어야 한다.
// ─────────────────────────────────────────────────────────────────────────────
const HOLD_OWNER_TAB={
 model_config_rejected:'/settings?tab=models',
 extraction_rules_invalid:'/settings?tab=overlays&amp;overlay=rules',
 extraction_rules_unavailable:'/settings?tab=overlays&amp;overlay=rules',
};
const heldJobsPage=hold_reason=>({available:true,total:1,limit:40,offset:0,
 items:[{job_id:'job-held-1',kind:'fact_extract',session_id:'session-0',state:'pending',attempts:0,max_attempts:5,
  last_error:null,updated_at:'2026-09-10T00:00:00.000Z',hold_reason}]});

test('보류된 작업은 사유 배지와 소유 화면 링크를 함께 보여준다',async()=>{
 for(const [reason,href] of Object.entries(HOLD_OWNER_TAB)){
  const {html}=await activityPage.render(ctx('tab=jobs',{jobs:heldJobsPage(reason)}));
  assert(html.includes(ko['common.job.hold.'+reason]),`${reason}: 보류 사유 배지가 없음`);
  assert(html.includes(ko['activity.jobs.hold.next']),`${reason}: 다음 행동 한 줄이 없음`);
  assert(html.includes(`href="${href}"`),`${reason}: 소유 화면(${href}) 링크가 없음`);
  // 보류는 "기다리면 풀리는 재시도"로 설명되면 안 된다.
  assert(!html.includes(ko['guidance.job-retry.title']),`${reason}: 재시도 대기로 설명함`);
  assert(html.includes(ko['guidance.job-held.title']),`${reason}: 다음 행동 열에 보류 클래스가 없음`);
 }
});

test('보류가 아닌 대기 작업에는 보류 배지도 링크도 붙지 않는다',async()=>{
 const {html}=await activityPage.render(ctx('tab=jobs',{jobs:heldJobsPage(null)}));
 assert(!html.includes(ko['activity.jobs.hold.next']),'보류가 아닌 작업에 보류 안내가 붙음');
 for(const reason of Object.keys(HOLD_OWNER_TAB))assert(!html.includes(ko['common.job.hold.'+reason]),'보류 배지가 붙음: '+reason);
 assert(!html.includes('/settings?tab=models'),'불필요한 모델 설정 링크가 생김');
});

/**
 * #121 — 사용자 정의 fact 종류가 기억 페이지에 나타나는 두 자리.
 *
 * 칩의 값과 배지의 값이 **같은 문자열**이어야 한다는 것이 핵심이다: 그 문자열이 곧
 * `facts.category`에 저장된 값이고 서버가 `f.category=?`로 거르는 값이다. 칩 라벨과 필터 값이
 * 갈라지면 "이 배지가 붙은 기억만 보기"가 조용히 0건이 된다.
 */
test('기억 페이지의 종류 칩은 내장 5종 뒤에 사용자 정의 종류를 붙이고 값은 저장된 category다',async()=>{
 setCustomFactKinds([{id:'runbook',label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}]);
 try{
  const {html}=await renderFacts('category=runbook',{facts:factsPage([row({category:'runbook'})])});
  assert(html.includes('data-param-value="runbook"'),'사용자 정의 종류 칩이 없음');
  assert(html.includes('>운영 절차</button>'),'칩 라벨이 오버레이 라벨이 아님');
  // 내장 5종 뒤다 — 순서가 뒤집히면 익숙한 유형이 낯선 것 뒤로 밀린다.
  assert(html.indexOf('data-param-value="knowledge"')<html.indexOf('data-param-value="runbook"'));
  assert(/class="filter-chip active" data-param-key="category" data-param-value="runbook"/.test(html),'선택 상태가 반영되지 않음');
  // 선택된 칩과 행의 배지가 같은 라벨·설명을 쓴다.
  assert(html.includes('<span class="tag outline" title="운영 절차입니다.">운영 절차</span>'),'행 배지가 오버레이 라벨·설명을 쓰지 않음');
 }finally{setCustomFactKinds([]);}
});

/**
 * 0.7.5 후속 검토 P2 #5 — 레지스트리는 부팅 때 한 번 꽂는 값이 아니다.
 *
 * 규칙을 초기화하면 종류가 사라지는데, 부트스트랩을 다시 읽지 않으면 칩과 배지에는 지워진
 * 정의가 남는다. `syncCustomFactKinds()`가 그 재조회이고, **달라졌을 때만** true를 돌려주므로
 * `app.mjs`가 불필요한 재렌더를 하지 않는다.
 */
test('오버레이 초기화 뒤 재조회하면 종류 칩과 배지 라벨이 사라진다',async()=>{
 try{
  setCustomFactKinds([{id:'runbook',label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}]);
  const before=await renderFacts('',{facts:factsPage([row({category:'runbook'})])});
  assert(before.html.includes('data-param-value="runbook"'),'초기화 전에 칩이 있어야 한다');
  assert(before.html.includes('>운영 절차</span>'),'초기화 전에 배지가 라벨이어야 한다');

  // 규칙 초기화 = 부트스트랩이 빈 목록을 싣는다.
  assert.equal(await syncCustomFactKinds(async()=>[]),true,'목록이 달라졌는데 false를 돌려줌');
  const after=await renderFacts('',{facts:factsPage([row({category:'runbook'})])});
  assert(!after.html.includes('data-param-value="runbook"'),'초기화 뒤에도 칩이 남아 있음');
  assert(after.html.includes('>runbook</span>'),'정의가 사라졌는데 이전 라벨을 계속 씀');

  // 같은 값을 다시 읽으면 재렌더하지 않고, 재조회 실패는 직전 정의를 유지한다.
  assert.equal(await syncCustomFactKinds(async()=>[]),false,'달라지지 않았는데 true를 돌려줌');
  setCustomFactKinds([{id:'runbook',label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}]);
  assert.equal(await syncCustomFactKinds(async()=>{throw new Error('서버 연결 실패');}),false);
  assert.equal(name('runbook'),'운영 절차','재조회 실패가 라벨을 지웠다');
 }finally{setCustomFactKinds([]);}
});

/**
 * 0.7.6 후속 검토 P2 #4 — id 하나가 정의 하나가 아니다.
 *
 * 두 프로젝트가 `runbook`을 서로 다른 라벨·설명으로 정의할 수 있는데, 레지스트리가 id로만
 * 합치면 오버레이 파일에서 먼저 나온 정의가 두 프로젝트의 기억에 모두 붙는다. 전체 보기에서는
 * 두 프로젝트의 기억이 한 화면에 섞이므로 이 실패가 그대로 보인다.
 */
const KINDS_BY_PROJECT=[
 {id:'runbook',global:false,projects:['/work/alpha'],label_en:'Alpha runbook',label_ko:'알파 운영 절차',description:'알파의 복구 절차입니다.'},
 {id:'runbook',global:false,projects:['/work/beta'],label_en:'Beta runbook',label_ko:'베타 운영 절차',description:'베타의 복구 절차입니다.'}];

test('전체 보기에서 같은 종류 id를 가진 기억은 각자 자기 프로젝트의 라벨로 표시된다',async()=>{
 setCustomFactKinds(KINDS_BY_PROJECT);
 try{
  const {html}=await renderFacts('',{facts:factsPage([
   row({id:'11111111-1111-4111-8111-11111111aaaa',category:'runbook',scope_project:'/work/alpha'}),
   row({id:'11111111-1111-4111-8111-11111111bbbb',category:'runbook',scope_project:'/work/beta'})])});
  assert(html.includes('<span class="tag outline" title="알파의 복구 절차입니다.">알파 운영 절차</span>'),'alpha 기억이 자기 프로젝트 라벨을 쓰지 않음');
  assert(html.includes('<span class="tag outline" title="베타의 복구 절차입니다.">베타 운영 절차</span>'),'beta 기억이 alpha의 라벨로 표시됨');
  // 칩은 저장된 값 하나당 하나다 — 같은 필터를 두 번 그리지 않는다.
  assert.equal(html.split('data-param-value="runbook"').length-1,1,'같은 id로 칩을 두 개 그림');
  // 파일 순서를 뒤집어도 각 기억의 의미는 그대로여야 한다.
  setCustomFactKinds([KINDS_BY_PROJECT[1],KINDS_BY_PROJECT[0]]);
  const flipped=await renderFacts('',{facts:factsPage([row({category:'runbook',scope_project:'/work/beta'})])});
  assert(flipped.html.includes('>베타 운영 절차</span>'),'오버레이 키 순서가 저장된 값의 의미를 바꿨다');
 }finally{setCustomFactKinds([]);}
});

test('전역 정의는 override가 없는 프로젝트의 대체값이고, 그것도 없으면 코어 원문이다',()=>{
 setCustomFactKinds([
  {id:'runbook',global:true,projects:['/work/beta'],label_en:'Runbook step',label_ko:'운영 절차',description:'공용 운영 절차입니다.'}]);
 try{
  assert.equal(name('runbook','/work/beta'),'운영 절차','전역 정의를 그대로 쓰는 프로젝트가 라벨을 못 찾았다');
  assert.equal(name('runbook','/work/gamma'),'운영 절차','override가 없는 프로젝트가 전역 정의로 떨어지지 않았다');
  assert.equal(name('runbook',null),'운영 절차','글로벌 기억이 전역 정의를 쓰지 않았다');
  setCustomFactKinds([KINDS_BY_PROJECT[0]]);
  assert.equal(name('runbook','/work/gamma'),'runbook','대체할 전역 정의가 없는데 남의 라벨을 빌려 썼다');
 }finally{setCustomFactKinds([]);}
});

/**
 * 0.7.7 후속 검토 P2 #2 — 우선순위는 화면과 추출기에서 **하나**여야 한다.
 *
 * 추출기의 `resolveFromDoc()`는 전역 우선으로 중복을 지우므로 프로젝트 override가 전역 id의 뜻을
 * 바꿀 수 없다. UI가 프로젝트를 먼저 보면 같은 `facts.category` 값이 프롬프트에서는 전역 정의로
 * 추출되고 화면에서는 프로젝트의 라벨·설명으로 읽힌다 — 저장된 값의 의미가 둘로 갈린다. 서버는
 * 이제 그런 override를 `KIND_ID_SHADOWS_GLOBAL`로 거부하고 레지스트리도 전역 행에 프로젝트 이름만
 * 더하지만, 그 조합이 들어와도 화면은 추출기와 같은 답을 해야 한다.
 */
test('전역 정의가 있는 id는 프로젝트 override가 아니라 전역 정의로 표시된다',async()=>{
 setCustomFactKinds([
  {id:'runbook',global:true,projects:[],label_en:'Runbook step',label_ko:'운영 절차',description:'공용 운영 절차입니다.'},
  {id:'runbook',global:false,projects:['/work/beta'],label_en:'Beta runbook',label_ko:'베타 운영 절차',description:'베타의 복구 절차입니다.'}]);
 try{
  const {html}=await renderFacts('',{facts:factsPage([row({category:'runbook',scope_project:'/work/beta'})])});
  // 라벨과 툴팁은 **같은 정의**에서 와야 하고, 그 정의는 추출기가 쓴 전역 정의다.
  assert(html.includes('<span class="tag outline" title="공용 운영 절차입니다.">운영 절차</span>'),
   '기억 배지가 추출기와 다른 정의를 씀');
  assert(!html.includes('베타 운영 절차'),'프로젝트 override가 전역 정의를 가렸다');
  assert.equal(name('runbook','/work/beta'),'운영 절차','라벨이 전역 정의를 쓰지 않음');
  // 전역 정의가 **없는** id는 여전히 프로젝트가 고른다(0.7.6 후속 검토 P2 #4).
  setCustomFactKinds(KINDS_BY_PROJECT);
  assert.equal(name('runbook','/work/beta'),'베타 운영 절차','전역 정의가 없는데 프로젝트 정의를 쓰지 않았다');
 }finally{setCustomFactKinds([]);}
});

/**
 * 0.7.7 후속 검토 P2 #3 — 칩은 정의를 이미 들고 있는데 id로 다시 조회했다.
 *
 * 조회 키는 `(project, id)`이고 칩에는 프로젝트가 없다. 그래서 프로젝트 override에만 있는 종류는
 * 라벨이 있는데도 전역 정의 없음으로 떨어져 원시 id로 떴다. 칩은 범위와 무관하게 id마다 하나이므로
 * 프로젝트 범위와 전체 보기 둘 다에서 같은 실패였다.
 */
test('프로젝트 override에만 있는 종류도 칩에 그 정의의 라벨로 뜬다',async()=>{
 setCustomFactKinds([{id:'runbook',global:false,projects:['/work/beta'],label_en:'Beta runbook',label_ko:'베타 운영 절차',description:'베타의 복구 절차입니다.'}]);
 try{
  for(const scope of [{scope:'all'},{scope:'project',project:'/work/beta'}]){
   const {html}=await facts.render(ctx('',{taxonomy:TAXONOMY,facts:factsPage([row({category:'runbook',scope_project:'/work/beta'})])},{scope}));
   assert(html.includes('data-param-value="runbook">베타 운영 절차</button>'),
    scope.scope+' 범위: 칩 라벨이 오버레이 라벨이 아님');
   assert(!/data-param-value="runbook">runbook</.test(html),scope.scope+' 범위: 칩이 원시 id로 떴다');
  }
 }finally{setCustomFactKinds([]);}
});

/**
 * 0.7.6 후속 검토 P2 #3 — 늦게 도착한 재조회 응답이 삭제된 종류를 되살렸다.
 *
 * SSE `change`와 `invalidate()`가 겹치면 재조회가 동시에 두 개 뜨고, 응답 순서는 보장되지
 * 않는다. 세대를 검사하지 않으면 "초기화 뒤의 빈 목록"이 먼저 도착해 칩을 지운 다음 그 전에
 * 시작한 옛 목록이 나중에 도착해 지운 칩을 되돌린다. 여기서는 Promise 완료 순서를 직접
 * 제어해 그 순서를 재현한다.
 */
test('나중에 시작한 재조회가 이긴다 — 늦게 도착한 옛 응답은 레지스트리를 되살리지 않는다',async()=>{
 const RUNBOOK=[{id:'runbook',label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}];
 try{
  setCustomFactKinds(RUNBOOK);
  let releaseOld;
  const oldResponse=new Promise(resolve=>{releaseOld=()=>resolve(RUNBOOK);});
  // 1) 먼저 시작한 재조회(옛 목록). 아직 응답하지 않는다.
  const older=syncCustomFactKinds(()=>oldResponse);
  // 2) 나중에 시작한 재조회(초기화 뒤의 빈 목록)가 **먼저** 완료된다.
  assert.equal(await syncCustomFactKinds(async()=>[]),true,'최신 응답이 적용되지 않았다');
  assert.deepEqual(customFactKinds(),[],'최신 빈 응답이 레지스트리를 비우지 못했다');
  // 3) 이제 옛 응답이 도착한다 — 버려져야 한다.
  releaseOld();
  assert.equal(await older,false,'낡은 응답이 재렌더를 요구했다');
  assert.deepEqual(customFactKinds(),[],'늦게 도착한 옛 응답이 삭제된 종류를 되살렸다');
  assert.equal(name('runbook'),'runbook','삭제된 종류의 라벨이 되살아났다');

  // 세대는 소모되지 않는다: 다음 재조회는 정상적으로 적용된다.
  assert.equal(await syncCustomFactKinds(async()=>RUNBOOK),true,'다음 재조회가 막혔다');
  assert.equal(name('runbook'),'운영 절차');
 }finally{setCustomFactKinds([]);}
});

test('app.mjs는 저장·초기화(invalidate)와 SSE 변경에서 종류 레지스트리를 재조회한다',()=>{
 assert(/invalidate\(\)\{[^}]*refreshFactKinds\(\)/.test(APP),'ctx.invalidate()가 종류를 재조회하지 않음');
 assert(/addEventListener\('change',\(\)=>\{[^}]*refreshFactKinds\(\)/.test(APP),'SSE change가 종류를 재조회하지 않음');
 assert(/async function refreshFactKinds\(\)/.test(APP),'refreshFactKinds가 없음');
 // 0.7.6 후속 검토 P2 #5 — 재조회는 **부트스트랩이 아니라** 종류만 싣는 경로를 읽는다.
 assert(/scheduleCustomFactKindsSync\(\(\)=>request\('fact-kinds'\)\)/.test(APP),
  '재조회가 종류 전용 엔드포인트를 쓰지 않음');
 const refreshBody=APP.slice(APP.indexOf('async function refreshFactKinds'),APP.indexOf('async function boot('));
 assert(refreshBody&&!refreshBody.includes("request('bootstrap')"),'재조회가 아직 부트스트랩 전체를 다시 읽음');
 assert(/setCustomFactKindsHash\(bootstrap\.customFactKindsHash\)/.test(APP),
  '부팅이 서버 지문을 기억하지 않음 — 첫 change에서 불필요한 재렌더가 난다');
});

/**
 * 0.7.6 후속 검토 P2 #5 — 모든 변경 이벤트가 전체 집계를 다시 돌렸다.
 *
 * SSE `change`는 오버레이 변경만이 아니라 DB·로그 변경에도 뜨고, 요청 병합이 없어 탭 수 ×
 * 변경 빈도만큼 조회가 나갔다. 연속 알림은 하나로 합쳐지고, 서버 지문이 그대로면 목록을 꽂지도
 * 다시 그리지도 않아야 한다.
 */
test('연속된 변경 알림은 한 번의 조회로 합쳐진다',async()=>{
 try{
  setCustomFactKinds([]);setCustomFactKindsHash(null);
  let calls=0;
  const load=async()=>{calls++;return {customFactKinds:[{id:'runbook',global:true,projects:[],label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}],hash:'h1'};};
  const results=await Promise.all([1,2,3,4,5].map(()=>scheduleCustomFactKindsSync(load,1)));
  assert.equal(calls,1,'변경 5건에 조회가 '+calls+'번 나갔다');
  assert.deepEqual(results,[true,true,true,true,true],'합쳐진 호출이 결과를 받지 못했다(누수)');
  assert.equal(name('runbook'),'운영 절차','합쳐진 조회가 목록을 꽂지 않았다');
 }finally{setCustomFactKinds([]);setCustomFactKindsHash(null);}
});

test('서버 지문이 그대로면 목록을 꽂지도 다시 그리지도 않는다',async()=>{
 try{
  setCustomFactKinds([]);setCustomFactKindsHash(null);
  const payload={customFactKinds:[{id:'runbook',global:true,projects:[],label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}],hash:'h1'};
  assert.equal(await scheduleCustomFactKindsSync(async()=>payload,1),true,'첫 조회가 적용되지 않았다');
  // 같은 지문 = 오버레이가 그대로다. 목록을 건드리면 화면이 통째로 다시 그려진다.
  let applied=false;
  assert.equal(await scheduleCustomFactKindsSync(async()=>{applied=true;return {customFactKinds:[],hash:'h1'};},1),false,
   '지문이 같은데 재렌더를 요구했다');
  assert(applied,'로더는 불렸어야 한다 — 건너뛰는 것은 적용이지 조회가 아니다');
  assert.equal(name('runbook'),'운영 절차','지문이 같은데 목록을 갈아 끼웠다');
  // 지문이 달라지면 그때 적용한다.
  assert.equal(await scheduleCustomFactKindsSync(async()=>({customFactKinds:[],hash:'h2'}),1),true,'지문이 달라졌는데 적용하지 않았다');
  assert.equal(name('runbook'),'runbook');
 }finally{setCustomFactKinds([]);setCustomFactKindsHash(null);}
});

/**
 * 0.7.7 후속 검토 P2 #1 — 세대 검사가 디바운스 경로를 지나지 않았다.
 *
 * 세대를 `load()`가 **끝난 뒤에** 떼면 먼저 출발한 조회가 늦게 도착하면서 더 큰 번호를 받는다.
 * 그래서 초기화 뒤의 빈 목록이 먼저 적용되고도 그 전에 시작한 옛 목록이 나중에 도착해
 * 레지스트리와 서버 지문을 함께 되살렸다. 여기서는 두 디바운스 조회의 완료 순서를 뒤집는다.
 */
test('디바운스된 재조회도 세대를 지킨다 — 먼저 시작해 늦게 도착한 응답은 버려진다',async()=>{
 const RUNBOOK=[{id:'runbook',global:true,projects:[],label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}];
 try{
  setCustomFactKinds([]);setCustomFactKindsHash(null);
  let releaseOld;
  const oldPayload=new Promise(resolve=>{releaseOld=()=>resolve({customFactKinds:RUNBOOK,hash:'hA'});});
  // A: 먼저 시작한 조회. 타이머는 발화했고 응답은 아직 오지 않았다.
  const older=scheduleCustomFactKindsSync(()=>oldPayload,1);
  await new Promise(resolve=>setTimeout(resolve,10));
  // B: 나중에 시작한 조회(초기화 뒤의 빈 목록)가 **먼저** 완료된다.
  assert.equal(await scheduleCustomFactKindsSync(async()=>({customFactKinds:[],hash:'hB'}),1),false,
   '이미 비어 있는 레지스트리를 바꿨다고 보고했다');
  // 이제 A의 응답이 도착한다 — 버려져야 한다.
  releaseOld();
  assert.equal(await older,false,'낡은 응답이 재렌더를 요구했다');
  assert.deepEqual(customFactKinds(),[],'늦게 도착한 옛 응답이 삭제된 종류를 되살렸다');
  assert.equal(name('runbook'),'runbook','삭제된 종류의 라벨이 되살아났다');
  // 서버 지문도 낡은 응답이 덮지 않았다 — hB가 그대로여야 같은 지문의 다음 알림이 적용을 건너뛴다.
  let applied=false;
  assert.equal(await scheduleCustomFactKindsSync(async()=>{applied=true;return {customFactKinds:RUNBOOK,hash:'hB'};},1),false,
   '낡은 응답이 서버 지문을 자기 것으로 덮었다');
  assert(applied,'로더는 불렸어야 한다');
  assert.deepEqual(customFactKinds(),[],'지문이 같은데 목록을 갈아 끼웠다');
 }finally{setCustomFactKinds([]);setCustomFactKindsHash(null);}
});

/**
 * 0.7.8 후속 검토 P2 #2 — 예약과 발화 사이의 250ms가 새는 창이었다.
 *
 * 세대를 타이머 **발화** 때 떼면 예약만 된 재조회는 이미 나간 조회의 적용 권한을 빼앗지 못한다.
 * 그래서 초기화 알림이 예약돼 있는데도 그 전에 출발한 옛 목록이 도착해 칩과 서버 지문을 되살리고,
 * 예약된 조회까지 실패하면 삭제된 종류가 최종 상태로 남았다. 여기서는 그 순서를 그대로 만든다.
 */
test('재조회 예약만으로도 이미 나간 옛 조회는 적용 권한을 잃는다',async()=>{
 const RUNBOOK=[{id:'runbook',global:true,projects:[],label_en:'Runbook step',label_ko:'운영 절차',description:'운영 절차입니다.'}];
 try{
  // 초기화가 이미 적용된 상태: 목록은 비었고 서버 지문은 hB다.
  setCustomFactKinds([]);setCustomFactKindsHash('hB');
  let releaseOld;
  const oldPayload=new Promise(resolve=>{releaseOld=()=>resolve({customFactKinds:RUNBOOK,hash:'hA'});});
  // A: 타이머가 발화해 조회가 이미 나갔다. 응답은 아직 오지 않았다.
  const older=scheduleCustomFactKindsSync(()=>oldPayload,1);
  await new Promise(resolve=>setTimeout(resolve,10));
  // B: 새 알림이 재조회를 **예약**한다. 아직 발화하지 않았다 — 그래도 A는 이 순간 적용 권한을
  //    잃어야 한다. 조회가 실패할 수도 있으므로, B의 성공이 A를 덮어 준다는 보장은 없다.
  const newer=scheduleCustomFactKindsSync(async()=>{throw new Error('서버 연결 실패');},60);
  // A의 응답이 B의 대기 안에 도착한다.
  releaseOld();
  assert.equal(await older,false,'예약만 된 재조회가 낡은 응답을 막지 못했다');
  assert.deepEqual(customFactKinds(),[],'대기 중 도착한 낡은 응답이 삭제된 종류를 되살렸다');
  assert.equal(name('runbook'),'runbook','삭제된 종류의 라벨이 되살아났다');
  // B는 발화해서 실패한다 — 그래도 레지스트리는 A 이전 그대로여야 한다.
  assert.equal(await newer,false,'실패한 조회가 재렌더를 요구했다');
  assert.deepEqual(customFactKinds(),[],'B가 실패하자 낡은 목록이 최종 상태로 남았다');
  // 서버 지문도 낡은 응답이 덮지 않았다: hB가 그대로라 같은 지문의 다음 알림은 적용을 건너뛴다.
  let applied=false;
  assert.equal(await scheduleCustomFactKindsSync(async()=>{applied=true;return {customFactKinds:RUNBOOK,hash:'hB'};},1),false,
   '낡은 응답이 서버 지문을 hA로 덮었다');
  assert(applied,'로더는 불렸어야 한다');
  assert.deepEqual(customFactKinds(),[],'지문이 같은데 목록을 갈아 끼웠다');
 }finally{setCustomFactKinds([]);setCustomFactKindsHash(null);}
});

/**
 * 0.7.8 후속 검토 P2 #3 — 칩과 배지가 같은 값을 두 이름으로 불렀다.
 *
 * 라벨을 정의 자체에서 고르게 한 0.7.7 수정은 원시 id 노출만 막았다. 칩 목록은 범위를 받지 않아
 * id별 **첫** 정의를 남겼고, 기억 배지는 `(project, id)`로 조회한다. 전역 정의 없이 두 프로젝트가
 * 같은 id를 다르게 정의하면 `/beta` 화면에서 칩은 alpha, 배지는 beta가 된다 — 저장된 값 하나의
 * 뜻이 같은 화면에서 갈린다. override 순서를 바꿔도 답은 같아야 한다.
 */
test('프로젝트 범위의 칩은 그 프로젝트의 정의를 쓴다 — 남의 프로젝트 라벨을 빌려 오지 않는다',async()=>{
 try{
  for(const order of [KINDS_BY_PROJECT,[KINDS_BY_PROJECT[1],KINDS_BY_PROJECT[0]]]){
   setCustomFactKinds(order);
   const {html}=await facts.render(ctx('',{taxonomy:TAXONOMY,facts:factsPage([row({category:'runbook',scope_project:'/work/beta'})])},{scope:{scope:'project',project:'/work/beta'}}));
   assert(html.includes('data-param-value="runbook">베타 운영 절차</button>'),'칩이 beta의 정의를 쓰지 않음');
   assert(!html.includes('알파 운영 절차'),'beta 범위에 alpha의 라벨이 떴다');
   // 칩과 배지는 **같은 정의**를 말해야 한다.
   assert(html.includes('<span class="tag outline" title="베타의 복구 절차입니다.">베타 운영 절차</span>'),'배지가 칩과 다른 정의를 씀');
   assert.equal(html.split('data-param-value="runbook"').length-1,1,'같은 id로 칩을 두 개 그림');
  }
  // 전역 정의가 있으면 추출기와 같이 그것이 이긴다 — 프로젝트 범위에서도.
  setCustomFactKinds([
   {id:'runbook',global:true,projects:[],label_en:'Runbook step',label_ko:'운영 절차',description:'공용 운영 절차입니다.'},
   KINDS_BY_PROJECT[1]]);
  const shadowed=await facts.render(ctx('',{taxonomy:TAXONOMY,facts:factsPage([row({category:'runbook',scope_project:'/work/beta'})])},{scope:{scope:'project',project:'/work/beta'}}));
  assert(shadowed.html.includes('data-param-value="runbook">운영 절차</button>'),'전역 정의가 있는데 칩이 override 라벨을 씀');
  // 다른 프로젝트만 아는 id는 이 범위에서 아무것도 고르지 못하므로 칩이 되지 않는다.
  setCustomFactKinds([KINDS_BY_PROJECT[0]]);
  const foreign=await facts.render(ctx('',{taxonomy:TAXONOMY,facts:factsPage([row()])},{scope:{scope:'project',project:'/work/beta'}}));
  assert(!foreign.html.includes('data-param-value="runbook"'),'남의 프로젝트 종류가 이 범위의 칩으로 떴다');
  // 전체 보기에서는 모든 프로젝트의 기억이 섞이므로 id마다 칩을 그린다.
  const all=await facts.render(ctx('',{taxonomy:TAXONOMY,facts:factsPage([row({category:'runbook',scope_project:'/work/alpha'})])},{scope:{scope:'all'}}));
  assert(all.html.includes('data-param-value="runbook">알파 운영 절차</button>'),'전체 보기에서 칩이 사라졌다');
 }finally{setCustomFactKinds([]);}
});

test('종류 재조회 디바운스 기본값은 250ms다',()=>{
 assert.equal(FACT_KINDS_SYNC_DEBOUNCE_MS,250);
});

test('정의되지 않은 종류로 저장된 기억은 코어 원문 그대로 보이고 칩도 만들지 않는다',async()=>{
 setCustomFactKinds([]);
 const {html}=await renderFacts('',{facts:factsPage([row({category:'postmortem'})])});
 assert(html.includes('>postmortem</span>'),'모르는 종류의 이름을 지어냄');
 assert(!html.includes('data-param-value="postmortem"'),'정의되지 않은 종류로 칩을 만듦');
});

// ── 0.7.9 후속 검토 P2 #1/#2 — 전체 보기의 충돌 id와 공통 기억 범위의 칩 ──────────────
test('전체 보기에서 전역 정의 없이 두 프로젝트가 같은 id를 다르게 정의하면 칩은 파일 순서와 무관하게 원시 id를 보여 준다',async()=>{
 const alpha={id:'runbook',projects:['/alpha'],label_en:'Alpha runbook',label_ko:'알파 운영 절차',description:'a'};
 const beta={id:'runbook',projects:['/beta'],label_en:'Beta runbook',label_ko:'베타 운영 절차',description:'b'};
 for(const order of [[alpha,beta],[beta,alpha]]){
  setCustomFactKinds(order);
  const {html}=await renderFacts('',{facts:factsPage([row({category:'runbook',scope_project:'/beta'})])});
  assert(/data-param-value="runbook">runbook</.test(html),'충돌 id의 칩이 한 프로젝트의 라벨을 대표함: '+order.map(k=>k.label_en).join(','));
  assert(html.includes('베타 운영 절차'),'배지는 여전히 자기 프로젝트 정의를 써야 한다');
 }
 // 두 프로젝트의 정의가 같으면 그 라벨을 그대로 쓴다.
 setCustomFactKinds([alpha,{...alpha,projects:['/beta']}]);
 const same=await renderFacts('',{facts:factsPage([row({category:'runbook',scope_project:'/beta'})])});
 assert(/data-param-value="runbook">알파 운영 절차</.test(same.html),'동일 정의는 라벨을 보여 줘야 한다');
 setCustomFactKinds([]);
});

test('공통 기억 범위에서는 프로젝트 전용 종류의 칩이 그려지지 않는다',async()=>{
 setCustomFactKinds([{id:'runbook',projects:['/alpha'],label_en:'Alpha runbook',label_ko:'알파 운영 절차',description:'a'},{id:'policy',global:true,projects:[],label_en:'Policy',label_ko:'정책',description:'p'}]);
 const {html}=await facts.render(ctx('',{taxonomy:TAXONOMY,facts:factsPage([row({category:'policy',scope_project:null})])},{scope:{scope:'global'}}));
 assert(!html.includes('data-param-value="runbook"'),'프로젝트 전용 종류가 공통 범위 칩에 나옴');
 assert(/data-param-value="policy">정책</.test(html),'전역 종류의 칩은 있어야 한다');
 setCustomFactKinds([]);
});
