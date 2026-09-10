import { getSearchDb } from "./search.js";
import { l2DistanceToSimilarity } from "./db.js";
import {
  factMatchesReadScope,
  rowToFact,
  searchFactsInScope,
  searchFactsLexicallyInScope,
  isExactFactIdentifierQuery,
  searchHumanSourceIdentifiersInScope,
  validateHumanSourceIdentifierEvidence,
} from "./fact-db.js";
import { readScopeForSession } from './read-scope.js';
import {
  embeddingCallStats,
  generateEmbedding,
  initEmbeddings,
  queryBaseline,
} from "./embeddings.js";
import { getRelatedFactsInScope } from "./ontology-db.js";
import { detectRepeat } from "./repeat-detector.js";
import { appendInjectLog, type InjectLogEntry } from "./inject-log.js";
import { recordRecallEvent } from "./db.js";
import {
  matchIncidentPatterns,
  readChronicleTimeline,
  recordTelemetrySample,
  type TelemetryMetric,
} from "./chronicle.js";
import {
  ensureSessionMemoryState,
  readResidentFactRevisions,
  readResidentRevisionCorrections,
  readWorkCapsule,
  recordResidentFactRevisions,
  type ResidentFactRevision,
} from "./continuity-core.js";
import {
  commitHotEvidenceCursor,
  markSessionProjectRevisionSeen,
  readHotEvidence,
  sessionProjectRevisionState,
} from "./continuity-identity.js";
import {
  blobToEmbedding,
  decideRecall,
  embeddingToBlob,
  resolveAmbiguousDecision,
  tokenizePrompt,
  type RecallGateConfig,
  type RecallGateDecision,
} from "./recall-gate.js";
import {
  NORMAL_BUNDLE_BUDGET,
  renderMemoryBundle,
  type BundleSection,
} from "./memory-bundle.js";

type SearchDb = ReturnType<typeof getSearchDb>;

/** Measured outcome sample; never blocks or fails the prompt path. */
function sampleTelemetry(
  db: SearchDb,
  input: { metric: TelemetryMetric; value: number; unit?: string; projectId?: string | null; sessionId?: string | null; dims?: Record<string, unknown> },
): void {
  try {
    recordTelemetrySample(db as Parameters<typeof recordTelemetrySample>[0], input);
  } catch {
    /* telemetry is best-effort */
  }
}

const TOP_K = 5;
// Probe-baseline relevance gate (e5 scores are compressed, so absolute
// thresholds cannot separate relevant from irrelevant). A fact is injected
// only when sim(query, fact) exceeds the query's own background baseline by
// this margin. Measured on KR/EN real-DB pairs: related +0.047~+0.123,
// unrelated -0.028~-0.091; long compound "memory" facts can leak in at
// +0.04~+0.045, so the margin sits just above that noise band.
const BASELINE_MARGIN = 0.045;
/**
 * Issue #32 — the margin is now tunable and measurable.
 *
 * The observed data root ran the pipeline 12 times over five days with
 * `candidate_facts = 5` and `current_facts = 0` every single time: not one of
 * 127 extracted facts ever entered a prompt. Nothing recorded where those
 * candidates actually sat relative to the threshold, so the constant could not
 * be judged from data. `baseline_margin_gap` telemetry now records that
 * distribution, and this override lets it be moved once the data says where.
 * The default is unchanged: retuning it without evidence would be guessing.
 */
export const INJECT_BASELINE_MARGIN_DEFAULT = BASELINE_MARGIN;

export function resolveBaselineMargin(): number {
  const raw = process.env.MEMEX_INJECT_BASELINE_MARGIN;
  if (raw === undefined) return BASELINE_MARGIN;
  const parsed = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return BASELINE_MARGIN;
  return parsed;
}
const MAX_CONTEXT_FACTS = 8;
// Phase 5 budget (RFC §12.5): normal prompt delta target 700 / hard 1,000 chars.
// detectRepeat 는 313k exchanges 벡터검색 (p50 21ms / p95 498ms 실측) — tail 이
// 주입 지연 p90 을 끌어올린다. better-sqlite3 는 동기라 시작한 검색을 타이머로
// 선점할 수 없다(Promise.race 는 무효 — Codex 리뷰 지적). 대신 시작 "전" 경과
// 예산을 확인해, 파이프라인이 이미 이만큼 썼으면 반복감지를 통째로 생략한다.
const REPEAT_ELAPSED_BUDGET_MS = 700;
/** A WATCH signature or TRACE pointer is not repeated within this many substantive prompts unless it changed. */
const WATCH_TTL_PROMPTS = 5;
const TOPIC_FINGERPRINT_MAX = 64;

/**
 * The bundle transaction refused itself because its client is gone (#89).
 *
 * A distinct type, not a message convention: it has to be separable from a real
 * failure inside the same transaction (a fact whose generation moved, a scope
 * change) so the log can call one `abandoned` and the other `error`.
 */
class UndeliverableInjection extends Error {}

export interface InjectOptions {
  /** Disable the cheap gate (calibration baseline only). */
  gate?: boolean;
  gateConfig?: Partial<RecallGateConfig>;
  now?: string;
  /** Receives the exact prepared receipt only after its transaction commits. */
  onPreparedReceipt?: (id: string) => void;
  /**
   * Last gate before the bundle transaction: return a reason and NOTHING is
   * written — no prepared receipt, no fact residency, no gate state, no cursor.
   *
   * Issue #89. The transaction accounts for a delivery that happens afterwards
   * over a transport which may already be gone: the daemon computed for 74s
   * while the hook gave up at 3s, committed a `prepared` receipt nobody could
   * ever mark emitted (#44's provenance failure), and left the in-process
   * fallback to find every fact already resident, dedup them all, and emit
   * nothing. Called INSIDE the transaction, so there is no window between the
   * check and the commit.
   */
  deliverable?: () => string | null;
  /**
   * Issue #84: daemon attribution for this run's log line — the answering
   * daemon's identity on the fast path, or the identity mismatch that sent the
   * hook in-process. Recorded on whichever line this call writes, so the
   * fast-path decision and its outcome are one record.
   */
  daemon?: InjectLogEntry["daemon"];
}

function commitInjectionState(
  db: SearchDb,
  input: {
    sessionId: string;
    project: string;
    prompt: string;
    factIds: string[];
    projectId: string;
    workspaceId: string;
    workstreamId: string;
    contextEpoch: number;
    projectMemoryRevision: number;
    revisions: ResidentFactRevision[];
    /** Final host-facing context; allows a context-only receipt with no facts. */
    context?: string;
    /** False while stale-revision corrections are still being drained. */
    markProjectRevision: boolean;
  },
): string | null {
  let receiptId: string | null = null;
  const write = () => {
    receiptId = recordRecallEvent(db, input);
    if (!receiptId) throw new Error("Failed to persist prepared recall receipt");
    if (!recordResidentFactRevisions(db, input.sessionId, input.contextEpoch, input.revisions)) {
      throw new Error("context epoch changed before residency commit");
    }
    if (input.markProjectRevision &&
        !markSessionProjectRevisionSeen(db, input.sessionId, input.projectMemoryRevision)) {
      throw new Error("project memory revision changed before injection commit");
    }
  };
  if (typeof db.transaction !== "function") {
    write();
    return receiptId;
  }
  const tx = db.transaction(write);
  if (db.inTransaction) tx();
  else tx.immediate();
  return receiptId;
}

interface GateRow {
  context_epoch: number;
  last_source: string | null;
  capsule_generation_seen: number;
  memory_revision_seen: number;
  topic_fingerprint_json: string;
  topic_embedding: Buffer | null;
  informative_prompts_since_retrieval: number;
  last_retrieval_epoch: number;
  last_retrieval_at: string | null;
  hot_evidence_cursor: number;
  watch_emitted_json: string;
  resident_fact_revisions_json: string;
  workstream_id: string;
}

/** Per-session residency for hint lines (WATCH `watch:<signature>`, TRACE `trace:<subject>`). */
interface WatchLedgerEntry {
  key: string;
  epoch: number;
  /** Substantive prompts processed since the emission, as of the last retrieval commit. */
  at: number;
  /** Change token: newest verified episode (WATCH) or Chronicle state (TRACE). */
  lastEffectiveAt: string;
}

/** Test doubles may hand in a bare object; state reads then degrade to defaults. */
function canQuery(db: SearchDb): boolean {
  return typeof (db as { prepare?: unknown }).prepare === "function";
}

function readGateRow(db: SearchDb, sessionId: string): GateRow | null {
  if (!canQuery(db)) return null;
  return (db.prepare(`
    SELECT context_epoch, last_source, capsule_generation_seen, memory_revision_seen,
           topic_fingerprint_json, topic_embedding, informative_prompts_since_retrieval,
           last_retrieval_epoch, last_retrieval_at, hot_evidence_cursor, watch_emitted_json, resident_fact_revisions_json, workstream_id
    FROM session_memory_state WHERE session_id = ?
  `).get(sessionId) as GateRow | undefined) ?? null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Advance the substantive-prompt counter on a skip; bounded write, no retrieval. */
function noteSkippedPrompt(db: SearchDb, sessionId: string, substantive: boolean, now: string): void {
  if (!substantive || !canQuery(db)) return;
  db.prepare(`
    UPDATE session_memory_state
    SET informative_prompts_since_retrieval = informative_prompts_since_retrieval + 1, updated_at = ?
    WHERE session_id = ?
  `).run(now, sessionId);
}

function commitGateState(
  db: SearchDb,
  input: {
    sessionId: string;
    contextEpoch: number;
    /** Null keeps the previous fingerprint (vector-free acknowledgement turns). */
    tokens: string[] | null;
    embedding: number[] | null;
    watchLedger: WatchLedgerEntry[];
    workstreamId: string;
    now: string;
  },
): void {
  if (!canQuery(db)) return;
  const changed = db.prepare(`
    UPDATE session_memory_state
    SET topic_fingerprint_json = COALESCE(?, topic_fingerprint_json), topic_embedding = COALESCE(?, topic_embedding),
        informative_prompts_since_retrieval = 0, last_retrieval_epoch = ?, last_retrieval_at = ?,
        watch_emitted_json = ?, updated_at = ?
    WHERE session_id = ? AND context_epoch = ? AND workstream_id = ?
  `).run(
    input.tokens ? JSON.stringify(input.tokens.slice(0, TOPIC_FINGERPRINT_MAX)) : null,
    input.embedding ? embeddingToBlob(input.embedding) : null,
    input.contextEpoch,
    input.now,
    JSON.stringify(input.watchLedger.slice(-20)),
    input.now,
    input.sessionId,
    input.contextEpoch,
    input.workstreamId,
  );
  if (changed.changes !== 1) throw new Error("session scope changed before gate commit");
}

function markCapsuleGenerationSeen(db: SearchDb, sessionId: string, contextEpoch: number, generation: number): void {
  if (!canQuery(db)) return;
  db.prepare("UPDATE session_memory_state SET capsule_generation_seen = ? WHERE session_id = ? AND context_epoch = ?")
    .run(generation, sessionId, contextEpoch);
}

function truncateFact(text: string, cap = NORMAL_BUNDLE_BUDGET.lineChars): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap - 1) + "…" : t;
}

/**
 * Compute the UserPromptSubmit context block for a prompt.
 *
 * Phase 5 flow: cheap gate (no model, no embedding) → optional single
 * embedding on the ambiguous path → revision-aware delta retrieval → Memory
 * Bundle (CORRECTION, WORK NOW, CURRENT TRUTH, WATCH, TRACE, RECENT EVIDENCE,
 * ASSISTANT CONTEXT-ONLY) under a deterministic hard budget. Returns '' when
 * there is nothing to inject.
 *
 * Shared by BOTH execution paths:
 *  - the warm in-process daemon inside the MCP server (embeddings already
 *    loaded → ~150ms), and
 *  - the cold fallback in scripts/inject-context.js (fresh node process,
 *    ~2.3s dominated by model load) used when no MCP server is running.
 *
 * `via` tags the inject log so the two paths stay distinguishable.
 *
 * Provenance 계약(RETRIEVAL-AND-CONTEXT.md:43-48): 컨텍스트 발행 **전**에 durable
 * `prepared` recall 영수증이 있어야 한다. sessionId 없는 호출은 recall_events 행을
 * 남길 수 없어 provenance 가 단절되므로, fact 주입 자체를 생략한다(fail-closed).
 * "one recall must not taint sibling tools" 불변식의 추적 가능성이 이 영수증에 의존한다.
 */
export async function computeInjectContext(
  userPrompt: string,
  project: string,
  via: "daemon" | "fallback",
  sessionId?: string,
  options: InjectOptions = {},
): Promise<string> {
  const t0 = Date.now();
  const now = options.now ?? new Date().toISOString();
  const daemonNote = options.daemon ? { daemon: options.daemon } : {};
  if (!sessionId) {
    appendInjectLog({
      status: "no-session-provenance",
      project,
      prompt_len: userPrompt.length,
      via,
      ...daemonNote,
    });
    return "";
  }

  try {
    // Cached long-lived handle (file-identity checked) — initDatabase()'s
    // full migration pass per request costs ~38ms and is pure overhead in the
    // warm daemon. NOT closed here: getSearchDb owns its lifecycle.
    const db = getSearchDb();
    const sessionScope = ensureSessionMemoryState(db, {
      sessionId,
      project,
      prompt: userPrompt,
      source: "UserPromptSubmit",
    });
    const revisionState = sessionProjectRevisionState(db, sessionId);
    const currentProjectRevision = revisionState.current;
    const gateRow = readGateRow(db, sessionId);
    const hotCursor = Number(gateRow?.hot_evidence_cursor ?? 0);
    // Read a fixed eligible prefix before any await. Only emitted sequence IDs
    // are acknowledged, so query limits and budget cutoffs remain retryable.
    const hot = readHotEvidence(db, {
      projectId: sessionScope.projectId, workstreamId: sessionScope.workstreamId,
      excludeSessionId: sessionId, afterSeq: hotCursor, limit: 2,
    });
    const capsule = readWorkCapsule(db, sessionScope.workstreamId);
    const currentCapsuleGeneration = capsule?.generation ?? 0;
    const capsuleGenerationSeen = Number(gateRow?.capsule_generation_seen ?? 0);
    const residentTuples = parseJson<ResidentFactRevision[]>(gateRow?.resident_fact_revisions_json, []);
    const residentTexts = residentTuples.length > 0 && canQuery(db)
      ? (db.prepare(`
          SELECT * FROM facts WHERE id IN (${residentTuples.map(() => "?").join(",")})
        `).all(...residentTuples.map(([id]) => id)) as Array<Record<string, unknown>>)
          .map(rowToFact).filter(fact => {
            const readScope = readScopeForSession(db, sessionId);
            return !!readScope && factMatchesReadScope(db, fact, readScope);
          })
      : [];
    const residentTokens = new Set(residentTexts.flatMap((row) => tokenizePrompt(row.fact)));
    // Corrections come from residency, not from the search results: every
    // resident revision whose fact moved to a new generation or was
    // deactivated is corrected, whether or not the prompt is about it. This is
    // also a gate trigger, because workstream-scoped truth changes carry no
    // project revision token and the stale statement must still be corrected
    // at the next prompt boundary, even an acknowledgement (vector-free).
    const residency = readResidentFactRevisions(db, sessionId);
    const residentById = new Map(residency.resident.map((entry) => [entry[0], entry]));
    const revisionCorrections = residentById.size > 0 ? readResidentRevisionCorrections(db, sessionId) : [];
    // Verified incident patterns only (independent episodes or explicit user
    // repeat); candidates and remediated signatures never wake retrieval.
    const incidents = canQuery(db)
      ? matchIncidentPatterns(db as Parameters<typeof matchIncidentPatterns>[0], {
          projectId: sessionScope.projectId,
          text: userPrompt,
          limit: 2,
        })
      : [];

    // Model-call accounting is read from the embedding module itself so the
    // metric equals real inferences (probe warm-up included) and memo hits.
    const statsBefore = embeddingCallStats();
    const embeddingMetrics = () => {
      const current = embeddingCallStats();
      return { calls: current.modelCalls - statsBefore.modelCalls, hits: current.cacheHits - statsBefore.cacheHits };
    };
    const sampleEmbeddingMetrics = (path: "skip" | "retrieve", unavailable: boolean) => {
      const { calls, hits } = embeddingMetrics();
      sampleTelemetry(db, { metric: "embedding_calls", value: calls, projectId: sessionScope.projectId, sessionId, dims: { path, unavailable } });
      sampleTelemetry(db, { metric: "embedding_cache_hits", value: hits, projectId: sessionScope.projectId, sessionId, dims: { path } });
      return calls;
    };

    let embedding: number[] | null = null;
    let decision: RecallGateDecision = decideRecall({
      prompt: userPrompt,
      state: {
        contextEpoch: sessionScope.contextEpoch,
        lastRetrievalEpoch: Number(gateRow?.last_retrieval_epoch ?? -1),
        lastSource: gateRow?.last_source ?? null,
        capsuleGenerationSeen,
        memoryRevisionSeen: revisionState.seen,
        topicFingerprint: parseJson<string[]>(gateRow?.topic_fingerprint_json, []),
        hasTopicEmbedding: !!gateRow?.topic_embedding,
        informativePromptsSinceRetrieval: Number(gateRow?.informative_prompts_since_retrieval ?? 0),
        residentTokens,
      },
      currentCapsuleGeneration,
      currentProjectRevision,
      incidentMatched: incidents.length > 0,
      residentRevisionStale: revisionCorrections.length > 0,
      hotEvidencePending: hot.length > 0,
      config: options.gateConfig,
    });
    if (options.gate === false) {
      decision = { ...decision, action: "retrieve", triggers: ["safety_refresh"], skipReason: null };
    }
    // Exact paths, symbols and error identifiers are useful even when they
    // are short enough to look like a coherent continuation. Keep ordinary
    // acknowledgements vector-free while allowing the literal lane to answer
    // this high-signal query shape.
    if (canQuery(db) && decision.action === "skip" &&
        !decision.intents.acknowledgement && !decision.intents.continuation) {
      let identifierQuery = false;
      try {
        identifierQuery = isExactFactIdentifierQuery(userPrompt);
      } catch {
        // Partial test doubles and older integrations may not expose the
        // optional lexical helper; preserve the gate's normal skip behavior.
      }
      if (identifierQuery) decision = { ...decision, action: "retrieve", skipReason: null };
    }
    // Embeddings may be unavailable (model missing, offline, cache failure).
    // The gate is lexical, so skips still cost nothing; on the retrieve path the
    // bundle degrades to the sections that need no vector (CORRECTION, WORK
    // NOW, WATCH, RECENT EVIDENCE) and the failure is logged, never thrown.
    let embeddingUnavailable = false;
    const embedOnce = async (): Promise<number[] | null> => {
      try {
        await initEmbeddings();
        return await generateEmbedding(userPrompt, "query");
      } catch {
        embeddingUnavailable = true;
        return null;
      }
    };
    let baseline: number | null = null;
    if (decision.action === "ambiguous") {
      embedding = await embedOnce();
      if (embedding) {
        baseline = await queryBaseline(embedding);
        decision = resolveAmbiguousDecision(decision, embedding, blobToEmbedding(gateRow?.topic_embedding), baseline, options.gateConfig);
      } else {
        decision = { ...decision, action: "retrieve", triggers: [...decision.triggers, "no_topic_embedding"], skipReason: null };
      }
    }
    if (decision.action === "skip") {
      noteSkippedPrompt(db, sessionId, decision.substantive, now);
      sampleTelemetry(db, {
        metric: "retrieval_gate_skip_count", value: 1, projectId: sessionScope.projectId, sessionId,
        dims: { reason: decision.skipReason, substantive: decision.substantive },
      });
      const calls = sampleEmbeddingMetrics("skip", embeddingUnavailable);
      appendInjectLog({
        status: "skipped",
        project,
        prompt_len: userPrompt.length,
        gate: `skip:${decision.skipReason}`,
        embedding_calls: calls,
        duration_ms: Date.now() - t0,
        via,
        ...daemonNote,
      });
      return "";
    }

    // An acknowledgement/continuation only reaches this path through a state
    // trigger (new epoch, Capsule, project revision, incident): it carries the
    // Capsule/corrections without a vector, and never disturbs the topic
    // fingerprint. Everything else pays exactly one embedding.
    const needsVector = options.gate === false || decision.intents.memory ||
      !(decision.intents.acknowledgement || decision.intents.continuation);
    if (needsVector && !embedding && !embeddingUnavailable) embedding = await embedOnce();
    const gateLabel = `retrieve:${decision.triggers.join("+") || "forced"}${embeddingUnavailable ? "+embeddings_unavailable" : ""}`;
    sampleTelemetry(db, {
      metric: "retrieval_execute_count", value: 1, projectId: sessionScope.projectId, sessionId,
      dims: { triggers: decision.triggers, vector: needsVector },
    });
    sampleTelemetry(db, { metric: "semantic_retrieval_calls", value: needsVector ? 1 : 0, projectId: sessionScope.projectId, sessionId });
    const staleProjectMemory = currentProjectRevision > revisionState.seen;
    if (staleProjectMemory) {
      sampleTelemetry(db, { metric: "project_revision_invalidations", value: 1, projectId: sessionScope.projectId, sessionId });
    }
    if (baseline === null) baseline = embedding ? await queryBaseline(embedding) : 0;
    const watchLedger = parseJson<WatchLedgerEntry[]>(gateRow?.watch_emitted_json, []);
    const informativeCounter = Number(gateRow?.informative_prompts_since_retrieval ?? 0);

    // A stale project revision (sibling change) or a stale resident revision
    // forces this pass; never-resident facts are not corrections and arrive
    // only through relevance below.
    const corrections: Array<{ text: string; revision: ResidentFactRevision }> = revisionCorrections.map((row) => ({
      text: row.is_active === 1
        ? `Updated (supersedes earlier context): [${row.category}] ${truncateFact(row.fact)}${row.previous_fact ? ` — earlier: "${truncateFact(row.previous_fact, 60)}"` : ""}`
        : `No longer active: ${truncateFact(row.fact)}`,
      revision: [row.id, row.semantic_generation, row.lifecycle_generation],
    }));
    const correctedIds = new Set(revisionCorrections.map((row) => row.id));

    // threshold 0: take top-k by distance, then gate by baseline margin below
    const scope = {
      type: "workstream-id" as const,
      projectId: sessionScope.projectId,
      workspaceId: sessionScope.workspaceId,
      workstreamId: sessionScope.workstreamId,
    };
    // Keep the existing semantic call as its own lane so the expanding KNN
    // behavior and testable failure boundary remain unchanged. Literal
    // matches are fetched independently and then given deterministic priority.
    const semanticCandidates = embedding ? searchFactsInScope(db, embedding, scope, TOP_K, 0) : [];
    let lexicalCandidates: Array<{ fact: ReturnType<typeof rowToFact>; lexicalScore: number; distance: number }> = [];
    let lexicalLane: "ok" | "unavailable" = "ok";
    if (canQuery(db)) {
      try {
        lexicalCandidates = searchFactsLexicallyInScope(db, userPrompt, scope, TOP_K);
      } catch (error) {
        // Issue #32: this catch used to be empty. Semantic retrieval and
        // correction/hot evidence do remain available when a legacy database
        // or partial integration lacks lexical columns — but a lane that is
        // dead for every prompt looked exactly like a lane with no matches.
        lexicalLane = "unavailable";
        sampleTelemetry(db, {
          metric: "lexical_lane_unavailable", value: 1,
          projectId: sessionScope.projectId, sessionId,
          dims: { reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) },
        });
      }
    }
    const candidates = [...([...semanticCandidates.map((result) => ({
      ...result,
      semanticSimilarity: l2DistanceToSimilarity(result.distance),
      lexicalScore: null as number | null,
    })), ...lexicalCandidates.map((result) => ({
      ...result,
      semanticSimilarity: null as number | null,
      lexicalScore: result.lexicalScore,
    }))].reduce((merged, result) => {
      const existing = merged.get(result.fact.id);
      if (!existing) {
        merged.set(result.fact.id, result);
      } else {
        existing.distance = result.lexicalScore !== null ? existing.distance : result.distance;
        existing.semanticSimilarity = existing.semanticSimilarity ?? result.semanticSimilarity;
        existing.lexicalScore = Math.max(existing.lexicalScore ?? 0, result.lexicalScore ?? 0) || null;
      }
      return merged;
    }, new Map<string, (typeof semanticCandidates[number] & { semanticSimilarity: number | null; lexicalScore: number | null })>())
      .values())];
    const orderedCandidates = [...candidates].sort((a, b) => {
      const aLexical = a.lexicalScore ?? 0;
      const bLexical = b.lexicalScore ?? 0;
      if ((aLexical > 0) !== (bLexical > 0)) return aLexical > 0 ? -1 : 1;
      if (aLexical !== bLexical) return bLexical - aLexical;
      const aSemantic = a.semanticSimilarity ?? -Infinity;
      const bSemantic = b.semanticSimilarity ?? -Infinity;
      return bSemantic - aSemantic || a.fact.id.localeCompare(b.fact.id);
    }).slice(0, TOP_K);
    // Issue #32: record where each candidate actually sat relative to the
    // threshold. Without this the gate's effect is invisible: the log only ever
    // showed "5 candidates, 0 injected" with no way to tell a correct rejection
    // from a threshold set too high.
    const margin = resolveBaselineMargin();
    // Issue #75: the gate decides on the raw gap, so the counts must be derived
    // from the raw gaps too. Recomputing `passed` from the rounded display array
    // disagreed with the gate at the boundary — with the default margin of
    // 0.045, a gap of 0.04496 is rejected but rounds to 0.045 and "passes" — so
    // telemetry could report an injection that never happened. Raw values decide
    // and count; the rounded copy is only for the log.
    const rawGaps: number[] = [];
    const results = orderedCandidates.filter((r) => {
      if (r.lexicalScore !== null) return true;
      const similarity = r.semanticSimilarity ?? l2DistanceToSimilarity(r.distance);
      const gap = similarity - baseline;
      rawGaps.push(gap);
      return gap >= margin;
    });
    if (rawGaps.length > 0) {
      const passed = rawGaps.filter((gap) => gap >= margin).length;
      sampleTelemetry(db, {
        // The closest miss is the decision-relevant number; `dims.gaps` keeps
        // the whole bounded distribution (at most TOP_K entries).
        metric: "baseline_margin_gap",
        value: Math.round(Math.max(...rawGaps) * 1e4) / 1e4,
        unit: "similarity",
        projectId: sessionScope.projectId,
        sessionId,
        dims: {
          margin,
          gaps: rawGaps.map((gap) => Math.round(gap * 1e4) / 1e4),
          passed,
          rejected: rawGaps.length - passed,
          baseline: Math.round(baseline * 1e4) / 1e4,
        },
      });
    }
    let rawEvidence: ReturnType<typeof searchHumanSourceIdentifiersInScope> = [];
    if (canQuery(db)) {
      try { rawEvidence = searchHumanSourceIdentifiersInScope(db, userPrompt, scope); }
      catch { /* Missing source identity/provenance support leaves this lane empty. */ }
    }
    sampleTelemetry(db, { metric: "candidate_facts", value: candidates.length, projectId: sessionScope.projectId, sessionId });
    sampleTelemetry(db, { metric: "current_facts", value: results.length, projectId: sessionScope.projectId, sessionId });
    // Intent-gated 1-hop expansion (RFC §12.7): only why/related/dependency/
    // contradiction/trace prompts pay for graph expansion.
    const seenIds = new Set(results.map((r) => r.fact.id));
    const expandedFacts = [...results.map((r) => ({ fact: r.fact, note: "" }))];
    if (decision.intents.trace) {
      for (const { fact } of results.slice(0, 3)) {
        const related = getRelatedFactsInScope(db, fact.id, scope);
        for (const { fact: relFact, relation } of related) {
          if (!seenIds.has(relFact.id) && expandedFacts.length < MAX_CONTEXT_FACTS) {
            seenIds.add(relFact.id);
            expandedFacts.push({ fact: relFact, note: `[${relation.relation_type}]` });
          }
        }
      }
    }

    // Revision-aware delta: identical resident revisions are suppressed; a
    // resident fact seen in a newer generation is a correction (normally
    // already collected above from residency).
    const revisionOf = (fact: { id: string; semantic_generation?: number; lifecycle_generation?: number }): ResidentFactRevision => [
      fact.id,
      fact.semantic_generation ?? 1,
      fact.lifecycle_generation ?? 1,
    ];
    const fresh: typeof expandedFacts = [];
    let dedupedCount = 0;
    for (const entry of expandedFacts) {
      const [id, semantic, lifecycle] = revisionOf(entry.fact);
      const resident = residentById.get(id);
      if (!resident) { fresh.push(entry); continue; }
      if (resident[1] === semantic && resident[2] === lifecycle) { dedupedCount++; continue; }
      if (!correctedIds.has(id)) {
        correctedIds.add(id);
        corrections.push({
          text: `Updated (supersedes earlier context): [${entry.fact.category}] ${truncateFact(entry.fact.fact)}`,
          revision: [id, semantic, lifecycle],
        });
      }
    }
    sampleTelemetry(db, { metric: "delta_facts", value: fresh.length + corrections.length, projectId: sessionScope.projectId, sessionId });

    const sections: BundleSection<ResidentFactRevision | undefined>[] = [];
    if (corrections.length > 0) {
      sections.push({ kind: "CORRECTION", items: corrections.map((c) => ({ text: c.text, ref: c.revision })) });
    }
    // WORK NOW whenever the current Capsule generation is not resident in this
    // epoch (new session, compact/clear, or a new generation); SessionStart
    // rehydration marks the generation it already injected.
    const wantsWorkNow = !!capsule && capsule.generation > capsuleGenerationSeen;
    let workNowRenderable = false;
    if (wantsWorkNow && capsule) {
      const lines = ["[WORK NOW]"];
      if (capsule.objective) lines.push(`Objective: ${truncateFact(capsule.objective, 200)}`);
      if (capsule.currentState) lines.push(`State: ${truncateFact(capsule.currentState, 200)}`);
      if (capsule.blockers[0]) lines.push(`Blocker: ${truncateFact(capsule.blockers[0], 160)}`);
      if (capsule.nextActions[0]) lines.push(`Next: ${truncateFact(capsule.nextActions[0], 160)}`);
      workNowRenderable = lines.length > 1;
      if (workNowRenderable) sections.push({ kind: "WORK NOW", items: [{ text: lines.join("\n"), raw: true }] });
    }
    if (fresh.length > 0) {
      sections.push({
        kind: "CURRENT TRUTH",
        items: fresh.map(({ fact, note }) => ({
          text: `${note ? note + " " : ""}[${fact.category}] ${truncateFact(fact.fact)} (${fact.created_at.slice(0, 10)})`,
          ref: revisionOf(fact),
        })),
      });
    }
    // WATCH: verified patterns only, bounded, with a per-session TTL counted in
    // substantive prompts so the same signature is not repeated on every
    // prompt unless it recurred (a newer verified episode).
    // A hint line is resident for the epoch until its change token moves (a
    // newer verified episode, a Chronicle change). WATCH additionally expires
    // after `ttl` substantive prompts so a live signature is re-warned; TRACE
    // is a pointer and stays resident for the whole epoch.
    const hintResident = (key: string, changeToken: string, ttl: number): boolean => {
      const prior = watchLedger.find((entry) => entry.key === key);
      if (!prior) return false;
      const changed = changeToken > prior.lastEffectiveAt;
      const withinTtl = prior.epoch === sessionScope.contextEpoch && prior.at + informativeCounter < ttl;
      return !changed && withinTtl;
    };
    const watchItems: Array<{ text: string; key: string; lastEffectiveAt: string }> = [];
    for (const pattern of incidents) {
      const key = `watch:${pattern.signatureKey}`;
      if (hintResident(key, pattern.lastEffectiveAt, WATCH_TTL_PROMPTS)) continue;
      watchItems.push({
        key,
        lastEffectiveAt: pattern.lastEffectiveAt,
        text: `Known incident pattern (${pattern.episodeCount} verified episodes, last ${pattern.lastEffectiveAt.slice(0, 10)}): "${pattern.signatureText}"${pattern.remediationSummary ? ` — verified remediation: ${pattern.remediationSummary}` : ""}`,
      });
    }
    if (watchItems.length > 0) sections.push({ kind: "WATCH", items: watchItems.map((w) => ({ text: w.text })) });
    // TRACE: explicit why/history/source intent → point at the Chronicle instead of injecting it.
    const traceItems: Array<{ text: string; key: string; lastEffectiveAt: string }> = [];
    if ((decision.intents.trace || decision.intents.memory) && canQuery(db)) {
      for (const { fact } of results.slice(0, 2)) {
        if (!fact.subject_key || !fact.project_id) continue;
        const latest = readChronicleTimeline(db as Parameters<typeof readChronicleTimeline>[0], {
          projectId: fact.project_id, subjectKey: fact.subject_key, order: "desc", limit: 1,
        });
        const count = (db.prepare("SELECT COUNT(*) AS n FROM fact_revisions WHERE project_id = ? AND subject_key = ?")
          .get(fact.project_id, fact.subject_key) as { n: number }).n;
        const event = latest.events[0];
        if (!event || Number(count) === 0) continue;
        const key = `trace:${fact.subject_key}`;
        const changeToken = `${String(count).padStart(8, "0")}@${event.effective_at}`;
        if (hintResident(key, changeToken, Number.POSITIVE_INFINITY)) continue;
        traceItems.push({
          key,
          lastEffectiveAt: changeToken,
          // Pointer first so the actionable call survives the line cap.
          text: `trace_fact subject_key=${fact.subject_key} — ${count} Chronicle event(s), latest ${event.event_kind} effective ${event.effective_at.slice(0, 10)}${event.grounded_cause ? `; cause: ${truncateFact(event.grounded_cause, 80)}` : ""}`,
        });
      }
      if (traceItems.length > 0) sections.push({ kind: "TRACE", items: traceItems.map((t) => ({ text: t.text })) });
    }
    if (rawEvidence.length > 0) {
      sections.push({ kind: "RAW EVIDENCE", items: rawEvidence.map(item => ({ text: item.text })) });
    }
    if (hot.length > 0) {
      sections.push({ kind: "RECENT EVIDENCE", items: hot.map((item) => ({ text: String(item.evidence_text).slice(0, 180) })) });
    }
    // Assistant repeat context is demoted: only when no current truth answers
    // the prompt and the user explicitly asks about memory, as a labeled
    // source-linked hint that never outranks current facts.
    if (embedding && fresh.length === 0 && corrections.length === 0 && decision.intents.memory && Date.now() - t0 < REPEAT_ELAPSED_BUDGET_MS) {
      try {
        const repeats = await detectRepeat(userPrompt, project, 1, 0.85, { embedding, db });
        const match = repeats[0];
        if (match) {
          sections.push({
            kind: "ASSISTANT CONTEXT",
            items: [{
              text: `Earlier answer (${match.timestamp.slice(0, 10)}, may be stale; verify with MCP search): "${truncateFact(match.assistantSummary, 200)}" — lines ${match.lineStart}-${match.lineEnd} in ${match.archivePath}`,
            }],
          });
        }
      } catch {
        /* best-effort */
      }
    }

    const rendered = renderMemoryBundle(sections, NORMAL_BUNDLE_BUDGET);
    const emittedRevisions: ResidentFactRevision[] = [];
    for (const section of rendered.sections) {
      for (const item of section.emitted) if (item.ref) emittedRevisions.push(item.ref);
    }
    const emittedCorrections = rendered.sections.find((s) => s.kind === "CORRECTION")?.emitted.length ?? 0;
    // Drain corrections across prompts under the budget: the project revision
    // is acknowledged only once every stale resident revision has been corrected.
    const correctionsComplete = emittedCorrections === corrections.length;
    const emittedWatch = rendered.sections.find((s) => s.kind === "WATCH")?.emitted.length ?? 0;
    const emittedTrace = rendered.sections.find((s) => s.kind === "TRACE")?.emitted.length ?? 0;
    const emittedHints = [...watchItems.slice(0, emittedWatch), ...traceItems.slice(0, emittedTrace)];
    const emittedWatchKeys = new Set(emittedHints.map((hint) => hint.key));
    const promptsSinceLastRetrieval = informativeCounter + (decision.substantive ? 1 : 0);
    const nextWatchLedger: WatchLedgerEntry[] = watchLedger
      .filter((entry) => !emittedWatchKeys.has(entry.key))
      .map((entry) => ({ ...entry, at: entry.at + promptsSinceLastRetrieval }));
    for (const hint of emittedHints) {
      nextWatchLedger.push({ key: hint.key, epoch: sessionScope.contextEpoch, at: 0, lastEffectiveAt: hint.lastEffectiveAt });
    }
    const workNowEmitted = rendered.sections.some((s) => s.kind === "WORK NOW");
    const capsuleResident = wantsWorkNow && capsule && (workNowEmitted || !workNowRenderable);
    const fingerprintTokens = needsVector ? decision.tokens : null;

    const injectedIds = [...new Set(emittedRevisions.map(([id]) => id))];
    let preparedReceiptId: string | null = null;
    const commitBundle = () => {
      const undeliverable = options.deliverable?.();
      if (undeliverable) throw new UndeliverableInjection(undeliverable);
      if (canQuery(db)) {
        const emittedRaw = rendered.sections.find(section => section.kind === "RAW EVIDENCE")?.emitted.length ?? 0;
        for (const evidence of rawEvidence.slice(0, emittedRaw)) {
          if (!validateHumanSourceIdentifierEvidence(db, evidence, scope)) {
            throw new Error("raw source content or scope changed before injection commit");
          }
        }
        for (const [id, semantic, lifecycle] of emittedRevisions) {
          const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
          const revoked = revisionCorrections.some(correction => correction.id === id && correction.scope_revoked);
          if (!row || Number(row.semantic_generation) !== semantic || Number(row.lifecycle_generation) !== lifecycle ||
              (!revoked && !factMatchesReadScope(db, rowToFact(row), scope))) {
            throw new Error('fact meaning or scope changed before injection commit');
          }
        }
      }
      if (rendered.rawText.length > 0) {
        preparedReceiptId = commitInjectionState(db, {
          sessionId, project, prompt: userPrompt, factIds: injectedIds,
          projectId: sessionScope.projectId, workspaceId: sessionScope.workspaceId,
          workstreamId: sessionScope.workstreamId, contextEpoch: residency.contextEpoch,
          projectMemoryRevision: currentProjectRevision, revisions: emittedRevisions,
          context: rendered.text,
          markProjectRevision: !staleProjectMemory || correctionsComplete,
        });
      } else if (staleProjectMemory && correctionsComplete &&
          !markSessionProjectRevisionSeen(db, sessionId, currentProjectRevision)) {
        throw new Error("project memory revision changed before injection commit");
      }
      if (canQuery(db)) {
        const emitted = rendered.sections.find((s) => s.kind === "RECENT EVIDENCE")?.emitted.length ?? 0;
        commitHotEvidenceCursor(db, {
          sessionId, projectId: sessionScope.projectId, workstreamId: sessionScope.workstreamId,
          contextEpoch: residency.contextEpoch, fromSeq: hotCursor,
          emittedSeqs: hot.slice(0, emitted).map((item) => Number(item.seq)),
        });
      }
      commitGateState(db, { sessionId, workstreamId: sessionScope.workstreamId,
        contextEpoch: residency.contextEpoch, tokens: fingerprintTokens,
        embedding, watchLedger: nextWatchLedger, now });
      if (capsuleResident) markCapsuleGenerationSeen(db, sessionId, residency.contextEpoch, capsule.generation);
    };
    // Receipt, fact residency, Hot Evidence prefix and gate state either commit
    // together or remain retryable when this transaction fails. Delivery on
    // stdout happens afterwards; it is not an exactly-once transport.
    if (typeof db.transaction === "function") {
      const tx = db.transaction(commitBundle);
      db.inTransaction ? tx() : tx.immediate();
    } else commitBundle();
    // The receipt is durable at this point. The transport can now carry its
    // exact id and mark only this delivery after stdout succeeds.
    if (preparedReceiptId && options.onPreparedReceipt) {
      try { options.onPreparedReceipt(preparedReceiptId); } catch { /* callback is best-effort */ }
    }

    if (rendered.rawText.length === 0) {
      const calls = sampleEmbeddingMetrics("retrieve", embeddingUnavailable);
      appendInjectLog({
        status: dedupedCount > 0 ? "deduped" : "no-match",
        project,
        prompt_len: userPrompt.length,
        candidates: candidates.length,
        injected: 0,
        deduped: dedupedCount,
        gate: gateLabel,
        embedding_calls: calls,
        lexical_lane: lexicalLane,
        duration_ms: Date.now() - t0,
        via,
        ...daemonNote,
      });
      if (dedupedCount > 0) {
        sampleTelemetry(db, { metric: "repeated_context_turns", value: 1, projectId: sessionScope.projectId, sessionId });
      }
      return "";
    }

    // `rendered.text` is already the complete host-facing envelope. Do not
    // append an unmeasured transport newline after references are committed.
    const block = rendered.text;
    const sectionKinds = rendered.sections.map((s) => s.kind);
    const calls = sampleEmbeddingMetrics("retrieve", embeddingUnavailable);
    sampleTelemetry(db, { metric: "injected_facts", value: injectedIds.length, projectId: sessionScope.projectId, sessionId });
    sampleTelemetry(db, { metric: "injected_chars", value: block.length, unit: "chars", projectId: sessionScope.projectId, sessionId });
    sampleTelemetry(db, { metric: "estimated_tokens", value: rendered.estimatedTokens, unit: "tokens", projectId: sessionScope.projectId, sessionId });
    sampleTelemetry(db, { metric: "bundle_size", value: block.length, unit: "chars", projectId: sessionScope.projectId, sessionId, dims: { kind: "normal", sections: sectionKinds } });
    for (const section of rendered.sections) {
      sampleTelemetry(db, { metric: "section_chars", value: section.chars, unit: "chars", projectId: sessionScope.projectId, sessionId, dims: { section: section.kind } });
    }
    if (emittedCorrections > 0) {
      sampleTelemetry(db, { metric: "correction_count", value: emittedCorrections, projectId: sessionScope.projectId, sessionId, dims: { path: staleProjectMemory ? "project_revision" : "revision_delta" } });
      sampleTelemetry(db, { metric: "correction_delay_prompts", value: informativeCounter, projectId: sessionScope.projectId, sessionId });
    }
    if (emittedWatch > 0) {
      sampleTelemetry(db, { metric: "watch_emissions", value: emittedWatch, projectId: sessionScope.projectId, sessionId, dims: { keys: watchItems.slice(0, emittedWatch).map((w) => w.key) } });
    }
    if (dedupedCount > 0) {
      sampleTelemetry(db, { metric: "repeated_context_turns", value: 1, projectId: sessionScope.projectId, sessionId });
    }
    appendInjectLog({
      // Issue #32: a bundle with zero facts is not an injection of memory.
      status: injectedIds.length > 0 ? "injected" : "context-only",
      project,
      prompt_len: userPrompt.length,
      candidates: candidates.length,
      injected: injectedIds.length,
      deduped: dedupedCount,
      chars: block.length,
      gate: gateLabel,
      embedding_calls: calls,
      sections: sectionKinds,
      lexical_lane: lexicalLane,
      duration_ms: Date.now() - t0,
      via,
      ...daemonNote,
    });
    return block;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UndeliverableInjection) {
      // Rolled back on purpose: a client that is gone must not leave durable
      // state behind. `abandoned`, not `error`, so `doctor` does not report a
      // correct refusal as a broken injection path.
      appendInjectLog({
        status: "abandoned",
        project,
        prompt_len: userPrompt.length,
        duration_ms: Date.now() - t0,
        error: message.slice(0, 300),
        via,
        ...daemonNote,
      });
      return "";
    }
    appendInjectLog({
      status: "error",
      project,
      prompt_len: userPrompt.length,
      duration_ms: Date.now() - t0,
      error: message.slice(0, 300),
      via,
      ...daemonNote,
    });
    return ""; // non-fatal: never disrupt the user's prompt
  }
}
