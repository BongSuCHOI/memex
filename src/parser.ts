// Codex rollout transcript parser facade.
//
// Turn assembly lives in codex-rollout.ts (rollout JSONL -> normalized
// user/agent exchanges). This module preserves the public parse API consumed
// by sync/indexer/search and adds transparent .zst archive support on top.
import fs from 'node:fs';
import path from 'node:path';
import { ConversationExchange } from './types.js';
import { createArchiveReadStream } from './archive-io.js';
import { parseRolloutStream } from './codex-rollout.js';

export async function parseConversation(
  filePath: string,
  projectName: string,
  archivePath: string
): Promise<ConversationExchange[]> {
  const fileStream = createArchiveReadStream(filePath);
  try {
    const { meta, exchanges } = await parseRolloutStream(fileStream, { archivePath });
    if (meta && typeof meta.cwd === 'string') {
      for (const e of exchanges) (e as Record<string, unknown>).cwd = meta.cwd;
    }
    for (const e of exchanges) (e as Record<string, unknown>).project = projectName;
    return exchanges as unknown as ConversationExchange[];
  } finally {
    fileStream.destroy();
  }
}

/**
 * Convenience wrapper: derive the project key from the session's own cwd
 * (the rollout directory layout is dates, not projects) and parse the file.
 * Subagent threads are flagged via isSidechain so downstream sync can skip
 * them exactly like legacy sidechain transcripts.
 */
export async function parseConversationFile(filePath: string): Promise<{
  project: string;
  exchanges: ConversationExchange[];
}> {
  const fileStream = createArchiveReadStream(filePath);
  try {
    const { meta, isSubagent, exchanges } = await parseRolloutStream(fileStream, {
      archivePath: filePath,
    });
    const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : '';
    const project = cwd ? path.basename(cwd) : 'unknown';
    for (const e of exchanges) {
      const rec = e as Record<string, unknown>;
      rec.project = project;
      if (isSubagent) rec.isSidechain = true;
    }
    return { project, exchanges: exchanges as unknown as ConversationExchange[] };
  } finally {
    fileStream.destroy();
  }
}
