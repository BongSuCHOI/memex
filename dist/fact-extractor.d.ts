import Database from 'better-sqlite3';
import type { ExtractedFact } from './types.js';
export declare const EXTRACTION_SYSTEM_PROMPT = "You are an expert at extracting long-term facts from conversations.\n\n## Rules\n- 1 fact = 1 sentence (concise)\n- Ignore trivial exchanges (greetings, \"yes\", \"thanks\")\n- Code snippets are NOT facts - extract only decisions/patterns\n- No duplicate facts within the same batch\n- Prefer durable facts (decisions, conventions, constraints, lessons) over\n  session-ephemeral details (\"user is currently editing file X\" is NOT a fact)\n- Capture problem\u2192solution lessons as \"pattern\"\n  (e.g., \"X error in this project is caused by Y and fixed by Z\")\n\n## scope determination\n- project: specific files/paths/DB/API/framework/business logic\n- global: coding style, language/response format, common tool usage\n\n## Output format (JSON array)\n[\n  {\n    \"fact\": \"User uses Riverpod for state management\",\n    \"fact_kr\": \"\uC0AC\uC6A9\uC790\uB294 \uC0C1\uD0DC \uAD00\uB9AC\uC5D0 Riverpod\uC744 \uC0AC\uC6A9\uD55C\uB2E4\",\n    \"category\": \"decision\",\n    \"scope_type\": \"project\",\n    \"confidence\": 0.9\n  }\n]\n\n## fact_kr rules\n- Natural Korean translation of \"fact\"\n- Keep technical terms (API/tool/framework names, file paths, commands) in English\n\n## category choices\n- decision: architecture/technology decisions\n- preference: user preferences\n- pattern: repeated patterns\n- knowledge: project knowledge\n- constraint: constraints\n\n## confidence criteria\n- 0.9+: explicit decision/declaration\n- 0.7-0.9: inferred from behavior\n- Below 0.7: do not extract";
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
}): Promise<ExtractedFact[]>;
export declare function saveExtractedFacts(db: Database.Database, facts: ExtractedFact[], project: string, sourceExchangeIds: string[], codingAgent?: string): Promise<string[]>;
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
