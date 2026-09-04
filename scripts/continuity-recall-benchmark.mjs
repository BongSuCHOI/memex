#!/usr/bin/env node
/**
 * Phase 5 reproducible recall calibration harness.
 *
 * Runs the Prompt 5A/5B workloads through the real `computeInjectContext`
 * path twice per workload — baseline (cheap gate disabled: every prompt
 * retrieves, the pre-continuity behaviour) and gated (Phase 5) — on an
 * isolated database with the deterministic embedding stub
 * (`MEMEX_EMBEDDING_STUB=1`, no model download, no network). Ground truth is
 * planted (stale facts, sibling-workstream facts, verified incident patterns,
 * mandatory memory intents) so recall and scope quality are measured, not
 * assumed. Writes `docs/verification/continuity-v1/recall-calibration.json`.
 *
 * Usage: node scripts/continuity-recall-benchmark.mjs [--out <path>]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

process.env.MEMEX_EMBEDDING_STUB = process.env.MEMEX_EMBEDDING_STUB ?? "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-recall-bench-"));
process.env.MEMEX_HOME = path.join(root, "home");

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (file) => path.join(here, "..", "dist", file);
const { initDatabase, insertExchange } = await import(dist("db.js"));
const { insertFact } = await import(dist("fact-db.js"));
const { mutateFactMeaning } = await import(dist("fact-management.js"));
const { computeInjectContext } = await import(dist("inject-core.js"));
const { DEFAULT_RECALL_GATE_CONFIG } = await import(dist("recall-gate.js"));
const { NORMAL_BUNDLE_BUDGET, REHYDRATION_BUNDLE_BUDGET } = await import(dist("memory-bundle.js"));
const { recordIncidentOccurrence, recordChronicleEvent, readChronicleTimeline, summarizeTelemetry } = await import(dist("chronicle.js"));
const { ensureSessionMemoryState, advanceContextEpoch, buildRehydrationContext } = await import(dist("continuity-core.js"));
const { createWorkstream, bindSessionWorkstream, indexHotEvidenceForSession } = await import(dist("continuity-identity.js"));
const { stubEmbedding } = await import(dist("embeddings.js"));
const { handleToolCall } = await import(dist("mcp-server.js"));

const outArg = process.argv.indexOf("--out");
const outPath = outArg >= 0 ? process.argv[outArg + 1] : path.join(here, "..", "docs", "verification", "continuity-v1", "recall-calibration.json");
const cwd = "/project/recall-bench";

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function openDb(name) {
  const dbPath = path.join(root, `${name}.sqlite`);
  process.env.TEST_DB_PATH = dbPath;
  return initDatabase({ dbPath });
}

function fact(db, text, extra = {}) {
  return insertFact(db, { fact: text, category: "decision", scope_type: "project", scope_project: cwd, source_exchange_ids: [], embedding: stubEmbedding(text), ...extra });
}

function exchange(db, id, sessionId, timestamp, userMessage, assistantMessage = "context only") {
  insertExchange(db, {
    id, project: cwd, cwd, timestamp, userMessage, assistantMessage,
    archivePath: path.join(root, `${sessionId}.jsonl`), lineStart: 1, lineEnd: 2, sessionId,
    closureState: "closed", parserVersion: 2,
  }, stubEmbedding(userMessage));
}

function toolFailure(db, exchangeId, id, result, timestamp) {
  db.prepare("INSERT INTO tool_calls (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable) VALUES (?, ?, 'shell', '{}', ?, 1, ?, 'test_execution', 1)")
    .run(id, exchangeId, result, timestamp);
}

/** Seed one project corpus with planted ground truth. */
function seed(db) {
  const session = ensureSessionMemoryState(db, { sessionId: "seed", project: cwd, prompt: "seed" });
  const projectId = session.projectId;
  const facts = {
    store: fact(db, "The runtime session store is Redis", { subject_key: "state.runtime.session_store" }),
    rollout: fact(db, "Deployments use blue green rollout with health checks", { subject_key: "state.deploy.rollout" }),
    ttl: fact(db, "Session TTL is thirty minutes because of the compliance review", { subject_key: "constraint.session.ttl" }),
    stale: fact(db, "The payment retry limit is three attempts", { subject_key: "state.payment.retry_limit" }),
  };
  for (const [key, id] of Object.entries(facts)) {
    const row = db.prepare("SELECT fact, subject_key FROM facts WHERE id = ?").get(id);
    recordChronicleEvent(db, { kind: "ASSERTED", projectId, subjectKey: row.subject_key, factId: id, newValue: row.fact, actor: "user", projectionApplied: true, effectiveAt: "2026-08-01T00:00:00.000Z" });
    void key;
  }
  // Divergent truth: an unmerged workstream experiment must never reach main sessions.
  const experiment = createWorkstream(db, { projectId, workspaceId: session.workspaceId, projectPath: cwd, ownerSessionId: "experiment-owner", branch: "feature/sharded" });
  bindSessionWorkstream(db, { sessionId: "experiment-owner", projectId, workspaceId: session.workspaceId, projectPath: cwd, explicitWorkstreamId: experiment });
  insertFact(db, {
    fact: "EXPERIMENTAL the runtime session store is a sharded Redis cluster", category: "knowledge", scope_type: "project", scope_project: cwd,
    source_exchange_ids: [], embedding: stubEmbedding("EXPERIMENTAL the runtime session store is a sharded Redis cluster"),
    project_id: projectId, workspace_id: session.workspaceId, workstream_id: experiment, promotion_state: "workstream", promotion_evidence: "experimental",
  });
  // Verified incident pattern (two independent episodes) plus a single-episode candidate.
  exchange(db, "inc-1", "inc-session-a", "2026-07-02T10:00:00.000Z", "run the integration tests");
  toolFailure(db, "inc-1", "inc-t1", "FAIL redis reconnect: missing TTL refresh", "2026-07-02T10:00:00.000Z");
  exchange(db, "inc-2", "inc-session-b", "2026-08-14T10:00:00.000Z", "run the failover tests");
  toolFailure(db, "inc-2", "inc-t2", "FAIL redis reconnect: missing TTL refresh", "2026-08-14T10:00:00.000Z");
  exchange(db, "inc-3", "inc-session-c", "2026-08-20T10:00:00.000Z", "run the migration");
  toolFailure(db, "inc-3", "inc-t3", "FAIL migration lock timeout on accounts table", "2026-08-20T10:00:00.000Z");
  recordIncidentOccurrence(db, { projectId, sessionId: "inc-session-a", signatureText: "FAIL redis reconnect: missing TTL refresh", sourceExchangeIds: ["inc-1"], sourceEvidenceIds: ["inc-t1"], evidenceAuthority: "trusted-tool", actor: "extractor" });
  recordIncidentOccurrence(db, { projectId, sessionId: "inc-session-b", signatureText: "FAIL redis reconnect: missing TTL refresh", sourceExchangeIds: ["inc-2"], sourceEvidenceIds: ["inc-t2"], evidenceAuthority: "trusted-tool", actor: "extractor" });
  recordIncidentOccurrence(db, { projectId, sessionId: "inc-session-c", signatureText: "FAIL migration lock timeout on accounts table", sourceExchangeIds: ["inc-3"], sourceEvidenceIds: ["inc-t3"], evidenceAuthority: "trusted-tool", actor: "extractor" });
  // Stale assistant answer that must never outrank current truth.
  exchange(db, "old-answer", "old-session", "2026-06-01T00:00:00.000Z", "Why did we pick the redis session store originally?", "Because MySQL locked up under burst traffic; we picked Redis.");
  // Large Chronicle timeline for the MCP pagination check.
  for (let i = 0; i < 60; i++) {
    recordChronicleEvent(db, { kind: "VALIDATED", projectId, subjectKey: "state.deploy.rollout", newValue: `rollout validation ${i}`, outcome: { i }, sourceExchangeIds: ["inc-1"], sourceEvidenceIds: [], actor: "user", effectiveAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:${String(i % 60).padStart(2, "0")}.000Z`, projectionApplied: false });
  }
  return { projectId, facts };
}

const ACKS = ["thanks", "ok", "계속해", "응", "good", "continue", "네 계속해주세요", "sounds good, go ahead"];
const TOPIC_STORE_KR = ["redis 세션 스토어 클라이언트를 설정해줘", "redis 클라이언트 재시도 옵션도 추가해줘", "redis 클라이언트 에러 로그 남겨줘", "세션 스토어 타임아웃 조정해줘"];
const HISTORY_KR = [
  { prompt: "왜 redis 세션 스토어를 선택했지?", expect: "state.runtime.session_store" },
  { prompt: "세션 ttl 제약의 이전 기록 보여줘", expect: "constraint.session.ttl" },
];
const TOPIC_STORE = ["Configure the redis runtime session store client", "add the redis client retry option", "log redis client errors", "tune the redis session store timeout"];
const TOPIC_ROLLOUT = ["Rewrite the deployment rollout pipeline with canary stages", "add health checks to the rollout", "document the rollout runbook"];
const TOPIC_TTL = ["Set the session ttl to thirty minutes in config", "keep the ttl", "expose the ttl in the admin panel"];
const HISTORY = [
  { prompt: "Why did we choose the redis runtime session store?", expect: "state.runtime.session_store" },
  { prompt: "What is the history of the session ttl constraint?", expect: "constraint.session.ttl" },
  { prompt: "Where did the blue green rollout decision come from?", expect: "state.deploy.rollout" },
];

/** Build the workload list. Each prompt carries optional expectations. */
function workloads() {
  const list = [];
  list.push({ name: "follow-up-heavy", prompts: Array.from({ length: 10 }, () => TOPIC_STORE).flat().map((p) => ({ p })) });
  list.push({ name: "ack-heavy", prompts: [{ p: TOPIC_STORE[0] }, ...Array.from({ length: 39 }, (_, i) => ({ p: ACKS[i % ACKS.length], ack: true }))] });
  list.push({ name: "topic-shift-heavy", prompts: Array.from({ length: 8 }, () => [TOPIC_STORE[0], TOPIC_ROLLOUT[0], TOPIC_TTL[0]]).flat().map((p) => ({ p })) });
  list.push({ name: "explicit-history-source", prompts: Array.from({ length: 6 }, () => HISTORY).flat().map((h) => ({ p: h.prompt, mustRecall: h.expect })) });
  list.push({ name: "same-fact-evolution-rollback-correction", prompts: [
    { p: "Configure the payment retry limit handler" },
    { p: "thanks", ack: true },
    { mutate: { key: "stale", text: "The payment retry limit is five attempts" } },
    { p: "ok now wire the payment retry limit handler", expectCorrection: "five attempts", staleText: "three attempts" },
    { mutate: { key: "stale", text: "The payment retry limit is three attempts" } },
    { p: "and add the payment retry limit metric", expectCorrection: "three attempts", staleText: "five attempts" },
    { p: "great", ack: true },
  ] });
  list.push({ name: "compaction-heavy-200", prompts: Array.from({ length: 200 }, (_, i) => {
    if (i === 3) return { capsule: true };
    if (i % 25 === 24) return { compact: true };
    // The first prompt after every other compaction is a bare continuation: the Capsule must still carry (no vector).
    if (i % 50 === 25) return { p: "계속해", ack: true, expectWorkNow: true };
    const cycle = [TOPIC_STORE, TOPIC_ROLLOUT, TOPIC_TTL][Math.floor(i / 5) % 3];
    return i % 5 === 4 ? { p: ACKS[i % ACKS.length], ack: true } : { p: cycle[i % cycle.length] };
  }) });
  list.push({ name: "korean-follow-up-ack", prompts: [
    ...Array.from({ length: 5 }, () => TOPIC_STORE_KR).flat().map((p, i) => (i % 3 === 2 ? { p: ACKS[(i + 2) % ACKS.length], ack: true } : { p })),
    ...HISTORY_KR.map((h) => ({ p: h.prompt, mustRecall: h.expect })),
  ] });
  list.push({ name: "same-project-same-workstream", prompts: [
    { p: "Configure the payment retry limit handler" },
    { siblingMutate: { key: "stale", text: "The payment retry limit is five attempts" }, siblingEvidence: "Sibling verified the payment retry handler against five attempts" },
    { p: "thanks", ack: true, expectCorrection: "five attempts", staleText: "three attempts", expectEvidence: "Sibling verified" },
    { p: "ok", ack: true },
    { p: "add the payment retry limit metric now", forbidRepeatEvidence: "Sibling verified" },
  ] });
  list.push({ name: "same-project-different-workstreams", prompts: Array.from({ length: 12 }, (_, i) => ({ p: TOPIC_STORE[i % TOPIC_STORE.length], forbid: "EXPERIMENTAL" })) });
  list.push({ name: "incident-recurrence", prompts: [
    { p: "Configure the redis runtime session store client" },
    { p: "The suite prints FAIL redis reconnect: missing TTL refresh in staging", expectWatch: true },
    { p: "The suite prints FAIL redis reconnect: missing TTL refresh once more", expectWatchSuppressed: true },
    { p: "The migration step says FAIL migration lock timeout on accounts table", falseWatch: true },
    { p: "Why did we pick the redis session store originally?", forbidAssistantAboveTruth: true },
  ] });
  list.push({ name: "embeddings-unavailable", prompts: [{ p: TOPIC_STORE[0] }, { failEmbeddings: true }, { p: "thanks", ack: true }, { p: TOPIC_ROLLOUT[0], degraded: true }, { p: "ok", ack: true }, { restoreEmbeddings: true }] });
  return list;
}

async function runWorkload(workload, gate) {
  const db = openDb(`${workload.name}-${gate ? "gated" : "baseline"}`);
  const { projectId, facts } = seed(db);
  const session = `bench-${workload.name}-${gate ? "g" : "b"}`;
  const latencies = [];
  const outcome = {
    prompts: 0, acks: 0, ackEmbeddingCalls: 0, contexts: 0, injectedChars: 0, maxBundleChars: 0,
    staleInjections: 0, wrongWorkstreamInjections: 0, mandatoryRecallMisses: 0, mandatoryRecalls: 0,
    correctionsExpected: 0, correctionsSeen: 0, watchExpected: 0, watchSeen: 0, watchFalse: 0, watchSuppressedOk: 0,
    assistantAboveTruth: 0, degradedOk: 0, duplicateInjections: 0, workNowExpected: 0, workNowSeen: 0,
    evidenceExpected: 0, evidenceSeen: 0, repeatedEvidence: 0,
  };
  // Duplicate injection = the same bullet line emitted twice inside one context epoch.
  let epochLines = new Set();
  // Mandatory recall is residency-aware: a subject already injected in this epoch is in context.
  let epochRecalled = new Set();
  const mandatoryKeys = [...new Set(workload.prompts.filter((step) => step.mustRecall).map((step) => step.mustRecall))];
  let capsuleGeneration = 0;
  const embeddingRequests = () => Number(db.prepare(
    "SELECT COALESCE(SUM(value),0) AS v FROM continuity_telemetry WHERE metric IN ('embedding_calls','embedding_cache_hits') AND session_id = ?",
  ).get(session).v);
  for (const step of workload.prompts) {
    if (step.compact) {
      advanceContextEpoch(db, { sessionId: session, source: "compact", turnId: `c-${outcome.prompts}` });
      db.prepare("UPDATE session_memory_state SET last_source = 'compact' WHERE session_id = ?").run(session);
      const bundle = buildRehydrationContext(db, { sessionId: session });
      outcome.maxBundleChars = Math.max(outcome.maxBundleChars, bundle.context.length);
      epochLines = new Set();
      epochRecalled = new Set();
      continue;
    }
    if (step.capsule) {
      const workstreamId = db.prepare("SELECT workstream_id FROM session_memory_state WHERE session_id = ?").get(session).workstream_id;
      capsuleGeneration += 1;
      db.prepare(`
        INSERT INTO work_capsules (workstream_id, generation, objective, current_state, next_actions_json, updated_at)
        VALUES (?, ?, 'Ship the redis session store', 'client wired, tests pending', '["run the failover test"]', ?)
        ON CONFLICT(workstream_id) DO UPDATE SET generation = excluded.generation, objective = excluded.objective
      `).run(workstreamId, capsuleGeneration, new Date().toISOString());
      continue;
    }
    if (step.mutate) {
      await mutateFactMeaning(db, { factId: facts[step.mutate.key], newText: step.mutate.text, chronicle: { actor: "user", userStatedRationale: "benchmark" } });
      continue;
    }
    if (step.siblingMutate) {
      // A second session on the same workstream changes the resident fact and leaves trusted evidence.
      const scope = db.prepare("SELECT project_id, workspace_id, workstream_id FROM session_memory_state WHERE session_id = ?").get(session);
      const sibling = `${session}-sibling`;
      bindSessionWorkstream(db, { sessionId: sibling, projectId: scope.project_id, workspaceId: scope.workspace_id, projectPath: cwd, explicitWorkstreamId: scope.workstream_id });
      await mutateFactMeaning(db, { factId: facts[step.siblingMutate.key], newText: step.siblingMutate.text, chronicle: { actor: "user", userStatedRationale: "sibling benchmark" } });
      exchange(db, `${sibling}-ex`, sibling, new Date().toISOString(), step.siblingEvidence);
      indexHotEvidenceForSession(db, sibling, { now: new Date(Date.now() + 5).toISOString() });
      continue;
    }
    if (step.failEmbeddings) { process.env.MEMEX_EMBEDDING_STUB = "fail"; continue; }
    if (step.restoreEmbeddings) { process.env.MEMEX_EMBEDDING_STUB = "1"; continue; }
    const before = embeddingRequests();
    const t0 = performance.now();
    const context = await computeInjectContext(step.p, cwd, "daemon", session, { gate });
    latencies.push(performance.now() - t0);
    const after = embeddingRequests();
    outcome.prompts++;
    if (step.ack) { outcome.acks++; outcome.ackEmbeddingCalls += after - before; }
    if (context) outcome.contexts++;
    outcome.injectedChars += context.length;
    outcome.maxBundleChars = Math.max(outcome.maxBundleChars, context.length);
    for (const line of context.split("\n")) {
      if (!line.startsWith("- ")) continue;
      if (epochLines.has(line)) outcome.duplicateInjections++;
      epochLines.add(line);
    }
    if (step.expectWorkNow) { outcome.workNowExpected++; if (context.includes("[WORK NOW]")) outcome.workNowSeen++; }
    if (step.expectEvidence) { outcome.evidenceExpected++; if (context.includes(step.expectEvidence)) outcome.evidenceSeen++; }
    if (step.forbidRepeatEvidence && context.includes(step.forbidRepeatEvidence)) outcome.repeatedEvidence++;
    if (step.forbid && context.includes(step.forbid)) outcome.wrongWorkstreamInjections++;
    if (context.includes("EXPERIMENTAL")) outcome.wrongWorkstreamInjections++;
    for (const key of mandatoryKeys) if (context.includes(key)) epochRecalled.add(key);
    if (step.mustRecall) {
      outcome.mandatoryRecalls++;
      const recalledNow = context.includes(step.mustRecall) || context.includes("[CURRENT TRUTH]");
      if (recalledNow) epochRecalled.add(step.mustRecall);
      else if (!epochRecalled.has(step.mustRecall)) outcome.mandatoryRecallMisses++;
    }
    if (step.expectCorrection) {
      outcome.correctionsExpected++;
      if (context.includes("[MEMEX CORRECTION]") && context.includes(step.expectCorrection)) outcome.correctionsSeen++;
      if (context.includes(step.staleText) && !context.includes("[MEMEX CORRECTION]")) outcome.staleInjections++;
    }
    if (step.expectWatch) { outcome.watchExpected++; if (context.includes("[WATCH")) outcome.watchSeen++; }
    if (step.expectWatchSuppressed && !context.includes("[WATCH")) outcome.watchSuppressedOk++;
    if (step.falseWatch && context.includes("redis reconnect")) outcome.watchFalse++;
    if (step.forbidAssistantAboveTruth) {
      const truth = context.indexOf("[CURRENT TRUTH]");
      const assistant = context.indexOf("[ASSISTANT CONTEXT-ONLY");
      if (assistant >= 0 && (truth < 0 || assistant < truth)) outcome.assistantAboveTruth++;
    }
    if (step.degraded && !context.includes("[CURRENT TRUTH]")) outcome.degradedOk++;
  }
  process.env.MEMEX_EMBEDDING_STUB = "1";
  const totals = Object.fromEntries(
    db.prepare("SELECT metric, SUM(value) AS v, COUNT(*) AS n FROM continuity_telemetry WHERE session_id = ? GROUP BY metric").all(session)
      .map((row) => [row.metric, { sum: Number(row.v), samples: Number(row.n) }]),
  );
  const trace = await handleToolCall("trace_fact", { subject_key: "state.deploy.rollout", project_id: projectId, timeline_limit: 20 });
  const timelinePage = readChronicleTimeline(db, { projectId, subjectKey: "state.deploy.rollout", limit: 25 });
  const mcp = {
    traceSuccess: !trace.isError && String(trace.content[0].text).includes("[CHRONICLE EVENT]"),
    timelineBounded: timelinePage.events.length <= 25 && !!timelinePage.nextCursor,
  };
  const summary = summarizeTelemetry(db, { projectId });
  db.close();
  const retrievals = totals.retrieval_execute_count?.sum ?? 0;
  const skips = totals.retrieval_gate_skip_count?.sum ?? 0;
  const inferences = totals.embedding_calls?.sum ?? 0;
  const memoHits = totals.embedding_cache_hits?.sum ?? 0;
  return {
    workload: workload.name,
    mode: gate ? "gated" : "baseline",
    ...outcome,
    retrievals, skips,
    // Requests = model inferences + query-memo hits: the cost on unique prompts.
    // The harness recycles prompt text, so inferences alone understate it.
    embeddingCalls: inferences + memoHits,
    embeddingInferences: inferences,
    embeddingMemoHits: memoHits,
    retrievalsPer100: outcome.prompts ? Math.round((retrievals / outcome.prompts) * 1000) / 10 : 0,
    injectedCharsPer100: outcome.prompts ? Math.round((outcome.injectedChars / outcome.prompts) * 100) : 0,
    latencyMs: { p50: Math.round(percentile(latencies, 0.5) * 100) / 100, p95: Math.round(percentile(latencies, 0.95) * 100) / 100 },
    mcp,
    telemetryNotice: summary.notice,
  };
}

const results = [];
for (const workload of workloads()) {
  results.push(await runWorkload(workload, false));
  results.push(await runWorkload(workload, true));
}
const gated = results.filter((r) => r.mode === "gated");
const baseline = results.filter((r) => r.mode === "baseline");
const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);
const report = {
  generated_at: new Date().toISOString(),
  environment: { platform: `${process.platform} ${process.arch}`, node: process.version, embeddings: "deterministic stub (MEMEX_EMBEDDING_STUB=1)", isolation: root },
  gate_config: DEFAULT_RECALL_GATE_CONFIG,
  budgets: { normal: NORMAL_BUNDLE_BUDGET, rehydration: REHYDRATION_BUNDLE_BUDGET },
  totals: {
    baseline: { prompts: sum(baseline, "prompts"), retrievals: sum(baseline, "retrievals"), embeddingCalls: sum(baseline, "embeddingCalls"), embeddingInferences: sum(baseline, "embeddingInferences"), injectedChars: sum(baseline, "injectedChars"), ackEmbeddingCalls: sum(baseline, "ackEmbeddingCalls"), duplicateInjections: sum(baseline, "duplicateInjections") },
    gated: { prompts: sum(gated, "prompts"), retrievals: sum(gated, "retrievals"), embeddingCalls: sum(gated, "embeddingCalls"), embeddingInferences: sum(gated, "embeddingInferences"), injectedChars: sum(gated, "injectedChars"), ackEmbeddingCalls: sum(gated, "ackEmbeddingCalls"), duplicateInjections: sum(gated, "duplicateInjections") },
  },
  quality_gated: {
    stale_injections: sum(gated, "staleInjections"),
    wrong_workstream_injections: sum(gated, "wrongWorkstreamInjections"),
    mandatory_recall_misses: sum(gated, "mandatoryRecallMisses"),
    mandatory_recalls: sum(gated, "mandatoryRecalls"),
    corrections_seen_of_expected: `${sum(gated, "correctionsSeen")}/${sum(gated, "correctionsExpected")}`,
    watch_seen_of_expected: `${sum(gated, "watchSeen")}/${sum(gated, "watchExpected")}`,
    watch_false_positives: sum(gated, "watchFalse"),
    watch_ttl_suppressions: sum(gated, "watchSuppressedOk"),
    assistant_above_truth: sum(gated, "assistantAboveTruth"),
    duplicate_injections: sum(gated, "duplicateInjections"),
    work_now_carry_seen_of_expected: `${sum(gated, "workNowSeen")}/${sum(gated, "workNowExpected")}`,
    sibling_evidence_seen_of_expected: `${sum(gated, "evidenceSeen")}/${sum(gated, "evidenceExpected")}`,
    repeated_sibling_evidence: sum(gated, "repeatedEvidence"),
    max_bundle_chars: Math.max(...gated.map((r) => r.maxBundleChars)),
    mcp_trace_success: gated.every((r) => r.mcp.traceSuccess),
    mcp_timeline_bounded: gated.every((r) => r.mcp.timelineBounded),
  },
  verdict: {
    noop_path_expensive_calls_zero: sum(gated, "ackEmbeddingCalls") === 0,
    mandatory_memory_intents_recalled: sum(gated, "mandatoryRecallMisses") === 0,
    stale_or_wrong_scope_injection_zero: sum(gated, "staleInjections") === 0 && sum(gated, "wrongWorkstreamInjections") === 0,
    corrections_correct: sum(gated, "correctionsSeen") === sum(gated, "correctionsExpected"),
    hard_budget_respected: Math.max(...results.map((r) => r.maxBundleChars)) <= REHYDRATION_BUNDLE_BUDGET.hard + 1,
    watch_authority_safe: sum(gated, "watchFalse") === 0 && sum(gated, "watchSeen") === sum(gated, "watchExpected"),
    duplicate_injection_zero: sum(gated, "duplicateInjections") === 0,
    capsule_carry_on_continuation: sum(gated, "workNowSeen") === sum(gated, "workNowExpected"),
    sibling_evidence_once: sum(gated, "evidenceSeen") === sum(gated, "evidenceExpected") && sum(gated, "repeatedEvidence") === 0,
    retrieval_reduction: sum(baseline, "retrievals") > 0 ? Math.round((1 - sum(gated, "retrievals") / sum(baseline, "retrievals")) * 1000) / 10 : null,
  },
  workloads: results,
  note: "Measured on the deterministic embedding stub; absolute similarity thresholds must be re-checked on the production model (Prompt 5B). Cost figures are counts of calls and bytes, never time or money savings.",
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
fs.rmSync(root, { recursive: true, force: true });
const failed = Object.entries(report.verdict).filter(([key, value]) => key !== "retrieval_reduction" && value === false);
console.log(JSON.stringify({ out: outPath, verdict: report.verdict, quality: report.quality_gated, totals: report.totals }, null, 2));
if (failed.length > 0) {
  console.error(`recall calibration FAILED: ${failed.map(([k]) => k).join(", ")}`);
  process.exit(1);
}
