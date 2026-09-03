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
export function sessionsRoot() {
    // MEMEX_SESSIONS_DIR is the optional explicit override; TEST_SESSIONS_DIR
    // is used by tests.
    if (process.env.MEMEX_SESSIONS_DIR)
        return process.env.MEMEX_SESSIONS_DIR;
    if (process.env.TEST_SESSIONS_DIR)
        return process.env.TEST_SESSIONS_DIR;
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    return path.join(home, "sessions");
}
/** Recursively list rollout transcript files, oldest-first. */
export function discoverSessionFiles(root = sessionsRoot()) {
    const out = [];
    let st;
    try {
        st = fs.statSync(root);
    }
    catch {
        return out;
    }
    if (!st.isDirectory())
        return out;
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory())
                stack.push(p);
            else if (e.isFile() &&
                e.name.startsWith("rollout-") &&
                e.name.endsWith(".jsonl"))
                out.push(p);
        }
    }
    return out.sort();
}
/** True when a parsed session_meta marks a subagent/child thread. */
export function isSubagentMeta(meta) {
    if (!meta)
        return false;
    const ptid = meta.parent_thread_id;
    if (ptid != null && ptid !== "")
        return true;
    return /subagent|child_thread|spawned/i.test(JSON.stringify([meta.source ?? null, meta.thread_source ?? null]));
}
/**
 * Read just the session_meta header of a rollout file — cheap pre-parse used
 * by sync/index to route sessions before any exchange processing.
 */
export async function readRolloutMeta(filePath) {
    return new Promise((resolve) => {
        const stream = fs.createReadStream(filePath);
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let meta = null;
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve({ meta, isSubagent: isSubagentMeta(meta) });
        };
        rl.on("line", (line) => {
            if (meta != null)
                return;
            try {
                const rec = JSON.parse(line);
                if (rec && rec.type === "session_meta") {
                    meta = rec.payload || {};
                    rl.close();
                    stream.close();
                }
            }
            catch {
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
export function extractSessionIdFromPath(filePath) {
    const basename = path.basename(filePath, ".jsonl");
    const matches = basename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    return matches ? matches[matches.length - 1] : null;
}
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const c of content) {
        if (c && typeof c.text === "string")
            parts.push(c.text);
    }
    return parts.join("\n");
}
function safeParseInput(input) {
    if (typeof input !== "string")
        return (input ?? null);
    try {
        return JSON.parse(input);
    }
    catch {
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
export function isInternalContextMessage(text) {
    return ENV_CONTEXT_PREFIXES.some((pre) => text.startsWith(pre));
}
/**
 * Stream-parse one rollout file handle into normalized user/agent exchanges.
 * Malformed lines are tolerated per-line (same contract as the legacy parser).
 */
export async function parseRolloutStream(input, { archivePath = "" } = {}) {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const exchanges = [];
    let meta = null;
    let cur = null;
    let lineNo = 0;
    let lastTs = "";
    const flush = (boundary) => {
        if (!cur ||
            (cur.assistantMessages.length === 0 && cur.toolCalls.length === 0)) {
            cur = null;
            return;
        }
        // 재감사 P1-5: 교환 신원은 (세션, user turn 행 위치)에서 결정론적으로
        // 파생한다 — 기기별 archive 경로와 assistant/tool 행 위치는 신원 재료가
        // 아니다(경로는 location metadata일 뿐이다). user 행은 append-only
        // rollout에서 불변이므로 turn 이 자라도(assistant/tool 행 추가) 같은
        // 교환으로 upsert 된다. assistant/tool 변화는 content generation이며
        // insertExchange upsert가 반영한다. session_meta 없는 파일은 경로 독립인
        // content 폴백 키를 쓴다. "mx" 접두사는 구 scheme(md5(archivePath:...))과의
        // 우연한 충돌을 네임스페이스로 분리한다.
        const sessionKey = meta ? String(meta.session_id ?? meta.id ?? "") : "";
        const id = sessionKey
            ? crypto
                .createHash("md5")
                .update(`mx:${sessionKey}:u${cur.userLine}`)
                .digest("hex")
            : crypto
                .createHash("md5")
                .update(`mx:u${cur.userLine}:${cur.userMessage}`)
                .digest("hex");
        const toolCalls = cur.toolCalls.map((tc) => ({ ...tc, exchangeId: id }));
        const hasIncompleteTool = toolCalls.some((call) => call.toolResult === undefined);
        exchanges.push({
            id,
            project: "",
            timestamp: cur.timestamp,
            userMessage: cur.userMessage || "(tool calls only)",
            assistantMessage: cur.assistantMessages.join("\n\n"),
            archivePath,
            lineStart: cur.userLine,
            lineEnd: cur.assistantLine,
            exchangeSeq: exchanges.length + 1,
            closureState: boundary === "eof" && hasIncompleteTool ? "interrupted" : "closed",
            parserVersion: 2,
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
        let rec;
        try {
            rec = JSON.parse(line);
        }
        catch {
            continue; // malformed-line tolerance
        }
        if (!rec || typeof rec !== "object")
            continue;
        if (typeof rec.timestamp === "string" && rec.timestamp)
            lastTs = rec.timestamp;
        if (rec.type === "session_meta") {
            meta = rec.payload || {};
            continue;
        }
        // Turn content only arrives on response_item; event_msg/reasoning/world_state/
        // turn_context/compacted are transport noise by contract.
        if (rec.type !== "response_item")
            continue;
        const p = rec.payload || {};
        const pType = String(p.type ?? "");
        if (pType === "reasoning" || pType === "developer" || pType === "system")
            continue;
        if (pType === "message") {
            const role = p.role;
            const text = textFromContent(p.content);
            if (role === "user") {
                if (isInternalContextMessage(text))
                    continue;
                flush("next_user");
                cur = {
                    userMessage: text,
                    userLine: lineNo,
                    assistantMessages: [],
                    assistantLine: lineNo,
                    timestamp: rec.timestamp || lastTs,
                    toolCalls: [],
                };
            }
            else if (role === "assistant" && cur) {
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
                toolInput: safeParseInput(pType === "function_call" ? p.arguments : p.input),
                isError: false,
                timestamp: rec.timestamp || lastTs || new Date(0).toISOString(),
            });
            cur.assistantLine = lineNo;
            continue;
        }
        if ((pType === "custom_tool_call_output" ||
            pType === "function_call_output") &&
            cur) {
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
    flush("eof");
    return { meta, isSubagent: isSubagentMeta(meta), exchanges };
}
/**
 * Legacy-compatible entry point: parse one rollout transcript into exchanges.
 * projectName is stamped onto every exchange (project scoping stays with sync).
 */
export async function parseConversation(filePath, projectName, archivePath = filePath) {
    const stream = fs.createReadStream(filePath);
    try {
        const { meta, exchanges } = await parseRolloutStream(stream, {
            archivePath,
        });
        for (const e of exchanges) {
            e.project = projectName;
            if (meta && meta.cwd)
                e.cwd = meta.cwd;
        }
        return exchanges;
    }
    finally {
        stream.close();
    }
}
