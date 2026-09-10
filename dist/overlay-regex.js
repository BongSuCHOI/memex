/**
 * Overlay regex grammar subset — DEFENCE IN DEPTH, NOT A SAFETY PROOF.
 *
 * Read this before trusting anything below (decisions-v2 D1).
 *
 * The 0.7.0 v2 design called this a "safe regex subset" and claimed it ruled out
 * catastrophic backtracking. It does not. The reviewer's counterexample
 *
 *   ^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$
 *
 * has no groups, no backreferences, no lookaround, and no two ADJACENT quantified
 * atoms whose first-character sets intersect — it passes every structural rule
 * here — and on the input `'a'.repeat(80) + '!'` it does not terminate in any
 * useful time. Lowering the quantifier budget from 20 to 8 does not fix it
 * either: `^a+b?a+b?a+b?a+$` has seven quantifiers and the same shape.
 *
 * So this module makes NO safety claim. What keeps a user pattern from stopping
 * the hook is src/overlay-matcher.ts: user patterns execute ONLY inside a
 * worker_thread under a 50 ms wall clock, and a pattern that burns that budget
 * is quarantined and dropped from matching. This parser exists to:
 *
 *  - reject constructs the overlay has no use for (backreferences, lookaround);
 *  - catch the ORDINARY author mistake early, with a stable code and a useful
 *    message, instead of at match time as a quarantine;
 *  - bound the work the parser itself does (it is pure, linear and terminating,
 *    so the load path can run it on every request).
 *
 * Every real-world shape in the design's acceptance list passes:
 *   배포\s*이력 · \bsk-[A-Za-z0-9_-]{16,} · (확정|최종 결정) · ^(ok|okay)$ ·
 *   (?:re)?deploy · [가-힣]{2,10} · .*배포
 */
import { createHash } from "node:crypto";
function camelCode(code) {
    return code
        .toLowerCase()
        .split("_")
        .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
        .join("");
}
/** Build an `Issue`, deriving the i18n key from the code so the two cannot drift. */
export function overlayIssue(severity, code, message, extra = {}) {
    return {
        severity,
        code,
        key: `overlays.issue.${camelCode(code)}`,
        message,
        ...(extra.path === undefined ? {} : { path: extra.path }),
        ...(extra.params === undefined ? {} : { params: extra.params }),
        ...(extra.row === undefined ? {} : { row: extra.row }),
        ...(extra.field === undefined ? {} : { field: extra.field }),
    };
}
export const OVERLAY_REGEX_LIMITS = Object.freeze({
    /** `source` characters (§1.3). */
    sourceChars: 200,
    /** Total quantifiers anywhere in the pattern (§1.3, lowered from 20 in v2). */
    quantifiers: 8,
    /** Group nesting depth. */
    depth: 5,
    /** Alternation branches, summed over the whole pattern. */
    branches: 32,
    /** Upper bound of `{n,m}`. */
    repeatMax: 100,
    /** Flags an overlay pattern may carry. */
    flags: "isu",
});
/* -------------------------------------------------------------------------- */
/* First-character sets                                                        */
/* -------------------------------------------------------------------------- */
/**
 * The adjacency rule needs "can these two atoms start on the same character?".
 *
 * Rather than compiling a user fragment (this module must never execute
 * user-authored regex, not even an atom), membership is decided by hand over a
 * fixed representative alphabet. Two atoms overlap iff some sample character is
 * in both sets. The alphabet covers ASCII plus a few Hangul/Latin-1
 * representatives, which is enough to catch `a+a+`, `\w+\d+` and `.*.*` while
 * leaving `\s*이력` alone.
 */
const SAMPLE_ALPHABET = (() => {
    const chars = [];
    for (let code = 0x20; code <= 0x7e; code++)
        chars.push(String.fromCharCode(code));
    chars.push("\t", "\n", "\r", "é", "а", "가", "힣", "ㄱ", "一");
    return Object.freeze(chars);
})();
const EMPTY_SET = SAMPLE_ALPHABET.map(() => false);
const ANY_SET = SAMPLE_ALPHABET.map(() => true);
function setFrom(predicate) {
    return SAMPLE_ALPHABET.map(predicate);
}
function unionSets(a, b) {
    return a.map((value, index) => value || b[index]);
}
function intersects(a, b) {
    for (let i = 0; i < a.length; i++)
        if (a[i] && b[i])
            return true;
    return false;
}
const IS_WORD = (ch) => /[A-Za-z0-9_]/.test(ch);
const IS_DIGIT = (ch) => ch >= "0" && ch <= "9";
const IS_SPACE = (ch) => /\s/.test(ch);
const IS_LETTER = (ch) => /\p{L}/u.test(ch);
class RejectedRegex extends Error {
    problem;
    constructor(problem) {
        super(problem.message);
        this.problem = problem;
    }
}
const ESCAPE_LITERALS = {
    t: "\t", n: "\n", r: "\r", f: "\f", v: "\v", "0": "\0",
};
class SubsetParser {
    src;
    i = 0;
    quantifiers = 0;
    branches = 0;
    maxDepth = 0;
    depth = 0;
    caseInsensitive;
    dotAll;
    constructor(src, flags) {
        this.src = src;
        this.caseInsensitive = flags.includes("i");
        this.dotAll = flags.includes("s");
    }
    parse() {
        this.alternation();
        if (this.i < this.src.length) {
            this.reject("REGEX_UNSUPPORTED_SYNTAX", `unexpected "${this.src[this.i]}"`, this.i);
        }
    }
    reject(code, detail, at, params) {
        throw new RejectedRegex({
            code,
            message: `${detail}${at === undefined ? "" : ` at offset ${at}`}`,
            ...(at === undefined ? {} : { at }),
            ...(params ? { params } : {}),
        });
    }
    peek(offset = 0) {
        return this.src[this.i + offset];
    }
    /** alternation := concat ('|' concat)* */
    alternation() {
        let first = this.concat();
        let seen = 1;
        while (this.peek() === "|") {
            this.i++;
            seen++;
            this.branches++;
            if (this.branches > OVERLAY_REGEX_LIMITS.branches) {
                this.reject("REGEX_QUANTIFIER_BUDGET", `too many alternation branches (limit ${OVERLAY_REGEX_LIMITS.branches})`, this.i, { limit: OVERLAY_REGEX_LIMITS.branches });
            }
            first = { first: unionSets(first.first, this.concat().first), composite: true };
        }
        return seen > 1 ? { first: first.first, composite: true } : first;
    }
    /** concat := quantified* — returns the FIRST-character set, and enforces adjacency. */
    concat() {
        let head = EMPTY_SET;
        let previous = null;
        /** True while every element so far could match the empty string. */
        let headOpen = true;
        while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
            const current = this.quantified();
            if (headOpen) {
                head = unionSets(head, current.atom.first);
                if (!current.nullable)
                    headOpen = false;
            }
            // `a+b?a+` slips past this on purpose — see the module header: adjacency is
            // an author-mistake filter, not a backtracking proof.
            if (previous && previous.quantified && current.quantified &&
                previous.max > 1 && current.max > 1 &&
                intersects(previous.atom.first, current.atom.first)) {
                this.reject("REGEX_ADJACENT_OVERLAP", "two adjacent repeated atoms can start on the same character (e.g. a+a+, \\w+\\d+, .*.*)", this.i);
            }
            previous = current;
        }
        return { first: head, composite: false };
    }
    /** quantified := atom quantifier? */
    quantified() {
        const start = this.i;
        const atom = this.atom();
        const quantifier = this.quantifier();
        if (!quantifier) {
            return { atom, max: 1, quantified: false, nullable: atom.zeroWidth === true };
        }
        this.quantifiers++;
        if (this.quantifiers > OVERLAY_REGEX_LIMITS.quantifiers) {
            this.reject("REGEX_QUANTIFIER_BUDGET", `too many quantifiers (limit ${OVERLAY_REGEX_LIMITS.quantifiers})`, start, { limit: OVERLAY_REGEX_LIMITS.quantifiers, seen: this.quantifiers });
        }
        if (atom.composite && quantifier.max > 1) {
            this.reject("REGEX_QUANTIFIED_GROUP", "a group or alternation may not be repeated more than once (use ? or {0,1})", start);
        }
        return {
            atom,
            max: quantifier.max,
            quantified: true,
            nullable: quantifier.min === 0 || atom.zeroWidth === true,
        };
    }
    quantifier() {
        const ch = this.peek();
        if (ch === "?") {
            this.i++;
            this.lazyOrPossessive();
            return { min: 0, max: 1 };
        }
        if (ch === "*") {
            this.i++;
            this.lazyOrPossessive();
            return { min: 0, max: Infinity };
        }
        if (ch === "+") {
            this.i++;
            this.lazyOrPossessive();
            return { min: 1, max: Infinity };
        }
        if (ch !== "{")
            return null;
        const close = this.src.indexOf("}", this.i);
        const body = close < 0 ? null : this.src.slice(this.i + 1, close);
        if (body === null || !/^\d+(,\d*)?$/.test(body)) {
            // `{` that is not a valid repetition is a literal brace in JS regex, but
            // the subset does not accept it: it is almost always a typo.
            this.reject("REGEX_UNSUPPORTED_SYNTAX", 'a literal "{" must be escaped as \\{', this.i);
        }
        const [rawMin, rawMax] = body.split(",");
        const min = Number(rawMin);
        const max = rawMax === undefined ? min : rawMax === "" ? Infinity : Number(rawMax);
        this.i = close + 1;
        this.lazyOrPossessive();
        if (max < min) {
            this.reject("REGEX_QUANTIFIER_BUDGET", `{n,m} with m < n (${body})`, this.i, { body });
        }
        if (Number.isFinite(max) && max > OVERLAY_REGEX_LIMITS.repeatMax) {
            this.reject("REGEX_QUANTIFIER_BUDGET", `{n,m} upper bound above ${OVERLAY_REGEX_LIMITS.repeatMax} (${body})`, this.i, { limit: OVERLAY_REGEX_LIMITS.repeatMax, body });
        }
        return { min, max };
    }
    /** `??`/`*?`/`+?` are allowed (lazy); `*+` etc. are not JS syntax. */
    lazyOrPossessive() {
        if (this.peek() === "?")
            this.i++;
    }
    atom() {
        const ch = this.peek();
        if (ch === undefined)
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "pattern ends mid-atom", this.i);
        if (ch === "(")
            return this.group();
        if (ch === "[")
            return this.charClass();
        if (ch === "\\")
            return this.escape();
        if (ch === ".") {
            this.i++;
            return { first: this.dotAll ? ANY_SET : setFrom((c) => c !== "\n"), composite: false };
        }
        if (ch === "^" || ch === "$") {
            this.i++;
            // Anchors consume no character, so they contribute nothing to a first set
            // and must never be treated as a repeated atom.
            return { first: EMPTY_SET, composite: false, zeroWidth: true };
        }
        if (ch === "*" || ch === "+" || ch === "?") {
            this.reject("REGEX_UNSUPPORTED_SYNTAX", `quantifier "${ch}" with nothing to repeat`, this.i);
        }
        this.i++;
        return { first: this.literal(ch), composite: false };
    }
    literal(ch) {
        if (!this.caseInsensitive)
            return setFrom((c) => c === ch);
        const lower = ch.toLowerCase();
        const upper = ch.toUpperCase();
        return setFrom((c) => c === lower || c === upper);
    }
    group() {
        const open = this.i;
        this.i++; // '('
        if (this.peek() === "?") {
            const next = this.peek(1);
            if (next === ":") {
                this.i += 2;
            }
            else if (next === "=" || next === "!" || next === "<") {
                this.reject("REGEX_LOOKAROUND", "lookahead and lookbehind are not allowed", open);
            }
            else {
                this.reject("REGEX_UNSUPPORTED_SYNTAX", `unsupported group "(?${next ?? ""}"`, open);
            }
        }
        this.depth++;
        this.maxDepth = Math.max(this.maxDepth, this.depth);
        if (this.depth > OVERLAY_REGEX_LIMITS.depth) {
            this.reject("REGEX_QUANTIFIER_BUDGET", `group nesting deeper than ${OVERLAY_REGEX_LIMITS.depth}`, open, { limit: OVERLAY_REGEX_LIMITS.depth });
        }
        const inner = this.alternation();
        this.depth--;
        if (this.peek() !== ")")
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "unbalanced (", open);
        this.i++;
        return { first: inner.first, composite: true };
    }
    escape() {
        const at = this.i;
        this.i++; // '\'
        const ch = this.peek();
        if (ch === undefined)
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "pattern ends with a backslash", at);
        if (ch >= "1" && ch <= "9") {
            this.reject("REGEX_BACKREFERENCE", "numeric backreferences are not allowed", at);
        }
        if (ch === "k")
            this.reject("REGEX_BACKREFERENCE", "named backreferences are not allowed", at);
        this.i++;
        switch (ch) {
            case "w": return { first: setFrom(IS_WORD), composite: false };
            case "W": return { first: setFrom((c) => !IS_WORD(c)), composite: false };
            case "d": return { first: setFrom(IS_DIGIT), composite: false };
            case "D": return { first: setFrom((c) => !IS_DIGIT(c)), composite: false };
            case "s": return { first: setFrom(IS_SPACE), composite: false };
            case "S": return { first: setFrom((c) => !IS_SPACE(c)), composite: false };
            case "b":
            case "B": return { first: EMPTY_SET, composite: false, zeroWidth: true };
            case "p":
            case "P": return { first: this.unicodeProperty(ch === "P"), composite: false };
            case "u":
            case "x": return { first: this.literal(this.numericEscapeChar(ch)), composite: false };
            default:
                if (ESCAPE_LITERALS[ch] !== undefined) {
                    return { first: this.literal(ESCAPE_LITERALS[ch]), composite: false };
                }
                if (/[A-Za-z]/.test(ch)) {
                    this.reject("REGEX_UNSUPPORTED_SYNTAX", `unsupported escape \\${ch}`, at);
                }
                return { first: this.literal(ch), composite: false };
        }
    }
    unicodeProperty(negated) {
        if (this.peek() !== "{")
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "\\p must be followed by {", this.i);
        const close = this.src.indexOf("}", this.i);
        if (close < 0)
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "unterminated \\p{…}", this.i);
        const name = this.src.slice(this.i + 1, close);
        this.i = close + 1;
        let base;
        if (/^(L|Letter|Alphabetic|Alpha)$/.test(name))
            base = setFrom(IS_LETTER);
        else if (/^(N|Nd|Number|Digit)$/.test(name))
            base = setFrom(IS_DIGIT);
        // Unknown property: assume it can start anywhere. Conservative for the
        // adjacency rule (it may reject a pair that is in fact disjoint), which is
        // the right direction for a defence-in-depth check.
        else
            base = ANY_SET;
        return negated ? base.map((value) => !value) : base;
    }
    /** Consumes the digits of `\xHH`, `\uHHHH` or `\u{…}` and returns the character. */
    numericEscapeChar(kind) {
        if (kind === "x") {
            const hex = this.src.slice(this.i, this.i + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex))
                this.reject("REGEX_UNSUPPORTED_SYNTAX", "\\xHH needs two hex digits", this.i);
            this.i += 2;
            return String.fromCharCode(parseInt(hex, 16));
        }
        if (this.peek() === "{") {
            const close = this.src.indexOf("}", this.i);
            if (close < 0)
                this.reject("REGEX_UNSUPPORTED_SYNTAX", "unterminated \\u{…}", this.i);
            const hex = this.src.slice(this.i + 1, close);
            if (!/^[0-9a-fA-F]{1,6}$/.test(hex))
                this.reject("REGEX_UNSUPPORTED_SYNTAX", "\\u{…} needs hex digits", this.i);
            this.i = close + 1;
            return String.fromCodePoint(parseInt(hex, 16));
        }
        const hex = this.src.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex))
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "\\uHHHH needs four hex digits", this.i);
        this.i += 4;
        return String.fromCharCode(parseInt(hex, 16));
    }
    charClass() {
        const open = this.i;
        this.i++; // '['
        const negated = this.peek() === "^";
        if (negated)
            this.i++;
        const members = [];
        let closed = false;
        while (this.i < this.src.length) {
            if (this.peek() === "]") {
                this.i++;
                closed = true;
                break;
            }
            const item = this.classItem(open);
            // Range: `a-z`, but a trailing `-` before `]` is a literal.
            if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
                this.i++;
                const upper = this.classItem(open);
                if (item.literal === null || upper.literal === null) {
                    this.reject("REGEX_UNSUPPORTED_SYNTAX", "a character class range needs literal bounds", open);
                }
                const lo = item.literal.codePointAt(0);
                const hi = upper.literal.codePointAt(0);
                if (hi < lo)
                    this.reject("REGEX_UNSUPPORTED_SYNTAX", "reversed character class range", open);
                members.push((ch) => {
                    const code = ch.codePointAt(0);
                    if (code >= lo && code <= hi)
                        return true;
                    if (!this.caseInsensitive)
                        return false;
                    const other = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
                    const otherCode = other.codePointAt(0);
                    return otherCode >= lo && otherCode <= hi;
                });
                continue;
            }
            members.push(item.test);
        }
        if (!closed)
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "unterminated character class", open);
        const inside = (ch) => members.some((test) => test(ch));
        return { first: setFrom(negated ? (ch) => !inside(ch) : inside), composite: false };
    }
    classItem(open) {
        const ch = this.peek();
        if (ch === undefined)
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "unterminated character class", open);
        if (ch !== "\\") {
            this.i++;
            const lower = ch.toLowerCase();
            const upper = ch.toUpperCase();
            const test = this.caseInsensitive
                ? (c) => c === lower || c === upper
                : (c) => c === ch;
            return { test, literal: ch };
        }
        const at = this.i;
        this.i++;
        const esc = this.peek();
        if (esc === undefined)
            this.reject("REGEX_UNSUPPORTED_SYNTAX", "class ends with a backslash", at);
        if (esc >= "1" && esc <= "9") {
            this.reject("REGEX_BACKREFERENCE", "numeric backreferences are not allowed", at);
        }
        this.i++;
        switch (esc) {
            case "w": return { test: IS_WORD, literal: null };
            case "W": return { test: (c) => !IS_WORD(c), literal: null };
            case "d": return { test: IS_DIGIT, literal: null };
            case "D": return { test: (c) => !IS_DIGIT(c), literal: null };
            case "s": return { test: IS_SPACE, literal: null };
            case "S": return { test: (c) => !IS_SPACE(c), literal: null };
            case "b": return { test: (c) => c === "\b", literal: "\b" };
            case "p":
            case "P": {
                const set = this.unicodeProperty(esc === "P");
                const table = new Map(SAMPLE_ALPHABET.map((sample, index) => [sample, set[index]]));
                return { test: (c) => table.get(c) === true, literal: null };
            }
            case "u":
            case "x": {
                const literal = this.numericEscapeChar(esc);
                const lower = literal.toLowerCase();
                const upper = literal.toUpperCase();
                const test = this.caseInsensitive
                    ? (c) => c === lower || c === upper
                    : (c) => c === literal;
                return { test, literal };
            }
            default: {
                const literal = ESCAPE_LITERALS[esc] ?? esc;
                if (ESCAPE_LITERALS[esc] === undefined && /[A-Za-z]/.test(esc)) {
                    this.reject("REGEX_UNSUPPORTED_SYNTAX", `unsupported escape \\${esc} in a character class`, at);
                }
                const lower = literal.toLowerCase();
                const upper = literal.toUpperCase();
                const test = this.caseInsensitive
                    ? (c) => c === lower || c === upper
                    : (c) => c === literal;
                return { test, literal };
            }
        }
    }
}
/**
 * Structural check for one overlay pattern. Pure, linear in `source.length`, and
 * guaranteed to terminate — which is why the load path runs it on every request
 * while the measuring probe (§2.3.2) only runs on writes.
 */
export function checkOverlayRegex(source, flags) {
    const problems = [];
    if (typeof source !== "string" || source.length === 0) {
        return {
            ok: false,
            problems: [{ code: "REGEX_UNSUPPORTED_SYNTAX", message: "pattern source is empty" }],
            quantifiers: 0, depth: 0, branches: 0,
        };
    }
    if (source.length > OVERLAY_REGEX_LIMITS.sourceChars) {
        problems.push({
            code: "PATTERN_TOO_LONG",
            message: `pattern is ${source.length} characters (limit ${OVERLAY_REGEX_LIMITS.sourceChars})`,
            params: { length: source.length, limit: OVERLAY_REGEX_LIMITS.sourceChars },
        });
    }
    const badFlags = [...new Set(flags ?? "")].filter((flag) => !OVERLAY_REGEX_LIMITS.flags.includes(flag));
    if (badFlags.length > 0) {
        problems.push({
            code: "PATTERN_FLAGS_REJECTED",
            message: `flags "${badFlags.join("")}" are not allowed (only i, s, u). ` +
                "g/y make .test() stateful through lastIndex, so the same prompt would be judged differently " +
                "each time; m changes what ^ and $ mean, which misreads multi-line prompts against the " +
                "anchored built-in acknowledgement patterns.",
            params: { flags: badFlags.join("") },
        });
    }
    // Compile before parsing: an uncompilable pattern has no meaningful structure,
    // and `new RegExp` with no match attempt cannot backtrack.
    if (badFlags.length === 0) {
        try {
            new RegExp(source, flags ?? "");
        }
        catch (error) {
            problems.push({
                code: "PATTERN_UNCOMPILABLE",
                message: `the pattern does not compile: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    const parser = new SubsetParser(source, flags ?? "");
    try {
        parser.parse();
    }
    catch (error) {
        if (error instanceof RejectedRegex)
            problems.push(error.problem);
        else
            throw error;
    }
    return {
        ok: problems.length === 0,
        problems,
        quantifiers: parser.quantifiers,
        depth: parser.maxDepth,
        branches: parser.branches,
    };
}
/** `sha8(intent \0 source \0 flags)` — the deterministic id of a user pattern (§2.2). */
export function userPatternId(intent, source, flags) {
    return `user.${sha8(`${intent}\0${source}\0${flags}`)}`;
}
/** First 8 hex characters of the sha256 of `text`. */
export function sha8(text) {
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}
/** `source_sha8` — the quarantine key's second half, so a FIX auto-clears it. */
export function patternSourceSha8(source, flags) {
    return sha8(`${source}\0${flags}`);
}
/**
 * Canonical JSON: object keys sorted, no whitespace. The overlay hash must not
 * move when a re-save reorders keys, or the extraction drift warning fires for
 * nothing.
 */
export function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value) ?? "null";
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
