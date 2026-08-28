import os from "os";
import path from "path";
import fs from "fs";
import { sessionsRoot } from "./codex-rollout.js";
/**
 * Memex data root resolver (pure getter — never mutates filesystem).
 *
 * Precedence:
 * 1. MEMEX_HOME                — explicit root
 * 2. XDG_CONFIG_HOME/memex
 * 3. ~/.config/memex           — default
 */
const MEMEX_DEFAULT_BASENAME = "memex";
export function getMemexHome() {
    const home = process.env.MEMEX_HOME;
    if (home)
        return home;
    return process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, MEMEX_DEFAULT_BASENAME)
        : path.join(os.homedir(), ".config", MEMEX_DEFAULT_BASENAME);
}
/**
 * Get conversation archive directory (pure getter).
 */
export function getArchiveDir() {
    if (process.env.TEST_ARCHIVE_DIR) {
        return process.env.TEST_ARCHIVE_DIR;
    }
    return path.join(getMemexHome(), "conversation-archive");
}
/**
 * Get conversation index directory (pure getter).
 */
export function getIndexDir() {
    return path.join(getMemexHome(), "conversation-index");
}
/**
 * Get database path (pure getter).
 */
export function getDbPath() {
    const dbOverride = process.env.MEMEX_DB_PATH || process.env.TEST_DB_PATH;
    if (dbOverride)
        return dbOverride;
    return path.join(getIndexDir(), "db.sqlite");
}
/**
 * Write helpers (explicit directory creation for write paths only).
 */
export function ensureMemexHome() {
    const dir = getMemexHome();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function ensureArchiveDir() {
    const dir = getArchiveDir();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function ensureIndexDir() {
    const dir = getIndexDir();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function ensureDbDir() {
    const dbDir = path.dirname(getDbPath());
    if (!fs.existsSync(dbDir))
        fs.mkdirSync(dbDir, { recursive: true });
    return dbDir;
}
/**
 * Get exclude config path
 */
export function getExcludeConfigPath() {
    return path.join(getIndexDir(), "exclude.txt");
}
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
export const LLM_WORKDIR_BASENAME = "memex-llm";
/**
 * True for the reserved headless-worker working directory, in either shape it
 * exists as: the plain basename (`…/memex-llm`) or the mkdtemp form
 * codex-exec.ts creates (`<tmpdir>/memex-llm-XXXXXX`). Matched on the FINAL
 * path segment only. Consumers:
 * sync/indexer/verify exclusion (TS) and, through llmWorkdirCwdSql, the
 * extraction gate SQL — keep the shapes identical.
 */
export function isLlmWorkdirPath(project) {
    const segments = project.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last)
        return false;
    return last === LLM_WORKDIR_BASENAME || last.startsWith(`${LLM_WORKDIR_BASENAME}-`);
}
/**
 * SQLite predicate equivalent of isLlmWorkdirPath for exchanges.cwd, shared by
 * pendingExtractionCoreQuery and pipeline-status so the reserved workdir shape
 * cannot drift between the selection and status consumers again. Returns a
 * parenthesized clause; `column` defaults to the worker queries' alias.
 */
export function llmWorkdirCwdSql(column = "x.cwd") {
    return `(${column} LIKE '%/${LLM_WORKDIR_BASENAME}' OR ${column} LIKE '%/${LLM_WORKDIR_BASENAME}-%')`;
}
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
export function isExcludedProject(project, excluded) {
    const list = excluded ?? getExcludedProjects();
    if (list.includes(project))
        return true;
    // Built-in: the plugin's own headless worker workdir.
    return isLlmWorkdirPath(project);
}
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
export const WORKER_PROMPT_PREFIXES = [
    "You are an expert at extracting long-term facts from conversations.", // fact-extractor
    "You are an ontology classifier for technical decision facts.", // ontology batch classify
    "You are analyzing relationships between technical decision facts.", // ontology relation detect
    "Compare two facts and determine their relationship.", // consolidator
];
/**
 * True if a user message is one of the plugin's own LLM worker prompts —
 * such an exchange is ephemeral worker state, never knowledge, and must not
 * be indexed (searchable) regardless of which project slug it sits under.
 */
export function isWorkerPromptMessage(userMessage) {
    if (!userMessage)
        return false;
    return WORKER_PROMPT_PREFIXES.some((p) => userMessage.startsWith(p));
}
/**
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export function getExcludedProjects() {
    // Check env variable first
    if (process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS) {
        return process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS.split(",")
            .map((p) => p.trim())
            .filter((p) => p !== "");
    }
    // Check for config file
    const configPath = getExcludeConfigPath();
    if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        return content
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));
    }
    // Default: no exclusions
    return [];
}
