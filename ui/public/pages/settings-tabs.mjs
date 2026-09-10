// 관리 탭 레지스트리 (#109, 0.7.0 lane-0 · 설계 §16.3 C4).
//
// 탭 순서·id·레이블 키의 **유일한 진원지**다. 기존 id 5개는 개명하지 않고 alias도 URL
// 정규화도 없다 — `?tab=actions`·`?tab=interface`가 지금처럼 동작한다(C4.1).
//
// 기능 레인(오버레이·모델 설정)은 **기존 항목의 `enabled`·`render` 2필드만** 바꾼다.
// 항목을 추가하면 중복 탭이 된다(C4.2). 레이블 키 7개는 이미 i18n/settings/{en,ko}.mjs에
// 있으므로 기능 레인이 사전에 손댈 settings.* 키는 없다(C4.3 · decisions-v3 I3).

/**
 * `render`가 이 함수면 "settings.mjs가 자기 분기로 그린다"는 뜻이다. 탭이 보이는 조건
 * (`enabled && render`)은 그대로 만족시키면서, i18n L2가 탭별 렌더 함수로 쪼갤 때
 * 이 자리를 실제 함수로 교체하면 된다. 기능 레인은 자기 렌더 함수를 바로 넣는다.
 */
export function renderedBySettingsPage() { return null; }

export const SETTINGS_TABS = [
  { id: 'runtime', labelKey: 'settings.tabs.runtime', enabled: true, render: renderedBySettingsPage },
  { id: 'actions', labelKey: 'settings.tabs.actions', enabled: true, render: renderedBySettingsPage },
  { id: 'sync', labelKey: 'settings.tabs.sync', enabled: true, render: renderedBySettingsPage },
  { id: 'interface', labelKey: 'settings.tabs.interface', enabled: true, render: renderedBySettingsPage },
  { id: 'diagnostics', labelKey: 'settings.tabs.diagnostics', enabled: true, render: renderedBySettingsPage },
  // ↓ 오버레이·모델 레인은 이 두 항목의 enabled·render만 바꾼다.
  { id: 'overlays', labelKey: 'settings.tabs.overlays', enabled: false, render: null },
  { id: 'models', labelKey: 'settings.tabs.models', enabled: false, render: null },
];

export const DEFAULT_TAB = 'runtime';
/** 사전 키만 있고 화면이 없는 탭은 노출되지 않는다(C4.6). */
export const visibleTabs = () => SETTINGS_TABS.filter(tab => tab.enabled && tab.render);
/** 미지원·비활성 탭은 runtime으로 떨어진다 — 현행 동작과 같다(C4.5). */
export const tabFor = raw => visibleTabs().find(tab => tab.id === raw)
  ?? visibleTabs().find(tab => tab.id === DEFAULT_TAB)
  ?? visibleTabs()[0]
  ?? null;
