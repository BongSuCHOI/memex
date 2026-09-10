/**
 * CX-04 — pipeline readiness & backfill observability.
 *
 * READ-ONLY by contract: status opens the database readonly, never spawns
 * workers, never calls the LLM, never mutates anything. Readiness is derived
 * from ledger/table state, not from file existence or live PIDs.
 */
import fs from "node:fs";
import path from "node:path";
import { openReadDb } from "./db.js";
import { describeDerivedLaneSkipReason, readDerivedLaneSkips, } from "./derived-lane-skip.js";
import { EMBEDDING_VERSION } from "./embeddings.js";
import { countFactsWithoutLocalEvidence, hasEvidenceSchema, } from "./evidence-backfill.js";
import { heldJobSummary } from "./model-budget.js";
import { buildOntologyParkedClause, buildOntologyParkedRetryClause, } from "./ontology-selector.js";
import { getDbPath, getArchiveDir, getMemexHome, llmWorkdirCwdSql, } from "./paths.js";
import { EXTRACTION_STATE, freshClaimPredicate, getExtractionConfig, pendingExtractionCoreQuery, } from "./pending-extraction.js";
function tableExists(db, name) {
    return (db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name) !== undefined);
}
function columnNames(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all()
        .map((row) => row.name));
}
function count(db, sql, ...params) {
    const row = db.prepare(sql).get(...params);
    return row ? Number(row.c) : 0;
}
/** Recursively count rollout/summary files under the archive root. */
function countArchiveFiles(archiveDir) {
    let n = 0;
    const walk = (dir) => {
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory())
                walk(path.join(dir, e.name));
            else if (e.isFile() && e.name.endsWith(".jsonl"))
                n++;
        }
    };
    walk(archiveDir);
    return n;
}
export function getPipelineStatus(opts = {}) {
    const dbPath = opts.dbPath ?? getDbPath();
    const dbExists = opts.db !== undefined || fs.existsSync(dbPath);
    // Worker eligibility config — shared source with backfill-extract-worker
    // (pendingExtractionCoreQuery) so status counts what the pipeline does.
    const extractionGate = getExtractionConfig();
    // Lifecycle observation log lives outside the DB and is always safe to read.
    const lifecycleLastEventAt = readHookEvents();
    if (!dbExists) {
        return {
            dataRootEmpty: true,
            conversations: {
                sessionsIndexed: 0,
                exchanges: 0,
                archiveFiles: countArchiveFiles(getArchiveDir()),
                ready: false,
            },
            extraction: {
                total: 0,
                done: 0,
                pending: 0,
                excluded: 0,
                excludedBelowMin: 0,
                excludedProject: 0,
                deferred: 0,
                backoff: 0,
                backoffEarliestAt: null,
                gateMinExchanges: extractionGate.minExchanges,
                claimed: 0,
                failedPermanent: 0,
                failedVisible: 0,
                retriable: 0,
                lastSuccessAt: null,
                lastErrorAt: null,
            },
            embeddings: { activeFacts: 0, factVectorsPending: 0 },
            ontology: emptyOntology(),
            relations: 0,
            evidence: { factsWithoutLocalEvidence: 0, activeFactsWithSources: 0 },
            attention: emptyAttention(),
            jobs: emptyJobCounters(),
            derivedLaneSkips: null,
            quarantinedProjects: [],
            lifecycleLastEventAt,
            readiness: {
                conversationReady: false,
                factReady: false,
                graphReady: false,
            },
        };
    }
    const db = opts.db ?? openReadDb(dbPath);
    const ownsDb = opts.db === undefined;
    try {
        const hasExchanges = tableExists(db, "exchanges");
        const hasExtractionLog = tableExists(db, "extraction_log");
        const hasFacts = tableExists(db, "facts");
        const hasRelations = tableExists(db, "ontology_relations");
        const exchanges = hasExchanges
            ? count(db, "SELECT COUNT(*) AS c FROM exchanges")
            : 0;
        const sessionsIndexed = hasExchanges
            ? count(db, "SELECT COUNT(DISTINCT session_id) AS c FROM exchanges WHERE session_id IS NOT NULL AND is_sidechain = 0")
            : 0;
        // ── Extraction stage counters ────────────────────────────────────────
        let extraction = {
            total: 0,
            done: 0,
            pending: 0,
            excluded: 0,
            excludedBelowMin: 0,
            excludedProject: 0,
            deferred: 0,
            backoff: 0,
            backoffEarliestAt: null,
            gateMinExchanges: extractionGate.minExchanges,
            claimed: 0,
            failedPermanent: 0,
            failedVisible: 0,
            retriable: 0,
            lastSuccessAt: null,
            lastErrorAt: null,
        };
        if (hasExchanges && hasExtractionLog) {
            const total = count(db, "SELECT COUNT(DISTINCT session_id) AS c FROM exchanges WHERE session_id IS NOT NULL AND is_sidechain = 0");
            // done = successful sessions whose watermark covers every current
            // exchange. A successful marker with a newer resume suffix is pending,
            // not simultaneously done (the same watermark contract as the worker).
            const hasGenerationState = tableExists(db, "exchange_extraction_state");
            const done = hasGenerationState
                ? count(db, `
            SELECT COUNT(*) AS c FROM (
              SELECT DISTINCT e.session_id
              FROM exchanges e
              WHERE e.session_id IS NOT NULL AND e.is_sidechain = 0
                AND EXISTS (
                  SELECT 1 FROM exchanges closed
                  WHERE closed.session_id = e.session_id
                    AND closed.closure_state IN ('closed','final')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM exchanges current
                  LEFT JOIN exchange_extraction_state state
                    ON state.exchange_id = current.id
                   AND state.content_generation = current.content_generation
                   AND state.policy_version = 'continuity-fact-v1'
                   AND state.state = 'processed'
                  WHERE current.session_id = e.session_id
                    AND current.closure_state IN ('closed','final')
                    AND state.exchange_id IS NULL
                )
            )`)
                : count(db, `
            SELECT COUNT(*) AS c FROM (
              SELECT DISTINCT e.session_id
              FROM exchanges e
              JOIN extraction_log l ON l.session_id = e.session_id
              WHERE e.session_id IS NOT NULL AND e.is_sidechain = 0
                AND l.extracted >= 0
                AND (SELECT COALESCE(MAX(x.rowid), 0) FROM exchanges x
                     WHERE x.session_id = e.session_id)
                    <= l.last_exchange_rowid
            )`);
            const permanent = count(db, "SELECT COUNT(*) AS c FROM extraction_log WHERE extracted = ?", EXTRACTION_STATE.PERMANENT);
            const retriable = count(db, `SELECT COUNT(*) AS c FROM extraction_log WHERE extracted = ?
        AND saved < 3`, EXTRACTION_STATE.RETRIABLE_INTERNAL);
            const failedVisible = tableExists(db, "extraction_failed_ranges")
                ? count(db, "SELECT COUNT(*) AS c FROM extraction_failed_ranges WHERE state = 'failed-visible'")
                : 0;
            const claimedFresh = tableExists(db, "memory_jobs")
                ? count(db, `SELECT COUNT(*) AS c FROM memory_jobs
             WHERE kind = 'fact_extract' AND state = 'running'
               AND lease_until > ?`, new Date().toISOString())
                : count(db, `SELECT COUNT(*) AS c FROM extraction_log
            WHERE extracted = ? AND ${freshClaimPredicate()}`, EXTRACTION_STATE.CLAIMED);
            // Pending = sessions with exchanges lacking a settled extraction_log row.
            const settledSessions = count(db, `
        SELECT COUNT(*) AS c FROM (
          SELECT DISTINCT e.session_id
          FROM exchanges e
          WHERE e.session_id IS NOT NULL AND e.is_sidechain = 0
            AND EXISTS (
              SELECT 1 FROM extraction_log l WHERE l.session_id = e.session_id
                AND (l.extracted >= 0 OR l.extracted = ?
                OR (l.extracted = ? AND ${freshClaimPredicate("l")}))
            )
            -- settled 마커라도 워터마크가 뒤처지면 새 suffix 가 있는 것이므로
            -- 아직 완료가 아니다(pendingExtractionCoreQuery 의 watermark 분기와 동일).
            AND (SELECT COALESCE(MAX(x.rowid), 0) FROM exchanges x
                 WHERE x.session_id = e.session_id)
                <= COALESCE((SELECT l.last_exchange_rowid FROM extraction_log l
                             WHERE l.session_id = e.session_id), -1)
        )`, EXTRACTION_STATE.PERMANENT, EXTRACTION_STATE.CLAIMED);
            const times = db
                .prepare(`
        SELECT
          MAX(CASE WHEN extracted >= 0 THEN processed_at END) AS lastOk,
          MAX(CASE WHEN extracted < 0 THEN processed_at END) AS lastErr
        FROM extraction_log`)
                .get();
            // Sessions the worker deliberately never picks: markerless sessions
            // below BACKFILL_MIN_EXCHANGES or in excluded/LLM-workdir projects.
            // Mirrors pendingExtractionCoreQuery's gate (including its any-exchange
            // cwd pollution check) so pending means exactly "work the pipeline will
            // actually do" — excluded sessions stay visible under their own name.
            const exTerms = extractionGate.excludeProjects;
            // llmWorkdirCwdSql keeps status's pollution shape identical to the
            // worker's (pendingExtractionCoreQuery) — basename + mkdtemp suffix form.
            const pollutionClause = `${llmWorkdirCwdSql("x.cwd")}${exTerms.length
                ? " OR " + exTerms.map(() => "x.cwd = ?").join(" OR ")
                : ""}`;
            const gateRow = db
                .prepare(`
        SELECT COUNT(*) AS c,
               COALESCE(SUM(g.polluted), 0) AS byProject,
               COALESCE(SUM(1 - g.polluted), 0) AS belowMin
        FROM (
          SELECT e.session_id,
                 (SELECT MAX(CASE WHEN ${pollutionClause} THEN 1 ELSE 0 END)
                    FROM exchanges x WHERE x.session_id = e.session_id) AS polluted,
                 COUNT(*) AS n
          FROM exchanges e
          LEFT JOIN extraction_log l ON l.session_id = e.session_id
          WHERE e.is_sidechain = 0 AND e.session_id IS NOT NULL
            ${hasGenerationState
                ? `AND EXISTS (
                  SELECT 1 FROM exchanges ce
                  LEFT JOIN exchange_extraction_state ces
                    ON ces.exchange_id = ce.id
                   AND ces.content_generation = ce.content_generation
                   AND ces.policy_version = 'continuity-fact-v1'
                  WHERE ce.session_id = e.session_id
                    AND ce.closure_state IN ('closed','final')
                    AND (ces.exchange_id IS NULL
                      OR (ces.state IN ('pending','processing','retry')
                        AND NOT EXISTS (
                          SELECT 1 FROM extraction_targets cet
                          WHERE cet.target_id = ces.target_id AND cet.state = 'dead'
                        )))
                )`
                : "AND l.session_id IS NULL"}
          GROUP BY e.session_id
          HAVING COUNT(*) < ? OR polluted = 1
        ) g`)
                .get(...exTerms, extractionGate.minExchanges);
            const excludedSessions = Number(gateRow.c);
            // Legacy SEED/PERMANENT markers are not exact completion/failure evidence.
            // Only a Continuity target with an exact failed-visible range may defer.
            const deferredSessions = hasGenerationState
                ? count(db, `SELECT COUNT(DISTINCT session_id) AS c
             FROM extraction_targets WHERE state = 'dead'`)
                : count(db, `
            SELECT COUNT(*) AS c FROM (
              SELECT DISTINCT e.session_id
              FROM exchanges e
              JOIN extraction_log l ON l.session_id = e.session_id
              WHERE e.session_id IS NOT NULL AND e.is_sidechain = 0
                AND (l.extracted = ?
                  OR (l.extracted = ?
                    AND (SELECT COALESCE(MAX(x.rowid), 0) FROM exchanges x
                         WHERE x.session_id = e.session_id)
                        > COALESCE(l.last_exchange_rowid, -1)))
            )`, EXTRACTION_STATE.SEED, EXTRACTION_STATE.PERMANENT);
            // 🚨 Issue #11. Backoff is not deferral: `deferred` above is terminal
            // (dead targets / legacy markers) while these sessions hold a live,
            // claimable queue job whose `available_at` has simply not arrived. They
            // stay counted inside `pending` — this is a breakdown of pending, not a
            // new bucket beside it — so backfill's exit-2 "deferred work" contract is
            // untouched; what changes is that the operator can now see *when*.
            const nowIso = new Date().toISOString();
            const backoffRow = hasGenerationState && tableExists(db, "memory_jobs")
                ? db.prepare(`
              SELECT COUNT(*) AS c, MIN(available_at) AS earliest FROM (
                SELECT j.partition_key, MIN(j.available_at) AS available_at
                FROM memory_jobs j
                WHERE j.kind = 'fact_extract'
                  AND j.state IN ('pending','retry')
                  AND j.available_at > ?
                  AND NOT EXISTS (
                    SELECT 1 FROM memory_jobs live
                    WHERE live.partition_key = j.partition_key
                      AND live.kind = 'fact_extract'
                      AND ((live.state IN ('pending','retry') AND live.available_at <= ?)
                        OR (live.state = 'running' AND live.lease_until > ?))
                  )
                GROUP BY j.partition_key
              )
            `).get(nowIso, nowIso, nowIso)
                : { c: 0, earliest: null };
            const pendingCore = hasGenerationState
                ? pendingExtractionCoreQuery(extractionGate, "continuity")
                : null;
            const exactPending = pendingCore
                ? count(db, `SELECT COUNT(*) AS c FROM (${pendingCore.sql})`, ...pendingCore.params)
                : Math.max(0, total - settledSessions - excludedSessions - deferredSessions);
            extraction = {
                total,
                done,
                pending: exactPending,
                excluded: excludedSessions,
                excludedBelowMin: Number(gateRow.belowMin),
                excludedProject: Number(gateRow.byProject),
                deferred: deferredSessions,
                backoff: Number(backoffRow.c),
                backoffEarliestAt: backoffRow.earliest ?? null,
                gateMinExchanges: extractionGate.minExchanges,
                claimed: claimedFresh,
                failedPermanent: permanent,
                failedVisible,
                retriable,
                lastSuccessAt: times.lastOk,
                lastErrorAt: times.lastErr,
            };
        }
        // ── Embeddings / ontology / relations ────────────────────────────────
        const embeddings = { activeFacts: 0, factVectorsPending: 0 };
        const ontology = emptyOntology();
        let relations = 0;
        if (hasFacts) {
            embeddings.activeFacts = count(db, "SELECT COUNT(*) AS c FROM facts WHERE is_active = 1");
            if (tableExists(db, "vec_facts")) {
                embeddings.factVectorsPending = count(db, `
          SELECT COUNT(*) AS c FROM facts f
          WHERE f.is_active = 1
            AND NOT EXISTS (SELECT 1 FROM vec_facts v WHERE v.id = f.id)`);
            }
            else {
                // Missing table: report every active fact as vector-pending.
                embeddings.factVectorsPending = embeddings.activeFacts;
            }
            // 이슈 #41: parked는 classified가 아니다. 예전 카운트는 파킹된 fact를
            // classified로 세어 pending을 0으로 만들었고 graph-ready: YES가 됐다.
            const hasParkState = new Set(db.prepare("PRAGMA table_info(facts)").all().map((r) => r.name)).has("ontology_state");
            ontology.parkedFacts = hasParkState
                ? count(db, `SELECT COUNT(*) AS c FROM facts f WHERE ${buildOntologyParkedClause("f")}`)
                : 0;
            if (hasParkState) {
                const retry = buildOntologyParkedRetryClause({
                    embeddingVersion: EMBEDDING_VERSION,
                    alias: "f",
                });
                ontology.parkedRetryable = count(db, `SELECT COUNT(*) AS c FROM facts f WHERE ${retry.clause}`, ...retry.params);
            }
            ontology.classifiedFacts = count(db, `SELECT COUNT(*) AS c FROM facts f
         WHERE f.is_active = 1 AND f.ontology_category_id IS NOT NULL
           ${hasParkState ? "AND (f.ontology_state IS NULL OR f.ontology_state <> 'parked')" : ""}`);
            ontology.pendingFacts = Math.max(0, embeddings.activeFacts - ontology.classifiedFacts - ontology.parkedFacts);
            ontology.indexRepair = readOntologyIndexRepair(db);
        }
        if (hasRelations)
            relations = count(db, "SELECT COUNT(*) AS c FROM ontology_relations");
        // 이슈 #45: 통합이 조용히 보류되는 이유를 한 화면에서 볼 수 있어야 한다.
        const evidence = { factsWithoutLocalEvidence: 0, activeFactsWithSources: 0 };
        if (hasFacts && hasEvidenceSchema(db)) {
            evidence.factsWithoutLocalEvidence = countFactsWithoutLocalEvidence(db);
            evidence.activeFactsWithSources = count(db, `SELECT COUNT(*) AS c FROM facts
         WHERE is_active = 1 AND source_exchange_ids IS NOT NULL
           AND source_exchange_ids NOT IN ('', '[]')`);
        }
        const attention = readAttention(db);
        const jobs = readJobCounters(db);
        const archiveFiles = countArchiveFiles(getArchiveDir());
        const conversationReady = exchanges > 0;
        const factReady = conversationReady &&
            extraction.pending === 0 &&
            extraction.claimed === 0 &&
            extraction.failedPermanent === 0 &&
            extraction.failedVisible === 0 &&
            embeddings.factVectorsPending === 0;
        // 이슈 #41: parked는 pendingFacts에서 빠진 별도 버킷이다 — graph 준비
        // 여부의 입력이 아니고(무한 재분류를 강요하지 않는다), 대신 status 줄에
        // 자기 이름으로 보고된다. 예전에는 parked가 classified로 집계돼 pending을
        // 0으로 만들어 graph-ready: YES를 만들었다: 같은 YES라도 근거가 다르다.
        const graphReady = factReady && ontology.pendingFacts === 0;
        return {
            dataRootEmpty: false,
            conversations: {
                sessionsIndexed,
                exchanges,
                archiveFiles,
                ready: conversationReady,
            },
            extraction,
            embeddings,
            ontology,
            relations,
            evidence,
            attention,
            jobs,
            derivedLaneSkips: readDerivedLaneSkips(db),
            quarantinedProjects: readQuarantinedProjects(db),
            lifecycleLastEventAt,
            readiness: { conversationReady, factReady, graphReady },
        };
    }
    finally {
        if (ownsDb)
            db.close();
    }
}
/** Zero counters for a data root with no queue table yet. */
export function emptyJobCounters() {
    return { total: 0, byKind: {}, byState: {} };
}
/**
 * Issue #46 (15.2) — the kind × state cross-tab GUIDE §15 documented but no
 * command produced. Read-only single GROUP BY; unknown future kinds and states
 * appear on their own without a code change.
 */
function readJobCounters(db) {
    const counters = emptyJobCounters();
    if (!tableExists(db, "memory_jobs"))
        return counters;
    let rows;
    try {
        rows = db
            .prepare("SELECT kind, state, COUNT(*) AS c FROM memory_jobs GROUP BY kind, state")
            .all();
    }
    catch {
        return counters;
    }
    for (const row of rows) {
        const kind = String(row.kind ?? "unknown");
        const state = String(row.state ?? "unknown");
        const count = Number(row.c ?? 0);
        counters.total += count;
        (counters.byKind[kind] ??= {})[state] = (counters.byKind[kind][state] ?? 0) + count;
        counters.byState[state] = (counters.byState[state] ?? 0) + count;
    }
    return counters;
}
/** Zero counters for a data root with no ontology overlay yet. */
export function emptyOntology() {
    return {
        classifiedFacts: 0,
        pendingFacts: 0,
        parkedFacts: 0,
        parkedRetryable: 0,
        indexRepair: { blocked: false, reason: null, detail: null, detectedAt: null },
    };
}
/**
 * Issue #41: the durable channel for `IndexRepairError`. The message names the
 * next action ("manual repair required") and used to live only in
 * logs/backfill-ontology.log — a file no status command reads.
 */
function readOntologyIndexRepair(db) {
    if (!tableExists(db, "ontology_index_repair_state")) {
        return { blocked: false, reason: null, detail: null, detectedAt: null };
    }
    const row = db
        .prepare("SELECT state, blocked_reason, detail, detected_at FROM ontology_index_repair_state WHERE id = 1")
        .get();
    if (!row || row.state !== "blocked") {
        return { blocked: false, reason: null, detail: null, detectedAt: null };
    }
    return {
        blocked: true,
        reason: row.blocked_reason ?? null,
        detail: row.detail ?? null,
        detectedAt: row.detected_at ?? null,
    };
}
/** Zero counters for a data root with no database yet. */
export function emptyAttention() {
    return {
        total: 0,
        memoryJobsDead: 0,
        memoryJobsRetry: 0,
        memoryJobsBackoff: 0,
        held: 0,
        heldByReason: [],
        modelConfigHeld: 0,
        terminal: {
            checkpointsDeadLetter: 0,
            checkpointsFailedVisible: 0,
            extractionTargetsDead: 0,
            extractionTargetItemsFailedVisible: 0,
            capsuleCheckpointFailedVisible: 0,
            extractionFailedRanges: 0,
            captureGapsOpen: 0,
            modelWorkBudgetsExhausted: 0,
        },
    };
}
/**
 * Issue #39: all eight terminal states, counted. Seven of them had no operator
 * surface at all before this — a stalled pipeline was indistinguishable from an
 * idle one.
 */
function readAttention(db) {
    const attention = emptyAttention();
    const nowIso = new Date().toISOString();
    const stateCount = (table, predicate, ...params) => tableExists(db, table) ? count(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${predicate}`, ...params) : 0;
    attention.memoryJobsDead = stateCount("memory_jobs", "state = 'dead'");
    attention.memoryJobsRetry = stateCount("memory_jobs", "state = 'retry'");
    attention.memoryJobsBackoff = stateCount("memory_jobs", "state = 'retry' AND available_at > ?", nowIso);
    attention.total = attention.memoryJobsDead + attention.memoryJobsRetry;
    // Issues #31/#30. `heldJobSummary` owns the predicate and the reason whitelist,
    // so a new hold family appears here the moment it is added to HOLD_REASONS
    // instead of being silently uncounted. Guarded inside: a pre-0.7.0 database has
    // no `hold_reason` column and returns an empty list.
    attention.heldByReason = heldJobSummary(db);
    attention.held = attention.heldByReason.reduce((sum, row) => sum + row.jobs, 0);
    attention.modelConfigHeld =
        attention.heldByReason.find((row) => row.reason === "model_config_rejected")?.jobs ?? 0;
    attention.terminal = {
        checkpointsDeadLetter: stateCount("checkpoints", "state = 'dead-letter'"),
        checkpointsFailedVisible: stateCount("checkpoints", "state = 'failed-visible'"),
        extractionTargetsDead: stateCount("extraction_targets", "state = 'dead'"),
        extractionTargetItemsFailedVisible: stateCount("extraction_target_items", "state = 'failed-visible'"),
        capsuleCheckpointFailedVisible: stateCount("capsule_checkpoint_state", "state = 'failed-visible'"),
        extractionFailedRanges: stateCount("extraction_failed_ranges", "state = 'failed-visible'"),
        captureGapsOpen: stateCount("capture_gaps", "state = 'open'"),
        modelWorkBudgetsExhausted: stateCount("model_work_budgets", "state = 'exhausted'"),
    };
    return attention;
}
/**
 * #38 — quarantined projects stay listed, never silently dropped: their facts
 * are intact but excluded from injection and read scope until the user acts.
 */
function readQuarantinedProjects(db) {
    if (!tableExists(db, "projects"))
        return [];
    const columns = new Set(db.prepare("PRAGMA table_info(projects)").all().map((r) => r.name));
    if (!columns.has("quarantined"))
        return [];
    return db.prepare(`
    SELECT p.project_id, p.display_name,
           (SELECT COUNT(*) FROM facts f WHERE f.project_id = p.project_id) AS facts
    FROM projects p WHERE p.quarantined = 1 ORDER BY p.project_id
  `).all()
        .map((row) => ({
        projectId: row.project_id,
        displayName: row.display_name,
        facts: Number(row.facts),
    }));
}
/** Privacy-safe: reads only ts/event fields from logs/hook-events.jsonl. */
function readHookEvents() {
    const out = {};
    const base = getMemexHome();
    const file = path.join(base, "logs", "hook-events.jsonl");
    try {
        const lines = fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean);
        for (const line of lines) {
            try {
                const rec = JSON.parse(line);
                if (rec.event && typeof rec.ts === "string")
                    out[rec.event] = rec.ts;
            }
            catch {
                /* skip malformed */
            }
        }
    }
    catch {
        /* no log yet */
    }
    return out;
}
export function formatPipelineStatus(s) {
    const lines = [];
    if (s.dataRootEmpty)
        lines.push("Data root: EMPTY (no index database yet — run: memex sync)");
    else
        lines.push(`Conversations: ${s.conversations.ready ? "READY" : "EMPTY"} (${s.conversations.sessionsIndexed} sessions / ${s.conversations.exchanges} exchanges / ${s.conversations.archiveFiles} archived rollouts)`);
    const ex = s.extraction;
    const parts = [
        `${ex.done} done`,
        `${ex.pending} pending`,
        `${ex.excluded} excluded`,
        `${ex.deferred} deferred`,
        `${ex.claimed} claimed`,
        `${ex.failedPermanent} permanent-failed`,
        `${ex.failedVisible} failed-visible`,
    ];
    if (ex.backoff > 0)
        parts.push(`${ex.backoff} backoff`);
    if (ex.retriable > 0)
        parts.push(`${ex.retriable} retriable`);
    lines.push(`Fact extraction: ${ex.total === 0 ? "EMPTY" : ex.pending === 0 && ex.claimed === 0 && ex.failedPermanent === 0 && ex.failedVisible === 0 ? "DONE" : "PARTIAL"} (${parts.join(", ")})`);
    if (ex.excluded > 0)
        lines.push(`  excluded: intentionally skipped by extraction policy — ${ex.excludedBelowMin} below min-exchanges (BACKFILL_MIN_EXCHANGES=${ex.gateMinExchanges}), ${ex.excludedProject} excluded projects`);
    if (ex.deferred > 0)
        lines.push(`  deferred: exact failed-visible targets (or legacy-only seed/permanent markers) — ${ex.deferred}`);
    if (ex.backoff > 0)
        lines.push(`  backoff: retry backoff not yet elapsed (counted inside pending, no runner holds them) — ${ex.backoff}` +
            (ex.backoffEarliestAt ? `, earliest retry ${ex.backoffEarliestAt}` : ""));
    if (ex.lastSuccessAt)
        lines.push(`  last success: ${ex.lastSuccessAt}`);
    if (ex.lastErrorAt)
        lines.push(`  last failure: ${ex.lastErrorAt}`);
    lines.push(`Embeddings: ${s.embeddings.factVectorsPending === 0 ? "READY" : "PENDING"} (${s.embeddings.activeFacts - s.embeddings.factVectorsPending}/${s.embeddings.activeFacts} active facts vectorized)`);
    lines.push(`Ontology: ${s.ontology.pendingFacts === 0 ? "READY" : "PENDING"} (${s.ontology.classifiedFacts} classified, ${s.ontology.parkedFacts} parked, ${s.ontology.pendingFacts} pending)`);
    if (s.ontology.parkedFacts > 0) {
        lines.push("  parked: held in General/Misc after bounded classification failures — not classified, excluded from the classified count" +
            (s.ontology.parkedRetryable > 0
                ? `; ${s.ontology.parkedRetryable} are owed one retry (runs on the next: memex backfill ontology)`
                : "; retried once per classifier/embedding generation, this generation is spent"));
    }
    if (s.ontology.indexRepair.blocked) {
        lines.push(`  ontology category index: MANUAL REPAIR REQUIRED (${s.ontology.indexRepair.reason ?? "unknown"}` +
            (s.ontology.indexRepair.detectedAt ? `, detected ${s.ontology.indexRepair.detectedAt}` : "") +
            ") — classification is blocked; rebuild vectors: memex backfill embeddings");
    }
    lines.push(`Relations: ${s.relations}`);
    if (s.evidence.factsWithoutLocalEvidence > 0) {
        lines.push(`facts without local evidence: ${s.evidence.factsWithoutLocalEvidence} / ${s.evidence.activeFactsWithSources}`);
        lines.push("  no current local verification receipt — these facts are held back from automatic consolidation; rebuild: memex backfill receipts");
    }
    // Issue #46 (15.2): the per-kind queue breakdown GUIDE §15 asks for. Printed
    // above `Needs attention` because it is the wider view the two dead/retry
    // numbers are a subset of.
    if (s.jobs.total > 0) {
        lines.push(`Memory jobs: ${s.jobs.total}` +
            ` (${Object.entries(s.jobs.byState)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([state, count]) => `${state}=${count}`)
                .join(", ")})`);
        for (const [kind, states] of Object.entries(s.jobs.byKind).sort(([a], [b]) => a.localeCompare(b))) {
            lines.push(`  ${kind}: ${Object.entries(states)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([state, count]) => `${state}=${count}`)
                .join(", ")}`);
        }
    }
    // Issues #20/#39: the actionable count, then the terminal states behind it.
    const a = s.attention;
    lines.push(`Needs attention: ${a.total}` +
        ` (${a.memoryJobsDead} dead, ${a.memoryJobsRetry} retry` +
        (a.memoryJobsBackoff > 0 ? `, of which ${a.memoryJobsBackoff} in backoff` : "") +
        ")");
    if (a.total > 0) {
        lines.push("  inspect: memex jobs list --state dead   recover: memex recover --all-dead   retire: memex jobs dismiss <id> --reason \"...\"");
    }
    // Issues #31/#30: a held job is not a failure, so it gets its own line and its
    // own remedy rather than being folded into the dead/retry count. EVERY hold
    // family is named — an extraction-rules hold stops the entire extraction queue,
    // and reporting only the model family made that look like an idle pipeline.
    if (a.held > 0) {
        const reasons = a.heldByReason.map((row) => `${row.reason}=${row.jobs}`).join(", ");
        const remedies = [
            ...(a.heldByReason.some((row) => row.reason === "model_config_rejected")
                ? ["memex models show"]
                : []),
            ...(a.heldByReason.some((row) => row.reason.startsWith("extraction_rules_"))
                ? ["memex extract rules validate"]
                : []),
        ];
        lines.push(`  config held: ${a.held} job(s) waiting on a configuration (${reasons}) — ` +
            `no attempt was consumed; fix it and they resume automatically: ${remedies.join("  ")}`);
    }
    const terminal = Object.entries(a.terminal).filter(([, count]) => count > 0);
    if (terminal.length > 0) {
        lines.push(`  terminal state: ${terminal.map(([name, count]) => `${name}=${count}`).join(", ")}`);
        if (a.terminal.captureGapsOpen > 0) {
            lines.push(`  capture gaps: ${a.terminal.captureGapsOpen} open — the next successful capture on that session closes them`);
        }
        if (a.terminal.modelWorkBudgetsExhausted > 0) {
            lines.push("  exhausted model-work budgets: memex model-work status");
        }
    }
    // Issue #43: name the pipeline that is holding the derived lanes back.
    if (s.derivedLaneSkips && s.derivedLaneSkips.totalSkips > 0) {
        const skips = s.derivedLaneSkips;
        lines.push(`Derived lanes: skipped ${skips.totalSkips} time${skips.totalSkips === 1 ? "" : "s"} (reason: ${describeDerivedLaneSkipReason(skips.reason)})`);
        lines.push("  derived lanes are consolidation, re-embed, ontology and extraction backfill; P0/P1 (capture index, capsule) outranks them" +
            (skips.lastForcedAt ? `, last forced through ${skips.lastForcedAt}` : "") +
            ". Drain the backlog: memex jobs list --state retry");
    }
    if (s.quarantinedProjects.length > 0) {
        lines.push(`Quarantined projects: ${s.quarantinedProjects.length} (identity came from an untrusted cwd such as '/'; excluded from injection and read scope, facts kept)`);
        for (const p of s.quarantinedProjects) {
            lines.push(`  ${p.projectId} — ${p.displayName} (${p.facts} facts)`);
        }
    }
    for (const [ev, ts] of Object.entries(s.lifecycleLastEventAt)) {
        lines.push(`Lifecycle ${ev}: observed ${ts}`);
    }
    lines.push("");
    lines.push(`conversation-ready: ${s.readiness.conversationReady ? "YES" : "NO"}`);
    lines.push(`fact-ready:         ${s.readiness.factReady ? "YES" : "NO"}`);
    lines.push(`graph-ready:        ${s.readiness.graphReady ? "YES" : "NO"}`);
    if (!s.readiness.factReady &&
        (s.extraction.failedPermanent > 0 || s.extraction.failedVisible > 0)) {
        lines.push("NOTE: permanent or failed-visible extraction ranges exist — overall readiness stays PARTIAL until they are resolved.");
    }
    return lines.join("\n");
}
