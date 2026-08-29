import fs from "fs";
import path from "path";
import { parseConversation } from "./parser.js";
import { initDatabase, getAllExchanges, getFileLastIndexed } from "./db.js";
import { getArchiveDir, getDbPath, getExcludedProjects, isExcludedProject, } from "./paths.js";
import { archiveFileExists, canonicalArchiveName, statArchiveFile, } from "./archive-io.js";
import { readRolloutMeta } from "./codex-rollout.js";
import { canonicalizeProjectPath, UNKNOWN_PROJECT, } from "./project-identity.js";
import { getConversationEligibility, purgeConversationFromIndex, } from "./conversation-policy.js";
/**
 * FK violations are a database-file property, independent of the archive
 * tree — audit them even when the archive dir is absent. FK enforcement is
 * ON on every Memex connection (explicit pragma in initializeConnection), so
 * violations can only predate Memex (foreign tooling, direct sqlite3 edits,
 * or a pre-FK legacy file); PRAGMA foreign_key_check finds them all.
 */
function collectForeignKeyViolations() {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath))
        return [];
    const db = initDatabase();
    try {
        return db.pragma("foreign_key_check");
    }
    finally {
        db.close();
    }
}
/**
 * Repair pass for FK violations: orphaned child rows are derived local data
 * whose parent is gone, so removing them is the only safe repair. The three
 * tables below are the schema's fact/exchange FK children; anything else is
 * reported for manual review, never touched blindly. Returns the removed
 * count.
 */
export function repairForeignKeyViolations(db, violations) {
    let removed = 0;
    for (const v of violations) {
        if (v.table !== "tool_calls" &&
            v.table !== "fact_revisions" &&
            v.table !== "ontology_relations") {
            console.log(`  Unhandled FK child table ${v.table} (rowid=${v.rowid}, parent=${v.parent}) — manual review needed`);
            continue;
        }
        db.prepare(`DELETE FROM ${v.table} WHERE rowid = ?`).run(v.rowid);
        removed++;
        console.log(`  Removed orphaned ${v.table} rowid=${v.rowid} (parent ${v.parent} missing)`);
    }
    return removed;
}
export async function verifyIndex() {
    const result = {
        missing: [],
        orphaned: [],
        outdated: [],
        corrupted: [],
        fkViolations: [],
    };
    result.fkViolations = collectForeignKeyViolations();
    const archiveDir = getArchiveDir();
    // Track all files we find
    const foundFiles = new Set();
    // Find all conversation files
    if (!fs.existsSync(archiveDir)) {
        return result;
    }
    // Initialize database once for all checks
    const db = initDatabase();
    const projects = fs.readdirSync(archiveDir);
    const excludedProjects = getExcludedProjects();
    let totalChecked = 0;
    for (const project of projects) {
        // Historical archives may still use a plain project directory name.
        // Per-file canonical policy below handles current collision-free keys.
        if (isExcludedProject(project, excludedProjects)) {
            console.log("\nSkipping excluded project: " + project);
            continue;
        }
        const projectPath = path.join(archiveDir, project);
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory())
            continue;
        // Archive files may be compressed out-of-band (.jsonl.zst) — canonicalize
        // to the .jsonl name the database stores.
        const files = [
            ...new Set(fs
                .readdirSync(projectPath)
                .filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.zst"))
                .map((f) => canonicalArchiveName(f))),
        ];
        for (const file of files) {
            totalChecked++;
            if (totalChecked % 100 === 0) {
                console.log(`  Checked ${totalChecked} conversations...`);
            }
            const conversationPath = path.join(projectPath, file);
            const { meta, isSubagent } = await readRolloutMeta(conversationPath);
            const cwd = meta && typeof meta.cwd === "string" ? meta.cwd : "";
            const canonicalProject = cwd
                ? canonicalizeProjectPath(cwd)
                : UNKNOWN_PROJECT;
            const eligibility = await getConversationEligibility({
                filePath: conversationPath,
                project: canonicalProject,
                isSubagent,
                excludedProjects,
            });
            if (!eligibility.eligible) {
                // Verification remains read-only. Ineligible archives are not summary
                // defects; ingestion/reindex entrypoints own conversation-wide purge.
                foundFiles.add(conversationPath);
                continue;
            }
            foundFiles.add(conversationPath);
            const summaryPath = conversationPath.replace(".jsonl", "-summary.txt");
            // Check for missing summary
            if (!archiveFileExists(summaryPath)) {
                result.missing.push({
                    path: conversationPath,
                    reason: "No summary file",
                });
                continue;
            }
            // Check if file is outdated (modified after last_indexed)
            const lastIndexed = getFileLastIndexed(db, conversationPath);
            if (lastIndexed !== null) {
                const fileStat = statArchiveFile(conversationPath);
                if (fileStat && fileStat.mtimeMs > lastIndexed) {
                    result.outdated.push({
                        path: conversationPath,
                        fileTime: fileStat.mtimeMs,
                        dbTime: lastIndexed,
                    });
                }
            }
            // Try parsing to detect corruption
            try {
                await parseConversation(conversationPath, project, conversationPath);
            }
            catch (error) {
                result.corrupted.push({
                    path: conversationPath,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    console.log(`Verified ${totalChecked} conversations.`);
    // Check for orphaned database entries
    const dbExchanges = getAllExchanges(db);
    db.close();
    for (const exchange of dbExchanges) {
        if (!foundFiles.has(exchange.archivePath)) {
            result.orphaned.push({
                uuid: exchange.id,
                path: exchange.archivePath,
            });
        }
    }
    return result;
}
export async function repairIndex(issues) {
    console.log("Repairing index...");
    // To avoid circular dependencies, we import the indexer functions dynamically
    const { initDatabase, insertExchange, deleteExchange, reconcileArchiveExchanges } = await import("./db.js");
    const { parseConversation } = await import("./parser.js");
    const { initEmbeddings, generateExchangeEmbedding } = await import("./embeddings.js");
    const { summarizeConversation } = await import("./summarizer.js");
    const db = initDatabase();
    let embeddingsReady = false;
    const failures = [];
    try {
        // Foreign-key violations (predate-Memex orphans from foreign tooling)
        // first: leaving them would make every subsequent delete on the affected
        // parents fail under enforced FKs.
        if (issues.fkViolations.length > 0) {
            console.log(`Removing ${issues.fkViolations.length} foreign-key violation row(s)...`);
            repairForeignKeyViolations(db, issues.fkViolations);
        }
        // Remove orphaned entries first
        for (const orphan of issues.orphaned) {
            console.log(`Removing orphaned entry: ${orphan.uuid}`);
            deleteExchange(db, orphan.uuid);
        }
        // Re-index missing and outdated conversations
        const toReindex = [
            ...issues.missing.map((m) => m.path),
            ...issues.outdated.map((o) => o.path),
        ];
        for (const conversationPath of toReindex) {
            console.log(`Re-indexing: ${conversationPath}`);
            try {
                // CX-02: project identity comes from the rollout's own session_meta.cwd
                // (canonical absolute path), never from the archive storage key — the
                // storage directory name is a derived collision-free label, not identity
                // evidence. Subagent threads never reach the index, matching sync.
                const { meta, isSubagent } = await readRolloutMeta(conversationPath);
                if (isSubagent) {
                    console.log(`  Skipped (subagent thread)`);
                    continue;
                }
                const cwd = meta && typeof meta.cwd === "string" ? meta.cwd : "";
                const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
                const eligibility = await getConversationEligibility({
                    filePath: conversationPath,
                    project,
                    isSubagent,
                    excludedProjects: getExcludedProjects(),
                });
                if (!eligibility.eligible) {
                    if (eligibility.reason === "user_excluded") {
                        purgeConversationFromIndex(db, {
                            archivePath: conversationPath,
                            sessionId: meta && typeof meta.id === "string" ? meta.id : null,
                        });
                        console.log(`  Purged (user-excluded conversation)`);
                    }
                    else {
                        console.log(`  Skipped (${eligibility.reason})`);
                    }
                    continue;
                }
                if (!embeddingsReady) {
                    await initEmbeddings();
                    embeddingsReady = true;
                }
                // Parse conversation
                const exchanges = await parseConversation(conversationPath, project, conversationPath);
                if (exchanges.length === 0) {
                    console.log(`  Skipped (no exchanges)`);
                    continue;
                }
                // Generate/update summary
                const summaryPath = conversationPath.replace(".jsonl", "-summary.txt");
                const summary = await summarizeConversation(exchanges);
                fs.writeFileSync(summaryPath, summary, "utf-8");
                console.log(`  Created summary: ${summary.split(/\s+/).length} words`);
                // Index exchanges
                // 재감사 P1-6: 삽입 전 desired-set reconciliation.
                reconcileArchiveExchanges(db, {
                    archivePath: conversationPath,
                    desired: exchanges.map((e) => ({
                        id: e.id,
                        lineStart: e.lineStart,
                    })),
                });
                for (const exchange of exchanges) {
                    const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
                    const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                    insertExchange(db, exchange, embedding, toolNames);
                }
                console.log(`  Indexed ${exchanges.length} exchanges`);
            }
            catch (error) {
                const cause = error instanceof Error ? error : new Error(String(error));
                console.error(`Failed to re-index ${conversationPath}:`, cause);
                failures.push(new Error(`${conversationPath}: ${cause.message}`, { cause }));
            }
        }
    }
    finally {
        db.close();
    }
    // Report corrupted files (manual intervention needed)
    if (issues.corrupted.length > 0) {
        console.log("\n⚠️  Corrupted files (manual review needed):");
        issues.corrupted.forEach((c) => console.log(`  ${c.path}: ${c.error}`));
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, `Repair failed for ${failures.length} conversation(s)`);
    }
    console.log("✅ Repair complete.");
}
