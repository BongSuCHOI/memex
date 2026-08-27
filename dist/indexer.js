import fs from 'fs';
import path from 'path';
import { initDatabase, insertExchange } from './db.js';
import { parseConversation } from './parser.js';
import { initEmbeddings, generateExchangeEmbedding } from './embeddings.js';
import { summarizeConversation } from './summarizer.js';
import { getArchiveDir, getExcludedProjects, isExcludedProject, isWorkerPromptMessage, getSessionsRoot } from './paths.js';
import { discoverSessionFiles, readRolloutMeta } from './codex-rollout.js';
import { canonicalizeProjectPath, projectStorageKey, UNKNOWN_PROJECT } from './project-identity.js';
import { archiveFileExists, statArchiveFile } from './archive-io.js';
/**
 * Copy source → archive unless a current copy (plain or .zst) already exists.
 * A stale compressed copy must not mask a newer source file.
 */
function archiveIfStale(sourcePath, archivePath) {
    const destStat = statArchiveFile(archivePath);
    if (destStat && destStat.mtimeMs >= fs.statSync(sourcePath).mtimeMs) {
        return false;
    }
    fs.copyFileSync(sourcePath, archivePath);
    return true;
}
// Concurrency headroom for parallel embedding/summary workers.
// Increase max listeners for concurrent API calls
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;
// Session discovery (recursive rollout walk) lives in codex-rollout.ts;
// TEST_SESSIONS_DIR / MEMORY_BANK_SESSIONS_DIR override the sessions root.
// Process items in batches with limited concurrency
export async function processBatch(items, processor, concurrency) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }
    return results;
}
export async function indexConversations(limitToProject, maxConversations, concurrency = 1, noSummaries = false) {
    console.log('Initializing database...');
    const db = initDatabase();
    console.log('Loading embedding model...');
    await initEmbeddings();
    if (noSummaries) {
        console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
    }
    console.log('Scanning for Codex session rollouts...');
    const SESSIONS_DIR = getSessionsRoot();
    const ARCHIVE_DIR = getArchiveDir();
    let totalExchanges = 0;
    let conversationsProcessed = 0;
    const excludedProjects = getExcludedProjects();
    const toProcess = [];
    const rolloutFiles = discoverSessionFiles(SESSIONS_DIR);
    if (limitToProject)
        console.log(`Limiting to project: ${limitToProject}`);
    for (const sourcePath of rolloutFiles) {
        // Header pre-parse routes sessions cheaply: subagent threads and excluded
        // projects never reach the archive; project = session's own cwd basename.
        const { meta, isSubagent } = await readRolloutMeta(sourcePath);
        if (isSubagent)
            continue;
        const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : '';
        // CX-02: project identity is the canonical absolute cwd; archive dir uses
        // the collision-free storageKey.
        const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
        if (isExcludedProject(project, excludedProjects)) {
            console.log(`\nSkipping excluded project: ${project}`);
            continue;
        }
        if (limitToProject && project !== limitToProject)
            continue;
        const fileName = path.basename(sourcePath);
        const projectArchive = path.join(ARCHIVE_DIR, projectStorageKey(project));
        fs.mkdirSync(projectArchive, { recursive: true });
        const archivePath = path.join(projectArchive, fileName);
        // Copy to archive (skip when a current plain or compressed copy exists)
        if (archiveIfStale(sourcePath, archivePath)) {
            console.log(`  Archived: ${project}/${fileName}`);
        }
        // Parse conversation
        const exchanges = await parseConversation(sourcePath, project, archivePath);
        if (exchanges.length === 0) {
            continue;
        }
        toProcess.push({
            file: `${project}/${fileName}`,
            sourcePath,
            archivePath,
            summaryPath: archivePath.replace('.jsonl', '-summary.txt'),
            exchanges
        });
    }
    // Batch summarize conversations in parallel (unless --no-summaries)
    if (!noSummaries) {
        const needsSummary = toProcess.filter(c => !archiveFileExists(c.summaryPath));
        if (needsSummary.length > 0) {
            console.log(`  Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...`);
            await processBatch(needsSummary, async (conv) => {
                try {
                    const summary = await summarizeConversation(conv.exchanges);
                    fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
                    const wordCount = summary.split(/\s+/).length;
                    console.log(`  ✓ ${conv.file}: ${wordCount} words`);
                    return summary;
                }
                catch (error) {
                    console.log(`  ✗ ${conv.file}: ${error}`);
                    return null;
                }
            }, concurrency);
        }
    }
    else {
        console.log(`  Skipping ${toProcess.length} summaries (--no-summaries mode)`);
    }
    // Now process embeddings and DB inserts (fast, sequential is fine)
    for (const conv of toProcess) {
        for (const exchange of conv.exchanges) {
            // The plugin's own worker-prompt sessions are ephemeral state, not
            // knowledge — never index them.
            if (isWorkerPromptMessage(exchange.userMessage))
                continue;
            const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
            const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
            insertExchange(db, exchange, embedding, toolNames);
        }
        totalExchanges += conv.exchanges.length;
        conversationsProcessed++;
        // Check if we hit the limit
        if (maxConversations && conversationsProcessed >= maxConversations) {
            console.log(`\nReached limit of ${maxConversations} conversations`);
            db.close();
            console.log(`✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
            return;
        }
    }
    db.close();
    console.log(`\n✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
}
export async function indexSession(sessionId, concurrency = 1, noSummaries = false) {
    console.log(`Indexing session: ${sessionId}`);
    // Locate the rollout whose filename carries this thread id
    const SESSIONS_DIR = getSessionsRoot();
    const ARCHIVE_DIR = getArchiveDir();
    const candidates = discoverSessionFiles(SESSIONS_DIR).filter(p => path.basename(p).includes(sessionId));
    let found = false;
    for (const sourcePath of candidates) {
        const { meta, isSubagent } = await readRolloutMeta(sourcePath);
        if (isSubagent)
            continue; // harness plumbing, never knowledge
        found = true;
        const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : '';
        // CX-02: canonical absolute cwd as project identity.
        const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
        const fileName = path.basename(sourcePath);
        const db = initDatabase();
        await initEmbeddings();
        const projectArchive = path.join(ARCHIVE_DIR, projectStorageKey(project));
        fs.mkdirSync(projectArchive, { recursive: true });
        const archivePath = path.join(projectArchive, fileName);
        // Archive
        archiveIfStale(sourcePath, archivePath);
        // Parse and summarize
        const exchanges = await parseConversation(sourcePath, project, archivePath);
        if (exchanges.length > 0) {
            // Generate summary (unless --no-summaries)
            const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
            if (!noSummaries && !archiveFileExists(summaryPath)) {
                const summary = await summarizeConversation(exchanges);
                fs.writeFileSync(summaryPath, summary, 'utf-8');
                console.log(`Summary: ${summary.split(/\s+/).length} words`);
            }
            // Index
            for (const exchange of exchanges) {
                if (isWorkerPromptMessage(exchange.userMessage))
                    continue; // worker prompt = ephemeral state, not knowledge
                const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                insertExchange(db, exchange, embedding, toolNames);
            }
            console.log(`✅ Indexed session ${sessionId}: ${exchanges.length} exchanges`);
        }
        db.close();
        break;
    }
    if (!found) {
        console.log(`Session ${sessionId} not found`);
    }
}
export async function indexUnprocessed(concurrency = 1, noSummaries = false) {
    console.log('Finding unprocessed conversations...');
    if (concurrency > 1)
        console.log(`Concurrency: ${concurrency}`);
    if (noSummaries)
        console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
    const db = initDatabase();
    await initEmbeddings();
    const SESSIONS_DIR = getSessionsRoot();
    const ARCHIVE_DIR = getArchiveDir();
    const excludedProjects = getExcludedProjects();
    const unprocessed = [];
    // Collect all unprocessed rollouts. Partial/malformed files parse with
    // per-line tolerance; whatever yields no exchanges simply stays unindexed
    // and will be retried on the next run once the transcript completes.
    for (const sourcePath of discoverSessionFiles(SESSIONS_DIR)) {
        const { meta, isSubagent } = await readRolloutMeta(sourcePath);
        if (isSubagent)
            continue;
        const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : '';
        // CX-02: canonical absolute cwd as project identity.
        const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
        if (isExcludedProject(project, excludedProjects))
            continue;
        const fileName = path.basename(sourcePath);
        const projectArchive = path.join(ARCHIVE_DIR, projectStorageKey(project));
        const archivePath = path.join(projectArchive, fileName);
        const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
        // Check if already indexed in database
        const alreadyIndexed = db.prepare('SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?')
            .get(archivePath);
        if (alreadyIndexed.count > 0)
            continue;
        fs.mkdirSync(projectArchive, { recursive: true });
        // Archive if needed (a current plain or compressed copy counts)
        archiveIfStale(sourcePath, archivePath);
        // Parse and check
        const exchanges = await parseConversation(sourcePath, project, archivePath);
        if (exchanges.length === 0)
            continue;
        unprocessed.push({ project, file: `${project}/${fileName}`, sourcePath, archivePath, summaryPath, exchanges });
    }
    if (unprocessed.length === 0) {
        console.log('✅ All conversations are already processed!');
        db.close();
        return;
    }
    console.log(`Found ${unprocessed.length} unprocessed conversations`);
    // Batch process summaries (unless --no-summaries)
    if (!noSummaries) {
        const needsSummary = unprocessed.filter(c => !archiveFileExists(c.summaryPath));
        if (needsSummary.length > 0) {
            console.log(`Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...\n`);
            await processBatch(needsSummary, async (conv) => {
                try {
                    const summary = await summarizeConversation(conv.exchanges);
                    fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
                    const wordCount = summary.split(/\s+/).length;
                    console.log(`  ✓ ${conv.project}/${conv.file}: ${wordCount} words`);
                    return summary;
                }
                catch (error) {
                    console.log(`  ✗ ${conv.project}/${conv.file}: ${error}`);
                    return null;
                }
            }, concurrency);
        }
    }
    else {
        console.log(`Skipping summaries for ${unprocessed.length} conversations (--no-summaries mode)\n`);
    }
    // Now index embeddings
    console.log(`\nIndexing embeddings...`);
    for (const conv of unprocessed) {
        for (const exchange of conv.exchanges) {
            if (isWorkerPromptMessage(exchange.userMessage))
                continue; // worker prompt = ephemeral state, not knowledge
            const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
            const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
            insertExchange(db, exchange, embedding, toolNames);
        }
    }
    db.close();
    console.log(`\n✅ Processed ${unprocessed.length} conversations`);
}
