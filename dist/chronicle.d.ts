import type Database from "better-sqlite3";
import { CHRONICLE_EVENT_KINDS } from "./continuity-store.js";
export { CHRONICLE_EVENT_KINDS };
/**
 * Phase 4 Chronicle — sparse, append-only semantic history.
 *
 * Current Facts (`facts`) remain the fast materialized projection. Every row
 * here is either a projection transition that already committed in the same
 * transaction (ASSERTED/CHANGED/RETIRED/RESTORED with `projection_applied = 1`)
 * or an event-only observation/candidate that changed nothing
 * (VALIDATED/INCIDENT/CONTRADICTED, historical ASSERTED, `projection_applied = 0`).
 *
 * Grounded fields (`problem`, `grounded_cause`, `rationale`) are only written
 * when the caller proves them against a stored authoritative source; model or
 * consolidator inference is stored as `classifier_note` and formatted as such.
 * `effective_at` is the time the decision/change/incident happened according
 * to its source; `recorded_at` is when Memex processed it. Timelines order by
 * `effective_at`, never by worker completion order.
 */
export type ChronicleEventKind = (typeof CHRONICLE_EVENT_KINDS)[number];
export type ChronicleActor = "extractor" | "consolidator" | "user" | "sync" | "legacy";
export type EvidenceAuthority = "human-decision" | "human" | "trusted-tool" | "unknown";
export type EffectiveAtSource = "source" | "recorded" | "peer";
export declare const CHRONICLE_POLICY_VERSION = "chronicle-v1";
export declare const INCIDENT_COALESCE_WINDOW_MS: number;
export declare const CHRONICLE_TIMELINE_MAX_LIMIT = 100;
export declare const CHRONICLE_LANE_LABELS: {
    readonly currentFact: "CURRENT FACT";
    readonly event: "CHRONICLE EVENT";
    readonly rawEvidence: "RAW EVIDENCE";
    readonly assistantContext: "ASSISTANT CONTEXT-ONLY";
    readonly hotEvidence: "HOT EVIDENCE — NOT YET DISTILLED";
    readonly telemetry: "TELEMETRY — MEASURED, NOT A FACT";
};
export declare class ChronicleGroundingError extends Error {
    constructor(message: string);
}
export declare class ChronicleConflictError extends Error {
    constructor(message: string);
}
export interface ChronicleEvent {
    id: string;
    project_id: string | null;
    subject_key: string | null;
    fact_id: string | null;
    event_kind: ChronicleEventKind;
    from_semantic_generation: number | null;
    to_semantic_generation: number | null;
    lifecycle_generation: number | null;
    previous_value: string | null;
    new_value: string | null;
    problem: string | null;
    grounded_cause: string | null;
    rationale: string | null;
    classifier_note: string | null;
    outcome: Record<string, unknown> | null;
    source_exchange_ids: string[];
    source_evidence_ids: string[];
    reverts_event_id: string | null;
    related_event_ids: string[];
    actor: ChronicleActor;
    policy_version: string;
    evidence_authority: EvidenceAuthority;
    effective_at: string;
    effective_at_source: EffectiveAtSource;
    recorded_at: string;
    projection_applied: boolean;
    created_at: string;
}
/** A cause/rationale/problem statement bound to the source that states it. */
export interface GroundedField {
    text: string;
    /** Exchange whose human message or trusted tool result contains `supporting_span`. */
    exchangeId: string;
    supportingSpan: string;
    /** When set, the span must appear in this trusted tool result of the exchange. */
    toolCallId?: string;
}
export interface RecordChronicleEventInput {
    kind: ChronicleEventKind;
    projectId?: string | null;
    subjectKey?: string | null;
    factId?: string | null;
    fromSemanticGeneration?: number | null;
    toSemanticGeneration?: number | null;
    lifecycleGeneration?: number | null;
    previousValue?: string | null;
    newValue?: string | null;
    /** Source-cited fields. Verified against stored exchanges/tool results; rejected when unproven. */
    grounded?: {
        problem?: GroundedField;
        cause?: GroundedField;
        rationale?: GroundedField;
    };
    /** Rationale typed directly by the user (CLI/MCP). Only legal for actor `user`. */
    userStatedRationale?: string | null;
    classifierNote?: string | null;
    outcome?: Record<string, unknown> | null;
    sourceExchangeIds?: string[];
    sourceEvidenceIds?: string[];
    revertsEventId?: string | null;
    relatedEventIds?: string[];
    actor: ChronicleActor;
    policyVersion?: string;
    evidenceAuthority?: EvidenceAuthority;
    effectiveAt?: string | null;
    effectiveAtSource?: EffectiveAtSource;
    recordedAt?: string;
    projectionApplied: boolean;
}
export interface RecordChronicleEventResult {
    event: ChronicleEvent;
    inserted: boolean;
}
export declare function rowToChronicleEvent(row: Record<string, unknown>): ChronicleEvent;
/** Deterministic content-derived id: duplicate delivery and sync replay of the same event collapse. */
export declare function chronicleEventId(input: {
    kind: string;
    projectId: string | null;
    subjectKey: string | null;
    factId: string | null;
    effectiveAt: string;
    previousValue: string | null;
    newValue: string | null;
    sourceExchangeIds: string[];
    sourceEvidenceIds: string[];
    revertsEventId: string | null;
    outcome: Record<string, unknown> | null;
}): string;
/** Fail-closed check that a stated cause/rationale/problem is present in a stored authoritative source. */
export declare function verifyGroundedField(db: Database.Database, field: GroundedField): boolean;
export declare function getChronicleEvent(db: Database.Database, eventId: string): ChronicleEvent | null;
/**
 * Append one Chronicle event. Must be called inside the same transaction as
 * the projection mutation it describes so current state and history never
 * commit separately. Duplicate delivery of identical content is a no-op.
 */
export declare function recordChronicleEvent(db: Database.Database, input: RecordChronicleEventInput): RecordChronicleEventResult;
/** Raw insert for replicated peer events. Content is stored as delivered; device-local generations are dropped. */
export declare function insertReplicatedChronicleEvent(db: Database.Database, event: Omit<ChronicleEvent, "from_semantic_generation" | "to_semantic_generation" | "lifecycle_generation" | "created_at"> & {
    created_at?: string;
}): "inserted" | "duplicate" | "conflict" | "tombstoned";
export interface ChronicleTimelineQuery {
    projectId?: string | null;
    subjectKey?: string | null;
    factId?: string | null;
    kinds?: ChronicleEventKind[];
    workspaceId?: string | null;
    workstreamId?: string | null;
    sessionId?: string | null;
    /** Keyset cursor returned by a previous page. */
    cursor?: string | null;
    limit?: number;
    order?: "asc" | "desc";
    includeGlobal?: boolean;
    /**
     * Project scope: hide the history of unmerged workspace/workstream facts
     * (they are not project-wide truth). Ignored when a workspace/workstream
     * filter is given, which selects exactly that scope's visibility.
     */
    projectTruthOnly?: boolean;
}
export interface ChronicleTimelinePage {
    events: ChronicleEvent[];
    nextCursor: string | null;
    limit: number;
}
interface TimelineCursor {
    effective_at: string;
    recorded_at: string;
    seq: number;
}
export declare function encodeTimelineCursor(cursor: TimelineCursor): string;
export declare function decodeTimelineCursor(raw: string | null | undefined): TimelineCursor | null;
export declare function readChronicleTimeline(db: Database.Database, query: ChronicleTimelineQuery): ChronicleTimelinePage;
export interface CurrentFactRevision {
    factId: string;
    projectId: string | null;
    subjectKey: string | null;
    promotionState: string;
    isActive: boolean;
    fact: string;
    semanticGeneration: number;
    lifecycleGeneration: number;
    semanticUpdatedAt: string;
    lifecycleUpdatedAt: string;
    latestEventId: string | null;
    latestEffectiveAt: string | null;
    latestEffectiveAtSource: EffectiveAtSource | null;
}
/** Current projection revision for one fact, plus its latest projection-changing event. */
export declare function currentFactRevision(db: Database.Database, factId: string): CurrentFactRevision | null;
/**
 * Effective time of the current projection value plus how it was established
 * (`source` = cited evidence timestamp, `recorded` = a worker clock that was
 * the only thing available), used for temporal ordering of incoming evidence.
 */
export declare function currentEffectiveTime(db: Database.Database, factId: string): {
    at: string;
    source: EffectiveAtSource;
} | null;
export declare function currentEffectiveAt(db: Database.Database, factId: string): string | null;
export declare const SUBJECT_KEY_PATTERN: RegExp;
/** Validate a model-proposed subject key against the stable slot grammar and its category prefix. */
export declare function normalizeSubjectKey(raw: unknown, category: string): string | null;
export declare function isSemanticSubjectKey(key: string | null | undefined): boolean;
export declare function normalizeSlotText(text: string): string;
export declare const AUTHORITY_RANK: Record<EvidenceAuthority, number>;
export declare function evidenceAuthorityFromKinds(evidence: Array<{
    source: string;
    kind: string;
}> | undefined): EvidenceAuthority;
export interface SubjectSlotLookup {
    projectId: string | null;
    subjectKey: string;
    promotionState: string;
    workspaceId?: string | null;
    workstreamId?: string | null;
}
export declare function findCurrentSlotFact(db: Database.Database, slot: SubjectSlotLookup): {
    id: string;
    fact: string;
    semantic_generation: number;
    lifecycle_generation: number;
    source_exchange_ids: string | null;
} | null;
/** Latest authority recorded for a fact's current projection. */
export declare function currentEvidenceAuthority(db: Database.Database, factId: string): EvidenceAuthority;
export type TemporalVerdict = "apply" | "historical" | "contradicted";
/**
 * Deterministic judgment for competing evidence on one subject slot. Worker
 * completion order never decides; only source-effective time and authority do.
 */
export declare function judgeCompetingEvidence(input: {
    existingEffectiveAt: string | null;
    existingAuthority: EvidenceAuthority;
    incomingEffectiveAt: string;
    incomingAuthority: EvidenceAuthority;
}): {
    verdict: TemporalVerdict;
    reason: string;
};
export interface IncidentSignature {
    key: string;
    text: string;
}
/** Stable, device-neutral failure signature: strips addresses, counters, paths and timestamps. */
export declare function normalizeIncidentSignature(raw: string): IncidentSignature;
export interface RecordIncidentInput {
    projectId: string;
    workspaceId?: string | null;
    workstreamId?: string | null;
    sessionId?: string | null;
    subjectKey?: string | null;
    /** Raw failure text (test output, error line, or the user's description). */
    signatureText: string;
    summary?: string | null;
    sourceExchangeIds: string[];
    /** tool_calls ids proving the failure; required for trusted-tool authority. */
    sourceEvidenceIds?: string[];
    evidenceAuthority: "trusted-tool" | "human";
    /** The user explicitly said this keeps happening. */
    userFlaggedRepeat?: boolean;
    classifierNote?: string | null;
    effectiveAt?: string | null;
    recordedAt?: string;
    actor: ChronicleActor;
}
export interface RecordIncidentResult {
    coalesced: boolean;
    occurrenceId: string;
    eventId: string;
    signatureKey: string;
    signatureText: string;
    patternState: "candidate" | "pattern" | "remediated";
    episodeCount: number;
}
/**
 * Record one incident episode. Retries of the same failure inside one session
 * within the coalescing window collapse into the existing occurrence and emit
 * no new event; independent episodes append an INCIDENT event.
 */
export declare function recordIncidentOccurrence(db: Database.Database, input: RecordIncidentInput): RecordIncidentResult;
export interface RecordRemediationInput {
    projectId: string;
    signatureKey: string;
    subjectKey?: string | null;
    summary: string;
    sourceExchangeIds: string[];
    sourceEvidenceIds?: string[];
    evidenceAuthority: "trusted-tool" | "human";
    effectiveAt?: string | null;
    recordedAt?: string;
    actor: ChronicleActor;
}
/** A pattern is resolved only by verified remediation evidence, never by silence. */
export declare function recordIncidentRemediation(db: Database.Database, input: RecordRemediationInput): {
    eventId: string;
    remediatedOccurrences: number;
};
export interface IncidentPatternMatch {
    signatureKey: string;
    signatureText: string;
    patternState: "candidate" | "pattern" | "remediated";
    episodeCount: number;
    firstEffectiveAt: string;
    lastEffectiveAt: string;
    remediationSummary: string | null;
    remediationEventId: string | null;
    score: number;
}
/**
 * Bounded deterministic match for Phase 5 WATCH: a signature matches the
 * prompt/error text when the normalized signature is contained in it or the
 * token overlap is high. Candidates are excluded unless requested.
 */
export declare function matchIncidentPatterns(db: Database.Database, input: {
    projectId: string;
    text: string;
    limit?: number;
    includeCandidates?: boolean;
    includeRemediated?: boolean;
    minScore?: number;
}): IncidentPatternMatch[];
export interface IncidentOccurrenceRow {
    occurrence_id: string;
    project_id: string;
    workspace_id: string | null;
    workstream_id: string | null;
    session_id: string | null;
    signature_key: string;
    signature_text: string;
    subject_key: string | null;
    event_id: string;
    source_exchange_ids: string[];
    source_evidence_ids: string[];
    retry_count: number;
    evidence_authority: string;
    effective_at: string;
    recorded_at: string;
    last_retry_at: string | null;
    state: "open" | "remediated";
}
export declare function listIncidentOccurrences(db: Database.Database, input: {
    projectId: string;
    signatureKey?: string | null;
    subjectKey?: string | null;
    sessionId?: string | null;
    limit?: number;
}): IncidentOccurrenceRow[];
export declare function recordChronicleTombstone(db: Database.Database, eventId: string, reason: string | null, deletedAt?: string): void;
export interface ChroniclePurgeResult {
    deletedEvents: number;
    deletedOccurrences: number;
}
/**
 * Remove every Chronicle event that belongs to a purged fact or cites a purged
 * exchange, tombstone each id so sync replay cannot resurrect it, and recount
 * incident signatures. Must run inside the caller's purge transaction.
 */
export declare function purgeChronicleForSources(db: Database.Database, input: {
    exchangeIds: Set<string>;
    factIds: Set<string>;
    reason: string;
    now?: string;
}): ChroniclePurgeResult;
export declare const TELEMETRY_METRICS: readonly ["semantic_retrieval_calls", "retrieval_gate_skip_count", "retrieval_execute_count", "embedding_calls", "embedding_cache_hits", "candidate_facts", "current_facts", "delta_facts", "injected_facts", "injected_chars", "section_chars", "bundle_size", "estimated_tokens", "correction_count", "correction_delay_prompts", "watch_emissions", "watch_confirmed", "warning_precision", "project_revision_invalidations", "duplicate_tool_calls", "repeated_context_turns", "time_to_first_correct_action_ms", "incident_recurrence", "mcp_trace_success", "worker_extraction_tokens", "worker_extraction_latency_ms", "worker_extraction_retries", "worker_extraction_dead"];
export type TelemetryMetric = (typeof TELEMETRY_METRICS)[number];
export declare function recordTelemetrySample(db: Database.Database, input: {
    metric: TelemetryMetric;
    value: number;
    unit?: string;
    projectId?: string | null;
    sessionId?: string | null;
    dims?: Record<string, unknown>;
    recordedAt?: string;
}): string;
export interface TelemetrySummary {
    metric: string;
    samples: number;
    sum: number;
    avg: number;
    min: number;
    max: number;
    first_recorded_at: string;
    last_recorded_at: string;
}
/** Aggregate measured samples. The result is a report, never Chronicle or fact evidence. */
export declare function summarizeTelemetry(db: Database.Database, input?: {
    projectId?: string | null;
    metric?: TelemetryMetric | null;
    since?: string | null;
}): {
    notice: string;
    metrics: TelemetrySummary[];
};
export interface FormattedSource {
    exchangeId: string;
    available: boolean;
    project?: string | null;
    timestamp?: string | null;
    sessionId?: string | null;
    archivePath?: string | null;
    lineStart?: number | null;
    lineEnd?: number | null;
    excerpt?: string | null;
}
export declare function describeEventSources(db: Database.Database, event: ChronicleEvent): FormattedSource[];
/** One event as labeled markdown. Grounded fields and classifier notes are never merged. */
export declare function formatChronicleEvent(db: Database.Database, event: ChronicleEvent, options?: {
    includeSources?: boolean;
}): string;
