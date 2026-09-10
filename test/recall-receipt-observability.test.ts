import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db.js";
import { appendInjectLog, getInjectLogPath } from "../src/inject-log.js";
import { doctor } from "../src/lifecycle.js";

/**
 * Issue #44 — an emitted bundle with no durable recall receipt was invisible.
 *
 * Observed on the real data root (v0.5.2):
 *
 *   SELECT count(*) FROM recall_events;            -- 0
 *   SELECT count(*) FROM conversation_exclusions;  -- 0  (no privacy purge)
 *
 * while `logs/inject-context.jsonl` recorded seven `status: "injected"` lines
 * between 2026-09-05 and 2026-09-09. The provenance contract
 * (RETRIEVAL-AND-CONTEXT.md §43-48) requires a durable `prepared` receipt
 * before context is emitted, and post-hoc audit depends entirely on it. The
 * failure went only to hook stderr, which Codex discards, and doctor's
 * `inject-output` check never looked at `recall_events`.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let root: string;

async function check(name: string) {
  return (await doctor()).json.find((entry) => entry.name === name)!;
}

beforeEach(() => {
  // Short names on purpose: this fixture binds a unix socket under MEMEX_HOME
  // and macOS caps sun_path at 104 bytes.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mx-"));
  process.env.MEMEX_HOME = path.join(root, "h");
  process.env.MEMEX_DB_PATH = path.join(root, "h", "conversation-index", "db.sqlite");
  process.env.CODEX_HOME = path.join(root, "c");
  process.env.MEMEX_PLUGIN_ROOT = REPO;
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.CODEX_HOME;
  delete process.env.MEMEX_PLUGIN_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

it("doctor fails inject-output on a receipt-failed line", async () => {
  const db = initDatabase();
  db.close();
  appendInjectLog({ status: "injected", chars: 208, sections: ["ASSISTANT CONTEXT"], via: "fallback" });
  appendInjectLog({ status: "receipt-failed", via: "fallback", error: "prepared receipt not found" });

  const injectOutput = await check("inject-output");
  expect(injectOutput.status).toBe("fail");
  expect(injectOutput.detail).toContain("receipt-failed");
  expect(injectOutput.detail).toContain("no durable recall receipt");
});

/**
 * Issue #84 — the `inject-daemon` check probes the socket for an identity, and a
 * pre-0.6.3 daemon answers that probe by running `computeInjectContext("")`,
 * appending `no-session-provenance, via:"daemon", prompt_len:0`. Left in the log
 * readers, the NEXT `memex doctor` would warn about a line doctor itself caused.
 * A real prompt is never empty, so an empty-prompt provenance line can only be a
 * probe artifact.
 */
it("an empty-prompt provenance line from the daemon probe does not become a doctor warning", async () => {
  const db = initDatabase();
  db.close();
  appendInjectLog({ status: "injected", chars: 208, sections: ["CURRENT TRUTH"], injected: 2, via: "daemon" });
  appendInjectLog({ status: "no-session-provenance", via: "daemon", prompt_len: 0 });

  const injectOutput = await check("inject-output");
  expect(injectOutput.status).toBe("ok");
  // The verdict belongs to the real run, not to the probe artifact.
  expect(injectOutput.detail).toContain("injected");
  expect(injectOutput.detail).not.toContain("no-session-provenance");

  // A provenance line from a REAL prompt is still a warning.
  appendInjectLog({ status: "no-session-provenance", via: "fallback", prompt_len: 42 });
  expect((await check("inject-output")).status).toBe("warn");
});

it("doctor fails recall-provenance when emitted bundles have no recall_events rows", async () => {
  const db = initDatabase();
  try {
    // The exact observed rows: emissions logged, receipts absent, no purge.
    expect(db.prepare("SELECT COUNT(*) AS c FROM recall_events").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM conversation_exclusions").get()).toEqual({ c: 0 });
  } finally {
    db.close();
  }
  for (let i = 0; i < 7; i++) {
    appendInjectLog({ status: "injected", chars: 208, sections: ["ASSISTANT CONTEXT"], via: "fallback" });
  }

  const provenance = await check("recall-provenance");
  expect(provenance.status).toBe("fail");
  expect(provenance.detail).toContain("7 emitted bundle(s)");
  expect(provenance.detail).toContain("recall_events is empty");
  expect((await doctor()).overall).toBe("FAIL");
});

it("doctor passes recall-provenance once the receipts exist", async () => {
  const db = initDatabase();
  try {
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO recall_events
          (id, session_id, project, prompt_hash, fact_ids, status, created_at, emitted_at)
        VALUES (?, 'session-1', ?, ?, '[]', 'emitted', ?, ?)`)
        .run(`receipt-${i}`, root, `hash-${i}`, now, now);
    }
  } finally {
    db.close();
  }
  for (let i = 0; i < 3; i++) {
    appendInjectLog({ status: "injected", chars: 208, via: "fallback" });
  }

  const provenance = await check("recall-provenance");
  expect(provenance.status).toBe("ok");
  expect(provenance.detail).toContain("3 recall_events row(s)");
});

it("the real injection hook logs receipt-failed after emitting context with no receipt", async () => {
  initDatabase().close();
  // A daemon that answers with context and a receipt id that is not in the
  // database — exactly the observed shape: context emitted, receipt absent.
  const socketPath = path.join(process.env.MEMEX_HOME!, "conversation-index", "inject-daemon.sock");
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  // Issue #84: the hook only trusts a daemon that answers `type:"ok"` with the
  // identity it asked for, so the stand-in echoes the handshake back.
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const asked = JSON.parse(String(chunk).split("\n")[0]) as Record<string, unknown>;
      socket.write(JSON.stringify({
        type: "ok",
        protocol: asked.protocol,
        version: asked.version,
        buildId: asked.buildId,
        pluginRoot: asked.pluginRoot,
        dbPath: asked.dbPath,
        pid: process.pid,
        ok: true,
        context: "MEMORY CONTEXT",
        receiptId: "never-prepared",
      }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    // Spawned asynchronously on purpose: execFileSync would block this
    // process's event loop and the fake daemon could never accept the socket.
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(REPO, "scripts", "inject-context.js")], {
        env: process.env,
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", () => resolve(stdout));
      child.stdin.end(
        JSON.stringify({ prompt: "why did we choose SQLite?", cwd: root, session_id: "session-1" }),
      );
    });
    // Context did reach the model...
    expect(JSON.parse(result).hookSpecificOutput.additionalContext).toBe("MEMORY CONTEXT");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(socketPath, { force: true });
  }

  // ...and the broken provenance is now in the log, not only on discarded stderr.
  const lines = fs.readFileSync(getInjectLogPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.at(-1)).toMatchObject({ status: "receipt-failed", via: "daemon" });
  expect(String(lines.at(-1).error)).toContain("prepared receipt not found");

  expect((await check("inject-output")).status).toBe("fail");
  expect((await check("recall-provenance")).status).toBe("fail");
});
