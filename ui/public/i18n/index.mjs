// Web UI 번역 런타임 (#109, 0.7.0 lane-0).
//
// 계약은 docs 설계 §2.2 / §16.2 C2가 소유한다. 이 모듈의 규칙 3개:
//   1. **top-level await 금지** — ui/test/*.test.cjs가 require()로 이 ESM을 불러온다.
//   2. **런타임 언어 간 폴백 없음** — 사전에 없는 키는 키 문자열을 그대로 내보내고
//      console.error를 키당 한 번 찍는다. en으로 떨어지면 "영어 폴백 0건" 검사가
//      통과해 버려 회귀가 숨는다.
//   3. 알 수 없는 로케일은 throw한다. 조용한 폴백은 디버깅을 불가능하게 만든다.
//
// 복수형 해소(`.other`로 내려가기)는 **같은 사전 안에서만** 일어난다 — 언어 간 폴백과
// 별개의 개념이다.

export const LOCALES = Object.freeze(['en', 'ko']);
export const DEFAULT_LOCALE = 'en';
/** 언어 선택은 표시 설정(memex.workspace.preferences)과 생애주기가 달라 별 키에 둔다. */
export const LANGUAGE_STORAGE_KEY = 'memex.workspace.language';

let TAG = DEFAULT_LOCALE;
let DICT = Object.create(null);
const REPORTED = new Set();

/**
 * 사전을 동기적으로 꽂는다. 폴백 사전 인자는 없다(설계 §2.2).
 * @param {'en'|'ko'} tag
 * @param {Record<string,string>} dict
 */
export function setLocale(tag, dict) {
  if (!LOCALES.includes(tag)) throw new Error(`[i18n] unknown locale ${tag}`);
  if (!dict || typeof dict !== 'object') throw new TypeError('[i18n] setLocale needs a dictionary object');
  TAG = tag;
  DICT = dict;
  REPORTED.clear();
}

export const localeTag = () => TAG;
export const intlTag = () => (TAG === 'ko' ? 'ko-KR' : 'en-US');
/** 테스트·린트용. 런타임 분기에 쓰지 않는다. */
export const hasKey = key => Object.prototype.hasOwnProperty.call(DICT, key);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

/** `{htmlLink}`처럼 html로 시작하는 파라미터만 마크업을 원문 통과시킨다(설계 §2.5 c). */
const HTML_PARAM = /^html[A-Z_]/;
const encodeParam = (value, name) => (HTML_PARAM.test(name) ? String(value ?? '') : escapeHtml(value));

function interpolate(template, params, encode) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
    (params && name in params ? encode(params[name], name) : whole));
}

/** 누락 키는 버그다 — 모드와 무관하게 키당 한 번 보고하고 키를 그대로 내보낸다. */
function missing(key) {
  if (!REPORTED.has(key)) {
    REPORTED.add(key);
    console.error(`[memex-ui][i18n] missing ${TAG} key: ${key}`);
  }
  return String(key);
}

/** 평문. 호출자가 esc()한다. */
export function t(key, params) {
  const template = DICT[key];
  if (template === undefined) return missing(key);
  return params ? interpolate(template, params, v => String(v ?? '')) : String(template);
}

/** 사전 값의 마크업은 신뢰하고, 파라미터는 이스케이프한다(html* 접두사만 원문). */
export function tHtml(key, params) {
  const template = DICT[key];
  if (template === undefined) return escapeHtml(missing(key));
  return interpolate(template, params || {}, encodeParam);
}

/**
 * 복수형. 형태 선택은 Intl.PluralRules가 하고, 없는 형태는 **같은 사전의** `.other`로 내려간다.
 * ko 사전은 `.other` 하나만 두면 된다.
 */
export function tn(key, count, params) {
  const form = new Intl.PluralRules(intlTag()).select(Number(count));
  const exact = `${key}.${form}`;
  const chosen = Object.prototype.hasOwnProperty.call(DICT, exact) ? exact : `${key}.other`;
  return t(chosen, { ...(params || {}), count });
}

/**
 * 네임스페이스 병합. 스프레드는 중복 키를 조용히 덮어쓰므로 **모듈 로드 시점에 throw**한다.
 * @param {Array<[string, Record<string,string>]>} entries
 */
export function mergeNamespaces(entries) {
  const out = Object.create(null);
  const owner = new Map();
  for (const [ns, dict] of entries) {
    if (!dict || typeof dict !== 'object') throw new TypeError(`[i18n] namespace "${ns}" has no dictionary`);
    for (const key of Object.keys(dict)) {
      if (owner.has(key)) throw new Error(`[i18n] duplicate key "${key}": ${owner.get(key)} and ${ns}`);
      owner.set(key, ns);
      out[key] = dict[key];
    }
  }
  return { dict: out, owner };
}

/**
 * 서버가 심은 기본 언어. 인라인 스크립트는 CSP(`script-src 'self'`)에 차단되므로
 * `<html data-lang>`를 1순위, `<meta name="memex-ui-lang">`를 2순위로 읽는다(설계 §3.3).
 */
export function serverLocale() {
  if (typeof document === 'undefined') return null;
  const root = document.documentElement?.dataset?.lang;
  if (LOCALES.includes(root)) return root;
  const meta = document.querySelector('meta[name="memex-ui-lang"]')?.content;
  return LOCALES.includes(meta) ? meta : null;
}

/** `?lang` > localStorage > `<html data-lang>`/meta > en. navigator.language은 쓰지 않는다. */
export function resolveLocale() {
  let asked = null;
  try { asked = new URL(location.href).searchParams.get('lang'); } catch { asked = null; }
  if (LOCALES.includes(asked)) return { tag: asked, from: 'query' };
  let saved = null;
  try { saved = localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch { saved = null; }
  if (LOCALES.includes(saved)) return { tag: saved, from: 'storage' };
  const injected = serverLocale();
  if (injected) return { tag: injected, from: 'server' };
  return { tag: DEFAULT_LOCALE, from: 'default' };
}

/** 언어 선택을 이 브라우저에 저장한다. `?lang`은 저장하지 않는다(설계 §3.1). */
export function storeLocale(tag) {
  if (!LOCALES.includes(tag)) throw new Error(`[i18n] unknown locale ${tag}`);
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, tag); } catch { /* private mode */ }
  return tag;
}
