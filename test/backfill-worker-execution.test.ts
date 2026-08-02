import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * backfill 워커 **실행** 회귀 (Codex R15 MEDIUM).
 *
 * 리뷰어가 증명한 구멍: 기존 워커 테스트는 소스 문자열만 봤고, **수정 전(결함) 소스가
 * assertion 7/7 을 전부 통과**했다 — 즉 R14 수정을 되돌려도 스위트는 완전 초록인 채
 * 경보만 조용히 죽는다. 문자열 검사로는 "워커가 표를 어떻게 읽는가"를 검증할 수 없다.
 *
 * 그래서 여기서는 워커를 **자식 프로세스로 실제 실행**한다. 의존 dist 모듈을 스텁으로
 * 대체해 실패 경로를 결정론적으로 재현하고, 표준출력의 요약줄을 계약으로 고정한다.
 *  - 정상 표: handoff/transient/budget 로 정확히 라우팅 + INTERNAL 경보
 *  - 구버전 표(label/note 만): 필드가 없어도 경보가 **살아남아야** 한다(R14 수정의 핵심)
 */

let sandbox: string;

/** 워커가 import 하는 dist 모듈을 최소 스텁으로 만든다. */
function writeStubs(opts: { staleTable: boolean }): void {
  const dist = path.join(sandbox, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'index'), { recursive: true });

  // 실패 4종을 한 번씩 만들어내는 가짜 파이프라인.
  const table = opts.staleTable
    ? `{
        handoff: { label: 'HANDOFF', note: '구버전' },
        provider_transient: { label: 'ERROR', note: '구버전' },
        provider_deterministic: { label: 'ERROR', note: '구버전' },
        internal: { label: 'ERROR', note: '구버전' },
      }`
    : `{
        handoff: { label: 'HANDOFF', note: 'h', bucket: 'handoff', consumesBudget: false, escalate: false },
        provider_transient: { label: 'ERROR', note: 't', bucket: 'transient', consumesBudget: false, escalate: false },
        provider_deterministic: { label: 'ERROR', note: 'd', bucket: 'budget', consumesBudget: true, escalate: false },
        internal: { label: 'ERROR', note: 'i', bucket: 'budget', consumesBudget: true, escalate: true },
      }`;

  fs.writeFileSync(path.join(dist, 'fact-extractor.js'), `
const KINDS = ['handoff', 'provider_transient', 'provider_deterministic', 'internal'];
let n = 0;
export async function runFactExtraction() { throw new Error('KIND:' + KINDS[n++ % KINDS.length]); }
export function classifyExtractionFailure(err) { return String(err.message).replace('KIND:', ''); }
export const FAILURE_REPORT = ${table};
`);
  fs.writeFileSync(path.join(dist, 'db.js'), `
export function initDatabase() {
  return {
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }),
    transaction: (fn) => fn,
    close: () => {},
    pragma: () => {},
  };
}
`);
  // 세션 4개를 pending 으로 반환 → 실패 4종이 한 번씩 발생한다.
  fs.writeFileSync(path.join(dist, 'pending-extraction.js'), `
export function getExtractionConfig() { return { minExchanges: 2, excludeProjects: [] }; }
export function pendingExtractionCoreQuery() { return { sql: 'SELECT 1', params: [] }; }
`);
  fs.writeFileSync(path.join(dist, 'project-canon.js'), `export function canonicalizeProject(_d, p) { return p; }\n`);
  fs.writeFileSync(path.join(dist, 'paths.js'), `export function getIndexDir() { return ${JSON.stringify(path.join(sandbox, 'index'))}; }\n`);

  // 워커 원본을 그대로 복사 — 검증 대상은 **실제 소스**여야 한다.
  const worker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backfill-extract-worker.js'), 'utf8')
    // pendingSessions 가 스텁 DB 로도 4세션을 내놓게 최소 치환(쿼리 결과만 대체).
    .replace(
      'return db.prepare(`${sql} ORDER BY ts DESC LIMIT ?`).all(...params, limit);',
      "return [{sid:'s1'},{sid:'s2'},{sid:'s3'},{sid:'s4'}];",
    )
    // seed 단계는 이 테스트의 관심사가 아니다 — 함수 본문이 아니라 **호출부**만 치환한다
    // (본문을 주석으로 감싸면 구문이 깨진다).
    .replace('const seeded = seedFromExistingFacts(db);', 'const seeded = 0;');
  fs.writeFileSync(path.join(sandbox, 'scripts', 'backfill-extract-worker.js'), worker);
}

function runWorker(): string {
  try {
    return execFileSync(process.execPath, ['scripts/backfill-extract-worker.js'], {
      cwd: sandbox, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, BACKFILL_CONCURRENCY: '1' },
    });
  } catch (e) {
    // 워커가 non-zero 로 죽어도 출력은 검사한다(진단 가능하도록).
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-backfill-exec-')); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('backfill 워커 실행 계약', () => {
  it('정상 표: 4분류가 각 버킷으로 라우팅되고 INTERNAL 경보가 뜬다', () => {
    writeStubs({ staleTable: false });
    const out = runWorker();
    expect(out, 'handoff 집계').toMatch(/handoff 1/);
    expect(out, 'transient 집계').toMatch(/transient-deferred 1/);
    expect(out, 'budget 집계(deterministic+internal)').toMatch(/budget-burned 2/);
    expect(out, '운영 에스컬레이션 신호').toMatch(/INTERNAL failures 1/);
  });

  it('구버전 표(필드 누락)에서도 INTERNAL 경보가 살아남는다 (R14 수정의 회귀 보호)', () => {
    writeStubs({ staleTable: true });
    const out = runWorker();
    // 수정 전 소스는 rep.bucket/rep.escalate 가 undefined 라 유령 버킷에 집계되고
    // 경보가 통째로 사라졌다 — 그때 이 단언이 실패한다.
    expect(out, '필드 누락 시 경보가 무음으로 사라지면 안 된다').toMatch(/INTERNAL failures/);
    expect(out, '미지 버킷은 budget 으로 흡수돼야 한다').toMatch(/budget-burned/);
    expect(out, '유령 버킷 키가 노출되면 안 된다').not.toMatch(/undefined/);
  });
});
