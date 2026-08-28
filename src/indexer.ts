import fs from "fs";
import path from "path";
import { initDatabase, insertExchange } from "./db.js";
import { parseConversation } from "./parser.js";
import { initEmbeddings, generateExchangeEmbedding } from "./embeddings.js";
import { summarizeConversation } from "./summarizer.js";
import { ConversationExchange } from "./types.js";
import {
  getArchiveDir,
  getExcludedProjects,
  isWorkerPromptMessage,
  getSessionsRoot,
} from "./paths.js";
import { discoverSessionFiles, readRolloutMeta } from "./codex-rollout.js";
import {
  canonicalizeProjectPath,
  projectStorageKey,
  UNKNOWN_PROJECT,
} from "./project-identity.js";
import {
  archiveFileExists,
  statArchiveFile,
  atomicCopyFileSync,
} from "./archive-io.js";
import {
  getConversationEligibility,
  purgeConversationFromIndex,
} from "./conversation-policy.js";

/**
 * Copy source → archive unless a current copy (plain or .zst) already exists.
 * A stale compressed copy must not mask a newer source file.
 */
function archiveIfStale(sourcePath: string, archivePath: string): boolean {
  const destStat = statArchiveFile(archivePath);
  if (destStat && destStat.mtimeMs >= fs.statSync(sourcePath).mtimeMs) {
    return false;
  }
  // 원자적 복사 — 잘린 아카이브가 "최신"으로 남는 것을 방지한다(CX-11 계약).
  atomicCopyFileSync(sourcePath, archivePath);
  return true;
}

// Concurrency headroom for parallel embedding/summary workers.

// Increase max listeners for concurrent API calls
import { EventEmitter } from "events";
EventEmitter.defaultMaxListeners = 20;

// Session discovery (recursive rollout walk) lives in codex-rollout.ts;
// MEMEX_SESSIONS_DIR overrides the sessions root; TEST_SESSIONS_DIR and the
// historical MEMORY_BANK_SESSIONS_DIR remain test/compatibility fallbacks.

// Process items in batches with limited concurrency
export async function processBatch<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }

  return results;
}

export async function indexConversations(
  limitToProject?: string,
  maxConversations?: number,
  concurrency: number = 1,
  noSummaries: boolean = false,
): Promise<void> {
  console.log("Initializing database...");
  const db = initDatabase();

  if (noSummaries) {
    console.log("⚠️  Running in no-summaries mode (skipping AI summaries)");
  }

  console.log("Scanning for Codex session rollouts...");
  const SESSIONS_DIR = getSessionsRoot();
  const ARCHIVE_DIR = getArchiveDir();

  let totalExchanges = 0;
  let conversationsProcessed = 0;

  const excludedProjects = getExcludedProjects();

  type ConvToProcess = {
    file: string;
    sourcePath: string;
    archivePath: string;
    summaryPath: string;
    exchanges: ConversationExchange[];
  };

  const toProcess: ConvToProcess[] = [];

  const rolloutFiles = discoverSessionFiles(SESSIONS_DIR);
  if (limitToProject) console.log(`Limiting to project: ${limitToProject}`);

  for (const sourcePath of rolloutFiles) {
    // Header pre-parse routes sessions cheaply: subagent threads and excluded
    // projects never reach the archive; project = session's own cwd basename.
    const { meta, isSubagent } = await readRolloutMeta(sourcePath);
    const cwd = meta && typeof meta.cwd === "string" ? meta.cwd : "";
    // CX-02: project identity is the canonical absolute cwd; archive dir uses
    // the collision-free storageKey.
    const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
    let eligibility = await getConversationEligibility({
      filePath: sourcePath,
      project,
      isSubagent,
      excludedProjects,
    });
    if (!eligibility.eligible && eligibility.reason === "subagent") continue;
    if (!eligibility.eligible && eligibility.reason === "excluded_project") {
      console.log(`\nSkipping excluded project: ${project}`);
      continue;
    }
    if (limitToProject && project !== limitToProject) continue;

    const fileName = path.basename(sourcePath);
    const projectArchive = path.join(ARCHIVE_DIR, projectStorageKey(project));
    fs.mkdirSync(projectArchive, { recursive: true });
    const archivePath = path.join(projectArchive, fileName);

    // Copy to archive (skip when a current plain or compressed copy exists)
    if (archiveIfStale(sourcePath, archivePath)) {
      console.log(`  Archived: ${project}/${fileName}`);
    }
    if (eligibility.eligible) {
      eligibility = await getConversationEligibility({
        filePath: archivePath,
        project,
        isSubagent: false,
        excludedProjects,
      });
    }
    if (!eligibility.eligible) {
      purgeConversationFromIndex(db, {
        archivePath,
        sessionId: meta && typeof meta.id === "string" ? meta.id : null,
      });
      console.log(`  Excluded by user marker: ${project}/${fileName}`);
      continue;
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
      summaryPath: archivePath.replace(".jsonl", "-summary.txt"),
      exchanges,
    });
  }

  if (toProcess.length > 0) {
    console.log("Loading embedding model...");
    await initEmbeddings();
  }

  // Batch summarize conversations in parallel (unless --no-summaries)
  if (!noSummaries) {
    const needsSummary = toProcess.filter(
      (c) => !archiveFileExists(c.summaryPath),
    );

    if (needsSummary.length > 0) {
      console.log(
        `  Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...`,
      );

      await processBatch(
        needsSummary,
        async (conv) => {
          try {
            const summary = await summarizeConversation(conv.exchanges);
            fs.writeFileSync(conv.summaryPath, summary, "utf-8");
            const wordCount = summary.split(/\s+/).length;
            console.log(`  ✓ ${conv.file}: ${wordCount} words`);
            return summary;
          } catch (error) {
            console.log(`  ✗ ${conv.file}: ${error}`);
            return null;
          }
        },
        concurrency,
      );
    }
  } else {
    console.log(
      `  Skipping ${toProcess.length} summaries (--no-summaries mode)`,
    );
  }

  // Now process embeddings and DB inserts (fast, sequential is fine)
  for (const conv of toProcess) {
    for (const exchange of conv.exchanges) {
      // The plugin's own worker-prompt sessions are ephemeral state, not
      // knowledge — never index them.
      if (isWorkerPromptMessage(exchange.userMessage)) continue;
      const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
      const embedding = await generateExchangeEmbedding(
        exchange.userMessage,
        exchange.assistantMessage,
        toolNames,
      );

      insertExchange(db, exchange, embedding, toolNames);
    }

    totalExchanges += conv.exchanges.length;
    conversationsProcessed++;

    // Check if we hit the limit
    if (maxConversations && conversationsProcessed >= maxConversations) {
      console.log(`\nReached limit of ${maxConversations} conversations`);
      db.close();
      console.log(
        `✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`,
      );
      return;
    }
  }

  db.close();
  console.log(
    `\n✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`,
  );
}

export async function indexSession(
  sessionId: string,
  concurrency: number = 1,
  noSummaries: boolean = false,
): Promise<void> {
  console.log(`Indexing session: ${sessionId}`);

  // Locate the rollout whose filename carries this thread id
  const SESSIONS_DIR = getSessionsRoot();
  const ARCHIVE_DIR = getArchiveDir();
  const candidates = discoverSessionFiles(SESSIONS_DIR).filter((p) =>
    path.basename(p).includes(sessionId),
  );
  let found = false;
  const excludedProjects = getExcludedProjects();

  for (const sourcePath of candidates) {
    const { meta, isSubagent } = await readRolloutMeta(sourcePath);
    const cwd = meta && typeof meta.cwd === "string" ? meta.cwd : "";
    // CX-02: canonical absolute cwd as project identity.
    const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
    let eligibility = await getConversationEligibility({
      filePath: sourcePath,
      project,
      isSubagent,
      excludedProjects,
    });
    if (!eligibility.eligible && eligibility.reason === "subagent") continue;
    found = true;
    if (!eligibility.eligible && eligibility.reason === "excluded_project") {
      console.log(`Skipping excluded project: ${project}`);
      break;
    }
    const fileName = path.basename(sourcePath);

    const db = initDatabase();

    const projectArchive = path.join(ARCHIVE_DIR, projectStorageKey(project));
    fs.mkdirSync(projectArchive, { recursive: true });

    const archivePath = path.join(projectArchive, fileName);

    // Archive
    archiveIfStale(sourcePath, archivePath);
    if (eligibility.eligible) {
      eligibility = await getConversationEligibility({
        filePath: archivePath,
        project,
        isSubagent: false,
        excludedProjects,
      });
    }
    if (!eligibility.eligible) {
      purgeConversationFromIndex(db, {
        archivePath,
        sessionId: meta && typeof meta.id === "string" ? meta.id : sessionId,
      });
      console.log(`Excluded session ${sessionId} by user marker`);
      db.close();
      break;
    }
    await initEmbeddings();

    // Parse and summarize
    const exchanges = await parseConversation(sourcePath, project, archivePath);

    if (exchanges.length > 0) {
      // Generate summary (unless --no-summaries)
      const summaryPath = archivePath.replace(".jsonl", "-summary.txt");
      if (!noSummaries && !archiveFileExists(summaryPath)) {
        const summary = await summarizeConversation(exchanges);
        fs.writeFileSync(summaryPath, summary, "utf-8");
        console.log(`Summary: ${summary.split(/\s+/).length} words`);
      }

      // Index
      for (const exchange of exchanges) {
        if (isWorkerPromptMessage(exchange.userMessage)) continue; // worker prompt = ephemeral state, not knowledge
        const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
        const embedding = await generateExchangeEmbedding(
          exchange.userMessage,
          exchange.assistantMessage,
          toolNames,
        );
        insertExchange(db, exchange, embedding, toolNames);
      }

      console.log(
        `✅ Indexed session ${sessionId}: ${exchanges.length} exchanges`,
      );
    }

    db.close();
    break;
  }

  if (!found) {
    console.log(`Session ${sessionId} not found`);
  }
}

export async function indexUnprocessed(
  concurrency: number = 1,
  noSummaries: boolean = false,
): Promise<void> {
  console.log("Finding unprocessed conversations...");
  if (concurrency > 1) console.log(`Concurrency: ${concurrency}`);
  if (noSummaries)
    console.log("⚠️  Running in no-summaries mode (skipping AI summaries)");

  const db = initDatabase();

  const SESSIONS_DIR = getSessionsRoot();
  const ARCHIVE_DIR = getArchiveDir();
  const excludedProjects = getExcludedProjects();

  type UnprocessedConv = {
    project: string;
    file: string;
    sourcePath: string;
    archivePath: string;
    summaryPath: string;
    exchanges: ConversationExchange[];
  };

  const unprocessed: UnprocessedConv[] = [];

  // Collect all unprocessed rollouts. Partial/malformed files parse with
  // per-line tolerance; whatever yields no exchanges simply stays unindexed
  // and will be retried on the next run once the transcript completes.
  for (const sourcePath of discoverSessionFiles(SESSIONS_DIR)) {
    const { meta, isSubagent } = await readRolloutMeta(sourcePath);
    const cwd = meta && typeof meta.cwd === "string" ? meta.cwd : "";
    // CX-02: canonical absolute cwd as project identity.
    const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
    let eligibility = await getConversationEligibility({
      filePath: sourcePath,
      project,
      isSubagent,
      excludedProjects,
    });
    if (!eligibility.eligible && eligibility.reason !== "user_excluded") continue;

    const fileName = path.basename(sourcePath);
    const projectArchive = path.join(ARCHIVE_DIR, projectStorageKey(project));
    const archivePath = path.join(projectArchive, fileName);
    const summaryPath = archivePath.replace(".jsonl", "-summary.txt");

    if (!eligibility.eligible) {
      fs.mkdirSync(projectArchive, { recursive: true });
      archiveIfStale(sourcePath, archivePath);
      purgeConversationFromIndex(db, {
        archivePath,
        sessionId: meta && typeof meta.id === "string" ? meta.id : null,
      });
      continue;
    }

    // Check if already indexed in database
    const alreadyIndexed = db
      .prepare("SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?")
      .get(archivePath) as { count: number };

    if (alreadyIndexed.count > 0) continue;

    fs.mkdirSync(projectArchive, { recursive: true });

    // Archive if needed (a current plain or compressed copy counts)
    archiveIfStale(sourcePath, archivePath);

    // Parse and check
    const exchanges = await parseConversation(sourcePath, project, archivePath);
    if (exchanges.length === 0) continue;

    unprocessed.push({
      project,
      file: `${project}/${fileName}`,
      sourcePath,
      archivePath,
      summaryPath,
      exchanges,
    });
  }

  if (unprocessed.length === 0) {
    console.log("✅ All conversations are already processed!");
    db.close();
    return;
  }

  await initEmbeddings();

  console.log(`Found ${unprocessed.length} unprocessed conversations`);

  // Batch process summaries (unless --no-summaries)
  if (!noSummaries) {
    const needsSummary = unprocessed.filter(
      (c) => !archiveFileExists(c.summaryPath),
    );
    if (needsSummary.length > 0) {
      console.log(
        `Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...\n`,
      );

      await processBatch(
        needsSummary,
        async (conv) => {
          try {
            const summary = await summarizeConversation(conv.exchanges);
            fs.writeFileSync(conv.summaryPath, summary, "utf-8");
            const wordCount = summary.split(/\s+/).length;
            console.log(`  ✓ ${conv.project}/${conv.file}: ${wordCount} words`);
            return summary;
          } catch (error) {
            console.log(`  ✗ ${conv.project}/${conv.file}: ${error}`);
            return null;
          }
        },
        concurrency,
      );
    }
  } else {
    console.log(
      `Skipping summaries for ${unprocessed.length} conversations (--no-summaries mode)\n`,
    );
  }

  // Now index embeddings
  console.log(`\nIndexing embeddings...`);
  for (const conv of unprocessed) {
    for (const exchange of conv.exchanges) {
      if (isWorkerPromptMessage(exchange.userMessage)) continue; // worker prompt = ephemeral state, not knowledge
      const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
      const embedding = await generateExchangeEmbedding(
        exchange.userMessage,
        exchange.assistantMessage,
        toolNames,
      );
      insertExchange(db, exchange, embedding, toolNames);
    }
  }

  db.close();
  console.log(`\n✅ Processed ${unprocessed.length} conversations`);
}
