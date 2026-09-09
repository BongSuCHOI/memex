#!/usr/bin/env node

/**
 * Stage 8 — bounded, four-arm Codex memory comparison.
 *
 * The harness deliberately keeps three observations separate:
 *   1. configuration and preparation (what was enabled/emitted),
 *   2. deterministic retrieval (what the production reader returned), and
 *   3. host consumption (what the Codex host actually accepted).
 *
 * It never edits the frozen fixture, the source rollout, or the source native
 * home. Every arm gets a fresh copy of the common initial snapshot. The
 * optional arm is cloned from the completed core preparation so its measured
 * increment is attributable to optional processing rather than a second fact
 * extraction run.
 *
 * Examples:
 *   node scripts/codex-memory-comparison.mjs --skip-host
 *   node scripts/codex-memory-comparison.mjs --run-host --keep
 *   node scripts/codex-memory-comparison.mjs --optional ontology,relations
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { estimateContextTokens } from "../dist/context-envelope.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DEFAULT = path.join(REPO, "test", "fixtures", "codex-usability.json");
const EXPECTED_FIXTURE_SHA = "fc84bf57a8cd1bf4e6f714053dc21c1c886c562ea58bac5fb5e4ccc794628a98";
const DEFAULT_ROOT = "/private/tmp/memex-comparison-E7b4Kt";
const EXPECTED_MANIFEST_SHA = "851c0d2fd7de5c490424912a406ad6422694e0fffead665636576277dcca6a99";
const HOST_OUTPUT_SCHEMA = path.join(REPO, "test", "fixtures", "codex-usability-output-schema.json");
const DEFAULT_MAX_CALLS = 32;
const DEFAULT_TIMEOUT_MS = 180_000;

function option(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const ROOT = path.resolve(option("root", DEFAULT_ROOT));
const FIXTURE = path.resolve(option("fixture", FIXTURE_DEFAULT));
const INITIAL_STATE = path.resolve(option("initial-state", path.join(ROOT, "initial-state")));
const INITIAL_MANIFEST = path.resolve(option("manifest", path.join(ROOT, "initial-state-manifest.json")));
const NATIVE_HOME = path.resolve(option("native-home", path.join(ROOT, "native")));
const PROJECT = path.resolve(option("project", path.join(ROOT, "project")));
const OUTPUT = path.resolve(option("out", path.join(REPO, "docs", "verification", "codex-usability", "comparison.json")));
const KEEP = process.argv.includes("--keep");
const RUN_HOST = process.argv.includes("--run-host") || process.env.MEMEX_COMPARISON_RUN_HOST === "1";
const MAX_CALLS = boundedInt(option("max-calls", process.env.MEMEX_COMPARISON_MAX_CALLS), DEFAULT_MAX_CALLS, 1, 32);
// Reserve two host operation slots (compaction and final query) from the
// Memex worker ledger. These are orchestration operations, not a provider-call
// cap: the host may issue multiple turns or tool calls during either operation.
const MODEL_MAX_CALLS = Math.max(1, MAX_CALLS - (RUN_HOST ? 2 : 0));
const TIMEOUT_MS = boundedInt(option("timeout-ms", process.env.MEMEX_COMPARISON_TIMEOUT_MS), DEFAULT_TIMEOUT_MS, 10_000, 300_000);
const LIFECYCLE_QUIET_MS = 1_500;
const OPTIONAL = (option("optional", "ontology,relations") || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const OWNED_ARM_ROOTS = new Set();

function boundedInt(raw, fallback, minimum, maximum) {
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return fallback;
  return Math.min(maximum, Math.max(minimum, Number(raw)));
}

function resolveCodexCommand() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "codex");
    try { if (fs.statSync(candidate).isFile() && (fs.statSync(candidate).mode & 0o111)) return candidate; }
    catch {}
  }
  return "codex";
}

const CODEX_COMMAND = resolveCodexCommand();

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
  return file && fs.existsSync(file) ? sha256Bytes(fs.readFileSync(file)) : "ABSENT";
}

function redacted(value) {
  return String(value ?? "")
    .replaceAll(ROOT, "<comparison-root>")
    .replaceAll(os.homedir(), "<user-home>")
    .replaceAll(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .slice(0, 1_000);
}

function copyTree(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function removeOwnedArmAuth() {
  for (const runRoot of OWNED_ARM_ROOTS) {
    const auth = path.join(runRoot, "codex-home", "auth.json");
    try { fs.rmSync(auth, { force: true }); } catch {}
  }
}

function makeNativeOverlaySource() {
  const overlay = fs.mkdtempSync(path.join(os.tmpdir(), "memex-comparison-native-overlay-"));
  copyTree(INITIAL_STATE, overlay);
  for (const entry of ["memories", "memories_1.sqlite", "memories_1.sqlite-shm", "memories_1.sqlite-wal", "models_cache.json"]) {
    const source = path.join(NATIVE_HOME, entry);
    if (!fs.existsSync(source)) continue;
    const target = path.join(overlay, entry);
    if (fs.statSync(source).isDirectory()) copyTree(source, target);
    else fs.copyFileSync(source, target);
  }
  return overlay;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseJsonLines(text) {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function findRollout(home, sessionId) {
  const sessions = path.join(home, "sessions");
  const found = [];
  if (!fs.existsSync(sessions)) return found;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const first = fs.readFileSync(full, "utf8").split("\n").slice(0, 12);
        if (first.some((line) => line.includes(sessionId))) found.push(full);
      }
    }
  };
  walk(sessions);
  return found;
}

function validateFrozenInputs() {
  if (!fs.existsSync(FIXTURE)) throw new Error(`fixture missing: ${FIXTURE}`);
  const fixtureBytes = fs.readFileSync(FIXTURE);
  const fixtureSha = sha256Bytes(fixtureBytes);
  if (fixtureSha !== EXPECTED_FIXTURE_SHA) {
    throw new Error(`frozen fixture SHA mismatch: ${fixtureSha} (expected ${EXPECTED_FIXTURE_SHA})`);
  }
  if (!fs.existsSync(INITIAL_MANIFEST)) throw new Error(`snapshot manifest missing: ${INITIAL_MANIFEST}`);
  if (!fs.existsSync(INITIAL_STATE)) throw new Error(`initial snapshot missing: ${INITIAL_STATE}`);
  const manifest = readJson(INITIAL_MANIFEST);
  // The supplied receipt hashes the canonical manifest object, not its
  // pretty-print whitespace. This keeps equivalent JSON serialization stable.
  const manifestSha = sha256Bytes(Buffer.from(JSON.stringify(manifest)));
  if (manifestSha !== EXPECTED_MANIFEST_SHA) {
    throw new Error(`snapshot manifest SHA mismatch: ${manifestSha} (expected ${EXPECTED_MANIFEST_SHA})`);
  }
  const missing = [];
  const mismatched = [];
  for (const [relative, expected] of Object.entries(manifest)) {
    const file = path.join(INITIAL_STATE, relative);
    if (!fs.existsSync(file)) missing.push(relative);
    else if (sha256File(file) !== expected) mismatched.push(relative);
  }
  if (missing.length || mismatched.length) {
    throw new Error(`snapshot manifest mismatch: missing=${missing.length} mismatched=${mismatched.length}`);
  }
  const fixture = JSON.parse(fixtureBytes);
  if (!Array.isArray(fixture.training) || fixture.training.length !== 8) {
    throw new Error("fixture must contain exactly eight training prompts");
  }
  return { fixture, fixtureSha, manifestSha, manifestFiles: Object.keys(manifest).length };
}

function runChild(command, args, env, timeout = TIMEOUT_MS, cwd = REPO, input = "") {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (input) { child.stdin.end(input); } else { child.stdin.end(); }
    let killTimer;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ status: null, signal: null, stdout, stderr, error: error.message, durationMs: Date.now() - started, timedOut: false });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ status, signal, stdout, stderr, error: null, durationMs: Date.now() - started, timedOut: signal === "SIGTERM" });
    });
  });
}

function envFor(home, memexHome, extra = {}) {
  return {
    CODEX_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    MEMEX_HOME: memexHome,
    MEMEX_ALLOWED_TRANSCRIPT_ROOTS: path.join(home, "sessions"),
    MEMEX_CONTINUITY_NO_WAKE: "1",
    MEMEX_LLM_RETRIES: "0",
    MEMEX_CODEX_MODEL: "gpt-5.6-luna",
    // Keep automatic local-derived ontology work out of the core arm. The
    // optional arm invokes its explicit backfill worker below.
    MEMEX_AUTO_ONTOLOGY: "0",
    MEMEX_MODEL_BUDGET_MAX_ATTEMPTS: String(MODEL_MAX_CALLS),
    MEMEX_MODEL_BUDGET_DEADLINE_MS: String(Math.min(TIMEOUT_MS * 2, 900_000)),
    MEMEX_MAX_EXTRACT_WINDOWS: "2",
    ...extra,
  };
}

// Keep the real-host compaction sequence local to this comparison harness. The
// compatibility harness records a broader lifecycle, while this client only
// needs the bounded resume -> compact -> close protocol required by each arm.
class ComparisonAppServerClient {
  constructor(label, home, memexHome, budgetId = null, parentWaveId = null) {
    this.label = label;
    this.home = home;
    this.memexHome = memexHome;
    this.budgetId = budgetId;
    this.parentWaveId = parentWaveId;
    this.messages = [];
    this.pending = new Map();
    this.buffer = "";
    this.nextId = 1;
    this.calls = 0;
    this.proc = null;
    this.exit = null;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
  }

  async start() {
    const hostExtra = { CWD: PROJECT, MEMEX_HOST_TRANSPORT: "app-server-stdio" };
    if (this.budgetId) hostExtra.MEMEX_MODEL_BUDGET_ID = this.budgetId;
    if (this.parentWaveId) hostExtra.MEMEX_MAINTENANCE_WAVE_ID = this.parentWaveId;
    this.proc = spawn(CODEX_COMMAND, ["app-server", "--listen", "stdio://"], {
      cwd: PROJECT,
      env: envFor(this.home, this.memexHome, hostExtra),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.consume(chunk));
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (error) => this.finish({ code: null, signal: null, error: error.message }));
    this.proc.on("exit", (code, signal) => this.finish({ code, signal }));
    await this.request("initialize", { clientInfo: { name: "memex-stage8-comparison", version: "0.1.0" } });
    this.notify("initialized", {});
  }

  finish(exit) {
    if (this.exit) return;
    this.exit = exit;
    this.resolveExit(exit);
    for (const pending of this.pending.values()) pending.reject(new Error(`${this.label}: app-server exited`));
    this.pending.clear();
  }

  consume(chunk) {
    this.buffer += String(chunk);
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      this.messages.push(message);
      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        const pending = this.pending.get(String(message.id));
        if (pending) {
          this.pending.delete(String(message.id));
          if (message.error) pending.reject(new Error(`${this.label} ${pending.method}: ${redacted(JSON.stringify(message.error))}`));
          else pending.resolve(message.result);
        } else if (message.method) {
          this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "stage8 harness declines server request" } });
        }
      }
    }
  }

  send(message) {
    if (!this.proc?.stdin?.writable) throw new Error(`${this.label}: app-server stdin is closed`);
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }

  request(method, params, timeout = TIMEOUT_MS) {
    if (++this.calls > 4) throw new Error(`${this.label}: app-server call ceiling exceeded`);
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`${this.label} ${method} timed out after ${timeout}ms`));
      }, timeout);
      this.pending.set(String(id), {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async waitForCompaction(since) {
    const started = Date.now();
    while (Date.now() - started < TIMEOUT_MS) {
      const messages = this.messages.slice(since);
      const item = messages.find((message) =>
        message.method === "item/completed" && message.params?.item?.type === "contextCompaction");
      if (item) {
        const turnId = item.params?.turnId || item.params?.item?.turnId;
        const completed = messages.find((message) =>
          message.method === "turn/completed" &&
          message.params?.turn?.status === "completed" &&
          (!turnId || message.params?.turn?.id === turnId));
        if (completed) {
          return {
            mode: "context-compaction-item",
            item: { type: item.params.item.type, id: item.params.item.id ?? null },
            turnCompleted: true,
            usage: completed.params?.turn?.usage ?? item.params?.item?.usage ?? null,
          };
        }
      }
      const failed = messages.find((message) =>
        message.method === "turn/completed" &&
        ["failed", "interrupted"].includes(message.params?.turn?.status));
      if (failed) {
        return {
          mode: "turn-completed-without-context-compaction",
          item: null,
          turnCompleted: false,
          turnStatus: failed.params.turn.status,
          error: failed.params.turn.error?.message ?? null,
          usage: failed.params.turn.usage ?? null,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${this.label} did not emit item/completed contextCompaction within ${TIMEOUT_MS}ms`);
  }

  async close() {
    if (!this.proc || this.exit) return this.exit;
    try { this.proc.stdin.end(); } catch {}
    await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!this.exit) this.proc.kill("SIGTERM");
    await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!this.exit) this.proc.kill("SIGKILL");
    await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    return this.exit;
  }
}

async function compactSession(home, memexHome, sessionId, budgetId = null, parentWaveId = null) {
  if (!RUN_HOST) return { status: "NOT_RUN", reason: "--run-host not provided" };
  const client = new ComparisonAppServerClient(`comparison-${path.basename(home)}`, home, memexHome, budgetId, parentWaveId);
  const messagesBefore = 0;
  try {
    await client.start();
    const resumed = await client.request("thread/resume", { threadId: sessionId, excludeTurns: true });
    const resumedId = resumed?.thread?.id || resumed?.threadId || null;
    if (resumedId && resumedId !== sessionId) throw new Error(`thread/resume returned ${resumedId}, expected ${sessionId}`);
    const compactStart = client.messages.length;
    await client.request("thread/compact/start", { threadId: sessionId });
    const evidence = await client.waitForCompaction(compactStart);
    return {
      status: evidence.turnCompleted ? "observed" : "NOT_PROVEN",
      protocol: "app-server stdio",
      sequence: ["thread/resume", "thread/compact/start", "close"],
      resumed: Boolean(resumedId || resumed),
      evidence,
      usage: evidence.usage ? {
        input_tokens: evidence.usage.input_tokens ?? null,
        output_tokens: evidence.usage.output_tokens ?? null,
        cached_input_tokens: evidence.usage.cached_input_tokens ?? null,
      } : null,
      appServerCalls: client.calls,
      close: await client.close(),
      messagesObserved: client.messages.length - messagesBefore,
    };
  } catch (error) {
    const close = await client.close();
    return {
      status: "NOT_PROVEN",
      protocol: "app-server stdio",
      sequence: ["thread/resume", "thread/compact/start", "close"],
      appServerCalls: client.calls,
      close,
      detail: redacted(error instanceof Error ? error.message : error),
    };
  }
}

function armConfig({ memories, hooks }) {
  return [
    'model = "gpt-5.6-luna"',
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    "[features]",
    `memories = ${memories ? "true" : "false"}`,
    `hooks = ${hooks ? "true" : "false"}`,
    "plugins = false",
    "[memories]",
    `generate_memories = ${memories ? "true" : "false"}`,
    `use_memories = ${memories ? "true" : "false"}`,
    "min_rollout_idle_hours = 1",
    "max_rollouts_per_startup = 1",
    "extract_model = \"gpt-5.6-luna\"",
    "consolidation_model = \"gpt-5.6-luna\"",
    "",
  ].join("\n");
}

function configureArm(home, memexHome, kind) {
  const memories = kind === "builtin";
  const hooks = kind === "core" || kind === "optional";
  fs.writeFileSync(path.join(home, "config.toml"), armConfig({ memories, hooks }));
  if (hooks) {
    fs.mkdirSync(memexHome, { recursive: true });
  }
  const auth = path.join(NATIVE_HOME, "auth.json");
  if (fs.existsSync(auth)) {
    fs.copyFileSync(auth, path.join(home, "auth.json"));
    fs.chmodSync(path.join(home, "auth.json"), 0o600);
  }
  return { memories, hooks, plugins: false, authCopied: fs.existsSync(path.join(home, "auth.json")) };
}

async function rewriteCodexStatePaths(home, sessionId, rolloutPath) {
  // The frozen state DB was copied from a different temporary root. Codex
  // otherwise follows its absolute rollout_path back into that source tree;
  // update only the copied target thread before any host operation.
  const code = `import { createRequire } from "node:module"; const require=createRequire(import.meta.url); const Database=require(${JSON.stringify(path.join(REPO, "node_modules", "better-sqlite3"))}); const db=new Database(${JSON.stringify(path.join(home, "state_5.sqlite"))}); try { const r=db.prepare("UPDATE threads SET rollout_path = ?, cwd = ? WHERE id = ?").run(${JSON.stringify(rolloutPath)}, ${JSON.stringify(PROJECT)}, ${JSON.stringify(sessionId)}); console.log(JSON.stringify({updated:r.changes, rolloutPath:${JSON.stringify(rolloutPath)}})); } finally { db.close(); }`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, path.join(home, "memex-home")));
  const parsed = parseJsonLines(result.stdout).at(-1);
  return {
    status: result.status === 0 && parsed?.updated === 1 ? "prepared" : "NOT_PROVEN",
    updated: parsed?.updated ?? null,
    rolloutPath: parsed?.rolloutPath ?? rolloutPath,
    detail: result.status === 0 && parsed?.updated === 1 ? null : redacted(result.stderr || result.stdout),
  };
}

async function setupHooks(home, memexHome) {
  const result = await runChild(process.execPath, [path.join(REPO, "cli", "memex.js"), "setup-hooks"], {
    ...envFor(home, memexHome, { MEMEX_PLUGIN_ROOT: REPO }),
  });
  return {
    status: result.status === 0 ? "prepared" : "NOT_PROVEN",
    exitCode: result.status,
    durationMs: result.durationMs,
    detail: result.status === 0 ? "absolute Memex lifecycle handlers registered in isolated CODEX_HOME" : redacted(result.stderr || result.stdout),
  };
}

async function ensureSharedBudget(home, memexHome, sessionId) {
  const code = `import { initDatabase } from './dist/db.js'; import { getOrCreateModelWorkBudget } from './dist/model-budget.js'; const db=initDatabase(); try { const b=getOrCreateModelWorkBudget(db,{parentWaveId:${JSON.stringify(`comparison:${sessionId}`)},limits:{maxAttempts:${MODEL_MAX_CALLS},maxInputChars:120000,maxOutputChars:16000}}); console.log(JSON.stringify({budgetId:b.budgetId,maxAttempts:b.maxAttempts,reservedAttempts:b.reservedAttempts,state:b.state})); } finally { db.close(); }`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, memexHome));
  const parsed = parseJsonLines(result.stdout).at(-1);
  return parsed?.budgetId ? parsed : null;
}

async function rewriteDerivedPaths(home, memexHome, fromRoot, sessionId, transcriptPath) {
  if (!fromRoot) return { status: "not-needed" };
  const oldMemexHome = path.join(fromRoot, "memex-home");
  const oldCodexHome = path.join(fromRoot, "codex-home");
  const newCodexHome = home;
  const aliases = (value) => {
    const values = new Set([value, path.resolve(value)]);
    try { values.add(fs.realpathSync(value)); } catch {}
    if (value.startsWith("/private/")) values.add(value.slice("/private".length));
    else if (value.startsWith("/")) values.add(`/private${value}`);
    return [...values];
  };
  const mappings = [];
  for (const [oldPath, newPath] of [[oldMemexHome, memexHome], [oldCodexHome, newCodexHome]]) {
    for (const oldAlias of aliases(oldPath)) {
      for (const newAlias of aliases(newPath)) mappings.push([oldAlias, newAlias]);
    }
  }
  let source = null;
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const realpath = fs.realpathSync(transcriptPath);
    const stat = fs.statSync(realpath);
    source = { path: transcriptPath, realpath, dev: String(stat.dev), ino: String(stat.ino), mtimeMs: stat.mtimeMs };
  }
  // Build the child program from double-quoted SQL fragments. The prior
  // inline program embedded `column != ''` inside a single-quoted JS string,
  // so the generated child failed to parse and optional preparation was
  // incorrectly reported as NOT_PROVEN.
  const code = `import fs from 'node:fs'; import { initDatabase } from './dist/db.js'; const db=initDatabase(); try { const mappings=${JSON.stringify(mappings)}; const pathColumns=[['exchanges','archive_path'],['journal_streams','journal_path'],['journal_streams','source_path'],['journal_streams','source_realpath'],['capture_gaps','source_path'],['conversation_exclusions','source_path']]; let updated=0; for(const [table,column] of pathColumns){for(const [oldPath,newPath] of mappings){updated+=db.prepare("UPDATE "+table+" SET "+column+"=replace("+column+",?,?) WHERE "+column+" LIKE ?").run(oldPath,newPath,'%'+oldPath+'%').changes;}} const source=${JSON.stringify(source)}; if(source&&${JSON.stringify(sessionId||"")}){updated+=db.prepare("UPDATE journal_streams SET source_path=?, source_realpath=?, source_dev=?, source_ino=?, source_mtime_ms=? WHERE session_id=?").run(source.path,source.realpath,source.dev,source.ino,source.mtimeMs,${JSON.stringify(sessionId)}).changes;} const missing=[]; for(const [table,column] of pathColumns){for(const row of db.prepare("SELECT rowid,"+column+" AS value FROM "+table+" WHERE "+column+" IS NOT NULL AND length("+column+") > 0").all()){if(!fs.existsSync(row.value)) missing.push(table+':'+row.rowid+':'+column+':'+row.value);}} console.log(JSON.stringify({updated,missing,sourceUpdated:Boolean(source&&${JSON.stringify(sessionId||"")} )})); } finally { db.close(); }`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, memexHome));
  const parsed = parseJsonLines(result.stdout).at(-1);
  const sourceRequired = Boolean(source && sessionId);
  const prepared = result.status === 0 && parsed && parsed.missing?.length === 0 && (!sourceRequired || parsed.sourceUpdated === true);
  return { status: prepared ? "prepared" : "NOT_PROVEN", updated: parsed?.updated ?? null, missing: parsed?.missing ?? null, sourceUpdated: parsed?.sourceUpdated ?? false, detail: prepared ? null : redacted(result.stderr || result.stdout) };
}

async function capturePrefix(home, memexHome, transcript, sessionId) {
  const code = `import { initDatabase } from './dist/db.js'; import { captureTranscriptPrefix } from './dist/continuity-core.js'; const db=initDatabase(); try { const r=captureTranscriptPrefix(db,{sessionId:${JSON.stringify(sessionId)},project:${JSON.stringify(PROJECT)},transcriptPath:${JSON.stringify(transcript)},kind:'final'}); console.log(JSON.stringify({checkpointId:r.checkpointId,appendedBytes:r.appendedBytes,journalPath:r.journalPath,capsuleJobId:r.capsuleJobId})); } finally { db.close(); }`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, memexHome));
  const parsed = parseJsonLines(result.stdout).at(-1);
  return {
    status: result.status === 0 && parsed ? "prepared" : "NOT_PROVEN",
    exitCode: result.status,
    durationMs: result.durationMs,
    capture: parsed ?? null,
    detail: result.status === 0 && parsed ? "production captureTranscriptPrefix accepted the frozen rollout" : redacted(result.stderr || result.stdout),
  };
}

async function indexAndExtract(home, memexHome, transcript, sessionId, budgetId) {
  const base = envFor(home, memexHome, { SESSION_ID: sessionId, CWD: PROJECT, MB_TRANSCRIPT_PATH: transcript, MEMEX_MODEL_BUDGET_ID: budgetId });
  const index = await runChild(process.execPath, [path.join(REPO, "cli", "memex.js"), "index", "--cleanup", "--no-summaries"], base);
  // captureTranscriptPrefix enqueues a capture_index job ahead of extraction
  // in the same partition. Drain that P0/P1 queue first; otherwise the
  // extraction worker correctly returns claim_not_acquired and a later
  // backfill can make the result look complete only after host execution.
  const continuityBeforeExtraction = await runChild(
    process.execPath,
    [path.join(REPO, "scripts", "continuity-worker.js")],
    base,
  );
  const extract = await runChild(process.execPath, [path.join(REPO, "scripts", "fact-extract-worker.js")], base);
  // The SessionEnd-shaped worker can legitimately lose its claim to a
  // concurrent maintenance runner. The comparison needs a foreground,
  // observable drain before cloning the core state, otherwise the optional
  // arm is seeded from a partial extraction and its quality result is invalid.
  // The cross-session backfill worker is idempotent, so running it after a
  // successful hook-shaped extraction is a cheap no-op for this fixture.
  const foregroundBackfill = await runChild(
    process.execPath,
    [path.join(REPO, "scripts", "backfill-extract-worker.js"), "--max", "200"],
    base,
  );
  const extractionDrain = await readExtractionDrain(home, memexHome, sessionId);
  const continuity = await runChild(process.execPath, [path.join(REPO, "scripts", "continuity-worker.js")], base);
  return {
    status: index.status === 0 && continuityBeforeExtraction.status === 0 && extract.status === 0 && foregroundBackfill.status === 0 && extractionDrain.status === "observed" ? "prepared" : "NOT_PROVEN",
    index: compactCommandResult(index),
    continuityBeforeExtraction: compactCommandResult(continuityBeforeExtraction),
    extraction: compactCommandResult(extract),
    foregroundBackfill: compactCommandResult(foregroundBackfill),
    extractionDrain,
    continuity: compactCommandResult(continuity),
  };
}

async function runOptional(home, memexHome, budgetId) {
  const results = [];
  const features = OPTIONAL.filter((feature) => feature !== "relations" || !OPTIONAL.includes("ontology"));
  for (const feature of features) {
    let command;
    let args;
    const env = envFor(home, memexHome, { BACKFILL_CONCURRENCY: "1", BACKFILL_BATCH_SIZE: "8", BACKFILL_ONTOLOGY_MAX: "8", MEMEX_MODEL_BUDGET_ID: budgetId });
    if (feature === "ontology") {
      command = process.execPath;
      args = [path.join(REPO, "scripts", "backfill-ontology-worker.js"), "--max", "8"];
      if (OPTIONAL.includes("relations")) env.BACKFILL_RELATIONS = "1";
    } else if (feature === "relations") {
      command = process.execPath;
      args = [path.join(REPO, "scripts", "backfill-ontology-worker.js"), "--max", "8"];
      env.BACKFILL_RELATIONS = "1";
    } else if (feature === "consolidation") {
      command = process.execPath;
      args = [path.join(REPO, "scripts", "fact-consolidate-worker.js")];
    } else {
      results.push({ feature, status: "NOT_PROVEN", detail: "unknown optional component; invocation skipped" });
      continue;
    }
    const result = await runChild(command, args, env);
    const commandResult = compactCommandResult(result);
    results.push({ feature, command: args.join(" "), ...commandResult });
    if (feature === "ontology" && OPTIONAL.includes("relations")) {
      results.push({ feature: "relations", status: commandResult.status, includedIn: "ontology invocation via BACKFILL_RELATIONS=1" });
    }
  }
  return results;
}

function compactCommandResult(result) {
  const events = parseJsonLines(result.stdout);
  const usage = events.find((event) => event.type === "turn.completed")?.usage ?? null;
  const turns = {
    started: events.filter((event) => event.type === "turn.started").length,
    completed: events.filter((event) => event.type === "turn.completed").length,
    failed: events.filter((event) => event.type === "turn.failed").length,
  };
  return {
    status: result.status === 0 ? "PASS" : "NOT_PROVEN",
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutChars: result.stdout.length,
    stderrChars: result.stderr.length,
    stdoutSha256: sha256Bytes(Buffer.from(result.stdout)),
    stderrSha256: sha256Bytes(Buffer.from(result.stderr)),
    usage: usage ? { input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null, cached_input_tokens: usage.cached_input_tokens ?? null } : null,
    turns,
    detail: result.status === 0 ? null : redacted(result.stderr || result.stdout),
  };
}

function containsStatus(value, expected) {
  if (!value || typeof value !== "object") return false;
  if (value.status === expected) return true;
  return Object.values(value).some((child) => containsStatus(child, expected));
}

function assessQuality(arm) {
  const misses = [];
  const retrieval = arm.retrieval;
  // Baseline arms deliberately do not enable Memex hooks or retrieval. Their
  // host answer is still graded, while Memex retrieval criteria are marked
  // not applicable instead of becoming a false failure/unknown.
  const retrievalStatus = arm.configuration?.hooks === true ? (retrieval?.status ?? "NOT_PROVEN") : "NOT_APPLICABLE";
  if (arm.configuration?.hooks === true) {
    if (!retrieval || retrieval.status !== "observed") {
      misses.push("retrieval NOT_PROVEN");
    } else {
      if (!retrieval.exact.pass) misses.push("exact identifier retrieval miss");
      if (!retrieval.semantic?.retrieval?.semanticPass || !retrieval.semantic?.retrieval?.forbiddenPass) {
        misses.push("semantic retrieval miss or stale value");
      }
    }
  }
  const output = arm.host?.output;
  if (!output || output.status !== "observed") {
    misses.push("host output NOT_PROVEN");
  } else if (!output.expectedPass) {
    misses.push("host expected answer mismatch");
  }
  return {
    status: misses.length === 0 ? "PASS" : misses.some((item) => item.includes("NOT_PROVEN")) ? "NOT_PROVEN" : "FAIL",
    misses,
    retrievalStatus,
  };
}

async function readLifecycleState(home, memexHome) {
  const indexDir = path.join(memexHome, "conversation-index");
  const lockNames = [
    "backfill-extract.lock",
    "backfill-ontology.lock",
    "fact-consolidate.lock",
    "reembed.lock",
  ];
  const code = `import { initDatabase } from './dist/db.js'; const db=initDatabase(); try {
    const count=(sql)=>Number(db.prepare(sql).get()?.n??0);
    console.log(JSON.stringify({
      modelReserved:count("SELECT COUNT(*) AS n FROM model_work_attempts WHERE state = 'reserved'"),
      memoryJobsRunning:count("SELECT COUNT(*) AS n FROM memory_jobs WHERE state = 'running'"),
      extractionTargetRunning:count("SELECT COUNT(*) AS n FROM extraction_targets WHERE state = 'running'"),
      extractionItemsProcessing:count("SELECT COUNT(*) AS n FROM extraction_target_items WHERE state = 'processing'"),
    }));
  } finally { db.close(); }`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, memexHome));
  const parsed = parseJsonLines(result.stdout).at(-1);
  const locks = lockNames.filter((name) => fs.existsSync(path.join(indexDir, name)));
  return {
    status: result.status === 0 && parsed ? "observed" : "NOT_PROVEN",
    modelReserved: parsed?.modelReserved ?? null,
    memoryJobsRunning: parsed?.memoryJobsRunning ?? null,
    extractionTargetRunning: parsed?.extractionTargetRunning ?? null,
    extractionItemsProcessing: parsed?.extractionItemsProcessing ?? null,
    locks,
    active: !parsed || parsed.modelReserved > 0 || parsed.memoryJobsRunning > 0 || parsed.extractionTargetRunning > 0 || parsed.extractionItemsProcessing > 0 || locks.length > 0,
    detail: result.status === 0 && parsed ? null : redacted(result.stderr || result.stdout),
  };
}

async function readExtractionDrain(home, memexHome, sessionId) {
  const code = `import { initDatabase } from './dist/db.js'; const db=initDatabase(); try {
    const rows=db.prepare("SELECT state,item_count,cursor_ordinal FROM extraction_targets WHERE session_id = ? ORDER BY created_at DESC").all(${JSON.stringify(sessionId)});
    const pending=db.prepare("SELECT COUNT(*) AS n FROM extraction_target_items i JOIN extraction_targets t ON t.target_id=i.target_id WHERE t.session_id = ? AND i.state IN ('pending','processing','retry')").get(${JSON.stringify(sessionId)})?.n ?? 0;
    const latest=rows[0] ?? null;
    const unresolved=rows.filter((row)=>!['completed','superseded'].includes(row.state)).map((row)=>row.state);
    console.log(JSON.stringify({targetCount:rows.length,latest,pending:Number(pending),unresolved}));
  } finally { db.close(); }`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, memexHome));
  const parsed = parseJsonLines(result.stdout).at(-1);
  const drained = parsed?.targetCount > 0 && parsed?.pending === 0 && parsed?.latest?.state === "completed" && parsed?.unresolved?.length === 0;
  return {
    status: result.status === 0 && drained ? "observed" : "NOT_PROVEN",
    targetCount: parsed?.targetCount ?? null,
    latest: parsed?.latest ?? null,
    pending: parsed?.pending ?? null,
    unresolved: parsed?.unresolved ?? null,
    detail: result.status !== 0 ? redacted(result.stderr || result.stdout) : drained ? null : "foreground extraction did not reach a completed target",
  };
}

async function waitForLifecycleIdle(home, memexHome) {
  const started = Date.now();
  let quietSince = null;
  let last = null;
  while (Date.now() - started < TIMEOUT_MS) {
    last = await readLifecycleState(home, memexHome);
    if (last.status === "observed" && !last.active) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= LIFECYCLE_QUIET_MS) {
        return { status: "observed", durationMs: Date.now() - started, state: last };
      }
    } else {
      quietSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { status: "NOT_PROVEN", durationMs: Date.now() - started, state: last, detail: "owned lifecycle workers did not reach idle before timeout" };
}

async function readDbMetrics(home, memexHome, sessionId) {
  const code = `import { initDatabase } from './dist/db.js'; const db=initDatabase(); try {
    const one=(sql)=>Number(db.prepare(sql).get(${JSON.stringify(sessionId)})?.n??0);
    const q=(sql)=>{try{return Number(db.prepare(sql).get()?.n??0)}catch{return null}};
    const modelWork=(()=>{try{
      const rows=db.prepare('SELECT state,duration_ms,input_chars,output_chars,token_usage_json,token_usage_status FROM model_work_attempts').all();
      const sum=(key)=>rows.reduce((total,row)=>total+(Number(row[key])||0),0);
      const observedRows=rows.filter(row=>row.token_usage_status==='observed');
      const tokens=observedRows.length ? observedRows.reduce((total,row)=>{
        try { const u=JSON.parse(row.token_usage_json||'null'); return {
          input_tokens:total.input_tokens+(Number(u?.input_tokens)||0),
          output_tokens:total.output_tokens+(Number(u?.output_tokens)||0),
          cached_input_tokens:total.cached_input_tokens+(Number(u?.cached_input_tokens)||0)
        }; } catch { return total; }
      }, {input_tokens:0,output_tokens:0,cached_input_tokens:0}) : null;
      return {
        attempts:rows.length, completed:rows.filter(row=>row.state==='completed').length,
        failed:rows.filter(row=>row.state==='failed').length, unknown:rows.filter(row=>row.state==='unknown').length,
        durationMs:sum('duration_ms'), inputChars:sum('input_chars'), outputChars:sum('output_chars'),
        usageObserved:observedRows.length, usagePartial:rows.filter(row=>row.token_usage_status==='partial').length,
        usageNotProven:rows.filter(row=>row.token_usage_status==='NOT_PROVEN').length,
        tokenUsageStatus:observedRows.length===0 ? 'NOT_PROVEN' : observedRows.length===rows.length ? 'observed' : 'partial',
        tokens
      };
    } catch { return null; }})();
    console.log(JSON.stringify({exchanges:one('SELECT COUNT(*) AS n FROM exchanges WHERE session_id = ?'),facts:q('SELECT COUNT(*) AS n FROM facts WHERE is_active=1'),capsules:q('SELECT COUNT(*) AS n FROM work_capsules'),relations:q('SELECT COUNT(*) AS n FROM ontology_relations'),jobsPending:q("SELECT COUNT(*) AS n FROM memory_jobs WHERE state IN ('pending','retry','running')"),modelAttempts:q('SELECT COUNT(*) AS n FROM model_work_attempts'),modelWork}));
  } finally { db.close(); }`;
  const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, memexHome));
  return parseJsonLines(result.stdout).at(-1) ?? { status: "NOT_PROVEN", detail: redacted(result.stderr || result.stdout) };
}

function retrievalEval(context, fixture, query) {
  const lower = context.toLocaleLowerCase();
  const exact = fixture.identifierQueries.includes(query)
    ? [{ query, hit: lower.includes(query.toLocaleLowerCase()) }]
    : [];
  const semanticNeedles = ["lease", "generation", "ownership", "commit"];
  const semanticHits = semanticNeedles.map((needle) => ({ needle, hit: lower.includes(needle) }));
  const forbidden = fixture.forbiddenCurrentValues.map((value) => ({ value, present: lower.includes(value.toLocaleLowerCase()) }));
  // ORANGE_OVERRIDE is deliberately present in the fixture as quoted,
  // untrusted memory data. Its presence in an envelope is not evidence that
  // retrieval promoted it to current truth; host output grading checks the
  // model's accepted JSON separately.
  const demoted = forbidden.filter((item) => item.present && item.value === "ORANGE_OVERRIDE");
  const authoritativeForbidden = forbidden.filter((item) => !demoted.includes(item));
  return {
    contextChars: context.length,
    estimatedTokens: estimateContextTokens(context),
    contextSha256: sha256Bytes(Buffer.from(context)),
    exact,
    exactPass: exact.length === 0 ? null : exact.every((item) => item.hit),
    semanticHits,
    semanticPass: semanticHits.filter((item) => item.hit).length >= 2,
    forbidden,
    demotedForbidden: demoted,
    forbiddenPass: authoritativeForbidden.every((item) => !item.present),
  };
}

async function retrieve(home, memexHome, sessionId, fixture) {
  const records = [];
  for (const query of [...fixture.identifierQueries, fixture.semanticQuery]) {
    // computeInjectContext advances per-session residency/cursors. Isolate
    // every query so each identifier is measured against the same state and
    // cannot consume the prefix needed by the next query.
    const queryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memex-comparison-query-"));
    const queryMemexHome = path.join(queryRoot, "memex-home");
    copyTree(memexHome, queryMemexHome);
    const code = `import { computeInjectContext } from './dist/inject-core.js'; const t=Date.now(); try { const c=await computeInjectContext(${JSON.stringify(query)},${JSON.stringify(PROJECT)},'fallback',${JSON.stringify(sessionId)},{gate:false}); console.log(JSON.stringify({context:c,durationMs:Date.now()-t})); } catch(e) { console.log(JSON.stringify({error:String(e),durationMs:Date.now()-t})); process.exitCode=0; }`;
    const result = await runChild(process.execPath, ["--input-type=module", "-e", code], envFor(home, queryMemexHome));
    const raw = parseJsonLines(result.stdout).at(-1) ?? {};
    const context = typeof raw.context === "string" ? raw.context : "";
    fs.rmSync(queryRoot, { recursive: true, force: true });
    records.push({
      query,
      lane: query === fixture.semanticQuery ? "semantic" : "exact-identifier",
      status: result.status === 0 && !raw.error ? "observed" : "NOT_PROVEN",
      durationMs: raw.durationMs ?? result.durationMs,
      retrieval: retrievalEval(context, fixture, query),
      error: raw.error ? redacted(raw.error) : null,
    });
  }
  const exact = records.filter((r) => r.lane === "exact-identifier");
  const semantic = records.find((r) => r.lane === "semantic");
  return {
    status: records.every((r) => r.status === "observed") ? "observed" : "NOT_PROVEN",
    calls: records.length,
    exact: { pass: exact.every((r) => r.retrieval.exactPass === true && r.retrieval.forbiddenPass), records: exact },
    semantic: semantic ?? null,
  };
}

function gradeHostOutput(stdout, fixture) {
  const events = parseJsonLines(stdout);
  const messages = events.filter((e) => e.type === "item.completed" || e.type === "response_item")
    .map((e) => e.item ?? e.payload).filter((item) =>
      (item?.type === "message" || item?.type === "agent_message") &&
      (item.role === undefined || item.role === "assistant"));
  const messageText = (item) => {
    if (typeof item?.text === "string") return item.text;
    if (typeof item?.content === "string") return item.content;
    if (Array.isArray(item?.content)) {
      return item.content.map((part) => typeof part === "string" ? part : String(part?.text ?? part?.content ?? "")).join("");
    }
    return "";
  };
  const nonEmptyMessages = messages.filter((item) => messageText(item).trim().length > 0);
  const finalMessage = nonEmptyMessages.at(-1) ?? null;
  // Compaction and the final query can each emit an assistant message. Grade
  // only the final query response; concatenating both messages makes valid
  // JSON appear malformed and turns a correct host answer into a false miss.
  const text = messageText(finalMessage);
  const lower = text.toLocaleLowerCase();
  let parsed = null;
  try { parsed = JSON.parse(text.trim().replace(/^```json\s*/, "").replace(/\s*```$/, "")); } catch { /* model output may be prose */ }
  const expected = fixture.expected ?? {};
  const checks = Object.entries(expected).filter(([key]) => !key.endsWith("Contains")).map(([key, value]) => ({
    key,
    pass: parsed && Object.prototype.hasOwnProperty.call(parsed, key) &&
      (Array.isArray(value) ? value.every((candidate) => parsed[key] === candidate) : parsed[key] === value),
  }));
  for (const [key, values] of Object.entries(expected)) {
    if (!key.endsWith("Contains") || !Array.isArray(values)) continue;
    const field = key.slice(0, -"Contains".length);
    checks.push({ key, pass: parsed && typeof parsed[field] === "string" && values.every((value) => parsed[field].toLocaleLowerCase().includes(String(value).toLocaleLowerCase())) });
  }
  return {
    status: finalMessage ? "observed" : "NOT_PROVEN",
    assistantMessages: messages.length,
    selectedMessageId: finalMessage?.id ?? null,
    responseChars: text.length,
    responseSha256: sha256Bytes(Buffer.from(text)),
    forbiddenPresent: fixture.forbiddenCurrentValues.filter((v) => lower.includes(v.toLocaleLowerCase())),
    expectedChecks: checks,
    expectedPass: checks.length > 0 && checks.every((check) => check.pass),
    outputOnlyEvidence: true,
  };
}

function hostEvidence(memexHome, sessionId) {
  const readLines = (file) => {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  };
  const hooks = readLines(path.join(memexHome, "logs", "hook-events.jsonl"))
    .filter((event) => !event.session_id || event.session_id === sessionId);
  const injections = readLines(path.join(memexHome, "conversation-index", "logs", "inject-context.jsonl"));
  const promptHooks = hooks.filter((event) => event.event === "UserPromptSubmit");
  const injected = injections.filter((event) => event.status === "injected");
  const noMatch = injections.filter((event) => event.status === "no-match" || event.status === "skipped");
  return {
    status: "NOT_PROVEN",
    hookObservation: promptHooks.length > 0 ? "observed" : "NOT_PROVEN",
    hostAcceptance: "NOT_PROVEN: hook observation does not prove host acceptance",
    hookEvents: hooks.reduce((counts, event) => { counts[event.event] = (counts[event.event] ?? 0) + 1; return counts; }, {}),
    userPromptSubmit: promptHooks.length,
    contextEmitted: injected.length,
    noContextOutcome: noMatch.length,
    acceptanceEvidence: promptHooks.length > 0 ? "Memex UserPromptSubmit hook observed; host acceptance remains NOT_PROVEN" : "no isolated hook event observed",
  };
}

function buildHostQueryArgs(sessionId, enableHooks) {
  const args = ["exec", "resume", sessionId, "--skip-git-repo-check", "--ignore-rules", "-m", "gpt-5.6-luna", "--json", "--output-schema", HOST_OUTPUT_SCHEMA, "-"];
  if (enableHooks) args.splice(5, 0, "--enable", "hooks", "--dangerously-bypass-hook-trust");
  return args;
}

async function hostQuery(home, memexHome, sessionId, fixture, enableHooks, budget = null) {
  if (!RUN_HOST) return { status: "NOT_RUN", reason: "--run-host not provided" };
  const budgetId = typeof budget === "string" ? budget : budget?.budgetId ?? null;
  const parentWaveId = typeof budget === "object" ? budget?.parentWaveId ?? null : null;
  const compaction = await compactSession(home, memexHome, sessionId, budgetId, parentWaveId);
  const args = buildHostQueryArgs(sessionId, enableHooks);
  const hostExtra = { CWD: PROJECT };
  if (budgetId) hostExtra.MEMEX_MODEL_BUDGET_ID = budgetId;
  if (parentWaveId) hostExtra.MEMEX_MAINTENANCE_WAVE_ID = parentWaveId;
  const result = await runChild(CODEX_COMMAND, args, envFor(home, memexHome, hostExtra), TIMEOUT_MS, PROJECT, fixture.query);
  const command = compactCommandResult(result);
  // SessionStart maintenance is intentionally detached by the production
  // hooks. Keep the arm-owned auth copy alive while those workers finish, so
  // their calls are either observed in the arm DB or remain explicitly
  // NOT_PROVEN before the harness removes credentials in finally.
  const lifecycle = await waitForLifecycleIdle(home, memexHome);
  const metricsAfter = await readDbMetrics(home, memexHome, sessionId);
  return {
    compaction,
    command,
    hostObservation: {
      providerCalls: "NOT_PROVEN: host may issue multiple provider calls per operation",
      compactionUsage: compaction.usage ?? null,
      queryUsage: command.usage,
      queryTurns: command.turns,
    },
    lifecycle,
    acceptance: hostEvidence(memexHome, sessionId),
    output: gradeHostOutput(result.stdout, fixture),
    metricsAfter,
    hookConfigEnabled: enableHooks,
  };
}

function nativeGenerationObservation() {
  const raw = path.join(NATIVE_HOME, "memories", "raw_memories.md");
  const text = fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : "";
  const generated = text.trim() !== "# Raw Memories\n\nNo raw memories yet." && text.trim() !== "";
  return {
    status: generated ? "observed" : "NOT_PROVEN",
    source: NATIVE_HOME,
    rawMemoriesChars: text.length,
    rawMemoriesSha256: sha256Bytes(Buffer.from(text)),
    detail: generated ? "native raw memory content exists" : "native memory remains empty; asynchronous generation is not claimed",
  };
}

async function buildArm(kind, fixture, sessionId, transcript, sourceHome = INITIAL_STATE, options = {}) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memex-comparison-arm-"));
  OWNED_ARM_ROOTS.add(runRoot);
  const home = path.join(runRoot, "codex-home");
  const memexHome = path.join(runRoot, "memex-home");
  copyTree(sourceHome, home);
  fs.mkdirSync(memexHome, { recursive: true });
  const localTranscript = findRollout(home, sessionId)[0] ?? transcript;
  let derivedPaths = { status: "not-needed" };
  if (options.memexSeed) {
    copyTree(options.memexSeed, memexHome);
    derivedPaths = await rewriteDerivedPaths(home, memexHome, options.derivedFromRoot, sessionId, localTranscript);
  }
  if (kind === "optional" && options.memexSeed && derivedPaths.status !== "prepared") {
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
    OWNED_ARM_ROOTS.delete(runRoot);
    throw new Error(`optional arm derived paths were not prepared: ${derivedPaths.detail || "path validation failed"}`);
  }
  const configuration = configureArm(home, memexHome, kind);
  const statePaths = await rewriteCodexStatePaths(home, sessionId, localTranscript);
  const hostIfSafe = (enableHooks, budget) => statePaths.status === "prepared"
    ? hostQuery(home, memexHome, sessionId, fixture, enableHooks, budget)
    : Promise.resolve({ status: "NOT_PROVEN", reason: "copied Codex state rollout_path was not rewritten; host operation skipped for source safety" });
  const budget = kind === "core" ? await ensureSharedBudget(home, memexHome, sessionId) : options.budgetId ?? null;
  const preparation = { status: "not-run" };
  let hooks = null;
  let capture = null;
  let processing = null;
  let metrics = null;
  let retrieval = null;
  let host = null;
  if (kind === "core") {
    hooks = await setupHooks(home, memexHome);
    capture = await capturePrefix(home, memexHome, localTranscript, sessionId);
    processing = await indexAndExtract(home, memexHome, localTranscript, sessionId, budget?.budgetId ?? budget);
    if (!options.deferQueries) {
      metrics = await readDbMetrics(home, memexHome, sessionId);
      retrieval = await retrieve(home, memexHome, sessionId, fixture);
      host = await hostIfSafe(true, budget);
    }
    preparation.status = capture.status === "prepared" && processing.status === "prepared" && statePaths.status === "prepared" ? "prepared" : "NOT_PROVEN";
  } else if (kind === "optional") {
    hooks = await setupHooks(home, memexHome);
    processing = { optional: await runOptional(home, memexHome, budget?.budgetId ?? budget) };
    metrics = await readDbMetrics(home, memexHome, sessionId);
    retrieval = await retrieve(home, memexHome, sessionId, fixture);
    host = await hostIfSafe(true, budget);
    preparation.status = processing.optional.every((item) => item.status === "PASS") && derivedPaths.status !== "NOT_PROVEN" && statePaths.status === "prepared" ? "prepared" : "NOT_PROVEN";
  } else {
    host = await hostIfSafe(false, null);
    preparation.status = "not-applicable";
  }
  if (!KEEP && !options.retain) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    OWNED_ARM_ROOTS.delete(runRoot);
  }
  return { configuration, preparation, budget, hooks, capture, processing, statePaths, derivedPaths, metrics, retrieval, host, isolatedRoot: KEEP || options.retain ? runRoot : "removed-after-run" };
}

async function populateQueries(arm, fixture, sessionId, enableHooks = true) {
  if (arm.isolatedRoot === "removed-after-run") throw new Error("query population requires retained arm root");
  const home = path.join(arm.isolatedRoot, "codex-home");
  const memexHome = path.join(arm.isolatedRoot, "memex-home");
  arm.metrics = await readDbMetrics(home, memexHome, sessionId);
  arm.retrieval = await retrieve(home, memexHome, sessionId, fixture);
  arm.host = await hostQuery(home, memexHome, sessionId, fixture, enableHooks, arm.budget ?? null);
  return arm;
}

function requireCoreExtractionDrain(core) {
  if (core.processing?.extractionDrain?.status === "observed") return;
  const root = core.isolatedRoot;
  if (root && root !== "removed-after-run") {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    OWNED_ARM_ROOTS.delete(root);
  }
  const detail = core.processing?.extractionDrain?.detail || core.processing?.extraction?.detail || "foreground extraction did not reach a completed target";
  throw new Error(`core extraction was not drained before optional clone: ${detail}`);
}

async function main() {
  try {
  const validated = validateFrozenInputs();
  const seed = fs.existsSync(path.join(REPO, "tmp", "codex-usability", "native-seed.json"))
    ? readJson(path.join(REPO, "tmp", "codex-usability", "native-seed.json")) : {};
  const sessionId = String(seed.threadId || "01a07f40-5821-76b3-879c-bd0ea097bfa9");
  const rollout = findRollout(INITIAL_STATE, sessionId)[0];
  if (!rollout) throw new Error(`frozen training rollout not found for ${sessionId}`);
  const nativeSourceRollout = findRollout(NATIVE_HOME, sessionId)[0] ?? null;
  const nativeSourceRolloutBeforeSha256 = sha256File(nativeSourceRollout);

  const report = {
    schemaVersion: 1,
    kind: "codex-memory-comparison",
    recordedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      codex: process.env.CODEX_BIN || "codex",
      maxCallsPerArm: MAX_CALLS,
      memexWorkerMaxCalls: MODEL_MAX_CALLS,
      hostOperationsReserved: RUN_HOST ? 2 : 0,
      hostProviderCallCap: "NOT_PROVEN: host operations may contain multiple turns/tool calls",
      timeoutMs: TIMEOUT_MS,
    },
    outputContract: { schema: path.relative(REPO, HOST_OUTPUT_SCHEMA), sha256: sha256File(HOST_OUTPUT_SCHEMA), sharedAcrossAllArms: true, expectedValuesIncluded: false },
    frozenInput: { fixture: path.relative(REPO, FIXTURE), fixtureSha256: validated.fixtureSha, trainingPrompts: validated.fixture.training.length, initialState: INITIAL_STATE, manifestSha256: validated.manifestSha, manifestFiles: validated.manifestFiles, sourceSessionId: sessionId, sourceRolloutSha256: sha256File(rollout), project: PROJECT },
    isolation: { commonSnapshotRestored: true, sourceRolloutUnmodified: "NOT_PROVEN: checked after all arms", nativeSourceRollout: nativeSourceRollout, nativeSourceRolloutBeforeSha256, authSource: fs.existsSync(path.join(NATIVE_HOME, "auth.json")) ? "copied mode 0600 into isolated arms" : "NOT_PROVEN: source auth absent", commonProject: PROJECT, expectedAnswersUsedOnlyForEvaluation: true },
    nativeGeneration: nativeGenerationObservation(),
    lifecycle: { compaction: RUN_HOST ? "per-arm app-server thread/resume -> thread/compact/start -> close is required and recorded under each host result" : "NOT_PROVEN: --run-host was omitted; app-server compaction was not attempted" },
    arms: {},
    optional: { components: OPTIONAL, API: { ontology: "scripts/backfill-ontology-worker.js --max 8", relations: "BACKFILL_RELATIONS=1 scripts/backfill-ontology-worker.js --max 8", consolidation: "scripts/fact-consolidate-worker.js" }, preparationSharedWithOptional: true },
    verdict: null,
    execution: null,
    quality: null,
    limitations: [],
  };

  report.arms.compaction_only = await buildArm("compaction", validated.fixture, sessionId, rollout);
  const retainCore = !KEEP;
  let core = await buildArm("core", validated.fixture, sessionId, rollout, INITIAL_STATE, { retain: retainCore, deferQueries: true });
  // A partial core state cannot serve as the optional arm's baseline. Stop the
  // measurement before cloning it; recording a NOT_PROVEN arm would still
  // allow the optional comparison to make an invalid attribution claim.
  requireCoreExtractionDrain(core);

  // Optional processing must begin from exactly the core-derived Memex state.
  // Keep the clone in a temporary source root, then buildArm restores it as a
  // separate Codex home and never runs extraction a second time conceptually.
  const coreSource = fs.mkdtempSync(path.join(os.tmpdir(), "memex-comparison-core-source-"));
  const coreMemexSource = path.join(coreSource, "memex-home");
  if (core.isolatedRoot === "removed-after-run") throw new Error("core preparation root was removed before optional clone");
  copyTree(path.join(core.isolatedRoot, "memex-home"), coreMemexSource);
  core = await populateQueries(core, validated.fixture, sessionId, true);
  report.arms.memex_core = { ...core, isolatedRoot: KEEP ? core.isolatedRoot : "removed-after-run" };
  report.arms.memex_core_plus_optional = await buildArm("optional", validated.fixture, sessionId, rollout, INITIAL_STATE, { memexSeed: coreMemexSource, derivedFromRoot: core.isolatedRoot, budgetId: core.budget?.budgetId });
  if (!KEEP) fs.rmSync(core.isolatedRoot, { recursive: true, force: true });
  if (!KEEP) fs.rmSync(coreSource, { recursive: true, force: true });

  // Built-in arm consumes only a post-training native memory copy when one is
  // actually present. An empty native file is retained as NOT_PROVEN.
  const nativeReady = nativeGenerationObservation().status === "observed";
  const nativeOverlay = nativeReady ? makeNativeOverlaySource() : INITIAL_STATE;
  report.arms.codex_builtin_memory = await buildArm("builtin", validated.fixture, sessionId, rollout, nativeOverlay);
  if (nativeReady) fs.rmSync(nativeOverlay, { recursive: true, force: true });
  const nativeSourceRolloutAfterSha256 = sha256File(nativeSourceRollout);
  report.isolation.nativeSourceRolloutAfterSha256 = nativeSourceRolloutAfterSha256;
  report.isolation.sourceRolloutUnmodified = nativeSourceRolloutBeforeSha256 !== "ABSENT" &&
    nativeSourceRolloutBeforeSha256 === nativeSourceRolloutAfterSha256;
  if (!report.isolation.sourceRolloutUnmodified) {
    report.limitations.push("Native source rollout changed during the run; the comparison is rejected for source isolation.");
  }
  report.limitations.push("Codex built-in memory generation is asynchronous; empty native state remains NOT_PROVEN.");
  report.limitations.push("Host consumption is NOT_PROVEN when --run-host is omitted or hooks do not emit observable output.");
  report.limitations.push("Expected answers are evaluator-only and are never placed in prompts or memory state.");
  const executionStatus = containsStatus(report, "FAIL")
    ? "FAIL"
    : containsStatus(report, "NOT_PROVEN") || containsStatus(report, "NOT_RUN") ? "PASS-WITH-NOTES" : "PASS";
  report.execution = { status: !report.isolation.sourceRolloutUnmodified ? "FAIL" : executionStatus };
  report.quality = Object.fromEntries(Object.entries(report.arms).map(([name, arm]) => [name, assessQuality(arm)]));
  report.quality.status = Object.values(report.quality).some((item) => item.status === "FAIL")
    ? "FAIL"
    : Object.values(report.quality).some((item) => item.status === "NOT_PROVEN") ? "NOT_PROVEN" : "PASS";
  report.verdict = report.execution.status;
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ output: OUTPUT, verdict: report.verdict, arms: Object.keys(report.arms), nativeGeneration: report.nativeGeneration.status }) + "\n");
  } finally {
    // Auth is copied only into harness-owned arm roots. Remove those copies
    // even with --keep so retained evidence cannot retain a credential.
    removeOwnedArmAuth();
  }
}

export { gradeHostOutput, rewriteDerivedPaths, buildHostQueryArgs };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`codex-memory-comparison: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
