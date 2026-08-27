#!/usr/bin/env node
// Explicit, idempotent Memex installer.
// Dependencies and builds are preconditions; this script never installs them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializePluginDependencies } from "./materialize-plugin-dependencies.mjs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const opt = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const MARKET_ARG = opt("--marketplace");
const REPO = path.resolve(
  opt(
    "--plugin-root",
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  ),
);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const DATA_ROOT =
  process.env.MEMEX_HOME ||
  process.env.MEMORY_BANK_HOME ||
  process.env.MEMORY_BANK_CONFIG_DIR ||
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "memex",
  );
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

function command(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const detail = (
      result.stderr ||
      result.stdout ||
      result.error?.message ||
      ""
    )
      .trim()
      .slice(-500);
    throw new Error(
      `${cmd} ${cmdArgs.join(" ")} failed (${result.status}): ${detail}`,
    );
  }
  return result;
}

function jsonCommand(cmd, cmdArgs, options = {}) {
  const result = command(cmd, cmdArgs, options);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${cmd} ${cmdArgs.join(" ")} returned invalid JSON`);
  }
}

function ok(name, detail) {
  console.log(
    `OK    [${DRY ? "dry-run" : "run"}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
}

function check(name, fn) {
  const detail = fn();
  ok(name, detail);
}

/**
 * Read a marketplace.json manifest defensively. Returns null when missing or
 * malformed so auto-discovery can move on to the next candidate instead of
 * crashing on an unrelated half-written directory.
 */
function readMarketplaceManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function marketplaceFromArgument() {
  if (!MARKET_ARG) {
    const candidates = [
      path.join(REPO, "..", `${path.basename(REPO)}-marketplace`),
      path.join(REPO, "marketplace"),
    ];
    for (const candidate of candidates) {
      const manifestPath = path.join(
        candidate,
        ".agents",
        "plugins",
        "marketplace.json",
      );
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = readMarketplaceManifest(manifestPath);
      if (!manifest || typeof manifest.name !== "string") {
        console.error(
          `WARN  [${DRY ? "dry-run" : "run"}] unreadable marketplace manifest — skipped: ${manifestPath}`,
        );
        continue;
      }
      return { name: manifest.name, source: path.resolve(candidate) };
    }
    return null;
  }
  const candidate = path.resolve(MARKET_ARG);
  const manifestPath = path.join(
    candidate,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  if (fs.existsSync(manifestPath)) {
    const manifest = readMarketplaceManifest(manifestPath);
    if (!manifest || typeof manifest.name !== "string") {
      throw new Error(
        `Explicit marketplace has a missing or invalid manifest: ${manifestPath}`,
      );
    }
    return { name: manifest.name, source: candidate };
  }
  return { name: MARKET_ARG, source: null };
}

function marketplaces() {
  return (
    jsonCommand("codex", ["plugin", "marketplace", "list", "--json"])
      .marketplaces || []
  );
}

function installedPlugin(marketName) {
  const installed =
    jsonCommand("codex", ["plugin", "list", "--json"]).installed || [];
  return (
    installed.find((plugin) => plugin.pluginId === `memex@${marketName}`) ||
    null
  );
}

function authoritativeRoot(marketName, addResult = null) {
  const listed = installedPlugin(marketName);
  const added =
    typeof addResult?.installedPath === "string"
      ? addResult.installedPath
      : null;
  const cached = listed?.version
    ? path.join(
        CODEX_HOME,
        "plugins",
        "cache",
        marketName,
        listed.name || "memex",
        listed.version,
      )
    : null;
  if (
    added &&
    cached &&
    fs.existsSync(cached) &&
    fs.realpathSync(added) !== fs.realpathSync(cached)
  ) {
    throw new Error(`installedPath mismatch: add=${added} cache=${cached}`);
  }
  // plugin list.source.path is the marketplace source checkout, not the
  // executable installation. On an idempotent rerun resolve the documented
  // Codex cache identity (market/name/version); never fall back to source.path.
  const root = added || cached;
  if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) {
    throw new Error("Codex did not provide a valid installed plugin root");
  }
  for (const required of [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "cli/memex.js",
    "cli/mcp-server-wrapper.js",
    "dist/mcp-server.js",
    "scripts/inject-context-hook.sh",
    "package.json",
    "ui/server.cjs",
    "ui/relations/app.js",
  ]) {
    if (!fs.existsSync(path.join(root, required))) {
      throw new Error(
        `installed plugin root is incomplete: missing ${required}`,
      );
    }
  }
  return fs.realpathSync(root);
}

function verifyMcpHandshake(root) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-install-mcp-"));
  try {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "memex-installer", version: "1" },
      },
    };
    const initialized = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    };
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const input =
      [initialize, initialized, list]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n";
    const result = command(
      process.execPath,
      [path.join(root, "cli", "mcp-server-wrapper.js")],
      {
        cwd: root,
        env: {
          ...process.env,
          MEMORY_BANK_PLUGIN_ROOT: root,
          MEMORY_BANK_HOME: temp,
          TEST_DB_PATH: path.join(temp, "conversation-index", "db.sqlite"),
        },
        input,
        timeout: 15_000,
      },
    );
    const responses = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const toolResponse = responses.find((response) => response.id === 2);
    const names = (toolResponse?.result?.tools || [])
      .map((tool) => tool.name)
      .sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(
        `installed MCP tools mismatch: ${names.join(", ") || "none"}`,
      );
    }
    return names.length;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const market = marketplaceFromArgument();

try {
  check("runtime precheck: node >= 22.15", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 15))
      throw new Error(`node ${process.versions.node} too old`);
    return process.version;
  });
  check("codex CLI present", () =>
    command("codex", ["--version"]).stdout.trim(),
  );
  check("dependencies installed", () => {
    if (!fs.existsSync(path.join(REPO, "node_modules")))
      throw new Error(
        `node_modules missing — run manually: cd "${REPO}" && npm install`,
      );
    return "node_modules present";
  });
  check("build artifacts present", () => {
    for (const required of [
      "dist/db.js",
      "dist/lifecycle.js",
      "dist/mcp-server.js",
    ]) {
      if (!fs.existsSync(path.join(REPO, required)))
        throw new Error(
          `${required} missing — run manually: cd "${REPO}" && npm run build`,
        );
    }
    return "dist/db.js, dist/lifecycle.js, dist/mcp-server.js present";
  });
  check("marketplace discovery", () => {
    if (!market?.name)
      throw new Error(
        "No local marketplace found. Pass --marketplace <registered-name|marketplace-directory>",
      );
    const registered = marketplaces().some((item) => item.name === market.name);
    if (!registered && !market.source)
      throw new Error(
        `marketplace "${market.name}" is not registered; pass its local directory`,
      );
    return `${market.name}${market.source ? ` at ${market.source}` : " (already registered)"}`;
  });
} catch (error) {
  console.error(
    `FAIL  [${DRY ? "dry-run" : "run"}] preflight — ${error.message}`,
  );
  console.error("No plugin, hook, or Memex data changes were made.");
  process.exit(1);
}

const pluginId = `memex@${market.name}`;
const marketWasRegistered = marketplaces().some(
  (item) => item.name === market.name,
);
const pluginWasInstalled = installedPlugin(market.name) !== null;

if (DRY) {
  ok(
    "marketplace registration",
    marketWasRegistered ? "already registered" : `would add ${market.source}`,
  );
  ok(
    "plugin installation",
    pluginWasInstalled ? "already installed" : `would add ${pluginId}`,
  );
  const existingRoot = pluginWasInstalled
    ? authoritativeRoot(market.name)
    : null;
  ok(
    "runtime dependency packaging",
    existingRoot
      ? `would verify/materialize ${existingRoot}/node_modules`
      : "would package preinstalled production dependencies into installedPath",
  );
  ok(
    "installed-root MCP handshake",
    existingRoot
      ? `would verify ${existingRoot}`
      : "would verify Codex installedPath after installation",
  );
  ok(
    "plugin-managed lifecycle hooks",
    "would verify hooks.json from the installed manifest",
  );
  ok("doctor gate", "would require all critical checks ok");
  ok("foreground first sync", "would run from installedPath");
  ok("pipeline status", "would read readiness from installedPath");
  console.log("\nInstall dry-run complete — nothing was changed.");
  process.exit(0);
}

let marketAddedThisRun = false;
let pluginInstalledThisRun = false;
let dependenciesMaterializedThisRun = false;
let installedRoot = null;
const hooksFile = path.join(CODEX_HOME, "hooks.json");
const hooksBefore = fs.existsSync(hooksFile)
  ? fs.readFileSync(hooksFile, "utf8")
  : null;

function restoreHooks() {
  if (hooksBefore === null) {
    if (fs.existsSync(hooksFile)) fs.rmSync(hooksFile, { force: true });
  } else {
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, hooksBefore);
  }
}

function rollback(error) {
  console.error(`FAIL  [run] install — ${error.message}`);
  console.error("Rolling back registration artifacts created by this run.");
  try {
    restoreHooks();
  } catch (hookError) {
    console.error(`  hook restore failed: ${hookError.message}`);
  }
  if (pluginInstalledThisRun) {
    try {
      command("codex", ["plugin", "remove", pluginId, "--json"]);
    } catch (removeError) {
      console.error(`  plugin removal failed: ${removeError.message}`);
    }
  } else if (dependenciesMaterializedThisRun && installedRoot) {
    try {
      fs.rmSync(path.join(installedRoot, "node_modules"), {
        recursive: true,
        force: true,
      });
    } catch (removeError) {
      console.error(`  dependency rollback failed: ${removeError.message}`);
    }
  }
  if (marketAddedThisRun) {
    try {
      command("codex", [
        "plugin",
        "marketplace",
        "remove",
        market.name,
        "--json",
      ]);
    } catch (removeError) {
      console.error(`  marketplace removal failed: ${removeError.message}`);
    }
  }
  if (fs.existsSync(path.join(DATA_ROOT, "conversation-index"))) {
    console.error(
      `Registration rollback complete; partial Memex data is preserved at ${path.join(DATA_ROOT, "conversation-index")}.`,
    );
  } else {
    console.error(
      "Registration rollback complete; no Memex data directory was created.",
    );
  }
  process.exit(1);
}

try {
  if (!marketWasRegistered) {
    command("codex", ["plugin", "marketplace", "add", market.source, "--json"]);
    marketAddedThisRun = true;
    ok("marketplace registration", `registered ${market.name}`);
  } else {
    ok("marketplace registration", "already registered");
  }

  let addResult = null;
  if (!pluginWasInstalled) {
    addResult = jsonCommand("codex", ["plugin", "add", pluginId, "--json"]);
    pluginInstalledThisRun = true;
  }
  installedRoot = authoritativeRoot(market.name, addResult);
  ok(
    "plugin installation",
    `${pluginWasInstalled ? "already installed" : "installed"} at ${installedRoot}`,
  );

  const packaged = materializePluginDependencies(REPO, installedRoot);
  dependenciesMaterializedThisRun = packaged.changed;
  ok(
    "runtime dependency packaging",
    packaged.changed
      ? `${packaged.packages} preinstalled production packages copied into Codex cache (no npm install/network)`
      : "installed cache dependency tree already complete",
  );

  const toolCount = verifyMcpHandshake(installedRoot);
  ok(
    "installed-root MCP handshake",
    `${toolCount} tools from ${installedRoot}`,
  );

  const pluginManifest = JSON.parse(
    fs.readFileSync(
      path.join(installedRoot, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  if (pluginManifest.hooks !== "./hooks.json")
    throw new Error("installed plugin manifest does not declare ./hooks.json");
  const pluginHooks = JSON.parse(
    fs.readFileSync(path.join(installedRoot, "hooks.json"), "utf8"),
  ).hooks;
  for (const event of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
    if (
      !Array.isArray(pluginHooks?.[event]) ||
      pluginHooks[event].length === 0
    ) {
      throw new Error(`installed plugin hooks missing ${event}`);
    }
  }
  ok(
    "plugin-managed lifecycle hooks",
    "SessionStart, UserPromptSubmit, SessionEnd declared; restart Codex to activate",
  );

  const doctor = jsonCommand(
    process.execPath,
    [path.join(installedRoot, "cli", "memex.js"), "doctor", "--json"],
    {
      env: { ...process.env, MEMORY_BANK_PLUGIN_ROOT: installedRoot },
    },
  );
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const critical = [
    "dependencies",
    "build",
    "codex-home",
    "lifecycle-configured",
    "mcp-manifest",
  ];
  const failedCritical = critical.filter(
    (name) =>
      !checks.some((item) => item.name === name && item.status === "ok"),
  );
  if (doctor.overall === "FAIL" || failedCritical.length) {
    throw new Error(
      `doctor critical checks failed: ${failedCritical.join(", ") || doctor.overall}`,
    );
  }
  ok("doctor gate", `overall=${doctor.overall}; critical checks ok`);

  command(
    process.execPath,
    [path.join(installedRoot, "cli", "memex.js"), "sync"],
    {
      env: { ...process.env, MEMORY_BANK_PLUGIN_ROOT: installedRoot },
      timeout: 30 * 60 * 1000,
    },
  );
  ok("foreground first sync", "sync complete");

  const status = command(
    process.execPath,
    [path.join(installedRoot, "cli", "memex.js"), "status"],
    {
      env: { ...process.env, MEMORY_BANK_PLUGIN_ROOT: installedRoot },
    },
  );
  ok("pipeline status", status.stdout.trim().split("\n").slice(-3).join(" | "));
} catch (error) {
  rollback(error);
}

console.log(`\nInstall complete. Authoritative plugin root: ${installedRoot}`);
