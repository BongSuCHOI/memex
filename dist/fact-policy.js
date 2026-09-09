import { createHash } from 'node:crypto';
export const SUBJECT_KEY_PATTERN = /^(state|decision|constraint|preference|pattern)(\.[a-z0-9_]{1,40}){1,4}$/;
export function isSemanticSubjectKey(key) {
    return !!key && SUBJECT_KEY_PATTERN.test(key) && !/\.fact\.[0-9a-f-]{36}$/.test(key);
}
export class StaleFactMutationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StaleFactMutationError';
    }
}
function mutationState(db, id, kind) {
    const row = db.prepare(`SELECT fact, scope_type, project_id, workspace_id, workstream_id,
    promotion_state, subject_key, semantic_generation, lifecycle_generation, is_active
    FROM facts WHERE id = ?`).get(id);
    if (!row)
        return null;
    // Replication's semantic/lifecycle axes are independent. Local lifecycle
    // changes must not prevent a valid remote semantic update.
    if (kind === 'replicated') {
        delete row.lifecycle_generation;
        delete row.is_active;
    }
    return JSON.stringify(row);
}
export function captureMutationPolicy(db, kind, factIds, options = {}) {
    if (factIds.length === 0 || factIds.some(id => typeof id !== 'string' || !id))
        throw new Error('MutationPolicy requires exact target IDs');
    const sources = options.sourceExchangeIds === undefined ? undefined : captureSourceSnapshot(db, options.sourceExchangeIds);
    if (sources === null)
        throw new StaleFactMutationError('mutation evidence is missing');
    return { kind, targets: [...new Set(factIds)].map(id => ({ id, state: mutationState(db, id, kind) })),
        ...(sources ? { sources } : {}), ...(options.verifiedText !== undefined ? { verifiedText: options.verifiedText.trim() } : {}) };
}
/** Every meaning/placement writer calls this inside its final DB transaction. */
export function assertMutationPolicy(db, policy, factId, newText) {
    if (!policy || !['user-correction', 'verified-extraction', 'consolidation', 'replicated', 'identity'].includes(policy.kind)) {
        throw new Error('MutationPolicy is required');
    }
    if (!Array.isArray(policy.targets) || !policy.targets.some(target => target.id === factId))
        throw new Error('fact is outside MutationPolicy');
    for (const target of policy.targets) {
        if (mutationState(db, target.id, policy.kind) !== target.state)
            throw new StaleFactMutationError('mutation participant meaning, lifecycle or scope changed');
        if (policy.kind === 'consolidation') {
            const row = db.prepare('SELECT is_active FROM facts WHERE id = ?').get(target.id);
            if (row?.is_active !== 1)
                throw new StaleFactMutationError('consolidation participant is inactive');
        }
    }
    if (policy.sources && !sourceSnapshotValid(db, policy.sources))
        throw new StaleFactMutationError('mutation source evidence changed');
    if (newText !== undefined && (policy.kind === 'consolidation' || policy.kind === 'verified-extraction') && newText.trim() !== policy.verifiedText) {
        throw new Error('automatic mutation cannot rewrite verified text');
    }
    if (newText !== undefined && policy.kind === 'identity')
        throw new Error('identity policy cannot rewrite meaning');
}
/** Read permission is deliberately insufficient for automatic consolidation. */
export function consolidationEligibility(a, b, relation) {
    if (a.id === b.id)
        return 'same participant';
    if (!a.is_active || !b.is_active)
        return 'inactive participant';
    if (a.scope_type !== b.scope_type)
        return 'different scope types';
    if (a.scope_type === 'project') {
        if (!a.project_id || !b.project_id || a.promotion_state === 'legacy-project' || b.promotion_state === 'legacy-project' ||
            !a.promotion_state || !b.promotion_state)
            return 'legacy or incomplete project identity';
        if (a.project_id !== b.project_id || a.promotion_state !== b.promotion_state ||
            (a.workspace_id ?? null) !== (b.workspace_id ?? null) ||
            (a.workstream_id ?? null) !== (b.workstream_id ?? null))
            return 'different mutation scope';
        if (a.promotion_state === 'workstream' && !a.workstream_id)
            return 'missing workstream identity';
        if (a.promotion_state === 'workspace' && (!a.workspace_id || a.workstream_id))
            return 'invalid workspace identity';
        if ((a.promotion_state === 'project-current' || a.promotion_state === 'decision') &&
            (a.workspace_id || a.workstream_id))
            return 'invalid project-wide identity';
    }
    else if (a.project_id || b.project_id || a.workspace_id || b.workspace_id || a.workstream_id || b.workstream_id) {
        return 'global fact has project identity';
    }
    if (isSemanticSubjectKey(a.subject_key) && isSemanticSubjectKey(b.subject_key) && a.subject_key !== b.subject_key)
        return 'different subjects';
    if ((relation === 'CONTRADICTION' || relation === 'EVOLUTION') &&
        (!isSemanticSubjectKey(a.subject_key) || a.subject_key !== b.subject_key))
        return 'unresolved competing subject';
    return null;
}
const placement = ['scope_type', 'project_id', 'workspace_id', 'workstream_id', 'promotion_state', 'subject_key'];
/** Validate both snapshots inside the writer transaction, including identity-only changes. */
export function consolidationSnapshotValid(db, snapshots) {
    return snapshots.every(snapshot => {
        const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(snapshot.id);
        return !!row && row.is_active === 1 &&
            row.semantic_generation === (snapshot.semantic_generation ?? 1) &&
            row.lifecycle_generation === (snapshot.lifecycle_generation ?? 1) &&
            placement.every(key => (row[key] ?? null) === (snapshot[key] ?? null));
    });
}
/** Exact source identity across model/embedding awaits; absent evidence fails closed. */
export function captureSourceSnapshot(db, ids) {
    const result = [];
    for (const id of [...new Set(ids)].sort()) {
        const row = db.prepare(`SELECT id, timestamp, user_message, assistant_message, provenance,
      assistant_learnable, has_memex_recall, project_id, workspace_id, workstream_id
      FROM exchanges WHERE id = ?`).get(id);
        if (!row)
            return null;
        const toolRows = db.prepare('SELECT * FROM tool_calls WHERE exchange_id = ? ORDER BY id').all(id);
        result.push({ id, hash: createHash('sha256').update(JSON.stringify([row, toolRows])).digest('hex') });
    }
    return result;
}
export function sourceSnapshotValid(db, snapshot) {
    return JSON.stringify(captureSourceSnapshot(db, snapshot.map(row => row.id))) === JSON.stringify(snapshot);
}
/**
 * 이슈 #45: `authority`가 채워진 영수증은 로컬 검증이 아니라 **peer 권위**의
 * 흔적이다(remote semantic win). 이전에는 그 순간 영수증을 삭제했기 때문에
 * 해당 기기가 증거 결속을 영구히 잃었다 — 이제는 강등해서 남기고, 로컬
 * 검증으로는 세지 않는다. 로컬 재검증(백필 포함)이 성공하면 다시 NULL이 된다.
 */
export function hasLocalMeaningEvidence(db, fact) {
    const receipt = db.prepare('SELECT semantic_generation, fact_hash, source_snapshot_json, authority FROM fact_evidence_receipts WHERE fact_id = ?')
        .get(fact.id);
    if (!receipt || receipt.authority || receipt.semantic_generation !== fact.semantic_generation ||
        receipt.fact_hash !== createHash('sha256').update(fact.fact).digest('hex'))
        return false;
    try {
        return sourceSnapshotValid(db, JSON.parse(receipt.source_snapshot_json));
    }
    catch {
        return false;
    }
}
/**
 * Local verification receipt; never exported/imported as durable peer truth.
 *
 * 이슈 #45: `void`가 아니라 boolean을 돌려준다. 예전에는 fact가 사라졌거나
 * 텍스트가 달라졌거나 source exchange가 해석되지 않으면 조용히 return했고,
 * 호출자는 영수증이 만들어지지 않았다는 사실 자체를 알 수 없었다 — 실측
 * 데이터에서 127개 중 118개에 영수증이 없던 상태가 아무 데도 드러나지 않은
 * 이유다. 컬럼을 명시적으로 나열하는 것도 의도적이다(additive `authority`
 * 컬럼이 위치 기반 INSERT를 깨뜨리므로).
 *
 * @returns 영수증이 실제로 기록됐으면 true
 */
export function recordLocalMeaningEvidence(db, factId, text, method, sourceIds) {
    const row = db.prepare('SELECT fact, semantic_generation FROM facts WHERE id = ?').get(factId);
    const sources = captureSourceSnapshot(db, sourceIds);
    if (!row || row.fact !== text || !sources)
        return false;
    db.prepare(`INSERT INTO fact_evidence_receipts
      (fact_id, semantic_generation, fact_hash, source_snapshot_json, method, verified_at, authority)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(fact_id) DO UPDATE SET semantic_generation = excluded.semantic_generation,
      fact_hash = excluded.fact_hash, source_snapshot_json = excluded.source_snapshot_json,
      method = excluded.method, verified_at = excluded.verified_at,
      authority = NULL`).run(factId, row.semantic_generation, createHash('sha256').update(text).digest('hex'), JSON.stringify(sources), method, new Date().toISOString());
    return true;
}
/** Peer authority replaced the local meaning: the receipt is DEMOTED, not deleted. */
export const PEER_AUTHORITY_MARKER = 'peer-authority';
