import { getSearchDb } from "./search.js";
import { l2DistanceToSimilarity } from "./db.js";
import { searchFactsByScope } from "./fact-db.js";
import { generateEmbedding, initEmbeddings, queryBaseline, } from "./embeddings.js";
import { getRelatedFacts } from "./ontology-db.js";
import { detectRepeat } from "./repeat-detector.js";
import { appendInjectLog } from "./inject-log.js";
import { recordRecallEvent } from "./db.js";
import { matchIncidentPatterns, readChronicleTimeline, recordTelemetrySample, } from "./chronicle.js";
import { ensureSessionMemoryState, buildRehydrationContext, readResidentFactRevisions, readWorkCapsule, recordResidentFactRevisions, } from "./continuity-core.js";
import { markSessionProjectRevisionSeen, readHotEvidence, sessionProjectRevisionState, } from "./continuity-identity.js";
import { blobToEmbedding, decideRecall, embeddingToBlob, resolveAmbiguousDecision, tokenizePrompt, } from "./recall-gate.js";
import { NORMAL_BUNDLE_BUDGET, estimateTokens, renderMemoryBundle, } from "./memory-bundle.js";
/** Measured outcome sample; never blocks or fails the prompt path. */
function sampleTelemetry(db, input) {
    try {
        recordTelemetrySample(db, input);
    }
    catch {
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
const MAX_CONTEXT_FACTS = 8;
// Phase 5 budget (RFC §12.5): normal prompt delta target 700 / hard 1,000 chars.
const BLOCK_CHAR_BUDGET = NORMAL_BUNDLE_BUDGET.hard;
// detectRepeat 는 313k exchanges 벡터검색 (p50 21ms / p95 498ms 실측) — tail 이
// 주입 지연 p90 을 끌어올린다. better-sqlite3 는 동기라 시작한 검색을 타이머로
// 선점할 수 없다(Promise.race 는 무효 — Codex 리뷰 지적). 대신 시작 "전" 경과
// 예산을 확인해, 파이프라인이 이미 이만큼 썼으면 반복감지를 통째로 생략한다.
const REPEAT_ELAPSED_BUDGET_MS = 700;
/** A WATCH signature is not repeated within this many substantive prompts unless it recurred. */
const WATCH_TTL_PROMPTS = 5;
const TOPIC_FINGERPRINT_MAX = 64;
function commitInjectionState(db, input) {
    const write = () => {
        const receipt = recordRecallEvent(db, input);
        if (!receipt)
            throw new Error("Failed to persist prepared recall receipt");
        if (!recordResidentFactRevisions(db, input.sessionId, input.contextEpoch, input.revisions)) {
            throw new Error("context epoch changed before residency commit");
        }
        if (input.markProjectRevision !== false &&
            !markSessionProjectRevisionSeen(db, input.sessionId, input.projectMemoryRevision)) {
            throw new Error("project memory revision changed before injection commit");
        }
    };
    if (typeof db.transaction !== "function") {
        write();
        return;
    }
    const tx = db.transaction(write);
    if (db.inTransaction)
        tx();
    else
        tx.immediate();
}
/** Test doubles may hand in a bare object; state reads then degrade to defaults. */
function canQuery(db) {
    return typeof db.prepare === "function";
}
function readGateRow(db, sessionId) {
    if (!canQuery(db))
        return null;
    return db.prepare(`
    SELECT context_epoch, last_source, capsule_generation_seen, memory_revision_seen,
           topic_fingerprint_json, topic_embedding, informative_prompts_since_retrieval,
           last_retrieval_epoch, watch_emitted_json, resident_fact_revisions_json, workstream_id
    FROM session_memory_state WHERE session_id = ?
  `).get(sessionId) ?? null;
}
function parseJson(raw, fallback) {
    if (typeof raw !== "string" || raw === "")
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/** Advance the substantive-prompt counter on a skip; bounded write, no retrieval. */
function noteSkippedPrompt(db, sessionId, substantive, now) {
    if (!substantive || !canQuery(db))
        return;
    db.prepare(`
    UPDATE session_memory_state
    SET informative_prompts_since_retrieval = informative_prompts_since_retrieval + 1, updated_at = ?
    WHERE session_id = ?
  `).run(now, sessionId);
}
function commitGateState(db, input) {
    if (!canQuery(db))
        return;
    db.prepare(`
    UPDATE session_memory_state
    SET topic_fingerprint_json = ?, topic_embedding = COALESCE(?, topic_embedding),
        informative_prompts_since_retrieval = 0, last_retrieval_epoch = ?, last_retrieval_at = ?,
        watch_emitted_json = ?, updated_at = ?
    WHERE session_id = ?
  `).run(JSON.stringify(input.tokens.slice(0, TOPIC_FINGERPRINT_MAX)), input.embedding ? embeddingToBlob(input.embedding) : null, input.contextEpoch, input.now, JSON.stringify(input.watchLedger.slice(-20)), input.now, input.sessionId);
}
function truncateFact(text, cap = NORMAL_BUNDLE_BUDGET.lineChars) {
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
export async function computeInjectContext(userPrompt, project, via, sessionId, options = {}) {
    const t0 = Date.now();
    const now = options.now ?? new Date().toISOString();
    if (!sessionId) {
        appendInjectLog({
            status: "no-session-provenance",
            project,
            prompt_len: userPrompt.length,
            via,
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
        const capsule = readWorkCapsule(db, sessionScope.workstreamId);
        const currentCapsuleGeneration = capsule?.generation ?? 0;
        const residentTuples = parseJson(gateRow?.resident_fact_revisions_json, []);
        const residentTexts = residentTuples.length > 0 && canQuery(db)
            ? db.prepare(`
          SELECT id, fact FROM facts WHERE id IN (${residentTuples.map(() => "?").join(",")})
        `).all(...residentTuples.map(([id]) => id))
            : [];
        const residentTokens = new Set(residentTexts.flatMap((row) => tokenizePrompt(row.fact)));
        // Verified incident patterns only (independent episodes or explicit user
        // repeat); candidates and remediated signatures never wake retrieval.
        const incidents = canQuery(db)
            ? matchIncidentPatterns(db, {
                projectId: sessionScope.projectId,
                text: userPrompt,
                limit: 2,
            })
            : [];
        let embedding = null;
        let embeddingCalls = 0;
        let decision = decideRecall({
            prompt: userPrompt,
            state: {
                contextEpoch: sessionScope.contextEpoch,
                lastRetrievalEpoch: Number(gateRow?.last_retrieval_epoch ?? -1),
                lastSource: gateRow?.last_source ?? null,
                capsuleGenerationSeen: Number(gateRow?.capsule_generation_seen ?? 0),
                memoryRevisionSeen: revisionState.seen,
                topicFingerprint: parseJson(gateRow?.topic_fingerprint_json, []),
                hasTopicEmbedding: !!gateRow?.topic_embedding,
                informativePromptsSinceRetrieval: Number(gateRow?.informative_prompts_since_retrieval ?? 0),
                residentTokens,
            },
            currentCapsuleGeneration,
            currentProjectRevision,
            incidentMatched: incidents.length > 0,
            config: options.gateConfig,
        });
        if (options.gate === false) {
            decision = { ...decision, action: "retrieve", triggers: ["safety_refresh"], skipReason: null };
        }
        // Embeddings may be unavailable (model missing, offline, cache failure).
        // The gate is lexical, so skips still cost nothing; on the retrieve path the
        // bundle degrades to the sections that need no vector (CORRECTION, WORK
        // NOW, WATCH, RECENT EVIDENCE) and the failure is logged, never thrown.
        let embeddingUnavailable = false;
        const embedOnce = async () => {
            try {
                await initEmbeddings();
                const vector = await generateEmbedding(userPrompt, "query");
                embeddingCalls++;
                return vector;
            }
            catch {
                embeddingUnavailable = true;
                return null;
            }
        };
        let baseline = null;
        if (decision.action === "ambiguous") {
            embedding = await embedOnce();
            if (embedding) {
                baseline = await queryBaseline(embedding);
                decision = resolveAmbiguousDecision(decision, embedding, blobToEmbedding(gateRow?.topic_embedding), baseline, options.gateConfig);
            }
            else {
                decision = { ...decision, action: "retrieve", triggers: [...decision.triggers, "no_topic_embedding"], skipReason: null };
            }
        }
        if (decision.action === "skip") {
            noteSkippedPrompt(db, sessionId, decision.substantive, now);
            sampleTelemetry(db, {
                metric: "retrieval_gate_skip_count", value: 1, projectId: sessionScope.projectId, sessionId,
                dims: { reason: decision.skipReason, substantive: decision.substantive },
            });
            sampleTelemetry(db, { metric: "embedding_calls", value: embeddingCalls, projectId: sessionScope.projectId, sessionId, dims: { path: "skip" } });
            appendInjectLog({
                status: "skipped",
                project,
                prompt_len: userPrompt.length,
                gate: `skip:${decision.skipReason}`,
                embedding_calls: embeddingCalls,
                duration_ms: Date.now() - t0,
                via,
            });
            return "";
        }
        if (!embedding && !embeddingUnavailable)
            embedding = await embedOnce();
        const gateLabel = `retrieve:${decision.triggers.join("+") || "forced"}${embeddingUnavailable ? "+embeddings_unavailable" : ""}`;
        sampleTelemetry(db, {
            metric: "retrieval_execute_count", value: 1, projectId: sessionScope.projectId, sessionId,
            dims: { triggers: decision.triggers },
        });
        sampleTelemetry(db, { metric: "semantic_retrieval_calls", value: 1, projectId: sessionScope.projectId, sessionId });
        sampleTelemetry(db, { metric: "embedding_calls", value: embeddingCalls, projectId: sessionScope.projectId, sessionId, dims: { path: "retrieve", unavailable: embeddingUnavailable } });
        if (decision.triggers.includes("project_revision_stale")) {
            sampleTelemetry(db, { metric: "project_revision_invalidations", value: 1, projectId: sessionScope.projectId, sessionId });
        }
        if (baseline === null)
            baseline = embedding ? await queryBaseline(embedding) : 0;
        const watchLedger = parseJson(gateRow?.watch_emitted_json, []);
        const informativeCounter = Number(gateRow?.informative_prompts_since_retrieval ?? 0);
        const staleProjectMemory = currentProjectRevision > revisionState.seen;
        if (staleProjectMemory) {
            const correction = buildRehydrationContext(db, {
                sessionId,
                maxChars: BLOCK_CHAR_BUDGET,
            });
            const ids = [...new Set(correction.factRevisions.map(([id]) => id))];
            if (correction.context && ids.length > 0) {
                const contextEpoch = readResidentFactRevisions(db, sessionId).contextEpoch;
                commitInjectionState(db, {
                    sessionId,
                    project,
                    prompt: userPrompt,
                    factIds: ids,
                    projectId: sessionScope.projectId,
                    workspaceId: sessionScope.workspaceId,
                    workstreamId: sessionScope.workstreamId,
                    contextEpoch,
                    projectMemoryRevision: currentProjectRevision,
                    revisions: correction.factRevisions,
                    markProjectRevision: correction.projectRevisionComplete,
                });
                commitGateState(db, { sessionId, contextEpoch, tokens: decision.tokens, embedding, watchLedger, now });
                const chars = correction.context.length + 1;
                sampleTelemetry(db, { metric: "correction_count", value: ids.length, projectId: sessionScope.projectId, sessionId, dims: { path: "project_revision" } });
                sampleTelemetry(db, { metric: "correction_delay_prompts", value: informativeCounter, projectId: sessionScope.projectId, sessionId });
                sampleTelemetry(db, { metric: "injected_facts", value: ids.length, projectId: sessionScope.projectId, sessionId });
                sampleTelemetry(db, { metric: "injected_chars", value: chars, unit: "chars", projectId: sessionScope.projectId, sessionId });
                sampleTelemetry(db, { metric: "bundle_size", value: chars, unit: "chars", projectId: sessionScope.projectId, sessionId, dims: { kind: "correction" } });
                appendInjectLog({
                    status: "injected",
                    project,
                    prompt_len: userPrompt.length,
                    injected: ids.length,
                    chars,
                    gate: gateLabel,
                    embedding_calls: embeddingCalls,
                    sections: ["CORRECTION"],
                    duration_ms: Date.now() - t0,
                    via,
                });
                return correction.context + "\n";
            }
            // A project revision can be irrelevant to this workspace/workstream
            // (or contain no active correction). Advance the invalidation token
            // only after rehydration has proved that there is nothing to emit.
            if (!markSessionProjectRevisionSeen(db, sessionId, currentProjectRevision)) {
                throw new Error("project memory revision changed during correction check");
            }
        }
        // threshold 0: take top-k by distance, then gate by baseline margin below
        const scope = {
            type: "workstream-id",
            projectId: sessionScope.projectId,
            workspaceId: sessionScope.workspaceId,
            workstreamId: sessionScope.workstreamId,
        };
        const candidates = embedding ? searchFactsByScope(db, embedding, scope, TOP_K, 0) : [];
        const results = candidates.filter((r) => {
            const similarity = l2DistanceToSimilarity(r.distance);
            return similarity - baseline >= BASELINE_MARGIN;
        });
        sampleTelemetry(db, { metric: "candidate_facts", value: candidates.length, projectId: sessionScope.projectId, sessionId });
        sampleTelemetry(db, { metric: "current_facts", value: results.length, projectId: sessionScope.projectId, sessionId });
        const hot = readHotEvidence(db, {
            projectId: sessionScope.projectId,
            workstreamId: sessionScope.workstreamId,
            limit: 2,
        });
        // Intent-gated 1-hop expansion (RFC §12.7): only why/related/dependency/
        // contradiction/trace prompts pay for graph expansion.
        const seenIds = new Set(results.map((r) => r.fact.id));
        const expandedFacts = [...results.map((r) => ({ fact: r.fact, note: "" }))];
        if (decision.intents.trace) {
            for (const { fact } of results.slice(0, 3)) {
                const related = getRelatedFacts(db, fact.id, 1, 0.6, 0.2, null, "project", scope);
                for (const { fact: relFact, relation } of related) {
                    if (!seenIds.has(relFact.id) && expandedFacts.length < MAX_CONTEXT_FACTS) {
                        seenIds.add(relFact.id);
                        expandedFacts.push({ fact: relFact, note: `[${relation.relation_type}]` });
                    }
                }
            }
        }
        // Revision-aware residency: identical revisions are suppressed; the same
        // fact in a newer generation is a correction; a resident fact that became
        // inactive is retracted explicitly.
        const residency = readResidentFactRevisions(db, sessionId);
        const residentById = new Map(residency.resident.map((entry) => [entry[0], entry]));
        const revisionOf = (fact) => [
            fact.id,
            fact.semantic_generation ?? 1,
            fact.lifecycle_generation ?? 1,
        ];
        const fresh = [];
        const corrections = [];
        let dedupedCount = 0;
        for (const entry of expandedFacts) {
            const [id, semantic, lifecycle] = revisionOf(entry.fact);
            const resident = residentById.get(id);
            if (!resident) {
                fresh.push(entry);
                continue;
            }
            if (resident[1] === semantic && resident[2] === lifecycle) {
                dedupedCount++;
                continue;
            }
            corrections.push({
                text: `Updated (supersedes earlier context): [${entry.fact.category}] ${truncateFact(entry.fact.fact)}`,
                revision: [id, semantic, lifecycle],
            });
        }
        if (residentById.size > 0 && canQuery(db)) {
            const inactive = db.prepare(`
        SELECT id, fact, semantic_generation, lifecycle_generation FROM facts
        WHERE is_active = 0 AND id IN (${[...residentById.keys()].map(() => "?").join(",")})
      `).all(...residentById.keys());
            for (const row of inactive) {
                const resident = residentById.get(row.id);
                if (resident && resident[2] !== row.lifecycle_generation) {
                    corrections.push({
                        text: `No longer active: ${truncateFact(row.fact)}`,
                        revision: [row.id, row.semantic_generation, row.lifecycle_generation],
                    });
                }
            }
        }
        sampleTelemetry(db, { metric: "delta_facts", value: fresh.length + corrections.length, projectId: sessionScope.projectId, sessionId });
        const sections = [];
        if (corrections.length > 0) {
            sections.push({ kind: "CORRECTION", items: corrections.map((c) => ({ text: c.text, ref: c.revision })) });
        }
        const wantsWorkNow = !!capsule && (decision.triggers.includes("capsule_generation_changed") ||
            decision.triggers.includes("first_substantive_in_epoch") ||
            decision.triggers.includes("context_epoch_changed") ||
            decision.triggers.includes("compact_first_prompt"));
        if (wantsWorkNow && capsule) {
            const lines = ["[WORK NOW]"];
            if (capsule.objective)
                lines.push(`Objective: ${truncateFact(capsule.objective, 200)}`);
            if (capsule.currentState)
                lines.push(`State: ${truncateFact(capsule.currentState, 200)}`);
            if (capsule.blockers[0])
                lines.push(`Blocker: ${truncateFact(capsule.blockers[0], 160)}`);
            if (capsule.nextActions[0])
                lines.push(`Next: ${truncateFact(capsule.nextActions[0], 160)}`);
            if (lines.length > 1)
                sections.push({ kind: "WORK NOW", items: [{ text: lines.join("\n"), raw: true }] });
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
        // WATCH: verified patterns only, bounded, with a per-session TTL so the
        // same signature is not repeated on every prompt unless it recurred.
        const watchItems = [];
        for (const pattern of incidents) {
            const prior = watchLedger.find((entry) => entry.key === pattern.signatureKey);
            const recurred = prior ? pattern.lastEffectiveAt > prior.lastEffectiveAt : true;
            const withinTtl = !!prior && prior.epoch === sessionScope.contextEpoch &&
                informativeCounter - prior.at < WATCH_TTL_PROMPTS;
            if (!recurred && withinTtl)
                continue;
            watchItems.push({
                key: pattern.signatureKey,
                lastEffectiveAt: pattern.lastEffectiveAt,
                text: `Known incident pattern (${pattern.episodeCount} verified episodes, last ${pattern.lastEffectiveAt.slice(0, 10)}): "${pattern.signatureText}"${pattern.remediationSummary ? ` — verified remediation: ${pattern.remediationSummary}` : ""}`,
            });
        }
        if (watchItems.length > 0)
            sections.push({ kind: "WATCH", items: watchItems.map((w) => ({ text: w.text })) });
        // TRACE: explicit why/history/source intent → point at the Chronicle instead of injecting it.
        if ((decision.intents.trace || decision.intents.memory) && canQuery(db)) {
            const traceItems = [];
            for (const { fact } of results.slice(0, 2)) {
                if (!fact.subject_key || !fact.project_id)
                    continue;
                const latest = readChronicleTimeline(db, {
                    projectId: fact.project_id, subjectKey: fact.subject_key, order: "desc", limit: 1,
                });
                const count = db.prepare("SELECT COUNT(*) AS n FROM fact_revisions WHERE project_id = ? AND subject_key = ?")
                    .get(fact.project_id, fact.subject_key).n;
                const event = latest.events[0];
                if (!event || Number(count) === 0)
                    continue;
                traceItems.push({
                    text: `${fact.subject_key}: ${count} Chronicle event(s), latest ${event.event_kind} effective ${event.effective_at.slice(0, 10)}${event.grounded_cause ? ` (cause: ${truncateFact(event.grounded_cause, 80)})` : ""}. Use trace_fact subject_key=${fact.subject_key} for history/source.`,
                });
            }
            if (traceItems.length > 0)
                sections.push({ kind: "TRACE", items: traceItems });
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
            }
            catch {
                /* best-effort */
            }
        }
        const rendered = renderMemoryBundle(sections, NORMAL_BUNDLE_BUDGET);
        const emittedRevisions = [];
        for (const section of rendered.sections) {
            for (const item of section.emitted)
                if (item.ref)
                    emittedRevisions.push(item.ref);
        }
        const emittedWatch = rendered.sections.find((s) => s.kind === "WATCH")?.emitted.length ?? 0;
        const nextWatchLedger = [...watchLedger.filter((entry) => !watchItems.slice(0, emittedWatch).some((w) => w.key === entry.key))];
        for (const watch of watchItems.slice(0, emittedWatch)) {
            nextWatchLedger.push({ key: watch.key, epoch: sessionScope.contextEpoch, at: 0, lastEffectiveAt: watch.lastEffectiveAt });
        }
        if (rendered.chars === 0) {
            commitGateState(db, { sessionId, contextEpoch: residency.contextEpoch, tokens: decision.tokens, embedding, watchLedger, now });
            appendInjectLog({
                status: dedupedCount > 0 ? "deduped" : "no-match",
                project,
                prompt_len: userPrompt.length,
                candidates: candidates.length,
                injected: 0,
                deduped: dedupedCount,
                gate: gateLabel,
                embedding_calls: embeddingCalls,
                duration_ms: Date.now() - t0,
                via,
            });
            if (dedupedCount > 0) {
                sampleTelemetry(db, { metric: "repeated_context_turns", value: 1, projectId: sessionScope.projectId, sessionId });
            }
            return "";
        }
        // Provenance is the fail-closed durability gate; the dedup ledger is
        // only best-effort operational state. Writing the ledger first would
        // suppress a later retry when the prepared receipt fails to persist.
        const injectedIds = [...new Set(emittedRevisions.map(([id]) => id))];
        if (injectedIds.length > 0) {
            commitInjectionState(db, {
                sessionId,
                project,
                prompt: userPrompt,
                factIds: injectedIds,
                projectId: sessionScope.projectId,
                workspaceId: sessionScope.workspaceId,
                workstreamId: sessionScope.workstreamId,
                contextEpoch: residency.contextEpoch,
                projectMemoryRevision: currentProjectRevision,
                revisions: emittedRevisions,
            });
        }
        commitGateState(db, { sessionId, contextEpoch: residency.contextEpoch, tokens: decision.tokens, embedding, watchLedger: nextWatchLedger, now });
        if (rendered.sections.some((s) => s.kind === "WORK NOW") && capsule && canQuery(db)) {
            db.prepare("UPDATE session_memory_state SET capsule_generation_seen = ? WHERE session_id = ? AND context_epoch = ?")
                .run(capsule.generation, sessionId, residency.contextEpoch);
        }
        const block = rendered.text + "\n";
        const sectionKinds = rendered.sections.map((s) => s.kind);
        sampleTelemetry(db, { metric: "injected_facts", value: injectedIds.length, projectId: sessionScope.projectId, sessionId });
        sampleTelemetry(db, { metric: "injected_chars", value: block.length, unit: "chars", projectId: sessionScope.projectId, sessionId });
        sampleTelemetry(db, { metric: "estimated_tokens", value: estimateTokens(block.length), unit: "tokens", projectId: sessionScope.projectId, sessionId });
        sampleTelemetry(db, { metric: "bundle_size", value: block.length, unit: "chars", projectId: sessionScope.projectId, sessionId, dims: { kind: "normal", sections: sectionKinds } });
        for (const section of rendered.sections) {
            sampleTelemetry(db, { metric: "section_chars", value: section.chars, unit: "chars", projectId: sessionScope.projectId, sessionId, dims: { section: section.kind } });
        }
        const emittedCorrections = rendered.sections.find((s) => s.kind === "CORRECTION")?.emitted.length ?? 0;
        if (emittedCorrections > 0) {
            sampleTelemetry(db, { metric: "correction_count", value: emittedCorrections, projectId: sessionScope.projectId, sessionId, dims: { path: "revision_delta" } });
        }
        if (emittedWatch > 0) {
            sampleTelemetry(db, { metric: "watch_emissions", value: emittedWatch, projectId: sessionScope.projectId, sessionId, dims: { keys: watchItems.slice(0, emittedWatch).map((w) => w.key) } });
        }
        if (dedupedCount > 0) {
            sampleTelemetry(db, { metric: "repeated_context_turns", value: 1, projectId: sessionScope.projectId, sessionId });
        }
        appendInjectLog({
            status: "injected",
            project,
            prompt_len: userPrompt.length,
            candidates: candidates.length,
            injected: injectedIds.length,
            deduped: dedupedCount,
            chars: block.length,
            gate: gateLabel,
            embedding_calls: embeddingCalls,
            sections: sectionKinds,
            duration_ms: Date.now() - t0,
            via,
        });
        return block;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendInjectLog({
            status: "error",
            project,
            prompt_len: userPrompt.length,
            duration_ms: Date.now() - t0,
            error: message.slice(0, 300),
            via,
        });
        return ""; // non-fatal: never disrupt the user's prompt
    }
}
