import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "path";
import * as sqliteVec from "sqlite-vec";
import { getMemexHome, getDbPath, ensureDbDir, LLM_WORKDIR_BASENAME, } from "./paths.js";
import { sessionsRoot } from "./codex-rollout.js";
import os from "node:os";
import { EMBEDDING_VERSION } from "./embeddings.js";
import { ensureContinuitySchema, exchangeContentHash, } from "./continuity-store.js";
import { resolveProjectWorkspace } from "./continuity-identity.js";
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
const VEC_TABLES = new Set([
    "vec_exchanges",
    "vec_facts",
    "vec_facts_kr",
    "vec_categories",
]);
/** Authoritative dtype of any vec0 table — read from the ACTUAL schema in
 * sqlite_master (never a flag), so readers/writers can never disagree with a
 * Unknown/absent tables default to int8, matching the schema below. */
export function getVecTableDtype(db, table) {
    if (!VEC_TABLES.has(table))
        throw new Error(`not a vec table: ${table}`);
    const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table);
    if (!row?.sql)
        return "int8";
    return /int8\s*\[/i.test(row.sql) ? "int8" : "float32";
}
export function getVecDtype(db) {
    return getVecTableDtype(db, "vec_exchanges");
}
/** Convert a float embedding to the blob matching the table dtype. */
export function embeddingToVecBlob(embedding, dtype) {
    if (dtype === "int8") {
        const q = new Int8Array(embedding.length);
        for (let i = 0; i < embedding.length; i++) {
            q[i] = Math.max(-127, Math.min(127, Math.round(embedding[i] * VEC_INT8_SCALE)));
        }
        return Buffer.from(q.buffer);
    }
    return Buffer.from(new Float32Array(embedding).buffer);
}
/** SQL placeholder for a vec_exchanges MATCH/INSERT param under the dtype. */
export function vecParamSql(dtype) {
    return dtype === "int8" ? "vec_int8(?)" : "?";
}
/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×127). */
export function normalizeVecDistance(distance, dtype) {
    return dtype === "int8" ? distance / VEC_INT8_SCALE : distance;
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
export function l2DistanceToSimilarity(distance) {
    return 1 - (distance * distance) / 2;
}
/**
 * Install every connection-local runtime invariant. sqlite-vec registration
 * belongs to a connection, not the database file, so production callers must
 * use the factories below before touching vec0 tables.
 */
function initializeConnection(db, mode) {
    try {
        sqliteVec.load(db);
        db.pragma("busy_timeout = 5000");
        // FK enforcement happens to be better-sqlite3's connection default, but
        // that is a driver default, not our invariant. Declare it explicitly so
        // the schema's REFERENCES clauses stay enforced regardless of driver
        // changes. Every delete/rename path is ordered for it (tool_calls → vec →
        // parent row; relations/revisions → facts); parent/child moves run inside
        // PRAGMA defer_foreign_keys transactions.
        db.pragma("foreign_keys = ON");
        if (mode === "write") {
            db.pragma("journal_mode = WAL");
            // Cap the -wal file so it is truncated back after each checkpoint. The
            // default (-1 = unlimited) allowed unbounded growth while long-lived MCP
            // readers delayed checkpoints. Apply it to every writer connection.
            db.pragma("journal_size_limit = 67108864");
            // REPLACE-induced deletes only fire the exchanges_fts cleanup trigger
            // when recursive triggers are enabled on the writing connection.
            db.pragma("recursive_triggers = ON");
        }
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
/** Open an existing database read-only with sqlite-vec registered. */
export function openReadDb(dbPath = getDbPath()) {
    return initializeConnection(new Database(dbPath, { readonly: true, fileMustExist: true }), "read");
}
/** Open a writable database with sqlite-vec and writer pragmas registered. */
export function openWriteDb(dbPath = getDbPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return initializeConnection(new Database(dbPath), "write");
}
export function initDatabase(options = {}) {
    const dbPath = options.dbPath ?? getDbPath();
    // Ensure directory exists
    if (options.dbPath)
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    else
        ensureDbDir();
    const db = openWriteDb(dbPath);
    if (options.busyTimeoutMs !== undefined) {
        db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs))}`);
    }
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
    const exchangeColumns = new Set(db.prepare("PRAGMA table_info(exchanges)").all().map((r) => r.name));
    if (!exchangeColumns.has("provenance")) {
        db.exec(`ALTER TABLE exchanges ADD COLUMN provenance TEXT NOT NULL DEFAULT '["human_assertion","assistant_generated"]'`);
    }
    if (!exchangeColumns.has("assistant_learnable")) {
        db.exec("ALTER TABLE exchanges ADD COLUMN assistant_learnable BOOLEAN NOT NULL DEFAULT 0");
    }
    if (!exchangeColumns.has("has_memex_recall")) {
        db.exec("ALTER TABLE exchanges ADD COLUMN has_memex_recall BOOLEAN NOT NULL DEFAULT 0");
    }
    // Policy v1: agent-generated prose is context, never primary evidence.
    db.prepare("UPDATE exchanges SET assistant_learnable = 0 WHERE assistant_learnable <> 0").run();
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
    const recallColumns = new Set(db.prepare("PRAGMA table_info(recall_events)").all().map((r) => r.name));
    if (!recallColumns.has("status")) {
        db.exec("ALTER TABLE recall_events ADD COLUMN status TEXT NOT NULL DEFAULT 'prepared'");
    }
    if (!recallColumns.has("emitted_at")) {
        db.exec("ALTER TABLE recall_events ADD COLUMN emitted_at TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_recall_events_session_prompt ON recall_events(session_id, prompt_hash)");
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
    const toolColumns = new Set(db.prepare("PRAGMA table_info(tool_calls)").all().map((r) => r.name));
    if (!toolColumns.has("source_type")) {
        db.exec("ALTER TABLE tool_calls ADD COLUMN source_type TEXT NOT NULL DEFAULT 'external_unverified'");
    }
    if (!toolColumns.has("learnable")) {
        db.exec("ALTER TABLE tool_calls ADD COLUMN learnable BOOLEAN NOT NULL DEFAULT 0");
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
    const hasFtsFlag = db
        .prepare(`SELECT 1 FROM fts_meta WHERE key='exchanges_fts_built'`)
        .get() !== undefined;
    if (!hasFtsFlag) {
        const exchangesHaveRows = db.prepare("SELECT 1 FROM exchanges LIMIT 1").get() !== undefined;
        // INSERT OR IGNORE (not plain INSERT): initDatabase() runs in every MCP/hook
        // process, so two callers can both observe a missing flag and race to insert.
        // OR IGNORE makes the first writer win and the rest no-op instead of crashing
        // on SQLITE_CONSTRAINT_PRIMARYKEY. The value is deterministic for the DB state,
        // so a lost race is harmless.
        db.prepare(`INSERT OR IGNORE INTO fts_meta(key, value) VALUES('exchanges_fts_built', ?)`).run(exchangesHaveRows ? "0" : "1");
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
    // Identity/provenance-only updates must not touch the external-content FTS
    // index. Recreate the legacy broad trigger as a content-column trigger before
    // Continuity's Phase 3 backfill updates project/workspace IDs.
    //
    // initDatabase() runs in every hook/MCP process, so several processes can
    // reach this point at once. An unconditional DROP + plain CREATE lets a second
    // process observe the trigger the first one just created and fail with
    // "trigger exchanges_fts_au already exists", which crashes a capture hook.
    // Decide and apply inside one immediate transaction so processes serialize
    // on the write lock and only a legacy-shaped trigger is ever replaced.
    db.transaction(() => {
        const auTrigger = db
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'exchanges_fts_au'")
            .get();
        if (auTrigger?.sql && !/AFTER UPDATE OF user_message, assistant_message ON exchanges/i.test(auTrigger.sql)) {
            db.exec(`DROP TRIGGER IF EXISTS exchanges_fts_au`);
        }
        db.exec(`
      CREATE TRIGGER IF NOT EXISTS exchanges_fts_au AFTER UPDATE OF user_message, assistant_message ON exchanges BEGIN
        INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
        VALUES('delete', old.rowid, old.user_message, old.assistant_message);
        INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
        VALUES (new.rowid, new.user_message, new.assistant_message);
      END
    `);
    }).immediate();
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
      needs_consolidation INTEGER NOT NULL DEFAULT 1,
      ontology_last_attempt_at TEXT,
      semantic_generation INTEGER NOT NULL DEFAULT 1,
      semantic_updated_at TEXT NOT NULL DEFAULT '',
      lifecycle_generation INTEGER NOT NULL DEFAULT 1,
      lifecycle_updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
    // Consolidation processing order is local ingestion/mutation order, never the
    // fact's historical created_at. Existing active rows must be examined once
    // after this additive migration; inactive rows re-enter only when restored.
    const factColumns = new Set(db.prepare("PRAGMA table_info(facts)").all().map((r) => r.name));
    if (!factColumns.has("needs_consolidation")) {
        db.exec("ALTER TABLE facts ADD COLUMN needs_consolidation INTEGER NOT NULL DEFAULT 1");
        db.prepare("UPDATE facts SET needs_consolidation = 0 WHERE is_active = 0").run();
    }
    // 재감사 P1-2: 의미 세대 토큰. 모든 의미 변경(mutateFactMeaning, sync fact
    // import)이 generation을 올리고 semantic_updated_at을 갱신하며, 비동기 파생
    // writer(ontology/reembed/KR vector/relation/consolidation/sync import)는
    // 시작 시 캡처한 generation으로 최종 쓰기를 CAS한다 — 0행이면 stale 결과 폐기.
    // legacy 행은 generation 1에서 시작하고 semantic_updated_at은 updated_at로
    // 채운다(한 번만 채워지고 이후 writer가 항상 설정한다).
    if (!factColumns.has("semantic_generation")) {
        db.exec("ALTER TABLE facts ADD COLUMN semantic_generation INTEGER NOT NULL DEFAULT 1");
    }
    if (!factColumns.has("semantic_updated_at")) {
        db.exec("ALTER TABLE facts ADD COLUMN semantic_updated_at TEXT NOT NULL DEFAULT ''");
    }
    db.prepare("UPDATE facts SET semantic_updated_at = updated_at WHERE semantic_updated_at = ''").run();
    // 재감사 P1-3(protocol v4): 활성 시계. is_active는 의미 state와 독립인
    // lifecycle state다 — deactivate/restore/sync lifecycle import가 generation을
    // 올리고 lifecycle_updated_at을 기록하며, embedding await가 있는 async
    // writer(restore, sync activate)는 semantic + lifecycle token 둘 다 CAS한다.
    // 의미 편집은 이 시계를 건드리지 않고, lifecycle 전환도 의미 시계를
    // 건드리지 않는다 — "새 의미 + 더 최근 deactivate"가 어느 축도 롤백하지
    // 않고 수렴한다. legacy 행은 generation 1에서 updated_at로 시작한다.
    if (!factColumns.has("lifecycle_generation")) {
        db.exec("ALTER TABLE facts ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 1");
    }
    if (!factColumns.has("lifecycle_updated_at")) {
        db.exec("ALTER TABLE facts ADD COLUMN lifecycle_updated_at TEXT NOT NULL DEFAULT ''");
    }
    db.prepare("UPDATE facts SET lifecycle_updated_at = updated_at WHERE lifecycle_updated_at = ''").run();
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_project)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(is_active)
  `);
    // Local persistent interpretive lineage. These rows explain which
    // conversation context helped resolve a fact, but they are never
    // authoritative evidence and never enter protocol v4 sync payloads.
    db.exec(`
    CREATE TABLE IF NOT EXISTS fact_context_dependencies (
      fact_id TEXT NOT NULL,
      exchange_id TEXT NOT NULL,
      dependency_kind TEXT NOT NULL CHECK (
        dependency_kind IN (
          'assistant_context',
          'recall_influenced_assistant',
          'watermark_prefix',
          'conversation_context',
          'ratified_proposition',
          'referent_definition',
          'style_reference',
          'workflow_reference',
          'recall_reference'
        )
      ),
      created_at TEXT NOT NULL,
      PRIMARY KEY (fact_id, exchange_id, dependency_kind),
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);
    const contextDependencySchema = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fact_context_dependencies'")
        .get();
    if (!contextDependencySchema?.sql?.includes("'ratified_proposition'")) {
        db.transaction(() => {
            db.exec(`
        CREATE TABLE fact_context_dependencies_p2 (
          fact_id TEXT NOT NULL,
          exchange_id TEXT NOT NULL,
          dependency_kind TEXT NOT NULL CHECK (
            dependency_kind IN (
              'assistant_context',
              'recall_influenced_assistant',
              'watermark_prefix',
              'conversation_context',
              'ratified_proposition',
              'referent_definition',
              'style_reference',
              'workflow_reference',
              'recall_reference'
            )
          ),
          created_at TEXT NOT NULL,
          PRIMARY KEY (fact_id, exchange_id, dependency_kind),
          FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE,
          FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
            ON UPDATE CASCADE ON DELETE CASCADE
        );
        INSERT INTO fact_context_dependencies_p2
          (fact_id, exchange_id, dependency_kind, created_at)
        SELECT fact_id, exchange_id, dependency_kind, created_at
        FROM fact_context_dependencies;
        DROP TABLE fact_context_dependencies;
        ALTER TABLE fact_context_dependencies_p2
          RENAME TO fact_context_dependencies;
      `);
        })();
    }
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fact_context_exchange
    ON fact_context_dependencies(exchange_id)
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT REFERENCES facts(id),
      previous_fact TEXT,
      new_fact TEXT,
      reason TEXT,
      source_exchange_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_revisions_fact ON fact_revisions(fact_id)
  `);
    // Durable hard-delete events. Facts are otherwise absent after deletion, so
    // cross-device reconciliation needs a separately syncable tombstone to keep
    // an older device from resurrecting a deleted row.
    db.exec(`
    CREATE TABLE IF NOT EXISTS fact_tombstones (
      fact_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT
    )
  `);
    // Local writer identity for multi-device sync snapshots. The DB is local,
    // so each device gets a disjoint snapshot directory and never overwrites a
    // peer's state. Losing the DB creates a new identity; old snapshots remain
    // valid inputs until normal retention is introduced explicitly.
    db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
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
    // 재감사 Privacy-P1(v4): taxonomy 전면 invalidate(privacy purge)마다 1씩
    // 올라가는 전역 epoch다. 분류기는 LLM 대기 전에 이 값을 캡처하고 커밋 시점에
    // 재판정한다 — purge가 taxonomy를 지운 뒤 도착하는 stale LLM 결과가
    // private-derived taxonomy를 다시 만들지 못하게 하는 CAS 토큰이다.
    db.exec(`
    CREATE TABLE IF NOT EXISTS taxonomy_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch INTEGER NOT NULL DEFAULT 1
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_categories (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES ontology_domains(id),
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding_version INTEGER NOT NULL DEFAULT 0
    )
  `);
    const ontologyCategoryColumns = new Set(db.prepare("PRAGMA table_info(ontology_categories)").all().map((row) => row.name));
    if (!ontologyCategoryColumns.has("embedding_version")) {
        db.exec("ALTER TABLE ontology_categories ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 0");
    }
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
    // Relation scope is a final database write invariant, not a caller policy.
    // Different project facts may never have a direct edge; global↔project and
    // same-project edges remain valid. Guard both new rows and endpoint rewrites
    // so sync/import or future low-level writers cannot bypass createRelation().
    const crossProjectRelationPredicate = `
    EXISTS (
      SELECT 1
      FROM facts AS source
      JOIN facts AS target
        ON source.id = NEW.source_fact_id
       AND target.id = NEW.target_fact_id
      WHERE source.scope_type = 'project'
        AND target.scope_type = 'project'
        AND source.scope_project IS NOT target.scope_project
    )
  `;
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ontology_relations_scope_insert_guard
    BEFORE INSERT ON ontology_relations
    WHEN ${crossProjectRelationPredicate}
    BEGIN
      SELECT RAISE(ABORT, 'cross-project ontology relation is not allowed');
    END
  `);
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ontology_relations_scope_update_guard
    BEFORE UPDATE OF source_fact_id, target_fact_id ON ontology_relations
    WHEN ${crossProjectRelationPredicate}
    BEGIN
      SELECT RAISE(ABORT, 'cross-project ontology relation is not allowed');
    END
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
    // Durable local dirty queue for consolidation. updated_at is only a stable
    // queue ordering key; membership comes exclusively from needs_consolidation.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_consolidation_queue
     ON facts(is_active, needs_consolidation, updated_at, id)`);
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
    ensureContinuitySchema(db);
    return db;
}
export function insertExchange(db, exchange, embedding, _toolNames) {
    const now = Date.now();
    const promptHash = hashRecallPrompt(exchange.userMessage);
    const recall = exchange.sessionId
        ? db
            .prepare(`SELECT 1 FROM recall_events
           WHERE session_id = ? AND prompt_hash = ? AND status = 'emitted'`)
            .get(exchange.sessionId, promptHash) !== undefined
        : false;
    const classifiedTools = (exchange.toolCalls ?? []).map((call) => ({
        call,
        evidence: classifyToolEvidence(call.toolName, call.toolInput, {
            cwd: exchange.cwd,
        }),
    }));
    const toolRecall = classifiedTools.some(({ evidence }) => evidence.sourceType === "memex_recall");
    const hasRecall = recall || toolRecall;
    const provenance = exchange.provenance ?? [
        ...new Set([
            "human_assertion",
            "assistant_generated",
            ...classifiedTools.map(({ evidence }) => evidence.sourceType),
            ...(hasRecall ? ["memex_recall"] : []),
        ]),
    ];
    const assistantLearnable = exchange.assistantLearnable ?? false;
    const hasMemexRecall = exchange.hasMemexRecall ?? hasRecall;
    // One transaction keeps the exchange, vector, and tool calls atomic. Read
    // the table dtype inside that write transaction so the blob always matches
    // the actual vec schema.
    const insertAll = db.transaction(() => {
        const identityPath = exchange.cwd || exchange.project;
        const identity = identityPath && identityPath !== "unknown"
            ? resolveProjectWorkspace(db, {
                cwd: identityPath,
                projectId: exchange.projectId ?? null,
                branch: exchange.gitBranch ?? null,
            })
            : null;
        if (exchange.workspaceId && identity && exchange.workspaceId !== identity.workspaceId) {
            throw new Error("exchange workspace_id does not match resolved workspace");
        }
        const sessionScope = exchange.sessionId
            ? db.prepare(`
          SELECT project_id, workspace_id, workstream_id
          FROM session_memory_state WHERE session_id = ?
        `).get(exchange.sessionId)
            : undefined;
        if (sessionScope?.project_id && identity && sessionScope.project_id !== identity.projectId) {
            throw new Error("exchange session belongs to a different logical project");
        }
        const projectId = identity?.projectId ?? exchange.projectId ?? null;
        const workspaceId = identity?.workspaceId ?? exchange.workspaceId ?? null;
        const workstreamId = exchange.workstreamId ?? sessionScope?.workstream_id ?? null;
        const existing = db.prepare(`
      SELECT line_end, exchange_seq, content_hash, content_generation, closure_state,
             project_id, workspace_id, workstream_id
      FROM exchanges WHERE id = ?
    `).get(exchange.id);
        const contentHash = exchange.contentHash ?? exchangeContentHash(exchange);
        const explicitGeneration = exchange.contentGeneration;
        if (existing) {
            if (exchange.lineEnd < existing.line_end)
                return false;
            if (explicitGeneration !== undefined &&
                explicitGeneration < existing.content_generation)
                return false;
            if (explicitGeneration !== undefined &&
                explicitGeneration === existing.content_generation &&
                existing.content_hash &&
                contentHash !== existing.content_hash)
                return false;
        }
        const contentGeneration = explicitGeneration ?? (existing &&
            (contentHash !== existing.content_hash || exchange.lineEnd > existing.line_end)
            ? existing.content_generation + 1
            : Math.max(1, existing?.content_generation ?? 1));
        const closureRank = {
            open: 0,
            interrupted: 1,
            closed: 2,
            final: 3,
        };
        const closureState = exchange.closureState ?? "closed";
        if (existing &&
            contentGeneration === existing.content_generation &&
            closureRank[closureState] < closureRank[existing.closure_state])
            return false;
        const exchangeSeq = exchange.exchangeSeq ?? existing?.exchange_seq ?? (db.prepare("SELECT COALESCE(MAX(exchange_seq), 0) + 1 AS n FROM exchanges WHERE session_id IS ?").get(exchange.sessionId ?? null).n);
        // The embedding parameter was just generated with the current model, so
        // stamp the current version — search filters on it and the re-embed
        // worker must not redo freshly indexed rows.
        db.prepare(`
      INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed,
       parent_uuid, is_sidechain, session_id, cwd, git_branch, codex_version,
       thinking_level, thinking_disabled, thinking_triggers, embedding_version,
       provenance, assistant_learnable, has_memex_recall, exchange_seq,
       content_hash, content_generation, closure_state, parser_version,
       project_id, workspace_id, workstream_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        has_memex_recall = excluded.has_memex_recall,
        exchange_seq = excluded.exchange_seq,
        content_hash = excluded.content_hash,
        content_generation = excluded.content_generation,
        closure_state = excluded.closure_state,
        parser_version = excluded.parser_version,
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        workstream_id = excluded.workstream_id
    `).run(exchange.id, exchange.project, exchange.timestamp, exchange.userMessage, exchange.assistantMessage, exchange.archivePath, exchange.lineStart, exchange.lineEnd, now, exchange.parentUuid || null, exchange.isSidechain ? 1 : 0, exchange.sessionId || null, exchange.cwd || null, exchange.gitBranch || null, exchange.codexVersion || null, exchange.thinkingLevel || null, exchange.thinkingDisabled ? 1 : 0, exchange.thinkingTriggers || null, EMBEDDING_VERSION, JSON.stringify(provenance), assistantLearnable ? 1 : 0, hasMemexRecall ? 1 : 0, exchangeSeq, contentHash, contentGeneration, closureState, exchange.parserVersion ?? 1, projectId, workspaceId, workstreamId);
        // Vector upsert: DELETE+INSERT since virtual tables don't support REPLACE.
        const vecDtype = getVecDtype(db);
        db.prepare("DELETE FROM vec_exchanges WHERE id = ?").run(exchange.id);
        db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(vecDtype)})`).run(exchange.id, embeddingToVecBlob(embedding, vecDtype));
        // 재감사 P1-6: tool_calls 는 이 교환의 desired set 이다 — 재색인 시 새 set 을
        // 넣기 전에 기존 set 을 지운다(INSERT OR REPLACE 만으로는 parse 사이에 사라진
        // call 이 고아 증거로 남는다). tool_calls 행은 삽입 후 갱신되지 않으므로
        // delete+insert 가 안전하다.
        db.prepare("DELETE FROM tool_calls WHERE exchange_id = ?").run(exchange.id);
        if (exchange.toolCalls && exchange.toolCalls.length > 0) {
            const toolStmt = db.prepare(`
        INSERT INTO tool_calls
        (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp, source_type, learnable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const toolCall of exchange.toolCalls) {
                const evidence = classifyToolEvidence(toolCall.toolName, toolCall.toolInput, { cwd: exchange.cwd });
                toolStmt.run(toolCall.id, toolCall.exchangeId, toolCall.toolName, toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null, toolCall.toolResult || null, toolCall.isError ? 1 : 0, toolCall.timestamp, toolCall.sourceType ?? evidence.sourceType, (toolCall.learnable ?? evidence.learnable) &&
                    !toolCall.isError &&
                    toolCall.toolResult
                    ? 1
                    : 0);
            }
        }
        return true;
    });
    // .immediate(): acquire the write lock at BEGIN, before any schema read.
    return insertAll.immediate();
}
const MEMEX_RECALL_TOOLS = new Set([
    "search",
    "read",
    "search_facts",
    "search_ontology",
    "ask_avatar",
    "trace_fact",
    "graph_stats",
    "cross_project_insights",
    "explore_graph",
]);
export function isMemexRecallToolName(toolName) {
    const match = /^mcp__memex__(.+)$/.exec(toolName);
    return !!match && MEMEX_RECALL_TOOLS.has(match[1]);
}
const REPO_READ_TOOLS = new Set(["read", "read_file", "grep", "view_image"]);
/** Absolute roots whose contents must never become learnable evidence:
 * Memex's own derived data (facts, archives, summaries), Codex rollout
 * transcripts, and ephemeral Memex model workdirs. Reading a
 * summary/rollout back with a local file tool would otherwise launder
 * assistant synthesis or memex_recall into `repo_file/learnable=1`. */
function deniedEvidenceRoots() {
    const roots = [];
    const push = (p) => {
        if (!p)
            return;
        const canonical = canonicalizePath(p);
        if (canonical)
            roots.push(canonical);
    };
    try {
        // MEMEX_HOME root covers archive/, index/, and the SQLite DB in one hop.
        push(getMemexHome());
        push(sessionsRoot());
        // Scoped temp denial: only Memex model workdirs, not the whole temp tree,
        // so projects that legitimately live under a system temp dir keep working.
        push(path.join(os.tmpdir(), LLM_WORKDIR_BASENAME));
    }
    catch {
        /* resolver unavailable — denylist stays partial */
    }
    return [...new Set(roots)].filter((r) => r && r !== "/");
}
/** Ephemeral model workdirs are mkdtemp'd as `<tmpdir>/memex-llm-XXXXXX` — a
 * SIBLING of the plain `memex-llm` denied root, so root containment alone
 * cannot see them. Deny the whole basename family scoped to the temp dir
 * (the same basename-vs-mkdtemp bug class that once leaked worker prompts
 * into the index) without touching projects that merely live under the temp
 * tree. */
function isLlmWorkdirEvidencePath(canonical) {
    if (!canonical)
        return false;
    const tmp = canonicalizePath(os.tmpdir());
    if (!tmp || canonical === tmp || !canonical.startsWith(tmp + path.sep)) {
        return false;
    }
    const segment = canonical
        .slice(tmp.length + path.sep.length)
        .split(path.sep)[0];
    return (segment === LLM_WORKDIR_BASENAME ||
        segment.startsWith(`${LLM_WORKDIR_BASENAME}-`));
}
/** Resolve symlinks through the longest existing ancestor. This also gives a
 * stable canonical path for commands that name a not-yet-created file. */
function canonicalizePath(value) {
    try {
        const resolved = path.resolve(value);
        const suffix = [];
        let cursor = resolved;
        while (!fs.existsSync(cursor)) {
            const parent = path.dirname(cursor);
            if (parent === cursor)
                return null;
            suffix.unshift(path.basename(cursor));
            cursor = parent;
        }
        return path.resolve(fs.realpathSync.native(cursor), ...suffix);
    }
    catch {
        return null;
    }
}
function isInside(child, ancestor) {
    const c = canonicalizePath(child);
    const a = canonicalizePath(ancestor);
    return !!c && !!a && (c === a || c.startsWith(a + path.sep));
}
/** Extract candidate target paths from common repo-read tool input shapes. */
function readTargetPaths(input) {
    if (!input || typeof input !== "object")
        return [];
    const out = [];
    for (const key of [
        "path",
        "file",
        "filepath",
        "file_path",
        "paths",
        "files",
    ]) {
        const value = input[key];
        if (typeof value === "string" && value.trim())
            out.push(value.trim());
        else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === "string" && item.trim())
                    out.push(item.trim());
            }
        }
    }
    return out;
}
/** Path-aware verdict for a repo-local observation. Missing project identity,
 * missing target, or any target outside the canonical cwd fails closed. */
function repoReadVerdict(toolInput, ctx) {
    const demote = () => ({
        sourceType: "external_unverified",
        learnable: false,
    });
    if (!ctx?.cwd)
        return demote();
    const denied = deniedEvidenceRoots();
    const base = canonicalizePath(ctx.cwd);
    const targets = base
        ? readTargetPaths(toolInput).map((target) => canonicalizePath(path.resolve(base, target)))
        : [];
    // Step 1 — locality proof: with a project context, every observation must
    // land inside the canonical project working directory to count as a
    // repository-local observation at all.
    const projectRoot = canonicalizePath(ctx.cwd);
    const locallyProven = !!projectRoot &&
        targets.length > 0 &&
        targets.every((target) => !!target && isInside(target, projectRoot));
    if (!locallyProven)
        return demote();
    // Step 2 — denied data surfaces: even inside the project, readings from
    // Memex-owned data roots stay non-learnable (label kept, learning flipped).
    for (const target of targets) {
        if (!target)
            return demote();
        if (isLlmWorkdirEvidencePath(target)) {
            return { sourceType: "repo_file", learnable: false };
        }
        for (const root of denied) {
            if (isInside(target, root)) {
                return { sourceType: "repo_file", learnable: false };
            }
        }
    }
    return { sourceType: "repo_file", learnable: true };
}
/**
 * 복합 셸 명령 판정 (FACT-LIFECYCLE.md:49-50).
 *
 * `git log && cat config` 처럼 신뢰 구간(git/test) 뒤에 임의 명령이 붙으면, 출력 전체가
 * 신뢰 증거로 승격되어 비-증거 내용이 학습된다. 메타문자(`&&`, `||`, `;`, `|`, `&`,
 * 개행, 커맨드 치환, 리다이렉트)가 **unquoted** 위치에 하나라도 있으면 복합으로 본다.
 * quote 상태를 추적해 `echo "a && b"` 같은 문자열 인자 내부는 단일 명령으로 취급한다.
 * 판정은 보수적이되 fail-closed 방향(모호 → 복합 → external_unverified)으로 간다.
 */
function isCompositeShellCommand(command) {
    let quote = null;
    let escaped = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === "\\" && quote === '"') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (ch === quote)
                quote = null;
            else if (quote === '"' && (ch === "$" || ch === "`"))
                return true;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            continue;
        }
        // 커맨드 치환 (backtick 또는 $( )
        if (ch === "`" || ch === "$")
            return true;
        if (ch === "{" || ch === "}")
            return true; // target-changing brace expansion
        if (ch === "&&" && command[i + 1] === "&")
            return true;
        if (ch === "|" && command[i + 1] === "|")
            return true;
        if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r")
            return true;
        if (ch === ">" || ch === "<")
            return true; // 리다이렉션도 출력 신뢰성을 깬다
    }
    return false;
}
function commandText(input) {
    if (typeof input === "string")
        return input;
    if (!input || typeof input !== "object")
        return "";
    const cmd = input.cmd;
    return Array.isArray(cmd)
        ? cmd.join(" ")
        : typeof cmd === "string"
            ? cmd
            : "";
}
function shellWords(command) {
    const words = [];
    let word = "";
    let quote = null;
    let escaped = false;
    let started = false;
    for (const ch of command) {
        if (escaped) {
            word += ch;
            escaped = false;
            started = true;
            continue;
        }
        if (ch === "\\" && quote !== "'") {
            escaped = true;
            started = true;
            continue;
        }
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                word += ch;
            started = true;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            started = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (started) {
                words.push(word);
                word = "";
                started = false;
            }
            continue;
        }
        word += ch;
        started = true;
    }
    if (quote || escaped)
        return null;
    if (started)
        words.push(word);
    return words.length > 0 ? words : null;
}
function commandWords(input, command) {
    if (input && typeof input === "object") {
        const cmd = input.cmd;
        if (Array.isArray(cmd)) {
            return cmd.length > 0 && cmd.every((part) => typeof part === "string")
                ? cmd
                : null;
        }
    }
    return shellWords(command);
}
function shellWorkingDirectory(input, projectRoot) {
    if (!input || typeof input !== "object")
        return projectRoot;
    const record = input;
    const values = [record.workdir, record.cwd].filter((value) => typeof value === "string" && !!value.trim());
    if (new Set(values).size > 1)
        return null;
    return canonicalizePath(path.resolve(projectRoot, values[0] ?? "."));
}
function expandShellPath(base, target) {
    if (!target || target === "-")
        return null;
    if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) {
        return null; // ~user expansion cannot be proven against this process home
    }
    const expanded = target === "~" || target.startsWith(`~${path.sep}`)
        ? path.join(os.homedir(), target.slice(2))
        : target;
    return canonicalizePath(path.resolve(base, expanded));
}
function looksPathLike(value) {
    return (value === "." ||
        value === ".." ||
        value === "~" ||
        path.isAbsolute(value) ||
        value.startsWith("./") ||
        value.startsWith("../") ||
        value.startsWith("~/") ||
        value.includes(path.sep));
}
function pathLikeArguments(words) {
    const paths = [];
    for (const word of words) {
        const value = word.startsWith("-") && word.includes("=")
            ? word.slice(word.indexOf("=") + 1)
            : word;
        if (looksPathLike(value))
            paths.push(value);
    }
    return paths;
}
const TRUSTED_GIT_SUBCOMMANDS = new Set([
    "status",
    "log",
    "show",
    "diff",
    "rev-parse",
    "branch",
]);
function gitEvidenceSpec(words, base) {
    let index = 1;
    let gitCwd = base;
    while (index < words.length) {
        const word = words[index];
        if (word === "-C") {
            const target = words[index + 1];
            if (!target)
                return null;
            const resolved = expandShellPath(gitCwd, target);
            if (!resolved)
                return null;
            gitCwd = resolved;
            index += 2;
            continue;
        }
        if (word.startsWith("-C") && word.length > 2) {
            const resolved = expandShellPath(gitCwd, word.slice(2));
            if (!resolved)
                return null;
            gitCwd = resolved;
            index++;
            continue;
        }
        if (["--no-pager", "--literal-pathspecs", "--no-replace-objects"].includes(word)) {
            index++;
            continue;
        }
        if (word.startsWith("-"))
            return null;
        break;
    }
    const subcommand = words[index];
    if (!subcommand || !TRUSTED_GIT_SUBCOMMANDS.has(subcommand))
        return null;
    return {
        sourceType: "git_history",
        targets: [gitCwd, ...pathLikeArguments(words.slice(index + 1))],
    };
}
function npmTestEvidenceSpec(words, base) {
    let index = 1;
    let prefix = base;
    while (index < words.length) {
        const word = words[index];
        if (word === "--prefix") {
            const target = words[index + 1];
            if (!target)
                return null;
            const resolved = expandShellPath(base, target);
            if (!resolved)
                return null;
            prefix = resolved;
            index += 2;
            continue;
        }
        if (word.startsWith("--prefix=")) {
            const resolved = expandShellPath(base, word.slice("--prefix=".length));
            if (!resolved)
                return null;
            prefix = resolved;
            index++;
            continue;
        }
        break;
    }
    if (words[index] === "run" && words[index + 1] === "test")
        index += 2;
    else if (words[index] === "test")
        index++;
    else
        return null;
    return {
        sourceType: "test_execution",
        targets: [prefix, ...pathLikeArguments(words.slice(index))],
    };
}
function readCommandTargets(program, args) {
    if (program === "find") {
        if (args.some((arg) => /^(?:-exec|-execdir|-ok|-okdir|-delete|-fls|-fprint|-fprintf)$/.test(arg))) {
            return null;
        }
        const roots = [];
        for (const arg of args) {
            if (arg.startsWith("-") || arg === "!" || arg === "(")
                break;
            roots.push(arg);
        }
        return roots.length > 0 ? roots : null;
    }
    const operands = args.filter((arg) => arg === "-" || !arg.startsWith("-"));
    if (program === "ls")
        return operands.length > 0 ? operands : ["."];
    if (program === "stat")
        return operands.length > 0 ? operands : null;
    if (program === "jq")
        return operands.length > 1 ? operands.slice(1) : null;
    // grep/rg: first positional operand is the expression; remaining operands
    // are observation targets. stdin-only searches are intentionally untrusted.
    return operands.length > 1 ? operands.slice(1) : null;
}
function shellEvidenceSpec(words, base) {
    const program = words[0];
    if (!program)
        return null;
    if (program === "git")
        return gitEvidenceSpec(words, base);
    if (program === "npm")
        return npmTestEvidenceSpec(words, base);
    if (["pnpm", "yarn", "bun"].includes(program)) {
        const commandIndex = words[1] === "run" ? 2 : 1;
        if (words[commandIndex] !== "test")
            return null;
        return {
            sourceType: "test_execution",
            targets: [base, ...pathLikeArguments(words.slice(commandIndex + 1))],
        };
    }
    if ((program === "node" && words[1] === "--test") ||
        (program === "vitest") ||
        (program === "npx" && words[1] === "vitest") ||
        program === "pytest" ||
        (program === "cargo" && words[1] === "test") ||
        (program === "go" && words[1] === "test")) {
        return {
            sourceType: "test_execution",
            targets: [base, ...pathLikeArguments(words.slice(1))],
        };
    }
    if (["rg", "grep", "find", "ls", "stat", "jq"].includes(program)) {
        if ((program === "rg" || program === "grep") && words.includes("--pre")) {
            return null;
        }
        const targets = readCommandTargets(program, words.slice(1));
        if (!targets)
            return null;
        return {
            sourceType: "repo_file",
            targets: [...targets, ...pathLikeArguments(words.slice(1))],
        };
    }
    return null;
}
function shellEvidenceVerdict(toolInput, words, ctx) {
    const unverified = {
        sourceType: "external_unverified",
        learnable: false,
    };
    if (!ctx?.cwd)
        return unverified;
    const projectRoot = canonicalizePath(ctx.cwd);
    if (!projectRoot)
        return unverified;
    const effectiveCwd = shellWorkingDirectory(toolInput, projectRoot);
    if (!effectiveCwd || !isInside(effectiveCwd, projectRoot))
        return unverified;
    const spec = shellEvidenceSpec(words, effectiveCwd);
    if (!spec)
        return unverified;
    const denied = deniedEvidenceRoots();
    const targets = [effectiveCwd, ...spec.targets];
    for (const target of targets) {
        const canonical = path.isAbsolute(target)
            ? canonicalizePath(target)
            : expandShellPath(effectiveCwd, target);
        if (!canonical || !isInside(canonical, projectRoot))
            return unverified;
        if (isLlmWorkdirEvidencePath(canonical)) {
            return { sourceType: spec.sourceType, learnable: false };
        }
        if (denied.some((root) => isInside(canonical, root))) {
            return { sourceType: spec.sourceType, learnable: false };
        }
    }
    return { sourceType: spec.sourceType, learnable: true };
}
export function classifyToolEvidence(toolName, toolInput, ctx) {
    if (isMemexRecallToolName(toolName))
        return { sourceType: "memex_recall", learnable: false };
    const leaf = toolName.split("__").at(-1) ?? toolName;
    if (REPO_READ_TOOLS.has(leaf))
        return repoReadVerdict(toolInput, ctx);
    if (leaf !== "shell" && leaf !== "exec_command") {
        return { sourceType: "external_unverified", learnable: false };
    }
    const command = commandText(toolInput).trim();
    if (!command ||
        /(^|\s)(curl|wget|ssh|scp|sftp)\b|https?:\/\/|\bgh\s+api\b/i.test(command)) {
        return { sourceType: "external_unverified", learnable: false };
    }
    // 복합 명령은 첫 토큰이 git/test 여도 출력 전체를 신뢰할 수 없다 —
    // FACT-LIFECYCLE.md:49-50 에 따라 external_unverified 로 강등한다.
    if (isCompositeShellCommand(command)) {
        return { sourceType: "external_unverified", learnable: false };
    }
    const words = commandWords(toolInput, command);
    return words
        ? shellEvidenceVerdict(toolInput, words, ctx)
        : { sourceType: "external_unverified", learnable: false };
}
export function hashRecallPrompt(prompt) {
    return createHash("sha256").update(prompt, "utf8").digest("hex");
}
export function recordRecallEvent(db, event) {
    if (!event.sessionId || event.factIds.length === 0)
        return null;
    const id = randomUUID();
    db.prepare(`
    INSERT INTO recall_events
      (id, session_id, project, prompt_hash, fact_ids, source_type, learnable, status,
       project_id, workspace_id, workstream_id, context_epoch, project_memory_revision, created_at)
    VALUES (?, ?, ?, ?, ?, 'memex_recall', 0, 'prepared', ?, ?, ?, ?, ?, ?)
  `).run(id, event.sessionId, event.project, hashRecallPrompt(event.prompt), JSON.stringify([...new Set(event.factIds)]), event.projectId ?? null, event.workspaceId ?? null, event.workstreamId ?? null, event.contextEpoch ?? 0, event.projectMemoryRevision ?? 0, new Date().toISOString());
    return id;
}
export function markRecallEventEmitted(db, event) {
    const row = db
        .prepare(`
    SELECT id FROM recall_events
    WHERE session_id = ? AND prompt_hash = ? AND status = 'prepared'
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `)
        .get(event.sessionId, hashRecallPrompt(event.prompt));
    if (!row)
        return false;
    return (db
        .prepare(`UPDATE recall_events SET status = 'emitted', emitted_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), row.id).changes === 1);
}
export function getAllExchanges(db) {
    const stmt = db.prepare(`SELECT id, archive_path as archivePath FROM exchanges`);
    return stmt.all();
}
export function getFileLastIndexed(db, archivePath) {
    const stmt = db.prepare(`
    SELECT MAX(last_indexed) as lastIndexed
    FROM exchanges
    WHERE archive_path = ?
  `);
    const row = stmt.get(archivePath);
    return row.lastIndexed;
}
export function deleteExchange(db, id) {
    // 재감사 P1-6: 통합 삭제 primitive다 — tool_calls(vec_exchanges, FTS는
    // exchange 삭제 trigger가 정리)까지 같이 지우지 않으면 FK가 켜진 연결에서는
    // constraint error가, 꺼진 연결에서는 고아 tool evidence가 남는다.
    db.prepare(`DELETE FROM tool_calls WHERE exchange_id = ?`).run(id);
    // Delete from vector table
    db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`).run(id);
    // Delete from main table
    db.prepare(`DELETE FROM exchanges WHERE id = ?`).run(id);
}
function renameExchangeWithin(db, oldId, newId) {
    // fact provenance 재작성 — exchange id 는 facts.source_exchange_ids(JSON)와
    // fact_revisions.source_exchange_id 에 참조된다.
    const factRows = db
        .prepare("SELECT id, source_exchange_ids FROM facts WHERE source_exchange_ids LIKE ?")
        .all(`%${oldId}%`);
    for (const fact of factRows) {
        try {
            const ids = JSON.parse(fact.source_exchange_ids);
            if (Array.isArray(ids) && ids.includes(oldId)) {
                db.prepare("UPDATE facts SET source_exchange_ids = ? WHERE id = ?").run(JSON.stringify([...new Set(ids.map((i) => (i === oldId ? newId : i)))]), fact.id);
            }
        }
        catch {
            // malformed provenance — rename 대상이 아니다
        }
    }
    db.prepare("UPDATE fact_revisions SET source_exchange_id = ? WHERE source_exchange_id = ?").run(newId, oldId);
    // vec0 virtual table은 UPDATE가 아닌 DELETE+INSERT로 옮긴다. SELECT 는
    // 디코딩된 벡터를 돌려주므로 테이블 dtype 으로 재인코딩해야 한다.
    const vec = db
        .prepare("SELECT embedding FROM vec_exchanges WHERE id = ?")
        .get(oldId);
    if (vec) {
        const dt = getVecTableDtype(db, "vec_exchanges");
        db.prepare("DELETE FROM vec_exchanges WHERE id = ?").run(oldId);
        db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(dt)})`).run(newId, embeddingToVecBlob(vec.embedding, dt));
    }
    db.prepare("UPDATE exchanges SET id = ? WHERE id = ?").run(newId, oldId);
    db.prepare("UPDATE tool_calls SET exchange_id = ? WHERE exchange_id = ?").run(newId, oldId);
}
/**
 * 재감사 P1-6: 재색인 desired-set reconciliation. 새 파싱의 교환 집합(desired)과
 * 같은 archive의 DB 행 집합을 transaction으로 대조한다.
 *  - line 이 desired 에 없는 행 → 통합 삭제 primitive로 제거(stale state).
 *  - line 이 일치하지만 id 가 legacy(archivePath 기반) 행 → canonical id 로
 *    rename하고 모든 참조(tool_calls/vec/fact provenance/revision)를 재작성한다.
 *  - id 가 이미 일치하는 행 → 그대로(insertExchange upsert가 내용을 갱신한다).
 * 같은 line_start 에 행이 여러 개(구 scheme 의 growing-turn 중복)면, desired id 와
 * 정확히 일치하는 행을 남기고 없으면 last_indexed 가 최신인 행을 rename한 뒤
 * 나머지는 삭제한다. caller는 호출 뒤 desired 교환을 insertExchange 하면 된다.
 */
export function reconcileArchiveExchanges(db, input) {
    const desiredByLine = new Map(input.desired.map((d) => [d.lineStart, d.id]));
    const rows = db
        .prepare("SELECT id, line_start, last_indexed FROM exchanges WHERE archive_path = ?")
        .all(input.archivePath);
    const byLine = new Map();
    for (const row of rows) {
        const group = byLine.get(row.line_start) ?? [];
        group.push({ id: row.id, last_indexed: row.last_indexed });
        byLine.set(row.line_start, group);
    }
    const renames = [];
    const deletions = [];
    for (const [lineStart, group] of byLine) {
        const desiredId = desiredByLine.get(lineStart);
        if (desiredId === undefined) {
            for (const row of group)
                deletions.push(row.id);
            continue;
        }
        const exact = group.find((row) => row.id === desiredId);
        if (exact) {
            // 이 행이 desired 이다 — 나머지 중복 행은 stale 다.
            for (const row of group) {
                if (row.id !== desiredId)
                    deletions.push(row.id);
            }
            continue;
        }
        // legacy rename 대상은 가장 최근에 기록된 행(내용이 가장 완전하다).
        const newest = [...group].sort((a, b) => b.last_indexed - a.last_indexed)[0];
        renames.push([newest.id, desiredId]);
        for (const row of group) {
            if (row.id !== newest.id)
                deletions.push(row.id);
        }
    }
    // desired 에 있는데 DB 에 행이 아예 없는 line 은 rename/delete 대상이 아니다 —
    // caller의 insertExchange 가 새로 넣는다.
    if (renames.length === 0 && deletions.length === 0) {
        return { renamed: 0, deleted: 0 };
    }
    const tx = db.transaction(() => {
        // rename 은 parent(exchanges.id)와 children(tool_calls)을 한 transaction 에서
        // 양방향으로 건드린다 — 즉시 FK 검사를 commit 까지 미룬다.
        db.pragma("defer_foreign_keys = ON");
        for (const [oldId, newId] of renames)
            renameExchangeWithin(db, oldId, newId);
        for (const id of deletions) {
            // 삭제된 교환을 참조하는 provenance 도 정리한다 — 죽은 포인터를 남기면
            // source trace 가 "resolvable 한 것처럼" 보이는 것 자체가 거짓이다.
            const factRows = db
                .prepare("SELECT id, source_exchange_ids FROM facts WHERE source_exchange_ids LIKE ?")
                .all(`%${id}%`);
            for (const fact of factRows) {
                try {
                    const ids = JSON.parse(fact.source_exchange_ids);
                    if (Array.isArray(ids) && ids.includes(id)) {
                        const next = ids.filter((i) => i !== id);
                        db.prepare("UPDATE facts SET source_exchange_ids = ? WHERE id = ?").run(JSON.stringify([...new Set(next)]), fact.id);
                    }
                }
                catch {
                    // malformed provenance — 건드리지 않는다
                }
            }
            db.prepare("UPDATE fact_revisions SET source_exchange_id = NULL WHERE source_exchange_id = ?").run(id);
            deleteExchange(db, id);
        }
    });
    tx.immediate();
    return { renamed: renames.length, deleted: deletions.length };
}
