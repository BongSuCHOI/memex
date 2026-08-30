import fs from "fs";
import path from "path";
import { initDatabase, getVecTableDtype, embeddingToVecBlob, vecParamSql, hashRecallPrompt, } from "./db.js";
import { generateEmbedding, initEmbeddings, EMBEDDING_VERSION, } from "./embeddings.js";
import { getSyncDir, SYNC_PAYLOAD_FILE_NAMES, countPayloadRows, payloadSha256, } from "./sync-export.js";
import { canonicalizeProjectPath } from "./project-identity.js";
import { PRIVACY_TOMBSTONE_REASON } from "./conversation-policy.js";
import { applyReplicatedLifecycle, compareTimestamps } from "./fact-management.js";
const ALLOWED_CATEGORIES = new Set([
    "decision",
    "preference",
    "pattern",
    "knowledge",
    "constraint",
]);
function isRecord(value) {
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
];
/**
 * Verify a pinned generation against its manifest (재감사 P1-4 보강): the
 * manifest's generation/device must match the location CURRENT named, and
 * every payload file must match its pinned row count and SHA-256 with every
 * line parsing cleanly. Cloud sync moves a generation directory file-by-file
 * — a locally-atomic rename proves nothing about what arrived here, and a
 * partially synced tombstones file is a privacy boundary, so ANY mismatch
 * rejects the whole generation. Returns the first integrity error, or null.
 */
function validateGenerationIntegrity(deviceId, generationId, files) {
    let manifest;
    try {
        manifest = JSON.parse(files.get("meta.json"));
    }
    catch (error) {
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
        const content = files.get(name);
        if (countPayloadRows(content) !== spec.rows) {
            return `${name} row count mismatch (manifest pins ${spec.rows}) — partially synced generation`;
        }
        if (payloadSha256(content) !== spec.sha256) {
            return `${name} sha256 mismatch — partially synced or corrupted generation`;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].trim())
                continue;
            try {
                JSON.parse(lines[i]);
            }
            catch {
                return `${name} malformed JSON at line ${i + 1}`;
            }
        }
    }
    return null;
}
function parseFromPinned(generation, name, issues) {
    const content = generation.files.get(name);
    if (content === undefined)
        return [];
    const rows = [];
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim())
            continue;
        try {
            rows.push(JSON.parse(line));
        }
        catch (error) {
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
function collectCommittedGenerations(syncDir, issues) {
    const devicesDir = path.join(syncDir, "devices");
    if (!fs.existsSync(devicesDir))
        return [];
    const pinned = [];
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
        let generation;
        try {
            generation = JSON.parse(fs.readFileSync(currentPath, "utf8"))
                .generation;
        }
        catch (error) {
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
        const files = new Map();
        let complete = true;
        for (const name of REQUIRED_PAYLOAD_FILES) {
            const filePath = path.join(genDir, name);
            try {
                files.set(name, fs.readFileSync(filePath, "utf8"));
            }
            catch (error) {
                // 재감사 P2 v4: missing AND unreadable are the same fail-closed outcome.
                // A generation pruned between the CURRENT read and this read must not
                // escape as an exception — it is a per-device rejected snapshot with a
                // reported issue, and other devices keep importing.
                issues.push({
                    file: currentPath,
                    line: 0,
                    error: `CURRENT names generation ${generation} with unreadable ${name}, device ${entry.name} snapshot rejected: ${error instanceof Error ? error.message : String(error)}`,
                });
                complete = false;
                break;
            }
        }
        if (!complete)
            continue;
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
function isTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
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
        !isTimestamp(value.semantic_updated_at) ||
        !isTimestamp(value.lifecycle_updated_at) ||
        !Number.isInteger(value.consolidated_count) || Number(value.consolidated_count) < 0 ||
        (value.is_active !== 0 && value.is_active !== 1))
        return null;
    const scopeProject = canonicalScopeProject(value.scope_type, value.scope_project);
    if (scopeProject === undefined)
        return null;
    return {
        id: value.id,
        fact: value.fact,
        category: value.category,
        scope_type: value.scope_type,
        scope_project: scopeProject,
        source_exchange_ids: value.source_exchange_ids,
        created_at: value.created_at,
        updated_at: value.updated_at,
        semantic_updated_at: value.semantic_updated_at,
        lifecycle_updated_at: value.lifecycle_updated_at,
        consolidated_count: Number(value.consolidated_count),
        is_active: value.is_active === 0 ? 0 : 1,
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
function semanticConflictKey(fact) {
    return JSON.stringify([
        fact.fact,
        fact.category,
        fact.scope_type,
        fact.scope_project,
        fact.created_at,
    ]);
}
function parseFactSourceIds(raw) {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    }
    catch {
        return [];
    }
}
/** DB 행의 의미 시계 — legacy/빈 값은 updated_at으로 폴백한다. */
function localSemanticClock(row) {
    const value = row.semantic_updated_at;
    return typeof value === "string" && value !== "" && isTimestamp(value)
        ? value
        : row.updated_at;
}
/** DB 행의 활성 시계(재감사 P1-3 v4) — legacy/빈 값은 updated_at으로 폴백한다. */
function localLifecycleClock(row) {
    const value = row.lifecycle_updated_at;
    return typeof value === "string" && value !== "" && isTimestamp(value)
        ? value
        : row.updated_at;
}
/** Local fact view for conflict judgment — the fields the semantic key,
 * lineage merge, and lifecycle reconciliation read from the current row. */
function localFactView(row) {
    return {
        id: row.id,
        fact: row.fact,
        category: row.category,
        scope_type: row.scope_type,
        scope_project: row.scope_project ?? null,
        source_exchange_ids: row.source_exchange_ids ?? "[]",
        created_at: row.created_at,
        updated_at: row.updated_at,
        semantic_updated_at: localSemanticClock(row),
        lifecycle_updated_at: localLifecycleClock(row),
        consolidated_count: Number(row.consolidated_count),
        is_active: Number(row.is_active) === 0 ? 0 : 1,
        semantic_generation: Number(row.semantic_generation ?? 1),
        lifecycle_generation: Number(row.lifecycle_generation ?? 1),
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
/**
 * Newest tombstone wins; a conversation exclusion is terminal privacy state
 * with no un-consent event, so its reason dominates any non-privacy deletion
 * regardless of timestamps while the timestamp stays monotone.
 */
function mergeTombstones(a, b) {
    const privacy = a.reason === PRIVACY_TOMBSTONE_REASON ||
        b.reason === PRIVACY_TOMBSTONE_REASON;
    if (!privacy) {
        return compareTimestamps(b.deleted_at, a.deleted_at) > 0 ? b : a;
    }
    return {
        fact_id: b.fact_id,
        deleted_at: compareTimestamps(a.deleted_at, b.deleted_at) > 0
            ? a.deleted_at
            : b.deleted_at,
        reason: PRIVACY_TOMBSTONE_REASON,
    };
}
function importTombstones(db, generations, result) {
    const byFact = new Map();
    for (const generation of generations) {
        for (const value of parseFromPinned(generation, "fact-tombstones.jsonl", result.malformedRows)) {
            const row = parseTombstone(value);
            if (!row)
                continue;
            const previous = byFact.get(row.fact_id);
            byFact.set(row.fact_id, previous ? mergeTombstones(previous, row) : row);
        }
    }
    for (const tombstone of byFact.values()) {
        const localFact = db.prepare("SELECT COALESCE(NULLIF(semantic_updated_at, ''), updated_at) AS semantic_clock, updated_at FROM facts WHERE id = ?").get(tombstone.fact_id);
        const localTombstone = db.prepare("SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?").get(tombstone.fact_id);
        const privacy = tombstone.reason === PRIVACY_TOMBSTONE_REASON;
        if (localTombstone) {
            if (localTombstone.reason === PRIVACY_TOMBSTONE_REASON) {
                // Terminal local exclusion: nothing may downgrade it, and only a
                // strictly newer privacy tombstone can extend it.
                if (!privacy || compareTimestamps(localTombstone.deleted_at, tombstone.deleted_at) >= 0)
                    continue;
            }
            else if (!privacy &&
                compareTimestamps(localTombstone.deleted_at, tombstone.deleted_at) >= 0) {
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
        if (!privacy && localFact && compareTimestamps(localFact.semantic_clock, tombstone.deleted_at) > 0)
            continue;
        const commit = db.transaction(() => {
            const existed = !!db.prepare("SELECT 1 FROM facts WHERE id = ?").get(tombstone.fact_id);
            deleteFactState(db, tombstone.fact_id);
            // Monotone: an existing tombstone never moves backwards in time.
            const deletedAt = localTombstone &&
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
        if (commit())
            result.deletedFacts++;
        result.newTombstones++;
    }
}
async function importFacts(db, generations, result) {
    const plans = new Map();
    const remoteById = new Map();
    for (const generation of generations) {
        for (const value of parseFromPinned(generation, "facts.jsonl", result.malformedRows)) {
            const fact = parseSyncFact(value);
            if (!fact)
                continue; // strict validation already rejected this generation
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
        const localTombstone = db.prepare("SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?").get(remote.id);
        // Hard delete wins a timestamp tie; only a strictly newer semantic event can
        // restore (재감사 P1-3 — 비의미 메타데이터 touch는 삭제를 이기지 못한다).
        if (localTombstone && compareTimestamps(localTombstone.deleted_at, remote.semantic_updated_at) >= 0)
            continue;
        // A conversation-exclusion tombstone is terminal privacy state: without an
        // explicit un-exclude/re-consent event no newer fact event may resurrect it.
        if (localTombstone?.reason === PRIVACY_TOMBSTONE_REASON)
            continue;
        const localRow = db.prepare(`
      SELECT id, fact, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, is_active,
             semantic_generation, semantic_updated_at, lifecycle_generation, lifecycle_updated_at
      FROM facts WHERE id = ?
    `).get(remote.id);
        const plan = {};
        if (!localRow) {
            // New fact: the meaning comes from the SEMANTIC winner while the
            // activation state comes from the LIFECYCLE winner — a remote device
            // that deactivated later must not be overridden by a device that edited
            // later (재감사 P1-1 v4).
            plan.semantic = {
                mode: "insert",
                fact: {
                    ...remote,
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
        }
        else if (lifecycleTime === 0 && agg.lifecycleWinner.is_active === 0 && local.is_active === 1) {
            plan.lifecycle = {
                desiredActive: 0,
                eventAt: agg.lifecycleWinner.lifecycle_updated_at,
            };
        }
        if (plan.semantic || plan.lineage || plan.lifecycle)
            plans.set(remote.id, plan);
    }
    if (plans.size === 0)
        return;
    await initEmbeddings();
    for (const [factId, plan] of plans) {
        try {
            // --- semantic axis: generate before the transaction; failure leaves the
            // whole fact retryable instead of committing a vectorless row ---
            const semantic = plan.semantic;
            if (semantic) {
                const fact = semantic.fact;
                const embedding = await generateEmbedding(fact.fact);
                const commit = db.transaction(() => {
                    // 재감사 P1-2: embedding await 동안 tombstone이 생겼으면 이
                    // reconcile은 폐기한다 — commit 직전 재검사다.
                    const tombstone = db.prepare("SELECT deleted_at, reason FROM fact_tombstones WHERE fact_id = ?").get(factId);
                    if (tombstone && (tombstone.reason === PRIVACY_TOMBSTONE_REASON ||
                        compareTimestamps(tombstone.deleted_at, fact.semantic_updated_at) >= 0)) {
                        return false;
                    }
                    if (semantic.mode === "replace") {
                        // Commit-time live lineage (재감사 P1-2 v4): provenance/count
                        // merges bump NO generation, so the CAS token alone cannot see a
                        // concurrent DUPLICATE consolidation — re-read them inside this
                        // transaction and union/max so the merge is absorbed, never lost.
                        const current = db.prepare("SELECT source_exchange_ids, consolidated_count, is_active FROM facts WHERE id = ?").get(factId);
                        if (!current)
                            return false;
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
                source_exchange_ids = ?, embedding = ?, created_at = ?, updated_at = ?,
                consolidated_count = ?, embedding_version = ?,
                ontology_category_id = NULL, fact_kr = NULL,
                ontology_attempts = 0, consolidation_attempts = 0,
                needs_consolidation = ?, ontology_last_attempt_at = NULL,
                semantic_generation = semantic_generation + 1, semantic_updated_at = ?
              WHERE id = ? AND semantic_generation = ?
            `).run(fact.fact, fact.category, fact.scope_type, fact.scope_project, liveSources, Buffer.from(new Float32Array(embedding).buffer), fact.created_at, fact.updated_at, liveCount, EMBEDDING_VERSION, isActive, fact.semantic_updated_at, factId, semantic.localGeneration);
                        if (claimed.changes === 0)
                            return false;
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
                            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(primaryDtype)})`).run(factId, embeddingToVecBlob(embedding, primaryDtype));
                        }
                    }
                    else {
                        if (db.prepare("SELECT 1 FROM facts WHERE id = ?").get(factId))
                            return false;
                        db.prepare(`
              INSERT INTO facts
                (id, fact, category, scope_type, scope_project, source_exchange_ids,
                 embedding, created_at, updated_at, consolidated_count, is_active,
                 embedding_version, needs_consolidation,
                 semantic_generation, semantic_updated_at,
                 lifecycle_generation, lifecycle_updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)
            `).run(fact.id, fact.fact, fact.category, fact.scope_type, fact.scope_project, fact.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer), fact.created_at, fact.updated_at, fact.consolidated_count, fact.is_active, EMBEDDING_VERSION, fact.is_active, fact.semantic_updated_at, fact.lifecycle_updated_at);
                        // A strictly newer semantic event resurrected over a stale
                        // non-privacy tombstone — clear the inert deletion marker.
                        db.prepare("DELETE FROM fact_tombstones WHERE fact_id = ?").run(factId);
                        if (fact.is_active === 1) {
                            const primaryDtype = getVecTableDtype(db, "vec_facts");
                            db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(primaryDtype)})`).run(factId, embeddingToVecBlob(embedding, primaryDtype));
                        }
                    }
                    return true;
                });
                if (!commit()) {
                    console.error(`sync-import: discarded stale reconciliation for fact ${factId} (local state changed during embedding)`);
                }
                else if (semantic.mode === "replace") {
                    result.updatedFacts++;
                }
                else {
                    result.newFacts++;
                }
            }
            // --- lineage axis: monotone union/max against the LIVE row in one
            // transaction. Serialized writers make read-merge-write race-free; no
            // generation token is involved, so nothing can invalidate the merge. ---
            const lineage = plan.lineage;
            if (lineage) {
                const commit = db.transaction(() => {
                    const current = db.prepare("SELECT source_exchange_ids, consolidated_count FROM facts WHERE id = ?").get(factId);
                    if (!current)
                        return false;
                    const sources = JSON.stringify([
                        ...new Set([
                            ...parseFactSourceIds(current.source_exchange_ids ?? "[]"),
                            ...parseFactSourceIds(lineage.sources),
                        ]),
                    ].sort());
                    const count = Math.max(Number(current.consolidated_count), lineage.count);
                    if (sources === JSON.stringify(parseFactSourceIds(current.source_exchange_ids ?? "[]").sort()) &&
                        count === Number(current.consolidated_count))
                        return false;
                    db.prepare("UPDATE facts SET source_exchange_ids = ?, consolidated_count = ?, updated_at = ? WHERE id = ?").run(sources, count, new Date().toISOString(), factId);
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
                    const outcome = await applyReplicatedLifecycle(db, factId, plan.lifecycle.desiredActive, plan.lifecycle.eventAt);
                    if (outcome === "applied")
                        result.updatedFacts++;
                }
                catch (error) {
                    console.error(`sync-import: failed to reconcile lifecycle for fact ${factId}:`, error instanceof Error ? error.message : error);
                }
            }
        }
        catch (error) {
            console.error(`sync-import: failed to reconcile fact ${factId}:`, error instanceof Error ? error.message : error);
        }
    }
}
function importRevisions(db, generations, result) {
    for (const generation of generations) {
        for (const value of parseFromPinned(generation, "fact-revisions.jsonl", result.malformedRows)) {
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
function importRecallEvents(db, generations, result) {
    for (const generation of generations) {
        for (const value of parseFromPinned(generation, "recall-events.jsonl", result.malformedRows)) {
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
function generationKey(generation) {
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
const ROW_VALIDATORS = [
    { file: "facts.jsonl", validate: (value) => parseSyncFact(value) !== null },
    { file: "fact-revisions.jsonl", validate: (value) => parseRevision(value) !== null },
    { file: "fact-tombstones.jsonl", validate: (value) => parseTombstone(value) !== null },
    { file: "recall-events.jsonl", validate: (value) => parseRecallEvent(value) !== null },
];
function rejectInvalidRows(generations, issues) {
    const rejected = new Set();
    for (const generation of generations) {
        for (const { file, validate } of ROW_VALIDATORS) {
            const content = generation.files.get(file);
            if (content === undefined)
                continue;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim())
                    continue;
                let value;
                try {
                    value = JSON.parse(line);
                }
                catch {
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
            if (rejected.has(generationKey(generation)))
                break;
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
export async function importFromSync() {
    const result = {
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
    if (pinned.length === 0)
        return result;
    const rejected = rejectInvalidRows(pinned, result.malformedRows);
    const generations = rejected.size === 0
        ? pinned
        : pinned.filter((generation) => !rejected.has(generationKey(generation)));
    if (generations.length === 0)
        return result;
    const db = initDatabase();
    try {
        importTombstones(db, generations, result);
        await importFacts(db, generations, result);
        importRevisions(db, generations, result);
        importRecallEvents(db, generations, result);
        return result;
    }
    finally {
        db.close();
    }
}
