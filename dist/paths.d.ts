import { sessionsRoot } from './codex-rollout.js';
/**
 * Native memory-bank data root.
 *
 * Precedence (no legacy fallback, no migration):
 * 1. MEMORY_BANK_HOME          — explicit root, used as-is
 * 2. MEMORY_BANK_CONFIG_DIR    — explicit root, used as-is
 * 3. XDG_CONFIG_HOME/memory-bank
 * 4. ~/.config/memory-bank     — default
 */
export declare function getMemoryBankHome(): string;
/**
 * Get conversation archive directory
 */
export declare function getArchiveDir(): string;
/**
 * Get conversation index directory
 */
export declare function getIndexDir(): string;
/**
 * Get database path
 */
export declare function getDbPath(): string;
/**
 * Get exclude config path
 */
export declare function getExcludeConfigPath(): string;
/**
 * Codex rollout transcripts root ($CODEX_HOME/sessions). Recursive layout:
 * sessions/YYYY/MM/DD/rollout-<timestamp>-<thread>.jsonl. TEST_SESSIONS_DIR /
 * MEMORY_BANK_SESSIONS_DIR override for tests and custom installs.
 */
export { sessionsRoot as getSessionsRoot };
/**
 * Reserved basename of the isolated working directory that llm.ts gives to
 * headless CodexExec calls (see LLM_WORKDIR in llm.ts). Every one-shot
 * `codex exec` call runs with --ephemeral inside its own mkdtemp, so nothing
 * persists under this name anymore. The reserved name still prevents an
 * accidentally persisted worker rollout from entering the index.
 */
export declare const LLM_WORKDIR_BASENAME = "memory-bank-llm";
/**
 * True if a project key derived from session cwd must be skipped by
 * indexing/sync. Combines the user-configured exact-match
 * list with the built-in exclusion of the plugin's own LLM worker sessions.
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
