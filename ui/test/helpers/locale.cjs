'use strict';
/**
 * 테스트 로케일 하네스 (#109, 0.7.0 lane-0 · 설계 §9.2).
 *
 * 기존 테스트의 한국어 단정(pages 206건 · guidance 77건 · help 66건 · core 51건)을
 * 키 조회로 바꾸지 않는다 — 파일 맨 위에 `require('./helpers/locale.cjs').useKo();`
 * 한 줄만 넣으면 그대로 통과한다. 이관(L1~L4)이 진행돼도 이 한 줄은 그대로다.
 */
const {setLocale} = require('../../public/i18n/index.mjs');
const {loadDictionary} = require('../../public/i18n/load.mjs');

const en = loadDictionary('en').dict;
const ko = loadDictionary('ko').dict;

module.exports = {
  useEn: () => setLocale('en', en),
  useKo: () => setLocale('ko', ko),
  en,
  ko,
};
