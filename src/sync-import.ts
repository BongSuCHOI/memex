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

interface SyncFact {
  id: string;
  fact: string;
  fact_kr: string | null;
  category: string;
  scope_type: "project" | "global";
  scope_project: string | null;
  source_exchange_ids: string;
  created_at: string;
  updated_at: string;
  /**
   * 재감사 P1-3: 의미 사건의 시각 — 충돌 판정의 기준 시계다. v3 이전 payload에는
   * 필드가 없으므로 updated_at으로 폴백한다(구버전 peer와의 transition 동작).
   */
  semantic_updated_at: string;
  consolidated_count: number;
  is_active: 0 | 1;
  ontology_category_id: string | null;
}

interface SyncTombstone {
  fact_id: string;
  deleted_at: string;
  reason: string | null;
}

interface SyncRevision {
  id: string;
  fact_id: string;
  previous_fact: string;
  new_fact: string;
  reason: string | null;
  source_exchange_id: string | null;
  created_at: string;
}

interface SyncRecallEvent {
  id: string;
  session_id: string;
  project: string;
  prompt_hash: string;
  fact_ids: string;
  status: "prepared" | "emitted";
  created_at: string;
  emitted_at: string | null;
}

export interface SyncImportResult {
  newFacts: number;
  updatedFacts: number;
  deletedFacts: number;
  newRevisions: number;
  newTombstones: number;
  newRecallEvents: number;
  updatedRecallEvents: number;
  newDomains: number;
  newCategories: number;
  newRelations: number;
  /** P2-7: rows (or manifests) that could not be parsed, with their source
   * location. Valid rows still import; the damage is never silent. */
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
const ALLOWED_RELATION_TYPES = new Set([
  "SUPPORTS",
  "INFLUENCES",
  "SUPERSEDES",
  "CONTRADICTS",
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
  if (manifest.protocol_version !== 3) {
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
      if (!fs.existsSync(filePath)) {
        issues.push({
          file: currentPath,
          line: 0,
          error: `CURRENT names generation ${generation} missing ${name}, device ${entry.name} snapshot rejected`,
        });
        complete = false;
        break;
      }
      files.set(name, fs.readFileSync(filePath, "utf8"));
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

function compareTimestamps(a: string, b: string): number {
  return Math.sign(Date.parse(a) - Date.parse(b));
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
    !Number.isInteger(value.consolidated_count) || Number(value.consolidated_count) < 0 ||
    (value.is_active !== undefined && value.is_active !== 0 && value.is_active !== 1) ||
    (value.fact_kr !== undefined && value.fact_kr !== null && typeof value.fact_kr !== "string") ||
    (value.ontology_category_id !== undefined && value.ontology_category_id !== null &&
      typeof value.ontology_category_id !== "string") ||
    // semantic_updated_at은 선택 필드다(v2 payload엔 없다). 있으면 반드시 유효해야 한다.
    (value.semantic_updated_at !== undefined && !isTimestamp(value.semantic_updated_at))
  ) return null;
  const scopeProject = canonicalScopeProject(value.scope_type, value.scope_project);
  if (scopeProject === undefined) return null;
  return {
    id: value.id,
    fact: value.fact,
    fact_kr: typeof value.fact_kr === "string" ? value.fact_kr : null,
    category: value.category,
    scope_type: value.scope_type,
    scope_project: scopeProject,
    source_exchange_ids: value.source_exchange_ids,
    created_at: value.created_at,
    updated_at: value.updated_at,
    // 의미 시계: payload가 주면 그것, 없으면(updated_at이 오염된 구버전 payload)
    // 최선의 근사로 updated_at을 쓴다 — 구버전 peer와의 동작은 이전과 같다.
    semantic_updated_at: isTimestamp(value.semantic_updated_at)
      ? value.semantic_updated_at
      : value.updated_at,
    consolidated_count: Number(value.consolidated_count),
    // Protocol v1 payloads omitted is_active because they exported active rows only.
    is_active: value.is_active === 0 ? 0 : 1,
    ontology_category_id: typeof value.ontology_category_id === "string"
      ? value.ontology_category_id
      : null,
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

function parseRevision(value: unknown): SyncRevision | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
      typeof value.fact_id !== "string" || !value.fact_id ||
      typeof value.previous_fact !== "string" || typeof value.new_fact !== "string" ||
      !isTimestamp(value.created_at) ||
      (value.reason !== undefined && value.reason !== null && typeof value.reason !== "string") ||
      (value.source_exchange_id !== undefined && value.source_exchange_id !== null &&
        typeof value.source_exchange_id !== "string")) {
    return null;
  }
  return {
    id: value.id,
    fact_id: value.fact_id,
    previous_fact: value.previous_fact,
    new_fact: value.new_fact,
    reason: typeof value.reason === "string" ? value.reason : null,
    source_exchange_id: typeof value.source_exchange_id === "string" ? value.source_exchange_id : null,
    created_at: value.created_at,
  };
}

function parseRecallEvent(value: unknown): SyncRecallEvent | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
      typeof value.session_id !== "string" || !value.session_id ||
      typeof value.project !== "string" || !value.project ||
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
    project: value.project,
    prompt_hash: value.prompt_hash,
    fact_ids: value.fact_ids,
    status: value.status,
    created_at: value.created_at,
    emitted_at: typeof value.emitted_at === "string" ? value.emitted_at : null,
  };
}

/** Semantic identity of a fact row — the ONLY fields that may decide a
 * winner. Provenance (`source_exchange_ids`), `consolidated_count`,
 * `fact_kr` and `ontology_category_id` are metadata/derived state: letting
 * them decide a tie let a device with POORER provenance lexically beat a
 * device whose DUPLICATE consolidation had unioned evidence in — and losing
 * provenance breaks the privacy purge's fact lookup (재감사 P1-1 보강).
 * Inactive state wins exact-time ties; remaining fields use canonical JSON
 * lexical order so every device independently selects the same winner. */
function semanticConflictKey(fact: SyncFact): string {
  return JSON.stringify([
    fact.is_active === 0 ? 1 : 0,
    fact.fact,
    fact.category,
    fact.scope_type,
    fact.scope_project,
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

/** Monotone metadata convergence across devices: provenance is a SORTED
 * union and consolidated_count a max — neither can ever regress, and neither
 * is a semantic event (no generation bump, no relation invalidation, no
 * vector regeneration). fact_kr/ontology adopt whichever side carries one
 * (both derived/overlay state). `winner`'s derived fields are preferred. */
function mergeFactMetadata(winner: SyncFact, other: SyncFact): SyncFact {
  const sources = [
    ...new Set([...parseFactSourceIds(winner.source_exchange_ids), ...parseFactSourceIds(other.source_exchange_ids)]),
  ].sort();
  return {
    ...winner,
    source_exchange_ids: JSON.stringify(sources),
    consolidated_count: Math.max(winner.consolidated_count, other.consolidated_count),
    fact_kr: winner.fact_kr ?? other.fact_kr,
    ontology_category_id: winner.ontology_category_id ?? other.ontology_category_id,
  };
}

/** DB 행의 의미 시계 — legacy/빈 값은 updated_at으로 폴백한다. */
function localSemanticClock(row: Record<string, unknown>): string {
  const value = row.semantic_updated_at;
  return typeof value === "string" && value !== "" && isTimestamp(value)
    ? value
    : (row.updated_at as string);
}

function rowToSyncFact(row: Record<string, unknown>): SyncFact {
  return {
    id: row.id as string,
    fact: row.fact as string,
    fact_kr: (row.fact_kr as string | null) ?? null,
    category: row.category as string,
    scope_type: row.scope_type as "project" | "global",
    scope_project: (row.scope_project as string | null) ?? null,
    source_exchange_ids: (row.source_exchange_ids as string | null) ?? "[]",
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    semantic_updated_at: localSemanticClock(row),
    consolidated_count: Number(row.consolidated_count),
    is_active: Number(row.is_active) === 0 ? 0 : 1,
    ontology_category_id: (row.ontology_category_id as string | null) ?? null,
  };
}

function deleteFactState(db: Database.Database, factId: string): void {
  db.prepare("DELETE FROM vec_facts WHERE id = ?").run(factId);
  db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(factId);
  db.prepare("DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?")
    .run(factId, factId);
  db.prepare("DELETE FROM fact_revisions WHERE fact_id = ?").run(factId);
  db.prepare("DELETE FROM facts WHERE id = ?").run(factId);
}

function importOntology(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): void {
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "ontology-domains.jsonl", result.malformedRows)) {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
          typeof value.name !== "string" || !value.name) continue;
      if (db.prepare("SELECT 1 FROM ontology_domains WHERE id = ?").get(value.id)) continue;
      db.prepare(
        "INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        value.id,
        value.name,
        typeof value.description === "string" ? value.description : null,
        isTimestamp(value.created_at) ? value.created_at : new Date().toISOString(),
      );
      result.newDomains++;
    }
  }

  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "ontology-categories.jsonl", result.malformedRows)) {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
          typeof value.domain_id !== "string" || !value.domain_id ||
          typeof value.name !== "string" || !value.name) continue;
      if (!db.prepare("SELECT 1 FROM ontology_domains WHERE id = ?").get(value.domain_id)) continue;
      if (db.prepare("SELECT 1 FROM ontology_categories WHERE id = ?").get(value.id)) continue;
      db.prepare(
        "INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        value.id,
        value.domain_id,
        value.name,
        typeof value.description === "string" ? value.description : null,
        isTimestamp(value.created_at) ? value.created_at : new Date().toISOString(),
      );
      result.newCategories++;
    }
  }
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
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "fact-tombstones.jsonl", result.malformedRows)) {
      const row = parseTombstone(value);
      if (!row) continue;
      const previous = byFact.get(row.fact_id);
      byFact.set(row.fact_id, previous ? mergeTombstones(previous, row) : row);
    }
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

async function importFacts(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): Promise<void> {
  type Candidate =
    | { mode: "semantic"; fact: SyncFact; exists: boolean; localGeneration?: number }
    | {
        mode: "metadata";
        id: string;
        localGeneration: number;
        sources: string;
        count: number;
        factKr: string | null;
        ontologyCategoryId: string | null;
      };
  const candidates: Candidate[] = [];
  const remoteById = new Map<string, SyncFact>();
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "facts.jsonl", result.malformedRows)) {
      const fact = parseSyncFact(value);
      if (!fact) continue;
      // Fold remote rows per fact id: the SEMANTIC winner is picked by the
      // semantic clock (ties by the semantic key), while metadata converges
      // monotonically across every contributing generation.
      const previous = remoteById.get(fact.id);
      if (!previous) {
        remoteById.set(fact.id, fact);
        continue;
      }
      const time = compareTimestamps(fact.semantic_updated_at, previous.semantic_updated_at);
      if (time > 0 || (time === 0 && semanticConflictKey(fact) >= semanticConflictKey(previous))) {
        remoteById.set(fact.id, mergeFactMetadata(fact, previous));
      } else {
        remoteById.set(fact.id, mergeFactMetadata(previous, fact));
      }
    }
  }
  for (const remote of remoteById.values()) {
    // 재감사 P1-7: ontology는 fact 위에 얹는 파생 overlay다 — 원격 category가
    // 로컬에 없어도 의미 자체를 버리면 안 된다. NULL로 import해 재분류 대기
    // 상태로 두고, 분류 백필이 overlay를 다시 채운다.
    let fact = remote;
    if (
      fact.ontology_category_id &&
      !db.prepare("SELECT 1 FROM ontology_categories WHERE id = ?").get(fact.ontology_category_id)
    ) {
      fact = { ...fact, ontology_category_id: null };
    }
    const localTombstone = db.prepare(
      "SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?",
    ).get(fact.id) as { deleted_at: string; reason: string | null } | undefined;
    // Hard delete wins a timestamp tie; only a strictly newer semantic event can
    // restore (재감사 P1-3 — 비의미 메타데이터 touch는 삭제를 이기지 못한다).
    if (localTombstone && compareTimestamps(localTombstone.deleted_at, fact.semantic_updated_at) >= 0) continue;
    // A conversation-exclusion tombstone is terminal privacy state: without an
    // explicit un-exclude/re-consent event no newer fact event may resurrect it.
    if (localTombstone?.reason === PRIVACY_TOMBSTONE_REASON) continue;

    const localRow = db.prepare(`
      SELECT id, fact, fact_kr, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, is_active, ontology_category_id,
             semantic_generation, semantic_updated_at
      FROM facts WHERE id = ?
    `).get(fact.id) as Record<string, unknown> | undefined;
    if (!localRow) {
      candidates.push({ mode: "semantic", fact, exists: false });
      continue;
    }
    const local = rowToSyncFact(localRow);
    const localGeneration = Number(localRow.semantic_generation ?? 1);
    // Monotone metadata convergence applies to EVERY outcome — even a locally
    // newer semantic state must absorb the peer's provenance, and provenance
    // must never regress to a peer with fewer sources.
    const mergedSources = [
      ...new Set([...parseFactSourceIds(local.source_exchange_ids), ...parseFactSourceIds(fact.source_exchange_ids)]),
    ].sort();
    const mergedCount = Math.max(local.consolidated_count, fact.consolidated_count);
    const sourcesChanged = JSON.stringify(mergedSources) !== JSON.stringify(parseFactSourceIds(local.source_exchange_ids).sort());
    const countChanged = mergedCount !== local.consolidated_count;

    const time = compareTimestamps(fact.semantic_updated_at, local.semantic_updated_at);
    const localKey = semanticConflictKey(local);
    const remoteKey = semanticConflictKey(fact);
    const semanticWinner =
      time > 0 ? "remote"
      : time < 0 ? "local"
      : remoteKey === localKey ? "tie-identical"
      : remoteKey > localKey ? "remote"
      : "local";

    if (semanticWinner === "remote") {
      // Strict semantic replacement — the remote meaning is the truth, and
      // the merged (never-regressing) metadata rides along with it.
      candidates.push({
        mode: "semantic",
        fact: { ...fact, source_exchange_ids: JSON.stringify(mergedSources), consolidated_count: mergedCount },
        exists: true,
        localGeneration,
      });
      continue;
    }
    if (semanticWinner === "tie-identical") {
      // Same semantic clock AND same semantic content: this is NOT a conflict.
      // Full-row replacement here would let metadata decide a winner and
      // could regress provenance — only converge metadata, and do it without
      // a semantic event (no generation bump, no relation invalidation, no
      // ontology reset, no vector regeneration).
      const factKr = local.fact_kr ?? fact.fact_kr;
      const ontologyCategoryId = local.ontology_category_id ?? fact.ontology_category_id;
      const krChanged = (factKr ?? null) !== (local.fact_kr ?? null);
      const ontologyChanged = (ontologyCategoryId ?? null) !== (local.ontology_category_id ?? null);
      if (!sourcesChanged && !countChanged && !krChanged && !ontologyChanged) continue;
      candidates.push({
        mode: "metadata",
        id: fact.id,
        localGeneration,
        sources: JSON.stringify(mergedSources),
        count: mergedCount,
        factKr,
        ontologyCategoryId,
      });
      continue;
    }
    // Local is the semantic winner: its meaning/derived state stand, but the
    // peer's provenance still converges in monotonically.
    if (!sourcesChanged && !countChanged) continue;
    candidates.push({
      mode: "metadata",
      id: fact.id,
      localGeneration,
      sources: JSON.stringify(mergedSources),
      count: mergedCount,
      factKr: local.fact_kr,
      ontologyCategoryId: local.ontology_category_id,
    });
  }
  if (candidates.length === 0) return;

  await initEmbeddings();
  for (const candidate of candidates) {
    if (candidate.mode === "metadata") {
      // Metadata-only convergence: no await, but still CAS on the semantic
      // generation — candidates queue behind OTHER candidates' embedding
      // awaits, and a concurrent semantic edit must not be metadata-clobbered.
      const commit = db.transaction((): boolean => {
        const claimed = db.prepare(`
          UPDATE facts SET
            source_exchange_ids = ?, consolidated_count = ?,
            fact_kr = COALESCE(fact_kr, ?),
            ontology_category_id = COALESCE(ontology_category_id, ?),
            updated_at = ?
          WHERE id = ? AND semantic_generation = ?
        `).run(
          candidate.sources, candidate.count,
          candidate.factKr, candidate.ontologyCategoryId,
          new Date().toISOString(), candidate.id, candidate.localGeneration,
        );
        return claimed.changes > 0;
      });
      if (commit()) {
        result.updatedFacts++;
      } else {
        console.error(
          `sync-import: discarded stale metadata convergence for fact ${candidate.id} (local state changed)`,
        );
      }
      continue;
    }
    const { fact } = candidate;
    try {
      // Generate before the transaction. Failure leaves the whole fact
      // retryable instead of committing a permanently vectorless row.
      const embedding = await generateEmbedding(fact.fact);
      const embeddingKr = fact.fact_kr ? await generateEmbedding(fact.fact_kr) : null;
      const commit = db.transaction((): boolean => {
        // 재감사 P1-2: embedding await 동안 로컬 상태가 변했으면 이 reconcile은
        // 폐기한다 — 동시 사용자 편집이 remote stale state로 덮이는 것을 막는
        // commit 직전 CAS다(T06의 절반; 충돌 시계는 이제 semantic clock이다).
        const tombstone = db.prepare(
          "SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?",
        ).get(fact.id) as { deleted_at: string; reason: string | null } | undefined;
        if (tombstone && (tombstone.reason === PRIVACY_TOMBSTONE_REASON ||
            compareTimestamps(tombstone.deleted_at, fact.semantic_updated_at) >= 0)) {
          return false;
        }
        if (candidate.exists) {
          const claimed = db.prepare(`
            UPDATE facts SET
              fact = ?, fact_kr = ?, category = ?, scope_type = ?, scope_project = ?,
              source_exchange_ids = ?, embedding = ?, created_at = ?, updated_at = ?,
              consolidated_count = ?, is_active = ?, ontology_category_id = ?,
              embedding_version = ?, ontology_attempts = 0, consolidation_attempts = 0,
              needs_consolidation = ?, ontology_last_attempt_at = NULL,
              semantic_generation = semantic_generation + 1, semantic_updated_at = ?
            WHERE id = ? AND semantic_generation = ?
          `).run(
            fact.fact, fact.fact_kr, fact.category, fact.scope_type, fact.scope_project,
            fact.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer),
            fact.created_at, fact.updated_at, fact.consolidated_count, fact.is_active,
            fact.ontology_category_id, EMBEDDING_VERSION, fact.is_active,
            fact.semantic_updated_at,
            fact.id, candidate.localGeneration,
          );
          if (claimed.changes === 0) return false;
        } else {
          if (db.prepare("SELECT 1 FROM facts WHERE id = ?").get(fact.id)) return false;
          db.prepare(`
            INSERT INTO facts
              (id, fact, fact_kr, category, scope_type, scope_project, source_exchange_ids,
               embedding, created_at, updated_at, consolidated_count, is_active,
               ontology_category_id, embedding_version, needs_consolidation,
               semantic_generation, semantic_updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          `).run(
            fact.id, fact.fact, fact.fact_kr, fact.category, fact.scope_type, fact.scope_project,
            fact.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer),
            fact.created_at, fact.updated_at, fact.consolidated_count, fact.is_active,
            fact.ontology_category_id, EMBEDDING_VERSION, fact.is_active,
            fact.semantic_updated_at,
          );
        }

        db.prepare("DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?")
          .run(fact.id, fact.id);
        db.prepare("DELETE FROM fact_tombstones WHERE fact_id = ?").run(fact.id);

        db.prepare("DELETE FROM vec_facts WHERE id = ?").run(fact.id);
        db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(fact.id);
        if (fact.is_active === 1) {
          const primaryDtype = getVecTableDtype(db, "vec_facts");
          db.prepare(
            `INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(primaryDtype)})`,
          ).run(fact.id, embeddingToVecBlob(embedding, primaryDtype));
          if (fact.fact_kr && embeddingKr) {
            const koreanDtype = getVecTableDtype(db, "vec_facts_kr");
            db.prepare(
              `INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${vecParamSql(koreanDtype)})`,
            ).run(fact.id, embeddingToVecBlob(embeddingKr, koreanDtype));
          }
        }
        return true;
      });
      if (!commit()) {
        console.error(
          `sync-import: discarded stale reconciliation for fact ${fact.id} (local state changed during embedding)`,
        );
        continue;
      }
      if (candidate.exists) result.updatedFacts++;
      else result.newFacts++;
    } catch (error) {
      console.error(
        `sync-import: failed to reconcile fact ${fact.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

function importRevisions(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): void {
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "fact-revisions.jsonl", result.malformedRows)) {
      const revision = parseRevision(value);
      if (!revision || !db.prepare("SELECT 1 FROM facts WHERE id = ?").get(revision.fact_id) ||
          db.prepare("SELECT 1 FROM fact_revisions WHERE id = ?").get(revision.id)) continue;
      db.prepare(`
        INSERT INTO fact_revisions
          (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        revision.id, revision.fact_id, revision.previous_fact, revision.new_fact,
        revision.reason, revision.source_exchange_id, revision.created_at,
      );
      result.newRevisions++;
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
        db.prepare(`
          INSERT INTO recall_events
            (id, session_id, project, prompt_hash, fact_ids, source_type, learnable,
             status, created_at, emitted_at)
          VALUES (?, ?, ?, ?, ?, 'memex_recall', 0, ?, ?, ?)
        `).run(
          event.id, event.session_id, event.project, event.prompt_hash, event.fact_ids,
          event.status, event.created_at, event.emitted_at,
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

function importRelations(db: Database.Database, generations: PinnedGeneration[], result: SyncImportResult): void {
  for (const generation of generations) {
    for (const value of parseFromPinned(generation, "ontology-relations.jsonl", result.malformedRows)) {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
          typeof value.source_fact_id !== "string" || !value.source_fact_id ||
          typeof value.target_fact_id !== "string" || !value.target_fact_id ||
          typeof value.relation_type !== "string" || !ALLOWED_RELATION_TYPES.has(value.relation_type)) {
        continue;
      }
      const source = db.prepare(
        "SELECT scope_type, scope_project, updated_at, COALESCE(NULLIF(semantic_updated_at, ''), updated_at) AS semantic_clock FROM facts WHERE id = ?",
      ).get(value.source_fact_id) as
        | { scope_type: string; scope_project: string | null; updated_at: string; semantic_clock: string }
        | undefined;
      const target = db.prepare(
        "SELECT scope_type, scope_project, updated_at, COALESCE(NULLIF(semantic_updated_at, ''), updated_at) AS semantic_clock FROM facts WHERE id = ?",
      ).get(value.target_fact_id) as
        | { scope_type: string; scope_project: string | null; updated_at: string; semantic_clock: string }
        | undefined;
      if (!source || !target ||
          (source.scope_type === "project" && target.scope_type === "project" &&
           source.scope_project !== target.scope_project) ||
          db.prepare("SELECT 1 FROM ontology_relations WHERE id = ?").get(value.id)) {
        continue;
      }
      const relationCreatedAt = isTimestamp(value.created_at) ? value.created_at : null;
      // 재감사 P1-3: endpoint version은 의미 세계의 시각으로 검증한다. payload가
      // semantic stamp를 주면(신버전 exporter) 로컬 semantic clock과 비교하고,
      // 없으면(구버전 payload) 기존 updated_at 검증을 그대로 쓴다 — transition
      // 동안 구버전 peer의 relation은 이전과 같이 판정된다.
      const sourceMatches = isTimestamp(value.source_fact_semantic_updated_at)
        ? compareTimestamps(value.source_fact_semantic_updated_at, source.semantic_clock) === 0
        : isTimestamp(value.source_fact_updated_at)
          ? compareTimestamps(value.source_fact_updated_at, source.updated_at) === 0
          : !relationCreatedAt || compareTimestamps(relationCreatedAt, source.updated_at) >= 0;
      const targetMatches = isTimestamp(value.target_fact_semantic_updated_at)
        ? compareTimestamps(value.target_fact_semantic_updated_at, target.semantic_clock) === 0
        : isTimestamp(value.target_fact_updated_at)
          ? compareTimestamps(value.target_fact_updated_at, target.updated_at) === 0
          : !relationCreatedAt || compareTimestamps(relationCreatedAt, target.updated_at) >= 0;
      if (!sourceMatches || !targetMatches) continue;
      try {
        db.prepare(`
          INSERT INTO ontology_relations
            (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          value.id, value.source_fact_id, value.relation_type, value.target_fact_id,
          typeof value.reasoning === "string" ? value.reasoning : null,
          relationCreatedAt ?? new Date().toISOString(),
        );
        result.newRelations++;
      } catch {
        // Duplicate triple under a different id or another local invariant.
      }
    }
  }
}

/**
 * Reconcile protocol-v2 sync files into the local DB.
 *
 * Input contract (재감사 P1-1/P1-4): only committed device generations are
 * read, each pinned fully into memory before any DB mutation. The former root
 * JSONL mirror is no longer an input — mixing the exporter's per-file
 * non-atomic mirror with set-atomic generations re-opened the mixed-snapshot
 * hole the generations exist to close.
 *
 * Conflict order: semantic event clock (semantic_updated_at; legacy payloads
 * fall back to updated_at), then a deterministic canonical fact key;
 * hard-delete tombstones win exact-time ties. Source-created timestamps remain
 * historical data and are never used as local processing cursors.
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
    newDomains: 0,
    newCategories: 0,
    newRelations: 0,
    malformedRows: [],
  };
  const syncDir = getSyncDir();
  const generations = collectCommittedGenerations(syncDir, result.malformedRows);
  if (generations.length === 0) return result;

  const db = initDatabase();
  try {
    importOntology(db, generations, result);
    importTombstones(db, generations, result);
    await importFacts(db, generations, result);
    importRevisions(db, generations, result);
    importRecallEvents(db, generations, result);
    importRelations(db, generations, result);
    return result;
  } finally {
    db.close();
  }
}
