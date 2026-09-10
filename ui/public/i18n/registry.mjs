// 네임스페이스 목록과 키 접두사 소유권 (#109, 0.7.0 lane-0).
//
// 디렉터리 하나 = 소유자 하나다. lane-0이 13개를 전부 선언하므로 이후 어떤 레인도
// 이 목록에 항목을 추가하지 않는다 — 자기 디렉터리의 {en,ko}.mjs만 채운다.

export const NAMESPACES = Object.freeze([
  'common', 'shell', 'ui', 'badge', 'errors', 'pages', 'activity',
  'details', 'settings', 'help', 'guidance', 'overlays', 'models',
]);

/**
 * 네임스페이스별 허용 키 접두사.
 *
 * 중복 키 throw는 *같은* 키만 잡는다. 기능 레인이 `settings.tabs.overlays`를 자기 파일에
 * 옮겨 적고 lane-0 쪽을 지우면 중복이 아니므로 통과해 버린다 — 접두사 검사가 **소유권**을
 * 강제한다(설계 §9.1 (11)). 특히 `settings.*`의 유일한 소유자는 `settings`다.
 *
 * 소유 레인은 자기 행에 접두사를 **추가**할 수 있다(이 파일에서 허용되는 유일한 변경).
 * 다른 레인의 행은 건드리지 않는다.
 */
export const PREFIXES = Object.freeze({
  common: ['common.', 'unit.', 'action.', 'label.', 'state.', 'note.', 'op.'],
  shell: ['shell.'],
  // event.* 는 i18n L1이 추가했다 — ui.mjs eventRow()의 타임라인 문구(설계 §12.3 L1).
  ui: ['tier.', 'a11y.', 'pagination.', 'sync.', 'status.', 'event.'],
  badge: ['badge.'],
  errors: ['error.'],
  pages: ['pages.'],
  activity: ['activity.'],
  details: ['details.'],
  settings: ['settings.'],
  help: ['help.'],
  guidance: ['guidance.'],
  overlays: ['overlays.'],
  models: ['models.'],
});
