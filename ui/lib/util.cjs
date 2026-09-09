'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
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
module.exports = { HttpError, integer, text, identifier, sqlName, parseJSON, array, cleanRow, redact, hash, canonicalProject };
