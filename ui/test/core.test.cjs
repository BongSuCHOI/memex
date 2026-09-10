'use strict';
require('./helpers/locale.cjs').useKo();   // #109: 기존 한국어 단정은 ko 로케일에서 그대로 통과한다.
const {test}=require('node:test');const assert=require('node:assert/strict');const {Core}=require('../lib/core.cjs');const {fixture,uid,PROJECT}=require('./fixture.cjs');const fs=require('node:fs');const path=require('node:path');
function setup(){const f=fixture();const c=new Core({root:'/fixture/core',home:f.home,dbPath:'/fixture/db.sqlite'});c.db=f.db;c.store=f.store;let calls=[],closed=0;const writer={close(){closed++;}};c.modules.set('db',{openWriteDb(p){calls.push(['writer',p]);return writer;}});c.modules.set('fact-management',{async mutateFactMeaning(db,opts){calls.push(['edit',db,opts]);return {id:opts.factId,revisionId:'mock-revision',embeddingRefreshed:true};},deactivateFactTransactional(db,id){calls.push(['deactivate',db,id]);return {deactivated:true};},async restoreFact(db,id){calls.push(['restore',db,id]);return {restored:true};},async hardDeleteFact(db,id,opts){calls.push(['delete',db,id,opts]);return {deleted:true};},hardDeleteImpact(db,id){return {exists:true,revisions:2};},factTierOf(row){return row.scope_type==='global'?'global':(row.promotion_state==='workstream'||row.promotion_state==='workspace'?'workstream':'project');},promoteFact(db,id,options){calls.push(['promote',db,id,options]);return {id,from:'workstream',to:'project',steps:[{from:'workstream',to:'project',eventId:'mock-event'}]};},demoteFact(db,id,options){calls.push(['demote',db,id,options]);return {id,from:'project',to:'workstream',steps:[{from:'project',to:'workstream',eventId:'mock-event'}]};}});return {f,c,calls,closed:()=>closed,scope:f.store.scope(new URLSearchParams({scope:'project',project:PROJECT})),clean(){c.close();fs.rmSync(f.home,{recursive:true,force:true});}};}
test('root resolution points at the repository containing ui, not its parent',()=>{const c=new Core({home:'/tmp/unused'});if(!process.env.MEMEX_PLUGIN_ROOT&&!process.env.PLUGIN_ROOT)assert.equal(c.root,path.resolve(__dirname,'../..'));});
test('explicit user edit uses shared service, both CAS generations and human rationale',async()=>{const x=setup();try{const old=x.f.store.visibleFact(uid(1),x.scope);await x.c.mutate({id:uid(1),action:'edit',text:'Updated factual content',reason:'A user correction',expectedText:old.fact,expectedUpdatedAt:old.updated_at},x.scope);const [,writer,o]=x.calls.find(c=>c[0]==='edit');assert.equal(o.expectedPreviousFact,old.fact);assert.equal(o.expectedSemanticGeneration,old.semantic_generation);assert.equal(o.expectedLifecycleGeneration,old.lifecycle_generation);assert.equal(o.chronicle.actor,'user');assert.equal(o.chronicle.evidenceAuthority,'human');assert.equal(o.chronicle.userStatedRationale,'A user correction');assert.equal(x.closed(),1);assert.equal(x.c.busy.size,0);}finally{x.clean();}});
test('stale edits and cross-scope changes never open a writer',async()=>{const x=setup();try{await assert.rejects(x.c.mutate({id:uid(1),action:'edit',text:'Updated text',expectedText:'stale'},x.scope),{status:409});await assert.rejects(x.c.mutate({id:uid(73),action:'deactivate'},x.scope),{status:404});assert.equal(x.calls.length,0);}finally{x.clean();}});
test('deactivate and restore use core lifecycle services',async()=>{const x=setup();try{await x.c.mutate({id:uid(1),action:'deactivate'},x.scope);await x.c.mutate({id:uid(1),action:'restore'},x.scope);assert(x.calls.some(c=>c[0]==='deactivate'));assert(x.calls.some(c=>c[0]==='restore'));assert.equal(x.closed(),2);}finally{x.clean();}});
test('hard delete requires full exact ID and explicit confirmation',async()=>{const x=setup();try{await assert.rejects(x.c.mutate({id:uid(1),action:'delete',confirm:true,confirmId:'wrong'},x.scope),{status:400});assert.equal(x.calls.length,0);await x.c.mutate({id:uid(1),action:'delete',confirm:true,confirmId:uid(1)},x.scope);assert.deepEqual(x.calls.find(c=>c[0]==='delete')[3],{confirm:true});}finally{x.clean();}});
test('core failure closes writer and clears busy state',async()=>{const x=setup();try{x.c.modules.get('fact-management').mutateFactMeaning=async()=>{throw new Error('Embedding not available (mock)');};await assert.rejects(x.c.mutate({id:uid(1),action:'edit',text:'Updated content'},x.scope),/Embedding not available/);assert.equal(x.closed(),1);assert.equal(x.c.busy.size,0);}finally{x.clean();}});
test('계층 이동은 코어 사다리 서비스를 actor=user로 호출하고 writer를 닫는다',async()=>{const x=setup();try{
 const result=await x.c.tier({id:uid(1),action:'promote',reason:'프로젝트 전체에 적용'},x.scope);
 const [,writer,id,options]=x.calls.find(c=>c[0]==='promote');
 assert.equal(id,uid(1));assert.equal(options.actor,'user');assert.equal(options.reason,'프로젝트 전체에 적용');
 assert.equal(options.projectId,x.scope.projectId);assert.equal(result.steps.length,1);
 await x.c.tier({id:uid(1),action:'demote'},x.scope);
 assert.equal(x.calls.find(c=>c[0]==='demote')[3].reason,null);
 assert.equal(x.closed(),2);assert.equal(x.c.busy.size,0);
}finally{x.clean();}});
test('계층 이동은 한 칸 규칙과 범위를 서버에서 강제한다',async()=>{const x=setup();try{
 await assert.rejects(x.c.tier({id:uid(1),action:'move'},x.scope),{status:400});
 await assert.rejects(x.c.tier({id:uid(73),action:'promote'},x.scope),{status:404});
 await assert.rejects(x.c.tier({id:uid(1),action:'promote',expectedUpdatedAt:'2000-01-01T00:00:00.000Z'},x.scope),{status:409,code:'STALE_FACT'});
 assert.equal(x.calls.length,0);
 x.c.modules.get('fact-management').promoteFact=()=>{const e=new Error('tier ladder moves one step at a time: workstream → global is not adjacent');e.name='TierStepError';throw e;};
 await assert.rejects(x.c.tier({id:uid(1),action:'promote'},x.scope),{status:409,code:'TIER_STEP'});
 x.c.modules.get('fact-management').promoteFact=()=>{throw new Error('demoting a global fact requires a target project');};
 await assert.rejects(x.c.tier({id:uid(1),action:'promote'},x.scope),{status:400,code:'TIER_TARGET_REQUIRED'});
 assert.equal(x.c.busy.size,0);
}finally{x.clean();}});
test('계층 이동 서비스가 없는 코어에서는 쓰기를 열지 않는다',async()=>{const x=setup();try{
 delete x.c.modules.get('fact-management').promoteFact;
 await assert.rejects(x.c.tier({id:uid(1),action:'promote'},x.scope),{status:503,code:'CORE_UNAVAILABLE'});
 assert.equal(x.closed(),0);assert.equal(x.calls.length,0);
}finally{x.clean();}});
test('계층 이동은 읽은 tier에서 한 칸만 지정하고 기대 버전을 코어에 넘긴다 (#77)',async()=>{const x=setup();try{
 // uid(66) = promotion_state 'workstream'. tiers=all 범위에서만 보이므로 그 범위로 읽는다.
 const scope=x.f.store.scope(new URLSearchParams({scope:'project',project:PROJECT,tiers:'all'}));
 const branchFact=x.f.store.visibleFact(uid(66),scope);
 assert.equal(branchFact.promotion_state,'workstream');
 await x.c.tier({id:uid(66),action:'promote',expectedUpdatedAt:branchFact.updated_at},scope);
 const [,,,options]=x.calls.find(c=>c[0]==='promote');
 assert.equal(options.to,'project','한 칸 목표를 코어에 넘기지 않았습니다');
 assert.deepEqual(options.expected,{tier:'workstream',updatedAt:branchFact.updated_at});
 // 브랜치 아래 칸은 없으므로 쓰기를 열기 전에 거절한다.
 await assert.rejects(x.c.tier({id:uid(66),action:'demote'},scope),{status:409,code:'TIER_STEP'});
 assert.equal(x.calls.some(c=>c[0]==='demote'),false);
}finally{x.clean();}});
test('같은 버전으로 동시에 들어온 승격 두 개는 한 칸만 움직인다 (#77)',async()=>{const x=setup();try{
 const scope=x.f.store.scope(new URLSearchParams({scope:'project',project:PROJECT,tiers:'all'}));
 const LADDER=['workstream','project','global'];let tier='workstream';const moves=[];
 x.c.modules.set('fact-management',{
  factTierOf:row=>row.scope_type==='global'?'global':(row.promotion_state==='workstream'||row.promotion_state==='workspace'?'workstream':'project'),
  // 코어 가드를 그대로 흉내낸다: 기대 tier 불일치는 TierStaleError, 같은 칸은 TierStepError.
  promoteFact(_w,id,options){
   if(options.expected&&options.expected.tier&&options.expected.tier!==tier){const e=new Error('stale');e.name='TierStaleError';throw e;}
   const to=options.to??LADDER[LADDER.indexOf(tier)+1];
   if(to===tier){const e=new Error('not adjacent');e.name='TierStepError';throw e;}
   const from=tier;tier=to;moves.push({from,to});return {id,from,to,steps:[{from,to,eventId:'mock-event'}]};
  },
  demoteFact(){throw new Error('unused');},
 });
 const body={id:uid(66),action:'promote',expectedUpdatedAt:x.f.store.visibleFact(uid(66),scope).updated_at};
 const results=await Promise.allSettled([x.c.tier({...body},scope),x.c.tier({...body},scope)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'두 요청이 모두 통과했습니다');
 const refused=results.find(r=>r.status==='rejected').reason;
 assert.equal(refused.status,409);
 assert(['MUTATION_BUSY','TIER_STEP','STALE_FACT'].includes(refused.code),'예상치 못한 거절 코드: '+refused.code);
 assert.deepEqual(moves,[{from:'workstream',to:'project'}]);
 assert.equal(tier,'project');assert.equal(x.c.busy.size,0);
}finally{x.clean();}});
test('서로 다른 기억의 변경이 겹쳐도 코어 경로 고정이 풀리지 않는다 (#96)',async()=>{
 const x=setup();const saved={home:process.env.MEMEX_HOME,db:process.env.MEMEX_DB_PATH};
 // 잠금은 fact ID별이므로 서로 다른 두 기억의 변경은 실제로 겹친다. 겹치는 동안에도 두 코어 호출이
 // 모두 이 서버의 home을 봐야 하고(#78), 끝난 뒤에는 상속한 환경이 그대로 남아야 한다.
 try{
  process.env.MEMEX_HOME='/original/home';process.env.MEMEX_DB_PATH='/original/home/conversation-index/db.sqlite';
  const gate=new Map();const seen=[];
  x.c.modules.get('fact-management').deactivateFactTransactional=(db,id)=>new Promise(resolve=>{
   gate.set(id,()=>{seen.push([id,process.env.MEMEX_HOME,process.env.MEMEX_DB_PATH]);resolve({deactivated:true});});
  });
  const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
  const a=x.c.mutate({id:uid(1),action:'deactivate'},x.scope);
  await settle();assert(gate.has(uid(1)),'첫 변경이 코어 호출까지 가지 못했습니다');
  const b=x.c.mutate({id:uid(2),action:'deactivate'},x.scope);
  await settle();assert(gate.has(uid(2)),'두 번째 변경이 코어 호출까지 가지 못했습니다');
  assert.equal(x.c.busy.size,2,'서로 다른 두 기억의 변경이 겹치지 않았습니다');
  gate.get(uid(1))();await a;  // A가 먼저 끝난다 — B는 아직 코어 안이다.
  assert.equal(process.env.MEMEX_HOME,x.c.home,'먼저 끝난 변경이 아직 실행 중인 변경의 home을 되돌렸습니다');
  assert.equal(process.env.MEMEX_DB_PATH,x.c.dbPath,'먼저 끝난 변경이 아직 실행 중인 변경의 DB 경로를 되돌렸습니다');
  gate.get(uid(2))();await b;
  assert.equal(seen.length,2);
  for(const [id,home,db] of seen){
   assert.equal(home,x.c.home,id+' 의 코어 호출이 고정된 home을 보지 못했습니다');
   assert.equal(db,x.c.dbPath,id+' 의 코어 호출이 고정된 DB 경로를 보지 못했습니다');
  }
  // 마지막으로 빠져나간 호출만 되돌리므로 UI의 home이 프로세스에 남지 않는다.
  assert.equal(process.env.MEMEX_HOME,'/original/home');
  assert.equal(process.env.MEMEX_DB_PATH,'/original/home/conversation-index/db.sqlite');
  assert.equal(x.c.busy.size,0);assert.equal(x.c.pinDepth,0);
  // 원래 정의되지 않았던 변수는 변경 뒤에도 정의되지 않는다.
  delete process.env.MEMEX_HOME;delete process.env.MEMEX_DB_PATH;
  const c=x.c.mutate({id:uid(3),action:'deactivate'},x.scope);
  await settle();gate.get(uid(3))();await c;
  assert.equal('MEMEX_HOME' in process.env,false);
  assert.equal('MEMEX_DB_PATH' in process.env,false);
 }finally{
  for(const [k,v] of [['MEMEX_HOME',saved.home],['MEMEX_DB_PATH',saved.db]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  x.clean();
 }
});
test('동기화가 진행 중이면 기억 변경과 계층 이동을 409로 거절한다 (#96)',async()=>{
 const x=setup();
 try{
  x.c.syncBusy=true;
  await assert.rejects(x.c.mutate({id:uid(1),action:'deactivate'},x.scope),{status:409,code:'SYNC_BUSY'});
  await assert.rejects(x.c.tier({id:uid(1),action:'promote'},x.scope),{status:409,code:'SYNC_BUSY'});
  assert.equal(x.calls.length,0,'동기화 중에 코어 쓰기를 열었습니다');
  x.c.syncBusy=false;
  await x.c.mutate({id:uid(1),action:'deactivate'},x.scope);
  assert(x.calls.some(c=>c[0]==='deactivate'));
 }finally{x.clean();}
});
/**
 * #106 — 0.6.6의 #96 수정은 변경 쪽에 `syncBusy` 검사를 더했지만, `mutate()`는 그 검사 뒤에
 * `await this.connect()`로 양보한 다음에야 `busy.add(id)`로 잠금을 잡았다. 그 창에 들어온
 * `sync()`는 빈 `busy`를 보고 통과하고, 재개된 변경은 `syncBusy`를 다시 보지 않으므로 동기화와
 * 변경이 실제로 겹쳤다. #77이 `tier()`에 세운 규칙 — 잠금은 첫 `await` 앞에서 동기적으로 —
 * 을 변경에도 적용해야 두 순서 모두에서 배타적이다. 기존 테스트는 처음부터 `syncBusy=true`인
 * 경우만 다뤄 이 창을 지나쳤다.
 */
test('연결 await 창에 들어온 동기화는 진행 중인 기억 변경과 겹치지 않는다 (#106)',async()=>{
 const x=syncSetup();
 const settle=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
 try{
  // 주입된 지연 연결: 검사와 잠금 사이에 실제 양보 지점을 만든다.
  let openConnect;const connecting=new Promise(r=>{openConnect=r;});
  const realConnect=x.c.connect.bind(x.c);
  x.c.connect=async()=>{await connecting;return realConnect();};
  let syncBusyAtWrite=null;
  x.c.modules.get('fact-management').deactivateFactTransactional=(db,id)=>{
   syncBusyAtWrite=x.c.syncBusy===true;return {deactivated:true};
  };
  const mutation=x.c.mutate({id:uid(1),action:'deactivate'},x.scope);
  await settle();
  assert.equal(x.calls.length,0,'변경이 연결 await에서 멈춰 있지 않습니다');
  assert.equal(x.c.busy.has(uid(1)),true,'첫 await 앞에서 변경 잠금을 잡지 않았습니다');
  await assert.rejects(x.c.sync('export'),{status:409,code:'MUTATION_BUSY'});
  openConnect();
  await mutation;
  assert.equal(syncBusyAtWrite,false,'동기화가 진행 중인데 코어 쓰기가 실행됐습니다');
  assert.equal(x.syncCalls.filter(c=>c[0]==='export').length,0,'거절된 동기화가 코어 export를 실행했습니다');
  assert.equal(x.c.busy.size,0);assert.equal(!!x.c.syncBusy,false);

  // 반대 순서도 배타적이다: 동기화가 먼저 잠금을 잡으면 변경이 SYNC_BUSY로 거절된다.
  let openModule;const loading=new Promise(r=>{openModule=r;});
  const realModule=x.c.module.bind(x.c);
  x.c.module=async name=>{await loading;return realModule(name);};
  const sync=x.c.sync('export');
  await settle();
  assert.equal(x.c.syncBusy,true,'동기화가 첫 await 앞에서 잠금을 잡지 않았습니다');
  await assert.rejects(x.c.mutate({id:uid(1),action:'deactivate'},x.scope),{status:409,code:'SYNC_BUSY'});
  assert.equal(x.c.busy.size,0,'거절된 변경이 잠금을 남겼습니다');
  openModule();await sync;
  assert.equal(x.c.syncBusy,false);
 }finally{x.clean();}
});
function syncSetup(){
 const x=setup();const calls=[];
 x.c.modules.set('sync-control',{
  getSyncStatus(){calls.push(['status',process.env.MEMEX_HOME,process.env.MEMEX_DB_PATH]);return {enabled:false,dir:'/shared/memex',dirSource:'configured',peers:[]};},
  setSyncEnabled(input){calls.push(['set',input]);return {enabled:input.enabled,dir:input.dir??null,peers:[]};},
  runSyncExport(options){calls.push(['export',options]);return {skipped:null,result:{facts:3,revisions:1,tombstones:0,recallEvents:2},error:null};},
  async runSyncImport(){calls.push(['import']);return {skipped:null,result:{newFacts:2,malformedRows:[]},error:null};},
 });
 return {...x,syncCalls:calls};
}
test('동기화 호출은 이 서버가 해석한 home과 DB로 코어 경로를 고정하고 되돌린다',async()=>{
 const x=syncSetup();const before={home:process.env.MEMEX_HOME,db:process.env.MEMEX_DB_PATH};
 try{
  const result=await x.c.sync('status');
  assert.equal(result.status.dir,'/shared/memex');
  const [,home,db]=x.syncCalls.find(c=>c[0]==='status');
  assert.equal(home,x.c.home);assert.equal(db,x.c.dbPath);
  assert.equal(process.env.MEMEX_HOME,before.home,'호출 뒤 MEMEX_HOME을 되돌리지 않았습니다');
  assert.equal(process.env.MEMEX_DB_PATH,before.db,'호출 뒤 MEMEX_DB_PATH를 되돌리지 않았습니다');
  assert.equal(x.c.syncBusy,false);
 }finally{x.clean();}
});
test('동기화 켜기는 절대 경로만 받고, 수동 내보내기는 변경이 없어도 강제한다',async()=>{
 const x=syncSetup();
 try{
  await assert.rejects(x.c.sync('enable',{dir:'relative/path'}),{status:400,code:'INVALID_SYNC_DIR'});
  await assert.rejects(x.c.sync('enable',{dir:'   '}),{status:400});
  await assert.rejects(x.c.sync('teleport'),{status:400});
  await x.c.sync('enable',{dir:'/shared//memex/'});
  assert.deepEqual(x.syncCalls.find(c=>c[0]==='set')[1],{enabled:true,dir:'/shared/memex/'});
  await x.c.sync('disable');
  assert.deepEqual(x.syncCalls.filter(c=>c[0]==='set')[1][1],{enabled:false});
  const exported=await x.c.sync('export');
  assert.deepEqual(x.syncCalls.find(c=>c[0]==='export')[1],{force:true});
  assert.equal(exported.outcome.result.facts,3);
  const imported=await x.c.sync('import');
  assert.equal(imported.outcome.result.newFacts,2);
  assert(imported.status,'실행 뒤 상태를 함께 돌려주지 않았습니다');
 }finally{x.clean();}
});
test('동시 sync 요청은 하나만 통과하고 환경을 호출 전 값으로 되돌린다 (#76)',async()=>{
 const x=syncSetup();const saved={home:process.env.MEMEX_HOME,db:process.env.MEMEX_DB_PATH};
 try{
  process.env.MEMEX_HOME='/original/home';process.env.MEMEX_DB_PATH='/original/home/conversation-index/db.sqlite';
  // module() 해소를 한 틱 늦춰, 검사와 설정 사이의 양보 지점을 실제로 만든다.
  const real=x.c.module.bind(x.c);
  x.c.module=async name=>{await new Promise(r=>setImmediate(r));return real(name);};
  let inFlight=0,maxInFlight=0;
  x.c.modules.get('sync-control').runSyncImport=async()=>{
   inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
   await new Promise(r=>setImmediate(r));inFlight--;
   return {skipped:null,result:{newFacts:2,malformedRows:[]},error:null};
  };
  const results=await Promise.allSettled([x.c.sync('import'),x.c.sync('import')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'두 import가 모두 통과했습니다');
  const refused=results.find(r=>r.status==='rejected').reason;
  assert.equal(refused.status,409);assert.equal(refused.code,'SYNC_BUSY');
  assert.equal(maxInFlight,1,'두 import가 동시에 실행됐습니다');
  assert.equal(x.c.syncBusy,false);
  assert.equal(process.env.MEMEX_HOME,'/original/home');
  assert.equal(process.env.MEMEX_DB_PATH,'/original/home/conversation-index/db.sqlite');
  // 원래 정의되지 않았던 변수는 호출 뒤에도 정의되지 않는다.
  delete process.env.MEMEX_HOME;delete process.env.MEMEX_DB_PATH;
  await x.c.sync('status');
  assert.equal('MEMEX_HOME' in process.env,false);
  assert.equal('MEMEX_DB_PATH' in process.env,false);
 }finally{
  for(const [k,v] of [['MEMEX_HOME',saved.home],['MEMEX_DB_PATH',saved.db]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  x.clean();
 }
});
test('수동 세대 파일 action은 절대 경로만 받고 코어 서비스를 그대로 호출한다 (#48)',async()=>{
 const x=syncSetup();const calls=x.syncCalls;
 x.c.modules.get('sync-control').exportGenerationArchive=()=>{calls.push(['archive-export']);return {path:'/tmp/root/sync/exports/d-g.zip',bytes:12,deviceId:'d',deviceAlias:null,generation:'g',counts:{facts:1,revisions:0,tombstones:0,recallEvents:0}};};
 x.c.modules.get('sync-control').previewImportArchive=source=>{calls.push(['archive-preview',source]);return {source,deviceId:'peer',deviceAlias:null,generation:'g9',newFacts:2,updatedFacts:1,deletedFacts:0,conflicts:[],generations:[{deviceId:'peer'}],rejected:[]};};
 x.c.modules.get('sync-control').importArchive=async source=>{calls.push(['archive-import',source]);return {source,deviceId:'peer',deviceAlias:null,generation:'g9',result:{newFacts:2,malformedRows:[]}};};
 x.c.modules.get('sync-control').setDeviceAlias=(deviceId,alias)=>{calls.push(['alias',deviceId,alias]);return {[deviceId]:alias};};
 try{
  await assert.rejects(x.c.sync('archive-preview',{path:'relative/g.zip'}),{status:400,code:'INVALID_ARCHIVE_PATH'});
  await assert.rejects(x.c.sync('archive-import',{path:'   '}),{status:400});
  const exported=await x.c.sync('archive-export');
  assert.equal(exported.archive.path,'/tmp/root/sync/exports/d-g.zip');
  assert(exported.status,'내보낸 뒤 상태를 함께 돌려주지 않았습니다');
  const preview=await x.c.sync('archive-preview',{path:'/tmp/Downloads//g.zip'});
  assert.equal(preview.preview.newFacts,2);
  assert.equal(calls.find(c=>c[0]==='archive-preview')[1],'/tmp/Downloads/g.zip','경로를 정규화하지 않았습니다');
  const imported=await x.c.sync('archive-import',{path:'/tmp/Downloads/g.zip'});
  assert.equal(imported.outcome.result.newFacts,2);
  await x.c.sync('alias',{deviceId:'peer',alias:'  회사 맥북  '});
  assert.deepEqual(calls.find(c=>c[0]==='alias').slice(1),['peer','회사 맥북']);
  // 빈 이름은 삭제 신호로 null을 넘긴다.
  await x.c.sync('alias',{deviceId:'peer',alias:'   '});
  assert.equal(calls.filter(c=>c[0]==='alias')[1][2],null);
  // 코어의 거부 사유는 원문 그대로 400으로 전달한다.
  x.c.modules.get('sync-control').importArchive=async()=>{throw new Error('sync archive is not a readable zip: zip central directory not found');};
  await assert.rejects(x.c.sync('archive-import',{path:'/tmp/not-a.zip'}),{status:400,code:'INVALID_ARCHIVE',message:/not a readable zip/});
  assert.equal(x.c.syncBusy,false);
 }finally{x.clean();}
});
test('세대 파일·별칭 서비스가 없는 코어에서는 503으로 끝난다 (#48)',async()=>{
 const x=syncSetup();
 try{
  for(const action of ['archive-export','archive-preview','archive-import','alias'])
   await assert.rejects(x.c.sync(action,{path:'/tmp/g.zip',deviceId:'peer'}),{status:503,code:'CORE_UNAVAILABLE'});
 }finally{x.clean();}
});
test('동기화 서비스가 없는 코어에서는 503으로 끝난다',async()=>{
 const x=setup();
 try{
  x.c.modules.set('sync-control',{getSyncStatus(){return {};}});
  await assert.rejects(x.c.sync('status'),{status:503,code:'CORE_UNAVAILABLE'});
  // #76: 잠금은 첫 await 앞에서 잡히므로 503 경로도 finally가 풀어 false로 끝난다.
  assert.equal(x.c.syncBusy,false);
 }finally{x.clean();}
});
/**
 * #78 — 코어가 남기는 감사 줄은 이 UI의 home에만 있어야 한다.
 *
 * 스텁은 코어의 경로 해석(`src/paths.ts` getMemexHome: MEMEX_HOME → XDG_CONFIG_HOME/memex →
 * ~/.config/memex)을 그대로 흉내내 `logs/ui-audit.jsonl`에 한 줄을 쓴다. 고정이 없으면 그 줄은
 * XDG 기본 루트로 가고, 고정이 있으면 UI가 유도한 home으로 간다.
 */
function auditSetup(action){
 const temp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'memex-ui-audit-'));
 const xdg=path.join(temp,'xdg');const altRoot=path.join(temp,'alt-root');
 const saved={};for(const k of ['MEMEX_HOME','MEMEX_DB_PATH','TEST_DB_PATH','XDG_CONFIG_HOME'])saved[k]=process.env[k];
 delete process.env.MEMEX_HOME;delete process.env.TEST_DB_PATH;
 process.env.XDG_CONFIG_HOME=xdg;process.env.MEMEX_DB_PATH=path.join(altRoot,'db.sqlite');
 const x=setup();
 const core=new Core({root:'/fixture/core'});
 core.db=x.f.db;core.store=x.f.store;core.modules=x.c.modules;
 const coreHome=()=>process.env.MEMEX_HOME||path.join(process.env.XDG_CONFIG_HOME,'memex');
 const audit=()=>{const home=coreHome();fs.mkdirSync(path.join(home,'logs'),{recursive:true});
  fs.appendFileSync(path.join(home,'logs','ui-audit.jsonl'),JSON.stringify({source:'memex-core',action,at:new Date().toISOString()})+'\n');};
 const fm=core.modules.get('fact-management');
 const wrap=(name,value)=>{const original=fm[name];fm[name]=(...args)=>{audit();return original?.(...args)??value;};};
 wrap('promoteFact',{id:uid(1),steps:[]});wrap('mutateFactMeaning',{id:uid(1)});
 const lines=root=>{try{return fs.readFileSync(path.join(root,'logs','ui-audit.jsonl'),'utf8').trim().split('\n').filter(Boolean);}catch{return [];}};
 return {x,core,xdgHome:path.join(xdg,'memex'),altRoot,lines,scope:x.scope,
  clean(){x.clean();for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(temp,{recursive:true,force:true});}};
}
test('계층 변경의 코어 감사 줄은 UI가 유도한 home에만 남는다 (#78)',async()=>{
 const t=auditSetup('fact.promote');
 try{
  assert.equal(t.core.home,t.altRoot,'명시된 DB에서 home을 유도하지 않았습니다');
  await t.core.tier({id:uid(1),action:'promote'},t.scope);
  assert.equal(t.lines(t.altRoot).length,1,'UI의 home에 감사 줄이 없습니다');
  assert.deepEqual(t.lines(t.xdgHome),[],'기본 데이터 루트에 감사 줄이 새어 나갔습니다');
  assert.equal('MEMEX_HOME' in process.env,false,'호출 뒤에도 MEMEX_HOME이 정의돼 있습니다');
  assert.equal(process.env.MEMEX_DB_PATH,path.join(t.altRoot,'db.sqlite'),'MEMEX_DB_PATH를 되돌리지 않았습니다');
  assert.equal(t.core.busy.size,0);
 }finally{t.clean();}
});
test('기억 수정의 코어 감사 줄도 같은 home에만 남는다 (#78)',async()=>{
 const t=auditSetup('fact.edit');
 try{
  await t.core.mutate({id:uid(1),action:'edit',text:'Updated factual content'},t.scope);
  assert.equal(t.lines(t.altRoot).length,1,'UI의 home에 감사 줄이 없습니다');
  assert.deepEqual(t.lines(t.xdgHome),[],'기본 데이터 루트에 감사 줄이 새어 나갔습니다');
 }finally{t.clean();}
});
test('no DB file is created when the initial read fails',async()=>{const f=fixture(),filename=path.join(f.home,'missing','never.sqlite');const c=new Core({root:f.home,dbPath:filename,home:f.home});try{await assert.rejects(c.connect(),{status:503});assert.equal(fs.existsSync(filename),false);}finally{f.close();fs.rmSync(f.home,{recursive:true,force:true});}});
test('API helper sends POST plus token when a body exists',async()=>{const mod=await import('../public/api.mjs');const saved={fetch:global.fetch,location:global.location};try{global.location={origin:'http://127.0.0.1:3847'};let captured;global.fetch=async(url,opts)=>{captured={url:String(url),opts};return new Response('{"ok":true}',{status:200,headers:{'content-type':'application/json'}});};mod.setToken('test-token');assert.deepEqual(await mod.request('facts/mutate',{scope:'global'},{body:{action:'edit'}}),{ok:true});assert.equal(captured.opts.method,'POST');assert.equal(captured.opts.headers['X-Memex-CSRF'],'test-token');await mod.request('facts');assert.equal(captured.opts.method,'GET');assert.equal(captured.opts.body,undefined);}finally{global.fetch=saved.fetch;global.location=saved.location;}});
test('safe Markdown escapes scripts, event attributes and remote image syntax',async()=>{const {markdown,esc}=await import('../public/ui.mjs');const html=markdown('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n![remote](https://invalid/x)');assert(!html.includes('<img'));assert(!html.includes('<script'));assert(html.includes('&lt;script&gt;'));assert.equal(esc('"\'<>&'),'&quot;&#39;&lt;&gt;&amp;');});

test('initial missing DB can be retried after sync creates it',async()=>{const f=fixture(),filename=path.join(f.home,'created-later.sqlite');const c=new Core({root:f.home,dbPath:filename,home:f.home});try{await assert.rejects(c.connect(),{status:503});assert.equal(c.connecting,null);fs.writeFileSync(filename,'fixture marker');c.modules.set('db',{openReadDb(){return f.db;}});const store=await c.connect(true);assert.equal(store.db,f.db);assert.equal(c.connecting,null);}finally{c.close();fs.rmSync(f.home,{recursive:true,force:true});}});
test('an explicitly pointed database owns the UI home, so a temp DB never writes into the real one',()=>{
 const saved={};for(const k of ['MEMEX_HOME','MEMEX_DB_PATH','TEST_DB_PATH','XDG_CONFIG_HOME'])saved[k]=process.env[k];
 try{
  delete process.env.MEMEX_HOME;delete process.env.TEST_DB_PATH;process.env.XDG_CONFIG_HOME=path.join('/fixture','xdg');
  process.env.MEMEX_DB_PATH=path.join('/fixture','scratch','db.sqlite');
  assert.equal(new Core().home,path.join('/fixture','scratch'));
  process.env.MEMEX_DB_PATH=path.join('/fixture','scratch','conversation-index','db.sqlite');
  assert.equal(new Core().home,path.join('/fixture','scratch'));
  process.env.MEMEX_HOME=path.join('/fixture','explicit');
  assert.equal(new Core().home,path.join('/fixture','explicit'));
  delete process.env.MEMEX_HOME;delete process.env.MEMEX_DB_PATH;
  assert.equal(new Core().home,path.join('/fixture','xdg','memex'));
 }finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
