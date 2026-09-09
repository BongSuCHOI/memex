#!/usr/bin/env node
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { realpathSync, existsSync as fsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(realpathSync(__filename));

const command = process.argv[2];
const args = process.argv.slice(3);

function runScript(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to run command: ${err.message}`));
    });
  });
}

function remainingBackfillWork(status, targets) {
  const deferred = Object.fromEntries(
    targets.map((target) => [target, status.stages[target]]),
  );
  const active = targets.includes("extract") ? status.active.extract : 0;
  const unresolved = targets.includes("extract")
    ? status.unresolved.extract
    : 0;
  return {
    deferred,
    deferredTotal: Object.values(deferred).reduce(
      (sum, count) => sum + count,
      0,
    ),
    active,
    unresolved,
  };
}

function formatStageCounts(counts) {
  return Object.entries(counts)
    .map(([stage, count]) => `${stage}=${count}`)
    .join(", ");
}

function showHelp() {
  console.log(`memex - Collect, connect, and retrieve knowledge from Codex conversations

USAGE:
  memex <command> [options]

COMMANDS:
  setup       Detect conflicting Codex built-in Memory and disable it only with approval
  install     Register the plugin and materialize its runtime dependencies (idempotent)
  deps        Materialize runtime dependencies into the installed plugin root: materialize
  sync        Sync conversations from Codex session rollouts and index them
  update      Refresh the marketplace and reinstall the latest Memex plugin
  index       Index conversations for search
  search      Search indexed conversations
  show        Display a conversation in readable format
  stats       Show index statistics
  analyze     Analyze full conversation history (coverage, projects, facts)
  setup-hooks Register Memex lifecycle hooks in $CODEX_HOME/hooks.json
  remove-hooks Remove only Memex-owned lifecycle hook entries
  doctor      Diagnose dependency/build/lifecycle configuration (read-only)
  migrate-projects  Re-derive project identity from cwd evidence (CX-02 migration)
  home        Print the resolved Memex data root (read-only)
  status      Show pipeline readiness per stage (read-only)
  jobs        Inspect and recover memory jobs: list|show|retry|dismiss
  recover     Reset terminal (dead) work back to claimable in one transaction
  model-work  Inspect durable model-work budgets or explicitly resume one
  backfill    Run extract/ontology/embeddings/receipts backlog explicitly ('all' runs each stage in order)
  facts       Manage extracted facts: list|show|edit|deactivate|restore|history|explain|tier|promote|demote|migrate-tiers|delete
  ontology    Inspect and repair the local taxonomy: list|merge|rename

Run 'memex <command> --help' for command-specific help.

EXAMPLES:
  # Index all conversations
  memex index --cleanup

  # Search for something
  memex search "React Router auth"

  # Display a conversation
  memex show path/to/conversation.jsonl

  # Generate HTML output
  memex show --format html conversation.jsonl > output.html`);
}

const MODEL_WORK_USAGE = `Usage:
  memex model-work status [budget-id] [--json]
  memex model-work resume <budget-id> --new-run [options]

status is read-only and reports parent wave, stage/job/target attempts, and
pending work. resume requires --new-run; it creates a fresh budget while
preserving the exhausted run's attempt ledger and rebinds only lease-free
pending jobs.

resume options:
  --wave-id <id>            Distinct parent wave for the new run
  --max-attempts <n>        Attempt cap for the new run
  --max-input-chars <n>     Input character cap for the new run
  --max-output-chars <n>    Output character cap for the new run
  --deadline-at <ISO>       Absolute deadline for the new run
  --json                    Print machine-readable output`;

/**
 * Issue #36 — `--help` on a side-effecting command used to do the work.
 *
 * `memex update --help` reinstalled the plugin, `memex setup-hooks --help`
 * wrote $CODEX_HOME/hooks.json, `memex remove-hooks --help` removed entries and
 * `memex migrate-projects --help` rewrote exchanges/facts/archive_paths —
 * because each decided dry-run purely from `args.includes('--dry-run')` and
 * never looked at `--help`, while the top-level help actively told users to
 * type it.
 *
 * The guard is default-deny: every known subcommand is intercepted before its
 * case runs. A command with a richer help text delegates to the script that
 * owns it, invoked with `--help` and nothing else; every other command answers
 * from this table. A subcommand added later is protected without remembering
 * anything, which is the point.
 */
const HELP_DELEGATES = {
  setup: (dist) => join(dist, "..", "scripts", "setup-memex.js"),
  index: () => join(__dirname, "index-conversations.js"),
  search: (dist) => join(dist, "search-cli.js"),
  show: (dist) => join(dist, "show-cli.js"),
  stats: (dist) => join(dist, "stats-cli.js"),
  analyze: (dist) => join(dist, "analyze-cli.js"),
  sync: (dist) => join(dist, "sync-cli.js"),
};

const COMMAND_USAGE = {
  install: `Usage: memex install [--dry-run] [--marketplace <source>] [--plugin-root <path>] [--root <path>]

Register the Memex plugin with Codex and materialize its runtime dependencies
into the installed plugin cache. Idempotent.
--plugin-root is the SOURCE checkout; --root is the installed plugin root to
materialize into (default: the Codex cache identity, same as 'memex doctor').
When the source checkout has a production dependency closure it is copied (no
network, no version resolution); otherwise the installed root runs
'npm install --omit=dev --no-audit --no-fund' (issue #53).`,
  deps: `Usage: memex deps materialize [--root <path>] [--dry-run] [--force] [--json]

Install the production runtime dependencies into the INSTALLED plugin root
(resolved exactly as 'memex doctor' resolves it: MEMEX_PLUGIN_ROOT, then the
$CODEX_HOME plugin cache, then 'codex plugin list --json', then this launcher).
Without them every Codex hook silently falls back to
'npx github:BongSuCHOI/memex#main' — an unpinned revision.

Runs: npm install --omit=dev --no-audit --no-fund
Touches nothing else: no marketplace, plugin registry, hook file, or data root.`,
  update: `Usage: memex update [--dry-run] [--marketplace <name>] [--no-materialize]

Refresh the Memex marketplace entry and reinstall the plugin, preserving the
Memex data root. --dry-run performs read-only discovery only.
--marketplace selects one install when Memex is registered more than once.
After a successful reinstall the runtime dependencies are materialized into the
new plugin root (issue #53); --no-materialize prints that command instead.`,
  "setup-hooks": `Usage: memex setup-hooks [--dry-run]

Register Memex lifecycle hooks in $CODEX_HOME/hooks.json. Foreign entries are
preserved byte-for-byte and re-running is an idempotent no-op.
--dry-run prints the exact diff without writing anything.`,
  "remove-hooks": `Usage: memex remove-hooks [--dry-run]

Remove only Memex-owned lifecycle hook entries. The Memex data root and the
Codex session rollouts are never touched.
--dry-run prints what would be removed without writing anything.`,
  doctor: `Usage: memex doctor [--json]

Read-only diagnosis of dependencies, build, Codex home, lifecycle registration,
observed hook events, injection output, recall provenance, and sync export.
Exits 1 when any check fails.`,
  "migrate-projects": `Usage: memex migrate-projects [--dry-run]

Re-derive project identity from cwd evidence (CX-02). Rewrites exchanges, facts
and archive_paths and writes a backup first. Exchanges with no cwd evidence are
reported as ambiguous and are never moved.
--dry-run prints the plan without writing anything.`,
  home: `Usage: memex home [--json]

Print the resolved Memex data root (read-only). Use this before deleting or
moving Memex data.`,
  status: `Usage: memex status [--json]

Show read-only conversation, fact, and graph pipeline readiness.

Options:
  --json  Print the same pipeline counters as JSON`,
  jobs: `Usage:
  memex jobs list [--state dead|retry|running|pending|all] [--kind <kind>] [--limit <n>] [--json]
  memex jobs show <job-id> [--json]
  memex jobs retry <job-id|--all-dead> [--kind <kind>] [--dry-run] [--json]
  memex jobs dismiss <job-id> --reason "<why>" [--json]

list and show are read-only. retry is the same recovery as 'memex recover': it
resets the whole terminal unit (job, checkpoint, capsule state, extraction
target/items/ranges) in one transaction, sets the job pending with attempts 0
and a cleared lease, and preserves the cleared failure in retry_history.
dismiss retires a job as 'superseded' with
last_error = 'user dismissed: <reason>' and one audit line. Nothing is deleted.`,
  recover: `Usage: memex recover <job-id|target-id|--all-dead> [--kind <kind>] [--dry-run] [--json]

Reset terminal (dead) Continuity work back to claimable, resetting memory_jobs,
checkpoints, capsule_checkpoint_state, extraction_targets,
extraction_target_items, exchange_extraction_state and extraction_failed_ranges
in ONE transaction — the same unit that was made terminal together.

--dry-run reports exactly what would be reset and writes nothing.
Run the worker afterwards: memex-continuity-worker / memex backfill extract.`,
  "model-work": MODEL_WORK_USAGE,
  backfill: `Usage: memex backfill <all|extract|ontology|embeddings|receipts> [--background]

Run backlog work explicitly; never auto-started by status. 'all' runs each stage
in order and stops at the first failure. Foreground is the default; exit 2 means
the run completed with outstanding work.

receipts rebuilds missing local meaning-evidence receipts
(fact_evidence_receipts) for facts whose source exchanges all still resolve.
It is model-free. Facts without a receipt are excluded from automatic
consolidation; 'memex status' counts them.`,
  ontology: `Usage:
  memex ontology list [--json]
  memex ontology merge <from-category-id> <to-category-id> [--dry-run] [--json]
  memex ontology rename <category-id> "<new name>" [--json]

Repair the LOCAL ontology overlay. Before 0.6.1 the taxonomy was append-only:
near-duplicate categories ("Auth" / "Authentication" / "AuthN") could only be
removed by wiping the whole ontology.

merge re-points every fact under <from-category-id> to <to-category-id> and
deletes the source category and its vector. rename changes one category's label
and invalidates its vector (rebuilt by 'memex backfill embeddings').

Neither touches fact meaning: no Chronicle event, no semantic/lifecycle
generation bump, no attempt-ledger reset and no taxonomy-epoch bump. Each
writes one metadata-only line to logs/ui-audit.jsonl.`,
  facts: `Usage: memex facts <list|show|edit|deactivate|restore|history|explain|tier|promote|demote|migrate-tiers|delete> [options]

  list        [--project <p>] [--scope global|all] [--all] [--limit n] [--offset n]
  show        --id <uuid>
  edit        --id <uuid> --text "new text" [--reason "why"] [--source-exchange <id>]
  deactivate  --id <uuid>
  restore     --id <uuid>
  history     --id <uuid> | --subject <subject_key> --project-id <project_id>
  explain     (alias of history)
  tier        <id> [--json]
  promote     <id> [--to workstream|project|global] [--reason "why"] [--json]
  demote      <id> [--to workstream|project|global] [--reason "why"] [--json]
  migrate-tiers --dry-run | --apply [--json]
  delete      --id <full-uuid> --hard --yes   (default delete is deactivate)

The tier ladder is workstream <-> project <-> global and moves ONE rung at a
time; a skipped rung is refused. promote/demote by a user are recorded as
Chronicle PROMOTED/DEMOTED plus one metadata line in logs/ui-audit.jsonl.
migrate-tiers needs --dry-run or --apply explicitly: it lists (or moves) the
pre-0.6.0 workstream facts that the branch-signal rule makes project-common.`,
};

const KNOWN_COMMANDS = new Set([
  ...Object.keys(HELP_DELEGATES),
  ...Object.keys(COMMAND_USAGE),
]);

async function printCommandUsage(command, distDir) {
  const delegate = HELP_DELEGATES[command];
  if (delegate) {
    // Only the help flag is forwarded, so the delegate cannot do work.
    await runScript(delegate(distDir), ["--help"]);
    return;
  }
  console.log(COMMAND_USAGE[command] ?? "");
}

async function main() {
  try {
    const distDir = join(__dirname, "../dist");

    // Issue #36: help never runs the command. Checked before the dispatch so a
    // subcommand added later cannot reintroduce the regression.
    if (
      KNOWN_COMMANDS.has(command) &&
      (args.includes("--help") || args.includes("-h"))
    ) {
      await printCommandUsage(command, distDir);
      process.exitCode = 0;
      return;
    }

    switch (command) {
      case "setup":
        await runScript(
          join(__dirname, "..", "scripts", "setup-memex.js"),
          args,
        );
        break;

      // Issue #40: `memex doctor` and the runtime launcher both point here when
      // an installed plugin has no materialized dependencies. The command has
      // to exist for that instruction to be true.
      case "install":
        await runScript(
          join(__dirname, "..", "scripts", "install-memex.mjs"),
          args,
        );
        break;

      // Issue #53: the executable form of doctor's advice. `memex install`
      // needs a registered marketplace; this only needs the installed root.
      case "deps": {
        const sub = args.find((a) => !a.startsWith("-"));
        if (sub !== undefined && sub !== "materialize") {
          console.error("Usage: memex deps materialize [--root <path>] [--dry-run] [--force] [--json]");
          process.exitCode = 1;
          break;
        }
        await runScript(
          join(__dirname, "..", "scripts", "materialize-deps.mjs"),
          args.filter((a) => a !== "materialize"),
        );
        break;
      }

      case "index":
        await runScript(join(__dirname, "index-conversations.js"), args);
        break;

      case "search":
        await runScript(join(distDir, "search-cli.js"), args);
        break;

      case "show":
        await runScript(join(distDir, "show-cli.js"), args);
        break;

      case "stats":
        await runScript(join(distDir, "stats-cli.js"), args);
        break;

      case "analyze":
        await runScript(join(distDir, "analyze-cli.js"), args);
        break;

      case "sync":
        await runScript(join(distDir, "sync-cli.js"), args);
        break;
      case "update":
        await runScript(
          join(__dirname, "..", "scripts", "update-plugin.js"),
          args,
        );
        break;
      case "setup-hooks": {
        const { setupHooks } = await import(join(distDir, "lifecycle.js"));
        const dryRun = args.includes("--dry-run");
        const result = setupHooks({ dryRun });
        console.log(`Target: ${result.diff.targetFile}`);
        for (const a of result.diff.add)
          console.log(`Add: ${a.event} -> ${a.command}`);
        if (result.diff.staleOwnedEntries > 0) {
          console.log(
            `Stale Memex entries detected: ${result.diff.staleOwnedEntries} (re-run setup to repair paths)`,
          );
        }
        console.log(
          `Existing non-Memex entries preserved: ${result.diff.preservedForeignEntries}`,
        );
        if (dryRun) {
          console.log("No files changed.");
        } else {
          console.log(
            result.changed
              ? "Lifecycle configured."
              : "Lifecycle already up to date (idempotent no-op).",
          );
          console.log(`Ownership record: ${result.registrationPath}`);
        }
        break;
      }

      case "remove-hooks": {
        const { removeHooks } = await import(join(distDir, "lifecycle.js"));
        const dryRun = args.includes("--dry-run");
        const result = removeHooks({ dryRun });
        console.log(
          `${dryRun ? "[dry-run] Would remove" : "Removed"}: ${result.removed} Memex hook entr${result.removed === 1 ? "y" : "ies"}`,
        );
        console.log(
          `Non-Memex entries preserved: ${result.preservedForeignEntries}`,
        );
        if (!dryRun)
          console.log("Memex data root and Codex rollouts untouched.");
        break;
      }

      case "doctor": {
        const { doctor } = await import(join(distDir, "lifecycle.js"));
        const report = doctor();
        if (args.includes("--json")) {
          console.log(
            JSON.stringify(
              { overall: report.overall, checks: report.json },
              null,
              2,
            ),
          );
        } else {
          for (const c of report.json)
            console.log(
              `${c.status.toUpperCase().padEnd(5)} ${c.name}: ${c.detail}`,
            );
          console.log(`Overall: ${report.overall}`);
        }
        process.exitCode = report.overall === "FAIL" ? 1 : 0;
        break;
      }

      case "migrate-projects": {
        const Database = (await import("better-sqlite3")).default;
        const { getDbPath } = await import(join(distDir, "paths.js"));
        const { planMigration, applyMigration } = await import(
          join(distDir, "project-migration.js")
        );
        const dbPath = getDbPath();
        if (!fsSync(dbPath)) {
          console.error(`No database at ${dbPath} — nothing to migrate.`);
          break;
        }
        const db = new Database(dbPath);
        const dryRun = args.includes("--dry-run");
        const plan = planMigration(db);
        console.log(`Database: ${dbPath}`);
        console.log(
          `Exchanges: ${plan.totalExchanges} total / ${plan.alreadyCanonical} already canonical`,
        );
        console.log(`Movable (cwd evidence): ${plan.movable.length}`);
        console.log(
          `Ambiguous (no cwd evidence, NOT moved): ${plan.ambiguous.length}`,
        );
        console.log(
          `Facts to re-scope (lexical normalization only): ${plan.factsRescope.length}`,
        );
        for (const a of plan.ambiguous.slice(0, 10)) {
          console.log(
            `  ambiguous exchange ${a.id}: project=${a.project} (${a.reason}) — recover by re-sync from source rollout`,
          );
        }
        if (plan.movable.length > 0) {
          const sample = plan.movable[0];
          console.log(
            `  e.g. exchange ${sample.id}: ${sample.from} -> ${sample.to}`,
          );
        }
        if (dryRun) {
          console.log("Dry run — no changes written.");
        } else {
          const result = applyMigration(db, dbPath);
          console.log(
            `Applied: exchanges=${result.exchangesUpdated} facts=${result.factsUpdated} archive_paths=${result.archivePathsUpdated}`,
          );
          console.log(`Counts verified: ${result.countsVerified}`);
          console.log(`Backup: ${result.backupPath}`);
        }
        db.close();
        break;
      }

      case "facts": {
        const fm = await import(join(distDir, "fact-management.js"));
        const { initDatabase } = await import(join(distDir, "db.js"));
        const sub = args.find((a) => !a.startsWith("-"));
        const rest = args.slice(args.indexOf(sub) + 1);
        const flag = (name) => rest.includes(name);
        const optValue = (name) => {
          const i = rest.indexOf(name);
          return i >= 0 ? rest[i + 1] : undefined;
        };
        const db = initDatabase();
        try {
          if (sub === "list") {
            const scope = optValue("--scope") || "global";
            if (!["global", "all"].includes(scope))
              throw new Error("usage: --scope global|all");
            const rows = fm.listFacts(db, {
              project: optValue("--project"),
              scope,
              includeInactive: flag("--all"),
              limit: parseInt(optValue("--limit") || "50"),
              offset: parseInt(optValue("--offset") || "0"),
            });
            for (const r of rows) {
              console.log(
                `${r.is_active ? "active  " : "inactive"} ${r.id}  [${r.category}] ${String(r.fact).slice(0, 90)}${String(r.fact).length > 90 ? "…" : ""}`,
              );
            }
            console.log(`(${rows.length} facts)`);
          } else if (sub === "show") {
            const id = optValue("--id");
            if (!id) throw new Error("usage: memex facts show --id <uuid>");
            const detail = fm.showFact(db, id);
            if (!detail) throw new Error(`fact not found: ${id}`);
            console.log(JSON.stringify(detail, null, 2));
          } else if (sub === "edit") {
            const id = optValue("--id"),
              text = optValue("--text");
            if (!id || !text)
              throw new Error(
                'usage: memex facts edit --id <uuid> --text "new text" [--reason "why"]',
              );
            const r = await fm.editFact(db, id, {
              text,
              reason: optValue("--reason"),
              sourceExchangeId: optValue("--source-exchange"),
            });
            console.log(
              `Updated: 1\nRevision: created (${r.revisionId})\nEmbedding: ${r.embeddingRefreshed ? "refreshed" : "vector table unavailable"}\nOntology: pending reclassification\nRelations referencing this fact: ${r.affectedRelations}`,
            );
          } else if (sub === "deactivate") {
            const id = optValue("--id");
            if (!id)
              throw new Error("usage: memex facts deactivate --id <uuid>");
            const r = fm.deactivateFactTransactional(db, id);
            console.log(
              `Deactivated: ${id}\nRemoved from vector index: ${r.removedFromVectorIndex}`,
            );
          } else if (sub === "restore") {
            const id = optValue("--id");
            if (!id) throw new Error("usage: memex facts restore --id <uuid>");
            const r = await fm.restoreFact(db, id);
            console.log(
              `Restored: ${id}\nVector restored: ${r.vectorRestored}`,
            );
          } else if (sub === "history" || sub === "explain") {
            const id = optValue("--id");
            const subject = optValue("--subject");
            const projectId = optValue("--project-id");
            if (!id && !(subject && projectId)) {
              throw new Error("usage: memex facts history --id <uuid> | --subject <subject_key> --project-id <project_id>");
            }
            const chronicle = await import(join(distDir, "chronicle.js"));
            const events = id
              ? fm.factHistory(db, id)
              : chronicle.readChronicleTimeline(db, { projectId, subjectKey: subject, order: "asc", limit: 100 }).events;
            if (events.length === 0) console.log("No Chronicle events.");
            for (const ev of events) {
              console.log(chronicle.formatChronicleEvent(db, ev, { includeSources: false }));
            }
            console.log(`(${events.length} Chronicle events)`);
          } else if (sub === "delete") {
            const id = optValue("--id");
            if (!id)
              throw new Error(
                "usage: memex facts delete --id <full-uuid> --hard --yes",
              );
            if (!flag("--hard")) {
              console.error(
                "Default delete is deactivate. For permanent deletion use: delete --id <uuid> --hard --yes",
              );
              process.exitCode = 1;
              break;
            }
            const impact = fm.hardDeleteImpact(db, id);
            if (!impact.exists) throw new Error(`fact not found: ${id}`);
            console.log(
              `Impact: revisions=${impact.revisions} relations=${impact.relations} vectors=1`,
            );
            if (!flag("--yes")) {
              console.error(
                "Refusing to hard delete without --yes. Deactivate is the default safe delete.",
              );
              process.exitCode = 1;
              break;
            }
            const r = fm.hardDeleteFact(db, id, { confirm: true });
            console.log(
              `Deleted: ${id} (revisions=${r.impact.revisions}, relations=${r.impact.relations})`,
            );
          // --- 0.6.0 tier ladder (#18/#19) ---------------------------------
          } else if (sub === "tier") {
            const id = rest.find((a) => !a.startsWith("-")) || optValue("--id");
            if (!id) throw new Error("usage: memex facts tier <id> [--json]");
            const state = fm.readFactTier(db, id);
            if (flag("--json")) {
              console.log(JSON.stringify(state, null, 2));
            } else {
              console.log(
                `${state.id}\ntier: ${state.tier} (promotion_state=${state.promotionState}, scope_type=${state.scopeType})\n` +
                  `project: ${state.projectId ?? "-"}\nworkstream: ${state.workstreamId ?? "-"}\n` +
                  `subject: ${state.subjectKey ?? "-"}\ntier_reason: ${state.tierReason ?? "-"}`,
              );
            }
          } else if (sub === "promote" || sub === "demote") {
            const id = rest.find((a) => !a.startsWith("-")) || optValue("--id");
            if (!id) {
              throw new Error(
                `usage: memex facts ${sub} <id> [--to workstream|project|global] [--reason "why"] [--json]`,
              );
            }
            const move = sub === "promote"
              ? fm.promoteFact(db, id, { actor: "user", reason: optValue("--reason"), to: optValue("--to") })
              : fm.demoteFact(db, id, { actor: "user", reason: optValue("--reason"), to: optValue("--to") });
            if (flag("--json")) {
              console.log(JSON.stringify(move, null, 2));
            } else {
              console.log(
                `${move.id}: ${move.from} → ${move.to} (${move.steps.length} Chronicle event(s): ${move.steps.map((s) => s.eventId).join(", ")})`,
              );
            }
          } else if (sub === "migrate-tiers") {
            const apply = flag("--apply");
            if (!apply && !flag("--dry-run")) {
              throw new Error(
                "usage: memex facts migrate-tiers --dry-run | --apply [--json]",
              );
            }
            const candidates = fm.listTierMigrationCandidates(db);
            const result = apply ? fm.applyTierMigration(db) : null;
            if (flag("--json")) {
              console.log(JSON.stringify({ candidates, applied: result }, null, 2));
            } else if (candidates.length === 0) {
              console.log("No workstream facts would move to project-common.");
            } else {
              for (const c of candidates) {
                console.log(
                  `${c.id}  [${c.tierReason}] ${String(c.fact).slice(0, 80)}${String(c.fact).length > 80 ? "…" : ""}`,
                );
              }
              console.log(
                apply
                  ? `Promoted ${result.promoted.length} fact(s) to project-current; skipped ${result.skipped.length}.`
                  : `${candidates.length} fact(s) would move workstream → project-current. Re-run with --apply.`,
              );
              for (const s of result?.skipped ?? []) console.error(`skipped ${s.id}: ${s.reason}`);
            }
          // --- end 0.6.0 tier ladder ---------------------------------------
          } else {
            console.error(
              "Usage: memex facts <list|show|edit|deactivate|restore|history|tier|promote|demote|migrate-tiers|delete> [--id <uuid>] ...",
            );
            process.exitCode = 1;
          }
        } finally {
          db.close();
        }
        break;
      }

      // Issue #47: the taxonomy used to be append-only — no merge, no rename,
      // no delete. Near-duplicate categories could only be fixed by wiping the
      // whole ontology. Both operations are local-derived overlay edits: fact
      // meaning is untouched, so there is no Chronicle event and no generation
      // bump, only one metadata line in logs/ui-audit.jsonl.
      case "ontology": {
        const { initDatabase } = await import(join(distDir, "db.js"));
        const { mergeCategories, renameCategory } = await import(
          join(distDir, "ontology-admin.js")
        );
        const { listCategories, listDomains } = await import(
          join(distDir, "ontology-db.js")
        );
        const json = args.includes("--json");
        const dryRun = args.includes("--dry-run");
        const positional = args.filter((a) => !a.startsWith("-"));
        const sub = positional[0];
        if (!["list", "merge", "rename"].includes(sub ?? "")) {
          console.error(COMMAND_USAGE.ontology);
          process.exitCode = 1;
          break;
        }
        const db = initDatabase();
        try {
          if (sub === "list") {
            const domains = listDomains(db);
            const byDomain = new Map(domains.map((d) => [d.id, d.name]));
            const categories = listCategories(db);
            if (json) {
              console.log(
                JSON.stringify(
                  categories.map((c) => ({
                    id: c.id,
                    name: c.name,
                    domain: byDomain.get(c.domain_id) ?? "?",
                    domainId: c.domain_id,
                  })),
                  null,
                  2,
                ),
              );
            } else {
              for (const c of categories) {
                console.log(`${c.id}  ${byDomain.get(c.domain_id) ?? "?"} / ${c.name}`);
              }
              console.log(`(${domains.length} domains, ${categories.length} categories)`);
            }
          } else if (sub === "merge") {
            const [, fromId, toId] = positional;
            if (!fromId || !toId) {
              throw new Error(
                "usage: memex ontology merge <from-category-id> <to-category-id> [--dry-run]",
              );
            }
            const plan = mergeCategories(db, {
              fromCategoryId: fromId,
              toCategoryId: toId,
              dryRun,
            });
            if (json) {
              console.log(JSON.stringify(plan, null, 2));
            } else {
              console.log(
                `${plan.dryRun ? "[dry-run] Would merge" : "Merged"} "${plan.fromName}" (${plan.fromCategoryId}) into "${plan.toName}" (${plan.toCategoryId})`,
              );
              console.log(`Facts re-pointed: ${plan.factsMoved}`);
              if (plan.crossDomain) {
                console.log(
                  "Note: the two categories live under different domains; the facts move to the target's domain.",
                );
              }
              if (!plan.dryRun) {
                console.log(
                  "Fact meaning, attempt ledgers and the taxonomy epoch are unchanged; only the overlay moved.",
                );
              }
            }
          } else {
            const [, id, ...nameParts] = positional;
            const explicitName = (() => {
              const index = args.indexOf("--name");
              return index >= 0 ? args[index + 1] : undefined;
            })();
            const name = explicitName ?? nameParts.join(" ");
            if (!id || !name) {
              throw new Error('usage: memex ontology rename <category-id> "<new name>"');
            }
            const result = renameCategory(db, { categoryId: id, name });
            if (json) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              console.log(
                `Renamed ${result.categoryId}: "${result.previousName}" -> "${result.name}"`,
              );
              console.log(
                "Facts keep their assignment; the category vector was invalidated and is rebuilt by: memex backfill embeddings",
              );
            }
          }
        } finally {
          db.close();
        }
        break;
      }

      // Issues #20/#39: dead work used to be a dead end. `jobs` inspects the
      // queue; `jobs retry` and `recover` are the same one-transaction reset of
      // every table that was made terminal together.
      case "jobs":
      case "recover": {
        const json = args.includes("--json");
        const dryRun = args.includes("--dry-run");
        const allDead = args.includes("--all-dead");
        const valueFlags = new Set(["--state", "--kind", "--limit", "--reason"]);
        const optValue = (name) => {
          const index = args.indexOf(name);
          if (index < 0) return undefined;
          const value = args[index + 1];
          if (value === undefined || value.startsWith("--")) {
            throw new Error(`missing value for ${name}`);
          }
          return value;
        };
        const positional = [];
        for (let i = 0; i < args.length; i++) {
          if (valueFlags.has(args[i])) i++;
          else if (!args[i].startsWith("-")) positional.push(args[i]);
        }
        const sub = command === "recover" ? "recover" : positional[0];
        const id = command === "recover" ? positional[0] : positional[1];
        if (command === "jobs" && !["list", "show", "retry", "dismiss"].includes(sub ?? "")) {
          console.error(
            "Usage: memex jobs <list|show|retry|dismiss> [...] (see: memex jobs --help)",
          );
          process.exitCode = 1;
          break;
        }

        const { getDbPath } = await import(join(distDir, "paths.js"));
        const dbPath = getDbPath();
        if (!fsSync(dbPath)) {
          console.error(`No database at ${dbPath} — nothing to inspect or recover.`);
          process.exitCode = 1;
          break;
        }
        const recovery = await import(join(distDir, "job-recovery.js"));
        const readOnly = sub === "list" || sub === "show";
        let db;
        if (readOnly) {
          const { openReadDb } = await import(join(distDir, "db.js"));
          db = openReadDb(dbPath);
        } else {
          const { initDatabase } = await import(join(distDir, "db.js"));
          db = initDatabase();
        }
        try {
          if (sub === "list") {
            const state = optValue("--state") ?? "all";
            const rows = recovery.listMemoryJobs(db, {
              state,
              kind: optValue("--kind"),
              limit: Number.parseInt(optValue("--limit") ?? "50", 10),
            });
            if (json) {
              console.log(JSON.stringify(rows, null, 2));
            } else {
              for (const row of rows) {
                console.log(
                  `${row.state.padEnd(10)} ${row.kind.padEnd(14)} ${row.jobId}  attempts=${row.attempts}/${row.maxAttempts}  ${row.partitionKey}` +
                    (row.leaseExpired && row.state === "running" ? "  [lease expired]" : ""),
                );
                if (row.lastError) console.log(`    last_error: ${row.lastError.slice(0, 160)}`);
              }
              console.log(`(${rows.length} job${rows.length === 1 ? "" : "s"}${state === "all" ? "" : `, state=${state}`})`);
            }
            break;
          }
          if (sub === "show") {
            if (!id) throw new Error("usage: memex jobs show <job-id> [--json]");
            const detail = recovery.showMemoryJob(db, id);
            if (!detail) throw new Error(`no memory job with id ${id}`);
            console.log(JSON.stringify(detail, null, 2));
            break;
          }
          if (sub === "dismiss") {
            if (!id) throw new Error('usage: memex jobs dismiss <job-id> --reason "why"');
            const reason = optValue("--reason");
            if (!reason) throw new Error('memex jobs dismiss requires --reason "why"');
            const result = recovery.dismissMemoryJob(db, { jobId: id, reason });
            if (json) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              console.log(`Dismissed ${result.jobId} (${result.fromState} -> superseded)`);
              console.log(`Reason recorded in last_error: user dismissed: ${result.reason}`);
              for (const [table, count] of Object.entries(result.reset)) {
                console.log(`  ${table}: ${count}`);
              }
              if (result.auditPath) console.log(`Audit: ${result.auditPath}`);
              console.log("Nothing was deleted. Check the count: memex status");
            }
            break;
          }
          // retry / recover
          if (!id && !allDead) {
            throw new Error(
              command === "recover"
                ? "usage: memex recover <job-id|target-id|--all-dead> [--dry-run]"
                : "usage: memex jobs retry <job-id|--all-dead> [--kind <kind>] [--dry-run]",
            );
          }
          const result = recovery.recoverTerminalWork(db, {
            jobId: id && !allDead ? id : undefined,
            targetId: undefined,
            allDead,
            kind: optValue("--kind"),
            dryRun,
          });
          if (!dryRun) recovery.recordRecoveryAudit(result, `${command} ${sub === "recover" ? "" : sub}`.trim());
          if (json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            const label = dryRun ? "[dry-run] would recover" : "Recovered";
            console.log(`${label}: ${result.entries.length} unit(s)`);
            for (const entry of result.entries) {
              const tables = Object.entries(entry.reset)
                .map(([table, count]) => `${table}=${count}`)
                .join(" ");
              console.log(
                `  ${entry.kind} ${entry.jobId ?? entry.targetId} (${entry.fromState}) ${tables || "no rows"}`,
              );
            }
            for (const note of result.notes) console.log(`  note: ${note}`);
            if (!dryRun && result.entries.length > 0) {
              console.log("Run the worker to drain the recovered work:");
              console.log("  memex-continuity-worker    # or: node scripts/continuity-worker.js");
              console.log("  memex backfill extract     # for fact extraction targets");
            }
          }
        } finally {
          db.close();
        }
        break;
      }

      case "home": {
        // Read-only: print the resolved data root. This is the authoritative
        // answer for uninstall/backup paths that need the EXACT directory.
        const { getMemexHome } = await import(join(distDir, "paths.js"));
        const root = getMemexHome();
        if (args.includes("--json")) {
          console.log(JSON.stringify({ home: root }));
        } else {
          console.log(root);
        }
        break;
      }

      case "status": {
        // --help is handled by the common guard above (issue #36).
        if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
          console.error("Usage: memex status [--json]");
          process.exitCode = 1;
          break;
        }
        const { getPipelineStatus, formatPipelineStatus } = await import(
          join(distDir, "pipeline-status.js")
        );
        const st = getPipelineStatus();
        if (args.includes("--json")) {
          console.log(JSON.stringify(st, null, 2));
        } else {
          console.log(formatPipelineStatus(st));
        }
        break;
      }

      case "model-work": {
        const valueFlags = new Set([
          "--wave-id", "--max-attempts", "--max-input-chars",
          "--max-output-chars", "--deadline-at",
        ]);
        const positional = [];
        for (let i = 0; i < args.length; i++) {
          const arg = args[i];
          if (valueFlags.has(arg)) {
            i++;
          } else if (!arg.startsWith("-")) {
            positional.push(arg);
          }
        }
        const subcommand = positional[0] || "status";
        const json = args.includes("--json");
        const valueFor = (name) => {
          const index = args.indexOf(name);
          if (index < 0) return undefined;
          const value = args[index + 1];
          if (!value || value.startsWith("-"))
            throw new Error(`missing value for ${name}`);
          return value;
        };
        const nonNegative = (name) => {
          const value = valueFor(name);
          if (value === undefined) return undefined;
          if (!/^\d+$/.test(value))
            throw new Error(`${name} must be a non-negative integer`);
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed))
            throw new Error(`${name} is too large`);
          return parsed;
        };
        // Single source with the common --help guard above (issue #36).
        const usage = () => console.log(MODEL_WORK_USAGE);
        if (!["status", "resume"].includes(subcommand)) {
          usage();
          process.exitCode = 1;
          break;
        }

        const { getDbPath } = await import(join(distDir, "paths.js"));
        const dbPath = getDbPath();
        if (subcommand === "status") {
          if (positional.length > 2 || args.some((arg) =>
            arg.startsWith("--") && arg !== "--json")) {
            console.error("Usage: memex model-work status [budget-id] [--json]");
            process.exitCode = 1;
            break;
          }
          const budgetId = positional[1];
          let diagnostics = {
            budgets: [],
            attempts: [],
            pending: [],
            unassigned: [],
            totals: {
              reserved: 0,
              completed: 0,
              failed: 0,
              unknown: 0,
              pending: 0,
              durationMs: null,
              inputChars: null,
              outputChars: null,
              inputTokens: null,
              outputTokens: null,
              cachedInputTokens: null,
              tokenUsageObserved: 0,
              tokenUsagePartial: 0,
              tokenUsageUnknown: 0,
              unassigned: 0,
            },
            stages: [],
          };
          if (fsSync(dbPath)) {
            const { openReadDb } = await import(join(distDir, "db.js"));
            const { getModelWorkDiagnostics, formatModelWorkDiagnostics } =
              await import(join(distDir, "model-budget.js"));
            const db = openReadDb(dbPath);
            try {
              diagnostics = getModelWorkDiagnostics(db, { budgetId });
              if (json) {
                console.log(JSON.stringify({ dbPath, ...diagnostics }, null, 2));
              } else {
                console.log(`Database: ${dbPath}`);
                console.log(formatModelWorkDiagnostics(diagnostics));
              }
            } finally {
              db.close();
            }
          } else if (json) {
            console.log(JSON.stringify({ dbPath, ...diagnostics }, null, 2));
          } else {
            console.log(`Database: ${dbPath}`);
            console.log("No model-work budget rows (database does not exist).");
          }
          break;
        }

        const budgetId = positional[1];
        if (!budgetId || positional.length > 2 || !args.includes("--new-run")) {
          usage();
          process.exitCode = 1;
          break;
        }
        const allowed = new Set([
          "--new-run", "--json", "--wave-id", "--max-attempts",
          "--max-input-chars", "--max-output-chars", "--deadline-at",
        ]);
        if (args.some((arg) => arg.startsWith("--") && !allowed.has(arg))) {
          usage();
          process.exitCode = 1;
          break;
        }
        const { initDatabase } = await import(join(distDir, "db.js"));
        const { startNewModelWorkRunForBudget } = await import(
          join(distDir, "model-budget.js"),
        );
        const db = initDatabase();
        try {
          const limits = {
            maxAttempts: nonNegative("--max-attempts"),
            maxInputChars: nonNegative("--max-input-chars"),
            maxOutputChars: nonNegative("--max-output-chars"),
            deadlineAt: valueFor("--deadline-at"),
          };
          const result = startNewModelWorkRunForBudget(db, {
            budgetId,
            parentWaveId: valueFor("--wave-id"),
            limits,
          });
          const kinds = new Set(
            result.reboundJobIds
              .map((jobId) => db.prepare("SELECT kind FROM memory_jobs WHERE job_id = ?").get(jobId)?.kind)
              .filter(Boolean),
          );
          const env = `MEMEX_MODEL_BUDGET_ID=${result.budget.budgetId} MEMEX_MAINTENANCE_WAVE_ID=${result.budget.parentWaveId}`;
          const workerCommands = [];
          if (kinds.has("fact_extract")) workerCommands.push(`${env} memex backfill extract`);
          if (kinds.has("capsule_update")) workerCommands.push(`${env} memex-continuity-worker`);
          if (workerCommands.length === 0) {
            workerCommands.push(`${env} memex backfill all`);
          }
          const output = {
            previousBudget: result.previousBudget,
            budget: result.budget,
            reboundJobIds: result.reboundJobIds,
            skippedJobIds: result.skippedJobIds,
            workerCommands,
          };
          if (json) {
            console.log(JSON.stringify(output, null, 2));
          } else {
            console.log(`Previous budget: ${result.previousBudget.budgetId} (${result.previousBudget.state})`);
            console.log(`New budget: ${result.budget.budgetId} (wave=${result.budget.parentWaveId})`);
            console.log(`Rebound lease-free jobs: ${result.reboundJobIds.length}`);
            if (result.skippedJobIds.length > 0)
              console.log(`Skipped active/raced jobs: ${result.skippedJobIds.length}`);
            console.log("Run one of:");
            for (const command of workerCommands) console.log(`  ${command}`);
          }
        } finally {
          db.close();
        }
        break;
      }

      case "backfill": {
        // Explicit, user-invoked. Never auto-started by status.
        // Foreground is the default so completion is directly observable;
        // pass --background to detach instead. (--foreground is accepted as a
        // deprecated no-op for pre-v0.2 scripts.)
        const target = args.find((a) => !a.startsWith("-"));
        const background = args.includes("--background");
        if (
          !target ||
          !["all", "extract", "ontology", "embeddings", "receipts"].includes(target)
        ) {
          console.error(
            "Usage: memex backfill <all|extract|ontology|embeddings|receipts> [--background]",
          );
          process.exitCode = 1;
          break;
        }
        const scriptMap = {
          extract: "backfill-extract-worker.js",
          ontology: "backfill-ontology-worker.js",
          embeddings: "reembed-worker.js",
          // Issue #45: model-free, so it runs last and never delays the stages
          // that need the provider.
          receipts: "backfill-receipts-worker.js",
        };
        const targets = target === "all" ? Object.keys(scriptMap) : [target];
        for (const t of targets) {
          const script = join(__dirname, "..", "scripts", scriptMap[t]);
          if (!fsSync(script)) {
            console.error(
              `Worker script missing: ${script} — run npm run build first.`,
            );
            process.exitCode = 1;
            break;
          }
        }
        if (process.exitCode) break;
        if (!background) {
          // Run stages sequentially in this terminal, stopping at the first
          // failure so each stage's ledger/idempotency state stays coherent.
          for (const t of targets) {
            console.log(`Running ${t} backfill in foreground...`);
            try {
              await runScript(
                join(__dirname, "..", "scripts", scriptMap[t]),
                [],
              );
            } catch {
              if (target === "all") {
                console.error(
                  `${t} backfill failed; remaining stages were not started. Re-run 'memex backfill all' to resume (stages are idempotent).`,
                );
              } else {
                console.error(`${t} backfill failed.`);
              }
              process.exitCode = 1;
              break;
            }
          }
          if (!process.exitCode) {
            const { getBackfillWorkStatus } = await import(
              join(distDir, "backfill-status.js")
            );
            const remaining = remainingBackfillWork(
              getBackfillWorkStatus(),
              targets,
            );
            if (
              remaining.deferredTotal > 0 ||
              remaining.active > 0 ||
              remaining.unresolved > 0
            ) {
              if (remaining.active === 0 && remaining.unresolved === 0) {
                console.log(
                  `Backfill completed with deferred work: ${remaining.deferredTotal} item(s) remain (${formatStageCounts(remaining.deferred)}).`,
                );
              } else {
                const parts = [];
                if (remaining.deferredTotal > 0)
                  parts.push(
                    `deferred=${remaining.deferredTotal} (${formatStageCounts(remaining.deferred)})`,
                  );
                if (remaining.active > 0)
                  parts.push(`active extract=${remaining.active}`);
                if (remaining.unresolved > 0)
                  parts.push(`unresolved extract=${remaining.unresolved}`);
                console.log(
                  `Backfill completed with outstanding work: ${parts.join("; ")}.`,
                );
              }
              console.log("Check progress: memex status");
              process.exitCode = 2;
            } else if (target === "all") {
              console.log("All backfill stages completed; no outstanding work remains.");
            } else {
              console.log(`${target} backfill completed; no outstanding work remains.`);
            }
          }
          break;
        }
        const { spawn: spawnBg } = await import("child_process");
        // For 'all', detach a copy of this CLI in orchestrator mode; it takes
        // the sequential foreground path above (its output is discarded).
        const bgChildArgs =
          target === "all"
            ? [process.execPath, __filename, "backfill", "all"]
            : [
                process.execPath,
                join(__dirname, "..", "scripts", scriptMap[target]),
              ];
        const child = spawnBg(bgChildArgs[0], bgChildArgs.slice(1), {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        console.log(
          `${target} backfill started in background (pid ${child.pid}). Check progress: memex status`,
        );
        break;
      }

      case "--help":
      case "-h":
      case undefined:
        showHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Try: memex --help");
        process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});
