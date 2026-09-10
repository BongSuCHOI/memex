'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
/**
 * HTTP 오류 (#109, 0.7.0 · 설계 §5.2 · §16.1 C1).
 *
 * 계약은 **객체 인자 하나**다:
 *   new HttpError(status, {code, key, params, message, details})
 *     code    기계 판별용 안정 코드 (기본 'REQUEST_FAILED'). 기존 코드는 변경하지 않는다.
 *     key     i18n 키, 또는 null = 코어·런타임 원문 패스스루. 번역은 전부 클라이언트가 한다.
 *     params  key 보간 값.
 *     message en 한 줄 (필수) — 로그·curl·비브라우저 호출자용.
 *     details 선택. 허용 형태는 {issues: Issue[]} 하나.
 *             Issue = {row?, field?, path?, key, params?, message?, severity?}
 *
 * 위치 인자 `(status, message, code)` 호출은 **어댑터가 흡수**한다 — 이관은 한 번에 되지
 * 않으므로 3번째 인자(legacyCode)까지 정확히 전달해야 `error.code` 기반 분기가 조용히
 * 깨지지 않는다(decisions-v3 I1).
 */
class HttpError extends Error {
  constructor(status, info, legacyCode) {
    const o = normalizeErrorInfo(info, legacyCode);
    super(o.message);
    this.status = status;
    this.code = o.code;
    this.key = o.key;
    this.params = o.params;
    this.details = o.details;
    // super(message)와 별개로 명시 보관한다 — 직렬화기는 이 값을 쓴다.
    this.uiMessage = o.message;
  }
}
/**
 * 레거시 호환 어댑터. 이관이 끝나도 남긴다 — 외부(플러그인·훅)에서 들어오는 옛 호출을
 * 조용히 깨뜨리지 않는다.
 *   new HttpError(404,'Not found')               → {code:'REQUEST_FAILED', key:null, message:'Not found'}
 *   new HttpError(404,'Not found','NOT_FOUND')   → {code:'NOT_FOUND',      key:null, message:'Not found'}
 *   new HttpError(404,{key:'k',message:'m'},'X') → {code:'X', key:'k'}   (info.code가 있으면 그것이 이긴다)
 */
function normalizeErrorInfo(info, legacyCode) {
  if (typeof info === 'string') {
    return { code: legacyCode || 'REQUEST_FAILED', key: null, params: null, details: null, message: info };
  }
  if (!info || typeof info !== 'object') throw new TypeError('HttpError: info must be an object or a message string');
  if (typeof info.message !== 'string' || !info.message) throw new TypeError('HttpError: info.message (en) is required');
  return {
    code: info.code || legacyCode || 'REQUEST_FAILED',
    key: info.key ?? null,
    params: info.params ?? null,
    details: info.details ?? null,
    message: info.message,
  };
}
function integer(value, fallback, min = 0, max = 500) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new HttpError(400, '정수 형식의 값이 필요합니다.', 'INVALID_NUMBER');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `허용 범위: ${min}–${max}`, 'INVALID_NUMBER');
  return n;
}
function text(value, max = 500) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function identifier(value) {
  const id = text(value, 200);
  if (!id || /[\x00-\x1f]/.test(id)) throw new HttpError(400, '유효한 ID가 필요합니다.', 'INVALID_ID');
  return id;
}
function sqlName(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('Unsafe SQL identifier');
  return '"' + name + '"';
}
function parseJSON(raw, fallback = null) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}
function array(raw) { const value = parseJSON(raw, []); return Array.isArray(value) ? value : []; }
function cleanRow(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).filter(([, value]) => !Buffer.isBuffer(value) && !(value instanceof Uint8Array)));
}
function redact(input) {
  return String(input ?? '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}
function hash(input) { return crypto.createHash('sha256').update(String(input)).digest('hex'); }
function canonicalProject(value) {
  if (!value || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new HttpError(400, '프로젝트는 정규화 가능한 절대 경로여야 합니다.', 'INVALID_SCOPE');
  return path.normalize(value).replace(/\/+$/, '') || '/';
}
module.exports = { HttpError, normalizeErrorInfo, integer, text, identifier, sqlName, parseJSON, array, cleanRow, redact, hash, canonicalProject };
