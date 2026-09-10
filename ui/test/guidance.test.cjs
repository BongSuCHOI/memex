'use strict';
require('./helpers/locale.cjs').useKo();   // #109: 기존 한국어 단정은 ko 로케일에서 그대로 통과한다.
/**
 * 실패 클래스 카탈로그 커버리지 (#23).
 *
 * 코어가 던지는 오류 문자열과 skip 사유 enum을 src/에서 직접 뽑아, 각각이 UI 카탈로그에
 * 매핑되거나 아래 대장(臺帳)에 명시적으로 "매핑하지 않음"으로 올라 있는지 검사한다.
 * 새 오류가 코어에 들어오면 이 테스트가 먼저 실패한다 — 그게 이 테스트의 목적이다.
 */
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const ts=require('typescript');
const guidance=require('../public/guidance.mjs');
const {en,ko}=require('./helpers/locale.cjs');
const {DOC_ANCHORS}=require('../public/i18n/doc-anchors.mjs');
const SRC=path.resolve(__dirname,'../../src');
const UI_LIB=path.resolve(__dirname,'../lib');

/** src/의 모든 throw new *Error("…") 문자열 리터럴. 템플릿 보간은 그대로 둔다. */
function throwLiterals(){
 const out=[];
 for(const file of fs.readdirSync(SRC).filter(f=>f.endsWith('.ts'))){
  const text=fs.readFileSync(path.join(SRC,file),'utf8');
  const re=/throw new ([A-Za-z]*Error)\(\s*(["'`])/g;let m;
  while((m=re.exec(text))){
   const quote=m[2];let i=m.index+m[0].length,value='';
   while(i<text.length){const ch=text[i];if(ch==='\\'){value+=text[i]+text[i+1];i+=2;continue;}if(ch===quote)break;value+=ch;i++;}
   out.push({file,cls:m[1],literal:value.replace(/\s+/g,' ').trim()});
  }
 }
 return out;
}

/** 코어가 선언한 skip 사유·클레임 사유·terminal 상태 이름. 문자열을 다시 적지 않고 src에서 읽는다. */
function declaredEnums(){
 const read=f=>fs.readFileSync(path.join(SRC,f),'utf8');
 const values=new Set();
 const quoted=text=>(text.match(/['"][a-z_]+['"]/g)||[]).map(v=>v.slice(1,-1));
 const extractor=read('fact-extractor.ts');
 for(const m of extractor.matchAll(/skipped\??:\s*\n?\s*\|?\s*((?:\s*['"][a-z_]+['"]\s*\|?)+)/g))for(const v of quoted(m[1]))values.add(v);
 for(const m of extractor.matchAll(/^\s{2}(lease_held|backoff|attempts_exhausted|cas):/gm))values.add(m[1]);
 for(const name of ['MemoryJobClaimReason','SyncSkipReason','DerivedLaneSkipReason']){
  for(const file of ['continuity-store.ts','sync-control.ts','derived-lane-skip.ts'])
   for(const m of read(file).matchAll(new RegExp(name+'\\s*=\\s*([^;]+);','g')))for(const v of quoted(m[1]))values.add(v);
 }
 const terminal=read('pipeline-status.ts').match(/terminal:\s*\{([^}]+)\}/);
 if(terminal)for(const m of terminal[1].matchAll(/^\s*([a-zA-Z]+):\s*number;/gm))values.add(m[1]);
 return [...values];
}

/**
 * 대장 A — 파일 단위 면제. 이 파일들의 오류는 Web UI가 읽는 표면(memory_jobs.last_error,
 * model_work_attempts.error_message, 로그 파일, 관리 실행 출력)에 도달하지 않거나,
 * 사용자가 화면에서 취할 행동이 없는 내부 불변식이다.
 */
const EXEMPT_FILES={
 'fact-extraction-eval.ts':'개발용 평가 하네스. 런타임 경로가 아니다.',
 'mcp-server.ts':'MCP 도구 인자 검증. 오류는 MCP 클라이언트로 돌아가고 Web UI를 지나지 않는다.',
 'continuity-identity.ts':'프로젝트·워크스페이스 동일성 불변식. 위반은 코어 버그이고 사용자 행동이 없다.',
 'continuity-core.ts':'Capsule/체크포인트 내부 계약. 사용자에게 보이는 결과는 작업 상태로 이미 표현된다.',
 'read-scope.ts':'ReadScope 불변식. 위반은 코어 버그다.',
 'models-cli.ts':'`memex models` 인자 파싱 오류. CLI 사용자에게 stderr로 돌아가고 Web UI 표면에 도달하지 않는다 (#31).',
 'overlay-admin.ts':'오버레이 쓰기 API의 호출 전제조건(validator/emptyDoc 누락, 델타 대상, 스냅숏 부재, 심볼릭 링크 거부). CLI/UI가 같은 조건을 먼저 검증하고 422/400으로 돌려주며, 작업 상태 표면에 도달하지 않는다 (#29).',
 'legacy-read-scope.ts':'레거시 ReadScope 불변식. 코어 버그이며 사용자 행동이 없다.',
 'fact-policy.ts':'MutationPolicy 불변식. UI는 이 경로를 직접 노출하지 않는다.',
 'chronicle.ts':'Chronicle 근거 계약. 위반은 이벤트 기록 거부로 끝나고 별도 복구 명령이 없다.',
 'codex-exec.ts':'호스트 실행기 계약. 실행 출력으로 도달한다.',
 'fact-integrity.ts':'무결성 감사 CLI 전용 흐름(GUIDE §16).',
 'ontology-admin.ts':'온톨로지 관리 CLI 전용 흐름. Web UI에 해당 화면이 없다.',
 'ontology-db.ts':'온톨로지 쓰기 불변식. 위반은 코어 버그다.',
 'ontology-selector.ts':'park 토큰 형식 불변식. 코어 내부 계약이다.',
 'search.ts':'CLI 날짜 인자 검증. Web UI는 날짜 입력을 따로 검증한다.',
 'db.ts':'DB 열기 계약. 사용자에게는 DB_UNAVAILABLE로 도달한다.',
 'archive-io.ts':'아카이브 압축 해제 런타임 요구. Node 버전 문제로 설치 안내와 겹친다.',
 'lifecycle.ts':'lifecycle 설정 파일 편집 경로.',
 'sync-import.ts':'sync import 동일성 불변식. 세대 거부로 표현된다.',
 'continuity-evidence.ts':'Capsule 근거 페이지 내부 계약. 사용자에게는 Capsule 잘림으로 도달한다.',
 'consolidator.ts':'통합 CAS 계약. 사용자 행동은 stale-fact 안내와 같다.',
 'model-budget.ts':'예산 객체 내부 계약. 사용자에게는 budget_exhausted로 도달한다.',
 'inject-core.ts':'주입 커밋 CAS 계약. 결과는 recall 상태로 표현된다.',
 'llm.ts':'LLM 호출 래퍼 내부 계약. 사용자에게는 모델 시도 오류로 도달한다.',
 'continuity-worker.ts':'worker 내부 계약. 결과는 작업 상태로 표현된다.',
 'fact-extractor.ts':'추출기 내부 계약. 사용자에게는 skip 사유와 작업 상태로 도달한다.',
 'continuity-store.ts':'큐 멱등성 불변식. 위반은 코어 버그다.',
 'sync-cli.ts':'sync CLI 인자 검증. Web UI는 같은 값을 폼에서 검증한다.',
 'zip.ts':'zip 컨테이너 레코드 계약. 사용자에게는 sync-control이 감싼 "sync archive …" 거부 사유로 도달한다.',
};
/** 대장 B — 위 면제에 들지 않는 파일에서, 개별적으로 매핑하지 않기로 한 리터럴. */
const EXEMPT_LITERALS=[
 ['fact-db.ts','fact workspace_id is outside project_id'],
 ['fact-db.ts','fact workstream_id is outside project_id'],
 ['fact-db.ts','project current state requires merged, validated or no-branch-signal evidence'],
 ['fact-db.ts','project decision requires explicit decision evidence'],
 ['fact-db.ts','project-wide truth cannot retain workspace/workstream scope'],
 ['fact-db.ts','workspace state requires workspace_id and validated evidence'],
 ['fact-db.ts','workstream state requires workstream_id and experimental evidence'],
 ['fact-db.ts','workspace truth cannot retain workstream scope'],
 ['fact-db.ts','updateFact cannot change fact text'],
 ['job-recovery.ts','only \'${RECOVERABLE_JOB_STATE}\' work is recovered'],
 ['job-recovery.ts','only \'${RECOVERABLE_TARGET_STATE}\' work is recovered'],
 ['job-recovery.ts','is owned by job'],
 ['ontology-classifier.ts','taxonomy was invalidated during classification'],
 ['ontology-classifier.ts','changed meaning during classification'],
 ['fact-management.ts','fact source_exchange_ids must be a JSON string array'],
 ['fact-management.ts','hard delete requires explicit confirmation (--yes after reviewing impact)'],
 ['fact-management.ts','hard delete requires the exact full UUID'],
 ['fact-management.ts','MutationPolicy is required'],
 ['fact-management.ts','new fact text too short (min 4 chars)'],
 ['fact-management.ts','unsupported fact lineage mode'],
 ['fact-management.ts','demoting'],
 ['fact-management.ts','promoting to project requires project identity'],
 ['fact-management.ts','unknown tier'],
 ['fact-management.ts','no active fact with id'],
 ['fact-management.ts','no inactive fact with id'],
 ['fact-management.ts','fact not found'],
 ['job-recovery.ts','dismiss requires'],
 ['job-recovery.ts','recover requires a job id, a target id, or --all-dead'],
 ['job-recovery.ts','no memory job'],
 ['job-recovery.ts','no memory job or extraction target with id'],
 ['ontology-classifier.ts','ontology classify: fact not found'],
 ['embeddings.ts','embedding model unavailable (MEMEX_EMBEDDING_STUB=fail)'],
 ['sync-paths.ts','device id is not a sync device identifier'],
 // #31 모델 선택 저장 경계의 입력 검증. 두 문장은 사용자가 방금 입력한 값을
 // 그대로 되돌려주는 거부이고, Web UI는 같은 값을 폼에서 먼저 검증한다
 // (sync-cli.ts 면제와 같은 성격).
 ['model-settings.ts','invalid model id'],
 ['model-settings.ts','invalid reasoning effort'],
];

const exemptLiteral=(file,literal)=>EXEMPT_LITERALS.some(([f,prefix])=>f===file&&literal.toLowerCase().includes(prefix.toLowerCase()));
const mapped=value=>{const cls=guidance.classify(value);return !!cls&&cls.id!=='unknown';};

test('코어가 던지는 오류 문자열은 모두 매핑되거나 대장에 명시적으로 올라 있다',()=>{
 const literals=throwLiterals();
 assert(literals.length>200,'추출이 깨졌습니다: '+literals.length);
 const untriaged=[];
 for(const {file,literal} of literals){
  if(EXEMPT_FILES[file])continue;
  if(exemptLiteral(file,literal))continue;
  if(mapped(literal))continue;
  untriaged.push(`${file}: ${literal}`);
 }
 assert.deepEqual(untriaged,[],'분류도 면제도 되지 않은 코어 오류가 있습니다. guidance.mjs에 클래스를 추가하거나 대장에 올리세요:\n'+untriaged.join('\n'));
});

test('대장에 죽은 항목이 없다',()=>{
 const literals=throwLiterals();
 const files=new Set(literals.map(x=>x.file));
 for(const file of Object.keys(EXEMPT_FILES))assert(files.has(file),'src에 더 이상 오류가 없는 면제 파일: '+file);
 for(const [file,prefix] of EXEMPT_LITERALS)assert(literals.some(x=>x.file===file&&x.literal.toLowerCase().includes(prefix.toLowerCase())),`대장 항목이 더 이상 일치하지 않습니다: ${file} / ${prefix}`);
 for(const [,reason] of Object.entries(EXEMPT_FILES))assert(reason.length>10,'면제 사유가 비었습니다');
});

test('코어가 선언한 skip 사유와 terminal 상태는 모두 클래스가 있다',()=>{
 const values=declaredEnums();
 assert(values.length>=15,'enum 추출이 깨졌습니다: '+JSON.stringify(values));
 for(const value of ['excluded_project','failed_visible','budget_exhausted','claim_not_acquired','lease_held','backoff','attempts_exhausted','disabled','unchanged','locked','continuity_backlog','captureGapsOpen','modelWorkBudgetsExhausted','extractionFailedRanges','checkpointsDeadLetter'])
  assert(values.includes(value),'코어 enum 추출에서 빠진 값: '+value);
 const unmapped=values.filter(v=>!mapped(v));
 assert.deepEqual(unmapped,[],'클래스가 없는 skip 사유·상태: '+unmapped.join(', '));
});

test('이슈가 요구한 실패 클래스가 모두 존재한다',()=>{
 for(const id of ['capsule-truncated','budget-exhausted','claim-handoff','claim-backoff','claim-attempts','excluded-project','failed-visible','model-invalid-json','lease-expired','db-unavailable','embedding-unavailable','ontology-parked','ontology-index-repair','job-dead','job-retry','derived-lane-skip','evidence-missing','sync-disabled','sync-never-exported'])
  assert(guidance.guidanceFor(id),'클래스 없음: '+id);
 for(const cls of guidance.CLASSES){
  for(const key of ['title','cause','impact','next','source'])assert(typeof cls[key]==='string'&&cls[key].length>5,`${cls.id}.${key} 누락`);
  assert(typeof cls.ignorable==='boolean',cls.id+': 무시 가능 여부가 참/거짓이 아님');
  assert(Array.isArray(cls.actions)&&cls.actions.length,cls.id+': 액션 없음');
  for(const a of cls.actions)assert(['operation','command','view','diagnostics'].includes(a.kind),cls.id+': 알 수 없는 액션 종류 '+a.kind);
 }
});

/**
 * 0.7.0 (#109): 산문은 `i18n/guidance/{en,ko}.mjs`가 갖고 모듈은 게터로 읽는다. 모듈에 한국어
 * 산문이 되돌아오거나 en 쪽이 비면 여기서 드러난다 — 키 노출은 값이 키와 같아지는 것으로 보인다.
 */
test('클래스 산문은 두 로케일에 다 있고 모듈은 사전 값을 그대로 반환한다',()=>{
 const problems=[];
 const ids=[...guidance.CLASSES.map(c=>c.id),'unknown'];
 for(const id of ids){
  for(const field of ['title','cause','impact','next']){
   const key=`guidance.${id}.${field}`;
   if(!en[key])problems.push('en 누락: '+key);
   if(!ko[key])problems.push('ko 누락: '+key);
  }
 }
 for(const cls of guidance.CLASSES){
  for(const field of ['title','cause','impact','next'])
   if(cls[field]!==ko[`guidance.${cls.id}.${field}`])problems.push(`${cls.id}.${field}가 ko 사전과 다름`);
 }
 const unknown=guidance.unknownClass('x');
 if(unknown.cause!==ko['guidance.unknown.cause'])problems.push('unknown.cause가 ko 사전과 다름');
 // 액션 라벨도 사전이 갖는다. `text`(복사되는 CLI 명령)만 모듈에 남는다.
 for(const cls of [...guidance.CLASSES,unknown])for(const a of cls.actions){
  if(a.kind==='command'){if(!a.text)problems.push(cls.id+': command 액션에 text가 없음');continue;}
  if(!a.labelKey)problems.push(`${cls.id}: ${a.kind} 액션에 labelKey가 없음`);
  else for(const [tag,dict] of [['en',en],['ko',ko]])if(!dict[a.labelKey])problems.push(`${tag} 누락: ${a.labelKey}`);
 }
 assert.deepEqual(problems,[]);
});

/**
 * ★ 설계 §14.4: 한국어 `match` 7건이 서버의 한국어 오류 원문에 의존했고, 서버 메시지를 en 한 줄 +
 * 안정적 코드로 바꾸면 그 규칙들이 **에러 없이 조용히 죽는다.** 구조적으로 다시 들어오지 못하게
 * 막는다 — 규칙은 코드·영어 원문·단어 경계 정규식 중 하나여야 한다.
 */
test('match 규칙에 한글이 없다 (#109)',()=>{
 const hangul=[];
 for(const cls of guidance.CLASSES)for(const rule of cls.match)
  if(/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(String(rule)))hangul.push(cls.id+': '+String(rule));
 assert.deepEqual(hangul,[],'한국어 match는 서버 메시지가 영어가 되면 조용히 죽습니다: '+hangul.join(', '));
});

test('알 수 없는 오류는 원인을 지어내지 않고 원문과 진단 안내를 남긴다',()=>{
 const cls=guidance.classify('완전히 새로운 오류 문자열 zzqq');
 assert.equal(cls.id,'unknown');
 assert.equal(cls.raw,'완전히 새로운 오류 문자열 zzqq');
 assert.equal(cls.ignorable,null);
 assert.equal(cls.cause,ko['guidance.unknown.cause']);
 assert(cls.cause.includes('추측하지 않습니다'));
 assert(/do not guess/i.test(en['guidance.unknown.cause']),'en에서도 원인을 추측하지 않는다고 말해야 합니다');
 assert(cls.actions.some(a=>a.kind==='diagnostics'));
 assert.equal(guidance.classify(''),null);
 assert.equal(guidance.classify(null),null);
});

test('진행 중이거나 정상인 기록에는 안내를 붙이지 않는다',()=>{
 assert.equal(guidance.jobGuidance({state:'completed',last_error:null}),null);
 assert.equal(guidance.jobGuidance({state:'running',last_error:null,lease_until:new Date(Date.now()+60000).toISOString()}),null);
 assert.equal(guidance.jobGuidance({state:'running',last_error:null,lease_until:new Date(Date.now()-60000).toISOString()}).id,'lease-expired');
 // #79: terminal·대기 상태가 오류 문자열보다 먼저다. 문자열이 무시 가능한 클래스에 걸려도
 // 그 상태에 필요한 복구·대기 안내가 사라지지 않는다.
 const dead=guidance.jobGuidance({state:'dead',last_error:'capsule patch exceeds bounded storage size'});
 assert.equal(dead.id,'job-dead');
 assert.equal(dead.ignorable,false);
 assert(dead.actions.some(a=>a.kind==='command'&&a.text.includes('memex recover'))||dead.actions.some(a=>a.kind==='operation'&&a.command==='recover'),'복구 액션이 없음');
 assert.equal(guidance.jobGuidance({state:'dead',last_error:null}).id,'job-dead');
 assert.equal(guidance.jobGuidance({state:'retry',last_error:'MODEL_BUDGET_EXHAUSTED: deadline reached'}).id,'job-retry');
 // 상태가 terminal이 아닌 기록에서는 문자열 분류가 그대로 이긴다.
 assert.equal(guidance.jobGuidance({state:'completed',last_error:'capsule patch truncated: dropped 2 items'}).id,'capsule-truncated');
 assert.equal(guidance.jobGuidance({state:'completed',last_error:'MODEL_BUDGET_EXHAUSTED: deadline reached'}).id,'budget-exhausted');
 assert.equal(guidance.attemptGuidance({state:'completed',error_message:null,error_class:null}),null);
 assert.equal(guidance.attemptGuidance({state:'failed',error_class:'deadline_exceeded',error_message:'Model work deadline exceeded'}).id,'budget-exhausted');
 assert.equal(guidance.operationGuidance({status:'completed',exit_code:0}),null);
 assert.equal(guidance.operationGuidance({status:'failed',exit_code:2}).id,'operation-incomplete');
});

test('짧은 열거값은 단어 경계로만 매칭한다 (#80)',()=>{
 // 자유 텍스트 안의 broadcast·case·casing은 claim 사유가 아니다. 원인을 지어내지 않고 unknown으로 둔다.
 for(const raw of ['broadcast failed','unsupported case in patch builder','casing mismatch','exit 25: unknown'])
  assert.equal(guidance.classify(raw).id,'unknown','부분 문자열로 원인을 단정함: '+raw);
 // 진짜 열거값은 계속 매칭한다.
 assert.equal(guidance.classify('cas conflict').id,'claim-handoff');
 assert.equal(guidance.classify('claim lost to a concurrent writer').id,'claim-handoff');
 assert.equal(guidance.classify('exit 2').id,'operation-incomplete');
 assert.equal(guidance.classify('backoff until 2026-09-10T00:00:00Z').id,'claim-backoff');
 // 카탈로그 불변식: 6자 이하의 짧은 열거값을 문자열로 남겨 두지 않는다.
 // 0.7.0 (#109): ASCII 전용 `/^[a-z0-9 ]{1,6}$/`는 `'임베딩'` 같은 한국어 2글자 규칙을 못 막았다.
 // 유니코드로 확장해 어떤 문자 체계의 짧은 열거값도 단어 경계 정규식을 쓰게 강제한다(설계 §14.4).
 const short=[];
 for(const cls of guidance.CLASSES)for(const rule of cls.match)
  if(typeof rule==='string'&&/^[\p{L}\p{N} ]{1,6}$/u.test(rule))short.push(cls.id+': '+rule);
 assert.deepEqual(short,[],'짧은 열거값은 /\\b…\\b/ 정규식으로 써야 합니다: '+short.join(', '));
});

test('모델 호출 실패와 응답 형식 오류를 분리한다 (#80)',()=>{
 const call=guidance.classify('LLM call failed: authentication expired');
 assert.equal(call.id,'model-call-failed');
 assert(call.cause.includes('네트워크'),'호출 경로 문제라고 말하지 않음');
 assert(!call.cause.includes('JSON'),'응답 형식 문제로 설명함');
 assert.equal(guidance.classify('TransientLlmError: fetch failed').id,'model-call-failed');
 assert.equal(guidance.classify('spawn codex ENOENT').id,'model-call-failed');
 assert.equal(guidance.classify('ontology classify: unparseable LLM response').id,'model-invalid-json');
 assert.equal(guidance.classify('model returned invalid json').id,'model-invalid-json');
 assert(!guidance.guidanceFor('model-invalid-json').match.some(r=>String(r).includes('llm call failed')),'응답 형식 클래스가 호출 실패 문자열을 계속 매칭함');
 assert(guidance.CLASSES.findIndex(c=>c.id==='model-call-failed')<guidance.CLASSES.findIndex(c=>c.id==='model-invalid-json'),'호출 실패 클래스가 더 뒤에 있어 이기지 못함');
});

test('과거 Capsule 상한 실패는 정상 잘림과 다른 클래스다 (#79)',()=>{
 const legacy=guidance.classify('capsule patch exceeds bounded storage size');
 assert.equal(legacy.id,'capsule-bound-exceeded');
 assert.equal(legacy.ignorable,false,'복구가 필요한 과거 실패를 무시 가능으로 단정함');
 assert(legacy.next.includes('memex recover'),'복구 명령을 안내하지 않음');
 assert(legacy.cause.includes('0.6.1'),'언제부터 잘라서 저장하는지 밝히지 않음');
 const truncated=guidance.classify('capsule patch truncated: dropped 2 low-priority items');
 assert.equal(truncated.id,'capsule-truncated');
 assert.equal(truncated.ignorable,true);
 assert(!guidance.guidanceFor('capsule-truncated').match.some(r=>String(r).includes('exceeds bounded storage size')),'정상 잘림 클래스가 과거 실패 문자열을 계속 매칭함');
});

test('개요 경고 카드는 클래스별로 묶고 0은 만들지 않는다',()=>{
 assert.deepEqual(guidance.attentionFromPipeline(null),[]);
 const empty=guidance.attentionFromPipeline({attention:{memoryJobsDead:0,memoryJobsRetry:0,terminal:{}},ontology:{parkedFacts:0,indexRepair:{blocked:false}},evidence:{factsWithoutLocalEvidence:0},quarantinedProjects:[]});
 assert.deepEqual(empty,[]);
 const groups=guidance.attentionFromPipeline({
  attention:{memoryJobsDead:7,memoryJobsRetry:2,terminal:{capsuleCheckpointFailedVisible:1,modelWorkBudgetsExhausted:3}},
  ontology:{parkedFacts:4,indexRepair:{blocked:true,reason:'write'}},
  evidence:{factsWithoutLocalEvidence:118},
  derivedLaneSkips:{consecutive:2},
  quarantinedProjects:[{projectId:'p'}],
 });
 const ids=groups.map(g=>g.cls.id);
 assert.equal(ids[0],'ontology-index-repair','차단된 인덱스 수리가 가장 위에 와야 함');
 for(const id of ['job-dead','job-retry','failed-visible','budget-exhausted','ontology-parked','evidence-missing','quarantined-project','derived-lane-skip'])assert(ids.includes(id),'빠진 클래스: '+id);
 assert.equal(groups.find(g=>g.cls.id==='job-dead').count,7);
 assert.equal(groups.find(g=>g.cls.id==='evidence-missing').count,118);
});

test('안내 렌더링은 기존 컴포넌트만 쓰고 액션을 실제 버튼으로 만든다',()=>{
 const ctx={href:(p,q={})=>p+'?'+new URLSearchParams(q),bootstrap:{environment:{commands:true}}};
 const html=guidance.guidancePanel(guidance.guidanceFor('job-dead'),ctx);
 assert(html.includes('data-command="recover"'),'복구 실행 버튼 없음');
 assert(html.includes('data-copy-command="memex jobs dismiss'),'복사 가능한 정리 명령 없음');
 assert(html.includes(DOC_ANCHORS.GUIDE_FAIL),'단일 출처 표기가 없음');
 assert(html.includes(ko['guidance.source.label']),'단일 출처 라벨이 없음');
 assert(!/class="[^"]*guidance-/.test(html),'새 컴포넌트 클래스를 도입했습니다');
 for(const cls of ['card','tag','btn','kv'])assert(html.includes('class="'+cls)||html.includes(' '+cls),'기존 컴포넌트 미사용: '+cls);
 const locked=guidance.guidancePanel(guidance.guidanceFor('job-dead'),{href:ctx.href,bootstrap:{environment:{commands:false}}});
 assert(/data-command="recover" disabled/.test(locked),'CLI가 없으면 실행 버튼을 잠가야 함');
 const groups=guidance.attentionFromPipeline({attention:{memoryJobsDead:7,terminal:{}},ontology:{indexRepair:{blocked:false}},evidence:{},quarantinedProjects:[]});
 const card=guidance.attentionCard(groups,ctx);
 assert(card.includes(ko['guidance.attention.heading']),'카드 제목이 사전 값과 다릅니다');
 // 수량은 사전의 1슬롯 패턴이 어순까지 갖는다 — 타이포그래피 이어붙이기를 없앴다(설계 §6.0).
 assert.equal(groups[0].detail,ko['guidance.attention.job-dead.detail'].replace('{count}','7'));
 assert(card.includes(groups[0].detail),'수량 라벨이 렌더되지 않았습니다');
 assert(card.includes(ko['guidance.job-dead.title']));
 assert.equal(guidance.attentionCard([],ctx),'');
});

/**
 * ★ 설계 §14.4 완화 (2). `guidance.test.cjs`의 기존 커버리지 테스트는 `src/*.ts`의 **코어** 오류
 * 리터럴만 수확하고 `ui/lib`의 메시지는 보지 않는다. 서버 메시지가 en 한 줄 + 안정적 코드로 바뀌면
 * 분류는 **코드**를 봐야 하므로, `ui/lib`이 던지는 모든 `HttpError`의 `code`를 수확해 각각이
 * 클래스에 매핑되거나 면제 대장에 올라 있는지 대조한다 — 이 구멍을 구조적으로 막는 유일한 방법이다.
 */
function uiLibCodes(){
 const out=new Map();   // code → [file:line]
 const uncoded=[];
 const add=(code,where)=>{if(!out.has(code))out.set(code,[]);out.get(code).push(where);};
 for(const file of fs.readdirSync(UI_LIB).filter(f=>f.endsWith('.cjs'))){
  const src=fs.readFileSync(path.join(UI_LIB,file),'utf8');
  const sf=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const at=node=>`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1}`;
  const hasCode=node=>{let found=false;(function s(i){if(ts.isPropertyAssignment(i)&&i.name&&i.name.getText(sf)==='code')found=true;ts.forEachChild(i,s);})(node);return found;};
  (function visit(node){
   if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='HttpError'){
    const args=node.arguments??[];
    // 레거시 위치 인자 3번째(legacyCode)와 객체 인자의 `code:` 둘 다 본다(설계 §16.1 C1.8).
    if(args[2]&&ts.isStringLiteral(args[2]))add(args[2].text,at(node));
    for(const arg of args)(function scan(inner){
     if(ts.isObjectLiteralExpression(inner))for(const prop of inner.properties)
      if(ts.isPropertyAssignment(prop)&&prop.name&&prop.name.getText(sf)==='code'&&ts.isStringLiteral(prop.initializer))add(prop.initializer.text,at(node));
     ts.forEachChild(inner,scan);
    })(arg);
    if(args[1]&&!(args[2]&&ts.isStringLiteral(args[2]))&&!hasCode(args[1]))uncoded.push(at(node));
   }
   ts.forEachChild(node,visit);
  })(sf);
 }
 return {codes:out,uncoded};
}

/** 코드 → 기대 클래스 id. 값이 맞아야 하고, 코드가 사라지면 죽은 항목으로 잡힌다. */
const UI_CODE_CLASSES={
 DB_UNAVAILABLE:'db-unavailable',
 DB_INDEX_MISSING:'db-unavailable',
 STALE_FACT:'stale-fact',
 TIER_STEP:'tier-step',
 INVALID_SYNC_DIR:'sync-export-failed',
 SYNC_DIR_UNWRITABLE:'sync-export-failed',
 INVALID_ARCHIVE:'sync-archive-invalid',
 INVALID_ARCHIVE_PATH:'sync-archive-invalid',
 SYNC_DIR_REQUIRED:'sync-export-failed',
};
/**
 * ★ L1에서 올 코드. 분류 규칙을 먼저 두어 L1 머지 시점에 회귀 창이 생기지 않게 했다(설계 §6.1).
 * L1이 머지되면서 `SYNC_DIR_REQUIRED`는 실제로 `ui/lib/core.cjs`에 들어왔고 위 표로 옮겼다 —
 * 이 목록이 비어 있는 것이 정상 상태다.
 */
const EXPECTED_FROM_L1={};
/** 실패 클래스를 두지 않는 코드. 화면에서 취할 행동이 폼·요청 그 자체이거나 코어 버그다. */
const UI_CODE_EXEMPT={
 AMBIGUOUS_PROJECT:'같은 경로에 프로젝트가 여러 개다. 상단 범위 선택으로 해소하고 복구 명령이 없다.',
 CONFIRMATION_REQUIRED:'영향을 확인한 뒤 확인 입력을 요구하는 가드. 다음 행동이 화면의 입력 자체다.',
 CORE_UNAVAILABLE:'설치된 코어에 그 서비스가 없다. 오류 카드가 코드를 그대로 보여주고 진단이 같은 말을 한다.',
 CSRF_REJECTED:'요청 위조 방어. 사용자가 취할 행동은 화면을 다시 불러오는 것뿐이다.',
 HOST_REJECTED:'루프백이 아닌 Host 헤더 거부. 서버 바인딩 정책이며 데이터 상태가 아니다.',
 INVALID_COMMAND:'allowlist에 없는 관리 명령. 버튼으로만 실행되므로 사용자 경로에서 발생하지 않는다.',
 INVALID_ID:'UUID 형식 검증. 다음 행동이 입력 수정이다.',
 INVALID_NUMBER:'정수·범위 검증. 다음 행동이 입력 수정이다.',
 INVALID_SCOPE:'조회 범위 인자 검증. 상단 컨트롤이 값을 만들므로 사용자 경로에서 발생하지 않는다.',
 MUTATION_BUSY:'같은 기억에 변경이 진행 중이다. 잠시 뒤 다시 시도하는 것이 전부다.',
 NOT_FOUND:'없는 리소스. 실패 클래스가 아니라 404다.',
 OPERATION_BUSY:'관리 실행이 이미 진행 중이다. 실행 내역에서 진행 상황을 본다.',
 ORIGIN_REJECTED:'교차 출처 거부. 서버 정책이며 데이터 상태가 아니다.',
 SCHEMA_UNAVAILABLE:'기대한 테이블이 없는 구버전 DB. 코어 업그레이드 안내와 겹친다.',
 SCOPE_MISMATCH:'범위와 대상이 어긋난 요청. 상단 범위를 맞추면 해소된다.',
 SYNC_BUSY:'동기화 작업이 진행 중이다. 잠시 뒤 다시 시도하는 것이 전부다.',
 TIER_TARGET_REQUIRED:'계층 이동의 대상 범위를 먼저 골라야 한다. 다음 행동이 상단 범위 선택이다.',
 // ── L1이 0.7.0에서 새로 부여한 코드 (설계 §5.3 "38건에 안정적인 code 부여") ──
 // 전부 **요청 모양·입력 형식** 검증이다: 데이터 상태를 말하지 않으므로 실패 클래스를 두면
 // 복구 절차를 지어내게 된다. 오류 카드가 문장과 코드를 보여주는 것이 취할 수 있는 전부다.
 ARCHIVE_PATH_REQUIRED:'세대 파일 경로를 입력하라는 요구. 다음 행동이 그 입력 자체다.',
 BODY_TOO_LARGE:'요청 본문 상한 초과. 화면이 보내는 크기는 고정이므로 사용자 경로에서 발생하지 않는다.',
 INVALID_ACTION:'실행 내역 API가 cancel만 받는다. 버튼으로만 호출되므로 사용자 경로에서 발생하지 않는다.',
 INVALID_FACT_ACTION:'기억 변경 action allowlist(edit·deactivate·restore·delete). 화면이 값을 만든다.',
 INVALID_FACT_STATE:'기억 상태 필터 검증(all·active·inactive). 상단 컨트롤이 값을 만든다.',
 INVALID_FACT_TEXT:'기억 본문 길이 검증. 다음 행동이 입력 수정이며 수정 모달이 같은 한도를 안내한다.',
 INVALID_FILE:'일반 파일이 아닌 로그 경로. 목록이 고른 항목만 열리므로 사용자 경로에서 발생하지 않는다.',
 INVALID_JSON:'요청 본문이 JSON 객체가 아니다. 화면이 직렬화하므로 사용자 경로에서 발생하지 않는다.',
 INVALID_PATH:'정적 에셋 경로 검증. 링크만 값을 만든다.',
 INVALID_RELATION:'관계 유형 필터 검증. 지식 지도의 범례가 값을 만든다.',
 INVALID_SYNC_ACTION:'동기화 action allowlist. 화면의 버튼만 값을 만든다.',
 INVALID_TIER_ACTION:'계층 이동 action allowlist(promote·demote). 버튼만 값을 만든다.',
 INVALID_URL:'요청 URL 파싱 실패. 브라우저가 만든 주소이므로 사용자 경로에서 발생하지 않는다.',
 METHOD_NOT_ALLOWED:'라우트가 허용하지 않는 HTTP 메서드. 화면은 정해진 메서드만 보낸다.',
 REQUEST_ABORTED:'클라이언트가 요청을 끊었다. 화면 전환·취소의 정상 결과이며 실패가 아니다.',
 TOO_MANY_CLIENTS:'실시간 연결 상한(24). 탭을 줄이면 해소되고 데이터 상태와 무관하다.',
 UNSUPPORTED_MEDIA_TYPE:'Content-Type 검증. 화면이 헤더를 붙이므로 사용자 경로에서 발생하지 않는다.',
};

test('ui/lib이 던지는 오류 코드는 모두 클래스가 있거나 대장에 올라 있다 (#109)',()=>{
 const {codes,uncoded}=uiLibCodes();
 assert(codes.size>15,'코드 수확이 깨졌습니다: '+codes.size);
 const untriaged=[],wrong=[];
 for(const [code,where] of codes){
  const expected=UI_CODE_CLASSES[code];
  if(expected){
   const cls=guidance.classify({code});
   if(!cls||cls.id!==expected)wrong.push(`${code} → ${cls?cls.id:'null'} (기대: ${expected}, ${where[0]})`);
   continue;
  }
  if(UI_CODE_EXEMPT[code])continue;
  untriaged.push(`${code} (${where[0]})`);
 }
 assert.deepEqual(untriaged,[],'분류도 면제도 되지 않은 UI 오류 코드가 있습니다. guidance.mjs의 match에 코드를 넣거나 대장에 올리세요:\n'+untriaged.join('\n'));
 assert.deepEqual(wrong,[],'코드가 기대한 클래스로 가지 않습니다:\n'+wrong.join('\n'));
 // L1이 부여할 코드는 아직 없어도 되지만 규칙은 지금 있어야 한다.
 for(const [code,expected] of Object.entries(EXPECTED_FROM_L1)){
  const cls=guidance.classify({code});
  assert(cls&&cls.id===expected,`L1에서 올 코드의 규칙이 없습니다: ${code} → ${cls?cls.id:'null'} (기대: ${expected})`);
 }
 // 대장에 죽은 항목을 남기지 않는다 — L1 예정 코드는 예외다.
 for(const code of [...Object.keys(UI_CODE_CLASSES),...Object.keys(UI_CODE_EXEMPT)])
  if(!EXPECTED_FROM_L1[code])assert(codes.has(code),'ui/lib에 더 이상 없는 코드가 대장에 남아 있습니다: '+code);
 for(const reason of Object.values(UI_CODE_EXEMPT))assert(reason.length>10,'면제 사유가 비었습니다');
 // 코드 없이 던지는 호출은 전부 REQUEST_FAILED로 뭉개진다(설계 §1.3 (12)). L1이 38건에 코드를
 // 부여하므로 수가 늘어나면 실패한다 — 줄어드는 방향만 허용한다.
 assert(uncoded.length<=38,`code 없는 HttpError가 늘었습니다(${uncoded.length} > 38):\n`+uncoded.join('\n'));
});

/** 코드는 레코드의 `code`/`error_code`로 들어온다 — haystack이 그 필드를 봐야 분류가 동작한다. */
test('오류 코드는 레코드 필드로도 분류된다 (#109)',()=>{
 assert.equal(guidance.classify({code:'DB_INDEX_MISSING'}).id,'db-unavailable');
 assert.equal(guidance.classify({error_code:'SYNC_DIR_UNWRITABLE'}).id,'sync-export-failed');
 assert.equal(guidance.classify({code:'TIER_STEP',state:'failed'}).id,'tier-step');
 assert.equal(guidance.classify({code:'REQUEST_FAILED'}).id,'unknown','원인을 모르는 기본 코드를 단정하지 않습니다');
});
