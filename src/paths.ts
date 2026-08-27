import os from 'os';
import path from 'path';
import fs from 'fs';
import { sessionsRoot } from './codex-rollout.js';

/**
 * Ensure a directory exists, creating it if necessary
 */
function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Native memory-bank data root (pure getter — never mutates filesystem).
 *
 * Precedence (no legacy fallback, no migration):
 * 1. MEMORY_BANK_HOME          — explicit root, used as-is
 * 2. MEMORY_BANK_CONFIG_DIR    — explicit root, used as-is
 * 3. XDG_CONFIG_HOME/memory-bank
 * 4. ~/.config/memory-bank     — default
 */
export function getMemoryBankHome(): string {
  return process.env.MEMORY_BANK_HOME
    || process.env.MEMORY_BANK_CONFIG_DIR
    || (process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'memory-bank')
      : path.join(os.homedir(), '.config', 'memory-bank'));
}

/**
 * Get conversation archive directory (pure getter).
 */
export function getArchiveDir(): string {
  if (process.env.TEST_ARCHIVE_DIR) {
    return process.env.TEST_ARCHIVE_DIR;
  }
  return path.join(getMemoryBankHome(), 'conversation-archive');
}

/**
 * Get conversation index directory (pure getter).
 */
export function getIndexDir(): string {
  return path.join(getMemoryBankHome(), 'conversation-index');
}

/**
 * Get database path (pure getter).
 */
export function getDbPath(): string {
  if (process.env.MEMORY_BANK_DB_PATH || process.env.TEST_DB_PATH) {
    return process.env.MEMORY_BANK_DB_PATH || process.env.TEST_DB_PATH!;
  }
  return path.join(getIndexDir(), 'db.sqlite');
}

/**
 * Write helpers (explicit directory creation for write paths only).
 */
export function ensureMemoryBankHome(): string {
  const dir = getMemoryBankHome();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureArchiveDir(): string {
  const dir = getArchiveDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureIndexDir(): string {
  const dir = getIndexDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDbDir(): string {
  const dbDir = path.dirname(getDbPath());
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  return dbDir;
}


/**
 * Get exclude config path
 */
export function getExcludeConfigPath(): string {
  return path.join(getIndexDir(), 'exclude.txt');
}

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
export const LLM_WORKDIR_BASENAME = 'memory-bank-llm';

/**
 * True if a canonical project must be skipped by indexing/sync.
 *
 * CX-02: `project` is the canonical absolute cwd. The user list is an
 * exact-match on that canonical path (a basename entry can no longer
 * accidentally exclude an unrelated same-named project). The built-in rule
 * still excludes the reserved LLM worker workdir, matched on the final path
 * segment so both `.../memory-bank-llm` and legacy slug forms stay covered.
 */
export function isExcludedProject(project: string, excluded?: string[]): boolean {
  const list = excluded ?? getExcludedProjects();
  if (list.includes(project)) return true;
  // Built-in: the plugin's own headless worker workdir basename.
  const segments = project.split('/').filter(Boolean);
  return segments[segments.length - 1] === LLM_WORKDIR_BASENAME;
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
export const WORKER_PROMPT_PREFIXES: readonly string[] = [
  'You are an expert at extracting long-term facts from conversations.', // fact-extractor
  'You are an ontology classifier for technical decision facts.',        // ontology batch classify
  'You are analyzing relationships between technical decision facts.',   // ontology relation detect
  'Compare two facts and determine their relationship.',                 // consolidator
];

/**
 * True if a user message is one of the plugin's own LLM worker prompts —
 * such an exchange is ephemeral worker state, never knowledge, and must not
 * be indexed (searchable) regardless of which project slug it sits under.
 */
export function isWorkerPromptMessage(userMessage: string | null | undefined): boolean {
  if (!userMessage) return false;
  return WORKER_PROMPT_PREFIXES.some((p) => userMessage.startsWith(p));
}

/**
 * Get list of projects to exclude from indexing
 * Configurable via env var or config file
 */
export function getExcludedProjects(): string[] {
  // Check env variable first
  if (process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS) {
    return process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS.split(',').map(p => p.trim()).filter(p => p !== '');
  }

  // Check for config file
  const configPath = getExcludeConfigPath();
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    return content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  }

  // Default: no exclusions
  return [];
}
