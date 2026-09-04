/**
 * Phase 5 pre-retrieval cheap gate (RFC §12.3).
 *
 * Runs before any embedding, vector search, relation expansion or model call.
 * It decides from local session state and a cheap lexical fingerprint whether
 * the prompt needs recall (`retrieve`), clearly does not (`skip`), or is
 * ambiguous (`ambiguous`: exactly one embedding is allowed, and that embedding
 * is reused for retrieval). The gate itself never calls an LLM.
 */
export const DEFAULT_RECALL_GATE_CONFIG = {
    ackMaxTokens: 4,
    safetyRefreshInterval: 6,
    driftJaccard: 0.12,
    driftMinTokens: 5,
    coverageMinTokens: 8,
    coherentMargin: 0.08,
    substantiveMinTokens: 5,
    lexicalCoherentJaccard: 0.35,
};
const STOPWORDS = new Set([
    "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "are", "it", "this", "that", "with",
    "be", "as", "at", "by", "we", "i", "you", "do", "can", "please", "let", "me", "us", "our", "my", "your",
    "은", "는", "이", "가", "을", "를", "에", "의", "로", "으로", "와", "과", "도", "좀", "그", "저", "것", "수",
    "해", "해줘", "하자", "해요", "합니다", "있어", "없어", "그리고", "또", "그럼",
]);
const ACK_PATTERNS = [
    /^(ok|okay|k|yes|yep|yeah|no|nope|sure|thanks|thank you|thx|ty|cool|great|nice|good|got it|understood|done|fine|alright|perfect|sounds good)[.! ]*$/i,
    /^(응|네|넵|넹|예|아니|아니요|고마워|고마워요|고맙습니다|감사|감사합니다|감사해요|좋아|좋아요|좋네|좋습니다|알겠어|알겠어요|알겠습니다|오케이|ㅇㅋ|ㅇㅇ|ㄱㄱ|굿|맞아|맞아요|그래|그래요|확인)[.! ~]*$/,
];
const CONTINUE_PATTERNS = [
    /^(continue|go on|keep going|next|proceed|carry on|go ahead|resume)[.! ]*$/i,
    /^(계속|진행|다음|이어서|이어)(해|하자|해줘|해줘요|해주세요|하세요|할게|할게요|해요|해봐|합시다|가자|으로 넘어가자|으로 넘어가요)?[.! ~]*$/,
    /^(가자|고|해줘|해봐|ㄱ)[.! ~]*$/,
];
const MINOR_CORRECTION_PATTERNS = [
    /^(no|not that|the other one|wrong one|other|instead|actually|rather)\b/i,
    /^(아니|그거 말고|다른 거|다른거|말고|대신|그게 아니라)/,
];
const MEMORY_INTENT = /(\bwhy\b|\bwhen\b|\bhistory\b|\bsource\b|\bprevious(ly)?\b|\bbefore\b|\bearlier\b|\brepeat(ed|ing)?\b|\bagain\b|\bremember\b|\brecall\b|\bwhat did we\b|\bwhat was\b|\bhow did\b|\bwhere did\b|\borigin\b|\bdecided\b|왜|언제|이전|예전|과거|전에|기록|출처|근거|이유|히스토리|history|반복|또\s*(그|이)|기억|다시|했었|였었|결정했|정했|바꿨|변경했|어디서)/i;
const TRACE_INTENT = /(\bwhy\b|\brationale\b|\breason\b|\brelated\b|\bdepend|\bcontradict|\bconflict|\barchitecture\b|\btrace\b|\bhistory\b|\bsource\b|왜|이유|근거|관련|의존|모순|충돌|아키텍처|추적|출처|히스토리|history)/i;
const HIGH_IMPACT_INTENT = /(\bdecide\b|\bdecision\b|\bswitch(ing)?\b|\bmigrat(e|ion)\b|\brollback\b|\broll back\b|\brevert\b|\breplace\b|\bdrop\b|\bremove\b|\bdeprecate\b|\bchange the\b|\badopt\b|\bmove to\b|결정|전환|마이그레이션|롤백|되돌|교체|제거|삭제|바꾸|변경|도입|채택|옮기)/i;
// Korean particles and common verb endings attached to a stem. Stripping one
// trailing suffix keeps "클라이언트를"/"클라이언트" and "옵션도"/"옵션" on the
// same fingerprint token; the stem must keep at least two characters.
const KR_SUFFIX = /(해주세요|해줘요|합니다|하세요|했어요|해요|해줘|해봐|하자|할까|했어|했다|한다|해서|에서|에게|한테|으로|까지|부터|처럼|이랑|은|는|이|가|을|를|의|에|로|와|과|도|만|랑)$/u;
function normalizeToken(token) {
    if (!/[\u3131-\uD79D]/u.test(token))
        return token;
    const stripped = token.replace(KR_SUFFIX, "");
    return stripped.length >= 2 ? stripped : token;
}
export function tokenizePrompt(text) {
    const tokens = text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.-]+/u)
        .map((token) => token.replace(/^[.-]+|[.-]+$/g, ""))
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
        .map(normalizeToken)
        .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
    return [...new Set(tokens)];
}
export function jaccard(a, b) {
    const left = new Set(a);
    const right = new Set(b);
    if (left.size === 0 || right.size === 0)
        return 0;
    let overlap = 0;
    for (const token of left)
        if (right.has(token))
            overlap++;
    return overlap / (left.size + right.size - overlap);
}
const ACK_WORDS = new Set([
    "ok", "okay", "k", "yes", "yep", "yeah", "no", "nope", "sure", "thanks", "thank", "thx", "ty", "cool",
    "great", "nice", "good", "got", "understood", "done", "fine", "alright", "perfect", "right", "awesome",
    "응", "네", "넵", "넹", "예", "아니", "아니요", "고마워", "고마워요", "고맙습니다", "감사", "감사합니다", "감사해요",
    "좋아", "좋아요", "좋네", "좋습니다", "알겠어", "알겠어요", "알겠습니다", "오케이", "ㅇㅋ", "ㅇㅇ", "굿", "맞아", "맞아요",
    "그래", "그래요", "확인",
]);
const CONTINUE_WORDS = new Set([
    "continue", "go", "on", "keep", "going", "next", "proceed", "carry", "ahead", "resume",
    "계속", "계속해", "계속해줘", "계속해줘요", "계속해주세요", "계속하자", "진행", "진행해", "진행해줘", "진행해주세요", "진행할게",
    "진행할게요", "다음", "다음으로", "넘어가자", "넘어가요", "넘어가", "이어서", "이어", "가자", "해줘", "해주세요", "해봐", "ㄱㄱ",
]);
/** Words that carry no topic on their own; they never make a prompt substantive. */
const FILLER_WORDS = new Set([
    "you", "it", "that", "this", "the", "and", "then", "now", "please", "let", "lets", "s", "do", "for", "with",
    "sounds", "looks", "work", "job", "well", "really", "very", "much", "so", "all", "too",
    "저", "그", "좀", "요", "네요", "입니다", "이제", "그럼", "그러면", "일단",
]);
export function detectPromptIntents(prompt) {
    const trimmed = prompt.trim();
    const rawTokens = trimmed.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    const allAck = rawTokens.length > 0 &&
        rawTokens.every((token) => ACK_WORDS.has(token) || CONTINUE_WORDS.has(token) || FILLER_WORDS.has(token));
    const acknowledgement = ACK_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
        (allAck && rawTokens.some((token) => ACK_WORDS.has(token)));
    const continuation = CONTINUE_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
        (allAck && !acknowledgement && rawTokens.some((token) => CONTINUE_WORDS.has(token)));
    return {
        memory: MEMORY_INTENT.test(trimmed),
        trace: TRACE_INTENT.test(trimmed),
        highImpact: HIGH_IMPACT_INTENT.test(trimmed),
        acknowledgement,
        continuation,
    };
}
export function cosineSimilarity(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return 0;
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
export function decideRecall(input) {
    const config = { ...DEFAULT_RECALL_GATE_CONFIG, ...(input.config ?? {}) };
    const tokens = tokenizePrompt(input.prompt);
    const intents = detectPromptIntents(input.prompt);
    const triggers = [];
    const fingerprint = input.state.topicFingerprint;
    const topicOverlap = fingerprint.length > 0 ? jaccard(tokens, fingerprint) : null;
    const substantive = !(intents.acknowledgement || intents.continuation) &&
        (tokens.length >= config.substantiveMinTokens || intents.memory || intents.highImpact);
    const base = (action, skipReason = null) => ({
        action, triggers, skipReason, intents, tokens, substantive, topicOverlap,
    });
    if (input.prompt.trim().length === 0)
        return base("skip", "empty_prompt");
    if (intents.memory)
        triggers.push("explicit_memory_intent");
    if (input.incidentMatched)
        triggers.push("incident_signature_match");
    if (input.currentProjectRevision > input.state.memoryRevisionSeen)
        triggers.push("project_revision_stale");
    if (input.currentCapsuleGeneration > input.state.capsuleGenerationSeen)
        triggers.push("capsule_generation_changed");
    if (input.state.lastRetrievalEpoch !== input.state.contextEpoch) {
        triggers.push(input.state.lastSource === "compact" ? "compact_first_prompt" : input.state.lastRetrievalEpoch < 0 ? "first_substantive_in_epoch" : "context_epoch_changed");
    }
    if (triggers.length > 0)
        return base("retrieve");
    // Pure acknowledgements/continuations never need retrieval on their own.
    if ((intents.acknowledgement || intents.continuation) && tokens.length <= config.ackMaxTokens) {
        return base("skip", intents.acknowledgement ? "acknowledgement" : "continuation");
    }
    if (!substantive && MINOR_CORRECTION_PATTERNS.some((pattern) => pattern.test(input.prompt.trim())) &&
        tokens.length <= config.ackMaxTokens + 2) {
        return base("skip", "minor_correction");
    }
    if (intents.highImpact)
        triggers.push("high_impact_intent");
    if (input.state.informativePromptsSinceRetrieval >= config.safetyRefreshInterval)
        triggers.push("safety_refresh");
    if (topicOverlap !== null && tokens.length >= config.driftMinTokens && topicOverlap < config.driftJaccard) {
        triggers.push("topic_drift");
    }
    if (tokens.length >= config.coverageMinTokens && input.state.residentTokens.size > 0) {
        let covered = 0;
        for (const token of tokens)
            if (input.state.residentTokens.has(token))
                covered++;
        if (covered === 0)
            triggers.push("low_resident_coverage");
    }
    if (triggers.length > 0)
        return base("retrieve");
    // Short non-memory prompt that clearly continues the current topic.
    if (!substantive && topicOverlap !== null && topicOverlap >= 0.3)
        return base("skip", "continuation");
    // Substantive prompt whose vocabulary largely repeats the current topic:
    // lexical continuation, no embedding needed (safety refresh still bounds it).
    if (topicOverlap !== null && topicOverlap >= config.lexicalCoherentJaccard)
        return base("skip", "coherent_topic");
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
export function resolveAmbiguousDecision(decision, promptEmbedding, topicEmbedding, baseline, config = {}) {
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
export function embeddingToBlob(embedding) {
    return Buffer.from(new Float32Array(embedding).buffer);
}
export function blobToEmbedding(blob) {
    if (!blob || !(blob instanceof Buffer) || blob.byteLength === 0)
        return null;
    const view = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
    return Array.from(view);
}
