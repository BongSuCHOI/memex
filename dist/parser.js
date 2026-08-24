import path from 'node:path';
import { createArchiveReadStream } from './archive-io.js';
import { parseRolloutStream } from './codex-rollout.js';
export async function parseConversation(filePath, projectName, archivePath) {
    const fileStream = createArchiveReadStream(filePath);
    try {
        const { meta, exchanges } = await parseRolloutStream(fileStream, { archivePath });
        if (meta && typeof meta.cwd === 'string') {
            for (const e of exchanges)
                e.cwd = meta.cwd;
        }
        for (const e of exchanges)
            e.project = projectName;
        return exchanges;
    }
    finally {
        fileStream.destroy();
    }
}
/**
 * Convenience wrapper: derive the project key from the session's own cwd
 * (the rollout directory layout is dates, not projects) and parse the file.
 * Subagent threads are flagged via isSidechain so downstream sync can skip
 * them exactly like legacy sidechain transcripts.
 */
export async function parseConversationFile(filePath) {
    const fileStream = createArchiveReadStream(filePath);
    try {
        const { meta, isSubagent, exchanges } = await parseRolloutStream(fileStream, {
            archivePath: filePath,
        });
        const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : '';
        const project = cwd ? path.basename(cwd) : 'unknown';
        for (const e of exchanges) {
            const rec = e;
            rec.project = project;
            if (isSubagent)
                rec.isSidechain = true;
        }
        return { project, exchanges: exchanges };
    }
    finally {
        fileStream.destroy();
    }
}
