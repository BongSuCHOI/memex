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
export const BUNDLE_SECTION_ORDER = [
    "CORRECTION",
    "WORK NOW",
    "CURRENT TRUTH",
    "WATCH",
    "TRACE",
    "RECENT EVIDENCE",
    "ASSISTANT CONTEXT",
];
export const BUNDLE_HEADINGS = {
    CORRECTION: "[MEMEX CORRECTION]",
    "WORK NOW": "[WORK NOW]",
    "CURRENT TRUTH": "[CURRENT TRUTH]",
    WATCH: "[WATCH — VERIFIED INCIDENT PATTERN]",
    TRACE: "[TRACE — HISTORY AVAILABLE]",
    "RECENT EVIDENCE": "[RECENT EVIDENCE — NOT YET DISTILLED]",
    "ASSISTANT CONTEXT": "[ASSISTANT CONTEXT-ONLY — NOT AUTHORITATIVE]",
};
export const NORMAL_BUNDLE_BUDGET = {
    target: 700,
    hard: 1_000,
    lineChars: 160,
    maxItems: { CORRECTION: 4, "WORK NOW": 1, "CURRENT TRUTH": 4, WATCH: 2, TRACE: 2, "RECENT EVIDENCE": 2, "ASSISTANT CONTEXT": 1 },
};
export const REHYDRATION_BUNDLE_BUDGET = {
    target: 1_500,
    hard: 2_000,
    lineChars: 260,
    maxItems: { CORRECTION: 6, "WORK NOW": 1, "CURRENT TRUTH": 4, WATCH: 2, TRACE: 2, "RECENT EVIDENCE": 3, "ASSISTANT CONTEXT": 1 },
};
function normalizeLine(text, cap) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > cap ? flat.slice(0, cap - 1) + "…" : flat;
}
/** Render sections in priority order under the budget. Deterministic for identical input. */
export function renderMemoryBundle(sections, budget) {
    const byKind = new Map(sections.map((section) => [section.kind, section]));
    const blocks = [];
    const report = [];
    let used = 0;
    let truncated = false;
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
            const prospective = item.raw && accepted.length === 0 && line.startsWith("[")
                ? line
                : `${heading}\n${[...accepted, line].join("\n")}`;
            const separator = blocks.length > 0 ? 2 : 0;
            if (used + separator + prospective.length > budget.hard) {
                truncated = true;
                break;
            }
            // Past the target only short items are admitted, so low-priority
            // sections cannot push the bundle toward the hard cap.
            if (used + separator + prospective.length > budget.target && line.length > budget.lineChars / 2 && accepted.length > 0) {
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
        used += (blocks.length > 0 ? 2 : 0) + block.length;
        blocks.push(block);
        report.push({ kind, emitted, chars: block.length });
    }
    const text = blocks.join("\n\n");
    return { text, chars: text.length, sections: report, truncated };
}
export function estimateTokens(chars) {
    return Math.ceil(chars / 3);
}
