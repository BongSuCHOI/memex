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
/**
 * Latin letters one Hangul syllable is worth. See the module note: a syllable
 * block is about a word, a letter is about a phoneme. Exact in binary floating
 * point, which is what lets the tie rule below be a plain `===`.
 */
export const HANGUL_WEIGHT = 2.5;
/**
 * Hangul: precomposed syllables plus the jamo blocks, so a decomposed or
 * IME-intermediate string is not silently counted as "no Korean".
 */
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]/gu;
/** Latin letters, including the accented ranges other Latin-script languages use. */
const LATIN = /[A-Za-zÀ-ɏ]/gu;
/** Opening fence run plus its info string, wherever a fence starts. */
const FENCE_OPEN = /(`{3,}|~{3,})[^\n]*/g;
/**
 * Replace every fenced code block with a space, terminated or running to EOF.
 *
 * The CLOSING fence has to be a line of its own — the same fence CHARACTER and
 * nothing else on the line. Without that condition a `"```"` literal INSIDE the
 * block closes it, and the rest of the code is then counted as the human's
 * prose: a Korean question about a JavaScript file flips to `en` on the strength
 * of its own identifiers (post-0.7.5 review P2 #2).
 *
 * Length is `>= opener`, not `=== opener` (post-0.7.6 review P2 #2). CommonMark
 * closes a fence with a run of the same character AT LEAST as long, so ` ``` `
 * closed by ` ```` ` is a closed block — the old backreference made that an
 * UNCLOSED one and swallowed the Korean question after it all the way to EOF.
 * The same fix reads in the other direction too: a shorter run still cannot
 * close (` ``` ` never closes ` ```` `), and `~~~` is never closed by backticks.
 *
 * A closing line may carry up to three leading spaces and any trailing spaces or
 * tabs, and may end with `\r` — a message pasted with CRLF line endings is the
 * same message, and treating it as unclosed was the other half of the same bug.
 */
function stripFencedBlocks(text) {
    let out = "";
    let cursor = 0;
    FENCE_OPEN.lastIndex = 0;
    let open;
    while ((open = FENCE_OPEN.exec(text)) !== null) {
        const run = open[1];
        out += text.slice(cursor, open.index) + " ";
        const bodyAt = open.index + open[0].length;
        // `run[0]` is a backtick or a tilde — neither is a regex metacharacter.
        const close = new RegExp(`\\n[ \\t]{0,3}${run[0]}{${run.length},}[ \\t]*\\r?(?=\\n|$)`);
        const found = close.exec(text.slice(bodyAt));
        cursor = found ? bodyAt + found.index + found[0].length : text.length;
        FENCE_OPEN.lastIndex = cursor;
    }
    return out + text.slice(cursor);
}
/**
 * Remove the parts of a human message that are not the human's prose.
 *
 * Deliberately narrow: fenced code, inline code spans and URLs. Anything else —
 * quoted English product copy, a pasted sentence — is prose the human chose to
 * include, and counting it is the honest reading of "what language is this
 * conversation in".
 */
function humanProse(raw) {
    const text = typeof raw === "string" ? raw : "";
    if (text === "")
        return "";
    return (
    // Fenced blocks first, terminated or running to the end of the message.
    stripFencedBlocks(text)
        // Then inline spans, which the fence pass can no longer be confused by.
        .replace(/`[^`\n]*`/g, " ")
        .replace(/\b(?:https?|ftp|file):\/\/\S+/gi, " ")
        .replace(/\bwww\.\S+/gi, " ")
        // Harness transport wrappers. `isContextEligibleExchange` already splits
        // these out of a window; stripping them here keeps the function honest
        // when it is called on a raw list.
        .replace(/<\/?(?:local-command-stdout|local-command-caveat|command-name|command-message|command-args|system-reminder)>/gi, " "));
}
function countChars(text) {
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
export function classifyWindowLanguage(exchanges) {
    let hangul = 0;
    let latin = 0;
    let countedMessages = 0;
    let lastCounted = null;
    for (const exchange of exchanges ?? []) {
        const counts = countChars(humanProse(exchange?.user_message));
        if (counts.hangul === 0 && counts.latin === 0)
            continue;
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
    const last = lastCounted;
    const lastKo = last.hangul * HANGUL_WEIGHT;
    if (lastKo === last.latin) {
        return { language: null, ...shape, decidedBy: "tie_unresolved" };
    }
    return { language: lastKo > last.latin ? "ko" : "en", ...shape, decidedBy: "tie_last_human" };
}
/** The answer alone. `null` means "this window does not decide". */
export function detectWindowLanguage(exchanges) {
    return classifyWindowLanguage(exchanges).language;
}
/**
 * The same weighted-majority reading of ONE string — the language a stored
 * sentence is already written in.
 *
 * Shares `humanProse` and the Hangul weight with the window classifier on
 * purpose: `scripts/translate-facts.mjs` uses it to skip facts that are already
 * Korean, and a fact full of English identifiers ("Riverpod으로 결정했습니다")
 * has to read the same way there as it does in the extraction window. `null`
 * means "this string does not decide" (no counted characters, or an exact tie),
 * and a caller that must not act on a guess should treat it as "unknown".
 */
export function classifyTextLanguage(text) {
    const counts = countChars(humanProse(text));
    const koScore = counts.hangul * HANGUL_WEIGHT;
    const enScore = counts.latin;
    const shape = { hangul: counts.hangul, latin: counts.latin, koScore, enScore };
    if (counts.hangul === 0 && counts.latin === 0)
        return { language: null, ...shape };
    if (koScore === enScore)
        return { language: null, ...shape };
    return { language: koScore > enScore ? "ko" : "en", ...shape };
}
/** `classifyTextLanguage` without the counts. */
export function detectTextLanguage(text) {
    return classifyTextLanguage(text).language;
}
/**
 * `preferred_language` (explicit operator override) beats detection, detection
 * beats nothing, and "nothing" means no clause at all.
 */
export function resolveExtractionLanguage(preferred, detected) {
    if (preferred === "ko" || preferred === "en")
        return { language: preferred, source: "override" };
    if (detected === "ko" || detected === "en")
        return { language: detected, source: "window" };
    return { language: null, source: "none" };
}
const LANGUAGE_NAME = { ko: "Korean", en: "English" };
/**
 * The clause itself. One sentence, deterministic, and `""` when no language was
 * decided — an installation that decides nothing therefore sends a
 * byte-identical prompt to the one it sent before this feature existed.
 *
 * `subject_key` is called out because it is a machine slot, not prose: a Korean
 * fact with a Korean subject_key would stop colliding with the same slot written
 * from an English conversation, which is the whole point of the slot.
 */
export function renderExtractionLanguageClause(language) {
    if (language !== "ko" && language !== "en")
        return "";
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
export function appendExtractionLanguageClause(base, language) {
    const clause = renderExtractionLanguageClause(language);
    return clause === "" ? base : `${base}\n\n${clause}`;
}
/**
 * Summarise the languages one claim actually ran under, for the target receipt.
 * A claim whose windows disagreed is recorded as `mixed` rather than as
 * whichever window happened to be last.
 */
export function summarizeAppliedLanguages(languages) {
    const seen = new Set();
    for (const language of languages) {
        if (language === "ko" || language === "en")
            seen.add(language);
    }
    if (seen.size === 0)
        return null;
    if (seen.size > 1)
        return "mixed";
    return [...seen][0];
}
