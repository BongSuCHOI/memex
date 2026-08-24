import { ConversationExchange } from './types.js';
export declare function parseConversation(filePath: string, projectName: string, archivePath: string): Promise<ConversationExchange[]>;
/**
 * Convenience wrapper: derive the project key from the session's own cwd
 * (the rollout directory layout is dates, not projects) and parse the file.
 * Subagent threads are flagged via isSidechain so downstream sync can skip
 * them exactly like legacy sidechain transcripts.
 */
export declare function parseConversationFile(filePath: string): Promise<{
    project: string;
    exchanges: ConversationExchange[];
}>;
