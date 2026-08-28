#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let PACKAGE;
try {
  PACKAGE = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
} catch (e) {
  throw new Error(`Cannot read memex package.json: ${e.message}`);
}
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "memex-marketplace-e2e-"));
const CODEX_HOME = path.join(TEMP, "codex-home");
const DATA_ROOT = path.join(TEMP, "data");
const SOURCE = path.join(TEMP, "marketplace");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME, MEMEX_HOME: DATA_ROOT },
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
    );
  }
  return result;
}

function json(command, args, options = {}) {
  const result = run(command, args, options);
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(
      `${command} ${args.join(" ")} returned invalid JSON: ${e.message}`,
    );
  }
}

try {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  for (const directory of [
    ".agents",
    ".codex-plugin",
    "cli",
    "dist",
    "scripts",
    "skills",
    "ui",
  ]) {
    fs.cpSync(path.join(ROOT, directory), path.join(SOURCE, directory), {
      recursive: true,
    });
  }
  for (const file of [".mcp.json", "hooks.json", "package.json"]) {
    fs.copyFileSync(path.join(ROOT, file), path.join(SOURCE, file));
  }
  const market = json("codex", [
    "plugin",
    "marketplace",
    "add",
    SOURCE,
    "--json",
  ]);
  if (market.marketplaceName !== "memex")
    throw new Error(`marketplace name mismatch: ${market.marketplaceName}`);

  const added = json("codex", ["plugin", "add", "memex@memex", "--json"]);
  if (!added.installedPath || !path.isAbsolute(added.installedPath)) {
    throw new Error("plugin add did not return an absolute installedPath");
  }
  const installedRoot = fs.realpathSync(added.installedPath);
  if (installedRoot === fs.realpathSync(ROOT))
    throw new Error("plugin was not installed into an isolated Codex cache");

  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(installedRoot, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  if (manifest.version !== PACKAGE.version) {
    throw new Error(
      `installed version mismatch: ${manifest.version} != ${PACKAGE.version}`,
    );
  }
  if (manifest.hooks !== "./hooks.json")
    throw new Error("installed plugin does not declare hooks.json");
  for (const skill of [
    "analyzing-all-conversations",
    "remembering-conversations",
    "show-memex-dashboard",
  ]) {
    if (!fs.existsSync(path.join(installedRoot, "skills", skill, "SKILL.md"))) {
      throw new Error(`installed skill missing: ${skill}`);
    }
  }
  const mcp = JSON.parse(
    fs.readFileSync(path.join(installedRoot, ".mcp.json"), "utf8"),
  ).mcpServers?.memex;
  if (
    mcp?.command !== "node" ||
    mcp.args?.[0] !== "cli/runtime-exec.js" ||
    mcp.args?.[1] !== "memex-mcp-server" ||
    mcp.startup_timeout_sec !== 300
  ) {
    throw new Error(
      "installed MCP manifest does not use the shared runtime launcher",
    );
  }
  const hooks = JSON.parse(
    fs.readFileSync(path.join(installedRoot, "hooks.json"), "utf8"),
  ).hooks;
  const hookCommands = Object.values(hooks).flatMap((blocks) =>
    blocks.flatMap((block) => block.hooks.map((hook) => hook.command)),
  );
  if (
    hookCommands.length !== 6 ||
    hookCommands.some(
      (command) => !command.includes("${PLUGIN_ROOT}/cli/runtime-exec.js"),
    )
  ) {
    throw new Error("installed hooks do not use the shared runtime launcher");
  }
  const launcher = fs.readFileSync(
    path.join(installedRoot, "cli", "runtime-exec.js"),
    "utf8",
  );
  if (!launcher.includes("github:BongSuCHOI/memex#main"))
    throw new Error("runtime launcher does not target latest main");

  const help = run(
    process.execPath,
    [path.join(installedRoot, "cli", "memex.js"), "--help"],
    { cwd: installedRoot },
  );
  const installedCommands = new Set(
    (help.stdout.match(/^  [a-z][\w-]+(?=\s{2,})/gm) || []).map((line) =>
      line.trim(),
    ),
  );
  if (!installedCommands.has("sync") || !installedCommands.has("backfill")) {
    throw new Error("installed CLI help is incomplete");
  }
  const bad = spawnSync(
    process.execPath,
    [path.join(installedRoot, "cli", "memex.js"), "not-a-command"],
    {
      cwd: installedRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME,
        MEMEX_HOME: DATA_ROOT,
        MEMORY_BANK_PLUGIN_ROOT: installedRoot,
      },
    },
  );
  if (bad.status === 0 || !bad.stderr.includes("Unknown command"))
    throw new Error("installed CLI accepted a bad command");

  const listed = json("codex", ["plugin", "list", "--json"]);
  const plugin = (listed.installed || []).find(
    (item) => item.pluginId === "memex@memex",
  );
  if (!plugin?.installed || plugin.version !== PACKAGE.version)
    throw new Error("installed plugin was not discoverable");

  json("codex", ["plugin", "remove", "memex@memex", "--json"]);
  json("codex", ["plugin", "marketplace", "remove", "memex", "--json"]);
  const afterPlugins =
    json("codex", ["plugin", "list", "--json"]).installed || [];
  const afterMarkets =
    json("codex", ["plugin", "marketplace", "list", "--json"]).marketplaces ||
    [];
  if (afterPlugins.some((item) => item.pluginId === "memex@memex"))
    throw new Error("plugin removal failed");
  if (afterMarkets.some((item) => item.name === "memex"))
    throw new Error("marketplace removal failed");

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        marketplace: market.marketplaceName,
        plugin: plugin.pluginId,
        version: plugin.version,
        installedPath: installedRoot,
        runtimeLauncher: "github:BongSuCHOI/memex#main",
        skills: 3,
        hooks: ["SessionStart", "UserPromptSubmit", "SessionEnd"],
        cleanup: "PASS",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true });
}
