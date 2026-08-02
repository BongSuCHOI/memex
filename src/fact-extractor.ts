import Database from 'better-sqlite3';
import type { ExtractedFact } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
import { classifyLlmError, LlmCallError } from './llm-error-class.js';
import { insertFact } from './fact-db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { classifyAndLinkFact } from './ontology-classifier.js';

export const EXTRACTION_SYSTEM_PROMPT = `You are an expert at extracting long-term facts from conversations.

## Rules
- 1 fact = 1 sentence (concise)
- Ignore trivial exchanges (greetings, "yes", "thanks")
- Code snippets are NOT facts - extract only decisions/patterns
- No duplicate facts within the same batch
- Prefer durable facts (decisions, conventions, constraints, lessons) over
  session-ephemeral details ("user is currently editing file X" is NOT a fact)
- Capture problem→solution lessons as "pattern"
  (e.g., "X error in this project is caused by Y and fixed by Z")

## scope determination
- project: specific files/paths/DB/API/framework/business logic
- global: coding style, language/response format, common tool usage

## Output format (JSON array)
[
  {
    "fact": "User uses Riverpod for state management",
    "fact_kr": "사용자는 상태 관리에 Riverpod을 사용한다",
    "category": "decision",
    "scope_type": "project",
    "confidence": 0.9
  }
]

## fact_kr rules
- Natural Korean translation of "fact"
- Keep technical terms (API/tool/framework names, file paths, commands) in English

## category choices
- decision: architecture/technology decisions
- preference: user preferences
- pattern: repeated patterns
- knowledge: project knowledge
- constraint: constraints

## confidence criteria
- 0.9+: explicit decision/declaration
- 0.7-0.9: inferred from behavior
- Below 0.7: do not extract`;

const BATCH_SIZE = 5; // configurable-ok
const MAX_FACTS_PER_SESSION = 20; // configurable-ok
const CONFIDENCE_THRESHOLD = 0.7; // configurable-ok
const DEFAULT_MAX_LLM_CALLS = 12; // configurable-ok — per-session LLM call budget

/** Trivial acknowledgements (EN/KR) that carry no extractable signal. */
const TRIVIAL_USER_PATTERN = /^(ok(ay)?|yes|no|y|n|thanks?|thank you|good|nice|great|done|go|proceed|continue|응|넵?|네|예|아니오?|ㅇㅇ|ㅇㅋ|ㄱㄱ|좋아요?|그래|고마워요?|감사(합니다|해요)?|해줘|진행해?줘?|계속(해줘)?)[.!~\s]*$/i;

/**
 * Whether an exchange is worth sending to the extraction LLM.
 * Filters harness artifacts (local command output), bare slash commands,
 * and trivial acknowledgements — they waste LLM calls and produce noise facts.
 */
export function isSubstantiveExchange(userMessage: string, assistantMessage: string): boolean {
  const user = (userMessage ?? '').trim();
  const assistant = (assistantMessage ?? '').trim();

  if (!user) return false;
  // Harness/system artifacts injected as user turns, not human input
  if (
    user.startsWith('<local-command-stdout>') ||
    user.startsWith('<local-command-caveat>') ||
    user.startsWith('<command-name>') ||
    user.startsWith('Caveat:')
  ) return false;
  // Bare slash commands like /clear, /model, /codex:review
  if (/^\/[\w:-]+$/.test(user)) return false;
  // Trivial acknowledgement with no substantive reply
  if (TRIVIAL_USER_PATTERN.test(user) && assistant.length < 200) return false;
  // Near-empty prompt with a near-empty answer
  if (user.length < 5 && assistant.length < 80) return false;
  return true;
}

/** Normalize fact text for cross-batch duplicate detection within a session. */
export function normalizeFactText(fact: string): string {
  return fact.toLowerCase().replace(/\s+/g, ' ').replace(/[.!。]+$/g, '').trim();
}

/**
 * Confidence gate for extracted facts. Rejects missing/NaN confidence —
 * `undefined < 0.7` is false, so a naive `<` check would accept unscored
 * facts from malformed LLM output.
 */
export function passesConfidenceGate(confidence: unknown): boolean {
  return typeof confidence === 'number'
    && !Number.isNaN(confidence)
    && confidence >= CONFIDENCE_THRESHOLD;
}

/**
 * Cap LLM calls for long sessions by picking evenly spread batches, so the
 * beginning, middle, and end of a session are all represented instead of
 * only the head.
 */
export function selectSpreadBatches<T>(batches: T[], maxBatches: number): T[] {
  if (batches.length <= maxBatches) return batches;
  if (maxBatches <= 1) return [batches[0]];
  const selected: T[] = [];
  const step = (batches.length - 1) / (maxBatches - 1);
  const used = new Set<number>();
  for (let i = 0; i < maxBatches; i++) {
    const idx = Math.round(i * step);
    if (!used.has(idx)) {
      used.add(idx);
      selected.push(batches[idx]);
    }
  }
  return selected;
}

function maxLlmCallsPerSession(): number {
  const parsed = parseInt(process.env.MEMORY_BANK_MAX_EXTRACT_CALLS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LLM_CALLS;
}

// Self-referential repos whose conversations must NOT be extracted (e.g.
// memory-bank's own monitoring/cron sessions — extracting them creates noise
// facts and an endless feedback loop). Comma-separated cwd paths, env-overridable.
const EXCLUDE_PROJECTS = (
  process.env.BACKFILL_EXCLUDE_PROJECTS ||
  '/Users/jung-wankim/Project/Claude/memory-bank'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isExcludedProject(project: string | null | undefined): boolean {
  if (!project) return false;
  return EXCLUDE_PROJECTS.some((p) => project === p || project.startsWith(p));
}

export function buildExtractionPrompt(
  exchanges: Array<{ user_message: string; assistant_message: string }>,
): string {
  return exchanges.map((ex, i) => {
    const userSnippet = ex.user_message.slice(0, 1000);
    const assistantSnippet = ex.assistant_message.slice(0, 1000);
    return `### Exchange ${i + 1}\nUser: ${userSnippet}\nAssistant: ${assistantSnippet}`;
  }).join('\n\n');
}

/**
 * @param stats 선택적 out-param. deterministic 실패로 **폐기된 배치 수**를 돌려준다
 *   (dead-letter 회계). 선택적이라 기존 호출자는 그대로 동작한다.
 */
export async function extractFactsFromExchanges(
  db: Database.Database,
  sessionId: string,
  stats?: { droppedBatches: number },
): Promise<ExtractedFact[]> {
  const exchanges = db.prepare(`
    SELECT id, user_message, assistant_message
    FROM exchanges
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId) as Array<{ id: string; user_message: string; assistant_message: string }>;

  const substantive = exchanges.filter(
    ex => isSubstantiveExchange(ex.user_message, ex.assistant_message),
  );
  if (substantive.length === 0) return [];

  const batches: Array<typeof substantive> = [];
  for (let i = 0; i < substantive.length; i += BATCH_SIZE) {
    batches.push(substantive.slice(i, i + BATCH_SIZE));
  }
  const selectedBatches = selectSpreadBatches(batches, maxLlmCallsPerSession());

  const allFacts: ExtractedFact[] = [];
  const seen = new Set<string>();
  // transient(공급자 장애·빈 응답)로 실패한 배치. >0 이면 이 세션은 "처리 완료"가 아니다.
  const transientFailures: unknown[] = [];

  for (let b = 0; b < selectedBatches.length; b++) {
    if (allFacts.length >= MAX_FACTS_PER_SESSION) break;

    const prompt = buildExtractionPrompt(selectedBatches[b]);

    try {
      const response = await callHaiku(EXTRACTION_SYSTEM_PROMPT, prompt);
      const extracted = parseJsonResponse<ExtractedFact[]>(response);

      if (extracted && Array.isArray(extracted)) {
        for (const fact of extracted) {
          if (typeof fact?.fact !== 'string' || fact.fact.trim() === '') continue;
          if (!passesConfidenceGate(fact.confidence)) continue;
          if (allFacts.length >= MAX_FACTS_PER_SESSION) break;

          const key = normalizeFactText(fact.fact);
          if (seen.has(key)) continue; // cross-batch duplicate within this session
          seen.add(key);
          allFacts.push(fact);
        }
      }
    } catch (error) {
      // 실패를 3분류한다 — 예전에는 전부 삼켜서, 공급자 장애로 한 건도 못 뽑은
      // 세션이 extraction_log 에 '완료(0건)'로 기록되고 pending 쿼리에서 영구 제외됐다
      // (그 대화의 fact 는 영원히 추출되지 않음 = 데이터 손실).
      //
      // 🚨 추출 경로는 consolidation 과 위험이 비대칭이라 'unknown' 처리가 다르다:
      // consolidation 에서 건너뛴 fact 는 살아 있고 검색되지만(중복제거만 미실행),
      // 추출에서 건너뛴 배치는 **fact 가 애초에 만들어지지 않는다** — 되돌릴 수 없다.
      // 그래서 인식 못 한 에러(unknown)는 '이 요청 잘못'으로 단정하지 않고 transient
      // 와 같이 이연한다(다음 run 재시도). 무한 재시도 위험은 callHaiku 가 이미 유한
      // 재시도로 흡수했고, 워커가 이연 건수를 로그로 표면화한다.
      // (Codex 적대 리뷰 2026-07-17: 'API Error: 500 …' 이 unknown 으로 떨어져
      //  배치 폐기 → 세션 완료 기록 = 원 결함 재현. 분류기 보강 + 이 이연이 이중 방어.)
      const cls = classifyLlmError(error);
      if (cls === 'deterministic') {
        // 요청 자체가 잘못됨(400/413/max_tokens): 같은 입력은 같은 결과이므로 이
        // 배치만 포기하고 진행한다 — 여기서 이연하면 세션이 큐를 영구히 막는다.
        // 단 폐기를 **기록**한다(dead-letter): 조용히 버리면 그 교환들의 fact 가
        // 사라진 사실 자체가 보이지 않는다 (Codex 리뷰 2026-07-17).
        if (stats) stats.droppedBatches += 1;
        console.error(`Batch ${b} extraction failed (deterministic — batch dropped, recorded):`, error);
      } else {
        transientFailures.push(error);
        console.error(`Batch ${b} extraction failed (${cls} — session deferred, will retry):`, error);
      }
    }
  }

  // 공급자 장애가 하나라도 있었으면 이 세션을 완료로 기록하면 안 된다. 호출자
  // (extractAndSaveFacts)가 extraction_log 기록을 건너뛰도록 throw 로 표면화한다.
  if (transientFailures.length > 0) {
    throw new LlmCallError(transientFailures[0]);
  }

  return allFacts;
}

export async function saveExtractedFacts(
  db: Database.Database,
  facts: ExtractedFact[],
  project: string,
  sourceExchangeIds: string[],
  codingAgent?: string,
): Promise<string[]> {
  await initEmbeddings();
  const savedIds: string[] = [];

  for (const fact of facts) {
    const embedding = await generateEmbedding(fact.fact);
    const embeddingKr = fact.fact_kr ? await generateEmbedding(fact.fact_kr) : null;

    const id = insertFact(db, {
      fact: fact.fact,
      category: fact.category,
      scope_type: fact.scope_type,
      scope_project: fact.scope_type === 'project' ? project : null,
      source_exchange_ids: sourceExchangeIds,
      embedding,
      coding_agent: codingAgent,
      fact_kr: fact.fact_kr ?? null,
      embedding_kr: embeddingKr,
    });

    savedIds.push(id);

    // Ontology classification + relation detection (must await to prevent DB close race)
    try {
      await classifyAndLinkFact(db, id, embedding);
    } catch (err) {
      console.error(`Ontology pipeline failed for fact ${id}:`, err);
    }
  }

  return savedIds;
}

export async function runFactExtraction(
  db: Database.Database,
  sessionId: string,
  project: string,
  codingAgent?: string,
): Promise<{ extracted: number; saved: number }> {
  // Skip self-referential repos (memory-bank's own monitoring sessions) — mark
  // as processed with zero facts so they are never re-attempted, no LLM calls.
  if (isExcludedProject(project)) {
    try {
      db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0
      `).run(sessionId, new Date().toISOString());
    } catch { /* log table may not exist on very old DBs */ }
    return { extracted: 0, saved: 0 };
  }

  const stats = { droppedBatches: 0 };
  const facts = await extractFactsFromExchanges(db, sessionId, stats);

  let saved = 0;
  if (facts.length > 0) {
    // Detect coding agent from session's exchanges if not provided
    const agent = codingAgent || detectAgentFromSession(db, sessionId);

    const exchangeIds = (db.prepare(
      'SELECT id FROM exchanges WHERE session_id = ?'
    ).all(sessionId) as Array<{ id: string }>).map(r => r.id);

    saved = (await saveExtractedFacts(db, facts, project, exchangeIds, agent)).length;
  }

  // Record the session as processed (idempotency marker shared by the
  // SessionEnd hook and the cross-project backfill worker).
  try {
    // 🚨 dropped_batches 컬럼은 마이그레이션이 락 경합으로 지연될 수 있다(db.ts).
    // 그때 5-컬럼 INSERT 는 'no such column' 으로 실패하고, 아래 catch 가 삼키면
    // **마커가 아예 안 써진다** → 세션이 영구 pending → 매 run 재추출 → facts.id 가
    // randomUUID 이고 내용 UNIQUE 가 없어 **중복 fact 가 누적**된다(Codex R5 HIGH-1).
    // 마커 기록(멱등성)이 dead-letter 카운터보다 우선이므로, 컬럼이 없으면 4-컬럼으로
    // 폴백해 마커는 반드시 남기고 카운터 누락만 크게 표면화한다.
    const hasDropped = (db.prepare(`SELECT name FROM pragma_table_info('extraction_log')`)
      .all() as Array<{ name: string }>).some(c => c.name === 'dropped_batches');
    if (hasDropped) {
      db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved, dropped_batches)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = excluded.extracted, saved = excluded.saved,
          dropped_batches = excluded.dropped_batches
      `).run(sessionId, new Date().toISOString(), facts.length, saved, stats.droppedBatches);
    } else {
      db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = excluded.extracted, saved = excluded.saved
      `).run(sessionId, new Date().toISOString(), facts.length, saved);
      if (stats.droppedBatches > 0) {
        console.error(
          `extraction: session ${sessionId} — dropped_batches 컬럼 부재로 폐기 카운터 ` +
          `${stats.droppedBatches}건을 기록하지 못했습니다(마이그레이션 지연). 마커는 기록됨.`,
        );
      }
    }
    if (stats.droppedBatches > 0 && hasDropped) {
      // 조용히 넘어가지 않는다 — 폐기가 있었다는 사실을 로그로도 표면화(fail-loud).
      console.error(
        `extraction: session ${sessionId} completed with ${stats.droppedBatches} dropped batch(es) ` +
        `(deterministic LLM failures — those exchanges produced no facts; ` +
        `query: SELECT session_id, dropped_batches FROM extraction_log WHERE dropped_batches > 0)`,
      );
    }
  } catch (e) {
    // 아주 오래된 DB 는 log 테이블 자체가 없을 수 있다 — 추출 결과는 유효하다.
    // 단 조용히 넘기지 않는다: 마커 미기록 = 다음 run 재추출(중복 fact 위험)이므로
    // 원인을 표면화해야 진단이 가능하다(fail-loud).
    console.error(
      `extraction: session ${sessionId} 마커 기록 실패 — 다음 run 에서 재추출될 수 있습니다: ` +
      `${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { extracted: facts.length, saved };
}

/**
 * Detect the coding agent from a session's exchanges.
 * Returns the coding_agent of the first exchange in the session, or 'claude-code' as default.
 */
function detectAgentFromSession(db: Database.Database, sessionId: string): string {
  const row = db.prepare(
    'SELECT coding_agent FROM exchanges WHERE session_id = ? LIMIT 1'
  ).get(sessionId) as { coding_agent: string | null } | undefined;
  return row?.coding_agent || 'claude-code';
}
