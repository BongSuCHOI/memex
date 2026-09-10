// settings — 관리 화면. 소유: lane-0이 탭 레이블 7개와 언어 행을 만들고, i18n L2가
// 나머지 settings.* 를 같은 파일에 채운다. 기능 레인(overlays/models)은 **읽기만** 한다:
// settings.tabs.overlays / settings.tabs.models도 여기 있으므로 건드리지 않는다(I3).
export default {
  'settings.tabs.runtime': 'Runtime',
  'settings.tabs.actions': 'Admin actions',
  'settings.tabs.sync': 'Sync',
  'settings.tabs.interface': 'Display',
  'settings.tabs.diagnostics': 'Diagnostics',
  'settings.tabs.overlays': 'Extraction rules',
  'settings.tabs.models': 'Models',
  'settings.interface.language.title': 'Display language',
  'settings.interface.language.body': 'Applies to this browser only. Changing it reloads the page.',
  'settings.interface.language.fromUrl': 'From ?lang',
};
