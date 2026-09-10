import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getDbPath } from "./paths.js";
import { EMBEDDING_VERSION } from "./embeddings.js";
import { ontologyPendingSqlInline } from "./ontology-selector.js";
import {
  llmSelectionFingerprint,
  resolveLlmModel,
  resolveReasoningEffort,
  type LlmSelectionOverride,
} from "./model-settings.js";

/**
 * Durable accounting for model work.
 *
 * A budget is deliberately a small row plus an append-only attempt ledger. The
 * row is the authority for the cap; the ledger is only the privacy-safe
 * explanation of where that cap went. Prompts, model responses, and secrets
 * never enter either table.
 */
export const MODEL_BUDGET_SCHEMA_VERSION = 1;
export const MODEL_BUDGET_TABLE = "model_work_budgets";
export const MODEL_ATTEMPT_TABLE = "model_work_attempts";
/** Durable requested-target membership. This is separate from provider
 * attempts because a whole batch can be pending before its first await or
 * reservation. */
export const MODEL_TARGET_TABLE = "model_work_targets";

const DEFAULT_MAX_ATTEMPTS = 64;
const DEFAULT_MAX_INPUT_CHARS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
const DEFAULT_DEADLINE_MS = 15 * 60_000;
const MAX_DEADLINE_MS = 24 * 60 * 60_000;
export const AUTOMATIC_MAINTENANCE_WINDOW_MS = 24 * 60 * 60_000;
export const AUTOMATIC_MAINTENANCE_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_AUTOMATIC_MAX_ATTEMPTS = 256;
export const MAINTENANCE_WAKE_INTERVAL_MS = 3 * 60_000;

/** Issue #31: an active hold nobody observes for this long is closed by TTL. */
export const MODEL_CONFIG_HOLD_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Issue #31 — `memory_jobs.hold_reason`. The value set lives here, in ONE
 * place, and both HOLD transitions validate against it so the check is not
 * scattered across the six call sites that use them.
 */
export const HOLD_REASONS = [
  "model_config_rejected", // the provider refused the request envelope
  "extraction_rules_invalid", // a never_extract pattern was quarantined
  "extraction_rules_unavailable", // the never_extract check could not finish
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/**
 * Attempt outcomes that exist as EVIDENCE but are excluded from every budget
 * aggregate (reserved / used / exhausted, and the 24h automatic window).
 *
 * Adding a member here is the whole change needed to make a new "cost nothing"
 * outcome free: the SQL below is generated from this array rather than
 * hand-written per query.
 */
export const BUDGET_FREE_OUTCOMES = ["config_rejected"] as const;
export type BudgetFreeOutcome = (typeof BUDGET_FREE_OUTCOMES)[number];

/** `COALESCE(<alias>.outcome,'') NOT IN (...)` — a budget-relevant attempt. */
function budgetRelevantOutcomeSql(alias: string): string {
  const list = BUDGET_FREE_OUTCOMES.map((value) => `'${value}'`).join(",");
  return `COALESCE(${alias}.outcome,'') NOT IN (${list})`;
}

export type ModelBudgetState = "active" | "exhausted" | "completed" | "cancelled";
export type ModelAttemptState = "reserved" | "completed" | "failed" | "unknown";
export type ModelBudgetExhaustionReason = "attempts" | "deadline" | "cancelled" | "window";
export type ModelWorkTargetState = "pending" | "completed" | "failed" | "cancelled";

export interface ModelBudgetLimits {
  maxAttempts: number;
  maxInputChars: number;
  maxOutputChars: number;
  deadlineAt: string | null;
}

export interface ModelWorkBudget {
  budgetId: string;
  parentWaveId: string;
  /**
   * 이슈 #42: rollover 계보의 ROOT. `parent_wave_id`에 `:run:<uuid>`를 계속
   * 이어붙이던 것이 rollover 1회당 41자씩 무한히 자랐고(실데이터에 이미 3단계
   * 중첩), 확장된 id가 환경변수로 자식 워커에 전파돼 또 붙었다. 계보는 이제
   * 문자열이 아니라 이 컬럼이다: 공유 rolling cap 조회의 기준이기도 하다.
   */
  rootWaveId: string;
  /** 이 root 안에서 몇 번째 run인지(1부터). `UNIQUE(root_wave_id, run_seq)`. */
  runSeq: number;
  state: ModelBudgetState;
  maxAttempts: number;
  reservedAttempts: number;
  maxInputChars: number;
  maxOutputChars: number;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  automatic: boolean;
}

export interface ModelWorkContext {
  /** Reuse the caller's already initialized connection when available. */
  db?: Database.Database;
  dbPath?: string;
  budgetId?: string;
  parentWaveId?: string;
  stage?: string;
  jobId?: string | null;
  targetId?: string | null;
}

export interface ModelAttemptReservation {
  attemptId: string;
  budgetId: string;
  parentWaveId: string;
  attemptNo: number;
  startedAt: string;
  deadlineAt: string | null;
  maxInputChars: number;
  maxOutputChars: number;
  remainingAttempts: number;
  remainingDeadlineMs: number | null;
}

export interface ModelWorkTargetMembership {
  membershipId: string;
  budgetId: string;
  parentWaveId: string;
  stage: string;
  targetId: string;
  jobId: string | null;
  state: ModelWorkTargetState;
  createdAt: string;
  updatedAt: string;
  reason: string | null;
}

export interface ModelWorkRunResumeResult {
  previousBudget: ModelWorkBudget;
  budget: ModelWorkBudget;
  reboundJobIds: string[];
  skippedJobIds: string[];
}

export interface FinishModelAttemptInput {
  attemptId: string;
  state: Exclude<ModelAttemptState, "reserved">;
  durationMs?: number | null;
  outputChars?: number | null;
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  } | null;
  tokenUsageStatus?: "observed" | "partial" | "NOT_PROVEN";
  errorClass?: string | null;
  errorMessage?: string | null;
  finishedAt?: string;
  /** Issue #31: the selection the provider ACTUALLY received, as observed by
   *  codex-exec. Absent leaves the reservation's intended values in place. */
  model?: string | null;
  reasoningEffort?: string | null;
}

export class ModelBudgetError extends Error {
  readonly code = "MEMEX_MODEL_BUDGET";
  readonly budgetId: string;
  readonly parentWaveId: string;
  readonly reason: ModelBudgetExhaustionReason;
  readonly pending = true;

  constructor(
    budgetId: string,
    parentWaveId: string,
    reason: ModelBudgetExhaustionReason,
    detail?: string,
  ) {
    super(
      detail ??
        `model work budget exhausted (${reason}; budget=${budgetId}; wave=${parentWaveId})`,
    );
    this.name = "ModelBudgetError";
    this.budgetId = budgetId;
    this.parentWaveId = parentWaveId;
    this.reason = reason;
  }
}

export class ModelBudgetExhaustedError extends ModelBudgetError {}

export class ModelBudgetInputLimitError extends Error {
  readonly code = "MEMEX_MODEL_INPUT_LIMIT";
  readonly pending = true;
  readonly inputChars: number;
  readonly maxInputChars: number;

  constructor(inputChars: number, maxInputChars: number) {
    super(`model input exceeds durable budget (${inputChars} > ${maxInputChars} chars)`);
    this.name = "ModelBudgetInputLimitError";
    this.inputChars = inputChars;
    this.maxInputChars = maxInputChars;
  }
}

export class ModelBudgetOutputLimitError extends Error {
  readonly code = "MEMEX_MODEL_OUTPUT_LIMIT";
  readonly pending = true;
  readonly outputChars: number;
  readonly maxOutputChars: number;

  constructor(outputChars: number, maxOutputChars: number) {
    super(`model output exceeds durable budget (${outputChars} > ${maxOutputChars} chars)`);
    this.name = "ModelBudgetOutputLimitError";
    this.outputChars = outputChars;
    this.maxOutputChars = maxOutputChars;
  }
}

export class ModelBudgetOutputSchemaError extends Error {
  readonly code = "MEMEX_MODEL_OUTPUT_SCHEMA";
  readonly pending = true;

  constructor(detail = "model output does not satisfy the requested schema") {
    super(detail);
    this.name = "ModelBudgetOutputSchemaError";
  }
}

export class ModelBudgetNotFoundError extends Error {
  readonly code = "MEMEX_MODEL_BUDGET_NOT_FOUND";

  constructor(budgetId: string) {
    super(`model work budget ${budgetId} does not exist; refusing an implicit cap reset`);
    this.name = "ModelBudgetNotFoundError";
  }
}

export class ModelBudgetAffinityError extends Error {
  readonly code = "MEMEX_MODEL_BUDGET_AFFINITY";

  constructor(jobId: string, existing: string, requested: string) {
    super(
      `memory job ${jobId} is already bound to budget ${existing}; refusing rebind to ${requested}`,
    );
    this.name = "ModelBudgetAffinityError";
  }
}

/**
 * Issue #31 — an active config hold refused this call before it could reserve.
 *
 * Classified `'config'` by `classifyLlmError` (via `code`), so the caller takes
 * the same HOLD path a live provider rejection takes. The difference is cost:
 * this one spends NOTHING — no reservation, no provider call.
 */
export class ModelConfigHeldError extends Error {
  readonly code = "MEMEX_MODEL_CONFIG_HELD";
  readonly hold: ModelConfigHold;

  constructor(hold: ModelConfigHold) {
    super(
      `model work is held: the provider rejected the request envelope for model ` +
        `"${hold.model}"${hold.reasoningEffort ? ` at reasoning effort "${hold.reasoningEffort}"` : ""}` +
        ` (${hold.status ?? "?"} ${hold.providerType ?? "provider error"}). ` +
        `Fix the selection and it resumes automatically: memex models show`,
    );
    this.name = "ModelConfigHeldError";
    this.hold = hold;
  }
}

const modelWorkStorage = new AsyncLocalStorage<ModelWorkContext>();

export function getModelWorkContext(): ModelWorkContext | undefined {
  return modelWorkStorage.getStore();
}

/** Run work with context merged into the current async context. */
export async function withModelWorkContext<T>(
  context: Partial<ModelWorkContext>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const current = modelWorkStorage.getStore();
  return modelWorkStorage.run(
    { ...(current ?? {}), ...context },
    async () => await fn(),
  );
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

function hasDerivedFactQueue(db: Database.Database): boolean {
  if (!tableExists(db, "facts")) return false;
  const columns = columnNames(db, "facts");
  return columns.has("id") && columns.has("is_active") &&
    columns.has("ontology_category_id") && columns.has("needs_consolidation");
}

/**
 * 이슈 #42: wave 계보를 문자열이 아니라 컬럼으로 읽는다.
 *
 * 역사적으로 rollover는 `parent_wave_id`에 `:run:<uuid>`(41자)를 이어붙여
 * 표현했고 상한이 없었다. 실데이터에는 이미 3단계 중첩이 있었다:
 *   maintenance
 *   maintenance:run:f11b5103-…
 *   maintenance:run:f11b5103-…:run:7344dd28-…
 * 이 함수는 어떤 형태의 id에서도 ROOT를 뽑는다 — 옛 `:run:` 사슬과 새
 * `#<seq>` 접미사 둘 다. 환경변수로 옛 id를 물려받은 워커가 여전히 같은
 * 계보(=같은 rolling cap)로 해석되게 하는 것이 목적이다.
 */
export function rootWaveIdOf(parentWaveId: string): string {
  const withoutRun = parentWaveId.split(":run:")[0];
  const compact = /^(.*)#\d+$/.exec(withoutRun);
  return compact ? compact[1] : withoutRun;
}

/**
 * Parse a wave id into (root, explicit run number when the name carries one).
 *
 * 이슈 #72: only a BARE compact name states its own run number. A legacy
 * `:run:` suffix means "one rollover past the name in front of it", so
 * `maintenance#2` and `maintenance#2:run:<uuid>` are two DIFFERENT runs of the
 * same root — reading the `#2` out of the chain's prefix collapsed them onto
 * the same (root, seq) and made `UNIQUE(root_wave_id, run_seq)` impossible to
 * create. A chained name gets `seq: null` so the caller assigns the next free
 * run instead; the root (and therefore the rolling cap it shares) is unchanged.
 */
function parseWaveId(parentWaveId: string): { root: string; seq: number | null } {
  const root = rootWaveIdOf(parentWaveId);
  if (parentWaveId.includes(":run:")) return { root, seq: null };
  const compact = /^(.*)#(\d+)$/.exec(parentWaveId);
  return { root, seq: compact ? Number(compact[2]) : null };
}

/** Human-readable, BOUNDED name for run `seq` of `root`. Run 1 IS the root. */
function runWaveId(root: string, seq: number): string {
  return seq <= 1 ? root : `${root}#${seq}`;
}

function nextRunSeq(db: Database.Database, rootWaveId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(run_seq), 0) AS n FROM model_work_budgets WHERE root_wave_id = ?")
    .get(rootWaveId) as { n: number } | undefined;
  return Number(row?.n ?? 0) + 1;
}

/**
 * Additive, idempotent local telemetry migration. This is intentionally
 * separate from the Continuity schema version: budgets are operational state
 * and do not alter transcript/fact protocol meaning.
 */
export function ensureModelBudgetSchema(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_work_budgets (
        budget_id TEXT PRIMARY KEY,
        parent_wave_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active'
          CHECK(state IN ('active','exhausted','completed','cancelled')),
        max_attempts INTEGER NOT NULL CHECK(max_attempts >= 0),
        reserved_attempts INTEGER NOT NULL DEFAULT 0
          CHECK(reserved_attempts >= 0 AND reserved_attempts <= max_attempts),
        max_input_chars INTEGER NOT NULL CHECK(max_input_chars >= 0),
        max_output_chars INTEGER NOT NULL CHECK(max_output_chars >= 0),
        deadline_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(parent_wave_id)
      );

      CREATE TABLE IF NOT EXISTS model_work_attempts (
        attempt_id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES model_work_budgets(budget_id)
          ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
        stage TEXT NOT NULL,
        job_id TEXT,
        target_id TEXT,
        state TEXT NOT NULL DEFAULT 'reserved'
          CHECK(state IN ('reserved','completed','failed','unknown')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        input_chars INTEGER,
        output_chars INTEGER,
        token_usage_json TEXT,
        token_usage_status TEXT
          CHECK(token_usage_status IN ('observed','partial','NOT_PROVEN')),
        error_class TEXT,
        error_message TEXT,
        -- Issue #31: which selection this attempt intended and actually used.
        model TEXT,
        reasoning_effort TEXT,
        -- Issue #31: NULL for an ordinary attempt; 'config_rejected' for one the
        -- provider refused before any model work started. No CHECK: the value
        -- set can grow (other "cost nothing" outcomes) and every existing row
        -- must stay NULL, so the restriction is application-level only.
        outcome TEXT
      );

      CREATE TABLE IF NOT EXISTS model_work_targets (
        membership_id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES model_work_budgets(budget_id)
          ON DELETE CASCADE,
        stage TEXT NOT NULL,
        target_id TEXT NOT NULL,
        job_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','completed','failed','cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reason TEXT,
        UNIQUE(budget_id, stage, target_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_model_work_attempts_sequence
        ON model_work_attempts(budget_id, attempt_no);
      CREATE INDEX IF NOT EXISTS idx_model_work_attempts_budget
        ON model_work_attempts(budget_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_model_work_attempts_job
        ON model_work_attempts(job_id, target_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_model_work_targets_pending
        ON model_work_targets(budget_id, state, stage, target_id);
      CREATE INDEX IF NOT EXISTS idx_model_work_targets_job
        ON model_work_targets(job_id, state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_model_work_budgets_state
        ON model_work_budgets(state, updated_at);

      CREATE TABLE IF NOT EXISTS model_maintenance_wake (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        wake_after TEXT NOT NULL
      );

      /*
       * Issue #31 — durable "this model selection is unusable" state.
       *
       * Keyed on the SELECTION FINGERPRINT, one row per selection, NOT a single
       * id=1 row. v2 of the design used a single row that a lookup deleted on a
       * fingerprint mismatch, so in one data root a process with different env
       * erased another process's valid hold (2nd review (b)5). With the
       * fingerprint as the key, every process reads and writes only its OWN
       * row — so there is no delete race to lose, and fixing the setting simply
       * means no active row matches any more.
       *
       * Clearing does not delete: cleared_at / cleared_by are written so the
       * history stays auditable. "Active" means cleared_at IS NULL.
       */
      CREATE TABLE IF NOT EXISTS model_config_holds (
        selection_fingerprint TEXT PRIMARY KEY,
        held_at TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        provider_status INTEGER,
        provider_type TEXT,
        provider_message TEXT,
        first_stage TEXT,
        first_job_id TEXT,
        observed_count INTEGER NOT NULL DEFAULT 1,
        last_observed_at TEXT NOT NULL,
        cleared_at TEXT,
        cleared_by TEXT
          CHECK(cleared_by IS NULL OR cleared_by IN ('probe-ok','manual','ttl'))
      );
      CREATE INDEX IF NOT EXISTS idx_model_config_holds_live
        ON model_config_holds(cleared_at, last_observed_at);
    `);

    // Issue #31: the attempt ledger had no column guards at all. Three additive
    // nullable columns; existing rows stay NULL, which reads correctly as
    // "recorded before Memex could name its own selection".
    const attemptColumns = columnNames(db, MODEL_ATTEMPT_TABLE);
    for (const column of ["model", "reasoning_effort", "outcome"]) {
      if (!attemptColumns.has(column)) {
        db.exec(`ALTER TABLE ${MODEL_ATTEMPT_TABLE} ADD COLUMN ${column} TEXT`);
      }
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_model_work_attempts_outcome
         ON ${MODEL_ATTEMPT_TABLE}(budget_id, outcome)`,
    );

    // TTL: an active hold nobody has seen for 30 days is closed (never deleted)
    // so the table cannot grow without bound. The same fingerprint being
    // rejected again simply records a fresh hold.
    db.prepare(
      `UPDATE model_config_holds SET cleared_at = ?, cleared_by = 'ttl'
       WHERE cleared_at IS NULL AND last_observed_at < ?`,
    ).run(
      new Date().toISOString(),
      new Date(Date.now() - MODEL_CONFIG_HOLD_TTL_MS).toISOString(),
    );

    if (!columnNames(db, MODEL_BUDGET_TABLE).has("automatic")) {
      db.exec("ALTER TABLE model_work_budgets ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic IN (0,1))");
    }

    // 이슈 #42: rollover 계보를 컬럼으로 옮긴다(둘 다 additive nullable).
    // `UNIQUE(parent_wave_id)`는 테이블 제약이라 그대로 두고, 계보 유일성은
    // 추가 UNIQUE INDEX로 표현한다 — 테이블 재작성 없이 additive하게.
    const budgetColumns = columnNames(db, MODEL_BUDGET_TABLE);
    if (!budgetColumns.has("root_wave_id")) {
      db.exec("ALTER TABLE model_work_budgets ADD COLUMN root_wave_id TEXT");
    }
    if (!budgetColumns.has("run_seq")) {
      db.exec("ALTER TABLE model_work_budgets ADD COLUMN run_seq INTEGER");
    }

    // 기존 중첩 id 정규화. 실제 root는 3단계까지 중첩돼 있었고, rolling cap은
    // "모든 자동 작업이 하나의 wave 계보를 공유한다"는 전제 위에 서 있으므로
    // 계보 연결을 잃지 않는 것이 이 마이그레이션의 유일한 요구사항이다.
    // 같은 root 안에서 created_at 순서가 곧 run 순서다.
    const legacyRows = db
      .prepare(
        `SELECT budget_id, parent_wave_id, root_wave_id, run_seq FROM model_work_budgets
         WHERE root_wave_id IS NULL OR run_seq IS NULL OR parent_wave_id LIKE '%:run:%'
         ORDER BY created_at, budget_id`,
      )
      .all() as Array<{
        budget_id: string;
        parent_wave_id: string;
        root_wave_id: string | null;
        run_seq: number | null;
      }>;
    if (legacyRows.length > 0) {
      const seqByRoot = new Map<string, number>();
      const seeded = db
        .prepare("SELECT root_wave_id, COALESCE(MAX(run_seq), 0) AS n FROM model_work_budgets WHERE root_wave_id IS NOT NULL GROUP BY root_wave_id")
        .all() as Array<{ root_wave_id: string; n: number }>;
      for (const row of seeded) seqByRoot.set(row.root_wave_id, Number(row.n));
      const takenNames = new Set(
        (db.prepare("SELECT parent_wave_id FROM model_work_budgets").all() as Array<{ parent_wave_id: string }>)
          .map((row) => row.parent_wave_id),
      );
      // 이슈 #72: (root_wave_id, run_seq) must stay unique across budgets, or
      // the UNIQUE index below cannot be created and DB open dies with it.
      // Track who owns each pair and walk to the first free run number.
      const runKey = (root: string, seq: number) => `${root} ${seq}`;
      const runOwner = new Map<string, string>();
      for (const row of db
        .prepare(
          `SELECT budget_id, root_wave_id, run_seq FROM model_work_budgets
           WHERE root_wave_id IS NOT NULL AND run_seq IS NOT NULL`,
        )
        .all() as Array<{ budget_id: string; root_wave_id: string; run_seq: number }>) {
        runOwner.set(runKey(row.root_wave_id, Number(row.run_seq)), row.budget_id);
      }
      for (const row of legacyRows) {
        const parsed = parseWaveId(row.parent_wave_id);
        const root = parsed.root;
        let seq = row.run_seq ?? parsed.seq ?? (seqByRoot.get(root) ?? 0) + 1;
        while (true) {
          const owner = runOwner.get(runKey(root, seq));
          if (owner === undefined || owner === row.budget_id) break;
          seq += 1;
        }
        const previousKey = row.root_wave_id !== null && row.run_seq !== null
          ? runKey(row.root_wave_id, Number(row.run_seq))
          : null;
        if (previousKey !== null) runOwner.delete(previousKey);
        runOwner.set(runKey(root, seq), row.budget_id);
        seqByRoot.set(root, Math.max(seqByRoot.get(root) ?? 0, seq));
        let name = runWaveId(root, seq);
        // A compact name that is already taken by a DIFFERENT budget must not
        // collide with UNIQUE(parent_wave_id): keep the legacy string instead.
        if (name !== row.parent_wave_id && takenNames.has(name)) name = row.parent_wave_id;
        if (name !== row.parent_wave_id) {
          takenNames.delete(row.parent_wave_id);
          takenNames.add(name);
          db.prepare("UPDATE model_work_budgets SET parent_wave_id = ? WHERE budget_id = ?")
            .run(name, row.budget_id);
          // Queue rows carry the wave marker as a plain string; a rewritten
          // budget name must not orphan them from their lineage.
          if (tableExists(db, "memory_jobs") && columnNames(db, "memory_jobs").has("maintenance_wave_id")) {
            db.prepare("UPDATE memory_jobs SET maintenance_wave_id = ? WHERE maintenance_wave_id = ?")
              .run(name, row.parent_wave_id);
          }
        }
        db.prepare("UPDATE model_work_budgets SET root_wave_id = ?, run_seq = ? WHERE budget_id = ?")
          .run(root, seq, row.budget_id);
      }
    }
    // memory_jobs is created by ensureContinuitySchema. Keep these columns
    // nullable so old rows remain valid and bind once their first model call
    // is reserved. The ledger remains the authority for the binding while the
    // nullable correlation column lets old queue rows migrate in place.
    if (tableExists(db, "memory_jobs")) {
      const columns = columnNames(db, "memory_jobs");
      if (!columns.has("budget_id")) {
        db.exec("ALTER TABLE memory_jobs ADD COLUMN budget_id TEXT");
      }
      if (!columns.has("maintenance_wave_id")) {
        db.exec("ALTER TABLE memory_jobs ADD COLUMN maintenance_wave_id TEXT");
      }
      // Issue #31: `ensureContinuitySchema` owns this column (it owns the
      // table), but the HOLD transitions live here and must work on any
      // connection that reached them — including a fixture that only ran the
      // budget migration. Both guards are the same idempotent ALTER.
      if (!columns.has("hold_reason")) {
        db.exec("ALTER TABLE memory_jobs ADD COLUMN hold_reason TEXT");
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_memory_jobs_budget ON memory_jobs(budget_id, state, updated_at)",
      );
    }
  });
  migrate.immediate();
  // 이슈 #72: the lineage UNIQUE index is a HARDENING, never a precondition.
  // It used to live inside the migration transaction, so one duplicate
  // (root_wave_id, run_seq) pair left behind by a mixed-version rollover rolled
  // the whole migration back and `initDatabase()` threw on every call — CLI,
  // hooks and UI all dead. Create it outside the transaction and, if the data
  // still cannot satisfy it, say so once and leave the index for a later run.
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_model_work_budgets_run
         ON model_work_budgets(root_wave_id, run_seq)`,
    );
  } catch (error) {
    console.warn(
      `[memex] model budget lineage index not created (${
        error instanceof Error ? error.message : String(error)
      }); run numbers are still recorded`,
    );
  }
}

function nonNegativeInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return Math.min(value, max);
  }
  const text = value == null ? "" : String(value).trim();
  if (!/^\d+$/.test(text)) return fallback;
  return Math.min(Number.parseInt(text, 10), max);
}

function envInt(names: string[], fallback: number, max?: number): number {
  for (const name of names) {
    if (process.env[name] !== undefined) {
      return nonNegativeInt(process.env[name], fallback, max);
    }
  }
  return fallback;
}

function envDeadlineAt(now = Date.now()): string | null {
  const absolute = process.env.MEMEX_MODEL_BUDGET_DEADLINE_AT;
  if (absolute && !Number.isNaN(Date.parse(absolute))) return new Date(absolute).toISOString();
  const duration = envInt(
    ["MEMEX_MODEL_BUDGET_DEADLINE_MS", "MEMEX_MODEL_DEADLINE_MS"],
    DEFAULT_DEADLINE_MS,
    MAX_DEADLINE_MS,
  );
  return new Date(now + duration).toISOString();
}

export function modelBudgetLimitsFromEnv(now = Date.now()): ModelBudgetLimits {
  return {
    maxAttempts: envInt(
      ["MEMEX_MODEL_BUDGET_MAX_ATTEMPTS", "MEMEX_MODEL_MAX_ATTEMPTS"],
      DEFAULT_MAX_ATTEMPTS,
      100_000,
    ),
    maxInputChars: envInt(
      ["MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS", "MEMEX_MODEL_MAX_INPUT_CHARS"],
      DEFAULT_MAX_INPUT_CHARS,
      10_000_000,
    ),
    maxOutputChars: envInt(
      ["MEMEX_MODEL_BUDGET_MAX_OUTPUT_CHARS", "MEMEX_MODEL_MAX_OUTPUT_CHARS"],
      DEFAULT_MAX_OUTPUT_CHARS,
      10_000_000,
    ),
    deadlineAt: envDeadlineAt(now),
  };
}

/**
 * Automatic ontology classification is an optional local-derived maintenance
 * lane. It is enabled by default; MEMEX_AUTO_ONTOLOGY=0 disables it. The manual ontology
 * backfill command remains available regardless of this switch.
 */
export function isAutomaticOntologyEnabled(): boolean {
  const value = process.env.MEMEX_AUTO_ONTOLOGY?.trim();
  return value === undefined || value === "" || value === "1";
}

function normalizeLimits(input: Partial<ModelBudgetLimits> = {}): ModelBudgetLimits {
  const env = modelBudgetLimitsFromEnv();
  const deadlineAt =
    input.deadlineAt === null
      ? null
      : input.deadlineAt
        ? new Date(input.deadlineAt).toISOString()
        : env.deadlineAt;
  return {
    maxAttempts: nonNegativeInt(input.maxAttempts, env.maxAttempts, 100_000),
    maxInputChars: nonNegativeInt(input.maxInputChars, env.maxInputChars, 10_000_000),
    maxOutputChars: nonNegativeInt(input.maxOutputChars, env.maxOutputChars, 10_000_000),
    deadlineAt,
  };
}

function budgetFromRow(row: Record<string, unknown>): ModelWorkBudget {
  const parentWaveId = String(row.parent_wave_id);
  return {
    budgetId: String(row.budget_id),
    parentWaveId,
    rootWaveId: row.root_wave_id == null ? rootWaveIdOf(parentWaveId) : String(row.root_wave_id),
    runSeq: row.run_seq == null ? 1 : Number(row.run_seq),
    state: String(row.state) as ModelBudgetState,
    maxAttempts: Number(row.max_attempts),
    reservedAttempts: Number(row.reserved_attempts),
    maxInputChars: Number(row.max_input_chars),
    maxOutputChars: Number(row.max_output_chars),
    deadlineAt: row.deadline_at == null ? null : String(row.deadline_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    automatic: row.automatic === 1,
  };
}

function readBudgetById(db: Database.Database, budgetId: string): ModelWorkBudget | null {
  const row = db
    .prepare("SELECT * FROM model_work_budgets WHERE budget_id = ?")
    .get(budgetId) as Record<string, unknown> | undefined;
  return row ? budgetFromRow(row) : null;
}

function targetMembershipFromRow(row: Record<string, unknown>): ModelWorkTargetMembership {
  return {
    membershipId: String(row.membership_id),
    budgetId: String(row.budget_id),
    parentWaveId: String(row.parent_wave_id),
    stage: String(row.stage),
    targetId: String(row.target_id),
    jobId: row.job_id == null ? null : String(row.job_id),
    state: String(row.state) as ModelWorkTargetState,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    reason: row.reason == null ? null : String(row.reason),
  };
}

function cleanTargetIds(targetIds: string[]): string[] {
  return [...new Set(targetIds.map((targetId) => targetId.trim()).filter(Boolean))];
}

/**
 * Register every requested derived target before the caller's first await.
 * Membership is intentionally independent of the attempt ledger: one batch
 * may own many targets while consuming one provider reservation, and a crash
 * before that reservation must still leave the targets attached to the same
 * durable wave.
 */
export function registerModelWorkTargets(
  db: Database.Database,
  input: {
    budgetId: string;
    stage: string;
    targetIds: string[];
    jobId?: string | null;
    now?: Date;
  },
): number {
  ensureModelBudgetSchema(db);
  const budget = readBudgetById(db, input.budgetId);
  if (!budget) throw new ModelBudgetNotFoundError(input.budgetId);
  const stage = input.stage.trim();
  if (!stage) throw new Error("model work target stage must not be empty");
  const targetIds = cleanTargetIds(input.targetIds);
  if (targetIds.length === 0) return 0;
  const now = (input.now ?? new Date()).toISOString();
  const insert = db.prepare(`
    INSERT INTO model_work_targets
      (membership_id, budget_id, stage, target_id, job_id, state, created_at, updated_at, reason)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)
    ON CONFLICT(budget_id, stage, target_id) DO UPDATE SET
      job_id = COALESCE(excluded.job_id, model_work_targets.job_id),
      state = 'pending',
      updated_at = excluded.updated_at,
      reason = NULL
  `);
  const register = db.transaction(() => {
    for (const targetId of targetIds) {
      insert.run(randomUUID(), budget.budgetId, stage, targetId, input.jobId ?? null, now, now);
    }
    return targetIds.length;
  });
  return register.immediate();
}

/** Mark requested targets settled while preserving the row for diagnostics. */
export function settleModelWorkTargets(
  db: Database.Database,
  input: {
    budgetId: string;
    stage: string;
    targetIds: string[];
    state?: Exclude<ModelWorkTargetState, "pending">;
    reason?: string | null;
    now?: Date;
  },
): number {
  ensureModelBudgetSchema(db);
  const budget = readBudgetById(db, input.budgetId);
  if (!budget) throw new ModelBudgetNotFoundError(input.budgetId);
  const stage = input.stage.trim();
  if (!stage) throw new Error("model work target stage must not be empty");
  const targetIds = cleanTargetIds(input.targetIds);
  if (targetIds.length === 0) return 0;
  const state = input.state ?? "completed";
  const now = (input.now ?? new Date()).toISOString();
  const reason = input.reason == null
    ? null
    : input.reason.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120);
  const placeholders = targetIds.map(() => "?").join(",");
  return db.prepare(`
    UPDATE model_work_targets
    SET state = ?, reason = ?, updated_at = ?
    WHERE budget_id = ? AND stage = ? AND target_id IN (${placeholders})
  `).run(state, reason, now, budget.budgetId, stage, ...targetIds).changes;
}

/** Read target memberships for a budget in stable diagnostic order. */
export function getModelWorkTargets(
  db: Database.Database,
  filter: { budgetId?: string; parentWaveId?: string; state?: ModelWorkTargetState } = {},
): ModelWorkTargetMembership[] {
  if (!tableExists(db, MODEL_TARGET_TABLE)) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.budgetId) {
    where.push("t.budget_id = ?");
    params.push(filter.budgetId);
  }
  if (filter.parentWaveId) {
    where.push("b.parent_wave_id = ?");
    params.push(filter.parentWaveId);
  }
  if (filter.state) {
    where.push("t.state = ?");
    params.push(filter.state);
  }
  const rows = db.prepare(`
    SELECT t.*, b.parent_wave_id
    FROM model_work_targets t
    JOIN model_work_budgets b ON b.budget_id = t.budget_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY t.updated_at, t.membership_id
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map(targetMembershipFromRow);
}

/**
 * Rebind pending target memberships as part of an explicit new run. Terminal
 * rows remain on the old budget for auditability; only work still needing a
 * retry moves to the fresh cap.
 */
interface RebindTargetFilter {
  /** undefined = every pending target, null = only jobless targets. */
  jobId?: string | null;
  /** Move targets owned by a queue job in this terminal state. */
  jobState?: "completed";
}

/**
 * Move pending target memberships inside a caller-owned transaction. Keeping
 * this primitive transaction-free is deliberate: queue-job CAS and its target
 * membership must commit or roll back together. A lease race must never leave
 * a target attached to a fresh run while its job remains on the old run.
 */
function rebindPendingModelWorkTargetsInTransaction(
  db: Database.Database,
  input: {
    fromBudgetId: string;
    toBudgetId: string;
    now: Date;
  } & RebindTargetFilter,
): number {
  if (!tableExists(db, MODEL_TARGET_TABLE)) return 0;
  if (input.jobState && !tableExists(db, "memory_jobs")) return 0;
  const clauses = ["t.budget_id = ?", "t.state = 'pending'"];
  const params: unknown[] = [input.fromBudgetId];
  if (input.jobId !== undefined) {
    if (input.jobId === null) clauses.push("t.job_id IS NULL");
    else {
      clauses.push("t.job_id = ?");
      params.push(input.jobId);
    }
  }
  if (input.jobState) {
    clauses.push(
      "EXISTS (SELECT 1 FROM memory_jobs j WHERE j.job_id = t.job_id AND j.state = ?)",
    );
    params.push(input.jobState);
  }
  const where = clauses.join(" AND ");
  const rows = db.prepare(`
    SELECT t.* FROM model_work_targets t
    WHERE ${where}
    ORDER BY updated_at, membership_id
  `).all(...params) as Array<Record<string, unknown>>;
  if (rows.length === 0) return 0;
  const now = input.now.toISOString();
  const upsert = db.prepare(`
    INSERT INTO model_work_targets
      (membership_id, budget_id, stage, target_id, job_id, state, created_at, updated_at, reason)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(budget_id, stage, target_id) DO UPDATE SET
      job_id = COALESCE(excluded.job_id, model_work_targets.job_id),
      state = 'pending', updated_at = excluded.updated_at, reason = excluded.reason
  `);
  for (const row of rows) {
    upsert.run(
      randomUUID(),
      input.toBudgetId,
      String(row.stage),
      String(row.target_id),
      row.job_id == null ? null : String(row.job_id),
      String(row.created_at),
      now,
      row.reason == null ? null : String(row.reason),
    );
  }
  const membershipIds = rows.map((row) => String(row.membership_id));
  db.prepare(`
    DELETE FROM model_work_targets
    WHERE membership_id IN (${membershipIds.map(() => "?").join(",")})
  `).run(...membershipIds);
  return rows.length;
}

function insertModelWorkBudget(
  db: Database.Database,
  input: {
    parentWaveId: string;
    budgetId?: string;
    limits?: Partial<ModelBudgetLimits>;
    now?: Date;
  },
): ModelWorkBudget {
  const budgetId = input.budgetId?.trim() || randomUUID();
  const limits = normalizeLimits(input.limits);
  const now = (input.now ?? new Date()).toISOString();
  // 이슈 #42: 계보는 이름이 아니라 컬럼이다. 이름이 `<root>#<n>` 형태면 그
  // n을 존중하고, 아니면 이 root의 다음 run 번호를 잡는다.
  const parsed = parseWaveId(input.parentWaveId);
  const runSeq = parsed.seq ?? nextRunSeq(db, parsed.root);
  db.prepare(`
    INSERT INTO model_work_budgets
      (budget_id, parent_wave_id, root_wave_id, run_seq, state, max_attempts, reserved_attempts,
       max_input_chars, max_output_chars, deadline_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?, ?)
  `).run(
    budgetId,
    input.parentWaveId,
    parsed.root,
    runSeq,
    limits.maxAttempts,
    limits.maxInputChars,
    limits.maxOutputChars,
    limits.deadlineAt,
    now,
    now,
  );
  return readBudgetById(db, budgetId)!;
}

export function getModelWorkBudget(
  db: Database.Database,
  budgetId: string,
): ModelWorkBudget | null {
  ensureModelBudgetSchema(db);
  return readBudgetById(db, budgetId);
}

/**
 * Create or reuse a budget for one stable parent wave. Existing rows always
 * win, including exhausted rows; changing env limits cannot reset a run.
 */
export function getOrCreateModelWorkBudget(
  db: Database.Database,
  input: {
    parentWaveId: string;
    budgetId?: string;
    limits?: Partial<ModelBudgetLimits>;
  },
): ModelWorkBudget {
  ensureModelBudgetSchema(db);
  const parentWaveId = input.parentWaveId.trim();
  if (!parentWaveId) throw new Error("parentWaveId must not be empty");
  const existing = db
    .prepare("SELECT * FROM model_work_budgets WHERE parent_wave_id = ?")
    .get(parentWaveId) as Record<string, unknown> | undefined;
  if (existing) {
    const budget = budgetFromRow(existing);
    if (input.budgetId && input.budgetId !== budget.budgetId) {
      throw new Error(
        `parent wave ${parentWaveId} is already bound to budget ${budget.budgetId}`,
      );
    }
    return budget;
  }
  const create = db.transaction(() => {
    insertModelWorkBudget(db, {
      parentWaveId,
      budgetId: input.budgetId,
      limits: input.limits,
    });
  });
  try {
    create.immediate();
  } catch (error) {
    // Another process may have won the stable wave race. Re-read and reuse it.
    const raced = db
      .prepare("SELECT * FROM model_work_budgets WHERE parent_wave_id = ?")
      .get(parentWaveId) as Record<string, unknown> | undefined;
    if (!raced) throw error;
    return budgetFromRow(raced);
  }
  const created = db
    .prepare("SELECT budget_id FROM model_work_budgets WHERE parent_wave_id = ?")
    .get(parentWaveId) as { budget_id: string } | undefined;
  if (!created) throw new Error(`model work budget ${parentWaveId} was not created`);
  return readBudgetById(db, created.budget_id)!;
}

/** Explicit new run entrypoint. It never resets or mutates an older budget. */
export function startNewModelWorkRun(
  db: Database.Database,
  input: {
    parentWaveId?: string;
    budgetId?: string;
    limits?: Partial<ModelBudgetLimits>;
  } = {},
): ModelWorkBudget {
  return getOrCreateModelWorkBudget(db, {
    parentWaveId: input.parentWaveId?.trim() || `run:${randomUUID()}`,
    budgetId: input.budgetId,
    limits: input.limits,
  });
}

export function bindMemoryJobToBudget(
  db: Database.Database,
  input: { jobId: string; budgetId: string; parentWaveId?: string | null },
): boolean {
  ensureModelBudgetSchema(db);
  const bound = db.transaction(() => {
    const row = db
      .prepare("SELECT budget_id, maintenance_wave_id FROM memory_jobs WHERE job_id = ?")
      .get(input.jobId) as
      | { budget_id: string | null; maintenance_wave_id: string | null }
      | undefined;
    if (!row) return false;
    if (row.budget_id && row.budget_id !== input.budgetId) {
      throw new ModelBudgetAffinityError(input.jobId, row.budget_id, input.budgetId);
    }
    db.prepare(`
      UPDATE memory_jobs
      SET budget_id = COALESCE(budget_id, ?),
          maintenance_wave_id = COALESCE(maintenance_wave_id, ?),
          updated_at = updated_at
      WHERE job_id = ? AND (budget_id IS NULL OR budget_id = ?)
    `).run(input.budgetId, input.parentWaveId ?? null, input.jobId, input.budgetId);
    return true;
  });
  return bound.immediate();
}

/**
 * Explicit operator action for moving one pending job to a fresh budget run.
 * The expected old budget is checked so an operator cannot accidentally reset
 * a job that another process rebound concurrently. Queue attempts are reset
 * only by this explicit action; the previous provider-attempt ledger remains
 * attached to its original budget for auditability.
 */
export function rebindMemoryJobToBudget(
  db: Database.Database,
  input: {
    jobId: string;
    budgetId: string;
    expectedBudgetId?: string | null;
    now?: Date;
    /** Automatic continuation must preserve retry history and backoff. */
    automatic?: boolean;
  },
): boolean {
  ensureModelBudgetSchema(db);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const tx = db.transaction(() => {
    const budget = readBudgetById(db, input.budgetId);
    if (!budget) throw new ModelBudgetNotFoundError(input.budgetId);
    const job = db.prepare(`
      SELECT budget_id, maintenance_wave_id, state, target_id, checkpoint_id,
             lease_until, last_error
      FROM memory_jobs WHERE job_id = ?
    `).get(input.jobId) as
      | {
          budget_id: string | null;
          maintenance_wave_id: string | null;
          state: string;
          target_id: string | null;
          checkpoint_id: string | null;
          lease_until: string | null;
          last_error: string | null;
        }
      | undefined;
    if (!job) return false;
    if (input.expectedBudgetId !== undefined && job.budget_id !== input.expectedBudgetId) {
      throw new ModelBudgetAffinityError(
        input.jobId,
        job.budget_id ?? "<unbound>",
        input.expectedBudgetId ?? "<unbound>",
      );
    }
    if ((job.state === "running" && !input.automatic) || ["completed", "superseded"].includes(job.state)) {
      throw new Error(`memory job ${input.jobId} is not resumable from state ${job.state}`);
    }
    if (
      job.state === "dead" &&
      !job.last_error?.startsWith("model work budget exhausted:")
    ) {
      throw new Error(`memory job ${input.jobId} is not resumable from terminal state dead`);
    }
    if (job.lease_until && Date.parse(job.lease_until) > now.getTime()) {
      throw new Error(`memory job ${input.jobId} still has an active lease`);
    }
    const changed = db.prepare(`
      UPDATE memory_jobs
      SET budget_id = ?, maintenance_wave_id = ?, state = 'pending',
          attempts = CASE WHEN ? THEN attempts ELSE 0 END,
          available_at = CASE WHEN ? THEN MAX(available_at, ?) ELSE ? END,
          lease_owner = NULL, lease_until = NULL,
          last_error = NULL, updated_at = ?
      WHERE job_id = ? AND (state IN ('pending','retry','dead') OR (? AND state = 'running'))
        AND (lease_until IS NULL OR lease_until <= ?)
    `).run(
      budget.budgetId,
      budget.parentWaveId,
      input.automatic ? 1 : 0,
      input.automatic ? 1 : 0,
      nowIso,
      nowIso,
      nowIso,
      input.jobId,
      input.automatic ? 1 : 0,
      nowIso,
    ).changes;
    if (changed !== 1) return false;
    if (job.target_id) {
      db.prepare(`
        UPDATE extraction_targets
        SET state = 'pending', lease_owner = NULL, lease_until = NULL,
            last_error = NULL, updated_at = ?
        WHERE target_id = ? AND (state IN ('pending','retry','dead')
          OR (? AND state = 'running' AND (lease_until IS NULL OR lease_until <= ?)))
      `).run(nowIso, job.target_id, input.automatic ? 1 : 0, nowIso);
      db.prepare(`
        UPDATE extraction_target_items SET state = 'pending'
        WHERE target_id = ? AND state IN ('retry','processing','failed-visible')
      `).run(job.target_id);
    }
    if (job.checkpoint_id) {
      db.prepare("UPDATE checkpoints SET state = 'pending' WHERE checkpoint_id = ?")
        .run(job.checkpoint_id);
    }
    if (job.budget_id && job.budget_id !== budget.budgetId) {
      // Move the queue-owned derived targets in the same transaction as the
      // lease-free job CAS. If the job was stale/running, the validation above
      // throws before this point and the old membership remains untouched.
      rebindPendingModelWorkTargetsInTransaction(db, {
        fromBudgetId: job.budget_id,
        toBudgetId: budget.budgetId,
        jobId: input.jobId,
        now,
      });
    }
    return true;
  });
  return tx.immediate();
}

/** Start a fresh, explicitly named run for one pending job and rebind it. */
export function startNewModelWorkRunForJob(
  db: Database.Database,
  input: {
    jobId: string;
    parentWaveId?: string;
    limits?: Partial<ModelBudgetLimits>;
    now?: Date;
  },
): ModelWorkBudget {
  ensureModelBudgetSchema(db);
  const old = db.prepare(
    "SELECT budget_id FROM memory_jobs WHERE job_id = ?",
  ).get(input.jobId) as { budget_id: string | null } | undefined;
  if (!old) throw new Error(`memory job ${input.jobId} does not exist`);
  const oldBudget = old.budget_id ? readBudgetById(db, old.budget_id) : null;
  const requestedWave = input.parentWaveId?.trim();
  if (requestedWave && requestedWave === oldBudget?.parentWaveId) {
    throw new Error("new model work run requires a distinct parentWaveId");
  }
  // 이슈 #42: job 재개도 같은 root의 다음 run 번호를 쓴다.
  const jobRoot = rootWaveIdOf(oldBudget?.parentWaveId ?? "job");
  const parentWaveId = requestedWave || runWaveId(jobRoot, nextRunSeq(db, jobRoot));
  const next = startNewModelWorkRun(db, { parentWaveId, limits: input.limits });
  rebindMemoryJobToBudget(db, {
    jobId: input.jobId,
    budgetId: next.budgetId,
    expectedBudgetId: old.budget_id,
    now: input.now,
  });
  return next;
}

/**
 * Explicitly start a fresh budget for one exhausted wave and move only queue
 * jobs that are still safe to retry. Running jobs remain bound to the old
 * budget; a lease-free CAS is used for every rebind so a concurrent worker
 * cannot be reset underneath an active claim.
 *
 * 🚨 Issue #14, belt and braces. A budget whose deadline/window has passed is
 * spent whatever its stored `state` says, so resume settles that first rather
 * than refusing the operator's only exit. It is the same transition every
 * other caller makes, so a budget that arrives here already `exhausted` — the
 * normal case — is unaffected. `state` alone still fences a genuinely live
 * budget: an `active` budget with time left is refused as before.
 */
export function startNewModelWorkRunForBudget(
  db: Database.Database,
  input: {
    budgetId: string;
    parentWaveId?: string;
    limits?: Partial<ModelBudgetLimits>;
    now?: Date;
    automatic?: boolean;
  },
): ModelWorkRunResumeResult {
  ensureModelBudgetSchema(db);
  const now = input.now ?? new Date();
  let previousBudget = readBudgetById(db, input.budgetId);
  if (!previousBudget) throw new ModelBudgetNotFoundError(input.budgetId);
  if (previousBudget.state === "active") {
    const spent = resolveBudgetExhaustion(db, previousBudget, now);
    if (spent) {
      markModelBudgetExhausted(db, previousBudget.budgetId, spent, now.toISOString());
      previousBudget = readBudgetById(db, previousBudget.budgetId)!;
    }
  }
  if (!(["exhausted", "cancelled"] as ModelBudgetState[]).includes(previousBudget.state)) {
    throw new Error(
      `model work budget ${input.budgetId} is still active; resume requires an exhausted or cancelled budget`,
    );
  }
  const requestedWave = input.parentWaveId?.trim();
  if (requestedWave && requestedWave === previousBudget.parentWaveId) {
    throw new Error("new model work run requires a distinct parentWaveId");
  }
  const createBudget = input.automatic ? insertModelWorkBudget : startNewModelWorkRun;
  // 이슈 #42: 이름을 이어붙이지 않고 같은 root의 다음 run을 연다.
  const previousRoot = previousBudget.rootWaveId || rootWaveIdOf(previousBudget.parentWaveId);
  const budget = createBudget(db, {
    parentWaveId: requestedWave || runWaveId(previousRoot, nextRunSeq(db, previousRoot)),
    limits: input.limits,
    now: input.now,
  });
  const rows = tableExists(db, "memory_jobs")
    ? (db.prepare(`
        SELECT job_id, state, lease_until
        FROM memory_jobs
        WHERE budget_id = ? AND (state IN ('pending','retry','dead') OR (? AND state = 'running'))
        ORDER BY updated_at, job_id
      `).all(previousBudget.budgetId, input.automatic ? 1 : 0) as Array<{
        job_id: string;
        state: string;
        lease_until: string | null;
      }>)
    : [];
  const reboundJobIds: string[] = [];
  const skippedJobIds: string[] = [];
  for (const row of rows) {
    if (row.lease_until && Date.parse(row.lease_until) > now.getTime()) {
      skippedJobIds.push(row.job_id);
      continue;
    }
    try {
      const rebound = rebindMemoryJobToBudget(db, {
        jobId: row.job_id,
        budgetId: budget.budgetId,
        expectedBudgetId: previousBudget.budgetId,
        now,
        automatic: input.automatic,
      });
      if (rebound) {
        reboundJobIds.push(row.job_id);
      } else {
        // A concurrent state/lease change can make the guarded UPDATE a no-op
        // without throwing. Treat that the same as a skipped job so its
        // pending targets remain on the old budget rather than becoming
        // orphaned.
        skippedJobIds.push(row.job_id);
      }
    } catch (error) {
      // An affinity/lease race means another worker owns the row now. Keep it
      // on its original budget and make that decision visible to the caller.
      if (
        error instanceof ModelBudgetAffinityError ||
        /active lease|not resumable/.test(String(error))
      ) {
        skippedJobIds.push(row.job_id);
        continue;
      }
      throw error;
    }
  }
  // Extraction commits the durable fact page before its asynchronous ontology
  // and relation work runs. That makes the extraction queue job authoritative
  // and completed while its derived targets may still be pending. Carry those
  // unfinished memberships into the fresh derived-work cap, while leaving the
  // completed job and its old attempt ledger untouched.
  const moveCompletedJobTargets = db.transaction(() =>
    rebindPendingModelWorkTargetsInTransaction(db, {
      fromBudgetId: previousBudget.budgetId,
      toBudgetId: budget.budgetId,
      jobState: "completed",
      now,
    }),
  );
  moveCompletedJobTargets.immediate();
  // Fact/derived work often has no memory_jobs row. Move only those jobless
  // memberships here; queue-owned memberships were moved atomically with
  // their successful job CAS above, so active or raced jobs stay on the old
  // budget together with their targets.
  const moveJoblessTargets = db.transaction(() =>
    rebindPendingModelWorkTargetsInTransaction(db, {
      fromBudgetId: previousBudget.budgetId,
      toBudgetId: budget.budgetId,
      jobId: null,
      now,
    }),
  );
  moveJoblessTargets.immediate();
  return { previousBudget, budget, reboundJobIds, skippedJobIds };
}

/**
 * Pre-flight for a queue claim: would this job be handed a budget that is
 * already spent? Read-only whenever the budget is genuinely fine; when it is
 * not, it performs — and only then — the durable exhausted transition.
 *
 * 🚨 Issue #14. This check stands in for `reserveModelAttempt`, and the
 * reservation did not merely *report* exhaustion: it wrote the budget durably
 * to `exhausted` before throwing. Reporting without writing left budget
 * `15af9e61` `active` with a deadline hours in the past, so every foreground
 * backfill deferred and `model-work resume --new-run` refused the budget as
 * "still active" — no way out but an automatic wake. The transition goes
 * through the same `markModelBudgetExhausted` the reservation uses, so the
 * pre-flight cannot leave a state the reservation would not have left.
 *
 * 🚨 Issue #12. The extractor claimed a job (which burns one `attempts`), then
 * resolved its budget deep inside the model call, and only there discovered
 * that the budget's `deadline_at` had passed hours ago. `reserveModelAttempt`
 * throws *before* inserting a `model_work_attempts` row, so no provider call
 * ever happened — yet the claim's attempt was spent and
 * `deferMemoryJobForModelBudget` parked the job for a full hour. The fresh
 * budget minted seconds later by the same maintenance wake then had nothing
 * left to run. Resolving the budget *before* the claim keeps a dead budget
 * from ever reaching the extractor.
 *
 * Resolution mirrors `withResolvedModelWorkContext`: a bound job's durable
 * budget wins over any explicitly requested/environment budget. Nothing is
 * created here — an unbound job with no explicit budget returns null and takes
 * the normal lazy-creation path.
 */
export function findExhaustedModelBudgetForClaim(
  db: Database.Database,
  input: { jobId?: string | null; budgetId?: string | null; now?: Date },
): {
  budgetId: string;
  parentWaveId: string;
  reason: ModelBudgetExhaustionReason;
} | null {
  ensureModelBudgetSchema(db);
  const now = input.now ?? new Date();
  let budget: ModelWorkBudget | null = null;
  const jobId = input.jobId?.trim();
  if (jobId && tableExists(db, "memory_jobs") && columnNames(db, "memory_jobs").has("budget_id")) {
    const row = db
      .prepare("SELECT budget_id FROM memory_jobs WHERE job_id = ?")
      .get(jobId) as { budget_id: string | null } | undefined;
    if (row?.budget_id) budget = readBudgetById(db, row.budget_id);
  }
  const requested = input.budgetId?.trim();
  if (!budget && requested) budget = readBudgetById(db, requested);
  if (!budget) return null;
  // Identical predicate to reserveModelAttempt — the pre-flight must not be
  // able to disagree with the reservation it is standing in for.
  const reason = resolveBudgetExhaustion(db, budget, now);
  if (!reason) return null;
  // Identical *write*, too. Without it the refusal is invisible to everything
  // that reads durable state, and `resume --new-run` has nothing to resume.
  markModelBudgetExhausted(db, budget.budgetId, reason, now.toISOString());
  return { budgetId: budget.budgetId, parentWaveId: budget.parentWaveId, reason };
}

/**
 * Did this claim actually spend a provider attempt before it gave up?
 *
 * A config-rejected row is NOT a spent call — the provider refused the envelope
 * before doing any work — so it must not make an unspent claim look spent and
 * lose its refund (#31 §3.5.3-3).
 */
function hasModelAttemptSince(db: Database.Database, jobId: string, since: Date): boolean {
  const outcomeAware = columnNames(db, MODEL_ATTEMPT_TABLE).has("outcome");
  return db.prepare(`
    SELECT 1 FROM model_work_attempts a
    WHERE a.job_id = ? AND a.started_at >= ?
      ${outcomeAware ? `AND ${budgetRelevantOutcomeSql("a")}` : ""}
    LIMIT 1
  `).get(jobId, since.toISOString()) !== undefined;
}

/**
 * Release a claimed queue item because its parent model budget is exhausted.
 * This transition intentionally does not increment queue attempts, move a
 * cursor, or mark a target dead. The scheduler filters the exhausted budget
 * until bounded automatic maintenance or an explicit operator run rebinds it.
 *
 * `claimedAt` opts into the issue-#12 safety net: when the budget died of a
 * `deadline`/`window` (i.e. wall-clock, not work) and this claim never
 * reserved a single provider attempt, the claim itself was a no-op, so the
 * attempt it consumed is refunded and the job returns to `pending` at `now`
 * instead of an hour out. An `attempts` exhaustion keeps the old contract:
 * that budget really was spent, and the backoff is the fence.
 */
export function deferMemoryJobForModelBudget(
  db: Database.Database,
  input: {
    jobId: string;
    budgetId?: string;
    parentWaveId?: string;
    owner: string;
    leaseGeneration: number;
    reason: ModelBudgetExhaustionReason;
    now?: Date;
    availableAt?: Date;
    /** Instant this claim was taken; enables the unspent-claim refund. */
    claimedAt?: Date;
  },
): boolean {
  ensureModelBudgetSchema(db);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const unspentClaim =
    (input.reason === "deadline" || input.reason === "window") &&
    input.claimedAt !== undefined &&
    !hasModelAttemptSince(db, input.jobId, input.claimedAt);
  const availableAt = unspentClaim
    ? now
    : input.availableAt ?? new Date(now.getTime() + 60 * 60_000);
  const reason = `model work budget exhausted: ${input.reason}`;
  const defer = db.transaction(() => {
    const row = db.prepare(`
      SELECT target_id, checkpoint_id, kind, budget_id, maintenance_wave_id
      FROM memory_jobs
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.jobId, input.owner, input.leaseGeneration, nowIso) as
      | {
          target_id: string | null;
          checkpoint_id: string | null;
          kind: string;
          budget_id: string | null;
          maintenance_wave_id: string | null;
        }
      | undefined;
    if (!row) return false;
    const budget = input.budgetId ? readBudgetById(db, input.budgetId) : null;
    if (input.budgetId && !budget) throw new ModelBudgetNotFoundError(input.budgetId);
    if (input.budgetId && row.budget_id && row.budget_id !== input.budgetId) {
      throw new ModelBudgetAffinityError(input.jobId, row.budget_id, input.budgetId);
    }
    const changed = db.prepare(`
      UPDATE memory_jobs
      SET budget_id = COALESCE(budget_id, ?),
          maintenance_wave_id = COALESCE(maintenance_wave_id, ?),
          state = ?, available_at = ?, lease_owner = NULL,
          lease_until = NULL, last_error = ?, updated_at = ?,
          attempts = CASE WHEN ? THEN MAX(attempts - 1, 0) ELSE attempts END
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
        AND (budget_id IS NULL OR budget_id = ?)
    `).run(
      input.budgetId ?? null,
      input.parentWaveId ?? budget?.parentWaveId ?? null,
      unspentClaim ? "pending" : "retry",
      availableAt.toISOString(),
      reason,
      nowIso,
      unspentClaim ? 1 : 0,
      input.jobId,
      input.owner,
      input.leaseGeneration,
      nowIso,
      input.budgetId ?? row.budget_id,
    ).changes;
    if (changed !== 1) return false;
    if (row.target_id) {
      // The target's own attempt counter is refunded with the job's, but only
      // where the column exists — minimal fixtures model this table narrowly.
      const refundTargetAttempt =
        unspentClaim && columnNames(db, "extraction_targets").has("attempts");
      db.prepare(`
        UPDATE extraction_targets
        SET state = ?, lease_owner = NULL, lease_until = NULL,
            last_error = ?, updated_at = ?
            ${refundTargetAttempt ? ", attempts = MAX(attempts - 1, 0)" : ""}
        WHERE target_id = ? AND state = 'running' AND lease_owner = ?
          AND lease_generation = ?
      `).run(
        unspentClaim ? "pending" : "retry",
        reason,
        nowIso,
        row.target_id,
        input.owner,
        input.leaseGeneration,
      );
    }
    if (row.checkpoint_id) {
      db.prepare("UPDATE checkpoints SET state = 'retry' WHERE checkpoint_id = ?")
        .run(row.checkpoint_id);
      if (row.kind === 'capsule_update') {
        db.prepare(`
          UPDATE capsule_checkpoint_state
          SET state = 'retry', last_error = ?, updated_at = ?
          WHERE checkpoint_id = ? AND state IN ('processing','retry','pending')
        `).run(reason, nowIso, row.checkpoint_id);
      }
    }
    return true;
  });
  return defer.immediate();
}

/* ------------------------------------------------------------------------- *
 * Issue #31 — HOLD transitions.
 *
 * Classifying a rejection `'config'` is not enough on its own: by the time the
 * model answers, the claim ALREADY happened. Extraction's
 * `claimExtractionTargetWithReason` has written three things — `memory_jobs`
 * (running + lease + attempts+1), `extraction_targets` (the same), and
 * `checkpoints.state='processing'` — so a hold has to UNDO all three, or the
 * job sits `running` with a spent attempt and eventually goes `dead` for a
 * reason that was never its fault (2nd review (b)1).
 *
 * The precedent is right above: `deferMemoryJobForModelBudget` already refunds
 * a claim whose wall-clock budget died unspent. These transitions reuse its
 * structure, with one difference that matters — the reason is a PARAMETER.
 * Gate/extraction overlays hold work for reasons of their own (a quarantined
 * `never_extract` pattern, a check that could not finish), and they must reach
 * the identical state transition rather than a second near-copy of it.
 * ------------------------------------------------------------------------- */

function assertHoldReason(reason: string): HoldReason {
  if (!(HOLD_REASONS as readonly string[]).includes(reason)) {
    throw new Error(
      `unknown hold reason ${JSON.stringify(reason)}; expected one of ${HOLD_REASONS.join(", ")}`,
    );
  }
  return reason as HoldReason;
}

/** The column lives on `memory_jobs` (owned by ensureContinuitySchema) but is
 *  written only here, so make sure it exists before the first write. */
function ensureHoldReasonColumn(db: Database.Database): boolean {
  if (!tableExists(db, "memory_jobs")) return false;
  if (columnNames(db, "memory_jobs").has("hold_reason")) return true;
  db.exec("ALTER TABLE memory_jobs ADD COLUMN hold_reason TEXT");
  return true;
}

/** One bounded line for `last_error`; the next normal claim overwrites it. */
function holdDetail(reason: HoldReason, detail: string): string {
  return `held (${reason}): ${detail}`.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

interface HoldJobRow {
  target_id: string | null;
  checkpoint_id: string | null;
  kind: string;
}

function holdJobStatement(db: Database.Database) {
  return db.prepare(`
    UPDATE memory_jobs
    SET state = 'pending', available_at = ?, lease_owner = NULL, lease_until = NULL,
        attempts = MAX(attempts - 1, 0), hold_reason = ?, last_error = ?, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `);
}

/**
 * Return one claimed job to "waiting on a configuration".
 *
 * Deliberately NOT `failMemoryJob`:
 *  - state is `'pending'`, not `'retry'` — a hold does not belong on the
 *    exponential backoff ladder, and `max_attempts` must never terminate it;
 *  - `available_at` is now, so the session after the fix picks it up at once;
 *  - attempts are REFUNDED (the claim bought nothing);
 *  - `checkpoints` and `capsule_checkpoint_state` are untouched — a hold is not
 *    a failure, and for Capsule work advancing anything here would step the
 *    evidence frontier and lose a fragment permanently.
 *
 * The CAS is byte-for-byte `failMemoryJob`'s, so a stale owner can never
 * overwrite a live claim. Returns false when it does not match.
 */
export function holdMemoryJob(
  db: Database.Database,
  input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    reason: HoldReason;
    detail: string;
    now?: Date;
  },
): boolean {
  const reason = assertHoldReason(input.reason);
  ensureModelBudgetSchema(db);
  if (!ensureHoldReasonColumn(db)) return false;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const detail = holdDetail(reason, input.detail);
  const hold = db.transaction(() =>
    holdJobStatement(db).run(
      nowIso, reason, detail, nowIso,
      input.jobId, input.owner, input.leaseGeneration, nowIso,
    ).changes === 1,
  );
  return db.inTransaction ? hold() : hold.immediate();
}

/**
 * Return a whole extraction claim — job + target + checkpoint marker.
 *
 * Acceptance criterion, asserted by the tests: across this transition
 * `memory_jobs.attempts` and `extraction_targets.attempts` are unchanged from
 * before the claim, both states are `pending`, `extraction_failures` and
 * `extraction_log` gain NO rows, and `checkpoints.state` is back off
 * `processing`. A hold that leaves a failed range behind is not a hold.
 */
export function releaseExtractionClaimOnHold(
  db: Database.Database,
  input: {
    targetId: string;
    jobId: string;
    owner: string;
    leaseGeneration: number;
    reason: HoldReason;
    detail: string;
    now?: Date;
  },
): boolean {
  const reason = assertHoldReason(input.reason);
  ensureModelBudgetSchema(db);
  if (!ensureHoldReasonColumn(db)) return false;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const detail = holdDetail(reason, input.detail);
  const release = db.transaction(() => {
    const row = db.prepare(`
      SELECT target_id, checkpoint_id, kind FROM memory_jobs
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.jobId, input.owner, input.leaseGeneration, nowIso) as HoldJobRow | undefined;
    if (!row) return false;
    const changed = holdJobStatement(db).run(
      nowIso, reason, detail, nowIso,
      input.jobId, input.owner, input.leaseGeneration, nowIso,
    ).changes;
    if (changed !== 1) return false;
    const targetId = input.targetId || row.target_id;
    if (targetId && tableExists(db, "extraction_targets")) {
      // Minimal fixtures model this table narrowly — the same `attempts` guard
      // `deferMemoryJobForModelBudget` uses.
      const refundTargetAttempt = columnNames(db, "extraction_targets").has("attempts");
      db.prepare(`
        UPDATE extraction_targets
        SET state = 'pending', lease_owner = NULL, lease_until = NULL,
            last_error = ?, updated_at = ?
            ${refundTargetAttempt ? ", attempts = MAX(attempts - 1, 0)" : ""}
        WHERE target_id = ? AND state = 'running' AND lease_owner = ?
          AND lease_generation = ?
      `).run(detail, nowIso, targetId, input.owner, input.leaseGeneration);
    }
    if (row.checkpoint_id && tableExists(db, "checkpoints")) {
      // Only the marker the claim itself wrote. Any other value belongs to
      // someone else's transition and is left exactly as found.
      db.prepare(
        "UPDATE checkpoints SET state = 'pending' WHERE checkpoint_id = ? AND state = 'processing'",
      ).run(row.checkpoint_id);
    }
    return true;
  });
  return db.inTransaction ? release() : release.immediate();
}

/**
 * Lift the hold marker so the next claim treats the job as ordinary work.
 *
 * Touches `hold_reason` and nothing else: the job is already `pending` with its
 * attempts refunded, and rewriting state/attempts here would undo that.
 */
export function clearJobHold(db: Database.Database, jobId: string): boolean {
  ensureModelBudgetSchema(db);
  if (!ensureHoldReasonColumn(db)) return false;
  return db.prepare(
    "UPDATE memory_jobs SET hold_reason = NULL, updated_at = ? WHERE job_id = ? AND hold_reason IS NOT NULL",
  ).run(new Date().toISOString(), jobId).changes === 1;
}

/**
 * Lift every hold with THIS reason. Returns how many rows were lifted.
 *
 * Reason isolation is the point: a fixed model selection must not release jobs
 * that are waiting on a quarantined extraction rule, and vice versa. Each owner
 * releases only its own.
 */
export function releaseHeldJobs(db: Database.Database, reason: HoldReason): number {
  assertHoldReason(reason);
  ensureModelBudgetSchema(db);
  if (!ensureHoldReasonColumn(db)) return 0;
  return db.prepare(
    "UPDATE memory_jobs SET hold_reason = NULL, updated_at = ? WHERE hold_reason = ?",
  ).run(new Date().toISOString(), reason).changes;
}

/** Per-reason held-job counts for `memex status`, doctor and the Web UI. */
export function heldJobSummary(
  db: Database.Database,
): Array<{ reason: HoldReason; jobs: number; oldestHeldAt: string | null }> {
  if (!tableExists(db, "memory_jobs")) return [];
  if (!columnNames(db, "memory_jobs").has("hold_reason")) return [];
  const rows = db.prepare(`
    SELECT hold_reason AS reason, COUNT(*) AS jobs, MIN(updated_at) AS oldest
    FROM memory_jobs
    WHERE hold_reason IS NOT NULL AND state NOT IN ('completed','superseded','dead')
    GROUP BY hold_reason
    ORDER BY hold_reason
  `).all() as Array<{ reason: string; jobs: number; oldest: string | null }>;
  return rows
    .filter((row): row is { reason: HoldReason; jobs: number; oldest: string | null } =>
      (HOLD_REASONS as readonly string[]).includes(row.reason))
    .map((row) => ({ reason: row.reason, jobs: Number(row.jobs), oldestHeldAt: row.oldest ?? null }));
}

/* ------------------------------------------------------------------------- *
 * Issue #31 — the durable config-hold table (fingerprint keyed, see the DDL).
 * ------------------------------------------------------------------------- */

export interface ModelConfigHold {
  fingerprint: string;
  heldAt: string;
  model: string;
  reasoningEffort: string | null;
  status: number | null;
  providerType: string | null;
  providerMessage: string;
  observedCount: number;
  lastObservedAt: string;
}

function holdFromRow(row: Record<string, unknown>): ModelConfigHold {
  return {
    fingerprint: String(row.selection_fingerprint),
    heldAt: String(row.held_at),
    model: String(row.model),
    reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
    status: row.provider_status == null ? null : Number(row.provider_status),
    providerType: row.provider_type == null ? null : String(row.provider_type),
    providerMessage: row.provider_message == null ? "" : String(row.provider_message),
    observedCount: Number(row.observed_count ?? 1),
    lastObservedAt: String(row.last_observed_at),
  };
}

/**
 * Record (or re-observe) a hold for ONE selection fingerprint.
 *
 * "Exactly once per data root" is explicitly NOT promised: the hold is written
 * AFTER a rejection is observed, so calls already in flight each take one
 * rejection. The guarantee is the bound — the number of provider calls a wrong
 * setting can cause equals the number of calls already in flight when the hold
 * commits (measured 1-4 workers), and zero afterwards. Retry and splitting can
 * never add to it.
 */
export function recordModelConfigHold(
  db: Database.Database,
  input: {
    fingerprint: string;
    model: string;
    reasoningEffort: string | null;
    status: number | null;
    providerType: string | null;
    providerMessage: string;
    stage?: string | null;
    jobId?: string | null;
    now?: Date;
  },
): void {
  ensureModelBudgetSchema(db);
  const nowIso = (input.now ?? new Date()).toISOString();
  db.prepare(`
    INSERT INTO model_config_holds
      (selection_fingerprint, held_at, model, reasoning_effort, provider_status,
       provider_type, provider_message, first_stage, first_job_id,
       observed_count, last_observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(selection_fingerprint) DO UPDATE SET
      observed_count = model_config_holds.observed_count + 1,
      last_observed_at = excluded.last_observed_at,
      provider_status = excluded.provider_status,
      provider_type = excluded.provider_type,
      provider_message = excluded.provider_message,
      -- A re-observation revives a cleared row: the selection is still broken.
      cleared_at = NULL,
      cleared_by = NULL
  `).run(
    input.fingerprint,
    nowIso,
    input.model,
    input.reasoningEffort,
    input.status,
    input.providerType,
    input.providerMessage.slice(0, 400),
    input.stage ?? null,
    input.jobId ?? null,
    nowIso,
  );
}

/** The active hold for THIS fingerprint, or null. Other fingerprints' rows are
 *  never read, updated or deleted here — that is the whole (b)5 fix. */
export function activeModelConfigHold(
  db: Database.Database,
  fingerprint: string,
): ModelConfigHold | null {
  if (!tableExists(db, "model_config_holds")) return null;
  const row = db.prepare(
    "SELECT * FROM model_config_holds WHERE selection_fingerprint = ? AND cleared_at IS NULL",
  ).get(fingerprint) as Record<string, unknown> | undefined;
  return row ? holdFromRow(row) : null;
}

/** Close one fingerprint's hold. The row is kept (audit), never deleted. */
export function clearModelConfigHold(
  db: Database.Database,
  fingerprint: string,
  reason: "probe-ok" | "manual",
  now = new Date(),
): boolean {
  ensureModelBudgetSchema(db);
  return db.prepare(
    `UPDATE model_config_holds SET cleared_at = ?, cleared_by = ?
     WHERE selection_fingerprint = ? AND cleared_at IS NULL`,
  ).run(now.toISOString(), reason, fingerprint).changes === 1;
}

/** Every active hold, flagged with whether it is the one blocking this process.
 *  Other selections' holds are visible but inert here. */
export function listModelConfigHolds(
  db: Database.Database,
  currentFingerprint?: string,
): Array<ModelConfigHold & { current: boolean }> {
  if (!tableExists(db, "model_config_holds")) return [];
  const rows = db.prepare(
    "SELECT * FROM model_config_holds WHERE cleared_at IS NULL ORDER BY held_at, selection_fingerprint",
  ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const hold = holdFromRow(row);
    return { ...hold, current: currentFingerprint === hold.fingerprint };
  });
}

/**
 * The hold (if any) blocking THIS process's current selection.
 *
 * A convenience for the pre-claim gates in the detached workers and the session
 * hook, which otherwise each have to import two modules to ask one question.
 */
export function currentModelConfigHold(
  db: Database.Database,
  overrides?: LlmSelectionOverride,
): ModelConfigHold | null {
  return activeModelConfigHold(db, llmSelectionFingerprint(overrides));
}

/**
 * Settle a reservation the provider refused before any model work began.
 *
 * Four things together make a wrong setting cost ZERO budget: no retry (llm.ts),
 * this refund, exclusion from the 24h automatic window, and the claim refund
 * above. What remains is one evidence row and one hold row.
 *
 * The exhaustion release is the subtle half. `reserveModelAttempt` marks a
 * budget `exhausted` when it hands out the last attempt, and `budgetExhaustion`
 * treats that state as STICKY — so decrementing the counter alone does not
 * unblock anything. The release condition cannot look at the refunded row's own
 * `attempt_no` either: with `max_attempts=2`, if A reserves #1, B reserves #2
 * (exhausting it), B then completes and A is rejected, the reservation that
 * caused exhaustion was B's while the one being refunded is A's — the observed
 * result was `('exhausted', 1, 2)`. So it counts EFFECTIVE USAGE right now
 * instead, and deadline/cancelled exhaustion is never revived.
 */
export function settleConfigRejectedAttempt(
  db: Database.Database,
  input: { attemptId: string; durationMs?: number; errorClass?: string; now?: Date },
): boolean {
  ensureModelBudgetSchema(db);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const settle = db.transaction(() => {
    // Idempotency guard: only a still-`reserved` row can be settled, so a
    // double call cannot refund twice.
    const changed = db.prepare(`
      UPDATE ${MODEL_ATTEMPT_TABLE}
      SET state = 'failed', outcome = 'config_rejected', error_class = ?,
          finished_at = ?, duration_ms = ?
      WHERE attempt_id = ? AND state = 'reserved'
    `).run(
      (input.errorClass ?? "CodexRequestRejectedError").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120),
      nowIso,
      input.durationMs == null ? null : Math.max(0, Math.trunc(input.durationMs)),
      input.attemptId,
    ).changes;
    if (changed !== 1) return false;
    const row = db.prepare(
      `SELECT budget_id FROM ${MODEL_ATTEMPT_TABLE} WHERE attempt_id = ?`,
    ).get(input.attemptId) as { budget_id: string } | undefined;
    if (!row) return false;
    db.prepare(`
      UPDATE ${MODEL_BUDGET_TABLE}
      SET reserved_attempts = MAX(reserved_attempts - 1, 0), updated_at = ?
      WHERE budget_id = ?
    `).run(nowIso, row.budget_id);
    db.prepare(`
      UPDATE ${MODEL_BUDGET_TABLE} SET state = 'active', updated_at = ?
      WHERE budget_id = ? AND state = 'exhausted'
        AND reserved_attempts < max_attempts
        AND (SELECT COUNT(*) FROM ${MODEL_ATTEMPT_TABLE} a
              WHERE a.budget_id = ${MODEL_BUDGET_TABLE}.budget_id
                AND ${budgetRelevantOutcomeSql("a")}) < max_attempts
        AND (deadline_at IS NULL OR deadline_at > ?)
    `).run(nowIso, row.budget_id, nowIso);
    return true;
  });
  return db.inTransaction ? settle() : settle.immediate();
}

function remainingDeadlineMs(deadlineAt: string | null, now = Date.now()): number | null {
  if (!deadlineAt) return null;
  return Math.max(0, Date.parse(deadlineAt) - now);
}

function budgetExhaustion(
  budget: ModelWorkBudget,
  now = Date.now(),
): ModelBudgetExhaustionReason | null {
  if (budget.state === "cancelled") return "cancelled";
  if (budget.reservedAttempts >= budget.maxAttempts) return "attempts";
  if (budget.deadlineAt && Date.parse(budget.deadlineAt) <= now) return "deadline";
  // An exhausted window stays fenced until the scheduler explicitly rolls
  // its pending work forward; an old process cannot revive it on its own.
  if (budget.state === "exhausted") return "attempts";
  return null;
}

/**
 * The one exhaustion predicate in this module: the budget's own durable limits
 * plus the rolling automatic-maintenance cap. Every caller that has to decide
 * "is this budget spent?" — the pre-claim check, the reservation it stands in
 * for, the automatic wake and `resume --new-run` — asks this, so none of them
 * can disagree with the others about the same budget at the same instant.
 */
function resolveBudgetExhaustion(
  db: Database.Database,
  budget: ModelWorkBudget,
  now: Date,
): ModelBudgetExhaustionReason | null {
  return (
    budgetExhaustion(budget, now.getTime()) ??
    (budget.automatic && automaticMaintenanceWindow(db, now).remaining === 0
      ? "window"
      : null)
  );
}

/**
 * The one durable "this budget is spent" write.
 *
 * 🚨 Issue #14. Until 0.5.1 this write lived only inside `reserveModelAttempt`,
 * which is what made a deadline-expired budget reach durable `exhausted` and
 * therefore made `model-work resume --new-run` possible. The issue-#12
 * pre-claim check then short-circuited *before* the reservation, so the
 * transition never happened: the budget stayed `active` forever, every claim
 * deferred, and resume refused. Sharing the write keeps the pre-claim path,
 * the reservation, the automatic wake and resume on one identical transition
 * instead of three copies that can drift.
 *
 * The `state IN ('active','exhausted')` guard keeps a terminal `completed`/
 * `cancelled` budget from being rewritten; `exhausted` is included so the write
 * stays idempotent and refreshes `updated_at`.
 */
function markModelBudgetExhausted(
  db: Database.Database,
  budgetId: string,
  reason: ModelBudgetExhaustionReason,
  nowIso: string,
): void {
  db.prepare(
    "UPDATE model_work_budgets SET state = ?, updated_at = ? WHERE budget_id = ? AND state IN ('active','exhausted')",
  ).run(reason === "cancelled" ? "cancelled" : "exhausted", nowIso, budgetId);
}

/**
 * Atomically reserve one provider attempt immediately before runCodex. A
 * reservation is never returned to the pool: a crash after this point still
 * represents a possible provider attempt and must remain counted.
 */
export function reserveModelAttempt(
  db: Database.Database,
  input: {
    budgetId: string;
    stage?: string;
    jobId?: string | null;
    targetId?: string | null;
    inputChars: number;
    now?: Date;
    /** Issue #31: the selection this attempt INTENDS to use. Defaults to the
     *  resolved one; llm.ts passes a per-call override when it has one, and
     *  overwrites both with the selection actually sent at completion. */
    model?: string | null;
    reasoningEffort?: string | null;
  },
): ModelAttemptReservation {
  ensureModelBudgetSchema(db);
  if (!Number.isSafeInteger(input.inputChars) || input.inputChars < 0) {
    throw new Error("inputChars must be a non-negative safe integer");
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const stage = input.stage?.trim() || "standalone";
  const intendedModel = input.model?.trim() || resolveLlmModel().value;
  const intendedEffort =
    input.reasoningEffort !== undefined
      ? input.reasoningEffort
      : resolveReasoningEffort().value;
  const reserve = db.transaction((): ModelAttemptReservation | ModelBudgetExhaustedError => {
    const row = db
      .prepare("SELECT * FROM model_work_budgets WHERE budget_id = ?")
      .get(input.budgetId) as Record<string, unknown> | undefined;
    if (!row) throw new ModelBudgetNotFoundError(input.budgetId);
    const budget = budgetFromRow(row);
    if (input.inputChars > budget.maxInputChars) {
      throw new ModelBudgetInputLimitError(input.inputChars, budget.maxInputChars);
    }
    const reason = resolveBudgetExhaustion(db, budget, now);
    if (reason) {
      markModelBudgetExhausted(db, input.budgetId, reason, nowIso);
      // Return the error after the transaction commits. Throwing here would
      // roll back the durable exhausted state and make a deadline/attempt cap
      // look active again on the next worker restart.
      return new ModelBudgetExhaustedError(
        budget.budgetId,
        budget.parentWaveId,
        reason,
      );
    }
    // Issue #31: the LEDGER sequence and the ACCOUNTING counter had to be
    // separated. `attempt_no` used to be `reservedAttempts + 1`, which is the
    // same number only while nothing is ever refunded — and
    // `settleConfigRejectedAttempt` refunds. With a config-rejected row still
    // holding sequence 1, the next reservation recomputed 1 and died on
    // `idx_model_work_attempts_sequence` (UNIQUE(budget_id, attempt_no)), so a
    // rejected selection wedged the budget it was supposed to free. The sequence
    // now comes from the ledger (dense, unique, never reused) and the counter
    // stays the spend accounting.
    const attemptNo = Number(
      (db.prepare(
        `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM ${MODEL_ATTEMPT_TABLE} WHERE budget_id = ?`,
      ).get(budget.budgetId) as { n: number }).n,
    );
    const nextReserved = budget.reservedAttempts + 1;
    const attemptId = randomUUID();
    db.prepare(`
      INSERT INTO model_work_attempts
        (attempt_id, budget_id, attempt_no, stage, job_id, target_id,
         state, started_at, input_chars, token_usage_status, model, reasoning_effort)
      VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, 'NOT_PROVEN', ?, ?)
    `).run(
      attemptId,
      budget.budgetId,
      attemptNo,
      stage,
      input.jobId ?? null,
      input.targetId ?? null,
      nowIso,
      input.inputChars,
      intendedModel,
      intendedEffort,
    );
    const nextState =
      nextReserved >= budget.maxAttempts ||
      (budget.deadlineAt != null && Date.parse(budget.deadlineAt) <= now.getTime())
        ? "exhausted"
        : "active";
    db.prepare(`
      UPDATE model_work_budgets
      SET reserved_attempts = ?, state = ?, updated_at = ?
      WHERE budget_id = ? AND reserved_attempts = ?
    `).run(nextReserved, nextState, nowIso, budget.budgetId, budget.reservedAttempts);
    if (input.jobId) {
      const job = db
        .prepare("SELECT budget_id FROM memory_jobs WHERE job_id = ?")
        .get(input.jobId) as { budget_id: string | null } | undefined;
      if (job?.budget_id && job.budget_id !== input.budgetId) {
        throw new ModelBudgetAffinityError(input.jobId, job.budget_id, input.budgetId);
      }
      if (job && !job.budget_id) {
        db.prepare(
          "UPDATE memory_jobs SET budget_id = ?, maintenance_wave_id = COALESCE(maintenance_wave_id, ?) WHERE job_id = ? AND budget_id IS NULL",
        ).run(input.budgetId, budget.parentWaveId, input.jobId);
      }
    }
    return {
      attemptId,
      budgetId: budget.budgetId,
      parentWaveId: budget.parentWaveId,
      attemptNo,
      startedAt: nowIso,
      deadlineAt: budget.deadlineAt,
      maxInputChars: budget.maxInputChars,
      maxOutputChars: budget.maxOutputChars,
      remainingAttempts: Math.max(0, budget.maxAttempts - nextReserved),
      remainingDeadlineMs: remainingDeadlineMs(budget.deadlineAt, now.getTime()),
    } satisfies ModelAttemptReservation;
  });
  const result = reserve.immediate();
  if (result instanceof ModelBudgetExhaustedError) throw result;
  return result;
}

export function finishModelAttempt(
  db: Database.Database,
  input: FinishModelAttemptInput,
): boolean {
  ensureModelBudgetSchema(db);
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const usage = input.tokenUsage
    ? JSON.stringify({
        input_tokens: input.tokenUsage.input_tokens,
        output_tokens: input.tokenUsage.output_tokens,
        ...(input.tokenUsage.cached_input_tokens == null
          ? {}
          : { cached_input_tokens: input.tokenUsage.cached_input_tokens }),
      })
    : null;
  // Keep the ledger content-free. Provider stderr and prompt text can contain
  // user data or secrets; callers may still pass a human-readable message for
  // local logs, but durable diagnostics retain only the stable error class.
  const durableErrorClass = input.errorClass
    ? input.errorClass.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120)
    : null;
  const durableTokenUsageStatus = input.tokenUsage
    ? input.tokenUsageStatus === "NOT_PROVEN"
      ? "NOT_PROVEN"
      : input.tokenUsage.cached_input_tokens == null
        ? "partial"
        : input.tokenUsageStatus ?? "observed"
    : input.tokenUsageStatus ?? "NOT_PROVEN";
  const changed = db
    .prepare(`
      UPDATE model_work_attempts
      SET state = ?, finished_at = ?, duration_ms = ?, output_chars = ?,
          token_usage_json = ?, token_usage_status = ?, error_class = ?,
          error_message = ?,
          model = COALESCE(?, model),
          reasoning_effort = CASE WHEN ? THEN ? ELSE reasoning_effort END
      WHERE attempt_id = ? AND state = 'reserved'
    `)
    .run(
      input.state,
      finishedAt,
      input.durationMs == null ? null : Math.max(0, Math.trunc(input.durationMs)),
      input.outputChars == null ? null : Math.max(0, Math.trunc(input.outputChars)),
      usage,
      durableTokenUsageStatus,
      durableErrorClass,
      null,
      input.model ?? null,
      // `reasoningEffort: null` is a real observation ("no flag was sent"), so
      // it must be distinguishable from "the caller said nothing".
      input.reasoningEffort !== undefined ? 1 : 0,
      input.reasoningEffort ?? null,
      input.attemptId,
    ).changes;
  return changed === 1;
}

/** Mark a known budget exhausted without reserving a synthetic provider call. */
export function exhaustModelBudget(
  db: Database.Database,
  input: { budgetId: string; reason: ModelBudgetExhaustionReason; now?: Date },
): ModelBudgetExhaustedError {
  ensureModelBudgetSchema(db);
  const row = readBudgetById(db, input.budgetId);
  if (!row) throw new ModelBudgetNotFoundError(input.budgetId);
  const now = input.now ?? new Date();
  markModelBudgetExhausted(db, input.budgetId, input.reason, now.toISOString());
  return new ModelBudgetExhaustedError(row.budgetId, row.parentWaveId, input.reason);
}

export function isModelBudgetExhausted(error: unknown): error is ModelBudgetError {
  if (error instanceof ModelBudgetError) return true;
  const reason = error as { reason?: unknown } | null;
  if (reason && reason.reason !== error && isModelBudgetExhausted(reason.reason)) return true;
  return (error as { code?: unknown } | null)?.code === "MEMEX_MODEL_BUDGET";
}

export function modelBudgetErrorFromUnknown(error: unknown): ModelBudgetError | null {
  if (error instanceof ModelBudgetError) return error;
  const reason = error as { reason?: unknown } | null;
  if (reason && reason.reason !== error) return modelBudgetErrorFromUnknown(reason.reason);
  return null;
}

function configuredDbPath(context?: ModelWorkContext): string {
  if (context?.dbPath) return context.dbPath;
  // Unit tests that do not configure a DB must not write the user's durable
  // store. Production standalone workers still use getDbPath().
  if ((process.env.VITEST || process.env.NODE_ENV === "test") &&
      !process.env.MEMEX_DB_PATH && !process.env.TEST_DB_PATH) {
    return ":memory:";
  }
  return getDbPath();
}

function openBudgetDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  if (dbPath !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }
  ensureModelBudgetSchema(db);
  return db;
}

function envContext(): Partial<ModelWorkContext> {
  return {
    budgetId: process.env.MEMEX_MODEL_BUDGET_ID || undefined,
    parentWaveId:
      process.env.MEMEX_MAINTENANCE_WAVE_ID ||
      process.env.MEMEX_MODEL_PARENT_WAVE_ID ||
      undefined,
    stage: process.env.MEMEX_MODEL_WORK_STAGE || undefined,
    jobId: process.env.MEMEX_MODEL_JOB_ID || undefined,
    targetId: process.env.MEMEX_MODEL_TARGET_ID || undefined,
  };
}

interface PendingModelWorkCounts {
  pending: number;
  reserved: number;
  unbound: number;
}

/**
 * 이슈 #41: 유지보수 wave가 "남은 파생 일감"을 판정하는 술어.
 *
 * 예전에는 `ontology_category_id IS NULL`만 봤다. 실패로 파킹된 fact는
 * category id가 채워져 있으므로 여기에 걸리지 않았고, 그래서 wave가
 * completed로 닫혔으며 SessionStart는 ontology 워커를 아예 띄우지 않았다 —
 * 파킹이 영구가 된 마지막 고리다. 현재 (정책, 임베딩) 세대에서 아직 재시도를
 * 쓰지 않은 파킹 행은 진짜 일감이므로 pending으로 센다. 손으로 만든 옛 스키마
 * (컬럼 없음)에서는 예전 술어로 정확히 되돌아간다.
 */
function ontologyPendingPredicate(db: Database.Database, alias = "f"): string {
  if (!columnNames(db, "facts").has("ontology_state")) {
    return `${alias}.ontology_category_id IS NULL`;
  }
  return ontologyPendingSqlInline(alias, EMBEDDING_VERSION);
}

function countPendingModelWork(
  db: Database.Database,
  budgetId?: string,
): PendingModelWorkCounts {
  const counts: PendingModelWorkCounts = { pending: 0, reserved: 0, unbound: 0 };
  const derivedFactQueue = hasDerivedFactQueue(db);
  if (tableExists(db, "memory_jobs") && columnNames(db, "memory_jobs").has("budget_id")) {
    const scope = budgetId ? "AND budget_id = ?" : "";
    const params = budgetId ? [budgetId] : [];
    const row = db.prepare(`
      SELECT COUNT(*) AS pending
      FROM memory_jobs
      WHERE state IN ('pending','retry','running') ${scope}
    `).get(...params) as { pending: number };
    counts.pending += Number(row?.pending ?? 0);
    if (!budgetId) {
      const unbound = db.prepare(`
        SELECT COUNT(*) AS unbound
        FROM memory_jobs
        WHERE budget_id IS NULL AND state IN ('pending','retry','running')
      `).get() as { unbound: number };
      counts.unbound += Number(unbound?.unbound ?? 0);
    }
  }
  if (tableExists(db, MODEL_TARGET_TABLE) && derivedFactQueue) {
    const scope = budgetId ? "AND t.budget_id = ?" : "";
    const params = budgetId ? [budgetId] : [];
    const row = db.prepare(`
      SELECT COUNT(*) AS pending
      FROM model_work_targets t
      JOIN facts f ON f.id = t.target_id
      WHERE t.state = 'pending' AND f.is_active = 1
        AND ((t.stage = 'ontology' AND ${ontologyPendingPredicate(db)})
          OR (t.stage = 'consolidation' AND f.needs_consolidation = 1)
          OR (t.stage = 'relation' AND f.is_active = 1))
        ${scope}
    `).get(...params) as { pending: number };
    counts.pending += Number(row?.pending ?? 0);
  }
  if (tableExists(db, MODEL_ATTEMPT_TABLE)) {
    const row = db.prepare(`
      SELECT COUNT(*) AS reserved
      FROM model_work_attempts
      WHERE state = 'reserved' ${budgetId ? "AND budget_id = ?" : ""}
    `).get(...(budgetId ? [budgetId] : [])) as { reserved: number };
    counts.reserved = Number(row?.reserved ?? 0);
  }
  if (derivedFactQueue) {
    // A disabled automatic ontology lane leaves NULL category assignments as
    // an intentional local-derived backlog. It must not keep the shared
    // maintenance wave active forever. Explicit ontology workers still bind
    // their provider attempts to a budget and therefore use the full pending
    // predicate below when a budgetId is supplied.
    const includeUnboundOntology = budgetId !== undefined || isAutomaticOntologyEnabled();
    const ontologyPending = ontologyPendingPredicate(db);
    const pendingFactCondition = includeUnboundOntology
      ? `(${ontologyPending} OR f.needs_consolidation = 1)`
      : "f.needs_consolidation = 1";
    const pendingFactsSql = budgetId
      ? `
        SELECT COUNT(*) AS pending
        FROM facts f
        WHERE f.is_active = 1
          AND ${pendingFactCondition}
          AND (
            EXISTS (
              SELECT 1 FROM model_work_targets t
              WHERE t.budget_id = ? AND t.state = 'pending'
                AND t.target_id = f.id
                AND ((t.stage = 'ontology' AND ${ontologyPending})
                  OR (t.stage = 'consolidation' AND f.needs_consolidation = 1)
                  OR (t.stage = 'relation' AND f.is_active = 1))
            )
            OR EXISTS (
              SELECT 1 FROM model_work_attempts a
              WHERE a.budget_id = ?
                AND a.stage IN ('ontology','consolidation')
                AND a.target_id = f.id
            )
          )`
      : `
        SELECT COUNT(*) AS pending
        FROM facts f
        WHERE f.is_active = 1
          AND ${pendingFactCondition}`;
    const row = db.prepare(pendingFactsSql).get(...(budgetId ? [budgetId, budgetId] : [])) as {
      pending: number;
    };
    counts.pending += Number(row?.pending ?? 0);
    if (!budgetId) {
      const unbound = db.prepare(`
        SELECT COUNT(*) AS unbound
        FROM facts f
        WHERE f.is_active = 1
          AND ${pendingFactCondition}
          AND (
            (${ontologyPending} AND NOT EXISTS (
              SELECT 1 FROM model_work_targets t
              WHERE t.target_id = f.id AND t.stage = 'ontology' AND t.state = 'pending'
            ) AND NOT EXISTS (
              SELECT 1 FROM model_work_attempts a
              WHERE a.stage = 'ontology' AND a.target_id = f.id
            ))
            OR
            (f.needs_consolidation = 1 AND NOT EXISTS (
              SELECT 1 FROM model_work_targets t
              WHERE t.target_id = f.id AND t.stage = 'consolidation' AND t.state = 'pending'
            ) AND NOT EXISTS (
              SELECT 1 FROM model_work_attempts a
              WHERE a.stage = 'consolidation' AND a.target_id = f.id
            ))
          )
      `).get() as { unbound: number };
      counts.unbound += Number(unbound?.unbound ?? 0);
    }
  }
  return counts;
}

/**
 * 이슈 #42: 계보 매칭은 LIKE 접두 패턴이 아니라 root 컬럼이다.
 *
 * 옛 방식은 자식이 확장된 id를 루트로 삼아 조회하면 범위가 그 접두사 이하로
 * 좁아져 원래 `maintenance` 계보의 이력 — shared rolling attempt cap이 근거로
 * 삼는 바로 그 이력 — 을 채택하지 못했다. 인자로 어떤 형태의 id가 들어와도
 * (옛 `:run:` 사슬, 새 `#<n>`, 순수 root) 같은 root로 정규화한다.
 */
function latestMaintenanceBudget(
  db: Database.Database,
  parentWaveId: string,
): ModelWorkBudget | null {
  const root = rootWaveIdOf(parentWaveId);
  const row = db.prepare(`
    SELECT * FROM model_work_budgets
    WHERE root_wave_id = ?
    ORDER BY run_seq DESC, created_at DESC, budget_id DESC
    LIMIT 1
  `).get(root) as Record<string, unknown> | undefined;
  return row ? budgetFromRow(row) : null;
}

/** One rolling cap across all automatic maintenance waves in this data root. */
export function automaticMaintenanceWindow(db: Database.Database, now = new Date()): {
  maxAttempts: number; used: number; remaining: number; retryAt: string | null;
} {
  const maxAttempts = envInt(["MEMEX_AUTO_MODEL_MAX_ATTEMPTS"], DEFAULT_AUTOMATIC_MAX_ATTEMPTS, 100_000);
  const cutoff = new Date(now.getTime() - AUTOMATIC_MAINTENANCE_WINDOW_MS).toISOString();
  // Issue #31: a config-rejected row is evidence, not a spent call. Counting it
  // here would let a wrong setting eat the 24h cap, so automatic maintenance
  // would stay blocked even after the setting was fixed.
  const budgetRelevant = columnNames(db, MODEL_ATTEMPT_TABLE).has("outcome")
    ? `AND ${budgetRelevantOutcomeSql("a")}`
    : "";
  const { used } = db.prepare(`
    SELECT COUNT(*) AS used FROM model_work_attempts a
    JOIN model_work_budgets b ON b.budget_id = a.budget_id
    WHERE b.automatic = 1 AND a.started_at > ? ${budgetRelevant}
  `).get(cutoff) as { used: number };
  const oldest = maxAttempts > 0 && used >= maxAttempts ? db.prepare(`
    SELECT a.started_at FROM model_work_attempts a
    JOIN model_work_budgets b ON b.budget_id = a.budget_id
    WHERE b.automatic = 1 AND a.started_at > ? ${budgetRelevant}
    ORDER BY a.started_at, a.attempt_id LIMIT 1 OFFSET ?
  `).get(cutoff, used - maxAttempts) as { started_at: string } | undefined : undefined;
  return {
    maxAttempts, used, remaining: Math.max(0, maxAttempts - used),
    retryAt: oldest ? new Date(Date.parse(oldest.started_at) + AUTOMATIC_MAINTENANCE_WINDOW_MS).toISOString() : null,
  };
}

/** Coalesce prompt/startup wakeups before scanning queues; no model call. */
export function claimMaintenanceWake(db: Database.Database, now = new Date()): boolean {
  return db.prepare(`
    INSERT INTO model_maintenance_wake(id, wake_after) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET wake_after = excluded.wake_after
    WHERE model_maintenance_wake.wake_after <= ?
  `).run(new Date(now.getTime() + MAINTENANCE_WAKE_INTERVAL_MS).toISOString(), now.toISOString()).changes === 1;
}

/**
 * SessionStart continuation. Selection, rollover and target moves are one
 * write transaction; simultaneous sessions cannot mint independent budgets.
 * Explicit worker/operator budgets retain their existing resume contract.
 */
export function getOrCreateAutomaticMaintenanceModelBudget(
  db: Database.Database,
  input: { parentWaveId?: string; limits?: Partial<ModelBudgetLimits>; now?: Date } = {},
): ModelWorkBudget {
  ensureModelBudgetSchema(db);
  const parentWaveId = input.parentWaveId?.trim() || "maintenance";
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const limits = { ...modelBudgetLimitsFromEnv(now.getTime()), ...input.limits };
  const maintain = db.transaction(() => {
    // Adopt the existing named maintenance history, including pre-upgrade
    // attempts. Changing the wave name cannot bypass the shared rolling cap.
    // 이슈 #42: 계보 채택은 root 컬럼 기준이다. 인자가 옛 중첩 id여도 같은
    // 계보로 정규화되므로 shared rolling cap의 전제가 깨지지 않는다.
    const rootWaveId = rootWaveIdOf(parentWaveId);
    db.prepare("UPDATE model_work_budgets SET automatic = 1 WHERE root_wave_id = ?").run(rootWaveId);
    let latest = latestMaintenanceBudget(db, parentWaveId);
    const window = automaticMaintenanceWindow(db, now);
    const lastAttempt = latest ? db.prepare(`
      SELECT MAX(started_at) AS started_at FROM model_work_attempts WHERE budget_id = ?
    `).get(latest.budgetId) as { started_at: string | null } : null;
    const retryAt = latest ? Math.max(
      Date.parse(lastAttempt?.started_at ?? latest.createdAt) + AUTOMATIC_MAINTENANCE_COOLDOWN_MS,
      window.retryAt ? Date.parse(window.retryAt) : 0,
    ) : 0;
    if (latest?.state === "cancelled") return latest;
    // Same transition as the pre-claim check and `reserveModelAttempt` (#14):
    // an automatic wake that meets a clock-dead `active` budget must leave it
    // durably `exhausted`, which is what lets the rollover below adopt it.
    const spent = latest?.state === "active"
      ? resolveBudgetExhaustion(db, latest, now)
      : null;
    if (latest && spent) {
      markModelBudgetExhausted(db, latest.budgetId, spent, nowIso);
      latest = readBudgetById(db, latest.budgetId)!;
    }
    if (latest) {
      // A queue claim outranks maintenance, even after the provider cap is
      // exhausted. Expired claims may be recovered without resetting retries.
      const held = tableExists(db, "memory_jobs") && columnNames(db, "memory_jobs").has("lease_until")
        ? db.prepare("SELECT 1 FROM memory_jobs WHERE budget_id = ? AND lease_until > ? LIMIT 1").get(latest.budgetId, nowIso)
        : null;
      if (held) return latest;
      const reserved = countPendingModelWork(db, latest.budgetId).reserved;
      if (reserved > 0) {
        // Provider calls are bounded by the run deadline. Retain crashed
        // reservations as unknown usage, never free their spent attempts.
        if (!latest.deadlineAt || now.getTime() < Date.parse(latest.deadlineAt) + 60_000) return latest;
        db.prepare(`UPDATE model_work_attempts SET state = 'unknown', finished_at = ?,
          error_class = 'expired_reservation' WHERE budget_id = ? AND state = 'reserved'`)
          .run(nowIso, latest.budgetId);
      }
      const pending = countPendingModelWork(db, latest.budgetId).pending > 0 || countPendingModelWork(db).unbound > 0;
      if (!pending) {
        db.prepare("UPDATE model_work_budgets SET state = 'completed', updated_at = ? WHERE budget_id = ? AND state != 'completed'")
          .run(nowIso, latest.budgetId);
        return readBudgetById(db, latest.budgetId)!;
      }
      if (latest.state === "active") return latest;
      if (window.remaining === 0 || now.getTime() < retryAt) return latest;
    }
    // 이슈 #42: rollover는 접미사 누적이 아니라 run 번호 증가다.
    // `maintenance` → `maintenance#2` → `maintenance#3` — 길이가 유한하고
    // root_wave_id 컬럼이 계보를 들고 있다.
    const nextWaveId = runWaveId(rootWaveId, nextRunSeq(db, rootWaveId));
    const next = latest?.state === "exhausted"
      ? startNewModelWorkRunForBudget(db, {
          budgetId: latest.budgetId, parentWaveId: nextWaveId,
          limits, now, automatic: true,
        }).budget
      : insertModelWorkBudget(db, {
          parentWaveId: latest ? nextWaveId : parentWaveId,
          limits, now,
        });
    db.prepare("UPDATE model_work_budgets SET automatic = 1, state = ? WHERE budget_id = ?")
      .run(window.remaining === 0 ? "exhausted" : "active", next.budgetId);
    return readBudgetById(db, next.budgetId)!;
  });
  return maintain.immediate();
}

/** Stable budget used by the SessionStart maintenance sibling wave. */
function getOrCreateWaveModelBudget(
  db: Database.Database,
  input: {
    parentWaveId: string;
    limits?: Partial<ModelBudgetLimits>;
    reuseCompletedIfIdle?: boolean;
  },
): ModelWorkBudget {
  ensureModelBudgetSchema(db);
  const parentWaveId = input.parentWaveId.trim();
  if (!parentWaveId) throw new Error("parentWaveId must not be empty");
  const maintain = db.transaction(() => {
    let latest = latestMaintenanceBudget(db, parentWaveId);
    const allPending = countPendingModelWork(db);
    if (latest && latest.state === "active") {
      const linked = countPendingModelWork(db, latest.budgetId);
      if (linked.pending > 0 || linked.reserved > 0 || allPending.unbound > 0) {
        return latest;
      }
      db.prepare(`
        UPDATE model_work_budgets
        SET state = 'completed', updated_at = ?
        WHERE budget_id = ? AND state IN ('active','exhausted')
      `).run(new Date().toISOString(), latest.budgetId);
      latest = readBudgetById(db, latest.budgetId);
    }
    if (latest && latest.state === "exhausted") {
      const linked = countPendingModelWork(db, latest.budgetId);
      // Keep a cap attached while either already-owned work or a newly
      // observed derived target is still pending. The latter covers the
      // restart window before a worker has registered its whole batch.
      if (linked.pending > 0 || linked.reserved > 0 || allPending.unbound > 0) return latest;
      db.prepare(`
        UPDATE model_work_budgets
        SET state = 'completed', updated_at = ?
        WHERE budget_id = ? AND state = 'exhausted'
      `).run(new Date().toISOString(), latest.budgetId);
      latest = readBudgetById(db, latest.budgetId);
    }
    if (
      latest &&
      (latest.state === "completed" || latest.state === "cancelled") &&
      (input.reuseCompletedIfIdle ?? true) &&
      allPending.unbound === 0
    ) {
      return latest;
    }
    // 이슈 #42: 여기도 접미사 누적이 아니라 run 번호 증가.
    const root = rootWaveIdOf(parentWaveId);
    const nextWave = latest ? runWaveId(root, nextRunSeq(db, root)) : parentWaveId;
    return insertModelWorkBudget(db, {
      parentWaveId: nextWave,
      limits: input.limits,
    });
  });
  return maintain.immediate();
}

/** Stable budget used by the SessionStart maintenance sibling wave. */
export function getOrCreateMaintenanceModelBudget(
  db: Database.Database,
  input: { parentWaveId?: string; limits?: Partial<ModelBudgetLimits> } = {},
): ModelWorkBudget {
  return getOrCreateWaveModelBudget(db, {
    parentWaveId: input.parentWaveId?.trim() || "maintenance",
    limits: input.limits,
    reuseCompletedIfIdle: true,
  });
}

/** Stable direct-worker budget; restart reuses its named wave. */
export function getOrCreateWorkerModelBudget(
  db: Database.Database,
  input: {
    stage: string;
    parentWaveId?: string;
    budgetId?: string;
    limits?: Partial<ModelBudgetLimits>;
  },
): ModelWorkBudget {
  const stage = input.stage.trim() || "worker";
  const envBudgetId = process.env.MEMEX_MODEL_BUDGET_ID || input.budgetId;
  if (envBudgetId) {
    const budget = readBudgetById(db, envBudgetId);
    if (!budget) throw new ModelBudgetNotFoundError(envBudgetId);
    return budget;
  }
  return getOrCreateWaveModelBudget(db, {
    parentWaveId:
      input.parentWaveId?.trim() ||
      process.env.MEMEX_MAINTENANCE_WAVE_ID?.trim() ||
      `worker:${stage}`,
    limits: input.limits,
    reuseCompletedIfIdle: false,
  });
}

export interface ModelAttemptDiagnostic {
  attemptId: string;
  budgetId: string;
  parentWaveId: string;
  attemptNo: number;
  stage: string;
  jobId: string | null;
  targetId: string | null;
  state: ModelAttemptState;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  inputChars: number | null;
  outputChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  tokenUsageStatus: "observed" | "partial" | "NOT_PROVEN" | null;
  errorClass: string | null;
  errorMessage: string | null;
  /** Issue #31. `null` on rows recorded before this release. */
  model: string | null;
  reasoningEffort: string | null;
  /** `'config_rejected'` for an attempt excluded from budget accounting. */
  outcome: string | null;
}

export interface ModelWorkStageDiagnostics {
  stage: string;
  reserved: number;
  completed: number;
  failed: number;
  unknown: number;
  /** Issue #31: refused envelopes, reported apart from real failures. */
  configRejected: number;
  durationMs: number | null;
  inputChars: number | null;
  outputChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  tokenUsageObserved: number;
  tokenUsagePartial: number;
  tokenUsageUnknown: number;
}

export interface ModelWorkDiagnostics {
  automaticMaintenance?: ReturnType<typeof automaticMaintenanceWindow>;
  budgets: ModelWorkBudget[];
  attempts: ModelAttemptDiagnostic[];
  pending: Array<{
    stage: string;
    jobId: string | null;
    targetId: string | null;
    state: string;
    reason: string | null;
  }>;
  /** Derived backlog with no evidence tying it to the requested budget. */
  unassigned: Array<{
    stage: string;
    targetId: string;
    state: "pending";
    reason: string;
  }>;
  totals: {
    reserved: number;
    completed: number;
    failed: number;
    unknown: number;
    /** Issue #31: its own bucket, SUBTRACTED from `failed` — a refused envelope
     *  is not a failed model call and must not read as one. */
    configRejected: number;
    pending: number;
    durationMs: number | null;
    inputChars: number | null;
    outputChars: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    tokenUsageObserved: number;
    tokenUsagePartial: number;
    tokenUsageUnknown: number;
    unassigned: number;
  };
  stages: ModelWorkStageDiagnostics[];
}

/** Read-only, content-free parent-wave → stage/job/target diagnostics. */
export function getModelWorkDiagnostics(
  db: Database.Database,
  filter: { budgetId?: string; parentWaveId?: string } = {},
): ModelWorkDiagnostics {
  // Diagnostics are also used by read-only status commands. Do not run the
  // additive migration on that connection: an older database simply has no
  // model-work rows to report yet.
  if (!tableExists(db, MODEL_BUDGET_TABLE)) {
    return {
      budgets: [],
      attempts: [],
      pending: [],
      totals: {
        reserved: 0,
        completed: 0,
        failed: 0,
        unknown: 0,
        configRejected: 0,
        pending: 0,
        durationMs: null,
        inputChars: null,
        outputChars: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        tokenUsageObserved: 0,
        tokenUsagePartial: 0,
        tokenUsageUnknown: 0,
        unassigned: 0,
      },
      stages: [],
      unassigned: [],
    };
  }
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.budgetId) {
    where.push("budget_id = ?");
    params.push(filter.budgetId);
  }
  if (filter.parentWaveId) {
    where.push("parent_wave_id = ?");
    params.push(filter.parentWaveId);
  }
  const budgetWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const budgets = (db
    .prepare(`SELECT * FROM model_work_budgets ${budgetWhere} ORDER BY created_at, budget_id`)
    .all(...params) as Record<string, unknown>[]).map(budgetFromRow);
  const ids = budgets.map((budget) => budget.budgetId);
  const attempts: ModelAttemptDiagnostic[] = [];
  if (ids.length > 0 && tableExists(db, MODEL_ATTEMPT_TABLE)) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT a.*, b.parent_wave_id
      FROM model_work_attempts a
      JOIN model_work_budgets b ON b.budget_id = a.budget_id
      WHERE a.budget_id IN (${placeholders})
      ORDER BY a.started_at, a.attempt_id
    `).all(...ids) as Array<Record<string, unknown>>;
    for (const row of rows) {
      let usage: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cached_input_tokens?: unknown;
      } | null = null;
      if (typeof row.token_usage_json === "string") {
        try {
          const parsed = JSON.parse(row.token_usage_json);
          if (parsed && typeof parsed === "object") usage = parsed;
        } catch {
          /* malformed historical telemetry remains unknown */
        }
      }
      const integerOrNull = (value: unknown): number | null =>
        Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
      attempts.push({
        attemptId: String(row.attempt_id),
        budgetId: String(row.budget_id),
        parentWaveId: String(row.parent_wave_id),
        attemptNo: Number(row.attempt_no),
        stage: String(row.stage),
        jobId: row.job_id == null ? null : String(row.job_id),
        targetId: row.target_id == null ? null : String(row.target_id),
        state: String(row.state) as ModelAttemptState,
        startedAt: String(row.started_at),
        finishedAt: row.finished_at == null ? null : String(row.finished_at),
        durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
        inputChars: row.input_chars == null ? null : Number(row.input_chars),
        outputChars: row.output_chars == null ? null : Number(row.output_chars),
        inputTokens: integerOrNull(usage?.input_tokens),
        outputTokens: integerOrNull(usage?.output_tokens),
        cachedInputTokens: integerOrNull(usage?.cached_input_tokens),
        tokenUsageStatus:
          row.token_usage_status == null
            ? null
            : (String(row.token_usage_status) as "observed" | "partial" | "NOT_PROVEN"),
        errorClass: row.error_class == null ? null : String(row.error_class),
        errorMessage: row.error_message == null ? null : String(row.error_message),
        model: row.model == null ? null : String(row.model),
        reasoningEffort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
        outcome: row.outcome == null ? null : String(row.outcome),
      });
    }
  }

  const pending: ModelWorkDiagnostics["pending"] = [];
  const pendingKeys = new Set<string>();
  const addPending = (item: ModelWorkDiagnostics["pending"][number]): void => {
    const key = `${item.stage}\u0000${item.jobId ?? ""}\u0000${item.targetId ?? ""}`;
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);
    pending.push(item);
  };
  const unassigned: ModelWorkDiagnostics["unassigned"] = [];
  const unassignedKeys = new Set<string>();
  const addUnassigned = (item: ModelWorkDiagnostics["unassigned"][number]): void => {
    const key = `${item.stage}\u0000${item.targetId}`;
    if (unassignedKeys.has(key)) return;
    unassignedKeys.add(key);
    unassigned.push(item);
  };
  if (
    tableExists(db, "memory_jobs") &&
    columnNames(db, "memory_jobs").has("budget_id") &&
    ids.length > 0
  ) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT job_id, kind, target_id, state, last_error
      FROM memory_jobs
      WHERE budget_id IN (${placeholders})
        AND state NOT IN ('completed','superseded','dead')
      ORDER BY updated_at, job_id
    `).all(...ids) as Array<Record<string, unknown>>;
    for (const row of rows) {
      addPending({
        stage: String(row.kind),
        jobId: String(row.job_id),
        targetId: row.target_id == null ? null : String(row.target_id),
        state: String(row.state),
        reason: row.last_error == null ? null : String(row.last_error).slice(0, 1_000),
      });
    }
  }
  if (
    tableExists(db, "extraction_targets") &&
    tableExists(db, "memory_jobs") &&
    columnNames(db, "memory_jobs").has("budget_id") &&
    ids.length > 0
  ) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT t.target_id, j.job_id, t.state, t.last_error
      FROM extraction_targets t JOIN memory_jobs j ON j.target_id = t.target_id
      WHERE j.budget_id IN (${placeholders})
        AND t.state NOT IN ('completed','superseded','dead')
      ORDER BY t.updated_at, t.target_id
    `).all(...ids) as Array<Record<string, unknown>>;
    for (const row of rows) {
      addPending({
        stage: "fact_extract_target",
        jobId: String(row.job_id),
        targetId: String(row.target_id),
        state: String(row.state),
        reason: row.last_error == null ? null : String(row.last_error).slice(0, 1_000),
      });
    }
  }
  if (tableExists(db, MODEL_TARGET_TABLE) && ids.length > 0) {
    const derivedFactQueue = hasDerivedFactQueue(db);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT t.stage, t.job_id, t.target_id, t.reason
      FROM model_work_targets t
      WHERE t.budget_id IN (${placeholders}) AND t.state = 'pending'
      ORDER BY t.updated_at, t.membership_id
    `).all(...ids) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const fact = derivedFactQueue
        ? db.prepare(
            "SELECT is_active, ontology_category_id, needs_consolidation FROM facts WHERE id = ?",
          ).get(String(row.target_id)) as
          | { is_active: number; ontology_category_id: string | null; needs_consolidation: number }
          | undefined
        : undefined;
      if (fact && (
        fact.is_active !== 1 ||
        (row.stage === "ontology" && fact.ontology_category_id !== null) ||
        (row.stage === "consolidation" && fact.needs_consolidation !== 1)
      )) continue;
      addPending({
        stage: String(row.stage),
        jobId: row.job_id == null ? null : String(row.job_id),
        targetId: row.target_id == null ? null : String(row.target_id),
        state: "pending",
        reason: row.reason == null ? null : String(row.reason),
      });
    }
  }
  if (hasDerivedFactQueue(db) && tableExists(db, MODEL_ATTEMPT_TABLE) && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    // Fact derived work has no memory_jobs row. It is linked to the wave by
    // the attempt ledger when a provider call was reserved.
    const targetIds = db.prepare(`
      SELECT DISTINCT target_id FROM model_work_attempts
      WHERE budget_id IN (${placeholders}) AND stage IN ('ontology','consolidation')
        AND target_id IS NOT NULL
    `).all(...ids) as Array<{ target_id: string }>;
    for (const row of targetIds) {
      const fact = db.prepare(
        "SELECT is_active, needs_consolidation, ontology_category_id FROM facts WHERE id = ?",
      ).get(row.target_id) as
        | { is_active: number; needs_consolidation: number; ontology_category_id: string | null }
        | undefined;
      if (!fact || fact.is_active !== 1) continue;
      const stage = fact.ontology_category_id == null ? "ontology" :
        fact.needs_consolidation === 1 ? "consolidation" : null;
      if (stage) {
        addPending({ stage, jobId: null, targetId: row.target_id, state: "pending", reason: null });
      }
    }
  }
  if (hasDerivedFactQueue(db)) {
    // A dirty fact without a target membership or attempt is real backlog, but
    // it has no provenance tying it to this budget. Keep it out of `pending`
    // for a filtered budget; report it separately as unassigned instead of
    // attributing unrelated work to an exhausted run.
    const targetTable = tableExists(db, MODEL_TARGET_TABLE);
    const attemptTable = tableExists(db, MODEL_ATTEMPT_TABLE);
    const targetLink = (stage: string): string => targetTable
      ? `EXISTS (
          SELECT 1 FROM model_work_targets t
          WHERE t.target_id = f.id AND t.stage = '${stage}'
        )`
      : "0";
    const attemptLink = (stages: string): string => attemptTable
      ? `EXISTS (
          SELECT 1 FROM model_work_attempts a
          WHERE a.target_id = f.id AND a.stage IN (${stages})
        )`
      : "0";
    const rows: Array<{ id: string; stage: "ontology" | "consolidation" }> = [];
    const ontologyRows = db.prepare(`
      SELECT f.id
      FROM facts f
      WHERE f.is_active = 1 AND ${ontologyPendingPredicate(db)}
        AND NOT (${targetLink("ontology")} OR ${attemptLink("'ontology'")})
      ORDER BY f.id
    `).all() as Array<{ id: string }>;
    rows.push(...ontologyRows.map((row) => ({ id: row.id, stage: "ontology" as const })));
    const consolidationRows = db.prepare(`
      SELECT f.id
      FROM facts f
      WHERE f.is_active = 1 AND f.needs_consolidation = 1
        AND NOT (${targetLink("consolidation")} OR ${attemptLink("'consolidation'")})
      ORDER BY f.id
    `).all() as Array<{ id: string }>;
    rows.push(...consolidationRows.map((row) => ({ id: row.id, stage: "consolidation" as const })));
    for (const row of rows) {
      addUnassigned({
        stage: row.stage,
        targetId: row.id,
        state: "pending",
        reason: "derived backlog has no model-work budget membership or attempt",
      });
    }
  }
  const isConfigRejected = (attempt: ModelAttemptDiagnostic): boolean =>
    attempt.outcome != null &&
    (BUDGET_FREE_OUTCOMES as readonly string[]).includes(attempt.outcome);
  const totals = {
    reserved: attempts.length,
    completed: attempts.filter((attempt) => attempt.state === "completed").length,
    // A refused envelope is `state='failed'` in the ledger but is NOT a failed
    // model call: reporting it as one is what made "the budget is burning"
    // indistinguishable from "the setting is wrong".
    failed: attempts.filter((attempt) => attempt.state === "failed" && !isConfigRejected(attempt)).length,
    unknown: attempts.filter((attempt) => attempt.state === "unknown" || attempt.state === "reserved").length,
    configRejected: attempts.filter(isConfigRejected).length,
    pending: pending.length,
    durationMs: null as number | null,
    inputChars: null as number | null,
    outputChars: null as number | null,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    cachedInputTokens: null as number | null,
    tokenUsageObserved: attempts.filter((attempt) => attempt.tokenUsageStatus === "observed").length,
    tokenUsagePartial: attempts.filter((attempt) => attempt.tokenUsageStatus === "partial").length,
    tokenUsageUnknown: attempts.filter((attempt) =>
      attempt.tokenUsageStatus === "NOT_PROVEN" || attempt.tokenUsageStatus == null,
    ).length,
    unassigned: unassigned.length,
  };
  const sumKnown = (values: Array<number | null>): number | null => {
    const known = values.filter((value): value is number => value != null);
    return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  totals.durationMs = sumKnown(attempts.map((attempt) => attempt.durationMs));
  totals.inputChars = sumKnown(attempts.map((attempt) => attempt.inputChars));
  totals.outputChars = sumKnown(attempts.map((attempt) => attempt.outputChars));
  totals.inputTokens = sumKnown(attempts.map((attempt) => attempt.inputTokens));
  totals.outputTokens = sumKnown(attempts.map((attempt) => attempt.outputTokens));
  totals.cachedInputTokens = sumKnown(attempts.map((attempt) => attempt.cachedInputTokens));

  const stages = new Map<string, ModelWorkStageDiagnostics>();
  for (const attempt of attempts) {
    let stage = stages.get(attempt.stage);
    if (!stage) {
      stage = {
        stage: attempt.stage,
        reserved: 0,
        completed: 0,
        failed: 0,
        unknown: 0,
        configRejected: 0,
        durationMs: null,
        inputChars: null,
        outputChars: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        tokenUsageObserved: 0,
        tokenUsagePartial: 0,
        tokenUsageUnknown: 0,
      };
      stages.set(attempt.stage, stage);
    }
    stage.reserved++;
    if (attempt.state === "completed") stage.completed++;
    if (attempt.state === "failed" && !isConfigRejected(attempt)) stage.failed++;
    if (isConfigRejected(attempt)) stage.configRejected++;
    if (attempt.state === "unknown" || attempt.state === "reserved") stage.unknown++;
    stage.durationMs = sumKnown(
      attempts.filter((item) => item.stage === attempt.stage).map((item) => item.durationMs),
    );
    stage.inputChars = sumKnown(
      attempts.filter((item) => item.stage === attempt.stage).map((item) => item.inputChars),
    );
    stage.outputChars = sumKnown(
      attempts.filter((item) => item.stage === attempt.stage).map((item) => item.outputChars),
    );
    stage.inputTokens = sumKnown(
      attempts.filter((item) => item.stage === attempt.stage).map((item) => item.inputTokens),
    );
    stage.outputTokens = sumKnown(
      attempts.filter((item) => item.stage === attempt.stage).map((item) => item.outputTokens),
    );
    stage.cachedInputTokens = sumKnown(
      attempts.filter((item) => item.stage === attempt.stage).map((item) => item.cachedInputTokens),
    );
    stage.tokenUsageObserved = attempts.filter(
      (item) => item.stage === attempt.stage && item.tokenUsageStatus === "observed",
    ).length;
    stage.tokenUsagePartial = attempts.filter(
      (item) => item.stage === attempt.stage && item.tokenUsageStatus === "partial",
    ).length;
    stage.tokenUsageUnknown = attempts.filter(
      (item) => item.stage === attempt.stage &&
        (item.tokenUsageStatus === "NOT_PROVEN" || item.tokenUsageStatus == null),
    ).length;
  }
  return {
    budgets, attempts, pending, unassigned, totals, stages: [...stages.values()],
    automaticMaintenance: columnNames(db, MODEL_BUDGET_TABLE).has("automatic")
      ? automaticMaintenanceWindow(db) : undefined,
  };
}

export function formatModelWorkDiagnostics(diagnostics: ModelWorkDiagnostics): string {
  const lines: string[] = [];
  if (diagnostics.automaticMaintenance) {
    const window = diagnostics.automaticMaintenance;
    lines.push(`automatic-maintenance attempts=${window.used}/${window.maxAttempts} remaining=${window.remaining} window_ms=${AUTOMATIC_MAINTENANCE_WINDOW_MS} cooldown_ms=${AUTOMATIC_MAINTENANCE_COOLDOWN_MS} window_retry_at=${window.retryAt ?? "-"}`);
  }
  for (const budget of diagnostics.budgets) {
    const remaining = Math.max(0, budget.maxAttempts - budget.reservedAttempts);
    lines.push(
      `wave=${budget.parentWaveId} budget=${budget.budgetId} state=${budget.state} attempts=${budget.reservedAttempts}/${budget.maxAttempts} remaining=${remaining} automatic=${budget.automatic}`,
    );
  }
  for (const attempt of diagnostics.attempts) {
    lines.push(
      `  stage=${attempt.stage} job=${attempt.jobId ?? "-"} target=${attempt.targetId ?? "-"} attempt=${attempt.attemptNo} state=${attempt.state} model=${attempt.model ?? "?"} effort=${attempt.reasoningEffort ?? "-"} outcome=${attempt.outcome ?? "-"} input_chars=${attempt.inputChars ?? "?"} output_chars=${attempt.outputChars ?? "?"} input_tokens=${attempt.inputTokens ?? "?"} output_tokens=${attempt.outputTokens ?? "?"} cached_input_tokens=${attempt.cachedInputTokens ?? "?"} usage=${attempt.tokenUsageStatus ?? "NOT_PROVEN"}`,
    );
  }
  for (const stage of diagnostics.stages) {
    lines.push(
      `stage-total=${stage.stage} attempts=${stage.reserved} completed=${stage.completed} failed=${stage.failed} config_rejected=${stage.configRejected} unknown=${stage.unknown} duration_ms=${stage.durationMs ?? "?"} input_chars=${stage.inputChars ?? "?"} output_chars=${stage.outputChars ?? "?"} usage=${stage.tokenUsageObserved}/${stage.tokenUsagePartial}/${stage.tokenUsageUnknown}`,
    );
  }
  for (const pending of diagnostics.pending) {
    lines.push(
      `pending stage=${pending.stage} job=${pending.jobId ?? "-"} target=${pending.targetId ?? "-"} state=${pending.state} reason=${pending.reason ?? "budget/work remains"}`,
    );
  }
  for (const item of diagnostics.unassigned) {
    lines.push(
      `unassigned stage=${item.stage} target=${item.targetId} state=${item.state} reason=${item.reason}`,
    );
  }
  lines.push(
    `totals reserved=${diagnostics.totals.reserved} completed=${diagnostics.totals.completed} failed=${diagnostics.totals.failed} config_rejected=${diagnostics.totals.configRejected} unknown=${diagnostics.totals.unknown} pending=${diagnostics.totals.pending} unassigned=${diagnostics.totals.unassigned} duration_ms=${diagnostics.totals.durationMs ?? "?"} input_chars=${diagnostics.totals.inputChars ?? "?"} output_chars=${diagnostics.totals.outputChars ?? "?"} input_tokens=${diagnostics.totals.inputTokens ?? "?"} output_tokens=${diagnostics.totals.outputTokens ?? "?"} cached_input_tokens=${diagnostics.totals.cachedInputTokens ?? "?"} usage_observed=${diagnostics.totals.tokenUsageObserved} usage_partial=${diagnostics.totals.tokenUsagePartial} usage_unknown=${diagnostics.totals.tokenUsageUnknown}`,
  );
  return lines.join("\n");
}

/** Resolve a context's DB and budget, then run one bounded model operation. */
export async function withResolvedModelWorkContext<T>(
  requested: Partial<ModelWorkContext>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const parent = modelWorkStorage.getStore();
  const environment = envContext();
  const requestedDefined = Object.fromEntries(
    Object.entries(requested).filter(([, value]) => value !== undefined),
  ) as Partial<ModelWorkContext>;
  const merged: ModelWorkContext = {
    ...environment,
    ...(parent ?? {}),
    ...requestedDefined,
  };
  let db = merged.db;
  let ownsDb = false;
  if (!db) {
    db = openBudgetDb(configuredDbPath(merged));
    ownsDb = true;
  }
  try {
    ensureModelBudgetSchema(db);
    const jobId = merged.jobId?.trim() || undefined;
    let budgetId = merged.budgetId?.trim() || undefined;
    let parentWaveId = merged.parentWaveId?.trim() || undefined;
    const stage = merged.stage?.trim() || "default";

    // Queue ownership is durable. A worker may restart with a different
    // process/wave environment, but a bound memory job must continue using
    // its stored budget before any new budget is created. Only an explicitly
    // requested budget may challenge that affinity; environment defaults are
    // intentionally ignored for an already-bound job.
    let boundJob: { budget_id: string | null; maintenance_wave_id: string | null } | undefined;
    if (jobId && tableExists(db, "memory_jobs")) {
      boundJob = db.prepare(
        "SELECT budget_id, maintenance_wave_id FROM memory_jobs WHERE job_id = ?",
      ).get(jobId) as typeof boundJob;
      if (boundJob?.budget_id) {
        const explicitBudgetIds = [requestedDefined.budgetId, parent?.budgetId]
          .filter((value): value is string => typeof value === "string" && value.trim() !== "");
        for (const explicitBudgetId of explicitBudgetIds) {
          if (explicitBudgetId !== boundJob.budget_id) {
            throw new ModelBudgetAffinityError(jobId, boundJob.budget_id, explicitBudgetId);
          }
        }
        budgetId = boundJob.budget_id;
        const boundBudget = readBudgetById(db, budgetId);
        if (!boundBudget) throw new ModelBudgetNotFoundError(budgetId);
        parentWaveId = boundBudget.parentWaveId;
      } else if (boundJob?.maintenance_wave_id) {
        // Legacy queue rows may have a wave marker but no budget id. Reuse
        // that marker to create/bind exactly one durable budget.
        parentWaveId = boundJob.maintenance_wave_id;
      }
    }

    if (budgetId) {
      if (!readBudgetById(db, budgetId)) throw new ModelBudgetNotFoundError(budgetId);
    } else {
      const budget = getOrCreateWorkerModelBudget(db, {
        stage,
        parentWaveId: parentWaveId || `standalone:${stage}`,
      });
      budgetId = budget.budgetId;
      parentWaveId = budget.parentWaveId;
    }
    if (jobId && boundJob && !boundJob.budget_id) {
      bindMemoryJobToBudget(db, {
        jobId,
        budgetId,
        parentWaveId,
      });
    }
    return await modelWorkStorage.run(
      { ...merged, db, budgetId, parentWaveId, stage, jobId },
      async () => await fn(),
    );
  } finally {
    if (ownsDb) db.close();
  }
}
