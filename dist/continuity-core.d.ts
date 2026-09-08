import fs from "node:fs";
import type Database from "better-sqlite3";
import { type CapsulePage } from "./continuity-evidence.js";
export declare const CONTINUITY_CAPTURE_POLICY_VERSION = "continuity-capture-v1";
export { CAPSULE_POLICY_VERSION } from "./continuity-evidence.js";
export declare const CONTINUITY_PARSER_VERSION = 2;
export declare const CAPTURE_CHUNK_BYTES: number;
export type CaptureKind = "stop" | "interrupt" | "precompact" | "final";
export type LifecycleSource = "startup" | "resume" | "clear" | "compact";
export type ResidentFactRevision = [string, number, number];
export interface NormalizedHookPayload {
    sessionId: string;
    transcriptPath: string | null;
    cwd: string;
    hookEventName: string;
    turnId: string | null;
    source: string | null;
    trigger: string | null;
    reason: string | null;
    permissionMode: string | null;
    stopHookActive: boolean;
    lastAssistantMessage: string | null;
    prompt: string | null;
    workstreamId: string | null;
}
export interface CaptureResult {
    checkpointId: string;
    captureIndexJobId: string;
    capsuleJobId: string | null;
    jobId: string;
    sessionId: string;
    streamEpoch: number;
    sourceFromByte: number;
    sourceThroughByte: number;
    fromLine: number;
    throughLine: number;
    segmentHash: string;
    prefixHash: string;
    appendedBytes: number;
    journalPath: string;
    created: boolean;
}
export interface CapsuleEvidenceItem {
    text: string;
    sourceExchangeIds: string[];
}
export interface WorkCapsulePatch {
    objective: string;
    currentState: string;
    verifiedProgress: CapsuleEvidenceItem[];
    hypotheses: CapsuleEvidenceItem[];
    blockers: string[];
    openQuestions: string[];
    nextActions: string[];
    touchedAreas: string[];
    carryFactRevisions: ResidentFactRevision[];
    sourceExchangeIds: string[];
}
/** Native generation shape only; provenance, bounds and CAS remain local. */
export declare const WORK_CAPSULE_OUTPUT_SCHEMA: {
    type: string;
    properties: {
        objective: {
            type: string;
        };
        currentState: {
            type: string;
            description: string;
        };
        verifiedProgress: {
            type: string;
            items: {
                type: string;
                properties: {
                    text: {
                        type: string;
                    };
                    sourceExchangeIds: {
                        type: string;
                        items: {
                            type: string;
                        };
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
        };
        hypotheses: {
            type: string;
            items: {
                type: string;
                properties: {
                    text: {
                        type: string;
                    };
                    sourceExchangeIds: {
                        type: string;
                        items: {
                            type: string;
                        };
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
        };
        blockers: {
            type: string;
            items: {
                type: string;
            };
        };
        openQuestions: {
            type: string;
            items: {
                type: string;
            };
        };
        nextActions: {
            type: string;
            items: {
                type: string;
            };
        };
        touchedAreas: {
            type: string;
            items: {
                type: string;
            };
        };
        carryFactRevisions: {
            type: string;
            items: {
                type: string;
                items: {
                    anyOf: {
                        type: string;
                    }[];
                };
            };
        };
        sourceExchangeIds: {
            type: string;
            items: {
                type: string;
            };
        };
    };
    required: string[];
    additionalProperties: boolean;
};
export interface WorkCapsule extends WorkCapsulePatch {
    workstreamId: string;
    generation: number;
    throughCheckpointId: string | null;
    throughSeq: number;
    authority: "context-only";
    sourceWorkspaceId: string | null;
    sourceSessionId: string | null;
    updatedAt: string;
}
export interface HandleHookResult {
    stdout: string;
    warning?: string;
    capture?: CaptureResult;
    /** Durable recall provenance is prepared before residency and emitted by the hook after stdout. */
    recallReceipt?: ContinuityRecallReceipt;
}
export interface ContinuityRecallReceipt {
    id: string;
    prompt: string;
    status: "prepared";
}
export declare function normalizeHookPayload(input: unknown): NormalizedHookPayload;
export declare function validateTranscriptPath(candidate: string): {
    path: string;
    realpath: string;
    stat: fs.Stats;
};
export declare function ensureSessionMemoryState(db: Database.Database, input: {
    sessionId: string;
    project: string;
    explicitWorkstreamId?: string | null;
    branch?: string | null;
    prompt?: string | null;
    source?: string | null;
    now?: string;
}): {
    workstreamId: string;
    contextEpoch: number;
    projectId: string;
    workspaceId: string;
};
/** Preserve Stop/byte coalescing using database capture order, never session ordinals. */
export declare function scheduleCapsuleForCheckpoint(db: Database.Database, checkpointId: string, now?: string, force?: boolean): void;
export declare function scheduleCapsuleBacklog(db: Database.Database): void;
export declare function captureTranscriptPrefix(db: Database.Database, input: {
    sessionId: string;
    project: string;
    transcriptPath: string;
    kind: CaptureKind;
    turnId?: string | null;
    workstreamId?: string | null;
    now?: string;
    afterJournalChunk?: (bytesCopied: number) => void;
    afterJournalFsync?: () => void;
    afterCheckpoint?: () => void;
    afterJob?: () => void;
}): CaptureResult;
export declare function advanceContextEpoch(db: Database.Database, input: {
    sessionId: string;
    source: "compact" | "clear";
    turnId?: string | null;
    now?: string;
}): number;
export declare function readResidentFactRevisions(db: Database.Database, sessionId: string): {
    contextEpoch: number;
    resident: ResidentFactRevision[];
    carry: ResidentFactRevision[];
};
export declare function recordResidentFactRevisions(db: Database.Database, sessionId: string, contextEpoch: number, revisions: ResidentFactRevision[], now?: string): boolean;
export interface ResidentRevisionCorrection {
    scope_revoked?: boolean;
    id: string;
    fact: string;
    category: string;
    semantic_generation: number;
    lifecycle_generation: number;
    is_active: number;
    /** Statement the resident revision carried, from the Chronicle, when known. */
    previous_fact: string | null;
}
/**
 * Resident fact revisions whose current row differs (new semantic/lifecycle
 * generation or deactivated): exactly the facts whose earlier statement is
 * now stale in the model's context (RFC §12.4/§12.6). Purged rows are skipped
 * so a correction never resurrects removed text. Never-resident facts are not
 * corrections; they reach the context only through relevance retrieval.
 */
export declare function readResidentRevisionCorrections(db: Database.Database, sessionId: string): ResidentRevisionCorrection[];
export declare function validateWorkCapsulePatch(value: unknown): WorkCapsulePatch;
export declare function applyWorkCapsulePatch(db: Database.Database, input: {
    workstreamId: string;
    expectedGeneration: number;
    throughCheckpointId: string;
    patch: unknown;
    evidencePage?: CapsulePage;
    jobLease?: {
        jobId: string;
        owner: string;
        leaseGeneration: number;
    };
    now?: string;
}): WorkCapsule | null;
export declare function completeEmptyCapsuleCheckpoint(db: Database.Database, input: {
    checkpointId: string;
    jobId: string;
    owner: string;
    leaseGeneration: number;
    evidencePage?: CapsulePage;
    now?: string;
}): boolean;
export declare function readWorkCapsule(db: Database.Database, workstreamId: string): WorkCapsule | null;
export declare function buildDeterministicTailBaton(db: Database.Database, input: {
    sessionId: string;
    maxChars?: number;
    pending?: string[];
}): string;
export declare function buildRehydrationContext(db: Database.Database, input: {
    sessionId: string;
    maxChars?: number;
}): {
    context: string;
    factRevisions: ResidentFactRevision[];
    capsuleGeneration: number;
    projectRevisionComplete: boolean;
    projectMemoryRevision: number;
    contextEpoch: number;
    projectId: string | null;
    workstreamId: string | null;
    hotEvidenceCursor: number;
    hotEvidenceSeqs: number[];
};
export declare function handleContinuityHook(payloadValue: unknown, options?: {
    db?: Database.Database;
    strictCapture?: boolean;
}): HandleHookResult;
export declare function runtimePlatformSummary(): string;
/**
 * Apply the latest event-grounded closure fence after a transcript prefix has
 * been parsed. Raw EOF is not authoritative for final vs interrupted; the
 * lifecycle checkpoint is. A changed closure receives a new generation so an
 * already-running result for the parser-only state cannot become current.
 */
export declare function applyLatestLifecycleClosure(db: Database.Database, sessionId: string): boolean;
