import fs from "fs";
import path from "path";
import { initDatabase, getVecTableDtype, embeddingToVecBlob, vecParamSql, hashRecallPrompt, } from "./db.js";
import { generateEmbedding, initEmbeddings, EMBEDDING_VERSION, } from "./embeddings.js";
import { getSyncDir } from "./sync-export.js";
import { canonicalizeProjectPath } from "./project-identity.js";
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
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function compareTimestamps(a, b) {
    return Math.sign(Date.parse(a) - Date.parse(b));
}
function isStringArrayJson(value) {
    if (typeof value !== "string")
        return false;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === "string");
    }
    catch {
        return false;
    }
}
function readJsonLines(filePath) {
    if (!fs.existsSync(filePath))
        return [];
    const rows = [];
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim())
            continue;
        try {
            rows.push(JSON.parse(line));
        }
        catch {
            // Malformed external rows remain uncommitted. A later complete sync can retry.
        }
    }
    return rows;
}
function getPayloadDirs(syncDir) {
    const dirs = [syncDir];
    const devicesDir = path.join(syncDir, "devices");
    if (!fs.existsSync(devicesDir))
        return dirs;
    for (const entry of fs.readdirSync(devicesDir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        dirs.push(path.join(devicesDir, entry.name));
    }
    return dirs;
}
function canonicalScopeProject(scopeType, scopeProject) {
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
function parseSyncFact(value) {
    if (!isRecord(value))
        return null;
    if (typeof value.id !== "string" || !value.id ||
        typeof value.fact !== "string" || !value.fact ||
        typeof value.category !== "string" || !ALLOWED_CATEGORIES.has(value.category) ||
        (value.scope_type !== "project" && value.scope_type !== "global") ||
        !isStringArrayJson(value.source_exchange_ids) ||
        !isTimestamp(value.created_at) || !isTimestamp(value.updated_at) ||
        !Number.isInteger(value.consolidated_count) || Number(value.consolidated_count) < 0 ||
        (value.is_active !== undefined && value.is_active !== 0 && value.is_active !== 1) ||
        (value.fact_kr !== undefined && value.fact_kr !== null && typeof value.fact_kr !== "string") ||
        (value.ontology_category_id !== undefined && value.ontology_category_id !== null &&
            typeof value.ontology_category_id !== "string"))
        return null;
    const scopeProject = canonicalScopeProject(value.scope_type, value.scope_project);
    if (scopeProject === undefined)
        return null;
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
        consolidated_count: Number(value.consolidated_count),
        // Protocol v1 payloads omitted is_active because they exported active rows only.
        is_active: value.is_active === 0 ? 0 : 1,
        ontology_category_id: typeof value.ontology_category_id === "string"
            ? value.ontology_category_id
            : null,
    };
}
function parseTombstone(value) {
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
function parseRevision(value) {
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
function parseRecallEvent(value) {
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
    if (value.source_type !== undefined && value.source_type !== "memex_recall")
        return null;
    if (value.learnable !== undefined && value.learnable !== 0 && value.learnable !== false)
        return null;
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
function factConflictKey(fact) {
    // Inactive state wins exact-time ties. Remaining fields use canonical JSON
    // lexical order so every device independently selects the same winner.
    return JSON.stringify([
        fact.is_active === 0 ? 1 : 0,
        fact.fact,
        fact.fact_kr,
        fact.category,
        fact.scope_type,
        fact.scope_project,
        fact.source_exchange_ids,
        fact.consolidated_count,
        fact.ontology_category_id,
        fact.created_at,
    ]);
}
function remoteFactWins(remote, local) {
    const time = compareTimestamps(remote.updated_at, local.updated_at);
    return time > 0 || (time === 0 && factConflictKey(remote) > factConflictKey(local));
}
function rowToSyncFact(row) {
    return {
        id: row.id,
        fact: row.fact,
        fact_kr: row.fact_kr ?? null,
        category: row.category,
        scope_type: row.scope_type,
        scope_project: row.scope_project ?? null,
        source_exchange_ids: row.source_exchange_ids ?? "[]",
        created_at: row.created_at,
        updated_at: row.updated_at,
        consolidated_count: Number(row.consolidated_count),
        is_active: Number(row.is_active) === 0 ? 0 : 1,
        ontology_category_id: row.ontology_category_id ?? null,
    };
}
function deleteFactState(db, factId) {
    db.prepare("DELETE FROM vec_facts WHERE id = ?").run(factId);
    db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(factId);
    db.prepare("DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?")
        .run(factId, factId);
    db.prepare("DELETE FROM fact_revisions WHERE fact_id = ?").run(factId);
    db.prepare("DELETE FROM facts WHERE id = ?").run(factId);
}
function importOntology(db, payloadDirs, result) {
    for (const payloadDir of payloadDirs) {
        for (const value of readJsonLines(path.join(payloadDir, "ontology-domains.jsonl"))) {
            if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
                typeof value.name !== "string" || !value.name)
                continue;
            if (db.prepare("SELECT 1 FROM ontology_domains WHERE id = ?").get(value.id))
                continue;
            db.prepare("INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)").run(value.id, value.name, typeof value.description === "string" ? value.description : null, isTimestamp(value.created_at) ? value.created_at : new Date().toISOString());
            result.newDomains++;
        }
    }
    for (const payloadDir of payloadDirs) {
        for (const value of readJsonLines(path.join(payloadDir, "ontology-categories.jsonl"))) {
            if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
                typeof value.domain_id !== "string" || !value.domain_id ||
                typeof value.name !== "string" || !value.name)
                continue;
            if (!db.prepare("SELECT 1 FROM ontology_domains WHERE id = ?").get(value.domain_id))
                continue;
            if (db.prepare("SELECT 1 FROM ontology_categories WHERE id = ?").get(value.id))
                continue;
            db.prepare("INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)").run(value.id, value.domain_id, value.name, typeof value.description === "string" ? value.description : null, isTimestamp(value.created_at) ? value.created_at : new Date().toISOString());
            result.newCategories++;
        }
    }
}
function importTombstones(db, payloadDirs, result) {
    const byFact = new Map();
    for (const payloadDir of payloadDirs) {
        for (const value of readJsonLines(path.join(payloadDir, "fact-tombstones.jsonl"))) {
            const row = parseTombstone(value);
            if (!row)
                continue;
            const previous = byFact.get(row.fact_id);
            if (!previous || compareTimestamps(row.deleted_at, previous.deleted_at) > 0) {
                byFact.set(row.fact_id, row);
            }
        }
    }
    for (const tombstone of byFact.values()) {
        const localFact = db.prepare("SELECT updated_at FROM facts WHERE id = ?").get(tombstone.fact_id);
        const localTombstone = db.prepare("SELECT deleted_at FROM fact_tombstones WHERE fact_id = ?").get(tombstone.fact_id);
        if (localTombstone && compareTimestamps(localTombstone.deleted_at, tombstone.deleted_at) >= 0)
            continue;
        // A fact event strictly newer than the deletion is a later restore/edit.
        if (localFact && compareTimestamps(localFact.updated_at, tombstone.deleted_at) > 0)
            continue;
        const commit = db.transaction(() => {
            const existed = !!db.prepare("SELECT 1 FROM facts WHERE id = ?").get(tombstone.fact_id);
            deleteFactState(db, tombstone.fact_id);
            db.prepare(`
        INSERT INTO fact_tombstones (fact_id, deleted_at, reason)
        VALUES (?, ?, ?)
        ON CONFLICT(fact_id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason
      `).run(tombstone.fact_id, tombstone.deleted_at, tombstone.reason);
            return existed;
        });
        if (commit())
            result.deletedFacts++;
        result.newTombstones++;
    }
}
async function importFacts(db, payloadDirs, result) {
    const candidates = [];
    const remoteById = new Map();
    for (const payloadDir of payloadDirs) {
        for (const value of readJsonLines(path.join(payloadDir, "facts.jsonl"))) {
            const fact = parseSyncFact(value);
            if (!fact)
                continue;
            const previous = remoteById.get(fact.id);
            if (!previous || remoteFactWins(fact, previous))
                remoteById.set(fact.id, fact);
        }
    }
    for (const fact of remoteById.values()) {
        if (fact.ontology_category_id &&
            !db.prepare("SELECT 1 FROM ontology_categories WHERE id = ?").get(fact.ontology_category_id)) {
            continue;
        }
        const localTombstone = db.prepare("SELECT deleted_at FROM fact_tombstones WHERE fact_id = ?").get(fact.id);
        // Hard delete wins a timestamp tie; only a strictly newer fact can restore.
        if (localTombstone && compareTimestamps(localTombstone.deleted_at, fact.updated_at) >= 0)
            continue;
        const localRow = db.prepare(`
      SELECT id, fact, fact_kr, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, is_active, ontology_category_id
      FROM facts WHERE id = ?
    `).get(fact.id);
        if (localRow && !remoteFactWins(fact, rowToSyncFact(localRow)))
            continue;
        candidates.push({ fact, exists: !!localRow });
    }
    if (candidates.length === 0)
        return;
    await initEmbeddings();
    for (const candidate of candidates) {
        const { fact } = candidate;
        try {
            // Generate before the transaction. Failure leaves the whole fact
            // retryable instead of committing a permanently vectorless row.
            const embedding = await generateEmbedding(fact.fact);
            const embeddingKr = fact.fact_kr ? await generateEmbedding(fact.fact_kr) : null;
            const commit = db.transaction(() => {
                db.prepare("DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?")
                    .run(fact.id, fact.id);
                db.prepare("DELETE FROM fact_tombstones WHERE fact_id = ?").run(fact.id);
                if (candidate.exists) {
                    db.prepare(`
            UPDATE facts SET
              fact = ?, fact_kr = ?, category = ?, scope_type = ?, scope_project = ?,
              source_exchange_ids = ?, embedding = ?, created_at = ?, updated_at = ?,
              consolidated_count = ?, is_active = ?, ontology_category_id = ?,
              embedding_version = ?, ontology_attempts = 0, consolidation_attempts = 0,
              needs_consolidation = ?, ontology_last_attempt_at = NULL
            WHERE id = ?
          `).run(fact.fact, fact.fact_kr, fact.category, fact.scope_type, fact.scope_project, fact.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer), fact.created_at, fact.updated_at, fact.consolidated_count, fact.is_active, fact.ontology_category_id, EMBEDDING_VERSION, fact.is_active, fact.id);
                }
                else {
                    db.prepare(`
            INSERT INTO facts
              (id, fact, fact_kr, category, scope_type, scope_project, source_exchange_ids,
               embedding, created_at, updated_at, consolidated_count, is_active,
               ontology_category_id, embedding_version, needs_consolidation)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fact.id, fact.fact, fact.fact_kr, fact.category, fact.scope_type, fact.scope_project, fact.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer), fact.created_at, fact.updated_at, fact.consolidated_count, fact.is_active, fact.ontology_category_id, EMBEDDING_VERSION, fact.is_active);
                }
                db.prepare("DELETE FROM vec_facts WHERE id = ?").run(fact.id);
                db.prepare("DELETE FROM vec_facts_kr WHERE id = ?").run(fact.id);
                if (fact.is_active === 1) {
                    const primaryDtype = getVecTableDtype(db, "vec_facts");
                    db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(primaryDtype)})`).run(fact.id, embeddingToVecBlob(embedding, primaryDtype));
                    if (fact.fact_kr && embeddingKr) {
                        const koreanDtype = getVecTableDtype(db, "vec_facts_kr");
                        db.prepare(`INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${vecParamSql(koreanDtype)})`).run(fact.id, embeddingToVecBlob(embeddingKr, koreanDtype));
                    }
                }
            });
            commit();
            if (candidate.exists)
                result.updatedFacts++;
            else
                result.newFacts++;
        }
        catch (error) {
            console.error(`sync-import: failed to reconcile fact ${fact.id}:`, error instanceof Error ? error.message : error);
        }
    }
}
function importRevisions(db, payloadDirs, result) {
    for (const payloadDir of payloadDirs) {
        for (const value of readJsonLines(path.join(payloadDir, "fact-revisions.jsonl"))) {
            const revision = parseRevision(value);
            if (!revision || !db.prepare("SELECT 1 FROM facts WHERE id = ?").get(revision.fact_id) ||
                db.prepare("SELECT 1 FROM fact_revisions WHERE id = ?").get(revision.id))
                continue;
            db.prepare(`
        INSERT INTO fact_revisions
          (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(revision.id, revision.fact_id, revision.previous_fact, revision.new_fact, revision.reason, revision.source_exchange_id, revision.created_at);
            result.newRevisions++;
        }
    }
}
function importRecallEvents(db, payloadDirs, result) {
    for (const payloadDir of payloadDirs) {
        for (const value of readJsonLines(path.join(payloadDir, "recall-events.jsonl"))) {
            const event = parseRecallEvent(value);
            if (!event)
                continue;
            const existing = db.prepare("SELECT status FROM recall_events WHERE id = ?").get(event.id);
            if (!existing) {
                db.prepare(`
          INSERT INTO recall_events
            (id, session_id, project, prompt_hash, fact_ids, source_type, learnable,
             status, created_at, emitted_at)
          VALUES (?, ?, ?, ?, ?, 'memex_recall', 0, ?, ?, ?)
        `).run(event.id, event.session_id, event.project, event.prompt_hash, event.fact_ids, event.status, event.created_at, event.emitted_at);
                result.newRecallEvents++;
            }
            else if (existing.status === "prepared" && event.status === "emitted") {
                db.prepare("UPDATE recall_events SET status = 'emitted', emitted_at = ? WHERE id = ?")
                    .run(event.emitted_at ?? event.created_at, event.id);
                result.updatedRecallEvents++;
            }
            // A prepared receipt proves durable intent, not stdout emission. Only an
            // emitted receipt can mark an exchange as recalled; this matches
            // insertExchange while preserving order independence across sync/rebuild.
            const stored = db.prepare("SELECT status FROM recall_events WHERE id = ?")
                .get(event.id);
            if (stored?.status !== "emitted")
                continue;
            const exchanges = db.prepare("SELECT id, user_message, provenance FROM exchanges WHERE session_id = ?").all(event.session_id);
            for (const exchange of exchanges) {
                if (hashRecallPrompt(exchange.user_message) !== event.prompt_hash)
                    continue;
                let provenance = [];
                try {
                    const parsed = JSON.parse(exchange.provenance);
                    if (Array.isArray(parsed)) {
                        provenance = parsed.filter((item) => typeof item === "string");
                    }
                }
                catch {
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
function importRelations(db, payloadDirs, result) {
    for (const payloadDir of payloadDirs) {
        for (const value of readJsonLines(path.join(payloadDir, "ontology-relations.jsonl"))) {
            if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
                typeof value.source_fact_id !== "string" || !value.source_fact_id ||
                typeof value.target_fact_id !== "string" || !value.target_fact_id ||
                typeof value.relation_type !== "string" || !ALLOWED_RELATION_TYPES.has(value.relation_type)) {
                continue;
            }
            const source = db.prepare("SELECT scope_type, scope_project, updated_at FROM facts WHERE id = ?").get(value.source_fact_id);
            const target = db.prepare("SELECT scope_type, scope_project, updated_at FROM facts WHERE id = ?").get(value.target_fact_id);
            if (!source || !target ||
                (source.scope_type === "project" && target.scope_type === "project" &&
                    source.scope_project !== target.scope_project) ||
                db.prepare("SELECT 1 FROM ontology_relations WHERE id = ?").get(value.id)) {
                continue;
            }
            const relationCreatedAt = isTimestamp(value.created_at) ? value.created_at : null;
            const sourceVersion = isTimestamp(value.source_fact_updated_at)
                ? value.source_fact_updated_at
                : null;
            const targetVersion = isTimestamp(value.target_fact_updated_at)
                ? value.target_fact_updated_at
                : null;
            if ((sourceVersion && compareTimestamps(sourceVersion, source.updated_at) !== 0) ||
                (targetVersion && compareTimestamps(targetVersion, target.updated_at) !== 0) ||
                (!sourceVersion && relationCreatedAt && compareTimestamps(relationCreatedAt, source.updated_at) < 0) ||
                (!targetVersion && relationCreatedAt && compareTimestamps(relationCreatedAt, target.updated_at) < 0))
                continue;
            try {
                db.prepare(`
          INSERT INTO ontology_relations
            (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(value.id, value.source_fact_id, value.relation_type, value.target_fact_id, typeof value.reasoning === "string" ? value.reasoning : null, relationCreatedAt ?? new Date().toISOString());
                result.newRelations++;
            }
            catch {
                // Duplicate triple under a different id or another local invariant.
            }
        }
    }
}
/**
 * Reconcile protocol-v2 sync files into the local DB.
 *
 * Conflict order: event timestamp, then a deterministic canonical fact key;
 * hard-delete tombstones win exact-time ties. Source-created timestamps remain
 * historical data and are never used as local processing cursors.
 */
export async function importFromSync() {
    const result = {
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
    };
    const syncDir = getSyncDir();
    const payloadDirs = getPayloadDirs(syncDir);
    if (!payloadDirs.some((dir) => fs.existsSync(path.join(dir, "facts.jsonl"))))
        return result;
    const db = initDatabase();
    try {
        importOntology(db, payloadDirs, result);
        importTombstones(db, payloadDirs, result);
        await importFacts(db, payloadDirs, result);
        importRevisions(db, payloadDirs, result);
        importRecallEvents(db, payloadDirs, result);
        importRelations(db, payloadDirs, result);
        return result;
    }
    finally {
        db.close();
    }
}
