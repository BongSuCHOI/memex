import fs from "node:fs";
import { openReadDb } from "./db.js";
import { EMBEDDING_VERSION } from "./embeddings.js";
import { getDbPath } from "./paths.js";
import { EXTRACTION_STATE, getExtractionConfig, pendingExtractionCoreQuery, } from "./pending-extraction.js";
import { getPipelineStatus } from "./pipeline-status.js";
import { buildCategoryReembedPending, buildFactReembedPending, buildReembedPending, } from "./reembed-selector.js";
function tableExists(db, name) {
    return db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
        .get(name) !== undefined;
}
function count(db, sql, ...params) {
    return Number(db.prepare(sql).get(...params).n);
}
export function getBackfillWorkStatus(opts = {}) {
    const dbPath = opts.dbPath ?? getDbPath();
    const empty = {
        total: 0,
        stages: { extract: 0, ontology: 0, embeddings: 0 },
        active: { total: 0, extract: 0 },
        unresolved: {
            total: 0,
            extract: 0,
            failedVisibleRanges: 0,
            legacyPermanentSessions: 0,
        },
        details: {
            extractionSessions: 0,
            ontologyFacts: 0,
            relationTargets: 0,
            categoryVectors: 0,
            factVectors: 0,
            koreanFactVectors: 0,
            exchangeVectors: 0,
        },
    };
    if (!fs.existsSync(dbPath))
        return empty;
    const db = openReadDb(dbPath);
    try {
        db.exec("BEGIN");
        const pipeline = getPipelineStatus({ dbPath, db });
        const pendingExtraction = tableExists(db, "exchange_extraction_state")
            ? pendingExtractionCoreQuery(getExtractionConfig(), "continuity")
            : null;
        let extractionSessions = pipeline.extraction.pending;
        let activeExtractionSessions = pipeline.extraction.claimed;
        if (pendingExtraction && tableExists(db, "memory_jobs")) {
            const row = db
                .prepare(`SELECT COUNT(*) AS pending,
                  COALESCE(SUM(CASE WHEN EXISTS (
                    SELECT 1 FROM memory_jobs j
                    WHERE j.kind = 'fact_extract'
                      AND j.partition_key = 'session:' || p.sid
                      AND j.state = 'running' AND j.lease_until > ?
                  ) THEN 1 ELSE 0 END), 0) AS active
           FROM (${pendingExtraction.sql}) p`)
                .get(new Date().toISOString(), ...pendingExtraction.params);
            activeExtractionSessions = Number(row.active);
            extractionSessions = Math.max(0, Number(row.pending) - activeExtractionSessions);
        }
        const failedVisibleRanges = tableExists(db, "extraction_failed_ranges")
            ? count(db, `SELECT COUNT(*) AS n FROM extraction_failed_ranges
           WHERE state = 'failed-visible'`)
            : 0;
        const legacyPermanentSessions = tableExists(db, "extraction_log")
            ? count(db, `SELECT COUNT(*) AS n FROM extraction_log l
           WHERE l.extracted = ?
             ${pendingExtraction
                ? `AND NOT EXISTS (
                    SELECT 1 FROM (${pendingExtraction.sql}) p
                    WHERE p.sid = l.session_id
                  )`
                : ""}
             ${tableExists(db, "extraction_targets") && tableExists(db, "extraction_failed_ranges")
                ? `AND NOT EXISTS (
                    SELECT 1
                    FROM extraction_targets t
                    JOIN extraction_failed_ranges r ON r.target_id = t.target_id
                    WHERE t.session_id = l.session_id
                      AND r.state = 'failed-visible'
                  )`
                : ""}`, EXTRACTION_STATE.PERMANENT, ...(pendingExtraction?.params ?? []))
            : 0;
        const ontologyFacts = pipeline.ontology.pendingFacts;
        const relationTargets = tableExists(db, "model_work_targets")
            ? count(db, `SELECT COUNT(*) AS n
           FROM model_work_targets t
           JOIN facts f ON f.id = t.target_id
           WHERE t.stage = 'relation' AND t.state = 'pending'
             AND f.is_active = 1`)
            : 0;
        let categoryVectors = 0;
        if (tableExists(db, "ontology_categories") &&
            tableExists(db, "vec_categories_rowids")) {
            const pending = buildCategoryReembedPending(EMBEDDING_VERSION);
            categoryVectors = count(db, `SELECT COUNT(*) AS n FROM ontology_categories c WHERE ${pending.clause}`, ...pending.params);
        }
        let factVectors = 0;
        let koreanFactVectors = 0;
        if (tableExists(db, "facts")) {
            if (tableExists(db, "vec_facts_rowids")) {
                const pending = buildFactReembedPending(EMBEDDING_VERSION);
                factVectors = count(db, `SELECT COUNT(*) AS n FROM facts f WHERE ${pending.clause}`, ...pending.params);
            }
            else {
                factVectors = count(db, "SELECT COUNT(*) AS n FROM facts WHERE is_active = 1");
            }
            koreanFactVectors = tableExists(db, "vec_facts_kr_rowids")
                ? count(db, `SELECT COUNT(*) AS n FROM facts f
             WHERE f.is_active = 1 AND f.fact_kr IS NOT NULL AND f.fact_kr != ''
               AND NOT EXISTS (
                 SELECT 1 FROM vec_facts_kr_rowids v WHERE v.id = f.id
               )`)
                : count(db, `SELECT COUNT(*) AS n FROM facts
             WHERE is_active = 1 AND fact_kr IS NOT NULL AND fact_kr != ''`);
        }
        let exchangeVectors = 0;
        if (tableExists(db, "exchanges") &&
            tableExists(db, "vec_exchanges_rowids")) {
            const pending = buildReembedPending(EMBEDDING_VERSION);
            exchangeVectors = count(db, `SELECT COUNT(*) AS n FROM exchanges e WHERE ${pending.clause}`, ...pending.params);
        }
        const stages = {
            extract: extractionSessions,
            ontology: ontologyFacts + relationTargets,
            embeddings: categoryVectors + factVectors + koreanFactVectors + exchangeVectors,
        };
        const status = {
            total: stages.extract + stages.ontology + stages.embeddings,
            stages,
            active: {
                total: activeExtractionSessions,
                extract: activeExtractionSessions,
            },
            unresolved: {
                total: failedVisibleRanges + legacyPermanentSessions,
                extract: failedVisibleRanges + legacyPermanentSessions,
                failedVisibleRanges,
                legacyPermanentSessions,
            },
            details: {
                extractionSessions,
                ontologyFacts,
                relationTargets,
                categoryVectors,
                factVectors,
                koreanFactVectors,
                exchangeVectors,
            },
        };
        db.exec("COMMIT");
        return status;
    }
    catch (error) {
        if (db.inTransaction)
            db.exec("ROLLBACK");
        throw error;
    }
    finally {
        db.close();
    }
}
