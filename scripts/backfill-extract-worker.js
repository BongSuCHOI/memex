#!/usr/bin/env node

/**
 * Cross-project fact-extraction backfill (detached, resumable).
 *
 * The SessionEnd hook only covers sessions that end while the fixed hook is
 * installed — every earlier session (all projects) was never extracted. This
 * worker walks ALL unprocessed sessions, newest first, runs the same
 * extraction pipeline, and records each session in extraction_log so work is
 * idempotent and resumable.
 *
 * Seed step: sessions that already produced facts (via source_exchange_ids)
 * are pre-marked as processed so they are not re-extracted into duplicates.
 *
 * Usage: node scripts/backfill-extract-worker.js [--max N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { getExtractionConfig, pendingExtractionCoreQuery } from '../dist/pending-extraction.js';
import { runFactExtraction } from '../dist/fact-extractor.js';
import { classifyLlmError, LlmCallError } from '../dist/llm-error-class.js';
import { canonicalizeProject } from '../dist/project-canon.js';
import { getIndexDir } from '../dist/paths.js';

const maxArg = process.argv.indexOf('--max');
// Per-run cap (env-overridable). Bounded by DEFAULT — NOT Infinity — so a single
// run (including a detached run whose session has ended) can never flood the LLM
// proxy: it processes at most this many sessions, then exits cleanly. The
// SessionStart hook re-spawns to drain the rest across sessions (resumable via
// extraction_log). Garbage --max/env values must not silently fall back to
// unbounded, so validate to a finite non-negative integer.
// (def, cap): validate to a finite non-negative int, then clamp to an absolute
// per-run ceiling so NO invocation path — explicit --max, hook-inherited env, or
// default — can exceed `cap` and flood the proxy.
function boundedInt(raw, def, cap) {
  // Strict: only an all-digits string is a valid override; malformed input
  // ('', '1e9', '200.9', '999abc', undefined) falls back to the default rather
  // than being partially parsed by parseInt. Then clamp to the absolute ceiling.
  const s = raw == null ? '' : String(raw);
  const v = /^\d+$/.test(s) ? parseInt(s, 10) : def;
  return Math.min(v, cap);
}
const MAX_SESSIONS = maxArg > -1
  ? boundedInt(process.argv[maxArg + 1], 40, 200)
  : boundedInt(process.env.BACKFILL_EXTRACT_MAX, 40, 200);
// Strict + clamped to [1, 8]: BACKFILL_CONCURRENCY=0/'abc'/'-1' must not yield
// zero workers (silent no-op) or overspawn.
const CONCURRENCY = Math.max(1, boundedInt(process.env.BACKFILL_CONCURRENCY, 4, 8));

// Exclude self-referential repo conversations (memory-bank's own monitoring /
// cron sessions). These are ~98% 1-exchange noise that the backfill itself
// generates, so including them is a feedback loop that never converges.
// Comma-separated cwd paths; env-overridable.
const { minExchanges: MIN_EXCHANGES, excludeProjects: EXCLUDE_PROJECTS } = getExtractionConfig();


const LOCK = path.join(getIndexDir(), 'backfill-extract.lock');
const LOG = path.join(getIndexDir(), 'backfill-extract.log');

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try { fs.appendFileSync(LOG, msg + '\n'); } catch { /* best-effort */ }
  console.log(msg);
}

function acquireLock() {
  // Atomic exclusive create ('wx') — a read-then-write check is racy when two
  // SessionStart hooks spawn workers simultaneously.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
        if (pid && !Number.isNaN(pid)) {
          try { process.kill(pid, 0); return false; } // alive → don't run
          catch { /* stale lock */ }
        }
        fs.unlinkSync(LOCK); // stale — remove and retry the exclusive create
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK);
  } catch { /* ignore */ }
}

/** Pre-mark sessions that already yielded facts (historic batch runs). */
function seedFromExistingFacts(db) {
  const facts = db.prepare(
    "SELECT source_exchange_ids FROM facts WHERE source_exchange_ids IS NOT NULL AND source_exchange_ids != '[]'"
  ).all();
  const exchangeIds = new Set();
  for (const f of facts) {
    try { for (const id of JSON.parse(f.source_exchange_ids)) exchangeIds.add(id); }
    catch { /* skip malformed */ }
  }
  if (exchangeIds.size === 0) return 0;

  const sessionStmt = db.prepare('SELECT session_id FROM exchanges WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO extraction_log (session_id, processed_at, extracted, saved)
    VALUES (?, ?, -1, -1)
  `);
  const now = new Date().toISOString();
  let seeded = 0;
  const tx = db.transaction(() => {
    const seen = new Set();
    for (const exId of exchangeIds) {
      const row = sessionStmt.get(exId);
      const sid = row?.session_id;
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        if (insertStmt.run(sid, now).changes > 0) seeded++;
      }
    }
  });
  tx();
  return seeded;
}

function pendingSessions(db, limit) {
  // Single source (pendingExtractionCoreQuery) shared with the SessionStart
  // hook's spawn condition so the two can never drift.
  const { sql, params } = pendingExtractionCoreQuery({ minExchanges: MIN_EXCHANGES, excludeProjects: EXCLUDE_PROJECTS });
  return db.prepare(`${sql} ORDER BY ts DESC LIMIT ?`).all(...params, limit);
}

/** Simple concurrency pool — LLM latency dominates, DB writes are sync-safe. */
async function runPool(items, concurrency, fn) {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await fn(item);
    }
  });
  await Promise.all(workers);
}

function sessionProject(db, sid) {
  const byCwd = db.prepare(`
    SELECT cwd, COUNT(*) AS n FROM exchanges
    WHERE session_id = ? AND cwd IS NOT NULL
    GROUP BY cwd ORDER BY n DESC LIMIT 1
  `).get(sid);
  if (byCwd?.cwd) return byCwd.cwd;
  const bySlug = db.prepare(
    'SELECT project FROM exchanges WHERE session_id = ? LIMIT 1'
  ).get(sid);
  return bySlug ? canonicalizeProject(db, bySlug.project) : null;
}

async function main() {
  if (!acquireLock()) {
    console.log('backfill-extract: another worker is running, exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  let db;
  try {
    db = initDatabase();

    const seeded = seedFromExistingFacts(db);
    if (seeded) log(`seed: marked ${seeded} already-extracted sessions`);

    const sessions = pendingSessions(db, MAX_SESSIONS);
    log(`backfill-extract: ${sessions.length} sessions this run (concurrency ${CONCURRENCY})`);

    let done = 0, totalSaved = 0, transientSessions = 0, internalFailures = 0;
    await runPool(sessions, CONCURRENCY, async (next) => {
      const project = sessionProject(db, next.sid);
      try {
        // 선점은 runFactExtraction 이 단독 소유한다. 'worker' 변형은 자기가 pending
        // 으로 선정했던 상태일 때만 성공하므로, 선정 후 훅이 먼저 확정한 세션을
        // 덮어 재추출하는 중복 경로가 구조적으로 막힌다(Codex R6 HIGH).
        const result = await runFactExtraction(db, next.sid, project ?? 'unknown', undefined, { claimVariant: 'worker' });
        totalSaved += result.saved;
        if (result.saved > 0) {
          log(`session ${next.sid} (${project ?? '?'}, ${next.n} exch): saved ${result.saved}`);
        }
      } catch (error) {
        // 실패를 3분류한다. 예전에는 어떤 에러든 extraction_log(-2) 로 기록해서
        // "한 세션에 물리지 않는다"는 목적은 달성했지만, 공급자 장애(429/5xx/네트워크/
        // 빈 응답)로 실패한 세션까지 영구 제외돼 그 대화의 fact 가 영원히 추출되지
        // 않았다. transient 는 기록하지 않고 다음 run 에 남긴다 — 이번 run 에서만
        // 건너뛰므로 루프가 물리지도 않는다(스핀 방지 목적은 유지).
        // 이연 대상은 **공급자 실패만**이다. fact-extractor 는 공급자 거절을
        // LlmCallError 로 감싸 던지므로 그것만 이연하고, 내부 실패(DB 쓰기·임베딩
        // 런타임·파서 버그)는 이연하지 않는다 — 내부가 깨진 상태에서 이연하면
        // 최신 세션이 매 run 재시도되며 오래된 백로그가 영구 기아한다
        // (Codex 리뷰 R3 HIGH). 내부 실패는 마커를 남겨 큐를 진행시키되 INTERNAL
        // 로 크게 표면화한다 — 조용히 넘어가지 않는다.
        // 실패 분류와 마커 기록은 **선점 소유자**인 runFactExtraction 이 단독 수행한다
        // (소유권 토큰이 그쪽에만 있으므로 여기서 쓰면 남의 claim 을 덮을 수 있다).
        // 워커는 관측만 한다.
        const isProviderError = error instanceof LlmCallError;
        const cls = isProviderError ? classifyLlmError(error) : 'internal';
        log(`session ${next.sid}: ERROR (${cls}) ${error instanceof Error ? error.message : error}`);
        if (cls === 'internal') internalFailures++;
        else transientSessions++;
      }
      done++;
      if (done % 25 === 0) log(`progress: ${done}/${sessions.length} sessions, facts saved ${totalSaved}`);
    });
    log(
      `backfill-extract: done this run (sessions ${done}, facts saved ${totalSaved}` +
      (transientSessions > 0 ? `, transient-deferred ${transientSessions} — will retry next run` : '') +
      (internalFailures > 0 ? `, INTERNAL failures ${internalFailures} — 런타임/DB 점검 필요` : '') + ')',
    );
  } catch (error) {
    log(`backfill-extract: FATAL ${error instanceof Error ? error.message : error}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
