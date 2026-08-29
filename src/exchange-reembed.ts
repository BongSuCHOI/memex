import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getVecDtype, embeddingToVecBlob, vecParamSql } from './db.js';

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
export function exchangeContentHash(
  userMessage: string,
  assistantMessage: string,
  toolNames: string[],
): string {
  return createHash('md5')
    .update(JSON.stringify([userMessage, assistantMessage, toolNames]))
    .digest('hex');
}

/**
 * Commit a freshly generated exchange vector only if the row still holds the
 * exact content the vector was computed from. Returns false when the row is
 * gone (purged) or its content moved (turn growth) — the caller must treat
 * that as a stale discard, not an error.
 */
export function commitExchangeReembed(
  db: Database.Database,
  id: string,
  expectedContentHash: string,
  embedding: number[],
  embeddingVersion: number,
  lastIndexed: number,
): boolean {
  const tx = db.transaction((): boolean => {
    const row = db.prepare(
      'SELECT user_message, assistant_message FROM exchanges WHERE id = ?',
    ).get(id) as { user_message: string; assistant_message: string } | undefined;
    if (!row) return false;
    const toolNames = (
      db.prepare('SELECT tool_name FROM tool_calls WHERE exchange_id = ? ORDER BY rowid')
        .all(id) as Array<{ tool_name: string }>
    ).map((t) => t.tool_name);
    if (
      exchangeContentHash(row.user_message, row.assistant_message, toolNames) !==
      expectedContentHash
    ) {
      return false;
    }
    // dtype read INSIDE the transaction so the blob matches the vec schema.
    const vecDtype = getVecDtype(db);
    db.prepare('UPDATE exchanges SET embedding = NULL, embedding_version = ?, last_indexed = ? WHERE id = ?')
      .run(embeddingVersion, lastIndexed, id);
    db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(id);
    db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(vecDtype)})`)
      .run(id, embeddingToVecBlob(embedding, vecDtype));
    return true;
  });
  // .immediate(): acquire the write lock at BEGIN, before the schema read.
  return tx.immediate();
}
