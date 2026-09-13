/**
 * The conversation-language default (#123).
 *
 * The bug this pins: the extraction prompt never named a language, so the model
 * wrote English canonical facts for entirely Korean conversations (112 of 127
 * active facts on the reporter's machine). Detection is deterministic on
 * purpose, so these assertions are exact and not statistical.
 *
 * Two invariants matter more than any single case:
 *   - a window that decides nothing appends NOTHING, so an installation that
 *     detects nothing sends the same bytes it sent before this feature;
 *   - `preferred_language` always wins, because it is the operator's explicit
 *     instruction and detection is only a default.
 */
import { describe, expect, it } from "vitest";

import {
  HANGUL_WEIGHT,
  appendExtractionLanguageClause,
  classifyWindowLanguage,
  detectWindowLanguage,
  renderExtractionLanguageClause,
  resolveExtractionLanguage,
  summarizeAppliedLanguages,
} from "../src/extraction-language.js";
import { composeExtractionSystemPrompt } from "../src/extraction-rules.js";
import { EXTRACTION_SYSTEM_PROMPT } from "../src/fact-extractor.js";

/** One window row. Only `user_message` is ever read. */
function ex(user_message: string, assistant_message = "assistant reply in English"): {
  user_message: string;
  assistant_message: string;
} {
  return { user_message, assistant_message };
}

describe("detectWindowLanguage (#123 §1)", () => {
  it("picks ko when Hangul dominates the human turns", () => {
    const window = [
      ex("Flutter 상태관리는 Riverpod으로 결정했습니다."),
      ex("그리고 세션 저장소는 SQLite를 그대로 씁니다."),
    ];
    const result = classifyWindowLanguage(window);
    expect(result.language).toBe("ko");
    expect(result.decidedBy).toBe("majority");
    expect(result.hangul).toBeGreaterThan(result.latin);
    expect(result.countedMessages).toBe(2);
  });

  it("picks en when Latin dominates the human turns", () => {
    const result = classifyWindowLanguage([
      ex("We decided to use Riverpod for state management."),
      ex("Session storage stays on SQLite."),
    ]);
    expect(result.language).toBe("en");
    expect(result.decidedBy).toBe("majority");
    expect(result.latin).toBeGreaterThan(result.hangul);
  });

  it("counts the human turns only — an English assistant does not make it English", () => {
    expect(
      detectWindowLanguage([
        ex("이건 프로젝트 공용으로 기억하자", "A very long English assistant answer ".repeat(20)),
      ]),
    ).toBe("ko");
  });

  it("ignores fenced code, inline code and URLs inside a Korean turn", () => {
    const window = [
      ex(
        "이 스택트레이스 원인이 뭘까요?\n" +
          "```\n" +
          "TypeError: cannot read property length of undefined at renderSessionStore\n" +
          "  at Object.<anonymous> (/usr/local/lib/node_modules/whatever/index.js:41:17)\n" +
          "```\n" +
          "참고 문서는 https://nodejs.org/api/errors.html#typeerror 입니다. " +
          "`renderSessionStore` 쪽이 의심됩니다.",
      ),
    ];
    const result = classifyWindowLanguage(window);
    // Raw, the English inside the fence outnumbers the Hangul several times over.
    expect(window[0].user_message.match(/[A-Za-z]/g)!.length).toBeGreaterThan(result.hangul);
    expect(result.language).toBe("ko");
    expect(result.latin).toBeLessThan(result.hangul);
  });

  it("weights a Hangul syllable at 2.5 Latin letters — the units are not comparable raw", () => {
    // The case the weight exists for. Raw, this sentence is 13 Hangul against 15
    // Latin and would classify as ENGLISH: a plainly Korean sentence, judged
    // English because it names two products. A syllable block carries about a
    // word; a letter carries a phoneme.
    const sentence = classifyWindowLanguage([ex("Flutter 상태관리는 Riverpod으로 결정했습니다.")]);
    expect(sentence.hangul).toBe(13);
    expect(sentence.latin).toBe(15);
    expect(HANGUL_WEIGHT).toBe(2.5);
    expect(sentence.koScore).toBe(32.5);
    expect(sentence.enScore).toBe(15);
    expect(sentence.language).toBe("ko");
    expect(sentence.decidedBy).toBe("majority");
  });

  it("keeps a Korean sentence Korean through a long path and a long identifier", () => {
    // 19 Hangul against 45 Latin: raw, the identifiers win outright. This is the
    // everyday shape of a Korean technical conversation, and it is the shape the
    // reporter's corpus was losing to English.
    const result = classifyWindowLanguage([
      ex(
        "세션 저장소 경로를 src/continuity-store.ts 의 readExtractionTargetItems 에서 " +
          "읽도록 바꿨습니다.",
      ),
    ]);
    expect(result.hangul).toBe(19);
    expect(result.latin).toBe(45);
    expect(result.koScore).toBe(47.5);
    expect(result.language).toBe("ko");
  });

  it("keeps an English sentence English when one Korean word appears in it", () => {
    // The weight must not turn any stray Hangul into a Korean verdict: 2 Hangul
    // weighs 5, against 47 Latin letters of English prose.
    const result = classifyWindowLanguage([
      ex("We keep the 한글 label on the button so translators can find it."),
    ]);
    expect(result.hangul).toBe(2);
    expect(result.koScore).toBe(5);
    expect(result.enScore).toBe(47);
    expect(result.language).toBe("en");
  });

  it("breaks an exact tie with the LAST human message that said anything", () => {
    // Two turns of identical WEIGHT, one each way: 2 Hangul weigh 5, and so do 5
    // Latin letters. The window total ties, so the most recent human turn
    // decides — it is the one the next fact is about. 2.5 is exact in binary
    // floating point, so this really is an equality and not a near-miss.
    const koThenEn = classifyWindowLanguage([ex("가나"), ex("abcde")]);
    expect(koThenEn.koScore).toBe(koThenEn.enScore);
    expect(koThenEn.language).toBe("en");
    expect(koThenEn.decidedBy).toBe("tie_last_human");

    const enThenKo = classifyWindowLanguage([ex("abcde"), ex("가나")]);
    expect(enThenKo.koScore).toBe(enThenKo.enScore);
    expect(enThenKo.language).toBe("ko");
    expect(enThenKo.decidedBy).toBe("tie_last_human");
  });

  it("decides nothing when the tie-breaking message is itself tied", () => {
    const result = classifyWindowLanguage([ex("가나 abcde")]);
    expect(result.koScore).toBe(result.enScore);
    expect(result.language).toBeNull();
    expect(result.decidedBy).toBe("tie_unresolved");
  });

  it("returns null when there is no human prose at all", () => {
    // A tool-only window: the rows carry tool evidence, never human text. This
    // module does not read `tool_evidence`, so the answer is "no opinion".
    const toolOnly = [
      { user_message: "", assistant_message: "", tool_evidence: [{ tool_result: "database = sqlite" }] },
      { user_message: "   \n\t ", assistant_message: "" },
      { user_message: "```\nSELECT * FROM facts WHERE active = 1;\n```" },
      { user_message: "https://example.com/build/log/12345" },
    ];
    const result = classifyWindowLanguage(toolOnly);
    expect(result.language).toBeNull();
    expect(result.decidedBy).toBe("no_human_text");
    expect(result.countedMessages).toBe(0);
    expect(detectWindowLanguage([])).toBeNull();
    expect(detectWindowLanguage(null)).toBeNull();
  });
});

describe("the language clause (#123 §2)", () => {
  it("names the language and protects identifiers", () => {
    expect(renderExtractionLanguageClause("ko")).toContain(
      "Write `fact` (and subject_key stays snake_case ASCII) in Korean; " +
        "keep code identifiers, paths and product names verbatim.",
    );
    expect(renderExtractionLanguageClause("en")).toContain(
      "Write `fact` (and subject_key stays snake_case ASCII) in English; " +
        "keep code identifiers, paths and product names verbatim.",
    );
    expect(renderExtractionLanguageClause("ko")).toBe(renderExtractionLanguageClause("ko"));
  });

  it("is EMPTY with no language, and then the prompt is byte-identical", () => {
    expect(renderExtractionLanguageClause(null)).toBe("");
    expect(appendExtractionLanguageClause("BASE", null)).toBe("BASE");
    expect(appendExtractionLanguageClause("BASE", undefined)).toBe("BASE");
    expect(appendExtractionLanguageClause(EXTRACTION_SYSTEM_PROMPT, null)).toBe(
      EXTRACTION_SYSTEM_PROMPT,
    );
  });

  it("APPENDS — the base prompt constant is never edited", () => {
    const composed = appendExtractionLanguageClause(EXTRACTION_SYSTEM_PROMPT, "ko");
    expect(composed.startsWith(`${EXTRACTION_SYSTEM_PROMPT}\n\n`)).toBe(true);
    expect(composed.slice(EXTRACTION_SYSTEM_PROMPT.length + 2)).toBe(
      renderExtractionLanguageClause("ko"),
    );
    // The legacy fact_kr ban is still in force: the clause changes the language
    // of `fact`, it does not resurrect the translation field.
    expect(composed).toContain("Do not emit fact_kr");
  });

  it("goes AFTER the rule overlay block, so both survive", () => {
    const rules = {
      projectId: null,
      hash: "rules:9c1e4d07",
      revision: 3,
      preferredLanguage: "ko" as const,
      excludeTopics: ["급여"],
      neverExtract: [],
      decisionHints: [],
    };
    const composed = appendExtractionLanguageClause(
      composeExtractionSystemPrompt(EXTRACTION_SYSTEM_PROMPT, rules),
      "ko",
    );
    expect(composed).toContain("## User rule overlay (local, operator-authored)");
    expect(composed.indexOf("## Fact language")).toBeGreaterThan(
      composed.indexOf("## User rule overlay"),
    );
    // #123: the old "- Prefer fact_kr in Korean" bullet is gone. It told the
    // model to emit a field the base prompt forbids in the same breath.
    expect(composed).not.toContain("Prefer fact_kr in Korean");
  });

  it("renders no overlay block for a rule set whose only content is the language", () => {
    const languageOnly = {
      projectId: null,
      hash: "rules:9c1e4d07",
      revision: 3,
      preferredLanguage: "en" as const,
      excludeTopics: [],
      neverExtract: [],
      decisionHints: [],
    };
    expect(composeExtractionSystemPrompt("BASE", languageOnly)).toBe("BASE");
  });
});

describe("resolveExtractionLanguage — the override order (#123 §2)", () => {
  it("preferred_language beats the detected window language", () => {
    expect(resolveExtractionLanguage("en", "ko")).toEqual({ language: "en", source: "override" });
    expect(resolveExtractionLanguage("ko", "en")).toEqual({ language: "ko", source: "override" });
  });

  it("falls back to detection, then to nothing", () => {
    expect(resolveExtractionLanguage(null, "ko")).toEqual({ language: "ko", source: "window" });
    expect(resolveExtractionLanguage(undefined, "en")).toEqual({ language: "en", source: "window" });
    expect(resolveExtractionLanguage(null, null)).toEqual({ language: null, source: "none" });
  });
});

describe("summarizeAppliedLanguages — the target receipt (#123 §2)", () => {
  it("reports one language, disagreement as mixed, and nothing as null", () => {
    expect(summarizeAppliedLanguages(["ko", "ko"])).toBe("ko");
    expect(summarizeAppliedLanguages(["en", null])).toBe("en");
    expect(summarizeAppliedLanguages(["ko", "en"])).toBe("mixed");
    expect(summarizeAppliedLanguages([null, null])).toBeNull();
    expect(summarizeAppliedLanguages([])).toBeNull();
  });
});
