#!/usr/bin/env node
/**
 * UserPromptSubmit context injection — thin client.
 *
 * Fast path: connect to the warm inject daemon (a unix-socket sidecar inside
 * any running MCP server, which already has the embedding model loaded) and
 * get the context back in ~150ms. Cold fallback: compute locally exactly as
 * before (~2.3s, dominated by model load) when no daemon answers — first
 * session start, daemon disabled, or any socket hiccup.
 *
 * Input (either):
 *   stdin JSON  { "prompt": "...", "cwd": "...", "session_id": "..." }   ← Codex UserPromptSubmit hook contract
 *   env         USER_PROMPT / CWD                                        ← manual invocation
 *
 * IMPORTANT: keep the import list here LIGHT — the fast path must not pay for
 * better-sqlite3/transformers imports. Heavy modules load lazily only in the
 * fallback.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOCKET_CONNECT_TIMEOUT_MS = 300;
const SOCKET_RESPONSE_TIMEOUT_MS = 3000;
/** Must equal INJECT_DAEMON_PROTOCOL in src/inject-daemon.ts. */
const INJECT_DAEMON_PROTOCOL = 1;

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Mirrors paths.ts getMemexHome() without importing the heavy dist chain. */
function memexHome() {
  return (
    process.env.MEMEX_HOME ||
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "memex",
    )
  );
}

function injectSocketPath() {
  return path.join(memexHome(), "conversation-index", "inject-daemon.sock");
}

/** Mirrors paths.ts getDbPath(). Part of the daemon handshake: two builds on
 * the same code but different data roots must not serve each other. */
function dbPath() {
  const override = process.env.MEMEX_DB_PATH || process.env.TEST_DB_PATH;
  return path.resolve(
    override || path.join(memexHome(), "conversation-index", "db.sqlite"),
  );
}

/**
 * Issue #84 — the identity this hook REQUIRES of a daemon before using it.
 *
 * Mirrors `injectDaemonIdentity()` in src/inject-daemon.ts, computed here from
 * node builtins so the fast path still pays nothing for the heavy dist chain.
 * The root is this script's own plugin root (`__dirname/..`), realpath'd: the
 * hook belongs to an installation and must only trust a daemon running that
 * installation's code.
 *
 * The build id is the SHA-256 of the shipped bundle, because a version string
 * cannot tell a development checkout's 0.6.3 from the installed 0.6.3 — which is
 * exactly the confusion that let a pre-0.6.0 `dist` answer 0.6.2's prompts.
 * Reading and hashing ~1MB costs single-digit milliseconds against the fast
 * path's ~150ms, and buys attribution for every injected line.
 */
function localIdentity() {
  const root = (() => {
    try {
      return fs.realpathSync(path.join(__dirname, ".."));
    } catch {
      return path.resolve(path.join(__dirname, ".."));
    }
  })();
  let version = null;
  for (const relative of [
    path.join(".codex-plugin", "plugin.json"),
    "package.json",
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        version = parsed.version.trim();
        break;
      }
    } catch {
      /* unreadable candidate: try the next one */
    }
  }
  let buildId = null;
  try {
    buildId = `sha256:${createHash("sha256")
      .update(fs.readFileSync(path.join(root, "dist", "mcp-server.js")))
      .digest("hex")}`;
  } catch {
    for (const entry of [
      path.join(root, "dist", "inject-daemon.js"),
      path.join(root, "src", "inject-daemon.ts"),
    ]) {
      try {
        buildId = `mtime:${version ?? "unknown"}:${Math.trunc(fs.statSync(entry).mtimeMs)}`;
        break;
      } catch {
        /* try the next shape */
      }
    }
  }
  return {
    protocol: INJECT_DAEMON_PROTOCOL,
    version,
    buildId,
    pluginRoot: root,
    dbPath: dbPath(),
  };
}

/**
 * The subset of a daemon's reply worth recording when it is not ours.
 *
 * `null` when the reply said nothing about its identity at all — a pre-0.6.3
 * daemon or a foreign listener. That is a different fact from "it identified
 * itself and the identity differs", so the log must not blur them into an object
 * of nulls.
 */
function reportedIdentity(reply) {
  if (!reply || typeof reply !== "object") return null;
  const pick = (value, kind) => (typeof value === kind ? value : null);
  const got = {
    protocol: pick(reply.protocol, "number"),
    version: pick(reply.version, "string"),
    buildId: pick(reply.buildId, "string"),
    pluginRoot: pick(reply.pluginRoot, "string"),
    dbPath: pick(reply.dbPath, "string"),
    pid: pick(reply.pid, "number"),
  };
  return Object.values(got).some((value) => value !== null) ? got : null;
}

/** Emit valid Codex 0.149 UserPromptSubmit JSON — never raw context text. */
function emitContext(context) {
  return new Promise((resolve, reject) => {
    process.stdout.write(
      JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      }) + "\n",
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/**
 * Issue #44: a failure here means context reached the model with no durable
 * recall receipt behind it — the provenance contract is broken for that
 * emission. Codex discards hook stderr, so this must also land in the injection
 * log, which is the surface `memex doctor` reads.
 */
async function logReceiptFailure(via, prompt, message) {
  try {
    const { appendInjectLog } = await import(
      path.join(__dirname, "../dist/inject-log.js")
    );
    appendInjectLog({
      status: "receipt-failed",
      via,
      prompt_len: prompt ? prompt.length : 0,
      error: message,
    });
  } catch {
    /* observability is best-effort and must never break the prompt path */
  }
  process.stderr.write(`inject-context: recall receipt remained prepared: ${message}\n`);
}

async function markRecallEmitted(sessionId, prompt, receiptId = null, via = "fallback") {
  if (!sessionId || !prompt) return;
  try {
    const { initDatabase, markRecallEventEmitted } = await import(
      path.join(__dirname, "../dist/db.js")
    );
    const db = initDatabase();
    try {
      if (!markRecallEventEmitted(db, { sessionId, prompt, ...(receiptId ? { id: receiptId } : {}) })) {
        throw new Error("prepared receipt not found");
      }
    } finally {
      db.close();
    }
  } catch (error) {
    await logReceiptFailure(
      via,
      prompt,
      error instanceof Error ? error.message : String(error),
    );
  }
}
/**
 * Ask the warm daemon. Never rejects: every failure resolves to a refusal so the
 * caller falls back — the hook must never break a user prompt.
 *
 * Issue #84: identity travels WITH the prompt on the same connection, and the
 * daemon computes only after it agrees. A reply that is not `type:"ok"` — an
 * identity mismatch, a pre-0.6.3 daemon that cannot handshake, a foreign
 * listener, a timeout — is refused here, with the reason and the owner's
 * reported identity so the log can name the build that was holding the socket.
 * Still one round trip, so the 3s response budget is unchanged.
 *
 * Returns `{served}` on success, or `{refused: {reason, got}}`; `null` means
 * nothing was listening at all (the ordinary cold-start state, not a conflict).
 */
function askDaemon(prompt, cwd, sessionId, identity) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const refuse = (reason, got = null) => done({ refused: { reason, got } });
    let conn;
    try {
      conn = net.connect(injectSocketPath());
    } catch {
      return done(null);
    }
    const connectTimer = setTimeout(() => {
      conn.destroy();
      refuse("connect timeout");
    }, SOCKET_CONNECT_TIMEOUT_MS);
    conn.on("connect", () => {
      clearTimeout(connectTimer);
      conn.setTimeout(SOCKET_RESPONSE_TIMEOUT_MS, () => {
        conn.destroy();
        refuse("response timeout");
      });
      // Deliberately WITHOUT the pre-0.6.3 `session_id` field. A daemon that
      // cannot handshake can never serve this prompt — its reply is refused
      // below — so handing it the session only makes it do harm: it would run
      // `computeInjectContext` to completion and COMMIT the bundle transaction
      // (prepared recall receipt, resident fact revisions, gate state,
      // hot-evidence cursor). The in-process fallback would then find every fact
      // already resident at the same generation, dedup them all, and emit
      // nothing at all — while that receipt stayed `prepared` for ever. Omitting
      // the field makes an old daemon return at its own `if (!sessionId)` guard,
      // before it touches the database, leaving the fallback a clean run.
      conn.write(JSON.stringify({ type: "inject", ...identity, prompt, cwd, sessionId }) + "\n");
      let buf = "";
      conn.on("data", (c) => {
        buf += c.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let res = null;
        try {
          res = JSON.parse(buf.slice(0, nl));
        } catch {
          conn.destroy();
          return refuse("unparseable reply");
        }
        conn.destroy();
        if (res && res.type === "ok") {
          // The reply must carry back the identity we asked for. Saying `ok` is
          // not proof of anything: the socket path is predictable and any
          // same-user process can squat it, so without this the handshake would
          // gate the daemon's willingness to answer and nothing at all on the
          // hook's willingness to inject what came back.
          const echoed = ["protocol", "version", "buildId", "pluginRoot", "dbPath"]
            .every((field) => res[field] === identity[field]);
          if (!echoed) {
            return refuse("ok reply carried a different identity", reportedIdentity(res));
          }
          return done({
            served: {
              context: String(res.context ?? ""),
              receiptId: res.receiptId ? String(res.receiptId) : null,
              version: typeof res.version === "string" ? res.version : null,
              buildId: typeof res.buildId === "string" ? res.buildId : null,
              pid: typeof res.pid === "number" ? res.pid : null,
            },
          });
        }
        const reason =
          res && typeof res.reason === "string"
            ? res.reason
            : res && res.type
              ? `daemon replied ${String(res.type)}`
              : "no handshake in reply (pre-0.6.3 daemon or foreign listener)";
        refuse(reason, reportedIdentity(res));
      });
    });
    conn.on("error", (error) => {
      clearTimeout(connectTimer);
      // No socket / nobody listening is the ordinary state, not a conflict.
      if (error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        return done(null);
      }
      refuse(`socket error ${error && error.code ? error.code : "unknown"}`);
    });
  });
}

async function main() {
  // Parse hook input: stdin JSON first, env fallback (manual runs).
  const raw = await readStdin();
  let prompt = "";
  let cwd = "";
  let sessionId = "";
  if (raw) {
    try {
      const j = JSON.parse(raw);
      prompt = String(j.prompt ?? "");
      cwd = String(j.cwd ?? "");
      sessionId = String(j.session_id ?? ""); // 세션 dedup 원장 키 (hook stdin 계약)
    } catch {
      prompt = raw; // plain-text stdin = the prompt itself
    }
  }
  if (!prompt) prompt = process.env.USER_PROMPT || "";
  if (!cwd) cwd = process.env.CWD || process.cwd();
  if (!sessionId) sessionId = process.env.SESSION_ID || "";

  // CX-01: privacy-safe event observation (event/ts/session/cwd only).
  try {
    const { recordHookEvent } = await import(
      path.join(__dirname, "../dist/observe-hook-event.js")
    );
    recordHookEvent("UserPromptSubmit", { sessionId, cwd });
  } catch {
    /* observation is best-effort */
  }
  // Phase 5: the cheap gate decides what is worth retrieval. Only an empty
  // prompt is dropped here, so a short explicit memory question ("왜 Redis?")
  // still reaches the gate while acknowledgements skip without a model call.
  if (!prompt || prompt.trim().length === 0) return;

  // FAST PATH — warm daemon inside a running MCP server, but only one running
  // THIS installation's code (issue #84).
  const identity = localIdentity();
  const daemonResult = await askDaemon(prompt, cwd, sessionId, identity);
  if (daemonResult && daemonResult.served) {
    const served = daemonResult.served;
    if (served.context) {
      await emitContext(served.context);
      await markRecallEmitted(sessionId, prompt, served.receiptId, "daemon");
    }
    return;
  }

  // COLD FALLBACK — compute locally (heavy imports load only here).
  // A refusal is carried into the log line so "a stale build answered every
  // prompt" stops being invisible; nothing listening at all logs no daemon note.
  const daemonNote = daemonResult && daemonResult.refused
    ? {
        daemon: {
          expected: {
            version: identity.version,
            buildId: identity.buildId,
            pluginRoot: identity.pluginRoot,
            dbPath: identity.dbPath,
          },
          got: daemonResult.refused.got,
          reason: daemonResult.refused.reason,
        },
      }
    : {};
  try {
    const { computeInjectContext } = await import(
      path.join(__dirname, "../dist/inject-core.js")
    );
    let receiptId = null;
    const context = await computeInjectContext(
      prompt,
      cwd,
      "fallback",
      sessionId || undefined,
      { onPreparedReceipt: (id) => { receiptId = id; }, ...daemonNote },
    );
    if (context) {
      await emitContext(context);
      await markRecallEmitted(sessionId, prompt, receiptId, "fallback");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`inject-context: error: ${msg}\n`);
    if (/Cannot find (package|module)|ERR_MODULE_NOT_FOUND/.test(msg)) {
      // Fail loud, never auto-install: missing deps are an explicit setup step.
      process.stderr.write(
        "inject-context: runtime dependencies are missing. Run manually:\n" +
          `  cd "${path.join(__dirname, "..")}" && npm install && npm run build\n`,
      );
    }
  }
}

main();
