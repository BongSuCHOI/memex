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
import { estimateContextTokens, NORMAL_CONTEXT_LIMITS, REHYDRATION_CONTEXT_LIMITS, wrapMemoryContext, } from "./context-envelope.js";
export const BUNDLE_SECTION_ORDER = [
    "CORRECTION",
    "WORK NOW",
    "CURRENT TRUTH",
    "RAW EVIDENCE",
    "WATCH",
    "TRACE",
    "RECENT EVIDENCE",
    "ASSISTANT CONTEXT",
];
export const BUNDLE_HEADINGS = {
    CORRECTION: "[MEMEX CORRECTION]",
    "WORK NOW": "[WORK NOW]",
    "CURRENT TRUTH": "[CURRENT TRUTH]",
    "RAW EVIDENCE": "[RAW EVIDENCE — CONTEXT-ONLY, MAY BE STALE]",
    WATCH: "[WATCH — VERIFIED INCIDENT PATTERN]",
    TRACE: "[TRACE — HISTORY AVAILABLE]",
    "RECENT EVIDENCE": "[RECENT EVIDENCE — NOT YET DISTILLED]",
    "ASSISTANT CONTEXT": "[ASSISTANT CONTEXT-ONLY — NOT AUTHORITATIVE]",
};
export const NORMAL_BUNDLE_BUDGET = {
    target: 700,
    hard: 1_000,
    lineChars: 160,
    maxItems: { CORRECTION: 4, "WORK NOW": 1, "CURRENT TRUTH": 4, "RAW EVIDENCE": 2, WATCH: 2, TRACE: 2, "RECENT EVIDENCE": 2, "ASSISTANT CONTEXT": 1 },
    contextLimits: NORMAL_CONTEXT_LIMITS,
};
export const REHYDRATION_BUNDLE_BUDGET = {
    target: 1_500,
    hard: 2_000,
    lineChars: 260,
    maxItems: { CORRECTION: 6, "WORK NOW": 1, "CURRENT TRUTH": 4, WATCH: 2, TRACE: 2, "RECENT EVIDENCE": 3, "ASSISTANT CONTEXT": 1 },
    contextLimits: REHYDRATION_CONTEXT_LIMITS,
};
function normalizeLine(text, cap) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > cap ? flat.slice(0, cap - 1) + "…" : flat;
}
/**
 * Keep the first renderer-owned section marker visible to existing host
 * consumers, then place every memory item inside the untrusted JSON envelope.
 * The marker is selected from BUNDLE_HEADINGS, never from item text, so this
 * compatibility prefix cannot be supplied by memory data.
 */
function wrapRenderedMemory(rawText, firstHeading) {
    const newline = rawText.indexOf("\n");
    const firstLine = newline < 0 ? rawText : rawText.slice(0, newline);
    if (!firstHeading || firstLine !== firstHeading)
        return wrapMemoryContext(rawText);
    const payload = newline < 0 ? "" : rawText.slice(newline + 1);
    return `${firstLine}\n${wrapMemoryContext(payload)}`;
}
/** Render sections in priority order under the budget. Deterministic for identical input. */
export function renderMemoryBundle(sections, budget) {
    const byKind = new Map(sections.map((section) => [section.kind, section]));
    const blocks = [];
    const report = [];
    let truncated = false;
    const contextLimits = budget.contextLimits ?? {
        maxChars: budget.hard,
        maxEstimatedTokens: Number.MAX_SAFE_INTEGER,
    };
    for (const kind of BUNDLE_SECTION_ORDER) {
        const section = byKind.get(kind);
        if (!section || section.items.length === 0)
            continue;
        const maxItems = budget.maxItems[kind] ?? section.items.length;
        const heading = BUNDLE_HEADINGS[kind];
        const accepted = [];
        const emitted = [];
        for (const item of section.items) {
            if (emitted.length >= maxItems) {
                truncated = true;
                break;
            }
            const line = item.raw ? item.text.trim().slice(0, budget.hard) : `- ${normalizeLine(item.text, budget.lineChars)}`;
            const prospectiveBlock = item.raw && accepted.length === 0 && line.startsWith("[")
                ? line
                : `${heading}\n${[...accepted, line].join("\n")}`;
            // Check the complete wrapped output while selecting each item. This
            // reserves the fixed instruction, delimiters and JSON escaping before a
            // reference can become eligible for a residency/cursor commit.
            const prospectiveRaw = blocks.length > 0
                ? `${blocks.join("\n\n")}\n\n${prospectiveBlock}`
                : prospectiveBlock;
            const prospectiveText = wrapRenderedMemory(prospectiveRaw, BUNDLE_HEADINGS[report[0]?.kind ?? kind]);
            if (prospectiveText.length > contextLimits.maxChars ||
                estimateContextTokens(prospectiveText) > contextLimits.maxEstimatedTokens) {
                truncated = true;
                break;
            }
            // Past the target only short items are admitted, so low-priority
            // sections cannot push the bundle toward the hard cap.
            if (prospectiveText.length > budget.target && line.length > budget.lineChars / 2 && accepted.length > 0) {
                truncated = true;
                break;
            }
            accepted.push(line);
            emitted.push(item);
        }
        if (accepted.length === 0)
            continue;
        const block = accepted.length === 1 && section.items[0]?.raw && accepted[0].startsWith("[")
            ? accepted[0]
            : `${heading}\n${accepted.join("\n")}`;
        blocks.push(block);
        report.push({ kind, emitted, chars: block.length });
    }
    const rawText = blocks.join("\n\n");
    const text = wrapRenderedMemory(rawText, report[0] ? BUNDLE_HEADINGS[report[0].kind] : undefined);
    const emittedRefs = [];
    for (const section of report) {
        for (const item of section.emitted) {
            if (item.ref !== undefined)
                emittedRefs.push(item.ref);
        }
    }
    return {
        text,
        rawText,
        chars: text.length,
        estimatedTokens: estimateContextTokens(text),
        sections: report,
        emittedRefs,
        truncated,
    };
}
export function estimateTokens(chars) {
    return Math.ceil(chars / 3);
}
