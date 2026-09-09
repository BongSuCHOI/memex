// 도움말·툴팁·용어집 카탈로그 (#28).
//
// 단일 출처는 docs/GUIDE.md와 docs/WEBUI-WORKSPACE.md의 정의이고, 항목마다 `source`로 그 문서의
// 앵커를 가리킨다. ui/test/help.test.cjs가 (a) 메뉴·배지·관리 명령·범위 옵션에 항목이 있는지
// (b) 참조한 앵커가 실제로 문서에 있는지 검사한다.
//
// 이 모듈은 아무것도 import하지 않는다 — ui.mjs가 배지 툴팁을 위해 이 파일을 읽기 때문이다.
// 설명은 코드 동작과 일치해야 하고 추측하지 않는다("제공됨 ≠ 활용됨").

const REPO='https://github.com/BongSuCHOI/memex';
/** 문서 링크는 로컬 파일 경로가 아니라 릴리스 태그에 고정한 GitHub URL이다. */
export function docUrl(source,version){
 const [file,anchor]=String(source||'').split('#');
 const ref=version&&/^\d+\.\d+\.\d+/.test(String(version))?'v'+String(version).split(' ')[0]:'main';
 return `${REPO}/blob/${ref}/${file}${anchor?'#'+anchor:''}`;
}

const GUIDE_UI='docs/GUIDE.md#9-web-ui';
const GUIDE_FACTS='docs/GUIDE.md#7-fact-관리';
const GUIDE_FAIL='docs/GUIDE.md#20-문제가-생겼을-때--실패-클래스별-복구';
const GUIDE_CONTINUITY='docs/GUIDE.md#15-continuity-운영';
const GUIDE_BUDGET='docs/GUIDE.md#17-모델-작업-예산과-대기-진단';
const GUIDE_SYNC='docs/GUIDE.md#10-저장-위치와-sync';
const GUIDE_DIAG='docs/GUIDE.md#13-진단';
const GUIDE_TIERS='docs/GUIDE.md#수집과-기억-계층';
const WEBUI='docs/WEBUI-WORKSPACE.md#화면';
const WEBUI_TIERS='docs/WEBUI-WORKSPACE.md#계층-배지와-숨겨진-계층-061-22';
const WEBUI_PROMOTE='docs/WEBUI-WORKSPACE.md#승격강등과-계층-이관-061-22';
const WEBUI_FAIL='docs/WEBUI-WORKSPACE.md#문제가-생겼을-때';
const WEBUI_MAP='docs/WEBUI-WORKSPACE.md#지식-지도';
const WEBUI_CONTRACT='docs/WEBUI-WORKSPACE.md#계약';
const LIFECYCLE='docs/FACT-LIFECYCLE.md#1-fact란-무엇인가';

/** 메뉴 7개. 페이지 헤더의 ⓘ가 이 문단을 보여준다. */
export const PAGES={
 '/':{title:'개요',body:'선택한 조회 범위의 요약입니다. 대화·기억 수, 파이프라인 준비 상태, 최근 기억 변화, 그리고 확인이 필요한 상태를 실패 클래스별로 묶어 보여줍니다. 이 화면을 여는 것만으로는 모델 작업이 시작되지 않습니다.',source:WEBUI},
 '/conversations':{title:'대화 원장',body:'수집된 대화를 세션 단위로 읽고, 각 턴이 어떤 기억의 직접 근거가 됐는지 따라갑니다. 원본 대화 파일은 읽기만 하며 수정하지 않습니다. 대화는 프로젝트에 종속되므로 공통 기억 범위에서는 항상 0건입니다.',source:WEBUI},
 '/facts':{title:'기억·사실',body:'Memex가 기억하는 문장과 그 근거입니다. 상세 패널에서 수정·비활성화·복원·영구 삭제와 계층 승격/강등을 할 수 있고, 모든 변경은 CLI와 같은 코어 서비스를 통과합니다.',source:GUIDE_FACTS},
 '/taxonomy':{title:'분류',body:'온톨로지 도메인과 주제 분류입니다. 분류는 로컬에서 파생되는 상태라서, 동기화 직후나 재분류 중에는 기억이 있어도 비어 보일 수 있습니다. 이것은 오류가 아닙니다.',source:WEBUI_MAP},
 '/graph':{title:'지식 지도',body:'기억 노드와 관계 유형을 브라우저 네이티브 WebGL로 그립니다. 레이아웃은 도메인 그룹만 인코딩합니다 — 화면상의 거리는 임베딩 유사도 수치가 아닙니다.',source:WEBUI_MAP},
 '/activity':{title:'활동 · 추적',body:'무엇이 바뀌었고 어떤 작업이 실행됐는지 원장으로 확인합니다. 실패한 기록에는 원인·영향·다음 행동이 함께 붙습니다. 수집되지 않은 값은 0으로 환산하지 않습니다.',source:WEBUI_FAIL},
 '/settings':{title:'관리',body:'런타임 정보, 명시적으로 실행하는 관리 명령, 이 브라우저의 화면 설정, 그리고 진단입니다. 관리 명령은 상단 조회 범위와 무관하게 항상 전체 데이터를 대상으로 합니다.',source:WEBUI_CONTRACT},
};

/** 상단 컨트롤. 한 줄 title 툴팁으로 쓴다. */
export const CONTROLS={
 scope:{title:'조회 범위',body:'이 화면이 읽는 범위입니다. 주입 범위와 다릅니다 — 주입은 언제나 현재 프로젝트 + 공통 기억 기준입니다.',source:WEBUI},
 scopeHint:{title:'주입 범위 안내',body:'전체 프로젝트는 조회 전용입니다. 실제로 세션에 들어가는 기억은 작업 중인 프로젝트와 공통 기억에서 고릅니다.',source:WEBUI},
 includeGlobal:{title:'공통 포함',body:'프로젝트 범위에 프로젝트에 종속되지 않는 공통 기억을 함께 표시합니다.',source:WEBUI},
 advanced:{title:'상세 조회 범위',body:'워크스페이스·작업 흐름을 골라 그 범위의 미승격 기억을 추가로 봅니다. 브랜치·워크스페이스 계층 전체를 포함하는 체크박스도 여기 있습니다.',source:WEBUI_TIERS},
 search:{title:'통합 검색 (⌘/Ctrl + K)',body:'현재 조회 범위에서 기억과 대화를 함께 찾습니다. 저장된 내용을 검색할 뿐 모델을 호출하지 않습니다.',source:'docs/GUIDE.md#6-검색과-분석'},
 live:{title:'실시간 자동 갱신',body:'활동 화면에서 10초마다 다시 읽습니다. 입력 중이거나 상세를 열어 둔 동안에는 멈춥니다.',source:WEBUI},
 refresh:{title:'새로고침',body:'현재 화면을 다시 읽습니다. 변경이 감지되면 아이콘이 바뀝니다.',source:WEBUI},
 theme:{title:'밝기 테마',body:'밝게·어둡게를 전환합니다. 이 브라우저에만 저장됩니다.',source:WEBUI},
 connection:{title:'UI 연결 상태',body:'브라우저와 이 서버의 연결만 나타냅니다. 플러그인이나 훅의 건강 상태와는 다릅니다.',source:WEBUI_CONTRACT},
 glossary:{title:'용어집 (?)',body:'이 화면에서 쓰는 용어의 정의를 한 곳에서 봅니다.',source:WEBUI},
};

/** 표 머리글. 숫자·시각의 의미가 헷갈리는 열만 설명한다. */
export const HEADERS={
 tier:{title:'주입 계층',body:'이 기억이 어느 범위의 세션에 주입되는지를 나타냅니다.',source:WEBUI_TIERS},
 evidence:{title:'직접 근거',body:'이 기억을 뒷받침하는 원문 대화 턴의 수입니다. 해석에 참고한 맥락은 따로 셉니다.',source:LIFECYCLE},
 nextAction:{title:'다음 행동',body:'docs/GUIDE.md §20의 실패 클래스 표에서 파생한 안내입니다.',source:GUIDE_FAIL},
 attempts:{title:'시도',body:'이 작업이 실행된 횟수와 허용된 최대 횟수입니다.',source:GUIDE_CONTINUITY},
 tokens:{title:'토큰 관측',body:'실제로 수집된 토큰 사용량만 표시합니다. 미수집을 0으로 해석하지 않습니다.',source:GUIDE_BUDGET},
 updated:{title:'최근 변경',body:'이 기록이 마지막으로 바뀐 시각입니다. 사건이 일어난 시각과 다를 수 있습니다.',source:WEBUI_CONTRACT},
};

/** 범위 옵션 3종. */
export const SCOPES={
 all:{title:'전체 프로젝트 (조회)',body:'모든 프로젝트와 공통 기억을 한 화면에서 봅니다. 조회 전용이며 주입 범위가 아닙니다.',source:WEBUI},
 global:{title:'공통 기억',body:'프로젝트에 종속되지 않는 기억입니다. 대화·작업·활동 기록은 이 범위에 없습니다.',source:WEBUI},
 project:{title:'프로젝트',body:'한 프로젝트의 기억과 대화입니다. 공통 기억 포함 여부와 계층 범위를 따로 고를 수 있습니다.',source:WEBUI},
};

/** 관리 명령. 무엇을 하는지, 모델을 부르는지, 되돌릴 수 있는지. */
export const COMMANDS={
 doctor:{title:'설치·런타임 진단',body:'설치 상태와 실행 환경을 검사만 합니다. 모델을 부르지 않고 데이터를 바꾸지 않습니다.',source:GUIDE_DIAG},
 status:{title:'파이프라인 상태 확인',body:'전체 데이터의 처리 상태를 읽습니다. 모델을 부르지 않고 데이터를 바꾸지 않습니다.',source:GUIDE_CONTINUITY},
 sync:{title:'대화 동기화',body:'보관된 대화를 인덱스에 반영합니다. 모델을 부르지 않지만 인덱스를 변경합니다. 원본 대화 파일은 건드리지 않습니다.',source:GUIDE_SYNC},
 extract:{title:'기억 추출 백필',body:'미처리 대화에서 기억을 추출합니다. 모델을 호출할 수 있고 기억을 새로 만듭니다. 되돌리려면 만들어진 기억을 개별로 비활성화해야 합니다.',source:GUIDE_FACTS},
 ontology:{title:'온톨로지 분류 백필',body:'미분류 기억을 분류합니다. 모델을 호출할 수 있습니다. 분류는 로컬 파생 상태라 다시 만들 수 있습니다.',source:'docs/GUIDE.md#ontology-taxonomy-수리-061-47'},
 embeddings:{title:'임베딩 백필',body:'누락된 벡터를 다시 만듭니다. 로컬 임베딩 런타임만 쓰고 외부 모델을 부르지 않습니다.',source:GUIDE_DIAG},
 all:{title:'전체 백필',body:'추출·분류·임베딩을 코어가 정한 순서로 수행합니다. 모델을 호출할 수 있습니다.',source:GUIDE_CONTINUITY},
 recover:{title:'실패 종료 작업 복구',body:'실패로 끝난 작업을 다시 대기 상태로 되돌립니다. 아무것도 삭제하지 않고, 지워진 오류 원문은 보존됩니다.',source:GUIDE_FAIL},
 'tiers-preview':{title:'기억 계층 이관 미리보기',body:'브랜치 신호 없이 브랜치 계층에 남은 기억을 나열만 합니다. 아무것도 바꾸지 않습니다.',source:WEBUI_PROMOTE},
 'tiers-apply':{title:'기억 계층 이관 적용',body:'미리보기에 나온 기억을 프로젝트 공용으로 올리고 Chronicle에 계층 승격 이벤트를 남깁니다. 되돌리려면 개별로 강등해야 합니다.',source:WEBUI_PROMOTE},
};

/** 상태 배지 전종. ui.mjs의 label 키와 1:1로 맞춘다. */
export const BADGES={
 ASSERTED:'추출기나 사용자가 이 기억을 확정한 이벤트입니다.',
 RETIRED:'기억을 더 이상 쓰지 않도록 내린 이벤트입니다.',
 RELATION_CREATED:'기억 사이의 관계가 만들어진 이벤트입니다.',
 RELATION_REMOVED:'기억 사이의 관계가 제거된 이벤트입니다.',
 active:'검색·지도·주입 후보에 포함되는 상태입니다.',
 inactive:'기본 조회와 주입에서 제외됩니다. 기록은 지워지지 않았습니다.',
 running:'지금 실행 중입니다. 임대 시각이 지났다면 실행기가 사라진 것입니다.',
 pending:'차례를 기다리는 중입니다. 실패가 아닙니다.',
 processing:'입력 항목을 처리하는 중입니다.',
 processed:'이 입력 항목의 처리가 끝났습니다.',
 completed:'정상적으로 끝났습니다.',
 failed:'이번 시도가 실패했습니다. 재시도 여부는 상태와 시도 수로 판단합니다.',
 dead:'재시도 상한을 소진해 종료됐습니다. 복구하거나 사유를 남기고 정리해야 합니다.',
 retry:'실패 후 다음 재시도 시각을 기다립니다.',
 superseded:'같은 대상의 새 작업으로 대체됐습니다.',
 reserved:'예산에서 시도가 예약된 상태입니다. 아직 결과가 없습니다.',
 unknown:'서버가 다시 시작돼 이전 실행의 최종 상태를 알 수 없습니다.',
 cancelled:'사용자가 중단했습니다. 이미 커밋된 변경은 되돌아가지 않습니다.',
 cancelling:'중단 신호를 보냈고 종료를 기다리는 중입니다.',
 'timed-out':'실행 시간 제한에 걸려 종료됐습니다.',
 'failed-visible':'재시도해도 같은 결과가 나오는 실패라서 숨기지 않고 표시합니다.',
 injected:'기억을 컨텍스트로 제공했습니다. 답변에 활용됐다는 증거는 아닙니다.',
 emitted:'컨텍스트를 실제로 내보냈습니다.',
 prepared:'제공을 준비했지만 발행 기록이 아직 없습니다.',
 deduped:'같은 기억이 이미 제공돼 중복 제공을 생략했습니다.',
 'no-match':'관련성 기준을 넘는 기억이 없었습니다. 오류가 아닙니다.',
 skipped:'정책에 따라 대상에서 제외했습니다.',
 error:'이 기록에 오류가 남아 있습니다.',
 observed:'실제로 관측된 값입니다.',
 partial:'일부만 관측됐습니다.',
 NOT_PROVEN:'수집되지 않았습니다. 0이라는 뜻이 아닙니다.',
 decision:'무엇을 하기로 정했는가 — 결정입니다.',
 preference:'어떻게 하기를 원하는가 — 선호입니다.',
 constraint:'무엇을 하면 안 되는가 — 제약입니다.',
 pattern:'반복해서 나타나는 방식 — 패턴입니다.',
 knowledge:'참이라고 확인된 사실 — 지식입니다.',
 CREATED:'기억이 새로 만들어진 이벤트입니다.',
 CHANGED:'기억의 의미가 바뀐 이벤트입니다.',
 DEACTIVATED:'기억을 비활성화한 이벤트입니다.',
 REACTIVATED:'비활성 기억을 다시 활성화한 이벤트입니다.',
 RESTORED:'기억을 복원한 이벤트입니다.',
 PROMOTED:'계층을 한 칸 위로 올린 이벤트입니다.',
 DEMOTED:'계층을 한 칸 아래로 내린 이벤트입니다.',
 CONSOLIDATED:'중복된 기억을 하나로 합친 이벤트입니다.',
 CONTRADICTED:'서로 어긋나는 기억이 발견된 이벤트입니다.',
 INCIDENT:'처리 중 문제가 기록된 이벤트입니다.',
 VALIDATED:'검증이 기록된 이벤트입니다.',
 REVERTED:'이전 상태로 되돌린 이벤트입니다.',
 REVERT_REQUESTED:'되돌림이 요청된 이벤트입니다.',
 LEGACY:'이벤트 종류가 기록되기 전 버전의 기록입니다.',
 SUPPORTS:'이 기억이 다른 기억을 뒷받침합니다.',
 INFLUENCES:'이 기억이 다른 기억에 영향을 줍니다.',
 SUPERSEDES:'이 기억이 다른 기억을 대체합니다.',
 CONTRADICTS:'이 기억이 다른 기억과 상충합니다.',
 fact_extract:'대화에서 기억을 뽑아내는 작업입니다.',
 capture_index:'대화를 인덱스에 넣는 작업입니다. 가장 높은 우선순위입니다.',
 capsule_update:'작업 맥락 Capsule을 갱신하는 작업입니다. 기억이 아니라 해석용 맥락입니다.',
 ontology:'기억을 주제로 분류하는 작업입니다.',
 extract:'기억 추출 작업입니다.',
 user:'사람이 직접 한 변경입니다.',
 extractor:'추출기가 만든 기록입니다.',
 consolidator:'통합기가 만든 기록입니다.',
 sync:'기기 사이 동기화가 만든 기록입니다.',
 project:'한 프로젝트에 속한 범위입니다.',
 global:'프로젝트에 종속되지 않는 공통 범위입니다.',
 workspace:'한 체크아웃(작업 공간)에만 적용되는 계층입니다.',
 workstream:'한 브랜치 작업 흐름에만 적용되는 계층입니다.',
 'legacy-project':'계층 규칙이 생기기 전에 배치된 프로젝트 기억입니다.',
 'project-current':'프로젝트 전체에 적용되는 현행 기억입니다.',
 'no-inject':'제공 기록은 있지만 실제로 전달된 기억이 0건입니다.',
};

/** `?` 단축키로 여는 용어집. `to`는 그 용어를 볼 수 있는 화면이다. */
export const GLOSSARY=[
 {term:'기억 · 사실 (fact)',body:'대화에서 뽑아낸 한 문장짜리 사실입니다. 대화 요약이 아니라, 정확한 원문 근거에 묶인 진술입니다.',to:'/facts',source:LIFECYCLE},
 {term:'직접 근거',body:'이 기억이 그렇게 말하는 이유가 된 실제 대화 턴입니다. `source_exchange_ids`에 정확한 원문만 들어갑니다.',to:'/facts',source:LIFECYCLE},
 {term:'해석에 참고한 맥락',body:'기억을 이해하는 데 필요했지만 근거로 승격되지 않는 주변 맥락입니다. 직접 근거와 절대 섞지 않습니다.',to:'/facts',source:LIFECYCLE},
 {term:'검증 영수증',body:'현재 의미 버전이 로컬 원문과 맞는지 확인한 기록입니다. 없으면 자동 통합에서 제외되고 동기화 충돌에서 밀립니다.',to:'/facts',source:GUIDE_FACTS},
 {term:'주입 계층 (tier)',body:'브랜치 → 프로젝트 공용 → 글로벌 세 칸짜리 사다리입니다. 계층이 곧 "어느 세션에 이 기억이 들어가는가"입니다.',to:'/facts',source:GUIDE_TIERS},
 {term:'승격 · 강등',body:'계층을 한 칸씩 옮기는 일입니다. 글로벌로 보내려면 먼저 프로젝트 공용으로 올려야 하고, 모든 이동은 Chronicle에 남습니다.',to:'/facts',source:WEBUI_PROMOTE},
 {term:'프로젝트',body:'경로가 아니라 안정적인 식별자로 관리되는 작업 단위입니다. 같은 저장소의 여러 체크아웃이 한 프로젝트를 공유할 수 있습니다.',to:'/',source:GUIDE_TIERS},
 {term:'워크스페이스',body:'한 기기의 한 체크아웃 디렉터리입니다. 같은 프로젝트라도 체크아웃이 다르면 워크스페이스가 다릅니다.',to:'/',source:GUIDE_TIERS},
 {term:'작업 흐름 (workstream)',body:'브랜치 신호가 있는 세션들의 묶음입니다. 브랜치 계층 기억은 이 단위로 격리됩니다.',to:'/',source:GUIDE_TIERS},
 {term:'Capsule',body:'작업의 목표와 현재 상태를 이어 주는 연속성 요약입니다. 해석용 맥락이며 직접 근거가 아니고, 한도를 넘으면 잘립니다.',to:'/conversations',source:GUIDE_CONTINUITY},
 {term:'주입 · 컨텍스트 제공',body:'저장된 기억을 세션의 컨텍스트로 내보내는 일입니다. **제공됐다는 기록이 답변에 활용됐다는 증거는 아닙니다.**',to:'/activity',source:WEBUI_CONTRACT},
 {term:'미수집',body:'그 값이 기록되지 않았다는 뜻입니다. 0이나 없음으로 바꿔 표시하지 않습니다.',to:'/activity',source:WEBUI_CONTRACT},
 {term:'발생 시각 vs 기록 시각',body:'사건이 실제로 일어난 시각과 Memex가 그것을 기록한 시각을 분리해 보여줍니다. 둘은 자주 다릅니다.',to:'/activity',source:WEBUI_CONTRACT},
 {term:'모델 작업 예산',body:'한 실행(run)이 쓸 수 있는 시도 수·기한·입출력 문자 한도입니다. 소진되면 남은 대상은 다음 실행으로 넘어갑니다.',to:'/activity',source:GUIDE_BUDGET},
 {term:'백필',body:'이미 저장된 데이터에 대해 빠진 처리(추출·분류·임베딩·영수증)를 나중에 채우는 일입니다.',to:'/settings',source:GUIDE_CONTINUITY},
 {term:'Chronicle',body:'기억이 언제 왜 바뀌었는지를 남기는 이벤트 원장입니다. 근거 없는 원인은 기록하지 않습니다.',to:'/activity',source:WEBUI_CONTRACT},
 {term:'동기화',body:'기기 사이에 durable 기억 상태만 주고받습니다. 대화 원문·번역·분류·벡터는 각 기기에서 다시 만듭니다. 기본값은 꺼짐입니다.',to:'/settings',source:GUIDE_SYNC},
];

export const ALL=[
 ...Object.entries(PAGES).map(([key,v])=>['page:'+key,v]),
 ...Object.entries(CONTROLS).map(([key,v])=>['control:'+key,v]),
 ...Object.entries(HEADERS).map(([key,v])=>['header:'+key,v]),
 ...Object.entries(SCOPES).map(([key,v])=>['scope:'+key,v]),
 ...Object.entries(COMMANDS).map(([key,v])=>['command:'+key,v]),
];
const BY_KEY=new Map(ALL);
export const helpFor=key=>BY_KEY.get(key)||null;
export const badgeHelp=value=>BADGES[value]||null;
/** 모든 source 앵커. 테스트가 문서에 실제로 있는지 검사한다. */
export const SOURCES=[...new Set([...ALL.map(([,v])=>v.source),...GLOSSARY.map(g=>g.source)])];
