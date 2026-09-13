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
 * KNOWN BIAS, stated rather than silently corrected: the approved rule is a raw
 * character-count majority (#123, "글자 수 다수결"), and one Hangul syllable
 * carries roughly two to three Latin letters' worth of text. A short Korean
 * sentence carrying two English product names — "Flutter 상태관리는 Riverpod으로
 * 결정했습니다." is 13 Hangul against 15 Latin — therefore classifies as English.
 * A weighting would fix that and would also be a policy nobody approved, so the
 * counts are exported: if the reporter's corpus shows this misfiring, the fix is
 * a weight here, not a rewrite anywhere else. `preferred_language` is the
 * operator's escape hatch in the meantime.
 */
/** The two languages the clause can name. */
export type ExtractionLanguage = "ko" | "en";
/** Where the applied language came from, for the receipt and for tests. */
export type ExtractionLanguageSource = "override" | "window" | "none";
export interface WindowLanguageClassification {
    /** The decided language, or `null` when the window decides nothing. */
    language: ExtractionLanguage | null;
    /** Hangul characters counted across the window's human prose. */
    hangul: number;
    /** Latin letters counted across the window's human prose. */
    latin: number;
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
 * Classify one extraction window by character-count majority over human prose.
 *
 * Ties fall back to the LAST human message that carried any counted text: in a
 * mixed window the most recent human turn is the one the next fact is about. A
 * last message that is itself tied decides nothing (`tie_unresolved`) rather
 * than inventing a winner, and a window with no human prose at all returns
 * `no_human_text`. Both leave `language` null, and a null language appends no
 * clause — the model then chooses, exactly as it does today.
 */
export declare function classifyWindowLanguage(exchanges: readonly HumanTextSource[] | null | undefined): WindowLanguageClassification;
/** The answer alone. `null` means "this window does not decide". */
export declare function detectWindowLanguage(exchanges: readonly HumanTextSource[] | null | undefined): ExtractionLanguage | null;
/**
 * `preferred_language` (explicit operator override) beats detection, detection
 * beats nothing, and "nothing" means no clause at all.
 */
export declare function resolveExtractionLanguage(preferred: ExtractionLanguage | null | undefined, detected: ExtractionLanguage | null | undefined): {
    language: ExtractionLanguage | null;
    source: ExtractionLanguageSource;
};
/**
 * The clause itself. One sentence, deterministic, and `""` when no language was
 * decided — an installation that decides nothing therefore sends a
 * byte-identical prompt to the one it sent before this feature existed.
 *
 * `subject_key` is called out because it is a machine slot, not prose: a Korean
 * fact with a Korean subject_key would stop colliding with the same slot written
 * from an English conversation, which is the whole point of the slot.
 */
export declare function renderExtractionLanguageClause(language: ExtractionLanguage | null | undefined): string;
/**
 * `base` + `\n\n` + clause, or `base` unchanged.
 *
 * APPENDS, exactly like the rule overlay's clause: `EXTRACTION_SYSTEM_PROMPT`
 * stays byte-identical, so `FACT_EXTRACTION_POLICY_VERSION` keeps meaning what
 * it meant and one conversation's language can never mark the corpus for
 * re-extraction.
 */
export declare function appendExtractionLanguageClause(base: string, language: ExtractionLanguage | null | undefined): string;
/**
 * Summarise the languages one claim actually ran under, for the target receipt.
 * A claim whose windows disagreed is recorded as `mixed` rather than as
 * whichever window happened to be last.
 */
export declare function summarizeAppliedLanguages(languages: Iterable<ExtractionLanguage | null>): "ko" | "en" | "mixed" | null;
