/**
 * The language a fact is written in (#123).
 *
 * A LEAF module with NO imports: the extractor, the CLI and the tests all read
 * it, and it must never pull the database, the overlay loader or the prompt
 * constant behind it.
 *
 * Why deterministic and not a model decision: the extraction prompt never named
 * a language, so the model defaulted to English even for an entirely Korean
 * conversation (112 of 127 active facts on the reporter's machine). Asking the
 * model to "use the conversation's language" moves the same guess one layer in.
 * Counting characters is reproducible, testable and free.
 *
 * What is counted: HUMAN message text only. Assistant turns are not evidence and
 * an assistant that answers in English does not make the conversation English.
 * Tool results never enter here at all — they live in `tool_evidence`, which
 * this module does not read. Inside a human message, fenced/inline code and URLs
 * are stripped first, because a Korean question wrapped around a 40-line English
 * stack trace is a Korean turn.
 *
 * The result is ADVISORY: it only picks which sentence is appended to the
 * prompt. It is never part of `policy_version`, never part of the scheduling
 * key, and it cannot make a candidate eligible or ineligible.
 *
 * WHY THE COUNT IS WEIGHTED. A raw character majority reads this project's real
 * conversations backwards. Korean technical prose is Korean sentences wrapped
 * around English identifiers, and the units are not comparable: a Hangul
 * syllable block is an onset-nucleus-coda cluster carrying roughly a word's
 * worth of information, while a Latin letter carries a phoneme. Counted raw,
 * "Flutter 상태관리는 Riverpod으로 결정했습니다." is 13 Hangul against 15 Latin
 * and classifies as ENGLISH — a plainly Korean sentence, judged English because
 * it names two products. So one Hangul syllable counts as `HANGUL_WEIGHT` Latin
 * letters. 2.5 sits in the middle of the two-to-three-letters-per-syllable range
 * and is exact in binary floating point, so the tie rule below stays a real
 * equality test and not an epsilon comparison.
 *
 * Both the raw counts and the weighted scores are exported: the weight is a
 * judgement, and the next person to revisit it should be able to see what it
 * did without re-deriving the inputs.
 */

/** The two languages the clause can name. */
export type ExtractionLanguage = "ko" | "en";

/** Where the applied language came from, for the receipt and for tests. */
export type ExtractionLanguageSource = "override" | "window" | "none";

/**
 * Latin letters one Hangul syllable is worth. See the module note: a syllable
 * block is about a word, a letter is about a phoneme. Exact in binary floating
 * point, which is what lets the tie rule below be a plain `===`.
 */
export const HANGUL_WEIGHT = 2.5;

export interface WindowLanguageClassification {
  /** The decided language, or `null` when the window decides nothing. */
  language: ExtractionLanguage | null;
  /** RAW Hangul characters counted across the window's human prose. */
  hangul: number;
  /** RAW Latin letters counted across the window's human prose. */
  latin: number;
  /** The weighted Korean side of the comparison: `hangul * HANGUL_WEIGHT`. */
  koScore: number;
  /** The weighted English side. Latin letters are the unit, so this is `latin`. */
  enScore: number;
  /** Human messages that contributed at least one counted character. */
  countedMessages: number;
  /** Which branch decided, so a test can assert the reason and not just the answer. */
  decidedBy: "majority" | "tie_last_human" | "tie_unresolved" | "no_human_text";
}

/** The only shape this module needs from an extraction window row. */
export interface HumanTextSource {
  user_message?: string | null;
}

/**
 * Hangul: precomposed syllables plus the jamo blocks, so a decomposed or
 * IME-intermediate string is not silently counted as "no Korean".
 */
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]/gu;

/** Latin letters, including the accented ranges other Latin-script languages use. */
const LATIN = /[A-Za-zÀ-ɏ]/gu;

/**
 * Remove the parts of a human message that are not the human's prose.
 *
 * Deliberately narrow: fenced code, inline code spans and URLs. Anything else —
 * quoted English product copy, a pasted sentence — is prose the human chose to
 * include, and counting it is the honest reading of "what language is this
 * conversation in".
 */
function humanProse(raw: string | null | undefined): string {
  const text = typeof raw === "string" ? raw : "";
  if (text === "") return "";
  return (
    text
      // Fenced blocks first, terminated or running to the end of the message.
      .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, " ")
      // Then inline spans, which the fence pass can no longer be confused by.
      .replace(/`[^`\n]*`/g, " ")
      .replace(/\b(?:https?|ftp|file):\/\/\S+/gi, " ")
      .replace(/\bwww\.\S+/gi, " ")
      // Harness transport wrappers. `isContextEligibleExchange` already splits
      // these out of a window; stripping them here keeps the function honest
      // when it is called on a raw list.
      .replace(
        /<\/?(?:local-command-stdout|local-command-caveat|command-name|command-message|command-args|system-reminder)>/gi,
        " ",
      )
  );
}

function countChars(text: string): { hangul: number; latin: number } {
  return {
    hangul: text.match(HANGUL)?.length ?? 0,
    latin: text.match(LATIN)?.length ?? 0,
  };
}

/**
 * Classify one extraction window by WEIGHTED character majority over human prose.
 *
 * Ties fall back to the LAST human message that carried any counted text: in a
 * mixed window the most recent human turn is the one the next fact is about. A
 * last message that is itself tied decides nothing (`tie_unresolved`) rather
 * than inventing a winner, and a window with no human prose at all returns
 * `no_human_text`. Both leave `language` null, and a null language appends no
 * clause — the model then chooses, exactly as it does today.
 */
export function classifyWindowLanguage(
  exchanges: readonly HumanTextSource[] | null | undefined,
): WindowLanguageClassification {
  let hangul = 0;
  let latin = 0;
  let countedMessages = 0;
  let lastCounted: { hangul: number; latin: number } | null = null;

  for (const exchange of exchanges ?? []) {
    const counts = countChars(humanProse(exchange?.user_message));
    if (counts.hangul === 0 && counts.latin === 0) continue;
    hangul += counts.hangul;
    latin += counts.latin;
    countedMessages += 1;
    lastCounted = counts;
  }

  const koScore = hangul * HANGUL_WEIGHT;
  const enScore = latin;
  const shape = { hangul, latin, koScore, enScore, countedMessages };

  if (countedMessages === 0) {
    return { language: null, ...shape, decidedBy: "no_human_text" };
  }
  if (koScore !== enScore) {
    return { language: koScore > enScore ? "ko" : "en", ...shape, decidedBy: "majority" };
  }
  // Tie on the window. The last human message that said anything breaks it.
  const last = lastCounted!;
  const lastKo = last.hangul * HANGUL_WEIGHT;
  if (lastKo === last.latin) {
    return { language: null, ...shape, decidedBy: "tie_unresolved" };
  }
  return { language: lastKo > last.latin ? "ko" : "en", ...shape, decidedBy: "tie_last_human" };
}

/** The answer alone. `null` means "this window does not decide". */
export function detectWindowLanguage(
  exchanges: readonly HumanTextSource[] | null | undefined,
): ExtractionLanguage | null {
  return classifyWindowLanguage(exchanges).language;
}

/**
 * `preferred_language` (explicit operator override) beats detection, detection
 * beats nothing, and "nothing" means no clause at all.
 */
export function resolveExtractionLanguage(
  preferred: ExtractionLanguage | null | undefined,
  detected: ExtractionLanguage | null | undefined,
): { language: ExtractionLanguage | null; source: ExtractionLanguageSource } {
  if (preferred === "ko" || preferred === "en") return { language: preferred, source: "override" };
  if (detected === "ko" || detected === "en") return { language: detected, source: "window" };
  return { language: null, source: "none" };
}

const LANGUAGE_NAME: Record<ExtractionLanguage, string> = { ko: "Korean", en: "English" };

/**
 * The clause itself. One sentence, deterministic, and `""` when no language was
 * decided — an installation that decides nothing therefore sends a
 * byte-identical prompt to the one it sent before this feature existed.
 *
 * `subject_key` is called out because it is a machine slot, not prose: a Korean
 * fact with a Korean subject_key would stop colliding with the same slot written
 * from an English conversation, which is the whole point of the slot.
 */
export function renderExtractionLanguageClause(
  language: ExtractionLanguage | null | undefined,
): string {
  if (language !== "ko" && language !== "en") return "";
  return [
    "## Fact language",
    `Write \`fact\` (and subject_key stays snake_case ASCII) in ${LANGUAGE_NAME[language]}; ` +
      "keep code identifiers, paths and product names verbatim.",
  ].join("\n");
}

/**
 * `base` + `\n\n` + clause, or `base` unchanged.
 *
 * APPENDS, exactly like the rule overlay's clause: `EXTRACTION_SYSTEM_PROMPT`
 * stays byte-identical, so `FACT_EXTRACTION_POLICY_VERSION` keeps meaning what
 * it meant and one conversation's language can never mark the corpus for
 * re-extraction.
 */
export function appendExtractionLanguageClause(
  base: string,
  language: ExtractionLanguage | null | undefined,
): string {
  const clause = renderExtractionLanguageClause(language);
  return clause === "" ? base : `${base}\n\n${clause}`;
}

/**
 * Summarise the languages one claim actually ran under, for the target receipt.
 * A claim whose windows disagreed is recorded as `mixed` rather than as
 * whichever window happened to be last.
 */
export function summarizeAppliedLanguages(
  languages: Iterable<ExtractionLanguage | null>,
): "ko" | "en" | "mixed" | null {
  const seen = new Set<ExtractionLanguage>();
  for (const language of languages) {
    if (language === "ko" || language === "en") seen.add(language);
  }
  if (seen.size === 0) return null;
  if (seen.size > 1) return "mixed";
  return [...seen][0];
}
