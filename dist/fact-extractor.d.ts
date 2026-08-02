import Database from 'better-sqlite3';
import type { ExtractedFact } from './types.js';
export declare const EXTRACTION_SYSTEM_PROMPT = "You are an expert at extracting long-term facts from conversations.\n\n## Rules\n- 1 fact = 1 sentence (concise)\n- Ignore trivial exchanges (greetings, \"yes\", \"thanks\")\n- Code snippets are NOT facts - extract only decisions/patterns\n- No duplicate facts within the same batch\n- Prefer durable facts (decisions, conventions, constraints, lessons) over\n  session-ephemeral details (\"user is currently editing file X\" is NOT a fact)\n- Capture problem\u2192solution lessons as \"pattern\"\n  (e.g., \"X error in this project is caused by Y and fixed by Z\")\n\n## scope determination\n- project: specific files/paths/DB/API/framework/business logic\n- global: coding style, language/response format, common tool usage\n\n## Output format (JSON array)\n[\n  {\n    \"fact\": \"User uses Riverpod for state management\",\n    \"fact_kr\": \"\uC0AC\uC6A9\uC790\uB294 \uC0C1\uD0DC \uAD00\uB9AC\uC5D0 Riverpod\uC744 \uC0AC\uC6A9\uD55C\uB2E4\",\n    \"category\": \"decision\",\n    \"scope_type\": \"project\",\n    \"confidence\": 0.9\n  }\n]\n\n## fact_kr rules\n- Natural Korean translation of \"fact\"\n- Keep technical terms (API/tool/framework names, file paths, commands) in English\n\n## category choices\n- decision: architecture/technology decisions\n- preference: user preferences\n- pattern: repeated patterns\n- knowledge: project knowledge\n- constraint: constraints\n\n## confidence criteria\n- 0.9+: explicit decision/declaration\n- 0.7-0.9: inferred from behavior\n- Below 0.7: do not extract";
/** 선점(claim)을 잃어 작업을 중단할 때 던진다. 호출자는 이것을 실패가 아니라
 *  "다른 러너가 이 세션을 가져갔다"로 읽어야 한다 — 예산을 소모하지 않는다. */
export declare class ClaimLostError extends Error {
    constructor(message: string);
}
/**
 * Whether an exchange is worth sending to the extraction LLM.
 * Filters harness artifacts (local command output), bare slash commands,
 * and trivial acknowledgements — they waste LLM calls and produce noise facts.
 */
export declare function isSubstantiveExchange(userMessage: string, assistantMessage: string): boolean;
/** Normalize fact text for cross-batch duplicate detection within a session. */
export declare function normalizeFactText(fact: string): string;
/**
 * Confidence gate for extracted facts. Rejects missing/NaN confidence —
 * `undefined < 0.7` is false, so a naive `<` check would accept unscored
 * facts from malformed LLM output.
 */
export declare function passesConfidenceGate(confidence: unknown): boolean;
/**
 * Cap LLM calls for long sessions by picking evenly spread batches, so the
 * beginning, middle, and end of a session are all represented instead of
 * only the head.
 */
export declare function selectSpreadBatches<T>(batches: T[], maxBatches: number): T[];
export declare function buildExtractionPrompt(exchanges: Array<{
    user_message: string;
    assistant_message: string;
}>): string;
/**
 * @param stats 선택적 out-param. deterministic 실패로 **폐기된 배치 수**를 돌려준다
 *   (dead-letter 회계). 선택적이라 기존 호출자는 그대로 동작한다.
 */
export declare function extractFactsFromExchanges(db: Database.Database, sessionId: string, stats?: {
    droppedBatches: number;
}, 
/**
 * 배치마다 호출되는 리스 갱신 훅. 리스보다 오래 걸리는 정상 추출이 회수 대상이
 * 되어 다른 워커가 선점하는 것을 막는다(R7 HIGH-1). throw 하면 즉시 중단한다 —
 * 이미 claim 을 잃었다는 뜻이므로 계속하면 중복 작업이다.
 */
renewLease?: () => void): Promise<ExtractedFact[]>;
export declare function saveExtractedFacts(db: Database.Database, facts: ExtractedFact[], project: string, sourceExchangeIds: string[], codingAgent?: string, 
/**
 * 🚨 저장 구간은 파이프라인에서 **가장 긴** 단계다 — fact 당 임베딩 2회 +
 * classifyAndLinkFact(내부에서 callHaiku = 헤드리스 세션 1회)를 최대 20 fact 반복.
 * 여기가 리스 밖이면 정상 작업이 회수돼 다른 워커가 같은 세션을 저장한다
 * (Codex R8 HIGH: R7 HIGH-1 의 잔존 구간). fact 마다 갱신·소유권 확인한다.
 */
renewLease?: () => void, 
/**
 * 🚨 완료 마커를 **fact 삽입과 같은 트랜잭션 안에서** 쓰기 위한 커밋 훅.
 * 갱신 행 수를 반환하며 0 이면(=선점을 잃음) 트랜잭션 전체가 롤백된다.
 *
 * 체크포인트(리스 확인)를 아무리 촘촘히 박아도 **마지막 확인과 커밋 사이**에는
 * 항상 창이 남는다 — R7(배치)→R8(저장 루프)→R9(루프 꼬리)로 같은 결함이 세 번
 * 좁아지기만 했다. 원인은 "저장"과 "소유권 확정"이 서로 다른 시점이라는 구조다.
 * 둘을 원자적으로 묶으면 창의 크기와 무관하게 닫힌다: 커밋 순간 소유권이 없으면
 * fact 도 남지 않으므로 중복이 생길 수 없다.
 */
commitMarker?: (extracted: number, saved: number) => number): Promise<string[]>;
/**
 * 추출 실패의 **소비자측 3분류**. 두 워커(SessionEnd 훅·backfill)가 같은 표현식을
 * 각자 인라인으로 들고 있으면 한쪽만 갱신돼 드리프트한다(R6 에서 마커 SQL 로 겪은 것과
 * 같은 계열). 분류 규칙을 여기 한 곳에 두고 소비자는 호출만 한다.
 *
 *  - 'handoff'  : 다른 러너가 인수함. 실패가 아니다 — 경보로 세지 말 것.
 *  - 'provider' : 공급자 장애/빈응답. 예산 미소모, 다음 run 재시도.
 *  - 'internal' : 런타임·DB·파서. 재시도 예산을 소모한다 — 운영 점검 대상.
 */
export declare function classifyExtractionFailure(err: unknown): 'handoff' | 'provider' | 'internal';
export declare function runFactExtraction(db: Database.Database, sessionId: string, project: string, codingAgent?: string, 
/**
 * claimVariant: 선점 조건. 'hook'(기본)은 살아있는 claim 만 존중하고 확정 마커
 * 위에서도 선점한다(--resume 세션 재추출은 의도된 동작). 'worker'는 자기가
 * pending 으로 선정했던 상태(미기록 / -4 / 리스만료 claim)일 때만 선점한다 —
 * 선정 후 훅이 먼저 확정했다면 그 위를 덮지 않아 중복 추출이 생기지 않는다.
 * 선점·복원을 이 함수가 단독으로 소유하므로 호출자 간 로직 분기가 없다.
 */
opts?: {
    claimVariant?: 'worker' | 'hook';
}): Promise<{
    extracted: number;
    saved: number;
}>;
