import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import {
  initDatabase,
  getVecTableDtype,
  embeddingToVecBlob,
  vecParamSql,
  hashRecallPrompt,
} from "./db.js";
import {
  generateEmbedding,
  initEmbeddings,
  EMBEDDING_VERSION,
} from "./embeddings.js";
import {
  getSyncDir,
  SYNC_PAYLOAD_FILE_NAMES,
  countPayloadRows,
  payloadSha256,
} from "./sync-export.js";
import { canonicalizeProjectPath } from "./project-identity.js";
import { PRIVACY_TOMBSTONE_REASON } from "./conversation-policy.js";
import { applyReplicatedLifecycle, compareTimestamps } from "./fact-management.js";
import { resolveProjectWorkspace } from "./continuity-identity.js";
import {
  CHRONICLE_EVENT_KINDS,
  insertReplicatedChronicleEvent,
  purgeChronicleForSources,
  recordChronicleTombstone,
  type ChronicleActor,
  type ChronicleEventKind,
  type EvidenceAuthority,
} from "./chronicle.js";

interface SyncFact {
  id: string;
  fact: string;
  category: string;
  scope_type: "project" | "global";
  scope_project: string | null;
  project_id: string | null;
  portable_project_key: string | null;
  subject_key: string | null;
  promotion_state: "legacy-project" | "decision" | "project-current";
  source_exchange_ids: string;
  created_at: string;
  updated_at: string;
  /** 재감사 P1-3: 의미 사건의 시각 — semantic 충돌 판정의 기준 시계다. */
  semantic_updated_at: string;
  /** 재감사 P1-3(protocol v4): 활성 사건의 시각 — lifecycle 충돌 판정의 기준
   * 시계다. 의미 편집과 활성 전환은 서로 독립인 축이다. */
  lifecycle_updated_at: string;
  consolidated_count: number;
  is_active: 0 | 1;
}

interface SyncTombstone {
  fact_id: string;
  deleted_at: string;
  reason: string | null;
}

/** Phase 4: a purged Chronicle event travels as a tombstone with fact_id null. */
interface SyncEventTombstone {
  event_id: string;
  deleted_at: string;
  reason: string | null;
}

interface SyncRevision {
  id: string;
  fact_id: string | null;
  previous_fact: string | null;
  new_fact: string | null;
  reason: string | null;
  source_exchange_id: string | null;
  created_at: string;
  /** Phase 4 Chronicle shape; absent on rows written by a released peer. */
  chronicle: {
    project_id: string | null;
    portable_project_key: string | null;
    subject_key: string | null;
    event_kind: ChronicleEventKind;
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
    recorded_at: string;
    projection_applied: boolean;
  } | null;
}

interface SyncRecallEvent {
  id: string;
  session_id: string;
  project: string | null;
  project_id: string | null;
  portable_project_key: string | null;
  prompt_hash: string;
  fact_ids: string;
  status: "prepared" | "emitted";
  created_at: string;
  emitted_at: string | null;
  context_epoch: number;
  project_memory_revision: number;
}

export interface SyncImportResult {
  newFacts: number;
  updatedFacts: number;
  deletedFacts: number;
  newRevisions: number;
  newTombstones: number;
  newRecallEvents: number;
  updatedRecallEvents: number;
  /** P2-7: rows (or manifests) that could not be parsed, with their source
   * location. Valid data still imports; the damage is never silent. */
  malformedRows: PayloadIssue[];
}

export interface PayloadIssue {
  file: string;
  line: number;
  error: string;
}

const ALLOWED_CATEGORIES = new Set([
  "decision",
  "preference",
  "pattern",
  "knowledge",
  "constraint",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// P2-5: device snapshot layout — generations/<uuid>/ file sets committed by
// the exporter's atomic rename, with CURRENT naming the committed generation.
const GENERATIONS_DIR_NAME = "generations";
const CURRENT_MANIFEST = "CURRENT";

/**
 * The complete payload a committed generation must carry, INCLUDING the
 * integrity manifest. A generation is a set-atomic unit: if any one file is
 * missing, the whole generation is rejected instead of importing the
 * survivors (재감사 P1-4 — reading a pruned generation must fail loudly,
 * never degrade into "that data was empty").
 */
const REQUIRED_PAYLOAD_FILES = [
  ...SYNC_PAYLOAD_FILE_NAMES,
  "meta.json",
] as const;

interface GenerationManifest {
  protocol_version?: unknown;
  generation?: unknown;
  device_id?: unknown;
  files?: Record<string, { rows?: unknown; sha256?: unknown }>;
}

/**
 * Verify a pinned generation against its manifest (재감사 P1-4 보강): the
 * manifest's generation/device must match the location CURRENT named, and
 * every payload file must match its pinned row count and SHA-256 with every
 * line parsing cleanly. Cloud sync moves a generation directory file-by-file
 * — a locally-atomic rename proves nothing about what arrived here, and a
 * partially synced tombstones file is a privacy boundary, so ANY mismatch
 * rejects the whole generation. Returns the first integrity error, or null.
 */
function validateGenerationIntegrity(
  deviceId: string,
  generationId: string,
  files: Map<string, string>,
): string | null {
  let manifest: GenerationManifest;
  try {
    manifest = JSON.parse(files.get("meta.json") as string) as GenerationManifest;
  } catch (error) {
    return `unreadable meta.json: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (manifest.protocol_version !== 4) {
    return `unsupported protocol_version ${JSON.stringify(manifest.protocol_version ?? null)}`;
  }
  if (manifest.generation !== generationId) {
    return `manifest generation ${JSON.stringify(manifest.generation ?? null)} does not match the CURRENT-named generation`;
  }
  if (manifest.device_id !== deviceId) {
    return `manifest device_id ${JSON.stringify(manifest.device_id ?? null)} does not match the device directory`;
  }
  if (!manifest.files || typeof manifest.files !== "object") {
    return "manifest has no files map";
  }
  for (const name of SYNC_PAYLOAD_FILE_NAMES) {
    const spec = manifest.files[name];
    if (!spec || typeof spec.rows !== "number" || typeof spec.sha256 !== "string") {
      return `manifest has no integrity spec for ${name}`;
    }
    const content = files.get(name) as string;
    if (countPayloadRows(content) !== spec.rows) {
      return `${name} row count mismatch (manifest pins ${spec.rows}) — partially synced generation`;
    }
    if (payloadSha256(content) !== spec.sha256) {
      return `${name} sha256 mismatch — partially synced or corrupted generation`;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        JSON.parse(lines[i]);
      } catch {
        return `${name} malformed JSON at line ${i + 1}`;
      }
    }
  }
  return null;
}

/** One committed generation, fully read into memory before any DB mutation.
 * Pinning the payload closes the slow-reader race: a later export's pruning
 * cannot remove data the importer is about to read, because there is nothing
 * left to read from disk. */
interface PinnedGeneration {
  deviceId: string;
  generationId: string;
  /** Generation directory — used only for issue attribution. */
  source: string;
  files: Map<string, string>;
}

function parseFromPinned(
  generation: PinnedGeneration,
  name: string,
  issues: PayloadIssue[],
): unknown[] {
  const content = generation.files.get(name);
  if (content === undefined) return [];
  const rows: unknown[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch (error) {
      // P2-7: a malformed external row is skipped but reported with its
      // source location — the docs' "uncommitted/reported" contract.
      issues.push({
        file: path.join(generation.source, name),
        line: i + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rows;
}

/**
 * Collect every device's committed generation, fully pinned into memory.
 *
 * Contract (재감사 P1-1 / P1-4):
 * - A device contributes exactly the generation its CURRENT manifest names —
 *   committed by the exporter's atomic rename, so it is never a mixed set.
 * - A CURRENT manifest that exists but is unreadable, malformed, or names a
 *   generation missing required files FAILS CLOSED: the device snapshot is
 *   skipped and the damage is reported. Falling back to an older payload
 *   would silently time-travel an upgraded device backwards.
 * - A device without a CURRENT manifest has no committed generation. Legacy
 *   device-root payloads are no longer read (root-mirror/device-root
 *   compatibility removed); their presence is reported, never imported.
 */
function collectCommittedGenerations(
  syncDir: string,
  issues: PayloadIssue[],
): PinnedGeneration[] {
  const devicesDir = path.join(syncDir, "devices");
  if (!fs.existsSync(devicesDir)) return [];
  const pinned: PinnedGeneration[] = [];
  for (const entry of fs.readdirSync(devicesDir, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.endsWith(".tmp"))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const deviceDir = path.join(devicesDir, entry.name);
    const currentPath = path.join(deviceDir, CURRENT_MANIFEST);
    if (!fs.existsSync(currentPath)) {
      if (fs.existsSync(path.join(deviceDir, "facts.jsonl"))) {
        issues.push({
          file: currentPath,
          line: 0,
          error: `device ${entry.name} has a legacy device-root payload but no CURRENT manifest; it is not read (device-root compatibility removed)`,
        });
      }
      continue;
    }
    let generation: unknown;
    try {
      generation = (JSON.parse(fs.readFileSync(currentPath, "utf8")) as { generation?: unknown })
        .generation;
    } catch (error) {
      issues.push({
        file: currentPath,
        line: 0,
        error: `CURRENT manifest unreadable, device ${entry.name} snapshot rejected: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (typeof generation !== "string" || !generation) {
      issues.push({
        file: currentPath,
        line: 0,
        error: `CURRENT manifest has no generation id, device ${entry.name} snapshot rejected`,
      });
      continue;
    }
    const genDir = path.join(deviceDir, GENERATIONS_DIR_NAME, generation);
    const files = new Map<string, string>();
    let complete = true;
    for (const name of REQUIRED_PAYLOAD_FILES) {
      const filePath = path.join(genDir, name);
      try {
        files.set(name, fs.readFileSync(filePath, "utf8"));
      } catch (error) {
        // 재감사 P2 v4: missing AND unreadable are the same fail-closed outcome.
        // A generation pruned between the CURRENT read and this read must not
        // escape as an exception — it is a per-device rejected snapshot with a
        // reported issue, and other devices keep importing.
        issues.push({
          file: currentPath,
          line: 0,
          error: `CURRENT names generation ${generation} with unreadable ${name}, device ${entry.name} snapshot rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        complete = false;
        break;
      }
    }
    if (!complete) continue;
    const integrityError = validateGenerationIntegrity(entry.name, generation, files);
    if (integrityError) {
      issues.push({
        file: currentPath,
        line: 0,
        error: `generation ${generation} integrity check failed, device ${entry.name} snapshot rejected: ${integrityError}`,
      });
      continue;
    }
    pinned.push({ deviceId: entry.name, generationId: generation, source: genDir, files });
  }
  return pinned;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isStringArrayJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string");
  } catch {
    return false;
  }
}

function canonicalScopeProject(
  scopeType: "project" | "global",
  scopeProject: unknown,
): string | null | undefined {
  if (scopeType === "global") {
    return scopeProject === null || scopeProject === "" || scopeProject === undefined
      ? null
      : undefined;
  }
  if (typeof scopeProject !== "string" || !scopeProject.trim() || !path.isAbsolute(scopeProject)) {
    return undefined;
  }
  const canonical = canonicalizeProjectPath(scopeProject);
  return canonical && path.isAbsolute(canonical) ? canonical : undefined;
}

function parseSyncFact(value: unknown): SyncFact | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.fact !== "string" || !value.fact ||
    typeof value.category !== "string" || !ALLOWED_CATEGORIES.has(value.category) ||
    (value.scope_type !== "project" && value.scope_type !== "global") ||
    !isStringArrayJson(value.source_exchange_ids) ||
    !isTimestamp(value.created_at) || !isTimestamp(value.updated_at) ||
    !isTimestamp(value.semantic_updated_at) ||
    !isTimestamp(value.lifecycle_updated_at) ||
    !Number.isInteger(value.consolidated_count) || Number(value.consolidated_count) < 0 ||
    (value.is_active !== 0 && value.is_active !== 1)
  ) return null;
  const stableProjectId = typeof value.project_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.project_id)
    ? value.project_id
    : null;
  const portableProjectKey = typeof value.portable_project_key === "string" && /^[A-Za-z0-9_.:-]{4,160}$/.test(value.portable_project_key)
    ? value.portable_project_key
    : null;
  const isStableProject = value.scope_type === "project" && stableProjectId !== null;
  const scopeProject = isStableProject
    ? (value.scope_project === null || value.scope_project === undefined ? null : undefined)
    : canonicalScopeProject(value.scope_type, value.scope_project);
  if (scopeProject === undefined || (value.scope_type === "project" && !stableProjectId && scopeProject === null)) return null;
  const promotionState = value.promotion_state === "decision" || value.promotion_state === "project-current"
    ? value.promotion_state
    : "legacy-project";
  const subjectKey = typeof value.subject_key === "string" && /^[a-z][a-z0-9_.-]{2,160}$/.test(value.subject_key)
    ? value.subject_key
    : null;
  return {
    id: value.id,
    fact: value.fact,
    category: value.category,
    scope_type: value.scope_type,
    scope_project: scopeProject,
    project_id: value.scope_type === "global" ? null : stableProjectId,
    portable_project_key: value.scope_type === "global" ? null : portableProjectKey,
    subject_key: subjectKey,
    promotion_state: promotionState,
    source_exchange_ids: value.source_exchange_ids,
    created_at: value.created_at,
    updated_at: value.updated_at,
    semantic_updated_at: value.semantic_updated_at,
    lifecycle_updated_at: value.lifecycle_updated_at,
    consolidated_count: Number(value.consolidated_count),
    is_active: value.is_active === 0 ? 0 : 1,
  };
}

function parseTombstone(value: unknown): SyncTombstone | null {
  if (!isRecord(value) || typeof value.fact_id !== "string" || !value.fact_id ||
      !isTimestamp(value.deleted_at) ||
      (value.reason !== undefined && value.reason !== null && typeof value.reason !== "string")) {
    return null;
  }
  return {
    fact_id: value.fact_id,
    deleted_at: value.deleted_at,
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}

function parseEventTombstone(value: unknown): SyncEventTombstone | null {
  if (!isRecord(value) || (value.fact_id !== null && value.fact_id !== undefined) ||
      typeof value.event_id !== "string" || !value.event_id || value.event_id.length > 200 ||
      !isTimestamp(value.deleted_at) ||
      (value.reason !== undefined && value.reason !== null && typeof value.reason !== "string")) {
    return null;
  }
  return {
    event_id: value.event_id,
    deleted_at: value.deleted_at,
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}

function parseAnyTombstone(value: unknown): boolean {
  return parseTombstone(value) !== null || parseEventTombstone(value) !== null;
}

const CHRONICLE_ACTORS = new Set(["extractor", "consolidator", "user", "sync", "legacy"]);
const EVIDENCE_AUTHORITIES = new Set(["human-decision", "human", "trusted-tool", "unknown"]);
const CHRONICLE_KIND_SET = new Set<string>(CHRONICLE_EVENT_KINDS);

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
}

function parseRevision(value: unknown): SyncRevision | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || !isTimestamp(value.created_at)) {
    return null;
  }
  const reason = optionalString(value.reason);
  const sourceExchangeId = optionalString(value.source_exchange_id);
  if (reason === undefined || sourceExchangeId === undefined) return null;
  const isChronicle = value.event_kind !== undefined && value.event_kind !== null;
  if (!isChronicle) {
    // Released 7-field revision row.
    if (typeof value.fact_id !== "string" || !value.fact_id ||
        typeof value.previous_fact !== "string" || typeof value.new_fact !== "string") {
      return null;
    }
    return {
      id: value.id,
      fact_id: value.fact_id,
      previous_fact: value.previous_fact,
      new_fact: value.new_fact,
      reason,
      source_exchange_id: sourceExchangeId,
      created_at: value.created_at,
      chronicle: null,
    };
  }
  if (typeof value.event_kind !== "string" || !CHRONICLE_KIND_SET.has(value.event_kind)) return null;
  if (value.id.length > 200) return null;
  const factId = optionalString(value.fact_id);
  const previous = optionalString(value.previous_fact);
  const next = optionalString(value.new_fact);
  const projectId = optionalString(value.project_id);
  const portableKey = optionalString(value.portable_project_key);
  const subjectKey = optionalString(value.subject_key);
  const problem = optionalString(value.problem);
  const groundedCause = optionalString(value.grounded_cause);
  const rationale = optionalString(value.rationale);
  const classifierNote = optionalString(value.classifier_note);
  const revertsEventId = optionalString(value.reverts_event_id);
  const outcomeRaw = optionalString(value.outcome_json);
  const sourceExchangeIds = optionalStringArray(value.source_exchange_ids);
  const sourceEvidenceIds = optionalStringArray(value.source_evidence_ids);
  const relatedEventIds = optionalStringArray(value.related_event_ids);
  if ([factId, previous, next, projectId, portableKey, subjectKey, problem, groundedCause, rationale,
       classifierNote, revertsEventId, outcomeRaw].includes(undefined) ||
      !sourceExchangeIds || !sourceEvidenceIds || !relatedEventIds) {
    return null;
  }
  if (projectId && !/^[A-Za-z0-9_-]{8,128}$/.test(projectId)) return null;
  if (typeof value.actor !== "string" || !CHRONICLE_ACTORS.has(value.actor)) return null;
  if (typeof value.policy_version !== "string" || !value.policy_version) return null;
  if (typeof value.evidence_authority !== "string" || !EVIDENCE_AUTHORITIES.has(value.evidence_authority)) return null;
  if (!isTimestamp(value.effective_at) || !isTimestamp(value.recorded_at)) return null;
  const projection = value.projection_applied;
  if (projection !== 0 && projection !== 1 && projection !== true && projection !== false) return null;
  const projectionApplied = projection === 1 || projection === true;
  // Structural GROUNDED CAUSE guard for replicated rows: the exporting peer
  // verified grounded fields against its own sources, so a grounded field
  // must always travel with cited sources (a user-stated rationale is the one
  // source-free exception, and only for actor `user`). A projection change
  // must name the fact it changed. Anything else is not a Memex-written row.
  if ((problem || groundedCause) && sourceExchangeIds.length === 0) return null;
  if (rationale && sourceExchangeIds.length === 0 && value.actor !== "user") return null;
  if (projectionApplied && !factId) return null;
  let outcome: Record<string, unknown> | null = null;
  if (outcomeRaw) {
    try {
      const parsed: unknown = JSON.parse(outcomeRaw);
      if (!isRecord(parsed)) return null;
      outcome = parsed;
    } catch {
      return null;
    }
  }
  return {
    id: value.id,
    fact_id: factId ?? null,
    previous_fact: previous ?? null,
    new_fact: next ?? null,
    reason,
    source_exchange_id: sourceExchangeId,
    created_at: value.created_at,
    chronicle: {
      project_id: projectId ?? null,
      portable_project_key: portableKey ?? null,
      subject_key: subjectKey ?? null,
      event_kind: value.event_kind as ChronicleEventKind,
      problem: problem ?? null,
      grounded_cause: groundedCause ?? null,
      rationale: rationale ?? null,
      classifier_note: classifierNote ?? null,
      outcome,
      source_exchange_ids: sourceExchangeIds,
      source_evidence_ids: sourceEvidenceIds,
      reverts_event_id: revertsEventId ?? null,
      related_event_ids: relatedEventIds,
      actor: value.actor as ChronicleActor,
      policy_version: value.policy_version,
      evidence_authority: value.evidence_authority as EvidenceAuthority,
      effective_at: value.effective_at,
      recorded_at: value.recorded_at,
      projection_applied: projectionApplied,
    },
  };
}

function parseRecallEvent(value: unknown): SyncRecallEvent | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
      typeof value.session_id !== "string" || !value.session_id ||
      !((typeof value.project === "string" && value.project) ||
        (typeof value.project_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.project_id))) ||
      typeof value.prompt_hash !== "string" || !value.prompt_hash ||
      !isStringArrayJson(value.fact_ids) ||
      (value.status !== "prepared" && value.status !== "emitted") ||
      !isTimestamp(value.created_at) ||
      (value.emitted_at !== undefined && value.emitted_at !== null && !isTimestamp(value.emitted_at))) {
    return null;
  }
  if (value.source_type !== undefined && value.source_type !== "memex_recall") return null;
  if (value.learnable !== undefined && value.learnable !== 0 && value.learnable !== false) return null;
  return {
    id: value.id,
    session_id: value.session_id,
    project: typeof value.project === "string" && value.project ? value.project : null,
    project_id: typeof value.project_id === "string" ? value.project_id : null,
    portable_project_key: typeof value.portable_project_key === "string" &&
      /^[A-Za-z0-9_.:-]{4,160}$/.test(value.portable_project_key)
      ? value.portable_project_key
      : null,
    prompt_hash: value.prompt_hash,
    fact_ids: value.fact_ids,
    status: value.status,
    created_at: value.created_at,
    emitted_at: typeof value.emitted_at === "string" ? value.emitted_at : null,
    context_epoch: Number.isInteger(value.context_epoch) ? Number(value.context_epoch) : 0,
    project_memory_revision: Number.isInteger(value.project_memory_revision) ? Number(value.project_memory_revision) : 0,
  };
}

/** Semantic identity of a fact row — the ONLY fields that may decide a
 * semantic winner. Provenance (`source_exchange_ids`) and `consolidated_count`
 * are monotone lineage metadata: letting them decide a tie let a device with
 * POORER provenance lexically beat a device whose DUPLICATE consolidation had
 * unioned evidence in — and losing provenance breaks the privacy purge's fact
 * lookup (재감사 P1-1 보강). `is_active` is deliberately absent (재감사
 * P1-3 v4): activation is LIFECYCLE state with its own clock, not semantic
 * content — it reconciles on the lifecycle axis, never by deciding a meaning
 * tie. Remaining fields use canonical JSON lexical order so every device
 * independently selects the same winner. */
function semanticConflictKey(fact: SyncFact): string {
  return JSON.stringify([
    fact.fact,
    fact.category,
    fact.scope_type,
    fact.project_id ?? fact.scope_project,
    fact.subject_key,
    fact.promotion_state,
    fact.created_at,
  ]);
}

function parseFactSourceIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** DB 행의 의미 시계 — legacy/빈 값은 updated_at으로 폴백한다. */
function localSemanticClock(row: Record<string, unknown>): string {
  const value = row.semantic_updated_at;
  return typeof value === "string" && value !== "" && isTimestamp(value)
    ? value
    : (row.updated_at as string);
}

/** DB 행의 활성 시계(재감사 P1-3 v4) — legacy/빈 값은 updated_at으로 폴백한다. */
function localLifecycleClock(row: Record<string, unknown>): string {
  const value = row.lifecycle_updated_at;
  return typeof value === "string" && value !== "" && isTimestamp(value)
    ? value
    : (row.updated_at as string);
}

/** Local fact view for conflict judgment — the fields the semantic key,
 * lineage merge, and lifecycle reconciliation read from the current row. */
function localFactView(row: Record<string, unknown>): SyncFact & {
  semantic_generation: number;
  lifecycle_generation: number;
} {
  return {
    id: row.id as string,
    fact: row.fact as string,
    category: row.category as string,
    scope_type: row.scope_type as "project" | "global",
    scope_project: (row.scope_project as string | null) ?? null,
    project_id: (row.project_id as string | null) ?? null,
    portable_project_key: null,
    subject_key: (row.subject_key as string | null) ?? null,
    promotion_state: (row.promotion_state as SyncFact["promotion_state"]) ?? "legacy-project",
    source_exchange_ids: (row.source_exchange_ids as string | null) ?? "[]",
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    semantic_updated_at: localSemanticClock(row),
    lifecycle_updated_at: localLifecycleClock(row),
    consolidated_count: Number(row.consolidated_count),
    is_active: Number(row.is_active) === 0 ? 0 : 1,
    semantic_generation: Number(row.semantic_generation ?? 1),
    lifecycle_generation: Number(row.lifecycle_generation ?? 1),
  };
}

function deleteFactState(db: Database.Database, factId: string): void {
  db.prepare("DELETE FROM vec_facts WHERE id = ?").run(factId);
  db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(factId);
  db.prepare("DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?")
    .run(factId, factId);
  purgeChronicleForSources(db, { exchangeIds: new Set(), factIds: new Set([factId]), reason: "sync_tombstone" });
  db.prepare("DELETE FROM facts WHERE id = ?").run(factId);
}

/**
 * Newest tombstone wins; a conversation exclusion is terminal privacy state
 * with no un-consent event, so its reason dominates any non-privacy deletion
 * regardless of timestamps while the timestamp stays monotone.
 */
function mergeTombstones(a: SyncTombstone, b: SyncTombstone): SyncTombstone {
  const privacy =
    a.reason === PRIVACY_TOMBSTONE_REASON ||
    b.reason === PRIVACY_TOMBSTONE_REASON;
  if (!privacy) {
    return compareTimestamps(b.deleted_at, a.deleted_at) > 0 ? b : a;
  }
  return {
    fact_id: b.fact_id,
    deleted_at:
      compareTimestamps(a.deleted_at, b.deleted_at) > 0
        ? a.deleted_at
        : b.deleted_at,
    reason: PRIVACY_TOMBSTONE_REASON,
  };
}

function importTombstones(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): void {
  const byFact = new Map<string, SyncTombstone>();
  const byEvent = new Map<string, SyncEventTombstone>();
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "fact-tombstones.jsonl", result.malformedRows)) {
      const eventRow = parseEventTombstone(value);
      if (eventRow) {
        const previous = byEvent.get(eventRow.event_id);
        if (!previous || compareTimestamps(eventRow.deleted_at, previous.deleted_at) > 0 ||
            eventRow.reason === PRIVACY_TOMBSTONE_REASON) {
          byEvent.set(eventRow.event_id, eventRow);
        }
        continue;
      }
      const row = parseTombstone(value);
      if (!row) continue;
      const previous = byFact.get(row.fact_id);
      byFact.set(row.fact_id, previous ? mergeTombstones(previous, row) : row);
    }
  }

  // Chronicle events are immutable, so an event tombstone is terminal: the
  // local copy is removed (with its incident occurrence) and the id is
  // remembered so later replays cannot resurrect it.
  for (const tombstone of byEvent.values()) {
    const existing = db.prepare("SELECT deleted_at FROM chronicle_tombstones WHERE event_id = ?")
      .get(tombstone.event_id) as { deleted_at: string } | undefined;
    const commit = db.transaction(() => {
      const present = !!db.prepare("SELECT 1 FROM fact_revisions WHERE id = ?").get(tombstone.event_id);
      if (present) {
        db.prepare("DELETE FROM incident_occurrences WHERE event_id = ?").run(tombstone.event_id);
        db.prepare("UPDATE fact_revisions SET reverts_event_id = NULL WHERE reverts_event_id = ?").run(tombstone.event_id);
        db.prepare("DELETE FROM fact_revisions WHERE id = ?").run(tombstone.event_id);
      }
      recordChronicleTombstone(db, tombstone.event_id, tombstone.reason, tombstone.deleted_at);
      return present;
    });
    commit();
    if (!existing) result.newTombstones++;
  }

  for (const tombstone of byFact.values()) {
    const localFact = db.prepare(
      "SELECT COALESCE(NULLIF(semantic_updated_at, ''), updated_at) AS semantic_clock, updated_at FROM facts WHERE id = ?",
    ).get(tombstone.fact_id) as
      | { semantic_clock: string; updated_at: string }
      | undefined;
    const localTombstone = db.prepare(
      "SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?",
    ).get(tombstone.fact_id) as
      | { deleted_at: string; reason: string | null }
      | undefined;
    const privacy = tombstone.reason === PRIVACY_TOMBSTONE_REASON;
    if (localTombstone) {
      if (localTombstone.reason === PRIVACY_TOMBSTONE_REASON) {
        // Terminal local exclusion: nothing may downgrade it, and only a
        // strictly newer privacy tombstone can extend it.
        if (!privacy || compareTimestamps(localTombstone.deleted_at, tombstone.deleted_at) >= 0) continue;
      } else if (
        !privacy &&
        compareTimestamps(localTombstone.deleted_at, tombstone.deleted_at) >= 0
      ) {
        continue;
      }
      // A privacy tombstone arriving over a non-privacy local tombstone falls
      // through: the terminal reason strengthens the deletion.
    }
    // A fact event strictly newer than the deletion is a later restore/edit —
    // except a conversation exclusion, which is terminal and propagates
    // conversation-wide regardless of stale peer edits.
    // A fact event strictly newer than the deletion is a later restore/edit —
    // except a conversation exclusion, which is terminal and propagates
    // conversation-wide regardless of stale peer edits. 비교 시계는 semantic
    // clock이다(P1-3) — 삭제 이후의 메타데이터 touch는 삭제를 되돌리지 못한다.
    if (!privacy && localFact && compareTimestamps(localFact.semantic_clock, tombstone.deleted_at) > 0) continue;

    const commit = db.transaction(() => {
      const existed = !!db.prepare("SELECT 1 FROM facts WHERE id = ?").get(tombstone.fact_id);
      deleteFactState(db, tombstone.fact_id);
      // Monotone: an existing tombstone never moves backwards in time.
      const deletedAt =
        localTombstone &&
        compareTimestamps(localTombstone.deleted_at, tombstone.deleted_at) > 0
          ? localTombstone.deleted_at
          : tombstone.deleted_at;
      db.prepare(`
        INSERT INTO fact_tombstones (fact_id, deleted_at, reason)
        VALUES (?, ?, ?)
        ON CONFLICT(fact_id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason
      `).run(tombstone.fact_id, deletedAt, tombstone.reason);
      return existed;
    });
    if (commit()) result.deletedFacts++;
    result.newTombstones++;
  }
}

function resolveSyncedFactScope(db: Database.Database, fact: SyncFact): SyncFact {
  const subjectKey = fact.subject_key ?? `${fact.scope_type === "global" ? "global" : "legacy"}.fact.${fact.id}`;
  if (fact.scope_type === "global") return { ...fact, project_id: null, scope_project: null, subject_key: subjectKey };
  if (!fact.project_id) {
    const identity = resolveProjectWorkspace(db, { cwd: fact.scope_project as string });
    return { ...fact, project_id: identity.projectId, scope_project: identity.canonicalPath, subject_key: subjectKey };
  }
  const byId = db.prepare(`
    SELECT project_id, portable_project_key FROM projects WHERE project_id = ?
  `).get(fact.project_id) as { project_id: string; portable_project_key: string | null } | undefined;
  const byPortable = fact.portable_project_key
    ? db.prepare(`
        SELECT project_id, portable_project_key FROM projects WHERE portable_project_key = ?
      `).get(fact.portable_project_key) as { project_id: string; portable_project_key: string | null } | undefined
    : undefined;
  if (byId && byPortable && byId.project_id !== byPortable.project_id) {
    throw new Error("stable project id and portable key resolve to different local projects");
  }
  if (byId?.portable_project_key && fact.portable_project_key &&
      byId.portable_project_key !== fact.portable_project_key) {
    throw new Error("stable project id conflicts with local portable key");
  }
  const localProjectId = byPortable?.project_id ?? byId?.project_id ?? fact.project_id;
  if (!byId && !byPortable) {
    db.prepare(`
      INSERT INTO projects(project_id, portable_project_key, display_name, memory_revision, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(localProjectId, fact.portable_project_key, localProjectId, fact.created_at, fact.updated_at);
  } else if (fact.portable_project_key) {
    db.prepare(`
      UPDATE projects SET portable_project_key = COALESCE(portable_project_key, ?), updated_at = ?
      WHERE project_id = ?
    `).run(fact.portable_project_key, fact.updated_at, localProjectId);
  }
  const workspace = db.prepare(`
    SELECT canonical_path FROM workspaces WHERE project_id = ?
    ORDER BY last_seen_at DESC, workspace_id LIMIT 1
  `).get(localProjectId) as { canonical_path: string } | undefined;
  return { ...fact, project_id: localProjectId, scope_project: workspace?.canonical_path ?? null, subject_key: subjectKey };
}

function rejectStableIdentityConflicts(
  db: Database.Database,
  generations: PinnedGeneration[],
  errors: SyncImportResult["malformedRows"],
): Set<string> {
  const rejected = new Set<string>();
  const remoteKeys = new Map<string, { key: string | null; generations: Set<string> }>();
  const slots = new Map<string, { factId: string; generations: Set<string> }>();
  const reject = (
    generation: PinnedGeneration,
    message: string,
    related: Set<string> = new Set(),
    file = "facts.jsonl",
  ): void => {
    const key = generationKey(generation);
    rejected.add(key);
    for (const other of related) rejected.add(other);
    errors.push({ file: path.join(generation.source, file), line: 0, error: message });
  };
  for (const generation of generations) {
    const generationId = generationKey(generation);
    for (const value of parseFromPinned(generation, "facts.jsonl", errors)) {
      const fact = parseSyncFact(value);
      if (!fact || fact.scope_type !== "project" || !fact.project_id) continue;
      const priorRemote = remoteKeys.get(fact.project_id);
      if (priorRemote && priorRemote.key && fact.portable_project_key && priorRemote.key !== fact.portable_project_key) {
        reject(generation, "stable project_id is paired with conflicting portable_project_key values", priorRemote.generations);
      } else if (!priorRemote) {
        remoteKeys.set(fact.project_id, { key: fact.portable_project_key, generations: new Set([generationId]) });
      } else {
        priorRemote.key ??= fact.portable_project_key;
        priorRemote.generations.add(generationId);
      }
      const byId = db.prepare("SELECT project_id, portable_project_key FROM projects WHERE project_id = ?")
        .get(fact.project_id) as { project_id: string; portable_project_key: string | null } | undefined;
      const byPortable = fact.portable_project_key
        ? db.prepare("SELECT project_id FROM projects WHERE portable_project_key = ?")
            .get(fact.portable_project_key) as { project_id: string } | undefined
        : undefined;
      if (byId?.portable_project_key && fact.portable_project_key &&
          byId.portable_project_key !== fact.portable_project_key) {
        reject(generation, "stable project_id conflicts with the local portable_project_key");
        continue;
      }
      if (byId && byPortable && byId.project_id !== byPortable.project_id) {
        reject(generation, "stable project_id and portable_project_key resolve to different local projects");
        continue;
      }
      const localProjectId = byPortable?.project_id ?? byId?.project_id ?? fact.project_id;
      const subjectKey = fact.subject_key ?? `legacy.fact.${fact.id}`;
      const slotKey = `${localProjectId}\0${fact.promotion_state}\0${subjectKey}`;
      const localConflict = db.prepare(`
        SELECT id FROM facts
        WHERE is_active = 1 AND project_id = ? AND promotion_state = ? AND subject_key = ? AND id <> ?
        LIMIT 1
      `).get(localProjectId, fact.promotion_state, subjectKey, fact.id) as { id: string } | undefined;
      if (localConflict) {
        reject(generation, `stable subject slot conflicts with local fact ${localConflict.id}`);
        continue;
      }
      const priorSlot = slots.get(slotKey);
      if (priorSlot && priorSlot.factId !== fact.id) {
        reject(generation, `stable subject slot has conflicting fact ids ${priorSlot.factId} and ${fact.id}`, priorSlot.generations);
      } else if (!priorSlot) {
        slots.set(slotKey, { factId: fact.id, generations: new Set([generationId]) });
      } else {
        priorSlot.generations.add(generationId);
      }
    }
    for (const value of parseFromPinned(generation, "recall-events.jsonl", errors)) {
      const event = parseRecallEvent(value);
      if (!event?.project_id) continue;
      const priorRemote = remoteKeys.get(event.project_id);
      if (priorRemote && priorRemote.key && event.portable_project_key && priorRemote.key !== event.portable_project_key) {
        reject(
          generation,
          "recall project_id is paired with a conflicting portable_project_key",
          priorRemote.generations,
          "recall-events.jsonl",
        );
      } else if (!priorRemote) {
        remoteKeys.set(event.project_id, {
          key: event.portable_project_key,
          generations: new Set([generationId]),
        });
      } else {
        priorRemote.key ??= event.portable_project_key;
        priorRemote.generations.add(generationId);
      }
      const byId = db.prepare("SELECT project_id, portable_project_key FROM projects WHERE project_id = ?")
        .get(event.project_id) as { project_id: string; portable_project_key: string | null } | undefined;
      const byPortable = event.portable_project_key
        ? db.prepare("SELECT project_id FROM projects WHERE portable_project_key = ?")
            .get(event.portable_project_key) as { project_id: string } | undefined
        : undefined;
      if ((byId?.portable_project_key && event.portable_project_key &&
           byId.portable_project_key !== event.portable_project_key) ||
          (byId && byPortable && byId.project_id !== byPortable.project_id)) {
        reject(
          generation,
          "recall stable identity conflicts with local project mapping",
          new Set(),
          "recall-events.jsonl",
        );
      }
    }
  }
  return rejected;
}

async function importFacts(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): Promise<void> {
  // Per-fact plan: the semantic axis (meaning), the monotone lineage axis
  // (provenance/count), and the lifecycle axis (activation) are judged and
  // applied INDEPENDENTLY (재감사 P1-3 v4). A remote semantic win never
  // rewrites is_active; a remote lifecycle win never rewrites meaning —
  // "새 의미 + 더 최근 deactivate"는 어느 축도 롤백하지 않고 수렴한다.
  type SemanticCandidate =
    | { mode: "insert"; fact: SyncFact }
    | { mode: "replace"; fact: SyncFact; localGeneration: number };
  type FactPlan = {
    semantic?: SemanticCandidate;
    lineage?: { sources: string; count: number };
    lifecycle?: { desiredActive: 0 | 1; eventAt: string };
  };
  const plans = new Map<string, FactPlan>();
  /** 재감사 P1-1(v4): remote↔remote fold는 축을 섞지 않는다. 여러 기기의 같은
   * fact를 semantic 시계만으로 단일 winner로 접으면 lifecycle winner의
   * deactivate/restore가 조용히 버려졌다(예: A가 semantic 최신, B가 lifecycle
   * 최신 → B의 deactivate 소실). 각 축의 winner를 독립 보존하고 lineage만
   * monotone으로 합친다. */
  type RemoteAggregate = {
    semanticWinner: SyncFact;
    lifecycleWinner: SyncFact;
    /** union of every contributing row's source_exchange_ids (sorted JSON). */
    sources: string;
    consolidatedCount: number;
  };
  const remoteById = new Map<string, RemoteAggregate>();
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "facts.jsonl", result.malformedRows)) {
      const parsed = parseSyncFact(value);
      if (!parsed) continue; // strict validation already rejected this generation
      let fact: SyncFact;
      try {
        fact = resolveSyncedFactScope(db, parsed);
      } catch (error) {
        result.malformedRows.push({
          file: path.join(generation.source, "facts.jsonl"),
          line: 0,
          error: `project identity conflict: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const agg = remoteById.get(fact.id);
      if (!agg) {
        remoteById.set(fact.id, {
          semanticWinner: fact,
          lifecycleWinner: fact,
          sources: fact.source_exchange_ids,
          consolidatedCount: fact.consolidated_count,
        });
        continue;
      }
      // Semantic axis: the newest semantic clock picks the meaning; ties fall
      // to the canonical semantic key (>= keeps the previous fold's rule that
      // an equal-key incoming row wins).
      const time = compareTimestamps(fact.semantic_updated_at, agg.semanticWinner.semantic_updated_at);
      if (time > 0 || (time === 0 && semanticConflictKey(fact) >= semanticConflictKey(agg.semanticWinner))) {
        agg.semanticWinner = fact;
      }
      // Lifecycle axis: the newest lifecycle clock picks activation; an exact
      // tie between differing states resolves to INACTIVE (the safe default,
      // deterministically on every device).
      const lifecycle = compareTimestamps(fact.lifecycle_updated_at, agg.lifecycleWinner.lifecycle_updated_at);
      if (lifecycle > 0 || (lifecycle === 0 && fact.is_active < agg.lifecycleWinner.is_active)) {
        agg.lifecycleWinner = fact;
      }
      // Lineage axis: monotone union/max across EVERY contributing row.
      const merged = [
        ...new Set([...parseFactSourceIds(agg.sources), ...parseFactSourceIds(fact.source_exchange_ids)]),
      ].sort();
      agg.sources = JSON.stringify(merged);
      agg.consolidatedCount = Math.max(agg.consolidatedCount, fact.consolidated_count);
    }
  }
  for (const agg of remoteById.values()) {
    const remote = agg.semanticWinner;
    const localTombstone = db.prepare(
      "SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?",
    ).get(remote.id) as { deleted_at: string; reason: string | null } | undefined;
    // Hard delete wins a timestamp tie; only a strictly newer semantic event can
    // restore (재감사 P1-3 — 비의미 메타데이터 touch는 삭제를 이기지 못한다).
    if (localTombstone && compareTimestamps(localTombstone.deleted_at, remote.semantic_updated_at) >= 0) continue;
    // A conversation-exclusion tombstone is terminal privacy state: without an
    // explicit un-exclude/re-consent event no newer fact event may resurrect it.
    if (localTombstone?.reason === PRIVACY_TOMBSTONE_REASON) continue;

    const localRow = db.prepare(`
      SELECT id, fact, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, is_active,
             semantic_generation, semantic_updated_at, lifecycle_generation, lifecycle_updated_at,
             project_id, subject_key, promotion_state
      FROM facts WHERE id = ?
    `).get(remote.id) as Record<string, unknown> | undefined;

    const plan: FactPlan = {};
    if (!localRow) {
      // New fact: the meaning comes from the SEMANTIC winner while the
      // activation state comes from the LIFECYCLE winner — a remote device
      // that deactivated later must not be overridden by a device that edited
      // later (재감사 P1-1 v4).
      plan.semantic = {
        mode: "insert",
        fact: {
          ...remote,
          source_exchange_ids: agg.sources,
          consolidated_count: agg.consolidatedCount,
          is_active: agg.lifecycleWinner.is_active,
          lifecycle_updated_at: agg.lifecycleWinner.lifecycle_updated_at,
        },
      };
      plans.set(remote.id, plan);
      continue;
    }
    const local = localFactView(localRow);

    // --- semantic axis: meaning only ---
    const semanticTime = compareTimestamps(remote.semantic_updated_at, local.semantic_updated_at);
    const localKey = semanticConflictKey(local);
    const remoteKey = semanticConflictKey(remote);
    if (semanticTime > 0 || (semanticTime === 0 && remoteKey > localKey)) {
      plan.semantic = { mode: "replace", fact: remote, localGeneration: local.semantic_generation };
    }
    // Same clock AND same semantic content (tie-identical) is not a conflict —
    // the lineage/lifecycle axes below may still have something to converge.

    // --- lineage axis: monotone union/max, judged against the CURRENT row ---
    const mergedSources = [
      ...new Set([...parseFactSourceIds(local.source_exchange_ids), ...parseFactSourceIds(agg.sources)]),
    ].sort();
    const mergedCount = Math.max(local.consolidated_count, agg.consolidatedCount);
    const sourcesChanged = JSON.stringify(mergedSources) !== JSON.stringify(parseFactSourceIds(local.source_exchange_ids).sort());
    if (sourcesChanged || mergedCount !== local.consolidated_count) {
      plan.lineage = { sources: JSON.stringify(mergedSources), count: mergedCount };
    }

    // --- lifecycle axis (재감사 P1-3 v4): activation only, judged against the
    // LIFECYCLE winner of the remotes — never the semantic winner's row. The
    // newest lifecycle event wins even when the resulting STATE matches the
    // local one (clock convergence); an exact tie resolves to INACTIVE.
    const lifecycleTime = compareTimestamps(agg.lifecycleWinner.lifecycle_updated_at, local.lifecycle_updated_at);
    if (lifecycleTime > 0) {
      plan.lifecycle = {
        desiredActive: agg.lifecycleWinner.is_active,
        eventAt: agg.lifecycleWinner.lifecycle_updated_at,
      };
    } else if (lifecycleTime === 0 && agg.lifecycleWinner.is_active === 0 && local.is_active === 1) {
      plan.lifecycle = {
        desiredActive: 0,
        eventAt: agg.lifecycleWinner.lifecycle_updated_at,
      };
    }

    if (plan.semantic || plan.lineage || plan.lifecycle) plans.set(remote.id, plan);
  }
  if (plans.size === 0) return;

  await initEmbeddings();
  for (const [factId, plan] of plans) {
    try {
      // --- semantic axis: generate before the transaction; failure leaves the
      // whole fact retryable instead of committing a vectorless row ---
      const semantic = plan.semantic;
      if (semantic) {
        const fact = semantic.fact;
        const embedding = await generateEmbedding(fact.fact);
        const commit = db.transaction((): boolean => {
          // 재감사 P1-2: embedding await 동안 tombstone이 생겼으면 이
          // reconcile은 폐기한다 — commit 직전 재검사다.
          const tombstone = db.prepare(
            "SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?",
          ).get(factId) as { deleted_at: string; reason: string | null } | undefined;
          if (tombstone && (tombstone.reason === PRIVACY_TOMBSTONE_REASON ||
              compareTimestamps(tombstone.deleted_at, fact.semantic_updated_at) >= 0)) {
            return false;
          }
          if (semantic.mode === "replace") {
            // Commit-time live lineage (재감사 P1-2 v4): provenance/count
            // merges bump NO generation, so the CAS token alone cannot see a
            // concurrent DUPLICATE consolidation — re-read them inside this
            // transaction and union/max so the merge is absorbed, never lost.
            const current = db.prepare(
              "SELECT source_exchange_ids, consolidated_count, is_active FROM facts WHERE id = ?",
            ).get(factId) as
              | { source_exchange_ids: string | null; consolidated_count: number; is_active: number }
              | undefined;
            if (!current) return false;
            const liveSources = JSON.stringify([
              ...new Set([
                ...parseFactSourceIds(current.source_exchange_ids ?? "[]"),
                ...parseFactSourceIds(fact.source_exchange_ids),
              ]),
            ].sort());
            const liveCount = Math.max(Number(current.consolidated_count), fact.consolidated_count);
            // 재감사 P1-3 v4: the local ACTIVATION state governs vector
            // visibility and the consolidation flag — semantic import never
            // rewrites is_active (that is the lifecycle axis's job).
            const isActive = Number(current.is_active) === 0 ? 0 : 1;
            const claimed = db.prepare(`
              UPDATE facts SET
                fact = ?, category = ?, scope_type = ?, scope_project = ?,
                project_id = ?, subject_key = ?, promotion_state = ?,
                source_exchange_ids = ?, embedding = ?, created_at = ?, updated_at = ?,
                consolidated_count = ?, embedding_version = ?,
                ontology_category_id = NULL, fact_kr = NULL,
                ontology_attempts = 0, consolidation_attempts = 0,
                needs_consolidation = ?, ontology_last_attempt_at = NULL,
                semantic_generation = semantic_generation + 1, semantic_updated_at = ?
              WHERE id = ? AND semantic_generation = ?
            `).run(
              fact.fact, fact.category, fact.scope_type, fact.scope_project,
              fact.project_id, fact.subject_key ?? `legacy.fact.${fact.id}`, fact.promotion_state,
              liveSources, Buffer.from(new Float32Array(embedding).buffer),
              fact.created_at, fact.updated_at, liveCount, EMBEDDING_VERSION,
              isActive, fact.semantic_updated_at,
              factId, semantic.localGeneration,
            );
            if (claimed.changes === 0) return false;
            // Context dependencies are local interpretive lineage for the
            // previous local meaning and are intentionally absent from
            // protocol v4. A remote semantic winner cannot inherit them.
            db.prepare(
              "DELETE FROM fact_context_dependencies WHERE fact_id = ?",
            ).run(factId);
            // The meaning changed — derived state built on the OLD meaning is
            // invalid: relations are re-derived, the KR translation is
            // re-derived by the translation backfill (derived overlay does
            // not travel in the payload).
            db.prepare("DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?")
              .run(factId, factId);
            db.prepare("DELETE FROM fact_tombstones WHERE fact_id = ?").run(factId);
            db.prepare("DELETE FROM vec_facts WHERE id = ?").run(factId);
            db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(factId);
            if (isActive === 1) {
              const primaryDtype = getVecTableDtype(db, "vec_facts");
              db.prepare(
                `INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(primaryDtype)})`,
              ).run(factId, embeddingToVecBlob(embedding, primaryDtype));
            }
          } else {
            if (db.prepare("SELECT 1 FROM facts WHERE id = ?").get(factId)) return false;
            db.prepare(`
              INSERT INTO facts
                (id, fact, category, scope_type, scope_project, source_exchange_ids,
                 embedding, created_at, updated_at, consolidated_count, is_active,
                 embedding_version, needs_consolidation,
                 semantic_generation, semantic_updated_at,
                 lifecycle_generation, lifecycle_updated_at,
                 project_id, subject_key, promotion_state)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?)
            `).run(
              fact.id, fact.fact, fact.category, fact.scope_type, fact.scope_project,
              fact.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer),
              fact.created_at, fact.updated_at, fact.consolidated_count, fact.is_active,
              EMBEDDING_VERSION, fact.is_active,
              fact.semantic_updated_at,
              fact.lifecycle_updated_at,
              fact.project_id,
              fact.subject_key ?? `${fact.scope_type === "global" ? "global" : "legacy"}.fact.${fact.id}`,
              fact.promotion_state,
            );
            // A strictly newer semantic event resurrected over a stale
            // non-privacy tombstone — clear the inert deletion marker.
            db.prepare("DELETE FROM fact_tombstones WHERE fact_id = ?").run(factId);
            if (fact.is_active === 1) {
              const primaryDtype = getVecTableDtype(db, "vec_facts");
              db.prepare(
                `INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(primaryDtype)})`,
              ).run(factId, embeddingToVecBlob(embedding, primaryDtype));
            }
          }
          return true;
        });
        if (!commit()) {
          console.error(
            `sync-import: discarded stale reconciliation for fact ${factId} (local state changed during embedding)`,
          );
        } else if (semantic.mode === "replace") {
          result.updatedFacts++;
        } else {
          result.newFacts++;
        }
      }

      // --- lineage axis: monotone union/max against the LIVE row in one
      // transaction. Serialized writers make read-merge-write race-free; no
      // generation token is involved, so nothing can invalidate the merge. ---
      const lineage = plan.lineage;
      if (lineage) {
        const commit = db.transaction((): boolean => {
          const current = db.prepare(
            "SELECT source_exchange_ids, consolidated_count FROM facts WHERE id = ?",
          ).get(factId) as { source_exchange_ids: string | null; consolidated_count: number } | undefined;
          if (!current) return false;
          const sources = JSON.stringify([
            ...new Set([
              ...parseFactSourceIds(current.source_exchange_ids ?? "[]"),
              ...parseFactSourceIds(lineage.sources),
            ]),
          ].sort());
          const count = Math.max(Number(current.consolidated_count), lineage.count);
          if (sources === JSON.stringify(parseFactSourceIds(current.source_exchange_ids ?? "[]").sort()) &&
              count === Number(current.consolidated_count)) return false;
          db.prepare(
            "UPDATE facts SET source_exchange_ids = ?, consolidated_count = ?, updated_at = ? WHERE id = ?",
          ).run(sources, count, new Date().toISOString(), factId);
          result.updatedFacts++;
          return true;
        });
        commit();
      }

      // --- lifecycle axis ---
      // 재감사 P1-2/P1-3 v4: the plan carries the remote EVENT time; the
      // commit re-judges the LWW against the live row inside its transaction.
      // Replication preserves the original event clock (never local now), a
      // same-state newer event converges the clock, and a lifecycle event
      // that landed locally during the semantic embedding await cannot be
      // overwritten by this stale plan.
      if (plan.lifecycle) {
        try {
          const outcome = await applyReplicatedLifecycle(
            db,
            factId,
            plan.lifecycle.desiredActive,
            plan.lifecycle.eventAt,
          );
          if (outcome === "applied") result.updatedFacts++;
        } catch (error) {
          console.error(
            `sync-import: failed to reconcile lifecycle for fact ${factId}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (error) {
      console.error(
        `sync-import: failed to reconcile fact ${factId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

function importRevisions(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): void {
  for (const generation of generations) {
    let lineNo = 0;
    for (const value of parseFromPinned(generation, "fact-revisions.jsonl", result.malformedRows)) {
      lineNo++;
      const revision = parseRevision(value);
      if (!revision) continue;
      if (db.prepare("SELECT 1 FROM chronicle_tombstones WHERE event_id = ?").get(revision.id)) continue;
      if (revision.fact_id && !db.prepare("SELECT 1 FROM facts WHERE id = ?").get(revision.fact_id)) continue;
      if (!revision.chronicle) {
        // Released peer row: a CHANGED transition whose reason is model text.
        if (db.prepare("SELECT 1 FROM fact_revisions WHERE id = ?").get(revision.id)) continue;
        const fact = db.prepare("SELECT project_id, subject_key FROM facts WHERE id = ?")
          .get(revision.fact_id as string) as { project_id: string | null; subject_key: string | null } | undefined;
        const status = insertReplicatedChronicleEvent(db, {
          id: revision.id,
          project_id: fact?.project_id ?? null,
          subject_key: fact?.subject_key ?? null,
          fact_id: revision.fact_id,
          event_kind: "CHANGED",
          previous_value: revision.previous_fact,
          new_value: revision.new_fact,
          problem: null,
          grounded_cause: null,
          rationale: null,
          classifier_note: revision.reason,
          outcome: null,
          source_exchange_ids: revision.source_exchange_id ? [revision.source_exchange_id] : [],
          source_evidence_ids: [],
          reverts_event_id: null,
          related_event_ids: [],
          actor: "legacy",
          policy_version: "legacy-revision-v0",
          evidence_authority: "unknown",
          effective_at: revision.created_at,
          effective_at_source: "peer",
          recorded_at: revision.created_at,
          projection_applied: true,
          created_at: revision.created_at,
        });
        if (status === "inserted") result.newRevisions++;
        continue;
      }
      const event = revision.chronicle;
      // Map the stable project through the portable key exactly like facts.
      let localProjectId: string | null = null;
      if (event.project_id) {
        const byId = db.prepare("SELECT project_id, portable_project_key FROM projects WHERE project_id = ?")
          .get(event.project_id) as { project_id: string; portable_project_key: string | null } | undefined;
        const byPortable = event.portable_project_key
          ? db.prepare("SELECT project_id FROM projects WHERE portable_project_key = ?")
              .get(event.portable_project_key) as { project_id: string } | undefined
          : undefined;
        if ((byId?.portable_project_key && event.portable_project_key && byId.portable_project_key !== event.portable_project_key) ||
            (byId && byPortable && byId.project_id !== byPortable.project_id)) {
          result.malformedRows.push({
            file: path.join(generation.source, "fact-revisions.jsonl"), line: lineNo,
            error: `chronicle event ${revision.id} stable project identity conflicts with local mapping`,
          });
          continue;
        }
        localProjectId = byPortable?.project_id ?? byId?.project_id ?? null;
        if (!localProjectId) {
          if (revision.fact_id) {
            localProjectId = (db.prepare("SELECT project_id FROM facts WHERE id = ?").get(revision.fact_id) as { project_id: string | null } | undefined)?.project_id ?? null;
          }
          if (!localProjectId) continue; // event-only row for a project this device has never seen
        }
      } else if (revision.fact_id) {
        localProjectId = (db.prepare("SELECT project_id FROM facts WHERE id = ?").get(revision.fact_id) as { project_id: string | null } | undefined)?.project_id ?? null;
      }
      const status = insertReplicatedChronicleEvent(db, {
        id: revision.id,
        project_id: localProjectId,
        subject_key: event.subject_key,
        fact_id: revision.fact_id,
        event_kind: event.event_kind,
        previous_value: revision.previous_fact,
        new_value: revision.new_fact,
        problem: event.problem,
        grounded_cause: event.grounded_cause,
        rationale: event.rationale,
        classifier_note: event.classifier_note,
        outcome: event.outcome,
        source_exchange_ids: event.source_exchange_ids,
        source_evidence_ids: event.source_evidence_ids,
        reverts_event_id: event.reverts_event_id,
        related_event_ids: event.related_event_ids,
        actor: event.actor,
        policy_version: event.policy_version,
        evidence_authority: event.evidence_authority,
        effective_at: event.effective_at,
        effective_at_source: "peer",
        recorded_at: event.recorded_at,
        projection_applied: event.projection_applied,
        created_at: revision.created_at,
      });
      if (status === "inserted") result.newRevisions++;
      else if (status === "conflict") {
        // Same event id with different content: never overwrite silently.
        result.malformedRows.push({
          file: path.join(generation.source, "fact-revisions.jsonl"), line: lineNo,
          error: `chronicle event ${revision.id} conflicts with the local event of the same id; local history preserved`,
        });
      }
    }
  }
}

function importRecallEvents(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): void {
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "recall-events.jsonl", result.malformedRows)) {
      const event = parseRecallEvent(value);
      if (!event) continue;
      const existing = db.prepare("SELECT status FROM recall_events WHERE id = ?").get(event.id) as
        | { status: "prepared" | "emitted" }
        | undefined;
      if (!existing) {
        let localProjectId = event.project_id;
        let localProject = event.project;
        if (localProjectId) {
          const byPortable = event.portable_project_key
            ? db.prepare("SELECT project_id FROM projects WHERE portable_project_key = ?")
                .get(event.portable_project_key) as { project_id: string } | undefined
            : undefined;
          const byId = db.prepare("SELECT project_id, portable_project_key FROM projects WHERE project_id = ?")
            .get(localProjectId) as { project_id: string; portable_project_key: string | null } | undefined;
          if (byId && byPortable && byId.project_id !== byPortable.project_id) {
            throw new Error("recall stable project id and portable key resolve to different local projects");
          }
          if (byId?.portable_project_key && event.portable_project_key &&
              byId.portable_project_key !== event.portable_project_key) {
            throw new Error("recall stable project id conflicts with local portable key");
          }
          localProjectId = byPortable?.project_id ?? byId?.project_id ?? localProjectId;
          if (!byId && !byPortable) {
            db.prepare(`
              INSERT INTO projects(project_id, portable_project_key, display_name, memory_revision, created_at, updated_at)
              VALUES (?, ?, ?, 0, ?, ?)
            `).run(localProjectId, event.portable_project_key, localProjectId, event.created_at, event.created_at);
          }
          localProject = (db.prepare(`
            SELECT canonical_path FROM workspaces WHERE project_id = ?
            ORDER BY last_seen_at DESC, workspace_id LIMIT 1
          `).get(localProjectId) as { canonical_path: string } | undefined)?.canonical_path ?? `project:${localProjectId}`;
        } else if (localProject) {
          const identity = resolveProjectWorkspace(db, { cwd: localProject });
          localProjectId = identity.projectId;
          localProject = identity.canonicalPath;
        }
        db.prepare(`
          INSERT INTO recall_events
            (id, session_id, project, prompt_hash, fact_ids, source_type, learnable,
             status, project_id, context_epoch, project_memory_revision, created_at, emitted_at)
          VALUES (?, ?, ?, ?, ?, 'memex_recall', 0, ?, ?, ?, ?, ?, ?)
        `).run(
          event.id, event.session_id, localProject as string, event.prompt_hash, event.fact_ids,
          event.status, localProjectId, event.context_epoch, event.project_memory_revision,
          event.created_at, event.emitted_at,
        );
        result.newRecallEvents++;
      } else if (existing.status === "prepared" && event.status === "emitted") {
        db.prepare("UPDATE recall_events SET status = 'emitted', emitted_at = ? WHERE id = ?")
          .run(event.emitted_at ?? event.created_at, event.id);
        result.updatedRecallEvents++;
      }
      // A prepared receipt proves durable intent, not stdout emission. Only an
      // emitted receipt can mark an exchange as recalled; this matches
      // insertExchange while preserving order independence across sync/rebuild.
      const stored = db.prepare("SELECT status FROM recall_events WHERE id = ?")
        .get(event.id) as { status: "prepared" | "emitted" } | undefined;
      if (stored?.status !== "emitted") continue;
      const exchanges = db.prepare(
        "SELECT id, user_message, provenance FROM exchanges WHERE session_id = ?",
      ).all(event.session_id) as Array<{ id: string; user_message: string; provenance: string }>;
      for (const exchange of exchanges) {
        if (hashRecallPrompt(exchange.user_message) !== event.prompt_hash) continue;
        let provenance: string[] = [];
        try {
          const parsed: unknown = JSON.parse(exchange.provenance);
          if (Array.isArray(parsed)) {
            provenance = parsed.filter((item): item is string => typeof item === "string");
          }
        } catch {
          // Invalid local provenance is replaced by the minimum safe marker.
        }
        db.prepare(`
          UPDATE exchanges
          SET provenance = ?, assistant_learnable = 0, has_memex_recall = 1
          WHERE id = ?
        `).run(JSON.stringify([...new Set([...provenance, "memex_recall"])]), exchange.id);
      }
    }
  }
}

function generationKey(generation: PinnedGeneration): string {
  return `${generation.deviceId}/${generation.generationId}`;
}

/**
 * v4 rows are validated STRICTLY before any import (protocol v4 + no legacy
 * peers): a schema-invalid row is payload corruption — the exporter is the
 * payload's only writer, and a fact row missing its semantic or lifecycle
 * clock is exactly the ambiguity sync exists to eliminate. The row's whole
 * generation is rejected (fail-closed, matching the manifest contract)
 * instead of silently dropping the row and importing its survivors.
 */
const ROW_VALIDATORS: Array<{ file: string; validate: (value: unknown) => boolean }> = [
  { file: "facts.jsonl", validate: (value) => parseSyncFact(value) !== null },
  { file: "fact-revisions.jsonl", validate: (value) => parseRevision(value) !== null },
  { file: "fact-tombstones.jsonl", validate: (value) => parseAnyTombstone(value) },
  { file: "recall-events.jsonl", validate: (value) => parseRecallEvent(value) !== null },
];

function rejectInvalidRows(
  generations: PinnedGeneration[],
  issues: PayloadIssue[],
): Set<string> {
  const rejected = new Set<string>();
  for (const generation of generations) {
    for (const { file, validate } of ROW_VALIDATORS) {
      const content = generation.files.get(file);
      if (content === undefined) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue; // already rejected by the integrity pass
        }
        if (!validate(value)) {
          rejected.add(generationKey(generation));
          issues.push({
            file: path.join(generation.source, file),
            line: i + 1,
            error: `row failed protocol v4 schema validation, generation ${generation.generationId} rejected — a schema-invalid payload row is corruption, not legacy input`,
          });
          break;
        }
      }
      if (rejected.has(generationKey(generation))) break;
    }
  }
  return rejected;
}

/**
 * Reconcile protocol-v4 sync files into the local DB.
 *
 * Input contract (재감사 P1-1/P1-4): only committed device generations are
 * read, each pinned fully into memory before any DB mutation. The former root
 * JSONL mirror is no longer an input — mixing the exporter's per-file
 * non-atomic mirror with set-atomic generations re-opened the mixed-snapshot
 * hole the generations exist to close.
 *
 * v4 row schema is validated STRICTLY before any import: a schema-invalid row
 * is payload corruption (the exporter is the payload's only writer and this
 * repository has no legacy peers), so its whole generation is rejected —
 * nothing from it imports and the damage is reported.
 *
 * Conflict order, per independent axis: the SEMANTIC axis judges meaning by
 * the semantic event clock (semantic_updated_at) with a deterministic
 * canonical fact key on exact ties; the LIFECYCLE axis judges activation by
 * lifecycle_updated_at where an exact tie resolves to inactive (재감사
 * P1-3 v4); lineage metadata (source_exchange_ids union, consolidated_count
 * max) converges monotonically regardless of either clock. Hard-delete
 * tombstones win exact-time ties. Source-created timestamps remain historical
 * data and are never used as local processing cursors.
 */
export async function importFromSync(): Promise<SyncImportResult> {
  const result: SyncImportResult = {
    newFacts: 0,
    updatedFacts: 0,
    deletedFacts: 0,
    newRevisions: 0,
    newTombstones: 0,
    newRecallEvents: 0,
    updatedRecallEvents: 0,
    malformedRows: [],
  };
  const syncDir = getSyncDir();
  const pinned = collectCommittedGenerations(syncDir, result.malformedRows);
  if (pinned.length === 0) return result;
  const rejected = rejectInvalidRows(pinned, result.malformedRows);
  let generations = rejected.size === 0
    ? pinned
    : pinned.filter((generation) => !rejected.has(generationKey(generation)));
  if (generations.length === 0) return result;

  const db = initDatabase();
  try {
    const identityRejected = rejectStableIdentityConflicts(db, generations, result.malformedRows);
    if (identityRejected.size > 0) {
      generations = generations.filter((generation) => !identityRejected.has(generationKey(generation)));
    }
    if (generations.length === 0) return result;
    importTombstones(db, generations, result);
    await importFacts(db, generations, result);
    importRevisions(db, generations, result);
    importRecallEvents(db, generations, result);
    return result;
  } finally {
    db.close();
  }
}
