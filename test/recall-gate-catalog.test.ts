/**
 * GOLDEN — the built-in gate catalogue is a behaviour-preserving refactor.
 *
 * The three intent detectors were single giant alternations in v0.6.9. 0.7.0
 * decomposes them into id-bearing term lists so an overlay can disable one term
 * and so the gate can say WHICH term fired. The literals below are copied
 * verbatim from v0.6.9 `src/recall-gate.ts:127-142` and are the independent
 * witness: if a composed `source` stops being byte-identical to its literal, the
 * refactor has moved a gate verdict and this test must fail rather than be
 * updated.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_GATE_PATTERNS,
  BUILTIN_GATE_WORDS,
  composeGatePatterns,
  detectPromptIntents,
  explainPromptIntents,
  type GateIntent,
} from "../src/recall-gate.js";

// ---------------------------------------------------------------------------
// v0.6.9 literals — DO NOT EDIT to make a test pass.
// ---------------------------------------------------------------------------
const V069_ACK_PATTERNS = [
  /^(ok|okay|k|yes|yep|yeah|no|nope|sure|thanks|thank you|thx|ty|cool|great|nice|good|got it|understood|done|fine|alright|perfect|sounds good)[.! ]*$/i,
  /^(응|네|넵|넹|예|아니|아니요|고마워|고마워요|고맙습니다|감사|감사합니다|감사해요|좋아|좋아요|좋네|좋습니다|알겠어|알겠어요|알겠습니다|오케이|ㅇㅋ|ㅇㅇ|ㄱㄱ|굿|맞아|맞아요|그래|그래요|확인)[.! ~]*$/,
];
const V069_CONTINUE_PATTERNS = [
  /^(continue|go on|keep going|next|proceed|carry on|go ahead|resume)[.! ]*$/i,
  /^(계속|진행|다음|이어서|이어)(해|하자|해줘|해줘요|해주세요|하세요|할게|할게요|해요|해봐|합시다|가자|으로 넘어가자|으로 넘어가요)?[.! ~]*$/,
  /^(가자|고|해줘|해봐|ㄱ)[.! ~]*$/,
];
const V069_MINOR_CORRECTION_PATTERNS = [
  /^(no|not that|the other one|wrong one|other|instead|actually|rather)\b/i,
  /^(아니|그거 말고|다른 거|다른거|말고|대신|그게 아니라)/,
];
const V069_MEMORY_INTENT = /(\bwhy\b|\bwhen\b|\bhistory\b|\bsource\b|\bprevious(ly)?\b|\bbefore\b|\bearlier\b|\brepeat(ed|ing)?\b|\bagain\b|\bremember\b|\brecall\b|\bwhat did we\b|\bwhat was\b|\bhow did\b|\bwhere did\b|\borigin\b|\bdecided\b|왜|언제|이전|예전|과거|전에|기록|출처|근거|이유|히스토리|history|반복|또\s*(그|이)|기억|다시|했었|였었|결정했|정했|바꿨|변경했|어디서)/i;
const V069_TRACE_INTENT = /(\bwhy\b|\brationale\b|\breason\b|\brelated\b|\bdepend|\bcontradict|\bconflict|\barchitecture\b|\btrace\b|\bhistory\b|\bsource\b|왜|이유|근거|관련|의존|모순|충돌|아키텍처|추적|출처|히스토리|history)/i;
const V069_HIGH_IMPACT_INTENT = /(\bdecide\b|\bdecision\b|\bswitch(ing)?\b|\bmigrat(e|ion)\b|\brollback\b|\broll back\b|\brevert\b|\breplace\b|\bdrop\b|\bremove\b|\bdeprecate\b|\bchange the\b|\badopt\b|\bmove to\b|결정|전환|마이그레이션|롤백|되돌|교체|제거|삭제|바꾸|변경|도입|채택|옮기)/i;

const V069_ACK_WORDS = [
  "ok", "okay", "k", "yes", "yep", "yeah", "no", "nope", "sure", "thanks", "thank", "thx", "ty", "cool",
  "great", "nice", "good", "got", "understood", "done", "fine", "alright", "perfect", "right", "awesome",
  "응", "네", "넵", "넹", "예", "아니", "아니요", "고마워", "고마워요", "고맙습니다", "감사", "감사합니다", "감사해요",
  "좋아", "좋아요", "좋네", "좋습니다", "알겠어", "알겠어요", "알겠습니다", "오케이", "ㅇㅋ", "ㅇㅇ", "굿", "맞아", "맞아요",
  "그래", "그래요", "확인",
];
const V069_CONTINUE_WORDS = [
  "continue", "go", "on", "keep", "going", "next", "proceed", "carry", "ahead", "resume",
  "계속", "계속해", "계속해줘", "계속해줘요", "계속해주세요", "계속하자", "진행", "진행해", "진행해줘", "진행해주세요", "진행할게",
  "진행할게요", "다음", "다음으로", "넘어가자", "넘어가요", "넘어가", "이어서", "이어", "가자", "해줘", "해주세요", "해봐", "ㄱㄱ",
];
const V069_FILLER_WORDS = [
  "you", "it", "that", "this", "the", "and", "then", "now", "please", "let", "lets", "s", "do", "for", "with",
  "sounds", "looks", "work", "job", "well", "really", "very", "much", "so", "all", "too",
  "저", "그", "좀", "요", "네요", "입니다", "이제", "그럼", "그러면", "일단",
];

/** KR/EN corpus broad enough that any single moved term changes an output. */
const CORPUS = [
  "왜 auth를 supabase로 바꿨지?",
  "언제 이 결정을 했어?",
  "이전에 우리가 정했던 캐시 전략이 뭐였지",
  "예전 방식으로 되돌릴 수 있어?",
  "과거 기록 좀 보여줘",
  "전에 얘기한 출처가 어디야",
  "근거 자료를 찾아줘",
  "이유가 뭔데",
  "히스토리 확인해줘",
  "반복되는 에러를 또 그 모듈에서 봤어",
  "기억나는 대로 정리해줘",
  "다시 설명해줘",
  "했었던 시도들을 알려줘",
  "였었던 상태를 복원해",
  "결정했던 내용을 요약해",
  "정했던 기준이 뭐야",
  "변경했던 파일 목록",
  "어디서 이 값을 읽어오지",
  "why did we pick postgres",
  "when was this introduced",
  "the history of this module",
  "what is the source of truth here",
  "previously we used redis",
  "previous decision about caching",
  "what did we do before",
  "an earlier attempt at this",
  "repeated failures in CI",
  "repeating the same mistake",
  "say that again",
  "do you remember the rate limit",
  "recall the deployment steps",
  "what did we decide on auth",
  "what was the original plan",
  "how did we solve this",
  "where did the config move to",
  "the origin of this constraint",
  "we decided to drop the queue",
  "rationale for this design",
  "the reason behind the retry",
  "related decisions please",
  "this depends on the scheduler",
  "does that contradict the RFC",
  "there is a conflict with the spec",
  "the architecture of the ingest path",
  "trace this fact to its source",
  "관련 결정들 보여줘",
  "의존 관계가 어떻게 돼",
  "모순되는 부분이 있나",
  "충돌 해결 방법",
  "아키텍처 설명",
  "추적 가능해?",
  "let's decide the storage engine",
  "this decision is reversible",
  "switching to fastify",
  "switch the parser",
  "migrate the schema",
  "the migration plan",
  "rollback the release",
  "roll back to 0.6.8",
  "revert that commit",
  "replace the client",
  "drop the legacy table",
  "remove the dead flag",
  "deprecate the old endpoint",
  "change the default timeout",
  "adopt the new protocol",
  "move to a worker thread",
  "결정 좀 하자",
  "전환 비용이 얼마야",
  "마이그레이션 순서",
  "롤백 절차",
  "되돌려 줘",
  "교체 대상 목록",
  "제거해도 괜찮아?",
  "삭제 전에 확인해",
  "바꾸자",
  "변경 사항 요약",
  "도입 여부 결정",
  "채택한 규칙",
  "옮기는 게 나을까",
  "ok",
  "okay!",
  "yes",
  "sure",
  "thanks",
  "thank you",
  "got it",
  "sounds good",
  "응",
  "넵",
  "알겠습니다",
  "ㅇㅋ",
  "확인",
  "그래요~",
  "continue",
  "go on",
  "keep going",
  "next",
  "proceed",
  "go ahead",
  "resume",
  "계속",
  "계속해줘",
  "진행해주세요",
  "다음으로 넘어가자",
  "이어서 해줘",
  "가자",
  "ㄱ",
  "no, not that",
  "the other one",
  "wrong one please",
  "instead use the cache",
  "actually never mind",
  "아니 그거 말고",
  "다른 거 보여줘",
  "말고 다른 방법",
  "대신 이걸 써",
  "그게 아니라 반대야",
  "",
  "   ",
  "refactor the ingest pipeline so batches stream instead of buffering whole files",
  "the scheduler picks up pending jobs every thirty seconds and leases them",
];

function v069Intents(prompt: string) {
  const trimmed = prompt.trim();
  const rawTokens = trimmed.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const ack = new Set(V069_ACK_WORDS);
  const cont = new Set(V069_CONTINUE_WORDS);
  const filler = new Set(V069_FILLER_WORDS);
  const allAck = rawTokens.length > 0 &&
    rawTokens.every((t) => ack.has(t) || cont.has(t) || filler.has(t));
  const acknowledgement = V069_ACK_PATTERNS.some((p) => p.test(trimmed)) ||
    (allAck && rawTokens.some((t) => ack.has(t)));
  const continuation = V069_CONTINUE_PATTERNS.some((p) => p.test(trimmed)) ||
    (allAck && !acknowledgement && rawTokens.some((t) => cont.has(t)));
  return {
    memory: V069_MEMORY_INTENT.test(trimmed),
    trace: V069_TRACE_INTENT.test(trimmed),
    highImpact: V069_HIGH_IMPACT_INTENT.test(trimmed),
    acknowledgement,
    continuation,
  };
}

describe("built-in gate catalogue golden", () => {
  it("composes the three intent alternations byte-identically to the v0.6.9 literals", () => {
    const composed = composeGatePatterns();
    expect(composed.memory?.source).toBe(V069_MEMORY_INTENT.source);
    expect(composed.memory?.flags).toBe(V069_MEMORY_INTENT.flags);
    expect(composed.trace?.source).toBe(V069_TRACE_INTENT.source);
    expect(composed.trace?.flags).toBe(V069_TRACE_INTENT.flags);
    expect(composed.highImpact?.source).toBe(V069_HIGH_IMPACT_INTENT.source);
    expect(composed.highImpact?.flags).toBe(V069_HIGH_IMPACT_INTENT.flags);
  });

  it("keeps the standalone pattern arrays identical (source, flags and order)", () => {
    const composed = composeGatePatterns();
    expect(composed.acknowledgement.map((p) => [p.re.source, p.re.flags]))
      .toEqual(V069_ACK_PATTERNS.map((p) => [p.source, p.flags]));
    expect(composed.continuation.map((p) => [p.re.source, p.re.flags]))
      .toEqual(V069_CONTINUE_PATTERNS.map((p) => [p.source, p.flags]));
    expect(composed.minorCorrection.map((p) => [p.re.source, p.re.flags]))
      .toEqual(V069_MINOR_CORRECTION_PATTERNS.map((p) => [p.source, p.flags]));
  });

  it("keeps the three lexicons identical, in order", () => {
    expect([...BUILTIN_GATE_WORDS.ack]).toEqual(V069_ACK_WORDS);
    expect([...BUILTIN_GATE_WORDS.continue]).toEqual(V069_CONTINUE_WORDS);
    expect([...BUILTIN_GATE_WORDS.filler]).toEqual(V069_FILLER_WORDS);
  });

  it("gives every catalogue entry a unique, well-formed id", () => {
    const ids = BUILTIN_GATE_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pattern of BUILTIN_GATE_PATTERNS) {
      expect(pattern.id).toMatch(/^(memory|trace|high|ack|continue|minor)\.(en|kr)\./);
      expect(() => new RegExp(pattern.source, pattern.flags)).not.toThrow();
    }
  });

  it("reproduces detectPromptIntents() exactly on the KR/EN corpus", () => {
    for (const prompt of CORPUS) {
      expect(detectPromptIntents(prompt), `prompt: ${JSON.stringify(prompt)}`)
        .toEqual(v069Intents(prompt));
    }
  });

  it("explainPromptIntents() agrees with detectPromptIntents() and names the firing terms", () => {
    for (const prompt of CORPUS) {
      const explained = explainPromptIntents(prompt);
      expect(explained.intents, `prompt: ${JSON.stringify(prompt)}`).toEqual(v069Intents(prompt));
      for (const intent of ["memory", "trace", "highImpact"] as GateIntent[]) {
        const fired = explained.intents[intent as "memory" | "trace" | "highImpact"];
        expect(explained.matched[intent].length > 0).toBe(fired);
      }
    }
    const explained = explainPromptIntents("왜 auth를 supabase로 바꿨지?");
    expect(explained.matched.memory.map((m) => m.id)).toContain("memory.kr.왜");
    expect(explained.matched.memory.map((m) => m.id)).toContain("memory.kr.바꿨");
    expect(explained.matched.trace.map((m) => m.id)).toContain("trace.kr.왜");
    expect(explained.matched.memory.every((m) => m.origin === "builtin")).toBe(true);
    // `바꿨` is a memory term; the high-impact term is the stem `바꾸`, which the
    // past tense does NOT contain — so the design doc's sample output showing
    // `high.kr.바꾸` for this prompt is wrong and 0.6.9 agrees with us here.
    expect(explained.matched.highImpact).toEqual([]);
    expect(explainPromptIntents("바꾸자").matched.highImpact.map((m) => m.id)).toEqual(["high.kr.바꾸"]);
  });

  it("disabling one term removes exactly that term and leaves the rest composed", () => {
    const composed = composeGatePatterns(["memory.kr.왜"]);
    expect(composed.memory?.source).not.toContain("|왜|");
    expect(composed.memory?.source).toContain("언제");
    // trace still has its own 왜 — ids are per intent, not global.
    expect(composed.trace?.source).toContain("왜");
    const hits = { intents: {}, disabledPatterns: ["memory.kr.왜"] };
    expect(detectPromptIntents("왜 그랬어", hits).memory).toBe(false);
    expect(detectPromptIntents("왜 그랬어", hits).trace).toBe(true);
    expect(detectPromptIntents("왜 그랬어").memory).toBe(true);
  });

  it("disabling EVERY term of an intent makes it never fire (not always fire)", () => {
    const all = BUILTIN_GATE_PATTERNS.filter((p) => p.intent === "memory").map((p) => p.id);
    const composed = composeGatePatterns(all);
    expect(composed.memory).toBeNull();
    expect(detectPromptIntents("왜 그랬어", { intents: {}, disabledPatterns: all }).memory).toBe(false);
    expect(detectPromptIntents("", { intents: {}, disabledPatterns: all }).memory).toBe(false);
  });

  it("precomputed user hits can add an intent without executing any regex here", () => {
    expect(detectPromptIntents("배포 이력 좀 보여줘").memory).toBe(false);
    const hits = { intents: { memory: ["user.3f9a1c22"] } };
    expect(detectPromptIntents("배포 이력 좀 보여줘", hits).memory).toBe(true);
    expect(explainPromptIntents("배포 이력 좀 보여줘", hits).matched.memory)
      .toEqual([{ id: "user.3f9a1c22", origin: "user" }]);
  });

  it("overlay words add and disable lexicon entries", () => {
    // "확인" is a built-in ack word and ack pattern; disabling the word alone
    // must not change the pattern-driven verdict.
    const plain = detectPromptIntents("ㅇㅈ");
    expect(plain.acknowledgement).toBe(false);
    const added = detectPromptIntents("ㅇㅈ", { intents: {}, words: { add: { ack: ["ㅇㅈ"] } } });
    expect(added.acknowledgement).toBe(true);
    const disabled = detectPromptIntents("awesome", { intents: {}, words: { disable: { ack: ["awesome"] } } });
    expect(disabled.acknowledgement).toBe(false);
    expect(detectPromptIntents("awesome").acknowledgement).toBe(true);
  });
});
