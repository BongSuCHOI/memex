import { callMemoryModel, parseJsonResponse } from './llm.js';
// 값 사용분은 별도 import — `export … from` 은 재수출만 하고 로컬 바인딩을 만들지 않는다.
import { LlmCallError, classifyLlmError } from './llm-error-class.js';
import { getPendingConsolidationFacts, searchFactsByScope, updateFact, } from './fact-db.js';
import { deactivateFactTransactional, mutateFactMeaning, StaleFactMutationError } from './fact-management.js';
export const CONSOLIDATION_SYSTEM_PROMPT = `Compare two facts and determine their relationship.

## Relationship types (choose one)
- DUPLICATE: same content - merge
- CONTRADICTION: conflicting - new fact replaces old
- EVOLUTION: old fact evolved - update
- INDEPENDENT: separate - keep both

## Output format
{
  "relation": "DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT",
  "merged_fact": "final sentence for merge/replace",
  "reason": "one-line justification"
}`;
const MAX_LLM_CALLS = 10;
// Cross-run retries for a driver fact whose comparison CALL keeps failing before
// it is skipped (removed from the dirty queue). A short/transient outage is retried until
// it recovers — a success resets the counter — while a persistently failing fact
// reaches MAX and is skipped so it can't wedge the queue. This spans runs on
// purpose: a real provider outage lasts across separate worker runs, which a
// run-local counter cannot see.
const MAX_CONSOLIDATION_ATTEMPTS = 3;
// e5 passage-passage scale (measured): near-dup 0.99, paraphrase 0.97,
// related-but-distinct ~0.91, unrelated <=0.86. 0.95 selects dup candidates.
const SIMILARITY_THRESHOLD = 0.95;
export function buildConsolidationPrompt(existingFact, newFact) {
    return `Existing fact: "${existingFact}"\nNew fact: "${newFact}"`;
}
export { LlmCallError, EmptyLlmResponseError, classifyLlmError, isTransientLlmError } from './llm-error-class.js';
/**
 * Consolidate ONE driver fact against a same-scope neighbour (if any).
 * Shared by consolidateAllPending and the back-compat consolidateFacts wrapper.
 *
 * `called` reports whether an LLM call was actually made — the caller MUST use
 * this (not the verdict) for budget accounting, because a call that returns
 * malformed/unparseable text still consumed the budget even though its verdict
 * is 'none'. Throws only on a transient LLM failure the caller should retry.
 */
async function consolidateOne(db, newFact) {
    if (!newFact.embedding)
        return { called: false, verdict: 'none' };
    const embeddingArray = Array.from(newFact.embedding);
    // SAME-SCOPE only (no cross-scope leak): project fact → its own project,
    // global fact → global. The scope gate is inside the search, before its
    // limit, so an in-scope match isn't starved by closer out-of-scope rows.
    const scope = newFact.scope_type === 'global'
        ? { type: 'global' }
        : newFact.scope_project
            ? { type: 'exact-project', project: newFact.scope_project }
            : null;
    if (!scope)
        return { called: false, verdict: 'none' };
    const candidates = searchFactsByScope(db, embeddingArray, scope, 5, SIMILARITY_THRESHOLD)
        .filter((s) => s.fact.id !== newFact.id);
    if (candidates.length === 0)
        return { called: false, verdict: 'none' };
    const closest = candidates[0];
    // Tag ONLY the provider call's rejection as an LlmCallError. Anything after
    // this (parseJsonResponse, applyConsolidationResult DB writes) throws as a
    // plain error, so the drain loop can hold on an internal bug instead of
    // treating it as a skippable "bad fact".
    let response;
    try {
        response = await callMemoryModel(CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationPrompt(closest.fact.fact, newFact.fact));
    }
    catch (e) {
        throw new LlmCallError(e);
    }
    const result = parseJsonResponse(response);
    // Unparseable output = the call happened (budget spent) but produced no usable
    // verdict. Treated as a no-op ('none'), NOT an error: consolidation is a
    // best-effort background dedup, so we clear this dirty item rather than hold
    // the queue. The pair is not lost — both facts stay active, and the
    // comparison re-triggers whenever either is a driver/candidate for a future
    // fact. This also means no single fact (a transiently non-JSON response, or a
    // deliberately "poison" candidate) can hold the queue and starve the backlog.
    if (!result)
        return { called: true, verdict: 'none' };
    await applyConsolidationResult(db, closest.fact, newFact, result);
    return { called: true, verdict: result.relation };
}
async function drainPending(db, project) {
    // Candidate comparison uses ALREADY-STORED vectors and an LLM. Do not eagerly
    // initialize embeddings: only EVOLUTION/CONTRADICTION needs a replacement
    // vector, and mutateFactMeaning initializes the model lazily for that verdict.
    const newFacts = getPendingConsolidationFacts(db, 2000, project);
    let llmCalls = 0;
    let merged = 0;
    let contradictions = 0;
    let evolutions = 0;
    let processed = 0;
    for (let i = 0; i < newFacts.length; i++) {
        const newFact = newFacts[i];
        if (llmCalls >= MAX_LLM_CALLS)
            break;
        // Re-read the queue generation: an earlier comparison or concurrent edit
        // may have deactivated or changed this fact after the bounded page loaded.
        // 재감사 P1-2: 세대 판정은 semantic_generation으로 한다 — 분류 같은 비의미
        // 메타데이터 쓰기가 updated_at을 움직여도 큐 판정이 흔들리지 않는다.
        const current = db.prepare('SELECT is_active, semantic_generation FROM facts WHERE id = ?').get(newFact.id);
        if (current?.is_active === 1 && current.semantic_generation !== newFact.semantic_generation) {
            continue; // newer generation stays dirty for the next run
        }
        if (current?.is_active === 1) {
            try {
                // Same-scope isolation + budget accounting via the shared helper.
                const { called, verdict } = await consolidateOne(db, newFact);
                if (called)
                    llmCalls++; // count the CALL, not the verdict
                if (verdict === 'DUPLICATE')
                    merged++;
                else if (verdict === 'CONTRADICTION')
                    contradictions++;
                else if (verdict === 'EVOLUTION')
                    evolutions++;
                // Clear only the exact generation examined. A concurrent import/edit
                // bumps semantic_generation and keeps the newer generation dirty for
                // the next run.
                db.prepare('UPDATE facts SET needs_consolidation = 0, consolidation_attempts = 0 WHERE id = ? AND semantic_generation = ?').run(newFact.id, newFact.semantic_generation);
            }
            catch (error) {
                llmCalls++;
                console.error(`Consolidation call failed for fact ${newFact.id}:`, error);
                if (error instanceof StaleFactMutationError) {
                    // 재감사 P1-2: 비교 중 fact 의미가 바뀌었다 — 판정은 폐기됐고 dirty는
                    // 유지된다(clear가 실행되지 않음). 내부 실패가 아니므로 큐를 멈추지 않고
                    // 다음 run이 새 의미를 다시 비교한다.
                }
                else if (!(error instanceof LlmCallError)) {
                    // A non-LLM error (parser/DB/internal bug, NOT an LlmCallError) must NEVER
                    // clear the dirty flag — hold so the bug surfaces instead of silently
                    // marking the fact processed and draining the backlog.
                    break;
                }
                else if (classifyLlmError(error) !== 'deterministic') {
                    // SKIP is reserved for a RECOGNIZED deterministic per-request rejection
                    // (400/413/422, too-long, max_tokens...) — the one case where the fact
                    // ITSELF is provably at fault. Transient (outage/auth) AND unknown both
                    // HOLD: an unrecognized provider error ("HTTP 500", "Error code: 503") is
                    // far more likely an unusual outage shape than a poison fact, so holding
                    // never drains the backlog during an outage. (Residual: a per-fact poison
                    // that never presents as a recognized deterministic error holds — but the
                    // global lock + budget mean it just stops, no flood, and the repeated
                    // fact id in the log makes it diagnosable.)
                    break;
                }
                else {
                    // Deterministic per-fact rejection: ledger it and, after MAX attempts,
                    // SKIP (clear it) so one un-processable fact can't wedge the queue.
                    // Below MAX, hold so a mis-classified blip still gets a couple of
                    // retries. The fact stays active/searchable; only best-effort
                    // consolidation stops after the bounded deterministic failures.
                    const attempts = db.prepare('UPDATE facts SET consolidation_attempts = COALESCE(consolidation_attempts, 0) + 1 WHERE id = ? AND semantic_generation = ? RETURNING consolidation_attempts').get(newFact.id, newFact.semantic_generation)?.consolidation_attempts ?? 0;
                    if (attempts >= MAX_CONSOLIDATION_ATTEMPTS) {
                        console.error(`Consolidation skip fact ${newFact.id} after ${attempts} deterministic failures`);
                        db.prepare('UPDATE facts SET needs_consolidation = 0 WHERE id = ? AND semantic_generation = ?').run(newFact.id, newFact.semantic_generation);
                        processed++;
                        continue;
                    }
                    break; // hold — retry this fact next run
                }
            }
        }
        // Fully examined (including a no-op / no-candidate / no-embedding fact).
        processed++;
    }
    const scopeClause = project
        ? " AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')"
        : '';
    const remaining = Number(db.prepare(`SELECT COUNT(*) AS n FROM facts
     WHERE is_active = 1 AND needs_consolidation = 1${scopeClause}`).get(...(project ? [project] : [])).n);
    return { processed, merged, contradictions, evolutions, llmCalls, remaining };
}
/**
 * @deprecated Back-compat wrapper for the removed per-project consolidator.
 * The timestamp argument is intentionally ignored: queue membership follows
 * local ingestion and semantic mutation, never historical created_at.
 */
export async function consolidateFacts(db, project, _lastConsolidatedAt) {
    const result = await drainPending(db, project);
    return {
        processed: result.processed,
        merged: result.merged,
        contradictions: result.contradictions,
        evolutions: result.evolutions,
    };
}
/** Drain the durable local dirty queue across every project and global scope. */
export async function consolidateAllPending(db) {
    return drainPending(db);
}
export async function applyConsolidationResult(db, existingFact, newFact, result) {
    // Normalize merged_fact: treat empty/whitespace-only as absent
    const mergedFact = result.merged_fact?.trim() || null;
    const mergedSources = [...new Set([
            ...existingFact.source_exchange_ids,
            ...newFact.source_exchange_ids,
        ])];
    const newEvidenceSource = newFact.source_exchange_ids[0] ?? null;
    switch (result.relation) {
        case 'DUPLICATE': {
            // One transaction: the survivor's count/provenance update and the
            // duplicate's deactivation are a single semantic step (SCHEMA §7 —
            // derived state never straddles commits). updateFact's inner vec
            // transaction nests as a savepoint inside this one.
            // 재감사 P1-2: 비교에 쓴 의미가 아직 현재인지 commit 시점에 CAS한다 —
            // LLM 왕복 동안 어느 쪽이든 변이됐으면 이 판정은 폐기된다(dirty 유지).
            // 재감사 P1-2(v4): provenance는 commit 시점에 live row를 다시 읽어
            // union한다 — sync import가 LLM 왕복 동안 provenance를 union했어도
            // (semantic_generation을 올리지 않는 metadata 쓰기) 이 읽기가 그 결과를
            // 흡수해 monotone union이 어떤 교차 순서에서도 유실되지 않는다.
            const apply = db.transaction(() => {
                const genStmt = db.prepare('SELECT semantic_generation, source_exchange_ids FROM facts WHERE id = ?');
                const existingNow = genStmt.get(existingFact.id);
                const newGen = genStmt.get(newFact.id)
                    ?.semantic_generation;
                if (!existingNow ||
                    existingNow.semantic_generation !== existingFact.semantic_generation ||
                    newGen !== newFact.semantic_generation) {
                    return false;
                }
                let liveSources = newFact.source_exchange_ids;
                try {
                    const parsed = JSON.parse(existingNow.source_exchange_ids ?? '[]');
                    if (Array.isArray(parsed)) {
                        liveSources = [...new Set([
                                ...parsed.filter((id) => typeof id === 'string'),
                                ...newFact.source_exchange_ids,
                            ])];
                    }
                }
                catch { /* unparseable local provenance — keep the new evidence side */ }
                updateFact(db, existingFact.id, {
                    consolidated_count_increment: true,
                    source_exchange_ids: liveSources,
                });
                deactivateFactTransactional(db, newFact.id);
                return true;
            });
            if (!apply()) {
                throw new StaleFactMutationError(`consolidation DUPLICATE discarded: fact ${existingFact.id} / ${newFact.id} changed meaning during comparison`);
            }
            break;
        }
        case 'CONTRADICTION':
            // 재감사 P1-2: CONTRADICTION/EVOLUTION도 DUPLICATE와 같은 CAS 계약이다 —
            // LLM 왕복 동안 어느 쪽이든 의미가 변이됐으면 이 판정은 폐기된다.
            // expectedSemanticGeneration은 existing 쪽(expectedPreviousFact는 텍스트
            // 우연 복귀를 못 잡는다), deactivateFacts의 세대 CAS는 driver 쪽을 지킨다.
            await mutateFactMeaning(db, {
                factId: existingFact.id,
                newText: mergedFact || newFact.fact,
                reason: result.reason,
                source: { exchangeId: newEvidenceSource ?? undefined, exchangeIds: mergedSources },
                lineageMode: 'preserve-identity',
                expectedPreviousFact: existingFact.fact,
                expectedSemanticGeneration: existingFact.semantic_generation ?? 1,
                deactivateFacts: [
                    { id: newFact.id, expectedSemanticGeneration: newFact.semantic_generation ?? 1 },
                ],
            });
            break;
        case 'EVOLUTION':
            await mutateFactMeaning(db, {
                factId: existingFact.id,
                newText: mergedFact || newFact.fact,
                reason: result.reason,
                source: { exchangeId: newEvidenceSource ?? undefined, exchangeIds: mergedSources },
                lineageMode: 'preserve-identity',
                expectedPreviousFact: existingFact.fact,
                expectedSemanticGeneration: existingFact.semantic_generation ?? 1,
                consolidatedCountIncrement: true,
                deactivateFacts: [
                    { id: newFact.id, expectedSemanticGeneration: newFact.semantic_generation ?? 1 },
                ],
            });
            break;
        case 'INDEPENDENT':
            // Keep both, do nothing
            break;
    }
}
