'use strict';
require('./helpers/locale.cjs').useKo();   // #109: 이 파일의 단정은 코드·키이므로 로케일과 무관하다.
/**
 * `/api/v2/models` — 모델 선택 API (#31, 0.7.0 lane E · 설계 §12.2 · §14.1).
 *
 * 이 스위트가 고정하는 계약 4개:
 *
 *  1. **조회는 DB 없이도 200이다.** 선택과 출처는 `models.json`과 환경 변수만으로 결정되므로
 *     새 설치(인덱스 DB 없음)에서도 모델 탭이 열린다. 보류·대기 작업·마지막 테스트만 빈다.
 *  2. **거절은 정규화보다 낫다.** 잘못된 모델 id·추론 강도는 422 + `details.issues`로 거절되고
 *     파일은 그대로 남는다 — 조용히 교정된 설정은 한 시간 뒤 원인 모를 보류가 된다.
 *  3. **같은 코어 함수를 쓴다.** 파일은 `dist/model-settings.js`, 보류·대기 작업은
 *     `dist/model-budget.js`의 HOLD API, 1회 테스트는 `dist/model-settings-probe.js`다.
 *     `memex`를 셸로 실행하지 않으므로 여기서 프로세스를 띄울 필요가 없다.
 *  4. **실제 제공자 호출은 절대 하지 않는다.** probe 모듈은 `core.modules` 캐시에 가짜를
 *     꽂아 대체한다(`module()`이 그 맵을 먼저 본다) — 테스트가 codex를 부르면 그 테스트는
 *     네트워크·과금·사용량 한도를 단정하는 것이고, 그것은 이 레인의 계약이 아니다.
 *
 * 임시 MEMEX_HOME과 임시 CODEX_HOME만 쓴다. 사용자의 `~/.config/memex`·`~/.codex`는 읽지도
 * 쓰지도 않는다.
 */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Core}=require('../lib/core.cjs');
const {createServer}=require('../lib/server.cjs');

const ROOT=path.resolve(__dirname,'../..');
/** 결정적인 카탈로그. 실측한 Codex `models_cache.json`의 모양 그대로다(설계 §3.2). */
const CATALOG={
  fetched_at:'2026-09-09T00:00:00.000Z',
  etag:'fixture',
  client_version:'0.153.4',
  models:[
    {slug:'gpt-6-astra',display_name:'GPT-6-Astra',description:'fixture',default_reasoning_level:'low',
      supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'high'}],visibility:'list',supported_in_api:true,priority:1},
    {slug:'gpt-5.6-luna',display_name:'GPT-5.6-Luna',description:'fixture',default_reasoning_level:null,
      supported_reasoning_levels:[{effort:'low'},{effort:'high'}],visibility:'list',supported_in_api:true,priority:2},
    {slug:'gpt-reserve',display_name:'Reserve',description:'fixture',default_reasoning_level:null,
      supported_reasoning_levels:[{effort:'low'}],visibility:'hide',supported_in_api:true,priority:9},
  ],
};

let TEMP,HOME,DB_PATH,CODEX,savedEnv;

/** 한 번에 하나의 임시 데이터 루트. initDatabase()가 실제 스키마를 만든다(보류 테이블 포함). */
async function seedDatabase(){
  const {initDatabase}=await import(path.join(ROOT,'dist','db.js'));
  const db=initDatabase({dbPath:DB_PATH});
  const at='2026-09-10T00:00:00.000Z';
  db.prepare(`INSERT INTO memory_jobs (job_id,kind,partition_key,policy_version,priority,state,available_at,
      attempts,max_attempts,idempotency_key,created_at,updated_at,hold_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('job-held','fact_extract','session:held','facts-v4',100,'pending',at,0,5,'models-test-held',at,at,'model_config_rejected');
  db.prepare(`INSERT INTO model_work_budgets (budget_id,parent_wave_id,state,max_attempts,reserved_attempts,
      max_input_chars,max_output_chars,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('budget-probe','wave-models-test','active',12,1,60000,16000,at,at);
  db.prepare(`INSERT INTO model_work_attempts (attempt_id,budget_id,attempt_no,stage,state,started_at,finished_at,
      duration_ms,model,reasoning_effort) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('attempt-probe','budget-probe',1,'model_probe','completed',at,at,1234,'gpt-6-astra','high');
  db.close();
}

function insertHold(fingerprint){
  const better=require(path.join(ROOT,'node_modules','better-sqlite3'));
  const db=new better(DB_PATH);
  try{
    db.prepare(`INSERT INTO model_config_holds (selection_fingerprint,held_at,model,reasoning_effort,provider_status,
        provider_type,provider_message,observed_count,last_observed_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(fingerprint,'2026-09-10T01:00:00.000Z','gpt-6-astraX','max',400,'invalid_request_error',
        "The 'gpt-6-astraX' model is not supported",3,'2026-09-10T02:00:00.000Z');
  }finally{db.close();}
}

/** 보류 사유로 작업을 다시 파킹한다 — 앞선 테스트의 설정 변경이 이미 풀었을 수 있다. */
function parkHeldJob(){
  const better=require(path.join(ROOT,'node_modules','better-sqlite3'));
  const db=new better(DB_PATH);
  try{db.prepare("UPDATE memory_jobs SET hold_reason = 'model_config_rejected', state = 'pending' WHERE job_id = 'job-held'").run();}
  finally{db.close();}
}

const core=()=>new Core({root:ROOT,home:HOME,dbPath:DB_PATH});
const settingsFile=()=>path.join(HOME,'models.json');
const auditLines=()=>{
  const file=path.join(HOME,'logs','ui-audit.jsonl');
  if(!fs.existsSync(file))return [];
  return fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
};
/** HttpError를 코드로 단정한다 — 문장은 클라이언트가 사전에서 만든다. */
async function refused(fn,status,code){
  try{await fn();assert.fail('요청이 거절되지 않았습니다');}
  catch(e){
    assert.equal(e.status,status,`status: ${e.message}`);
    assert.equal(e.code,code,`code: ${e.message}`);
    return e;
  }
}

before(async()=>{
  TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'memex-ui-models-'));
  HOME=path.join(TEMP,'home');
  DB_PATH=path.join(HOME,'conversation-index','db.sqlite');
  CODEX=path.join(TEMP,'codex');
  fs.mkdirSync(CODEX,{recursive:true});
  fs.writeFileSync(path.join(CODEX,'models_cache.json'),JSON.stringify(CATALOG));
  savedEnv={CODEX_HOME:process.env.CODEX_HOME,MEMEX_CODEX_MODEL:process.env.MEMEX_CODEX_MODEL,
    MEMEX_CODEX_REASONING:process.env.MEMEX_CODEX_REASONING};
  process.env.CODEX_HOME=CODEX;
  delete process.env.MEMEX_CODEX_MODEL;
  delete process.env.MEMEX_CODEX_REASONING;
  await seedDatabase();
});
after(()=>{
  for(const [k,v] of Object.entries(savedEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  fs.rmSync(TEMP,{recursive:true,force:true});
});

test('조회는 선택·출처·카탈로그·보류·대기 작업·마지막 테스트를 한 번에 답한다',async()=>{
  const c=core();
  const first=await c.models('status');
  assert.equal(first.llm.effective.model.source,'default');
  assert.equal(first.llm.effective.model.value,'gpt-5.6-luna','코어 기본값이 바닥이다');
  assert.equal(first.llm.effective.reasoning.value,null);
  assert.equal(first.fileExists,false,'아직 models.json이 없다');
  assert.equal(first.llm.catalog.source,'models_cache');
  assert.deepEqual(first.llm.catalog.models.map(m=>m.slug),['gpt-6-astra','gpt-5.6-luna','gpt-reserve']);
  assert.deepEqual(first.llm.catalogReasoning,['low','high'],'기본 모델이 받는 강도는 카탈로그에서 온다');
  assert.deepEqual(first.llm.allowedReasoning.slice(0,3),['none','minimal','low']);
  assert.equal(first.db.exists,true);
  // 대기 작업과 마지막 테스트는 코어의 HOLD API·원장에서 읽는다(지어내지 않는다).
  assert.deepEqual(first.llm.heldJobs,[{reason:'model_config_rejected',jobs:1,oldestHeldAt:'2026-09-10T00:00:00.000Z'}]);
  assert.equal(first.llm.lastProbe.ok,true);
  assert.equal(first.llm.lastProbe.model,'gpt-6-astra');
  assert.equal(first.llm.lastProbe.latencyMs,1234);
  assert.equal(first.llm.hold,null,'보류 행이 없으면 null이다');
  // 보류는 **지문이 일치할 때만** 이 프로세스를 막는다(§3.5.2 규칙 1).
  insertHold(first.llm.fingerprint);
  const held=await core().models('status');
  assert.equal(held.llm.hold.model,'gpt-6-astraX');
  assert.equal(held.llm.hold.observedCount,3);
  assert.equal(held.llm.hold.current,true);
  assert.equal(held.llm.holds.length,1);
  assert.equal(held.embedding.readOnly,true,'0.7.0의 임베딩 섹션은 읽기 전용이다');
  assert.ok(held.embedding.model,'실효 임베딩 모델은 읽을 수 있다');
  c.close();
});

test('조회는 인덱스 DB가 없어도 답한다 — 보류·원장만 빈다',async()=>{
  const c=new Core({root:ROOT,home:HOME,dbPath:path.join(TEMP,'missing','db.sqlite')});
  const status=await c.models('status');
  assert.equal(status.db.exists,false);
  assert.deepEqual(status.llm.holds,[]);
  assert.deepEqual(status.llm.heldJobs,[]);
  assert.equal(status.llm.lastProbe,null);
  assert.equal(status.llm.effective.model.value,'gpt-5.6-luna');
});

test('저장은 models.json을 0600으로 쓰고, 낡은 카탈로그는 경고이되 거절이 아니다',async()=>{
  const c=core();
  const saved=await c.models('set-llm',{model:'gpt-6-astra',reasoning:'xhigh'});
  assert.equal(saved.ok,true);
  assert.deepEqual(saved.saved,{model:'gpt-6-astra',reasoning:'xhigh'});
  assert.equal(saved.status.llm.effective.model.source,'file');
  assert.equal(saved.status.llm.effective.reasoning.value,'xhigh');
  assert.equal(fs.existsSync(settingsFile()),true);
  assert.equal(fs.statSync(settingsFile()).mode&0o777,0o600,'설정 파일은 0600이다');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(),'utf8')).llm.model,'gpt-6-astra');
  // 카탈로그는 low/medium/high만 말하지만 저장은 성공한다 — 카탈로그가 낡을 수 있다(§3.3 규칙 2).
  const unsupported=saved.warnings.find(w=>w.code==='REASONING_UNSUPPORTED');
  assert.ok(unsupported,'지원 목록 밖 강도는 경고로 알린다');
  assert.equal(unsupported.params.model,'gpt-6-astra');
  assert.match(unsupported.params.levels,/low/);
  // 같은 선택을 저장해도 지문이 같으므로 settle이 돌지 않는다(남의 보류를 건드리지 않는다).
  const again=await c.models('set-llm',{reasoning:'high'});
  assert.equal(again.status.llm.effective.reasoning.value,'high');
  assert.deepEqual(again.warnings.filter(w=>w.code==='REASONING_UNSUPPORTED'),[],'지원 목록 안이면 경고가 없다');
  c.close();
});

test('카탈로그에 없는 id와 숨은 항목은 저장되고 경고만 붙는다',async()=>{
  const c=core();
  const unknown=await c.models('set-llm',{model:'totally-bogus-model-xyz'});
  assert.equal(unknown.ok,true);
  assert.equal(unknown.warnings.find(w=>w.code==='MODEL_NOT_IN_CATALOG').params.model,'totally-bogus-model-xyz');
  const hidden=await c.models('set-llm',{model:'gpt-reserve'});
  assert.ok(hidden.warnings.find(w=>w.code==='MODEL_HIDDEN_IN_CATALOG'),'숨은 항목은 선택 가능하되 목록에 없다');
  c.close();
});

test('선택이 바뀌면 옛 지문의 보류와 그 사유로 대기하던 작업이 풀린다',async()=>{
  parkHeldJob();
  const before=await core().models('status');
  insertHold(before.llm.fingerprint);
  const c=core();
  const result=await c.models('set-llm',{model:'gpt-5.6-luna',reasoning:'low'});
  assert.equal(result.settled.clearedHolds,1,'옛 지문의 보류를 닫는다');
  assert.equal(result.settled.releasedJobs,1,'그 사유로 파킹된 작업도 함께 푼다');
  assert.ok(result.warnings.find(w=>w.code==='HOLD_CLEARED'));
  const after=await c.models('status');
  assert.deepEqual(after.llm.heldJobs,[],'대기 작업이 사라졌다');
  assert.equal(after.llm.hold,null);
  // 행은 지우지 않고 닫는다(감사·진단 보존).
  const better=require(path.join(ROOT,'node_modules','better-sqlite3'));
  const db=new better(DB_PATH,{readonly:true});
  const row=db.prepare('SELECT cleared_by FROM model_config_holds WHERE selection_fingerprint = ?').get(before.llm.fingerprint);
  db.close();
  assert.equal(row.cleared_by,'manual','보류 행은 삭제되지 않고 닫힌다');
  c.close();
});

test('잘못된 입력은 422 + details.issues로 거절되고 파일은 그대로다',async()=>{
  const c=core();
  const snapshot=fs.readFileSync(settingsFile(),'utf8');
  const badModel=await refused(()=>c.models('set-llm',{model:'bad id with spaces'}),422,'INVALID_MODEL_ID');
  assert.equal(badModel.key,'models.error.invalid_model_id');
  assert.equal(badModel.details.issues[0].field,'model');
  assert.equal(badModel.details.issues[0].key,'models.error.invalid_model_id');
  const badReasoning=await refused(()=>c.models('set-llm',{reasoning:'bogus'}),422,'INVALID_REASONING');
  assert.equal(badReasoning.key,'models.error.invalid_reasoning');
  assert.match(badReasoning.params.allowed,/none, minimal, low/);
  assert.equal(badReasoning.details.issues[0].field,'reasoning');
  await refused(()=>c.models('set-llm',{}),422,'NOTHING_TO_SAVE');
  await refused(()=>c.models('rm -rf'),400,'UNKNOWN_ACTION');
  assert.equal(fs.readFileSync(settingsFile(),'utf8'),snapshot,'거절된 요청은 파일을 건드리지 않는다');
  c.close();
});

test("reasoning을 'unset'으로 저장하면 플래그를 보내지 않는다",async()=>{
  const c=core();
  const result=await c.models('set-llm',{reasoning:'unset'});
  assert.equal(result.saved.reasoning,null);
  assert.equal(result.status.llm.effective.reasoning.value,null);
  // 'none'은 제공자의 실제 강도이므로 "해제"와 혼동되지 않는다.
  const none=await c.models('set-llm',{reasoning:'none'});
  assert.equal(none.saved.reasoning,'none');
  c.close();
});

test('환경 변수는 파일을 덮고, 저장은 그 사실을 경고로 말한다',async()=>{
  process.env.MEMEX_CODEX_MODEL='env-pinned-model';
  process.env.MEMEX_CODEX_REASONING='medium';
  try{
    const c=core();
    const status=await c.models('status');
    assert.equal(status.llm.effective.model.value,'env-pinned-model');
    assert.equal(status.llm.effective.model.source,'env');
    assert.equal(status.llm.effective.reasoning.source,'env');
    assert.equal(status.env.MEMEX_CODEX_MODEL,'env-pinned-model');
    const saved=await c.models('set-llm',{model:'gpt-6-astra',reasoning:'high'});
    assert.equal(saved.saved.model,'gpt-6-astra','파일에는 저장된다');
    assert.equal(saved.status.llm.effective.model.value,'env-pinned-model','호출은 여전히 환경 변수를 쓴다');
    assert.ok(saved.warnings.find(w=>w.code==='ENV_OVERRIDES_MODEL'));
    assert.ok(saved.warnings.find(w=>w.code==='ENV_OVERRIDES_REASONING'));
    c.close();
  }finally{delete process.env.MEMEX_CODEX_MODEL;delete process.env.MEMEX_CODEX_REASONING;}
});

test('초기화는 파일만 지우고 실효 임베딩 모델은 건드리지 않는다',async()=>{
  const c=core();
  await c.models('set-llm',{model:'gpt-6-astra'});
  const before=await c.models('status');
  const reset=await c.models('reset');
  assert.equal(reset.removed,true);
  assert.equal(fs.existsSync(settingsFile()),false);
  assert.equal(reset.status.llm.effective.model.value,'gpt-5.6-luna');
  assert.equal(reset.status.llm.effective.model.source,'default');
  assert.equal(reset.status.embedding.model,before.embedding.model,'벡터 공간은 설정 파일이 지울 수 없다');
  const again=await c.models('reset');
  assert.equal(again.removed,false,'없는 파일을 지우는 것은 같은 결과이고 오류가 아니다');
  c.close();
});

test('1회 테스트는 코어의 probe를 그대로 부르고, 동시 호출은 409다',async()=>{
  const c=core();
  await c.models('set-llm',{model:'gpt-6-astra',reasoning:'high'});
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const calls=[];
  c.modules.set('model-settings-probe',{
    MODEL_PROBE_STAGE:'model_probe',
    async probeModel(db,opts){
      calls.push(opts);
      await gate;
      return {ok:true,model:opts.model,reasoning:opts.reasoning,latencyMs:42,answer:'MEMEX_OK',
        rejection:null,error:null,errorClass:null,clearedHold:{fingerprint:'x',clearedHolds:1,releasedJobs:2}};
    },
  });
  const running=c.models('test');
  await new Promise(resolve=>setImmediate(resolve));
  await refused(()=>c.models('test'),409,'MODELS_BUSY');
  release();
  const result=await running;
  assert.equal(result.ok,true);
  assert.equal(result.probe.answer,'MEMEX_OK');
  assert.deepEqual(calls,[{model:'gpt-6-astra',reasoning:'high'}],'실효 선택을 그대로 넘긴다');
  // 호출 인자로 다른 모델을 시험할 수 있다(저장하지 않는다).
  const override=await c.models('test',{model:'gpt-5.6-luna',reasoning:'low'});
  assert.equal(override.probe.model,'gpt-5.6-luna');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile(),'utf8')).llm.model,'gpt-6-astra','테스트는 저장하지 않는다');
  c.close();
});

test('1회 테스트는 기록할 DB가 없으면 503이고, 실패한 probe는 200 본문으로 온다',async()=>{
  const noDb=new Core({root:ROOT,home:HOME,dbPath:path.join(TEMP,'missing','db.sqlite')});
  await refused(()=>noDb.models('test'),503,'DB_INDEX_MISSING');
  const c=core();
  c.modules.set('model-settings-probe',{MODEL_PROBE_STAGE:'model_probe',
    async probeModel(){return {ok:false,model:'gpt-6-astra',reasoning:'high',latencyMs:7,answer:null,
      rejection:{message:"The 'gpt-6-astra' model is not supported",status:400,type:'invalid_request_error'},
      error:'rejected',errorClass:'config',clearedHold:null};}});
  const failed=await c.models('test');
  assert.equal(failed.ok,false,'실패는 오류가 아니라 결과다 — 화면이 제공자 원문을 보여준다');
  assert.equal(failed.probe.rejection.status,400);
  c.close();
});

test('감사 줄은 코어의 writer로 이 서버의 home에 남고 모델 이름만 싣는다',async()=>{
  const c=core();
  await c.models('set-llm',{model:'gpt-6-astra',reasoning:'low'});
  await c.models('reset');
  const lines=auditLines();
  const set=lines.filter(l=>l.action==='models.llm.set').pop();
  assert.ok(set,'models.llm.set 줄이 없다');
  assert.equal(set.to_model,'gpt-6-astra');
  assert.equal(set.to_reasoning,'low');
  assert.equal(set.source,'ui');
  assert.ok(lines.some(l=>l.action==='models.reset'));
  assert.ok(!JSON.stringify(lines).includes('MEMEX_OK'),'probe 응답 문자열은 감사에 남기지 않는다');
  c.close();
});

/* ── HTTP 경계 ─────────────────────────────────────────────────────────────── */
test('HTTP: 조회는 DB 없이도 200이고, 변경은 CSRF와 명시적 확인을 요구한다',async()=>{
  const c=new Core({root:ROOT,home:HOME,dbPath:path.join(TEMP,'missing','db.sqlite')});
  const app=createServer({core:c});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  try{
    const read=await fetch(base+'/api/v2/models');
    assert.equal(read.status,200);
    const status=await read.json();
    assert.equal(status.llm.effective.model.value,'gpt-5.6-luna');
    assert.equal(status.db.exists,false);
    const url=base+'/api/v2/models';
    const headers={'Content-Type':'application/json','X-Memex-CSRF':app.token};
    const noToken=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'reset',confirm:true})});
    assert.equal(noToken.status,403);
    assert.equal((await noToken.json()).error.code,'CSRF_REJECTED');
    const noConfirm=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'reset'})});
    assert.equal(noConfirm.status,400);
    const envelope=(await noConfirm.json()).error;
    assert.equal(envelope.code,'CONFIRMATION_REQUIRED');
    assert.equal(envelope.key,'models.error.confirm_required');
    assert.ok(envelope.message,'봉투에는 기계가 읽는 code·key와 영어 원문이 함께 있다');
    const unknown=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'sudo',confirm:true})});
    assert.equal(unknown.status,400);
    assert.equal((await unknown.json()).error.code,'UNKNOWN_ACTION');
    const invalid=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'set-llm',model:'bad id',confirm:true})});
    assert.equal(invalid.status,422);
    const body=(await invalid.json()).error;
    assert.equal(body.code,'INVALID_MODEL_ID');
    assert.equal(body.details.issues[0].field,'model');
    assert.equal((await fetch(url,{method:'DELETE',headers})).status,405);
    assert.equal((await fetch(url+'?x=1',{method:'PUT',headers})).status,405);
    // 감사는 성공·실패 양쪽에 남는다(sync 선례).
    assert.ok(auditLines().some(l=>l.action==='models.set-llm'&&l.status==='failed'));
  }finally{app.close();}
});

test('HTTP: 저장은 임시 home의 models.json을 쓰고 상태를 함께 돌려준다',async()=>{
  const c=core();
  const app=createServer({core:c});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  try{
    const response=await fetch(base+'/api/v2/models',{method:'POST',
      headers:{'Content-Type':'application/json','X-Memex-CSRF':app.token},
      body:JSON.stringify({action:'set-llm',model:'gpt-6-astra',reasoning:'medium',confirm:true})});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.status.llm.effective.model.value,'gpt-6-astra');
    assert.equal(result.status.llm.effective.reasoning.value,'medium');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile(),'utf8')).llm.reasoning,'medium');
    assert.ok(auditLines().some(l=>l.action==='models.set-llm'&&l.status==='completed'));
  }finally{app.close();fs.rmSync(settingsFile(),{force:true});}
});
