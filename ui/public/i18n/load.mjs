// 언어별 사전 묶음 로더 (#109, 0.7.0 lane-0).
//
// **정적 import 26개**를 쓴다. 템플릿 경로 import(`./${ns}/${tag}.mjs`)는 동적이라
// 정적 분석·린트·IDE 추적이 끊기고, 이 UI는 번들러 없이 파일을 그대로 서빙한다.
// registry.mjs의 목록과 어긋나면 ui/test/i18n.test.cjs (5)가 잡는다.
//
// top-level await 금지 — ui/test/*.test.cjs가 require()로 불러온다.

import { NAMESPACES } from './registry.mjs';
import { mergeNamespaces } from './index.mjs';

import commonEn from './common/en.mjs'; import commonKo from './common/ko.mjs';
import shellEn from './shell/en.mjs'; import shellKo from './shell/ko.mjs';
import uiEn from './ui/en.mjs'; import uiKo from './ui/ko.mjs';
import badgeEn from './badge/en.mjs'; import badgeKo from './badge/ko.mjs';
import errorsEn from './errors/en.mjs'; import errorsKo from './errors/ko.mjs';
import pagesEn from './pages/en.mjs'; import pagesKo from './pages/ko.mjs';
import activityEn from './activity/en.mjs'; import activityKo from './activity/ko.mjs';
import detailsEn from './details/en.mjs'; import detailsKo from './details/ko.mjs';
import settingsEn from './settings/en.mjs'; import settingsKo from './settings/ko.mjs';
import helpEn from './help/en.mjs'; import helpKo from './help/ko.mjs';
import guidanceEn from './guidance/en.mjs'; import guidanceKo from './guidance/ko.mjs';
import overlaysEn from './overlays/en.mjs'; import overlaysKo from './overlays/ko.mjs';
import modelsEn from './models/en.mjs'; import modelsKo from './models/ko.mjs';

export const TABLES = {
  en: {
    common: commonEn, shell: shellEn, ui: uiEn, badge: badgeEn, errors: errorsEn,
    pages: pagesEn, activity: activityEn, details: detailsEn, settings: settingsEn,
    help: helpEn, guidance: guidanceEn, overlays: overlaysEn, models: modelsEn,
  },
  ko: {
    common: commonKo, shell: shellKo, ui: uiKo, badge: badgeKo, errors: errorsKo,
    pages: pagesKo, activity: activityKo, details: detailsKo, settings: settingsKo,
    help: helpKo, guidance: guidanceKo, overlays: overlaysKo, models: modelsKo,
  },
};

/** 중복 키가 있으면 여기서 throw한다(mergeNamespaces). */
export function loadDictionary(tag) {
  const table = TABLES[tag];
  if (!table) throw new Error(`[i18n] unknown locale ${tag}`);
  return mergeNamespaces(NAMESPACES.map(ns => [ns, table[ns]]));
}
