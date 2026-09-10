/**
 * Read side of the recall-gate overlay (issue #29, §1.6 / §2).
 *
 * A LEAF module: `fs`, `path`, `crypto`, `./paths.js`, `./overlay-regex.js`,
 * `./overlay-matcher.js`, `./recall-gate.js`. No database, no audit writer, no
 * lock — the injection hook loads this on every prompt, and pulling
 * `ontology-admin` (and through it `ontology-db`) into the fast path would undo
 * the whole point of the warm daemon (§1.4's "fast path 오염 금지").
 *
 * FAIL-SAFE, deliberately asymmetric with the extraction overlay (G1): a gate
 * overlay that will not load, or a pattern that got quarantined, degrades to the
 * BUILT-IN defaults and the prompt is still served. The gate only changes what is
 * RECALLED; it never decides what is stored, so fail-open is the correct
 * direction here. The extraction rules overlay does the opposite.
 *
 * Nothing here ever executes a user regex. Loading runs the structural parser
 * (pure, linear, terminating) and hands the surviving specs to the time-boxed
 * matcher; `loadRecallGateOverlay()` does NOT run the measuring probe.
 */
import fs from "node:fs";
import { recallGateOverlayPath, overlayQuarantinePath } from "./paths.js";
import { canonicalJson, checkOverlayRegex, overlayIssue, patternSourceSha8, sha8, userPatternId, OVERLAY_REGEX_LIMITS, } from "./overlay-regex.js";
import { quarantineMemoryGeneration, readQuarantine, EMPTY_USER_PATTERN_HITS, MATCH_WALL_MS, } from "./overlay-matcher.js";
import { BUILTIN_GATE_PATTERNS, BUILTIN_GATE_WORDS, decideRecall, explainPromptIntents, tokenizePrompt, } from "./recall-gate.js";
export const RECALL_GATE_OVERLAY_SCHEMA = "memex.recall-gate-overlay";
export const RECALL_GATE_OVERLAY_VERSION = 1;
/** §1.3 / §2.2 — the complete limit table, also served to the Web UI. */
export const OVERLAY_LIMITS = Object.freeze({
    fileBytes: 32_768,
    patternSource: OVERLAY_REGEX_LIMITS.sourceChars,
    quantifiers: OVERLAY_REGEX_LIMITS.quantifiers,
    groupDepth: OVERLAY_REGEX_LIMITS.depth,
    alternationBranches: OVERLAY_REGEX_LIMITS.branches,
    noteChars: 200,
    counts: Object.freeze({
        patternsAdd: 64,
        patternsAddPerIntent: 32,
        patternsDisable: 256,
        wordsAddPerLexicon: 128,
        wordsDisablePerLexicon: 256,
        wordChars: 32,
    }),
});
const INTENTS = [
    "memory", "trace", "highImpact", "acknowledgement", "continuation", "minorCorrection",
];
const LEXICONS = ["ack", "continue", "filler"];
function emptyWords() {
    return { add: { ack: [], continue: [], filler: [] }, disable: { ack: [], continue: [], filler: [] } };
}
const EMPTY_OVERLAY = Object.freeze({
    present: false,
    hash: null,
    revision: 0,
    patterns: Object.freeze([]),
    disabled: Object.freeze([]),
    words: Object.freeze(emptyWords()),
    quarantined: Object.freeze([]),
    issues: Object.freeze([]),
    doc: null,
});
export function emptyRecallGateOverlay() {
    return EMPTY_OVERLAY;
}
/* -------------------------------------------------------------------------- */
/* Hash                                                                        */
/* -------------------------------------------------------------------------- */
/**
 * `gate:<sha8>` over the RULES only.
 *
 * `revision`, `updated_at` and `updated_by` are excluded on purpose: re-saving
 * the same rules must not move the hash, or the extraction drift warning fires
 * for a no-op and every recall receipt looks like a new rule set.
 */
export function recallGateOverlayHash(doc) {
    const rules = {
        patterns: {
            add: (doc.patterns?.add ?? []).map((pattern) => ({
                id: pattern.id, intent: pattern.intent, source: pattern.source, flags: pattern.flags ?? "",
            })),
            disable: [...(doc.patterns?.disable ?? [])].sort(),
        },
        words: {
            add: Object.fromEntries(LEXICONS.map((lexicon) => [lexicon, [...(doc.words?.add?.[lexicon] ?? [])].sort()])),
            disable: Object.fromEntries(LEXICONS.map((lexicon) => [lexicon, [...(doc.words?.disable?.[lexicon] ?? [])].sort()])),
        },
    };
    return `gate:${sha8(canonicalJson(rules))}`;
}
/* -------------------------------------------------------------------------- */
/* Validation (§2.3.5 steps 1-4, 6, 7, 9)                                      */
/* -------------------------------------------------------------------------- */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const KNOWN_TOP_LEVEL = new Set([
    "schema", "version", "revision", "updated_at", "updated_by", "patterns", "words",
]);
const BUILTIN_IDS = new Set(BUILTIN_GATE_PATTERNS.map((pattern) => pattern.id));
const BUILTIN_SOURCES = new Set(BUILTIN_GATE_PATTERNS.map((pattern) => `${pattern.source}\u0000${pattern.flags}`));
/**
 * Structural validation. `forWrite` adds the warnings that only matter when an
 * operator is saving (`PATTERN_SHADOWED`), and a caller that also wants the
 * measuring probe runs `probeRecallGateOverlay()` from overlay-admin.ts.
 */
export function validateRecallGateOverlayDoc(raw, opts = {}) {
    const issues = [];
    const error = (code, message, extra) => {
        issues.push(overlayIssue("error", code, message, extra));
    };
    const warn = (code, message, extra) => {
        issues.push(overlayIssue("warning", code, message, extra));
    };
    if (opts.bytes !== undefined && opts.bytes > OVERLAY_LIMITS.fileBytes) {
        error("OVERLAY_TOO_LARGE", `the overlay file is ${opts.bytes} bytes (limit ${OVERLAY_LIMITS.fileBytes})`, { params: { bytes: opts.bytes, limit: OVERLAY_LIMITS.fileBytes } });
        return { ok: false, issues, doc: null };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        error("OVERLAY_NOT_OBJECT", "the overlay must be a JSON object");
        return { ok: false, issues, doc: null };
    }
    const doc = raw;
    if (doc.schema !== RECALL_GATE_OVERLAY_SCHEMA) {
        error("OVERLAY_SCHEMA_MISMATCH", `schema must be "${RECALL_GATE_OVERLAY_SCHEMA}" (found ${JSON.stringify(doc.schema ?? null)})`, { path: "schema", params: { expected: RECALL_GATE_OVERLAY_SCHEMA } });
        return { ok: false, issues, doc: null };
    }
    if (Number(doc.version) !== RECALL_GATE_OVERLAY_VERSION) {
        // An unknown version is NEVER partially applied (§1.2).
        error("OVERLAY_VERSION_UNSUPPORTED", `version ${String(doc.version)} is not supported by this build (expected ${RECALL_GATE_OVERLAY_VERSION})`, { path: "version", params: { version: doc.version, expected: RECALL_GATE_OVERLAY_VERSION } });
        return { ok: false, issues, doc: null };
    }
    for (const key of Object.keys(doc)) {
        if (!KNOWN_TOP_LEVEL.has(key)) {
            // Forward compatibility: 0.7.1 adds `config` (thresholds) and 0.7.0 must
            // ignore it quietly rather than refuse the whole file.
            warn("OVERLAY_UNKNOWN_FIELD", `unknown field "${key}" is ignored by this build`, {
                path: key, params: { field: key },
            });
        }
    }
    const revision = Number.isInteger(doc.revision) && Number(doc.revision) >= 0 ? Number(doc.revision) : 0;
    const patternsRaw = doc.patterns;
    const add = [];
    const disable = [];
    const seenIds = new Set();
    const perIntent = new Map();
    if (patternsRaw !== undefined && (typeof patternsRaw !== "object" || patternsRaw === null || Array.isArray(patternsRaw))) {
        error("OVERLAY_NOT_OBJECT", "`patterns` must be an object with `add` and `disable`", { path: "patterns" });
    }
    else {
        const section = (patternsRaw ?? {});
        const rawAdd = section.add;
        if (rawAdd !== undefined && !Array.isArray(rawAdd)) {
            error("OVERLAY_NOT_OBJECT", "`patterns.add` must be an array", { path: "patterns.add" });
        }
        else {
            const list = (rawAdd ?? []);
            if (list.length > OVERLAY_LIMITS.counts.patternsAdd) {
                error("PATTERN_COUNT_EXCEEDED", `${list.length} added patterns (limit ${OVERLAY_LIMITS.counts.patternsAdd})`, { path: "patterns.add", params: { count: list.length, limit: OVERLAY_LIMITS.counts.patternsAdd } });
            }
            list.forEach((entry, index) => {
                const at = `patterns.add[${index}]`;
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                    error("OVERLAY_NOT_OBJECT", "each added pattern must be an object", { path: at, row: index });
                    return;
                }
                const item = entry;
                const intent = item.intent;
                if (!INTENTS.includes(intent)) {
                    error("INTENT_UNKNOWN", `unknown intent ${JSON.stringify(item.intent ?? null)}`, {
                        path: `${at}.intent`, row: index, field: "intent", params: { intent: item.intent },
                    });
                    return;
                }
                const source = typeof item.source === "string" ? item.source : "";
                const flags = typeof item.flags === "string" ? item.flags : "";
                if (source.length === 0) {
                    error("PATTERN_TOO_LONG", "a pattern source may not be empty", {
                        path: `${at}.source`, row: index, field: "source",
                    });
                    return;
                }
                const check = checkOverlayRegex(source, flags);
                for (const problem of check.problems) {
                    error(problem.code, problem.message, {
                        path: `${at}.source`, row: index, field: "source", params: problem.params,
                    });
                }
                const id = typeof item.id === "string" && item.id.length > 0 ? item.id : userPatternId(intent, source, flags);
                if (seenIds.has(id)) {
                    error("PATTERN_DUPLICATE_ID", `duplicate pattern id ${id}`, {
                        path: `${at}.id`, row: index, field: "id", params: { id },
                    });
                    return;
                }
                seenIds.add(id);
                const count = (perIntent.get(intent) ?? 0) + 1;
                perIntent.set(intent, count);
                if (count > OVERLAY_LIMITS.counts.patternsAddPerIntent) {
                    error("PATTERN_COUNT_EXCEEDED", `intent ${intent} has ${count} added patterns (limit ${OVERLAY_LIMITS.counts.patternsAddPerIntent})`, { path: at, row: index, params: { intent, count, limit: OVERLAY_LIMITS.counts.patternsAddPerIntent } });
                }
                const note = typeof item.note === "string" ? item.note : undefined;
                if (note !== undefined) {
                    if (note.length > OVERLAY_LIMITS.noteChars || CONTROL_CHARS.test(note) || note.includes("\n")) {
                        error("WORD_INVALID", `a note must be a single line of at most ${OVERLAY_LIMITS.noteChars} characters`, { path: `${at}.note`, row: index, field: "note", params: { limit: OVERLAY_LIMITS.noteChars } });
                    }
                }
                if (opts.forWrite && BUILTIN_SOURCES.has(`${source}\u0000${flags}`)) {
                    warn("PATTERN_SHADOWED", "this regex is identical to a built-in pattern", {
                        path: `${at}.source`, row: index, field: "source",
                    });
                }
                add.push({
                    id, intent, source, flags,
                    ...(note === undefined ? {} : { note }),
                    ...(typeof item.created_at === "string" ? { created_at: item.created_at } : {}),
                });
            });
        }
        const rawDisable = section.disable;
        if (rawDisable !== undefined && !Array.isArray(rawDisable)) {
            error("OVERLAY_NOT_OBJECT", "`patterns.disable` must be an array of ids", { path: "patterns.disable" });
        }
        else {
            const list = (rawDisable ?? []);
            if (list.length > OVERLAY_LIMITS.counts.patternsDisable) {
                error("PATTERN_COUNT_EXCEEDED", `${list.length} disabled ids (limit ${OVERLAY_LIMITS.counts.patternsDisable})`, { path: "patterns.disable", params: { count: list.length, limit: OVERLAY_LIMITS.counts.patternsDisable } });
            }
            list.forEach((entry, index) => {
                if (typeof entry !== "string" || entry.length === 0) {
                    error("WORD_INVALID", "a disabled id must be a non-empty string", {
                        path: `patterns.disable[${index}]`, row: index,
                    });
                    return;
                }
                if (!BUILTIN_IDS.has(entry) && !seenIds.has(entry)) {
                    // A warning, not an error: an id from a future catalogue must not take
                    // the whole overlay down.
                    warn("DISABLE_ID_UNKNOWN", `no pattern with id ${entry} exists in this build's catalogue`, {
                        path: `patterns.disable[${index}]`, row: index, params: { id: entry },
                    });
                }
                disable.push(entry);
            });
        }
    }
    const words = emptyWords();
    const wordsRaw = doc.words;
    if (wordsRaw !== undefined && (typeof wordsRaw !== "object" || wordsRaw === null || Array.isArray(wordsRaw))) {
        error("OVERLAY_NOT_OBJECT", "`words` must be an object", { path: "words" });
    }
    else {
        const section = (wordsRaw ?? {});
        for (const side of ["add", "disable"]) {
            const sideRaw = section[side];
            if (sideRaw === undefined)
                continue;
            if (typeof sideRaw !== "object" || sideRaw === null || Array.isArray(sideRaw)) {
                error("OVERLAY_NOT_OBJECT", `\`words.${side}\` must be an object`, { path: `words.${side}` });
                continue;
            }
            const limit = side === "add"
                ? OVERLAY_LIMITS.counts.wordsAddPerLexicon
                : OVERLAY_LIMITS.counts.wordsDisablePerLexicon;
            for (const [lexicon, value] of Object.entries(sideRaw)) {
                if (!LEXICONS.includes(lexicon)) {
                    error("LEXICON_UNKNOWN", `unknown lexicon ${JSON.stringify(lexicon)}`, {
                        path: `words.${side}.${lexicon}`, params: { lexicon },
                    });
                    continue;
                }
                if (!Array.isArray(value)) {
                    error("OVERLAY_NOT_OBJECT", `\`words.${side}.${lexicon}\` must be an array`, {
                        path: `words.${side}.${lexicon}`,
                    });
                    continue;
                }
                if (value.length > limit) {
                    error("PATTERN_COUNT_EXCEEDED", `${value.length} words (limit ${limit})`, {
                        path: `words.${side}.${lexicon}`, params: { count: value.length, limit },
                    });
                }
                value.forEach((word, index) => {
                    const at = `words.${side}.${lexicon}[${index}]`;
                    if (typeof word !== "string" || word.length === 0 ||
                        word.length > OVERLAY_LIMITS.counts.wordChars ||
                        /\s/.test(word) || CONTROL_CHARS.test(word)) {
                        error("WORD_INVALID", `a word must be 1-${OVERLAY_LIMITS.counts.wordChars} characters with no whitespace or control characters`, { path: at, row: index, params: { word: typeof word === "string" ? word.slice(0, 40) : null } });
                        return;
                    }
                    words[side][lexicon].push(word);
                });
            }
        }
    }
    const ok = !issues.some((issue) => issue.severity === "error");
    return {
        ok,
        issues,
        doc: ok
            ? {
                schema: RECALL_GATE_OVERLAY_SCHEMA,
                version: RECALL_GATE_OVERLAY_VERSION,
                revision,
                ...(typeof doc.updated_at === "string" ? { updated_at: doc.updated_at } : {}),
                ...(doc.updated_by && typeof doc.updated_by === "object"
                    ? { updated_by: doc.updated_by }
                    : {}),
                patterns: { add, disable },
                words: { add: words.add, disable: words.disable },
            }
            : null,
    };
}
/** §2.4 — async signature so the write path can add the measuring probe later. */
export async function validateRecallGateOverlay(doc, opts = {}) {
    void opts.probe; // the probe lives in overlay-admin.ts (write-only, §2.3.2)
    return validateRecallGateOverlayDoc(doc, { forWrite: opts.forWrite });
}
/* -------------------------------------------------------------------------- */
/* Load + cache (§1.6)                                                         */
/* -------------------------------------------------------------------------- */
/** `mtimeMs:size:ino`, or `absent`. Atomic tmp+rename guarantees a new inode. */
function statKey(file) {
    try {
        const stat = fs.statSync(file);
        return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    }
    catch {
        return "absent";
    }
}
let cache = null;
export function overlaysDisabled() {
    return process.env.MEMEX_DISABLE_OVERLAYS === "1";
}
export function readRecallGateOverlayFile(file = recallGateOverlayPath()) {
    let text;
    try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
            return { raw: null, bytes: 0, present: true, readError: "the overlay path is a symbolic link" };
        }
        text = fs.readFileSync(file, "utf8");
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT")
            return { raw: null, bytes: 0, present: false, readError: null };
        return { raw: null, bytes: 0, present: true, readError: err.message };
    }
    const bytes = Buffer.byteLength(text, "utf8");
    try {
        return { raw: JSON.parse(text), bytes, present: true, readError: null };
    }
    catch (err) {
        return { raw: null, bytes, present: true, readError: err.message };
    }
}
function readValidateCompile(file) {
    const { raw, bytes, present, readError } = readRecallGateOverlayFile(file);
    if (!present)
        return EMPTY_OVERLAY;
    if (readError !== null) {
        return {
            ...EMPTY_OVERLAY,
            present: true,
            words: emptyWords(),
            issues: [
                overlayIssue("error", "OVERLAY_UNREADABLE", `the overlay file could not be read: ${readError}`, {
                    params: { reason: readError },
                }),
            ],
        };
    }
    const result = validateRecallGateOverlayDoc(raw, { bytes });
    if (!result.ok || !result.doc) {
        // Any error severity: the overlay is ignored ENTIRELY and the gate runs on
        // built-ins. Half-applying a rule set is worse than applying none.
        return { ...EMPTY_OVERLAY, present: true, words: emptyWords(), issues: result.issues };
    }
    const doc = result.doc;
    const quarantine = readQuarantine().filter((entry) => entry.overlay === "recall-gate");
    const issues = [...result.issues];
    const patterns = [];
    const quarantined = [];
    for (const pattern of doc.patterns?.add ?? []) {
        const sha8 = patternSourceSha8(pattern.source, pattern.flags ?? "");
        const row = quarantine.find((entry) => entry.pattern_id === pattern.id && entry.source_sha8 === sha8);
        if (row) {
            // §2.3.4: a quarantined pattern is a user rule that is SILENTLY OFF, so it
            // is an error (doctor fails), but only that pattern is dropped — the gate
            // keeps running (fail-safe).
            issues.push(overlayIssue("error", "PATTERN_QUARANTINED", `pattern ${pattern.id} exceeded the ${MATCH_WALL_MS} ms match budget and is NOT applied`, { path: "patterns.add", params: { id: pattern.id, limitMs: MATCH_WALL_MS } }));
            quarantined.push(row);
            continue;
        }
        patterns.push({
            id: pattern.id,
            intent: pattern.intent,
            source: pattern.source,
            flags: pattern.flags,
            overlay: "recall-gate",
        });
    }
    return {
        present: true,
        hash: recallGateOverlayHash(doc),
        revision: doc.revision,
        patterns,
        disabled: doc.patterns?.disable ?? [],
        words: {
            add: doc.words?.add,
            disable: doc.words?.disable,
        },
        quarantined: quarantined.filter(Boolean),
        issues,
        doc,
    };
}
/**
 * The hook's entry point. Two `statSync` calls per request (~20-60 µs) against a
 * warm budget of ~150 ms, and `ino` in the key so the atomic tmp+rename of a
 * write is always observed even when `mtimeMs:size` happen to repeat.
 *
 * No `fs.watch`: the MCP server must not put a watcher on the data root.
 */
export function loadRecallGateOverlay() {
    if (overlaysDisabled())
        return EMPTY_OVERLAY;
    const file = recallGateOverlayPath();
    const key = `${statKey(file)}|${statKey(overlayQuarantinePath())}|${quarantineMemoryGeneration()}`;
    if (cache && cache.key === key)
        return cache.loaded;
    const loaded = readValidateCompile(file);
    cache = { key, loaded };
    return loaded;
}
/** Cache-bypassing read of the applied revision (the write path's CAS input). */
export function currentRecallGateRevision() {
    const { raw, present } = readRecallGateOverlayFile();
    if (!present || !raw || typeof raw !== "object")
        return 0;
    const revision = raw.revision;
    return Number.isInteger(revision) && Number(revision) >= 0 ? Number(revision) : 0;
}
/** Test/transition hook: forget the cached load. */
export function resetRecallGateOverlayCache() {
    cache = null;
}
export function gateCatalog() {
    return { builtin: BUILTIN_GATE_PATTERNS, words: BUILTIN_GATE_WORDS, limits: OVERLAY_LIMITS };
}
/**
 * Fold a loaded overlay plus the matcher's answer into the gate's input.
 *
 * The word lists travel even when the matcher was unavailable: they are plain
 * strings, were never going to run in a worker, and dropping them because a
 * worker died would be an unrelated regression.
 */
export function toUserIntentHits(overlay, hits) {
    const hasWords = LEXICONS.some((lexicon) => (overlay.words.add?.[lexicon]?.length ?? 0) > 0 ||
        (overlay.words.disable?.[lexicon]?.length ?? 0) > 0);
    const hasIntents = Object.values(hits.intents).some((ids) => (ids?.length ?? 0) > 0);
    if (!hasWords && !hasIntents && overlay.disabled.length === 0)
        return undefined;
    return {
        intents: hits.intents,
        ...(overlay.disabled.length > 0 ? { disabledPatterns: overlay.disabled } : {}),
        ...(hasWords ? { words: { add: overlay.words.add, disable: overlay.words.disable } } : {}),
    };
}
export function neutralGateState() {
    return {
        contextEpoch: 0,
        lastRetrievalEpoch: 0,
        lastSource: null,
        capsuleGenerationSeen: 0,
        memoryRevisionSeen: 0,
        topicFingerprint: [],
        hasTopicEmbedding: true,
        informativePromptsSinceRetrieval: 0,
        residentTokens: new Set(),
    };
}
function sourceOfId(id, overlay) {
    const user = overlay.doc?.patterns?.add?.find((pattern) => pattern.id === id);
    if (user)
        return user.source;
    return BUILTIN_GATE_PATTERNS.find((pattern) => pattern.id === id)?.source ?? id;
}
/**
 * Explain one prompt against the built-ins and the overlay. Writes NOTHING — no
 * inject log, no recall receipt, no telemetry, no gate state. The one exception
 * is the quarantine file: user patterns go through the real matcher, so a
 * pattern that blows its budget here is quarantined exactly as it would be in
 * production, and that fact is recorded.
 */
export async function explainRecall(input, matcher) {
    const overlay = loadRecallGateOverlay();
    const hits = overlay.patterns.length > 0
        ? await matcher.match({
            text: input.prompt,
            patterns: overlay.patterns,
            overlay: "recall-gate",
            surface: "gate-test",
        })
        : EMPTY_USER_PATTERN_HITS;
    const userHits = toUserIntentHits(overlay, hits);
    const explained = explainPromptIntents(input.prompt, userHits);
    const state = input.state ?? neutralGateState();
    const base = {
        prompt: input.prompt,
        state,
        currentCapsuleGeneration: state.capsuleGenerationSeen,
        currentProjectRevision: state.memoryRevisionSeen,
        incidentMatched: false,
    };
    const decision = decideRecall({ ...base, userHits });
    const builtinOnly = input.compareBuiltin ? decideRecall({ ...base }) : undefined;
    const builtinExplained = input.compareBuiltin ? explainPromptIntents(input.prompt) : null;
    const intents = {};
    for (const intent of INTENTS) {
        const matched = explained.matched[intent].map((entry) => ({
            id: entry.id,
            source: sourceOfId(entry.id, overlay),
            origin: entry.origin,
        }));
        intents[intent] = { fired: matched.length > 0, matched };
    }
    let diffCause;
    if (builtinExplained) {
        diffCause = [];
        for (const intent of INTENTS) {
            const before = new Set(builtinExplained.matched[intent].map((entry) => entry.id));
            for (const entry of explained.matched[intent]) {
                if (!before.has(entry.id)) {
                    diffCause.push({ id: entry.id, source: sourceOfId(entry.id, overlay), intent });
                }
            }
        }
    }
    return {
        prompt: { chars: input.prompt.length, tokens: tokenizePrompt(input.prompt) },
        overlay: { present: overlay.present, hash: overlay.hash, revision: overlay.revision },
        matcher: {
            elapsedMs: hits.elapsedMs,
            timedOut: hits.timedOut,
            unavailable: hits.unavailable,
            quarantined: [...hits.quarantined],
        },
        intents,
        decision,
        ...(builtinOnly ? { builtinOnly } : {}),
        ...(diffCause ? { diffCause } : {}),
        stateSource: input.state ? "session" : "neutral",
    };
}
/**
 * The three gate-side doctor checks. `src/lifecycle.ts` is owned by the
 * diagnostics lane, so this module exports the checks rather than pushing them.
 *
 * `matcherProbe` lets the caller decide whether to pay for a worker spawn; the
 * default spawns one only when there is a user pattern to run.
 */
export async function recallGateOverlayChecks(matcherProbe) {
    const checks = [];
    const overlay = loadRecallGateOverlay();
    const errors = overlay.issues.filter((issue) => issue.severity === "error" && issue.code !== "PATTERN_QUARANTINED");
    const warnings = overlay.issues.filter((issue) => issue.severity === "warning");
    if (overlaysDisabled()) {
        checks.push({
            name: "recall-gate-overlay",
            status: "ok",
            detail: "MEMEX_DISABLE_OVERLAYS=1 — built-in defaults only, no overlay is read",
        });
    }
    else if (!overlay.present) {
        checks.push({ name: "recall-gate-overlay", status: "ok", detail: "absent — built-in defaults only" });
    }
    else if (errors.length > 0) {
        checks.push({
            name: "recall-gate-overlay",
            status: "fail",
            detail: `unreadable/invalid — running on BUILT-IN DEFAULTS: ${errors.map((issue) => issue.code).join(", ")}` +
                " — run: memex gate validate",
        });
    }
    else {
        const applied = `applied: ${overlay.hash} rev ${overlay.revision}, ${overlay.patterns.length} user pattern(s), ` +
            `${overlay.disabled.length} disabled`;
        checks.push(warnings.length > 0
            ? {
                name: "recall-gate-overlay",
                status: "warn",
                detail: `${applied} with ${warnings.length} warning(s): ${warnings.map((i) => i.code).join(", ")}`,
            }
            : { name: "recall-gate-overlay", status: "ok", detail: applied });
    }
    const quarantined = overlay.quarantined;
    checks.push(quarantined.length === 0
        ? { name: "overlay-pattern-quarantine", status: "ok", detail: "no quarantined pattern" }
        : {
            name: "overlay-pattern-quarantine",
            status: "fail",
            detail: `${quarantined.length} pattern(s) quarantined after exceeding the 50 ms match budget — ` +
                `they are NOT applied: ${quarantined.map((entry) => entry.pattern_id).join(", ")}` +
                " — run: memex gate quarantine list",
        });
    if (overlaysDisabled()) {
        checks.push({
            name: "overlay-matcher",
            status: "ok",
            detail: "MEMEX_DISABLE_OVERLAYS=1 — no matcher worker is created",
        });
    }
    else if (overlay.patterns.length === 0) {
        // OK, not `warn`. Nothing is wrong with a machine that has no user patterns —
        // that is the default install — and a warn here made `memex doctor` report
        // PARTIAL out of the box, which trains operators to ignore the verdict. A
        // matcher that is idle because there is nothing to run is the correct state;
        // `warn`/`fail` below are for an overlay that IS present and cannot run.
        checks.push({
            name: "overlay-matcher",
            status: "ok",
            detail: "no user patterns — matcher idle",
        });
    }
    else {
        let available = false;
        try {
            available = matcherProbe ? await matcherProbe() : await defaultMatcherProbe(overlay);
        }
        catch {
            available = false;
        }
        checks.push(available
            ? { name: "overlay-matcher", status: "ok", detail: "pattern matcher worker available" }
            : {
                name: "overlay-matcher",
                status: "fail",
                detail: "matcher worker unavailable — gate patterns are not applied (fail-safe); " +
                    "extraction is HELD (fail-closed)",
            });
    }
    return checks;
}
async function defaultMatcherProbe(overlay) {
    const { oneShotMatcher } = await import("./overlay-matcher.js");
    const matcher = oneShotMatcher();
    try {
        // A trivial text against the real patterns: it proves the worker runs without
        // measuring anything, and a quarantine here would be a real finding.
        const hits = await matcher.match({
            text: "memex doctor overlay-matcher probe",
            patterns: overlay.patterns,
            overlay: "recall-gate",
            surface: "doctor",
        });
        return !hits.unavailable;
    }
    finally {
        matcher.dispose();
    }
}
