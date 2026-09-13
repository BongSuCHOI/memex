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
import { OverlayInvalidError, OverlayLockedError, OverlayStaleError, PROBE_WALL_MS, addGatePattern, applyOverlayChange, clearQuarantine, disableGatePattern, listOverlayHistory, listOverlaySnapshots, overlayPaths, readOverlaySnapshot, resetOverlay, resolveGatePatternId, rollbackOverlay, setGateConfig, setGateWords, validateOverlay, } from "./overlay-admin.js";
import { GATE_CONFIG_FIELDS, GATE_CONFIG_KEYS, OVERLAY_LIMITS, RECALL_GATE_OVERLAY_SCHEMA, RECALL_GATE_OVERLAY_VERSION, currentRecallGateRevision, effectiveGateConfig, explainRecall, gateCatalog, gateConfigField, loadRecallGateOverlay, overlaysDisabled, overriddenGateConfigKeys, readRecallGateOverlayFile, } from "./recall-gate-overlay.js";
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
  memex gate config show [--json]
  memex gate config set <key> <value> [--expect-revision <n>] [--dry-run] [--json]
  memex gate config reset [<key>] [--expect-revision <n>] [--dry-run] [--json]
  memex gate test "<prompt>" [--session <id>] [--compare-builtin] [--json]
  memex gate replay [--limit <n>] [--project <path>] [--json]
  memex gate validate [--file <path>] [--json]
  memex gate history [--limit <n>] [--json]
  memex gate quarantine list [--json]
  memex gate quarantine clear [<pattern-id>|--all] [--dry-run] [--json]
  memex gate reset [--intent <intent>] --yes [--dry-run] [--json]
  memex gate rollback --to <revision> [--dry-run] [--json]

The recall-gate overlay adds your own regexes and words to the built-in gate
that decides whether a prompt retrieves memory. Built-ins are never deleted:
'patterns disable' switches one off by id and 'patterns enable' switches it back
on. 'patterns remove' is accepted as an alias of 'patterns disable'.

'config' edits the eight gate THRESHOLDS. Every one is optional: a threshold you
never set keeps its built-in value, and 'config reset' (no key) drops every
override at once. A threshold is a number, so it runs in no worker and is never
quarantined — but it does change what is recalled, so it is part of the overlay
hash and gets a revision, a snapshot and a rollback target like any other change.

READ-ONLY verbs: show, patterns list, words list, config show, test, replay,
validate, history, quarantine list. test and replay call NO model and NO
embedding, and write neither the inject log nor any recall receipt or session
state. 'test' prints the thresholds in force and marks the overridden ones.

WRITE verbs (patterns add/disable/enable, words add/remove, config set/reset,
reset, rollback) take
the overlay write lock, bump 'revision', keep a rollback snapshot and append one
metadata line to logs/ui-audit.jsonl and overlays/history.jsonl. --dry-run
validates and prints the command to re-run with the current revision, writing
nothing. --expect-revision <n> refuses the write when the overlay changed
elsewhere first (exit 1, OVERLAY_STALE).

'quarantine clear' writes overlays/quarantine.json, NOT the overlay document, so
it has no revision, no rollback snapshot and no --expect-revision. It does honour
--dry-run (printing what it would clear and writing nothing at all) and it leaves
the same one metadata line in logs/ui-audit.jsonl when it really clears.

User patterns run only inside a worker thread with a ${MATCH_WALL_MS} ms budget per prompt.
A pattern that exceeds it is QUARANTINED: it stops being applied until you fix
the regex (which clears it automatically) or run 'gate quarantine clear <id>'.
The syntax limits and the ${PROBE_WALL_MS} ms write-time probe are defence in depth, not a proof.

EXAMPLES:
  memex gate patterns add memory 'deploy\\s*history' --note "always recall deploy-history questions"
  memex gate test "why did we switch auth to supabase?" --compare-builtin
  memex gate config set safetyRefreshInterval 10
  memex gate config reset coherentMargin
  memex gate patterns disable memory.en.again
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
    "Note: a syntax check alone cannot catch every pattern like this. Even once stored, it only",
    `      runs inside the ${MATCH_WALL_MS}ms budget, and a pattern that exceeds it is quarantined and drops out of the recall decision.`,
];
function hasRegexIssue(issues) {
    return issues.some((issue) => issue.code.startsWith("REGEX_") || issue.code === "PATTERN_TOO_SLOW");
}
/** Map the admin layer's refusals onto §4's codes and exit 1. */
function failFromError(error) {
    if (error instanceof OverlayInvalidError) {
        const errors = error.issues.filter((issue) => issue.severity === "error");
        fail("OVERLAY_INVALID", [
            "Refused — nothing was saved.",
            ...issueLines(error.issues),
            ...(hasRegexIssue(errors) ? SLOW_PATTERN_NOTE : []),
        ], { issues: error.issues });
    }
    if (error instanceof OverlayStaleError) {
        fail("OVERLAY_STALE", [
            "Refused — nothing was saved.",
            `  OVERLAY_STALE  current revision ${error.currentRevision} (expected ${error.expectedRevision}) — it changed somewhere else first.`,
        ], { currentRevision: error.currentRevision, expectedRevision: error.expectedRevision });
    }
    if (error instanceof OverlayLockedError) {
        fail("OVERLAY_LOCKED", [
            "Refused — nothing was saved.",
            error.holderPid === null
                ? "  OVERLAY_LOCKED  another process is writing the rules (the lock could not be read)."
                : `  OVERLAY_LOCKED  another process (pid ${error.holderPid}) is writing the rules.`,
        ], { holderPid: error.holderPid });
    }
    fail("GATE_CLI_ERROR", [
        "Refused — nothing was saved.",
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
            "Dry run — refused. Nothing was saved.",
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
        "Dry run — nothing was saved.",
        ...summary.map((line) => `  ${line}`),
        `Checked  0 errors · ${result.issues.length} warnings`,
        ...issueLines(result.issues),
        `Next     ${rerunCommand(revision, opts.extraFlags ?? [])}`,
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
        row("File", `${overlayPaths().gate}  (revision ${before.revision} → ${result.revision}, ${before.hash ?? "none"} → ${result.hash ?? "none"})`),
        ...(result.quarantineCleared.length > 0
            ? [row("Released", result.quarantineCleared.join(" · "))]
            : []),
        ...(result.issues.length > 0 ? ["Warnings", ...issueLines(result.issues)] : []),
        row("Audit", `logs/ui-audit.jsonl action=${action} · overlays/history.jsonl overlay=recall-gate revision=${result.revision}`),
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
        return "not read — MEMEX_DISABLE_OVERLAYS=1 · only the built-in defaults apply";
    if (!loaded.present)
        return "absent — only the built-in defaults apply";
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    const onlyQuarantine = errors.length > 0 && errors.every((issue) => issue.code === "PATTERN_QUARANTINED");
    if (errors.length > 0 && !onlyQuarantine) {
        return `ignored — ${errors.length} error(s) · running on the built-in defaults (memex gate validate)`;
    }
    return `applied · revision ${loaded.revision} · ${loaded.hash ?? "none"} · ${shortTime(loaded.doc?.updated_at)}`;
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
            config: loaded.config,
        },
        config: {
            effective: effectiveGateConfig(loaded.config),
            overridden: overriddenGateConfigKeys(loaded.config),
            fields: GATE_CONFIG_FIELDS,
        },
        quarantine: quarantined,
        issues: loaded.issues,
        limits: OVERLAY_LIMITS,
        matchWallMs: MATCH_WALL_MS,
        probeWallMs: PROBE_WALL_MS,
        shared: false,
    }, [
        row("File", overlayPaths().gate),
        row("Status", statusLine(loaded)),
        row("Built-in", `${builtinTotal} patterns (${countText})`),
        `${CONTINUE}words ${LEXICONS.map((lexicon) => `${lexicon} ${catalog.words[lexicon].length}`).join(" · ")}`,
        row("User", `${loaded.patterns.length} added · ${loaded.disabled.length} disabled · ${quarantined.length} quarantined`),
        (() => {
            const overridden = overriddenGateConfigKeys(loaded.config);
            return row("Thresholds", overridden.length === 0
                ? `all ${GATE_CONFIG_FIELDS.length} built-in (memex gate config show)`
                : `${overridden.length} of ${GATE_CONFIG_FIELDS.length} overridden: ${overridden
                    .map((key) => `${key}=${thresholdText(loaded.config[key])}`)
                    .join(" · ")}`);
        })(),
        row("Execution", `User patterns run in a separate thread under a ${MATCH_WALL_MS}ms budget per prompt.`),
        `${CONTINUE}A pattern that exceeds it is quarantined and drops out of the recall decision.`,
        row("Warnings", warnings.length === 0 && errors.length === 0
            ? "none"
            : `${errors.length} error(s) · ${warnings.length} warning(s)`),
        ...issueLines(loaded.issues),
        row("Effective", "A running inject daemon re-reads this file on the next prompt (no restart needed)."),
        row("Sharing", "These rules are not shared between devices yet (planned for 0.7.1)."),
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
    active: "active",
    disabled: "disabled",
    quarantined: "quarantined",
    builtin: "built-in",
    user: "user",
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
        ? ["No matching rules."]
        : [
            `${rows.length} rules (built-in ${rows.filter((r) => r.origin === "builtin").length} · user ${rows.filter((r) => r.origin === "user").length} · disabled ${rows.filter((r) => r.state === "disabled").length} · quarantined ${rows.filter((r) => r.state === "quarantined").length})`,
            ...rows.map((candidate) => `  ${pad(`[${STATE_LABEL[candidate.origin]}]`, 11)}${pad(STATE_LABEL[candidate.state], 13)}${pad(candidate.intent, 18)}${pad(candidate.id, 26)}/${candidate.source}/${candidate.flags}`),
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
        await dryRun(next, [`Would add  ${id}  intent=${intent}  /${source}/${flags}`]);
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
        row("Checked", `syntax ok · compile ok · probe ok (budget ${PROBE_WALL_MS}ms) · user patterns ${applied.doc?.patterns?.add?.length ?? 0}/${OVERLAY_LIMITS.counts.patternsAdd}`),
        row("Added", `${id}  intent=${intent}  /${source}/${flags}`),
    ], snapshot, result, { id, intent, source, flags, ...(note ? { note } : {}) });
}
async function cmdPatternsDisable() {
    const target = positional[2];
    if (!target)
        usageError("patterns disable needs <id|regex>");
    const resolved = resolveGatePatternId(target, values.get("--flags"));
    if (resolved === null) {
        fail("PATTERN_UNKNOWN", [
            "Refused — nothing was saved.",
            `  PATTERN_UNKNOWN  no rule matches ${JSON.stringify(target)} (memex gate patterns list).`,
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
            isUser ? `Would delete  ${resolved} (user pattern)` : `Would disable  ${resolved} (built-in rule)`,
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
        row(isUser ? "Deleted" : "Disabled", isUser
            ? `${resolved} — the user pattern is gone.`
            : `${resolved} — the built-in is switched off (it stays in the catalogue, and memex gate patterns enable ${resolved} brings it back).`),
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
            "Refused — nothing was saved.",
            `  PATTERN_NOT_DISABLED  ${JSON.stringify(target)} is not switched off (memex gate patterns list --source disabled).`,
        ]);
    }
    if (bools.has("--dry-run")) {
        const next = currentRawDoc();
        next.patterns = next.patterns ?? {};
        next.patterns.disable = (next.patterns.disable ?? []).filter((id) => id !== resolved);
        await dryRun(next, [`Would re-enable  ${resolved}`]);
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
    writeReceipt("gate.pattern-enable", [row("Re-enabled", `${resolved} — it takes part in the recall decision again.`)], snapshot, result, { id: resolved });
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
        row(lexicon, `${catalog.words[lexicon].length} built-in`),
        `${CONTINUE}added ${(loaded.words.add?.[lexicon] ?? []).join(" · ") || "none"}`,
        `${CONTINUE}disabled ${(loaded.words.disable?.[lexicon] ?? []).join(" · ") || "none"}`,
    ]));
}
/**
 * The receipt labels are past tense ("Added"); a dry run has not done it yet.
 */
const WOULD = {
    Added: "Would add",
    Deleted: "Would delete",
    Disabled: "Would disable",
    "Re-enabled": "Would re-enable",
};
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
            headline = ["Re-enabled", `${lexicon} "${word}" — the built-in word is back on.`];
        }
        else if (inAdd) {
            fail("WORD_UNCHANGED", [
                "Refused — nothing was saved.",
                `  WORD_UNCHANGED  ${lexicon} "${word}" is already added.`,
            ]);
        }
        else {
            change = { add: [word] };
            headline = ["Added", `${lexicon} "${word}"`];
        }
    }
    else {
        if (inAdd) {
            change = { removeAdd: [word] };
            headline = ["Deleted", `${lexicon} "${word}" — the added word is gone.`];
        }
        else if (isBuiltin && !inDisable) {
            change = { disable: [word] };
            headline = [
                "Disabled",
                `${lexicon} "${word}" — the built-in word is switched off (memex gate words add ${lexicon} ${word} brings it back).`,
            ];
        }
        else {
            fail("WORD_UNKNOWN", [
                "Refused — nothing was saved.",
                `  WORD_UNKNOWN  ${lexicon} has no "${word}" (memex gate words list).`,
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
        await dryRun(next, [`${WOULD[headline[0]] ?? `Would ${headline[0]}`}  ${headline[1]}`]);
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
/* config (§2.2 `config`, issue #120)                                          */
/* -------------------------------------------------------------------------- */
/** `0.12` not `0.12000000000000001`: fractions print at the precision they were typed. */
function thresholdText(value) {
    return String(Number(value.toFixed(6)));
}
const CONFIG_KEY_LIST = GATE_CONFIG_KEYS.join(", ");
function configRangeText(field) {
    return field === undefined ? "" : `${field.kind === "integer" ? "integer" : "number"} ${field.min}–${field.max}`;
}
/** Reject an unknown key HERE, before the lock: the message can then list all eight. */
function configKey(raw) {
    if (!raw)
        usageError(`config needs a threshold name — one of: ${CONFIG_KEY_LIST}`);
    const field = gateConfigField(raw);
    if (!field)
        usageError(`unknown threshold ${JSON.stringify(raw)} — expected one of: ${CONFIG_KEY_LIST}`);
    return field.key;
}
/**
 * The eight thresholds with their built-in value, this overlay's override and
 * what is actually in force. Reads only — no lock, no revision.
 */
function cmdConfigShow() {
    const loaded = loadRecallGateOverlay();
    const effective = effectiveGateConfig(loaded.config);
    const overridden = overriddenGateConfigKeys(loaded.config);
    const rows = GATE_CONFIG_FIELDS.map((field) => ({
        key: field.key,
        kind: field.kind,
        min: field.min,
        max: field.max,
        builtin: field.default,
        override: loaded.config[field.key] ?? null,
        effective: effective[field.key],
        overridden: loaded.config[field.key] !== undefined,
    }));
    emit({
        revision: loaded.revision,
        hash: loaded.hash,
        overridden,
        config: loaded.config,
        effective,
        builtin: Object.fromEntries(GATE_CONFIG_FIELDS.map((f) => [f.key, f.default])),
        thresholds: rows,
        file: overlayPaths().gate,
    }, [
        row("Overlay", statusLine(loaded)),
        row("Thresholds", `${overridden.length} of ${GATE_CONFIG_FIELDS.length} overridden${overridden.length > 0 ? `: ${overridden.join(" · ")}` : ""}`),
        "",
        `  ${pad("threshold", 24)}${pad("built-in", 12)}${pad("override", 12)}${pad("in force", 12)}range`,
        ...rows.map((item) => `  ${pad(item.key, 24)}${pad(thresholdText(item.builtin), 12)}` +
            `${pad(item.override === null ? "—" : thresholdText(item.override), 12)}` +
            `${pad(thresholdText(item.effective), 12)}${configRangeText(gateConfigField(item.key))}`),
        "",
        "A threshold you never set keeps its built-in value. Thresholds are numbers: they run in no worker",
        "and are never quarantined, but they do change what is recalled, so they are part of the overlay hash.",
    ]);
}
async function cmdConfigSet() {
    const key = configKey(positional[2]);
    const field = gateConfigField(key);
    const raw = positional[3];
    if (raw === undefined)
        usageError(`config set needs a value: memex gate config set ${key} <value>`);
    const value = Number(raw);
    // The range check runs again inside the lock (the file is the authority); this
    // one exists so a typo costs no lock and names the range in the usage voice.
    if (!Number.isFinite(value))
        usageError(`${key} must be a finite number (found ${JSON.stringify(raw)})`);
    if (field.kind === "integer" && !Number.isInteger(value)) {
        usageError(`${key} must be a whole number of tokens (found ${raw})`);
    }
    if (value < field.min || value > field.max) {
        usageError(`${key} must be between ${field.min} and ${field.max} (found ${raw})`);
    }
    const loaded = loadRecallGateOverlay();
    if (loaded.config[key] === value) {
        fail("CONFIG_UNCHANGED", [
            "Refused — nothing was saved.",
            `  CONFIG_UNCHANGED  ${key} is already ${thresholdText(value)}.`,
        ]);
    }
    if (bools.has("--dry-run")) {
        const next = currentRawDoc();
        next.config = { ...(next.config ?? {}), [key]: value };
        await dryRun(next, [`Would set  ${key} ${thresholdText(field.default)} → ${thresholdText(value)} (built-in ${thresholdText(field.default)})`], { probe: false });
    }
    const snapshot = before();
    let result;
    try {
        result = await setGateConfig({ set: { [key]: value } }, { surface: "cli", expectedRevision: expectRevision() });
    }
    catch (error) {
        failFromError(error);
    }
    writeReceipt("gate.config", [
        row("Set", `${key} = ${thresholdText(value)}  (built-in ${thresholdText(field.default)}` +
            `${loaded.config[key] === undefined ? "" : `, was ${thresholdText(loaded.config[key])}`})`),
    ], snapshot, result, { key, value, builtin: field.default });
}
/**
 * `config reset` with no key drops EVERY override; with a key it drops that one.
 * Either way the built-in value comes back — a reset never invents a number.
 */
async function cmdConfigReset() {
    const loaded = loadRecallGateOverlay();
    const overridden = overriddenGateConfigKeys(loaded.config);
    const key = positional[2] === undefined ? null : configKey(positional[2]);
    const remove = key === null ? overridden : [key];
    if (remove.length === 0 || (key !== null && loaded.config[key] === undefined)) {
        fail("CONFIG_NOT_OVERRIDDEN", [
            "Refused — nothing was saved.",
            key === null
                ? "  CONFIG_NOT_OVERRIDDEN  no threshold is overridden (memex gate config show)."
                : `  CONFIG_NOT_OVERRIDDEN  ${key} is not overridden (memex gate config show).`,
        ]);
    }
    const headline = key === null
        ? `every threshold — ${remove.length} override(s) dropped: ${remove.join(" · ")}`
        : `${key} → built-in ${thresholdText(gateConfigField(key).default)}`;
    if (bools.has("--dry-run")) {
        const next = currentRawDoc();
        const config = { ...(next.config ?? {}) };
        for (const name of remove)
            delete config[name];
        if (Object.keys(config).length > 0)
            next.config = config;
        else
            delete next.config;
        await dryRun(next, [`Would reset  ${headline}`], { probe: false });
    }
    const snapshot = before();
    let result;
    try {
        result = await setGateConfig({ remove }, { surface: "cli", expectedRevision: expectRevision() });
    }
    catch (error) {
        failFromError(error);
    }
    writeReceipt("gate.config", [row("Reset", headline)], snapshot, result, { reset: remove });
}
/* -------------------------------------------------------------------------- */
/* test / replay                                                               */
/* -------------------------------------------------------------------------- */
function originLabel(origin) {
    return origin === "builtin" ? "built-in" : "user";
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
            `could not open the database, so --session was not read: ${error instanceof Error ? error.message : String(error)}`,
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
            `could not read the session state: ${error instanceof Error ? error.message : String(error)}`,
        ]);
    }
    if (!gateRow) {
        fail("SESSION_UNKNOWN", [`no gate state for session ${sessionId} (memex status).`]);
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
        row("Prompt", `${prompt}   (${explanation.prompt.chars} chars · ${explanation.prompt.tokens.length} fingerprint token(s)${explanation.prompt.tokens.length > 0 ? `: ${explanation.prompt.tokens.join(", ")}` : ""})`),
        row("Rules", explanation.overlay.present
            ? `built-in + overlay (${explanation.overlay.hash ?? "none"}) · user patterns ran ${explanation.matcher.elapsedMs}ms / budget ${MATCH_WALL_MS}ms`
            : "built-in only (no overlay)"),
        "",
        "Intents",
    ];
    for (const intent of INTENTS) {
        const entry = explanation.intents[intent];
        lines.push(`  ${pad(intent, 17)}${entry.fired ? "● fired" : "○      "}   ${matchedText(entry.matched)}`.trimEnd());
    }
    lines.push(`  ${pad("substantive", 17)}${explanation.decision.substantive ? "● yes" : "○ no"}`);
    lines.push("");
    lines.push(row("Decision", explanation.decision.action));
    lines.push(row("triggers", explanation.decision.triggers.join("+") || "—"));
    if (explanation.decision.skipReason)
        lines.push(row("Reason", explanation.decision.skipReason));
    if (loaded.disabled.length > 0) {
        lines.push(row("Disabled", `${loaded.disabled.join(" · ")} — ${loaded.disabled.length} rule(s) switched off by the overlay`));
    }
    const quarantined = gateQuarantine();
    if (quarantined.length > 0) {
        lines.push(row("Quarantined", `${quarantined.map((entry) => entry.pattern_id).join(" · ")} — over the ${MATCH_WALL_MS}ms budget, so they are not applied to the recall decision`));
    }
    if (explanation.matcher.timedOut) {
        lines.push(row("matcher", `over the ${MATCH_WALL_MS}ms budget — quarantined in this run: ${explanation.matcher.quarantined.join(" · ") || "none"}`));
    }
    else if (explanation.matcher.unavailable) {
        lines.push(row("matcher", "unavailable — decided on the built-in rules without user patterns (fail-safe)"));
    }
    lines.push(row("State", explanation.stateSource === "session"
        ? `--session ${sessionId} → real state (epoch ${state?.contextEpoch ?? 0}, ${state?.topicFingerprint.length ?? 0} fingerprint token(s), no residents)`
        : "no --session → neutral state (epoch 0, no fingerprint, no residents)"));
    lines.push(row("Embeddings", "0 calls — the gate calls no model and no embedding"));
    // #120 — the numbers this decision was judged against. Printed for EVERY run,
    // not only when something is overridden: a transcript that hides the built-in
    // values cannot be compared against one taken on another machine.
    const overridden = new Set(explanation.config.overridden);
    lines.push("");
    lines.push(row("Thresholds", overridden.size === 0
        ? `all ${GATE_CONFIG_FIELDS.length} built-in — no override`
        : `${overridden.size} of ${GATE_CONFIG_FIELDS.length} overridden by the overlay`));
    for (const field of GATE_CONFIG_FIELDS) {
        const effective = explanation.config.effective[field.key];
        lines.push(`  ${pad(field.key, 24)}${pad(thresholdText(effective), 12)}` +
            (overridden.has(field.key)
                ? `override (built-in ${thresholdText(field.default)})`
                : "built-in"));
    }
    if (explanation.builtinOnly) {
        lines.push("");
        lines.push(`${pad("", 20)}${pad("built-in only", 20)}built-in + overlay`);
        lines.push(`${pad("Decision", 20)}${pad(explanation.builtinOnly.action, 20)}${explanation.decision.action}`);
        lines.push(`${pad("triggers", 20)}${pad(explanation.builtinOnly.triggers.join("+") || "—", 20)}${explanation.decision.triggers.join("+") || "—"}`);
        lines.push(`${pad("Embedding calls", 20)}${pad(explanation.builtinOnly.action === "ambiguous" ? "1" : "0", 20)}${explanation.decision.action === "ambiguous" ? "1" : "0"}`);
        lines.push(`${pad("Rules that differ", 20)}${(explanation.diffCause ?? []).length === 0
            ? "none"
            : explanation
                .diffCause.map((entry) => `${entry.id} /${entry.source}/ (intent ${entry.intent})`)
                .join(" · ")}`);
    }
    lines.push("");
    lines.push("This command records nothing: inject log, recall receipt and session state are all unchanged.");
    lines.push(`(One exception: a user pattern that exceeds the ${MATCH_WALL_MS}ms budget is quarantined exactly as in production — only that fact is recorded.)`);
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
            "The overlay does not change the recall decision — there is nothing to compare.",
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
            `could not read the recent prompts: ${error instanceof Error ? error.message : String(error)}`,
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
        row("Replay", `${replayed.length} recent prompt(s) · neutral state assumed · 0 model and embedding calls`),
        row("Rules", `built-in + overlay (${loaded.hash ?? "none"})`),
        row("Changed", `${changed.length} / ${replayed.length}`),
        ...changed.map((entry) => `  ${pad(`${entry.builtinOnly} → ${entry.overlay}`, 24)}"${preview(entry.prompt)}"${entry.diffCause.length > 0
            ? `   ${entry.diffCause.map((cause) => `${cause.id} /${cause.source}/ (${cause.intent})`).join(" · ")}`
            : ""}`),
        "",
        "This command records nothing: inject log, recall receipt and session state are all unchanged.",
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
            row("File", target),
            row("Result", "absent — only the built-in defaults apply. There is nothing to validate."),
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
            row("File", target),
            row("Result", `unreadable — ${error instanceof Error ? error.message : String(error)}`),
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
        row("File", `${target} (${bytes} bytes / limit ${OVERLAY_LIMITS.fileBytes})`),
        row("Result", errors.length === 0 ? `valid · ${warnings.length} warning(s)` : `${errors.length} error(s) · ${warnings.length} warning(s)`),
        ...issueLines(issues),
    ];
    if (errors.length > 0) {
        if (json) {
            console.log(JSON.stringify({ ok: false, file: target, issues }, null, 2));
        }
        else {
            console.error(lines.join("\n"));
            console.error("A single error makes the whole overlay ignored, and the built-in defaults take over.");
        }
        process.exit(1);
    }
    emit({ file: target, present: true, bytes, issues }, lines);
}
function cmdHistory() {
    const limit = intValue("--limit", 20);
    const entries = listOverlayHistory("recall-gate", limit);
    emit({ count: entries.length, snapshots: listOverlaySnapshots("recall-gate"), history: entries }, entries.length === 0
        ? ["No change history."]
        : [
            row("History", `${entries.length} entries · revisions you can roll back to: ${listOverlaySnapshots("recall-gate").join(", ") || "none"}`),
            ...entries.map((entry) => `  ${pad(shortTime(entry.ts), 18)}${pad(`rev ${entry.from_revision} → ${entry.to_revision}`, 18)}${pad(entry.action, 22)}${pad(entry.surface, 9)}${[
                entry.added?.length ? `added ${entry.added.join(",")}` : "",
                entry.disabled?.length ? `disabled ${entry.disabled.join(",")}` : "",
                entry.removed?.length ? `removed ${entry.removed.join(",")}` : "",
            ]
                .filter(Boolean)
                .join(" · ")}`),
        ]);
}
function cmdQuarantineList() {
    const entries = gateQuarantine();
    emit({ count: entries.length, quarantine: entries }, entries.length === 0
        ? ["No quarantined patterns."]
        : [
            `${entries.length} quarantined pattern(s) — they are not applied to the recall decision right now.`,
            ...entries.flatMap((entry) => {
                const pattern = loadRecallGateOverlay().doc?.patterns?.add?.find((candidate) => candidate.id === entry.pattern_id);
                return [
                    `  ${pad(entry.pattern_id, 20)}${pad(entry.overlay, 14)}${pattern ? `intent=${pattern.intent}  /${pattern.source}/${pattern.flags}` : "(a pattern the overlay no longer has)"}`,
                    `  ${" ".repeat(20)}${shortTime(entry.at)} · ${entry.elapsed_ms}ms over · ${entry.input_chars} input chars · ${entry.surface}`,
                ];
            }),
            "Release: fixing the regex clears it automatically, or run memex gate quarantine clear <pattern-id> to let it try once more.",
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
    // `quarantine clear` writes `overlays/quarantine.json`, never the overlay
    // document, so there is no revision to pin and `--expect-revision` does not
    // apply to it (docs/GUIDE.md §22 says so). `--dry-run` very much does: it is the
    // flag that lets an operator see what `--all` would take away first.
    const dryRun = bools.has("--dry-run");
    const result = await clearQuarantine(patternId, { surface: "cli", dryRun });
    if (result.cleared === 0) {
        emit({ cleared: 0, ids: [], ...(dryRun ? { dryRun: true } : {}) }, [
            patternId === undefined
                ? "No quarantined patterns — nothing changed."
                : `${patternId} is not in the quarantine list — nothing changed.`,
        ]);
        return;
    }
    if (dryRun) {
        emit({ dryRun: true, cleared: 0, wouldClear: result.cleared, ids: result.ids }, [
            row("Would clear", `${result.ids.join(" · ")} (${result.cleared} entries)`),
            row("Changes", "none — --dry-run writes nothing, not even an audit line."),
            row("Run", `memex gate quarantine clear ${patternId ?? "--all"}`),
        ]);
        return;
    }
    emit({ cleared: result.cleared, ids: result.ids }, [
        row("Cleared", `${result.ids.join(" · ")} (${result.cleared} entries)`),
        row("Effect", "They run again on the next prompt. Exceeding the budget quarantines them again."),
        row("Audit", "logs/ui-audit.jsonl action=gate.quarantine-clear"),
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
                `Would clear  ${add.length} user pattern(s) · ${disable.length} disable mark(s) — only the built-in defaults remain`,
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
                `Would clear  intent=${intent}  ${removed.length} user pattern(s) · ${reEnabled.length} re-enabled`,
                ...(removed.length > 0 ? [`  delete  ${removed.join(" · ")}`] : []),
                ...(reEnabled.length > 0 ? [`  re-enable  ${reEnabled.join(" · ")}`] : []),
            ];
        }
        await dryRun(next, summary, { probe: false, extraFlags: ["--yes"] });
    }
    if (!bools.has("--yes")) {
        fail("CONFIRMATION_REQUIRED", [
            "Refused — nothing was saved.",
            intent === undefined
                ? "  CONFIRMATION_REQUIRED  this clears the whole overlay. Pass --yes to confirm."
                : `  CONFIRMATION_REQUIRED  this clears the user rules for intent=${intent}. Pass --yes to confirm.`,
            "  (It is reversible: memex gate rollback --to <revision>)",
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
        row("Reset", intent === undefined
            ? "the overlay is empty — only the built-in defaults apply."
            : `cleared the user rules and disable marks for intent=${intent}.`),
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
                "Dry run — cannot roll back. Nothing was saved.",
                `  SNAPSHOT_NOT_FOUND  no snapshot for revision ${revision} (kept: ${listOverlaySnapshots("recall-gate").join(", ") || "none"})`,
            ]);
        }
        const doc = JSON.parse(JSON.stringify(kept));
        const add = (doc.patterns?.add ?? []);
        const disable = (doc.patterns?.disable ?? []);
        await dryRun(doc, [`Would roll back  the revision ${revision} snapshot  ${add.length} user pattern(s) · ${disable.length} disable mark(s)`], { probe: false });
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
    writeReceipt("gate.rollback", [row("Rolled back", `the revision ${revision} snapshot is re-applied as revision ${result.revision}.`)], snapshot, result, { fromSnapshot: revision });
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
    case "config":
        switch (sub) {
            case "show":
                cmdConfigShow();
                break;
            case "set":
                await cmdConfigSet();
                break;
            case "reset":
                await cmdConfigReset();
                break;
            default:
                usageError(`Unknown 'memex gate config' subcommand: ${sub ?? "(none)"}`);
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
