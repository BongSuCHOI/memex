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
import {
  OverlayInvalidError,
  OverlayLockedError,
  OverlayStaleError,
  PROBE_WALL_MS,
  listOverlayHistory,
  listOverlaySnapshots,
  overlayPaths,
} from "./overlay-admin.js";
import {
  EXTRACTION_RULES_LIMITS,
  EXTRACTION_RULE_ENFORCEMENT_POINTS,
  buildBlockSet,
  composeEffectivePolicyVersion,
  currentExtractionRulesRevision,
  emptyLoadedExtractionRules,
  extractionRulesDocHash,
  isEmptyExtractionRules,
  loadExtractionRules,
  overlaysDisabled,
  readExtractionRulesFile,
  renderExtractionConstraintClause,
  resetExtractionRules,
  resolveExtractionRules,
  rollbackExtractionRules,
  setExtractionRules,
  validateExtractionRules,
  validateExtractionRulesDoc,
  type ExtractionRulesDoc,
  type ExtractionRulesWriteResult,
  type LoadedExtractionRules,
  type NeverExtractPattern,
  type ResolvedExtractionRules,
} from "./extraction-rules.js";
import {
  MATCH_WALL_MS,
  oneShotMatcher,
  readQuarantine,
  type MatcherHandle,
  type QuarantineEntry,
} from "./overlay-matcher.js";
import { extractionRulesOverlayPath, getDbPath } from "./paths.js";
import type { Issue } from "./overlay-regex.js";

const USAGE = `Usage:
  memex extract rules show [--json]
  memex extract rules validate [<file>] [--json]
  memex extract rules set <file> [--expect-revision <n>] [--dry-run] [--json]
  memex extract rules test [--exchange <id>] [--recent <n>] [--project <p>] [--limit <n>] [--json]
  memex extract rules history [--limit <n>] [--json]
  memex extract rules reset --yes [--json]
  memex extract rules rollback <revision> [--json]
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

const positional: string[] = [];
const values = new Map<string, string>();
const bools = new Set<string>();

const json = argv.includes("--json");

function usageError(message: string): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { code: "INVALID_USAGE", message } }, null, 2));
  } else {
    console.error(`${message}\n\n${USAGE}`);
  }
  process.exit(1);
}

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (VALUE_FLAGS.has(arg)) {
    const next = argv[i + 1];
    if (next === undefined) usageError(`${arg} needs a value`);
    values.set(arg, next);
    i++;
    continue;
  }
  if (BOOL_FLAGS.has(arg)) {
    bools.add(arg);
    continue;
  }
  if (arg.startsWith("--")) usageError(`unknown option ${arg}`);
  positional.push(arg);
}

function intValue(flag: string, fallback: number): number {
  const raw = values.get(flag);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) usageError(`${flag} must be a non-negative integer`);
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Output helpers                                                              */
/* -------------------------------------------------------------------------- */

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Terminal columns, counting CJK as two — the transcripts are column-aligned. */
function width(text: string): number {
  let total = 0;
  for (const ch of text) total += WIDE.test(ch) ? 2 : 1;
  return total;
}

function pad(text: string, target: number): string {
  return text + " ".repeat(Math.max(1, target - width(text)));
}

/** `label` column of the `show`/`test` transcripts. */
function row(label: string, text: string): string {
  return `${pad(label, 12)}${text}`;
}

const CONTINUE = " ".repeat(12);

function emit(payload: Record<string, unknown>, lines: string[]): void {
  if (json) console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
  else console.log(lines.join("\n"));
}

function fail(code: string, lines: string[], extra: Record<string, unknown> = {}): never {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { code, message: lines[0], ...extra } }, null, 2));
  } else {
    console.error(lines.join("\n"));
  }
  process.exit(1);
}

/** One issue per line: severity, stable code, document path, English message. */
function issueLines(issues: readonly Issue[]): string[] {
  return issues.map(
    (issue) =>
      `  ${pad(issue.severity, 9)}${pad(issue.code, 26)}${pad(issue.path ?? "-", 34)}${issue.message}`,
  );
}

const SLOW_PATTERN_NOTE = [
  "참고: 문법 검사만으로는 이런 패턴을 전부 걸러낼 수 없습니다. 저장되더라도 실행은",
  `      ${MATCH_WALL_MS}ms 상한 안에서만 일어나고, 상한을 넘으면 그 패턴은 격리되며 추출은 보류됩니다.`,
];

function hasRegexIssue(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.code.startsWith("REGEX_") || issue.code === "PATTERN_TOO_SLOW");
}

/** Map the admin layer's refusals onto §4's codes and exit 1. */
function failFromError(error: unknown): never {
  if (error instanceof OverlayInvalidError) {
    const errors = error.issues.filter((issue) => issue.severity === "error");
    fail(
      "OVERLAY_INVALID",
      [
        "거부 — 아무것도 저장하지 않았습니다.",
        ...issueLines(error.issues),
        ...(hasRegexIssue(errors) ? SLOW_PATTERN_NOTE : []),
      ],
      { issues: error.issues },
    );
  }
  if (error instanceof OverlayStaleError) {
    fail(
      "OVERLAY_STALE",
      [
        "거부 — 아무것도 저장하지 않았습니다.",
        `  OVERLAY_STALE  현재 revision ${error.currentRevision} (기대 ${error.expectedRevision}) — 다른 곳에서 먼저 바뀌었습니다.`,
      ],
      { currentRevision: error.currentRevision, expectedRevision: error.expectedRevision },
    );
  }
  if (error instanceof OverlayLockedError) {
    fail(
      "OVERLAY_LOCKED",
      [
        "거부 — 아무것도 저장하지 않았습니다.",
        error.holderPid === null
          ? "  OVERLAY_LOCKED  다른 프로세스가 규칙을 쓰고 있습니다 (lock을 읽을 수 없었습니다)."
          : `  OVERLAY_LOCKED  다른 프로세스(pid ${error.holderPid})가 규칙을 쓰고 있습니다.`,
      ],
      { holderPid: error.holderPid },
    );
  }
  fail("EXTRACT_CLI_ERROR", [
    "거부 — 아무것도 저장하지 않았습니다.",
    `  ${error instanceof Error ? error.message : String(error)}`,
  ]);
}

function shortTime(iso: string | undefined | null): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function preview(text: string, columns = 52): string {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  return width(oneLine) > columns ? `${oneLine.slice(0, columns - 1)}…` : oneLine;
}

function rulesQuarantine(): QuarantineEntry[] {
  return readQuarantine().filter((entry) => entry.overlay === "extraction-rules");
}

/* -------------------------------------------------------------------------- */
/* Policy identifiers and the database reads                                   */
/* -------------------------------------------------------------------------- */

interface PolicyVersions {
  /** The extraction prompt's own policy identity. */
  extraction: string;
  /** The entailment verifier's — untouched by this overlay, by design. */
  verifier: string;
  /** The SCHEDULING key. The rule hash is deliberately NOT part of it. */
  scheduling: string;
}

/**
 * Imported lazily so `--help` and a refused argument never pay for the extractor
 * and the database chain.
 */
async function policyVersions(): Promise<PolicyVersions> {
  const { EXTRACTION_POLICY_VERSION, FACT_ENTAILMENT_POLICY_VERSION } = await import("./fact-extractor.js");
  const { FACT_EXTRACTION_POLICY_VERSION } = await import("./continuity-store.js");
  return {
    extraction: EXTRACTION_POLICY_VERSION,
    verifier: FACT_ENTAILMENT_POLICY_VERSION,
    scheduling: FACT_EXTRACTION_POLICY_VERSION,
  };
}

interface HeldRow {
  reason: string;
  jobs: number;
  oldestHeldAt: string | null;
}

interface DriftRow {
  targets: number;
  sessions: number;
}

interface DbReport {
  dbPath: string;
  exists: boolean;
  heldJobs: HeldRow[];
  drift: DriftRow | null;
}

/**
 * Everything `show` needs from the database, read-only, in one open/close.
 *
 * A missing database is a normal state (a fresh install), not an error: the rules
 * are a file and answer for themselves.
 */
async function readDbReport(currentHash: string | null): Promise<DbReport> {
  const dbPath = getDbPath();
  const empty: DbReport = { dbPath, exists: false, heldJobs: [], drift: null };
  if (!fs.existsSync(dbPath)) return empty;
  const { openReadDb } = await import("./db.js");
  const { heldJobSummary } = await import("./model-budget.js");
  let db: ReturnType<typeof openReadDb>;
  try {
    db = openReadDb(dbPath);
  } catch {
    return empty;
  }
  try {
    const heldJobs = heldJobSummary(db)
      .filter((entry) => String(entry.reason).startsWith("extraction_rules_"))
      .map((entry) => ({ reason: String(entry.reason), jobs: entry.jobs, oldestHeldAt: entry.oldestHeldAt }));
    let drift: DriftRow | null = null;
    try {
      const stale = db
        .prepare(
          `SELECT COUNT(*) AS targets, COUNT(DISTINCT session_id) AS sessions
             FROM extraction_targets
            WHERE state = 'completed' AND IFNULL(rules_hash, '') IS NOT ?`,
        )
        .get(currentHash ?? "") as { targets: number; sessions: number } | undefined;
      drift = { targets: Number(stale?.targets ?? 0), sessions: Number(stale?.sessions ?? 0) };
    } catch {
      drift = null;
    }
    return { dbPath, exists: true, heldJobs, drift };
  } finally {
    db.close();
  }
}

function heldLines(report: DbReport): string[] {
  const heldJobs = report.heldJobs;
  // "No held job" and "we could not look" are different answers, and the one a
  // stopped pipeline needs is the second one.
  if (!report.exists) return [row("보류", `확인 못 함 — 데이터베이스가 없습니다 (${report.dbPath}).`)];
  if (heldJobs.length === 0) return [row("보류", "없음 — 규칙 때문에 멈춘 추출 작업이 없습니다.")];
  const total = heldJobs.reduce((sum, entry) => sum + entry.jobs, 0);
  return [
    row(
      "보류",
      `${total}건이 설정 대기 중입니다 (${heldJobs.map((entry) => `${entry.reason} ${entry.jobs}`).join(" · ")})`,
    ),
    `${CONTINUE}금지 검사를 끝내지 못해 아무것도 저장하지 않았습니다. 재시도 횟수는 쓰지 않았습니다.`,
    `${CONTINUE}규칙을 고치고 set/reset/rollback 중 하나를 실행하면 즉시 재개됩니다.`,
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
function resolveDoc(doc: ExtractionRulesDoc, projectId: string | null): ResolvedExtractionRules {
  const hash = extractionRulesDocHash(doc);
  const loaded: LoadedExtractionRules = {
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

interface CandidateFile {
  path: string;
  bytes: number;
  raw: unknown;
}

/** Read a candidate rules file, refusing unreadable bytes rather than guessing. */
function readCandidate(file: string): CandidateFile {
  if (!fs.existsSync(file)) {
    fail("FILE_NOT_FOUND", [
      "거부 — 아무것도 저장하지 않았습니다.",
      `  FILE_NOT_FOUND  ${file} 가 없습니다.`,
    ]);
  }
  const text = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  try {
    return { path: file, bytes, raw: JSON.parse(text) as unknown };
  } catch (error) {
    fail("OVERLAY_UNREADABLE", [
      "거부 — 아무것도 저장하지 않았습니다.",
      `  OVERLAY_UNREADABLE  ${file} 를 JSON으로 읽을 수 없습니다 — ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function expectRevision(): number | undefined {
  const raw = values.get("--expect-revision");
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    usageError("--expect-revision must be a non-negative integer");
  }
  return parsed;
}

/** The exact command to re-run, with the revision observed during the dry run. */
function rerunCommand(revision: number): string {
  const parts = ["memex", "extract"];
  for (const arg of argv) {
    if (arg === "--dry-run") continue;
    if (arg === "--expect-revision") continue;
    parts.push(/[\s'"\\]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg);
  }
  const index = argv.indexOf("--expect-revision");
  if (index >= 0) {
    const stale = argv[index + 1];
    const at = parts.lastIndexOf(stale);
    if (at >= 0) parts.splice(at, 1);
  }
  parts.push("--expect-revision", String(revision));
  return parts.join(" ");
}

/** The receipt every successful rules write prints (§3.7 transcript). */
function writeReceipt(
  action: string,
  headline: string[],
  before: { revision: number; hash: string | null },
  result: ExtractionRulesWriteResult,
  payload: Record<string, unknown> = {},
): void {
  emit(
    {
      action,
      revision: result.revision,
      hash: result.hash,
      fromRevision: before.revision,
      fromHash: before.hash,
      released: result.released,
      issues: result.issues,
      file: extractionRulesOverlayPath(),
      ...payload,
    },
    [
      ...headline,
      row(
        "파일",
        `${extractionRulesOverlayPath()}  (revision ${before.revision} → ${result.revision}, ${before.hash ?? "없음"} → ${result.hash ?? "없음"})`,
      ),
      row(
        "재개",
        `설정 대기(hold) 중이던 추출 작업 ${result.released}건을 즉시 대기로 돌렸습니다.`,
      ),
      ...(result.issues.length > 0 ? ["경고", ...issueLines(result.issues)] : []),
      row(
        "적용 시점",
        "진행 중인 작업은 중단하지 않습니다 — 그 작업의 프롬프트는 시작 시 규칙 그대로이고,",
      ),
      `${CONTINUE}새 금지 패턴은 그 작업의 저장 직전부터 적용됩니다. 이미 추출된 기억은 바뀌지 않습니다.`,
      row(
        "감사",
        `logs/ui-audit.jsonl action=${action} · overlays/history.jsonl overlay=extraction-rules revision=${result.revision}`,
      ),
    ],
  );
}

function beforeState(): { revision: number; hash: string | null } {
  return { revision: currentExtractionRulesRevision(), hash: loadExtractionRules().hash };
}

/** A write DB when there is one — `releaseExtractionRulesHold` needs it. */
async function openWriteDbIfPresent(): Promise<{ db: unknown; close: () => void }> {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return { db: undefined, close: () => {} };
  try {
    const { openWriteDb } = await import("./db.js");
    const db = openWriteDb(dbPath);
    return { db, close: () => db.close() };
  } catch {
    // A rules write must still succeed with no usable database: the one hour
    // safety-net backoff recovers the held jobs either way (§3.5.2).
    return { db: undefined, close: () => {} };
  }
}

/* -------------------------------------------------------------------------- */
/* rules show                                                                  */
/* -------------------------------------------------------------------------- */

function statusLine(loaded: LoadedExtractionRules): string {
  if (loaded.disabledByEnv) return "읽지 않음 — MEMEX_DISABLE_OVERLAYS=1 · 오버레이 없이 동작합니다";
  if (!loaded.present) return "없음 — 추출은 내장 정책만 따릅니다";
  const errors = loaded.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    return `무효 — 오류 ${errors.length}개 · 추출이 보류됩니다 (memex extract rules validate)`;
  }
  return `적용됨 · revision ${loaded.revision} · ${loaded.hash ?? "없음"} · ${shortTime(loaded.doc?.updated_at)}`;
}

function ruleSummaryLines(rules: ResolvedExtractionRules): string[] {
  if (isEmptyExtractionRules(rules)) return [row("규칙", "—")];
  const lines = [
    row(
      "규칙",
      `주제 제외 ${rules.excludeTopics.length}개 · 금지 패턴 ${rules.neverExtract.length}개 · ` +
        `결정 힌트 ${rules.decisionHints.length}개 · 선호 언어 ${rules.preferredLanguage ?? "지정 없음"}`,
    ),
  ];
  for (const topic of rules.excludeTopics) lines.push(`${CONTINUE}주제 제외  ${topic}`);
  for (const pattern of rules.neverExtract) {
    lines.push(
      `${CONTINUE}금지      ${pad(pattern.id, 20)}/${pattern.source}/${pattern.flags ?? ""}  scope=${pattern.scope ?? "both"}`,
    );
  }
  for (const hint of rules.decisionHints) {
    lines.push(`${CONTINUE}결정 힌트  ${pad(hint.id, 20)}/${hint.source}/${hint.flags ?? ""}`);
  }
  return lines;
}

async function cmdShow(): Promise<void> {
  const loaded = loadExtractionRules();
  const policy = await policyVersions();
  const effective = composeEffectivePolicyVersion(policy.extraction, loaded.hash);
  const report = await readDbReport(loaded.hash);
  const quarantined = rulesQuarantine();
  const errors = loaded.issues.filter((issue) => issue.severity === "error");
  const warnings = loaded.issues.filter((issue) => issue.severity === "warning");

  emit(
    {
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
    },
    [
      row(
        "파일",
        `${extractionRulesOverlayPath()}${loaded.present ? "" : "  (없음)"}`,
      ),
      row("상태", statusLine(loaded)),
      row("정책", `${pad(policy.extraction, 30)}(검증기 ${policy.verifier} — 오버레이가 바꾸지 않습니다)`),
      row(
        "실효 정책",
        `${pad(effective, 30)}(${loaded.hash ? "보고용 식별자입니다" : "오버레이 없음"})`,
      ),
      row(
        "스케줄 키",
        `${pad(policy.scheduling, 30)}(오버레이가 바꾸지 않습니다 — 규칙 변경이 전량 재추출을 일으키지 않습니다)`,
      ),
      row("강제 지점", `${EXTRACTION_RULE_ENFORCEMENT_POINTS.join(" · ")} — 저장 직전 차단 집합으로`),
      row(
        "적용 시점",
        "추출 작업을 시작(claim)할 때의 규칙이 프롬프트에 실리고,",
      ),
      `${CONTINUE}금지 패턴은 저장 직전에 그 시점의 파일을 다시 읽어 적용됩니다.`,
      `${CONTINUE}→ 제한 강화는 저장 시점에 즉시, 제한 완화는 다음 작업부터 반영됩니다.`,
      ...ruleSummaryLines(loaded.global),
      ...(quarantined.length > 0
        ? [
            row(
              "격리",
              `${quarantined.map((entry) => entry.pattern_id).join(" · ")} — ${MATCH_WALL_MS}ms 상한을 넘겨 적용되지 않습니다`,
            ),
            `${CONTINUE}해제: 정규식을 고치면 자동으로 풀립니다, 또는 memex gate quarantine clear <pattern-id>`,
          ]
        : []),
      row(
        "경고",
        warnings.length === 0 && errors.length === 0
          ? "없음"
          : `오류 ${errors.length}개 · 경고 ${warnings.length}개`,
      ),
      ...issueLines(loaded.issues),
      ...heldLines(report),
      row(
        "드리프트",
        report.drift === null
          ? report.exists
            ? "읽을 수 없었습니다 (extraction_targets 없음)"
            : `데이터베이스가 없습니다 (${report.dbPath})`
          : report.drift.targets === 0
            ? `완료된 모든 추출이 ${loaded.hash ?? "오버레이 없음"} 기준입니다`
            : `다른 규칙으로 추출된 세션 ${report.drift.sessions}개 (대상 ${report.drift.targets}개) — memex extract rules reextract --dry-run`,
      ),
      row("실행", "추출 자체는 여전히 memex backfill extract 로 돌립니다."),
      row("공유", "이 규칙은 아직 기기 간에 공유되지 않습니다 (0.7.1 예정)."),
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* rules validate                                                              */
/* -------------------------------------------------------------------------- */

async function cmdValidate(): Promise<void> {
  const file = positional[2] ?? values.get("--file");
  const liveFile = extractionRulesOverlayPath();
  const target = file ?? liveFile;
  if (!fs.existsSync(target)) {
    emit({ file: target, present: false, issues: [] }, [
      row("파일", target),
      row("결과", "없음 — 추출은 내장 정책만 따릅니다. 검증할 것이 없습니다."),
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
      if (issue.code === "PATTERN_QUARANTINED") issues.push(issue);
    }
  }
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const lines = [
    row("파일", `${target} (${candidate.bytes} bytes / 상한 ${EXTRACTION_RULES_LIMITS.fileBytes})`),
    row(
      "결과",
      errors.length === 0
        ? `유효 · 경고 ${warnings.length}개`
        : `오류 ${errors.length}개 · 경고 ${warnings.length}개`,
    ),
    ...issueLines(issues),
  ];
  if (errors.length > 0) {
    if (json) {
      console.log(JSON.stringify({ ok: false, file: target, issues }, null, 2));
    } else {
      console.error(lines.join("\n"));
      console.error(
        "오류가 하나라도 있으면 이 오버레이는 적용되지 않고, 추출은 보류(hold)됩니다 — 재시도 횟수는 쓰지 않습니다.",
      );
    }
    process.exit(1);
  }
  emit({ file: target, present: true, bytes: candidate.bytes, issues }, lines);
}

/* -------------------------------------------------------------------------- */
/* The model-free simulation (§3.8 stage 1), shared by `test` and `set --dry-run` */
/* -------------------------------------------------------------------------- */

interface BlockedRow {
  id: string;
  label: string;
  patternIds: string[];
  preview: string;
}

interface ScanResult {
  scanned: number;
  blocked: BlockedRow[];
}

interface SimulationReport {
  available: boolean;
  reason: string | null;
  facts: ScanResult;
  incidents: ScanResult;
  exchanges: ScanResult;
  matcher: { elapsedMs: number; failed: string | null; quarantined: string[] };
  advisoryOnly: { excludeTopics: string[]; decisionHints: string[]; preferredLanguage: string | null };
}

interface ScanRow {
  id: string;
  label: string;
  factText: string[];
  evidence: string[];
  preview: string;
}

const EMPTY_SCAN: ScanResult = { scanned: 0, blocked: [] };

/**
 * Run one row through the production block-set builder.
 *
 * `buildBlockSet` is the exact function the storage boundary uses — same matcher,
 * same scope split, same quarantine behaviour — so a preview that says "this
 * would have been blocked" is answering with the code that does the blocking.
 * One row per call is what gives the transcript a pattern id per row, and it
 * costs the same number of matcher round-trips as one batched call would.
 */
async function scanRows(
  matcher: MatcherHandle,
  patterns: readonly NeverExtractPattern[],
  rows: readonly ScanRow[],
  state: { elapsedMs: number; failed: string | null; quarantined: string[] },
): Promise<ScanResult> {
  const blocked: BlockedRow[] = [];
  let scanned = 0;
  for (const candidate of rows) {
    if (state.failed !== null) break;
    scanned += 1;
    const outcome = await buildBlockSet(
      matcher,
      patterns,
      [{ item: candidate, candidate: { factText: candidate.factText, evidence: candidate.evidence } }],
      "extract-cli",
    );
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

interface SimulationInput {
  rules: ResolvedExtractionRules;
  project: string | null;
  exchangeId: string | null;
  recent: number;
  memoryLimit: number;
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
async function simulate(input: SimulationInput): Promise<SimulationReport> {
  const advisoryOnly = {
    excludeTopics: input.rules.excludeTopics,
    decisionHints: input.rules.decisionHints.map((hint) => hint.id),
    preferredLanguage: input.rules.preferredLanguage,
  };
  const state = { elapsedMs: 0, failed: null as string | null, quarantined: [] as string[] };
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
      reason: `데이터베이스가 없습니다 (${dbPath}) — 저장된 기억과 대화를 읽을 수 없습니다.`,
      facts: EMPTY_SCAN,
      incidents: EMPTY_SCAN,
      exchanges: EMPTY_SCAN,
      matcher: state,
      advisoryOnly,
    };
  }
  const { openReadDb } = await import("./db.js");
  let db: ReturnType<typeof openReadDb>;
  try {
    db = openReadDb(dbPath);
  } catch (error) {
    return {
      available: false,
      reason: `데이터베이스를 열 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
      facts: EMPTY_SCAN,
      incidents: EMPTY_SCAN,
      exchanges: EMPTY_SCAN,
      matcher: state,
      advisoryOnly,
    };
  }

  const query = <T>(sql: string, params: unknown[]): T[] => {
    try {
      return db.prepare(sql).all(...params) as T[];
    } catch {
      return [];
    }
  };

  const factRows = query<{ id: string; fact: string; fact_kr: string | null; category: string | null }>(
    `SELECT id, fact, fact_kr, category FROM facts
      WHERE is_active = 1 ${input.project ? "AND scope_project = ?" : ""}
      ORDER BY updated_at DESC LIMIT ?`,
    input.project ? [input.project, input.memoryLimit] : [input.memoryLimit],
  ).map((fact) => ({
    id: fact.id.slice(0, 8),
    label: `[${fact.category ?? "unknown"}]`,
    factText: [fact.fact, fact.fact_kr ?? ""].filter((text) => text.length > 0),
    evidence: [],
    preview: preview(fact.fact),
  }));

  const incidentRows = query<{
    occurrence_id: string;
    signature_text: string;
    subject_key: string | null;
  }>(
    `SELECT occurrence_id, signature_text, subject_key FROM incident_occurrences
      ${input.project ? "WHERE project_id = ?" : ""}
      ORDER BY recorded_at DESC LIMIT ?`,
    input.project ? [input.project, input.memoryLimit] : [input.memoryLimit],
  ).map((incident) => ({
    id: incident.occurrence_id.slice(0, 8),
    label: "[incident]",
    factText: [incident.signature_text, incident.subject_key ?? ""].filter((text) => text.length > 0),
    evidence: [],
    preview: preview(incident.signature_text),
  }));

  const exchangeRows = (
    input.exchangeId
      ? query<{ id: string; user_message: string | null; assistant_message: string | null }>(
          "SELECT id, user_message, assistant_message FROM exchanges WHERE id = ?",
          [input.exchangeId],
        )
      : query<{ id: string; user_message: string | null; assistant_message: string | null }>(
          `SELECT id, user_message, assistant_message FROM exchanges
            ${input.project ? "WHERE project = ?" : ""}
            ORDER BY timestamp DESC LIMIT ?`,
          input.project ? [input.project, input.recent] : [input.recent],
        )
  ).map((exchange) => ({
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
    fail("EXCHANGE_UNKNOWN", [`교환 ${input.exchangeId}를 찾을 수 없습니다 (memex search).`]);
  }

  const matcher = oneShotMatcher();
  try {
    const facts = await scanRows(matcher, input.rules.neverExtract, factRows, state);
    const incidents = await scanRows(matcher, input.rules.neverExtract, incidentRows, state);
    const exchanges = await scanRows(matcher, input.rules.neverExtract, exchangeRows, state);
    return { available: true, reason: null, facts, incidents, exchanges, matcher: state, advisoryOnly };
  } finally {
    matcher.dispose();
    db.close();
  }
}

function simulationLines(report: SimulationReport, rules: ResolvedExtractionRules): string[] {
  const lines: string[] = ["영향 시뮬레이션 (모델 호출 0회, 저장된 기억과 대화만 읽습니다):"];
  if (rules.neverExtract.length === 0) {
    lines.push("  금지 패턴이 없어 결정적으로 검사할 항목이 없습니다.");
  } else if (!report.available) {
    lines.push(`  ${report.reason}`);
  } else {
    const section = (title: string, scan: ScanResult, noun: string) => {
      lines.push(
        `  ${title} ${scan.scanned}건 중 ${scan.blocked.length}건이 never_extract_patterns에 매치합니다${
          noun ? ` — ${noun}` : ""
        }`,
      );
      for (const blocked of scan.blocked) {
        lines.push(
          `    ${pad(blocked.id, 10)}${pad(blocked.patternIds.join(","), 22)}${pad(blocked.label, 14)}"${blocked.preview}"`,
        );
      }
    };
    section("활성 기억", report.facts, "이 규칙이 먼저 있었다면 만들어지지 않았을 기억입니다");
    section("사건 기록", report.incidents, "");
    section("최근 대화", report.exchanges, "이 형태가 대화에 나타납니다");
    lines.push(
      "  이미 저장된 기억·사건 기록은 이 명령이 바꾸지 않습니다. 지우려면: memex facts deactivate --id <uuid>",
    );
    if (report.matcher.failed !== null) {
      lines.push(
        `  matcher 중단 — ${report.matcher.failed}` +
          (report.matcher.quarantined.length > 0
            ? ` (격리: ${report.matcher.quarantined.join(" · ")})`
            : ""),
      );
      lines.push("  운영에서는 이 상황에서 아무것도 저장하지 않고 추출을 보류(hold)합니다.");
    } else {
      lines.push(`  matcher 실행 ${report.matcher.elapsedMs.toFixed(1)}ms / 상한 ${MATCH_WALL_MS}ms 당 요청`);
    }
  }
  lines.push(
    "  exclude_topics / always_treat_as_decision / preferred_language 는 로컬로 검증할 수 없습니다 —",
  );
  lines.push("  프롬프트에만 전달되며 결과는 모델 평가로만 확인됩니다 (memex extract eval).");
  if (report.advisoryOnly.excludeTopics.length > 0) {
    lines.push(`    주제 제외 (model-only)  ${report.advisoryOnly.excludeTopics.join("; ")}`);
  }
  if (report.advisoryOnly.decisionHints.length > 0) {
    lines.push(`    결정 힌트 (model-only)  ${report.advisoryOnly.decisionHints.join(" · ")}`);
  }
  if (report.advisoryOnly.preferredLanguage !== null) {
    lines.push(`    선호 언어 (model-only)  ${report.advisoryOnly.preferredLanguage}`);
  }
  return lines;
}

/* -------------------------------------------------------------------------- */
/* rules test                                                                  */
/* -------------------------------------------------------------------------- */

async function cmdTest(): Promise<void> {
  const file = values.get("--file");
  const project = values.get("--project") ?? null;
  let rules: ResolvedExtractionRules;
  let source: string;
  if (file !== undefined) {
    const candidate = readCandidate(file);
    const validation = validateExtractionRulesDoc(candidate.raw, { bytes: candidate.bytes });
    if (!validation.ok || !validation.doc) {
      fail(
        "OVERLAY_INVALID",
        ["거부 — 후보 파일이 유효하지 않습니다.", ...issueLines(validation.issues)],
        { issues: validation.issues },
      );
    }
    rules = resolveDoc(validation.doc, project);
    source = file;
  } else {
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

  emit(
    {
      source,
      project,
      rulesHash: rules.hash,
      revision: rules.revision,
      clause: { chars: clause.length, text: clause },
      enforcementPoints: [...EXTRACTION_RULE_ENFORCEMENT_POINTS],
      neverExtract: rules.neverExtract,
      ...report,
    },
    [
      row("규칙", `${source}  (${rules.hash ?? "없음"}${project ? ` · project=${project}` : ""})`),
      row("모델", "0회 — 이 명령은 모델도 임베딩도 호출하지 않습니다"),
      row("강제 지점", `${EXTRACTION_RULE_ENFORCEMENT_POINTS.join(" · ")} — 저장 직전 차단 집합으로`),
      "",
      ...simulationLines(report, rules),
      "",
      "이 명령은 아무것도 기록하지 않습니다: 오버레이·데이터베이스·감사 로그 모두 변경 없음.",
      `(단, 금지 패턴이 ${MATCH_WALL_MS}ms 상한을 넘기면 실제 운영과 동일하게 격리됩니다 — 그 사실만 기록합니다.)`,
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* rules set                                                                   */
/* -------------------------------------------------------------------------- */

async function cmdSet(): Promise<void> {
  const file = positional[2] ?? values.get("--file");
  if (!file) usageError("set needs a file: memex extract rules set <file>");
  const candidate = readCandidate(file);
  const validation = await validateExtractionRules(candidate.raw, {
    probe: true,
    forWrite: true,
    bytes: candidate.bytes,
  });
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  if (!validation.ok || !validation.doc) {
    fail(
      "OVERLAY_INVALID",
      [
        "거부 — 아무것도 저장하지 않았습니다.",
        ...issueLines(validation.issues),
        ...(hasRegexIssue(errors) ? SLOW_PATTERN_NOTE : []),
      ],
      { issues: validation.issues },
    );
  }
  const policy = await policyVersions();
  const revision = currentExtractionRulesRevision();
  const present = readExtractionRulesFile().present;
  const resolved = resolveDoc(validation.doc, null);
  const clause = renderExtractionConstraintClause(resolved);
  const itemCount =
    resolved.excludeTopics.length +
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
    emit(
      {
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
      },
      [
        "시험 실행 — 아무것도 저장하지 않았습니다.",
        row(
          "검증",
          `문법 ok · 프로브 ok (상한 ${PROBE_WALL_MS}ms) · 항목 ${itemCount} · 경고 ${validation.issues.length}`,
        ),
        ...issueLines(validation.issues),
        row("해시", `${resolved.hash}   (현재: ${loadExtractionRules().hash ?? "없음"}, revision ${revision})`),
        "",
        ...(clause === ""
          ? ["제약 절 미리보기 — 비어 있습니다 (규칙이 없으면 프롬프트는 바이트 동일합니다)."]
          : [
              `제약 절 미리보기 — 추출 시스템 프롬프트 뒤에 붙습니다 (${clause.length}자):`,
              ...clause.split("\n").map((line) => `  ${line}`),
            ]),
        "",
        row("검증기 프롬프트", `변경 없음 (${policy.verifier}, 바이트 동일)`),
        row("강제 지점", `${EXTRACTION_RULE_ENFORCEMENT_POINTS.join(" · ")} — 저장 직전 차단 집합으로`),
        `${CONTINUE}(금지된 후보는 "탈락"이며 작업 실패가 아닙니다: 재시도 횟수를 쓰지 않습니다)`,
        "",
        ...simulationLines(report, resolved),
        "",
        row("적용", rerunCommand(revision)),
        row("권장", `적용 전 모델 평가: memex extract eval --rules ${file} --out ./rules-eval.json`),
      ],
    );
    return;
  }

  // §1.5 lost-update contract: the full-document path must name the revision it
  // believes it is replacing once a file exists, or a concurrent edit is lost
  // silently. `--dry-run` above printed the exact command with it filled in.
  if (present && expectRevision() === undefined) {
    fail("EXPECTED_REVISION_REQUIRED", [
      "거부 — 아무것도 저장하지 않았습니다.",
      `  EXPECTED_REVISION_REQUIRED  이미 규칙 파일이 있습니다 (revision ${revision}). 전체 문서를 덮어쓰려면 --expect-revision ${revision} 를 함께 주세요.`,
      `  (먼저 확인하려면: memex extract rules set ${file} --dry-run)`,
    ]);
  }

  const snapshot = beforeState();
  const handle = await openWriteDbIfPresent();
  let result: ExtractionRulesWriteResult;
  try {
    result = await setExtractionRules(validation.doc, {
      surface: "cli",
      expectedRevision: expectRevision(),
      db: handle.db,
    });
  } catch (error) {
    handle.close();
    failFromError(error);
  }
  handle.close();
  writeReceipt(
    "rules.set",
    [
      row("적용", `revision ${snapshot.revision} → ${result.revision} · ${snapshot.hash ?? "없음"} → ${result.hash ?? "없음"}`),
      row("검증", `문법 ok · 프로브 ok (상한 ${PROBE_WALL_MS}ms) · 항목 ${itemCount}`),
    ],
    snapshot,
    result,
    { source: file, clause: { chars: clause.length } },
  );
}

/* -------------------------------------------------------------------------- */
/* rules reset / rollback / history                                            */
/* -------------------------------------------------------------------------- */

async function cmdReset(): Promise<void> {
  if (!bools.has("--yes")) {
    fail("CONFIRMATION_REQUIRED", [
      "거부 — 아무것도 저장하지 않았습니다.",
      "  CONFIRMATION_REQUIRED  규칙 오버레이 전체를 비웁니다. 확인하려면 --yes 를 함께 주세요.",
      "  (되돌릴 수 있습니다: memex extract rules rollback <revision>)",
    ]);
  }
  const snapshot = beforeState();
  const handle = await openWriteDbIfPresent();
  let result: ExtractionRulesWriteResult;
  try {
    result = await resetExtractionRules({
      surface: "cli",
      expectedRevision: expectRevision(),
      db: handle.db,
    });
  } catch (error) {
    handle.close();
    failFromError(error);
  }
  handle.close();
  writeReceipt(
    "rules.reset",
    [row("초기화", "규칙을 비웠습니다 — 추출은 내장 정책만 따릅니다. 이미 추출된 기억은 바뀌지 않습니다.")],
    snapshot,
    result,
  );
}

async function cmdRollback(): Promise<void> {
  const raw = positional[2] ?? values.get("--to");
  if (raw === undefined) usageError("rollback needs <revision>");
  const revision = Number(raw);
  if (!Number.isInteger(revision) || revision < 0) {
    usageError("rollback needs a non-negative integer revision");
  }
  const snapshot = beforeState();
  const handle = await openWriteDbIfPresent();
  let result: ExtractionRulesWriteResult;
  try {
    result = await rollbackExtractionRules(revision, {
      surface: "cli",
      expectedRevision: expectRevision(),
      db: handle.db,
    });
  } catch (error) {
    handle.close();
    failFromError(error);
  }
  handle.close();
  writeReceipt(
    "rules.rollback",
    [row("되돌림", `revision ${revision}의 스냅숏을 revision ${result.revision}으로 다시 적용했습니다.`)],
    snapshot,
    result,
    { fromSnapshot: revision },
  );
}

function cmdHistory(): void {
  const limit = intValue("--limit", 20);
  const entries = listOverlayHistory("extraction-rules", limit);
  const snapshots = listOverlaySnapshots("extraction-rules");
  emit(
    { count: entries.length, snapshots, history: entries },
    entries.length === 0
      ? ["변경 이력이 없습니다."]
      : [
          row("이력", `${entries.length}개 · 되돌릴 수 있는 revision: ${snapshots.join(", ") || "없음"}`),
          ...entries.map(
            (entry) =>
              `  ${pad(shortTime(entry.ts), 18)}${pad(`rev ${entry.from_revision} → ${entry.to_revision}`, 18)}${pad(entry.action, 18)}${pad(entry.surface, 9)}${Object.entries(
                entry.counts ?? {},
              )
                .map(([key, value]) => `${key}=${value}`)
                .join(" · ")}`,
          ),
        ],
  );
}

/* -------------------------------------------------------------------------- */
/* rules reextract                                                             */
/* -------------------------------------------------------------------------- */

interface StaleTarget {
  targetId: string;
  jobId: string | null;
  checkpointId: string | null;
  sessionId: string;
  project: string;
  rulesHash: string | null;
  itemCount: number;
  updatedAt: string;
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
async function cmdReextract(): Promise<void> {
  const apply = bools.has("--apply");
  const dry = bools.has("--dry-run");
  if (apply && dry) usageError("reextract takes either --dry-run or --apply, not both");
  if (!apply && !dry) {
    fail("CONFIRMATION_REQUIRED", [
      "거부 — 아무것도 바꾸지 않았습니다.",
      "  CONFIRMATION_REQUIRED  reextract 는 --dry-run 또는 --apply 중 하나를 명시해야 합니다.",
      "  (먼저 확인하려면: memex extract rules reextract --dry-run)",
    ]);
  }
  if (apply && !bools.has("--yes")) {
    fail("CONFIRMATION_REQUIRED", [
      "거부 — 아무것도 바꾸지 않았습니다.",
      "  CONFIRMATION_REQUIRED  --apply 는 모델 호출을 새로 발생시킵니다. 확인하려면 --yes 를 함께 주세요.",
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
    fail("DB_UNAVAILABLE", [`데이터베이스가 없습니다 (${dbPath}) — 재추출할 대상을 읽을 수 없습니다.`]);
  }
  const { openReadDb, openWriteDb } = await import("./db.js");
  const db = apply ? openWriteDb(dbPath) : openReadDb(dbPath);
  try {
    const where = ["t.state = 'completed'", "IFNULL(t.rules_hash, '') IS NOT ?"];
    const params: unknown[] = [hash ?? ""];
    if (project !== null) {
      where.push("t.project = ?");
      params.push(project);
    }
    if (session !== null) {
      where.push("t.session_id = ?");
      params.push(session);
    }
    let rows: StaleTarget[];
    try {
      rows = (
        db
          .prepare(
            `SELECT t.target_id, t.session_id, t.project, t.rules_hash, t.item_count, t.updated_at,
                    j.job_id, j.checkpoint_id
               FROM extraction_targets t
               LEFT JOIN memory_jobs j ON j.target_id = t.target_id
              WHERE ${where.join(" AND ")}
              ORDER BY t.updated_at DESC`,
          )
          .all(...params) as Array<Record<string, unknown>>
      ).map((candidate) => ({
        targetId: String(candidate.target_id),
        jobId: candidate.job_id == null ? null : String(candidate.job_id),
        checkpointId: candidate.checkpoint_id == null ? null : String(candidate.checkpoint_id),
        sessionId: String(candidate.session_id),
        project: String(candidate.project),
        rulesHash: candidate.rules_hash == null ? null : String(candidate.rules_hash),
        itemCount: Number(candidate.item_count ?? 0),
        updatedAt: String(candidate.updated_at ?? ""),
      }));
    } catch (error) {
      fail("DB_UNAVAILABLE", [
        `추출 대상을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    const sessions = new Set(rows.map((candidate) => candidate.sessionId));
    const items = rows.reduce((sum, candidate) => sum + candidate.itemCount, 0);
    const sample = rows.slice(0, sampleLimit);
    const sampleLines = sample.map(
      (candidate) =>
        `  ${pad(candidate.targetId.slice(0, 12), 14)}${pad(candidate.rulesHash ?? "없음", 20)}${pad(
          `${candidate.itemCount}턴`,
          8,
        )}${pad(shortTime(candidate.updatedAt), 18)}${candidate.sessionId}`,
    );
    const scopeText = `${project === null ? "전체 프로젝트" : `project=${project}`}${session === null ? "" : ` · session=${session}`}`;

    if (dry) {
      emit(
        {
          dryRun: true,
          currentHash: hash,
          scope: { project, session },
          targets: rows.length,
          sessions: sessions.size,
          items,
          sample,
        },
        [
          "시험 실행 — 아무것도 바꾸지 않았습니다.",
          row("현재 해시", hash ?? "없음 (오버레이 없음)"),
          row("범위", scopeText),
          row(
            "대상",
            `다른 규칙으로 추출된 완료 대상 ${rows.length}개 · 세션 ${sessions.size}개 · 교환 ${items}개`,
          ),
          ...sampleLines,
          ...(rows.length > sample.length ? [`  … 외 ${rows.length - sample.length}개 (--limit 로 더 보기)`] : []),
          "",
          row("예상 비용", `재추출은 교환 ${items}개만큼의 모델 호출을 새로 발생시킵니다.`),
          `${CONTINUE}예산은 memex model-work 로 확인하세요. 이미 저장된 기억은 이 명령이 지우지 않습니다.`,
          row("스케줄 키", "policy_version 은 건드리지 않습니다 — 선택한 범위만 다시 대기로 돌립니다."),
          row("적용", `memex extract rules reextract --apply --yes${project === null ? "" : ` --project ${project}`}${session === null ? "" : ` --session ${session}`}`),
        ],
      );
      return;
    }

    const now = new Date().toISOString();
    const changed: Record<string, number> = {};
    const requeued: string[] = [];
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
        if (Object.keys(counts).length === 0) continue;
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

    emit(
      {
        dryRun: false,
        currentHash: hash,
        scope: { project, session },
        targets: rows.length,
        requeued: requeued.length,
        sessions: sessions.size,
        items,
        changed,
      },
      [
        row("재대기", `완료 대상 ${requeued.length}개 / 후보 ${rows.length}개 · 세션 ${sessions.size}개 · 교환 ${items}개`),
        ...(requeued.length < rows.length
          ? [`${CONTINUE}${rows.length - requeued.length}개는 그사이 상태가 바뀌어 건드리지 않았습니다.`]
          : []),
        row(
          "되돌린 행",
          Object.entries(changed)
            .map(([table, count]) => `${table} ${count}`)
            .join(" · ") || "없음",
        ),
        row("스케줄 키", "policy_version 은 건드리지 않았습니다 — 전량 재추출은 일어나지 않습니다."),
        row("실행", "재추출은 자동으로 시작되지 않습니다: memex backfill extract"),
        row("감사", "logs/ui-audit.jsonl action=rules.reextract"),
      ],
    );
  } finally {
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
async function cmdEval(): Promise<void> {
  const script = new URL("../scripts/fact-extraction-eval.mjs", import.meta.url);
  if (!fs.existsSync(script)) {
    fail("EVAL_UNAVAILABLE", [
      `평가 하네스를 찾을 수 없습니다 (${script.pathname}).`,
      "소스 체크아웃에서 실행하거나 npm run build 후 다시 시도하세요.",
    ]);
  }
  const forwarded = argv.slice(1);
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [script.pathname, ...forwarded], { stdio: "inherit" });
  const code = await new Promise<number>((resolve) => {
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
