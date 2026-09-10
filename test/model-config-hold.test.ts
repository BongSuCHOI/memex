import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * The HOLD contract, asserted at the REAL extraction entry point (§3.5.6).
 *
 * Not a stub: `runFactExtraction` goes through `claimExtractionTargetWithReason`,
 * so the three writes a hold must undo — memory_jobs (running + lease +
 * attempts+1), extraction_targets (the same), checkpoints `processing` — really
 * happen before the model is called. Asserting on a stub would have passed in
 * every broken revision of this design.
 *
 * What must be true after a rejected model selection:
 *   one provider call, no window splitting, no irreducible failure,
 *   no failed range, no completion log, attempts back where they started,
 *   nothing `dead` however many times it repeats, and automatic resume when the
 *   selection changes.
 */

// The provider stub: a real envelope rejection, built from the measured body.
let providerCalls = 0;
let rejectEnvelope = true;
vi.mock("../src/codex-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-exec.js")>();
  return {
    ...actual,
    runCodex: async (opts: {
      onObservation?: (o: unknown) => void;
      model?: string | null;
      systemPrompt?: string;
      userMessage?: string;
    }) => {
      providerCalls++;
      const selection = await actual.resolveCodexSelection({ model: opts.model });
      opts.onObservation?.({
        duration_ms: 1,
        token_usage: null,
        model: selection.model,
        reasoning_effort: selection.reasoningEffort,
      });
      if (rejectEnvelope) {
        throw new actual.CodexRequestRejectedError({
          status: 400,
          providerType: "invalid_request_error",
          providerMessage: `The '${selection.model}' model is not supported when using Codex with a ChatGPT account.`,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        });
      }
      // The second model stage: extraction candidates go through a semantic
      // entailment verifier before they are saved, so the happy path has to
      // answer it too or nothing is ever committed.
      if (opts.systemPrompt?.includes("authoritative-entailment-v3")) {
        const envelope = JSON.parse(opts.userMessage ?? "{}") as {
          candidates: Array<{
            selected_context_dependencies: Array<{ context_id: string; relation: string }>;
          }>;
        };
        return JSON.stringify(
          (envelope.candidates ?? []).map((candidate, index) => ({
            candidate_index: index + 1,
            verdict: "ENTAILED",
            used_context_dependencies: candidate.selected_context_dependencies,
            used_local_context_exchange_indices: [],
          })),
        );
      }
      return JSON.stringify([
        {
          fact: "Flutter 상태관리는 Riverpod으로 결정했다",
          category: "preference",
          scope_type: "project",
          confidence: 0.9,
          grounding_type: "explicit",
          durable: true,
          evidence: [
            {
              exchange_index: 1,
              source: "human",
              kind: "assertion",
              supporting_span: "Riverpod",
            },
          ],
          context_dependencies: [],
        },
      ]);
    },
  };
});

vi.mock("../src/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock("../src/ontology-classifier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

let root: string;
let db: Database.Database;

interface Snapshot {
  jobState: string;
  jobAttempts: number;
  jobHoldReason: string | null;
  jobLeaseOwner: string | null;
  targetState: string;
  targetAttempts: number;
  targetLeaseOwner: string | null;
  checkpointState: string | null;
  failedRanges: number;
  extractionLog: number;
}

function snapshot(): Snapshot {
  const job = db.prepare(
    "SELECT state, attempts, hold_reason, lease_owner, checkpoint_id FROM memory_jobs WHERE kind = 'fact_extract'",
  ).get() as {
    state: string; attempts: number; hold_reason: string | null;
    lease_owner: string | null; checkpoint_id: string | null;
  };
  const target = db.prepare(
    "SELECT state, attempts, lease_owner FROM extraction_targets",
  ).get() as { state: string; attempts: number; lease_owner: string | null } | undefined;
  const checkpoint = job.checkpoint_id
    ? (db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = ?")
        .get(job.checkpoint_id) as { state: string } | undefined)
    : undefined;
  return {
    jobState: job.state,
    jobAttempts: job.attempts,
    jobHoldReason: job.hold_reason,
    jobLeaseOwner: job.lease_owner,
    targetState: target?.state ?? "none",
    targetAttempts: target?.attempts ?? -1,
    targetLeaseOwner: target?.lease_owner ?? null,
    checkpointState: checkpoint?.state ?? null,
    failedRanges: (db.prepare("SELECT COUNT(*) AS n FROM extraction_failed_ranges").get() as { n: number }).n,
    extractionLog: (db.prepare("SELECT COUNT(*) AS n FROM extraction_log").get() as { n: number }).n,
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-config-hold-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  process.env.MEMEX_CODEX_MODEL = "broken-model";
  delete process.env.MEMEX_CODEX_REASONING;
  providerCalls = 0;
  rejectEnvelope = true;

  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  const { initDatabase } = await import("../src/db.js");
  db = initDatabase();
  const insert = db.prepare(`
    INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path,
       line_start, line_end, session_id, is_sidechain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S1', 0)
  `);
  for (let i = 0; i < 6; i++) {
    insert.run(
      `e${i}`, "/tmp/p", new Date(Date.now() + i * 1_000).toISOString(),
      "Flutter 상태관리는 Riverpod으로 결정했습니다.",
      "Riverpod 결정을 확인합니다.", `/tmp/a${i}.jsonl`, i * 10, i * 10 + 9,
    );
  }
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  delete process.env.MEMEX_LLM_RETRY_BASE_MS;
  delete process.env.MEMEX_CODEX_MODEL;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a rejected model selection holds extraction", () => {
  it("returns the whole claim and records one hold", async () => {
    const { runFactExtraction } = await import("../src/fact-extractor.js");
    const {
      activeModelConfigHold, listModelConfigHolds,
    } = await import("../src/model-budget.js");
    const { llmSelectionFingerprint } = await import("../src/model-settings.js");

    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow(/not supported|envelope/);

    // One call, period: no retry ladder, no window splitting.
    expect(providerCalls).toBe(1);

    const after = snapshot();
    expect(after.jobState).toBe("pending");
    expect(after.jobHoldReason).toBe("model_config_rejected");
    expect(after.jobAttempts).toBe(0);
    expect(after.jobLeaseOwner).toBeNull();
    expect(after.targetState).toBe("pending");
    expect(after.targetAttempts).toBe(0);
    expect(after.targetLeaseOwner).toBeNull();
    // The claim's `processing` marker is rolled back.
    expect(after.checkpointState).not.toBe("processing");
    // Nothing blames the conversation.
    expect(after.failedRanges).toBe(0);
    expect(after.extractionLog).toBe(0);

    // The attempt survives as evidence, out of the accounting.
    const attempt = db.prepare(
      "SELECT state, outcome, model FROM model_work_attempts",
    ).all() as Array<{ state: string; outcome: string | null; model: string | null }>;
    expect(attempt).toHaveLength(1);
    expect(attempt[0].state).toBe("failed");
    expect(attempt[0].outcome).toBe("config_rejected");
    expect(attempt[0].model).toBe("broken-model");
    const reserved = db.prepare(
      "SELECT reserved_attempts FROM model_work_budgets",
    ).get() as { reserved_attempts: number };
    expect(reserved.reserved_attempts).toBe(0);

    expect(activeModelConfigHold(db, llmSelectionFingerprint())?.model).toBe("broken-model");
    expect(listModelConfigHolds(db)).toHaveLength(1);
  });

  it("costs ZERO provider calls on the second run", async () => {
    const { runFactExtraction } = await import("../src/fact-extractor.js");
    const { activeModelConfigHold } = await import("../src/model-budget.js");
    const { llmSelectionFingerprint } = await import("../src/model-settings.js");

    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();
    expect(providerCalls).toBe(1);

    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();
    // The gate sits before the reservation, so the second run spends nothing.
    expect(providerCalls).toBe(1);
    expect(activeModelConfigHold(db, llmSelectionFingerprint())?.observedCount).toBe(2);
    expect(snapshot().jobState).toBe("pending");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM model_work_attempts").get() as { n: number }).n,
    ).toBe(1);
  });

  it("can NEVER reach dead, past max_attempts", async () => {
    const { runFactExtraction } = await import("../src/fact-extractor.js");
    db.prepare("UPDATE memory_jobs SET max_attempts = 2 WHERE kind = 'fact_extract'").run();

    for (let round = 0; round < 6; round++) {
      await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();
      const after = snapshot();
      expect(after.jobState, `round ${round}`).toBe("pending");
      expect(after.jobAttempts, `round ${round}`).toBe(0);
      expect(after.checkpointState, `round ${round}`).not.toBe("failed-visible");
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE state = 'dead'").get() as { n: number }).n,
    ).toBe(0);
    // Both layers did their job: the claim refund AND the pre-claim gate.
    expect(providerCalls).toBe(1);
  });

  it("resumes automatically when the selection changes", async () => {
    const { runFactExtraction } = await import("../src/fact-extractor.js");
    const { currentModelConfigHold } = await import("../src/model-budget.js");
    const { invalidateModelSettingsCache } = await import("../src/model-settings.js");

    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();
    expect(snapshot().jobHoldReason).toBe("model_config_rejected");

    // The user fixes the selection; nothing is explicitly cleared.
    process.env.MEMEX_CODEX_MODEL = "working-model";
    invalidateModelSettingsCache();
    rejectEnvelope = false;
    expect(currentModelConfigHold(db)).toBeNull();

    const result = await runFactExtraction(db, "S1", "/tmp/p");
    expect(result.saved).toBeGreaterThan(0);
    // The next successful claim clears the marker with it.
    expect(snapshot().jobHoldReason).toBeNull();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it("reports the failure as `config`/held, not as a budget burn", async () => {
    const { runFactExtraction, classifyExtractionFailure, FAILURE_REPORT } =
      await import("../src/fact-extractor.js");
    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toSatisfy((error: unknown) => {
      const kind = classifyExtractionFailure(error);
      expect(kind).toBe("config");
      expect(FAILURE_REPORT[kind].bucket).toBe("held");
      expect(FAILURE_REPORT[kind].consumesBudget).toBe(false);
      return true;
    });
  });
});

describe("a hold stops model work and nothing else", () => {
  it("lets the Continuity worker keep draining capture_index", async () => {
    const { runContinuityWorker } = await import("../src/continuity-worker.js");
    const { recordModelConfigHold } = await import("../src/model-budget.js");
    const { llmSelectionFingerprint } = await import("../src/model-settings.js");
    const { captureTranscriptPrefix, ensureSessionMemoryState } =
      await import("../src/continuity-core.js");

    const transcript = path.join(root, "sess-2222.jsonl");
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: "session_meta", payload: { id: "sess-2222", cwd: root } })}\n` +
        `${JSON.stringify({ type: "event_msg", payload: { type: "note", text: "" } })}\n`,
    );
    process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
    ensureSessionMemoryState(db, { sessionId: "sess-2222", project: root });
    captureTranscriptPrefix(db, {
      sessionId: "sess-2222", project: root, transcriptPath: transcript, kind: "final",
    });

    recordModelConfigHold(db, {
      fingerprint: llmSelectionFingerprint(),
      model: "broken-model",
      reasoningEffort: null,
      status: 400,
      providerType: "invalid_request_error",
      providerMessage: "not supported",
    });

    const results = await runContinuityWorker(db, {
      maxJobs: 4,
      model: async () => { throw new Error("the capsule lane must not be reached"); },
    });

    // P0 capture ran; the model lane was never claimed. Gating the whole worker
    // would have stopped conversation capture, which must never happen.
    expect(results.some((entry) => entry.kind === "capture_index")).toBe(true);
    expect(results.some((entry) => entry.kind === "capsule_update")).toBe(false);
    expect(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'capsule_update' AND state = 'running'",
      ).get() as { n: number }).n,
    ).toBe(0);
    delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  });
});

describe("the probe is the repair", () => {
  it("passes the hold, lifts it on success and releases the held jobs", async () => {
    const { runFactExtraction } = await import("../src/fact-extractor.js");
    const { probeModel } = await import("../src/model-settings-probe.js");
    const { currentModelConfigHold, heldJobSummary } = await import("../src/model-budget.js");

    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();
    expect(currentModelConfigHold(db)).not.toBeNull();
    expect(heldJobSummary(db)).toEqual([
      { reason: "model_config_rejected", jobs: 1, oldestHeldAt: expect.any(String) },
    ]);

    // The user fixes nothing yet, but the probe must still be able to RUN —
    // otherwise the hold would refuse the very call that proves it can be lifted.
    rejectEnvelope = false;
    const before = providerCalls;
    const result = await probeModel(db, { model: "broken-model" });
    expect(providerCalls).toBe(before + 1);
    expect(result.ok).toBe(true);
    expect(result.clearedHold?.clearedHolds).toBe(1);
    expect(result.clearedHold?.releasedJobs).toBe(1);
    expect(currentModelConfigHold(db)).toBeNull();
    expect(heldJobSummary(db)).toEqual([]);

    // The probe leaves one honest ledger row under its own stage.
    const probeAttempt = db.prepare(
      "SELECT stage, state FROM model_work_attempts WHERE stage = 'model_probe'",
    ).all() as Array<{ stage: string; state: string }>;
    expect(probeAttempt).toHaveLength(1);
    expect(probeAttempt[0].state).toBe("completed");
  });

  it("reports a still-broken selection as a config rejection and keeps the hold", async () => {
    const { probeModel } = await import("../src/model-settings-probe.js");

    const result = await probeModel(db, { model: "broken-model", reasoning: null });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("config");
    expect(result.rejection?.status).toBe(400);
    expect(result.rejection?.message).toContain("not supported");
    // The failed probe recorded the hold itself, under ITS selection (explicit),
    // so the next ordinary call of the same id is free too.
    const { activeModelConfigHold } = await import("../src/model-budget.js");
    const { llmSelectionFingerprint } = await import("../src/model-settings.js");
    expect(
      activeModelConfigHold(
        db,
        llmSelectionFingerprint({ model: "broken-model", reasoningEffort: null }),
      ),
    ).not.toBeNull();
  });
});

describe("operator surfaces", () => {
  it("memex status counts held jobs on their own line, not as failures", async () => {
    const { runFactExtraction } = await import("../src/fact-extractor.js");
    const { getPipelineStatus, formatPipelineStatus } = await import("../src/pipeline-status.js");

    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();

    const status = getPipelineStatus(db);
    expect(status.attention.modelConfigHeld).toBe(1);
    // A held job is not dead and not in retry, so the actionable count is
    // untouched — folding it in would read as a failure that needs recovery.
    expect(status.attention.total).toBe(0);
    const text = formatPipelineStatus(status);
    expect(text).toContain("model config held: 1");
    expect(text).toContain("memex models show");
  });
});

describe("doctor llm-model", () => {
  it("is ok with the resolved selection and its provenance", async () => {
    const { llmModelCheck } = await import("../src/lifecycle.js");
    const check = llmModelCheck();
    expect(check.name).toBe("llm-model");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("model broken-model (via env)");
    expect(check.detail).toContain("reasoning unset");
  });

  it("warns with the provider's own sentence once a hold is active", async () => {
    const { runFactExtraction } = await import("../src/fact-extractor.js");
    const { llmModelCheck } = await import("../src/lifecycle.js");

    await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();

    const check = llmModelCheck();
    expect(check.status).toBe("warn");
    // The provider's own sentence is the most useful thing to show here.
    expect(check.detail).toContain("not supported when using Codex");
    // And it must say plainly that nothing was lost.
    expect(check.detail).toContain("no attempt was consumed");
    expect(check.detail).toContain("memex models test");
    expect(check.detail).toContain("model_config_rejected=1");
  });

  it("stays ok when the active hold belongs to a DIFFERENT selection", async () => {
    const { recordModelConfigHold } = await import("../src/model-budget.js");
    const { llmSelectionFingerprint } = await import("../src/model-settings.js");
    const { llmModelCheck } = await import("../src/lifecycle.js");

    recordModelConfigHold(db, {
      fingerprint: llmSelectionFingerprint({ model: "someone-elses-model" }),
      model: "someone-elses-model",
      reasoningEffort: null,
      status: 400,
      providerType: null,
      providerMessage: "nope",
    });

    const check = llmModelCheck();
    // Another process's hold is visible but inert — reporting it as a failure
    // here would send the operator to fix a setting that is not theirs.
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("OTHER selections");
    expect(check.detail).toContain("someone-elses-model");
  });
});

it("writes one metadata-only audit line per hold and per probe", async () => {
  const { runFactExtraction } = await import("../src/fact-extractor.js");
  const { probeModel } = await import("../src/model-settings-probe.js");

  await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();
  rejectEnvelope = false;
  await probeModel(db, { model: "broken-model" });

  const lines = fs.readFileSync(path.join(root, "logs", "ui-audit.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const hold = lines.find((line) => line.action === "models.llm.hold");
  const probe = lines.find((line) => line.action === "models.llm.probe");
  expect(hold).toMatchObject({
    model: "broken-model",
    provider_status: 400,
    provider_type: "invalid_request_error",
    stage: "fact_extract",
  });
  // Only the fingerprint PREFIX — the whole value lives in the database.
  expect(String(hold.fingerprint_prefix)).toHaveLength(12);
  expect(probe).toMatchObject({ model: "broken-model", ok: true });
  // The probe's answer text is never logged.
  expect(JSON.stringify(probe)).not.toContain("MEMEX_OK");
});

it("memex jobs list reports the held job as waiting on a configuration", async () => {
  const { runFactExtraction } = await import("../src/fact-extractor.js");
  const { listMemoryJobs } = await import("../src/job-recovery.js");

  await expect(runFactExtraction(db, "S1", "/tmp/p")).rejects.toThrow();

  const held = listMemoryJobs(db, { kind: "fact_extract" }).find(
    (job) => job.holdReason !== null,
  );
  expect(held).toBeDefined();
  expect(held!.holdReason).toBe("model_config_rejected");
  // Not dead and not in retry: the surface must not read as a failure.
  expect(held!.state).toBe("pending");
  expect(held!.attempts).toBe(0);
});
