import { sessionsRoot } from './codex-rollout.js';
/**
 * Get the personal superpowers directory
 *
 * Precedence:
 * 1. MEMORY_BANK_CONFIG_DIR env var (if set, for testing)
 * 2. PERSONAL_SUPERPOWERS_DIR env var (if set)
 * 3. XDG_CONFIG_HOME/superpowers (if XDG_CONFIG_HOME is set)
 * 4. ~/.config/superpowers (default)
 */
export declare function getSuperpowersDir(): string;
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
 * Known coding agent source directories.
 * Maps source directory paths to coding agent identifiers.
 * Used during sync to auto-detect which agent generated a conversation.
 */
export interface AgentSource {
    name: string;
    sourceDir: string;
}
/**
 * Get the list of coding agent sources to sync from.
 * Default: local Codex rollouts only. Additional agents configured via
 * MEMORY_BANK_AGENT_SOURCES env var (JSON) or agent-sources.json config file.
 *
 * Format: [{"name": "opencode", "sourceDir": "/path/to/conversations"}]
 */
export declare function getAgentSources(): AgentSource[];
/**
 * Detect coding agent from a source directory path.
 * Returns the agent name if the path matches a known source, 'codex' otherwise.
 */
export declare function detectCodingAgent(sourcePath: string): string;
/**
 * Reserved basename of the isolated working directory that llm.ts gives to
 * headless CodexExec calls (see LLM_WORKDIR in llm.ts). Every one-shot
 * `codex exec` call runs with --ephemeral inside its own mkdtemp, so nothing
 * persists under this name anymore. The slug is kept for legacy-archive
 * compatibility: pre-Codex transcripts polluted the conversation index with
 * 6.4k worker exchanges (observed 2026-07-08), and old archives still carry
 * those slugs.
 */
export declare const LLM_WORKDIR_BASENAME = "memory-bank-llm";
/**
 * True if a project key (derived from session cwd or legacy archive slugs)
 * must be skipped by indexing/sync. Combines the user-configured exact-match
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
