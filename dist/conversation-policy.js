import fs from "node:fs";
import readline from "node:readline";
import { createArchiveReadStream } from "./archive-io.js";
import { SUMMARIZER_CONTEXT_MARKER } from "./constants.js";
import { isExcludedProject } from "./paths.js";
import { recordFactTombstone } from "./fact-management.js";
import { purgeChronicleForSources } from "./chronicle.js";
import { bumpTaxonomyEpoch } from "./ontology-db.js";
import { getMemexHome } from "./paths.js";
import path from "node:path";
export const USER_EXCLUSION_MARKERS = [
    "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
    "Only use NO_INSIGHTS_FOUND",
    SUMMARIZER_CONTEXT_MARKER,
];
/**
 * Tombstone reason written when a conversation-wide user exclusion purges
 * facts. This reason is terminal privacy state: sync import must never let a
 * newer peer edit resurrect an excluded fact, because no un-exclude or
 * re-consent event exists anywhere in the protocol.
 */
export const PRIVACY_TOMBSTONE_REASON = "source_conversation_excluded";
export function isConversationExcludedSession(db, sessionId) {
    return !!db.prepare("SELECT 1 FROM conversation_exclusions WHERE session_id = ?").get(sessionId);
}
/**
 * User exclusion applies only to user-role message payloads. Raw transcript
 * bytes, tool output, and assistant output can quote marker source text and
 * must never exclude a conversation by themselves.
 */
export async function isUserExcludedConversation(filePath) {
    let stream;
    try {
        stream = createArchiveReadStream(filePath);
    }
    catch {
        return false;
    }
    try {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line.trim())
                continue;
            let rec;
            try {
                rec = JSON.parse(line);
            }
            catch {
                continue;
            }
            const payload = rec?.payload;
            if (rec?.type !== "response_item" ||
                !payload ||
                payload.type !== "message" ||
                payload.role !== "user") {
                continue;
            }
            const text = typeof payload.content === "string"
                ? payload.content
                : Array.isArray(payload.content)
                    ? payload.content
                        .filter((part) => part && typeof part.text === "string")
                        .map((part) => part.text)
                        .join("\n")
                    : "";
            if (USER_EXCLUSION_MARKERS.some((marker) => text.includes(marker))) {
                return true;
            }
        }
        return false;
    }
    catch {
        // Unreadable or undecidable input is not silently reclassified as a user
        // privacy instruction. The caller's normal parse/error path remains active.
        return false;
    }
    finally {
        stream.destroy();
    }
}
/** Single ingestion-policy decision shared by sync, index, repair, and summary. */
export async function getConversationEligibility(input) {
    if (input.isSubagent)
        return { eligible: false, reason: "subagent" };
    if (isExcludedProject(input.project, input.excludedProjects)) {
        return { eligible: false, reason: "excluded_project" };
    }
    if (await isUserExcludedConversation(input.filePath)) {
        return { eligible: false, reason: "user_excluded" };
    }
    return { eligible: true };
}
function parseSourceIds(raw) {
    if (typeof raw !== "string")
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((value) => typeof value === "string")
            : [];
    }
    catch {
        return [];
    }
}
/**
 * Conversation-wide user exclusion purge. Source rollouts stay untouched and
 * their archive copy remains retained/rebuildable; searchable and model-derived
 * state is removed. Facts touching excluded evidence are removed as a whole
 * because a merged sentence cannot prove which words came from which source.
 */
export function purgeConversationFromIndex(db, input) {
    const continuityTablesBefore = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    const identityCandidates = [];
    if (input.sessionId) {
        if (continuityTablesBefore.has("session_memory_state")) {
            identityCandidates.push(...db.prepare(`
        SELECT project_id, workspace_id FROM session_memory_state WHERE session_id = ?
      `).all(input.sessionId));
        }
        if (continuityTablesBefore.has("exchanges")) {
            identityCandidates.push(...db.prepare(`
        SELECT DISTINCT project_id, workspace_id FROM exchanges WHERE session_id = ?
      `).all(input.sessionId));
        }
    }
    const rows = (input.sessionId
        ? db
            .prepare("SELECT id FROM exchanges WHERE archive_path = ? OR session_id = ?")
            .all(input.archivePath, input.sessionId)
        : db
            .prepare("SELECT id FROM exchanges WHERE archive_path = ?")
            .all(input.archivePath));
    const exchangeIds = new Set(rows.map((row) => row.id));
    const factIds = new Set();
    if (exchangeIds.size > 0) {
        const facts = db
            .prepare("SELECT id, source_exchange_ids FROM facts")
            .all();
        for (const fact of facts) {
            if (parseSourceIds(fact.source_exchange_ids).some((id) => exchangeIds.has(id))) {
                factIds.add(fact.id);
            }
        }
        const revisions = db
            .prepare("SELECT fact_id, source_exchange_id, source_exchange_ids FROM fact_revisions WHERE fact_id IS NOT NULL")
            .all();
        for (const revision of revisions) {
            const cited = parseSourceIds(revision.source_exchange_ids);
            if (revision.source_exchange_id)
                cited.push(revision.source_exchange_id);
            if (cited.some((id) => exchangeIds.has(id))) {
                factIds.add(revision.fact_id);
            }
        }
        const contextDependencies = db
            .prepare("SELECT fact_id, exchange_id FROM fact_context_dependencies")
            .all();
        for (const dependency of contextDependencies) {
            // Context is non-authoritative for truth, but it can still disclose or
            // semantically determine the fact text. User exclusion therefore
            // purges the dependent derived fact rather than merely hiding the edge.
            if (exchangeIds.has(dependency.exchange_id)) {
                factIds.add(dependency.fact_id);
            }
        }
    }
    const purge = db.transaction(() => {
        if (input.sessionId) {
            db.prepare(`
        INSERT INTO conversation_exclusions(session_id, source_path, reason, excluded_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          source_path = excluded.source_path,
          reason = excluded.reason,
          excluded_at = excluded.excluded_at
      `).run(input.sessionId, input.archivePath, PRIVACY_TOMBSTONE_REASON, new Date().toISOString());
        }
        const deleteRelation = db.prepare("DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?");
        const deleteFactVector = db.prepare("DELETE FROM vec_facts WHERE id = ?");
        const deleteFactVectorKr = db.prepare("DELETE FROM vec_facts_kr WHERE id = ?");
        const deleteFact = db.prepare("DELETE FROM facts WHERE id = ?");
        // Chronicle events, incident occurrences and their signatures that belong
        // to a purged fact or cite a purged exchange are removed and tombstoned in
        // this same transaction, so a peer replay or pending worker cannot
        // resurrect purged history (PRIVACY).
        purgeChronicleForSources(db, { exchangeIds, factIds, reason: PRIVACY_TOMBSTONE_REASON });
        for (const factId of factIds) {
            recordFactTombstone(db, factId, PRIVACY_TOMBSTONE_REASON);
            deleteRelation.run(factId, factId);
            deleteFactVector.run(factId);
            deleteFactVectorKr.run(factId);
            deleteFact.run(factId);
        }
        const deleteTools = db.prepare("DELETE FROM tool_calls WHERE exchange_id = ?");
        const deleteVector = db.prepare("DELETE FROM vec_exchanges WHERE id = ?");
        const deleteExchange = db.prepare("DELETE FROM exchanges WHERE id = ?");
        for (const exchangeId of exchangeIds) {
            deleteTools.run(exchangeId);
            deleteVector.run(exchangeId);
            deleteExchange.run(exchangeId);
        }
        // 재감사 P1-4(protocol v4): taxonomy는 fact에서 파생된 model-derived
        // 상태다 — LLM이 만든 domain/category description과 그 벡터는 제거된
        // private 증거에서 유래했을 수 있고, purge 계약("searchable and
        // model-derived state is removed")은 그 잔존을 허용하지 않는다. 전면
        // invalidate하고 남은 facts의 overlay를 끊는다; 분류 백필이 공개 facts만으로
        // taxonomy를 재구축한다(derived 상태이므로 재구축 가능).
        db.prepare("DELETE FROM vec_categories").run();
        db.prepare("DELETE FROM ontology_categories").run();
        db.prepare("DELETE FROM ontology_domains").run();
        // 재감사 P2(v4): attempt ledger까지 초기화해야 "전체 fact가 재분류 대기"가
        // 성립한다 — attempts가 MAX인 잔존 fact는 worker 시작 시 LLM 없이 즉시
        // General/Misc로 파킹되므로, 리셋 없이는 새 taxonomy로 재분류되지 않는다.
        db.prepare("UPDATE facts SET ontology_category_id = NULL, ontology_attempts = 0, ontology_last_attempt_at = NULL").run();
        // 재감사 Privacy-P1(v4): purge 전에 시작된 in-flight classification은 이
        // epoch로 폐기된다 — stale LLM 결과가 옛 candidate에서 유래한 taxonomy를
        // 다시 만들지 못한다. bump는 taxonomy 삭제와 같은 transaction 안에 있다.
        bumpTaxonomyEpoch(db);
        if (input.sessionId) {
            const continuityTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
            if (continuityTables.has("checkpoints")) {
                // Cascade removes checkpoint-owned jobs before target/exchange rows.
                // This prevents a queued worker from recreating purged knowledge.
                db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(input.sessionId);
            }
            if (continuityTables.has("journal_streams")) {
                db.prepare("DELETE FROM journal_streams WHERE session_id = ?").run(input.sessionId);
            }
            if (continuityTables.has("capture_gaps")) {
                db.prepare("DELETE FROM capture_gaps WHERE session_id = ?").run(input.sessionId);
            }
            if (continuityTables.has("hot_evidence")) {
                db.prepare("DELETE FROM hot_evidence WHERE session_id = ?").run(input.sessionId);
            }
            if (continuityTables.has("session_memory_state")) {
                db.prepare("DELETE FROM session_memory_state WHERE session_id = ?").run(input.sessionId);
            }
            if (continuityTables.has("workstream_sessions")) {
                db.prepare("DELETE FROM workstream_sessions WHERE session_id = ?").run(input.sessionId);
            }
            if (continuityTables.has("work_capsules")) {
                // A Work Capsule is a model-derived projection. One built from the
                // purged session, or citing any purged exchange, must not survive as
                // a sibling's context; the sibling rebuilds from its own evidence and
                // re-receives WORK NOW because its seen generation is reset.
                const capsules = db.prepare(`
          SELECT workstream_id, source_session_id, source_exchange_ids_json FROM work_capsules
        `).all();
                for (const capsule of capsules) {
                    const cites = parseSourceIds(capsule.source_exchange_ids_json).some((id) => exchangeIds.has(id));
                    if (capsule.source_session_id !== input.sessionId && !cites)
                        continue;
                    db.prepare("DELETE FROM work_capsules WHERE workstream_id = ?").run(capsule.workstream_id);
                    if (continuityTables.has("session_memory_state")) {
                        db.prepare("UPDATE session_memory_state SET capsule_generation_seen = 0 WHERE workstream_id = ?")
                            .run(capsule.workstream_id);
                    }
                }
            }
            if (continuityTables.has("minimal_workstreams")) {
                // Phase 3 permits several sessions to share one workstream Capsule.
                // Purging one source session must remove its binding but must not erase
                // a sibling session's continuity projection. Re-home the compatibility
                // owner when another binding remains; delete only orphan workstreams.
                const owned = db.prepare(`
          SELECT workstream_id FROM minimal_workstreams WHERE session_id = ?
        `).all(input.sessionId);
                for (const row of owned) {
                    const sibling = continuityTables.has("workstream_sessions")
                        ? db.prepare(`
                SELECT session_id FROM workstream_sessions
                WHERE workstream_id = ? ORDER BY bound_at, session_id LIMIT 1
              `).get(row.workstream_id)
                        : undefined;
                    if (sibling) {
                        db.prepare(`
              UPDATE minimal_workstreams SET session_id = ?, updated_at = ?
              WHERE workstream_id = ?
            `).run(sibling.session_id, new Date().toISOString(), row.workstream_id);
                    }
                    else {
                        db.prepare("DELETE FROM minimal_workstreams WHERE workstream_id = ?")
                            .run(row.workstream_id);
                    }
                }
            }
            if (continuityTables.has("extraction_targets")) {
                db.prepare("DELETE FROM extraction_targets WHERE session_id = ?").run(input.sessionId);
            }
            db.prepare("DELETE FROM extraction_log WHERE session_id = ?").run(input.sessionId);
            db.prepare("DELETE FROM recall_events WHERE session_id = ?").run(input.sessionId);
            if (continuityTables.has("project_identity_audit")) {
                db.prepare("DELETE FROM project_identity_audit WHERE session_id = ?").run(input.sessionId);
            }
            for (const candidate of identityCandidates) {
                if (candidate.workspace_id && continuityTables.has("workspaces")) {
                    const used = db.prepare(`
            SELECT
              (SELECT COUNT(*) FROM exchanges WHERE workspace_id = ?) +
              (SELECT COUNT(*) FROM facts WHERE workspace_id = ?) +
              (SELECT COUNT(*) FROM session_memory_state WHERE workspace_id = ?) +
              (SELECT COUNT(*) FROM minimal_workstreams WHERE workspace_id = ?) +
              (SELECT COUNT(*) FROM hot_evidence WHERE workspace_id = ?) AS n
          `).get(candidate.workspace_id, candidate.workspace_id, candidate.workspace_id, candidate.workspace_id, candidate.workspace_id);
                    if (used.n === 0) {
                        db.prepare("DELETE FROM project_identity_audit WHERE workspace_id = ?").run(candidate.workspace_id);
                        db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(candidate.workspace_id);
                    }
                }
                if (candidate.project_id && continuityTables.has("projects")) {
                    const used = db.prepare(`
            SELECT
              (SELECT COUNT(*) FROM workspaces WHERE project_id = ?) +
              (SELECT COUNT(*) FROM exchanges WHERE project_id = ?) +
              (SELECT COUNT(*) FROM facts WHERE project_id = ?) +
              (SELECT COUNT(*) FROM recall_events WHERE project_id = ?) +
              (SELECT COUNT(*) FROM hot_evidence WHERE project_id = ?) +
              (SELECT COUNT(*) FROM session_memory_state WHERE project_id = ?) +
              (SELECT COUNT(*) FROM minimal_workstreams WHERE project_id = ?) AS n
          `).get(candidate.project_id, candidate.project_id, candidate.project_id, candidate.project_id, candidate.project_id, candidate.project_id, candidate.project_id);
                    if (used.n === 0) {
                        db.prepare("DELETE FROM project_identity_audit WHERE project_id = ?").run(candidate.project_id);
                        db.prepare("DELETE FROM projects WHERE project_id = ?").run(candidate.project_id);
                    }
                }
            }
        }
    });
    purge.immediate();
    if (input.sessionId && /^[A-Za-z0-9_-]{4,128}$/.test(input.sessionId)) {
        // Journal bytes are user-source-derived durable evidence. Privacy purge is
        // the sole normal destructive path and removes the session-owned directory
        // only after the DB transaction has made every queued worker unreachable.
        fs.rmSync(path.join(getMemexHome(), "journals", input.sessionId), {
            recursive: true,
            force: true,
        });
    }
    const summaryPath = input.archivePath.replace(/\.jsonl(?:\.zst)?$/, "-summary.txt");
    let summaries = 0;
    for (const candidate of [summaryPath, `${summaryPath}.zst`]) {
        if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
            summaries++;
        }
    }
    return { exchanges: exchangeIds.size, facts: factIds.size, summaries };
}
