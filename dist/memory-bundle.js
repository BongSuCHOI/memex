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
 * A sentence terminator, plus the closers that belong to the sentence it ends
 * (`... signs off."` is one boundary, not a cut before the quote). `。！？` are
 * the CJK forms; a Korean sentence ender (`…다.`, `…요.`) is terminated by the
 * same ASCII period, so it needs no rule of its own.
 */
const SENTENCE_END = /[.!?。！？]+["'”’»）)\]]*/g;
/**
 * Words whose period ends an abbreviation, not a sentence (compared in lower
 * case, without the period). A single Latin letter is deliberately NOT on this
 * list: `Use option A. Deployment is approved only after sign-off.` ends a real
 * sentence at `A.`, and rejecting it re-created the inversion (external review,
 * round 2). An initial such as `Ask A. Smith` is still caught by rule (2) when
 * a lowercase word follows; a capitalized surname after an initial is accepted
 * as a boundary, the cheaper of the two mistakes.
 */
const ABBREVIATIONS = new Set([
    "e.g", "i.e", "etc", "vs", "cf", "mr", "mrs", "ms", "dr", "prof",
    "no", "fig", "approx", "incl", "jr", "sr", "st",
]);
/** The word immediately before a terminator, dots included (`e.g`, `paths.ts`). */
const WORD_BEFORE_TERMINATOR = /([A-Za-z][A-Za-z.]*)$/;
/**
 * A bare list marker: `1`, `12`, `A`, and the bracketed forms `(1)`, `[a]`.
 * Matched against the whole segment since the previous accepted boundary, so
 * `Use option A` (a real sentence ending on a single letter) is NOT a marker.
 */
const LIST_MARKER_ONLY = /^[([]?(\d+|[A-Za-z])[)\]]?$/;
/**
 * 🚨 #182, external review: is the terminator at `terminatorAt` (whose match,
 * closers included, ends at `stop`) really the end of a sentence?
 *
 * Four conditions. "Followed by whitespace" alone accepted
 * `Deployment may proceed in e.g. staging only after operator approval.` as
 * ending at `e.g.` and injected `Deployment may proceed in e.g.…` — the
 * condition dropped, which is the very inversion class #182 exists to prevent
 * (and the half-budget guard cannot catch it: a sentence candidate never
 * reaches the word-boundary fallback).
 *
 * `segmentStart` is the previous ACCEPTED boundary (0 for the start of the
 * text), which is what makes condition (4) — the #185 list-marker rule —
 * answerable at all: a terminator is only a sentence end if the text since the
 * last one says something.
 */
function isSentenceEnd(flat, terminatorAt, stop, segmentStart) {
    // (1) A sentence ends at whitespace or at the end of the text. This is also
    //     what keeps `0.7.29` and `src/paths.ts` out of the boundary set.
    const next = flat[stop];
    if (next !== undefined && !/\s/.test(next))
        return false;
    // (2) A sentence does not START with a lowercase Latin letter. Korean, CJK,
    //     digits, quotes and capitals are all fine; a lowercase continuation
    //     means the period was inside the clause, so the cut is not taken.
    const rest = flat.slice(stop).trimStart();
    if (/^[a-z]/.test(rest))
        return false;
    // 🚨 (4) 이슈 #185 — a bare list marker is not a sentence.
    //
    // `1.` at the head of `1. Verify migration before deployment …` passed (1),
    // (2) and (3) — whitespace follows, `V` is uppercase, `1` is no abbreviation
    // (the word check only reads Latin words) — so an over-budget instruction
    // rendered as `1.…` in [WORK NOW] and in the rehydration capsule: the whole
    // instruction dropped, the #182 failure mode with a different trigger.
    //
    // The witness is the segment since the last accepted boundary: when all it
    // holds is the marker itself there is no sentence to keep, so the cut falls
    // through to the whitespace rule and the reader keeps the instruction.
    // `Use option A.` survives — its segment is `Use option A`, not `A` (the
    // round-2 case that also forbids putting single letters in ABBREVIATIONS).
    if (LIST_MARKER_ONLY.test(flat.slice(segmentStart, terminatorAt).trim()))
        return false;
    // (3) An abbreviation is not a sentence end.
    const before = WORD_BEFORE_TERMINATOR.exec(flat.slice(0, terminatorAt));
    if (!before)
        return true;
    return !ABBREVIATIONS.has(before[1].toLowerCase());
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
 * So the cut is made at the LAST sentence boundary inside the budget — see
 * `isSentenceEnd` for what counts as one, which is where `0.7.29`, `e.g.` and
 * `Fig.` are kept out — falling back to the last whitespace, and only then to
 * a hard cut for one unbroken token.
 * The ellipsis is kept in every case, so the reader still knows text was
 * dropped. Dropping the tail of a sentence is deliberate: a shorter complete
 * statement is worth more to the reader than a longer inverted one.
 *
 * The result is never longer than `maxChars` (ellipsis included) and never
 * longer than the input, so every caller's byte budget still holds.
 */
export function truncateAtSentenceBoundary(text, maxChars, options = {}) {
    const ellipsis = options.ellipsis ?? "…";
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= maxChars)
        return flat;
    const budget = maxChars - ellipsis.length;
    if (budget <= 0)
        return "";
    const head = flat.slice(0, budget);
    let sentenceEnd = 0;
    for (const match of head.matchAll(SENTENCE_END)) {
        const terminatorAt = match.index ?? 0;
        const stop = terminatorAt + match[0].length;
        // What proves a sentence end — the whitespace, and the letter that starts
        // the next sentence — may be the very characters the cut removes, so the
        // predicate reads the FULL text, not `head`. `sentenceEnd` doubles as the
        // segment start for #185: the last boundary this loop accepted.
        if (isSentenceEnd(flat, terminatorAt, stop, sentenceEnd))
            sentenceEnd = stop;
    }
    if (sentenceEnd > 0)
        return flat.slice(0, sentenceEnd) + ellipsis;
    // The budget already ends on a word boundary: keep the whole last word.
    if (/\s/.test(flat[budget] ?? ""))
        return head.trimEnd() + ellipsis;
    // The word-boundary fallback is cosmetic where the sentence rule is
    // semantic: it only exists so a cut does not land inside a word. So when the
    // nearest word boundary would throw away most of the budget — one unbroken
    // token, a URL, a CJK run without spaces — it is abandoned for the longer
    // hard cut: `Verify` tells the reader less than `Verify journalxxxx…` does,
    // and no clause is being inverted (test/continuity-rehydration-budget.test.ts
    // renders exactly that shape, a 480-character token inside a 66-char slot).
    const lastSpace = head.lastIndexOf(" ");
    if (lastSpace >= Math.ceil(budget * 0.5))
        return head.slice(0, lastSpace).trimEnd() + ellipsis;
    return head + ellipsis;
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
