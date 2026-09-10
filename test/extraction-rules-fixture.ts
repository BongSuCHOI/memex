/**
 * Shared fixture for the extraction-rules overlay suites (#30 §7 lane C).
 *
 * Not a `*.test.ts`, so vitest does not collect it.
 *
 * The point of going through `runFactExtraction` rather than stubbing the save
 * function is that the accounting these tests assert on — `memory_jobs.attempts`,
 * `extraction_targets.attempts`, the lease, `checkpoints.state`,
 * `extraction_failed_ranges`, `extraction_log` and the processed watermark — is
 * only written by the real claim path. A stub would have passed in every broken
 * revision of this design.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { patternSourceSha8 } from "../src/overlay-regex.js";

/** The scripted provider. Mutable so each test can decide what the model says. */
export const script: {
  calls: number;
  systemPrompts: string[];
  /** Raw candidate objects returned by the extraction stage. */
  candidates: unknown[];
  /**
   * Runs inside the provider call, i.e. while the claim is live and the model is
   * "thinking". Editing the overlay here is the only honest way to test a rule
   * change that lands between the claim and the commit.
   */
  onCall?: (stage: "extract" | "verify") => void;
} = { calls: 0, systemPrompts: [], candidates: [] };

export function resetScript(candidates: unknown[] = []): void {
  script.calls = 0;
  script.systemPrompts = [];
  script.candidates = candidates;
  script.onCall = undefined;
}

interface CodexModule {
  resolveCodexSelection: (opts: { model?: string | null }) => Promise<{
    model: string;
    reasoningEffort: string | null;
  }>;
}

/**
 * Build the `runCodex` replacement. Two model stages answer here: the extraction
 * call, and the fail-closed entailment verifier every candidate must clear before
 * it can be saved (answering only the first would commit nothing at all).
 */
export function codexMock(actual: CodexModule): {
  runCodex: (opts: {
    onObservation?: (o: unknown) => void;
    model?: string | null;
    systemPrompt?: string;
    userMessage?: string;
  }) => Promise<string>;
} {
  return {
    runCodex: async (opts) => {
      script.calls++;
      script.systemPrompts.push(opts.systemPrompt ?? "");
      const selection = await actual.resolveCodexSelection({ model: opts.model });
      opts.onObservation?.({
        duration_ms: 1,
        token_usage: null,
        model: selection.model,
        reasoning_effort: selection.reasoningEffort,
      });
      const stage = opts.systemPrompt?.includes("authoritative-entailment-v3")
        ? "verify"
        : "extract";
      script.onCall?.(stage);
      if (stage === "verify") {
        const envelope = JSON.parse(opts.userMessage ?? "{}") as {
          candidates?: Array<{
            selected_context_dependencies?: Array<{ context_id: string; relation: string }>;
          }>;
        };
        return JSON.stringify(
          (envelope.candidates ?? []).map((candidate, index) => ({
            candidate_index: index + 1,
            verdict: "ENTAILED",
            used_context_dependencies: candidate.selected_context_dependencies ?? [],
            used_local_context_exchange_indices: [],
          })),
        );
      }
      return JSON.stringify(script.candidates);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Matcher double                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How the matcher behaves for the EXTRACTOR's calls.
 *
 * `pre-claim` probe calls always succeed: the three failures under test are the
 * realistic ones where the worker was fine when the work was claimed and then
 * timed out, failed to start or died during the run. Failing the probe too would
 * only ever exercise the pre-claim gate.
 */
export type MatcherMode = "ok" | "execution-timeout" | "startup-timeout" | "worker-dead";

export const matcherScript: {
  mode: MatcherMode;
  /** When true the worker cannot be created at all, so even the probe fails. */
  failPreClaim: boolean;
  calls: number;
  disposed: number;
} = { mode: "ok", failPreClaim: false, calls: 0, disposed: 0 };

export function resetMatcherScript(mode: MatcherMode = "ok", failPreClaim = false): void {
  matcherScript.mode = mode;
  matcherScript.failPreClaim = failPreClaim;
  matcherScript.calls = 0;
  matcherScript.disposed = 0;
}

type MatcherModule = typeof import("../src/overlay-matcher.js");

/**
 * Replace only the two handle factories. `readQuarantine`, `quarantinePattern`
 * and the memory generation stay REAL, so an execution timeout really writes the
 * quarantine row the next load has to find.
 */
export function matcherMock(actual: MatcherModule): Partial<MatcherModule> {
  const handle = (): ReturnType<MatcherModule["oneShotMatcher"]> => ({
    state: () => (matcherScript.mode === "worker-dead" ? "dead" : "ready"),
    dispose: () => {
      matcherScript.disposed++;
    },
    match: async (input) => {
      const base = {
        intents: {},
        matched: [] as string[],
        timedOut: false,
        quarantined: [] as string[],
        unavailable: false,
        elapsedMs: 1,
        compiledPatterns: input.patterns.length,
      };
      if (input.surface === "pre-claim" && matcherScript.failPreClaim) {
        matcherScript.calls++;
        return { ...base, unavailable: true, elapsedMs: 0 };
      }
      // Otherwise the probe is answered: see the note above.
      if (input.surface === "pre-claim" || matcherScript.mode === "ok") {
        matcherScript.calls++;
        return {
          ...base,
          matched: input.patterns
            .filter((pattern) => {
              try {
                return new RegExp(pattern.source, pattern.flags).test(input.text);
              } catch {
                return false;
              }
            })
            .map((pattern) => pattern.id),
        };
      }
      matcherScript.calls++;
      if (matcherScript.mode === "execution-timeout") {
        // A timeout the worker attributed to ONE pattern: the real matcher
        // quarantines it and terminates, so do exactly that.
        const victim = input.patterns[0];
        actual.quarantinePattern({
          overlay: input.overlay ?? "extraction-rules",
          pattern_id: victim.id,
          source_sha8: patternSourceSha8(victim.source, victim.flags),
          at: new Date().toISOString(),
          elapsed_ms: actual.MATCH_WALL_MS,
          input_chars: input.text.length,
          surface: input.surface ?? "extractor",
        });
        return { ...base, timedOut: true, quarantined: [victim.id], elapsedMs: actual.MATCH_WALL_MS };
      }
      if (matcherScript.mode === "startup-timeout") {
        // Queue wait / startup budget: NOTHING is quarantined, because no pattern
        // can be shown to have been running.
        return { ...base, timedOut: true, unavailable: true, elapsedMs: 0 };
      }
      return { ...base, unavailable: true, elapsedMs: 0 };
    },
  });
  return { persistentMatcher: handle, oneShotMatcher: handle };
}

export const PROJECT = "/tmp/extraction-rules-project";
export const SESSION = "S-rules";

/** Six closed exchanges, enough for one extraction window with a human assertion. */
export function seedExchanges(
  db: Database.Database,
  options: { userMessage: string; count?: number; sessionId?: string } = {
    userMessage: "Flutter 상태관리는 Riverpod으로 결정했습니다.",
  },
): void {
  const insert = db.prepare(`
    INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path,
       line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const session = options.sessionId ?? SESSION;
  for (let i = 0; i < (options.count ?? 6); i++) {
    insert.run(
      `e${i}`,
      PROJECT,
      new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      options.userMessage,
      "확인했습니다.",
      `/tmp/a${i}.jsonl`,
      i * 10,
      i * 10 + 9,
      session,
    );
  }
}

/** One candidate fact whose evidence is an exact span of the seeded message. */
export function factCandidate(text: string, span: string, factKr?: string): Record<string, unknown> {
  return {
    fact: text,
    ...(factKr ? { fact_kr: factKr } : {}),
    category: "preference",
    scope_type: "project",
    confidence: 0.9,
    grounding_type: "explicit",
    durable: true,
    evidence: [{ exchange_index: 1, source: "human", kind: "assertion", supporting_span: span }],
    context_dependencies: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Overlay file                                                                */
/* -------------------------------------------------------------------------- */

export function overlayPath(home: string): string {
  return path.join(home, "overlays", "extraction-rules.json");
}

export interface NeverExtractInput {
  id: string;
  source: string;
  flags?: string;
  scope?: "fact_text" | "evidence" | "both";
}

export function rulesDoc(
  patterns: NeverExtractInput[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "memex.extraction-rules-overlay",
    version: 1,
    revision: 1,
    never_extract_patterns: patterns.map((pattern) => ({
      id: pattern.id,
      source: pattern.source,
      flags: pattern.flags ?? "",
      scope: pattern.scope ?? "both",
    })),
    ...extra,
  };
}

/**
 * Write the overlay the way production does — tmp + rename.
 *
 * That is load-bearing, not tidiness: the loader's cache key is
 * `mtimeMs:size:ino`, and a rewrite in place inside the same millisecond would
 * be invisible to it. The rename changes the inode every time.
 */
export function writeRules(home: string, doc: unknown): void {
  const target = overlayPath(home);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function removeRules(home: string): void {
  try {
    fs.unlinkSync(overlayPath(home));
  } catch {
    /* already absent */
  }
}

/* -------------------------------------------------------------------------- */
/* Claim accounting snapshot                                                   */
/* -------------------------------------------------------------------------- */

export interface ClaimSnapshot {
  jobState: string;
  jobAttempts: number;
  jobHoldReason: string | null;
  jobLeaseOwner: string | null;
  targetState: string;
  targetAttempts: number;
  targetLeaseOwner: string | null;
  targetRulesHash: string | null;
  checkpointState: string | null;
  failedRanges: number;
  extractionLog: number;
  processedGenerations: number;
  facts: number;
}

export function claimSnapshot(db: Database.Database): ClaimSnapshot {
  const job = db.prepare(
    "SELECT state, attempts, hold_reason, lease_owner, checkpoint_id FROM memory_jobs WHERE kind = 'fact_extract'",
  ).get() as
    | {
        state: string;
        attempts: number;
        hold_reason: string | null;
        lease_owner: string | null;
        checkpoint_id: string | null;
      }
    | undefined;
  const target = db.prepare(
    "SELECT state, attempts, lease_owner, rules_hash FROM extraction_targets",
  ).get() as
    | { state: string; attempts: number; lease_owner: string | null; rules_hash: string | null }
    | undefined;
  const checkpoint = job?.checkpoint_id
    ? (db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = ?").get(job.checkpoint_id) as
        | { state: string }
        | undefined)
    : undefined;
  const count = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
  return {
    jobState: job?.state ?? "none",
    jobAttempts: job?.attempts ?? -1,
    jobHoldReason: job?.hold_reason ?? null,
    jobLeaseOwner: job?.lease_owner ?? null,
    targetState: target?.state ?? "none",
    targetAttempts: target?.attempts ?? -1,
    targetLeaseOwner: target?.lease_owner ?? null,
    targetRulesHash: target?.rules_hash ?? null,
    checkpointState: checkpoint?.state ?? null,
    failedRanges: count("SELECT COUNT(*) AS n FROM extraction_failed_ranges"),
    extractionLog: count("SELECT COUNT(*) AS n FROM extraction_log"),
    processedGenerations: count(
      "SELECT COUNT(*) AS n FROM exchange_extraction_state WHERE state = 'processed'",
    ),
    facts: count("SELECT COUNT(*) AS n FROM facts"),
  };
}

/**
 * The six durable destinations §3.3 enumerates, with this schema's real names.
 *
 * The Chronicle's durable table IS `fact_revisions` (`new_fact` is the event's
 * `newValue`); there is no table called `chronicle_events`. The sixth name is
 * kept and guarded by existence so this list stays readable against the design
 * and keeps working either way.
 */
export const FORBIDDEN_SCAN: ReadonlyArray<{ table: string; columns: string[] }> = [
  { table: "facts", columns: ["fact", "fact_kr", "subject_key"] },
  {
    table: "fact_revisions",
    columns: [
      "previous_fact",
      "new_fact",
      "subject_key",
      "problem",
      "grounded_cause",
      "rationale",
      "classifier_note",
      "outcome_json",
    ],
  },
  {
    table: "incident_signatures",
    columns: ["signature_text", "signature_key", "remediation_summary"],
  },
  { table: "incident_occurrences", columns: ["signature_text", "subject_key"] },
  { table: "chronicle_events", columns: ["new_value", "previous_value", "subject_key"] },
  { table: "fact_evidence_receipts", columns: ["source_snapshot_json", "fact_hash"] },
];

/**
 * Tables that legitimately hold the raw conversation.
 *
 * The rule forbids DERIVED memory, not the archive: the operator's own sentence
 * is in `exchanges` because they typed it, and a "never extract" rule that
 * deleted their transcript would be a different and much worse feature.
 */
const SOURCE_TABLES = [
  "exchanges",
  "tool_calls",
  "conversation_files",
  "exchange_extraction_state",
  "extraction_target_items",
];

/** `exchanges`, and also `exchanges_fts`, `exchanges_fts_data`, … */
function isSourceTable(table: string): boolean {
  return SOURCE_TABLES.some((source) => table === source || table.startsWith(`${source}_`));
}

function likeHits(db: Database.Database, table: string, columns: string[], needle: string): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const usable = columns.filter((column) => present.has(column));
  if (usable.length === 0) return false;
  const where = usable.map((column) => `IFNULL("${column}", '') LIKE ?`).join(" OR ");
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${where}`).get(
    ...usable.map(() => `%${needle}%`),
  ) as { n: number };
  return Number(row.n) > 0;
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/** Returns the named destinations that contain `needle`. Empty is the assertion. */
export function scanForForbidden(db: Database.Database, needle: string): string[] {
  const hits: string[] = [];
  for (const { table, columns } of FORBIDDEN_SCAN) {
    if (!tableExists(db, table)) continue;
    if (likeHits(db, table, columns, needle)) hits.push(table);
  }
  return hits;
}

/**
 * The same question asked the strongest way: EVERY text column of EVERY table
 * except the conversation archive itself.
 *
 * Strictly stronger than the named list, and it cannot be fooled by a column
 * someone adds or renames later — which is the failure mode a hand-written list
 * has.
 */
export function scanWholeDatabase(db: Database.Database, needle: string): string[] {
  const hits: string[] = [];
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  for (const table of tables) {
    if (isSourceTable(table)) continue;
    let columns: Array<{ name: string; type: string }>;
    try {
      columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
        type: string;
      }>;
    } catch {
      continue; // virtual/shadow table without a readable shape
    }
    const textColumns = columns
      .filter((column) => /TEXT|CHAR|CLOB|JSON|^$/i.test(column.type ?? ""))
      .map((column) => column.name);
    if (textColumns.length === 0) continue;
    try {
      if (likeHits(db, table, textColumns, needle)) hits.push(table);
    } catch {
      continue; // a virtual table that refuses a plain scan
    }
  }
  return hits;
}
