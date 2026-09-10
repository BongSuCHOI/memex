#!/usr/bin/env node

/**
 * Read-only fact-extraction evaluation harness.
 *
 * Curated fixture:
 *   npm run eval:fact-extraction -- --out docs/verification/fact-extraction-baseline.json
 *
 * Real archive shadow run (never mutates the DB):
 *   npm run eval:fact-extraction -- --session <id> --out .fact-extraction-eval/shadow.json
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  compareFactExtractionReports,
  evaluateFactExtractionArchiveSessions,
  evaluateFactExtractionFixture,
  parseFactExtractionFixture,
} from "../dist/fact-extraction-eval.js";
import { callMemoryModelObserved } from "../dist/llm.js";
import { DEFAULT_CODEX_MODEL } from "../dist/codex-exec.js";
import { getDbPath } from "../dist/paths.js";
import {
  ALLOWED_REASONING_EFFORTS,
  resolveLlmModel,
  resolveReasoningEffort,
} from "../dist/model-settings.js";
import { EMBEDDING_MODEL } from "../dist/model-cache.js";
import {
  EXTRACTION_POLICY_VERSION,
  FACT_ENTAILMENT_POLICY_VERSION,
} from "../dist/fact-extractor.js";
import {
  composeEffectivePolicyVersion,
  emptyLoadedExtractionRules,
  extractionRulesDocHash,
  isEmptyExtractionRules,
  loadExtractionRules,
  renderExtractionConstraintClause,
  resolveExtractionRules,
  validateExtractionRulesDoc,
} from "../dist/extraction-rules.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = path.join(
  ROOT,
  "test",
  "fixtures",
  "fact-extraction-cases.json",
);

const HELP = `Usage:
  npm run eval:fact-extraction -- [options]

Curated mode (default):
  --fixture <path>    Fixture JSON (default: test/fixtures/fact-extraction-cases.json)
  --case <id>         Evaluate one case; repeat to select multiple cases
  --baseline <path>   Compare this run with an earlier curated report
  --validate-only     Validate fixture coverage without calling the model
  --allow-model-change  Report improvements/regressions even when the baseline
                      used a different model or reasoning effort. Without it such
                      a comparison is marked incomparable and reported as
                      'differences', because a model change and a prompt change
                      are otherwise indistinguishable in the same list.

Archive shadow mode:
  --session <id>      Evaluate one archive session; repeat for multiple sessions
  --db <path>         Memex SQLite path (default: resolved Memex DB)

Shared:
  --rules <path>      Evaluate with a CANDIDATE extraction-rules overlay instead
                      of the applied one (issue #30 §3.7). Nothing is written:
                      the file is validated, its constraint clause is appended to
                      the extraction system prompt for this run only, and the
                      report records it under 'rules_overlay'. Pass
                      '--rules none' to evaluate with NO overlay at all.
  --model <id>        Codex model override (default: the resolved selection —
                      MEMEX_CODEX_MODEL, then models.json, then ${DEFAULT_CODEX_MODEL})
  --reasoning <level> Reasoning effort override: ${ALLOWED_REASONING_EFFORTS.join("|")}
                      (default: the resolved selection; 'unset' sends no flag)
  --out <path>        Report path (default: ignored .fact-extraction-eval/ path)
  --help, -h          Show this help

--model and --reasoning are passed PER CALL and never written to the
environment or to models.json, so an evaluation run cannot change what the rest
of this machine uses.

Archive mode opens SQLite with readonly + query_only and never writes facts,
extraction_log markers, watermarks, or source conversations.`;

function parseArgs(argv) {
  const options = {
    sessions: [],
    cases: [],
    fixture: null,
    fixtureExplicit: false,
    rules: null,
    rulesExplicit: false,
    baseline: null,
    db: null,
    model: null,
    reasoning: null,
    out: null,
    validateOnly: false,
    allowModelChange: false,
    help: false,
  };
  const valueOptions = new Set([
    "--session",
    "--case",
    "--fixture",
    "--rules",
    "--baseline",
    "--db",
    "--model",
    "--reasoning",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--validate-only") {
      options.validateOnly = true;
      continue;
    }
    if (arg === "--allow-model-change") {
      options.allowModelChange = true;
      continue;
    }
    if (!valueOptions.has(arg)) throw new Error(`unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--session") options.sessions.push(value);
    else if (arg === "--case") options.cases.push(value);
    else if (arg === "--fixture") {
      options.fixture = value;
      options.fixtureExplicit = true;
    } else if (arg === "--rules") {
      options.rules = value;
      options.rulesExplicit = true;
    } else if (arg === "--baseline") options.baseline = value;
    else if (arg === "--db") options.db = value;
    else if (arg === "--model") options.model = value;
    else if (arg === "--reasoning") {
      // Refused here, not normalized: a typo that is silently dropped turns into
      // a receipt that claims a reasoning effort the run never used.
      if (value !== "unset" && !ALLOWED_REASONING_EFFORTS.includes(value)) {
        throw new Error(
          `--reasoning must be one of ${ALLOWED_REASONING_EFFORTS.join("|")} (or 'unset'): ${value}`,
        );
      }
      options.reasoning = value;
    } else if (arg === "--out") options.out = value;
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${file}): ${error.message}`);
  }
}

function assertBaselineReport(value, file) {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schema_version !== 1 ||
    value.mode !== "curated" ||
    typeof value.model !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.summary !== "object" ||
    value.summary === null ||
    !Array.isArray(value.cases)
  ) {
    throw new Error(`baseline report has an unsupported shape: ${file}`);
  }
  for (const [index, entry] of value.cases.entries()) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.id !== "string" ||
      typeof entry.passed !== "boolean"
    ) {
      throw new Error(`baseline report cases[${index}] is malformed: ${file}`);
    }
  }
  return value;
}

/**
 * #31 §13.2 — a comparison across a model change is not an improvement report.
 *
 * Run the harness against a different model and the prompt-policy effect and the
 * model effect arrive in the SAME `improvements`/`regressions` lists, indis-
 * tinguishable. So when the selection differs, the lists are renamed
 * `differences` and the comparison is marked incomparable; `--allow-model-change`
 * is the deliberate opt-out for someone who knows what they are reading.
 */
function labelModelIdentity(comparison, { report, baseline, allow }) {
  const baselineReasoning = baseline.reasoning ?? "unset";
  const sameModel = comparison.baseline_model === report.model;
  const sameReasoning = baselineReasoning === report.reasoning;
  const labelled = { ...comparison, baseline_reasoning: baselineReasoning };
  if (sameModel && sameReasoning) return { ...labelled, incomparable: false };
  const reason = !sameModel ? "model identity differs" : "reasoning effort differs";
  if (allow) {
    return { ...labelled, incomparable: false, model_change_allowed: true, reason };
  }
  const { improvements, regressions, ...rest } = labelled;
  return {
    ...rest,
    incomparable: true,
    reason,
    differences: [...(improvements ?? []), ...(regressions ?? [])],
  };
}

function gitRunContext(databaseMode, selection) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    git_head: head.status === 0 ? head.stdout.trim() : null,
    git_dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    extractor_profile: "production-current",
    database_mode: databaseMode,
    // #31: a receipt that does not say WHERE the selection came from cannot be
    // reproduced — the same command answers differently under a different env.
    model_source: selection.modelSource,
    reasoning_source: selection.reasoningSource,
    embedding_model: EMBEDDING_MODEL,
  };
}

/**
 * #31: the selection travels as a per-call option rather than through
 * `process.env.MEMEX_CODEX_MODEL`.
 *
 * The old shape wrote the flag into this process's environment, which every
 * later import and every child inherited — a harness run could change what the
 * rest of the machine believed it was using. `buildCodexExecArgs` is the single
 * interpretation point now, so handing it the pair directly is both narrower and
 * the only way to name a reasoning effort at all.
 */
function makeInvokeModel(selection, overlay) {
  return async function invokeModel({ systemPrompt, userMessage }) {
    const result = await callMemoryModelObserved(
      applyRulesClause(systemPrompt, overlay),
      userMessage,
      2048,
      {
        model: selection.model,
        reasoningEffort: selection.reasoning,
      },
    );
    return {
      text: result.text,
      tokenUsage: result.observation.token_usage,
    };
  };
}

/**
 * Issue #30 §3.7 — the rules overlay this run evaluates under.
 *
 * The APPLIED overlay by default, so `memex extract eval` answers the question a
 * user actually has ("what do my rules do to extraction quality?"). `--rules
 * <path>` substitutes a candidate that has NOT been applied — nothing is written
 * anywhere — and `--rules none` removes the overlay for a clean baseline.
 */
function resolveRulesOverlay(options) {
  const none = {
    source: "none",
    present: false,
    hash: null,
    revision: 0,
    clause: "",
    counts: { exclude_topics: 0, never_extract: 0, decision_hints: 0 },
    preferred_language: null,
  };
  const describe = (source, resolved) => ({
    source,
    present: !isEmptyExtractionRules(resolved),
    hash: resolved.hash,
    revision: resolved.revision,
    clause: renderExtractionConstraintClause(resolved),
    counts: {
      exclude_topics: resolved.excludeTopics.length,
      never_extract: resolved.neverExtract.length,
      decision_hints: resolved.decisionHints.length,
    },
    preferred_language: resolved.preferredLanguage,
  });

  if (options.rulesExplicit) {
    if (options.rules === "none") return none;
    const file = path.resolve(ROOT, options.rules);
    const text = fs.readFileSync(file, "utf8");
    const validation = validateExtractionRulesDoc(
      readJson(file, "rules overlay"),
      { bytes: Buffer.byteLength(text, "utf8") },
    );
    const errors = validation.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0 || !validation.doc) {
      throw new Error(
        `--rules ${options.rules} is not a valid extraction-rules overlay: ` +
          errors
            .map((issue) => `${issue.code}${issue.path ? ` at ${issue.path}` : ""}`)
            .join(", "),
      );
    }
    const doc = validation.doc;
    // The project-override merge is the core module's rule, never re-implemented
    // here: asking for a project id no override can carry makes the merge a no-op
    // and leaves exactly the global rule set.
    const resolved = resolveExtractionRules(" no-such-project", {
      ...emptyLoadedExtractionRules(),
      present: true,
      hash: extractionRulesDocHash(doc),
      revision: doc.revision,
      doc,
    });
    return describe(file, { ...resolved, projectId: null });
  }

  const loaded = loadExtractionRules();
  if (!loaded.doc) return none;
  return describe("applied", resolveExtractionRules(null, loaded));
}

/**
 * `base` + `\n\n` + clause, for the EXTRACTION call only.
 *
 * The entailment verifier's prompt must stay byte-identical whether or not an
 * overlay exists (§3.2), so it is excluded by its own policy identifier rather
 * than by call order.
 */
function applyRulesClause(systemPrompt, overlay) {
  if (!overlay || overlay.clause === "") return systemPrompt;
  if (!systemPrompt.includes(EXTRACTION_POLICY_VERSION)) return systemPrompt;
  if (systemPrompt.includes(FACT_ENTAILMENT_POLICY_VERSION)) return systemPrompt;
  return `${systemPrompt}\n\n${overlay.clause}`;
}

/**
 * The two fields the receipt needs to be reproducible under an overlay.
 *
 * `effective_policy_version` is REPORTING only — it is not the scheduling key,
 * and folding the rule hash into that key would re-extract the whole corpus on
 * one edited character.
 */
function stampRulesOverlay(report, overlay) {
  report.effective_policy_version = composeEffectivePolicyVersion(
    EXTRACTION_POLICY_VERSION,
    overlay.hash,
  );
  report.rules_overlay = {
    source: overlay.source,
    present: overlay.present,
    hash: overlay.hash,
    revision: overlay.revision,
    clause_chars: overlay.clause.length,
    counts: overlay.counts,
    preferred_language: overlay.preferred_language,
    applied_to: overlay.clause === "" ? null : "extraction_system_prompt",
    // Said out loud because it is not obvious: the per-call digests below are
    // computed by the harness over the prompt BEFORE the clause is appended.
    prompt_sha256_excludes_clause: overlay.clause !== "",
  };
  return report;
}

function defaultOutput(mode) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  return path.join(ROOT, ".fact-extraction-eval", `${mode}-${timestamp}.json`);
}

function writeReport(file, report) {
  const absolute = path.resolve(ROOT, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(temporary, absolute);
  return absolute;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (options.sessions.length > 0 && options.fixtureExplicit) {
    throw new Error("--session and --fixture are mutually exclusive");
  }
  if (options.sessions.length > 0 && options.cases.length > 0) {
    throw new Error("--session and --case are mutually exclusive");
  }
  if (options.sessions.length > 0 && options.validateOnly) {
    throw new Error("--validate-only is available only in curated mode");
  }
  if (options.sessions.length > 0 && options.baseline) {
    throw new Error("--baseline is available only in curated mode");
  }

  // #31: resolve once, pass per call, mutate no environment. `DEFAULT_CODEX_MODEL`
  // stays imported as the documented bottom of the chain, which `resolveLlmModel`
  // already returns when nothing else is chosen.
  const resolvedModel = resolveLlmModel();
  const resolvedReasoning = resolveReasoningEffort();
  const selection = {
    model: options.model || resolvedModel.value || DEFAULT_CODEX_MODEL,
    modelSource: options.model ? "explicit" : resolvedModel.source,
    reasoning: options.reasoning
      ? options.reasoning === "unset"
        ? null
        : options.reasoning
      : resolvedReasoning.value,
    reasoningSource: options.reasoning ? "explicit" : resolvedReasoning.source,
  };
  const model = selection.model;
  const reasoning = selection.reasoning ?? "unset";
  const rulesOverlay = resolveRulesOverlay(options);
  const invokeModel = makeInvokeModel(selection, rulesOverlay);

  if (options.sessions.length === 0) {
    const fixturePath = path.resolve(ROOT, options.fixture || DEFAULT_FIXTURE);
    let fixture = parseFactExtractionFixture(readJson(fixturePath, "fixture"));
    if (options.cases.length > 0) {
      const requested = new Set(options.cases);
      const selected = fixture.cases.filter((entry) => requested.has(entry.id));
      const missing = [...requested].filter(
        (id) => !selected.some((entry) => entry.id === id),
      );
      if (missing.length > 0) {
        throw new Error(`unknown fixture case(s): ${missing.join(", ")}`);
      }
      fixture = { ...fixture, name: `${fixture.name}-subset`, cases: selected };
    }
    if (options.validateOnly) {
      process.stdout.write(
        `${JSON.stringify({ valid: true, fixture: fixture.name, cases: fixture.cases.length })}\n`,
      );
      return;
    }

    const report = await evaluateFactExtractionFixture(fixture, {
      model,
      invokeModel,
    });
    report.reasoning = reasoning;
    stampRulesOverlay(report, rulesOverlay);
    report.run_context = gitRunContext("not-opened", selection);
    if (options.baseline) {
      const baselinePath = path.resolve(ROOT, options.baseline);
      const baseline = assertBaselineReport(
        readJson(baselinePath, "baseline report"),
        baselinePath,
      );
      report.comparison = labelModelIdentity(
        compareFactExtractionReports(report, baseline),
        { report, baseline, allow: options.allowModelChange },
      );
    }
    const output = writeReport(options.out || defaultOutput("curated"), report);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    process.stderr.write(`Saved: ${output}\n`);
    if (report.summary.execution_error_count > 0) {
      process.stderr.write("Evaluation is incomplete: one or more cases failed to execute.\n");
      process.exitCode = 2;
    }
    return;
  }

  const dbPath = path.resolve(options.db || getDbPath());
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const report = await evaluateFactExtractionArchiveSessions(
      db,
      options.sessions,
      { model, invokeModel },
    );
    report.reasoning = reasoning;
    stampRulesOverlay(report, rulesOverlay);
    report.run_context = gitRunContext("read-only", selection);
    const output = writeReport(options.out || defaultOutput("shadow"), report);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
    process.stderr.write(`Saved: ${output}\n`);
    if (report.summary.execution_error_count > 0) {
      process.stderr.write("Evaluation is incomplete: one or more sessions failed to execute.\n");
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`fact-extraction-eval: ${error.message}\n`);
  process.stderr.write("Try: npm run eval:fact-extraction -- --help\n");
  process.exitCode = 1;
});
