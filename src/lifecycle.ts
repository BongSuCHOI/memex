/**
 * CX-01 — Codex lifecycle registration, diagnosis, removal.
 *
 * Contract (documented in docs/CONVERSATION-LIFECYCLE.md, codex-cli 0.150.1):
 *  - The hook config owner is $CODEX_HOME/hooks.json (user scope). Plugin
 *    marketplace plugins declare hooks through plugin.json; explicit setup is
 *    retained only as a fingerprinted fallback for non-plugin hosts.
 *  - Registered commands use ABSOLUTE paths resolved at setup time.
 *    `${PLUGIN_ROOT}` is not assumed to expand inside Codex hooks.
 *  - Ownership: every Memex entry carries a fingerprint marker comment
 *    field `"_memex": true` plus the exact command string recorded in
 *    lifecycle-registration.json under the Memex data root. remove only
 *    touches entries whose command matches a registered fingerprint; foreign
 *    entries are preserved byte-for-byte (2-space JSON indent, key order kept).
 *  - Idempotent: running setup twice produces zero new entries.
 *  - Never installs dependencies or plugins; never mutates anything outside
 *    $CODEX_HOME/hooks.json and the Memex data root.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { lastObserved } from "./observe-hook-event.js";
import { getDbPath, getMemexHome } from "./paths.js";
import { readExportStatus } from "./sync-export.js";
import { readSyncConfig, resolveSyncDir } from "./sync-paths.js";
import { getInjectLogPath } from "./inject-log.js";
import {
  missingRuntimeDependencies,
  RUNTIME_DEPENDENCIES,
  resolveInstalledPluginRoot,
} from "./plugin-root.js";
import {
  embeddingCacheStatus,
  formatCacheBytes,
  legacyEmbeddingCacheCandidates,
} from "./model-cache.js";

const runtimeRequire = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface LifecycleCommandConfig {
  script: string;
  args?: string[];
  async?: boolean;
  matcher?: string;
  timeout?: number;
}

/** Relative-to-plugin-root commands registered for each event. */
export const LIFECYCLE_COMMANDS: Record<HookEvent, LifecycleCommandConfig[]> = {
  SessionStart: [
    { script: "scripts/continuity-hook.js", matcher: "startup|resume|clear|compact", timeout: 3 },
    { script: "scripts/version-drift-check.js", async: true, matcher: "startup|resume" },
    { script: "cli/memex.js", args: ["sync", "--background"], async: true, matcher: "startup|resume" },
    { script: "scripts/sync-import-hook.js", async: true, matcher: "startup|resume" },
    { script: "scripts/session-start-maintenance.js", async: true, matcher: "startup|resume" },
  ],
  UserPromptSubmit: [
    { script: "scripts/inject-context-hook.sh" },
    { script: "scripts/session-start-maintenance.js", args: ["--prompt"], async: true },
  ],
  Stop: [{ script: "scripts/continuity-hook.js", timeout: 3 }],
  Interrupt: [{ script: "scripts/continuity-hook.js", timeout: 3 }],
  PreCompact: [{ script: "scripts/continuity-hook.js", matcher: "manual|auto", timeout: 5 }],
  PostCompact: [{ script: "scripts/continuity-hook.js", matcher: "manual|auto", timeout: 3 }],
  // Issue #35: SessionEnd is still a bounded final capture fence — the export
  // is a SEPARATE async entry that Codex does not wait for. It is a no-op
  // unless cross-device sync is enabled AND durable state changed since the
  // last export, so the common case costs one process that exits immediately.
  SessionEnd: [
    { script: "scripts/continuity-hook.js", timeout: 3 },
    { script: "scripts/sync-export-hook.js", async: true },
  ],
};

/** Hook scripts that must be registered for cross-device sync to work at all. */
export const SYNC_LIFECYCLE_SCRIPTS = {
  export: "scripts/sync-export-hook.js",
  import: "scripts/sync-import-hook.js",
} as const;

/** True when `script` is registered for at least one lifecycle event. */
export function isLifecycleScriptRegistered(script: string): boolean {
  return HOOK_EVENTS.some((event) =>
    LIFECYCLE_COMMANDS[event].some((command) => command.script === script),
  );
}

const OWNERSHIP_KEY = "_memex";

export interface LifecycleRegistration {
  schemaVersion: 2;
  installedAt: string;
  pluginRoot: string;
  codexHome: string;
  hooksFile: string;
  entries: Array<{
    event: HookEvent;
    command: string;
    fingerprint: string;
    async?: boolean;
    matcher?: string;
    timeout?: number;
  }>;
}

function codexHome(): string {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

export function hooksFilePath(): string {
  return path.join(codexHome(), "hooks.json");
}

export function dataRoot(): string {
  // Single-source resolution (MEMEX_HOME > XDG > default).
  const dir = getMemexHome();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function registrationPath(): string {
  return path.join(dataRoot(), "lifecycle-registration.json");
}

export function pluginRoot(): string {
  const override = process.env.MEMEX_PLUGIN_ROOT;
  return override
    ? path.resolve(override)
    : path.resolve(HERE, "..");
}

export function fingerprintOf(command: string): string {
  return crypto.createHash("sha256").update(command).digest("hex").slice(0, 16);
}

interface HookEntry {
  type?: string;
  command?: string;
  async?: boolean;
  timeout?: number;
  [OWNERSHIP_KEY]?: boolean;
}
interface HookMatcherBlock {
  matcher?: string;
  hooks?: HookEntry[];
}
interface HooksFile {
  hooks?: Record<string, HookMatcherBlock[] | undefined>;
  [k: string]: unknown;
}

function readHooksFile(file: string): HooksFile {
  if (!fs.existsSync(file)) return {};
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  if (!raw.trim()) return {};
  // A malformed config must fail loud, never be silently clobbered by setup.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as HooksFile;
    throw new Error("not a JSON object");
  } catch {
    throw new Error(
      `${file} is not valid JSON — fix or remove it manually; refusing to touch it`,
    );
  }
}

function serializeHooksFile(hooks: HooksFile): string {
  // Preserve foreign key order via JSON.stringify on plain objects (insertion
  // order) and keep the file byte-stable when nothing changed.
  return JSON.stringify(hooks, null, 2) + "\n";
}

export function commandFor(root: string, c: LifecycleCommandConfig): string {
  const runner = c.script.endsWith(".sh") ? "bash" : "node";
  const scriptPath = path.join(root, c.script);
  const extraArgs =
    c.args && c.args.length > 0
      ? " " +
        c.args
          .map((a) => (a.includes(" ") && !a.startsWith('"') ? `"${a}"` : a))
          .join(" ")
      : "";
  return `${runner} "${scriptPath}"${extraArgs}`;
}

/** Build the desired entry list for a given plugin root (absolute commands). */
export function desiredEntries(
  root = pluginRoot(),
): Array<{ event: HookEvent; command: string; async?: boolean; matcher?: string; timeout?: number }> {
  const entries: Array<{ event: HookEvent; command: string; async?: boolean; matcher?: string; timeout?: number }> =
    [];
  for (const event of HOOK_EVENTS) {
    for (const c of LIFECYCLE_COMMANDS[event]) {
      entries.push({
        event,
        command: commandFor(root, c),
        ...(c.async ? { async: true } : {}),
        ...(c.matcher ? { matcher: c.matcher } : {}),
        ...(c.timeout ? { timeout: c.timeout } : {}),
      });
    }
  }
  return entries;
}

export interface PlanDiff {
  targetFile: string;
  add: Array<{ event: HookEvent; command: string; matcher?: string; timeout?: number }>;
  remove: Array<{ event: HookEvent; command: string }>;
  preservedForeignEntries: number;
  staleOwnedEntries: number;
}

/** Compute the exact add/remove diff against the current hooks.json. */
export function planSetup(root = pluginRoot()): PlanDiff {
  const hooks = readHooksFile(hooksFilePath());
  const desired = desiredEntries(root);
  const desiredCmds = new Set(desired.map((d) => d.command));
  const existingKeys = new Set<string>();
  let preservedForeign = 0;
  let staleOwned = 0;

  for (const event of HOOK_EVENTS) {
    for (const block of hooks.hooks?.[event] ?? []) {
      for (const h of block.hooks ?? []) {
        if (!h.command || typeof h.command !== "string") continue;
        if ((h as Record<string, unknown>)[OWNERSHIP_KEY] === true) {
          existingKeys.add(`${event}\0${block.matcher ?? ""}\0${h.command}`);
          // Owned entry pointing at a path that no longer exists or not desired -> stale
          const m = h.command.match(/"([^"]+)"/);
          const p = m ? m[1] : "";
          if ((p && !fs.existsSync(p)) || !desiredCmds.has(h.command))
            staleOwned++;
        } else {
          preservedForeign++;
        }
      }
    }
  }

  const add = desired
    .filter((d) => !existingKeys.has(`${d.event}\0${d.matcher ?? ""}\0${d.command}`))
    .map(({ event, command, matcher, timeout }) => ({ event, command, matcher, timeout }));
  return {
    targetFile: hooksFilePath(),
    add,
    remove: [],
    preservedForeignEntries: preservedForeign,
    staleOwnedEntries: staleOwned,
  };
}

export interface SetupResult {
  changed: boolean;
  diff: PlanDiff;
  registrationPath: string;
}

/** Apply the idempotent setup. Returns what changed. Never runs installers. */
export function setupHooks({
  dryRun = false,
  root = pluginRoot(),
}: {
  dryRun?: boolean;
  root?: string;
} = {}): SetupResult {
  // Fail loud when the handler scripts are not resolvable at this root.
  for (const d of desiredEntries(root)) {
    const m = d.command.match(/"([^"]+)"/);
    const p = m ? m[1] : "";
    if (!p || !fs.existsSync(p)) {
      throw new Error(
        `handler not found: ${p || d.command}\n` +
          "Build first: npm install && npm run build (never run automatically)",
      );
    }
  }

  const file = hooksFilePath();
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const hooks = readHooksFile(file);
  const diff = planSetup(root);

  if (!dryRun) {
    const desired = desiredEntries(root);
    const desiredKeys = new Set(
      desired.map((d) => `${d.event}\0${d.matcher ?? ""}\0${d.command}`),
    );
    // Prune owned entries whose registered path no longer exists (plugin
    // relocation / cache-version bump) or that are not in desired commands,
    // then re-add at the current root.
    if (hooks.hooks)
      for (const event of HOOK_EVENTS) {
        const blocks = hooks.hooks?.[event];
        if (!Array.isArray(blocks)) continue;
        for (const block of blocks) {
          if (!block.hooks) continue;
          block.hooks = block.hooks.filter((h) => {
            if ((h as Record<string, unknown>)[OWNERSHIP_KEY] !== true)
              return true;
            const m = h.command ? h.command.match(/"([^"]+)"/) : null;
            if (m && !fs.existsSync(m[1])) return false;
            return desiredKeys.has(
              `${event}\0${block.matcher ?? ""}\0${h.command ?? ""}`,
            );
          });
        }
        hooks.hooks[event] = blocks.filter((b) => (b.hooks ?? []).length > 0);
        if (
          (hooks.hooks[event] as HookMatcherBlock[] | undefined)?.length === 0
        )
          delete hooks.hooks[event];
      }
  }

  if (!dryRun && diff.add.length > 0) {
    if (!hooks.hooks) hooks.hooks = {};
    for (const { event, command, async, matcher, timeout } of desiredEntries(root).filter((x) =>
      diff.add.some((a) =>
        a.event === x.event && a.command === x.command &&
        (a.matcher ?? "") === (x.matcher ?? "")),
    )) {
      if (!hooks.hooks[event]) hooks.hooks[event] = [];
      let block = (hooks.hooks[event] as HookMatcherBlock[]).find(
        (b) => (b.matcher ?? "") === (matcher ?? ""),
      );
      if (!block) {
        block = { matcher: matcher ?? "", hooks: [] };
        (hooks.hooks[event] as HookMatcherBlock[]).push(block);
      }
      if (!block.hooks) block.hooks = [];
      block.hooks.push({
        type: "command",
        command,
        ...({ [OWNERSHIP_KEY]: true } as object),
        ...(async ? { async: true } : {}),
        ...(timeout ? { timeout } : {}),
      });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeHooksFile(hooks), { mode: 0o644 });
  }

  // Persist/refresh the ownership record regardless (cheap, local).
  const reg: LifecycleRegistration = {
    schemaVersion: 2,
    installedAt: new Date().toISOString(),
    pluginRoot: root,
    codexHome: codexHome(),
    hooksFile: file,
    entries: desiredEntries(root).map(({ event, command, ...rest }) => ({
      event,
      command,
      fingerprint: fingerprintOf(command),
      ...rest,
    })),
  };
  const after = dryRun
    ? before
    : fs.existsSync(file)
      ? fs.readFileSync(file, "utf8")
      : "";
  if (!dryRun) {
    fs.writeFileSync(registrationPath(), JSON.stringify(reg, null, 2) + "\n");
  }
  const changed = !dryRun && after !== before;
  return { changed, diff, registrationPath: registrationPath() };
}

export interface RemoveResult {
  removed: number;
  preservedForeignEntries: number;
  dryRun: boolean;
}

/** Remove only Memex-owned entries (exact fingerprint match). */
export function removeHooks({
  dryRun = false,
}: {
  dryRun?: boolean;
} = {}): RemoveResult {
  const file = hooksFilePath();
  const owned = new Set<string>();
  try {
    const reg = JSON.parse(
      fs.readFileSync(registrationPath(), "utf8"),
    ) as LifecycleRegistration;
    for (const e of reg.entries) owned.add(e.command);
  } catch {
    /* no registration record: fall back to ownership flag */
  }
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const hooks = readHooksFile(file);
  let removed = 0;
  let preservedForeign = 0;

  if (hooks.hooks) {
    for (const event of Object.keys(hooks.hooks)) {
      const blocks = hooks.hooks[event];
      if (!Array.isArray(blocks)) continue;
      const keptBlocks: HookMatcherBlock[] = [];
      for (const block of blocks) {
        const kept: HookEntry[] = [];
        for (const h of block.hooks ?? []) {
          const isOurs =
            (h as Record<string, unknown>)[OWNERSHIP_KEY] === true ||
            (typeof h.command === "string" && owned.has(h.command));
          if (isOurs) removed++;
          else {
            kept.push(h);
            if (typeof h.command === "string") preservedForeign++;
          }
        }
        // Keep foreign matcher blocks untouched; drop blocks we emptied.
        if (kept.length > 0 || (block.hooks?.length ?? 0) === 0) {
          keptBlocks.push(
            kept.length === (block.hooks?.length ?? 0)
              ? block
              : { ...block, hooks: kept },
          );
        }
      }
      if (keptBlocks.length > 0) hooks.hooks[event] = keptBlocks;
      else delete hooks.hooks[event];
    }
    if (Object.keys(hooks.hooks).length === 0) delete hooks.hooks;
  }

  const serialized = serializeHooksFile(hooks);
  const changed = !dryRun && serialized !== before;
  if (changed) {
    fs.writeFileSync(file, serialized, { mode: 0o644 });
    try {
      fs.rmSync(registrationPath(), { force: true });
    } catch {
      /* ignore */
    }
  }
  // `removed` is the observed/would-observe count in both dry-run and apply.
  void dryRun;
  return { removed, preservedForeignEntries: preservedForeign, dryRun };
}

export interface DoctorReport {
  json: unknown[];
  overall: "PASS" | "PARTIAL" | "FAIL";
}

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function trustStateLines(): string[] {
  try {
    const cfg = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8");
    return cfg.split("\n").filter((l) => l.trim().startsWith("[hooks.state."));
  } catch {
    return [];
  }
}
function hasTrustFor(_event: HookEvent): boolean {
  return trustStateLines().some((l) => l.includes(hooksFilePath()));
}
function trustedEventsConfigured(): boolean {
  return trustStateLines().length > 0;
}

function pluginManagedHookEvents(): HookEvent[] {
  try {
    const root = pluginRoot();
    const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
    if (!fs.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      hooks?: unknown;
    };
    if (typeof manifest.hooks !== "string") return [];
    const hookPath = path.resolve(root, manifest.hooks);
    if (!hookPath.startsWith(root + path.sep) || !fs.existsSync(hookPath))
      return [];
    const config = JSON.parse(fs.readFileSync(hookPath, "utf8")) as HooksFile;
    return HOOK_EVENTS.filter(
      (event) =>
        Array.isArray(config.hooks?.[event]) && config.hooks[event]!.length > 0,
    );
  } catch {
    return [];
  }
}

/** How many recent injection-log lines the injection checks read. */
const INJECT_LOG_WINDOW = 20;

interface InjectLogLine {
  status?: string;
  via?: string;
  ts?: string;
  error?: string;
  injected?: number;
  candidates?: number;
  lexical_lane?: string;
  [key: string]: unknown;
}

/** Parse the tail of the injection log; malformed lines are skipped, never thrown. */
function readInjectLogTail(limit: number): InjectLogLine[] {
  try {
    const logPath = getInjectLogPath();
    if (!fs.existsSync(logPath)) return [];
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const out: InjectLogLine[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") out.push(parsed as InjectLogLine);
      } catch {
        /* a truncated tail line is not a diagnosis */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Count rows without importing the heavy db.js chain; null when unreadable. */
function countRows(table: string): number | null {
  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return null;
    const Database = runtimeRequire("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      if (!exists) return null;
      return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Issue #41 — `IndexRepairError` says "manual repair required", and that
 * sentence used to live only in logs/backfill-ontology.log, a file no
 * diagnostic reads. Read its durable marker with the same lightweight
 * connection countRows uses (never the heavy db.js chain).
 */
function readOntologyIndexRepairMarker(): {
  blocked: boolean;
  reason: string | null;
  detectedAt: string | null;
} | null {
  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) return null;
    const Database = runtimeRequire("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'ontology_index_repair_state'")
        .get();
      if (!exists) return null;
      const row = db
        .prepare("SELECT state, blocked_reason, detected_at FROM ontology_index_repair_state WHERE id = 1")
        .get() as { state: string; blocked_reason: string | null; detected_at: string | null } | undefined;
      if (!row) return { blocked: false, reason: null, detectedAt: null };
      return {
        blocked: row.state === "blocked",
        reason: row.blocked_reason ?? null,
        detectedAt: row.detected_at ?? null,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Issue #44 — the injection log and `recall_events` can diverge completely.
 *
 * The observed data root emitted 7 bundles (`status: "injected"`) and held 0
 * `recall_events` rows, with no privacy purge to explain it. Every emission is
 * supposed to be backed by a durable `prepared` receipt
 * (RETRIEVAL-AND-CONTEXT.md §43-48), so post-hoc audit — which fact entered
 * which session, when — was impossible. Nothing compared the two numbers.
 */
function recallProvenanceCheck(recent: InjectLogLine[]): Check {
  const emitted = recent.filter(
    (entry) => entry.status === "injected" || entry.status === "context-only",
  ).length;
  const receiptFailures = recent.filter((entry) => entry.status === "receipt-failed").length;
  const receipts = countRows("recall_events");
  if (receipts === null) {
    return {
      name: "recall-provenance",
      status: emitted > 0 ? "warn" : "ok",
      detail:
        emitted > 0
          ? `${emitted} emitted bundle(s) in the last ${recent.length} log lines but recall_events is unreadable`
          : "no recall_events table yet (no injection observed)",
    };
  }
  if (receiptFailures > 0) {
    return {
      name: "recall-provenance",
      status: "fail",
      detail:
        `${receiptFailures} of the last ${recent.length} injections emitted context whose recall receipt stayed 'prepared' ` +
        `(recall_events rows=${receipts}). Post-hoc audit of those emissions is impossible.`,
    };
  }
  if (emitted > 0 && receipts === 0) {
    return {
      name: "recall-provenance",
      status: "fail",
      detail:
        `${emitted} emitted bundle(s) in the last ${recent.length} log lines but recall_events is empty — ` +
        "the injection provenance contract is broken (no privacy purge explains an empty table).",
    };
  }
  if (emitted > receipts) {
    return {
      name: "recall-provenance",
      status: "warn",
      detail: `${emitted} emitted bundle(s) in the last ${recent.length} log lines vs ${receipts} recall_events row(s)`,
    };
  }
  return {
    name: "recall-provenance",
    status: "ok",
    detail: `${receipts} recall_events row(s) back ${emitted} emitted bundle(s) in the last ${recent.length} log lines`,
  };
}

/** A run that produced no facts, whatever else it emitted. */
const ZERO_FACT_STATUSES = new Set(["context-only", "no-match", "deduped"]);
/** Consecutive zero-fact runs before the pipeline is reported as not delivering. */
const ZERO_FACT_STREAK_LIMIT = 8;

/**
 * Issue #32 — "the memory system is running" was indistinguishable from
 * "no fact has ever been injected".
 *
 * The observed data root ran the pipeline 12 times over five days: candidates
 * = 5 every time, injected facts = 0 every time, sum of `injected_facts`
 * telemetry = 0. Seven of those runs emitted a bundle (Capsule or assistant
 * context) and were logged as `injected`, so the number of injected facts was
 * unreadable from the log. Doctor read only the LAST line, whose `no-match`
 * status is a normal outcome, and reported `inject-output: ok`.
 */
function injectionYieldCheck(recent: InjectLogLine[]): Check {
  const retrievals = recent.filter(
    (entry) =>
      entry.status === "injected" ||
      ZERO_FACT_STATUSES.has(String(entry.status)),
  );
  if (retrievals.length === 0) {
    return {
      name: "injection-yield",
      status: "ok",
      detail: "no retrieval recorded yet in the injection log",
    };
  }
  const facts = retrievals.reduce((sum, entry) => sum + Number(entry.injected ?? 0), 0);
  let streak = 0;
  for (let i = retrievals.length - 1; i >= 0; i--) {
    if (Number(retrievals[i].injected ?? 0) > 0) break;
    streak++;
  }
  const contextOnly = retrievals.filter((entry) => entry.status === "context-only").length;
  const lexicalDead = recent.filter((entry) => entry.lexical_lane === "unavailable").length;
  const suffix =
    (contextOnly > 0 ? ` context-only=${contextOnly}` : "") +
    (lexicalDead > 0 ? ` lexical_lane=unavailable×${lexicalDead}` : "");
  if (streak >= ZERO_FACT_STREAK_LIMIT && facts === 0) {
    return {
      name: "injection-yield",
      status: "warn",
      detail:
        `${streak} consecutive retrievals injected 0 facts (candidates were found).` +
        `${suffix} Inspect the relevance gate: telemetry metric baseline_margin_gap, ` +
        "override MEMEX_INJECT_BASELINE_MARGIN.",
    };
  }
  return {
    name: "injection-yield",
    status: lexicalDead > 0 ? "warn" : "ok",
    detail:
      `${facts} fact(s) injected across the last ${retrievals.length} retrieval(s), current zero-fact streak ${streak}.${suffix}`,
  };
}

/**
 * Who owns the injection fast-path socket, and is it this installation (#84)?
 *
 * Read-only by construction: the probe asks for an identity, never for an
 * injection, so running `doctor` cannot produce a recall receipt or a log line.
 *
 * Observed on the real data root: a development checkout's MCP server, started
 * by another host from a pre-0.6.0 `dist`, held the socket and answered every
 * prompt the 0.6.2 hook sent. Nothing in `doctor` or `status` showed it — this
 * check exists so that state is visible instead of inferred from odd log lines.
 */
async function injectDaemonCheck(): Promise<Check> {
  const name = "inject-daemon";
  let daemon: typeof import("./inject-daemon.js");
  try {
    // Dynamic: keeps the injection core (and the embedding model chain) off
    // every other doctor check's import path.
    daemon = await import("./inject-daemon.js");
  } catch (error) {
    return {
      name, status: "warn",
      detail: `unable to inspect the inject daemon: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const policy = daemon.injectDaemonPolicy();
  // The identity that MATTERS is the one `scripts/inject-context.js` computes,
  // and that script runs from the INSTALLED root. This process is frequently not
  // that root: `~/.local/bin/memex` is an npx shim (issue #53), so judging the
  // owner against doctor's own copy would report a perfectly healthy
  // installation as "a different build" and point the operator at a pid to kill.
  // `probeCodex: true` is allowed here — a diagnostic may spawn.
  const installedRoot = (() => {
    try {
      return resolveInstalledPluginRoot({ fallbackRoot: pluginRoot(), probeCodex: true }).root;
    } catch {
      return pluginRoot();
    }
  })();
  const expected = daemon.injectDaemonIdentityFor(installedRoot);
  const self = daemon.injectDaemonIdentity();
  const where =
    `socket ${daemon.injectSocketPath()}; hooks run from ${expected.pluginRoot} ` +
    `(version ${expected.version ?? "unknown"})` +
    (self.pluginRoot === expected.pluginRoot
      ? ""
      : `; this diagnostic runs from ${self.pluginRoot}`) +
    `; listener here ${policy.open ? "on" : "off"}: ${policy.reason}`;
  let probe: Awaited<ReturnType<typeof daemon.probeInjectDaemon>>;
  try {
    probe = await daemon.probeInjectDaemon(
      undefined,
      daemon.INJECT_DAEMON_DIAGNOSTIC_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      name, status: "warn",
      detail: `could not probe the inject daemon: ${error instanceof Error ? error.message : String(error)} — ${where}`,
    };
  }
  if (!probe.listening) {
    // Issue #89 split this. `no daemon` used to cover both "nothing has started
    // yet", which is ordinary, and "the owner exited and left its socket file
    // behind", which on the observed data root meant every prompt paid the 70s
    // cold path for as long as the host kept running — and was reported as ok.
    if (probe.code === "ENOENT") {
      return {
        name, status: "ok",
        detail: `absent — no socket file; every prompt pays the cold in-process path (~2.3s). ${where}`,
      };
    }
    const candidates = daemon.readInjectDaemonCandidates();
    const stale =
      `stale — a socket file exists but nothing listens on it (${probe.code ?? "unreachable"}): ` +
      `its owner exited. Every prompt pays the cold in-process path (~2.3s) until it is reclaimed.`;
    if (candidates.length === 0) {
      return {
        name, status: "warn",
        detail:
          `${stale} NO live MCP server is waiting to reclaim it, so nothing will: start a host with this ` +
          `plugin (or restart the one you have) to reopen the fast path. ${where}`,
      };
    }
    const who = candidates
      .map((candidate) =>
        `pid ${candidate.pid} version ${candidate.version ?? "unknown"} root ${candidate.pluginRoot}` +
        (candidate.reprobeMs > 0 ? ` (re-probes every ${candidate.reprobeMs}ms)` : ""))
      .join("; ");
    return {
      name, status: "ok",
      detail:
        `${stale} Reacquisition is pending — ${candidates.length} live server(s) re-probe it on a timer and ` +
        `on their next MCP request: ${who}. ${where}`,
    };
  }
  // A pid identifies the WHOLE MCP server, not a daemon thread: stopping it
  // stops that host's memory tools too, and pids are reused, so the advice
  // always names the build as well.
  const pidNote = "the pid is the whole MCP server process (stopping it affects that host's Memex tools), and pids can be reused — confirm the owner before acting";
  if (!probe.owner) {
    return {
      name, status: "warn",
      detail:
        `hung — a listener holds the socket but did not identify itself within ` +
        `${daemon.INJECT_DAEMON_DIAGNOSTIC_TIMEOUT_MS}ms (${probe.problem ?? "no answer"}). ` +
        `Hooks fall back in-process, so injection is correct but slow until it exits. ${pidNote}. ${where}`,
    };
  }
  const owner = probe.owner;
  const ownerNote =
    `owner pid ${owner.pid} version ${owner.version ?? "unknown"} build ${owner.buildId ?? "unknown"} ` +
    `root ${owner.pluginRoot} db ${owner.dbPath} started ${owner.startedAt || "unknown"}`;
  if (daemon.injectDaemonIdentityMatches(expected, owner)) {
    // Issue #92: a 0.6.5+ owner says whether it is still loading the embedding
    // model. That is a transient start-up state of a CORRECT owner — prompts
    // that arrive inside it are answered `warming` in microseconds and fall back
    // in-process — so it is reported, never counted as a daemon problem.
    if (owner.warming) {
      return {
        name, status: "ok",
        detail:
          `ok — served by this installation, still warming its embedding model: prompts fall back ` +
          `in-process (logged daemon.reason=warming) until it finishes. On a cold model cache this ` +
          `is the 129 MB download — run: memex deps warm — ${ownerNote}. ${where}`,
      };
    }
    return { name, status: "ok", detail: `ok — served by this installation — ${ownerNote}. ${where}` };
  }
  return {
    name, status: "warn",
    detail:
      `mismatch — the socket is owned by a DIFFERENT build, so the fast path is refused and every prompt ` +
      `falls back in-process: ${ownerNote}. ${pidNote}. ${where}`,
  };
}

/**
 * Issue #92 — is the embedding model on disk, and where?
 *
 * The state this reports was completely invisible. On the observed data root the
 * model cache lived inside each plugin root's `node_modules`, so every update
 * started cold and the next six prompts took 68-74s each while `doctor` reported
 * every check green. Nothing said "the 129 MB is missing and the first prompt
 * will pay for it".
 *
 * Read-only and library-free: `./model-cache.js` needs node builtins only, so
 * this answers even on a host whose runtime closure is missing — which is exactly
 * when a cold cache is most likely.
 */
function embeddingCacheCheck(): Check {
  const name = "embedding-cache";
  let status: ReturnType<typeof embeddingCacheStatus>;
  try {
    status = embeddingCacheStatus();
  } catch (error) {
    return {
      name, status: "warn",
      detail: `unable to resolve the embedding model cache: ${
        error instanceof Error ? error.message : String(error)}`,
    };
  }
  const where = `cache ${status.dir} (via ${status.source}), model ${status.model}`;
  if (status.stub) {
    return {
      name, status: "ok",
      detail:
        `stub — MEMEX_EMBEDDING_STUB=1 replaces the model with a deterministic vector, so no weights ` +
        `are needed. ${where}`,
    };
  }
  if (status.present) {
    return {
      name, status: "ok",
      detail:
        `ok — ${formatCacheBytes(status.bytes)} in ${status.files} file(s) at ${status.modelDir}. ` +
        `It lives in the data root, so plugin updates keep it. ${where}`,
    };
  }
  // A legacy per-root cache means the first model load will COPY rather than
  // download, which is seconds instead of a minute — worth saying, because it
  // changes what the user should expect from the advice.
  const legacy = (() => {
    try {
      return legacyEmbeddingCacheCandidates();
    } catch {
      return [];
    }
  })();
  const partial = status.files > 0
    ? ` ${status.modelDir} holds ${status.files} file(s) / ${formatCacheBytes(status.bytes)} but no usable weights (an interrupted download).`
    : "";
  return {
    name, status: "warn",
    detail:
      `missing — the embedding model is not cached, so the first prompt will be slow (~68s for the ` +
      `129 MB download; measured) and a session's daemon and its hook fallback can download it at the ` +
      `same time. Run: memex deps warm.${partial}` +
      (legacy.length > 0
        ? ` A pre-0.6.5 per-root cache exists at ${legacy[0].cacheDir} (${legacy[0].kind}) and is COPIED ` +
          `on first use, so warming should take seconds rather than a download.`
        : "") +
      ` ${where}`,
  };
}

/** Read-only diagnosis. Distinguishes configured vs observed. */
export async function doctor(): Promise<DoctorReport> {
  const checks: Check[] = [];

  // Dependency + build readiness (report-only; never auto-install).
  // Issue #40: check the INSTALLED plugin root, not the running process. A
  // marketplace install whose dependencies were never materialized has no
  // node_modules beside the launcher, so every hook falls back to
  // `npx github:BongSuCHOI/memex#main` — an unpinned revision. Resolving from
  // the running process passes inside that very npx copy, which is exactly the
  // state this check has to report.
  // Issue #53: the running process is frequently the npx cache copy itself
  // (`~/.local/bin/memex` is an npx shim), so `__dirname/..` named the WRONG
  // root and reported a failure that belonged to nothing. Resolution now lives
  // in src/plugin-root.ts, shared with `memex install`, `memex deps
  // materialize` and the cli/runtime-exec.js fallback message.
  const installed = resolveInstalledPluginRoot({
    fallbackRoot: pluginRoot(),
    probeCodex: true,
  });
  const dependencyRoot = installed.root;
  const missingAtPluginRoot = missingRuntimeDependencies(dependencyRoot);
  const resolvableHere = RUNTIME_DEPENDENCIES.every((dependency) => {
    try {
      runtimeRequire.resolve(dependency);
      return true;
    } catch {
      return false;
    }
  });
  // Issue #69: say when the root came from the cache scan while the cache held
  // more than one version — that pick is keyed on the running copy's version,
  // not on what Codex loaded, so the operator has to see the ambiguity.
  const ambiguousCache =
    installed.source === "codex-cache" && installed.cacheVersions.length > 1
      ? `, ${installed.cacheVersions.length} cached versions (${installed.cacheVersions.join(", ")})` +
        " — codex plugin list --json did not answer, so this root is the closest match, not a confirmed load"
      : "";
  const rootNote =
    `installed plugin root ${dependencyRoot} (via ${installed.source}` +
    (installed.version ? `, version ${installed.version}` : "") +
    ambiguousCache +
    ")";
  checks.push({
    name: "dependencies",
    status: missingAtPluginRoot.length === 0 ? "ok" : "fail",
    detail:
      missingAtPluginRoot.length === 0
        ? `runtime dependencies materialized at ${path.join(dependencyRoot, "node_modules")} — ${rootNote}`
        : `missing at ${path.join(dependencyRoot, "node_modules")}: ${missingAtPluginRoot.join(", ")} — ` +
          "every hook silently falls back to npx github:BongSuCHOI/memex#main (an unpinned revision) — " +
          `run: memex deps materialize --root "${dependencyRoot}" (or run: memex install) — ${rootNote}` +
          (resolvableHere
            ? " (this process resolved them elsewhere, i.e. from the npx copy rather than the pinned plugin)"
            : ""),
  });
  const distEntry = fs.existsSync(path.join(pluginRoot(), "dist", "db.js"));
  checks.push({
    name: "build",
    status: distEntry ? "ok" : "fail",
    detail: distEntry
      ? "dist/ present"
      : `missing — run: cd ${pluginRoot()} && npm run build`,
  });

  // Codex home + hooks file
  const file = hooksFilePath();
  const hooks = readHooksFile(file);
  const foundCommands = new Set<string>();
  if (hooks.hooks) {
    for (const event of HOOK_EVENTS) {
      for (const block of hooks.hooks[event] ?? []) {
        for (const h of block.hooks ?? []) {
          if (typeof h.command === "string") foundCommands.add(h.command);
        }
      }
    }
  }
  const configuredEvents = HOOK_EVENTS.filter((ev) =>
    LIFECYCLE_COMMANDS[ev].every((c) =>
      foundCommands.has(commandFor(pluginRoot(), c)),
    ),
  );
  const pluginEvents = pluginManagedHookEvents();
  const activeEvents = [...new Set([...configuredEvents, ...pluginEvents])];
  checks.push({
    name: "codex-home",
    status: fs.existsSync(codexHome()) ? "ok" : "fail",
    detail: codexHome(),
  });
  checks.push({
    name: "lifecycle-configured",
    status:
      activeEvents.length === HOOK_EVENTS.length
        ? "ok"
        : activeEvents.length > 0
          ? "warn"
          : "fail",
    detail:
      pluginEvents.length === HOOK_EVENTS.length
        ? `${pluginEvents.join(", ")} (plugin manifest)`
        : configuredEvents.length
          ? `${configuredEvents.join(", ")} (${file})`
          : `not configured — run: memex setup-hooks`,
  });
  const observedDetail = HOOK_EVENTS.map((ev) => {
    const ts = lastObserved(ev);
    return `${ev}: ${ts ? `observed ${ts}` : "never observed"}`;
  }).join("; ");
  checks.push({
    name: "lifecycle-observed",
    status: HOOK_EVENTS.every((ev) => lastObserved(ev)) ? "ok" : "warn",
    detail: observedDetail,
  });
  // Inject output parse/consumption — distinguishes valid injection vs error vs no-match
  //
  // Issue #84: the `inject-daemon` check probes the socket, and a pre-0.6.3
  // daemon answers that probe by running `computeInjectContext("")`, which
  // appends `status:"no-session-provenance", via:"daemon", prompt_len:0`. Left
  // in, the NEXT `memex doctor` would read that line as the log tail and warn
  // about a line doctor itself wrote. A real prompt is never empty — the hook
  // returns before any daemon call for a blank prompt — so an empty-prompt
  // provenance line can only be a probe artifact, and is dropped here.
  const recent = readInjectLogTail(INJECT_LOG_WINDOW).filter((entry) =>
    !(entry.status === "no-session-provenance" && Number(entry.prompt_len ?? 0) === 0));
  try {
    const logPath = getInjectLogPath();
    if (fs.existsSync(logPath)) {
      const last = recent.length ? recent[recent.length - 1] : null;
      if (last) {
        const okStatuses: Record<string, true> = {
          injected: true,
          "no-match": true,
          deduped: true,
          skipped: true,
        };
        // Issue #44: a broken provenance receipt is a contract violation, not a
        // benign outcome. It used to exist only on a hook's discarded stderr.
        const receiptFailures = recent.filter((entry) => entry.status === "receipt-failed").length;
        const failing = last.status === "error" || last.status === "receipt-failed";
        checks.push({
          name: "inject-output",
          status: failing
            ? "fail"
            : okStatuses[String(last.status)]
              ? receiptFailures > 0
                ? "warn"
                : "ok"
              : "warn",
          detail:
            `${last.status} via=${last.via ?? "unknown"} ${last.ts ?? ""} ${last.error ? `error=${String(last.error).slice(0, 80)}` : ""}`.trim() +
            (receiptFailures > 0
              ? ` — ${receiptFailures}/${recent.length} recent runs emitted context with no durable recall receipt`
              : ""),
        });
      } else {
        checks.push({
          name: "inject-output",
          status: "warn",
          detail: "inject log empty — no UserPromptSubmit observed yet",
        });
      }
    } else {
      checks.push({
        name: "inject-output",
        status: "warn",
        detail: "no inject log yet — UserPromptSubmit not yet observed",
      });
    }
  } catch {
    checks.push({
      name: "inject-output",
      status: "warn",
      detail: "unable to read inject log",
    });
  }
  checks.push(recallProvenanceCheck(recent));
  checks.push(injectionYieldCheck(recent));
  checks.push(embeddingCacheCheck());
  checks.push(await injectDaemonCheck());
  // Persisted hook trust lives in config.toml [hooks.state."<file>:<event>:…"].
  let trustedEntries = 0;
  const configToml = path.join(codexHome(), "config.toml");
  try {
    if (fs.existsSync(configToml)) {
      const marker = `hooks.state.`;
      let section = false;
      for (const line of fs.readFileSync(configToml, "utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("[")) {
          section = t.includes(marker) && t.includes(hooksFilePath());
          if (section) trustedEntries++;
        }
      }
      void section;
    }
  } catch {
    /* unreadable config: treat as untrusted */
  }
  checks.push({
    name: "hook-trust",
    status: trustedEventsConfigured()
      ? configuredEvents.every((ev) => hasTrustFor(ev))
        ? "ok"
        : "warn"
      : "warn",
    detail:
      trustedEntries > 0
        ? `${trustedEntries} trusted hook state entries reference ${hooksFilePath()}`
        : "no persisted hook trust found in config.toml — Codex will prompt for trust on the next session start",
  });
  checks.push({
    name: "mcp-manifest",
    status: fs.existsSync(
      path.join(pluginRoot(), ".codex-plugin", "plugin.json"),
    )
      ? "ok"
      : "fail",
    detail: ".codex-plugin/plugin.json present (MCP servers declared there)",
  });

  // Issue #41: the ontology category vec index can be broken in a way
  // self-heal cannot fix. Classification then stops entirely while status
  // used to keep printing `Ontology: READY`.
  const ontologyRepair = readOntologyIndexRepairMarker();
  if (ontologyRepair) {
    checks.push({
      name: "ontology-index",
      status: ontologyRepair.blocked ? "fail" : "ok",
      detail: ontologyRepair.blocked
        ? `ontology category index repair FAILED (${ontologyRepair.reason ?? "unknown"}${
            ontologyRepair.detectedAt ? `, detected ${ontologyRepair.detectedAt}` : ""
          }) — classification is blocked; rebuild vectors: memex backfill embeddings`
        : "ontology category index reconciled",
    });
  }

  // P2-6: the last sync export attempt is recorded durably by the
  // SessionEnd chain — a failed export must surface here instead of
  // disappearing behind the hook's exit 0.
  try {
    // Issue #35: "no status file" used to be reported as ok with the advice to
    // wait for a SessionEnd — but no hook ever invoked the exporter, so that
    // was a wiring failure reported as health. The check now distinguishes
    // three states: off (skipped, not a warning — #48 decision 5), on but never
    // exported (warn), and on with a recorded result (ok/fail). It also
    // verifies the export script is actually registered in a lifecycle event.
    const syncConfig = readSyncConfig();
    const exportStatus = readExportStatus();
    const registered = isLifecycleScriptRegistered(SYNC_LIFECYCLE_SCRIPTS.export);
    if (!syncConfig.enabled) {
      checks.push({
        name: "sync-export",
        status: "ok",
        detail:
          `skipped(off) — cross-device sync is disabled; enable it with: ` +
          `memex sync enable --dir <shared folder>`,
      });
    } else if (!registered) {
      checks.push({
        name: "sync-export",
        status: "warn",
        detail:
          `sync is enabled but ${SYNC_LIFECYCLE_SCRIPTS.export} is not registered in any hook — ` +
          "nothing exports automatically; run: memex sync export",
      });
    } else if (!exportStatus) {
      checks.push({
        name: "sync-export",
        status: "warn",
        detail:
          `sync is enabled (shared folder ${resolveSyncDir(syncConfig)}) but nothing has been ` +
          "exported yet — run: memex sync export, or end one session to trigger the SessionEnd export",
      });
    } else {
      checks.push({
        name: "sync-export",
        status: exportStatus.ok ? "ok" : "fail",
        detail: exportStatus.ok
          ? `last export ok at ${exportStatus.at} (shared folder ${resolveSyncDir(syncConfig)})`
          : `last export FAILED at ${exportStatus.at}: ${exportStatus.error ?? "unknown"}`,
      });
    }
  } catch {
    checks.push({
      name: "sync-export",
      status: "warn",
      detail: "unable to read sync export status",
    });
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const allOk = checks.every((c) => c.status === "ok");
  return {
    json: checks.map(({ name, status, detail }) => ({ name, status, detail })),
    overall: hasFail ? "FAIL" : allOk ? "PASS" : "PARTIAL",
  };
}
