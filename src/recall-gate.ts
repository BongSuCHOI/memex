/**
 * Phase 5 pre-retrieval cheap gate (RFC §12.3).
 *
 * Runs before any embedding, vector search, relation expansion or model call.
 * It decides from local session state and a cheap lexical fingerprint whether
 * the prompt needs recall (`retrieve`), clearly does not (`skip`), or is
 * ambiguous (`ambiguous`: exactly one embedding is allowed, and that embedding
 * is reused for retrieval). The gate itself never calls an LLM.
 */

export interface RecallGateConfig {
  /** Prompts with at most this many tokens can be acknowledgements/continuations. */
  ackMaxTokens: number;
  /** Substantive prompts since the last retrieval that force a safety refresh. */
  safetyRefreshInterval: number;
  /** Jaccard below this against the topic fingerprint is significant drift (needs ≥ driftMinTokens). */
  driftJaccard: number;
  driftMinTokens: number;
  /** Prompt tokens needed before "no resident coverage" triggers. */
  coverageMinTokens: number;
  /**
   * Ambiguous path: the prompt is coherent with the current topic when
   * cos(prompt, topic) exceeds the prompt's own background baseline by this
   * margin (the same probe-relative rule retrieval uses, so it is not tied to
   * one embedding model's absolute scale).
   */
  coherentMargin: number;
  /** Tokens above which a prompt is substantive even without other signals. */
  substantiveMinTokens: number;
  /** Jaccard against the topic fingerprint at or above which a substantive prompt is a lexical continuation (no embedding). */
  lexicalCoherentJaccard: number;
}

export const DEFAULT_RECALL_GATE_CONFIG: RecallGateConfig = {
  ackMaxTokens: 4,
  safetyRefreshInterval: 6,
  driftJaccard: 0.12,
  driftMinTokens: 5,
  coverageMinTokens: 8,
  coherentMargin: 0.08,
  substantiveMinTokens: 5,
  lexicalCoherentJaccard: 0.35,
};

export type RecallTrigger =
  | "explicit_memory_intent"
  | "first_substantive_in_epoch"
  | "context_epoch_changed"
  | "compact_first_prompt"
  | "capsule_generation_changed"
  | "project_revision_stale"
  | "resident_revision_stale"
  | "hot_evidence_pending"
  | "incident_signature_match"
  | "high_impact_intent"
  | "safety_refresh"
  | "topic_drift"
  | "low_resident_coverage"
  | "embedding_drift"
  | "no_topic_embedding";

export type RecallSkipReason =
  | "acknowledgement"
  | "continuation"
  | "minor_correction"
  | "coherent_topic"
  | "empty_prompt";

export interface PromptIntents {
  /** why / history / source / when / previous / repeated — explicit memory question. */
  memory: boolean;
  /** why / rationale / related decision / dependency / contradiction / architecture — enables graph/TRACE. */
  trace: boolean;
  /** decide / switch / migrate / rollback / change — high-impact decision prompt. */
  highImpact: boolean;
  acknowledgement: boolean;
  continuation: boolean;
}

export interface RecallGateState {
  contextEpoch: number;
  lastRetrievalEpoch: number;
  lastSource: string | null;
  capsuleGenerationSeen: number;
  memoryRevisionSeen: number;
  topicFingerprint: string[];
  hasTopicEmbedding: boolean;
  informativePromptsSinceRetrieval: number;
  residentTokens: Set<string>;
}

export interface RecallGateInput {
  prompt: string;
  state: RecallGateState;
  currentCapsuleGeneration: number;
  currentProjectRevision: number;
  incidentMatched: boolean;
  /**
   * A revision resident in this epoch moved to a newer semantic/lifecycle
   * generation or was deactivated. Workstream truth changes carry no project
   * revision token (BRANCH TRUTH), so residency itself is the invalidation
   * signal (RFC §11.4, §12.6).
   */
  residentRevisionStale?: boolean;
  hotEvidencePending?: boolean;
  config?: Partial<RecallGateConfig>;
  /**
   * Issue #29: the user overlay's contribution, already evaluated elsewhere.
   * Absent (the default, and every installation without an overlay file) means
   * this gate behaves exactly as it did in 0.6.9.
   */
  userHits?: UserIntentHits;
}

export interface RecallGateDecision {
  action: "retrieve" | "skip" | "ambiguous";
  triggers: RecallTrigger[];
  skipReason: RecallSkipReason | null;
  intents: PromptIntents;
  tokens: string[];
  substantive: boolean;
  /** Jaccard of the prompt tokens against the topic fingerprint (null when no fingerprint). */
  topicOverlap: number | null;
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "are", "it", "this", "that", "with",
  "be", "as", "at", "by", "we", "i", "you", "do", "can", "please", "let", "me", "us", "our", "my", "your",
  "은", "는", "이", "가", "을", "를", "에", "의", "로", "으로", "와", "과", "도", "좀", "그", "저", "것", "수",
  "해", "해줘", "하자", "해요", "합니다", "있어", "없어", "그리고", "또", "그럼",
]);

/**
 * Built-in gate catalogue (issue #29, 0.7.0) — a BEHAVIOUR-PRESERVING refactor.
 *
 * Until 0.6.9 the three intent detectors were single giant alternations, which
 * made two things impossible: turning ONE term off, and saying which term made
 * the gate fire. Both are the whole point of a user overlay, so the literals
 * are now id-bearing term lists that are COMPOSED back into the same regex.
 *
 * `test/recall-gate-catalog.test.ts` holds the v0.6.9 literals verbatim and
 * asserts the composed `source` is byte-identical to them. That golden is the
 * only direct evidence that decomposing the alternation did not move a single
 * gate verdict; keep it passing or the refactor has silently changed recall.
 *
 * `form`:
 *  - `alternative` — one branch of a composed alternation (the intent regexes).
 *  - `whole`       — a standalone regex that was already its own array element.
 */
export type GateIntent =
  | "memory"
  | "trace"
  | "highImpact"
  | "acknowledgement"
  | "continuation"
  | "minorCorrection";

export type GateLexicon = "ack" | "continue" | "filler";

export interface BuiltinGatePattern {
  /** Stable, user-facing id: `<prefix>.<lang>.<slug>`. Never renumbered. */
  id: string;
  intent: GateIntent;
  source: string;
  flags: string;
  form: "alternative" | "whole";
}

/**
 * Hits the caller precomputed for the USER's overlay patterns.
 *
 * `recall-gate.ts` is a pure, synchronous, fs-free module and it NEVER executes
 * a user-authored regex: user patterns run only inside the time-boxed matcher
 * worker (src/overlay-matcher.ts), and only the resulting ids arrive here.
 */
export interface UserIntentHits {
  /** Overlay pattern ids that fired, per intent. */
  intents: Partial<Record<GateIntent, readonly string[]>>;
  /** Built-in catalogue ids the overlay disabled. */
  disabledPatterns?: readonly string[];
  /** Lexicon add/disable from the overlay (plain words — no regex involved). */
  words?: {
    add?: Partial<Record<GateLexicon, readonly string[]>>;
    disable?: Partial<Record<GateLexicon, readonly string[]>>;
  };
}

const MEMORY_TERMS: ReadonlyArray<readonly [string, string]> = [
  ["memory.en.why", "\\bwhy\\b"],
  ["memory.en.when", "\\bwhen\\b"],
  ["memory.en.history", "\\bhistory\\b"],
  ["memory.en.source", "\\bsource\\b"],
  ["memory.en.previous", "\\bprevious(ly)?\\b"],
  ["memory.en.before", "\\bbefore\\b"],
  ["memory.en.earlier", "\\bearlier\\b"],
  ["memory.en.repeat", "\\brepeat(ed|ing)?\\b"],
  ["memory.en.again", "\\bagain\\b"],
  ["memory.en.remember", "\\bremember\\b"],
  ["memory.en.recall", "\\brecall\\b"],
  ["memory.en.what-did-we", "\\bwhat did we\\b"],
  ["memory.en.what-was", "\\bwhat was\\b"],
  ["memory.en.how-did", "\\bhow did\\b"],
  ["memory.en.where-did", "\\bwhere did\\b"],
  ["memory.en.origin", "\\borigin\\b"],
  ["memory.en.decided", "\\bdecided\\b"],
  ["memory.kr.왜", "왜"],
  ["memory.kr.언제", "언제"],
  ["memory.kr.이전", "이전"],
  ["memory.kr.예전", "예전"],
  ["memory.kr.과거", "과거"],
  ["memory.kr.전에", "전에"],
  ["memory.kr.기록", "기록"],
  ["memory.kr.출처", "출처"],
  ["memory.kr.근거", "근거"],
  ["memory.kr.이유", "이유"],
  ["memory.kr.히스토리", "히스토리"],
  ["memory.en.history-plain", "history"],
  ["memory.kr.반복", "반복"],
  ["memory.kr.또", "또\\s*(그|이)"],
  ["memory.kr.기억", "기억"],
  ["memory.kr.다시", "다시"],
  ["memory.kr.했었", "했었"],
  ["memory.kr.였었", "였었"],
  ["memory.kr.결정했", "결정했"],
  ["memory.kr.정했", "정했"],
  ["memory.kr.바꿨", "바꿨"],
  ["memory.kr.변경했", "변경했"],
  ["memory.kr.어디서", "어디서"],
];

const TRACE_TERMS: ReadonlyArray<readonly [string, string]> = [
  ["trace.en.why", "\\bwhy\\b"],
  ["trace.en.rationale", "\\brationale\\b"],
  ["trace.en.reason", "\\breason\\b"],
  ["trace.en.related", "\\brelated\\b"],
  ["trace.en.depend", "\\bdepend"],
  ["trace.en.contradict", "\\bcontradict"],
  ["trace.en.conflict", "\\bconflict"],
  ["trace.en.architecture", "\\barchitecture\\b"],
  ["trace.en.trace", "\\btrace\\b"],
  ["trace.en.history", "\\bhistory\\b"],
  ["trace.en.source", "\\bsource\\b"],
  ["trace.kr.왜", "왜"],
  ["trace.kr.이유", "이유"],
  ["trace.kr.근거", "근거"],
  ["trace.kr.관련", "관련"],
  ["trace.kr.의존", "의존"],
  ["trace.kr.모순", "모순"],
  ["trace.kr.충돌", "충돌"],
  ["trace.kr.아키텍처", "아키텍처"],
  ["trace.kr.추적", "추적"],
  ["trace.kr.출처", "출처"],
  ["trace.kr.히스토리", "히스토리"],
  ["trace.en.history-plain", "history"],
];

const HIGH_IMPACT_TERMS: ReadonlyArray<readonly [string, string]> = [
  ["high.en.decide", "\\bdecide\\b"],
  ["high.en.decision", "\\bdecision\\b"],
  ["high.en.switch", "\\bswitch(ing)?\\b"],
  ["high.en.migrate", "\\bmigrat(e|ion)\\b"],
  ["high.en.rollback", "\\brollback\\b"],
  ["high.en.roll-back", "\\broll back\\b"],
  ["high.en.revert", "\\brevert\\b"],
  ["high.en.replace", "\\breplace\\b"],
  ["high.en.drop", "\\bdrop\\b"],
  ["high.en.remove", "\\bremove\\b"],
  ["high.en.deprecate", "\\bdeprecate\\b"],
  ["high.en.change-the", "\\bchange the\\b"],
  ["high.en.adopt", "\\badopt\\b"],
  ["high.en.move-to", "\\bmove to\\b"],
  ["high.kr.결정", "결정"],
  ["high.kr.전환", "전환"],
  ["high.kr.마이그레이션", "마이그레이션"],
  ["high.kr.롤백", "롤백"],
  ["high.kr.되돌", "되돌"],
  ["high.kr.교체", "교체"],
  ["high.kr.제거", "제거"],
  ["high.kr.삭제", "삭제"],
  ["high.kr.바꾸", "바꾸"],
  ["high.kr.변경", "변경"],
  ["high.kr.도입", "도입"],
  ["high.kr.채택", "채택"],
  ["high.kr.옮기", "옮기"],
];

/** Standalone patterns: `[id, source, flags]`, in their original array order. */
const WHOLE_PATTERNS: ReadonlyArray<readonly [string, GateIntent, string, string]> = [
  [
    "ack.en.1",
    "acknowledgement",
    "^(ok|okay|k|yes|yep|yeah|no|nope|sure|thanks|thank you|thx|ty|cool|great|nice|good|got it|understood|done|fine|alright|perfect|sounds good)[.! ]*$",
    "i",
  ],
  [
    "ack.kr.1",
    "acknowledgement",
    "^(응|네|넵|넹|예|아니|아니요|고마워|고마워요|고맙습니다|감사|감사합니다|감사해요|좋아|좋아요|좋네|좋습니다|알겠어|알겠어요|알겠습니다|오케이|ㅇㅋ|ㅇㅇ|ㄱㄱ|굿|맞아|맞아요|그래|그래요|확인)[.! ~]*$",
    "",
  ],
  [
    "continue.en.1",
    "continuation",
    "^(continue|go on|keep going|next|proceed|carry on|go ahead|resume)[.! ]*$",
    "i",
  ],
  [
    "continue.kr.1",
    "continuation",
    "^(계속|진행|다음|이어서|이어)(해|하자|해줘|해줘요|해주세요|하세요|할게|할게요|해요|해봐|합시다|가자|으로 넘어가자|으로 넘어가요)?[.! ~]*$",
    "",
  ],
  ["continue.kr.2", "continuation", "^(가자|고|해줘|해봐|ㄱ)[.! ~]*$", ""],
  [
    "minor.en.1",
    "minorCorrection",
    "^(no|not that|the other one|wrong one|other|instead|actually|rather)\\b",
    "i",
  ],
  ["minor.kr.1", "minorCorrection", "^(아니|그거 말고|다른 거|다른거|말고|대신|그게 아니라)", ""],
];

function alternativeTerms(
  intent: GateIntent,
  terms: ReadonlyArray<readonly [string, string]>,
): BuiltinGatePattern[] {
  return terms.map(([id, source]) => ({ id, intent, source, flags: "i", form: "alternative" as const }));
}

export const BUILTIN_GATE_PATTERNS: readonly BuiltinGatePattern[] = Object.freeze([
  ...alternativeTerms("memory", MEMORY_TERMS),
  ...alternativeTerms("trace", TRACE_TERMS),
  ...alternativeTerms("highImpact", HIGH_IMPACT_TERMS),
  ...WHOLE_PATTERNS.map(([id, intent, source, flags]) => ({
    id,
    intent,
    source,
    flags,
    form: "whole" as const,
  })),
]);

/**
 * Compose one intent's ACTIVE alternation branches back into a single regex.
 *
 * The wrapping parentheses are load-bearing: the v0.6.9 literals are
 * `/(a|b|c)/i`, and the golden test compares `source` byte-for-byte. With every
 * branch disabled the answer is `null` (never fires) — an empty group `()`
 * would match the empty string and fire on EVERY prompt.
 */
function composeAlternation(terms: readonly BuiltinGatePattern[]): RegExp | null {
  if (terms.length === 0) return null;
  return new RegExp(`(${terms.map((term) => term.source).join("|")})`, "i");
}

export interface ComposedGatePatterns {
  memory: RegExp | null;
  trace: RegExp | null;
  highImpact: RegExp | null;
  acknowledgement: Array<{ id: string; re: RegExp }>;
  continuation: Array<{ id: string; re: RegExp }>;
  minorCorrection: Array<{ id: string; re: RegExp }>;
}

function buildComposed(disabled: ReadonlySet<string>): ComposedGatePatterns {
  const active = BUILTIN_GATE_PATTERNS.filter((pattern) => !disabled.has(pattern.id));
  const alternatives = (intent: GateIntent) =>
    active.filter((pattern) => pattern.intent === intent && pattern.form === "alternative");
  const wholes = (intent: GateIntent) =>
    active
      .filter((pattern) => pattern.intent === intent && pattern.form === "whole")
      .map((pattern) => ({ id: pattern.id, re: new RegExp(pattern.source, pattern.flags) }));
  return {
    memory: composeAlternation(alternatives("memory")),
    trace: composeAlternation(alternatives("trace")),
    highImpact: composeAlternation(alternatives("highImpact")),
    acknowledgement: wholes("acknowledgement"),
    continuation: wholes("continuation"),
    minorCorrection: wholes("minorCorrection"),
  };
}

const DEFAULT_COMPOSED = buildComposed(new Set());
/** Recomposition is only ever over the TRUSTED built-in catalogue, so it is
 * cheap and safe to cache by the disabled-id set. Bounded to keep a pathological
 * overlay from growing an unbounded map in the long-lived daemon. */
const composedCache = new Map<string, ComposedGatePatterns>();
const COMPOSED_CACHE_MAX = 8;

export function composeGatePatterns(disabledIds: readonly string[] = []): ComposedGatePatterns {
  if (disabledIds.length === 0) return DEFAULT_COMPOSED;
  const key = [...new Set(disabledIds)].sort().join(" ");
  const cached = composedCache.get(key);
  if (cached) return cached;
  const built = buildComposed(new Set(disabledIds));
  if (composedCache.size >= COMPOSED_CACHE_MAX) composedCache.clear();
  composedCache.set(key, built);
  return built;
}

// Korean particles and common verb endings attached to a stem. Stripping one
// trailing suffix keeps "클라이언트를"/"클라이언트" and "옵션도"/"옵션" on the
// same fingerprint token; the stem must keep at least two characters.
const KR_SUFFIX = /(해주세요|해줘요|합니다|하세요|했어요|해요|해줘|해봐|하자|할까|했어|했다|한다|해서|에서|에게|한테|으로|까지|부터|처럼|이랑|은|는|이|가|을|를|의|에|로|와|과|도|만|랑)$/u;

function normalizeToken(token: string): string {
  if (!/[\u3131-\uD79D]/u.test(token)) return token;
  const stripped = token.replace(KR_SUFFIX, "");
  return stripped.length >= 2 ? stripped : token;
}

export function tokenizePrompt(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    .map(normalizeToken)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / (left.size + right.size - overlap);
}

/**
 * Built-in lexicons. The WORD ITSELF is the id — there is nothing to compose and
 * nothing to execute, so the overlay's word add/disable is applied on the main
 * thread (§2.5). `new Set(array)` preserves the literal order, so iteration
 * order is unchanged from 0.6.9.
 */
export const BUILTIN_GATE_WORDS: Readonly<Record<GateLexicon, readonly string[]>> = Object.freeze({
  ack: Object.freeze([
    "ok", "okay", "k", "yes", "yep", "yeah", "no", "nope", "sure", "thanks", "thank", "thx", "ty", "cool",
    "great", "nice", "good", "got", "understood", "done", "fine", "alright", "perfect", "right", "awesome",
    "응", "네", "넵", "넹", "예", "아니", "아니요", "고마워", "고마워요", "고맙습니다", "감사", "감사합니다", "감사해요",
    "좋아", "좋아요", "좋네", "좋습니다", "알겠어", "알겠어요", "알겠습니다", "오케이", "ㅇㅋ", "ㅇㅇ", "굿", "맞아", "맞아요",
    "그래", "그래요", "확인",
  ]),
  continue: Object.freeze([
    "continue", "go", "on", "keep", "going", "next", "proceed", "carry", "ahead", "resume",
    "계속", "계속해", "계속해줘", "계속해줘요", "계속해주세요", "계속하자", "진행", "진행해", "진행해줘", "진행해주세요", "진행할게",
    "진행할게요", "다음", "다음으로", "넘어가자", "넘어가요", "넘어가", "이어서", "이어", "가자", "해줘", "해주세요", "해봐", "ㄱㄱ",
  ]),
  /** Words that carry no topic on their own; they never make a prompt substantive. */
  filler: Object.freeze([
    "you", "it", "that", "this", "the", "and", "then", "now", "please", "let", "lets", "s", "do", "for", "with",
    "sounds", "looks", "work", "job", "well", "really", "very", "much", "so", "all", "too",
    "저", "그", "좀", "요", "네요", "입니다", "이제", "그럼", "그러면", "일단",
  ]),
});

const ACK_WORDS = new Set(BUILTIN_GATE_WORDS.ack);
const CONTINUE_WORDS = new Set(BUILTIN_GATE_WORDS.continue);
const FILLER_WORDS = new Set(BUILTIN_GATE_WORDS.filler);
const DEFAULT_WORD_SETS: Readonly<Record<GateLexicon, ReadonlySet<string>>> = Object.freeze({
  ack: ACK_WORDS,
  continue: CONTINUE_WORDS,
  filler: FILLER_WORDS,
});

function effectiveWords(
  hits: UserIntentHits | undefined,
): Readonly<Record<GateLexicon, ReadonlySet<string>>> {
  const words = hits?.words;
  if (!words) return DEFAULT_WORD_SETS;
  const resolve = (lexicon: GateLexicon): ReadonlySet<string> => {
    const add = words.add?.[lexicon] ?? [];
    const disable = words.disable?.[lexicon] ?? [];
    if (add.length === 0 && disable.length === 0) return DEFAULT_WORD_SETS[lexicon];
    const next = new Set(DEFAULT_WORD_SETS[lexicon]);
    for (const word of disable) next.delete(word);
    for (const word of add) next.add(word);
    return next;
  };
  return { ack: resolve("ack"), continue: resolve("continue"), filler: resolve("filler") };
}

/** Which catalogue/overlay ids fired, per intent — the basis of `memex gate test`. */
export interface IntentExplanation {
  intents: PromptIntents;
  matched: Record<GateIntent, Array<{ id: string; origin: "builtin" | "user" }>>;
}

function emptyMatched(): IntentExplanation["matched"] {
  return {
    memory: [], trace: [], highImpact: [], acknowledgement: [], continuation: [], minorCorrection: [],
  };
}

/**
 * Per-term explanation. Built-in terms are re-tested INDIVIDUALLY here — they
 * are a trusted, fixed set, so running them on the main thread is the same
 * trust decision 0.6.9 already made. User patterns are never executed: their
 * ids arrive precomputed from the matcher worker.
 */
function explain(prompt: string, hits?: UserIntentHits): IntentExplanation {
  const trimmed = prompt.trim();
  const composed = composeGatePatterns(hits?.disabledPatterns ?? []);
  const disabled = new Set(hits?.disabledPatterns ?? []);
  const words = effectiveWords(hits);
  const rawTokens = trimmed.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const allAck = rawTokens.length > 0 &&
    rawTokens.every((token) => words.ack.has(token) || words.continue.has(token) || words.filler.has(token));
  const matched = emptyMatched();
  const userIds = (intent: GateIntent): readonly string[] => hits?.intents?.[intent] ?? [];
  for (const intent of ["memory", "trace", "highImpact", "acknowledgement", "continuation", "minorCorrection"] as const) {
    for (const id of userIds(intent)) matched[intent].push({ id, origin: "user" });
  }

  const ackPatternHit = composed.acknowledgement.filter(({ re }) => re.test(trimmed));
  const continuePatternHit = composed.continuation.filter(({ re }) => re.test(trimmed));
  for (const hit of ackPatternHit) matched.acknowledgement.unshift({ id: hit.id, origin: "builtin" });
  for (const hit of continuePatternHit) matched.continuation.unshift({ id: hit.id, origin: "builtin" });

  const acknowledgement = ackPatternHit.length > 0 || userIds("acknowledgement").length > 0 ||
    (allAck && rawTokens.some((token) => words.ack.has(token)));
  const continuation = continuePatternHit.length > 0 || userIds("continuation").length > 0 ||
    (allAck && !acknowledgement && rawTokens.some((token) => words.continue.has(token)));

  for (const intent of ["memory", "trace", "highImpact"] as const) {
    const composedRe = composed[intent];
    if (!composedRe || !composedRe.test(trimmed)) continue;
    for (const term of BUILTIN_GATE_PATTERNS) {
      if (term.intent !== intent || term.form !== "alternative" || disabled.has(term.id)) continue;
      if (new RegExp(term.source, term.flags).test(trimmed)) {
        matched[intent].unshift({ id: term.id, origin: "builtin" });
      }
    }
  }

  return {
    intents: {
      memory: matched.memory.length > 0,
      trace: matched.trace.length > 0,
      highImpact: matched.highImpact.length > 0,
      acknowledgement,
      continuation,
    },
    matched,
  };
}

export function detectPromptIntents(prompt: string, hits?: UserIntentHits): PromptIntents {
  const trimmed = prompt.trim();
  // Fast path — no overlay at all: byte-for-byte the 0.6.9 procedure, with the
  // composed regexes standing in for the literals and no per-term re-test.
  if (!hits || (hits.disabledPatterns?.length ?? 0) === 0) {
    const composed = DEFAULT_COMPOSED;
    const words = effectiveWords(hits);
    const rawTokens = trimmed.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    const allAck = rawTokens.length > 0 &&
      rawTokens.every((token) => words.ack.has(token) || words.continue.has(token) || words.filler.has(token));
    const userAck = hits?.intents?.acknowledgement?.length ?? 0;
    const userContinue = hits?.intents?.continuation?.length ?? 0;
    const acknowledgement = composed.acknowledgement.some(({ re }) => re.test(trimmed)) || userAck > 0 ||
      (allAck && rawTokens.some((token) => words.ack.has(token)));
    const continuation = composed.continuation.some(({ re }) => re.test(trimmed)) || userContinue > 0 ||
      (allAck && !acknowledgement && rawTokens.some((token) => words.continue.has(token)));
    return {
      memory: (composed.memory?.test(trimmed) ?? false) || (hits?.intents?.memory?.length ?? 0) > 0,
      trace: (composed.trace?.test(trimmed) ?? false) || (hits?.intents?.trace?.length ?? 0) > 0,
      highImpact: (composed.highImpact?.test(trimmed) ?? false) || (hits?.intents?.highImpact?.length ?? 0) > 0,
      acknowledgement,
      continuation,
    };
  }
  return explain(prompt, hits).intents;
}

export function explainPromptIntents(prompt: string, hits?: UserIntentHits): IntentExplanation {
  return explain(prompt, hits);
}

/** Minor-correction patterns, with the overlay's disables applied. */
function minorCorrectionHit(prompt: string, hits?: UserIntentHits): boolean {
  const composed = composeGatePatterns(hits?.disabledPatterns ?? []);
  return composed.minorCorrection.some(({ re }) => re.test(prompt)) ||
    (hits?.intents?.minorCorrection?.length ?? 0) > 0;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cheap gate decision. Order matters: explicit memory intent is never skipped
 * because a prompt is short; state-change triggers (epoch/Capsule/project
 * revision/incident) fire before lexical judgments — including for
 * acknowledgements, so the first "continue" of a new epoch still carries the
 * Capsule (the caller renders it without any vector work); otherwise
 * acknowledgements and continuations skip; everything else is judged by
 * fingerprint overlap and, when still unclear, deferred to one embedding
 * (`ambiguous`).
 */
export function decideRecall(input: RecallGateInput): RecallGateDecision {
  const config = { ...DEFAULT_RECALL_GATE_CONFIG, ...(input.config ?? {}) };
  const tokens = tokenizePrompt(input.prompt);
  const intents = detectPromptIntents(input.prompt, input.userHits);
  const triggers: RecallTrigger[] = [];
  const fingerprint = input.state.topicFingerprint;
  const topicOverlap = fingerprint.length > 0 ? jaccard(tokens, fingerprint) : null;
  const substantive = !(intents.acknowledgement || intents.continuation) &&
    (tokens.length >= config.substantiveMinTokens || intents.memory || intents.highImpact);
  const base = (action: RecallGateDecision["action"], skipReason: RecallSkipReason | null = null): RecallGateDecision => ({
    action, triggers, skipReason, intents, tokens, substantive, topicOverlap,
  });

  if (input.prompt.trim().length === 0) return base("skip", "empty_prompt");

  if (intents.memory) triggers.push("explicit_memory_intent");
  if (input.incidentMatched) triggers.push("incident_signature_match");
  if (input.currentProjectRevision > input.state.memoryRevisionSeen) triggers.push("project_revision_stale");
  if (input.residentRevisionStale) triggers.push("resident_revision_stale");
  if (input.hotEvidencePending) triggers.push("hot_evidence_pending");
  if (input.currentCapsuleGeneration > input.state.capsuleGenerationSeen) triggers.push("capsule_generation_changed");
  if (input.state.lastRetrievalEpoch !== input.state.contextEpoch) {
    triggers.push(input.state.lastSource === "compact" ? "compact_first_prompt" : input.state.lastRetrievalEpoch < 0 ? "first_substantive_in_epoch" : "context_epoch_changed");
  }
  if (triggers.length > 0) return base("retrieve");

  // Pure acknowledgements/continuations never need retrieval on their own.
  if ((intents.acknowledgement || intents.continuation) && tokens.length <= config.ackMaxTokens) {
    return base("skip", intents.acknowledgement ? "acknowledgement" : "continuation");
  }
  if (!substantive && minorCorrectionHit(input.prompt.trim(), input.userHits) &&
      tokens.length <= config.ackMaxTokens + 2) {
    return base("skip", "minor_correction");
  }

  if (intents.highImpact) triggers.push("high_impact_intent");
  if (input.state.informativePromptsSinceRetrieval >= config.safetyRefreshInterval) triggers.push("safety_refresh");
  if (topicOverlap !== null && tokens.length >= config.driftMinTokens && topicOverlap < config.driftJaccard) {
    triggers.push("topic_drift");
  }
  if (tokens.length >= config.coverageMinTokens && input.state.residentTokens.size > 0) {
    let covered = 0;
    for (const token of tokens) if (input.state.residentTokens.has(token)) covered++;
    if (covered === 0) triggers.push("low_resident_coverage");
  }
  if (triggers.length > 0) return base("retrieve");

  // Short non-memory prompt that clearly continues the current topic.
  if (!substantive && topicOverlap !== null && topicOverlap >= 0.3) return base("skip", "continuation");
  // Substantive prompt whose vocabulary largely repeats the current topic:
  // lexical continuation, no embedding needed (safety refresh still bounds it).
  if (topicOverlap !== null && topicOverlap >= config.lexicalCoherentJaccard) return base("skip", "coherent_topic");

  // Prompt on a known topic with no other signal: one embedding decides.
  if (!input.state.hasTopicEmbedding) {
    triggers.push("no_topic_embedding");
    return base("retrieve");
  }
  return base("ambiguous");
}

/**
 * Resolve an ambiguous decision with the single embedding the caller computed.
 * `baseline` is the prompt's max similarity to the background probes; the
 * prompt is coherent with the current topic only when it beats that baseline
 * by `coherentMargin`, otherwise it drifted and retrieval runs.
 */
export function resolveAmbiguousDecision(
  decision: RecallGateDecision,
  promptEmbedding: number[],
  topicEmbedding: number[] | null,
  baseline: number,
  config: Partial<RecallGateConfig> = {},
): RecallGateDecision {
  const merged = { ...DEFAULT_RECALL_GATE_CONFIG, ...config };
  if (!topicEmbedding) {
    return { ...decision, action: "retrieve", triggers: [...decision.triggers, "no_topic_embedding"], skipReason: null };
  }
  const similarity = cosineSimilarity(promptEmbedding, topicEmbedding);
  if (similarity - baseline >= merged.coherentMargin) {
    return { ...decision, action: "skip", skipReason: "coherent_topic" };
  }
  return { ...decision, action: "retrieve", triggers: [...decision.triggers, "embedding_drift"], skipReason: null };
}

export function embeddingToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

export function blobToEmbedding(blob: unknown): number[] | null {
  if (!blob || !(blob instanceof Buffer) || blob.byteLength === 0) return null;
  const view = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  return Array.from(view);
}
