/**
 * What models can this Codex installation actually use? (#31, 0.7.0)
 *
 * Measured 2026-09-11 against codex-cli 0.153.4: the CLI has **no**
 * `models list`-style subcommand. Two JSON files carry the answer instead:
 *
 *   1. the user's own catalog, named by `model_catalog_json = "<path>"` in
 *      `$CODEX_HOME/config.toml`
 *   2. `$CODEX_HOME/models_cache.json`, the server list Codex last fetched
 *
 * Both hold the same item shape:
 *   { slug, display_name, description, default_reasoning_level,
 *     supported_reasoning_levels: [{ effort, description }],
 *     visibility: "list" | "hide", supported_in_api, priority }
 *
 * Read-only, builtin-only, and it NEVER throws: a missing/garbled catalog means
 * "this installation did not tell us", which is a free-text input with a
 * warning — not a failure. There is deliberately no TOML parser here; one line
 * of regex answers the only question we ask of config.toml, and a dependency
 * for that would be absurd.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexModelOption {
  slug: string;
  displayName: string;
  description: string | null;
  defaultReasoning: string | null;
  /** Allowed reasoning levels for THIS model, in catalog order. */
  reasoningEfforts: string[];
  /** `visibility === 'list'`. Hidden entries stay selectable by typing them. */
  visible: boolean;
  priority: number;
}

export interface CodexCatalog {
  source: 'model_catalog_json' | 'models_cache' | 'none';
  path: string | null;
  fetchedAt: string | null;
  models: CodexModelOption[];
}

/** `$CODEX_HOME` or `~/.codex`. Same rule `lifecycle.ts` uses for hooks. */
export function codexHome(): string {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

const CATALOG_PATH_RE = /^\s*model_catalog_json\s*=\s*"([^"]+)"\s*$/m;

/** The path `config.toml` points at, or null. Never throws. */
export function catalogPathFromConfig(home = codexHome()): string | null {
  try {
    const text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const match = CATALOG_PATH_RE.exec(text);
    if (!match) return null;
    const raw = match[1].trim();
    if (!raw) return null;
    if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
    return path.isAbsolute(raw) ? raw : path.resolve(home, raw);
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function reasoningLevelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const effort =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as { effort?: unknown }).effort
          : undefined;
    const normalized = stringOrNull(effort);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function optionFromEntry(entry: unknown): CodexModelOption | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const row = entry as Record<string, unknown>;
  const slug = stringOrNull(row.slug) ?? stringOrNull(row.id) ?? stringOrNull(row.model);
  if (!slug) return null;
  const priority = typeof row.priority === 'number' && Number.isFinite(row.priority)
    ? row.priority
    : Number.MAX_SAFE_INTEGER;
  return {
    slug,
    displayName: stringOrNull(row.display_name) ?? slug,
    description: stringOrNull(row.description),
    defaultReasoning: stringOrNull(row.default_reasoning_level),
    reasoningEfforts: reasoningLevelsOf(row.supported_reasoning_levels),
    // Absent `visibility` is a listable entry; only an explicit non-'list'
    // value hides one. Hidden ids (`gpt-reserve`, `codex-auto-review`) are
    // still legitimate typed input, so they are kept in `models`.
    visible: row.visibility === undefined || row.visibility === null || row.visibility === 'list',
    priority,
  };
}

function parseCatalogDocument(text: string): { models: CodexModelOption[]; fetchedAt: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  let entries: unknown;
  let fetchedAt: string | null = null;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const object = parsed as Record<string, unknown>;
    entries = object.models;
    fetchedAt = stringOrNull(object.fetched_at);
  }
  if (!Array.isArray(entries)) return null;
  const models: CodexModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const option = optionFromEntry(entry);
    if (!option || seen.has(option.slug)) continue;
    seen.add(option.slug);
    models.push(option);
  }
  if (models.length === 0) return null;
  models.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
  return { models, fetchedAt };
}

function readFrom(
  file: string | null,
  source: 'model_catalog_json' | 'models_cache',
): CodexCatalog | null {
  if (!file) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const document = parseCatalogDocument(text);
  if (!document) return null;
  return { source, path: file, fetchedAt: document.fetchedAt, models: document.models };
}

/**
 * User catalog first, then the fetched cache, then "none". Never throws.
 */
export function readCodexCatalog(home = codexHome()): CodexCatalog {
  return (
    readFrom(catalogPathFromConfig(home), 'model_catalog_json') ??
    readFrom(path.join(home, 'models_cache.json'), 'models_cache') ?? {
      source: 'none',
      path: null,
      fetchedAt: null,
      models: [],
    }
  );
}

/** Entries a picker should offer. Hidden ids stay typeable but unlisted. */
export function listableModels(catalog: CodexCatalog): CodexModelOption[] {
  return catalog.models.filter((model) => model.visible);
}

export function findCatalogModel(catalog: CodexCatalog, slug: string): CodexModelOption | null {
  const wanted = slug.trim();
  return catalog.models.find((model) => model.slug === wanted) ?? null;
}

/**
 * Allowed reasoning levels for one model, or `null` when this installation has
 * nothing to say about it.
 *
 * `null` is NOT "no levels are allowed" — the catalog can be stale, so a
 * settings write warns and proceeds instead of refusing (§3.3 rule 2).
 */
export function reasoningEffortsForModel(
  slug: string,
  catalog: CodexCatalog = readCodexCatalog(),
): string[] | null {
  const model = findCatalogModel(catalog, slug);
  if (!model || model.reasoningEfforts.length === 0) return null;
  return model.reasoningEfforts;
}
