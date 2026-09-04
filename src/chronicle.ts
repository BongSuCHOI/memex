import { createHash, randomUUID } from "node:crypto";
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

export const CHRONICLE_POLICY_VERSION = "chronicle-v1";
export const INCIDENT_COALESCE_WINDOW_MS = 30 * 60 * 1000;
export const CHRONICLE_TIMELINE_MAX_LIMIT = 100;
export const CHRONICLE_LANE_LABELS = {
  currentFact: "CURRENT FACT",
  event: "CHRONICLE EVENT",
  rawEvidence: "RAW EVIDENCE",
  assistantContext: "ASSISTANT CONTEXT-ONLY",
  hotEvidence: "HOT EVIDENCE — NOT YET DISTILLED",
  telemetry: "TELEMETRY — MEASURED, NOT A FACT",
} as const;

const TRUSTED_TOOL_SOURCE_TYPES = new Set(["repo_file", "git_history", "test_execution"]);
const KIND_SET = new Set<string>(CHRONICLE_EVENT_KINDS);
const PROJECTION_KINDS = new Set<ChronicleEventKind>(["ASSERTED", "CHANGED", "RETIRED", "RESTORED"]);
const EVENT_ONLY_KINDS = new Set<ChronicleEventKind>(["VALIDATED", "INCIDENT", "CONTRADICTED"]);

export class ChronicleGroundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChronicleGroundingError";
  }
}

export class ChronicleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChronicleConflictError";
  }
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseOutcome(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function uniqueSorted(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).filter((v) => typeof v === "string" && v !== ""))].sort();
}

export function rowToChronicleEvent(row: Record<string, unknown>): ChronicleEvent {
  return {
    id: String(row["id"]),
    project_id: (row["project_id"] as string | null) ?? null,
    subject_key: (row["subject_key"] as string | null) ?? null,
    fact_id: (row["fact_id"] as string | null) ?? null,
    event_kind: String(row["event_kind"] ?? "CHANGED") as ChronicleEventKind,
    from_semantic_generation: row["from_semantic_generation"] == null ? null : Number(row["from_semantic_generation"]),
    to_semantic_generation: row["to_semantic_generation"] == null ? null : Number(row["to_semantic_generation"]),
    lifecycle_generation: row["lifecycle_generation"] == null ? null : Number(row["lifecycle_generation"]),
    previous_value: (row["previous_fact"] as string | null) ?? null,
    new_value: (row["new_fact"] as string | null) ?? null,
    problem: (row["problem"] as string | null) ?? null,
    grounded_cause: (row["grounded_cause"] as string | null) ?? null,
    rationale: (row["rationale"] as string | null) ?? null,
    classifier_note: (row["classifier_note"] as string | null) ?? null,
    outcome: parseOutcome(row["outcome_json"]),
    source_exchange_ids: (() => {
      const ids = parseStringArray(row["source_exchange_ids"]);
      const legacy = row["source_exchange_id"];
      return ids.length === 0 && typeof legacy === "string" && legacy !== "" ? [legacy] : ids;
    })(),
    source_evidence_ids: parseStringArray(row["source_evidence_ids"]),
    reverts_event_id: (row["reverts_event_id"] as string | null) ?? null,
    related_event_ids: parseStringArray(row["related_event_ids"]),
    actor: String(row["actor"] ?? "legacy") as ChronicleActor,
    policy_version: String(row["policy_version"] ?? "legacy-revision-v0"),
    evidence_authority: String(row["evidence_authority"] ?? "unknown") as EvidenceAuthority,
    effective_at: String(row["effective_at"] || row["created_at"] || ""),
    effective_at_source: String(row["effective_at_source"] || "recorded") as EffectiveAtSource,
    recorded_at: String(row["recorded_at"] || row["created_at"] || ""),
    projection_applied: Number(row["projection_applied"] ?? 1) === 1,
    created_at: String(row["created_at"] ?? ""),
  };
}

/** Deterministic content-derived id: duplicate delivery and sync replay of the same event collapse. */
export function chronicleEventId(input: {
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
}): string {
  return sha256(
    JSON.stringify([
      "chronicle-v1",
      input.kind,
      input.projectId,
      input.subjectKey,
      input.factId,
      input.effectiveAt,
      input.previousValue,
      input.newValue,
      uniqueSorted(input.sourceExchangeIds),
      uniqueSorted(input.sourceEvidenceIds),
      input.revertsEventId,
      input.outcome ? JSON.stringify(input.outcome, Object.keys(input.outcome).sort()) : null,
    ]),
  ).slice(0, 32);
}

function exchangeIsHumanAuthority(db: Database.Database, exchangeId: string): { user_message: string; timestamp: string } | null {
  const row = db.prepare("SELECT user_message, provenance, timestamp FROM exchanges WHERE id = ?")
    .get(exchangeId) as { user_message: string; provenance: string | null; timestamp: string } | undefined;
  if (!row) return null;
  const provenance = parseStringArray(row.provenance ?? '["human_assertion","assistant_generated"]');
  if (!provenance.includes("human_assertion")) return null;
  return row;
}

function trustedToolResult(
  db: Database.Database,
  exchangeId: string,
  toolCallId: string,
  options: { allowError: boolean },
): { tool_result: string; source_type: string; is_error: number } | null {
  const row = db.prepare(`
    SELECT tool_result, source_type, learnable, is_error FROM tool_calls WHERE id = ? AND exchange_id = ?
  `).get(toolCallId, exchangeId) as
    | { tool_result: string | null; source_type: string; learnable: number; is_error: number }
    | undefined;
  if (!row || !row.tool_result || !TRUSTED_TOOL_SOURCE_TYPES.has(row.source_type) || Number(row.learnable) !== 1) {
    return null;
  }
  if (!options.allowError && Number(row.is_error) === 1) return null;
  return { tool_result: row.tool_result, source_type: row.source_type, is_error: Number(row.is_error) };
}

/** Fail-closed check that a stated cause/rationale/problem is present in a stored authoritative source. */
export function verifyGroundedField(db: Database.Database, field: GroundedField): boolean {
  const span = String(field.supportingSpan ?? "").trim();
  if (span.length < 3 || !field.exchangeId) return false;
  if (field.toolCallId) {
    const tool = trustedToolResult(db, field.exchangeId, field.toolCallId, { allowError: true });
    return !!tool && tool.tool_result.includes(span);
  }
  const human = exchangeIsHumanAuthority(db, field.exchangeId);
  return !!human && human.user_message.includes(span);
}

function maxSourceTimestamp(db: Database.Database, exchangeIds: string[]): string | null {
  if (exchangeIds.length === 0) return null;
  const placeholders = exchangeIds.map(() => "?").join(",");
  const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM exchanges WHERE id IN (${placeholders})`)
    .all(...exchangeIds)[0] as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

const SELECT_EVENT = "SELECT * FROM fact_revisions WHERE id = ?";

export function getChronicleEvent(db: Database.Database, eventId: string): ChronicleEvent | null {
  const row = db.prepare(SELECT_EVENT).get(eventId) as Record<string, unknown> | undefined;
  return row ? rowToChronicleEvent(row) : null;
}

/**
 * Append one Chronicle event. Must be called inside the same transaction as
 * the projection mutation it describes so current state and history never
 * commit separately. Duplicate delivery of identical content is a no-op.
 */
export function recordChronicleEvent(
  db: Database.Database,
  input: RecordChronicleEventInput,
): RecordChronicleEventResult {
  if (!KIND_SET.has(input.kind)) throw new Error(`unknown chronicle event kind: ${input.kind}`);
  const kind = input.kind;
  if (input.projectionApplied && !PROJECTION_KINDS.has(kind)) {
    throw new Error(`${kind} is an event-only kind and cannot claim a projection change`);
  }
  if (input.projectionApplied && !input.factId) {
    throw new Error(`${kind} with a projection change requires fact_id`);
  }
  if (EVENT_ONLY_KINDS.has(kind) && input.projectionApplied) {
    throw new Error(`${kind} cannot apply a projection change`);
  }
  if (kind === "INCIDENT" || kind === "VALIDATED") {
    if ((input.sourceExchangeIds ?? []).length === 0) {
      throw new ChronicleGroundingError(`${kind} requires source evidence`);
    }
  }
  if (input.revertsEventId) {
    const reverted = db.prepare("SELECT event_kind FROM fact_revisions WHERE id = ?")
      .get(input.revertsEventId) as { event_kind: string } | undefined;
    if (!reverted) throw new Error(`reverts_event_id does not exist: ${input.revertsEventId}`);
  }
  if (input.userStatedRationale && input.actor !== "user") {
    throw new ChronicleGroundingError("only actor 'user' can state a rationale without source evidence");
  }

  const grounded: { problem: string | null; cause: string | null; rationale: string | null } = {
    problem: null,
    cause: null,
    rationale: null,
  };
  const notes: string[] = [];
  // Every grounded statement is bound to the exchange that states it, so the
  // exchange is always part of the event's cited sources (a grounded field
  // without a cited source is structurally impossible, locally and on sync).
  const groundedExchangeIds: string[] = [];
  for (const [slot, field] of Object.entries(input.grounded ?? {}) as Array<[keyof typeof grounded, GroundedField | undefined]>) {
    if (!field) continue;
    if (!field.text || field.text.trim() === "") continue;
    if (verifyGroundedField(db, field)) {
      grounded[slot] = field.text.trim();
      groundedExchangeIds.push(field.exchangeId);
    } else {
      throw new ChronicleGroundingError(
        `${slot} is not present in the cited authoritative source (exchange ${field.exchangeId})`,
      );
    }
  }
  if (input.userStatedRationale && input.userStatedRationale.trim() !== "") {
    grounded.rationale = input.userStatedRationale.trim();
  }
  if (input.classifierNote && input.classifierNote.trim() !== "") notes.push(input.classifierNote.trim());

  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const sourceExchangeIds = uniqueSorted([...(input.sourceExchangeIds ?? []), ...groundedExchangeIds]);
  const sourceEvidenceIds = uniqueSorted(input.sourceEvidenceIds);
  let effectiveAt = input.effectiveAt ?? null;
  let effectiveAtSource: EffectiveAtSource = input.effectiveAtSource ?? "source";
  if (!effectiveAt) {
    const fromSource = maxSourceTimestamp(db, sourceExchangeIds);
    if (fromSource) {
      effectiveAt = fromSource;
      effectiveAtSource = "source";
    } else {
      effectiveAt = recordedAt;
      effectiveAtSource = "recorded";
    }
  }
  const outcome = input.outcome ?? null;
  const outcomeJson = outcome ? JSON.stringify(outcome) : null;
  const id = chronicleEventId({
    kind,
    projectId: input.projectId ?? null,
    subjectKey: input.subjectKey ?? null,
    factId: input.factId ?? null,
    effectiveAt,
    previousValue: input.previousValue ?? null,
    newValue: input.newValue ?? null,
    sourceExchangeIds,
    sourceEvidenceIds,
    revertsEventId: input.revertsEventId ?? null,
    outcome,
  });

  const existing = db.prepare(SELECT_EVENT).get(id) as Record<string, unknown> | undefined;
  if (existing) {
    const prior = rowToChronicleEvent(existing);
    const same =
      prior.event_kind === kind &&
      (prior.fact_id ?? null) === (input.factId ?? null) &&
      (prior.new_value ?? null) === (input.newValue ?? null) &&
      (prior.previous_value ?? null) === (input.previousValue ?? null) &&
      prior.effective_at === effectiveAt;
    if (!same) {
      throw new ChronicleConflictError(`chronicle event ${id} already exists with different content`);
    }
    return { event: prior, inserted: false };
  }

  db.prepare(`
    INSERT INTO fact_revisions (
      id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at,
      project_id, subject_key, event_kind, from_semantic_generation, to_semantic_generation,
      lifecycle_generation, problem, grounded_cause, rationale, classifier_note, outcome_json,
      source_exchange_ids, source_evidence_ids, reverts_event_id, related_event_ids,
      actor, policy_version, evidence_authority, effective_at, effective_at_source, recorded_at,
      projection_applied, chronicle_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(chronicle_seq), 0) + 1 FROM fact_revisions))
  `).run(
    id,
    input.factId ?? null,
    input.previousValue ?? null,
    input.newValue ?? null,
    // Legacy readers see the human-readable summary; it is never a grounded field.
    grounded.rationale ?? grounded.cause ?? (notes[0] ?? null),
    sourceExchangeIds[0] ?? null,
    recordedAt,
    input.projectId ?? null,
    input.subjectKey ?? null,
    kind,
    input.fromSemanticGeneration ?? null,
    input.toSemanticGeneration ?? null,
    input.lifecycleGeneration ?? null,
    grounded.problem,
    grounded.cause,
    grounded.rationale,
    notes.length > 0 ? notes.join("\n") : null,
    outcomeJson,
    JSON.stringify(sourceExchangeIds),
    JSON.stringify(sourceEvidenceIds),
    input.revertsEventId ?? null,
    JSON.stringify(uniqueSorted(input.relatedEventIds)),
    input.actor,
    input.policyVersion ?? CHRONICLE_POLICY_VERSION,
    input.evidenceAuthority ?? "unknown",
    effectiveAt,
    effectiveAtSource,
    recordedAt,
    input.projectionApplied ? 1 : 0,
  );
  const event = getChronicleEvent(db, id);
  if (!event) throw new Error("chronicle insert did not persist");
  return { event, inserted: true };
}

/** Raw insert for replicated peer events. Content is stored as delivered; device-local generations are dropped. */
export function insertReplicatedChronicleEvent(
  db: Database.Database,
  event: Omit<ChronicleEvent, "from_semantic_generation" | "to_semantic_generation" | "lifecycle_generation" | "created_at"> & {
    created_at?: string;
  },
): "inserted" | "duplicate" | "conflict" | "tombstoned" {
  if (db.prepare("SELECT 1 FROM chronicle_tombstones WHERE event_id = ?").get(event.id)) return "tombstoned";
  const existing = db.prepare(SELECT_EVENT).get(event.id) as Record<string, unknown> | undefined;
  if (existing) {
    const prior = rowToChronicleEvent(existing);
    const same =
      prior.event_kind === event.event_kind &&
      (prior.fact_id ?? null) === (event.fact_id ?? null) &&
      (prior.new_value ?? null) === (event.new_value ?? null) &&
      (prior.previous_value ?? null) === (event.previous_value ?? null) &&
      prior.effective_at === event.effective_at;
    return same ? "duplicate" : "conflict";
  }
  db.prepare(`
    INSERT INTO fact_revisions (
      id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at,
      project_id, subject_key, event_kind, from_semantic_generation, to_semantic_generation,
      lifecycle_generation, problem, grounded_cause, rationale, classifier_note, outcome_json,
      source_exchange_ids, source_evidence_ids, reverts_event_id, related_event_ids,
      actor, policy_version, evidence_authority, effective_at, effective_at_source, recorded_at,
      projection_applied, chronicle_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      (SELECT COALESCE(MAX(chronicle_seq), 0) + 1 FROM fact_revisions))
  `).run(
    event.id,
    event.fact_id,
    event.previous_value,
    event.new_value,
    event.rationale ?? event.grounded_cause ?? event.classifier_note ?? null,
    event.source_exchange_ids[0] ?? null,
    event.created_at ?? event.recorded_at,
    event.project_id,
    event.subject_key,
    event.event_kind,
    event.problem,
    event.grounded_cause,
    event.rationale,
    event.classifier_note,
    event.outcome ? JSON.stringify(event.outcome) : null,
    JSON.stringify(uniqueSorted(event.source_exchange_ids)),
    JSON.stringify(uniqueSorted(event.source_evidence_ids)),
    event.reverts_event_id,
    JSON.stringify(uniqueSorted(event.related_event_ids)),
    event.actor,
    event.policy_version,
    event.evidence_authority,
    event.effective_at,
    "peer",
    event.recorded_at,
    event.projection_applied ? 1 : 0,
  );
  return "inserted";
}

// ---------------------------------------------------------------------------
// Timeline queries (Phase 5 consumers use these; MCP/CLI format them)
// ---------------------------------------------------------------------------

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

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeTimelineCursor(raw: string | null | undefined): TimelineCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed && typeof parsed === "object" &&
      typeof (parsed as TimelineCursor).effective_at === "string" &&
      typeof (parsed as TimelineCursor).recorded_at === "string" &&
      typeof (parsed as TimelineCursor).seq === "number"
    ) {
      return parsed as TimelineCursor;
    }
  } catch {
    /* malformed cursor */
  }
  throw new Error("invalid chronicle timeline cursor");
}

export function readChronicleTimeline(
  db: Database.Database,
  query: ChronicleTimelineQuery,
): ChronicleTimelinePage {
  const limit = Math.max(1, Math.min(CHRONICLE_TIMELINE_MAX_LIMIT, Math.trunc(query.limit ?? 20)));
  const order = query.order ?? "asc";
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.factId) {
    clauses.push("r.fact_id = ?");
    params.push(query.factId);
  }
  if (query.projectId) {
    if (query.includeGlobal) {
      clauses.push("(r.project_id = ? OR r.project_id IS NULL)");
    } else {
      clauses.push("r.project_id = ?");
    }
    params.push(query.projectId);
  }
  if (query.subjectKey) {
    clauses.push("r.subject_key = ?");
    params.push(query.subjectKey);
  }
  if (query.kinds && query.kinds.length > 0) {
    clauses.push(`r.event_kind IN (${query.kinds.map(() => "?").join(",")})`);
    params.push(...query.kinds);
  }
  // Scope visibility mirrors the fact search contract (BRANCH TRUTH / SCOPE):
  // project-wide truth (legacy-project/decision/project-current) is visible in
  // every scope of its project; a workspace/workstream fact's history is
  // visible only inside that workspace/workstream; an event-only row is
  // visible where its cited evidence lives. A sibling workstream's unmerged
  // history therefore never appears under another workstream's scope.
  const PROJECT_TRUTH = "f.promotion_state IN ('legacy-project','decision','project-current')";
  const factVisible = (extra: string): string =>
    `EXISTS (SELECT 1 FROM facts f WHERE f.id = r.fact_id AND (${PROJECT_TRUTH}${extra}))`;
  const evidenceIn = (column: "workspace_id" | "workstream_id"): string =>
    `EXISTS (SELECT 1 FROM json_each(r.source_exchange_ids) j JOIN exchanges e ON e.id = j.value WHERE e.${column} = ?)`;
  if (query.workstreamId) {
    clauses.push(`(${factVisible(
      " OR (f.promotion_state = 'workstream' AND f.workstream_id = ?) OR (f.promotion_state = 'workspace' AND f.workspace_id = ?)",
    )} OR ${evidenceIn("workstream_id")})`);
    params.push(query.workstreamId, query.workspaceId ?? "", query.workstreamId);
  } else if (query.workspaceId) {
    clauses.push(`(${factVisible(" OR (f.promotion_state = 'workspace' AND f.workspace_id = ?)")} OR ${evidenceIn("workspace_id")})`);
    params.push(query.workspaceId, query.workspaceId);
  } else if (query.projectTruthOnly) {
    clauses.push(`(r.fact_id IS NULL OR ${factVisible("")})`);
  }
  if (query.sessionId) {
    clauses.push(`EXISTS (
      SELECT 1 FROM json_each(r.source_exchange_ids) j JOIN exchanges e ON e.id = j.value WHERE e.session_id = ?
    )`);
    params.push(query.sessionId);
  }
  const cursor = decodeTimelineCursor(query.cursor);
  if (cursor) {
    const cmp = order === "asc" ? ">" : "<";
    clauses.push(`(r.effective_at, r.recorded_at, COALESCE(r.chronicle_seq, r.rowid)) ${cmp} (?, ?, ?)`);
    params.push(cursor.effective_at, cursor.recorded_at, cursor.seq);
  }
  const direction = order === "asc" ? "ASC" : "DESC";
  const rows = db.prepare(`
    SELECT r.*, COALESCE(r.chronicle_seq, r.rowid) AS chronicle_seq FROM fact_revisions r
    ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY r.effective_at ${direction}, r.recorded_at ${direction}, COALESCE(r.chronicle_seq, r.rowid) ${direction}
    LIMIT ?
  `).all(...params, limit + 1) as Array<Record<string, unknown>>;
  const events = rows.slice(0, limit).map(rowToChronicleEvent);
  const lastRow = rows[Math.min(limit, rows.length) - 1];
  return {
    events,
    nextCursor: rows.length > limit && lastRow
      ? encodeTimelineCursor({ effective_at: String(lastRow["effective_at"]), recorded_at: String(lastRow["recorded_at"]), seq: Number(lastRow["chronicle_seq"]) })
      : null,
    limit,
  };
}

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
export function currentFactRevision(db: Database.Database, factId: string): CurrentFactRevision | null {
  const row = db.prepare(`
    SELECT id, project_id, subject_key, promotion_state, is_active, fact, semantic_generation,
           lifecycle_generation, semantic_updated_at, lifecycle_updated_at
    FROM facts WHERE id = ?
  `).get(factId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const latest = db.prepare(`
    SELECT id, effective_at, effective_at_source FROM fact_revisions
    WHERE fact_id = ? AND projection_applied = 1
    ORDER BY effective_at DESC, recorded_at DESC, COALESCE(chronicle_seq, rowid) DESC LIMIT 1
  `).get(factId) as { id: string; effective_at: string; effective_at_source: string | null } | undefined;
  return {
    factId,
    projectId: (row["project_id"] as string | null) ?? null,
    subjectKey: (row["subject_key"] as string | null) ?? null,
    promotionState: String(row["promotion_state"] ?? "legacy-project"),
    isActive: Number(row["is_active"]) === 1,
    fact: String(row["fact"]),
    semanticGeneration: Number(row["semantic_generation"] ?? 1),
    lifecycleGeneration: Number(row["lifecycle_generation"] ?? 1),
    semanticUpdatedAt: String(row["semantic_updated_at"] ?? ""),
    lifecycleUpdatedAt: String(row["lifecycle_updated_at"] ?? ""),
    latestEventId: latest?.id ?? null,
    latestEffectiveAt: latest?.effective_at ?? null,
    latestEffectiveAtSource: latest ? (String(latest.effective_at_source || "recorded") as EffectiveAtSource) : null,
  };
}

/**
 * Effective time of the current projection value plus how it was established
 * (`source` = cited evidence timestamp, `recorded` = a worker clock that was
 * the only thing available), used for temporal ordering of incoming evidence.
 */
export function currentEffectiveTime(
  db: Database.Database,
  factId: string,
): { at: string; source: EffectiveAtSource } | null {
  const current = currentFactRevision(db, factId);
  if (!current) return null;
  if (current.latestEffectiveAt) {
    return { at: current.latestEffectiveAt, source: current.latestEffectiveAtSource ?? "recorded" };
  }
  // Facts that predate the Chronicle: the evidence time is the latest cited
  // source exchange, never the local write time, when a source still exists.
  // A local write time is not evidence time; when neither an event nor a
  // source exists the effective time is unknown (null) and the judge treats
  // the value as un-ordered rather than as newer than real evidence.
  const row = db.prepare("SELECT source_exchange_ids FROM facts WHERE id = ?").get(factId) as { source_exchange_ids: string | null } | undefined;
  const fromSource = maxSourceTimestamp(db, parseStringArray(row?.source_exchange_ids ?? null));
  return fromSource ? { at: fromSource, source: "source" } : null;
}

export function currentEffectiveAt(db: Database.Database, factId: string): string | null {
  return currentEffectiveTime(db, factId)?.at ?? null;
}

// ---------------------------------------------------------------------------
// Subject keys
// ---------------------------------------------------------------------------

export const SUBJECT_KEY_PATTERN = /^(state|decision|constraint|preference|pattern)(\.[a-z0-9_]{1,40}){1,4}$/;

const CATEGORY_SUBJECT_PREFIX: Record<string, string> = {
  decision: "decision",
  constraint: "constraint",
  preference: "preference",
  pattern: "pattern",
  knowledge: "state",
};

/** Validate a model-proposed subject key against the stable slot grammar and its category prefix. */
export function normalizeSubjectKey(raw: unknown, category: string): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (!SUBJECT_KEY_PATTERN.test(key)) return null;
  const expected = CATEGORY_SUBJECT_PREFIX[category];
  if (!expected || key.split(".")[0] !== expected) return null;
  return key;
}

export function isSemanticSubjectKey(key: string | null | undefined): boolean {
  return !!key && SUBJECT_KEY_PATTERN.test(key) && !/\.fact\.[0-9a-f-]{36}$/.test(key);
}

export function normalizeSlotText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();
}

export const AUTHORITY_RANK: Record<EvidenceAuthority, number> = {
  "human-decision": 3,
  human: 2,
  "trusted-tool": 2,
  unknown: 1,
};

export function evidenceAuthorityFromKinds(
  evidence: Array<{ source: string; kind: string }> | undefined,
): EvidenceAuthority {
  if (!evidence || evidence.length === 0) return "unknown";
  if (evidence.some((e) => e.source === "human" && (e.kind === "decision" || e.kind === "correction"))) {
    return "human-decision";
  }
  if (evidence.some((e) => e.source === "human")) return "human";
  if (evidence.some((e) => e.source === "tool")) return "trusted-tool";
  return "unknown";
}

export interface SubjectSlotLookup {
  projectId: string | null;
  subjectKey: string;
  promotionState: string;
  workspaceId?: string | null;
  workstreamId?: string | null;
}

export function findCurrentSlotFact(
  db: Database.Database,
  slot: SubjectSlotLookup,
): { id: string; fact: string; semantic_generation: number; lifecycle_generation: number; source_exchange_ids: string | null } | null {
  if (!slot.projectId) return null;
  return db.prepare(`
    SELECT id, fact, semantic_generation, lifecycle_generation, source_exchange_ids FROM facts
    WHERE is_active = 1 AND project_id = ? AND subject_key = ? AND promotion_state = ?
      AND COALESCE(workspace_id, '') = COALESCE(?, '') AND COALESCE(workstream_id, '') = COALESCE(?, '')
    LIMIT 1
  `).get(slot.projectId, slot.subjectKey, slot.promotionState, slot.workspaceId ?? null, slot.workstreamId ?? null) as
    | { id: string; fact: string; semantic_generation: number; lifecycle_generation: number; source_exchange_ids: string | null }
    | undefined ?? null;
}

/** Latest authority recorded for a fact's current projection. */
export function currentEvidenceAuthority(db: Database.Database, factId: string): EvidenceAuthority {
  const row = db.prepare(`
    SELECT evidence_authority FROM fact_revisions
    WHERE fact_id = ? AND projection_applied = 1
    ORDER BY effective_at DESC, recorded_at DESC, COALESCE(chronicle_seq, rowid) DESC LIMIT 1
  `).get(factId) as { evidence_authority: EvidenceAuthority } | undefined;
  return row?.evidence_authority ?? "unknown";
}

export type TemporalVerdict = "apply" | "historical" | "contradicted";

/**
 * Deterministic judgment for competing evidence on one subject slot. Worker
 * completion order never decides; only source-effective time and authority do.
 */
export function judgeCompetingEvidence(input: {
  existingEffectiveAt: string | null;
  existingAuthority: EvidenceAuthority;
  incomingEffectiveAt: string;
  incomingAuthority: EvidenceAuthority;
}): { verdict: TemporalVerdict; reason: string } {
  if (!input.existingEffectiveAt) {
    return { verdict: "apply", reason: "existing value has no effective time" };
  }
  if (input.incomingEffectiveAt > input.existingEffectiveAt) {
    if (AUTHORITY_RANK[input.incomingAuthority] >= AUTHORITY_RANK[input.existingAuthority]) {
      return { verdict: "apply", reason: "newer evidence with sufficient authority" };
    }
    return { verdict: "contradicted", reason: "newer evidence has lower authority than the current value" };
  }
  if (input.incomingEffectiveAt < input.existingEffectiveAt) {
    return { verdict: "historical", reason: "evidence predates the current value" };
  }
  return { verdict: "contradicted", reason: "same effective time; order is ambiguous" };
}

// ---------------------------------------------------------------------------
// Incident episodes and patterns
// ---------------------------------------------------------------------------

export interface IncidentSignature {
  key: string;
  text: string;
}

const ANSI_PATTERN = /\[[0-9;]*m/g;

/** Stable, device-neutral failure signature: strips addresses, counters, paths and timestamps. */
export function normalizeIncidentSignature(raw: string): IncidentSignature {
  const text = String(raw ?? "")
    .replace(ANSI_PATTERN, "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/(?:\/[\w.-]+){2,}/g, "<path>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return { key: sha256(text).slice(0, 24), text };
}

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

function verifyIncidentEvidence(db: Database.Database, input: RecordIncidentInput, options: { allowError: boolean; requireSuccess?: boolean }): void {
  const exchangeIds = uniqueSorted(input.sourceExchangeIds);
  if (exchangeIds.length === 0) throw new ChronicleGroundingError("incident evidence requires source exchanges");
  if (input.evidenceAuthority === "trusted-tool") {
    const evidenceIds = uniqueSorted(input.sourceEvidenceIds);
    if (evidenceIds.length === 0) {
      throw new ChronicleGroundingError("trusted-tool incident evidence requires tool_calls ids");
    }
    for (const toolId of evidenceIds) {
      const match = exchangeIds.some((exchangeId) => {
        const tool = trustedToolResult(db, exchangeId, toolId, { allowError: options.allowError });
        if (!tool) return false;
        if (options.requireSuccess && tool.is_error === 1) return false;
        return true;
      });
      if (!match) throw new ChronicleGroundingError(`tool evidence ${toolId} is not a trusted learnable result of the cited exchanges`);
    }
    return;
  }
  if (!exchangeIds.some((id) => exchangeIsHumanAuthority(db, id))) {
    throw new ChronicleGroundingError("human incident evidence requires a human-authored exchange");
  }
}

function upsertSignature(
  db: Database.Database,
  input: {
    projectId: string; signature: IncidentSignature; effectiveAt: string; now: string; userFlaggedRepeat: boolean;
    newEpisode: boolean;
    /** The episode happened before the recorded remediation (out-of-order arrival): it does not reopen the pattern. */
    remediatedBefore: boolean;
  },
): { patternState: "candidate" | "pattern" | "remediated"; episodeCount: number } {
  const existing = db.prepare(`
    SELECT episode_count, pattern_state, user_flagged_repeat, first_effective_at, last_effective_at
    FROM incident_signatures WHERE project_id = ? AND signature_key = ?
  `).get(input.projectId, input.signature.key) as
    | { episode_count: number; pattern_state: string; user_flagged_repeat: number; first_effective_at: string; last_effective_at: string }
    | undefined;
  const episodeCount = (existing?.episode_count ?? 0) + (input.newEpisode ? 1 : 0);
  const flagged = (existing?.user_flagged_repeat ?? 0) === 1 || input.userFlaggedRepeat;
  // A remediated signature is reopened only by a new episode that is effective
  // after the remediation; retries of an already-remediated occurrence and
  // late-arriving older episodes keep the verified remediation. Absence of
  // recurrence never resolves a pattern, only a verified remediation does.
  const keepRemediated = existing?.pattern_state === "remediated" && (!input.newEpisode || input.remediatedBefore);
  const patternState: "candidate" | "pattern" | "remediated" =
    keepRemediated ? "remediated" : episodeCount >= 2 || flagged ? "pattern" : "candidate";
  const first = existing ? (input.effectiveAt < existing.first_effective_at ? input.effectiveAt : existing.first_effective_at) : input.effectiveAt;
  const last = existing ? (input.effectiveAt > existing.last_effective_at ? input.effectiveAt : existing.last_effective_at) : input.effectiveAt;
  db.prepare(`
    INSERT INTO incident_signatures
      (project_id, signature_key, signature_text, first_effective_at, last_effective_at, episode_count,
       user_flagged_repeat, pattern_state, remediation_event_id, remediation_summary, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT(project_id, signature_key) DO UPDATE SET
      first_effective_at = excluded.first_effective_at,
      last_effective_at = excluded.last_effective_at,
      episode_count = excluded.episode_count,
      user_flagged_repeat = excluded.user_flagged_repeat,
      pattern_state = excluded.pattern_state,
      remediation_event_id = CASE WHEN excluded.pattern_state = 'pattern' THEN NULL ELSE incident_signatures.remediation_event_id END,
      remediation_summary = CASE WHEN excluded.pattern_state = 'pattern' THEN NULL ELSE incident_signatures.remediation_summary END,
      updated_at = excluded.updated_at
  `).run(
    input.projectId, input.signature.key, input.signature.text, first, last, episodeCount,
    flagged ? 1 : 0, patternState, input.now,
  );
  return { patternState, episodeCount };
}

/**
 * Record one incident episode. Retries of the same failure inside one session
 * within the coalescing window collapse into the existing occurrence and emit
 * no new event; independent episodes append an INCIDENT event.
 */
export function recordIncidentOccurrence(
  db: Database.Database,
  input: RecordIncidentInput,
): RecordIncidentResult {
  verifyIncidentEvidence(db, input, { allowError: true });
  const signature = normalizeIncidentSignature(input.signatureText);
  if (signature.text.length < 4) throw new ChronicleGroundingError("incident signature is empty");
  const now = input.recordedAt ?? new Date().toISOString();
  const sourceExchangeIds = uniqueSorted(input.sourceExchangeIds);
  const effectiveAt = input.effectiveAt ?? maxSourceTimestamp(db, sourceExchangeIds) ?? now;

  const tx = db.transaction((): RecordIncidentResult => {
    const describe = (occurrenceId: string, eventId: string, coalesced: boolean, signatureRow: { patternState: "candidate" | "pattern" | "remediated"; episodeCount: number }): RecordIncidentResult => ({
      coalesced,
      occurrenceId,
      eventId,
      signatureKey: signature.key,
      signatureText: signature.text,
      patternState: signatureRow.patternState,
      episodeCount: signatureRow.episodeCount,
    });
    const currentSignature = (): { patternState: "candidate" | "pattern" | "remediated"; episodeCount: number } => {
      const row = db.prepare("SELECT pattern_state, episode_count FROM incident_signatures WHERE project_id = ? AND signature_key = ?")
        .get(input.projectId, signature.key) as { pattern_state: "candidate" | "pattern" | "remediated"; episode_count: number } | undefined;
      return { patternState: row?.pattern_state ?? "candidate", episodeCount: Number(row?.episode_count ?? 0) };
    };
    // Duplicate delivery (same signature proven by the same exchanges, e.g. a
    // retried worker page or a replayed job) is a no-op regardless of session:
    // it is neither a retry nor a new episode (incident count inflation 0).
    const duplicate = db.prepare(`
      SELECT occurrence_id, event_id FROM incident_occurrences
      WHERE project_id = ? AND signature_key = ?
        AND EXISTS (SELECT 1 FROM json_each(incident_occurrences.source_exchange_ids) WHERE value IN (${sourceExchangeIds.map(() => "?").join(",")}))
      ORDER BY effective_at DESC, recorded_at DESC LIMIT 1
    `).get(input.projectId, signature.key, ...sourceExchangeIds) as
      | { occurrence_id: string; event_id: string }
      | undefined;
    if (duplicate) {
      if (input.userFlaggedRepeat) {
        db.prepare("UPDATE incident_signatures SET user_flagged_repeat = 1, pattern_state = CASE WHEN pattern_state = 'candidate' THEN 'pattern' ELSE pattern_state END, updated_at = ? WHERE project_id = ? AND signature_key = ?")
          .run(now, input.projectId, signature.key);
      }
      return describe(duplicate.occurrence_id, duplicate.event_id, true, currentSignature());
    }
    // Retry of an open occurrence in the same session inside the window.
    const previous = db.prepare(`
      SELECT occurrence_id, event_id, effective_at, last_retry_at FROM incident_occurrences
      WHERE project_id = ? AND signature_key = ? AND session_id = ? AND state = 'open'
      ORDER BY effective_at DESC, recorded_at DESC LIMIT 1
    `).get(input.projectId, signature.key, input.sessionId ?? null) as
      | { occurrence_id: string; event_id: string; effective_at: string; last_retry_at: string | null }
      | undefined;
    if (previous && input.sessionId) {
      const anchor = previous.last_retry_at && previous.last_retry_at > previous.effective_at ? previous.last_retry_at : previous.effective_at;
      const gap = Math.abs(Date.parse(effectiveAt) - Date.parse(anchor));
      if (Number.isFinite(gap) && gap <= INCIDENT_COALESCE_WINDOW_MS) {
        db.prepare(`
          UPDATE incident_occurrences SET retry_count = retry_count + 1, last_retry_at = ?,
            source_exchange_ids = (
              SELECT json_group_array(value) FROM (
                SELECT DISTINCT value FROM (
                  SELECT value FROM json_each(incident_occurrences.source_exchange_ids)
                  UNION ALL SELECT value FROM json_each(?)
                ) ORDER BY value
              )
            )
          WHERE occurrence_id = ?
        `).run(effectiveAt > anchor ? effectiveAt : anchor, JSON.stringify(sourceExchangeIds), previous.occurrence_id);
        const signatureRow = upsertSignature(db, {
          projectId: input.projectId, signature, effectiveAt, now,
          userFlaggedRepeat: input.userFlaggedRepeat === true, newEpisode: false, remediatedBefore: false,
        });
        return describe(previous.occurrence_id, previous.event_id, true, signatureRow);
      }
    }
    // A new episode whose effective time precedes the verified remediation is
    // history that arrived late (TEMPORAL ORDER): it is stored as already
    // remediated and does not reopen the pattern.
    const remediation = db.prepare(`
      SELECT r.effective_at FROM incident_signatures s JOIN fact_revisions r ON r.id = s.remediation_event_id
      WHERE s.project_id = ? AND s.signature_key = ? AND s.pattern_state = 'remediated'
    `).get(input.projectId, signature.key) as { effective_at: string } | undefined;
    const remediatedBefore = !!remediation && effectiveAt <= remediation.effective_at;
    const signatureRow = upsertSignature(db, {
      projectId: input.projectId, signature, effectiveAt, now,
      userFlaggedRepeat: input.userFlaggedRepeat === true, newEpisode: true, remediatedBefore,
    });
    const { event } = recordChronicleEvent(db, {
      kind: "INCIDENT",
      projectId: input.projectId,
      subjectKey: input.subjectKey ?? null,
      factId: null,
      newValue: input.summary ?? signature.text,
      classifierNote: input.classifierNote ?? null,
      outcome: {
        signature_key: signature.key,
        signature_text: signature.text,
        episode_index: signatureRow.episodeCount,
        session_id: input.sessionId ?? null,
        user_flagged_repeat: input.userFlaggedRepeat === true,
      },
      sourceExchangeIds,
      sourceEvidenceIds: input.sourceEvidenceIds ?? [],
      actor: input.actor,
      evidenceAuthority: input.evidenceAuthority,
      effectiveAt,
      effectiveAtSource: input.effectiveAt ? "source" : maxSourceTimestamp(db, sourceExchangeIds) ? "source" : "recorded",
      recordedAt: now,
      projectionApplied: false,
    });
    const occurrenceId = randomUUID();
    db.prepare(`
      INSERT INTO incident_occurrences (
        occurrence_id, project_id, workspace_id, workstream_id, session_id, signature_key, signature_text,
        subject_key, event_id, source_exchange_ids, source_evidence_ids, retry_count, evidence_authority,
        effective_at, recorded_at, last_retry_at, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)
    `).run(
      occurrenceId, input.projectId, input.workspaceId ?? null, input.workstreamId ?? null, input.sessionId ?? null,
      signature.key, signature.text, input.subjectKey ?? null, event.id,
      JSON.stringify(sourceExchangeIds), JSON.stringify(uniqueSorted(input.sourceEvidenceIds)),
      input.evidenceAuthority, effectiveAt, now, remediatedBefore ? "remediated" : "open", now,
    );
    return describe(occurrenceId, event.id, false, signatureRow);
  });
  return tx();
}

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
export function recordIncidentRemediation(
  db: Database.Database,
  input: RecordRemediationInput,
): { eventId: string; remediatedOccurrences: number } {
  const signature = db.prepare(`
    SELECT signature_text FROM incident_signatures WHERE project_id = ? AND signature_key = ?
  `).get(input.projectId, input.signatureKey) as { signature_text: string } | undefined;
  if (!signature) throw new Error(`unknown incident signature ${input.signatureKey}`);
  verifyIncidentEvidence(
    db,
    { ...input, signatureText: signature.signature_text },
    { allowError: false, requireSuccess: true },
  );
  const now = input.recordedAt ?? new Date().toISOString();
  const sourceExchangeIds = uniqueSorted(input.sourceExchangeIds);
  const effectiveAt = input.effectiveAt ?? maxSourceTimestamp(db, sourceExchangeIds) ?? now;
  const tx = db.transaction(() => {
    const { event } = recordChronicleEvent(db, {
      kind: "VALIDATED",
      projectId: input.projectId,
      subjectKey: input.subjectKey ?? null,
      newValue: input.summary,
      outcome: { remediates_signature: input.signatureKey, signature_text: signature.signature_text },
      sourceExchangeIds,
      sourceEvidenceIds: input.sourceEvidenceIds ?? [],
      actor: input.actor,
      evidenceAuthority: input.evidenceAuthority,
      effectiveAt,
      recordedAt: now,
      projectionApplied: false,
    });
    const remediated = db.prepare(`
      UPDATE incident_occurrences SET state = 'remediated'
      WHERE project_id = ? AND signature_key = ? AND state = 'open' AND effective_at <= ?
    `).run(input.projectId, input.signatureKey, effectiveAt).changes;
    db.prepare(`
      UPDATE incident_signatures
      SET pattern_state = 'remediated', remediation_event_id = ?, remediation_summary = ?, updated_at = ?
      WHERE project_id = ? AND signature_key = ?
    `).run(event.id, input.summary, now, input.projectId, input.signatureKey);
    return { eventId: event.id, remediatedOccurrences: remediated };
  });
  return tx();
}

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

function signatureTokens(text: string): Set<string> {
  return new Set(
    text
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 3 && !token.startsWith("<")),
  );
}

/**
 * Bounded deterministic match for Phase 5 WATCH: a signature matches the
 * prompt/error text when the normalized signature is contained in it or the
 * token overlap is high. Candidates are excluded unless requested.
 */
export function matchIncidentPatterns(
  db: Database.Database,
  input: {
    projectId: string;
    text: string;
    limit?: number;
    includeCandidates?: boolean;
    includeRemediated?: boolean;
    minScore?: number;
  },
): IncidentPatternMatch[] {
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 5)));
  const minScore = input.minScore ?? 0.5;
  const probe = normalizeIncidentSignature(input.text.slice(0, 4000));
  const probeTokens = signatureTokens(probe.text);
  if (probeTokens.size === 0 && probe.text.length < 4) return [];
  const rows = db.prepare(`
    SELECT signature_key, signature_text, pattern_state, episode_count, first_effective_at, last_effective_at,
           remediation_summary, remediation_event_id
    FROM incident_signatures WHERE project_id = ?
    ORDER BY last_effective_at DESC LIMIT 500
  `).all(input.projectId) as Array<{
    signature_key: string; signature_text: string; pattern_state: "candidate" | "pattern" | "remediated";
    episode_count: number; first_effective_at: string; last_effective_at: string;
    remediation_summary: string | null; remediation_event_id: string | null;
  }>;
  const matches: IncidentPatternMatch[] = [];
  for (const row of rows) {
    if (row.pattern_state === "candidate" && !input.includeCandidates) continue;
    if (row.pattern_state === "remediated" && !input.includeRemediated) continue;
    const tokens = signatureTokens(row.signature_text);
    let score = 0;
    if (row.signature_text.length >= 20 && probe.text.includes(row.signature_text)) {
      score = 1;
    } else if (tokens.size > 0) {
      let overlap = 0;
      for (const token of tokens) if (probeTokens.has(token)) overlap++;
      const union = new Set([...tokens, ...probeTokens]).size;
      score = union === 0 ? 0 : overlap / union;
    }
    if (score >= minScore) {
      matches.push({
        signatureKey: row.signature_key,
        signatureText: row.signature_text,
        patternState: row.pattern_state,
        episodeCount: Number(row.episode_count),
        firstEffectiveAt: row.first_effective_at,
        lastEffectiveAt: row.last_effective_at,
        remediationSummary: row.remediation_summary,
        remediationEventId: row.remediation_event_id,
        score,
      });
    }
  }
  matches.sort((a, b) => b.score - a.score || b.episodeCount - a.episodeCount || a.signatureKey.localeCompare(b.signatureKey));
  return matches.slice(0, limit);
}

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

export function listIncidentOccurrences(
  db: Database.Database,
  input: { projectId: string; signatureKey?: string | null; subjectKey?: string | null; sessionId?: string | null; limit?: number },
): IncidentOccurrenceRow[] {
  const limit = Math.max(1, Math.min(CHRONICLE_TIMELINE_MAX_LIMIT, Math.trunc(input.limit ?? 20)));
  const clauses = ["project_id = ?"];
  const params: unknown[] = [input.projectId];
  if (input.signatureKey) { clauses.push("signature_key = ?"); params.push(input.signatureKey); }
  if (input.subjectKey) { clauses.push("subject_key = ?"); params.push(input.subjectKey); }
  if (input.sessionId) { clauses.push("session_id = ?"); params.push(input.sessionId); }
  const rows = db.prepare(`
    SELECT * FROM incident_occurrences WHERE ${clauses.join(" AND ")}
    ORDER BY effective_at DESC, recorded_at DESC LIMIT ?
  `).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    occurrence_id: String(row["occurrence_id"]),
    project_id: String(row["project_id"]),
    workspace_id: (row["workspace_id"] as string | null) ?? null,
    workstream_id: (row["workstream_id"] as string | null) ?? null,
    session_id: (row["session_id"] as string | null) ?? null,
    signature_key: String(row["signature_key"]),
    signature_text: String(row["signature_text"]),
    subject_key: (row["subject_key"] as string | null) ?? null,
    event_id: String(row["event_id"]),
    source_exchange_ids: (() => {
      const ids = parseStringArray(row["source_exchange_ids"]);
      const legacy = row["source_exchange_id"];
      return ids.length === 0 && typeof legacy === "string" && legacy !== "" ? [legacy] : ids;
    })(),
    source_evidence_ids: parseStringArray(row["source_evidence_ids"]),
    retry_count: Number(row["retry_count"] ?? 0),
    evidence_authority: String(row["evidence_authority"]),
    effective_at: String(row["effective_at"]),
    recorded_at: String(row["recorded_at"]),
    last_retry_at: (row["last_retry_at"] as string | null) ?? null,
    state: String(row["state"]) as "open" | "remediated",
  }));
}

// ---------------------------------------------------------------------------
// Privacy purge
// ---------------------------------------------------------------------------

export function recordChronicleTombstone(db: Database.Database, eventId: string, reason: string | null, deletedAt = new Date().toISOString()): void {
  db.prepare(`
    INSERT INTO chronicle_tombstones (event_id, deleted_at, reason) VALUES (?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason
    WHERE excluded.deleted_at > chronicle_tombstones.deleted_at
  `).run(eventId, deletedAt, reason);
}

/** Recount signature episodes after occurrences were removed; drop empty signatures. */
function recountSignatures(db: Database.Database, projectIds: Set<string>, now: string): void {
  for (const projectId of projectIds) {
    const signatures = db.prepare("SELECT signature_key FROM incident_signatures WHERE project_id = ?")
      .all(projectId) as Array<{ signature_key: string }>;
    for (const { signature_key } of signatures) {
      const stats = db.prepare(`
        SELECT COUNT(*) AS n, MIN(effective_at) AS first, MAX(effective_at) AS last
        FROM incident_occurrences WHERE project_id = ? AND signature_key = ?
      `).get(projectId, signature_key) as { n: number; first: string | null; last: string | null };
      if (Number(stats.n) === 0) {
        db.prepare("DELETE FROM incident_signatures WHERE project_id = ? AND signature_key = ?").run(projectId, signature_key);
        continue;
      }
      db.prepare(`
        UPDATE incident_signatures SET episode_count = ?, first_effective_at = ?, last_effective_at = ?,
          pattern_state = CASE
            WHEN pattern_state = 'remediated' AND remediation_event_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM fact_revisions WHERE id = incident_signatures.remediation_event_id) THEN 'remediated'
            WHEN ? >= 2 OR user_flagged_repeat = 1 THEN 'pattern' ELSE 'candidate' END,
          remediation_event_id = CASE
            WHEN remediation_event_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM fact_revisions WHERE id = incident_signatures.remediation_event_id) THEN remediation_event_id
            ELSE NULL END,
          remediation_summary = CASE
            WHEN remediation_event_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM fact_revisions WHERE id = incident_signatures.remediation_event_id) THEN remediation_summary
            ELSE NULL END,
          updated_at = ?
        WHERE project_id = ? AND signature_key = ?
      `).run(Number(stats.n), stats.first, stats.last, Number(stats.n), now, projectId, signature_key);
    }
  }
}

export interface ChroniclePurgeResult {
  deletedEvents: number;
  deletedOccurrences: number;
}

/**
 * Remove every Chronicle event that belongs to a purged fact or cites a purged
 * exchange, tombstone each id so sync replay cannot resurrect it, and recount
 * incident signatures. Must run inside the caller's purge transaction.
 */
export function purgeChronicleForSources(
  db: Database.Database,
  input: { exchangeIds: Set<string>; factIds: Set<string>; reason: string; now?: string },
): ChroniclePurgeResult {
  const now = input.now ?? new Date().toISOString();
  const eventIds = new Set<string>();
  for (const factId of input.factIds) {
    for (const row of db.prepare("SELECT id FROM fact_revisions WHERE fact_id = ?").all(factId) as Array<{ id: string }>) {
      eventIds.add(row.id);
    }
  }
  if (input.exchangeIds.size > 0) {
    const rows = db.prepare(`
      SELECT id, source_exchange_id, source_exchange_ids FROM fact_revisions
      WHERE source_exchange_id IS NOT NULL OR source_exchange_ids <> '[]'
    `).all() as Array<{ id: string; source_exchange_id: string | null; source_exchange_ids: string }>;
    for (const row of rows) {
      const cited = parseStringArray(row.source_exchange_ids);
      if (row.source_exchange_id) cited.push(row.source_exchange_id);
      if (cited.some((id) => input.exchangeIds.has(id))) eventIds.add(row.id);
    }
    const occurrences = db.prepare("SELECT event_id, source_exchange_ids FROM incident_occurrences")
      .all() as Array<{ event_id: string; source_exchange_ids: string }>;
    for (const row of occurrences) {
      if (parseStringArray(row.source_exchange_ids).some((id) => input.exchangeIds.has(id))) eventIds.add(row.event_id);
    }
  }
  // Dependent events (rollbacks/remediations pointing at purged events) keep
  // their own evidence; only the dangling pointer is cleared.
  const projectIds = new Set<string>();
  let deletedOccurrences = 0;
  for (const eventId of eventIds) {
    const project = db.prepare("SELECT project_id FROM fact_revisions WHERE id = ?").get(eventId) as { project_id: string | null } | undefined;
    if (project?.project_id) projectIds.add(project.project_id);
    deletedOccurrences += db.prepare("DELETE FROM incident_occurrences WHERE event_id = ?").run(eventId).changes;
    db.prepare("UPDATE fact_revisions SET reverts_event_id = NULL WHERE reverts_event_id = ?").run(eventId);
    db.prepare("UPDATE incident_signatures SET remediation_event_id = NULL, remediation_summary = NULL, pattern_state = CASE WHEN pattern_state = 'remediated' THEN 'pattern' ELSE pattern_state END WHERE remediation_event_id = ?").run(eventId);
    recordChronicleTombstone(db, eventId, input.reason, now);
    db.prepare("DELETE FROM fact_revisions WHERE id = ?").run(eventId);
  }
  for (const row of db.prepare("SELECT DISTINCT project_id FROM incident_signatures").all() as Array<{ project_id: string }>) {
    projectIds.add(row.project_id);
  }
  recountSignatures(db, projectIds, now);
  return { deletedEvents: eventIds.size, deletedOccurrences };
}

// ---------------------------------------------------------------------------
// Outcome telemetry — measured samples, never facts
// ---------------------------------------------------------------------------

export const TELEMETRY_METRICS = [
  "semantic_retrieval_calls",
  "retrieval_gate_skip_count",
  "injected_chars",
  "estimated_tokens",
  "duplicate_tool_calls",
  "repeated_context_turns",
  "time_to_first_correct_action_ms",
  "incident_recurrence",
  "warning_precision",
  "worker_extraction_tokens",
] as const;
export type TelemetryMetric = (typeof TELEMETRY_METRICS)[number];
const TELEMETRY_SET = new Set<string>(TELEMETRY_METRICS);

export function recordTelemetrySample(
  db: Database.Database,
  input: { metric: TelemetryMetric; value: number; unit?: string; projectId?: string | null; sessionId?: string | null; dims?: Record<string, unknown>; recordedAt?: string },
): string {
  if (!TELEMETRY_SET.has(input.metric)) throw new Error(`unknown telemetry metric: ${input.metric}`);
  if (!Number.isFinite(input.value)) throw new Error("telemetry value must be finite");
  const id = randomUUID();
  db.prepare(`
    INSERT INTO continuity_telemetry (sample_id, metric, value, unit, project_id, session_id, dims_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.metric, input.value, input.unit ?? "count", input.projectId ?? null, input.sessionId ?? null,
    JSON.stringify(input.dims ?? {}), input.recordedAt ?? new Date().toISOString());
  return id;
}

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
export function summarizeTelemetry(
  db: Database.Database,
  input: { projectId?: string | null; metric?: TelemetryMetric | null; since?: string | null } = {},
): { notice: string; metrics: TelemetrySummary[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.projectId) { clauses.push("project_id = ?"); params.push(input.projectId); }
  if (input.metric) { clauses.push("metric = ?"); params.push(input.metric); }
  if (input.since) { clauses.push("recorded_at >= ?"); params.push(input.since); }
  const rows = db.prepare(`
    SELECT metric, COUNT(*) AS samples, SUM(value) AS sum, AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max,
           MIN(recorded_at) AS first_recorded_at, MAX(recorded_at) AS last_recorded_at
    FROM continuity_telemetry ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
    GROUP BY metric ORDER BY metric
  `).all(...params) as TelemetrySummary[];
  return {
    notice: `${CHRONICLE_LANE_LABELS.telemetry}: measured samples only; no cost or time savings are asserted without a baseline.`,
    metrics: rows.map((row) => ({ ...row, samples: Number(row.samples), sum: Number(row.sum), avg: Number(row.avg), min: Number(row.min), max: Number(row.max) })),
  };
}

// ---------------------------------------------------------------------------
// Formatting shared by MCP and CLI
// ---------------------------------------------------------------------------

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

export function describeEventSources(db: Database.Database, event: ChronicleEvent): FormattedSource[] {
  return event.source_exchange_ids.map((exchangeId) => {
    const row = db.prepare(`
      SELECT project, timestamp, session_id, archive_path, line_start, line_end, user_message FROM exchanges WHERE id = ?
    `).get(exchangeId) as Record<string, unknown> | undefined;
    if (!row) return { exchangeId, available: false };
    return {
      exchangeId,
      available: true,
      project: (row["project"] as string) ?? null,
      timestamp: (row["timestamp"] as string) ?? null,
      sessionId: (row["session_id"] as string | null) ?? null,
      archivePath: (row["archive_path"] as string) ?? null,
      lineStart: Number(row["line_start"]),
      lineEnd: Number(row["line_end"]),
      excerpt: String(row["user_message"] ?? "").replace(/\s+/g, " ").slice(0, 160),
    };
  });
}

/** One event as labeled markdown. Grounded fields and classifier notes are never merged. */
export function formatChronicleEvent(
  db: Database.Database,
  event: ChronicleEvent,
  options: { includeSources?: boolean } = {},
): string {
  const lines: string[] = [];
  const effect = event.projection_applied ? "projection changed" : "event-only, current unchanged";
  lines.push(`- [${CHRONICLE_LANE_LABELS.event}] ${event.event_kind} · effective ${event.effective_at} (${event.effective_at_source}) · recorded ${event.recorded_at} · ${effect} · actor ${event.actor} · authority ${event.evidence_authority}`);
  lines.push(`  id: ${event.id}${event.subject_key ? ` · subject: ${event.subject_key}` : ""}${event.fact_id ? ` · fact: ${event.fact_id}` : ""}`);
  if (event.fact_id) {
    // BRANCH TRUTH: history of an unmerged workspace/workstream fact is never
    // presented as project-wide truth.
    const placement = db.prepare("SELECT promotion_state, workspace_id, workstream_id FROM facts WHERE id = ?")
      .get(event.fact_id) as { promotion_state: string | null; workspace_id: string | null; workstream_id: string | null } | undefined;
    if (placement?.promotion_state === "workstream" || placement?.promotion_state === "workspace") {
      const id = placement.promotion_state === "workstream" ? placement.workstream_id : placement.workspace_id;
      lines.push(`  scope: ${placement.promotion_state} ${id ?? "?"} (unmerged; not project-wide truth)`);
    }
  }
  if (event.previous_value !== null || event.new_value !== null) {
    lines.push(`  value: ${event.previous_value === null ? "(none)" : JSON.stringify(event.previous_value)} → ${event.new_value === null ? "(none)" : JSON.stringify(event.new_value)}`);
  }
  if (event.from_semantic_generation !== null || event.to_semantic_generation !== null) {
    lines.push(`  semantic generation: ${event.from_semantic_generation ?? "-"} → ${event.to_semantic_generation ?? "-"}`);
  }
  if (event.lifecycle_generation !== null) lines.push(`  lifecycle generation: ${event.lifecycle_generation}`);
  if (event.reverts_event_id) lines.push(`  reverts event: ${event.reverts_event_id}`);
  if (event.related_event_ids.length > 0) lines.push(`  related events: ${event.related_event_ids.join(", ")}`);
  if (event.problem) lines.push(`  problem (source-cited): ${event.problem}`);
  lines.push(`  grounded cause (source-cited): ${event.grounded_cause ?? "null — no cause stated in evidence"}`);
  if (event.rationale) lines.push(`  rationale (source-cited): ${event.rationale}`);
  if (event.classifier_note) lines.push(`  classifier note (model inference, NOT authoritative): ${event.classifier_note}`);
  if (event.outcome) lines.push(`  outcome: ${JSON.stringify(event.outcome)}`);
  if (options.includeSources !== false) {
    const sources = describeEventSources(db, event);
    if (sources.length === 0) {
      lines.push(`  sources: none recorded`);
    }
    for (const source of sources) {
      if (!source.available) {
        lines.push(`  [${CHRONICLE_LANE_LABELS.rawEvidence}] ${source.exchangeId}: source unavailable (purged or missing)`);
      } else {
        lines.push(`  [${CHRONICLE_LANE_LABELS.rawEvidence}] ${source.exchangeId} · ${source.timestamp} · session ${source.sessionId ?? "?"} · lines ${source.lineStart}-${source.lineEnd} in ${source.archivePath}`);
        if (source.excerpt) lines.push(`    "${source.excerpt}"`);
      }
    }
    if (event.source_evidence_ids.length > 0) lines.push(`  tool evidence ids: ${event.source_evidence_ids.join(", ")}`);
  }
  return lines.join("\n");
}
