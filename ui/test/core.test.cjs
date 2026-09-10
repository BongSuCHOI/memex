'use strict';
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
test('동기화 서비스가 없는 코어에서는 503으로 끝난다',async()=>{
 const x=setup();
 try{
  x.c.modules.set('sync-control',{getSyncStatus(){return {};}});
  await assert.rejects(x.c.sync('status'),{status:503,code:'CORE_UNAVAILABLE'});
  // #76: 잠금은 첫 await 앞에서 잡히므로 503 경로도 finally가 풀어 false로 끝난다.
  assert.equal(x.c.syncBusy,false);
 }finally{x.clean();}
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
