// Codex rollout (.jsonl) recursive discovery + turn assembly.
//
// Grounded against codex-cli 0.149.0 rollout files under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl:
//   session_meta   { payload: { id, session_id, timestamp, cwd, originator,
//                               cli_version, source, thread_source, ... } }
//   response_item  { payload: { type: 'message'|'reasoning'|'custom_tool_call'
//                                     |'custom_tool_call_output', role?, content? } }
//   event_msg / turn_context / world_state / compacted / token_count ...
//
// Turn-assembly contract (head gate):
//   - user turn   <- response_item message role=user
//   - agent turn  <- response_item message role=assistant
//   - tool use    <- response_item custom_tool_call | function_call
//   - event_msg (including user_message-shaped payloads), reasoning,
//     developer, and system records are never part of a turn.
// Subagent isolation: session_meta.parent_thread_id set, or source/thread_source
// marked subagent -> the whole file is flagged and skipped by callers.
import readline from "node:readline";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root directory that holds Codex rollout sessions (recursive layout). */
export function sessionsRoot(): string {
  // MEMEX_SESSIONS_DIR is the optional explicit override; TEST_SESSIONS_DIR
  // is used by tests.
  if (process.env.MEMEX_SESSIONS_DIR) return process.env.MEMEX_SESSIONS_DIR;
  if (process.env.TEST_SESSIONS_DIR) return process.env.TEST_SESSIONS_DIR;
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "sessions");
}

/** Recursively list rollout transcript files, oldest-first. */
export function discoverSessionFiles(root: string = sessionsRoot()): string[] {
  const out: string[] = [];
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    return out;
  }
  if (!st.isDirectory()) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (
        e.isFile() &&
        e.name.startsWith("rollout-") &&
        e.name.endsWith(".jsonl")
      )
        out.push(p);
    }
  }
  return out.sort();
}

/** True when a parsed session_meta marks a subagent/child thread. */
export function isSubagentMeta(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  if (!meta) return false;
  const ptid = (meta as { parent_thread_id?: unknown }).parent_thread_id;
  if (ptid != null && ptid !== "") return true;
  return /subagent|child_thread|spawned/i.test(
    JSON.stringify([meta.source ?? null, meta.thread_source ?? null]),
  );
}

/**
 * Read just the session_meta header of a rollout file — cheap pre-parse used
 * by sync/index to route sessions before any exchange processing.
 */
export async function readRolloutMeta(
  filePath: string,
): Promise<{ meta: Record<string, unknown> | null; isSubagent: boolean }> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let meta: Record<string, unknown> | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ meta, isSubagent: isSubagentMeta(meta) });
    };
    rl.on("line", (line) => {
      if (meta != null) return;
      try {
        const rec: { type?: string; payload?: Record<string, unknown> } =
          JSON.parse(line);
        if (rec && rec.type === "session_meta") {
          meta = rec.payload || {};
          rl.close();
          stream.close();
        }
      } catch {
        /* malformed header line — keep scanning */
      }
    });
    rl.on("close", finish);
    stream.on("error", finish);
  });
}

/**
 * Session/thread id from a rollout filename. Codex names are
 * `rollout-<timestamp>-<uuid>.jsonl` where the timestamp block also contains
 * dashes, so the thread id is the LAST UUID in the basename.
 * Legacy bare-UUID transcript names keep working.
 */
export function extractSessionIdFromPath(filePath: string): string | null {
  const basename = path.basename(filePath, ".jsonl");
  const matches = basename.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  );
  return matches ? matches[matches.length - 1] : null;
}

type ContentItem = { type?: string; text?: unknown };

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content as ContentItem[]) {
    if (c && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n");
}

/**
 * Domain shape of a parsed tool-call input: an already-structured JSON
 * payload (object, array, or scalar) when parsing succeeded, otherwise the
 * original raw string. Mirrors what the indexer can persist into
 * tool_calls.tool_input.
 */
type ToolCallInput =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null;

function safeParseInput(input: unknown): ToolCallInput {
  if (typeof input !== "string") return (input ?? null) as ToolCallInput;
  try {
    return JSON.parse(input) as ToolCallInput;
  } catch {
    return input;
  }
}

const ENV_CONTEXT_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<turn_context>",
  "<codex_internal_context",
  "<codex_context",
  "# AGENTS.md instructions",
  "The following is the Codex agent history",
];

/** Pure single-source check for harness/developer context that must never be
 * indexed or displayed. Used by the parser and the show/read formatters. */
export function isInternalContextMessage(text: string): boolean {
  return ENV_CONTEXT_PREFIXES.some((pre) => text.startsWith(pre));
}

export interface ParsedRollout {
  meta: Record<string, unknown> | null;
  isSubagent: boolean;
  /** Normalized exchanges compatible with the legacy ConversationExchange shape. */
  exchanges: Array<Record<string, unknown>>;
}

/**
 * Stream-parse one rollout file handle into normalized user/agent exchanges.
 * Malformed lines are tolerated per-line (same contract as the legacy parser).
 */
export async function parseRolloutStream(
  input: NodeJS.ReadableStream,
  { archivePath = "" }: { archivePath?: string } = {},
): Promise<ParsedRollout> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const exchanges: Array<Record<string, unknown>> = [];
  let meta: Record<string, unknown> | null = null;
  let cur: {
    userMessage: string;
    userLine: number;
    assistantMessages: string[];
    assistantLine: number;
    timestamp: string;
    toolCalls: Array<Record<string, unknown>>;
  } | null = null;
  let lineNo = 0;
  let lastTs = "";

  const flush = () => {
    if (
      !cur ||
      (cur.assistantMessages.length === 0 && cur.toolCalls.length === 0)
    ) {
      cur = null;
      return;
    }
    const id = crypto
      .createHash("md5")
      .update(`${archivePath}:${cur.userLine}-${cur.assistantLine}`)
      .digest("hex");
    const toolCalls = cur.toolCalls.map((tc) => ({ ...tc, exchangeId: id }));
    exchanges.push({
      id,
      project: "",
      timestamp: cur.timestamp,
      userMessage: cur.userMessage || "(tool calls only)",
      assistantMessage: cur.assistantMessages.join("\n\n"),
      archivePath,
      lineStart: cur.userLine,
      lineEnd: cur.assistantLine,
      sessionId: meta ? (meta.session_id ?? meta.id) : undefined,
      cwd: meta ? meta.cwd : undefined,
      codexVersion: meta ? meta.cli_version : undefined,
      isSidechain: false,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
    cur = null;
  };

  for await (const line of rl) {
    lineNo++;
    let rec: {
      type?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // malformed-line tolerance
    }
    if (!rec || typeof rec !== "object") continue;
    if (typeof rec.timestamp === "string" && rec.timestamp)
      lastTs = rec.timestamp;

    if (rec.type === "session_meta") {
      meta = (rec.payload as Record<string, unknown>) || {};
      continue;
    }
    // Turn content only arrives on response_item; event_msg/reasoning/world_state/
    // turn_context/compacted are transport noise by contract.
    if (rec.type !== "response_item") continue;
    const p = rec.payload || {};
    const pType = String(p.type ?? "");
    if (pType === "reasoning" || pType === "developer" || pType === "system")
      continue;

    if (pType === "message") {
      const role = p.role;
      const text = textFromContent(p.content);
      if (role === "user") {
        if (isInternalContextMessage(text)) continue;
        flush();
        cur = {
          userMessage: text,
          userLine: lineNo,
          assistantMessages: [],
          assistantLine: lineNo,
          timestamp: rec.timestamp || lastTs,
          toolCalls: [],
        };
      } else if (role === "assistant" && cur) {
        cur.assistantMessages.push(text);
        cur.assistantLine = lineNo;
      }
      continue;
    }

    if ((pType === "custom_tool_call" || pType === "function_call") && cur) {
      cur.toolCalls.push({
        id: String(p.call_id ?? p.id ?? crypto.randomUUID()),
        exchangeId: "",
        toolName: String(p.name ?? "unknown"),
        toolInput: safeParseInput(
          pType === "function_call" ? p.arguments : p.input,
        ),
        isError: false,
        timestamp:
          (rec.timestamp as string) || lastTs || new Date(0).toISOString(),
      });
      cur.assistantLine = lineNo;
      continue;
    }

    if (
      (pType === "custom_tool_call_output" ||
        pType === "function_call_output") &&
      cur
    ) {
      const callId = String(p.call_id ?? p.id ?? "");
      const call = cur.toolCalls.find((candidate) => candidate.id === callId);
      if (call) {
        const output = p.output ?? p.result ?? "";
        call.toolResult =
          typeof output === "string" ? output : JSON.stringify(output);
        call.isError = p.is_error === true;
        cur.assistantLine = lineNo;
      }
    }
  }
  flush();

  return { meta, isSubagent: isSubagentMeta(meta), exchanges };
}

/**
 * Legacy-compatible entry point: parse one rollout transcript into exchanges.
 * projectName is stamped onto every exchange (project scoping stays with sync).
 */
export async function parseConversation(
  filePath: string,
  projectName: string,
  archivePath: string = filePath,
): Promise<Array<Record<string, unknown>>> {
  const stream = fs.createReadStream(filePath);
  try {
    const { meta, exchanges } = await parseRolloutStream(stream, {
      archivePath,
    });
    for (const e of exchanges) {
      e.project = projectName;
      if (meta && meta.cwd) e.cwd = meta.cwd;
    }
    return exchanges;
  } finally {
    stream.close();
  }
}
