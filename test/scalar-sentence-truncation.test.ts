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

  it("never exceeds the budget, whatever the budget is", () => {
    for (const cap of [0, 1, 2, 3, 10, 57, 58, 80, 200]) {
      expect(truncateAtSentenceBoundary(observed, cap).length, `cap=${cap}`)
        .toBeLessThanOrEqual(cap);
    }
  });
});
