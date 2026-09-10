'use strict';
require('./helpers/locale.cjs').useKo();   // #109: 이 파일의 단정은 코드·키이므로 로케일과 무관하다.
/**
 * `/api/v2/overlays` — 사용자 오버레이 API (#29 · #30, 0.7.0 lane F · 설계 §4.1 · §7.3).
 *
 * 이 스위트가 고정하는 계약 6개:
 *
 *  1. **조회·쓰기가 DB 없이도 된다.** 오버레이는 `<home>/overlays/*.json` 파일이고 회수 게이트
 *     규칙은 데이터베이스와 무관하게 적용되므로, 인덱스 DB가 없는 새 설치에서도 탭이 열리고
 *     규칙을 저장할 수 있다. 대기 작업·드리프트·시뮬레이션만 DB를 본다.
 *  2. **거절은 정규화보다 낫다.** 문법을 어긴 정규식은 **422 + `details.issues`**로 거절되고 파일은
 *     바이트 그대로 남는다. `path`(`patterns.add[1].source`)가 왕복에서 보존돼야 어느 행을 고쳐야
 *     하는지 화면이 말할 수 있다 (G5/I2).
 *  3. **내장 항목은 삭제가 아니라 끄기다.** 끈 항목은 카탈로그에 남고, 다시 켜기가 정확한 역연산이다.
 *  4. **dry-run은 아무것도 쓰지 않는다.** `test`·`validate`·`simulate`는 오버레이 파일·감사 로그·
 *     히스토리 어디에도 쓰지 않는다(격리 파일만 예외이며, 그것은 실제 matcher를 썼다는 사실이다).
 *  5. **전체 문서 경로는 갱신 유실을 막는다.** 규칙 `set`은 파일이 있으면 `expectedRevision`이
 *     필수이고, 불일치는 409다.
 *  6. **규칙 쓰기가 HOLD를 푼다.** 규칙 오류로 파킹된 작업은 저장·초기화와 함께 풀린다 —
 *     고친 규칙이 큐를 영원히 세워 두지 않는다.
 *
 * 임시 MEMEX_HOME과 임시 MEMEX_OVERLAY_DIR만 쓴다. 사용자의 `~/.config/memex`는 읽지도 쓰지도 않는다.
 */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Core}=require('../lib/core.cjs');
const {createServer}=require('../lib/server.cjs');

const ROOT=path.resolve(__dirname,'../..');
const AT='2026-09-10T00:00:00.000Z';
let TEMP,HOME,DB_PATH,savedEnv;

const core=()=>new Core({root:ROOT,home:HOME,dbPath:DB_PATH});
const noDbCore=()=>new Core({root:ROOT,home:HOME,dbPath:path.join(TEMP,'missing','db.sqlite')});
const gateFile=()=>path.join(HOME,'overlays','recall-gate.json');
const rulesFile=()=>path.join(HOME,'overlays','extraction-rules.json');
const quarantineFile=()=>path.join(HOME,'overlays','quarantine.json');
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
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
/** 규칙 오류로 작업을 파킹한다 — 앞선 테스트의 규칙 저장이 이미 풀었을 수 있다. */
function parkHeldJob(reason='extraction_rules_invalid'){
  const better=require(path.join(ROOT,'node_modules','better-sqlite3'));
  const db=new better(DB_PATH);
  try{db.prepare('UPDATE memory_jobs SET hold_reason = ?, state = ? WHERE job_id = ?').run(reason,'pending','job-rules-held');}
  finally{db.close();}
}

before(async()=>{
  TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'memex-ui-overlays-'));
  HOME=path.join(TEMP,'home');
  DB_PATH=path.join(HOME,'conversation-index','db.sqlite');
  savedEnv={MEMEX_OVERLAY_DIR:process.env.MEMEX_OVERLAY_DIR,MEMEX_DISABLE_OVERLAYS:process.env.MEMEX_DISABLE_OVERLAYS,
    MEMEX_HOME:process.env.MEMEX_HOME};
  // 오버레이 디렉터리를 명시한다 — 코어의 기본값과 같은 위치지만, 실제 데이터 루트를 절대 보지 않는다는
  // 사실을 이 파일에서 읽을 수 있어야 한다 (§1.8 MEMEX_OVERLAY_DIR).
  process.env.MEMEX_OVERLAY_DIR=path.join(HOME,'overlays');
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  const {initDatabase}=await import(path.join(ROOT,'dist','db.js'));
  const db=initDatabase({dbPath:DB_PATH});
  db.prepare(`INSERT INTO memory_jobs (job_id,kind,partition_key,policy_version,priority,state,available_at,
      attempts,max_attempts,idempotency_key,created_at,updated_at,hold_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('job-rules-held','fact_extract','session:held','continuity-fact-v1',100,'pending',AT,0,5,'overlays-test-held',AT,AT,'extraction_rules_invalid');
  // 모델 설정으로 파킹된 작업은 규칙 저장이 **풀지 않아야** 한다(사유 격리).
  db.prepare(`INSERT INTO memory_jobs (job_id,kind,partition_key,policy_version,priority,state,available_at,
      attempts,max_attempts,idempotency_key,created_at,updated_at,hold_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('job-model-held','fact_extract','session:model','continuity-fact-v1',100,'pending',AT,0,5,'overlays-test-model',AT,AT,'model_config_rejected');
  db.close();
});
after(()=>{
  for(const [k,v] of Object.entries(savedEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  fs.rmSync(TEMP,{recursive:true,force:true});
});

test('조회는 DB 없이도 두 오버레이의 전체 상태를 답한다',async()=>{
  const c=noDbCore();
  const status=await c.overlays('status');
  assert.equal(status.available,true);
  assert.equal(status.shared,false,'0.7.0은 기기 간 공유가 없다 — 화면이 그 사실을 배너로 말한다');
  assert.ok(status.gate.builtin.patterns.length>0,'내장 카탈로그가 비어 있다');
  assert.deepEqual(Object.keys(status.gate.builtin.words),['ack','continue','filler']);
  assert.equal(status.gate.present,false,'아직 오버레이 파일이 없다');
  assert.equal(status.gate.hash,null);
  assert.equal(status.rules.present,false);
  assert.deepEqual(status.rules.enforcementPoints,['fact_insert','incident','remediation','chronicle']);
  assert.equal(status.rules.verifierUnchanged,true);
  assert.equal(status.rules.clause.text,'','적용할 제한이 없으면 제약 절도 비어 있다');
  assert.equal(status.rules.drift.available,false,'DB가 없으면 드리프트를 세지 않고 0을 지어내지 않는다');
  assert.deepEqual(status.rules.drift.heldJobs,[]);
  assert.equal(status.limits.quantifiers,8);
  assert.equal(status.limits.matchWallMs,50,'실행 상한은 코어 상수에서 온다');
  assert.ok(status.limits.probeWallMs>0);
  assert.equal(status.environment,undefined,'상태 응답은 환경 변수를 싣지 않는다');
  c.close();
});

test('사용자 패턴 추가는 0600 파일에 revision을 올려 쓰고 감사 줄을 남긴다',async()=>{
  const c=core();
  const result=await c.overlays('patch',{overlay:'gate',patternsAdd:[{intent:'memory',source:'deploy\\s*history',flags:'i',note:'release questions'}]});
  assert.equal(result.ok,true);
  assert.equal(result.revision,1);
  assert.match(result.hash,/^gate:[0-9a-f]{8}$/);
  assert.equal(fs.statSync(gateFile()).mode&0o777,0o600,'오버레이 파일은 0600이다');
  const doc=readJson(gateFile());
  assert.equal(doc.schema,'memex.recall-gate-overlay');
  assert.equal(doc.updated_by.surface,'web-ui');
  assert.equal(doc.patterns.add.length,1);
  const added=result.status.gate.user.patterns[0];
  assert.match(added.id,/^user\./,'사용자 패턴 id는 결정적으로 계산된다');
  assert.equal(added.intent,'memory');
  assert.equal(result.status.gate.present,true);
  // 감사는 코어의 writer가 남긴다(§1.4) — 서버가 두 번째 줄을 쓰지 않는다.
  const lines=auditLines().filter(line=>line.action==='gate.pattern-add');
  assert.equal(lines.length,1,'감사 줄이 이중으로 기록됐다');
  assert.equal(lines[0].to_revision,1);
  assert.ok(!JSON.stringify(lines).includes('deploy'),'정규식 본문은 감사에 남기지 않는다');
  // 히스토리 색인은 메타데이터만 담는다.
  const history=result.status.gate.history;
  assert.equal(history[0].to_revision,1);
  assert.deepEqual(history[0].added,[added.id]);
  c.close();
});

test('문법을 어긴 정규식은 422 + details.issues(path 포함)로 거절되고 파일은 그대로다',async()=>{
  const c=core();
  const snapshot=fs.readFileSync(gateFile(),'utf8');
  const e=await refused(()=>c.overlays('patch',{overlay:'gate',patternsAdd:[{intent:'memory',source:'(a+)+b'}]}),422,'OVERLAY_INVALID');
  assert.equal(e.key,'overlays.error.overlayInvalid');
  const issue=e.details.issues.find(i=>i.severity==='error');
  assert.ok(issue,'error severity 항목이 없다');
  assert.equal(issue.code,'REGEX_QUANTIFIED_GROUP');
  assert.equal(issue.key,'overlays.issue.regexQuantifiedGroup');
  assert.match(issue.path,/^patterns\.add\[\d+\]\.source$/,'어느 행을 고쳐야 하는지가 사라졌다');
  assert.ok(issue.message,'영어 한 줄이 항상 실린다');
  await refused(()=>c.overlays('patch',{overlay:'gate',patternsAdd:[{intent:'memory',source:'ok',flags:'g'}]}),422,'OVERLAY_INVALID');
  await refused(()=>c.overlays('patch',{overlay:'gate',patternsAdd:[{intent:'nonsense',source:'ok'}]}),422,'OVERLAY_INVALID');
  await refused(()=>c.overlays('patch',{overlay:'gate'}),400,'INVALID_PATCH');
  await refused(()=>c.overlays('patch',{overlay:'gate',patternsAdd:[{intent:'memory',source:'a'}],patternsDisable:['x']}),400,'INVALID_PATCH');
  await refused(()=>c.overlays('sudo',{overlay:'gate'}),400,'INVALID_ACTION');
  await refused(()=>c.overlays('patch',{overlay:'everything'}),400,'INVALID_OVERLAY');
  assert.equal(fs.readFileSync(gateFile(),'utf8'),snapshot,'거절된 요청은 파일을 건드리지 않는다');
  c.close();
});

test('내장 항목은 삭제가 아니라 끄기이고, 다시 켜기가 그 역연산이다',async()=>{
  const c=core();
  const before=await c.overlays('status');
  const builtin=before.gate.builtin.patterns.find(p=>p.intent==='memory');
  const off=await c.overlays('patch',{overlay:'gate',patternsDisable:[builtin.id]});
  assert.ok(off.status.gate.user.disabled.includes(builtin.id));
  assert.ok(off.status.gate.builtin.patterns.some(p=>p.id===builtin.id),'내장 항목은 카탈로그에 남는다');
  const on=await c.overlays('patch',{overlay:'gate',patternsEnable:[builtin.id]});
  assert.ok(!on.status.gate.user.disabled.includes(builtin.id));
  const e=await refused(()=>c.overlays('patch',{overlay:'gate',patternsEnable:[builtin.id]}),422,'PATTERN_NOT_DISABLED');
  assert.equal(e.details.issues[0].key,'overlays.error.patternNotDisabled');
  // 사용자 패턴의 "끄기"는 오버레이에서의 삭제다(카탈로그에 원본이 없으므로).
  const user=on.status.gate.user.patterns[0];
  const removed=await c.overlays('patch',{overlay:'gate',patternsDisable:[user.id]});
  assert.ok(!removed.status.gate.user.patterns.some(p=>p.id===user.id));
  const restored=await c.overlays('patch',{overlay:'gate',
    patternsAdd:[{intent:user.intent,source:user.source,flags:user.flags,note:user.note}]});
  assert.equal(restored.status.gate.user.patterns[0].id,user.id,'같은 규칙은 같은 id로 돌아온다');
  c.close();
});

test('어휘는 정규식이 아니므로 단어 그대로 추가·끄기된다',async()=>{
  const c=core();
  const added=await c.overlays('patch',{overlay:'gate',words:{lexicon:'ack',add:['ㅇㅈ']}});
  assert.deepEqual(added.status.gate.user.words.add.ack,['ㅇㅈ']);
  const off=await c.overlays('patch',{overlay:'gate',words:{lexicon:'ack',disable:['확인']}});
  assert.deepEqual(off.status.gate.user.words.disable.ack,['확인']);
  const back=await c.overlays('patch',{overlay:'gate',words:{lexicon:'ack',removeAdd:['ㅇㅈ']}});
  assert.deepEqual(back.status.gate.user.words.add.ack,[]);
  await refused(()=>c.overlays('patch',{overlay:'gate',words:{lexicon:'nonsense',add:['x']}}),400,'INVALID_LEXICON');
  await refused(()=>c.overlays('patch',{overlay:'gate',words:{lexicon:'ack'}}),400,'INVALID_PATCH');
  c.close();
});

test('프롬프트 테스트는 의도가 왜 발화했는지 말하고 아무것도 기록하지 않는다',async()=>{
  const c=core();
  const before={file:fs.readFileSync(gateFile(),'utf8'),audit:auditLines().length};
  const explanation=await c.overlays('test',{overlay:'gate',prompt:'why did we switch auth to supabase?',compareBuiltin:true});
  assert.equal(explanation.intents.memory.fired,true);
  assert.ok(explanation.intents.memory.matched.length>0,'어느 규칙이 발화시켰는지 말해야 한다');
  assert.ok(explanation.intents.memory.matched.every(hit=>hit.id&&hit.origin));
  assert.ok(explanation.decision.action,'판정이 비었다');
  assert.equal(explanation.matcher.timedOut,false);
  assert.ok(explanation.builtinOnly,'compareBuiltin은 내장만의 판정도 함께 돌린다');
  assert.equal(explanation.stateSource,'neutral','세션을 주지 않으면 중립 상태로 판정한다');
  assert.equal(fs.readFileSync(gateFile(),'utf8'),before.file,'테스트가 오버레이를 건드렸다');
  assert.equal(auditLines().length,before.audit,'dry-run이 감사 줄을 남겼다');
  await refused(()=>c.overlays('test',{overlay:'gate',prompt:'   '}),400,'PROMPT_REQUIRED');
  await refused(()=>c.overlays('test',{overlay:'rules',prompt:'x'}),400,'INVALID_ACTION');
  c.close();
});

test('격리된 패턴은 상태에 남고 해제는 해제한 개수를 돌려준다',async()=>{
  const c=core();
  const status=await c.overlays('status');
  const user=status.gate.user.patterns[0];
  const {patternSourceSha8}=await import(path.join(ROOT,'dist','overlay-regex.js'));
  const {resetQuarantineMemory}=await import(path.join(ROOT,'dist','overlay-matcher.js'));
  fs.writeFileSync(quarantineFile(),JSON.stringify({schema:'memex.overlay-quarantine',version:1,entries:[
    {overlay:'recall-gate',pattern_id:user.id,source_sha8:patternSourceSha8(user.source,user.flags),
      at:AT,elapsed_ms:50,input_chars:812,surface:'daemon'},
  ]}),{mode:0o600});
  resetQuarantineMemory();
  const held=await c.overlays('status');
  assert.equal(held.gate.quarantined.length,1);
  assert.equal(held.gate.quarantined[0].pattern_id,user.id);
  assert.ok(held.gate.issues.some(issue=>issue.code==='PATTERN_QUARANTINED'),'격리는 doctor fail 등급의 issue다');
  const cleared=await c.overlays('quarantine-clear',{overlay:'gate',patternId:user.id});
  assert.equal(cleared.cleared,1);
  assert.deepEqual(cleared.status.gate.quarantined,[]);
  await refused(()=>c.overlays('quarantine-clear',{overlay:'gate'}),400,'PATTERN_REQUIRED');
  const all=await c.overlays('quarantine-clear',{overlay:'gate',all:true});
  assert.equal(all.cleared,0,'없는 것을 해제하는 것은 같은 결과이고 오류가 아니다');
  c.close();
});

test('규칙 검증은 파일을 건드리지 않고 행별 사유를 돌려준다',async()=>{
  const c=core();
  const status=await c.overlays('status');
  const base=status.rules.emptyDoc;
  const bad={...base,never_extract_patterns:[{source:'(a+)+b',flags:'i',scope:'both'}],exclude_topics:['x']};
  const result=await c.overlays('validate',{overlay:'rules',doc:bad});
  assert.equal(result.ok,false);
  const issue=result.issues.find(i=>i.severity==='error');
  assert.ok(issue.path,'path 없이는 어느 행인지 알 수 없다');
  assert.match(issue.key,/^overlays\.issue\./);
  assert.equal(fs.existsSync(rulesFile()),false,'검증은 파일을 만들지 않는다');
  const ok=await c.overlays('validate',{overlay:'rules',doc:{...base,exclude_topics:['salary review']}});
  assert.equal(ok.ok,true);
  assert.deepEqual(ok.issues.filter(i=>i.severity==='error'),[]);
  await refused(()=>c.overlays('validate',{overlay:'rules'}),400,'INVALID_DOCUMENT');
  c.close();
});

test('규칙 저장은 전체 문서 경로이므로 revision을 요구하고 불일치를 409로 거절한다',async()=>{
  const c=core();
  const base=(await c.overlays('status')).rules.emptyDoc;
  const doc={...base,preferred_language:'ko',exclude_topics:['salary review'],
    never_extract_patterns:[{source:'\\bsk-[A-Za-z0-9_-]{16,}',flags:'',scope:'both',note:'api key shape'}]};
  const first=await c.overlays('set',{overlay:'rules',doc});
  assert.equal(first.revision,1,'파일이 없으면 expectedRevision 없이 첫 저장이 된다');
  assert.match(first.hash,/^rules:[0-9a-f]{8}$/);
  assert.equal(fs.statSync(rulesFile()).mode&0o777,0o600);
  assert.ok(first.status.rules.clause.text.includes('sk-'),'제약 절이 금지 패턴을 담는다');
  assert.ok(first.status.rules.effectivePolicyVersion.includes('rules:'),'실효 정책은 규칙 해시를 보고용으로만 싣는다');
  assert.equal(first.status.rules.schedulingPolicyVersion,'continuity-fact-v1','스케줄 키에는 해시를 섞지 않는다');
  await refused(()=>c.overlays('set',{overlay:'rules',doc}),400,'EXPECTED_REVISION_REQUIRED');
  const stale=await refused(()=>c.overlays('set',{overlay:'rules',doc,expectedRevision:99}),409,'OVERLAY_STALE');
  assert.equal(stale.params.current,1);
  const second=await c.overlays('set',{overlay:'rules',doc:{...doc,exclude_topics:['salary review','performance review']},expectedRevision:1});
  assert.equal(second.revision,2);
  assert.deepEqual(second.status.rules.resolved.excludeTopics,['salary review','performance review']);
  await refused(()=>c.overlays('set',{overlay:'gate',doc}),400,'INVALID_ACTION');
  c.close();
});

test('규칙 저장·초기화는 규칙 사유로 대기하던 작업만 푼다',async()=>{
  parkHeldJob();
  const c=core();
  const before=await c.overlays('status');
  const held=before.rules.drift.heldJobs;
  assert.ok(held.some(row=>row.reason==='extraction_rules_invalid'&&row.jobs===1),'대기 작업을 코어의 HOLD 집계에서 읽는다');
  assert.ok(!held.some(row=>row.reason==='model_config_rejected'),'모델 설정 대기는 이 화면의 배너가 아니다');
  assert.equal(before.rules.drift.available,true);
  const reset=await c.overlays('reset',{overlay:'rules',expectedRevision:before.rules.revision});
  assert.equal(reset.revision,before.rules.revision+1);
  assert.equal(reset.released,1,'고친 규칙이 큐를 세워 두지 않는다');
  assert.deepEqual(reset.status.rules.drift.heldJobs,[],'규칙 사유의 대기가 풀렸다');
  assert.equal(reset.status.rules.clause.text,'','초기화는 빈 문서를 다음 revision으로 쓴다');
  assert.equal(fs.existsSync(rulesFile()),true,'초기화는 파일을 지우지 않는다 — 되돌릴 수 있어야 한다');
  // 모델 설정으로 파킹된 작업은 그대로 남는다(사유 격리).
  const better=require(path.join(ROOT,'node_modules','better-sqlite3'));
  const db=new better(DB_PATH,{readonly:true});
  const row=db.prepare("SELECT hold_reason FROM memory_jobs WHERE job_id = 'job-model-held'").get();
  db.close();
  assert.equal(row.hold_reason,'model_config_rejected');
  const rolled=await c.overlays('rollback',{overlay:'rules',revision:2,expectedRevision:reset.revision});
  assert.equal(rolled.revision,reset.revision+1);
  assert.deepEqual(rolled.status.rules.resolved.excludeTopics,['salary review','performance review'],'스냅숏이 그대로 돌아왔다');
  await refused(()=>c.overlays('rollback',{overlay:'rules',revision:0}),400,'INVALID_REVISION');
  c.close();
});

test('시뮬레이션은 모델 없이 저장된 기억에서 차단될 것을 보여준다',async()=>{
  const {insertFact}=await import(path.join(ROOT,'dist','fact-db.js'));
  const factories=await import(path.join(ROOT,'dist','db.js'));
  const db=factories.openWriteDb(DB_PATH);
  let factId;
  try{
    factId=insertFact(db,{fact:'The staging key is sk-ABCDEFGHIJKLMNOPQRSTUV and it rotates monthly.',
      category:'knowledge',scope_type:'global',scope_project:null,source_exchange_ids:[],
      embedding:new Array(384).fill(0.2),embedding_version:1});
  }finally{db.close();}
  const c=core();
  const report=await c.overlays('simulate',{overlay:'rules'});
  assert.equal(report.available,true);
  assert.ok(report.existingFacts.scanned>0);
  const blocked=report.existingFacts.wouldBeBlocked.find(row=>row.id===factId);
  assert.ok(blocked,'금지 패턴에 맞는 기억이 미리보기에 없다');
  assert.ok(blocked.patternId,'어느 규칙이 막았는지 귀속해야 한다');
  assert.ok(blocked.preview.includes('sk-'));
  assert.deepEqual(report.enforcementPoints,['fact_insert','incident','remediation','chronicle']);
  assert.equal(report.verifierUnchanged,true);
  // 로컬에서 판정할 수 없는 규칙은 숫자를 만들지 않고 목록으로만 싣는다.
  assert.deepEqual(report.advisoryOnly.excludeTopics,['salary review','performance review']);
  const noDb=noDbCore();
  await refused(()=>noDb.overlays('simulate',{overlay:'rules'}),503,'DB_INDEX_MISSING');
  await refused(()=>c.overlays('simulate',{overlay:'gate'}),400,'INVALID_ACTION');
  c.close();
});

test('오버레이 변경은 한 번에 하나이고 동기화·기억 변경과도 배타적이다',async()=>{
  const c=core();
  const admin=await c.module('overlay-admin');
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  c.modules.set('overlay-admin',{...admin,async addGatePattern(input,opts){await gate;return admin.addGatePattern(input,opts);}});
  const running=c.overlays('patch',{overlay:'gate',patternsAdd:[{intent:'trace',source:'rollout\\s*log',flags:'i'}]});
  await new Promise(resolve=>setImmediate(resolve));
  await refused(()=>c.overlays('patch',{overlay:'gate',patternsAdd:[{intent:'trace',source:'other',flags:'i'}]}),409,'OVERLAY_BUSY');
  await refused(()=>c.sync('export'),409,'OVERLAY_BUSY');
  // 조회는 막지 않는다 — 화면은 변경 중에도 읽을 수 있어야 한다.
  assert.equal((await c.overlays('status')).available,true);
  release();
  const result=await running;
  assert.equal(result.ok,true);
  c.modules.set('overlay-admin',admin);
  c.close();
});

/* ── HTTP 경계 ─────────────────────────────────────────────────────────────── */
test('HTTP: 조회는 DB 없이도 200이고, 변경은 CSRF와 명시적 확인을 요구한다',async()=>{
  const c=noDbCore();
  const app=createServer({core:c});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  const url=base+'/api/v2/overlays';
  const headers={'Content-Type':'application/json','X-Memex-CSRF':app.token};
  try{
    const read=await fetch(url);
    assert.equal(read.status,200);
    const status=await read.json();
    assert.equal(status.shared,false);
    assert.ok(status.gate.builtin.patterns.length>0);
    const noToken=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({overlay:'gate',action:'reset',confirm:true})});
    assert.equal(noToken.status,403);
    assert.equal((await noToken.json()).error.code,'CSRF_REJECTED');
    const noConfirm=await fetch(url,{method:'POST',headers,body:JSON.stringify({overlay:'gate',action:'reset'})});
    assert.equal(noConfirm.status,400);
    const envelope=(await noConfirm.json()).error;
    assert.equal(envelope.code,'CONFIRMATION_REQUIRED');
    assert.equal(envelope.key,'overlays.error.confirmRequired','서버는 key를 검증하지 않고 통과시킨다');
    assert.ok(envelope.message,'봉투에는 기계가 읽는 code·key와 영어 원문이 함께 있다');
    const unknown=await fetch(url,{method:'POST',headers,body:JSON.stringify({overlay:'gate',action:'sudo',confirm:true})});
    assert.equal(unknown.status,400);
    assert.equal((await unknown.json()).error.code,'INVALID_ACTION');
    // 422의 행별 사유가 왕복에서 보존된다 — path·key·severity 전부 (G5/I2).
    const invalid=await fetch(url,{method:'POST',headers,
      body:JSON.stringify({overlay:'gate',action:'patch',confirm:true,patternsAdd:[{intent:'memory',source:'(a+)+b'}]})});
    assert.equal(invalid.status,422);
    const body=(await invalid.json()).error;
    assert.equal(body.code,'OVERLAY_INVALID');
    const issue=body.details.issues.find(i=>i.severity==='error');
    assert.match(issue.path,/^patterns\.add\[\d+\]\.source$/);
    assert.equal(issue.key,'overlays.issue.regexQuantifiedGroup');
    // 조회 action은 confirm 없이 통과한다 — 아무것도 쓰지 않으므로 확인할 것이 없다.
    const validate=await fetch(url,{method:'POST',headers,
      body:JSON.stringify({overlay:'gate',action:'validate',doc:{schema:'memex.recall-gate-overlay',version:1,revision:0}})});
    assert.equal(validate.status,200);
    assert.equal((await validate.json()).ok,true);
    assert.equal((await fetch(url,{method:'DELETE',headers})).status,405);
    assert.equal((await fetch(url,{method:'PUT',headers})).status,405);
    // 감사는 쓰기에만, 성공·실패 양쪽에 남는다(sync 선례).
    assert.ok(auditLines().some(line=>line.action==='overlays.patch'&&line.status==='failed'));
    assert.ok(!auditLines().some(line=>line.action==='overlays.validate'),'dry-run은 감사 줄을 남기지 않는다');
  }finally{app.close();}
});

test('HTTP: 쓰기는 이 서버가 해석한 임시 home에만 쓴다',async()=>{
  const c=core();
  const app=createServer({core:c});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  try{
    const response=await fetch(base+'/api/v2/overlays',{method:'POST',
      headers:{'Content-Type':'application/json','X-Memex-CSRF':app.token},
      body:JSON.stringify({overlay:'gate',action:'patch',confirm:true,
        patternsAdd:[{intent:'highImpact',source:'migrate\\s*database',flags:'i'}]})});
    assert.equal(response.status,200);
    const result=await response.json();
    assert.ok(result.revision>0);
    assert.ok(readJson(gateFile()).patterns.add.some(p=>p.source==='migrate\\s*database'));
    assert.ok(auditLines().some(line=>line.action==='overlays.patch'&&line.status==='completed'));
  }finally{app.close();}
});
