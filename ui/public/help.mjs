// 도움말·툴팁·용어집 카탈로그 (#28, i18n #109).
//
// 단일 출처는 docs/GUIDE.md와 docs/WEBUI-WORKSPACE.md의 정의이고, 항목마다 `source`로 그 문서의
// 앵커를 가리킨다. ui/test/help.test.cjs가 (a) 메뉴·배지·관리 명령·범위 옵션에 항목이 있는지
// (b) 참조한 앵커가 실제로 문서에 있는지 검사한다.
//
// 0.7.0 (#109): **산문은 전부 `i18n/help/{en,ko}.mjs`로 내려갔다.** 이 모듈에 남은 것은
//   · 6개 맵의 **키 집합**(= 무엇에 도움말이 있어야 하는가의 계약)
//   · 용어집의 **안정적 `id`**·`to` 라우트·배열 순서 (0.6.x까지는 한국어 `term`이 사실상 키였다)
//   · `source` 앵커 — 값은 언어 무관 모듈 `i18n/doc-anchors.mjs`가 갖는다
// 이고, `title`/`body`/`term`은 **접근 시점에 `t()`로 읽는 게터**다. 모듈 최상위에서 평가하면
// 사전이 꽂히기 전(`boot()` 이전)에 키 문자열이 굳어 버린다(설계 §2.6).
//
// `BADGES`(71)는 삭제됐다 — `ui.mjs`의 `label`(71)과 합쳐 `badge.<value>.{label,help}` 한
// 네임스페이스가 됐고(설계 §6.2 · §12.3 X1), `badgeHelp()`가 그 `.help`를 조회한다.
//
// 이 모듈은 i18n 런타임 외에는 아무것도 import하지 않는다 — ui.mjs가 배지 툴팁을 위해 이 파일을
// 읽기 때문이다(leaf 유지). 설명은 코드 동작과 일치해야 하고 추측하지 않는다("제공됨 ≠ 활용됨").
import {t,tHtml,hasKey} from './i18n/index.mjs';
import {DOC_ANCHORS as A} from './i18n/doc-anchors.mjs';

const REPO='https://github.com/BongSuCHOI/memex';
/** 문서 링크는 로컬 파일 경로가 아니라 릴리스 태그에 고정한 GitHub URL이다. */
export function docUrl(source,version){
 const [file,anchor]=String(source||'').split('#');
 const ref=version&&/^\d+\.\d+\.\d+/.test(String(version))?'v'+String(version).split(' ')[0]:'main';
 return `${REPO}/blob/${ref}/${file}${anchor?'#'+anchor:''}`;
}
/**
 * `docs/*.md` 13편은 전부 한국어이고 영문판이 없다. 앵커를 언어별로 갈라 두면 404 링크가 되므로
 * en UI도 같은 문서로 보내고, **대신 한 줄 고지를 붙인다**(설계 §6.4). ko에서는 빈 문자열이다.
 * 호출자는 값이 비었으면 아무것도 그리지 않는다.
 */
export const docsNotice=()=>t('help.docs.koreanOnly');

/** `{title, body, source}` 계약을 유지하면서 산문만 지연 조회한다 (§12.3 X3: 반환 형태 불변). */
const entry=(keyBase,source)=>({source,
 get title(){return t(`${keyBase}.title`);},
 get body(){return t(`${keyBase}.body`);}});

/** 메뉴 7개. 페이지 헤더의 ⓘ가 이 문단을 보여준다. 키 슬러그는 라우트에서 파생한다. */
export const PAGES={
 '/':entry('help.page.overview',A.WEBUI),
 '/conversations':entry('help.page.conversations',A.WEBUI),
 '/facts':entry('help.page.facts',A.GUIDE_FACTS),
 '/taxonomy':entry('help.page.taxonomy',A.WEBUI_MAP),
 '/graph':entry('help.page.graph',A.WEBUI_MAP),
 '/activity':entry('help.page.activity',A.WEBUI_FAIL),
 '/settings':entry('help.page.settings',A.WEBUI_CONTRACT),
};

/** 상단 컨트롤. 한 줄 title 툴팁으로 쓴다. */
export const CONTROLS={
 scope:entry('help.control.scope',A.WEBUI),
 scopeHint:entry('help.control.scopeHint',A.WEBUI),
 includeGlobal:entry('help.control.includeGlobal',A.WEBUI),
 advanced:entry('help.control.advanced',A.WEBUI_TIERS),
 search:entry('help.control.search',A.GUIDE_SEARCH),
 live:entry('help.control.live',A.WEBUI),
 refresh:entry('help.control.refresh',A.WEBUI),
 theme:entry('help.control.theme',A.WEBUI),
 connection:entry('help.control.connection',A.WEBUI_CONTRACT),
 glossary:entry('help.control.glossary',A.WEBUI),
};

/** 표 머리글. 숫자·시각의 의미가 헷갈리는 열만 설명한다. */
export const HEADERS={
 tier:entry('help.header.tier',A.WEBUI_TIERS),
 evidence:entry('help.header.evidence',A.LIFECYCLE),
 nextAction:entry('help.header.nextAction',A.GUIDE_FAIL),
 attempts:entry('help.header.attempts',A.GUIDE_CONTINUITY),
 tokens:entry('help.header.tokens',A.GUIDE_BUDGET),
 updated:entry('help.header.updated',A.WEBUI_CONTRACT),
};

/** 범위 옵션 3종. */
export const SCOPES={
 all:entry('help.scope.all',A.WEBUI),
 global:entry('help.scope.global',A.WEBUI),
 project:entry('help.scope.project',A.WEBUI),
};

/** 관리 명령. 무엇을 하는지, 모델을 부르는지, 되돌릴 수 있는지. */
export const COMMANDS={
 doctor:entry('help.command.doctor',A.GUIDE_DIAG),
 status:entry('help.command.status',A.GUIDE_CONTINUITY),
 sync:entry('help.command.sync',A.GUIDE_SYNC),
 extract:entry('help.command.extract',A.GUIDE_FACTS),
 ontology:entry('help.command.ontology',A.GUIDE_ONTOLOGY_REPAIR),
 embeddings:entry('help.command.embeddings',A.GUIDE_DIAG),
 all:entry('help.command.all',A.GUIDE_CONTINUITY),
 recover:entry('help.command.recover',A.GUIDE_FAIL),
 'tiers-preview':entry('help.command.tiers-preview',A.WEBUI_PROMOTE),
 'tiers-apply':entry('help.command.tiers-apply',A.WEBUI_PROMOTE),
};

/**
 * `?` 단축키로 여는 용어집. `to`는 그 용어를 볼 수 있는 화면이다.
 *
 * **`id`가 안정적 식별자다** (0.7.0 #109). 0.6.x까지는 한국어 `term`이 키 역할을 해서 테스트가
 * 한국어 문자열로 항목을 조회했다 — 사전을 한국어 산문으로 키잉하게 되는 구조였다(설계 §6.2).
 *
 * `bodyHtml`은 **0.6.x부터 있던 표시 버그를 고친다**: 본문에 마크다운(`**…**`, 백틱)이 들어
 * 있는데 호출자가 `esc()`로 출력해 별표와 백틱이 문자 그대로 보였다. 사전 값이 이제
 * `<strong>`·`<code>`를 담고 `tHtml`이 파라미터만 이스케이프한다(설계 §2.5 (a) · §6.2).
 *
 * `body`는 **평문**을 유지한다 — 기존 호출자는 `esc(g.body)`로 출력하므로, 여기서 태그를 그대로
 * 내보내면 마크다운 별표 대신 `<strong>`이 문자로 보이는 같은 버그가 된다. 태그를 지운 `body`는
 * 지금 당장 더 나아지고(별표·백틱이 사라진다), 호출자가 `bodyHtml`로 옮기면 강조까지 살아난다.
 * 사전 값의 태그는 §9.1 (2)가 `strong|em|code|br|kbd`로 제한하므로 단순 제거로 충분하다.
 */
const plain=value=>String(value).replace(/<[^>]+>/g,'');
const glossaryEntry=(id,to,source)=>({id,to,source,
 get term(){return t(`help.glossary.${id}.term`);},
 get body(){return plain(t(`help.glossary.${id}.body`));},
 get bodyHtml(){return tHtml(`help.glossary.${id}.body`);}});
export const GLOSSARY=[
 glossaryEntry('fact','/facts',A.LIFECYCLE),
 glossaryEntry('directEvidence','/facts',A.LIFECYCLE),
 glossaryEntry('interpretiveContext','/facts',A.LIFECYCLE),
 glossaryEntry('receipt','/facts',A.GUIDE_FACTS),
 glossaryEntry('tier','/facts',A.GUIDE_TIERS),
 glossaryEntry('promotion','/facts',A.WEBUI_PROMOTE),
 glossaryEntry('project','/',A.GUIDE_TIERS),
 glossaryEntry('workspace','/',A.GUIDE_TIERS),
 glossaryEntry('workstream','/',A.GUIDE_TIERS),
 glossaryEntry('capsule','/conversations',A.GUIDE_CONTINUITY),
 glossaryEntry('recall','/activity',A.WEBUI_CONTRACT),
 glossaryEntry('notRecorded','/activity',A.WEBUI_CONTRACT),
 glossaryEntry('effectiveVsRecorded','/activity',A.WEBUI_CONTRACT),
 glossaryEntry('modelBudget','/activity',A.GUIDE_BUDGET),
 glossaryEntry('backfill','/settings',A.GUIDE_CONTINUITY),
 glossaryEntry('chronicle','/activity',A.WEBUI_CONTRACT),
 glossaryEntry('sync','/settings',A.GUIDE_SYNC),
];
/** 용어집 항목을 id로 찾는다. 테스트와 딥링크가 한국어 문자열 대신 이것을 쓴다. */
export const glossaryFor=id=>GLOSSARY.find(g=>g.id===id)||null;

export const ALL=[
 ...Object.entries(PAGES).map(([key,v])=>['page:'+key,v]),
 ...Object.entries(CONTROLS).map(([key,v])=>['control:'+key,v]),
 ...Object.entries(HEADERS).map(([key,v])=>['header:'+key,v]),
 ...Object.entries(SCOPES).map(([key,v])=>['scope:'+key,v]),
 ...Object.entries(COMMANDS).map(([key,v])=>['command:'+key,v]),
];
const BY_KEY=new Map(ALL);
export const helpFor=key=>BY_KEY.get(key)||null;
/**
 * 상태 배지의 한 줄 설명. 설명이 없는 값에는 `null`을 돌려준다 — `t()`를 바로 부르면 임의의
 * 배지 값마다 "missing key" 콘솔 오류가 쏟아진다.
 */
export const badgeHelp=value=>{const key=`badge.${value}.help`;return hasKey(key)?t(key):null;};
/** 모든 source 앵커. 테스트가 문서에 실제로 있는지 검사한다. */
export const SOURCES=[...new Set([...ALL.map(([,v])=>v.source),...GLOSSARY.map(g=>g.source)])];
