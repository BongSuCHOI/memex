/**
 * Phase 5 Memory Bundle (RFC §12.5): deterministic section ordering, ranking,
 * truncation and hard budget for automatic injection.
 *
 * Sections are rendered in a fixed priority order; within a section items are
 * already ranked by the caller (score desc, id asc) and are accepted in order
 * until the budget is exhausted. Truncation is deterministic (fixed per-line
 * cap, no randomness), the hard cap is never exceeded, and the render reports
 * exactly which items were emitted so residency can be committed precisely.
 */
import { type ContextBudget } from "./context-envelope.js";
export type BundleSectionKind = "CORRECTION" | "WORK NOW" | "CURRENT TRUTH" | "RAW EVIDENCE" | "WATCH" | "TRACE" | "RECENT EVIDENCE" | "ASSISTANT CONTEXT";
export declare const BUNDLE_SECTION_ORDER: BundleSectionKind[];
export declare const BUNDLE_HEADINGS: Record<BundleSectionKind, string>;
export interface BundleBudget {
    /** Target size the ranking aims for; sections past it only fit when the item is short. */
    target: number;
    /** Absolute cap; the rendered text is never longer. */
    hard: number;
    /** Per-line truncation cap. */
    lineChars: number;
    /** Max items per section. */
    maxItems: Partial<Record<BundleSectionKind, number>>;
    /** Final wrapped-output limits; wrapper overhead is reserved during selection. */
    contextLimits?: ContextBudget;
}
export declare const NORMAL_BUNDLE_BUDGET: BundleBudget;
export declare const REHYDRATION_BUNDLE_BUDGET: BundleBudget;
export interface BundleItem<T = unknown> {
    text: string;
    /** Caller payload echoed back for emitted items (e.g. resident revision tuple). */
    ref?: T;
    /** Pre-rendered block (WORK NOW/ASSISTANT); rendered as-is instead of a bullet. */
    raw?: boolean;
}
export interface BundleSection<T = unknown> {
    kind: BundleSectionKind;
    items: BundleItem<T>[];
}
export interface RenderedBundle<T = unknown> {
    /** Final host-facing output, including the fixed instruction and envelope. */
    text: string;
    /** Candidate text before the untrusted-data envelope is applied. */
    rawText: string;
    chars: number;
    estimatedTokens: number;
    sections: Array<{
        kind: BundleSectionKind;
        emitted: BundleItem<T>[];
        chars: number;
    }>;
    /** References belonging only to items actually emitted in `text`. */
    emittedRefs: T[];
    truncated: boolean;
}
/**
 * 🚨 Issue #182 — a scalar rendered from model text must never be cut inside a
 * clause while a complete sentence fits.
 *
 * `[WORK NOW]` truncated the stored `currentState` again at the line budget:
 * `Deployment is approved only after the operator signs off.` was injected as
 * `Deployment is approved…`, so the model reading that context took a
 * CONDITIONAL for a fact. The cut is what inverted the meaning, not the
 * budget — the sentence before it was intact and shorter than the budget.
 *
 * So the cut is made at the LAST sentence boundary inside the budget (a
 * terminator followed by whitespace or the end of the text, which is also what
 * keeps `0.7.29` and `src/paths.ts` from counting as boundaries), falling back
 * to the last whitespace, and only then to a hard cut for one unbroken token.
 * The ellipsis is kept in every case, so the reader still knows text was
 * dropped. Dropping the tail of a sentence is deliberate: a shorter complete
 * statement is worth more to the reader than a longer inverted one.
 *
 * The result is never longer than `maxChars` (ellipsis included) and never
 * longer than the input, so every caller's byte budget still holds.
 */
export declare function truncateAtSentenceBoundary(text: string, maxChars: number, options?: {
    ellipsis?: string;
}): string;
/** Render sections in priority order under the budget. Deterministic for identical input. */
export declare function renderMemoryBundle<T = unknown>(sections: BundleSection<T>[], budget: BundleBudget): RenderedBundle<T>;
export declare function estimateTokens(chars: number): number;
