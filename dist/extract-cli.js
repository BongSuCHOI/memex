/**
 * `memex extract` — the CLI surface of the extraction-rules overlay (issue #30,
 * §3.7) plus the user-facing promotion of the evaluation harness.
 *
 * This command does NOT extract. Extraction runs from `memex backfill extract`
 * and the two workers; everything here reads or writes the RULES that extraction
 * obeys. The usage text says so in its first paragraph, because "extract" is the
 * word a user reaches for when they want facts, not rules.
 *
 * Three properties the transcripts depend on:
 *  - `show`/`validate`/`test`/`history`/`--dry-run`/`reextract --dry-run` write
 *    NOTHING: no overlay file, no database row, no audit line. The one exception
 *    is the quarantine file, because `test` runs the operator's patterns through
 *    the REAL matcher, so a pattern that blows the 50 ms budget is quarantined
 *    here exactly as it would be at the storage boundary.
 *  - no model and no embedding call is ever made, `eval` excepted — and that one
 *    is a separate verb precisely so the spend is explicit.
 *  - a refusal changes nothing: the issue rows name the path and severity, and
 *    the exit code is 1 (§4). A successful write releases the extraction jobs
 *    this overlay had put on hold, and says how many.
 */
import fs from "fs";
import { OverlayInvalidError, OverlayLockedError, OverlayStaleError, PROBE_WALL_MS, listOverlayHistory, listOverlaySnapshots, overlayPaths, readOverlaySnapshot, } from "./overlay-admin.js";
import { EXTRACTION_RULES_LIMITS, EXTRACTION_RULE_ENFORCEMENT_POINTS, buildBlockSet, composeEffectivePolicyVersion, currentExtractionRulesRevision, emptyExtractionRulesDoc, emptyLoadedExtractionRules, extractionRulesDocHash, isEmptyExtractionRules, loadExtractionRules, overlaysDisabled, readExtractionRulesFile, renderExtractionConstraintClause, resetExtractionRules, resolveExtractionRules, rollbackExtractionRules, setExtractionRules, validateExtractionRules, validateExtractionRulesDoc, } from "./extraction-rules.js";
import { MATCH_WALL_MS, oneShotMatcher, readQuarantine, } from "./overlay-matcher.js";
import { extractionRulesOverlayPath, getDbPath } from "./paths.js";
const USAGE = `Usage:
  memex extract rules show [--json]
  memex extract rules validate [<file>] [--json]
  memex extract rules set <file> [--expect-revision <n>] [--dry-run] [--json]
  memex extract rules test [--exchange <id>] [--recent <n>] [--project <p>] [--limit <n>] [--json]
  memex extract rules history [--limit <n>] [--json]
  memex extract rules reset --yes [--dry-run] [--json]
  memex extract rules rollback <revision> [--dry-run] [--json]
  memex extract rules reextract (--dry-run | --apply --yes) [--project <id>] [--session <id>] [--json]
  memex extract eval [--rules <path>] [--fixture <path>] [--session <id>] [--baseline <path>] [--out <path>]

THIS COMMAND DOES NOT EXTRACT. Extraction itself still runs via
'memex backfill extract' (and the two background workers); 'memex extract rules'
only reads and writes the local rules that extraction obeys.

The extraction-rules overlay adds your own RESTRICTIONS to fact extraction:
topics to stay away from, regexes that must never be stored, decision hints and a
preferred language. Restrictions only ever suppress — nothing here can widen what
the built-in policy accepts.

READ-ONLY verbs: show, validate, test, history, and every --dry-run. They call no
model and no embedding, and write neither the overlay nor the database.

WRITE verbs (set, reset, rollback, reextract --apply) take the overlay write
lock, bump 'revision', keep a rollback snapshot and append one metadata line to
logs/ui-audit.jsonl and overlays/history.jsonl. A successful rules write also
releases the extraction jobs this overlay had put on hold.
  --dry-run       validate and print the command to re-run, writing nothing
  --expect-revision <n>  refuse the write when the overlay changed elsewhere
                  first (exit 1, OVERLAY_STALE). REQUIRED by 'set' whenever the
                  overlay file already exists.

never_extract patterns run only inside a worker thread with a ${MATCH_WALL_MS} ms budget. A
pattern that exceeds it is QUARANTINED, and because a forbidden string must not
be stored just because the rule that forbids it turned out to be slow, extraction
is then HELD (fail-closed) until you fix the regex or clear the quarantine. The
syntax limits and the ${PROBE_WALL_MS} ms write-time probe are defence in depth, not a proof.

Changing rules never re-extracts anything by itself: the scheduling key
('continuity-fact-v1') does not contain the rule hash, so one edited character
cannot turn the whole corpus back into a backlog. 'rules reextract' is the
explicit, scoped way to ask for a re-run.

'memex extract eval' is the only verb that spends model calls: it runs the
fact-extraction evaluation harness with the rules overlay applied and reports
effective_policy_version in the receipt.

EXAMPLES:
  memex extract rules show
  memex extract rules set ./my-rules.json --dry-run
  memex extract rules test --recent 50
  memex extract rules reextract --dry-run
  memex extract eval --rules ./my-rules.json --out ./rules-eval.json`;
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
    "--file",
    "--expect-revision",
    "--limit",
    "--recent",
    "--exchange",
    "--session",
    "--project",
    "--scope",
    "--to",
]);
const BOOL_FLAGS = new Set(["--json", "--dry-run", "--apply", "--yes"]);
const positional = [];
const values = new Map();
const bools = new Set();
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
    return issues.map((issue) => `  ${pad(issue.severity, 9)}${pad(issue.code, 26)}${pad(issue.path ?? "-", 34)}${issue.message}`);
}
const SLOW_PATTERN_NOTE = [
    "Note: a syntax check alone cannot catch every pattern like this. Even once stored, it only",
    `      runs inside the ${MATCH_WALL_MS}ms budget, and a pattern that exceeds it is quarantined and extraction is held.`,
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
    fail("EXTRACT_CLI_ERROR", [
        "Refused — nothing was saved.",
        `  ${error instanceof Error ? error.message : String(error)}`,
    ]);
}
function shortTime(iso) {
    if (!iso)
        return "-";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return iso;
    const pad2 = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function preview(text, columns = 52) {
    const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
    return width(oneLine) > columns ? `${oneLine.slice(0, columns - 1)}…` : oneLine;
}
function rulesQuarantine() {
    return readQuarantine().filter((entry) => entry.overlay === "extraction-rules");
}
/**
 * Imported lazily so `--help` and a refused argument never pay for the extractor
 * and the database chain.
 */
async function policyVersions() {
    const { EXTRACTION_POLICY_VERSION, FACT_ENTAILMENT_POLICY_VERSION } = await import("./fact-extractor.js");
    const { FACT_EXTRACTION_POLICY_VERSION } = await import("./continuity-store.js");
    return {
        extraction: EXTRACTION_POLICY_VERSION,
        verifier: FACT_ENTAILMENT_POLICY_VERSION,
        scheduling: FACT_EXTRACTION_POLICY_VERSION,
    };
}
/**
 * Everything `show` needs from the database, read-only, in one open/close.
 *
 * A missing database is a normal state (a fresh install), not an error: the rules
 * are a file and answer for themselves.
 */
async function readDbReport(currentHash) {
    const dbPath = getDbPath();
    const empty = { dbPath, exists: false, heldJobs: [], drift: null };
    if (!fs.existsSync(dbPath))
        return empty;
    const { openReadDb } = await import("./db.js");
    const { heldJobSummary } = await import("./model-budget.js");
    let db;
    try {
        db = openReadDb(dbPath);
    }
    catch {
        return empty;
    }
    try {
        const heldJobs = heldJobSummary(db)
            .filter((entry) => String(entry.reason).startsWith("extraction_rules_"))
            .map((entry) => ({ reason: String(entry.reason), jobs: entry.jobs, oldestHeldAt: entry.oldestHeldAt }));
        let drift = null;
        try {
            const stale = db
                .prepare(`SELECT COUNT(*) AS targets, COUNT(DISTINCT session_id) AS sessions
             FROM extraction_targets
            WHERE state = 'completed' AND IFNULL(rules_hash, '') IS NOT ?`)
                .get(currentHash ?? "");
            drift = { targets: Number(stale?.targets ?? 0), sessions: Number(stale?.sessions ?? 0) };
        }
        catch {
            drift = null;
        }
        return { dbPath, exists: true, heldJobs, drift };
    }
    finally {
        db.close();
    }
}
function heldLines(report) {
    const heldJobs = report.heldJobs;
    // "No held job" and "we could not look" are different answers, and the one a
    // stopped pipeline needs is the second one.
    if (!report.exists)
        return [row("Held", `unknown — there is no database (${report.dbPath}).`)];
    if (heldJobs.length === 0)
        return [row("Held", "none — no extraction job is stopped by the rules.")];
    const total = heldJobs.reduce((sum, entry) => sum + entry.jobs, 0);
    return [
        row("Held", `${total} job(s) are waiting on the rules (${heldJobs.map((entry) => `${entry.reason} ${entry.jobs}`).join(" · ")})`),
        `${CONTINUE}The forbidden-string check did not finish, so nothing was stored. No retry was spent.`,
        `${CONTINUE}Fix the rules and run set/reset/rollback, and they resume immediately.`,
    ];
}
/* -------------------------------------------------------------------------- */
/* Documents and resolution                                                    */
/* -------------------------------------------------------------------------- */
/**
 * Resolve a candidate document the way the extractor would.
 *
 * The project-override merge (union for every restriction, override for the
 * language only) is lane C's rule and must not be re-implemented here, so this
 * routes through `resolveExtractionRules`. A null project is asked for under a
 * sentinel id that no override can carry, which makes the merge a no-op and
 * leaves exactly the global rule set.
 */
function resolveDoc(doc, projectId) {
    const hash = extractionRulesDocHash(doc);
    const loaded = {
        ...emptyLoadedExtractionRules(),
        present: true,
        hash,
        revision: doc.revision,
        doc,
    };
    const sentinel = projectId ?? "\u0000no-such-project";
    const resolved = resolveExtractionRules(sentinel, loaded);
    return projectId === null ? { ...resolved, projectId: null } : resolved;
}
/** Read a candidate rules file, refusing unreadable bytes rather than guessing. */
function readCandidate(file) {
    if (!fs.existsSync(file)) {
        fail("FILE_NOT_FOUND", [
            "Refused — nothing was saved.",
            `  FILE_NOT_FOUND  ${file} does not exist.`,
        ]);
    }
    const text = fs.readFileSync(file, "utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    try {
        return { path: file, bytes, raw: JSON.parse(text) };
    }
    catch (error) {
        fail("OVERLAY_UNREADABLE", [
            "Refused — nothing was saved.",
            `  OVERLAY_UNREADABLE  ${file} is not readable as JSON — ${error instanceof Error ? error.message : String(error)}`,
        ]);
    }
}
function expectRevision() {
    const raw = values.get("--expect-revision");
    if (raw === undefined)
        return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
        usageError("--expect-revision must be a non-negative integer");
    }
    return parsed;
}
/** The exact command to re-run, with the revision observed during the dry run. */
function rerunCommand(revision, extra = []) {
    const parts = ["memex", "extract"];
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
/** The receipt every successful rules write prints (§3.7 transcript). */
function writeReceipt(action, headline, before, result, payload = {}) {
    emit({
        action,
        revision: result.revision,
        hash: result.hash,
        fromRevision: before.revision,
        fromHash: before.hash,
        released: result.released,
        issues: result.issues,
        file: extractionRulesOverlayPath(),
        ...payload,
    }, [
        ...headline,
        row("File", `${extractionRulesOverlayPath()}  (revision ${before.revision} → ${result.revision}, ${before.hash ?? "none"} → ${result.hash ?? "none"})`),
        row("Resumed", `${result.released} extraction job(s) on hold went straight back to the queue.`),
        ...(result.issues.length > 0 ? ["Warnings", ...issueLines(result.issues)] : []),
        row("Effective", "Jobs already running are not interrupted — their prompt keeps the rules it started with,"),
        `${CONTINUE}and new never_extract patterns apply from that job's storage boundary on. Memories already extracted do not change.`,
        row("Audit", `logs/ui-audit.jsonl action=${action} · overlays/history.jsonl overlay=extraction-rules revision=${result.revision}`),
    ]);
}
function beforeState() {
    return { revision: currentExtractionRulesRevision(), hash: loadExtractionRules().hash };
}
/** A write DB when there is one — `releaseExtractionRulesHold` needs it. */
async function openWriteDbIfPresent() {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath))
        return { db: undefined, close: () => { } };
    try {
        const { openWriteDb } = await import("./db.js");
        const db = openWriteDb(dbPath);
        return { db, close: () => db.close() };
    }
    catch {
        // A rules write must still succeed with no usable database: the one hour
        // safety-net backoff recovers the held jobs either way (§3.5.2).
        return { db: undefined, close: () => { } };
    }
}
/* -------------------------------------------------------------------------- */
/* rules show                                                                  */
/* -------------------------------------------------------------------------- */
function statusLine(loaded) {
    if (loaded.disabledByEnv)
        return "not read — MEMEX_DISABLE_OVERLAYS=1 · running without the overlay";
    if (!loaded.present)
        return "absent — extraction follows the built-in policy only";
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
        return `invalid — ${errors.length} error(s) · extraction is held (memex extract rules validate)`;
    }
    return `applied · revision ${loaded.revision} · ${loaded.hash ?? "none"} · ${shortTime(loaded.doc?.updated_at)}`;
}
function ruleSummaryLines(rules) {
    if (isEmptyExtractionRules(rules))
        return [row("Rules", "—")];
    const lines = [
        row("Rules", `${rules.excludeTopics.length} excluded topic(s) · ${rules.neverExtract.length} never_extract pattern(s) · ` +
            `${rules.decisionHints.length} decision hint(s) · preferred language ${rules.preferredLanguage ?? "unset"}`),
    ];
    for (const topic of rules.excludeTopics)
        lines.push(`${CONTINUE}exclude   ${topic}`);
    for (const pattern of rules.neverExtract) {
        lines.push(`${CONTINUE}never     ${pad(pattern.id, 20)}/${pattern.source}/${pattern.flags ?? ""}  scope=${pattern.scope ?? "both"}`);
    }
    for (const hint of rules.decisionHints) {
        lines.push(`${CONTINUE}hint      ${pad(hint.id, 20)}/${hint.source}/${hint.flags ?? ""}`);
    }
    return lines;
}
async function cmdShow() {
    const loaded = loadExtractionRules();
    const policy = await policyVersions();
    const effective = composeEffectivePolicyVersion(policy.extraction, loaded.hash);
    const report = await readDbReport(loaded.hash);
    const quarantined = rulesQuarantine();
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    const warnings = loaded.issues.filter((issue) => issue.severity === "warning");
    emit({
        file: extractionRulesOverlayPath(),
        dir: overlayPaths().dir,
        overlaysDisabled: overlaysDisabled(),
        present: loaded.present,
        revision: loaded.revision,
        hash: loaded.hash,
        updatedAt: loaded.doc?.updated_at ?? null,
        updatedBy: loaded.doc?.updated_by ?? null,
        policyVersion: policy.extraction,
        verifierPolicyVersion: policy.verifier,
        effectivePolicyVersion: effective,
        schedulingPolicyVersion: policy.scheduling,
        enforcementPoints: [...EXTRACTION_RULE_ENFORCEMENT_POINTS],
        rules: loaded.global,
        // Issue #123 — the effective default is not in the overlay, so --json has
        // to carry it or a consumer cannot tell "unset" from "nothing decides".
        language: {
            default: "conversation",
            override: loaded.global.preferredLanguage,
        },
        quarantine: quarantined,
        issues: loaded.issues,
        heldJobs: report.heldJobs,
        drift: report.drift,
        dbPath: report.dbPath,
        dbPresent: report.exists,
        limits: EXTRACTION_RULES_LIMITS,
        matchWallMs: MATCH_WALL_MS,
        probeWallMs: PROBE_WALL_MS,
        shared: false,
    }, [
        row("File", `${extractionRulesOverlayPath()}${loaded.present ? "" : "  (absent)"}`),
        row("Status", statusLine(loaded)),
        row("Policy", `${pad(policy.extraction, 30)}(verifier ${policy.verifier} — the overlay does not change it)`),
        row("Effective", `${pad(effective, 30)}(${loaded.hash ? "a reporting identifier" : "no overlay"})`),
        row("Sched key", `${pad(policy.scheduling, 30)}(the overlay does not change it — a rules edit never triggers a full re-extraction)`),
        row("Enforced", `${EXTRACTION_RULE_ENFORCEMENT_POINTS.join(" · ")} — as a block set at the storage boundary`),
        row("Effective", "The rules in force when a job is claimed ride in its prompt,"),
        `${CONTINUE}and never_extract patterns are re-read from the file at the storage boundary.`,
        `${CONTINUE}→ a tightened restriction applies at once; a relaxed one from the next job on.`,
        // Issue #123 — the effective DEFAULT, which is not in the overlay file at
        // all. Without this line an operator reading `preferred language unset`
        // below would conclude that nothing decides the language.
        row("Language", loaded.global.preferredLanguage === null
            ? "follows the conversation (override: preferred_language)"
            : `${loaded.global.preferredLanguage} — preferred_language overrides the default, which follows the conversation`),
        ...ruleSummaryLines(loaded.global),
        ...(quarantined.length > 0
            ? [
                row("Quarantined", `${quarantined.map((entry) => entry.pattern_id).join(" · ")} — over the ${MATCH_WALL_MS}ms budget, so they are not applied`),
                `${CONTINUE}Release: fixing the regex clears it automatically, or memex gate quarantine clear <pattern-id>`,
            ]
            : []),
        row("Warnings", warnings.length === 0 && errors.length === 0
            ? "none"
            : `${errors.length} error(s) · ${warnings.length} warning(s)`),
        ...issueLines(loaded.issues),
        ...heldLines(report),
        row("Drift", report.drift === null
            ? report.exists
                ? "could not be read (no extraction_targets)"
                : `there is no database (${report.dbPath})`
            : report.drift.targets === 0
                ? `every completed extraction is on ${loaded.hash ?? "no overlay"}`
                : `${report.drift.sessions} session(s) extracted under different rules (${report.drift.targets} target(s)) — memex extract rules reextract --dry-run`),
        row("Run", "Extraction itself still runs from memex backfill extract."),
        row("Sharing", "These rules are not shared between devices yet (planned for 0.7.1)."),
    ]);
}
/* -------------------------------------------------------------------------- */
/* rules validate                                                              */
/* -------------------------------------------------------------------------- */
async function cmdValidate() {
    const file = positional[2] ?? values.get("--file");
    const liveFile = extractionRulesOverlayPath();
    const target = file ?? liveFile;
    if (!fs.existsSync(target)) {
        emit({ file: target, present: false, issues: [] }, [
            row("File", target),
            row("Result", "absent — extraction follows the built-in policy only. There is nothing to validate."),
        ]);
        return;
    }
    const candidate = readCandidate(target);
    const result = await validateExtractionRules(candidate.raw, {
        probe: true,
        forWrite: false,
        bytes: candidate.bytes,
    });
    const issues = [...result.issues];
    // The live file's quarantine rows are part of its verdict: a quarantined
    // never_extract pattern HOLDS extraction, which doctor fails on (§3.5.2).
    if (file === undefined) {
        for (const issue of loadExtractionRules().issues) {
            if (issue.code === "PATTERN_QUARANTINED")
                issues.push(issue);
        }
    }
    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");
    const lines = [
        row("File", `${target} (${candidate.bytes} bytes / limit ${EXTRACTION_RULES_LIMITS.fileBytes})`),
        row("Result", errors.length === 0
            ? `valid · ${warnings.length} warning(s)`
            : `${errors.length} error(s) · ${warnings.length} warning(s)`),
        ...issueLines(issues),
    ];
    if (errors.length > 0) {
        if (json) {
            console.log(JSON.stringify({ ok: false, file: target, issues }, null, 2));
        }
        else {
            console.error(lines.join("\n"));
            console.error("A single error leaves this overlay unapplied and extraction held — no retry is spent.");
        }
        process.exit(1);
    }
    emit({ file: target, present: true, bytes: candidate.bytes, issues }, lines);
}
const EMPTY_SCAN = { scanned: 0, blocked: [] };
/**
 * Run one row through the production block-set builder.
 *
 * `buildBlockSet` is the exact function the storage boundary uses — same matcher,
 * same scope split, same quarantine behaviour — so a preview that says "this
 * would have been blocked" is answering with the code that does the blocking.
 * One row per call is what gives the transcript a pattern id per row, and it
 * costs the same number of matcher round-trips as one batched call would.
 */
async function scanRows(matcher, patterns, rows, state) {
    const blocked = [];
    let scanned = 0;
    for (const candidate of rows) {
        if (state.failed !== null)
            break;
        scanned += 1;
        const outcome = await buildBlockSet(matcher, patterns, [{ item: candidate, candidate: { factText: candidate.factText, evidence: candidate.evidence } }], "extract-cli");
        if (!outcome.ok) {
            state.failed = `${outcome.reason}: ${outcome.detail}`;
            state.quarantined = [...state.quarantined, ...outcome.quarantined];
            break;
        }
        state.elapsedMs += outcome.elapsedMs;
        if (outcome.blocked.size > 0) {
            blocked.push({
                id: candidate.id,
                label: candidate.label,
                patternIds: outcome.patternIds,
                preview: candidate.preview,
            });
        }
    }
    return { scanned, blocked };
}
/**
 * The stage-1 report: zero model calls, zero embedding calls, reads only what is
 * already stored.
 *
 * The advisory items (`exclude_topics`, the decision hints and the preferred
 * language) are reported as model-only rather than guessed at. A topic is not
 * locally decidable, and inventing a number for it would be the one dishonest
 * line in an otherwise deterministic preview.
 */
async function simulate(input) {
    const advisoryOnly = {
        excludeTopics: input.rules.excludeTopics,
        decisionHints: input.rules.decisionHints.map((hint) => hint.id),
        preferredLanguage: input.rules.preferredLanguage,
    };
    const state = { elapsedMs: 0, failed: null, quarantined: [] };
    if (input.rules.neverExtract.length === 0) {
        return {
            available: true,
            reason: null,
            facts: EMPTY_SCAN,
            incidents: EMPTY_SCAN,
            exchanges: EMPTY_SCAN,
            matcher: state,
            advisoryOnly,
        };
    }
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
        return {
            available: false,
            reason: `there is no database (${dbPath}) — stored memories and conversations cannot be read.`,
            facts: EMPTY_SCAN,
            incidents: EMPTY_SCAN,
            exchanges: EMPTY_SCAN,
            matcher: state,
            advisoryOnly,
        };
    }
    const { openReadDb } = await import("./db.js");
    let db;
    try {
        db = openReadDb(dbPath);
    }
    catch (error) {
        return {
            available: false,
            reason: `could not open the database: ${error instanceof Error ? error.message : String(error)}`,
            facts: EMPTY_SCAN,
            incidents: EMPTY_SCAN,
            exchanges: EMPTY_SCAN,
            matcher: state,
            advisoryOnly,
        };
    }
    const query = (sql, params) => {
        try {
            return db.prepare(sql).all(...params);
        }
        catch {
            return [];
        }
    };
    const factRows = query(`SELECT id, fact, fact_kr, category FROM facts
      WHERE is_active = 1 ${input.project ? "AND scope_project = ?" : ""}
      ORDER BY updated_at DESC LIMIT ?`, input.project ? [input.project, input.memoryLimit] : [input.memoryLimit]).map((fact) => ({
        id: fact.id.slice(0, 8),
        label: `[${fact.category ?? "unknown"}]`,
        factText: [fact.fact, fact.fact_kr ?? ""].filter((text) => text.length > 0),
        evidence: [],
        preview: preview(fact.fact),
    }));
    const incidentRows = query(`SELECT occurrence_id, signature_text, subject_key FROM incident_occurrences
      ${input.project ? "WHERE project_id = ?" : ""}
      ORDER BY recorded_at DESC LIMIT ?`, input.project ? [input.project, input.memoryLimit] : [input.memoryLimit]).map((incident) => ({
        id: incident.occurrence_id.slice(0, 8),
        label: "[incident]",
        factText: [incident.signature_text, incident.subject_key ?? ""].filter((text) => text.length > 0),
        evidence: [],
        preview: preview(incident.signature_text),
    }));
    const exchangeRows = (input.exchangeId
        ? query("SELECT id, user_message, assistant_message FROM exchanges WHERE id = ?", [input.exchangeId])
        : query(`SELECT id, user_message, assistant_message FROM exchanges
            ${input.project ? "WHERE project = ?" : ""}
            ORDER BY timestamp DESC LIMIT ?`, input.project ? [input.project, input.recent] : [input.recent])).map((exchange) => ({
        id: exchange.id.slice(0, 8),
        label: "[exchange]",
        factText: [exchange.user_message ?? "", exchange.assistant_message ?? ""].filter((t) => t.length > 0),
        // An exchange is the INPUT, so both halves are checked as text: the scope
        // split only means something for a fact and its evidence span.
        evidence: [exchange.user_message ?? ""].filter((text) => text.length > 0),
        preview: preview(exchange.user_message ?? exchange.assistant_message ?? ""),
    }));
    if (input.exchangeId && exchangeRows.length === 0) {
        db.close();
        fail("EXCHANGE_UNKNOWN", [`no exchange ${input.exchangeId} (memex search).`]);
    }
    const matcher = oneShotMatcher();
    try {
        const facts = await scanRows(matcher, input.rules.neverExtract, factRows, state);
        const incidents = await scanRows(matcher, input.rules.neverExtract, incidentRows, state);
        const exchanges = await scanRows(matcher, input.rules.neverExtract, exchangeRows, state);
        return { available: true, reason: null, facts, incidents, exchanges, matcher: state, advisoryOnly };
    }
    finally {
        matcher.dispose();
        db.close();
    }
}
function simulationLines(report, rules) {
    const lines = ["Impact simulation (0 model calls; reads only stored memories and conversations):"];
    if (rules.neverExtract.length === 0) {
        lines.push("  No never_extract patterns, so there is nothing to check deterministically.");
    }
    else if (!report.available) {
        lines.push(`  ${report.reason}`);
    }
    else {
        const section = (title, scan, noun) => {
            lines.push(`  ${title}: ${scan.blocked.length} of ${scan.scanned} match never_extract_patterns${noun ? ` — ${noun}` : ""}`);
            for (const blocked of scan.blocked) {
                lines.push(`    ${pad(blocked.id, 10)}${pad(blocked.patternIds.join(","), 22)}${pad(blocked.label, 14)}"${blocked.preview}"`);
            }
        };
        section("Active memories", report.facts, "these would not have been created had the rules come first");
        section("Incident records", report.incidents, "");
        section("Recent exchanges", report.exchanges, "this shape appears in the conversation");
        lines.push("  This command changes no memory or incident record already stored. To remove one: memex facts deactivate --id <uuid>");
        if (report.matcher.failed !== null) {
            lines.push(`  matcher stopped — ${report.matcher.failed}` +
                (report.matcher.quarantined.length > 0
                    ? ` (quarantined: ${report.matcher.quarantined.join(" · ")})`
                    : ""));
            lines.push("  In production this stores nothing and holds extraction.");
        }
        else {
            lines.push(`  matcher ran ${report.matcher.elapsedMs.toFixed(1)}ms / budget ${MATCH_WALL_MS}ms per request`);
        }
    }
    lines.push("  exclude_topics / always_treat_as_decision / preferred_language cannot be checked locally —");
    lines.push("  they only travel in the prompt, and the result shows up only in a model evaluation (memex extract eval).");
    if (report.advisoryOnly.excludeTopics.length > 0) {
        lines.push(`    excluded topics (model-only)  ${report.advisoryOnly.excludeTopics.join("; ")}`);
    }
    if (report.advisoryOnly.decisionHints.length > 0) {
        lines.push(`    decision hints (model-only)  ${report.advisoryOnly.decisionHints.join(" · ")}`);
    }
    if (report.advisoryOnly.preferredLanguage !== null) {
        lines.push(`    preferred language (model-only)  ${report.advisoryOnly.preferredLanguage} — an override; the default follows the conversation`);
    }
    return lines;
}
/* -------------------------------------------------------------------------- */
/* rules test                                                                  */
/* -------------------------------------------------------------------------- */
async function cmdTest() {
    const file = values.get("--file");
    const project = values.get("--project") ?? null;
    let rules;
    let source;
    if (file !== undefined) {
        const candidate = readCandidate(file);
        const validation = validateExtractionRulesDoc(candidate.raw, { bytes: candidate.bytes });
        if (!validation.ok || !validation.doc) {
            fail("OVERLAY_INVALID", ["Refused — the candidate file is not valid.", ...issueLines(validation.issues)], { issues: validation.issues });
        }
        rules = resolveDoc(validation.doc, project);
        source = file;
    }
    else {
        const loaded = loadExtractionRules();
        rules = resolveExtractionRules(project, loaded);
        source = extractionRulesOverlayPath();
    }
    const report = await simulate({
        rules,
        project,
        exchangeId: values.get("--exchange") ?? null,
        recent: intValue("--recent", 200),
        memoryLimit: intValue("--limit", 2_000),
    });
    const clause = renderExtractionConstraintClause(rules);
    emit({
        source,
        project,
        rulesHash: rules.hash,
        revision: rules.revision,
        clause: { chars: clause.length, text: clause },
        enforcementPoints: [...EXTRACTION_RULE_ENFORCEMENT_POINTS],
        neverExtract: rules.neverExtract,
        ...report,
    }, [
        row("Rules", `${source}  (${rules.hash ?? "none"}${project ? ` · project=${project}` : ""})`),
        row("Model", "0 calls — this command calls no model and no embedding"),
        row("Enforced", `${EXTRACTION_RULE_ENFORCEMENT_POINTS.join(" · ")} — as a block set at the storage boundary`),
        "",
        ...simulationLines(report, rules),
        "",
        "This command records nothing: overlay, database and audit log are all unchanged.",
        `(One exception: a never_extract pattern that exceeds the ${MATCH_WALL_MS}ms budget is quarantined exactly as in production — only that fact is recorded.)`,
    ]);
}
/* -------------------------------------------------------------------------- */
/* rules set                                                                   */
/* -------------------------------------------------------------------------- */
async function cmdSet() {
    const file = positional[2] ?? values.get("--file");
    if (!file)
        usageError("set needs a file: memex extract rules set <file>");
    const candidate = readCandidate(file);
    const validation = await validateExtractionRules(candidate.raw, {
        probe: true,
        forWrite: true,
        bytes: candidate.bytes,
    });
    const errors = validation.issues.filter((issue) => issue.severity === "error");
    if (!validation.ok || !validation.doc) {
        fail("OVERLAY_INVALID", [
            "Refused — nothing was saved.",
            ...issueLines(validation.issues),
            ...(hasRegexIssue(errors) ? SLOW_PATTERN_NOTE : []),
        ], { issues: validation.issues });
    }
    const policy = await policyVersions();
    const revision = currentExtractionRulesRevision();
    const present = readExtractionRulesFile().present;
    const resolved = resolveDoc(validation.doc, null);
    const clause = renderExtractionConstraintClause(resolved);
    const itemCount = resolved.excludeTopics.length +
        resolved.neverExtract.length +
        resolved.decisionHints.length +
        (resolved.preferredLanguage === null ? 0 : 1);
    if (bools.has("--dry-run")) {
        const report = await simulate({
            rules: resolved,
            project: null,
            exchangeId: null,
            recent: intValue("--recent", 200),
            memoryLimit: intValue("--limit", 2_000),
        });
        emit({
            dryRun: true,
            file,
            revision,
            nextRevision: revision + 1,
            hash: resolved.hash,
            currentHash: loadExtractionRules().hash,
            issues: validation.issues,
            clause: { chars: clause.length, text: clause },
            effectivePolicyVersion: composeEffectivePolicyVersion(policy.extraction, resolved.hash),
            verifierPolicyVersion: policy.verifier,
            enforcementPoints: [...EXTRACTION_RULE_ENFORCEMENT_POINTS],
            rerun: rerunCommand(revision),
            ...report,
        }, [
            "Dry run — nothing was saved.",
            row("Checked", `syntax ok · probe ok (budget ${PROBE_WALL_MS}ms) · items ${itemCount} · warnings ${validation.issues.length}`),
            ...issueLines(validation.issues),
            row("Hash", `${resolved.hash}   (current: ${loadExtractionRules().hash ?? "none"}, revision ${revision})`),
            "",
            ...(clause === ""
                ? ["Constraint clause preview — empty (with no rules the prompt is byte-identical)."]
                : [
                    `Constraint clause preview — appended to the extraction system prompt (${clause.length} chars):`,
                    ...clause.split("\n").map((line) => `  ${line}`),
                ]),
            "",
            row("Verifier", `unchanged (${policy.verifier}, byte-identical)`),
            row("Enforced", `${EXTRACTION_RULE_ENFORCEMENT_POINTS.join(" · ")} — as a block set at the storage boundary`),
            `${CONTINUE}(a blocked candidate is DROPPED, not a job failure: no retry is spent)`,
            "",
            ...simulationLines(report, resolved),
            "",
            row("Apply", rerunCommand(revision)),
            row("Suggested", `evaluate before applying: memex extract eval --rules ${file} --out ./rules-eval.json`),
        ]);
        return;
    }
    // §1.5 lost-update contract: the full-document path must name the revision it
    // believes it is replacing once a file exists, or a concurrent edit is lost
    // silently. `--dry-run` above printed the exact command with it filled in.
    if (present && expectRevision() === undefined) {
        fail("EXPECTED_REVISION_REQUIRED", [
            "Refused — nothing was saved.",
            `  EXPECTED_REVISION_REQUIRED  a rules file already exists (revision ${revision}). Pass --expect-revision ${revision} to replace the whole document.`,
            `  (To see it first: memex extract rules set ${file} --dry-run)`,
        ]);
    }
    const snapshot = beforeState();
    const handle = await openWriteDbIfPresent();
    let result;
    try {
        result = await setExtractionRules(validation.doc, {
            surface: "cli",
            expectedRevision: expectRevision(),
            db: handle.db,
        });
    }
    catch (error) {
        handle.close();
        failFromError(error);
    }
    handle.close();
    writeReceipt("rules.set", [
        row("Applied", `revision ${snapshot.revision} → ${result.revision} · ${snapshot.hash ?? "none"} → ${result.hash ?? "none"}`),
        row("Checked", `syntax ok · probe ok (budget ${PROBE_WALL_MS}ms) · items ${itemCount}`),
    ], snapshot, result, { source: file, clause: { chars: clause.length } });
}
/* -------------------------------------------------------------------------- */
/* rules reset / rollback / history                                            */
/* -------------------------------------------------------------------------- */
/**
 * What a `reset` / `rollback` dry run prints.
 *
 * The shared shape matters more than the wording: `--dry-run` is the promise that
 * nothing moved, so it names the revision it observed, the document it would
 * write, and the exact command that applies it — and it touches no file, no
 * snapshot, no history line and no held job.
 */
function emitWriteDryRun(action, doc, headline, payload = {}, extraFlags = []) {
    const revision = currentExtractionRulesRevision();
    const resolved = resolveDoc(doc, null);
    emit({
        dryRun: true,
        action,
        revision,
        nextRevision: revision + 1,
        currentHash: loadExtractionRules().hash,
        hash: resolved.hash,
        rerun: rerunCommand(revision, extraFlags),
        ...payload,
    }, [
        "Dry run — nothing was saved.",
        ...headline,
        row("Hash", `${loadExtractionRules().hash ?? "none"} → ${resolved.hash ?? "none"}  (revision ${revision} → ${revision + 1})`),
        row("Held", "Extraction jobs on hold stay there — they are only released by a real apply."),
        row("Apply", rerunCommand(revision, extraFlags)),
    ]);
}
async function cmdReset() {
    if (bools.has("--dry-run")) {
        const current = loadExtractionRules();
        emitWriteDryRun("rules.reset", emptyExtractionRulesDoc(), [
            row("Would reset", `clears the rules — ${current.global.neverExtract.length} never_extract pattern(s) and ${current.global.excludeTopics.length} excluded topic(s) go away. Memories already extracted do not change.`),
        ], {}, ["--yes"]);
        return;
    }
    if (!bools.has("--yes")) {
        fail("CONFIRMATION_REQUIRED", [
            "Refused — nothing was saved.",
            "  CONFIRMATION_REQUIRED  this clears the whole rules overlay. Pass --yes to confirm.",
            "  (It is reversible: memex extract rules rollback <revision>)",
        ]);
    }
    const snapshot = beforeState();
    const handle = await openWriteDbIfPresent();
    let result;
    try {
        result = await resetExtractionRules({
            surface: "cli",
            expectedRevision: expectRevision(),
            db: handle.db,
        });
    }
    catch (error) {
        handle.close();
        failFromError(error);
    }
    handle.close();
    writeReceipt("rules.reset", [row("Reset", "the rules are empty — extraction follows the built-in policy only. Memories already extracted do not change.")], snapshot, result);
}
async function cmdRollback() {
    const raw = positional[2] ?? values.get("--to");
    if (raw === undefined)
        usageError("rollback needs <revision>");
    const revision = Number(raw);
    if (!Number.isInteger(revision) || revision < 0) {
        usageError("rollback needs a non-negative integer revision");
    }
    if (bools.has("--dry-run")) {
        const kept = readOverlaySnapshot("extraction-rules", revision);
        if (kept === null) {
            fail("SNAPSHOT_NOT_FOUND", [
                "Dry run — cannot roll back. Nothing was saved.",
                `  SNAPSHOT_NOT_FOUND  no snapshot for revision ${revision} (kept: ${listOverlaySnapshots("extraction-rules").join(", ") || "none"})`,
            ]);
        }
        const validation = await validateExtractionRules(kept, { probe: false, forWrite: true });
        if (!validation.ok || !validation.doc) {
            fail("OVERLAY_INVALID", [
                "Dry run — refused. Nothing was saved.",
                ...issueLines(validation.issues),
            ], { dryRun: true, issues: validation.issues });
        }
        emitWriteDryRun("rules.rollback", validation.doc, [row("Would roll back", `the revision ${revision} snapshot, re-applied as revision ${currentExtractionRulesRevision() + 1}.`)], { fromSnapshot: revision, issues: validation.issues });
        return;
    }
    const snapshot = beforeState();
    const handle = await openWriteDbIfPresent();
    let result;
    try {
        result = await rollbackExtractionRules(revision, {
            surface: "cli",
            expectedRevision: expectRevision(),
            db: handle.db,
        });
    }
    catch (error) {
        handle.close();
        failFromError(error);
    }
    handle.close();
    writeReceipt("rules.rollback", [row("Rolled back", `the revision ${revision} snapshot is re-applied as revision ${result.revision}.`)], snapshot, result, { fromSnapshot: revision });
}
function cmdHistory() {
    const limit = intValue("--limit", 20);
    const entries = listOverlayHistory("extraction-rules", limit);
    const snapshots = listOverlaySnapshots("extraction-rules");
    emit({ count: entries.length, snapshots, history: entries }, entries.length === 0
        ? ["No change history."]
        : [
            row("History", `${entries.length} entries · revisions you can roll back to: ${snapshots.join(", ") || "none"}`),
            ...entries.map((entry) => `  ${pad(shortTime(entry.ts), 18)}${pad(`rev ${entry.from_revision} → ${entry.to_revision}`, 18)}${pad(entry.action, 18)}${pad(entry.surface, 9)}${Object.entries(entry.counts ?? {})
                .map(([key, value]) => `${key}=${value}`)
                .join(" · ")}`),
        ]);
}
/**
 * Re-queue completed extraction work whose rule hash is not the current one.
 *
 * The immutable target and its item snapshot already exist, so this re-opens
 * them rather than building new ones — the `memex recover` shape (one
 * transaction, CAS on the state it claims to be reverting, nothing deleted).
 * `policy_version` is NEVER touched: that column is the scheduling key, and
 * rewriting it would be the full-corpus re-extraction this design exists to
 * avoid (`test/extraction-policy-keying.test.ts` is the guard).
 */
async function cmdReextract() {
    const apply = bools.has("--apply");
    const dry = bools.has("--dry-run");
    if (apply && dry)
        usageError("reextract takes either --dry-run or --apply, not both");
    if (!apply && !dry) {
        fail("CONFIRMATION_REQUIRED", [
            "Refused — nothing was changed.",
            "  CONFIRMATION_REQUIRED  reextract needs either --dry-run or --apply.",
            "  (To see it first: memex extract rules reextract --dry-run)",
        ]);
    }
    if (apply && !bools.has("--yes")) {
        fail("CONFIRMATION_REQUIRED", [
            "Refused — nothing was changed.",
            "  CONFIRMATION_REQUIRED  --apply spends new model calls. Pass --yes to confirm.",
        ]);
    }
    // `--scope project <id>` is the design document's spelling of `--project <id>`.
    const scope = values.get("--scope");
    if (scope !== undefined && scope !== "project") {
        usageError("--scope currently accepts only 'project'");
    }
    const project = values.get("--project") ?? (scope === "project" ? positional[2] : undefined) ?? null;
    const session = values.get("--session") ?? null;
    const sampleLimit = intValue("--limit", 10);
    const hash = loadExtractionRules().hash;
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
        fail("DB_UNAVAILABLE", [`there is no database (${dbPath}) — the targets to re-extract cannot be read.`]);
    }
    const { openReadDb, openWriteDb } = await import("./db.js");
    const db = apply ? openWriteDb(dbPath) : openReadDb(dbPath);
    try {
        const where = ["t.state = 'completed'", "IFNULL(t.rules_hash, '') IS NOT ?"];
        const params = [hash ?? ""];
        if (project !== null) {
            where.push("t.project = ?");
            params.push(project);
        }
        if (session !== null) {
            where.push("t.session_id = ?");
            params.push(session);
        }
        let rows;
        try {
            rows = db
                .prepare(`SELECT t.target_id, t.session_id, t.project, t.rules_hash, t.item_count, t.updated_at,
                    j.job_id, j.checkpoint_id
               FROM extraction_targets t
               LEFT JOIN memory_jobs j ON j.target_id = t.target_id
              WHERE ${where.join(" AND ")}
              ORDER BY t.updated_at DESC`)
                .all(...params).map((candidate) => ({
                targetId: String(candidate.target_id),
                jobId: candidate.job_id == null ? null : String(candidate.job_id),
                checkpointId: candidate.checkpoint_id == null ? null : String(candidate.checkpoint_id),
                sessionId: String(candidate.session_id),
                project: String(candidate.project),
                rulesHash: candidate.rules_hash == null ? null : String(candidate.rules_hash),
                itemCount: Number(candidate.item_count ?? 0),
                updatedAt: String(candidate.updated_at ?? ""),
            }));
        }
        catch (error) {
            fail("DB_UNAVAILABLE", [
                `could not read the extraction targets: ${error instanceof Error ? error.message : String(error)}`,
            ]);
        }
        const sessions = new Set(rows.map((candidate) => candidate.sessionId));
        const items = rows.reduce((sum, candidate) => sum + candidate.itemCount, 0);
        const sample = rows.slice(0, sampleLimit);
        const sampleLines = sample.map((candidate) => `  ${pad(candidate.targetId.slice(0, 12), 14)}${pad(candidate.rulesHash ?? "none", 20)}${pad(`${candidate.itemCount} turns`, 8)}${pad(shortTime(candidate.updatedAt), 18)}${candidate.sessionId}`);
        const scopeText = `${project === null ? "all projects" : `project=${project}`}${session === null ? "" : ` · session=${session}`}`;
        if (dry) {
            emit({
                dryRun: true,
                currentHash: hash,
                scope: { project, session },
                targets: rows.length,
                sessions: sessions.size,
                items,
                sample,
            }, [
                "Dry run — nothing was changed.",
                row("Hash", hash ?? "none (no overlay)"),
                row("Scope", scopeText),
                row("Targets", `${rows.length} completed target(s) extracted under different rules · ${sessions.size} session(s) · ${items} exchange(s)`),
                ...sampleLines,
                ...(rows.length > sample.length ? [`  … and ${rows.length - sample.length} more (--limit shows more)`] : []),
                "",
                row("Cost", `re-extraction spends new model calls for ${items} exchange(s).`),
                `${CONTINUE}Check the budget with memex model-work. This command deletes no memory already stored.`,
                row("Sched key", "policy_version is untouched — only the chosen scope goes back to the queue."),
                row("Apply", `memex extract rules reextract --apply --yes${project === null ? "" : ` --project ${project}`}${session === null ? "" : ` --session ${session}`}`),
            ]);
            return;
        }
        const now = new Date().toISOString();
        const changed = {};
        const requeued = [];
        // One shared implementation with the store that owns these tables, so the
        // progress fields a re-queue has to rewind cannot drift apart from the ones
        // the claim path reads.
        const { requeueCompletedExtractionTarget } = await import("./continuity-store.js");
        db.transaction(() => {
            for (const candidate of rows) {
                const counts = requeueCompletedExtractionTarget(db, {
                    targetId: candidate.targetId,
                    jobId: candidate.jobId,
                    checkpointId: candidate.checkpointId,
                    now,
                });
                if (Object.keys(counts).length === 0)
                    continue;
                requeued.push(candidate.targetId);
                for (const [table, value] of Object.entries(counts)) {
                    changed[table] = (changed[table] ?? 0) + value;
                }
            }
        }).immediate();
        const { appendUiAuditLine } = await import("./ontology-admin.js");
        appendUiAuditLine("rules.reextract", {
            id: hash ?? "none",
            overlay: "extraction-rules",
            targets: requeued.length,
            sessions: sessions.size,
            items,
            ...(project === null ? {} : { project }),
            ...(session === null ? {} : { session }),
        });
        emit({
            dryRun: false,
            currentHash: hash,
            scope: { project, session },
            targets: rows.length,
            requeued: requeued.length,
            sessions: sessions.size,
            items,
            changed,
        }, [
            row("Requeued", `${requeued.length} completed target(s) / ${rows.length} candidate(s) · ${sessions.size} session(s) · ${items} exchange(s)`),
            ...(requeued.length < rows.length
                ? [`${CONTINUE}${rows.length - requeued.length} changed state in the meantime and were left alone.`]
                : []),
            row("Rewound", Object.entries(changed)
                .map(([table, count]) => `${table} ${count}`)
                .join(" · ") || "none"),
            row("Sched key", "policy_version was untouched — no full re-extraction happens."),
            row("Run", "Re-extraction does not start by itself: memex backfill extract"),
            row("Audit", "logs/ui-audit.jsonl action=rules.reextract"),
        ]);
    }
    finally {
        db.close();
    }
}
/* -------------------------------------------------------------------------- */
/* eval                                                                        */
/* -------------------------------------------------------------------------- */
/**
 * The user-facing promotion of `scripts/fact-extraction-eval.mjs` (§3.7).
 *
 * Forwarded rather than re-implemented: the harness owns the fixture contract,
 * the baseline comparison and the receipt, and a second copy of that would drift.
 * Every remaining argument goes through untouched, which is also why this is the
 * one verb that can spend model calls.
 */
async function cmdEval() {
    const script = new URL("../scripts/fact-extraction-eval.mjs", import.meta.url);
    if (!fs.existsSync(script)) {
        fail("EVAL_UNAVAILABLE", [
            `the evaluation harness was not found (${script.pathname}).`,
            "Run it from a source checkout, or run npm run build and try again.",
        ]);
    }
    const forwarded = argv.slice(1);
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [script.pathname, ...forwarded], { stdio: "inherit" });
    const code = await new Promise((resolve) => {
        child.on("error", () => resolve(1));
        child.on("close", (status) => resolve(status ?? 1));
    });
    process.exit(code);
}
/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */
const verb = positional[0];
const sub = positional[1];
switch (verb) {
    case "rules":
        switch (sub) {
            case undefined:
            case "show":
                await cmdShow();
                break;
            case "validate":
                await cmdValidate();
                break;
            case "set":
                await cmdSet();
                break;
            case "test":
                await cmdTest();
                break;
            case "history":
                cmdHistory();
                break;
            case "reset":
                await cmdReset();
                break;
            case "rollback":
                await cmdRollback();
                break;
            case "reextract":
                await cmdReextract();
                break;
            default:
                usageError(`Unknown 'memex extract rules' subcommand: ${sub}`);
        }
        break;
    case "eval":
        await cmdEval();
        break;
    default:
        usageError(`Unknown 'memex extract' subcommand: ${verb ?? "(none)"}`);
}
