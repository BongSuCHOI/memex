// 문서 앵커 — **언어 무관 상수**. (#109, 0.7.0 lane-0)
//
// docs/*.md 13편은 전부 한국어이고 영문판이 없다. 앵커를 언어별로 갈라 두면 0.7.x에서
// 바로 드리프트하거나 404 링크가 되므로, en UI도 같은 문서의 같은 앵커로 보낸다
// (설계 §6.4). 한글 프래그먼트가 사전 밖에 남는 유일한 허용 지점이고, 소스 한글 린트는
// 이 파일을 경로로 면제한다.
//
// 값은 help.mjs의 기존 상수를 **그대로** 옮긴 것이다. help.mjs는 i18n L4가 이 모듈을
// 참조하도록 바꾼다(lane-0은 그 파일을 건드리지 않는다).
export const DOC_ANCHORS = Object.freeze({
  GUIDE_UI: 'docs/GUIDE.md#9-web-ui',
  GUIDE_FACTS: 'docs/GUIDE.md#7-fact-관리',
  GUIDE_FAIL: 'docs/GUIDE.md#20-문제가-생겼을-때--실패-클래스별-복구',
  GUIDE_CONTINUITY: 'docs/GUIDE.md#15-continuity-운영',
  GUIDE_BUDGET: 'docs/GUIDE.md#17-모델-작업-예산과-대기-진단',
  GUIDE_SYNC: 'docs/GUIDE.md#10-저장-위치와-sync',
  GUIDE_DIAG: 'docs/GUIDE.md#13-진단',
  GUIDE_TIERS: 'docs/GUIDE.md#수집과-기억-계층',
  GUIDE_RECOVER: 'docs/GUIDE.md#작업이-실패했을-때-terminal-상태-복구',
  // ↓ L4(#109): lane-0은 help.mjs의 **이름 붙은** 상수 16개만 옮겼다. help.mjs와 guidance.mjs의
  //   `source`에 인라인으로 박혀 있던 한국어 앵커 3개가 남아 §8.2 게이트를 막으므로 같이 올린다.
  GUIDE_SEARCH: 'docs/GUIDE.md#6-검색과-분석',
  GUIDE_ONTOLOGY_REPAIR: 'docs/GUIDE.md#ontology-taxonomy-수리-061-47',
  GUIDE_DO_NOT_INDEX: 'docs/GUIDE.md#11-do-not-index와-재분류-비용',
  WEBUI: 'docs/WEBUI-WORKSPACE.md#화면',
  WEBUI_TIERS: 'docs/WEBUI-WORKSPACE.md#계층-배지와-숨겨진-계층-061-22',
  WEBUI_PROMOTE: 'docs/WEBUI-WORKSPACE.md#승격강등과-계층-이관-061-22',
  WEBUI_FAIL: 'docs/WEBUI-WORKSPACE.md#문제가-생겼을-때',
  WEBUI_MAP: 'docs/WEBUI-WORKSPACE.md#지식-지도',
  WEBUI_CONTRACT: 'docs/WEBUI-WORKSPACE.md#계약',
  LIFECYCLE: 'docs/FACT-LIFECYCLE.md#1-fact란-무엇인가',
});
