/**
 * `memex gate` — the CLI surface of the recall-gate overlay (issue #29, §2.6).
 *
 * Everything here is either a READ of the applied overlay or a write that goes
 * through `applyOverlayChange` (lock + revision CAS + validation + history +
 * audit, §1.5). This module owns no file format, no validation rule and no lock:
 * it formats what `src/overlay-admin.ts` and `src/recall-gate-overlay.ts` decide.
 *
 * Three properties the transcripts depend on:
 *  - `test`/`replay`/`validate`/`--dry-run` write NOTHING — no inject log, no
 *    recall receipt, no session state, no overlay file. The single exception is
 *    the quarantine file: `test` runs user patterns through the REAL matcher, so
 *    a pattern that blows the 50 ms budget is quarantined here exactly as it
 *    would be in production, and that fact is recorded (§2.7).
 *  - no model and no embedding call is ever made.
 *  - a refusal changes nothing: the issue rows name the path and severity, and
 *    the exit code is 1 (§4).
 */
import fs from "fs";
import { OverlayInvalidError, OverlayLockedError, OverlayStaleError, PROBE_WALL_MS, addGatePattern, applyOverlayChange, clearQuarantine, disableGatePattern, listOverlayHistory, listOverlaySnapshots, overlayPaths, readOverlaySnapshot, resetOverlay, resolveGatePatternId, rollbackOverlay, setGateWords, validateOverlay, } from "./overlay-admin.js";
import { OVERLAY_LIMITS, RECALL_GATE_OVERLAY_SCHEMA, RECALL_GATE_OVERLAY_VERSION, currentRecallGateRevision, explainRecall, gateCatalog, loadRecallGateOverlay, overlaysDisabled, readRecallGateOverlayFile, } from "./recall-gate-overlay.js";
import { MATCH_WALL_MS, oneShotMatcher, readQuarantine, } from "./overlay-matcher.js";
import { userPatternId } from "./overlay-regex.js";
const USAGE = `Usage:
  memex gate show [--json]
  memex gate patterns list [--intent <intent>] [--source builtin|user|disabled|quarantined|all] [--json]
  memex gate patterns add <intent> <regex> [--flags <isu>] [--note "<why>"] [--expect-revision <n>] [--dry-run] [--json]
  memex gate patterns disable <id|regex> [--flags <isu>] [--expect-revision <n>] [--dry-run] [--json]
  memex gate patterns enable <id> [--expect-revision <n>] [--dry-run] [--json]
  memex gate words list [--json]
  memex gate words add|remove <ack|continue|filler> <word> [--expect-revision <n>] [--dry-run] [--json]
  memex gate test "<prompt>" [--session <id>] [--compare-builtin] [--json]
  memex gate replay [--limit <n>] [--project <path>] [--json]
  memex gate validate [--file <path>] [--json]
  memex gate history [--limit <n>] [--json]
  memex gate quarantine list [--json]
  memex gate quarantine clear [<pattern-id>|--all] [--json]
  memex gate reset [--intent <intent>] --yes [--dry-run] [--json]
  memex gate rollback --to <revision> [--dry-run] [--json]

The recall-gate overlay adds your own regexes and words to the built-in gate
that decides whether a prompt retrieves memory. Built-ins are never deleted:
'patterns disable' switches one off by id and 'patterns enable' switches it back
on. 'patterns remove' is accepted as an alias of 'patterns disable'.

READ-ONLY verbs: show, patterns list, words list, test, replay, validate,
history, quarantine list. test and replay call NO model and NO embedding, and
write neither the inject log nor any recall receipt or session state.

WRITE verbs (patterns add/disable/enable, words add/remove, reset, rollback,
quarantine clear) take the overlay write lock, bump 'revision', keep a
rollback snapshot and append one metadata line to logs/ui-audit.jsonl and
overlays/history.jsonl. --dry-run validates and prints the command to re-run
with the current revision, writing nothing. --expect-revision <n> refuses the
write when the overlay changed elsewhere first (exit 1, OVERLAY_STALE).

User patterns run only inside a worker thread with a ${MATCH_WALL_MS} ms budget per prompt.
A pattern that exceeds it is QUARANTINED: it stops being applied until you fix
the regex (which clears it automatically) or run 'gate quarantine clear <id>'.
The syntax limits and the ${PROBE_WALL_MS} ms write-time probe are defence in depth, not a proof.

EXAMPLES:
  memex gate patterns add memory '배포\\s*이력' --note "배포 이력 질문은 항상 회수"
  memex gate test "왜 auth를 supabase로 바꿨지?" --compare-builtin
  memex gate patterns disable memory.kr.다시
  memex gate quarantine list
  memex gate rollback --to 7`;
const argv = process.argv.slice(2);
/**
 * Issue #36 — `--help` must never do the work. `cli/memex.js` already forwards
 * only `--help`, and this is the second, independent refusal.
 */
if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
}
/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */
const VALUE_FLAGS = new Set([
    "--intent",
    "--source",
    "--flags",
    "--note",
    "--expect-revision",
    "--limit",
    "--project",
    "--file",
    "--to",
    "--session",
]);
const BOOL_FLAGS = new Set(["--json", "--dry-run", "--yes", "--all", "--compare-builtin"]);
const positional = [];
const values = new Map();
const bools = new Set();
const INTENTS = [
    "memory",
    "trace",
    "highImpact",
    "acknowledgement",
    "continuation",
    "minorCorrection",
];
const LEXICONS = ["ack", "continue", "filler"];
const SOURCES = ["builtin", "user", "disabled", "quarantined", "all"];
const json = argv.includes("--json");
function usageError(message) {
    if (json) {
        console.log(JSON.stringify({ ok: false, error: { code: "INVALID_USAGE", message } }, null, 2));
    }
    else {
        console.error(`${message}\n\n${USAGE}`);
    }
    process.exit(1);
}
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
        const next = argv[i + 1];
        if (next === undefined)
            usageError(`${arg} needs a value`);
        values.set(arg, next);
        i++;
        continue;
    }
    if (BOOL_FLAGS.has(arg)) {
        bools.add(arg);
        continue;
    }
    // A regex source may begin with a single dash; only `--flag` is an option.
    if (arg.startsWith("--"))
        usageError(`unknown option ${arg}`);
    positional.push(arg);
}
function intValue(flag, fallback) {
    const raw = values.get(flag);
    if (raw === undefined)
        return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0)
        usageError(`${flag} must be a non-negative integer`);
    return parsed;
}
/* -------------------------------------------------------------------------- */
/* Output helpers                                                              */
/* -------------------------------------------------------------------------- */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
/** Terminal columns, counting CJK as two — the transcripts are column-aligned. */
function width(text) {
    let total = 0;
    for (const ch of text)
        total += WIDE.test(ch) ? 2 : 1;
    return total;
}
function pad(text, target) {
    return text + " ".repeat(Math.max(1, target - width(text)));
}
/** `label` column of the `show`/`test` transcripts. */
function row(label, text) {
    return `${pad(label, 12)}${text}`;
}
const CONTINUE = " ".repeat(12);
function emit(payload, lines) {
    if (json)
        console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
    else
        console.log(lines.join("\n"));
}
function fail(code, lines, extra = {}) {
    if (json) {
        console.log(JSON.stringify({ ok: false, error: { code, message: lines[0], ...extra } }, null, 2));
    }
    else {
        console.error(lines.join("\n"));
    }
    process.exit(1);
}
/** One issue per line: severity, stable code, document path, English message. */
function issueLines(issues) {
    return issues.map((issue) => `  ${pad(issue.severity, 9)}${pad(issue.code, 26)}${pad(issue.path ?? "-", 22)}${issue.message}`);
}
const SLOW_PATTERN_NOTE = [
    "참고: 문법 검사만으로는 이런 패턴을 전부 걸러낼 수 없습니다. 저장되더라도 실행은",
    `      ${MATCH_WALL_MS}ms 상한 안에서만 일어나고, 상한을 넘으면 해당 패턴은 격리되어 회수 판정에서 빠집니다.`,
];
function hasRegexIssue(issues) {
    return issues.some((issue) => issue.code.startsWith("REGEX_") || issue.code === "PATTERN_TOO_SLOW");
}
/** Map the admin layer's refusals onto §4's codes and exit 1. */
function failFromError(error) {
    if (error instanceof OverlayInvalidError) {
        const errors = error.issues.filter((issue) => issue.severity === "error");
        fail("OVERLAY_INVALID", [
            "거부 — 아무것도 저장하지 않았습니다.",
            ...issueLines(error.issues),
            ...(hasRegexIssue(errors) ? SLOW_PATTERN_NOTE : []),
        ], { issues: error.issues });
    }
    if (error instanceof OverlayStaleError) {
        fail("OVERLAY_STALE", [
            "거부 — 아무것도 저장하지 않았습니다.",
            `  OVERLAY_STALE  현재 revision ${error.currentRevision} (기대 ${error.expectedRevision}) — 다른 곳에서 먼저 바뀌었습니다.`,
        ], { currentRevision: error.currentRevision, expectedRevision: error.expectedRevision });
    }
    if (error instanceof OverlayLockedError) {
        fail("OVERLAY_LOCKED", [
            "거부 — 아무것도 저장하지 않았습니다.",
            error.holderPid === null
                ? "  OVERLAY_LOCKED  다른 프로세스가 규칙을 쓰고 있습니다 (lock을 읽을 수 없었습니다)."
                : `  OVERLAY_LOCKED  다른 프로세스(pid ${error.holderPid})가 규칙을 쓰고 있습니다.`,
        ], { holderPid: error.holderPid });
    }
    fail("GATE_CLI_ERROR", [
        "거부 — 아무것도 저장하지 않았습니다.",
        `  ${error instanceof Error ? error.message : String(error)}`,
    ]);
}
/* -------------------------------------------------------------------------- */
/* Shared reads                                                                */
/* -------------------------------------------------------------------------- */
function shortTime(iso) {
    if (!iso)
        return "-";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return iso;
    const pad2 = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function gateQuarantine() {
    return readQuarantine().filter((entry) => entry.overlay === "recall-gate");
}
function emptyGateDoc() {
    return {
        schema: RECALL_GATE_OVERLAY_SCHEMA,
        version: RECALL_GATE_OVERLAY_VERSION,
        revision: 0,
        patterns: { add: [], disable: [] },
        words: {
            add: { ack: [], continue: [], filler: [] },
            disable: { ack: [], continue: [], filler: [] },
        },
    };
}
/**
 * The file as written, NOT the applied view.
 *
 * `--dry-run` has to validate the document the write would produce, which means
 * starting from the bytes on disk even when the applied overlay is empty because
 * it failed validation.
 */
function currentRawDoc() {
    const { raw, present } = readRecallGateOverlayFile();
    if (present && raw && typeof raw === "object" && !Array.isArray(raw)) {
        return JSON.parse(JSON.stringify(raw));
    }
    return emptyGateDoc();
}
function expectRevision() {
    const raw = values.get("--expect-revision");
    if (raw === undefined)
        return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0)
        usageError("--expect-revision must be a non-negative integer");
    return parsed;
}
/** The exact command to re-run, with the revision observed during the dry run. */
function rerunCommand(revision, extra = []) {
    const parts = ["memex", "gate"];
    for (const arg of argv) {
        if (arg === "--dry-run")
            continue;
        if (arg === "--expect-revision")
            continue;
        parts.push(/[\s'"\\]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg);
    }
    // Flags the destructive form requires but the dry run did not: printing a
    // command that then refuses with CONFIRMATION_REQUIRED is not a re-run command.
    for (const flag of extra)
        if (!parts.includes(flag))
            parts.push(flag);
    // Drop the value that followed --expect-revision, then re-add the observed one.
    const index = argv.indexOf("--expect-revision");
    if (index >= 0) {
        const stale = argv[index + 1];
        const at = parts.lastIndexOf(stale);
        if (at >= 0)
            parts.splice(at, 1);
    }
    parts.push("--expect-revision", String(revision));
    return parts.join(" ");
}
/**
 * Validate the document a write would produce, print the re-run command and
 * write nothing. Exits 1 when validation found an error (§4).
 */
async function dryRun(next, summary, opts = {}) {
    const revision = currentRecallGateRevision();
    next.revision = revision + 1;
    const result = await validateOverlay("recall-gate", next, {
        // `probe: false` mirrors the write this dry run stands in for. Rollback and
        // reset do not re-probe (§2.4), and probing here would refuse a recovery
        // path on a busy machine that the real command would have accepted.
        probe: opts.probe !== false,
        forWrite: true,
    });
    const errors = result.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
        fail("OVERLAY_INVALID", [
            "시험 실행 — 거부되었습니다. 아무것도 저장하지 않았습니다.",
            ...issueLines(result.issues),
            ...(hasRegexIssue(errors) ? SLOW_PATTERN_NOTE : []),
        ], { dryRun: true, issues: result.issues });
    }
    emit({
        dryRun: true,
        revision,
        nextRevision: revision + 1,
        issues: result.issues,
        rerun: rerunCommand(revision, opts.extraFlags ?? []),
    }, [
        "시험 실행 — 아무것도 저장하지 않았습니다.",
        ...summary.map((line) => `  ${line}`),
        `검증  오류 0개 · 경고 ${result.issues.length}개`,
        ...issueLines(result.issues),
        `다음  ${rerunCommand(revision, opts.extraFlags ?? [])}`,
    ]);
    process.exit(0);
}
/** The three-line receipt every successful write prints (§2.6 transcript). */
function writeReceipt(action, headline, before, result, payload = {}) {
    emit({
        action,
        revision: result.revision,
        hash: result.hash,
        fromRevision: before.revision,
        fromHash: before.hash,
        issues: result.issues,
        quarantineCleared: result.quarantineCleared,
        file: overlayPaths().gate,
        ...payload,
    }, [
        ...headline,
        row("파일", `${overlayPaths().gate}  (revision ${before.revision} → ${result.revision}, ${before.hash ?? "없음"} → ${result.hash ?? "없음"})`),
        ...(result.quarantineCleared.length > 0
            ? [row("격리 해제", result.quarantineCleared.join(" · "))]
            : []),
        ...(result.issues.length > 0 ? ["경고", ...issueLines(result.issues)] : []),
        row("감사", `logs/ui-audit.jsonl action=${action} · overlays/history.jsonl overlay=recall-gate revision=${result.revision}`),
    ]);
}
function before() {
    const loaded = loadRecallGateOverlay();
    return { revision: currentRecallGateRevision(), hash: loaded.hash };
}
/* -------------------------------------------------------------------------- */
/* show                                                                        */
/* -------------------------------------------------------------------------- */
function intentCounts() {
    const counts = {};
    for (const intent of INTENTS)
        counts[intent] = 0;
    for (const pattern of gateCatalog().builtin)
        counts[pattern.intent] += 1;
    return counts;
}
function statusLine(loaded) {
    if (overlaysDisabled())
        return "읽지 않음 — MEMEX_DISABLE_OVERLAYS=1 · 내장 기본값만 적용됩니다";
    if (!loaded.present)
        return "없음 — 내장 기본값만 적용됩니다";
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    const onlyQuarantine = errors.length > 0 && errors.every((issue) => issue.code === "PATTERN_QUARANTINED");
    if (errors.length > 0 && !onlyQuarantine) {
        return `무시됨 — 오류 ${errors.length}개 · 내장 기본값으로 동작합니다 (memex gate validate)`;
    }
    return `적용됨 · revision ${loaded.revision} · ${loaded.hash ?? "없음"} · ${shortTime(loaded.doc?.updated_at)}`;
}
function cmdShow() {
    const loaded = loadRecallGateOverlay();
    const catalog = gateCatalog();
    const counts = intentCounts();
    const quarantined = gateQuarantine();
    const warnings = loaded.issues.filter((issue) => issue.severity === "warning");
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    const builtinTotal = catalog.builtin.length;
    const countText = INTENTS.map((intent) => `${intent} ${counts[intent]}`).join(", ");
    emit({
        file: overlayPaths().gate,
        dir: overlayPaths().dir,
        overlaysDisabled: overlaysDisabled(),
        present: loaded.present,
        revision: loaded.revision,
        hash: loaded.hash,
        updatedAt: loaded.doc?.updated_at ?? null,
        updatedBy: loaded.doc?.updated_by ?? null,
        builtin: {
            patterns: { total: builtinTotal, byIntent: counts },
            words: Object.fromEntries(LEXICONS.map((lexicon) => [lexicon, catalog.words[lexicon].length])),
        },
        user: {
            added: loaded.patterns.length,
            disabled: loaded.disabled.length,
            quarantined: quarantined.length,
            words: loaded.words,
        },
        quarantine: quarantined,
        issues: loaded.issues,
        limits: OVERLAY_LIMITS,
        matchWallMs: MATCH_WALL_MS,
        probeWallMs: PROBE_WALL_MS,
        shared: false,
    }, [
        row("파일", overlayPaths().gate),
        row("상태", statusLine(loaded)),
        row("내장", `패턴 ${builtinTotal}개 (${countText})`),
        `${CONTINUE}어휘 ${LEXICONS.map((lexicon) => `${lexicon} ${catalog.words[lexicon].length}`).join(" · ")}`,
        row("사용자", `추가 ${loaded.patterns.length}개 · 비활성 ${loaded.disabled.length}개 · 격리 ${quarantined.length}개`),
        row("실행", `사용자 패턴은 별도 스레드에서 프롬프트당 ${MATCH_WALL_MS}ms 상한으로 실행됩니다.`),
        `${CONTINUE}상한을 넘으면 그 패턴은 격리되고 회수 판정에서 빠집니다.`,
        row("경고", warnings.length === 0 && errors.length === 0
            ? "없음"
            : `오류 ${errors.length}개 · 경고 ${warnings.length}개`),
        ...issueLines(loaded.issues),
        row("적용 시점", "실행 중인 주입 데몬은 다음 프롬프트에서 이 파일을 다시 읽습니다 (재시작 불필요)."),
        row("공유", "이 규칙은 아직 기기 간에 공유되지 않습니다 (0.7.1 예정)."),
    ]);
}
function patternRows(loaded) {
    const disabled = new Set(loaded.disabled);
    const quarantined = new Map(gateQuarantine().map((entry) => [entry.pattern_id, entry]));
    const rows = [];
    for (const pattern of gateCatalog().builtin) {
        rows.push({
            origin: "builtin",
            state: disabled.has(pattern.id) ? "disabled" : "active",
            id: pattern.id,
            intent: pattern.intent,
            source: pattern.source,
            flags: pattern.flags,
        });
    }
    for (const pattern of loaded.doc?.patterns?.add ?? []) {
        rows.push({
            origin: "user",
            state: quarantined.has(pattern.id) ? "quarantined" : "active",
            id: pattern.id,
            intent: pattern.intent,
            source: pattern.source,
            flags: pattern.flags,
            ...(pattern.note ? { note: pattern.note } : {}),
        });
    }
    // A disabled id the catalogue does not know (an old build's term) is still
    // reported, because `gate show` counts it and the operator has to see what it is.
    for (const id of loaded.disabled) {
        if (!rows.some((candidate) => candidate.id === id)) {
            rows.push({ origin: "builtin", state: "disabled", id, intent: "-", source: "-", flags: "" });
        }
    }
    return rows;
}
const STATE_LABEL = {
    active: "활성",
    disabled: "비활성",
    quarantined: "격리",
    builtin: "내장",
    user: "사용자",
};
function cmdPatternsList() {
    const loaded = loadRecallGateOverlay();
    const source = values.get("--source") ?? "all";
    if (!SOURCES.includes(source)) {
        usageError(`--source must be one of: ${SOURCES.join(", ")}`);
    }
    const intent = values.get("--intent");
    if (intent !== undefined && !INTENTS.includes(intent)) {
        usageError(`--intent must be one of: ${INTENTS.join(", ")}`);
    }
    const rows = patternRows(loaded).filter((candidate) => {
        if (intent !== undefined && candidate.intent !== intent)
            return false;
        switch (source) {
            case "builtin":
                return candidate.origin === "builtin" && candidate.state === "active";
            case "user":
                return candidate.origin === "user";
            case "disabled":
                return candidate.state === "disabled";
            case "quarantined":
                return candidate.state === "quarantined";
            default:
                return true;
        }
    });
    emit({ source, intent: intent ?? null, count: rows.length, patterns: rows }, rows.length === 0
        ? ["해당하는 규칙이 없습니다."]
        : [
            `규칙 ${rows.length}개 (내장 ${rows.filter((r) => r.origin === "builtin").length} · 사용자 ${rows.filter((r) => r.origin === "user").length} · 비활성 ${rows.filter((r) => r.state === "disabled").length} · 격리 ${rows.filter((r) => r.state === "quarantined").length})`,
            ...rows.map((candidate) => `  ${pad(`[${STATE_LABEL[candidate.origin]}]`, 9)}${pad(STATE_LABEL[candidate.state], 9)}${pad(candidate.intent, 18)}${pad(candidate.id, 26)}/${candidate.source}/${candidate.flags}`),
        ]);
}
async function cmdPatternsAdd() {
    const intent = positional[2];
    const source = positional[3];
    if (!intent || !source)
        usageError("patterns add needs <intent> and <regex>");
    if (!INTENTS.includes(intent)) {
        usageError(`unknown intent ${JSON.stringify(intent)} — expected one of: ${INTENTS.join(", ")}`);
    }
    const flags = values.get("--flags") ?? "i";
    const note = values.get("--note");
    const id = userPatternId(intent, source, flags);
    if (bools.has("--dry-run")) {
        const next = currentRawDoc();
        next.patterns = next.patterns ?? {};
        next.patterns.add = [
            ...(next.patterns.add ?? []).filter((pattern) => pattern.id !== id),
            { id, intent, source, flags, ...(note ? { note } : {}), created_at: new Date().toISOString() },
        ];
        await dryRun(next, [`추가 예정  ${id}  intent=${intent}  /${source}/${flags}`]);
    }
    const snapshot = before();
    let result;
    try {
        result = await addGatePattern({ intent: intent, source, flags, ...(note ? { note } : {}) }, { surface: "cli", expectedRevision: expectRevision() });
    }
    catch (error) {
        failFromError(error);
    }
    const applied = loadRecallGateOverlay();
    writeReceipt("gate.pattern-add", [
        row("검증", `문법 ok · 컴파일 ok · 프로브 ok (상한 ${PROBE_WALL_MS}ms) · 사용자 패턴 ${applied.doc?.patterns?.add?.length ?? 0}/${OVERLAY_LIMITS.counts.patternsAdd}`),
        row("추가", `${id}  intent=${intent}  /${source}/${flags}`),
    ], snapshot, result, { id, intent, source, flags, ...(note ? { note } : {}) });
}
async function cmdPatternsDisable() {
    const target = positional[2];
    if (!target)
        usageError("patterns disable needs <id|regex>");
    const resolved = resolveGatePatternId(target, values.get("--flags"));
    if (resolved === null) {
        fail("PATTERN_UNKNOWN", [
            "거부 — 아무것도 저장하지 않았습니다.",
            `  PATTERN_UNKNOWN  ${JSON.stringify(target)}에 해당하는 규칙이 없습니다 (memex gate patterns list).`,
        ]);
    }
    const isUser = resolved.startsWith("user.");
    if (bools.has("--dry-run")) {
        const next = currentRawDoc();
        next.patterns = next.patterns ?? {};
        if (isUser) {
            next.patterns.add = (next.patterns.add ?? []).filter((pattern) => pattern.id !== resolved);
        }
        else {
            next.patterns.disable = [...new Set([...(next.patterns.disable ?? []), resolved])];
        }
        await dryRun(next, [
            isUser ? `삭제 예정  ${resolved} (사용자 패턴)` : `비활성 예정  ${resolved} (내장 규칙)`,
        ]);
    }
    const snapshot = before();
    let result;
    try {
        result = await disableGatePattern(target, {
            surface: "cli",
            expectedRevision: expectRevision(),
            ...(values.get("--flags") ? { flags: values.get("--flags") } : {}),
        });
    }
    catch (error) {
        failFromError(error);
    }
    writeReceipt("gate.pattern-disable", [
        row(isUser ? "삭제" : "비활성", isUser
            ? `${resolved} — 사용자 패턴을 지웠습니다.`
            : `${resolved} — 내장 규칙을 껐습니다 (카탈로그에는 남아 있고 memex gate patterns enable ${resolved} 로 되살립니다).`),
    ], snapshot, result, { id: resolved, builtin: !isUser });
}
/**
 * Re-enable a built-in that the overlay had switched off.
 *
 * `disable` on a built-in appends its id to `patterns.disable`, so the inverse is
 * removing that id — which is exactly what the delta's `patternsRemove` does for
 * both sides of the document.
 */
async function cmdPatternsEnable() {
    const target = positional[2];
    if (!target)
        usageError("patterns enable needs <id>");
    const loaded = loadRecallGateOverlay();
    const resolved = loaded.disabled.includes(target)
        ? target
        : resolveGatePatternId(target, values.get("--flags"));
    if (resolved === null || !loaded.disabled.includes(resolved)) {
        fail("PATTERN_NOT_DISABLED", [
            "거부 — 아무것도 저장하지 않았습니다.",
            `  PATTERN_NOT_DISABLED  ${JSON.stringify(target)}은 꺼져 있지 않습니다 (memex gate patterns list --source disabled).`,
        ]);
    }
    if (bools.has("--dry-run")) {
        const next = currentRawDoc();
        next.patterns = next.patterns ?? {};
        next.patterns.disable = (next.patterns.disable ?? []).filter((id) => id !== resolved);
        await dryRun(next, [`재활성 예정  ${resolved}`]);
    }
    const snapshot = before();
    let result;
    try {
        result = await applyOverlayChange("recall-gate", { delta: { patternsRemove: [resolved] } }, {
            surface: "cli",
            expectedRevision: expectRevision(),
            probe: false,
            auditAction: "gate.pattern-enable",
            history: { removed: [resolved] },
        });
    }
    catch (error) {
        failFromError(error);
    }
    writeReceipt("gate.pattern-enable", [row("재활성", `${resolved} — 다시 회수 판정에 참여합니다.`)], snapshot, result, { id: resolved });
}
/* -------------------------------------------------------------------------- */
/* words                                                                       */
/* -------------------------------------------------------------------------- */
function cmdWordsList() {
    const loaded = loadRecallGateOverlay();
    const catalog = gateCatalog();
    emit({
        builtin: Object.fromEntries(LEXICONS.map((lexicon) => [lexicon, catalog.words[lexicon]])),
        user: loaded.words,
    }, LEXICONS.flatMap((lexicon) => [
        row(lexicon, `내장 ${catalog.words[lexicon].length}개`),
        `${CONTINUE}추가 ${(loaded.words.add?.[lexicon] ?? []).join(" · ") || "없음"}`,
        `${CONTINUE}비활성 ${(loaded.words.disable?.[lexicon] ?? []).join(" · ") || "없음"}`,
    ]));
}
/**
 * `words add` = "make this word count", `words remove` = "stop it counting".
 *
 * Which side of the document moves is derived, not asked: adding a word that is
 * a DISABLED built-in re-enables it instead of duplicating it, and removing a
 * built-in word disables it because a built-in is never deleted (§2.1).
 */
async function cmdWords(verb) {
    const lexicon = positional[2];
    const word = positional[3];
    if (!lexicon || !word)
        usageError(`words ${verb} needs <ack|continue|filler> and <word>`);
    if (!LEXICONS.includes(lexicon)) {
        usageError(`unknown lexicon ${JSON.stringify(lexicon)} — expected one of: ${LEXICONS.join(", ")}`);
    }
    const loaded = loadRecallGateOverlay();
    const catalog = gateCatalog();
    const isBuiltin = catalog.words[lexicon].includes(word);
    const inAdd = (loaded.words.add?.[lexicon] ?? []).includes(word);
    const inDisable = (loaded.words.disable?.[lexicon] ?? []).includes(word);
    let change;
    let headline;
    if (verb === "add") {
        if (inDisable) {
            change = { removeDisable: [word] };
            headline = ["재활성", `${lexicon} "${word}" — 내장 어휘를 다시 켰습니다.`];
        }
        else if (inAdd) {
            fail("WORD_UNCHANGED", [
                "거부 — 아무것도 저장하지 않았습니다.",
                `  WORD_UNCHANGED  ${lexicon} "${word}"는 이미 추가되어 있습니다.`,
            ]);
        }
        else {
            change = { add: [word] };
            headline = ["추가", `${lexicon} "${word}"`];
        }
    }
    else {
        if (inAdd) {
            change = { removeAdd: [word] };
            headline = ["삭제", `${lexicon} "${word}" — 추가한 어휘를 지웠습니다.`];
        }
        else if (isBuiltin && !inDisable) {
            change = { disable: [word] };
            headline = [
                "비활성",
                `${lexicon} "${word}" — 내장 어휘를 껐습니다 (memex gate words add ${lexicon} ${word} 로 되살립니다).`,
            ];
        }
        else {
            fail("WORD_UNKNOWN", [
                "거부 — 아무것도 저장하지 않았습니다.",
                `  WORD_UNKNOWN  ${lexicon}에 "${word}"가 없습니다 (memex gate words list).`,
            ]);
        }
    }
    if (bools.has("--dry-run")) {
        const next = currentRawDoc();
        next.words = next.words ?? {};
        for (const side of ["add", "disable"]) {
            next.words[side] = next.words[side] ?? {};
            next.words[side][lexicon] = next.words[side][lexicon] ?? [];
        }
        if (change.add)
            next.words.add[lexicon] = [...new Set([...next.words.add[lexicon], word])];
        if (change.disable)
            next.words.disable[lexicon] = [...new Set([...next.words.disable[lexicon], word])];
        if (change.removeAdd)
            next.words.add[lexicon] = next.words.add[lexicon].filter((w) => w !== word);
        if (change.removeDisable) {
            next.words.disable[lexicon] = next.words.disable[lexicon].filter((w) => w !== word);
        }
        await dryRun(next, [`${headline[0]} 예정  ${headline[1]}`]);
    }
    const snapshot = before();
    let result;
    try {
        result = await setGateWords(lexicon, change, {
            surface: "cli",
            expectedRevision: expectRevision(),
        });
    }
    catch (error) {
        failFromError(error);
    }
    writeReceipt("gate.words", [row(headline[0], headline[1])], snapshot, result, {
        lexicon,
        word,
        change,
    });
}
/* -------------------------------------------------------------------------- */
/* test / replay                                                               */
/* -------------------------------------------------------------------------- */
function originLabel(origin) {
    return origin === "builtin" ? "내장" : "사용자";
}
function matchedText(matched) {
    if (matched.length === 0)
        return "";
    const groups = [];
    for (const origin of ["builtin", "user"]) {
        const ids = matched.filter((entry) => entry.origin === origin).map((entry) => entry.id);
        if (ids.length > 0)
            groups.push(`${ids.join(" · ")} (${originLabel(origin)})`);
    }
    return groups.join(" · ");
}
/** The real gate state of one session. Read-only, and never created on demand. */
async function sessionState(sessionId) {
    const { getSearchDb } = await import("./search.js");
    let db;
    try {
        db = getSearchDb();
    }
    catch (error) {
        fail("DB_UNAVAILABLE", [
            `데이터베이스를 열 수 없어 --session을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        ]);
    }
    let gateRow;
    try {
        gateRow = db
            .prepare(`SELECT context_epoch, last_retrieval_epoch, last_source, capsule_generation_seen,
                memory_revision_seen, topic_fingerprint_json, topic_embedding,
                informative_prompts_since_retrieval
           FROM session_memory_state WHERE session_id = ?`)
            .get(sessionId);
    }
    catch (error) {
        fail("DB_UNAVAILABLE", [
            `세션 상태를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        ]);
    }
    if (!gateRow) {
        fail("SESSION_UNKNOWN", [`세션 ${sessionId}의 게이트 상태가 없습니다 (memex status).`]);
    }
    let fingerprint = [];
    try {
        const raw = gateRow.topic_fingerprint_json;
        if (typeof raw === "string" && raw !== "")
            fingerprint = JSON.parse(raw);
    }
    catch {
        fingerprint = [];
    }
    return {
        contextEpoch: Number(gateRow.context_epoch ?? 0),
        lastRetrievalEpoch: Number(gateRow.last_retrieval_epoch ?? -1),
        lastSource: gateRow.last_source ?? null,
        capsuleGenerationSeen: Number(gateRow.capsule_generation_seen ?? 0),
        memoryRevisionSeen: Number(gateRow.memory_revision_seen ?? 0),
        topicFingerprint: fingerprint,
        hasTopicEmbedding: !!gateRow.topic_embedding,
        informativePromptsSinceRetrieval: Number(gateRow.informative_prompts_since_retrieval ?? 0),
        // Residency needs the fact rows and a read scope; `test` stays a gate
        // explanation rather than a bundle simulation, so it assumes none.
        residentTokens: new Set(),
    };
}
async function cmdTest() {
    const prompt = positional[1];
    if (prompt === undefined)
        usageError('test needs a prompt: memex gate test "<prompt>"');
    const sessionId = values.get("--session");
    const state = sessionId === undefined ? undefined : await sessionState(sessionId);
    const loaded = loadRecallGateOverlay();
    const matcher = oneShotMatcher();
    let explanation;
    try {
        explanation = await explainRecall({ prompt, ...(state ? { state } : {}), compareBuiltin: bools.has("--compare-builtin") }, matcher);
    }
    finally {
        matcher.dispose();
    }
    const lines = [
        row("프롬프트", `${prompt}   (${explanation.prompt.chars}자 · fingerprint 토큰 ${explanation.prompt.tokens.length}개${explanation.prompt.tokens.length > 0 ? `: ${explanation.prompt.tokens.join(", ")}` : ""})`),
        row("규칙", explanation.overlay.present
            ? `내장 + 오버레이 (${explanation.overlay.hash ?? "없음"}) · 사용자 패턴 실행 ${explanation.matcher.elapsedMs}ms / 상한 ${MATCH_WALL_MS}ms`
            : "내장만 (오버레이 없음)"),
        "",
        "의도",
    ];
    for (const intent of INTENTS) {
        const entry = explanation.intents[intent];
        lines.push(`  ${pad(intent, 17)}${entry.fired ? "● 발화" : "○     "}   ${matchedText(entry.matched)}`.trimEnd());
    }
    lines.push(`  ${pad("substantive", 17)}${explanation.decision.substantive ? "● 예" : "○ 아니오"}`);
    lines.push("");
    lines.push(row("판정", explanation.decision.action));
    lines.push(row("triggers", explanation.decision.triggers.join("+") || "—"));
    if (explanation.decision.skipReason)
        lines.push(row("사유", explanation.decision.skipReason));
    if (loaded.disabled.length > 0) {
        lines.push(row("비활성", `${loaded.disabled.join(" · ")} — 오버레이에서 꺼진 규칙 ${loaded.disabled.length}개`));
    }
    const quarantined = gateQuarantine();
    if (quarantined.length > 0) {
        lines.push(row("격리", `${quarantined.map((entry) => entry.pattern_id).join(" · ")} — ${MATCH_WALL_MS}ms 상한을 넘겨 회수 판정에 적용되지 않습니다`));
    }
    if (explanation.matcher.timedOut) {
        lines.push(row("matcher", `상한 ${MATCH_WALL_MS}ms 초과 — 이번 실행에서 격리: ${explanation.matcher.quarantined.join(" · ") || "없음"}`));
    }
    else if (explanation.matcher.unavailable) {
        lines.push(row("matcher", "사용할 수 없었습니다 — 사용자 패턴 없이 내장 규칙으로 판정했습니다 (fail-safe)"));
    }
    lines.push(row("상태 가정", explanation.stateSource === "session"
        ? `--session ${sessionId} → 실제 상태 (epoch ${state?.contextEpoch ?? 0}, fingerprint ${state?.topicFingerprint.length ?? 0}개, resident 없음)`
        : "--session 없음 → 중립 상태 (epoch 0, fingerprint 없음, resident 없음)"));
    lines.push(row("임베딩", "0회 — 게이트는 모델·임베딩을 호출하지 않습니다"));
    if (explanation.builtinOnly) {
        lines.push("");
        lines.push(`${pad("", 20)}${pad("내장만", 16)}내장+오버레이`);
        lines.push(`${pad("판정", 20)}${pad(explanation.builtinOnly.action, 16)}${explanation.decision.action}`);
        lines.push(`${pad("triggers", 20)}${pad(explanation.builtinOnly.triggers.join("+") || "—", 16)}${explanation.decision.triggers.join("+") || "—"}`);
        lines.push(`${pad("예상 임베딩 호출", 20)}${pad(explanation.builtinOnly.action === "ambiguous" ? "1회" : "0회", 16)}${explanation.decision.action === "ambiguous" ? "1회" : "0회"}`);
        lines.push(`${pad("차이를 만든 규칙", 20)}${(explanation.diffCause ?? []).length === 0
            ? "없음"
            : explanation
                .diffCause.map((entry) => `${entry.id} /${entry.source}/ (intent ${entry.intent})`)
                .join(" · ")}`);
    }
    lines.push("");
    lines.push("이 명령은 아무것도 기록하지 않습니다: 주입 로그·recall 영수증·세션 상태 모두 변경 없음.");
    lines.push(`(단, 사용자 패턴이 ${MATCH_WALL_MS}ms 상한을 넘기면 실제 운영과 동일하게 격리됩니다 — 그 사실만 기록합니다.)`);
    emit({
        ...explanation,
        // `explanation.prompt` is the measurement ({chars, tokens}); the text the
        // operator typed travels beside it under its own name.
        promptText: prompt,
        sessionId: sessionId ?? null,
        disabled: loaded.disabled,
        quarantine: quarantined,
    }, lines);
}
async function cmdReplay() {
    const limit = intValue("--limit", 20);
    const project = values.get("--project");
    const loaded = loadRecallGateOverlay();
    const changesWords = LEXICONS.some((lexicon) => (loaded.words.add?.[lexicon]?.length ?? 0) > 0 || (loaded.words.disable?.[lexicon]?.length ?? 0) > 0);
    if (!loaded.present || (loaded.patterns.length === 0 && loaded.disabled.length === 0 && !changesWords)) {
        emit({ considered: 0, changed: 0, rows: [], overlay: { present: loaded.present, hash: loaded.hash } }, [
            "오버레이가 회수 판정을 바꾸지 않습니다 — 비교할 것이 없습니다.",
        ]);
        return;
    }
    const { getSearchDb } = await import("./search.js");
    let rows;
    try {
        const db = getSearchDb();
        const where = ["user_message IS NOT NULL", "length(trim(user_message)) > 0"];
        const params = [];
        if (project !== undefined) {
            where.push("project = ?");
            params.push(project);
        }
        rows = db
            .prepare(`SELECT user_message, project, timestamp, session_id FROM exchanges
          WHERE ${where.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`)
            .all(...params, limit);
    }
    catch (error) {
        fail("DB_UNAVAILABLE", [
            `최근 프롬프트를 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
        ]);
    }
    const matcher = oneShotMatcher();
    const replayed = [];
    try {
        for (const exchange of rows) {
            const explanation = await explainRecall({ prompt: exchange.user_message, compareBuiltin: true }, matcher);
            replayed.push({
                timestamp: exchange.timestamp,
                project: exchange.project,
                sessionId: exchange.session_id,
                prompt: exchange.user_message,
                builtinOnly: explanation.builtinOnly?.action ?? explanation.decision.action,
                overlay: explanation.decision.action,
                triggers: explanation.decision.triggers,
                diffCause: explanation.diffCause ?? [],
            });
        }
    }
    finally {
        matcher.dispose();
    }
    const changed = replayed.filter((entry) => entry.builtinOnly !== entry.overlay);
    const preview = (text) => {
        const oneLine = text.replace(/\s+/g, " ").trim();
        return oneLine.length > 58 ? `${oneLine.slice(0, 57)}…` : oneLine;
    };
    emit({
        limit,
        project: project ?? null,
        overlay: { present: loaded.present, hash: loaded.hash, revision: loaded.revision },
        considered: replayed.length,
        changed: changed.length,
        rows: replayed,
    }, [
        row("재생", `최근 프롬프트 ${replayed.length}개 · 중립 상태 가정 · 모델·임베딩 호출 0회`),
        row("규칙", `내장 + 오버레이 (${loaded.hash ?? "없음"})`),
        row("변화", `${changed.length}개 / ${replayed.length}개`),
        ...changed.map((entry) => `  ${pad(`${entry.builtinOnly} → ${entry.overlay}`, 24)}"${preview(entry.prompt)}"${entry.diffCause.length > 0
            ? `   ${entry.diffCause.map((cause) => `${cause.id} /${cause.source}/ (${cause.intent})`).join(" · ")}`
            : ""}`),
        "",
        "이 명령은 아무것도 기록하지 않습니다: 주입 로그·recall 영수증·세션 상태 모두 변경 없음.",
    ]);
}
/* -------------------------------------------------------------------------- */
/* validate / history / quarantine / reset / rollback                          */
/* -------------------------------------------------------------------------- */
async function cmdValidate() {
    const file = values.get("--file");
    const liveFile = overlayPaths().gate;
    const target = file ?? liveFile;
    let raw;
    let bytes = 0;
    if (!fs.existsSync(target)) {
        emit({ file: target, present: false, issues: [] }, [
            row("파일", target),
            row("결과", "없음 — 내장 기본값만 적용됩니다. 검증할 것이 없습니다."),
        ]);
        return;
    }
    try {
        const text = fs.readFileSync(target, "utf8");
        bytes = Buffer.byteLength(text, "utf8");
        raw = JSON.parse(text);
    }
    catch (error) {
        fail("OVERLAY_UNREADABLE", [
            row("파일", target),
            row("결과", `읽을 수 없습니다 — ${error instanceof Error ? error.message : String(error)}`),
        ]);
    }
    const result = await validateOverlay("recall-gate", raw, { probe: true, forWrite: false });
    const issues = [...result.issues];
    // The live file's quarantine rows are part of its verdict: a quarantined
    // pattern is a user rule that is silently off (doctor fails on it, §2.3.4).
    if (file === undefined) {
        for (const issue of loadRecallGateOverlay().issues) {
            if (issue.code === "PATTERN_QUARANTINED")
                issues.push(issue);
        }
    }
    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");
    const lines = [
        row("파일", `${target} (${bytes} bytes / 상한 ${OVERLAY_LIMITS.fileBytes})`),
        row("결과", errors.length === 0 ? `유효 · 경고 ${warnings.length}개` : `오류 ${errors.length}개 · 경고 ${warnings.length}개`),
        ...issueLines(issues),
    ];
    if (errors.length > 0) {
        if (json) {
            console.log(JSON.stringify({ ok: false, file: target, issues }, null, 2));
        }
        else {
            console.error(lines.join("\n"));
            console.error("오류가 하나라도 있으면 오버레이 전체가 무시되고 내장 기본값으로 동작합니다.");
        }
        process.exit(1);
    }
    emit({ file: target, present: true, bytes, issues }, lines);
}
function cmdHistory() {
    const limit = intValue("--limit", 20);
    const entries = listOverlayHistory("recall-gate", limit);
    emit({ count: entries.length, snapshots: listOverlaySnapshots("recall-gate"), history: entries }, entries.length === 0
        ? ["변경 이력이 없습니다."]
        : [
            row("이력", `${entries.length}개 · 되돌릴 수 있는 revision: ${listOverlaySnapshots("recall-gate").join(", ") || "없음"}`),
            ...entries.map((entry) => `  ${pad(shortTime(entry.ts), 18)}${pad(`rev ${entry.from_revision} → ${entry.to_revision}`, 18)}${pad(entry.action, 22)}${pad(entry.surface, 9)}${[
                entry.added?.length ? `추가 ${entry.added.join(",")}` : "",
                entry.disabled?.length ? `비활성 ${entry.disabled.join(",")}` : "",
                entry.removed?.length ? `삭제 ${entry.removed.join(",")}` : "",
            ]
                .filter(Boolean)
                .join(" · ")}`),
        ]);
}
function cmdQuarantineList() {
    const entries = gateQuarantine();
    emit({ count: entries.length, quarantine: entries }, entries.length === 0
        ? ["격리된 패턴이 없습니다."]
        : [
            `격리된 패턴 ${entries.length}개 — 이 규칙은 지금 회수 판정에 적용되지 않습니다.`,
            ...entries.flatMap((entry) => {
                const pattern = loadRecallGateOverlay().doc?.patterns?.add?.find((candidate) => candidate.id === entry.pattern_id);
                return [
                    `  ${pad(entry.pattern_id, 20)}${pad(entry.overlay, 14)}${pattern ? `intent=${pattern.intent}  /${pattern.source}/${pattern.flags}` : "(오버레이에서 이미 사라진 패턴)"}`,
                    `  ${" ".repeat(20)}${shortTime(entry.at)} · ${entry.elapsed_ms}ms 초과 · 입력 ${entry.input_chars}자 · ${entry.surface}`,
                ];
            }),
            "해제: 정규식을 고치면 자동으로 풀립니다, 또는 memex gate quarantine clear <pattern-id> 로 한 번 더 시도하게 할 수 있습니다.",
        ]);
}
async function cmdQuarantineClear() {
    const patternId = positional[2];
    if (patternId === undefined && !bools.has("--all")) {
        usageError("quarantine clear needs <pattern-id> or --all");
    }
    if (patternId !== undefined && bools.has("--all")) {
        usageError("quarantine clear takes either <pattern-id> or --all, not both");
    }
    const result = await clearQuarantine(patternId, { surface: "cli" });
    if (result.cleared === 0) {
        emit({ cleared: 0, ids: [] }, [
            patternId === undefined
                ? "격리된 패턴이 없습니다 — 변경 없음."
                : `${patternId}는 격리 목록에 없습니다 — 변경 없음.`,
        ]);
        return;
    }
    emit({ cleared: result.cleared, ids: result.ids }, [
        row("해제", `${result.ids.join(" · ")} (${result.cleared}개 항목)`),
        row("효과", "다음 프롬프트에서 다시 실행됩니다. 상한을 또 넘으면 다시 격리됩니다."),
        row("감사", "logs/ui-audit.jsonl action=gate.quarantine-clear"),
    ]);
}
async function cmdReset() {
    const intent = values.get("--intent");
    if (intent !== undefined && !INTENTS.includes(intent)) {
        usageError(`--intent must be one of: ${INTENTS.join(", ")}`);
    }
    // `--dry-run` comes BEFORE the --yes gate: a dry run writes nothing, so demanding
    // a confirmation for it would only teach the habit of typing --yes.
    if (bools.has("--dry-run")) {
        const current = currentRawDoc();
        const add = (current.patterns?.add ?? []);
        const disable = (current.patterns?.disable ?? []);
        let next;
        let summary;
        if (intent === undefined) {
            next = emptyGateDoc();
            summary = [
                `비울 예정  사용자 패턴 ${add.length}개 · 비활성 표시 ${disable.length}개 — 내장 기본값만 남습니다`,
            ];
        }
        else {
            const builtinOfIntent = new Set(gateCatalog().builtin.filter((pattern) => pattern.intent === intent).map((pattern) => pattern.id));
            const removed = add.filter((pattern) => pattern.intent === intent).map((pattern) => String(pattern.id));
            const reEnabled = disable.filter((id) => builtinOfIntent.has(id));
            next = {
                ...current,
                patterns: {
                    ...(current.patterns ?? {}),
                    add: add.filter((pattern) => pattern.intent !== intent),
                    disable: disable.filter((id) => !builtinOfIntent.has(id)),
                },
            };
            summary = [
                `비울 예정  intent=${intent}  사용자 패턴 ${removed.length}개 · 재활성 ${reEnabled.length}개`,
                ...(removed.length > 0 ? [`  삭제  ${removed.join(" · ")}`] : []),
                ...(reEnabled.length > 0 ? [`  재활성  ${reEnabled.join(" · ")}`] : []),
            ];
        }
        await dryRun(next, summary, { probe: false, extraFlags: ["--yes"] });
    }
    if (!bools.has("--yes")) {
        fail("CONFIRMATION_REQUIRED", [
            "거부 — 아무것도 저장하지 않았습니다.",
            intent === undefined
                ? "  CONFIRMATION_REQUIRED  오버레이 전체를 비웁니다. 확인하려면 --yes 를 함께 주세요."
                : `  CONFIRMATION_REQUIRED  intent=${intent}의 사용자 규칙을 비웁니다. 확인하려면 --yes 를 함께 주세요.`,
            "  (되돌릴 수 있습니다: memex gate rollback --to <revision>)",
        ]);
    }
    const snapshot = before();
    let result;
    try {
        result = await resetOverlay("recall-gate", {
            surface: "cli",
            ...(intent ? { intent: intent } : {}),
            expectedRevision: expectRevision(),
        });
    }
    catch (error) {
        failFromError(error);
    }
    writeReceipt("gate.reset", [
        row("초기화", intent === undefined
            ? "오버레이를 비웠습니다 — 내장 기본값만 적용됩니다."
            : `intent=${intent}의 사용자 규칙과 비활성 표시를 비웠습니다.`),
    ], snapshot, result, { intent: intent ?? null });
}
async function cmdRollback() {
    const raw = values.get("--to");
    if (raw === undefined)
        usageError("rollback needs --to <revision>");
    const revision = Number(raw);
    if (!Number.isInteger(revision) || revision < 0)
        usageError("--to must be a non-negative integer");
    if (bools.has("--dry-run")) {
        const kept = readOverlaySnapshot("recall-gate", revision);
        if (kept === null) {
            fail("SNAPSHOT_NOT_FOUND", [
                "시험 실행 — 되돌릴 수 없습니다. 아무것도 저장하지 않았습니다.",
                `  SNAPSHOT_NOT_FOUND  revision ${revision}의 스냅숏이 없습니다 (보관 중: ${listOverlaySnapshots("recall-gate").join(", ") || "없음"})`,
            ]);
        }
        const doc = JSON.parse(JSON.stringify(kept));
        const add = (doc.patterns?.add ?? []);
        const disable = (doc.patterns?.disable ?? []);
        await dryRun(doc, [`되돌릴 예정  revision ${revision}의 스냅숏  사용자 패턴 ${add.length}개 · 비활성 표시 ${disable.length}개`], { probe: false });
    }
    const snapshot = before();
    let result;
    try {
        result = await rollbackOverlay("recall-gate", revision, {
            surface: "cli",
            expectedRevision: expectRevision(),
        });
    }
    catch (error) {
        failFromError(error);
    }
    writeReceipt("gate.rollback", [row("되돌림", `revision ${revision}의 스냅숏을 revision ${result.revision}으로 다시 적용했습니다.`)], snapshot, result, { fromSnapshot: revision });
}
/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */
const verb = positional[0];
const sub = positional[1];
switch (verb) {
    case "show":
        cmdShow();
        break;
    case "patterns":
        switch (sub) {
            case "list":
                cmdPatternsList();
                break;
            case "add":
                await cmdPatternsAdd();
                break;
            // `remove` is the design document's name for the same operation: a
            // built-in is switched off and a user pattern is deleted (§2.4).
            case "remove":
            case "disable":
                await cmdPatternsDisable();
                break;
            case "enable":
                await cmdPatternsEnable();
                break;
            default:
                usageError(`Unknown 'memex gate patterns' subcommand: ${sub ?? "(none)"}`);
        }
        break;
    case "words":
        switch (sub) {
            case "list":
                cmdWordsList();
                break;
            case "add":
                await cmdWords("add");
                break;
            case "remove":
                await cmdWords("remove");
                break;
            default:
                usageError(`Unknown 'memex gate words' subcommand: ${sub ?? "(none)"}`);
        }
        break;
    case "test":
        await cmdTest();
        break;
    case "replay":
        await cmdReplay();
        break;
    case "validate":
        await cmdValidate();
        break;
    case "history":
        cmdHistory();
        break;
    case "quarantine":
        switch (sub) {
            case "list":
                cmdQuarantineList();
                break;
            case "clear":
                await cmdQuarantineClear();
                break;
            default:
                usageError(`Unknown 'memex gate quarantine' subcommand: ${sub ?? "(none)"}`);
        }
        break;
    case "reset":
        await cmdReset();
        break;
    case "rollback":
        await cmdRollback();
        break;
    default:
        usageError(`Unknown 'memex gate' subcommand: ${verb ?? "(none)"}`);
}
