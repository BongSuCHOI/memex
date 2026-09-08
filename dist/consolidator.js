import { callMemoryModel, parseJsonResponse } from './llm.js';
// 값 사용분은 별도 import — `export … from` 은 재수출만 하고 로컬 바인딩을 만들지 않는다.
import { LlmCallError, classifyLlmError } from './llm-error-class.js';
import { getPendingConsolidationFacts, mergeFactContextDependencies, searchFactsInScope, updateFact, } from './fact-db.js';
import { assertMutationPolicy, captureMutationPolicy, captureSourceSnapshot, consolidationEligibility, consolidationSnapshotValid, hasLocalMeaningEvidence } from './fact-policy.js';
import { deactivateFactTransactional, mutateFactMeaningWithPolicy, StaleFactMutationError } from './fact-management.js';
import { currentEffectiveAt, currentEffectiveTime, currentEvidenceAuthority, judgeCompetingEvidence, recordChronicleEvent, } from './chronicle.js';
export const CONSOLIDATION_SYSTEM_PROMPT = `Compare two facts and determine their relationship.

## Relationship types (choose one)
- DUPLICATE: same content - merge
- CONTRADICTION: conflicting - new fact replaces old
- EVOLUTION: old fact evolved - update
- INDEPENDENT: separate - keep both

CONTRADICTION and EVOLUTION require the SAME subject and the SAME applicability
conditions (environment, time interval, exceptions and qualifiers). Different or
uncertain conditions mean INDEPENDENT. Never invent a merged sentence: the
server can only adopt an already verified input fact after its own policy checks.

## Output format
{
  "relation": "DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT",
  "same_subject": true,
  "same_conditions": true,
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
    // A readable project fact is not necessarily writable from this workstream.
    // Legacy path-only facts remain searchable but await explicit identity review.
    let scope = null;
    if (newFact.scope_type === 'global')
        scope = { type: 'global' };
    else if (newFact.project_id && newFact.promotion_state && newFact.promotion_state !== 'legacy-project') {
        scope = newFact.promotion_state === 'workstream' && newFact.workstream_id
            ? { type: 'workstream-id', projectId: newFact.project_id, workstreamId: newFact.workstream_id, workspaceId: newFact.workspace_id, includeGlobal: false }
            : newFact.promotion_state === 'workspace' && newFact.workspace_id
                ? { type: 'workspace-id', projectId: newFact.project_id, workspaceId: newFact.workspace_id, includeGlobal: false }
                : { type: 'project-id', projectId: newFact.project_id, includeGlobal: false };
    }
    if (!scope)
        return { called: false, verdict: 'none' };
    const candidates = searchFactsInScope(db, embeddingArray, scope, 5, SIMILARITY_THRESHOLD, {
        accept: candidate => consolidationEligibility(candidate, newFact) === null,
    });
    if (candidates.length === 0)
        return { called: false, verdict: 'none' };
    const closest = candidates[0];
    const sources = captureSourceSnapshot(db, [...closest.fact.source_exchange_ids, ...newFact.source_exchange_ids]);
    if (!sources)
        return { called: false, verdict: 'none' };
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
    const applied = await applyConsolidationResult(db, closest.fact, newFact, result, sources);
    return { called: true, verdict: applied ? result.relation : 'none' };
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
        // 재감사 P1-4(v4): 활성 상태 판정은 lifecycle_generation으로도 한다 —
        // deactivate→restore는 semantic_generation을 올리지 않지만, active
        // 참가자에 내린 비교는 더 이상 유효하지 않다(다음 run이 재비교).
        const current = db.prepare('SELECT is_active, semantic_generation, lifecycle_generation FROM facts WHERE id = ?').get(newFact.id);
        if (current?.is_active === 1 && (current.semantic_generation !== newFact.semantic_generation ||
            current.lifecycle_generation !== Number(newFact.lifecycle_generation ?? 1))) {
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
export async function applyConsolidationResult(db, existingFact, newFact, result, expectedSources) {
    if (!consolidationSnapshotValid(db, [existingFact, newFact])) {
        throw new StaleFactMutationError('consolidation discarded: participant state or identity changed');
    }
    const preserveReason = (reason) => {
        // One fact's local review note must not disclose a sibling's text/identity.
        recordChronicleEvent(db, {
            kind: 'ASSERTED', factId: newFact.id, projectId: newFact.project_id, subjectKey: newFact.subject_key,
            actor: 'consolidator', classifierNote: `consolidation withheld: ${reason}`,
            effectiveAt: newFact.semantic_updated_at ?? newFact.created_at, effectiveAtSource: 'recorded',
            outcome: { consolidation: 'preserved', reason, semantic_generation: newFact.semantic_generation ?? 1 },
            projectionApplied: false,
        });
        return false;
    };
    if (!['DUPLICATE', 'CONTRADICTION', 'EVOLUTION', 'INDEPENDENT'].includes(result.relation))
        return preserveReason('invalid model verdict');
    if (result.relation === 'INDEPENDENT')
        return false;
    const blocked = consolidationEligibility(existingFact, newFact, result.relation);
    if (blocked) {
        return preserveReason(blocked);
    }
    const sources = expectedSources ?? captureSourceSnapshot(db, [...existingFact.source_exchange_ids, ...newFact.source_exchange_ids]);
    if (!sources)
        return preserveReason('source evidence is missing');
    const policy = { ...captureMutationPolicy(db, 'consolidation', [existingFact.id, newFact.id], { verifiedText: newFact.fact }), sources };
    const guard = () => assertMutationPolicy(db, policy, existingFact.id);
    guard();
    if ([existingFact, newFact].some(fact => fact.source_exchange_ids.length > 0 && !hasLocalMeaningEvidence(db, fact))) {
        return preserveReason('participant evidence has no current local verification');
    }
    const mergedSources = [...new Set([
            ...existingFact.source_exchange_ids,
            ...newFact.source_exchange_ids,
        ])];
    const newEvidenceSource = newFact.source_exchange_ids[0] ?? null;
    switch (result.relation) {
        case 'DUPLICATE': {
            // Meaning/lifecycle/scope/source guards and both live lineage reads share
            // the survivor update + incoming deactivation transaction.
            const apply = db.transaction(() => {
                guard();
                const liveSources = [...new Set([existingFact.id, newFact.id].flatMap(id => {
                        const row = db.prepare('SELECT source_exchange_ids FROM facts WHERE id = ?').get(id);
                        const ids = JSON.parse(row.source_exchange_ids);
                        if (!Array.isArray(ids) || !ids.every(value => typeof value === 'string'))
                            throw new Error('invalid participant lineage');
                        return ids;
                    }))];
                updateFact(db, existingFact.id, {
                    consolidated_count_increment: true,
                    source_exchange_ids: liveSources,
                });
                mergeFactContextDependencies(db, existingFact.id, [newFact.id]);
                // A duplicate is a rephrasing: the survivor keeps the truth, so no
                // RETIRED event is written for the absorbed row (RFC §15.1).
                deactivateFactTransactional(db, newFact.id, { chronicle: false });
                return true;
            });
            if (!apply()) {
                throw new StaleFactMutationError(`consolidation DUPLICATE discarded: fact ${existingFact.id} / ${newFact.id} changed meaning during comparison`);
            }
            break;
        }
        case 'CONTRADICTION':
        case 'EVOLUTION': {
            if (result.same_subject !== true || result.same_conditions !== true)
                return preserveReason('subject or applicability is unconfirmed');
            if (!hasLocalMeaningEvidence(db, newFact))
                return preserveReason('incoming meaning has no current local verification');
            // Effective source time and authority choose the current value.
            // The model's reason remains a non-authoritative classifier note.
            const existingEffective = currentEffectiveAt(db, existingFact.id);
            // A candidate without any source-effective time falls back to its local
            // write clock; the event then says `recorded` so the uncertainty is
            // visible instead of being presented as evidence time.
            const incomingTime = currentEffectiveTime(db, newFact.id);
            const incomingEffective = incomingTime?.at ?? newFact.semantic_updated_at ?? newFact.created_at;
            const incomingEffectiveSource = incomingTime?.source ?? 'recorded';
            const judgement = judgeCompetingEvidence({
                existingEffectiveAt: existingEffective,
                existingAuthority: currentEvidenceAuthority(db, existingFact.id),
                incomingEffectiveAt: incomingEffective,
                incomingAuthority: currentEvidenceAuthority(db, newFact.id),
            });
            if (judgement.verdict === 'apply') {
                await mutateFactMeaningWithPolicy(db, {
                    policy,
                    commitGuard: () => {
                        guard();
                        if (!hasLocalMeaningEvidence(db, newFact)) {
                            throw new StaleFactMutationError('consolidation discarded: incoming verification changed');
                        }
                    },
                    factId: existingFact.id,
                    newText: newFact.fact,
                    source: { exchangeId: newEvidenceSource ?? undefined, exchangeIds: mergedSources },
                    lineageMode: 'preserve-identity',
                    expectedPreviousFact: existingFact.fact,
                    expectedSemanticGeneration: existingFact.semantic_generation ?? 1,
                    expectedLifecycleGeneration: existingFact.lifecycle_generation ?? 1,
                    consolidatedCountIncrement: result.relation === 'EVOLUTION',
                    mergeContextFromFactIds: [newFact.id],
                    deactivateFacts: [
                        {
                            id: newFact.id,
                            expectedSemanticGeneration: newFact.semantic_generation ?? 1,
                            expectedLifecycleGeneration: newFact.lifecycle_generation ?? 1,
                        },
                    ],
                    chronicle: {
                        actor: 'consolidator',
                        classifierNote: `${result.relation}: ${result.reason}`,
                        effectiveAt: incomingEffective,
                        effectiveAtSource: incomingEffectiveSource,
                        evidenceAuthority: currentEvidenceAuthority(db, newFact.id),
                        outcome: { consolidation: result.relation, temporal: judgement.reason, absorbed_fact_id: newFact.id,
                            verified_input_fact_id: newFact.id, automatic_rewrite: false },
                    },
                });
                break;
            }
            // The current value stays. Preserve the competing statement as
            // Chronicle history (older evidence) or as an unresolved contradiction
            // candidate; neither overwrites the projection.
            const preserve = db.transaction(() => {
                guard();
                recordChronicleEvent(db, {
                    kind: judgement.verdict === 'historical' ? 'ASSERTED' : 'CONTRADICTED',
                    projectId: existingFact.project_id ?? null,
                    subjectKey: existingFact.subject_key ?? null,
                    factId: existingFact.id,
                    fromSemanticGeneration: existingFact.semantic_generation ?? 1,
                    toSemanticGeneration: null,
                    previousValue: judgement.verdict === 'historical' ? null : existingFact.fact,
                    newValue: newFact.fact,
                    classifierNote: `${result.relation}: ${result.reason}`,
                    outcome: {
                        resolution: judgement.verdict === 'historical' ? 'historical' : 'unresolved',
                        temporal: judgement.reason,
                        candidate_fact_id: newFact.id,
                        consolidation: result.relation,
                    },
                    sourceExchangeIds: newFact.source_exchange_ids,
                    actor: 'consolidator',
                    evidenceAuthority: currentEvidenceAuthority(db, newFact.id),
                    effectiveAt: incomingEffective,
                    effectiveAtSource: incomingEffectiveSource,
                    projectionApplied: false,
                });
                if (judgement.verdict === 'historical') {
                    // Older evidence is history for the existing subject; the candidate
                    // row is absorbed (its value lives in the Chronicle), not retired.
                    mergeFactContextDependencies(db, existingFact.id, [newFact.id]);
                    deactivateFactTransactional(db, newFact.id, { chronicle: false });
                }
                return true;
            });
            if (!preserve()) {
                throw new StaleFactMutationError(`consolidation ${result.relation} discarded: fact ${existingFact.id} / ${newFact.id} changed during comparison`);
            }
            break;
        }
    }
    return true;
}
