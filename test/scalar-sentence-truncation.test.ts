import { describe, expect, it } from "vitest";

import { truncateAtSentenceBoundary } from "../src/memory-bundle.js";

/**
 * 이슈 #182 — 주입된 스칼라 텍스트가 절 중간에서 잘려 조건문이 사실로 뒤집혔다.
 *
 * 관측된 렌더링: 저장된 `currentState`
 * `Deployment is approved only after the operator signs off.` 가 라인 예산(≈200자)
 * 에서 다시 잘리며 `Deployment is approved…` 로 렌더됐다 — 조건문이 사실이 되어
 * 그 컨텍스트를 받는 모델이 "승인됨"으로 읽는다.
 *
 * 규칙은 한 곳(`truncateAtSentenceBoundary`)에만 있고, 모델 텍스트에서 렌더되는
 * 모든 스칼라 라인이 그것을 쓴다: inject-core 의 [WORK NOW]
 * Objective/State/Blocker/Next, continuity-core 의 renderCapsule 필드와
 * buildDeterministicTailBaton 의 Pending/Request/Next.
 */
describe("issue #182 — scalar model text is cut at a sentence boundary", () => {
  const observed =
    "Deployment is approved only after the operator signs off. Rollback plan is ready.";
  /** 첫 문장만 들어가는 예산: 첫 문장 57자 < 60 < 전체 80자. */
  const FITS_FIRST_SENTENCE = 60;

  it("keeps the complete first sentence instead of inverting the conditional", () => {
    const rendered = truncateAtSentenceBoundary(observed, FITS_FIRST_SENTENCE);
    expect(rendered).toBe("Deployment is approved only after the operator signs off.…");
    expect(rendered.length).toBeLessThanOrEqual(FITS_FIRST_SENTENCE);
    // 관측된 결함 문자열 자체를 고정한다: 조건절이 사실로 뒤집힌 렌더링.
    expect(rendered).not.toBe("Deployment is approved…");
    expect(rendered, "a conditional must never be cut before its condition")
      .not.toMatch(/approved\s*…$/);
  });

  it("never ends inside a clause when a shorter complete sentence fits", () => {
    // 예산이 두 번째 문장 중간까지만 닿는 모든 지점에서 첫 문장으로 물러난다.
    for (let cap = 58; cap < observed.length; cap++) {
      const rendered = truncateAtSentenceBoundary(observed, cap);
      expect(rendered, `cap=${cap}`).toBe(
        "Deployment is approved only after the operator signs off.…",
      );
    }
  });

  it("falls back to the last whitespace for a single sentence with no boundary", () => {
    const single = `${"word ".repeat(79)}end.`; // 문장 종결자는 400자 끝에 하나뿐
    expect(single.length).toBeGreaterThan(200);
    const rendered = truncateAtSentenceBoundary(single, 200);
    expect(rendered.length).toBeLessThanOrEqual(200);
    expect(rendered.endsWith("…"), "the reader must still see that text was dropped").toBe(true);
    // 잘린 자리는 공백 경계다: 단어가 반토막 나지 않는다.
    expect(rendered.slice(0, -1)).toBe(rendered.slice(0, -1).trimEnd());
    expect(rendered.slice(0, -1).split(" ").pop()).toBe("word");
  });

  it("leaves text that fits inside the budget untouched", () => {
    expect(truncateAtSentenceBoundary(observed, 200)).toBe(observed);
    expect(truncateAtSentenceBoundary(observed, observed.length)).toBe(observed);
    // 공백 정규화는 기존 라인 렌더와 동일하게 유지한다.
    expect(truncateAtSentenceBoundary("  a\n\nb  ", 200)).toBe("a b");
  });

  it("cuts Korean prose at the sentence ender, not mid-clause", () => {
    const korean = "배포는 운영자가 승인한 뒤에만 진행된다. 롤백 계획은 준비되어 있다.";
    const first = "배포는 운영자가 승인한 뒤에만 진행된다.";
    const rendered = truncateAtSentenceBoundary(korean, first.length + 2);
    expect(rendered).toBe(`${first}…`);
    expect(rendered).not.toMatch(/진행된다\. 롤백/);
  });

  it("does not treat a decimal point or a version as a sentence end", () => {
    const text = "Release 0.7.29 shipped the maintenance lane. Verify the gate next.";
    const rendered = truncateAtSentenceBoundary(text, 46);
    expect(rendered).toBe("Release 0.7.29 shipped the maintenance lane.…");
  });

  /**
   * 🚨 #182 외부 리뷰(P2) — 약어의 마침표가 문장 끝으로 받아들여졌다.
   *
   * `e.g.` 의 마침표도 공백이 뒤따르므로 경계로 인정됐고, 예산이 그 뒤에서 끝나면
   * `Deployment may proceed in e.g.…` 가 렌더됐다 — `only after operator approval`
   * 조건이 사라진, #182 가 막으려던 바로 그 뒤집힘이다. 반-예산 가드는 문장 후보를
   * 거치지 않으므로 이것을 잡지 못한다.
   *
   * 그래서 종결자가 문장 끝이 되려면 세 조건이 모두 필요하다: 뒤가 공백/끝이고,
   * 다음 비공백 문자가 소문자 라틴 글자가 아니며(문장은 소문자로 시작하지 않는다),
   * 종결자 앞 단어가 알려진 약어나 한 글자 이니셜이 아니다.
   */
  const conditional =
    "Deployment may proceed in e.g. staging only after operator approval. Rollback is ready.";
  const firstConditionalSentence =
    "Deployment may proceed in e.g. staging only after operator approval.";

  it("keeps the whole conditional sentence instead of cutting at `e.g.`", () => {
    const rendered = truncateAtSentenceBoundary(conditional, firstConditionalSentence.length + 4);
    expect(rendered).toBe(`${firstConditionalSentence}…`);
    expect(rendered).not.toBe("Deployment may proceed in e.g.…");
  });

  it("falls back to the last whitespace when only an abbreviation period fits", () => {
    // 예산이 첫 문장에 닿지 않는다: `e.g.` 는 경계가 아니므로 공백 경계로 물러난다.
    const rendered = truncateAtSentenceBoundary(conditional, 40);
    expect(
      rendered,
      "an abbreviation period must never drop the condition that follows it",
    ).not.toBe("Deployment may proceed in e.g.…");
    expect(rendered).toBe("Deployment may proceed in e.g. staging…");
    expect(rendered.length).toBeLessThanOrEqual(40);
  });

  it("cuts after the real sentence, not after `Fig.`", () => {
    const text = "See Fig. 3 for details. Next step follows.";
    expect(truncateAtSentenceBoundary(text, 30)).toBe("See Fig. 3 for details.…");
    // 첫 문장조차 들어가지 않으면 `Fig.` 가 아니라 공백에서 끊는다.
    const tight = truncateAtSentenceBoundary(text, 20);
    expect(tight).not.toBe("See Fig.…");
    expect(tight).toBe("See Fig. 3 for…");
  });

  it("still cuts after an ordinary sentence that ends beside parentheses", () => {
    const text = "The API (v2) is stable. Use it.";
    expect(truncateAtSentenceBoundary(text, 26)).toBe("The API (v2) is stable.…");
  });

  it("does not treat a marker at the end of a segment as a sentence end (#185 round 2)", () => {
    // `Next steps: 1.` — the segment is `Next steps: 1`, not just `1`.
    const text = "Next steps: 1. Verify migration before deployment and confirm all tests pass before merging.";
    const rendered = truncateAtSentenceBoundary(text, 34);
    expect(rendered).not.toBe("Next steps: 1.…");
    expect(rendered.startsWith("Next steps: 1. Verify")).toBe(true);
    // A single letter after a colon is a marker; after an ordinary word it is not.
    expect(truncateAtSentenceBoundary("Steps: A. Verify the gate before merging the release.", 24)).not.toBe("Steps: A.…");
    expect(truncateAtSentenceBoundary("Use option A. Deployment is approved only after sign-off.", 37)).toBe("Use option A.…");
    // A sentence ending in a number is the accepted cost: it falls back to whitespace.
    expect(truncateAtSentenceBoundary("Bump to version 2. Then verify the gate again.", 30).endsWith("…")).toBe(true);
  });

  it("keeps a single-letter word as a real sentence end (external review round 2)", () => {
    // `option A.` ends a sentence; rejecting it as an initial dropped the
    // condition that followed and re-created the #182 inversion.
    const text = "Use option A. Deployment is approved only after sign-off.";
    expect(truncateAtSentenceBoundary(text, 37)).toBe("Use option A.…");
    // An initial followed by a lowercase word is still not a boundary (rule 2).
    const initial = "Ask A. the owner about the staged rollout before merging.";
    expect(truncateAtSentenceBoundary(initial, 22)).not.toBe("Ask A.…");
  });

  it("treats no listed abbreviation as a sentence end", () => {
    const abbreviations = [
      "e.g.", "i.e.", "etc.", "vs.", "cf.", "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.",
      "No.", "Fig.", "approx.", "incl.", "Jr.", "Sr.", "St.",
    ];
    for (const abbreviation of abbreviations) {
      const head = `Ask ${abbreviation}`;
      const text = `${head} the owner about the staged rollout before merging.`;
      // 예산은 약어 뒤 몇 단어까지만 닿는다 — 진짜 문장 끝은 예산 밖이다.
      const rendered = truncateAtSentenceBoundary(text, head.length + 16);
      expect(rendered.endsWith("…"), abbreviation).toBe(true);
      expect(rendered, abbreviation).not.toBe(`${head}…`);
      expect(rendered.length, abbreviation).toBeLessThanOrEqual(head.length + 16);
    }
  });

  it("does not cut where the next sentence would start with a lowercase letter", () => {
    // 소문자로 이어지는 조각은 새 문장이 아니다 — 확신이 없으면 끊지 않는다.
    const text = "Upgrade to 0.7.29. then verify the maintenance gate before merging.";
    const rendered = truncateAtSentenceBoundary(text, 30);
    expect(rendered).not.toBe("Upgrade to 0.7.29.…");
    expect(rendered.endsWith("…")).toBe(true);
  });

  it("keeps a path and a version out of the boundary set", () => {
    const text = "Read src/paths.ts before the gate. Then run the workdir table.";
    expect(truncateAtSentenceBoundary(text, 40)).toBe("Read src/paths.ts before the gate.…");
  });

  /**
   * 🚨 이슈 #185 — 목록 표지(`1.`, `A.`, `(1)`)가 문장 끝으로 받아들여졌다.
   *
   * 앞 단어 검사는 라틴 단어만 보므로 `1. Verify migration before deployment …`
   * 의 `1.` 이 세 조건을 모두 통과했다(뒤가 공백, 다음 글자가 대문자, 약어 아님).
   * 라인이 예산을 넘으면 `[WORK NOW]` 와 재수화 capsule 이 `1.…` 을 렌더한다 —
   * 지시문 전체가 사라진다. 그래서 네 번째 조건: 직전에 **승인된** 경계(없으면
   * 텍스트 시작)부터 종결자까지의 구간이 표지 하나뿐이면 경계가 아니다.
   */
  it("never cuts at a bare numbered-list marker", () => {
    const numbered =
      "1. Verify migration before deployment and confirm all tests pass before merging the release.";
    const rendered = truncateAtSentenceBoundary(numbered, 30);
    expect(rendered, "a list marker must never swallow the instruction").not.toBe("1.…");
    expect(rendered).toBe("1. Verify migration before…");
    expect(rendered.length).toBeLessThanOrEqual(30);
  });

  it("never cuts at a bare lettered-list marker", () => {
    const lettered =
      "A. Verify migration before deployment and confirm all tests pass before merging the release.";
    const rendered = truncateAtSentenceBoundary(lettered, 30);
    expect(rendered).not.toBe("A.…");
    expect(rendered).toBe("A. Verify migration before…");
  });

  it("cuts after the last complete list ITEM, not after its marker", () => {
    const list = "1. Do X. 2. Do Y. 3. Do Z.";
    // 예산이 두 항목까지 닿는다: `2.` 가 아니라 `Do Y.` 뒤에서 끊는다.
    expect(truncateAtSentenceBoundary(list, 22)).toBe("1. Do X. 2. Do Y.…");
    // 한 항목만 닿으면 첫 항목 뒤에서 끊는다.
    expect(truncateAtSentenceBoundary(list, 12)).toBe("1. Do X.…");
  });

  it("keeps a real sentence that happens to end on a single letter", () => {
    // v0.7.30 라운드 2 케이스: 구간이 `Use option A` 이므로 표지가 아니다.
    const text = "Use option A. Deployment is approved only after sign-off.";
    expect(truncateAtSentenceBoundary(text, 37)).toBe("Use option A.…");
  });

  it("cuts a Korean numbered list after the item, not after the marker", () => {
    const first = "1. 마이그레이션을 확인한다.";
    const korean = `${first} 2. 테스트를 돌린다.`;
    const rendered = truncateAtSentenceBoundary(korean, first.length + 3);
    expect(rendered).toBe(`${first}…`);
    expect(rendered).not.toBe("1.…");
  });

  it("never exceeds the budget, whatever the budget is", () => {
    for (const cap of [0, 1, 2, 3, 10, 57, 58, 80, 200]) {
      expect(truncateAtSentenceBoundary(observed, cap).length, `cap=${cap}`)
        .toBeLessThanOrEqual(cap);
    }
  });
});
