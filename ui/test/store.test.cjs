'use strict';
const {ko}=require('./helpers/locale.cjs');
require('./helpers/locale.cjs').useKo();   // #109: 기존 한국어 단정은 ko 로케일에서 그대로 통과한다.
const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const {fixture,uid,PROJECT,OTHER}=require('./fixture.cjs');const {Logs}=require('../lib/logs.cjs');const fs=require('node:fs');const path=require('node:path');
let f,store;const q=x=>new URLSearchParams(x),scope=(x={})=>store.scope(q(x));
before(()=>{f=fixture();store=f.store;});after(()=>{f.close();fs.rmSync(f.home,{recursive:true,force:true});});
test('global is the safe default, not all projects',()=>{const r=store.facts(q({state:'all'}),scope());assert.equal(r.total,6);assert(r.items.every(x=>x.scope_type==='global'));assert.equal(store.sessions(q(),scope()).total,0);});
test('project includes globals and excludes unpromoted local facts',()=>{const s=scope({scope:'project',project:PROJECT});const r=store.facts(q({state:'all',limit:200}),s);assert.equal(r.total,70);assert(!r.items.some(x=>x.id===uid(65)||x.id===uid(66)));assert(r.items.every(x=>x.scope_project===PROJECT||x.scope_type==='global'));});
test('global inclusion is independently switchable',()=>assert.equal(store.facts(q({state:'all'}),scope({scope:'project',project:PROJECT,includeGlobal:'0'})).total,64));
test('explicit all projects reveals the complete fixture',()=>assert.equal(store.facts(q({state:'all'}),scope({scope:'all'})).total,84));
test('the scope total is reported next to the filtered total',()=>{const s=scope({scope:'all'});assert.equal(store.facts(q({state:'all'}),s).scopeTotal,84);const none=store.facts(q({q:'존재하지 않는 문자열'}),s);assert.equal(none.total,0);assert.equal(none.scopeTotal,84);assert.equal(store.facts(q(),scope()).scopeTotal,6);assert.equal(store.facts(q(),scope({scope:'project',project:OTHER,includeGlobal:'0'})).scopeTotal,12);});
test('범위 선택 라벨용 기억 수는 활성 기억만 프로젝트별로 센다',()=>{
 const list=store.projects();
 const memex=list.find(x=>x.project===PROJECT),other=list.find(x=>x.project===OTHER);
 // 라벨의 수는 계층과 무관하게 그 프로젝트에 저장된 활성 기억이다. 기본 술어가 감추는 브랜치 계층 기억도 포함한다(#22).
 const stored=p=>store.count("SELECT COUNT(*) AS n FROM facts WHERE is_active=1 AND scope_type='project' AND scope_project=?",[p]);
 assert.equal(memex.facts,stored(PROJECT));
 assert.equal(other.facts,stored(OTHER));
 assert(memex.facts>store.facts(q({limit:'200'}),scope({scope:'project',project:PROJECT,includeGlobal:'0'})).total,'계층으로 가려진 기억이 수에서 빠졌습니다');
 const totals=store.factTotals();
 assert.equal(totals.global,store.facts(q(),scope()).total);
 assert.equal(totals.all,store.facts(q({limit:'200'}),scope({scope:'all'})).total);
 assert.equal(totals.all,memex.facts+other.facts+totals.global);
});
test('workspace scope adds only matching promoted rows',()=>{const s=scope({scope:'project',project:PROJECT,workspace:'workspace-0'});assert.equal(store.facts(q({state:'all'}),s).total,71);});
test('workstream selection adds only its local facts',()=>{const s=scope({scope:'project',project:PROJECT,workspace:'workspace-0',workstream:'stream-5'});assert.equal(store.facts(q({state:'all'}),s).total,72);});
test('프로젝트 화면은 술어 밖의 계층 기억 수를 함께 돌려준다',()=>{
 const base=scope({scope:'project',project:PROJECT});
 const page=store.facts(q({state:'all',limit:'200'}),base);
 assert.deepEqual(page.hiddenByTier,{workstream:1,workspace:1});
 assert.equal(page.tiers,'default');
 // 선택으로 이미 보이는 계층은 "숨겨진" 수에서 빠진다.
 assert.deepEqual(store.facts(q(),scope({scope:'project',project:PROJECT,workspace:'workspace-0'})).hiddenByTier,{workstream:1,workspace:0});
 assert.deepEqual(store.facts(q(),scope({scope:'project',project:PROJECT,workspace:'workspace-0',workstream:'stream-5'})).hiddenByTier,{workstream:0,workspace:0});
 assert.equal(store.facts(q(),scope({scope:'all'})).hiddenByTier,null);
 assert.equal(store.facts(q(),scope()).hiddenByTier,null);
});
test('tiers=all은 같은 프로젝트의 모든 계층을 포함하되 프로젝트 경계는 넓히지 않는다',()=>{
 const wide=store.facts(q({state:'all',limit:'200'}),scope({scope:'project',project:PROJECT,tiers:'all'}));
 assert.equal(wide.tiers,'all');
 assert.equal(wide.total,store.facts(q({state:'all',limit:'200'}),scope({scope:'project',project:PROJECT})).total+2);
 assert(wide.items.some(x=>x.id===uid(65))&&wide.items.some(x=>x.id===uid(66)),'브랜치·워크스페이스 계층 기억이 포함되지 않음');
 assert(wide.items.every(x=>x.scope_project===PROJECT||x.scope_type==='global'),'다른 프로젝트가 새어 들어옴');
 // 배너를 되돌릴 수 있어야 하므로 tiers=all에서도 수는 그대로 보고한다.
 assert.deepEqual(wide.hiddenByTier,{workstream:1,workspace:1});
 assert.throws(()=>scope({scope:'project',project:PROJECT,tiers:'branch'}),{status:400});
});
test('브랜치 계층 기억은 작업 흐름의 브랜치 이름을 함께 싣는다',()=>{
 const s=scope({scope:'project',project:PROJECT,tiers:'all'});
 const branchFact=store.facts(q({state:'all',limit:'200'}),s).items.find(x=>x.id===uid(66));
 assert.equal(branchFact.promotion_state,'workstream');
 assert.equal(branchFact.tier_reason,'branch:feature/tier-ladder');
 assert.equal(branchFact.workstream_branch,'ui/redesign');
 assert.equal(store.fact(uid(66),s).workstream_branch,'ui/redesign');
});
test('foreign workspace and malformed scopes fail closed',()=>{assert.throws(()=>scope({scope:'project',project:PROJECT,workspace:'workspace-1'}),{status:403});assert.throws(()=>scope({scope:'project',project:'relative/path'}),{status:400});assert.throws(()=>scope({scope:'all',project:PROJECT}),{status:400});assert.throws(()=>scope({scope:'unknown'}),{status:400});});
test('cross-project fact and raw exchange reads are denied',()=>{const s=scope({scope:'project',project:PROJECT});assert.throws(()=>store.fact(uid(73),s),{status:404});assert.throws(()=>store.exchange('exchange-1200',s),{status:404});assert.throws(()=>store.job('job-12',s),{status:404});});
test('global fact never discloses project-bound source text in global scope',()=>{const r=store.fact(uid(67),scope());assert(r.sources.every(x=>x.unavailable&&!x.user_message));assert.equal(r.receipt.source_snapshot_json,undefined);});
test('direct sources and context dependencies stay separate',()=>{const r=store.fact(uid(1),scope({scope:'project',project:PROJECT}));assert.equal(r.sources[0].id,'exchange-0');assert.equal(r.context_dependencies[0].exchange_id,'exchange-1');assert(r.provenance_parse_valid);});
test('pagination and exact substring search are bounded and parameterized',()=>{const s=scope({scope:'all'});assert.equal(store.facts(q({limit:'7',offset:'7'}),s).items.length,7);assert.equal(store.facts(q({q:"' OR 1=1 --"}),s).total,0);assert.throws(()=>store.facts(q({limit:'-1'}),s),{status:400});assert.throws(()=>store.facts(q({offset:'1000001'}),s),{status:400});});
test('session detail has real turn pagination and related records',()=>{const d=store.session('session-0',q({limit:20,offset:20}),scope({scope:'project',project:PROJECT}));assert.equal(d.total,26);assert.equal(d.items.length,6);assert.equal(d.items[0].id,'exchange-20');assert(d.jobs.length&&d.recalls.length&&d.capsule);});
test('job details link actual IDs and do not call related facts direct outputs',()=>{const d=store.job('job-4',scope({scope:'project',project:PROJECT}));assert.equal(d.items.length,5);assert.equal(d.failures.length,1);assert.equal(d.attempts[0].job_id,'job-4');// #109: 서버는 프로즈를 만들지 않고 키만 싣는다(설계 §5.3 분류 c).
 assert.equal(d.relatedFactsBasisKey,'note.job.relatedFactsBasis');
 assert.match(ko['note.job.relatedFactsBasis'],/직접 산출물.*의미하지/);});
test('model attempts without target_id still scope through job.target_id',()=>{assert(store.attempts(q(),scope({scope:'project',project:PROJECT})).items.some(x=>x.attempt_id==='attempt-2'));});
test('missing token usage remains null, not zero',()=>{const d=store.attempts(q({id:'attempt-0'}),scope({scope:'all'})).items[0];assert.equal(d.duration_ms,null);assert.equal(d.token_usage_json,null);assert.equal(d.token_usage_status,'NOT_PROVEN');});
test('graph edge endpoints and focus results are scoped',()=>{const s=scope({scope:'project',project:PROJECT});const d=store.graph(q({limit:20}),s);const ids=new Set(d.nodes.map(n=>n.id));assert(d.edges.every(e=>ids.has(e.source_fact_id)&&ids.has(e.target_fact_id)));assert(d.truncated);const focused=store.graph(q({focus:uid(1)}),s);assert(focused.nodes.some(n=>n.id===uid(1)));assert.throws(()=>store.graph(q({types:'INVALID'}),s),{status:400});});
test('taxonomy counts sum to active scoped facts including unclassified',()=>{const s=scope({scope:'project',project:PROJECT});const d=store.taxonomy(s);assert.equal(d.categories.reduce((n,c)=>n+c.facts,0)+d.unclassified,store.facts(q(),s).total);});
test('Chronicle events and recalls preserve two clocks and supplied status',()=>{const s=scope({scope:'project',project:PROJECT});const e=store.chronicle(q({id:'event-0'}),s).items[0];assert.notEqual(e.effective_at,e.recorded_at);const r=store.recalls(q({session:'session-0'}),s).items[0];assert.equal(r.status,'prepared');assert.equal(r.emitted_at,null);assert(Array.isArray(r.fact_ids));});
test('log tail requires explicit all scope for unattributed text',()=>{const logs=new Logs(f.home,'/nonexistent/db.sqlite');assert.equal(logs.read(q({file:'home:runtime.log'}),scope({scope:'project',project:PROJECT})).items.length,0);assert.equal(logs.read(q({file:'home:runtime.log'}),scope({scope:'all'})).items.length,1);const entries=logs.read(q({file:'home:inject-context.jsonl'}),scope({scope:'project',project:PROJECT})).items;assert(entries.every(x=>x.data.project===PROJECT));assert.throws(()=>logs.resolve('../../etc/passwd'),{status:404});});
test('symbolic-link logs are not exposed',()=>{fs.symlinkSync('/etc/passwd',path.join(f.home,'logs','escape.log'));const logs=new Logs(f.home,'/nonexistent/db.sqlite');assert(!logs.files().some(x=>x.name==='escape.log'));});
test('stable project ID overrides an obsolete matching path',()=>{const existing=store.visibleFact(uid(73),scope({scope:'all'}));f.db.prepare('UPDATE facts SET scope_project=? WHERE id=?').run(PROJECT,existing.id);assert.throws(()=>store.visibleFact(existing.id,scope({scope:'project',project:PROJECT})),{status:404});f.db.prepare('UPDATE facts SET scope_project=? WHERE id=?').run(OTHER,existing.id);});
test('missing optional telemetry table reports unavailable rather than zero',()=>{f.db.exec('DROP TABLE recall_events');store.refreshSchema();const d=store.recalls(q(),scope({scope:'all'}));assert.equal(d.available,false);assert.equal(d.total,null);});
test('FTS only activates when readiness flag is set; tokens are quoted',()=>{f.db.exec("CREATE TABLE fts_meta(key TEXT PRIMARY KEY,value TEXT);CREATE VIRTUAL TABLE exchanges_fts USING fts5(user_message,assistant_message,content='exchanges',content_rowid='rowid',detail=column);INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild');INSERT INTO fts_meta VALUES('exchanges_fts_built','0');");store.refreshSchema();assert.equal(store.searchClause(q({q:'SQLite'}))[2],'contains');f.db.exec("UPDATE fts_meta SET value='1'");assert.equal(store.searchClause(q({q:'SQLite OR'}))[2],'fts');assert(store.exchanges(q({q:'SQLite'}),scope({scope:'all'})).total>0);});
