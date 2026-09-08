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
/** Imported authority is retained as peer evidence, never mistaken for local verification. */
export declare function hasLocalMeaningEvidence(db: Database.Database, fact: Fact): boolean;
/** Local verification receipt; never exported/imported as durable peer truth. */
export declare function recordLocalMeaningEvidence(db: Database.Database, factId: string, text: string, method: 'extractor' | 'user' | 'consolidator', sourceIds: readonly string[]): void;
