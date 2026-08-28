import fs from "fs";
import path from "path";
import { getExcludedProjects, isWorkerPromptMessage, ensureArchiveDir, } from "./paths.js";
import { archiveFileExists, statArchiveFile, } from "./archive-io.js";
import { canonicalizeProjectPath, projectStorageKey, UNKNOWN_PROJECT, } from "./project-identity.js";
import { discoverSessionFiles, readRolloutMeta, extractSessionIdFromPath, } from "./codex-rollout.js";
import { getConversationEligibility, purgeConversationFromIndex, } from "./conversation-policy.js";
function copyIfNewer(src, dest) {
    // Ensure destination directory exists
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }
    // Check if destination exists and is up-to-date. The archive may have been
    // compressed out-of-band (dest.zst) — treat a current compressed copy as
    // up-to-date, otherwise every sync re-copies the whole history.
    const destStat = statArchiveFile(dest);
    if (destStat) {
        const srcStat = fs.statSync(src);
        if (destStat.mtimeMs >= srcStat.mtimeMs) {
            return false; // Dest (plain or compressed) is current, skip
        }
    }
    // Atomic copy: temp file + rename
    const tempDest = dest + ".tmp." + process.pid;
    try {
        fs.copyFileSync(src, tempDest);
        fs.renameSync(tempDest, dest); // Atomic on same filesystem
    }
    catch (e) {
        try {
            fs.unlinkSync(tempDest);
        }
        catch {
            /* cleanup best effort */
        }
        throw e;
    }
    return true;
}
export async function syncConversations(sourceDir, destDir, options = {}) {
    const targetArchiveDir = destDir || ensureArchiveDir();
    const result = {
        copied: 0,
        skipped: 0,
        indexed: 0,
        summarized: 0,
        errors: [],
    };
    // Ensure source directory exists
    if (!fs.existsSync(sourceDir)) {
        return result;
    }
    // Collect files to index and summarize
    const filesToIndex = [];
    const filesToSummarize = [];
    const filesToPurge = [];
    // Walk Codex session rollouts. Layout is recursive (YYYY/MM/DD), and the
    // project key is derived from each session's own cwd in session_meta —
    // the archive keeps its <project>/<file>.jsonl contract on disk.
    const excludedProjects = getExcludedProjects();
    for (const srcFile of discoverSessionFiles(sourceDir)) {
        try {
            const { meta, isSubagent } = await readRolloutMeta(srcFile);
            const cwd = meta && typeof meta.cwd === "string" ? meta.cwd : "";
            // CX-02: project identity is the canonical absolute cwd; the archive
            // directory uses a collision-free storage key derived from it.
            const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
            let eligibility = await getConversationEligibility({
                filePath: srcFile,
                project,
                isSubagent,
                excludedProjects,
            });
            if (!eligibility.eligible && eligibility.reason === "subagent")
                continue;
            if (!eligibility.eligible && eligibility.reason === "excluded_project") {
                console.error(`\nSkipping excluded project: ${project}`);
                continue;
            }
            const destFile = path.join(targetArchiveDir, projectStorageKey(project), path.basename(srcFile));
            const wasCopied = copyIfNewer(srcFile, destFile);
            if (wasCopied) {
                result.copied++;
            }
            else {
                result.skipped++;
            }
            if (eligibility.eligible) {
                eligibility = await getConversationEligibility({
                    filePath: destFile,
                    project,
                    isSubagent: false,
                    excludedProjects,
                });
            }
            const sessionId = meta && typeof meta.id === "string"
                ? meta.id
                : extractSessionIdFromPath(destFile);
            if (!eligibility.eligible) {
                filesToPurge.push({ path: destFile, sessionId });
                continue;
            }
            if (wasCopied)
                filesToIndex.push({ path: destFile, project });
            // Check if this file needs a summary (whether newly copied or existing)
            if (!options.skipSummaries) {
                const summaryPath = destFile.replace(".jsonl", "-summary.txt");
                if (!archiveFileExists(summaryPath)) {
                    if (sessionId) {
                        filesToSummarize.push({ path: destFile, sessionId, project });
                    }
                }
            }
        }
        catch (error) {
            result.errors.push({
                file: srcFile,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    // Purge user-excluded conversations even when no newly copied file needs
    // indexing. This makes a marker added later conversation-wide.
    if (filesToPurge.length > 0 ||
        (!options.skipIndex && filesToIndex.length > 0)) {
        const { initDatabase, insertExchange } = await import("./db.js");
        const db = initDatabase();
        for (const excluded of filesToPurge) {
            try {
                purgeConversationFromIndex(db, {
                    archivePath: excluded.path,
                    sessionId: excluded.sessionId,
                });
            }
            catch (error) {
                result.errors.push({
                    file: excluded.path,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (!options.skipIndex && filesToIndex.length > 0) {
            const { initEmbeddings, generateExchangeEmbedding } = await import("./embeddings.js");
            const { parseConversation } = await import("./parser.js");
            await initEmbeddings();
            for (const { path: file, project } of filesToIndex) {
                try {
                    // CX-02: project = canonical absolute cwd (carried from the rollout
                    // header), never the archive directory name.
                    const exchanges = await parseConversation(file, project, file);
                    for (const exchange of exchanges) {
                        // Worker-prompt exchange = ephemeral state, not knowledge — never index.
                        if (isWorkerPromptMessage(exchange.userMessage))
                            continue;
                        const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
                        const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                        insertExchange(db, exchange, embedding, toolNames);
                    }
                    result.indexed++;
                }
                catch (error) {
                    result.errors.push({
                        file,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        db.close();
    }
    // Generate summaries for files that need them
    if (!options.skipSummaries && filesToSummarize.length > 0) {
        const { parseConversation } = await import("./parser.js");
        const { summarizeConversation } = await import("./summarizer.js");
        const summaryLimit = options.summaryLimit ?? 10;
        const toSummarize = filesToSummarize.slice(0, summaryLimit);
        const remaining = filesToSummarize.length - toSummarize.length;
        console.error(`Generating summaries for ${toSummarize.length} conversation(s)...`);
        if (remaining > 0) {
            console.error(`  (${remaining} more need summaries - will process on next sync)`);
        }
        for (const { path: filePath, project } of toSummarize) {
            try {
                const exchanges = await parseConversation(filePath, project, filePath);
                if (exchanges.length === 0) {
                    continue; // Skip empty conversations
                }
                console.error(`  Summarizing ${path.basename(filePath)} (${exchanges.length} exchanges)...`);
                const summary = await summarizeConversation(exchanges);
                const summaryPath = filePath.replace(".jsonl", "-summary.txt");
                fs.writeFileSync(summaryPath, summary, "utf-8");
                result.summarized++;
            }
            catch (error) {
                result.errors.push({
                    file: filePath,
                    error: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
    }
    return result;
}
