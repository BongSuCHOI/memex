import { type InjectLogEntry } from "./inject-log.js";
import { type RecallGateConfig } from "./recall-gate.js";
/**
 * Issue #32 — the margin is now tunable and measurable.
 *
 * The observed data root ran the pipeline 12 times over five days with
 * `candidate_facts = 5` and `current_facts = 0` every single time: not one of
 * 127 extracted facts ever entered a prompt. Nothing recorded where those
 * candidates actually sat relative to the threshold, so the constant could not
 * be judged from data. `baseline_margin_gap` telemetry now records that
 * distribution, and this override lets it be moved once the data says where.
 * The default is unchanged: retuning it without evidence would be guessing.
 */
export declare const INJECT_BASELINE_MARGIN_DEFAULT = 0.045;
export declare function resolveBaselineMargin(): number;
export interface InjectOptions {
    /** Disable the cheap gate (calibration baseline only). */
    gate?: boolean;
    gateConfig?: Partial<RecallGateConfig>;
    now?: string;
    /** Receives the exact prepared receipt only after its transaction commits. */
    onPreparedReceipt?: (id: string) => void;
    /**
     * Issue #84: daemon attribution for this run's log line — the answering
     * daemon's identity on the fast path, or the identity mismatch that sent the
     * hook in-process. Recorded on whichever line this call writes, so the
     * fast-path decision and its outcome are one record.
     */
    daemon?: InjectLogEntry["daemon"];
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
