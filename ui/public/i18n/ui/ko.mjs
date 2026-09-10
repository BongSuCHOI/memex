// ui — 계층 라벨, 동기화 출처, 페이지네이션, 이벤트 행, a11y 문구. 소유: i18n L1.
export default {
  // ── 주입 계층 (ui.mjs tierLabel / tierExplain) ─────────────────────────────
  'tier.global.label': '글로벌 공용',
  'tier.global.explain': '모든 프로젝트의 세션에 주입 후보로 올라갑니다.',
  'tier.workstream.label': '브랜치',
  'tier.workstream.branch': '브랜치: {branch}',
  'tier.workstream.explain': '이 기억을 만든 작업 흐름의 세션에만 주입됩니다.',
  'tier.workstream.explain.branch': '브랜치 {branch} 세션에만 주입됩니다.',
  'tier.workspace.label': '워크스페이스',
  'tier.workspace.explain': '이 체크아웃(워크스페이스)의 세션에만 주입됩니다.',
  'tier.project.label': '프로젝트 공용',
  'tier.project.explain': '프로젝트 {project}의 모든 세션에 주입됩니다.',
  // ── 페이지네이션 ───────────────────────────────────────────────────────────
  'pagination.total.other': '총 {total}개',
  'pagination.range': '{from}–{to} 표시',
  'pagination.page': '{page} / {pages}',
  // ── 동기화 가져오기 출처 (ui.mjs SYNC_REASON / syncOriginTag) ──────────────
  'sync.reason.peer-newer': '가져온 쪽의 의미 수정 시각이 더 최근입니다.',
  'sync.reason.local-newer': '이 기기의 의미 수정 시각이 더 최근입니다.',
  'sync.reason.tie-broken-by-key': '수정 시각이 같아 결정적 규칙(정규화된 내용 키)으로 정했습니다.',
  'sync.origin.fromDevice': '기기 {device}에서 가져옴',
  'sync.origin.fromOtherDevice': '다른 기기에서 가져옴',
  'sync.winner.local': '이 기기의 값이 남음',
  'sync.winner.peer': '가져온 값으로 대체됨',
  // ── 이벤트 행 (ui.mjs eventRow) ────────────────────────────────────────────
  'event.fact.defaultTitle': '기억 상태 변경',
  'event.knowledge.defaultTitle': '지식 이벤트',
  'event.occurredAt': '발생 {date}',
  'event.noFactChange': '현재 기억 변경 없음',
  // ── 접근성 전용 ────────────────────────────────────────────────────────────
  'a11y.switchLanguage': '표시 언어 전환',
  'a11y.pageHelp': '{title} 도움말',
  'a11y.recordedAt': '기록한 시각',
  'a11y.eventDetail': '이벤트 상세',
};
