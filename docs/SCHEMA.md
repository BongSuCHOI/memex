# Database schema

Memory Bank creates a new SQLite database at
`~/.config/memory-bank/conversation-index/db.sqlite` unless
`MEMORY_BANK_DB_PATH` overrides it. The schema is created by `src/db.ts`; no
pre-Codex database migration is performed.

## Conversation tables

```sql
CREATE TABLE exchanges (
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
  embedding_version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL REFERENCES exchanges(id),
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  tool_result TEXT,
  is_error BOOLEAN DEFAULT 0,
  timestamp TEXT NOT NULL
);
```

`exchanges_fts` is an external-content FTS5 table over `user_message` and
`assistant_message` with `porter unicode61` tokenization and `detail=column`.
Insert, update, and delete triggers keep it synchronized. `fts_meta` records
whether the FTS index has been built.

## Facts and extraction

```sql
CREATE TABLE facts (
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
);

CREATE TABLE fact_revisions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES facts(id),
  previous_fact TEXT NOT NULL,
  new_fact TEXT NOT NULL,
  reason TEXT,
  source_exchange_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE extraction_log (
  session_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL,
  extracted INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  dropped_batches INTEGER NOT NULL DEFAULT 0,
  claim_owner TEXT,
  last_exchange_rowid INTEGER NOT NULL DEFAULT 0
);
```

`extraction_log` is both the extraction ledger and the concurrency claim. The
rowid watermark makes repeated SessionEnd events no-ops until new exchanges are
indexed for that session.

## Ontology

```sql
CREATE TABLE ontology_domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ontology_categories (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES ontology_domains(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ontology_relations (
  id TEXT PRIMARY KEY,
  source_fact_id TEXT NOT NULL REFERENCES facts(id),
  relation_type TEXT NOT NULL CHECK (
    relation_type IN ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS')
  ),
  target_fact_id TEXT NOT NULL REFERENCES facts(id),
  reasoning TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The `(source_fact_id, relation_type, target_fact_id)` triple is unique.

## Vector indexes

All sqlite-vec virtual tables use `int8[384]` embeddings:

- `vec_exchanges`
- `vec_facts`
- `vec_facts_kr`
- `vec_categories`

Conventional indexes cover timestamps, session/project/archive lookups, tool
lookups, active facts and scopes, ontology membership, and relation endpoints.
