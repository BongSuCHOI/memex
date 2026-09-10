// ui — 계층 라벨, 동기화 출처, 페이지네이션, 이벤트 행, a11y 문구. 소유: i18n L1.
// 상태 배지의 이름·설명은 `badge/` 네임스페이스가 갖는다(설계 §12.3 X1).
export default {
  // ── 주입 계층 (ui.mjs tierLabel / tierExplain) ─────────────────────────────
  'tier.global.label': 'Global',
  'tier.global.explain': 'Becomes an injection candidate for sessions in every project.',
  'tier.workstream.label': 'Branch',
  'tier.workstream.branch': 'Branch: {branch}',
  'tier.workstream.explain': 'Injected only into sessions of the workstream that created this memory.',
  'tier.workstream.explain.branch': 'Injected only into sessions on branch {branch}.',
  'tier.workspace.label': 'Workspace',
  'tier.workspace.explain': 'Injected only into sessions of this checkout (workspace).',
  'tier.project.label': 'Project-wide',
  'tier.project.explain': 'Injected into every session of project {project}.',
  // ── 페이지네이션 ───────────────────────────────────────────────────────────
  'pagination.total.one': '{total} row',
  'pagination.total.other': '{total} rows',
  'pagination.range': 'showing {from}–{to}',
  'pagination.page': '{page} / {pages}',
  // ── 동기화 가져오기 출처 (ui.mjs SYNC_REASON / syncOriginTag) ──────────────
  'sync.reason.peer-newer': 'The imported side has the more recent meaning edit.',
  'sync.reason.local-newer': 'This device has the more recent meaning edit.',
  'sync.reason.tie-broken-by-key': 'The edit times matched, so a deterministic rule (the normalised content key) decided.',
  'sync.origin.fromDevice': 'Imported from {device}',
  'sync.origin.fromOtherDevice': 'Imported from another device',
  'sync.winner.local': 'This device kept its value',
  'sync.winner.peer': 'Replaced by the imported value',
  // ── 이벤트 행 (ui.mjs eventRow) ────────────────────────────────────────────
  'event.fact.defaultTitle': 'Memory state change',
  'event.knowledge.defaultTitle': 'Knowledge event',
  'event.occurredAt': 'Occurred {date}',
  'event.noFactChange': 'No change to the current memory',
  // ── 접근성 전용 (스크린샷에 안 나와 눈으로 누락을 못 잡는다) ──────────────
  'a11y.switchLanguage': 'Switch language',
  'a11y.pageHelp': 'Help for {title}',
  'a11y.recordedAt': 'Recorded at',
  'a11y.eventDetail': 'Event details',
};
