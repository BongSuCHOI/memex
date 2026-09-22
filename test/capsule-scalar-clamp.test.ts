import { describe, expect, it } from "vitest";
import {
  validateWorkCapsulePatch,
  validateWorkCapsulePatchWithTruncation,
} from "../src/continuity-core.js";

/**
 * Issue #178 — the 500-character `objective`/`currentState` bound is a STORAGE
 * constraint, not a correctness one.
 *
 * `strictScalar` threw on an overrun, so a model that answered with 700
 * characters failed identically on all five attempts (nothing about the next
 * attempt changes a length violation). Observed on the primary Mac:
 *
 *   dead  capsule_update e06afd5c…  attempts=5/5
 *       last_error: currentState must be text of at most 500 characters
 *   capsuleCheckpointState: failed-visible — "(skipped evidence seq 199; frontier advanced)"
 *
 * The job died, the checkpoint went failed-visible, and the evidence frontier
 * advanced past the page: a whole page of session evidence lost over a bound the
 * patch could simply satisfy. Same shape as #85 (item caps) and #17 (size):
 * shorten and RECORD it, never throw the answer away. A non-string is still a
 * correctness failure and still throws.
 *
 * `scalarClamps[field]` carries the ORIGINAL length, like `itemCaps` carries
 * what a list lost, so the telemetry says the model overran rather than leaving
 * a quietly shorter capsule unexplained.
 */

const base = {
  objective: "Fix the capsule clamp",
  currentState: "The clamp is under test",
  verifiedProgress: [{ text: "Observed a dead capsule_update job", sourceExchangeIds: ["exchange-1"] }],
  hypotheses: [],
  blockers: [],
  openQuestions: [],
  nextActions: [],
  touchedAreas: [],
  carryFactRevisions: [],
  sourceExchangeIds: ["exchange-1"],
};

/**
 * True when the string holds a lone surrogate — i.e. a clamp split an
 * astral code point in half. Asserted alongside `isWellFormed()` so the
 * failure names the unit, not just the predicate.
 */
function loneSurrogates(text: string): number[] {
  const bad: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) bad.push(i);
      else i++;
    } else if (isLow) {
      bad.push(i);
    }
  }
  return bad;
}

/** 700 UTF-16 units of Korean words, so the boundary cut is observable on BMP text. */
function koreanWords(units: number): string {
  let text = "";
  let n = 0;
  while (text.length < units) text += (text ? " " : "") + `한국어단어${n++}`;
  return text.slice(0, units).replace(/\s$/, "끝");
}

/** 700 characters of real words, so "cut at a word boundary" is observable. */
function words(chars: number): string {
  let text = "";
  let n = 0;
  while (text.length < chars) {
    const word = `segment${n++}`;
    text += (text ? " " : "") + word;
  }
  // Never end on whitespace: `strictScalar` trims, so a trailing space would
  // make an at-the-bound value look clamped when nothing clamped it.
  return text.slice(0, chars).replace(/\s$/, "z");
}

describe("issue #178 — an over-long capsule scalar is clamped, not rejected", () => {
  it("clamps a 700-character currentState to a word boundary and records the original length", () => {
    const long = words(700);
    expect(long).toHaveLength(700);
    const { patch, truncation } = validateWorkCapsulePatchWithTruncation({
      ...base,
      currentState: long,
    });
    expect(
      patch.currentState.length,
      "a length overrun must be stored, not thrown: five retries cannot shorten it",
    ).toBeLessThanOrEqual(500);
    expect(patch.currentState.length).toBeGreaterThan(300);
    // Word boundary: the stored text is a prefix of the original that ends on a
    // whole word, so no half word is presented as the model's state.
    expect(long.startsWith(patch.currentState)).toBe(true);
    expect(patch.currentState).toBe(patch.currentState.trim());
    expect(long[patch.currentState.length]).toMatch(/\s/);
    expect(
      truncation.scalarClamps,
      "the clamp is telemetry, like itemCaps — the original length or nothing",
    ).toEqual({ currentState: 700 });
    // The clamp is a truncation, exactly as an item cap is (#85).
    expect(truncation.truncated).toBe(true);
    expect(truncation.truncatedFields).toContain("currentState");
  });

  it("clamps objective and currentState independently", () => {
    const { patch, truncation } = validateWorkCapsulePatchWithTruncation({
      ...base,
      objective: words(620),
      currentState: words(700),
    });
    expect(truncation.scalarClamps).toEqual({ objective: 620, currentState: 700 });
    expect(patch.objective.length).toBeLessThanOrEqual(500);
    expect(patch.currentState.length).toBeLessThanOrEqual(500);
  });

  it("hard-cuts at 500 when the text has no whitespace to cut back to", () => {
    const solid = "x".repeat(700);
    const { patch, truncation } = validateWorkCapsulePatchWithTruncation({
      ...base,
      currentState: solid,
    });
    // No whitespace at all: cutting back to the last boundary would throw away
    // most of the answer, so the bound itself is the cut.
    expect(patch.currentState).toHaveLength(500);
    expect(truncation.scalarClamps).toEqual({ currentState: 700 });
  });

  it("leaves a value exactly at the bound untouched and records no clamp", () => {
    const exact = words(500);
    expect(exact).toHaveLength(500);
    const { patch, truncation } = validateWorkCapsulePatchWithTruncation({
      ...base,
      currentState: exact,
    });
    expect(patch.currentState).toBe(exact);
    expect(truncation.scalarClamps).toEqual({});
    expect(truncation.truncatedFields).not.toContain("currentState");
  });

  it("still throws for a non-string scalar (a correctness failure, not a bound)", () => {
    expect(() => validateWorkCapsulePatch({ ...base, currentState: 42 }))
      .toThrow(/currentState must be text/);
    expect(() => validateWorkCapsulePatch({ ...base, objective: null }))
      .toThrow(/objective must be text/);
  });

  /**
   * Codex review of the #178 fix — the hard cut split a surrogate pair.
   *
   * `raw.slice(0, 500)` counts UTF-16 CODE UNITS, so a 500th unit that is the
   * high half of an astral code point (emoji, rare CJK, many scripts) was stored
   * alone: `String.prototype.isWellFormed() === false`, which is a malformed
   * string in the Capsule row, in its JSON serialization and in every surface
   * that renders it. A clamp is a storage concession; it must not corrupt text.
   */
  it("never leaves a lone surrogate at the hard cut", () => {
    const raw = "x".repeat(499) + "\u{1F600}" + "y".repeat(200);
    expect(raw).toHaveLength(701);
    // The naive cut lands between the emoji's two halves.
    expect(loneSurrogates(raw.slice(0, 500))).toEqual([499]);
    const { patch, truncation } = validateWorkCapsulePatchWithTruncation({
      ...base,
      currentState: raw,
    });
    expect(loneSurrogates(patch.currentState), "a clamp must not split a code point").toEqual([]);
    expect(patch.currentState.isWellFormed()).toBe(true);
    expect(patch.currentState.length).toBeLessThanOrEqual(500);
    // The whole code point is dropped, never half of it: 499 units of 'x'.
    expect(patch.currentState).toBe("x".repeat(499));
    // The recorded length is the same UTF-16 unit the bound is measured in.
    expect(truncation.scalarClamps).toEqual({ currentState: 701 });
  });

  it("never leaves a lone surrogate when the word boundary is below the floor", () => {
    // Whitespace at index 200 (< SCALAR_CLAMP_WORD_FLOOR), so the hard cut runs —
    // and it lands mid-emoji at unit 499/500.
    const raw = "a".repeat(200) + " " + "b".repeat(298) + "\u{1F600}" + "c".repeat(200);
    expect(loneSurrogates(raw.slice(0, 500))).toEqual([499]);
    const { patch } = validateWorkCapsulePatchWithTruncation({ ...base, currentState: raw });
    expect(loneSurrogates(patch.currentState)).toEqual([]);
    expect(patch.currentState.isWellFormed()).toBe(true);
    expect(patch.currentState.length).toBeLessThanOrEqual(500);
  });

  it("the word-boundary cut also lands on a code-point boundary", () => {
    const raw = "a".repeat(400) + " " + "b".repeat(98) + "\u{1F600}" + "c".repeat(300);
    const { patch } = validateWorkCapsulePatchWithTruncation({ ...base, currentState: raw });
    expect(loneSurrogates(patch.currentState)).toEqual([]);
    expect(patch.currentState).toBe("a".repeat(400));
  });

  it("clamps a 700-unit Korean string at a space", () => {
    const korean = koreanWords(700);
    expect(korean).toHaveLength(700);
    const { patch, truncation } = validateWorkCapsulePatchWithTruncation({
      ...base,
      currentState: korean,
    });
    expect(patch.currentState.length).toBeLessThanOrEqual(500);
    expect(patch.currentState.length).toBeGreaterThan(300);
    expect(korean.startsWith(patch.currentState)).toBe(true);
    // Cut at a space, not through a word.
    expect(korean[patch.currentState.length]).toMatch(/\s/);
    expect(patch.currentState.isWellFormed()).toBe(true);
    expect(truncation.scalarClamps).toEqual({ currentState: 700 });
  });
});
