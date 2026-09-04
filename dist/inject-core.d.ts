import { type RecallGateConfig } from "./recall-gate.js";
export interface InjectOptions {
    /** Disable the cheap gate (calibration baseline only). */
    gate?: boolean;
    gateConfig?: Partial<RecallGateConfig>;
    now?: string;
}
/**
 * Compute the UserPromptSubmit context block for a prompt.
 *
 * Phase 5 flow: cheap gate (no model, no embedding) → optional single
 * embedding on the ambiguous path → revision-aware delta retrieval → Memory
 * Bundle (CORRECTION, WORK NOW, CURRENT TRUTH, WATCH, TRACE, RECENT EVIDENCE,
 * ASSISTANT CONTEXT-ONLY) under a deterministic hard budget. Returns '' when
 * there is nothing to inject.
 *
 * Shared by BOTH execution paths:
 *  - the warm in-process daemon inside the MCP server (embeddings already
 *    loaded → ~150ms), and
 *  - the cold fallback in scripts/inject-context.js (fresh node process,
 *    ~2.3s dominated by model load) used when no MCP server is running.
 *
 * `via` tags the inject log so the two paths stay distinguishable.
 *
 * Provenance 계약(RETRIEVAL-AND-CONTEXT.md:43-48): 컨텍스트 발행 **전**에 durable
 * `prepared` recall 영수증이 있어야 한다. sessionId 없는 호출은 recall_events 행을
 * 남길 수 없어 provenance 가 단절되므로, fact 주입 자체를 생략한다(fail-closed).
 * "one recall must not taint sibling tools" 불변식의 추적 가능성이 이 영수증에 의존한다.
 */
export declare function computeInjectContext(userPrompt: string, project: string, via: "daemon" | "fallback", sessionId?: string, options?: InjectOptions): Promise<string>;
