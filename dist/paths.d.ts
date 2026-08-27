import { sessionsRoot } from "./codex-rollout.js";
export declare function getMemexHome(): string;
/**
 * @deprecated Historical name kept as a thin alias so pre-existing importers
 * (`dist/paths.js`) keep resolving the SAME root during the transition.
 * New code must call {@link getMemexHome}.
 */
export declare function getMemoryBankHome(): string;
/**
 * Read-only detection of a pre-v0.2 data root created by an older install.
 * Used by `memex doctor`, onboarding status checks, and `memex migrate-home`
 * to surface (never auto-execute) a pending migration. Returns null when the
 * legacy default location holds no recognizable Memex data.
 */
export declare function detectLegacyDataRoot(): string | null;
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
export declare function ensureMemoryBankHome(): string;
export declare function ensureArchiveDir(): string;
export declare function ensureIndexDir(): string;
export declare function ensureDbDir(): string;
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
 * True if a canonical project must be skipped by indexing/sync.
 *
 * CX-02: `project` is the canonical absolute cwd. The user list is an
 * exact-match on that canonical path (a basename entry can no longer
 * accidentally exclude an unrelated same-named project). The built-in rule
 * still excludes the reserved LLM worker workdir, matched on the final path
 * segment so both `.../memory-bank-llm` and legacy slug forms stay covered.
 */
export declare function isExcludedProject(
 project: string,
 excluded?: string[],
): boolean;
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
export declare function isWorkerPromptMessage(
 userMessage: string | null | undefined,
): boolean;
/**
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export declare function getExcludedProjects(): string[];
