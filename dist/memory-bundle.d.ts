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
/** Render sections in priority order under the budget. Deterministic for identical input. */
export declare function renderMemoryBundle<T = unknown>(sections: BundleSection<T>[], budget: BundleBudget): RenderedBundle<T>;
export declare function estimateTokens(chars: number): number;
