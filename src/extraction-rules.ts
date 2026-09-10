/**
 * Read side of the extraction-rules overlay (issue #30, §3).
 *
 * A LEAF module: `fs`, `./paths.js`, `./overlay-regex.js`, `./overlay-matcher.js`.
 * No database, no audit writer, no lock, no `overlay-admin` at module scope —
 * `overlay-admin` pulls `ontology-admin` and through it `ontology-db`, and this
 * module is loaded by the extractor and by the Web UI's DB-free overlay read
 * path. The write wrappers at the bottom reach `overlay-admin` through a dynamic
 * import for exactly that reason (§1.4 "fast path 오염 금지").
 *
 * FAIL-CLOSED, deliberately the opposite of the recall-gate overlay (G1):
 *
 *   - the overlay will not load            → the extractor HOLDS before it claims
 *     (`extraction_rules_invalid`, no attempt consumed);
 *   - a `never_extract` pattern is quarantined → extraction HOLDS entirely. There
 *     is NO path that drops the slow pattern and stores the rest, because a
 *     forbidden string being saved "because the rule was slow" is the failure
 *     this feature exists to prevent;
 *   - the forbid check could not finish    → the claim is RETURNED unsaved
 *     (`extraction_rules_unavailable`), so the same input is checked again.
 *
 * STRUCTURED RULES ONLY. There is no raw-prompt field and there never will be
 * one here: everything an operator can write is a bounded list that renders into
 * the constraint clause (§3.2), and the clause can only SUPPRESS. The evidence
 * bar, the fail-closed entailment verifier and the precision gates above it are
 * untouched — `composeExtractionSystemPrompt` appends, it never edits.
 *
 * Nothing here executes a user regex. Validation runs the structural parser from
 * `overlay-regex.ts` (pure, linear, terminating); every actual match goes through
 * the time-boxed matcher worker in `overlay-matcher.ts`.
 */

import fs from "node:fs";
import {
  extractionRulesOverlayPath,
  overlayQuarantinePath,
  recallGateOverlayPath,
} from "./paths.js";
import {
  canonicalJson,
  checkOverlayRegex,
  overlayIssue,
  patternSourceSha8,
  sha8,
  userPatternId,
  OVERLAY_REGEX_LIMITS,
  type Issue,
} from "./overlay-regex.js";
import {
  quarantineMemoryGeneration,
  readQuarantine,
  MATCH_WALL_MS,
  type MatcherHandle,
  type QuarantineEntry,
  type UserPatternSpec,
} from "./overlay-matcher.js";

export const EXTRACTION_RULES_OVERLAY_SCHEMA = "memex.extraction-rules-overlay";
export const EXTRACTION_RULES_OVERLAY_VERSION = 1;

/** §1.3 / §3.1 — the complete limit table, also served to the Web UI. */
export const EXTRACTION_RULES_LIMITS = Object.freeze({
  fileBytes: 32_768,
  patternSource: OVERLAY_REGEX_LIMITS.sourceChars,
  quantifiers: OVERLAY_REGEX_LIMITS.quantifiers,
  noteChars: 200,
  counts: Object.freeze({
    excludeTopics: 24,
    excludeTopicChars: Object.freeze({ min: 2, max: 80 }),
    neverExtractPatterns: 32,
    decisionPatterns: 16,
    projectOverrides: 32,
  }),
});

/** The four enforcement points the storage boundary covers (§3.3). */
export const EXTRACTION_RULE_ENFORCEMENT_POINTS = Object.freeze([
  "fact_insert",
  "incident",
  "remediation",
  "chronicle",
] as const);

/** Where a `never_extract` pattern is matched. `both` is the default. */
export type NeverExtractScope = "fact_text" | "evidence" | "both";

export interface NeverExtractPattern {
  id: string;
  source: string;
  flags: string;
  scope: NeverExtractScope;
  note?: string;
}

export interface DecisionHintPattern {
  id: string;
  source: string;
  flags: string;
  note?: string;
}

export type PreferredLanguage = "ko" | "en" | null;

/** The four rule items an operator may set, globally or per project. */
export interface ExtractionRuleSet {
  preferred_language?: PreferredLanguage;
  exclude_topics?: string[];
  never_extract_patterns?: NeverExtractPattern[];
  always_treat_as_decision_patterns?: DecisionHintPattern[];
}

export interface ExtractionRulesDoc extends ExtractionRuleSet {
  schema: string;
  version: number;
  revision: number;
  updated_at?: string;
  updated_by?: { surface?: string };
  project_overrides?: Record<string, ExtractionRuleSet>;
}

/** One project's effective rules — what the prompt clause and the block set use. */
export interface ResolvedExtractionRules {
  /** null for the global rule set. */
  projectId: string | null;
  hash: string | null;
  revision: number;
  preferredLanguage: PreferredLanguage;
  excludeTopics: string[];
  neverExtract: NeverExtractPattern[];
  decisionHints: DecisionHintPattern[];
}

export interface LoadedExtractionRules {
  /** The file exists (even if it failed to load). */
  present: boolean;
  /** `rules:<sha8>` of the applied rules, or null when nothing is applied. */
  hash: string | null;
  revision: number;
  /** The document as applied. Null on any error-severity issue. */
  doc: ExtractionRulesDoc | null;
  /** Global rules, already resolved (the default when no project is known). */
  global: ResolvedExtractionRules;
  issues: Issue[];
  /** Quarantine rows that belong to this overlay. */
  quarantined: QuarantineEntry[];
  /** True when `MEMEX_DISABLE_OVERLAYS=1` — "no overlay", NOT a hold (§1.8). */
  disabledByEnv: boolean;
}

const EMPTY_RESOLVED: ResolvedExtractionRules = Object.freeze({
  projectId: null,
  hash: null,
  revision: 0,
  preferredLanguage: null,
  excludeTopics: Object.freeze([]) as unknown as string[],
  neverExtract: Object.freeze([]) as unknown as NeverExtractPattern[],
  decisionHints: Object.freeze([]) as unknown as DecisionHintPattern[],
});

const EMPTY_RULES: LoadedExtractionRules = Object.freeze({
  present: false,
  hash: null,
  revision: 0,
  doc: null,
  global: EMPTY_RESOLVED,
  issues: Object.freeze([]) as unknown as Issue[],
  quarantined: Object.freeze([]) as unknown as QuarantineEntry[],
  disabledByEnv: false,
});

export function emptyLoadedExtractionRules(): LoadedExtractionRules {
  return EMPTY_RULES;
}

/**
 * The "nothing applied" document.
 *
 * `resetOverlay('extraction-rules')` needs this from us (lane A refuses to guess
 * another lane's schema), and a reset writes an EMPTY document at the next
 * revision rather than deleting the file, so the change keeps a revision, a
 * snapshot and a rollback target like every other change.
 */
export function emptyExtractionRulesDoc(): ExtractionRulesDoc {
  return {
    schema: EXTRACTION_RULES_OVERLAY_SCHEMA,
    version: EXTRACTION_RULES_OVERLAY_VERSION,
    revision: 0,
    preferred_language: null,
    exclude_topics: [],
    never_extract_patterns: [],
    always_treat_as_decision_patterns: [],
    project_overrides: {},
  };
}

/* -------------------------------------------------------------------------- */
/* Hash                                                                        */
/* -------------------------------------------------------------------------- */

function ruleSetForHash(rules: ExtractionRuleSet): Record<string, unknown> {
  return {
    preferred_language: rules.preferred_language ?? null,
    exclude_topics: [...(rules.exclude_topics ?? [])],
    never_extract_patterns: (rules.never_extract_patterns ?? []).map((pattern) => ({
      id: pattern.id,
      source: pattern.source,
      flags: pattern.flags ?? "",
      scope: pattern.scope ?? "both",
    })),
    always_treat_as_decision_patterns: (rules.always_treat_as_decision_patterns ?? []).map((pattern) => ({
      id: pattern.id,
      source: pattern.source,
      flags: pattern.flags ?? "",
    })),
  };
}

/**
 * `rules:<sha8>` over the RULES only.
 *
 * `revision`, `updated_at` and `updated_by` are excluded on purpose: re-saving
 * the same rules must not move the hash, or `extraction-rules-drift` warns about
 * a no-op and every target looks like it was extracted under a new rule set.
 */
export function extractionRulesDocHash(doc: ExtractionRulesDoc): string {
  const overrides = doc.project_overrides ?? {};
  const rules = {
    ...ruleSetForHash(doc),
    project_overrides: Object.fromEntries(
      Object.keys(overrides).sort().map((key) => [key, ruleSetForHash(overrides[key])]),
    ),
  };
  return `rules:${sha8(canonicalJson(rules))}`;
}

/** The applied hash, or null when nothing is applied. Cache-aware. */
export function extractionRulesHash(): string | null {
  return loadExtractionRules().hash;
}

/**
 * `precision-durability-v4` / `precision-durability-v4+rules:9c1e4d07`.
 *
 * This is a REPORTING identifier only. It is NOT the scheduling key — see
 * `test/extraction-policy-keying.test.ts`: mixing the rule hash into
 * `FACT_EXTRACTION_POLICY_VERSION` would turn one edited character into a
 * full-corpus re-extraction, because that constant is part of the
 * `exchange_extraction_state` primary key that decides what counts as processed.
 */
export function composeEffectivePolicyVersion(
  basePolicyVersion: string,
  rulesHash?: string | null,
): string {
  return rulesHash ? `${basePolicyVersion}+${rulesHash}` : basePolicyVersion;
}

/* -------------------------------------------------------------------------- */
/* Validation (§2.3.5 applied to §3.1)                                         */
/* -------------------------------------------------------------------------- */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SCOPES: readonly NeverExtractScope[] = ["fact_text", "evidence", "both"];
const LANGUAGES: readonly Exclude<PreferredLanguage, null>[] = ["ko", "en"];
const KNOWN_TOP_LEVEL = new Set([
  "schema",
  "version",
  "revision",
  "updated_at",
  "updated_by",
  "preferred_language",
  "exclude_topics",
  "never_extract_patterns",
  "always_treat_as_decision_patterns",
  "project_overrides",
]);
const KNOWN_RULE_KEYS = new Set([
  "preferred_language",
  "exclude_topics",
  "never_extract_patterns",
  "always_treat_as_decision_patterns",
]);

export interface ExtractionRulesValidation {
  ok: boolean;
  issues: Issue[];
  /** The document with defaults filled in, when `ok`. */
  doc: ExtractionRulesDoc | null;
}

type Emit = (
  severity: Issue["severity"],
  code: string,
  message: string,
  extra?: Parameters<typeof overlayIssue>[3],
) => void;

function validateRuleSet(
  raw: Record<string, unknown>,
  at: string,
  emit: Emit,
  seenIds: Set<string>,
): ExtractionRuleSet {
  const out: ExtractionRuleSet = {};
  const prefix = at === "" ? "" : `${at}.`;

  for (const key of Object.keys(raw)) {
    if (at !== "" && !KNOWN_RULE_KEYS.has(key)) {
      // `custom_fact_kinds` is deliberately out of scope (a binding decision):
      // `facts.category`, the ontology labels, the UI badge and the candidate
      // validator would all have to move together. Ignored, never refused.
      emit("warning", "OVERLAY_UNKNOWN_FIELD", `unknown field "${key}" is ignored by this build`, {
        path: `${prefix}${key}`,
        params: { field: key },
      });
    }
  }

  const language = raw.preferred_language;
  if (language !== undefined && language !== null) {
    if (typeof language !== "string" || !LANGUAGES.includes(language as "ko" | "en")) {
      emit("error", "LANGUAGE_UNKNOWN", `preferred_language must be "ko", "en" or null`, {
        path: `${prefix}preferred_language`,
        params: { language },
      });
    } else {
      out.preferred_language = language as PreferredLanguage;
    }
  } else {
    out.preferred_language = null;
  }

  const topicsRaw = raw.exclude_topics;
  const topics: string[] = [];
  if (topicsRaw !== undefined) {
    if (!Array.isArray(topicsRaw)) {
      emit("error", "OVERLAY_NOT_OBJECT", "`exclude_topics` must be an array of strings", {
        path: `${prefix}exclude_topics`,
      });
    } else {
      const { excludeTopics, excludeTopicChars } = EXTRACTION_RULES_LIMITS.counts;
      if (topicsRaw.length > excludeTopics) {
        emit("error", "TOPIC_COUNT_EXCEEDED", `${topicsRaw.length} topics (limit ${excludeTopics})`, {
          path: `${prefix}exclude_topics`,
          params: { count: topicsRaw.length, limit: excludeTopics },
        });
      }
      topicsRaw.forEach((topic, index) => {
        const where = `${prefix}exclude_topics[${index}]`;
        if (
          typeof topic !== "string" ||
          topic.trim().length < excludeTopicChars.min ||
          topic.length > excludeTopicChars.max ||
          CONTROL_CHARS.test(topic)
        ) {
          emit(
            "error",
            "TOPIC_INVALID",
            `a topic must be ${excludeTopicChars.min}-${excludeTopicChars.max} characters on a single line`,
            { path: where, row: index, params: { limit: excludeTopicChars } },
          );
          return;
        }
        topics.push(topic.trim());
      });
    }
  }
  out.exclude_topics = topics;

  const patterns: NeverExtractPattern[] = [];
  const patternsRaw = raw.never_extract_patterns;
  if (patternsRaw !== undefined) {
    if (!Array.isArray(patternsRaw)) {
      emit("error", "OVERLAY_NOT_OBJECT", "`never_extract_patterns` must be an array", {
        path: `${prefix}never_extract_patterns`,
      });
    } else {
      const limit = EXTRACTION_RULES_LIMITS.counts.neverExtractPatterns;
      if (patternsRaw.length > limit) {
        emit("error", "PATTERN_COUNT_EXCEEDED", `${patternsRaw.length} patterns (limit ${limit})`, {
          path: `${prefix}never_extract_patterns`,
          params: { count: patternsRaw.length, limit },
        });
      }
      patternsRaw.forEach((entry, index) => {
        const where = `${prefix}never_extract_patterns[${index}]`;
        const parsed = parsePattern(entry, where, index, emit, seenIds, "never_extract");
        if (!parsed) return;
        const scopeRaw = (entry as Record<string, unknown>).scope;
        let scope: NeverExtractScope = "both";
        if (scopeRaw !== undefined) {
          if (typeof scopeRaw !== "string" || !SCOPES.includes(scopeRaw as NeverExtractScope)) {
            emit("error", "SCOPE_UNKNOWN", `scope must be one of ${SCOPES.join(", ")}`, {
              path: `${where}.scope`,
              row: index,
              field: "scope",
              params: { scope: scopeRaw },
            });
            return;
          }
          scope = scopeRaw as NeverExtractScope;
        }
        patterns.push({ ...parsed, scope });
      });
    }
  }
  out.never_extract_patterns = patterns;

  const hints: DecisionHintPattern[] = [];
  const hintsRaw = raw.always_treat_as_decision_patterns;
  if (hintsRaw !== undefined) {
    if (!Array.isArray(hintsRaw)) {
      emit("error", "OVERLAY_NOT_OBJECT", "`always_treat_as_decision_patterns` must be an array", {
        path: `${prefix}always_treat_as_decision_patterns`,
      });
    } else {
      const limit = EXTRACTION_RULES_LIMITS.counts.decisionPatterns;
      if (hintsRaw.length > limit) {
        emit("error", "PATTERN_COUNT_EXCEEDED", `${hintsRaw.length} patterns (limit ${limit})`, {
          path: `${prefix}always_treat_as_decision_patterns`,
          params: { count: hintsRaw.length, limit },
        });
      }
      hintsRaw.forEach((entry, index) => {
        const where = `${prefix}always_treat_as_decision_patterns[${index}]`;
        const parsed = parsePattern(entry, where, index, emit, seenIds, "decision_hint");
        if (parsed) hints.push(parsed);
      });
    }
  }
  out.always_treat_as_decision_patterns = hints;

  return out;
}

function parsePattern(
  entry: unknown,
  where: string,
  index: number,
  emit: Emit,
  seenIds: Set<string>,
  kind: "never_extract" | "decision_hint",
): { id: string; source: string; flags: string; note?: string } | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    emit("error", "OVERLAY_NOT_OBJECT", "each pattern must be an object", { path: where, row: index });
    return null;
  }
  const item = entry as Record<string, unknown>;
  const source = typeof item.source === "string" ? item.source : "";
  const flags = typeof item.flags === "string" ? item.flags : "";
  if (source.length === 0) {
    emit("error", "PATTERN_TOO_LONG", "a pattern source may not be empty", {
      path: `${where}.source`,
      row: index,
      field: "source",
    });
    return null;
  }
  // The SAME structural parser the gate overlay uses — one grammar, one set of
  // reason codes, and it is defence in depth rather than a safety proof (D1).
  const check = checkOverlayRegex(source, flags);
  let rejected = false;
  for (const problem of check.problems) {
    rejected = true;
    emit("error", problem.code, problem.message, {
      path: `${where}.source`,
      row: index,
      field: "source",
      params: problem.params,
    });
  }
  if (rejected) return null;
  const id =
    typeof item.id === "string" && item.id.length > 0 ? item.id : userPatternId(kind, source, flags);
  if (seenIds.has(id)) {
    emit("error", "PATTERN_DUPLICATE_ID", `duplicate pattern id ${id}`, {
      path: `${where}.id`,
      row: index,
      field: "id",
      params: { id },
    });
    return null;
  }
  seenIds.add(id);
  const note = typeof item.note === "string" ? item.note : undefined;
  if (
    note !== undefined &&
    (note.length > EXTRACTION_RULES_LIMITS.noteChars || CONTROL_CHARS.test(note) || note.includes("\n"))
  ) {
    emit(
      "error",
      "NOTE_INVALID",
      `a note must be a single line of at most ${EXTRACTION_RULES_LIMITS.noteChars} characters`,
      { path: `${where}.note`, row: index, field: "note", params: { limit: EXTRACTION_RULES_LIMITS.noteChars } },
    );
    return null;
  }
  return { id, source, flags, ...(note === undefined ? {} : { note }) };
}

/**
 * Structural validation. Produces the shared `Issue[]` contract (G5/I2) — `path`
 * travels to the Web UI unchanged, so an operator is told WHICH row to fix.
 */
export function validateExtractionRulesDoc(
  raw: unknown,
  opts: { forWrite?: boolean; bytes?: number } = {},
): ExtractionRulesValidation {
  const issues: Issue[] = [];
  const emit: Emit = (severity, code, message, extra) => {
    issues.push(overlayIssue(severity, code, message, extra));
  };

  if (opts.bytes !== undefined && opts.bytes > EXTRACTION_RULES_LIMITS.fileBytes) {
    emit(
      "error",
      "OVERLAY_TOO_LARGE",
      `the overlay file is ${opts.bytes} bytes (limit ${EXTRACTION_RULES_LIMITS.fileBytes})`,
      { params: { bytes: opts.bytes, limit: EXTRACTION_RULES_LIMITS.fileBytes } },
    );
    return { ok: false, issues, doc: null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    emit("error", "OVERLAY_NOT_OBJECT", "the overlay must be a JSON object");
    return { ok: false, issues, doc: null };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== EXTRACTION_RULES_OVERLAY_SCHEMA) {
    emit(
      "error",
      "OVERLAY_SCHEMA_MISMATCH",
      `schema must be "${EXTRACTION_RULES_OVERLAY_SCHEMA}" (found ${JSON.stringify(doc.schema ?? null)})`,
      { path: "schema", params: { expected: EXTRACTION_RULES_OVERLAY_SCHEMA } },
    );
    return { ok: false, issues, doc: null };
  }
  if (Number(doc.version) !== EXTRACTION_RULES_OVERLAY_VERSION) {
    // An unknown version is NEVER partially applied (§1.2). A half-applied
    // "never extract this" is the worst outcome in the whole design.
    emit(
      "error",
      "OVERLAY_VERSION_UNSUPPORTED",
      `version ${String(doc.version)} is not supported by this build (expected ${EXTRACTION_RULES_OVERLAY_VERSION})`,
      { path: "version", params: { version: doc.version, expected: EXTRACTION_RULES_OVERLAY_VERSION } },
    );
    return { ok: false, issues, doc: null };
  }
  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      emit("warning", "OVERLAY_UNKNOWN_FIELD", `unknown field "${key}" is ignored by this build`, {
        path: key,
        params: { field: key },
      });
    }
  }

  const revision = Number.isInteger(doc.revision) && Number(doc.revision) >= 0 ? Number(doc.revision) : 0;
  const seenIds = new Set<string>();
  const global = validateRuleSet(doc, "", emit, seenIds);

  const overrides: Record<string, ExtractionRuleSet> = {};
  const overridesRaw = doc.project_overrides;
  if (overridesRaw !== undefined) {
    if (typeof overridesRaw !== "object" || overridesRaw === null || Array.isArray(overridesRaw)) {
      emit("error", "OVERLAY_NOT_OBJECT", "`project_overrides` must be an object keyed by project", {
        path: "project_overrides",
      });
    } else {
      const entries = Object.entries(overridesRaw as Record<string, unknown>);
      const limit = EXTRACTION_RULES_LIMITS.counts.projectOverrides;
      if (entries.length > limit) {
        emit("error", "PROJECT_COUNT_EXCEEDED", `${entries.length} project overrides (limit ${limit})`, {
          path: "project_overrides",
          params: { count: entries.length, limit },
        });
      }
      for (const [project, value] of entries) {
        const where = `project_overrides.${project}`;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          emit("error", "OVERLAY_NOT_OBJECT", "each project override must be an object", { path: where });
          continue;
        }
        // Ids are scoped per override: the same regex may legitimately appear in
        // the global list and in a project's, and a "duplicate id" error there
        // would be nonsense.
        overrides[project] = validateRuleSet(value as Record<string, unknown>, where, emit, new Set());
      }
    }
  }

  const ok = !issues.some((issue) => issue.severity === "error");
  void opts.forWrite; // every rule here matters equally on load and on write
  return {
    ok,
    issues,
    doc: ok
      ? {
          schema: EXTRACTION_RULES_OVERLAY_SCHEMA,
          version: EXTRACTION_RULES_OVERLAY_VERSION,
          revision,
          ...(typeof doc.updated_at === "string" ? { updated_at: doc.updated_at } : {}),
          ...(doc.updated_by && typeof doc.updated_by === "object"
            ? { updated_by: doc.updated_by as { surface?: string } }
            : {}),
          ...global,
          project_overrides: overrides,
        }
      : null,
  };
}

/**
 * §2.4-shaped async validator. This is the function lane A's
 * `applyOverlayChange('extraction-rules', …)` REQUIRES as `opts.validator`: the
 * write path refuses to guess this overlay's schema.
 */
export async function validateExtractionRules(
  doc: unknown,
  opts: { probe?: boolean; forWrite?: boolean; bytes?: number } = {},
): Promise<ExtractionRulesValidation> {
  const structural = validateExtractionRulesDoc(doc, { forWrite: opts.forWrite, bytes: opts.bytes });
  if (!structural.ok || !structural.doc || opts.probe !== true) return structural;
  // The measuring probe lives in overlay-admin.ts (write path only, §2.3.2). It
  // is defence in depth, not a proof: a pattern that passes it can still burn
  // its 50 ms at match time, which is why that is a HOLD and not a shrug.
  const { probeRegexSafety, PROBE_WALL_MS } = await import("./overlay-admin.js");
  const issues = [...structural.issues];
  const all = [
    ...collectRuleSetPatterns(structural.doc),
    ...Object.entries(structural.doc.project_overrides ?? {}).flatMap(([project, rules]) =>
      collectRuleSetPatterns(rules).map((pattern) => ({ ...pattern, project })),
    ),
  ];
  for (const pattern of all) {
    const probe = await probeRegexSafety([
      { label: pattern.id, source: pattern.source, flags: pattern.flags },
    ]);
    if (!probe.ok) {
      issues.push(
        overlayIssue(
          "error",
          "PATTERN_TOO_SLOW",
          `validation did not finish within the ${PROBE_WALL_MS} ms limit`,
          { path: pattern.path, params: { id: pattern.id, limitMs: PROBE_WALL_MS } },
        ),
      );
    }
  }
  const failed = issues.some((issue) => issue.severity === "error");
  return { ok: !failed, issues, doc: failed ? null : structural.doc };
}

function collectRuleSetPatterns(
  rules: ExtractionRuleSet,
): Array<{ id: string; source: string; flags: string; path: string }> {
  return [
    ...(rules.never_extract_patterns ?? []).map((pattern, index) => ({
      id: pattern.id,
      source: pattern.source,
      flags: pattern.flags,
      path: `never_extract_patterns[${index}].source`,
    })),
    ...(rules.always_treat_as_decision_patterns ?? []).map((pattern, index) => ({
      id: pattern.id,
      source: pattern.source,
      flags: pattern.flags,
      path: `always_treat_as_decision_patterns[${index}].source`,
    })),
  ];
}

/* -------------------------------------------------------------------------- */
/* Load + cache (§1.6)                                                         */
/* -------------------------------------------------------------------------- */

/** `mtimeMs:size:ino`, or `absent`. Atomic tmp+rename guarantees a new inode. */
function statKey(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return "absent";
  }
}

let cache: { key: string; loaded: LoadedExtractionRules } | null = null;
/** The last load that produced an APPLIED document — §3.5.2's stale-read fallback. */
let lastValid: LoadedExtractionRules | null = null;

export function overlaysDisabled(): boolean {
  return process.env.MEMEX_DISABLE_OVERLAYS === "1";
}

export function readExtractionRulesFile(file = extractionRulesOverlayPath()): {
  raw: unknown;
  bytes: number;
  present: boolean;
  readError: string | null;
} {
  let text: string;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      return { raw: null, bytes: 0, present: true, readError: "the overlay path is a symbolic link" };
    }
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { raw: null, bytes: 0, present: false, readError: null };
    return { raw: null, bytes: 0, present: true, readError: (err as Error).message };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  try {
    return { raw: JSON.parse(text), bytes, present: true, readError: null };
  } catch (err) {
    return { raw: null, bytes, present: true, readError: (err as Error).message };
  }
}

function readValidate(file: string): LoadedExtractionRules {
  const { raw, bytes, present, readError } = readExtractionRulesFile(file);
  if (!present) return EMPTY_RULES;
  if (readError !== null) {
    return {
      ...EMPTY_RULES,
      present: true,
      issues: [
        overlayIssue("error", "OVERLAY_UNREADABLE", `the overlay file could not be read: ${readError}`, {
          params: { reason: readError },
        }),
      ],
    };
  }
  const result = validateExtractionRulesDoc(raw, { bytes });
  if (!result.ok || !result.doc) {
    return { ...EMPTY_RULES, present: true, issues: result.issues };
  }
  const doc = result.doc;
  const quarantine = readQuarantine().filter((entry) => entry.overlay === "extraction-rules");
  const issues = [...result.issues];
  const quarantined: QuarantineEntry[] = [];

  // (G1) The asymmetry that defines this overlay. A quarantined `never_extract`
  // pattern does NOT get dropped so the rest can run: the whole overlay is
  // treated as erroring, which makes the next claim HOLD. A forbidden string
  // must not be stored because the rule that forbids it turned out to be slow.
  for (const pattern of allNeverExtract(doc)) {
    const sha = patternSourceSha8(pattern.source, pattern.flags ?? "");
    const row = quarantine.find((entry) => entry.pattern_id === pattern.id && entry.source_sha8 === sha);
    if (!row) continue;
    quarantined.push(row);
    issues.push(
      overlayIssue(
        "error",
        "PATTERN_QUARANTINED",
        `never_extract pattern ${pattern.id} exceeded the ${MATCH_WALL_MS} ms match budget — ` +
          "extraction is HELD until it is fixed or cleared",
        { path: "never_extract_patterns", params: { id: pattern.id, limitMs: MATCH_WALL_MS } },
      ),
    );
  }
  // A quarantined DECISION HINT is fail-safe: it cannot decide whether anything
  // is stored, so it is dropped with a warning and extraction continues.
  const hintQuarantine: string[] = [];
  for (const pattern of allDecisionHints(doc)) {
    const sha = patternSourceSha8(pattern.source, pattern.flags ?? "");
    const row = quarantine.find((entry) => entry.pattern_id === pattern.id && entry.source_sha8 === sha);
    if (!row) continue;
    hintQuarantine.push(pattern.id);
    quarantined.push(row);
    issues.push(
      overlayIssue(
        "warning",
        "PATTERN_QUARANTINED",
        `decision hint ${pattern.id} exceeded the ${MATCH_WALL_MS} ms match budget and is not applied`,
        { path: "always_treat_as_decision_patterns", params: { id: pattern.id, limitMs: MATCH_WALL_MS } },
      ),
    );
  }

  if (issues.some((issue) => issue.severity === "error")) {
    return { ...EMPTY_RULES, present: true, issues, quarantined, doc: null };
  }
  const hash = extractionRulesDocHash(doc);
  const loaded: LoadedExtractionRules = {
    present: true,
    hash,
    revision: doc.revision,
    doc,
    global: resolveFromDoc(doc, null, hash, new Set(hintQuarantine)),
    issues,
    quarantined,
    disabledByEnv: false,
  };
  return loaded;
}

function allNeverExtract(doc: ExtractionRulesDoc): NeverExtractPattern[] {
  return [
    ...(doc.never_extract_patterns ?? []),
    ...Object.values(doc.project_overrides ?? {}).flatMap((rules) => rules.never_extract_patterns ?? []),
  ];
}

function allDecisionHints(doc: ExtractionRulesDoc): DecisionHintPattern[] {
  return [
    ...(doc.always_treat_as_decision_patterns ?? []),
    ...Object.values(doc.project_overrides ?? {}).flatMap(
      (rules) => rules.always_treat_as_decision_patterns ?? [],
    ),
  ];
}

/**
 * The extractor's entry point. Two `statSync` calls, `ino` in the key so the
 * atomic tmp+rename of a write is always observed, and no `fs.watch`.
 */
export function loadExtractionRules(): LoadedExtractionRules {
  if (overlaysDisabled()) {
    // §1.8 — "no overlay", explicitly NOT a hold. Benchmarks and the isolation
    // harness run in this mode and must behave exactly like 0.6.9.
    return { ...EMPTY_RULES, disabledByEnv: true };
  }
  const file = extractionRulesOverlayPath();
  const key = `${statKey(file)}|${statKey(overlayQuarantinePath())}|${quarantineMemoryGeneration()}`;
  if (cache && cache.key === key) return cache.loaded;
  const loaded = readValidate(file);
  cache = { key, loaded };
  if (loaded.doc) lastValid = loaded;
  return loaded;
}

/**
 * The storage boundary's re-read (§3.4(2)).
 *
 * Identical to `loadExtractionRules()` except for the fallback: when the file is
 * now unparseable, the caller must not lose its claim-time rules, so the last
 * load that produced an applied document is returned with `staleRead` set. The
 * caller leaves one `rules.stale-read` audit line and keeps going — the union in
 * §3.4 already guarantees the claim snapshot is enforced either way.
 */
export function reloadExtractionRulesIfChanged(): LoadedExtractionRules & { staleRead: boolean } {
  const loaded = loadExtractionRules();
  if (loaded.doc || !loaded.present || loaded.disabledByEnv || !lastValid) {
    return { ...loaded, staleRead: false };
  }
  return { ...lastValid, staleRead: true };
}

/** Cache-bypassing read of the applied revision (the write path's CAS input). */
export function currentExtractionRulesRevision(): number {
  const { raw, present } = readExtractionRulesFile();
  if (!present || !raw || typeof raw !== "object") return 0;
  const revision = (raw as { revision?: unknown }).revision;
  return Number.isInteger(revision) && Number(revision) >= 0 ? Number(revision) : 0;
}

/** Test/transition hook: forget the cached load AND the stale-read fallback. */
export function resetExtractionRulesCache(): void {
  cache = null;
  lastValid = null;
}

/* -------------------------------------------------------------------------- */
/* Resolution (§3.1 — project_overrides merge)                                 */
/* -------------------------------------------------------------------------- */

function resolveFromDoc(
  doc: ExtractionRulesDoc,
  projectId: string | null,
  hash: string | null,
  quarantinedHints: Set<string>,
): ResolvedExtractionRules {
  const override = projectId ? doc.project_overrides?.[projectId] : undefined;
  const dedupe = <T extends { id: string }>(lists: T[][]): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const list of lists) {
      for (const item of list) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
    }
    return out;
  };
  return {
    projectId,
    hash,
    revision: doc.revision,
    // Only the language is OVERRIDDEN. Every restriction is a UNION, because a
    // project override that silently relaxed a global "never extract" would be a
    // way to lose a secret by adding a line somewhere else in the same file.
    preferredLanguage:
      override?.preferred_language !== undefined
        ? (override.preferred_language ?? null)
        : (doc.preferred_language ?? null),
    excludeTopics: [...new Set([...(doc.exclude_topics ?? []), ...(override?.exclude_topics ?? [])])],
    neverExtract: dedupe([doc.never_extract_patterns ?? [], override?.never_extract_patterns ?? []]),
    decisionHints: dedupe([
      doc.always_treat_as_decision_patterns ?? [],
      override?.always_treat_as_decision_patterns ?? [],
    ]).filter((hint) => !quarantinedHints.has(hint.id)),
  };
}

/** The effective rules for one project — what the clause and the block set use. */
export function resolveExtractionRules(
  projectId: string | null,
  loaded: LoadedExtractionRules = loadExtractionRules(),
): ResolvedExtractionRules {
  if (!loaded.doc) return { ...EMPTY_RESOLVED, projectId };
  if (projectId === null) return loaded.global;
  const quarantinedHints = new Set(
    loaded.issues
      .filter((issue) => issue.code === "PATTERN_QUARANTINED" && issue.severity === "warning")
      .map((issue) => String(issue.params?.id ?? "")),
  );
  return resolveFromDoc(loaded.doc, projectId, loaded.hash, quarantinedHints);
}

/** True when this rule set has nothing to say. The prompt clause is then empty. */
export function isEmptyExtractionRules(rules: ResolvedExtractionRules): boolean {
  return (
    rules.preferredLanguage === null &&
    rules.excludeTopics.length === 0 &&
    rules.neverExtract.length === 0 &&
    rules.decisionHints.length === 0
  );
}

/* -------------------------------------------------------------------------- */
/* Prompt clause (§3.2)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The monotonic-restriction preamble. It is a CONSTANT: the clause may only
 * suppress, and the sentence that says so has to be in the prompt rather than
 * only in the design document, or a future rule item could quietly widen what
 * the extractor accepts.
 */
const CLAUSE_PREAMBLE = [
  "These are the operator's additional RESTRICTIONS for this machine. They can only",
  "SUPPRESS or narrow a candidate. They can never relax a gate above, lower the",
  "evidence bar, widen what counts as authoritative, or make a fact eligible that the",
  "policy above rejects. If a rule here conflicts with any gate above, the gate wins",
  "and you emit nothing. Treat these lines as policy from the operator, not as",
  "conversation data.",
].join("\n");

function formatRegex(pattern: { source: string; flags: string }): string {
  return `/${pattern.source}/${pattern.flags ?? ""}`;
}

/**
 * Render the bounded structured block the extractor already consumes.
 *
 * Deterministic: same rules in, byte-identical block out, so a no-op re-save
 * cannot change a prompt. Returns `""` when there is nothing to say, and the
 * composer then returns the base prompt unchanged.
 */
export function renderExtractionConstraintClause(rules: ResolvedExtractionRules): string {
  if (isEmptyExtractionRules(rules)) return "";
  const lines: string[] = [
    "## User rule overlay (local, operator-authored)",
    `rules_hash: ${rules.hash ?? "unknown"}`,
    "",
    CLAUSE_PREAMBLE,
    "",
  ];
  if (rules.excludeTopics.length > 0) {
    lines.push(`- Never extract facts about: ${rules.excludeTopics.join("; ")}`);
  }
  for (const pattern of rules.neverExtract) {
    lines.push(
      `- Never emit a fact or observation whose text matches: ${formatRegex(pattern)}`,
    );
  }
  for (const pattern of rules.decisionHints) {
    lines.push(
      `- Prefer statements matching ${formatRegex(pattern)} as category=decision when the evidence allows it`,
    );
  }
  if (rules.preferredLanguage === "ko") lines.push("- Prefer fact_kr in Korean");
  if (rules.preferredLanguage === "en") lines.push("- Prefer fact in English");
  return lines.join("\n");
}

/**
 * `base` + `\n\n` + clause, or `base` unchanged.
 *
 * The base prompt constant is NEVER edited (`EXTRACTION_SYSTEM_PROMPT` stays
 * byte-identical, so `policy_version: precision-durability-v4` keeps meaning
 * what it meant), and the entailment verifier's prompts are not touched at all.
 */
export function composeExtractionSystemPrompt(
  base: string,
  rules: ResolvedExtractionRules | null | undefined,
): string {
  if (!rules) return base;
  const clause = renderExtractionConstraintClause(rules);
  return clause === "" ? base : `${base}\n\n${clause}`;
}

/* -------------------------------------------------------------------------- */
/* The storage boundary's block set (§3.3 / §3.4)                              */
/* -------------------------------------------------------------------------- */

/** Hold reasons this overlay owns. The value set itself lives in model-budget.ts. */
export type ExtractionRulesHoldReason =
  | "extraction_rules_invalid"
  | "extraction_rules_unavailable";

/** The candidate shapes the block set inspects. Structural, to stay DB-free. */
export interface BlockCandidate {
  /** fact / fact_kr / summary / signature_text / subject_key / … */
  factText: string[];
  /** evidence supporting spans. */
  evidence: string[];
}

export interface BlockSetOk<T> {
  ok: true;
  /** Candidates to DROP. Identity-based, so nothing depends on array indices. */
  blocked: Set<T>;
  /** Which patterns fired, for the single audit line. */
  patternIds: string[];
  /** Matcher execution time of the whole check. */
  elapsedMs: number;
}

export interface BlockSetFailed {
  ok: false;
  reason: ExtractionRulesHoldReason;
  detail: string;
  /** Ids newly quarantined by this check (execution timeout only). */
  quarantined: string[];
}

export type BlockSetResult<T> = BlockSetOk<T> | BlockSetFailed;

/**
 * G2 — the block set is `claim snapshot ∪ the latest valid rules read just
 * before the worker evaluation`.
 *
 * The union is the whole point. Reading only the current file made a relaxation
 * take effect on a claim that was already running, which is the exact opposite
 * of the contract: a pattern that existed when the work was claimed stays in
 * force until that work finishes, so TIGHTENING applies from the read and
 * RELAXATION applies from the next claim, automatically.
 */
export function unionNeverExtract(
  snapshot: readonly NeverExtractPattern[],
  latest: readonly NeverExtractPattern[],
): NeverExtractPattern[] {
  const out: NeverExtractPattern[] = [];
  const seen = new Set<string>();
  for (const pattern of [...snapshot, ...latest]) {
    const key = `${pattern.id}\u0000${pattern.source}\u0000${pattern.flags ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pattern);
  }
  return out;
}

function specsFor(
  patterns: readonly NeverExtractPattern[],
  group: "factText" | "evidence",
): UserPatternSpec[] {
  const wanted = group === "factText" ? ["fact_text", "both"] : ["evidence", "both"];
  return patterns
    .filter((pattern) => wanted.includes(pattern.scope ?? "both"))
    .map((pattern) => ({
      id: pattern.id,
      source: pattern.source,
      flags: pattern.flags ?? "",
      overlay: "extraction-rules" as const,
    }));
}

/**
 * Decide which candidates the commit must skip.
 *
 * Runs OUTSIDE the transaction, on purpose and without exception: better-sqlite3
 * transactions are synchronous so they cannot await a worker, and running an
 * un-time-boxed regex while holding a write lock is the worst possible place for
 * one. Inside the transaction there are only set lookups.
 *
 * Never throws. A check that could not finish returns `ok: false`, and the
 * caller then returns the claim unsaved rather than committing input it did not
 * manage to inspect (G1).
 */
export async function buildBlockSet<T>(
  matcher: MatcherHandle,
  patterns: readonly NeverExtractPattern[],
  candidates: ReadonlyArray<{ item: T; candidate: BlockCandidate }>,
  surface = "extractor",
): Promise<BlockSetResult<T>> {
  const blocked = new Set<T>();
  const patternIds = new Set<string>();
  let elapsedMs = 0;
  if (patterns.length === 0 || candidates.length === 0) {
    return { ok: true, blocked, patternIds: [], elapsedMs: 0 };
  }
  const groups: Array<{ key: "factText" | "evidence"; specs: UserPatternSpec[] }> = [
    { key: "factText", specs: specsFor(patterns, "factText") },
    { key: "evidence", specs: specsFor(patterns, "evidence") },
  ];
  for (const { item, candidate } of candidates) {
    for (const group of groups) {
      if (group.specs.length === 0) continue;
      const fields = candidate[group.key].filter((text) => typeof text === "string" && text.length > 0);
      if (fields.length === 0) continue;
      const hits = await matcher.match({
        // A newline join is safe in the only direction that matters: without the
        // `m` flag a pattern cannot straddle the boundary in a way that MISSES a
        // match, and a cross-field false positive over-blocks, which is the safe
        // side of a fail-closed rule.
        text: fields.join("\n"),
        patterns: group.specs,
        overlay: "extraction-rules",
        surface,
      });
      elapsedMs += hits.elapsedMs;
      if (hits.quarantined.length > 0) {
        // An execution timeout attributed to a specific pattern. The pattern is
        // now quarantined, which means the rule is OFF — so nothing is stored.
        return {
          ok: false,
          reason: "extraction_rules_invalid",
          detail: `never_extract pattern(s) ${hits.quarantined.join(", ")} exceeded the ${MATCH_WALL_MS} ms budget`,
          quarantined: hits.quarantined,
        };
      }
      if (hits.unavailable || hits.timedOut) {
        return {
          ok: false,
          reason: "extraction_rules_unavailable",
          detail: hits.timedOut
            ? "the matcher did not answer within its window (no pattern could be attributed)"
            : "the matcher worker could not be used",
          quarantined: [],
        };
      }
      if (hits.matched.length > 0) {
        blocked.add(item);
        for (const id of hits.matched) patternIds.add(id);
      }
    }
  }
  return { ok: true, blocked, patternIds: [...patternIds], elapsedMs };
}

/**
 * Is the matcher usable at all? The pre-claim gate (§3.5.2) asks this only when
 * there IS a `never_extract` pattern, because the answer costs a worker spawn
 * and an installation without forbid rules must pay nothing.
 */
export async function extractionMatcherAvailable(
  patterns: readonly NeverExtractPattern[],
): Promise<boolean> {
  if (patterns.length === 0) return true;
  const { oneShotMatcher } = await import("./overlay-matcher.js");
  const matcher = oneShotMatcher();
  try {
    const hits = await matcher.match({
      text: "memex extraction rules matcher probe",
      patterns: specsFor(patterns, "factText").slice(0, 1),
      overlay: "extraction-rules",
      surface: "pre-claim",
    });
    return !hits.unavailable && !hits.timedOut;
  } catch {
    return false;
  } finally {
    matcher.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* Pre-claim gate (§3.5.2)                                                     */
/* -------------------------------------------------------------------------- */

export interface PreClaimBlock {
  reason: ExtractionRulesHoldReason;
  detail: string;
}

/**
 * The synchronous half of the pre-claim gate: is the overlay itself unusable?
 *
 * Returns null when extraction may proceed. `MEMEX_DISABLE_OVERLAYS=1` always
 * proceeds (that is "no overlay", not "broken overlay").
 */
export function extractionRulesPreClaimBlock(
  rules: LoadedExtractionRules = loadExtractionRules(),
): PreClaimBlock | null {
  if (rules.disabledByEnv || !rules.present) return null;
  const errors = rules.issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return null;
  return {
    reason: "extraction_rules_invalid",
    detail:
      `${errors[0].code}: ${errors[0].message} — run: memex extract rules validate` +
      (errors.length > 1 ? ` (+${errors.length - 1} more)` : ""),
  };
}

/* -------------------------------------------------------------------------- */
/* Write wrappers (§3.5.2 "명시 재개")                                          */
/* -------------------------------------------------------------------------- */

export interface ExtractionRulesWriteOptions {
  surface: "cli" | "web-ui";
  expectedRevision?: number;
  probe?: boolean;
  /**
   * Open write DB. A successful rules write lifts every hold this overlay put
   * on extraction; without it a fixed rule set leaves the queue parked forever.
   * Optional because the write must still succeed with no database (the 1 hour
   * safety-net backoff recovers it), and because the Web UI opens its own.
   */
  db?: unknown;
}

export interface ExtractionRulesWriteResult {
  revision: number;
  hash: string | null;
  issues: Issue[];
  /** Jobs taken off hold by this write. */
  released: number;
}

/**
 * Lift every hold this overlay owns.
 *
 * Reason isolation matters: a fixed rule set must not release jobs parked on a
 * rejected model selection, so both of OUR reasons are released and nothing
 * else. Best-effort — a missing or closed database must not fail a rules write.
 */
export async function releaseExtractionRulesHold(db: unknown): Promise<number> {
  if (!db) return 0;
  try {
    const { releaseHeldJobs } = await import("./model-budget.js");
    const typed = db as Parameters<typeof releaseHeldJobs>[0];
    return (
      releaseHeldJobs(typed, "extraction_rules_invalid") +
      releaseHeldJobs(typed, "extraction_rules_unavailable")
    );
  } catch {
    return 0;
  }
}

async function applyRulesDoc(
  doc: unknown,
  auditAction: string,
  opts: ExtractionRulesWriteOptions,
): Promise<ExtractionRulesWriteResult> {
  const { applyOverlayChange } = await import("./overlay-admin.js");
  const result = await applyOverlayChange(
    "extraction-rules",
    { doc },
    {
      surface: opts.surface,
      expectedRevision: opts.expectedRevision,
      probe: opts.probe,
      auditAction,
      validator: validateExtractionRules,
      history: { counts: ruleCounts(doc) },
    },
  );
  resetExtractionRulesCache();
  const applied = loadExtractionRules();
  const released = await releaseExtractionRulesHold(opts.db);
  return {
    revision: result.revision,
    hash: applied.hash,
    issues: result.issues,
    released,
  };
}

function ruleCounts(doc: unknown): Record<string, number> {
  const parsed = validateExtractionRulesDoc(doc);
  if (!parsed.doc) return {};
  return {
    exclude_topics: parsed.doc.exclude_topics?.length ?? 0,
    never_extract: parsed.doc.never_extract_patterns?.length ?? 0,
    decision_hints: parsed.doc.always_treat_as_decision_patterns?.length ?? 0,
    project_overrides: Object.keys(parsed.doc.project_overrides ?? {}).length,
  };
}

/** §3.7 `memex extract rules set` / Web UI `set`. Full-document path. */
export async function setExtractionRules(
  doc: unknown,
  opts: ExtractionRulesWriteOptions,
): Promise<ExtractionRulesWriteResult> {
  return applyRulesDoc(doc, "rules.set", opts);
}

/** §3.7 `memex extract rules reset`. Writes the empty document, never unlinks. */
export async function resetExtractionRules(
  opts: ExtractionRulesWriteOptions,
): Promise<ExtractionRulesWriteResult> {
  const { resetOverlay } = await import("./overlay-admin.js");
  const result = await resetOverlay("extraction-rules", {
    surface: opts.surface,
    expectedRevision: opts.expectedRevision,
    emptyDoc: emptyExtractionRulesDoc(),
    validator: validateExtractionRules,
  });
  resetExtractionRulesCache();
  const released = await releaseExtractionRulesHold(opts.db);
  return { revision: result.revision, hash: loadExtractionRules().hash, issues: result.issues, released };
}

/** §3.7 `memex extract rules rollback --to <revision>`. */
export async function rollbackExtractionRules(
  revision: number,
  opts: ExtractionRulesWriteOptions,
): Promise<ExtractionRulesWriteResult> {
  const { rollbackOverlay } = await import("./overlay-admin.js");
  const result = await rollbackOverlay("extraction-rules", revision, {
    surface: opts.surface,
    expectedRevision: opts.expectedRevision,
    validator: validateExtractionRules,
  });
  resetExtractionRulesCache();
  const released = await releaseExtractionRulesHold(opts.db);
  return { revision: result.revision, hash: loadExtractionRules().hash, issues: result.issues, released };
}

/* -------------------------------------------------------------------------- */
/* doctor (§5) — the check FUNCTIONS live here; src/lifecycle.ts wires them in  */
/* -------------------------------------------------------------------------- */

export interface ExtractionRulesCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/**
 * `extraction-rules-overlay` and `extraction-rules-hold`.
 *
 * A held job is the "stopped quietly" class of bug doctor exists to surface, so
 * it is a `fail` rather than a `warn`: nothing was stored, and nothing will be
 * until an operator fixes the rules or clears the quarantine.
 */
export async function extractionRulesChecks(db?: unknown): Promise<ExtractionRulesCheck[]> {
  const checks: ExtractionRulesCheck[] = [];
  const rules = loadExtractionRules();
  const errors = rules.issues.filter((issue) => issue.severity === "error");
  const warnings = rules.issues.filter((issue) => issue.severity === "warning");

  if (rules.disabledByEnv) {
    checks.push({
      name: "extraction-rules-overlay",
      status: "ok",
      detail: "MEMEX_DISABLE_OVERLAYS=1 — no extraction rule overlay is read",
    });
  } else if (!rules.present) {
    checks.push({ name: "extraction-rules-overlay", status: "ok", detail: "absent" });
  } else if (errors.length > 0) {
    checks.push({
      name: "extraction-rules-overlay",
      status: "fail",
      detail:
        "invalid — EXTRACTION IS HELD (no attempts consumed): " +
        `${errors.map((issue) => issue.code).join(", ")} — run: memex extract rules validate`,
    });
  } else {
    const count =
      (rules.global.excludeTopics.length) +
      (rules.global.neverExtract.length) +
      (rules.global.decisionHints.length);
    const applied = `applied: ${rules.hash} rev ${rules.revision}, ${count} rule(s)`;
    checks.push(
      warnings.length > 0
        ? {
            name: "extraction-rules-overlay",
            status: "warn",
            detail: `${applied} with ${warnings.length} warning(s): ${warnings.map((i) => i.code).join(", ")}`,
          }
        : { name: "extraction-rules-overlay", status: "ok", detail: applied },
    );
  }

  let summary: Array<{ reason: string; jobs: number }> = [];
  if (db) {
    try {
      const { heldJobSummary } = await import("./model-budget.js");
      summary = heldJobSummary(db as Parameters<typeof heldJobSummary>[0]).filter((row) =>
        row.reason.startsWith("extraction_rules_"),
      );
    } catch {
      summary = [];
    }
  }
  const total = summary.reduce((sum, row) => sum + row.jobs, 0);
  checks.push(
    total === 0
      ? { name: "extraction-rules-hold", status: "ok", detail: "no extraction job is held" }
      : {
          name: "extraction-rules-hold",
          status: "fail",
          detail:
            `${total} job(s) held: ` +
            summary.map((row) => `${row.reason} ${row.jobs}`).join(" / ") +
            " — the never_extract check could not complete, so nothing was stored — " +
            "fix or clear, then they resume",
        },
  );
  return checks;
}

/* -------------------------------------------------------------------------- */
/* Benchmark contract (§6) — the OBSERVATION only; agent G wires it            */
/* -------------------------------------------------------------------------- */

export interface OverlayBenchmarkObservation {
  recall_gate: "present" | "absent";
  extraction_rules: "present" | "absent";
  quarantine: "present" | "absent";
  disabled_by_env: boolean;
}

/**
 * What the benchmark report's `environment.overlays` must say.
 *
 * Deliberately OBSERVED from the filesystem rather than echoed from the env var:
 * the contract validator then cannot be satisfied by a report that merely claims
 * the overlays were off.
 */
export function observeOverlayBenchmarkEnvironment(): OverlayBenchmarkObservation {
  const exists = (file: string): "present" | "absent" => {
    try {
      return fs.existsSync(file) ? "present" : "absent";
    } catch {
      return "absent";
    }
  };
  return {
    recall_gate: exists(recallGateOverlayPath()),
    extraction_rules: exists(extractionRulesOverlayPath()),
    quarantine: exists(overlayQuarantinePath()),
    disabled_by_env: overlaysDisabled(),
  };
}
