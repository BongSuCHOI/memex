import fs from "fs";
import path from "path";
import readline from "node:readline";
import { SUMMARIZER_CONTEXT_MARKER } from "./constants.js";
import {
  getExcludedProjects,
  isExcludedProject,
  isWorkerPromptMessage,
  ensureArchiveDir,
} from "./paths.js";
import {
  archiveFileExists,
  statArchiveFile,
  createArchiveReadStream,
} from "./archive-io.js";

import {
  canonicalizeProjectPath,
  projectStorageKey,
  UNKNOWN_PROJECT,
} from "./project-identity.js";
import {
  discoverSessionFiles,
  readRolloutMeta,
  extractSessionIdFromPath,
} from "./codex-rollout.js";
// An exclusion marker is a USER-level instruction to keep a conversation out
// of the index (typed in chat, or placed in AGENTS.md so it arrives inside a
// user_instructions/environment_context block). It is honored only when it
// appears in a user-role message payload — never in tool results, assistant
// output, or other recorded fields. Scanning raw file bytes instead caused
// memex-development sessions to exclude themselves whenever the agent merely
// read this file's own source (observed: 2 large dev sessions silently
// dropped because their transcripts contained marker strings inside tool
// results).
const EXCLUSION_MARKERS = [
  "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
  "Only use NO_INSIGHTS_FOUND",
  SUMMARIZER_CONTEXT_MARKER,
];

/**
 * True when an exclusion marker appears in a user-role message payload of the
 * rollout. Line-level scan (not full exchange parsing) so that internal
 * context blocks (<user_instructions>/<environment_context>) are still
 * honored even though parseRolloutStream filters them out of exchanges.
 * Undecidable (unreadable/unparsable) files are NOT excluded.
 */
async function conversationIsExcluded(filePath: string): Promise<boolean> {
  const stream = createArchiveReadStream(filePath);
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: {
        type?: unknown;
        payload?: { type?: unknown; role?: unknown; content?: unknown };
      };
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // malformed line — excluded only by intact user messages
      }
      const p = rec?.payload;
      if (
        rec?.type !== "response_item" ||
        !p ||
        p.type !== "message" ||
        p.role !== "user"
      ) {
        continue;
      }
      const text =
        typeof p.content === "string"
          ? p.content
          : Array.isArray(p.content)
            ? (p.content as Array<{ text?: unknown }>)
                .filter((c) => c && typeof c.text === "string")
                .map((c) => c.text as string)
                .join("\n")
            : "";
      if (EXCLUSION_MARKERS.some((marker) => text.includes(marker))) {
        return true;
      }
    }
    return false;
  } catch {
    // If we can't read or scan the file, don't exclude it
    return false;
  } finally {
    stream.destroy();
  }
}

export interface SyncResult {
  copied: number;
  skipped: number;
  indexed: number;
  summarized: number;
  errors: Array<{ file: string; error: string }>;
}

export interface SyncOptions {
  skipIndex?: boolean;
  skipSummaries?: boolean;
  summaryLimit?: number; // Max summaries to generate per run (default: 10)
}

function copyIfNewer(src: string, dest: string): boolean {
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
  } catch (e) {
    try {
      fs.unlinkSync(tempDest);
    } catch {
      /* cleanup best effort */
    }
    throw e;
  }
  return true;
}

export async function syncConversations(
  sourceDir: string,
  destDir?: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const targetArchiveDir = destDir || ensureArchiveDir();
  const result: SyncResult = {
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
  const filesToIndex: Array<{ path: string; project: string }> = [];
  const filesToSummarize: Array<{
    path: string;
    sessionId: string;
    project: string;
  }> = [];

  // Walk Codex session rollouts. Layout is recursive (YYYY/MM/DD), and the
  // project key is derived from each session's own cwd in session_meta —
  // the archive keeps its <project>/<file>.jsonl contract on disk.
  const excludedProjects = getExcludedProjects();

  for (const srcFile of discoverSessionFiles(sourceDir)) {
    try {
      const { meta, isSubagent } = await readRolloutMeta(srcFile);
      // Subagent / child threads are harness plumbing, never knowledge.
      if (isSubagent) continue;
      const cwd = meta && typeof meta.cwd === "string" ? meta.cwd : "";
      // CX-02: project identity is the canonical absolute cwd; the archive
      // directory uses a collision-free storage key derived from it.
      const project = cwd ? canonicalizeProjectPath(cwd) : UNKNOWN_PROJECT;
      if (isExcludedProject(project, excludedProjects)) {
        console.error(`\nSkipping excluded project: ${project}`);
        continue;
      }

      const destFile = path.join(
        targetArchiveDir,
        projectStorageKey(project),
        path.basename(srcFile),
      );

      const wasCopied = copyIfNewer(srcFile, destFile);
      if (wasCopied) {
        result.copied++;
        filesToIndex.push({ path: destFile, project });
      } else {
        result.skipped++;
      }

      // Check if this file needs a summary (whether newly copied or existing)
      if (!options.skipSummaries) {
        const summaryPath = destFile.replace(".jsonl", "-summary.txt");
        if (
          !archiveFileExists(summaryPath) &&
          !(await conversationIsExcluded(destFile))
        ) {
          const sessionId = extractSessionIdFromPath(destFile);
          if (sessionId) {
            filesToSummarize.push({ path: destFile, sessionId, project });
          }
        }
      }
    } catch (error) {
      result.errors.push({
        file: srcFile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Index copied files (unless skipIndex is set)
  if (!options.skipIndex && filesToIndex.length > 0) {
    const { initDatabase, insertExchange } = await import("./db.js");
    const { initEmbeddings, generateExchangeEmbedding } = await import(
      "./embeddings.js"
    );
    const { parseConversation } = await import("./parser.js");

    const db = initDatabase();
    await initEmbeddings();

    for (const { path: file, project } of filesToIndex) {
      try {
        // Check for user-level DO NOT INDEX exclusion marker
        if (await conversationIsExcluded(file)) {
          continue; // Skip indexing but file is already copied
        }

        // CX-02: project = canonical absolute cwd (carried from the rollout
        // header), never the archive directory name.
        const exchanges = await parseConversation(file, project, file);

        for (const exchange of exchanges) {
          // Worker-prompt exchange = ephemeral state, not knowledge — never index.
          if (isWorkerPromptMessage(exchange.userMessage)) continue;
          const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
          const embedding = await generateExchangeEmbedding(
            exchange.userMessage,
            exchange.assistantMessage,
            toolNames,
          );
          insertExchange(db, exchange, embedding, toolNames);
        }

        result.indexed++;
      } catch (error) {
        result.errors.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
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

    console.error(
      `Generating summaries for ${toSummarize.length} conversation(s)...`,
    );
    if (remaining > 0) {
      console.error(
        `  (${remaining} more need summaries - will process on next sync)`,
      );
    }

    for (const { path: filePath, project } of toSummarize) {
      try {
        const exchanges = await parseConversation(filePath, project, filePath);

        if (exchanges.length === 0) {
          continue; // Skip empty conversations
        }

        console.error(
          `  Summarizing ${path.basename(filePath)} (${exchanges.length} exchanges)...`,
        );
        const summary = await summarizeConversation(exchanges);

        const summaryPath = filePath.replace(".jsonl", "-summary.txt");
        fs.writeFileSync(summaryPath, summary, "utf-8");
        result.summarized++;
      } catch (error) {
        result.errors.push({
          file: filePath,
          error: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return result;
}
