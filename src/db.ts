import Database from 'better-sqlite3';
import { ConversationExchange, type EvidenceSourceType } from './types.js';
import { createHash, randomUUID } from 'node:crypto';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath, ensureDbDir } from './paths.js';
import { EMBEDDING_VERSION } from './embeddings.js';


// === vec table dtype handling ===
// int8 quantization: q = clamp(round(x*127)). e5 embeddings are L2-normalized
// (components ≪ 1), so 127-scaling loses <1% distance precision — measured
// recall@10 is identical to float32 while storage is 4× smaller and KNN ~2×
// faster. IMPORTANT: int8 L2 distances are scaled by ×127 vs float32 —
// consumers converting distance→similarity must divide by VEC_INT8_SCALE first.

export type VecDtype = 'float32' | 'int8';
export const VEC_INT8_SCALE = 127;

/**
 * Authoritative vector dtype for vec_exchanges.
 *
 * Derived from the ACTUAL table schema in sqlite_master — not a metadata flag.
 * A flag can diverge from the real schema (missing/corrupt flag on an int8
 * table would silently send float32 params against int8 storage); parsing the
 * declared column type cannot. Absent table ⇒ 'int8' (that is what
 * initDatabase creates for fresh DBs).
 */
const VEC_TABLES = new Set(['vec_exchanges', 'vec_facts', 'vec_facts_kr', 'vec_categories']);

/** Authoritative dtype of any vec0 table — read from the ACTUAL schema in
 * sqlite_master (never a flag), so readers/writers can never disagree with a
 * Unknown/absent tables default to int8, matching the schema below. */
export function getVecTableDtype(db: Database.Database, table: string): VecDtype {
  if (!VEC_TABLES.has(table)) throw new Error(`not a vec table: ${table}`);
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table) as { sql: string } | undefined;
  if (!row?.sql) return 'int8';
  return /int8\s*\[/i.test(row.sql) ? 'int8' : 'float32';
}

export function getVecDtype(db: Database.Database): VecDtype {
  return getVecTableDtype(db, 'vec_exchanges');
}

/** Convert a float embedding to the blob matching the table dtype. */
export function embeddingToVecBlob(embedding: number[], dtype: VecDtype): Buffer {
  if (dtype === 'int8') {
    const q = new Int8Array(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      q[i] = Math.max(-127, Math.min(127, Math.round(embedding[i] * VEC_INT8_SCALE)));
    }
    return Buffer.from(q.buffer);
  }
  return Buffer.from(new Float32Array(embedding).buffer);
}

/** SQL placeholder for a vec_exchanges MATCH/INSERT param under the dtype. */
export function vecParamSql(dtype: VecDtype): string {
  return dtype === 'int8' ? 'vec_int8(?)' : '?';
}

/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×127). */
export function normalizeVecDistance(distance: number, dtype: VecDtype): number {
  return dtype === 'int8' ? distance / VEC_INT8_SCALE : distance;
}

/**
 * Convert a (float32-scale) L2 distance between UNIT vectors to cosine
 * similarity. e5 embeddings are L2-normalized, so ‖a-b‖² = 2(1 - cos) and
 * cos = 1 - d²/2. Single source of truth: every relevance gate / threshold in
 * search, fact search, repeat detection, ontology and the avatar responder
 * used to inline this identical expression (9 copies) — a metric change in one
 * place would silently make those gates disagree. Pass a NORMALIZED distance
 * (run it through normalizeVecDistance first for int8 tables).
 */
export function l2DistanceToSimilarity(distance: number): number {
  return 1 - (distance * distance) / 2;
}

export function initDatabase(): Database.Database {
  const dbPath = getDbPath();

  // Ensure directory exists
  ensureDbDir();


  const db = new Database(dbPath);

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // Cap the -wal file so it is truncated back after each checkpoint. The default
  // (-1 = unlimited) let the WAL grow WITHOUT BOUND under this workload: many
  // long-lived MCP-server readers (one per session) keep a read mark active
  // almost continuously, so SQLite's auto-checkpoint can rarely advance past the
  // oldest reader and the file only ever grew — observed live at 1.4 GB, which
  // crawled the re-embed drain from ~13 to ~3 rows/s. Applied on EVERY connection
  // (every worker + the MCP server), so no single writer can bloat the WAL no
  // matter which path is active. 64 MiB is far above normal working-set needs; it
  // only reclaims runaway file space after checkpoints.
  db.pragma('journal_size_limit = 67108864');
  // Required so the exchanges_fts AFTER DELETE trigger fires when an exchange is
  // re-indexed via `INSERT OR REPLACE` (the REPLACE-induced delete does NOT fire
  // delete triggers unless recursive_triggers is on — verified: without it a
  // re-indexed exchange leaves a stale FTS row). Keeps the external-content FTS
  // index consistent with the source table on every write path.
  db.pragma('recursive_triggers = ON');

  // Create exchanges table
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      embedding BLOB,
      last_indexed INTEGER,
      parent_uuid TEXT,
      is_sidechain BOOLEAN DEFAULT 0,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      codex_version TEXT,
      thinking_level TEXT,
      thinking_disabled BOOLEAN,
      thinking_triggers TEXT,
      embedding_version INTEGER NOT NULL DEFAULT 0,
      provenance TEXT NOT NULL DEFAULT '["human_assertion","assistant_generated"]',
      assistant_learnable BOOLEAN NOT NULL DEFAULT 0,
      has_memex_recall BOOLEAN NOT NULL DEFAULT 0
    )
  `);

  // Existing durable databases predate provenance. Additive migration only:
  // rowids, rollout archives, embeddings, and extraction watermarks stay put.
  const exchangeColumns = new Set(
    (db.prepare('PRAGMA table_info(exchanges)').all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (!exchangeColumns.has('provenance')) {
    db.exec(`ALTER TABLE exchanges ADD COLUMN provenance TEXT NOT NULL DEFAULT '["human_assertion","assistant_generated"]'`);
  }
  if (!exchangeColumns.has('assistant_learnable')) {
    db.exec('ALTER TABLE exchanges ADD COLUMN assistant_learnable BOOLEAN NOT NULL DEFAULT 0');
  }
  if (!exchangeColumns.has('has_memex_recall')) {
    db.exec('ALTER TABLE exchanges ADD COLUMN has_memex_recall BOOLEAN NOT NULL DEFAULT 0');
  }
  // Policy v1: agent-generated prose is context, never primary evidence.
  db.prepare('UPDATE exchanges SET assistant_learnable = 0 WHERE assistant_learnable <> 0').run();

  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      fact_ids TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'memex_recall'
        CHECK(source_type = 'memex_recall'),
      learnable BOOLEAN NOT NULL DEFAULT 0 CHECK(learnable = 0),
      status TEXT NOT NULL DEFAULT 'prepared'
        CHECK(status IN ('prepared','emitted')),
      created_at TEXT NOT NULL,
      emitted_at TEXT
    )
  `);
  const recallColumns = new Set(
    (db.prepare('PRAGMA table_info(recall_events)').all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (!recallColumns.has('status')) {
    db.exec("ALTER TABLE recall_events ADD COLUMN status TEXT NOT NULL DEFAULT 'prepared'");
  }
  if (!recallColumns.has('emitted_at')) {
    db.exec('ALTER TABLE recall_events ADD COLUMN emitted_at TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_recall_events_session_prompt ON recall_events(session_id, prompt_hash)');

  // Create tool_calls table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      is_error BOOLEAN DEFAULT 0,
      timestamp TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'external_unverified'
        CHECK(source_type IN ('repo_file','git_history','test_execution','external_unverified','memex_recall')),
      learnable BOOLEAN NOT NULL DEFAULT 0,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
    )
  `);
  const toolColumns = new Set(
    (db.prepare('PRAGMA table_info(tool_calls)').all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (!toolColumns.has('source_type')) {
    db.exec("ALTER TABLE tool_calls ADD COLUMN source_type TEXT NOT NULL DEFAULT 'external_unverified'");
  }
  if (!toolColumns.has('learnable')) {
    db.exec('ALTER TABLE tool_calls ADD COLUMN learnable BOOLEAN NOT NULL DEFAULT 0');
  }

  // Create vector search index.
  //
  // int8 quantized vectors use 4× less storage than float32 and make KNN
  // scans cheaper. Fresh Memex databases always use int8.
  // The authoritative dtype is the ACTUAL schema in sqlite_master (getVecDtype)
  // — float32 and int8 blobs are not interchangeable, and deriving from the
  // real schema (not a flag) makes flag/schema divergence impossible.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timestamp ON exchanges(timestamp DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_id ON exchanges(session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project ON exchanges(project)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sidechain ON exchanges(is_sidechain)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_path ON exchanges(archive_path)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_git_branch ON exchanges(git_branch)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id)
  `);

  // === Full-text search index (FTS5) for exchanges ===
  // External-content FTS5: stores only the inverted index (not a second copy of
  // the text), reading the source columns from `exchanges` via rowid. Replaces
  // the O(rows) `LIKE '%q%'` full scan (measured p50 3.2s / p95 14.5s on 239K
  // rows) with a BM25-ranked index lookup. Triggers keep it in sync on every
  // insert/update/delete (INSERT OR REPLACE fires AFTER DELETE then AFTER INSERT,
  // so re-indexed exchanges stay consistent). The one-time backfill of existing
  // rows is done by scripts/backfill-fts.mjs (`'rebuild'`), NOT here — keeping
  // initDatabase() cheap since it runs on every MCP/hook invocation.
  //
  // detail=column: token positions are not stored — search.ts only issues
  // per-token (quoted single-term) matches, never phrase/NEAR queries, and
  // BM25 ranking still works at column granularity. On the production DB the
  // default detail=full index cost 2.9GB vs ~1.3GB for detail=column.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      user_message, assistant_message,
      content='exchanges', content_rowid='rowid',
      tokenize='porter unicode61',
      detail=column
    )
  `);
  // Readiness flag (deterministic, not probed). For an external-content FTS5
  // table the index is EMPTY right after creation even though the content table
  // (exchanges) already has rows — so `SELECT rowid FROM exchanges_fts` would
  // falsely look "ready". Track readiness explicitly instead. We (re)initialize
  // the flag whenever it is MISSING — not only when the FTS table is newly
  // created — so a DB from an earlier build (FTS table present, flag absent) or
  // a crash between CREATE and the flag write is still handled correctly rather
  // than permanently falling back to LIKE. When the flag is absent we cannot
  // prove the index is populated, so be conservative: an empty exchanges set is
  // ready (triggers index every future insert); a non-empty set stays NOT ready
  // until scripts/backfill-fts.mjs rebuilds the index and sets the flag.
  db.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const hasFtsFlag = db.prepare(`SELECT 1 FROM fts_meta WHERE key='exchanges_fts_built'`).get() !== undefined;
  if (!hasFtsFlag) {
    const exchangesHaveRows = db.prepare('SELECT 1 FROM exchanges LIMIT 1').get() !== undefined;
    // INSERT OR IGNORE (not plain INSERT): initDatabase() runs in every MCP/hook
    // process, so two callers can both observe a missing flag and race to insert.
    // OR IGNORE makes the first writer win and the rest no-op instead of crashing
    // on SQLITE_CONSTRAINT_PRIMARYKEY. The value is deterministic for the DB state,
    // so a lost race is harmless.
    db.prepare(`INSERT OR IGNORE INTO fts_meta(key, value) VALUES('exchanges_fts_built', ?)`)
      .run(exchangesHaveRows ? '0' : '1');
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ai AFTER INSERT ON exchanges BEGIN
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ad AFTER DELETE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_au AFTER UPDATE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);

  // === Facts Schema ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT,
      scope_type TEXT NOT NULL DEFAULT 'project',
      scope_project TEXT,
      source_exchange_ids TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consolidated_count INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      ontology_category_id TEXT,
      fact_kr TEXT,
      embedding_version INTEGER NOT NULL DEFAULT 1,
      ontology_attempts INTEGER NOT NULL DEFAULT 0,
      consolidation_attempts INTEGER NOT NULL DEFAULT 0,
      ontology_last_attempt_at TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_project)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(is_active)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      previous_fact TEXT NOT NULL,
      new_fact TEXT NOT NULL,
      reason TEXT,
      source_exchange_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (fact_id) REFERENCES facts(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_revisions_fact ON fact_revisions(fact_id)
  `);

  // vec_facts virtual table (sqlite-vec)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);

  // Korean-text vector index: facts are embedded twice (fact / fact_kr) because
  // multilingual models match same-language pairs far better than cross-language.
  // Queries search both tables and take the best score per fact id.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts_kr USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);

  // Category embedding index: lets the ontology classifier retrieve the top-K
  // most-similar existing categories for a fact instead of dumping ALL
  // categories into the LLM prompt (measured 1,612 categories ≈ 95K tokens per
  // classify call). Embeddings (category name + description, 'passage' mode) are
  // written on createCategory; existing rows are backfilled by
  // scripts/backfill-category-embeddings.mjs.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_categories USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);

  // === Ontology Schema ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_domains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_categories (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES ontology_domains(id),
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_relations (
      id TEXT PRIMARY KEY,
      source_fact_id TEXT NOT NULL REFERENCES facts(id),
      relation_type TEXT NOT NULL CHECK(relation_type IN ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS')),
      target_fact_id TEXT NOT NULL REFERENCES facts(id),
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Exact relation triples are unique; different relation types between the
  // same pair remain valid.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_relations_triple
    ON ontology_relations(source_fact_id, relation_type, target_fact_id)
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON ontology_relations(source_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON ontology_relations(target_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_ontology ON facts(ontology_category_id)`);
  // Keyset pagination for the consolidation drain (getAllNewFactsSince): serves
  // both `WHERE is_active = 1 AND (created_at, id) > cursor` and the
  // `ORDER BY created_at, id` without a temp sort over the whole table.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_active_created_id ON facts(is_active, created_at, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ontology_categories_domain ON ontology_categories(domain_id)`);

  // Tracks which sessions have been through fact extraction (SessionEnd hook
  // or the backfill worker). Makes extraction idempotent and lets the backfill
  // find unprocessed sessions across ALL projects.
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_log (
      session_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      extracted INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0,
      dropped_batches INTEGER NOT NULL DEFAULT 0,
      claim_owner TEXT,
      last_exchange_rowid INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

export function insertExchange(
  db: Database.Database,
  exchange: ConversationExchange,
  embedding: number[],
  _toolNames?: string[]
): void {
  const now = Date.now();
  const promptHash = hashRecallPrompt(exchange.userMessage);
  const recall = exchange.sessionId
    ? db.prepare('SELECT 1 FROM recall_events WHERE session_id = ? AND prompt_hash = ?')
      .get(exchange.sessionId, promptHash) !== undefined
    : false;
  const classifiedTools = (exchange.toolCalls ?? []).map((call) => ({
    call,
    evidence: classifyToolEvidence(call.toolName, call.toolInput),
  }));
  const toolRecall = classifiedTools.some(({ evidence }) => evidence.sourceType === 'memex_recall');
  const hasRecall = recall || toolRecall;
  const provenance = exchange.provenance
    ?? [...new Set<EvidenceSourceType>([
      'human_assertion',
      'assistant_generated',
      ...classifiedTools.map(({ evidence }) => evidence.sourceType),
      ...(hasRecall ? ['memex_recall' as const] : []),
    ])];
  const assistantLearnable = exchange.assistantLearnable ?? false;
  const hasMemexRecall = exchange.hasMemexRecall ?? hasRecall;

  // One transaction keeps the exchange, vector, and tool calls atomic. Read
  // the table dtype inside that write transaction so the blob always matches
  // the actual vec schema.
  const insertAll = db.transaction(() => {
    // The embedding parameter was just generated with the current model, so
    // stamp the current version — search filters on it and the re-embed
    // worker must not redo freshly indexed rows.
    db.prepare(`
      INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed,
       parent_uuid, is_sidechain, session_id, cwd, git_branch, codex_version,
       thinking_level, thinking_disabled, thinking_triggers, embedding_version,
       provenance, assistant_learnable, has_memex_recall)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project = excluded.project,
        timestamp = excluded.timestamp,
        user_message = excluded.user_message,
        assistant_message = excluded.assistant_message,
        archive_path = excluded.archive_path,
        line_start = excluded.line_start,
        line_end = excluded.line_end,
        last_indexed = excluded.last_indexed,
        parent_uuid = excluded.parent_uuid,
        is_sidechain = excluded.is_sidechain,
        session_id = excluded.session_id,
        cwd = excluded.cwd,
        git_branch = excluded.git_branch,
        codex_version = excluded.codex_version,
        thinking_level = excluded.thinking_level,
        thinking_disabled = excluded.thinking_disabled,
        thinking_triggers = excluded.thinking_triggers,
        embedding_version = excluded.embedding_version,
        provenance = excluded.provenance,
        assistant_learnable = excluded.assistant_learnable,
        has_memex_recall = excluded.has_memex_recall
    `).run(
      exchange.id,
      exchange.project,
      exchange.timestamp,
      exchange.userMessage,
      exchange.assistantMessage,
      exchange.archivePath,
      exchange.lineStart,
      exchange.lineEnd,
      now,
      exchange.parentUuid || null,
      exchange.isSidechain ? 1 : 0,
      exchange.sessionId || null,
      exchange.cwd || null,
      exchange.gitBranch || null,
      exchange.codexVersion || null,
      exchange.thinkingLevel || null,
      exchange.thinkingDisabled ? 1 : 0,
      exchange.thinkingTriggers || null,
      EMBEDDING_VERSION,
      JSON.stringify(provenance),
      assistantLearnable ? 1 : 0,
      hasMemexRecall ? 1 : 0,
    );

    // Vector upsert: DELETE+INSERT since virtual tables don't support REPLACE.
    const vecDtype = getVecDtype(db);
    db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(exchange.id);
    db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(vecDtype)})`)
      .run(exchange.id, embeddingToVecBlob(embedding, vecDtype));

    if (exchange.toolCalls && exchange.toolCalls.length > 0) {
      const toolStmt = db.prepare(`
        INSERT OR REPLACE INTO tool_calls
        (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const toolCall of exchange.toolCalls) {
        const evidence = classifyToolEvidence(toolCall.toolName, toolCall.toolInput);
        toolStmt.run(
          toolCall.id,
          toolCall.exchangeId,
          toolCall.toolName,
          toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null,
          toolCall.toolResult || null,
          toolCall.isError ? 1 : 0,
          toolCall.timestamp,
          toolCall.sourceType ?? evidence.sourceType,
          (toolCall.learnable ?? evidence.learnable) && !toolCall.isError && !!toolCall.toolResult ? 1 : 0,
        );
      }
    }
  });
  // .immediate(): acquire the write lock at BEGIN, before any schema read.
  insertAll.immediate();
}

const MEMEX_RECALL_TOOLS = new Set([
  'search', 'read', 'search_facts', 'search_ontology', 'ask_avatar',
  'trace_fact', 'graph_stats', 'cross_project_insights', 'explore_graph',
]);

export function isMemexRecallToolName(toolName: string): boolean {
  const match = /^mcp__memex__(.+)$/.exec(toolName);
  return !!match && MEMEX_RECALL_TOOLS.has(match[1]);
}

const REPO_READ_TOOLS = new Set(['read', 'read_file', 'grep', 'view_image']);

function commandText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const cmd = (input as { cmd?: unknown }).cmd;
  return Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
}

export function classifyToolEvidence(toolName: string, toolInput?: unknown): {
  sourceType: EvidenceSourceType;
  learnable: boolean;
} {
  if (isMemexRecallToolName(toolName)) return { sourceType: 'memex_recall', learnable: false };
  const leaf = toolName.split('__').at(-1) ?? toolName;
  if (REPO_READ_TOOLS.has(leaf)) return { sourceType: 'repo_file', learnable: true };
  if (leaf !== 'shell' && leaf !== 'exec_command') {
    return { sourceType: 'external_unverified', learnable: false };
  }

  const command = commandText(toolInput).trim();
  if (!command || /(^|\s)(curl|wget|ssh|scp|sftp)\b|https?:\/\/|\bgh\s+api\b/i.test(command)) {
    return { sourceType: 'external_unverified', learnable: false };
  }
  if (/^git\s+(status|log|show|diff|rev-parse|branch)(\s|$)/.test(command)) {
    return { sourceType: 'git_history', learnable: true };
  }
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test(\s|$)|^node\s+--test(\s|$)|^(npx\s+)?vitest(\s|$)|^(pytest|cargo\s+test|go\s+test)(\s|$)/.test(command)) {
    return { sourceType: 'test_execution', learnable: true };
  }
  if (/^(rg|grep|find|ls|stat|jq)(\s|$)/.test(command)) {
    return { sourceType: 'repo_file', learnable: true };
  }
  return { sourceType: 'external_unverified', learnable: false };
}

export function hashRecallPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export function recordRecallEvent(
  db: Database.Database,
  event: { sessionId: string; project: string; prompt: string; factIds: string[] },
): string | null {
  if (!event.sessionId || event.factIds.length === 0) return null;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO recall_events
      (id, session_id, project, prompt_hash, fact_ids, source_type, learnable, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'memex_recall', 0, 'prepared', ?)
  `).run(
    id,
    event.sessionId,
    event.project,
    hashRecallPrompt(event.prompt),
    JSON.stringify([...new Set(event.factIds)]),
    new Date().toISOString(),
  );
  return id;
}

export function markRecallEventEmitted(
  db: Database.Database,
  event: { sessionId: string; prompt: string },
): boolean {
  const row = db.prepare(`
    SELECT id FROM recall_events
    WHERE session_id = ? AND prompt_hash = ? AND status = 'prepared'
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(event.sessionId, hashRecallPrompt(event.prompt)) as { id: string } | undefined;
  if (!row) return false;
  return db.prepare(`UPDATE recall_events SET status = 'emitted', emitted_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), row.id).changes === 1;
}

export function getAllExchanges(db: Database.Database): Array<{ id: string; archivePath: string }> {
  const stmt = db.prepare(`SELECT id, archive_path as archivePath FROM exchanges`);
  return stmt.all() as Array<{ id: string; archivePath: string }>;
}

export function getFileLastIndexed(db: Database.Database, archivePath: string): number | null {
  const stmt = db.prepare(`
    SELECT MAX(last_indexed) as lastIndexed
    FROM exchanges
    WHERE archive_path = ?
  `);
  const row = stmt.get(archivePath) as { lastIndexed: number | null };
  return row.lastIndexed;
}

export function deleteExchange(db: Database.Database, id: string): void {
  // Delete from vector table
  db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`).run(id);

  // Delete from main table
  db.prepare(`DELETE FROM exchanges WHERE id = ?`).run(id);
}
