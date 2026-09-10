// 실패 클래스 카탈로그 (#23, i18n #109).
//
// 단일 출처는 docs/GUIDE.md §20 "문제가 생겼을 때 — 실패 클래스별 복구"이고 이 파일은 거기서
// 파생한 UI 표현이다. 코어가 남긴 last_error / error_class / skip 사유 / 상태 줄을 클래스로
// 옮기고, 각 클래스마다 원인 · 영향 · 다음 행동 · 액션 · 무시 가능 여부를 정의한다.
//
// 규칙 하나: **매핑되지 않은 오류의 원인을 지어내지 않는다.** 모르는 문자열은 원문 그대로
// 보여주고 진단 내보내기로 안내한다(unknown 클래스).
//
// 0.7.0 (#109): 산문은 전부 `i18n/guidance/{en,ko}.mjs`로 내려갔고, 이 모듈에는 **구조와
// 로직만** 남는다 — `CLASSES`의 순서(= classify의 우선순위), `id`, `match`, `ignorable`,
// 액션 서술자, `source` 앵커. `title`/`cause`/`impact`/`next`는 접근 시점에 `t()`로 읽는
// 게터다(모듈 최상위에서 평가하면 사전이 꽂히기 전에 키가 굳는다 — 설계 §2.6).
//
// **`match`는 사전으로 내리지 않는다**(설계 §6.1): 로케일마다 분류 결과가 달라지면
// `guidance.test.cjs`가 코어 오류 리터럴 200+개로 강제하는 커버리지가 로케일별로 포크되고,
// #80의 단어 경계 불변식도 언어별로 갈라진다. 규칙은 **코드·키·영어 원문만** 쓴다.
import {esc,icon,btn,linkBtn,kv,number} from './ui.mjs';
import {t} from './i18n/index.mjs';
import {DOC_ANCHORS as A} from './i18n/doc-anchors.mjs';

const GUIDE=A.GUIDE_FAIL;
const RECOVER=[{kind:'operation',command:'recover',labelKey:'guidance.action.recoverDeadWork'},{kind:'command',text:'memex recover --all-dead --dry-run'}];
// 0.7.0 (#109): `--reason "왜 포기하는가"`는 **버튼 텍스트이자 복사되는 CLI 명령**이었다.
// 명령 문자열은 번역 대상이 아니므로 한국어를 중립 플레이스홀더로 바꾼다.
const DISMISS={kind:'command',text:'memex jobs dismiss <job-id> --reason "<reason>"'};

/** 산문 4필드를 사전에서 지연 조회한다. 구조 필드는 그대로 둔다. */
const failure=(id,spec)=>({id,...spec,
 get title(){return t(`guidance.${id}.title`);},
 get cause(){return t(`guidance.${id}.cause`);},
 get impact(){return t(`guidance.${id}.impact`);},
 get next(){return t(`guidance.${id}.next`);}});

/**
 * 클래스 목록. `match`의 문자열은 소문자 비교로 부분 일치, 정규식은 그대로 시험한다.
 * 위에 있는 클래스가 먼저 이긴다.
 *
 * 규칙 (0.6.3 #80): **짧은 열거값은 반드시 단어 경계 정규식으로 쓴다.** 부분 일치로 두면
 * `cas`가 `broadcast`·`case`·`casing`에, `exit 2`가 `exit 25`에 걸려서, 원인을 모르는 오류를
 * "무시해도 되는 원인"으로 단정한다 — 이 카탈로그가 금지하는 바로 그 날조다. 여러 단어로 된
 * 문장이나 코어의 긴 오류 원문만 부분 일치로 둔다.
 *
 * 규칙 (0.7.0 #109): **한국어 `match`를 두지 않는다.** 서버 메시지가 en 한 줄 + 안정적 코드로
 * 바뀌었으므로 한국어 원문에 의존한 규칙은 에러 없이 조용히 죽는다(설계 §14.4). 규칙은 코드
 * (`db_index_missing`), 영어 원문, 단어 경계 정규식 중 하나여야 한다.
 */
export const CLASSES=[
 failure('db-unavailable',{
  // 0.7.0 (#109): 인덱스 DB 누락에 DB_INDEX_MISSING 코드가 붙었고 서버 메시지는 영어 한 줄이
  // 됐다. 한국어 원문 매칭('인덱스 db가 없습니다')은 삭제하고 코드·영어 원문만 남긴다.
  match:['db_unavailable','db_index_missing','index database is missing','database is locked','unable to open database','sqlite_cantopen'],
  ignorable:false,actions:[{kind:'operation',command:'doctor',labelKey:'guidance.action.runDoctor'},{kind:'operation',command:'sync',labelKey:'guidance.action.syncConversations'},{kind:'view',to:'/settings',query:{tab:'runtime'},labelKey:'guidance.action.viewRuntime'}],
  source:A.GUIDE_DIAG}),

 failure('deps-missing',{
  match:['runtime deps missing','better-sqlite3','@xenova/transformers','sqlite-vec','memex deps materialize'],
  ignorable:false,actions:[{kind:'command',text:'memex deps materialize'},{kind:'operation',command:'doctor',labelKey:'guidance.action.runDoctor'}],
  source:GUIDE}),

 // 0.6.3 (#79): 과거 실패 문자열은 "정상 잘림"과 다른 클래스다. 0.6.1 이전 코어는 같은 상한에서
 // 작업을 terminal 상태로 죽였고, 업그레이드만으로는 재개되지 않으므로 복구가 필요하다.
 // capsule-truncated보다 먼저 와야 그 문자열이 무시 가능으로 떨어지지 않는다.
 failure('capsule-bound-exceeded',{
  match:['capsule patch exceeds bounded storage size'],
  ignorable:false,actions:[...RECOVER,{kind:'view',to:'/activity',query:{tab:'jobs',state:'dead'},labelKey:'guidance.action.viewDeadJobs'}],
  source:A.GUIDE_RECOVER}),

 failure('capsule-truncated',{
  match:['capsule patch truncated','capsule evidence fragment exceeds page budget','memex_capsule_max_chars'],
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'runtime'},labelKey:'guidance.action.viewEnvVars'}],
  source:GUIDE}),

 failure('budget-exhausted',{
  match:['budget_exhausted','model_budget_exhausted','model work deadline exceeded','deadline_exceeded','modelworkbudgetsexhausted',/budget.*(deadline|window|attempts)/i],
  ignorable:false,actions:[{kind:'command',text:'memex model-work status'},{kind:'command',text:'memex model-work resume <id> --new-run'},{kind:'view',to:'/activity',query:{tab:'attempts'},labelKey:'guidance.action.viewAttempts'}],
  source:A.GUIDE_BUDGET}),

 failure('claim-handoff',{
  match:['lease_held','claim lost to a concurrent writer','claim lost',/\bcas\b/],
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'jobs',state:'running'},labelKey:'guidance.action.viewRunningJobs'}],
  source:GUIDE}),

 failure('claim-backoff',{
  match:[/\bbackoff\b/,'retry backoff','memoryjobsbackoff'],
  ignorable:true,actions:[{kind:'command',text:'memex jobs list --state retry'},{kind:'command',text:'memex jobs retry <job-id>'}],
  source:GUIDE}),

 failure('claim-attempts',{
  match:['attempts_exhausted','attempt cap reached'],
  ignorable:false,actions:[...RECOVER,DISMISS],
  source:GUIDE}),

 failure('claim-error',{
  match:['claim_not_acquired','claim_error'],
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'logs',level:'error'},labelKey:'guidance.action.viewErrorLogs'}],
  source:GUIDE}),

 failure('excluded-project',{
  match:['excluded_project','excluded_project_unmarked'],
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'runtime'},labelKey:'guidance.action.viewEnvironment'}],
  source:A.GUIDE_DO_NOT_INDEX}),

 failure('failed-visible',{
  match:['failed_visible','failed-visible','extractiontargetitemsfailedvisible','checkpointsfailedvisible','capsulecheckpointfailedvisible'],
  ignorable:false,actions:[...RECOVER,{kind:'view',to:'/activity',query:{tab:'jobs'},labelKey:'guidance.action.viewJobs'}],
  source:A.GUIDE_RECOVER}),

 failure('job-dead',{
  match:[/\bdead-letter\b/,/\bdead\b/,'checkpointsdeadletter','extractiontargetsdead','memoryjobsdead'],
  ignorable:false,actions:[...RECOVER,DISMISS,{kind:'view',to:'/activity',query:{tab:'jobs',state:'dead'},labelKey:'guidance.action.viewDeadJobs'}],
  source:GUIDE}),

 failure('job-retry',{
  match:[/\bretry\b/,'memoryjobsretry'],
  ignorable:true,actions:[{kind:'command',text:'memex jobs list --state retry'},{kind:'view',to:'/activity',query:{tab:'jobs',state:'retry'},labelKey:'guidance.action.viewRetryJobs'}],
  source:GUIDE}),

 failure('extraction-failed-range',{
  match:['extractionfailedranges','extraction_failed_ranges'],
  ignorable:false,actions:RECOVER,source:GUIDE}),

 failure('capture-gap',{
  match:['capturegapsopen','capture gap'],
  ignorable:true,actions:[{kind:'command',text:'memex status'}],source:GUIDE}),

 failure('lease-expired',{
  // 0.7.0 (#109): '임대 만료'는 details.mjs의 kv 라벨에서 온 실질 데드 규칙이라 삭제했다.
  match:['lease expired','lease_expired'],
  ignorable:false,actions:[...RECOVER,{kind:'view',to:'/activity',query:{tab:'jobs',state:'running'},labelKey:'guidance.action.viewRunningJobs'}],
  source:GUIDE}),

 // 0.6.3 (#80): 호출 자체가 실패한 것과 응답 형식이 틀린 것은 원인이 반대다. 이 클래스가
 // model-invalid-json보다 먼저 와야 TransientLlmError가 "응답 형식 문제"로 뒤바뀌지 않는다.
 failure('model-call-failed',{
  match:['llm call failed','transientllmerror','fetch failed',/\bspawn\b/,/\beconnrefused\b/,/\betimedout\b/],
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'attempts',state:'failed'},labelKey:'guidance.action.viewAttempts'},{kind:'operation',command:'doctor',labelKey:'guidance.action.runDoctor'}],
  source:GUIDE}),

 failure('model-invalid-json',{
  match:['unparseable llm response','invalid json','model returned invalid json','unusable domain/category name','empty llm response'],
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'attempts',state:'failed'},labelKey:'guidance.action.viewAttempts'}],
  source:GUIDE}),

 failure('embedding-unavailable',{
  // 0.7.0 (#109): '임베딩'은 **2글자 한국어 부분 일치**였다 — #80이 금지한 "짧은 열거값"의
  // 한국어 버전이다. 단어 경계 정규식으로 바꿨다.
  match:[/\bembedding\b/,'candidate embedding unavailable','embedder','vec_facts',/\bvec0\b/],
  ignorable:false,actions:[{kind:'operation',command:'doctor',labelKey:'guidance.action.runDoctor'},{kind:'operation',command:'embeddings',labelKey:'guidance.action.backfillEmbeddings'},{kind:'command',text:'memex deps materialize'}],
  source:A.GUIDE_DIAG}),

 failure('ontology-parked',{
  match:[/\bparked\b/,'ontology_state','ontology park'],
  ignorable:true,actions:[{kind:'operation',command:'ontology',labelKey:'guidance.action.backfillOntology'},{kind:'view',to:'/taxonomy',labelKey:'guidance.action.viewTaxonomy'}],
  source:A.GUIDE_ONTOLOGY_REPAIR}),

 failure('ontology-index-repair',{
  match:['index repair','indexrepairerror','category index repair failed','category index unavailable','category index incomplete'],
  ignorable:false,actions:[{kind:'operation',command:'embeddings',labelKey:'guidance.action.backfillEmbeddings'},{kind:'operation',command:'doctor',labelKey:'guidance.action.runDoctor'}],
  source:A.GUIDE_ONTOLOGY_REPAIR}),

 failure('derived-lane-skip',{
  match:['continuity_backlog','derived lane','derived_lane'],
  ignorable:true,actions:[{kind:'command',text:'memex jobs list --state retry'},{kind:'view',to:'/activity',query:{tab:'jobs'},labelKey:'guidance.action.viewJobs'}],
  source:A.GUIDE_CONTINUITY}),

 failure('evidence-missing',{
  match:['local meaning evidence not recorded','factswithoutlocalevidence','backfill receipts','source evidence changed or is unresolvable'],
  ignorable:false,actions:[{kind:'command',text:'memex backfill receipts'},{kind:'view',to:'/facts',labelKey:'guidance.action.viewFacts'}],
  source:A.GUIDE_FACTS}),

 failure('evidence-unresolved',{
  // 0.7.0 (#109): '근거로 지목된 원문'은 e2e 픽스처의 한국어 문장에만 걸렸고 `evidence_unresolved`
  // 코드가 같은 것을 이미 잡는다 — 중복이므로 삭제했다.
  match:['evidence_unresolved','invalid evidence references'],
  ignorable:false,actions:[{kind:'operation',command:'sync',labelKey:'guidance.action.syncConversations'},...RECOVER],
  source:GUIDE}),

 failure('stale-fact',{
  match:['stale_fact','stalefactmutationerror','changed during','changed before semantic mutation','discarded: fact'],
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'chronicle'},labelKey:'guidance.action.viewChronicle'}],
  source:A.GUIDE_FACTS}),

 failure('tier-step',{
  match:['tier_step','tierstepError','tier ladder moves one step at a time','not adjacent'],
  ignorable:true,actions:[{kind:'view',to:'/facts',labelKey:'guidance.action.viewFacts'}],
  source:A.GUIDE_FACTS}),

 failure('receipt-failed',{
  match:['receipt-failed','failed to persist prepared recall receipt','recall-provenance'],
  ignorable:false,actions:[{kind:'operation',command:'doctor',labelKey:'guidance.action.runDoctor'},{kind:'view',to:'/activity',query:{tab:'recalls'},labelKey:'guidance.action.viewRecalls'}],
  source:A.GUIDE_DIAG}),

 failure('no-match',{
  // 0.7.0 (#109): '관련 기억 없음'은 **UI 표시 라벨**(badge.no-match.label)을 오류로 재분류하던
  // 규칙이었다. `no-match`/`no_match` 코드가 같은 것을 잡으므로 삭제했다.
  match:['no-match','no_match'],
  ignorable:true,actions:[{kind:'view',to:'/facts',query:{tiers:'all'},labelKey:'guidance.action.viewFactsAllTiers'}],
  source:A.GUIDE_UI}),

 failure('quarantined-project',{
  match:['quarantined','untrusted cwd','untrustedprojectpatherror'],
  ignorable:false,actions:[{kind:'command',text:'memex facts list --scope all'},{kind:'view',to:'/facts',query:{scope:'all'},labelKey:'guidance.action.viewAllFacts'}],
  source:GUIDE}),

 failure('sync-disabled',{
  match:['cross-device sync is off','sync disabled','skipped(off)',/^\s*disabled\s*$/],
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},labelKey:'guidance.action.syncSettings'}],
  source:A.GUIDE_SYNC}),

 failure('sync-never-exported',{
  match:['never exported','sync-export: warn'],
  ignorable:false,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},labelKey:'guidance.action.syncSettings'}],
  source:A.GUIDE_SYNC}),

 failure('sync-locked',{
  match:['another export is in progress','export locked',/^\s*locked\s*$/],
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},labelKey:'guidance.action.syncStatus'}],
  source:A.GUIDE_SYNC}),

 failure('sync-unchanged',{
  match:['no durable change since the last export',/\bunchanged\b/],
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},labelKey:'guidance.action.syncStatus'}],
  source:A.GUIDE_SYNC}),

 failure('sync-export-failed',{
  // 0.7.0 (#109): '공유 폴더'는 `ui/lib/core.cjs`가 던지던 한국어 원문에 의존했다. 서버 메시지가
  // en 한 줄로 바뀌므로 **오류 코드 3개**로 승격한다(설계 §6.1). SYNC_DIR_REQUIRED는 L1이 지금
  // code 없이 던지는 "shared sync folder path is required"에 부여한다.
  match:['shared sync folder is not writable','sync export failed','sync-export: fail','sync_dir_required','invalid_sync_dir','sync_dir_unwritable'],
  ignorable:false,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},labelKey:'guidance.action.syncSettings'}],
  source:A.GUIDE_SYNC}),

 // 0.6.3 (#48): 수동 세대 파일(zip/디렉터리) 가져오기·내보내기의 거부. 코어의 모든 사유가
 // "sync archive …"로 시작하므로 한 클래스로 모인다. 0.7.0: UI 계층의 INVALID_ARCHIVE(_PATH)
 // 코드도 같은 클래스다.
 failure('sync-archive-invalid',{
  match:['sync archive','invalid_archive'],
  ignorable:false,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},labelKey:'guidance.action.syncSettings'},{kind:'command',text:'memex sync import --archive <path> --dry-run'}],
  source:A.GUIDE_SYNC}),

 failure('operation-incomplete',{
  // 0.7.0 (#109): '남은 작업'은 생산자가 없었다(docs의 산문뿐) — 삭제했다.
  match:[/\bexit 2\b/],
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'operations'},labelKey:'guidance.action.viewOperations'}],
  source:A.GUIDE_CONTINUITY}),
];

const BY_ID=new Map(CLASSES.map(c=>[c.id,c]));
export const guidanceFor=id=>BY_ID.get(id)||null;

/** 매핑되지 않은 오류. 원인을 추측하지 않고 원문과 진단 안내만 남긴다. */
export function unknownClass(raw){
 return failure('unknown',{raw:raw||null,ignorable:null,
  actions:[{kind:'diagnostics',labelKey:'guidance.action.exportDiagnostics'},{kind:'operation',command:'doctor',labelKey:'guidance.action.runDoctor'}],
  source:GUIDE});
}

/**
 * 분류 대상 문자열. 레코드의 여러 필드를 한 건초더미로 합친다.
 *
 * 0.7.0 (#109): **`code`와 `error_code`를 포함한다.** 서버 오류 메시지가 en 한 줄 + 안정적
 * 코드로 바뀌었으므로(설계 §5) 분류는 코드를 봐야 한다. `code`를 보지 않으면
 * `DB_INDEX_MISSING`·`SYNC_DIR_UNWRITABLE` 같은 승격된 코드가 분류기에 도달하지 않는다.
 */
const haystack=input=>{
 if(!input)return '';
 if(typeof input==='string')return input.toLowerCase();
 return [input.code,input.error_code,input.error,input.errorClass,input.error_class,input.error_message,input.last_error,input.reason,input.state,input.status,input.kind]
  .filter(x=>typeof x==='string').join('   ').toLowerCase();
};

/** 문자열 또는 레코드를 실패 클래스로 옮긴다. 모르면 unknown을 돌려준다. */
export function classify(input){
 const text=haystack(input);
 if(!text.trim())return null;
 for(const cls of CLASSES){
  for(const rule of cls.match){
   if(rule instanceof RegExp?rule.test(text):text.includes(String(rule).toLowerCase()))return cls;
  }
 }
 return unknownClass(typeof input==='string'?input:input?.error||input?.last_error||input?.error_message||null);
}

/**
 * 파이프라인 상태에서 주목이 필요한 클래스를 수량과 함께 뽑는다. 0은 만들지 않는다.
 *
 * `detail`은 **이미 번역된 한 줄**이다. 0.6.x는 `${number(count)} · ${라벨}`로 타이포그래피를
 * 이어붙여 어순을 표현할 수 없었다 — 수량 슬롯을 사전 안으로 옮겼다(설계 §6.0).
 */
export function attentionFromPipeline(p){
 if(!p)return [];
 const terminal=p.attention?.terminal||{};
 const detail=(id,count)=>t(`guidance.attention.${id}.detail`,{count:number(count)});
 const rows=[
  ['job-dead',(p.attention?.memoryJobsDead||0)+(terminal.checkpointsDeadLetter||0)+(terminal.extractionTargetsDead||0)],
  ['job-retry',p.attention?.memoryJobsRetry||0],
  ['failed-visible',(terminal.checkpointsFailedVisible||0)+(terminal.extractionTargetItemsFailedVisible||0)+(terminal.capsuleCheckpointFailedVisible||0)],
  ['extraction-failed-range',terminal.extractionFailedRanges||0],
  ['capture-gap',terminal.captureGapsOpen||0],
  ['budget-exhausted',terminal.modelWorkBudgetsExhausted||0],
  ['ontology-parked',p.ontology?.parkedFacts||0],
  ['evidence-missing',p.evidence?.factsWithoutLocalEvidence||0],
  ['quarantined-project',(p.quarantinedProjects||[]).length],
 ];
 const out=rows.filter(([,count])=>count>0).map(([id,count])=>({cls:guidanceFor(id),count,detail:detail(id,count)}));
 // 인덱스 수리는 수량이 아니라 코어가 남긴 차단 사유가 정보다. 사유가 없으면 지어내지 않는다.
 if(p.ontology?.indexRepair?.blocked)out.unshift({cls:guidanceFor('ontology-index-repair'),count:1,
  detail:t('guidance.attention.ontology-index-repair.detail',{reason:p.ontology.indexRepair.reason||t('common.unknown')})});
 if(p.derivedLaneSkips?.consecutive)out.push({cls:guidanceFor('derived-lane-skip'),count:p.derivedLaneSkips.consecutive,
  detail:detail('derived-lane-skip',p.derivedLaneSkips.consecutive)});
 return out.filter(x=>x.cls);
}

/**
 * 진행 중이거나 정상 완료한 작업에는 안내를 붙이지 않는다. 임대 시각이 지난 running은 그 자체가
 * 신호다.
 *
 * 0.6.3 (#79): **작업의 상태가 오류 문자열보다 먼저다.** 이전에는 문자열 매칭이 먼저라서, 저장된
 * 오류가 무시 가능한 클래스에 걸리면 terminal 상태(`dead`)인 작업에 "무시해도 됩니다"가 붙고 그
 * 상태에 필요한 복구 액션이 사라졌다. `dead`는 재시도 상한을 소진해 끝난 작업이고 `retry`는 다음
 * 재시도를 기다리는 작업이다 — 어느 쪽이든 다음 행동은 그 상태가 정한다. 저장된 오류 원문은 표의
 * 같은 행과 작업 상세에 그대로 남으므로 아무것도 숨기지 않는다.
 */
export function jobGuidance(j){
 if(!j)return null;
 if(j.state==='running'&&j.lease_until&&Date.parse(j.lease_until)<Date.now())return guidanceFor('lease-expired');
 if(!j.last_error&&['completed','processed','superseded','pending','running'].includes(j.state))return null;
 if(j.state==='dead')return guidanceFor('job-dead');
 if(j.state==='retry')return guidanceFor('job-retry');
 return classify({error:j.last_error,state:j.state});
}
export function attemptGuidance(a){
 if(!a)return null;
 if(!a.error_message&&!a.error_class&&a.state!=='failed')return null;
 return classify({error:a.error_message,errorClass:a.error_class,state:a.state});
}
/** 관리 실행: 종료 코드 2는 "남은 작업이 있다"는 뜻이지 실패가 아니다. */
export function operationGuidance(o){
 if(!o)return null;
 if(o.exit_code===2||o.status==='timed-out')return guidanceFor('operation-incomplete');
 if(['completed','running','cancelling','cancelled'].includes(o.status))return null;
 return classify({state:o.status});
}

export const ignorableTag=cls=>cls.ignorable===null
 ?`<span class="tag outline">${esc(t('guidance.ignorable.unknown'))}</span>`
 :`<span class="tag ${cls.ignorable?'':'amber'}">${esc(t('guidance.ignorable.'+String(cls.ignorable)))}</span>`;

/** 액션 하나를 기존 버튼·링크 컴포넌트로 그린다. 새 컴포넌트를 만들지 않는다. */
export function actionButton(action,ctx){
 // `text`(복사되는 CLI 명령)는 버튼 텍스트 자체이고 번역 대상이 아니다. 나머지는 사전이 갖는다.
 const label=action.labelKey?t(action.labelKey):'';
 if(action.kind==='operation')return btn(label,'play',`data-command="${esc(action.command)}" ${ctx?.bootstrap?.environment?.commands?'':'disabled'}`,'small');
 if(action.kind==='command')return btn(action.text,'copy',`data-copy-command="${esc(action.text)}"`,'small ghost');
 if(action.kind==='diagnostics')return btn(label,'download','data-action="diagnostics-download"','small ghost');
 if(action.kind==='view'&&ctx?.href)return linkBtn(label,'arrow',ctx.href(action.to,action.query||{}),'small ghost');
 return '';
}
export const actionRow=(cls,ctx)=>`<div class="row wrap">${(cls.actions||[]).map(a=>actionButton(a,ctx)).join('')}</div>`;

/** 목록 행 옆에 붙이는 한 줄 "다음 행동". */
export function guidanceCell(cls,ctx){
 if(!cls)return '<span class="muted">—</span>';
 return `<div class="stack-sm"><div class="row wrap">${ignorableTag(cls)}<span class="caption">${esc(cls.title)}</span></div><p class="caption">${esc(cls.next)}</p>${actionRow(cls,ctx)}</div>`;
}

/** 상세·개요에서 쓰는 전체 안내 패널. */
export function guidancePanel(cls,ctx,extra=''){
 if(!cls)return '';
 return `<section class="card pad"><div class="row wrap mb">${icon('warning')}<strong>${esc(cls.title)}</strong>${ignorableTag(cls)}</div>
 ${cls.raw?`<pre class="terminal">${esc(cls.raw)}</pre>`:''}
 ${kv([[t('guidance.kv.cause'),esc(cls.cause)],[t('guidance.kv.impact'),esc(cls.impact)],[t('guidance.kv.next'),esc(cls.next)]])}
 ${extra}
 <div class="mt">${actionRow(cls,ctx)}</div>
 <p class="caption mt">${esc(t('guidance.source.label'))}: <code>${esc(cls.source)}</code></p></section>`;
}

/** 개요의 "확인이 필요한 작업" 카드. 클래스별로 묶고 0은 만들지 않는다. */
export function attentionCard(groups,ctx){
 if(!groups.length)return '';
 return `<section class="card"><div class="card-head"><div><h2>${esc(t('guidance.attention.heading'))}</h2><p>${esc(t('guidance.attention.subtitle'))}</p></div>${linkBtn(t('guidance.attention.link'),'activity',ctx.href('/activity',{tab:'jobs'}),'small ghost')}</div>
 <div class="card-body stack">${groups.map(({cls,count,detail})=>`<div class="source-item"><div class="spread"><div class="row wrap">${ignorableTag(cls)}<strong>${esc(cls.title)}</strong><span class="tag outline">${esc(detail||number(count))}</span></div></div><p class="caption mt">${esc(cls.impact)}</p><p class="caption">${esc(cls.next)}</p><div class="mt">${actionRow(cls,ctx)}</div></div>`).join('')}</div></section>`;
}
