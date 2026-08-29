import { insertExchange, reconcileArchiveExchanges } from './db.js';
import { generateExchangeEmbedding, initEmbeddings } from './embeddings.js';
import { isWorkerPromptMessage } from './paths.js';
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
export async function ingestArchiveExchanges(db, archivePath, exchanges) {
    reconcileArchiveExchanges(db, {
        archivePath,
        desired: exchanges
            .filter((e) => !isWorkerPromptMessage(e.userMessage))
            .map((e) => ({ id: e.id, lineStart: e.lineStart })),
    });
    await initEmbeddings();
    let indexed = 0;
    for (const exchange of exchanges) {
        if (isWorkerPromptMessage(exchange.userMessage))
            continue;
        const toolNames = exchange.toolCalls?.map((tc) => tc.toolName);
        const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
        insertExchange(db, exchange, embedding, toolNames);
        indexed++;
    }
    return indexed;
}
