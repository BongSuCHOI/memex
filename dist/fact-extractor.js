import { callMemoryModel, parseJsonResponse } from "./llm.js";
import { classifyLlmError, LlmCallError } from "./llm-error-class.js";
import { insertFact } from "./fact-db.js";
import { generateEmbedding, initEmbeddings } from "./embeddings.js";
import { isLlmWorkdirPath } from "./paths.js";
import { classifyAndLinkFact } from "./ontology-classifier.js";
import { randomUUID } from "node:crypto";
import { claimSessionSql, renewClaimSql, failureMarkerUpsertSql, freshClaimPredicate, getExtractionConfig, EXTRACTION_STATE, MAX_INTERNAL_RETRIES, } from "./pending-extraction.js";
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
- Treat only content present in the evidence block as evidence. Never reconstruct
  or infer a decision from content marked as excluded Memex recall output.
- Human assertions and explicitly labeled trusted tool evidence are primary
  evidence. Assistant synthesis and Memex recall are context only and must not
  support, reinforce, contradict, or raise confidence for a fact.
- Every fact must cite the non-empty, 1-based source_exchange_indices of the
  exchanges that directly support it. Do not cite an exchange only because it
  appeared in the same batch.

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
    "confidence": 0.9,
    "source_exchange_indices": [1]
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
/** 선점(claim)을 잃어 작업을 중단할 때 던진다. 호출자는 이것을 실패가 아니라
 *  "다른 러너가 이 세션을 가져갔다"로 읽어야 한다 — 예산을 소모하지 않는다. */
export class ClaimLostError extends Error {
    constructor(message) {
        super(message);
        this.name = "ClaimLostError";
    }
}
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
export function isSubstantiveExchange(userMessage, assistantMessage, hasLearnableToolEvidence = false) {
    const user = (userMessage ?? "").trim();
    const assistant = (assistantMessage ?? "").trim();
    if (!user)
        return false;
    // Harness/system artifacts injected as user turns, not human input
    if (user.startsWith("<local-command-stdout>") ||
        user.startsWith("<local-command-caveat>") ||
        user.startsWith("<command-name>") ||
        user.startsWith("Caveat:"))
        return false;
    // Bare slash commands like /clear, /model, /codex:review
    if (/^\/[\w:-]+$/.test(user))
        return false;
    // Trivial acknowledgement with no substantive reply
    if (TRIVIAL_USER_PATTERN.test(user) && !hasLearnableToolEvidence)
        return false;
    // Near-empty prompt with a near-empty answer
    if (user.length < 5 && !hasLearnableToolEvidence)
        return false;
    return true;
}
/** Normalize fact text for cross-batch duplicate detection within a session. */
export function normalizeFactText(fact) {
    return fact
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[.!。]+$/g, "")
        .trim();
}
/**
 * Confidence gate for extracted facts. Rejects missing/NaN confidence —
 * `undefined < 0.7` is false, so a naive `<` check would accept unscored
 * facts from malformed LLM output.
 */
export function passesConfidenceGate(confidence) {
    return (typeof confidence === "number" &&
        !Number.isNaN(confidence) &&
        confidence >= CONFIDENCE_THRESHOLD);
}
/**
 * Cap LLM calls for long sessions by picking evenly spread batches, so the
 * beginning, middle, and end of a session are all represented instead of
 * only the head.
 */
export function selectSpreadBatches(batches, maxBatches) {
    if (batches.length <= maxBatches)
        return batches;
    if (maxBatches <= 1)
        return [batches[0]];
    const selected = [];
    const step = (batches.length - 1) / (maxBatches - 1);
    const used = new Set();
    for (let i = 0; i < maxBatches; i++) {
        const idx = Math.round(i * step);
        if (!used.has(idx)) {
            used.add(idx);
            selected.push(batches[idx]);
        }
    }
    return selected;
}
function maxLlmCallsPerSession() {
    const parsed = parseInt(process.env.MEMEX_MAX_EXTRACT_CALLS || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LLM_CALLS;
}
// Self-referential repos whose conversations must NOT be extracted (e.g.
// Memex's own monitoring/cron sessions — extracting them creates noise
// facts and an endless feedback loop). Comma-separated cwd paths, env-overridable.
// 🚨 제외 목록은 **단일 소스**(getExtractionConfig)에서 온다. 여기서 따로 파싱하면
// pending SQL 필터와 이 판정이 갈라져, 제외 대상이 선정된 뒤에야 걸러지거나(슬롯 낭비)
// 정규화가 한쪽에만 적용된다(R22 MEDIUM — 후행 슬래시 수정이 이쪽에만 들어갔었다).
// 파일 헤더가 명시한 "두 소비자는 동일 술어" 계약이 그것이다.
function isExcludedProject(project) {
    if (!project)
        return false;
    // Reserved LLM worker workdir (basename or mkdtemp `memex-llm-XXXXXX`
    // suffix form) is excluded regardless of the env list — the SessionEnd hook
    // path reaches runFactExtraction without passing the pending SQL gate, so
    // this is the only cwd guard on that entry point.
    if (isLlmWorkdirPath(project))
        return true;
    const EXCLUDE_PROJECTS = getExtractionConfig().excludeProjects;
    // 🚨 경로 **경계**로 비교한다. raw prefix 면 형제 프로젝트가 함께 배제된다 —
    // A raw prefix such as '/…/memex' can swallow a distinct sibling project,
    // 영구 0/0 마커를 받고 fact 가 영원히 추출되지 않았다(실측: 적격 8세션 전건 손실).
    // pending SQL 필터는 exact 매칭이라 선정은 되고 여기서만 걸러져 무음이었다.
    return EXCLUDE_PROJECTS.some((p) => project === p || project.startsWith(`${p}/`));
}
export function buildExtractionPrompt(exchanges) {
    return exchanges
        .map((ex, i) => {
        const userSnippet = ex.user_message.slice(0, 1000);
        const trustedTools = (ex.tool_evidence ?? [])
            .filter((tool) => tool.learnable === 1 || tool.learnable === true)
            .filter((tool) => tool.source_type !== "memex_recall" && tool.tool_result)
            .map((tool) => `${tool.source_type}/${tool.tool_name}: ${String(tool.tool_result).slice(0, 1000)}`);
        const toolBlock = trustedTools.length > 0
            ? `\nTrusted tool evidence:\n${trustedTools.join("\n")}`
            : "";
        return `### Exchange ${i + 1}\nHuman assertion: ${userSnippet}${toolBlock}\nAssistant: [assistant synthesis excluded from learnable evidence]`;
    })
        .join("\n\n");
}
/** Validate model-provided 1-based indices and resolve them to real exchange UUIDs. */
function resolveSourceExchangeIds(sourceExchangeIndices, exchanges) {
    if (!Array.isArray(sourceExchangeIndices) || sourceExchangeIndices.length === 0) {
        return null;
    }
    const resolved = new Set();
    for (const index of sourceExchangeIndices) {
        if (typeof index !== "number" ||
            !Number.isInteger(index) ||
            index < 1 ||
            index > exchanges.length) {
            return null;
        }
        resolved.add(exchanges[index - 1].id);
    }
    return [...resolved];
}
/** Extract facts, optionally renewing a claim and processing rows after a watermark. */
export async function extractFactsFromExchanges(db, sessionId, stats, renewLease, options) {
    const exchanges = db
        .prepare(`
    SELECT id, user_message, assistant_message, assistant_learnable, has_memex_recall
    FROM exchanges
    WHERE session_id = ?
      ${options?.onlyAfterRowid != null ? "AND rowid > ?" : ""}
    ORDER BY timestamp ASC
  `)
        .all(...(options?.onlyAfterRowid != null
        ? [sessionId, options.onlyAfterRowid]
        : [sessionId]));
    const selectToolEvidence = db.prepare(`
    SELECT tool_name, tool_result, source_type, learnable
    FROM tool_calls WHERE exchange_id = ? ORDER BY timestamp, id
  `);
    for (const exchange of exchanges) {
        exchange.tool_evidence = selectToolEvidence.all(exchange.id);
    }
    const substantive = exchanges.filter((ex) => isSubstantiveExchange(ex.user_message, "", ex.tool_evidence?.some((tool) => tool.learnable === 1 && !!tool.tool_result) ?? false));
    if (substantive.length === 0)
        return [];
    const batches = [];
    for (let i = 0; i < substantive.length; i += BATCH_SIZE) {
        batches.push(substantive.slice(i, i + BATCH_SIZE));
    }
    const selectedBatches = selectSpreadBatches(batches, maxLlmCallsPerSession());
    const allFacts = [];
    const factIndexByKey = new Map();
    // transient(공급자 장애·빈 응답)로 실패한 배치. >0 이면 이 세션은 "처리 완료"가 아니다.
    const transientFailures = [];
    for (let b = 0; b < selectedBatches.length; b++) {
        if (allFacts.length >= MAX_FACTS_PER_SESSION)
            break;
        const batch = selectedBatches[b];
        const prompt = buildExtractionPrompt(batch);
        renewLease?.(); // 배치 직전 갱신 — LLM 왕복이 리스를 넘겨도 회수되지 않는다
        try {
            const response = await callMemoryModel(EXTRACTION_SYSTEM_PROMPT, prompt);
            const extracted = parseJsonResponse(response);
            if (extracted && Array.isArray(extracted)) {
                for (const fact of extracted) {
                    if (typeof fact?.fact !== "string" || fact.fact.trim() === "")
                        continue;
                    if (!passesConfidenceGate(fact.confidence))
                        continue;
                    const sourceExchangeIds = resolveSourceExchangeIds(fact.source_exchange_indices, batch);
                    if (!sourceExchangeIds)
                        continue;
                    const key = normalizeFactText(fact.fact);
                    const existingIndex = factIndexByKey.get(key);
                    if (existingIndex !== undefined) {
                        allFacts[existingIndex].source_exchange_ids = [
                            ...new Set([
                                ...(allFacts[existingIndex].source_exchange_ids ?? []),
                                ...sourceExchangeIds,
                            ]),
                        ];
                        continue;
                    }
                    if (allFacts.length >= MAX_FACTS_PER_SESSION)
                        break;
                    factIndexByKey.set(key, allFacts.length);
                    allFacts.push({
                        fact: fact.fact,
                        fact_kr: fact.fact_kr,
                        category: fact.category,
                        scope_type: fact.scope_type,
                        confidence: fact.confidence,
                        source_exchange_ids: sourceExchangeIds,
                    });
                }
            }
        }
        catch (error) {
            // 실패를 3분류한다 — 예전에는 전부 삼켜서, 공급자 장애로 한 건도 못 뽑은
            // 세션이 extraction_log 에 '완료(0건)'로 기록되고 pending 쿼리에서 영구 제외됐다
            // (그 대화의 fact 는 영원히 추출되지 않음 = 데이터 손실).
            //
            // 🚨 추출 경로는 consolidation 과 위험이 비대칭이라 'unknown' 처리가 다르다:
            // consolidation 에서 건너뛴 fact 는 살아 있고 검색되지만(중복제거만 미실행),
            // 추출에서 건너뛴 배치는 **fact 가 애초에 만들어지지 않는다** — 되돌릴 수 없다.
            // 그래서 인식 못 한 에러(unknown)는 '이 요청 잘못'으로 단정하지 않고 transient
            // 와 같이 이연한다(다음 run 재시도). 무한 재시도 위험은 callMemoryModel 가 이미 유한
            // 재시도로 흡수했고, 워커가 이연 건수를 로그로 표면화한다.
            // (Codex 적대 리뷰 2026-07-17: 'API Error: 500 …' 이 unknown 으로 떨어져
            //  배치 폐기 → 세션 완료 기록 = 원 결함 재현. 분류기 보강 + 이 이연이 이중 방어.)
            const cls = classifyLlmError(error);
            if (cls === "deterministic") {
                // 요청 자체가 잘못됨(400/413/max_tokens): 같은 입력은 같은 결과이므로 이
                // 배치만 포기하고 진행한다 — 여기서 이연하면 세션이 큐를 영구히 막는다.
                // 단 폐기를 **기록**한다(dead-letter): 조용히 버리면 그 교환들의 fact 가
                // 사라진 사실 자체가 보이지 않는다 (Codex 리뷰 2026-07-17).
                if (stats)
                    stats.droppedBatches += 1;
                console.error(`Batch ${b} extraction failed (deterministic — batch dropped, recorded):`, error);
            }
            else {
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
/** Save facts and the completion marker in one transaction. */
export async function saveExtractedFacts(db, facts, project, sourceExchangeIds, renewLease, commitMarker) {
    await initEmbeddings();
    // 1단계(비동기): 임베딩만 먼저 계산한다 — 트랜잭션은 동기여야 하므로.
    const prepared = [];
    for (const fact of facts) {
        renewLease?.(); // 잃었으면 여기서 중단 — 비싼 임베딩을 더 돌리지 않는다
        prepared.push({
            fact,
            embedding: await generateEmbedding(fact.fact),
            embeddingKr: fact.fact_kr ? await generateEmbedding(fact.fact_kr) : null,
        });
    }
    // 2단계(동기·원자적): fact 삽입 + 완료 마커를 한 트랜잭션으로. 마커가 0행이면
    // 선점을 잃은 것이므로 throw → 삽입까지 통째로 롤백된다(부분 저장 잔존 없음).
    const savedIds = [];
    const commit = db.transaction(() => {
        for (const p of prepared) {
            savedIds.push(insertFact(db, {
                fact: p.fact.fact,
                category: p.fact.category,
                scope_type: p.fact.scope_type,
                scope_project: p.fact.scope_type === "project" ? project : null,
                source_exchange_ids: p.fact.source_exchange_ids ?? sourceExchangeIds,
                embedding: p.embedding,
                fact_kr: p.fact.fact_kr ?? null,
                embedding_kr: p.embeddingKr,
            }));
        }
        if (commitMarker && commitMarker(facts.length, savedIds.length) === 0) {
            throw new ClaimLostError("완료 마커가 0행 — 저장 중 선점을 잃었습니다. fact 삽입을 롤백합니다(중복 방지).");
        }
    });
    try {
        commit();
    }
    catch (e) {
        savedIds.length = 0; // 롤백됐으므로 호출자에게 저장 0건으로 보고
        throw e;
    }
    // 3단계(비동기, 커밋 이후): 온톨로지 분류. 파생 작업이라 실패해도 fact 는 유효하다.
    for (let i = 0; i < savedIds.length; i++) {
        try {
            await classifyAndLinkFact(db, savedIds[i], prepared[i].embedding);
        }
        catch (err) {
            console.error(`Ontology pipeline failed for fact ${savedIds[i]}:`, err);
        }
    }
    return savedIds;
}
export function classifyExtractionFailure(err) {
    if (err instanceof ClaimLostError)
        return "handoff";
    if (err instanceof LlmCallError) {
        return classifyLlmError(err) === "deterministic"
            ? "provider_deterministic"
            : "provider_transient";
    }
    return "internal";
}
/**
 * 소비자 보고·집계 표 — 라벨·문구뿐 아니라 **카운터 버킷과 예산 소모 여부까지** 여기서
 * 나온다. 워커가 자체 분기를 들면 "예산 판정과 카운터가 반대로 붙는" 실수를 테스트가
 * 잡지 못한다(문자열 검사는 워커가 결과를 무시해도 통과) — 분기 자체를 없앤다.
 *
 * `escalate`: 운영자가 손을 대야 하는 실패인가. R12 수정 과정에서 요약줄의
 * "INTERNAL failures — 런타임/DB 점검 필요" 경보가 일반 예산 회계로 대체돼 사라졌던
 * 것을 이 플래그로 복원한다(Codex R13 MEDIUM — 내가 만든 회귀).
 */
export const FAILURE_REPORT = {
    handoff: {
        label: "HANDOFF",
        note: "다른 러너가 인수 — 실패 아님",
        bucket: "handoff",
        consumesBudget: false,
        escalate: false,
    },
    provider_transient: {
        label: "ERROR",
        note: "공급자 일시 실패 — 예산 미소모, 다음 run 재시도",
        bucket: "transient",
        consumesBudget: false,
        escalate: false,
    },
    provider_deterministic: {
        label: "ERROR",
        note: "요청 거절 — 재시도 무의미, 예산 소모(반복 시 영구 제외)",
        bucket: "budget",
        consumesBudget: true,
        escalate: false,
    },
    internal: {
        label: "ERROR",
        note: "런타임/DB 점검 필요 — 예산 소모",
        bucket: "budget",
        consumesBudget: true,
        escalate: true,
    },
};
/**
 * 이 실패가 재시도 예산을 소모하는가. runFactExtraction 의 라우팅과 워커의 보고가
 * **같은 술어**를 보게 해서 "예산은 타는데 로그는 재시도된다고 말하는" 모순을 막는다.
 */
export function failureConsumesBudget(kind) {
    // 표에서 파생 — 명시 비교로 두면 새 분류가 조용히 false 로 떨어진다(Codex R13 LOW).
    // Record 타입이라 분류를 추가하면 표가 컴파일 에러를 낸다(강제력 대칭).
    return FAILURE_REPORT[kind].consumesBudget;
}
/** Claim a session, process unhandled rows, and atomically record completion. */
export async function runFactExtraction(db, sessionId, project, opts) {
    // Skip self-referential repos (Memex's own monitoring sessions) — mark
    // as processed with zero facts so they are never re-attempted, no LLM calls.
    if (isExcludedProject(project)) {
        // 🚨 마커가 **실제로 써졌는지**를 반환값이 구분해야 한다. 삼키고 'excluded_project'
        // 를 돌려주면 호출자가 "영구 마커가 써진 정상 흐름"으로 단정해 버킷·경보 없이
        // 넘기고, INSERT 가 일시 실패한 세션은 마커 없이 매 run 슬롯만 점유한다
        // (무경보 무진전 — 이 스레드가 계속 닫아온 클래스, Codex R20 MEDIUM).
        let markerWritten = false;
        try {
            // 🚨 다른 마커 쓰기는 전부 소유권·상태 가드가 있는데(claim WHERE owned,
            // failureMarkerUpsertSql, writeCompletionMarker 의 ownGuard) **이 경로만 무가드**
            // 였다. 살아있는 claim(-3) 위에 0/0 을 덮으면 소유자는 리스갱신 실패로 중단되고,
            // 그 롤백은 extracted=-3 을 요구하므로 무효가 되어 행이 0/0 확정마커로 남는다 →
            // 세션이 pending 에서 영구 제외되고 워커는 'handoff' 로 거짓 계상한다
            // (Codex R21 HIGH, 재현됨). 처리 **중**인 세션만 건드리지 않는다 — 리스가
            // 만료된 claim 은 죽은 소유자의 것이므로 회수 대상이다. `<> CLAIMED` 로 두면
            // 만료 claim 까지 존중해 그 세션이 마커를 영원히 못 받고 매 run 재선정된다
            // (R22 HIGH, 5/5 run 진전 0). 코드베이스의 다른 모든 경로와 같은 술어를 쓴다.
            const res = db
                .prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved, last_exchange_rowid)
        VALUES (?, ?, 0, 0, (SELECT COALESCE(MAX(rowid), 0) FROM exchanges x WHERE x.session_id = ?))
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0,
          -- settled 마커의 워터마크가 뒤처지면 pending 쿼리의 watermark 분기가
          -- 다시 집는다 — 제외 마커는 세션 전체를 커버해야 한다.
          last_exchange_rowid = (SELECT COALESCE(MAX(rowid), 0) FROM exchanges x
                                 WHERE x.session_id = extraction_log.session_id)
        WHERE NOT (${freshClaimPredicate()})
      `)
                .run(sessionId, new Date().toISOString(), sessionId);
            markerWritten = res.changes > 0;
            if (!markerWritten) {
                console.error(`extraction: session ${sessionId} 제외 마커를 쓰지 않았습니다 — 다른 러너가 선점 중`);
            }
        }
        catch (e) {
            console.error(`extraction: session ${sessionId} 제외 마커 기록 실패 — 다음 run 재선정됩니다: ` +
                `${e instanceof Error ? e.message : String(e)}`);
        }
        return {
            extracted: 0,
            saved: 0,
            skipped: markerWritten ? "excluded_project" : "excluded_project_unmarked",
        };
    }
    // 🚨 동일 재실행 게이트(비용 최적화): 성공 상태 마커 + last_exchange_rowid 이후
    // 새 exchange 가 없으면 claim 도 걸지 않고 즉시 종료한다. 안전성(중복 차단)은
    // claim 성공 직후의 post-claim watermark read 가 소유한다 — 이 값은 다른 러너가
    // 방금 완료한 최신 워터마크를 반영할 수 있다(UPDATE 는 이 컬럼을 건드리지 않음).
    {
        const marker = db
            .prepare("SELECT extracted, last_exchange_rowid FROM extraction_log WHERE session_id = ?")
            .get(sessionId);
        const settled = !!marker &&
            typeof marker.extracted === "number" &&
            (marker.extracted >= 0 ||
                marker.extracted === -1 ||
                marker.extracted === -2);
        if (settled && marker) {
            const maxRow = db
                .prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM exchanges WHERE session_id = ?")
                .get(sessionId).m;
            if (maxRow <= (marker.last_exchange_rowid ?? 0)) {
                // 멱등 no-op: LLM 호출 없이 종료 — 중복 facts 도 생기지 않는다.
                return { extracted: 0, saved: 0 };
            }
        }
    }
    let onlyAfterRowid;
    // 서로를 직렬화할 수단이 없고 마커는 파이프라인 끝에 써지므로, 선점이 없으면
    // 둘이 같은 세션을 각자 추출해 fact 가 두 벌 저장된다(Codex R6 HIGH).
    // 마커 시점에 막는 것은 늦다 — 그때는 이미 비용도 중복도 발생한 뒤다.
    // 선점 이전 상태를 기억해 둔다 — 실패 시 그대로 되돌려야 재시도 카운터(saved)가
    // 보존된다. 무조건 DELETE 로 풀면 매 run 카운터가 0 으로 리셋돼 예산이 영원히
    // 소진되지 않는다(무한 재시도 = R3 기아의 다른 얼굴).
    const owner = randomUUID();
    let preClaim;
    let holdsClaim = false;
    try {
        preClaim = db
            .prepare("SELECT extracted, saved FROM extraction_log WHERE session_id = ?")
            .get(sessionId);
        const claimed = db
            .prepare(claimSessionSql(opts?.claimVariant ?? "hook"))
            .run(sessionId, new Date().toISOString(), owner).changes;
        if (claimed === 0) {
            console.error(`extraction: session ${sessionId} — 다른 라이터가 선점/확정함, 이번 실행은 건너뜁니다`);
            return { extracted: 0, saved: 0, skipped: "claim_not_acquired" };
        }
        holdsClaim = true;
        // 🚨 post-claim watermark read — race 소유 지점. 내 UPDATE 는 이 컬럼을 건드리지
        // 않으므로, gate 이후 다른 러너가 방금 기록한 최신 last_exchange_rowid 를 그대로
        // 읽는다. 이후 신규 rows 만 LLM 배치 후보가 된다.
        const claimedRow = db
            .prepare("SELECT last_exchange_rowid FROM extraction_log WHERE session_id = ?")
            .get(sessionId);
        onlyAfterRowid =
            typeof claimedRow?.last_exchange_rowid === "number" &&
                claimedRow.last_exchange_rowid > 0
                ? claimedRow.last_exchange_rowid
                : undefined;
    }
    catch (e) {
        // 🚨 fresh-schema 계약: extraction_log 는 initDatabase 가 항상 보장한다.
        // 스키마 오류를 포함한 모든 claim 실패는 예산 소모 없이 보류(claim_error)만
        // 한다 — legacy ALTER/진행 분기는 없다.
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`extraction: session ${sessionId} — claim 실패(${msg}), 이번 실행은 보류합니다`);
        return { extracted: 0, saved: 0, skipped: "claim_error" };
    }
    /**
     * 리스 갱신 겸 소유권 확인. 잃었으면 즉시 throw 해서 중단한다 —
     * 계속 진행하면 새 소유자와 중복 작업이 된다.
     */
    const renewLease = () => {
        if (!holdsClaim)
            return;
        const renewed = db
            .prepare(renewClaimSql())
            .run(new Date().toISOString(), sessionId, owner).changes;
        if (renewed === 0) {
            holdsClaim = false; // 남의 행이 되었으므로 롤백도 하지 않는다
            throw new ClaimLostError(`claim lost for session ${sessionId} (리스 회수됨) — 중복 방지를 위해 중단`);
        }
    };
    /** 내 claim 만 되돌린다 — 소유권 토큰으로 다른 러너의 claim 을 건드리지 않는다. */
    const releaseClaim = () => {
        if (!holdsClaim)
            return;
        try {
            if (preClaim) {
                db.prepare("UPDATE extraction_log SET extracted = ?, saved = ?, claim_owner = NULL " +
                    `WHERE session_id = ? AND extracted = ${EXTRACTION_STATE.CLAIMED} AND claim_owner = ?`).run(preClaim.extracted, preClaim.saved, sessionId, owner);
            }
            else {
                db.prepare(`DELETE FROM extraction_log WHERE session_id = ? AND extracted = ${EXTRACTION_STATE.CLAIMED} AND claim_owner = ?`).run(sessionId, owner);
            }
        }
        catch {
            /* best-effort release; the original extraction error is preserved */
        }
    };
    /** 내부 실패 마커(-4 예산 / 소진 시 -2). 내 claim 위에서만 쓴다. */
    const writeInternalFailureMarker = (kind = "internal") => {
        if (!holdsClaim)
            return;
        try {
            const attempts = (preClaim?.extracted === EXTRACTION_STATE.RETRIABLE_INTERNAL
                ? preClaim.saved
                : 0) + 1;
            const exhausted = attempts >= MAX_INTERNAL_RETRIES;
            db.prepare(failureMarkerUpsertSql()).run(sessionId, new Date().toISOString(), exhausted
                ? EXTRACTION_STATE.PERMANENT
                : EXTRACTION_STATE.RETRIABLE_INTERNAL, exhausted ? 0 : attempts, owner);
            console.error(`extraction: session ${sessionId} 실패 [${kind}] (attempt ${attempts}/${MAX_INTERNAL_RETRIES}` +
                `${exhausted ? " — 예산 소진, 영구 마커로 승격" : " — 다음 run 재시도"}) — ${FAILURE_REPORT[kind].note}`);
        }
        catch {
            /* best-effort */
        }
    };
    const stats = { droppedBatches: 0 };
    let facts;
    let saved = 0;
    try {
        facts = await extractFactsFromExchanges(db, sessionId, stats, renewLease, {
            onlyAfterRowid,
        });
        // 🚨 저장 **직전** 소유권을 재확인한다. 마지막 갱신 이후에 claim 을 빼앗겼다면
        // (배치가 1개뿐이면 갱신도 1회뿐이라 창이 넓다) 여기서 멈춰야 한다 — 그대로
        // 저장하면 새 소유자와 함께 fact 를 두 벌 쓰게 된다.
        renewLease();
        if (facts.length > 0) {
            saved = (await saveExtractedFacts(db, facts, project, [], renewLease, writeCompletionMarker)).length;
        }
    }
    catch (e) {
        // 실패를 분류한다 — 이 판정을 워커가 아니라 **선점 소유자**가 내려야
        // 소유권 토큰으로 안전하게 마커를 쓸 수 있다(호출자 간 로직 중복도 사라진다).
        //  · 공급자 실패(LlmCallError, transient/unknown) → claim 해제 후 rethrow.
        //    예산을 쓰지 않고 다음 run 에 즉시 재시도된다.
        //  · 내부 실패(임베딩/DB/파서) → 재시도 예산 마커(-4, 소진 시 -2) 후 rethrow.
        // 분류·라우팅을 소비자와 **같은 함수**로 판정한다(문구와 동작이 어긋나지 않게).
        const kind = classifyExtractionFailure(e);
        if (kind === "handoff") {
            // 남의 행이므로 해제할 것도 기록할 것도 없다(SQL 가드가 이미 0행이지만 계약을 코드로).
            console.error(`extraction: session ${sessionId} — 다른 러너가 인수함(claim 이양), 이번 실행 종료`);
        }
        else if (failureConsumesBudget(kind)) {
            writeInternalFailureMarker(kind); // deterministic 거절 · 내부 실패 — 예산 소모
        }
        else {
            releaseClaim(); // 공급자 일시 실패 — 예산 미소모, 즉시 재시도
        }
        throw e;
    }
    // 완료 마커 — saveExtractedFacts 의 트랜잭션 안에서 호출된다(원자적 커밋).
    // fact 가 0건이면 트랜잭션이 없으므로 여기서 직접 호출한다.
    function writeCompletionMarker(extracted, savedCount) {
        const now = new Date().toISOString();
        // 워터마크: 처리 시점의 세션 MAX(rowid). 완료 마커와 같은 문장에서 기록돼
        // 마커·워터마크가 항상 한 세트로 커밋된다.
        const watermark = db
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM exchanges WHERE session_id = ?")
            .get(sessionId).m;
        const res = db
            .prepare(`
      UPDATE extraction_log
      SET processed_at = ?, extracted = ?, saved = ?, dropped_batches = ?,
          last_exchange_rowid = ?, claim_owner = NULL
      WHERE session_id = ? AND claim_owner = ?
    `)
            .run(now, extracted, savedCount, stats.droppedBatches, watermark, sessionId, owner);
        if (stats.droppedBatches > 0 && res.changes > 0) {
            console.error(`extraction: session ${sessionId} completed with ${stats.droppedBatches} dropped batch(es) ` +
                `(deterministic LLM failures — those exchanges produced no facts; ` +
                `query: SELECT session_id, dropped_batches FROM extraction_log WHERE dropped_batches > 0)`);
        }
        return res.changes; // 0 = 소유권 상실 → 호출자가 롤백/표면화
    }
    if (facts.length === 0) {
        try {
            if (writeCompletionMarker(0, 0) === 0 && holdsClaim) {
                console.error(`extraction: session ${sessionId} 완료 마커 미기록(소유권 상실 추정) — 다음 run 재시도`);
            }
        }
        catch (e) {
            console.error(`extraction: session ${sessionId} 마커 기록 실패 — 다음 run 에서 재추출될 수 있습니다: ` +
                `${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { extracted: facts.length, saved };
}
