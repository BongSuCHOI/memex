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

function showHelp() {
  console.log(`memex - Collect, connect, and retrieve knowledge from Codex conversations

USAGE:
  memex <command> [options]

COMMANDS:
  setup       Detect conflicting Codex built-in Memory and disable it only with approval
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
  backfill    Run extract/ontology/embeddings backlog explicitly ('all' runs each stage in order)
  facts       Manage extracted facts: list|show|edit|deactivate|restore|history|explain|delete

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

async function main() {
  try {
    const distDir = join(__dirname, "../dist");

    switch (command) {
      case "setup":
        await runScript(
          join(__dirname, "..", "scripts", "setup-memex.js"),
          args,
        );
        break;

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
            const r = fm.restoreFact(db, id);
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
            console.log(`(${revs.length} revisions)`);
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
          } else {
            console.error(
              "Usage: memex facts <list|show|edit|deactivate|restore|history|delete> [--id <uuid>] ...",
            );
            process.exitCode = 1;
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
        if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
          console.log(`Usage: memex status [--json]

Show read-only conversation, fact, and graph pipeline readiness.

Options:
  --json  Print the same pipeline counters as JSON`);
          break;
        }
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

      case "backfill": {
        // Explicit, user-invoked. Never auto-started by status.
        // Foreground is the default so completion is directly observable;
        // pass --background to detach instead. (--foreground is accepted as a
        // deprecated no-op for pre-v0.2 scripts.)
        const target = args.find((a) => !a.startsWith("-"));
        const background = args.includes("--background");
        if (
          !target ||
          !["all", "extract", "ontology", "embeddings"].includes(target)
        ) {
          console.error(
            "Usage: memex backfill <all|extract|ontology|embeddings> [--background]",
          );
          process.exitCode = 1;
          break;
        }
        const scriptMap = {
          extract: "backfill-extract-worker.js",
          ontology: "backfill-ontology-worker.js",
          embeddings: "reembed-worker.js",
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
          if (!process.exitCode && target === "all") {
            console.log("All backfill stages completed.");
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
