import type Database from 'better-sqlite3';
import type { Fact, FactRelation } from './types.js';
export declare const SUBJECT_KEY_PATTERN: RegExp;
export declare function isSemanticSubjectKey(key: string | null | undefined): boolean;
export declare class StaleFactMutationError extends Error {
    constructor(message: string);
}
/** Explicit writer intent, separate from the caller's broader ReadScope. */
export interface MutationPolicy {
    kind: 'user-correction' | 'verified-extraction' | 'consolidation' | 'replicated' | 'identity';
    targets: ReadonlyArray<{
        id: string;
        state: string | null;
    }>;
    sources?: SourceSnapshot;
    /** Automatic text changes may only adopt this already verified input. */
    verifiedText?: string;
}
export declare function captureMutationPolicy(db: Database.Database, kind: MutationPolicy['kind'], factIds: readonly string[], options?: {
    sourceExchangeIds?: readonly string[];
    verifiedText?: string;
}): MutationPolicy;
/** Every meaning/placement writer calls this inside its final DB transaction. */
export declare function assertMutationPolicy(db: Database.Database, policy: MutationPolicy, factId: string, newText?: string): void;
/** Read permission is deliberately insufficient for automatic consolidation. */
export declare function consolidationEligibility(a: Fact, b: Fact, relation?: FactRelation): string | null;
/** Validate both snapshots inside the writer transaction, including identity-only changes. */
export declare function consolidationSnapshotValid(db: Database.Database, snapshots: readonly Fact[]): boolean;
export type SourceSnapshot = ReadonlyArray<{
    id: string;
    hash: string;
}>;
/** Exact source identity across model/embedding awaits; absent evidence fails closed. */
export declare function captureSourceSnapshot(db: Database.Database, ids: readonly string[]): SourceSnapshot | null;
export declare function sourceSnapshotValid(db: Database.Database, snapshot: SourceSnapshot): boolean;
/**
 * 이슈 #45: `authority`가 채워진 영수증은 로컬 검증이 아니라 **peer 권위**의
 * 흔적이다(remote semantic win). 이전에는 그 순간 영수증을 삭제했기 때문에
 * 해당 기기가 증거 결속을 영구히 잃었다 — 이제는 강등해서 남기고, 로컬
 * 검증으로는 세지 않는다. 로컬 재검증(백필 포함)이 성공하면 다시 NULL이 된다.
 */
export declare function hasLocalMeaningEvidence(db: Database.Database, fact: Fact): boolean;
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
export declare function recordLocalMeaningEvidence(db: Database.Database, factId: string, text: string, method: 'extractor' | 'user' | 'consolidator', sourceIds: readonly string[]): boolean;
/** Peer authority replaced the local meaning: the receipt is DEMOTED, not deleted. */
export declare const PEER_AUTHORITY_MARKER = "peer-authority";
