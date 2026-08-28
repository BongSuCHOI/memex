/**
 * CX-04 — pipeline readiness & backfill observability.
 *
 * READ-ONLY by contract: status opens the database readonly, never spawns
 * workers, never calls the LLM, never mutates anything. Readiness is derived
 * from ledger/table state, not from file existence or live PIDs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openReadDb } from "./db.js";
import {
  getDbPath,
  getArchiveDir,
  getMemexHome,
  llmWorkdirCwdSql,
} from "./paths.js";
import {
  EXTRACTION_STATE,
  freshClaimPredicate,
  getExtractionConfig,
} from "./pending-extraction.js";

export interface StageCounters {
  total: number;
  done: number;
  pending: number;
  /** Sessions the worker deliberately never picks (policy gate, not work). */
  excluded: number;
  /** …of which below BACKFILL_MIN_EXCHANGES. */
  excludedBelowMin: number;
  /** …of which in excluded/LLM-workdir projects. */
  excludedProject: number;
  /** The configured min-exchange gate value, shown for actionability. */
  gateMinExchanges: number;
  claimed: number;
  failedPermanent: number;
  retriable: number;
}

export interface PipelineStatus {
  dataRootEmpty: boolean;
  conversations: {
    sessionsIndexed: number;
    exchanges: number;
    archiveFiles: number;
    ready: boolean;
  };
  extraction: StageCounters & {
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
  };
  embeddings: { activeFacts: number; factVectorsPending: number };
  ontology: { classifiedFacts: number; pendingFacts: number };
  relations: number;
  lifecycleLastEventAt: Partial<Record<string, string>>;
  readiness: {
    conversationReady: boolean;
    factReady: boolean;
    graphReady: boolean;
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) !== undefined
  );
}

function count(
  db: Database.Database,
  sql: string,
  ...params: unknown[]
): number {
  const row = db.prepare(sql).get(...params) as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

/** Recursively count rollout/summary files under the archive root. */
function countArchiveFiles(archiveDir: string): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".jsonl")) n++;
    }
  };
  walk(archiveDir);
  return n;
}

export function getPipelineStatus(
  opts: { dbPath?: string } = {},
): PipelineStatus {
  const dbPath = opts.dbPath ?? getDbPath();
  const dbExists = fs.existsSync(dbPath);
  // Worker eligibility config — shared source with backfill-extract-worker
  // (pendingExtractionCoreQuery) so status counts what the pipeline does.
  const extractionGate = getExtractionConfig();

  // Lifecycle observation log lives outside the DB and is always safe to read.
  const lifecycleLastEventAt: Partial<Record<string, string>> =
    readHookEvents();

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
        gateMinExchanges: extractionGate.minExchanges,
        claimed: 0,
        failedPermanent: 0,
        retriable: 0,
        lastSuccessAt: null,
        lastErrorAt: null,
      },
      embeddings: { activeFacts: 0, factVectorsPending: 0 },
      ontology: { classifiedFacts: 0, pendingFacts: 0 },
      relations: 0,
      lifecycleLastEventAt,
      readiness: {
        conversationReady: false,
        factReady: false,
        graphReady: false,
      },
    };
  }

  const db = openReadDb(dbPath);
  try {
    const hasExchanges = tableExists(db, "exchanges");
    const hasExtractionLog = tableExists(db, "extraction_log");
    const hasFacts = tableExists(db, "facts");
    const hasRelations = tableExists(db, "ontology_relations");

    const exchanges = hasExchanges
      ? count(db, "SELECT COUNT(*) AS c FROM exchanges")
      : 0;
    const sessionsIndexed = hasExchanges
      ? count(
          db,
          "SELECT COUNT(DISTINCT session_id) AS c FROM exchanges WHERE session_id IS NOT NULL AND is_sidechain = 0",
        )
      : 0;

    // ── Extraction stage counters ────────────────────────────────────────
    let extraction: PipelineStatus["extraction"] = {
      total: 0,
      done: 0,
      pending: 0,
      excluded: 0,
      excludedBelowMin: 0,
      excludedProject: 0,
      gateMinExchanges: extractionGate.minExchanges,
      claimed: 0,
      failedPermanent: 0,
      retriable: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
    };
    if (hasExchanges && hasExtractionLog) {
      const total = count(
        db,
        "SELECT COUNT(DISTINCT session_id) AS c FROM exchanges WHERE session_id IS NOT NULL AND is_sidechain = 0",
      );
      // done = settled success rows (extracted >= 0).
      const done = count(
        db,
        `
        SELECT COUNT(*) AS c FROM extraction_log
        WHERE extracted >= 0`,
      );
      const permanent = count(
        db,
        "SELECT COUNT(*) AS c FROM extraction_log WHERE extracted = ?",
        EXTRACTION_STATE.PERMANENT,
      );
      const retriable = count(
        db,
        `SELECT COUNT(*) AS c FROM extraction_log WHERE extracted = ?
        AND saved < 3`,
        EXTRACTION_STATE.RETRIABLE_INTERNAL,
      );
      const claimedFresh = count(
        db,
        `SELECT COUNT(*) AS c FROM extraction_log
        WHERE extracted = ? AND ${freshClaimPredicate()}`,
        EXTRACTION_STATE.CLAIMED,
      );
      // Pending = sessions with exchanges lacking a settled extraction_log row.
      const settledSessions = count(
        db,
        `
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
        )`,
        EXTRACTION_STATE.PERMANENT,
        EXTRACTION_STATE.CLAIMED,
      );
      const times = db
        .prepare(`
        SELECT
          MAX(CASE WHEN extracted >= 0 THEN processed_at END) AS lastOk,
          MAX(CASE WHEN extracted < 0 THEN processed_at END) AS lastErr
        FROM extraction_log`)
        .get() as { lastOk: string | null; lastErr: string | null };

      // Sessions the worker deliberately never picks: markerless sessions
      // below BACKFILL_MIN_EXCHANGES or in excluded/LLM-workdir projects.
      // Mirrors pendingExtractionCoreQuery's gate (including its any-exchange
      // cwd pollution check) so pending means exactly "work the pipeline will
      // actually do" — excluded sessions stay visible under their own name.
      const exTerms: string[] = extractionGate.excludeProjects;
      // llmWorkdirCwdSql keeps status's pollution shape identical to the
      // worker's (pendingExtractionCoreQuery) — basename + mkdtemp suffix form.
      const pollutionClause = `${llmWorkdirCwdSql("x.cwd")}${
        exTerms.length
          ? " OR " + exTerms.map(() => "x.cwd = ?").join(" OR ")
          : ""
      }`;
      const gateRow = db
        .prepare(
          `
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
            AND l.session_id IS NULL
          GROUP BY e.session_id
          HAVING COUNT(*) < ? OR polluted = 1
        ) g`,
        )
        .get(...exTerms, extractionGate.minExchanges) as {
        c: number;
        byProject: number;
        belowMin: number;
      };
      const excludedSessions = Number(gateRow.c);

      extraction = {
        total,
        done,
        pending: Math.max(0, total - settledSessions - excludedSessions),
        excluded: excludedSessions,
        excludedBelowMin: Number(gateRow.belowMin),
        excludedProject: Number(gateRow.byProject),
        gateMinExchanges: extractionGate.minExchanges,
        claimed: claimedFresh,
        failedPermanent: permanent,
        retriable,
        lastSuccessAt: times.lastOk,
        lastErrorAt: times.lastErr,
      };
    }

    // ── Embeddings / ontology / relations ────────────────────────────────
    const embeddings = { activeFacts: 0, factVectorsPending: 0 };
    const ontology = { classifiedFacts: 0, pendingFacts: 0 };
    let relations = 0;
    if (hasFacts) {
      embeddings.activeFacts = count(
        db,
        "SELECT COUNT(*) AS c FROM facts WHERE is_active = 1",
      );
      if (tableExists(db, "vec_facts")) {
        embeddings.factVectorsPending = count(
          db,
          `
          SELECT COUNT(*) AS c FROM facts f
          WHERE f.is_active = 1
            AND NOT EXISTS (SELECT 1 FROM vec_facts v WHERE v.id = f.id)`,
        );
      } else {
        // Missing table: report every active fact as vector-pending.
        embeddings.factVectorsPending = embeddings.activeFacts;
      }
      ontology.classifiedFacts = count(
        db,
        "SELECT COUNT(*) AS c FROM facts WHERE is_active = 1 AND ontology_category_id IS NOT NULL",
      );
      ontology.pendingFacts = embeddings.activeFacts - ontology.classifiedFacts;
    }
    if (hasRelations)
      relations = count(db, "SELECT COUNT(*) AS c FROM ontology_relations");

    const archiveFiles = countArchiveFiles(getArchiveDir());
    const conversationReady = exchanges > 0;
    const factReady =
      conversationReady &&
      extraction.pending === 0 &&
      extraction.claimed === 0 &&
      extraction.failedPermanent === 0 &&
      embeddings.factVectorsPending === 0;
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
      lifecycleLastEventAt,
      readiness: { conversationReady, factReady, graphReady },
    };
  } finally {
    db.close();
  }
}

/** Privacy-safe: reads only ts/event fields from logs/hook-events.jsonl. */
function readHookEvents(): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
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
        if (rec.event && typeof rec.ts === "string") out[rec.event] = rec.ts;
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* no log yet */
  }
  return out;
}

export function formatPipelineStatus(s: PipelineStatus): string {
  const lines: string[] = [];
  if (s.dataRootEmpty)
    lines.push("Data root: EMPTY (no index database yet — run: memex sync)");
  else
    lines.push(
      `Conversations: ${s.conversations.ready ? "READY" : "EMPTY"} (${s.conversations.sessionsIndexed} sessions / ${s.conversations.exchanges} exchanges / ${s.conversations.archiveFiles} archived rollouts)`,
    );

  const ex = s.extraction;
  const parts = [
    `${ex.done} done`,
    `${ex.pending} pending`,
    `${ex.excluded} excluded`,
    `${ex.claimed} claimed`,
    `${ex.failedPermanent} permanent-failed`,
  ];
  if (ex.retriable > 0) parts.push(`${ex.retriable} retriable`);
  lines.push(
    `Fact extraction: ${ex.total === 0 ? "EMPTY" : ex.pending === 0 && ex.claimed === 0 && ex.failedPermanent === 0 ? "DONE" : "PARTIAL"} (${parts.join(", ")})`,
  );
  if (ex.excluded > 0)
    lines.push(
      `  excluded: intentionally skipped by extraction policy — ${ex.excludedBelowMin} below min-exchanges (BACKFILL_MIN_EXCHANGES=${ex.gateMinExchanges}), ${ex.excludedProject} excluded projects`,
    );
  if (ex.lastSuccessAt) lines.push(`  last success: ${ex.lastSuccessAt}`);
  if (ex.lastErrorAt) lines.push(`  last failure: ${ex.lastErrorAt}`);

  lines.push(
    `Embeddings: ${s.embeddings.factVectorsPending === 0 ? "READY" : "PENDING"} (${s.embeddings.activeFacts - s.embeddings.factVectorsPending}/${s.embeddings.activeFacts} active facts vectorized)`,
  );
  lines.push(
    `Ontology: ${s.ontology.pendingFacts === 0 ? "READY" : "PENDING"} (${s.ontology.classifiedFacts} classified, ${s.ontology.pendingFacts} pending)`,
  );
  lines.push(`Relations: ${s.relations}`);

  for (const [ev, ts] of Object.entries(s.lifecycleLastEventAt)) {
    lines.push(`Lifecycle ${ev}: observed ${ts}`);
  }

  lines.push("");
  lines.push(
    `conversation-ready: ${s.readiness.conversationReady ? "YES" : "NO"}`,
  );
  lines.push(`fact-ready:         ${s.readiness.factReady ? "YES" : "NO"}`);
  lines.push(`graph-ready:        ${s.readiness.graphReady ? "YES" : "NO"}`);
  if (!s.readiness.factReady && s.extraction.failedPermanent > 0) {
    lines.push(
      "NOTE: permanent extraction failures exist — overall readiness stays PARTIAL until they are resolved.",
    );
  }
  return lines.join("\n");
}
