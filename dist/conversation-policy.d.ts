import type Database from "better-sqlite3";
export declare const USER_EXCLUSION_MARKERS: readonly ["<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>", "Only use NO_INSIGHTS_FOUND", "Context: This summary will be shown in a list to help users and Codex choose which conversations are relevant"];
export type ConversationIneligibilityReason = "subagent" | "excluded_project" | "user_excluded";
export type ConversationEligibility = {
    eligible: true;
} | {
    eligible: false;
    reason: ConversationIneligibilityReason;
};
export interface ConversationEligibilityInput {
    filePath: string;
    project: string;
    isSubagent?: boolean;
    excludedProjects?: string[];
}
export interface ConversationPurgeResult {
    exchanges: number;
    facts: number;
    summaries: number;
}
/**
 * User exclusion applies only to user-role message payloads. Raw transcript
 * bytes, tool output, and assistant output can quote marker source text and
 * must never exclude a conversation by themselves.
 */
export declare function isUserExcludedConversation(filePath: string): Promise<boolean>;
/** Single ingestion-policy decision shared by sync, index, repair, and summary. */
export declare function getConversationEligibility(input: ConversationEligibilityInput): Promise<ConversationEligibility>;
/**
 * Conversation-wide user exclusion purge. Source rollouts stay untouched and
 * their archive copy remains retained/rebuildable; searchable and model-derived
 * state is removed. Facts touching excluded evidence are removed as a whole
 * because a merged sentence cannot prove which words came from which source.
 */
export declare function purgeConversationFromIndex(db: Database.Database, input: {
    archivePath: string;
    sessionId?: string | null;
}): ConversationPurgeResult;
