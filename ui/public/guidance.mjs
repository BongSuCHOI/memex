// 실패 클래스 카탈로그 (#23).
//
// 단일 출처는 docs/GUIDE.md §20 "문제가 생겼을 때 — 실패 클래스별 복구"이고 이 파일은 거기서
// 파생한 UI 표현이다. 코어가 남긴 last_error / error_class / skip 사유 / 상태 줄을 클래스로
// 옮기고, 각 클래스마다 원인 · 영향 · 다음 행동 · 액션 · 무시 가능 여부를 정의한다.
//
// 규칙 하나: **매핑되지 않은 오류의 원인을 지어내지 않는다.** 모르는 문자열은 원문 그대로
// 보여주고 진단 내보내기로 안내한다(unknown 클래스).
import {esc,icon,btn,linkBtn,kv,number} from './ui.mjs';

const GUIDE='docs/GUIDE.md#20-문제가-생겼을-때--실패-클래스별-복구';
const RECOVER=[{kind:'operation',command:'recover',label:'실패 종료 작업 복구'},{kind:'command',text:'memex recover --all-dead --dry-run'}];

/**
 * 클래스 목록. `match`의 문자열은 소문자 비교로 부분 일치, 정규식은 그대로 시험한다.
 * 위에 있는 클래스가 먼저 이긴다.
 *
 * 규칙 (0.6.3 #80): **짧은 열거값은 반드시 단어 경계 정규식으로 쓴다.** 부분 일치로 두면
 * `cas`가 `broadcast`·`case`·`casing`에, `exit 2`가 `exit 25`에 걸려서, 원인을 모르는 오류를
 * "무시해도 되는 원인"으로 단정한다 — 이 카탈로그가 금지하는 바로 그 날조다. 여러 단어로 된
 * 문장이나 코어의 긴 오류 원문만 부분 일치로 둔다.
 */
export const CLASSES=[
 {id:'db-unavailable',title:'로컬 데이터베이스에 연결할 수 없음',
  match:['db_unavailable','인덱스 db가 없습니다','database is locked','unable to open database','sqlite_cantopen'],
  cause:'인덱스 DB 파일이 없거나 열 수 없습니다. 아직 한 번도 동기화하지 않았거나 경로·권한이 바뀐 상태입니다.',
  impact:'조회·주입·기억 변경이 모두 멈춥니다. 저장된 기억이 사라진 것은 아닙니다.',
  next:'관리 › 런타임에서 DB 경로를 확인하고, 진단을 실행한 뒤 대화 동기화로 인덱스를 만드세요.',
  ignorable:false,actions:[{kind:'operation',command:'doctor',label:'코어 진단 실행'},{kind:'operation',command:'sync',label:'대화 동기화'},{kind:'view',to:'/settings',query:{tab:'runtime'},label:'런타임 정보'}],
  source:'docs/GUIDE.md#13-진단'},

 {id:'deps-missing',title:'런타임 의존성이 설치되지 않음',
  match:['runtime deps missing','better-sqlite3','@xenova/transformers','sqlite-vec','memex deps materialize'],
  cause:'설치된 플러그인 루트에 네이티브 의존성이 없어 모든 훅이 고정되지 않은 npx 폴백으로 실행됩니다.',
  impact:'훅이 느려지고 버전이 고정되지 않습니다. 기억 데이터 자체는 손상되지 않습니다.',
  next:'설치본 루트에서 의존성을 실체화한 뒤 진단으로 dependencies가 ok인지 확인하세요.',
  ignorable:false,actions:[{kind:'command',text:'memex deps materialize'},{kind:'operation',command:'doctor',label:'코어 진단 실행'}],
  source:GUIDE},

 // 0.6.3 (#79): 과거 실패 문자열은 "정상 잘림"과 다른 클래스다. 0.6.1 이전 코어는 같은 상한에서
 // 작업을 terminal 상태로 죽였고, 업그레이드만으로는 재개되지 않으므로 복구가 필요하다.
 // capsule-truncated보다 먼저 와야 그 문자열이 무시 가능으로 떨어지지 않는다.
 {id:'capsule-bound-exceeded',title:'0.6.0 이전 상한으로 죽은 Capsule 작업',
  match:['capsule patch exceeds bounded storage size'],
  cause:'0.6.1 이전 코어는 Capsule 패치가 저장 한도(MEMEX_CAPSULE_MAX_CHARS)를 넘으면 작업을 실패시켰습니다. 이 오류를 남긴 작업은 그때 terminal 상태로 끝난 작업입니다 — 0.6.1부터는 실패시키지 않고 잘라서 저장합니다.',
  impact:'그 작업 흐름의 연속성 요약이 갱신되지 않은 채 남아 있습니다. 기억(fact)은 잃지 않았습니다.',
  next:'업그레이드만으로는 재개되지 않습니다(worker는 pending·retry만 가져갑니다). memex recover로 다시 대기 상태로 되돌리세요 — 복구는 아무것도 삭제하지 않습니다.',
  ignorable:false,actions:[...RECOVER,{kind:'view',to:'/activity',query:{tab:'jobs',state:'dead'},label:'실패 작업 보기'}],
  source:'docs/GUIDE.md#작업이-실패했을-때-terminal-상태-복구'},

 {id:'capsule-truncated',title:'작업 맥락 Capsule이 잘림',
  match:['capsule patch truncated','capsule evidence fragment exceeds page budget','memex_capsule_max_chars'],
  cause:'Capsule 패치가 저장 한도(MEMEX_CAPSULE_MAX_CHARS, 기본 12,000자)를 넘어 우선순위가 낮은 항목부터 잘렸습니다. 0.6.1부터 코어는 작업을 실패시키지 않고 잘라서 저장합니다.',
  impact:'기억(fact)에는 영향이 없습니다 — Capsule은 해석용 맥락이며 직접 근거가 아닙니다. 연속성 요약의 일부 항목만 보존되지 않습니다.',
  next:'무시해도 됩니다. 잘린 항목이 계속 필요하면 MEMEX_CAPSULE_MAX_CHARS를 올린 뒤 해당 작업 흐름을 다시 처리하세요.',
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'runtime'},label:'환경 변수 확인'}],
  source:GUIDE},

 {id:'budget-exhausted',title:'모델 작업 예산 소진',
  match:['budget_exhausted','model_budget_exhausted','model work deadline exceeded','deadline_exceeded','modelworkbudgetsexhausted',/budget.*(deadline|window|attempts)/i],
  cause:'이번 실행(run)의 예산을 다 썼습니다 — 기한(deadline), 호출 창(window), 시도 수(attempts) 중 하나입니다.',
  impact:'남은 대상은 처리되지 않고 대기 상태로 남습니다. 이미 저장된 기억은 그대로입니다.',
  next:'예산 상태를 확인한 뒤 새 실행으로 이어서 진행하세요. 예산 ID는 작업 상세의 "예산 ID"에 있습니다.',
  ignorable:false,actions:[{kind:'command',text:'memex model-work status'},{kind:'command',text:'memex model-work resume <id> --new-run'},{kind:'view',to:'/activity',query:{tab:'attempts'},label:'모델 시도 보기'}],
  source:'docs/GUIDE.md#17-모델-작업-예산과-대기-진단'},

 {id:'claim-handoff',title:'다른 실행기가 먼저 가져감',
  match:['lease_held','claim lost to a concurrent writer','claim lost',/\bcas\b/],
  cause:'같은 작업을 다른 worker가 이미 임대(lease)했거나, 동시 쓰기 경합에서 이번 실행이 졌습니다.',
  impact:'없습니다. 작업은 이긴 실행기가 처리합니다.',
  next:'무시해도 됩니다. 같은 작업이 계속 넘겨지기만 한다면 임대가 만료된 실행기가 남아 있는지 확인하세요.',
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'jobs',state:'running'},label:'실행 중 작업 보기'}],
  source:GUIDE},

 {id:'claim-backoff',title:'재시도 대기 중(backoff)',
  match:[/\bbackoff\b/,'retry backoff','memoryjobsbackoff'],
  cause:'실패 후의 재시도 시각이 아직 되지 않았습니다. 고장이 아닙니다.',
  impact:'해당 작업만 잠시 미뤄집니다.',
  next:'기다리거나 worker를 실행하세요. 즉시 되돌리려면 해당 작업만 재시도하세요.',
  ignorable:true,actions:[{kind:'command',text:'memex jobs list --state retry'},{kind:'command',text:'memex jobs retry <job-id>'}],
  source:GUIDE},

 {id:'claim-attempts',title:'시도 상한 도달',
  match:['attempts_exhausted','attempt cap reached'],
  cause:'이 작업이 허용된 시도 수를 모두 썼습니다.',
  impact:'해당 범위는 자동으로 다시 처리되지 않습니다.',
  next:'저장된 오류를 확인해 원인을 고친 뒤 복구하거나, 되살릴 가치가 없으면 사유를 남기고 정리하세요.',
  ignorable:false,actions:[...RECOVER,{kind:'command',text:'memex jobs dismiss <job-id> --reason "왜 포기하는가"'}],
  source:GUIDE},

 {id:'claim-error',title:'작업 확보 중 오류',
  match:['claim_not_acquired','claim_error'],
  cause:'작업을 확보하는 단계에서 오류가 났습니다. 처리 자체는 시작되지 않았습니다.',
  impact:'이번 회차만 건너뜁니다.',
  next:'같은 작업에서 반복되면 시스템 로그의 원문을 확인하세요.',
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'logs',level:'error'},label:'오류 로그 보기'}],
  source:GUIDE},

 {id:'excluded-project',title:'정책상 제외된 프로젝트',
  match:['excluded_project','excluded_project_unmarked'],
  cause:'설정에서 제외한 프로젝트라 수집·추출 대상이 아닙니다. 실패가 아니라 정상 동작입니다.',
  impact:'이 프로젝트의 대화는 기억이 되지 않습니다.',
  next:'의도한 것이면 무시하세요. 아니라면 제외 설정을 확인하세요.',
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'runtime'},label:'환경 확인'}],
  source:'docs/GUIDE.md#11-do-not-index와-재분류-비용'},

 {id:'failed-visible',title:'결정론적으로 실패해 표시된 구간',
  match:['failed_visible','failed-visible','extractiontargetitemsfailedvisible','checkpointsfailedvisible','capsulecheckpointfailedvisible'],
  cause:'재시도해도 같은 결과가 나오는 실패라서, 숨기지 않고 그대로 표시한 상태입니다.',
  impact:'해당 구간의 기억만 만들어지지 않습니다. 다른 구간은 정상 처리됩니다.',
  next:'작업 상세에서 저장된 오류 원문과 실패 구간을 확인한 뒤 복구하세요.',
  ignorable:false,actions:[...RECOVER,{kind:'view',to:'/activity',query:{tab:'jobs'},label:'처리 작업 보기'}],
  source:'docs/GUIDE.md#작업이-실패했을-때-terminal-상태-복구'},

 {id:'job-dead',title:'실패로 종료된 작업',
  match:[/\bdead-letter\b/,/\bdead\b/,'checkpointsdeadletter','extractiontargetsdead','memoryjobsdead'],
  cause:'재시도 상한을 소진해 terminal 상태가 된 작업입니다.',
  impact:'그 작업이 담당하던 대화 구간은 기억으로 추출되지 않습니다.',
  next:'작업 상세에서 원인을 확인한 뒤 복구하거나, 되살릴 가치가 없으면 사유를 남기고 정리하세요. 복구는 아무것도 삭제하지 않습니다.',
  ignorable:false,actions:[...RECOVER,{kind:'command',text:'memex jobs dismiss <job-id> --reason "왜 포기하는가"'},{kind:'view',to:'/activity',query:{tab:'jobs',state:'dead'},label:'실패 작업 보기'}],
  source:GUIDE},

 {id:'job-retry',title:'재시도를 기다리는 작업',
  match:[/\bretry\b/,'memoryjobsretry'],
  cause:'실패한 뒤 다음 재시도 시각을 기다리는 중입니다.',
  impact:'처리가 늦어질 뿐, 손실은 아닙니다.',
  next:'worker가 돌면 자동으로 처리됩니다. 대기가 길어지면 저장된 오류를 확인하세요.',
  ignorable:true,actions:[{kind:'command',text:'memex jobs list --state retry'},{kind:'view',to:'/activity',query:{tab:'jobs',state:'retry'},label:'재시도 대기 보기'}],
  source:GUIDE},

 {id:'extraction-failed-range',title:'추출 실패 구간이 기록됨',
  match:['extractionfailedranges','extraction_failed_ranges'],
  cause:'어떤 입력 구간이 실패했는지까지 기록된 terminal 범위입니다.',
  impact:'그 구간의 기억만 비어 있습니다.',
  next:'같은 단위로 복구하세요. 오류 원문은 보존됩니다.',
  ignorable:false,actions:RECOVER,source:GUIDE},

 {id:'capture-gap',title:'capture 공백이 열려 있음',
  match:['capturegapsopen','capture gap'],
  cause:'capture가 fail-open으로 넘어간 구간입니다. 코어가 의도적으로 허용한 상태입니다.',
  impact:'그 구간의 대화가 인덱스에 없습니다.',
  next:'복구 명령의 대상이 아닙니다. 같은 세션의 다음 성공 capture가 닫습니다. 실패를 즉시 드러내려면 MEMEX_STRICT_CAPTURE=1로 실행하세요.',
  ignorable:true,actions:[{kind:'command',text:'memex status'}],source:GUIDE},

 {id:'lease-expired',title:'임대가 만료된 실행 중 작업',
  match:['lease expired','lease_expired','임대 만료'],
  cause:'실행 중으로 표시돼 있지만 임대 시각이 이미 지났습니다. 실행기가 중간에 사라진 상태입니다.',
  impact:'다른 worker가 다시 가져갈 때까지 진행되지 않습니다.',
  next:'worker를 실행하면 임대가 회수됩니다. 계속 남아 있으면 복구하세요.',
  ignorable:false,actions:[...RECOVER,{kind:'view',to:'/activity',query:{tab:'jobs',state:'running'},label:'실행 중 작업 보기'}],
  source:GUIDE},

 // 0.6.3 (#80): 호출 자체가 실패한 것과 응답 형식이 틀린 것은 원인이 반대다. 이 클래스가
 // model-invalid-json보다 먼저 와야 TransientLlmError가 "응답 형식 문제"로 뒤바뀌지 않는다.
 {id:'model-call-failed',title:'모델 호출 자체가 실패',
  match:['llm call failed','transientllmerror','fetch failed',/\bspawn\b/,/\beconnrefused\b/,/\betimedout\b/],
  cause:'모델을 호출하는 단계에서 실패했습니다 — 네트워크, 실행기(codex) 기동, 인증 같은 호출 경로의 문제이며 응답 내용의 문제가 아닙니다.',
  impact:'그 호출의 산출물이 없습니다. 코어는 이 실패를 일시적 오류로 보고 시도를 소모하지 않으므로 예산은 그대로입니다.',
  next:'대개 재시도로 해결됩니다. 반복되면 모델 시도 탭의 오류 원문으로 실행기·인증 상태를 먼저 확인하세요 — 프롬프트나 입력 길이를 고칠 문제가 아닙니다.',
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'attempts',state:'failed'},label:'모델 시도 보기'},{kind:'operation',command:'doctor',label:'코어 진단 실행'}],
  source:GUIDE},

 {id:'model-invalid-json',title:'모델이 형식에 맞지 않는 응답을 반환',
  match:['unparseable llm response','invalid json','model returned invalid json','unusable domain/category name','empty llm response'],
  cause:'모델 응답이 요구한 JSON 스키마를 만족하지 않아 코어가 저장을 거부했습니다.',
  impact:'그 시도의 산출물만 버려집니다. 잘못된 내용이 기억으로 저장되지는 않습니다.',
  next:'대개 재시도로 해결됩니다. 반복되면 모델 시도 탭에서 오류 원문과 입력 길이를 확인하세요.',
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'attempts',state:'failed'},label:'모델 시도 보기'}],
  source:GUIDE},

 {id:'embedding-unavailable',title:'임베딩 런타임을 준비하지 못함',
  match:['embedding model unavailable','candidate embedding unavailable','embedding not available','embedder','vec_facts',/\bvec0\b/,'임베딩'],
  cause:'로컬 임베딩 모델을 적재하지 못했습니다. 모델 파일이 없거나 런타임 의존성이 준비되지 않은 상태입니다.',
  impact:'의미 검색과 분류가 멈추고, 의미 수정 저장도 실패합니다. 저장된 기억은 그대로입니다.',
  next:'의존성을 실체화하고 진단을 실행한 뒤, 누락된 임베딩을 백필하세요.',
  ignorable:false,actions:[{kind:'operation',command:'doctor',label:'코어 진단 실행'},{kind:'operation',command:'embeddings',label:'임베딩 백필'},{kind:'command',text:'memex deps materialize'}],
  source:'docs/GUIDE.md#13-진단'},

 {id:'ontology-parked',title:'분류가 보류(parked)된 기억',
  match:[/\bparked\b/,'ontology_state','ontology park'],
  cause:'분류를 정해진 횟수만큼 시도했지만 실패해 General/Misc에 보류된 기억입니다. 분류 완료로 세지 않습니다.',
  impact:'분류·지도에서 제 자리를 찾지 못합니다. 기억 자체와 주입에는 영향이 없습니다.',
  next:'정책·임베딩 토큰이 바뀐 보류 건은 한 번의 재시도를 받을 수 있습니다. 온톨로지 백필을 실행하세요.',
  ignorable:true,actions:[{kind:'operation',command:'ontology',label:'온톨로지 분류 백필'},{kind:'view',to:'/taxonomy',label:'분류 보기'}],
  source:'docs/GUIDE.md#ontology-taxonomy-수리-061-47'},

 {id:'ontology-index-repair',title:'온톨로지 카테고리 인덱스 수리 필요',
  match:['index repair','indexrepairerror','category index repair failed','category index unavailable','category index incomplete'],
  cause:'카테고리 벡터 인덱스가 자가 치유로 복구되지 않는 상태입니다. 기억의 문제가 아니라 인덱스의 문제입니다.',
  impact:'분류가 차단됩니다. 새 기억은 계속 저장되지만 분류 대기로 쌓입니다.',
  next:'임베딩을 백필해 벡터를 다시 만드세요. 그래도 남으면 진단 결과와 함께 확인하세요.',
  ignorable:false,actions:[{kind:'operation',command:'embeddings',label:'임베딩 백필'},{kind:'operation',command:'doctor',label:'코어 진단 실행'}],
  source:'docs/GUIDE.md#ontology-taxonomy-수리-061-47'},

 {id:'derived-lane-skip',title:'파생 레인이 밀림',
  match:['continuity_backlog','derived lane','derived_lane'],
  cause:'우선순위가 높은 capture·capsule 작업이 밀려 있어 통합·재임베딩·분류·추출 백필이 순번을 양보했습니다.',
  impact:'"대기가 줄지 않는다"처럼 보이지만 원인은 다른 레인에 있습니다. 데이터 손실은 아닙니다.',
  next:'밀린 백로그를 먼저 비우세요. 연속으로 밀리면 코어가 강제로 한 번 통과시킵니다.',
  ignorable:true,actions:[{kind:'command',text:'memex jobs list --state retry'},{kind:'view',to:'/activity',query:{tab:'jobs'},label:'처리 작업 보기'}],
  source:'docs/GUIDE.md#15-continuity-운영'},

 {id:'evidence-missing',title:'로컬 검증 영수증이 없는 기억',
  match:['local meaning evidence not recorded','factswithoutlocalevidence','backfill receipts','source evidence changed or is unresolvable'],
  cause:'현재 의미 버전에 대한 로컬 검증 영수증이 없습니다. 원문이 아직 있으면 다시 만들 수 있습니다.',
  impact:'자동 통합에서 제외되고 동기화 충돌에서 밀립니다 — "중복 기억이 계속 쌓인다"의 실제 원인입니다.',
  next:'영수증 백필로 다시 만드세요. 원문이 사라진 기억은 복구되지 않습니다.',
  ignorable:false,actions:[{kind:'command',text:'memex backfill receipts'},{kind:'view',to:'/facts',label:'기억 목록 보기'}],
  source:'docs/GUIDE.md#7-fact-관리'},

 {id:'evidence-unresolved',title:'근거 원문을 다시 찾지 못함',
  match:['evidence_unresolved','invalid evidence references','근거로 지목된 원문'],
  cause:'기억이 가리키는 원문 exchange를 현재 인덱스에서 찾지 못했습니다.',
  impact:'그 작업은 기억을 저장하지 않고 종료합니다. 잘못된 근거로 저장하지는 않습니다.',
  next:'대화 동기화로 인덱스를 채운 뒤 복구하세요.',
  ignorable:false,actions:[{kind:'operation',command:'sync',label:'대화 동기화'},...RECOVER],
  source:GUIDE},

 {id:'stale-fact',title:'변경 중에 기억이 바뀜',
  match:['stale_fact','stalefactmutationerror','changed during','changed before semantic mutation','discarded: fact'],
  cause:'저장을 시도하는 사이에 같은 기억이 다른 경로에서 바뀌어, 코어가 덮어쓰기를 거부했습니다.',
  impact:'없습니다 — 이전 값이 그대로 유지됩니다. 안전장치가 동작한 것입니다.',
  next:'화면을 새로고침해 현재 값을 확인한 뒤 다시 시도하세요.',
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'chronicle'},label:'변경 이력 보기'}],
  source:'docs/GUIDE.md#7-fact-관리'},

 {id:'tier-step',title:'계층은 한 칸씩만 움직임',
  match:['tier_step','tierstepError','tier ladder moves one step at a time','not adjacent'],
  cause:'브랜치 ⇄ 프로젝트 공용 ⇄ 글로벌 사다리에서 두 칸을 한 번에 옮기려 했거나 이미 끝에 있습니다.',
  impact:'없습니다. 아무것도 바뀌지 않았습니다.',
  next:'한 칸씩 옮기세요. 글로벌로 보내려면 먼저 프로젝트 공용으로 승격합니다.',
  ignorable:true,actions:[{kind:'view',to:'/facts',label:'기억 목록 보기'}],
  source:'docs/GUIDE.md#7-fact-관리'},

 {id:'receipt-failed',title:'컨텍스트는 나갔는데 영수증이 남지 않음',
  match:['receipt-failed','failed to persist prepared recall receipt','recall-provenance'],
  cause:'기억을 컨텍스트로 내보냈지만 durable recall 영수증이 준비 상태에 머물렀습니다.',
  impact:'"어떤 기억이 언제 어느 세션에 들어갔는가"의 사후 감사가 불가능해집니다.',
  next:'진단을 실행하고 DB 쓰기 가능 여부·디스크·권한을 점검하세요.',
  ignorable:false,actions:[{kind:'operation',command:'doctor',label:'코어 진단 실행'},{kind:'view',to:'/activity',query:{tab:'recalls'},label:'컨텍스트 제공 보기'}],
  source:'docs/GUIDE.md#13-진단'},

 {id:'no-match',title:'관련 기억을 찾지 못함',
  match:['no-match','no_match','관련 기억 없음'],
  cause:'후보가 없었거나 관련성 게이트에서 전부 탈락했습니다. 오류가 아닙니다.',
  impact:'그 요청에는 기억이 제공되지 않았습니다.',
  next:'이 프로젝트에 저장된 기억 수를 확인하세요. 브랜치 계층에 가려진 기억이 있으면 포함해서 볼 수 있습니다.',
  ignorable:true,actions:[{kind:'view',to:'/facts',query:{tiers:'all'},label:'계층 포함해 기억 보기'}],
  source:'docs/GUIDE.md#9-web-ui'},

 {id:'quarantined-project',title:'격리된 프로젝트',
  match:['quarantined','untrusted cwd','untrustedprojectpatherror'],
  cause:'`/`처럼 프로젝트를 지목할 수 없는 cwd에서 만들어진 프로젝트입니다. 기억은 보존하고 주입·조회에서만 제외합니다.',
  impact:'그 프로젝트의 기억은 주입되지 않습니다. 삭제되지는 않았습니다.',
  next:'자동 복구 명령이 없습니다. 정상 cwd에서 다시 작업하고, 이전 기억이 필요하면 계층 이동으로 옮기세요.',
  ignorable:false,actions:[{kind:'command',text:'memex facts list --scope all'},{kind:'view',to:'/facts',query:{scope:'all'},label:'전체 기억 보기'}],
  source:GUIDE},

 {id:'sync-disabled',title:'동기화가 꺼져 있음',
  match:['cross-device sync is off','sync disabled','skipped(off)',/^\s*disabled\s*$/],
  cause:'기본값입니다. 고장이 아닙니다.',
  impact:'다른 기기와 기억 상태를 주고받지 않습니다.',
  next:'쓰려면 관리 › 동기화에서 공유 폴더를 지정해 켜세요.',
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},label:'동기화 설정'}],
  source:'docs/GUIDE.md#10-저장-위치와-sync'},

 {id:'sync-never-exported',title:'동기화가 켜져 있는데 한 번도 내보내지 않음',
  match:['never exported','sync-export: warn'],
  cause:'스위치는 켜져 있는데 export 기록이 없습니다.',
  impact:'다른 기기에서 이 기기의 기억을 볼 수 없습니다.',
  next:'관리 › 동기화에서 지금 내보내기로 첫 세대를 만드세요.',
  ignorable:false,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},label:'동기화 설정'}],
  source:'docs/GUIDE.md#10-저장-위치와-sync'},

 {id:'sync-locked',title:'다른 내보내기가 진행 중',
  match:['another export is in progress','export locked',/^\s*locked\s*$/],
  cause:'같은 데이터 루트에서 export가 이미 실행 중입니다.',
  impact:'없습니다. 이번 요청만 건너뜁니다.',
  next:'무시해도 됩니다. 잠시 뒤 다시 시도하세요.',
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},label:'동기화 상태'}],
  source:'docs/GUIDE.md#10-저장-위치와-sync'},

 {id:'sync-unchanged',title:'내보낼 변경이 없음',
  match:['no durable change since the last export',/\bunchanged\b/],
  cause:'마지막 export 이후 durable 기억이 바뀌지 않았습니다. 빈 세대를 만들지 않기 위한 정상 동작입니다.',
  impact:'없습니다. 다른 기기가 이미 마지막 세대를 받았다면 받을 것도 없습니다.',
  next:'무시해도 됩니다. 그래도 새 세대를 만들려면 CLI에서 --force로 내보내세요.',
  ignorable:true,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},label:'동기화 상태'}],
  source:'docs/GUIDE.md#10-저장-위치와-sync'},

 {id:'sync-export-failed',title:'동기화 내보내기 실패',
  match:['shared sync folder is not writable','sync export failed','sync-export: fail','공유 폴더'],
  cause:'대개 공유 폴더에 쓸 수 없는 상태입니다(경로 없음, 권한, 클라우드 동기화 중단).',
  impact:'이 기기의 변경이 다른 기기로 나가지 않습니다. 로컬 기억은 그대로입니다.',
  next:'관리 › 동기화에서 공유 폴더 경로와 쓰기 가능 여부를 확인한 뒤 다시 내보내세요.',
  ignorable:false,actions:[{kind:'view',to:'/settings',query:{tab:'sync'},label:'동기화 설정'}],
  source:'docs/GUIDE.md#10-저장-위치와-sync'},

 {id:'operation-incomplete',title:'관리 실행이 남은 작업을 두고 끝남',
  match:[/\bexit 2\b/,'남은 작업'],
  cause:'백필이 전경에서 끝났지만 처리할 작업이 남아 종료 코드 2로 끝났습니다. 실패가 아닙니다.',
  impact:'남은 대상은 다음 실행이나 worker가 처리합니다.',
  next:'같은 명령을 다시 실행하거나 worker를 돌리세요.',
  ignorable:true,actions:[{kind:'view',to:'/activity',query:{tab:'operations'},label:'관리 실행 내역'}],
  source:'docs/GUIDE.md#15-continuity-운영'},
];

const BY_ID=new Map(CLASSES.map(c=>[c.id,c]));
export const guidanceFor=id=>BY_ID.get(id)||null;

/** 매핑되지 않은 오류. 원인을 추측하지 않고 원문과 진단 안내만 남긴다. */
export function unknownClass(raw){
 return {id:'unknown',title:'알 수 없는 오류',raw:raw||null,
  cause:'이 오류 문자열에 대응하는 안내가 아직 없습니다. 원인을 추측하지 않습니다.',
  impact:'영향 범위를 단정할 수 없습니다. 아래 원문과 작업 상세를 함께 확인하세요.',
  next:'진단 JSON을 내보내 원문과 함께 보고하세요. 진단에는 대화·기억 원문과 절대 경로가 들어가지 않습니다.',
  ignorable:null,actions:[{kind:'diagnostics',label:'진단 내보내기'},{kind:'operation',command:'doctor',label:'코어 진단 실행'}],
  source:GUIDE};
}

const haystack=input=>{
 if(!input)return '';
 if(typeof input==='string')return input.toLowerCase();
 return [input.error,input.errorClass,input.error_class,input.error_message,input.last_error,input.reason,input.state,input.status,input.kind]
  .filter(x=>typeof x==='string').join('   ').toLowerCase();
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

/** 파이프라인 상태에서 주목이 필요한 클래스를 수량과 함께 뽑는다. 0은 만들지 않는다. */
export function attentionFromPipeline(p){
 if(!p)return [];
 const t=p.attention?.terminal||{};
 const rows=[
  ['job-dead',(p.attention?.memoryJobsDead||0)+(t.checkpointsDeadLetter||0)+(t.extractionTargetsDead||0),'실패로 종료된 작업'],
  ['job-retry',p.attention?.memoryJobsRetry||0,'재시도를 기다리는 작업'],
  ['failed-visible',(t.checkpointsFailedVisible||0)+(t.extractionTargetItemsFailedVisible||0)+(t.capsuleCheckpointFailedVisible||0),'결정론적 실패로 표시된 구간'],
  ['extraction-failed-range',t.extractionFailedRanges||0,'기록된 추출 실패 구간'],
  ['capture-gap',t.captureGapsOpen||0,'열려 있는 capture 공백'],
  ['budget-exhausted',t.modelWorkBudgetsExhausted||0,'소진된 모델 작업 예산'],
  ['ontology-parked',p.ontology?.parkedFacts||0,'분류가 보류된 기억'],
  ['evidence-missing',p.evidence?.factsWithoutLocalEvidence||0,'검증 영수증이 없는 기억'],
  ['quarantined-project',(p.quarantinedProjects||[]).length,'격리된 프로젝트'],
 ];
 const out=rows.filter(([,count])=>count>0).map(([id,count,detail])=>({cls:guidanceFor(id),count,detail}));
 if(p.ontology?.indexRepair?.blocked)out.unshift({cls:guidanceFor('ontology-index-repair'),count:1,detail:p.ontology.indexRepair.reason||'차단됨'});
 if(p.derivedLaneSkips?.consecutive)out.push({cls:guidanceFor('derived-lane-skip'),count:p.derivedLaneSkips.consecutive,detail:'연속 양보 횟수'});
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

const IGNORABLE={true:'무시해도 됩니다',false:'조치가 필요합니다'};
export const ignorableTag=cls=>cls.ignorable===null?'<span class="tag outline">영향 미확인</span>':`<span class="tag ${cls.ignorable?'':'amber'}">${IGNORABLE[String(cls.ignorable)]}</span>`;

/** 액션 하나를 기존 버튼·링크 컴포넌트로 그린다. 새 컴포넌트를 만들지 않는다. */
export function actionButton(action,ctx){
 if(action.kind==='operation')return btn(action.label,'play',`data-command="${esc(action.command)}" ${ctx?.bootstrap?.environment?.commands?'':'disabled'}`,'small');
 if(action.kind==='command')return btn(action.text,'copy',`data-copy-command="${esc(action.text)}"`,'small ghost');
 if(action.kind==='diagnostics')return btn(action.label,'download','data-action="diagnostics-download"','small ghost');
 if(action.kind==='view'&&ctx?.href)return linkBtn(action.label,'arrow',ctx.href(action.to,action.query||{}),'small ghost');
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
 ${kv([['원인',esc(cls.cause)],['영향',esc(cls.impact)],['다음 행동',esc(cls.next)]])}
 ${extra}
 <div class="mt">${actionRow(cls,ctx)}</div>
 <p class="caption mt">단일 출처: <code>${esc(cls.source)}</code></p></section>`;
}

/** 개요의 "확인이 필요한 작업" 카드. 클래스별로 묶고 0은 만들지 않는다. */
export function attentionCard(groups,ctx){
 if(!groups.length)return '';
 return `<section class="card"><div class="card-head"><div><h2>확인이 필요한 상태</h2><p>실패 클래스별로 묶었습니다. 수집되지 않은 값은 0으로 세지 않습니다.</p></div>${linkBtn('활동 · 추적','activity',ctx.href('/activity',{tab:'jobs'}),'small ghost')}</div>
 <div class="card-body stack">${groups.map(({cls,count,detail})=>`<div class="source-item"><div class="spread"><div class="row wrap">${ignorableTag(cls)}<strong>${esc(cls.title)}</strong><span class="tag outline">${number(count)}${esc(detail?' · '+detail:'')}</span></div></div><p class="caption mt">${esc(cls.impact)}</p><p class="caption">${esc(cls.next)}</p><div class="mt">${actionRow(cls,ctx)}</div></div>`).join('')}</div></section>`;
}
