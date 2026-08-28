import Database from "better-sqlite3";
import type { ExtractedFact } from "./types.js";
export declare const EXTRACTION_SYSTEM_PROMPT = "You are an expert at extracting long-term facts from conversations.\n\n## Rules\n- 1 fact = 1 sentence (concise)\n- Ignore trivial exchanges (greetings, \"yes\", \"thanks\")\n- Code snippets are NOT facts - extract only decisions/patterns\n- No duplicate facts within the same batch\n- Prefer durable facts (decisions, conventions, constraints, lessons) over\n  session-ephemeral details (\"user is currently editing file X\" is NOT a fact)\n- Capture problem\u2192solution lessons as \"pattern\"\n  (e.g., \"X error in this project is caused by Y and fixed by Z\")\n- Treat only content present in the evidence block as evidence. Never reconstruct\n  or infer a decision from content marked as excluded Memex recall output.\n- Human assertions and explicitly labeled trusted tool evidence are primary\n  evidence. Assistant synthesis and Memex recall are context only and must not\n  support, reinforce, contradict, or raise confidence for a fact.\n- Every fact must cite the non-empty, 1-based source_exchange_indices of the\n  exchanges that directly support it. Do not cite an exchange only because it\n  appeared in the same batch.\n\n## scope determination\n- project: specific files/paths/DB/API/framework/business logic\n- global: coding style, language/response format, common tool usage\n\n## Output format (JSON array)\n[\n  {\n    \"fact\": \"User uses Riverpod for state management\",\n    \"fact_kr\": \"\uC0AC\uC6A9\uC790\uB294 \uC0C1\uD0DC \uAD00\uB9AC\uC5D0 Riverpod\uC744 \uC0AC\uC6A9\uD55C\uB2E4\",\n    \"category\": \"decision\",\n    \"scope_type\": \"project\",\n    \"confidence\": 0.9,\n    \"source_exchange_indices\": [1]\n  }\n]\n\n## fact_kr rules\n- Natural Korean translation of \"fact\"\n- Keep technical terms (API/tool/framework names, file paths, commands) in English\n\n## category choices\n- decision: architecture/technology decisions\n- preference: user preferences\n- pattern: repeated patterns\n- knowledge: project knowledge\n- constraint: constraints\n\n## confidence criteria\n- 0.9+: explicit decision/declaration\n- 0.7-0.9: inferred from behavior\n- Below 0.7: do not extract";
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
export declare function isSubstantiveExchange(userMessage: string, assistantMessage: string, hasLearnableToolEvidence?: boolean): boolean;
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
    assistant_learnable?: number | boolean;
    has_memex_recall?: number | boolean;
    tool_evidence?: Array<{
        tool_name: string;
        tool_result: string | null;
        source_type: string;
        learnable: number | boolean;
    }>;
}>): string;
/** Extract facts, optionally renewing a claim and processing rows after a watermark. */
export declare function extractFactsFromExchanges(db: Database.Database, sessionId: string, stats?: {
    droppedBatches: number;
}, renewLease?: () => void, options?: {
    onlyAfterRowid?: number;
}): Promise<ExtractedFact[]>;
/** Save facts and the completion marker in one transaction. */
export declare function saveExtractedFacts(db: Database.Database, facts: ExtractedFact[], project: string, sourceExchangeIds: string[], renewLease?: () => void, commitMarker?: (extracted: number, saved: number) => number): Promise<string[]>;
/**
 * 추출 실패의 분류 — **라우팅(예산 소모 여부)과 보고(로그·카운터)가 같은 정의를 쓴다.**
 *
 * 🚨 이전에는 소비자가 3분류(handoff/provider/internal)인데 실제 이연 판정은 4분류였다:
 * deterministic 한 공급자 거절(400/413/422 · prompt-too-long)은 재시도해도 같은 결과라
 * 재시도 예산(-4, 3회 후 -2 영구제외)을 **소모하는데**, 워커는 그것을 'provider' 로 세어
 * "will retry next run" 이라 보고하고 internalFailures 도 0 이라 아무 경보가 없었다.
 * 즉 예산이 조용히 타들어가는 동안 로그는 "곧 재시도됨"이라고 말했다(Codex R12 HIGH).
 * 분류를 4분류로 맞추고 라우팅 술어까지 같은 모듈에 둬서 둘이 어긋날 수 없게 한다.
 */
export type ExtractionFailureKind = "handoff" | "provider_transient" | "provider_deterministic" | "internal";
export declare function classifyExtractionFailure(err: unknown): ExtractionFailureKind;
/**
 * 소비자 보고·집계 표 — 라벨·문구뿐 아니라 **카운터 버킷과 예산 소모 여부까지** 여기서
 * 나온다. 워커가 자체 분기를 들면 "예산 판정과 카운터가 반대로 붙는" 실수를 테스트가
 * 잡지 못한다(문자열 검사는 워커가 결과를 무시해도 통과) — 분기 자체를 없앤다.
 *
 * `escalate`: 운영자가 손을 대야 하는 실패인가. R12 수정 과정에서 요약줄의
 * "INTERNAL failures — 런타임/DB 점검 필요" 경보가 일반 예산 회계로 대체돼 사라졌던
 * 것을 이 플래그로 복원한다(Codex R13 MEDIUM — 내가 만든 회귀).
 */
export declare const FAILURE_REPORT: Record<ExtractionFailureKind, {
    label: string;
    note: string;
    bucket: "handoff" | "transient" | "budget";
    consumesBudget: boolean;
    escalate: boolean;
}>;
/**
 * 이 실패가 재시도 예산을 소모하는가. runFactExtraction 의 라우팅과 워커의 보고가
 * **같은 술어**를 보게 해서 "예산은 타는데 로그는 재시도된다고 말하는" 모순을 막는다.
 */
export declare function failureConsumesBudget(kind: ExtractionFailureKind): boolean;
/** Claim a session, process unhandled rows, and atomically record completion. */
export declare function runFactExtraction(db: Database.Database, sessionId: string, project: string, opts?: {
    claimVariant?: "worker" | "hook";
}): Promise<{
    extracted: number;
    saved: number;
    skipped?: "claim_not_acquired" | "claim_error" | "excluded_project" | "excluded_project_unmarked";
}>;
