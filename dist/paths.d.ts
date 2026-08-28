import { sessionsRoot } from "./codex-rollout.js";
export declare function getMemexHome(): string;
/**
 * Get conversation archive directory (pure getter).
 */
export declare function getArchiveDir(): string;
/**
 * Get conversation index directory (pure getter).
 */
export declare function getIndexDir(): string;
/**
 * Get database path (pure getter).
 */
export declare function getDbPath(): string;
/**
 * Write helpers (explicit directory creation for write paths only).
 */
export declare function ensureMemexHome(): string;
export declare function ensureArchiveDir(): string;
export declare function ensureIndexDir(): string;
export declare function ensureDbDir(): string;
/**
 * Get exclude config path
 */
export declare function getExcludeConfigPath(): string;
/**
 * Codex rollout transcripts root ($CODEX_HOME/sessions). Recursive layout:
 * sessions/YYYY/MM/DD/rollout-<timestamp>-<thread>.jsonl. MEMEX_SESSIONS_DIR is
 * the optional explicit override; TEST_SESSIONS_DIR is used by tests.
 */
export { sessionsRoot as getSessionsRoot };
/**
 * Reserved basename of the isolated working directory that llm.ts gives to
 * headless CodexExec calls (see LLM_WORKDIR in llm.ts). Every one-shot
 * `codex exec` call runs with --ephemeral inside its own mkdtemp, so nothing
 * persists under this name anymore. The reserved name still prevents an
 * accidentally persisted worker rollout from entering the index.
 */
export declare const LLM_WORKDIR_BASENAME = "memex-llm";
/**
 * True for the reserved headless-worker working directory, in either shape it
 * exists as: the plain basename (`…/memex-llm`) or the mkdtemp form
 * codex-exec.ts creates (`<tmpdir>/memex-llm-XXXXXX`). Matched on the FINAL
 * path segment only. Consumers:
 * sync/indexer/verify exclusion (TS) and, through llmWorkdirCwdSql, the
 * extraction gate SQL — keep the shapes identical.
 */
export declare function isLlmWorkdirPath(project: string): boolean;
/**
 * SQLite predicate equivalent of isLlmWorkdirPath for exchanges.cwd, shared by
 * pendingExtractionCoreQuery and pipeline-status so the reserved workdir shape
 * cannot drift between the selection and status consumers again. Returns a
 * parenthesized clause; `column` defaults to the worker queries' alias.
 */
export declare function llmWorkdirCwdSql(column?: string): string;
/**
 * True if a canonical project must be skipped by indexing/sync.
 *
 * CX-02: `project` is the canonical absolute cwd. The user list is an
 * exact-match on that canonical path (a basename entry can no longer
 * accidentally exclude an unrelated same-named project). The built-in rule
 * still excludes the reserved LLM worker workdir in both shapes (plain
 * basename and the mkdtemp `memex-llm-XXXXXX` suffix form — see
 * isLlmWorkdirPath).
 */
export declare function isExcludedProject(project: string, excluded?: string[]): boolean;
/**
 * Exact leading text of the plugin's own LLM worker prompts (CodexExec era).
 * Sessions from BEFORE the fixed workdir existed ran their worker prompts
 * with the CALLER project's cwd, so their transcripts sit in REAL project
 * archives and can never be excluded by slug — the slug is a legitimate
 * project's. Content is the only discriminator. Kept as full first sentences
 * so a prefix can't match ordinary human text by accident (measured
 * pollution: 59,940 exchanges / ~16% of one production corpus before this
 * guard existed).
 */
export declare const WORKER_PROMPT_PREFIXES: readonly string[];
/**
 * True if a user message is one of the plugin's own LLM worker prompts —
 * such an exchange is ephemeral worker state, never knowledge, and must not
 * be indexed (searchable) regardless of which project slug it sits under.
 */
export declare function isWorkerPromptMessage(userMessage: string | null | undefined): boolean;
/**
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export declare function getExcludedProjects(): string[];
