import type Database from 'better-sqlite3';
import type { ConversationExchange } from './types.js';
/**
 * Single ingestion SSOT for every archive→index entrypoint (sync,
 * indexConversations/indexSession/indexUnprocessed, verify --repair).
 *
 * Owning the whole pipeline in one place is the point: the desired-set
 * reconciliation and the insert loop must apply the worker-prompt exclusion
 * together, and no entrypoint may bypass it. verify --repair once re-indexed
 * worker prompts because its copy of the loop lacked the filter — the exact
 * entrypoint별 정책 drift this module exists to prevent (재감사 P2-11).
 *
 * Worker-prompt exchanges are the plugin's own ephemeral state, not knowledge:
 * they are excluded from the desired set (so stale rows are reconciled away)
 * and from the insert loop (so they are never indexed).
 */
export declare function ingestArchiveExchanges(db: Database.Database, archivePath: string, exchanges: ConversationExchange[]): Promise<number>;
/**
 * Monotonic partial ingestion for checkpoint prefixes. Unlike the canonical
 * archive path above, this never reconciles a desired set and therefore never
 * deletes exchanges missing from an older/shorter prefix. DB generation and
 * line guards reject regression before vectors or tool evidence are replaced.
 */
export declare function ingestPrefixExchanges(db: Database.Database, exchanges: ConversationExchange[]): Promise<{
    indexed: number;
    ignoredRegressions: number;
}>;
