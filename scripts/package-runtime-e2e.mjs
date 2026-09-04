#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "memex-package-e2e-"));
const CODEX_HOME = path.join(TEMP, "codex-home");
const DATA_ROOT = path.join(TEMP, "data");
const NPM_CACHE = path.join(TEMP, "npm-cache");
const INSTALL_ROOT = path.join(TEMP, "installed");
const EXPECTED_TOOLS = [
  "ask_avatar",
  "cross_project_insights",
  "explore_graph",
  "graph_stats",
  "read",
  "search",
  "search_facts",
  "search_ontology",
  "trace_fact",
];

function run(command, args, options = {}) {
  const { env: extraEnv = {}, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME,
      MEMEX_HOME: DATA_ROOT,
      npm_config_cache: NPM_CACHE,
      ...extraEnv,
    },
    ...spawnOptions,
  });
  if (result.error || result.status !== 0) {
    const detail = (
      result.stderr ||
      result.stdout ||
      result.error?.message ||
      ""
    )
      .trim()
      .slice(-1200);
    throw new Error(
      command +
        " " +
        args.join(" ") +
        " failed (" +
        result.status +
        "): " +
        detail,
    );
  }
  return result;
}

function installedBin(binary, args = [], options = {}) {
  return run(path.join(INSTALL_ROOT, "node_modules", ".bin", binary), args, options);
}

function listInstalledMcpTools(input) {
  return new Promise((resolve, reject) => {
    const command = path.join(INSTALL_ROOT, "node_modules", ".bin", "memex-mcp-server");
    const child = spawn(command, [], {
      cwd: ROOT,
      env: {
        ...process.env,
        CODEX_HOME,
        MEMEX_HOME: DATA_ROOT,
        npm_config_cache: NPM_CACHE,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
        return;
      }
      if (child.exitCode !== null) {
        resolve(value);
        return;
      }
      child.once("close", () => resolve(value));
      child.kill();
    };
    const timer = setTimeout(() => {
      finish(new Error(`packaged MCP tools/list timed out: ${stderr.slice(-1200)}`));
    }, 30_000);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const response = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .find((item) => item?.id === 2);
      if (response) finish(null, response);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`packaged MCP exited before tools/list (${code}): ${stderr.slice(-1200)}`));
    });
    child.stdin.end(input);
  });
}

try {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", TEMP]).stdout,
  );
  const tarball = path.join(TEMP, packed[0].filename);
  if (!fs.existsSync(tarball))
    throw new Error("npm pack did not create a tarball");
  const packageSpec = "file:" + tarball;
  run("npm", ["install", "--prefix", INSTALL_ROOT, packageSpec], {
    timeout: 10 * 60 * 1000,
  });

  const initialize = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "package-runtime-e2e", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const response = await listInstalledMcpTools(
    initialize.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  const tools = (response?.result?.tools || []).map((tool) => tool.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(
      "packaged MCP tool mismatch: " + (tools.join(", ") || "none"),
    );
  }

  const help = installedBin("memex", ["--help"]);
  if (
    !help.stdout.includes(
      "setup       Detect conflicting Codex built-in Memory",
    ) ||
    !help.stdout.includes("sync        Sync conversations") ||
    !help.stdout.includes("backfill    Run extract")
  ) {
    throw new Error("packaged CLI help is incomplete");
  }
  const setup = installedBin("memex", ["setup", "--dry-run"]);
  if (!/Codex built-in Memory|already disabled/.test(setup.stdout)) {
    throw new Error("packaged setup did not inspect Codex built-in Memory");
  }
  const sync = installedBin("memex", ["sync"], {
    timeout: 2 * 60 * 1000,
  });
  if (!/Sync complete|No conversations|0/.test(sync.stdout)) {
    throw new Error(
      "packaged empty-corpus sync output was unexpected: " +
        sync.stdout.slice(-500),
    );
  }
  installedBin("memex", ["backfill", "all"], {
    timeout: 4 * 60 * 1000,
  });
  const status = installedBin("memex", ["status", "--json"]);
  const parsedStatus = JSON.parse(status.stdout);
  if (
    !parsedStatus.conversations ||
    !parsedStatus.extraction ||
    !parsedStatus.readiness
  ) {
    throw new Error("packaged status omitted readiness sections");
  }

  const hook = installedBin("memex-hook-inject", [], {
    input:
      JSON.stringify({
        prompt: "package runtime empty corpus hook validation prompt",
        cwd: ROOT,
        session_id: "package-e2e",
      }) + "\n",
    timeout: 2 * 60 * 1000,
  });
  if (hook.stdout.trim()) JSON.parse(hook.stdout.trim().split("\n")[0]);

  const sessions = path.join(CODEX_HOME, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const sessionId = "package-continuity-e2e";
  const transcript = path.join(sessions, "rollout-package-continuity.jsonl");
  fs.writeFileSync(transcript, `${JSON.stringify({
    type: "session_meta",
    payload: { id: sessionId, cwd: ROOT },
  })}\n`);
  const continuity = installedBin("memex-hook-continuity", [], {
    input: `${JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      transcript_path: transcript,
      cwd: ROOT,
    })}\n`,
    env: { MEMEX_CONTINUITY_NO_WAKE: "1" },
    timeout: 2 * 60 * 1000,
  });
  if (continuity.stdout) {
    throw new Error(`packaged Continuity hook emitted invalid stdout: ${continuity.stdout.slice(-500)}`);
  }
  const unexpectedHookStderr = continuity.stderr
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !value.startsWith("npm warn"));
  if (unexpectedHookStderr.length > 0)
    throw new Error(`packaged Continuity hook failed: ${unexpectedHookStderr.join("\n").slice(-500)}`);
  installedBin("memex-continuity-worker", [], {
    timeout: 2 * 60 * 1000,
  });

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        artifact: packed[0].filename,
        packedBytes: packed[0].size,
        unpackedBytes: packed[0].unpackedSize,
        files: packed[0].entryCount,
        mcpTools: tools.length,
        onboarding: ["setup --dry-run", "sync", "backfill all", "status"],
        hooks: ["UserPromptSubmit valid-or-empty", "SessionEnd final fence + deferred worker"],
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}
