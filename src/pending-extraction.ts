/**
 * Single source of truth for "which sessions still need cross-project fact
 * extraction". BOTH the backfill-extract worker (to pick sessions to process)
 * AND the SessionStart hook (to decide whether to spawn that worker) must use
 * the IDENTICAL predicate — otherwise the spawn condition drifts from the work
 * condition. Observed drift (2026-07-11): the hook counted any session missing
 * from extraction_log (509), while the worker additionally drops
 * memory-bank-llm pollution sessions and sessions below MIN_EXCHANGES and so
 * only processed 4 — leaving 505 phantom "pending" sessions that the worker can
 * never clear, so the hook spawned the worker (model load + LLM setup) on EVERY
 * session start forever, for nothing.
 */

function boundedInt(raw: string | undefined, def: number, cap: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return def;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 1 && n <= cap ? n : def;
}

export interface ExtractionConfig {
  minExchanges: number;
  excludeProjects: string[];
}

/** Env-derived config, identical for the worker and the hook. */
export function getExtractionConfig(): ExtractionConfig {
  const excludeProjects = (
    process.env.BACKFILL_EXCLUDE_PROJECTS ||
    '/Users/jung-wankim/Project/Claude/memory-bank'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Default 2: 1-exchange sessions are overwhelmingly automated-worker /
  // monitoring noise that yields no durable facts. Interpolated into SQL →
  // boundedInt (not bare parseInt) so garbage can't reach the query text.
  const minExchanges = boundedInt(process.env.BACKFILL_MIN_EXCHANGES, 2, 1000);
  return { minExchanges, excludeProjects };
}

/**
 * extraction_log.extracted 의 상태 코드 (음수는 전부 "fact 0건"의 사유 구분).
 *
 * 🚨 이 3-상태가 없으면 세션 처리는 두 나쁜 선택 사이를 왕복한다 — 실패를 기록하면
 * pending 에서 영구 제외되어 fact 가 영영 안 생기고(손실), 기록하지 않고 이연하면
 * 런타임이 깨졌을 때 최신 세션만 매 run 재시도되며 오래된 백로그가 기아한다.
 * 실제로 이 진동이 Codex 적대 리뷰 R3(기아)↔R4(손실)에서 관측됐다. 해법은 어느
 * 한쪽을 고르는 게 아니라 **재시도 예산을 가진 제3의 터미널 상태**다:
 *   -1  seed        : 과거에 이미 fact 를 만든 세션 (재추출 금지)
 *   -2  permanent   : 같은 입력이면 같은 결과인 실패 (per-request 거절) — 재시도 무의미
 *   -4  retriable   : 내부 실패(DB/임베딩/파서). saved 컬럼에 시도 횟수를 적고,
 *                     예산이 남아 있는 동안은 pending 에 **다시 포함**된다. 예산을
 *                     소진하면 워커가 -2 로 승격해 큐가 영원히 물리지 않는다.
 * (공급자 장애는 애초에 행을 쓰지 않고 이연한다 — 예산 소모 없이 회복 시 재개.)
 */
export const EXTRACTION_STATE = {
  SEED: -1,
  PERMANENT: -2,
  RETRIABLE_INTERNAL: -4,
} as const;

/** 내부 실패 재시도 예산 — 소진하면 PERMANENT 로 승격(무한 재시도 방지). */
export const MAX_INTERNAL_RETRIES = 3;

/**
 * Core SELECT over pending-extraction sessions, through GROUP BY / HAVING but
 * WITHOUT any ORDER BY / LIMIT — callers wrap it:
 *   worker: `${sql} ORDER BY ts DESC LIMIT ?`   (params + limit)
 *   hook:   `SELECT 1 FROM (${sql}) LIMIT 1`     (params)
 * Columns: sid, ts, n.
 */
export function pendingExtractionCoreQuery(cfg: ExtractionConfig): { sql: string; params: string[] } {
  const exTerms = cfg.excludeProjects;
  // `x.session_id IS NOT NULL` is load-bearing: one NULL inside NOT IN makes the
  // whole predicate NULL (3-valued logic) → zero pending sessions → silent drain.
  const exClause = `AND e.session_id NOT IN (
      SELECT DISTINCT x.session_id FROM exchanges x
      WHERE x.session_id IS NOT NULL
        AND (x.cwd LIKE '%/memory-bank-llm'
      ${exTerms.length ? 'OR ' + exTerms.map(() => 'x.cwd = ?').join(' OR ') : ''})
    )`;
  const sql = `
    SELECT e.session_id AS sid, MAX(e.timestamp) AS ts, COUNT(*) AS n
    FROM exchanges e
    WHERE e.is_sidechain = 0 AND e.session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM extraction_log l
        WHERE l.session_id = e.session_id
          -- 재시도 예산이 남은 내부 실패(-4)는 '처리됨'이 아니다 → 여전히 pending.
          -- 이 예외가 없으면 일시적 런타임 장애 한 번에 세션이 영구 손실된다.
          AND NOT (l.extracted = ${EXTRACTION_STATE.RETRIABLE_INTERNAL}
                   AND l.saved < ${MAX_INTERNAL_RETRIES})
      )
      ${exClause}
    GROUP BY e.session_id
    HAVING COUNT(*) >= ${cfg.minExchanges}`;
  return { sql, params: exTerms };
}
