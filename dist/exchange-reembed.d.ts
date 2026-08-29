import type Database from 'better-sqlite3';
/**
 * CAS layer for the exchange re-embed worker (재감사 P1-2).
 *
 * Exchange ids are STABLE across turn growth (`mx:<session>:u<line>`), so the
 * same row's content is legally updated in place (assistant partial →
 * complete → tool evidence added) by sync/reindex. A re-embed that read the
 * row, awaited the model, then wrote unconditionally would either (a) pair a
 * stale turn's vector with the completed text while stamping
 * embedding_version=current — a mismatch the self-heal can never see — or
 * (b) resurrect a vec_exchanges row for an exchange a privacy purge deleted
 * mid-await (vec0 virtual tables cannot enforce FKs).
 *
 * The commit therefore re-reads the row's live content inside the write
 * transaction and compares it against the content hash captured before the
 * await. Any drift — or a purged row — discards the vector entirely.
 */
/** Content identity of an exchange row: everything the embedding text is
 * derived from (user turn, assistant turn, ordered tool evidence). */
export declare function exchangeContentHash(userMessage: string, assistantMessage: string, toolNames: string[]): string;
/**
 * Commit a freshly generated exchange vector only if the row still holds the
 * exact content the vector was computed from. Returns false when the row is
 * gone (purged) or its content moved (turn growth) — the caller must treat
 * that as a stale discard, not an error.
 */
export declare function commitExchangeReembed(db: Database.Database, id: string, expectedContentHash: string, embedding: number[], embeddingVersion: number, lastIndexed: number): boolean;
