#!/usr/bin/env node
// CX-05 — installed-lifecycle E2E harness (explicit execution only).
//
//   node scripts/lifecycle-e2e.mjs --tier offline
//   node scripts/lifecycle-e2e.mjs --tier authenticated
//
// Both tiers run inside a fresh mktemp root: CODEX_HOME, MEMEX_HOME, local
// marketplace and a staged plugin copy. The user's real ~/.codex,
// ~/.config/memex and the Memex DB are only ever READ (hash snapshots)
// and are verified byte-identical after the run.
//
// offline        — setup/remove idempotency, foreign-entry preservation,
//                  handler wiring with stub workers, injection JSON shape,
//                  cleanup inventory. No network, no model calls.
// authenticated  — everything above plus REAL codex exec canaries for
//                  SessionStart / UserPromptSubmit / SessionEnd and one real
//                  deferred Work Capsule update through the Continuity worker.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializePluginDependencies } from "./materialize-plugin-dependencies.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const TIER = args.includes("--tier")
  ? args[args.indexOf("--tier") + 1]
  : "offline";
const KEEP = args.includes("--keep");

const results = [];
function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => {
      results.push({ name, status: "PASS", detail: detail || "" });
    })
    .catch((err) => {
      results.push({
        name,
        status: "FAIL",
        detail: err && err.message ? err.message : String(err),
      });
    });
}
const sha256 = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
/** JSON.parse guarded at the boundary: a malformed subprocess payload fails
 * as that step's labeled Error instead of crashing the whole harness. */
function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `${label}: invalid JSON (${e && e.message ? e.message : String(e)})`,
    );
  }
}
function treeContains(root, needle) {
  if (!fs.existsSync(root)) return false;
  const target = Buffer.from(needle);
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return fs.readlinkSync(current).includes(needle);
    if (stat.isFile()) return fs.readFileSync(current).includes(target);
    if (!stat.isDirectory()) return false;
    return fs
      .readdirSync(current)
      .some((name) => visit(path.join(current, name)));
  };
  return visit(root);
}

// Keep the MCP Unix-socket path below macOS sockaddr_un's limit.
const TMP = fs.mkdtempSync("/tmp/mb-e2e-");
const CODEX_HOME = path.join(TMP, "codex-home");
const MB_HOME = path.join(TMP, "mb-home");
const MARKET = path.join(TMP, "marketplace");
const MARKET_NAME = "memex-e2e";
const PLUGIN_ID = `memex@${MARKET_NAME}`;
const PLUGIN = path.join(MARKET, "plugins", "memex"); // staged plugin copy (real code)
const RUN_MARKER = `MB-E2E-${crypto.randomBytes(16).toString("hex")}`;
const TEST_PROJECT = path.join(TMP, RUN_MARKER);
let ACTIVE_PLUGIN = PLUGIN;
for (const d of [
  CODEX_HOME,
  path.join(CODEX_HOME, "sessions"),
  MB_HOME,
  PLUGIN,
])
  fs.mkdirSync(d, { recursive: true });

// Stage the real plugin tree (dist + scripts + cli) so registered commands work.
fs.cpSync(path.join(REPO, "dist"), path.join(PLUGIN, "dist"), {
  recursive: true,
});
fs.cpSync(path.join(REPO, "scripts"), path.join(PLUGIN, "scripts"), {
  recursive: true,
});
fs.cpSync(path.join(REPO, "cli"), path.join(PLUGIN, "cli"), {
  recursive: true,
});
fs.cpSync(path.join(REPO, "ui"), path.join(PLUGIN, "ui"), { recursive: true });
fs.cpSync(
  path.join(REPO, ".codex-plugin"),
  path.join(PLUGIN, ".codex-plugin"),
  { recursive: true },
);
fs.cpSync(path.join(REPO, "skills"), path.join(PLUGIN, "skills"), {
  recursive: true,
});
fs.copyFileSync(path.join(REPO, ".mcp.json"), path.join(PLUGIN, ".mcp.json"));
fs.copyFileSync(
  path.join(REPO, "package.json"),
  path.join(PLUGIN, "package.json"),
);
fs.copyFileSync(path.join(REPO, "hooks.json"), path.join(PLUGIN, "hooks.json"));
const marketManifestDir = path.join(MARKET, ".agents", "plugins");
fs.mkdirSync(marketManifestDir, { recursive: true });
fs.writeFileSync(
  path.join(marketManifestDir, "marketplace.json"),
  JSON.stringify(
    {
      name: MARKET_NAME,
      plugins: [
        {
          name: "memex",
          source: { source: "local", path: "./plugins/memex" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Engineering",
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
// Workers resolve better-sqlite3 / sqlite-vec relative to the plugin root;
// link the repo's installed dependencies instead of copying them.
try {
  fs.symlinkSync(
    path.join(REPO, "node_modules"),
    path.join(PLUGIN, "node_modules"),
    "dir",
  );
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}

// User-environment fingerprints (read-only).
const USER_HOOKS = path.join(os.homedir(), ".codex", "hooks.json");
const USER_CONFIG = path.join(os.homedir(), ".codex", "config.toml");
const USER_DATA_ROOT = path.join(os.homedir(), ".config", "memex");
const before = {};
before.hooks = fs.existsSync(USER_HOOKS) ? sha256(USER_HOOKS) : "ABSENT";
before.config = fs.existsSync(USER_CONFIG) ? sha256(USER_CONFIG) : "ABSENT";
before.userPluginList = spawnSync("codex", ["plugin", "list", "--json"], {
  encoding: "utf8",
}).stdout;
before.userMarketplaceList = spawnSync(
  "codex",
  ["plugin", "marketplace", "list", "--json"],
  { encoding: "utf8" },
).stdout;
// Capture the temp socket path for later inventory. The real user data root is
// live while this suite runs, so its SQLite WAL/SHM and hook log are expected
// to change. Isolation is proven with stable config/registry bytes plus a
// per-run marker that must never appear anywhere under the real data root.
const TEMP_SOCKET = path.join(
  MB_HOME,
  "conversation-index",
  "inject-daemon.sock",
);

const ENV = {
  ...process.env,
  CODEX_HOME,
  MEMEX_HOME: MB_HOME,
  MEMEX_PLUGIN_ROOT: PLUGIN,
};
const MB = (cmd, extraEnv = {}) =>
  spawnSync(process.execPath, [path.join(REPO, "cli", "memex.js"), ...cmd], {
    env: { ...ENV, ...extraEnv },
    encoding: "utf8",
  });
const CODEX = (cmd) => spawnSync("codex", cmd, { env: ENV, encoding: "utf8" });
async function main() {
  // ── Step 1: pre-setup state has no Memex entries ────────────────────────
  await step("pre-setup: no Memex hook entries", () => {
    const f = path.join(CODEX_HOME, "hooks.json");
    if (fs.existsSync(f)) {
      const txt = fs.readFileSync(f, "utf8");
      if (txt.includes("_memex"))
        throw new Error("unexpected Memex entries before setup");
    }
    return "clean temp codex home";
  });

  await step("isolated Codex marketplace and plugin registration", () => {
    let r = CODEX(["plugin", "marketplace", "add", MARKET, "--json"]);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    r = CODEX(["plugin", "add", PLUGIN_ID, "--json"]);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    const added = parseJson(r.stdout, "codex plugin add output");
    const listed = CODEX(["plugin", "list", "--json"]);
    if (listed.status !== 0) throw new Error(listed.stderr || listed.stdout);
    const entry = parseJson(
      listed.stdout,
      "codex plugin list output",
    ).installed.find((plugin) => plugin.pluginId === PLUGIN_ID);
    if (
      !entry ||
      !added.installedPath ||
      !path.isAbsolute(added.installedPath)
    ) {
      throw new Error("Codex did not return an authoritative installedPath");
    }
    ACTIVE_PLUGIN = fs.realpathSync(added.installedPath);
    const packaged = materializePluginDependencies(REPO, ACTIVE_PLUGIN);
    ENV.MEMEX_PLUGIN_ROOT = ACTIVE_PLUGIN;
    return `registered ${PLUGIN_ID} at ${ACTIVE_PLUGIN}; packaged ${packaged.packages} production dependencies`;
  });

  // ── Step 2: dry-run shows diff, mutates nothing ─────────────────────────
  await step("setup-hooks --dry-run shows adds without writing", () => {
    const r = MB(["setup-hooks", "--dry-run"]);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    if (!r.stdout.includes("Add:") || !r.stdout.includes("No files changed."))
      throw new Error(`dry-run output:\n${r.stdout}`);
    if (fs.existsSync(path.join(CODEX_HOME, "hooks.json")))
      throw new Error("dry-run wrote hooks.json");
    return r.stdout.trim().split("\n").length + " lines";
  });

  // ── Step 3: setup registers exactly owned entries, idempotently ───
  await step("setup-hooks registers events; second run is a no-op", () => {
    let r = MB(["setup-hooks"]);
    if (r.status !== 0) throw new Error(r.stderr);
    const file = path.join(CODEX_HOME, "hooks.json");
    const after1 = fs.readFileSync(file, "utf8");
    const owned1 = (after1.match(/_memex/g) || []).length;
    if (owned1 !== 11)
      throw new Error(`expected 11 owned entries, got ${owned1}`);

    r = MB(["setup-hooks"]);
    if (r.status !== 0) throw new Error(r.stderr);
    const after2 = fs.readFileSync(file, "utf8");
    if (after2 !== after1)
      throw new Error("second setup changed the file (not idempotent)");
    return "idempotent merge confirmed";
  });
  // ── Step 4 (offline): handler wiring with stub worker ───────────────────
  if (TIER === "offline") {
    await step(
      "UserPromptSubmit handler emits valid no-match JSON shape",
      () => {
        // Cold path with an EMPTY data root: must exit 0 with either nothing or
        // valid Codex JSON (no-match => nothing). Never wedge.
        const input = JSON.stringify({
          prompt: `a prompt longer than twenty characters for the gate ${RUN_MARKER}`,
          cwd: TEST_PROJECT,
          session_id: RUN_MARKER,
        });
        const r = spawnSync(
          "bash",
          [path.join(ACTIVE_PLUGIN, "scripts", "inject-context-hook.sh")],
          {
            input,
            env: ENV,
            encoding: "utf8",
            timeout: 120000,
          },
        );
        if (r.status !== 0)
          throw new Error(`exit ${r.status}: ${r.stderr.slice(0, 300)}`);
        if (r.stdout.trim()) {
          const j = parseJson(
            r.stdout.split("\n")[0],
            "inject hook stdout shape",
          );
          if (
            !j.hookSpecificOutput ||
            j.hookSpecificOutput.hookEventName !== "UserPromptSubmit"
          ) {
            throw new Error(`invalid stdout shape: ${r.stdout.slice(0, 200)}`);
          }
        }
        return "exit 0, valid-or-empty stdout";
      },
    );

    await step(
      "SessionEnd handler: empty rollout creates a final fence without foreground work",
      async () => {
        const tp = path.join(TMP, "rollout-empty.jsonl");
        fs.writeFileSync(
          tp,
          JSON.stringify({
            type: "session_meta",
            timestamp: "t",
            payload: {
              id: RUN_MARKER,
              session_id: RUN_MARKER,
              cwd: TEST_PROJECT,
              source: "cli",
            },
          }) + "\n",
        );
        const r = spawnSync(
          process.execPath,
          [path.join(ACTIVE_PLUGIN, "scripts", "session-end-hook.js")],
          {
            input: JSON.stringify({
              hook_event_name: "SessionEnd",
              transcript_path: tp,
              session_id: RUN_MARKER,
              cwd: TEST_PROJECT,
            }),
            env: {
              ...ENV,
              MEMEX_ALLOWED_TRANSCRIPT_ROOTS: TMP,
              MEMEX_CONTINUITY_NO_WAKE: "1",
            },
            encoding: "utf8",
            timeout: 60000,
          },
        );
        if (r.status !== 0) throw new Error(`exit ${r.status}`);
        if (r.stdout || r.stderr)
          throw new Error(`expected silent valid output, got: ${(r.stdout + r.stderr).slice(0, 200)}`);
        const { default: Database } = await import("better-sqlite3");
        const db = new Database(path.join(MB_HOME, "conversation-index", "db.sqlite"), { readonly: true });
        const fence = db.prepare(`
          SELECT kind, closure_state FROM checkpoints WHERE session_id = ?
        `).get(RUN_MARKER);
        const jobs = db.prepare(`
          SELECT COUNT(*) AS n FROM memory_jobs WHERE checkpoint_id IN
            (SELECT checkpoint_id FROM checkpoints WHERE session_id = ?)
        `).get(RUN_MARKER);
        db.close();
        if (fence?.kind !== "final" || fence?.closure_state !== "final" || Number(jobs?.n) !== 2)
          throw new Error(`missing final fence/outbox: ${JSON.stringify({ fence, jobs })}`);
        return "final fence + capture_index/capsule_update pending; no foreground worker";
      },
    );
  }

  // ── Step 5 (authenticated): real Codex fires the registered commands ────
  if (TIER === "authenticated") {
    const authSrc = path.join(os.homedir(), ".codex", "auth.json");
    if (!fs.existsSync(authSrc))
      throw new Error("authenticated tier requires ~/.codex/auth.json");

    await step("copy auth into temp codex home (isolated)", () => {
      fs.copyFileSync(authSrc, path.join(CODEX_HOME, "auth.json"));
      fs.chmodSync(path.join(CODEX_HOME, "auth.json"), 0o600);
      return "ok";
    });

    await step("plugin runtime canary uses no fallback hook registration", () => {
      const r = MB(["remove-hooks"]);
      if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
      const file = path.join(CODEX_HOME, "hooks.json");
      if (fs.existsSync(file) && /_memex/.test(fs.readFileSync(file, "utf8"))) {
        throw new Error("fallback Memex hooks remain beside plugin-managed hooks");
      }
      return "plugin-managed hooks are the sole active Memex registration";
    });

    // Canary variants of the SAME registered script names: proves Codex
    // executes whatever setup-hooks registered at these paths.
    // Use a hook-only random nonce that NEVER appears in the user prompt.
    const nonce = `E2E-HOOK-ONLY-${crypto.randomBytes(8).toString("hex")}`;
    const canaryLog = path.join(TMP, "canary.jsonl");
    const canary = (event) => `import fs from 'node:fs';
let input=''; process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>{
  fs.appendFileSync(${JSON.stringify(canaryLog)}, JSON.stringify({event:${JSON.stringify(event)},stdin:JSON.parse(input||'{}')})+'\\n');
});`;
    fs.writeFileSync(
      path.join(ACTIVE_PLUGIN, "scripts", "version-drift-check.js"),
      canary("SessionStart"),
    );
    fs.writeFileSync(
      path.join(ACTIVE_PLUGIN, "scripts", "session-start-maintenance.js"),
      canary("SessionStart"),
    );
    fs.writeFileSync(
      path.join(ACTIVE_PLUGIN, "scripts", "continuity-hook.js"),
      `import fs from 'node:fs';
let input=''; process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>{
  const parsed=JSON.parse(input||'{}');
  fs.appendFileSync(${JSON.stringify(canaryLog)}, JSON.stringify({event:parsed.hook_event_name,stdin:parsed})+'\\n');
});`,
    );
    // Mock the sync command to avoid "Sync started..." output interfering with model reply
    const syncCanaryPath = path.join(ACTIVE_PLUGIN, "cli", "memex.js");
    fs.writeFileSync(
      syncCanaryPath,
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nlet i='';process.stdin.on('data',d=>i+=d);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(canaryLog)}, JSON.stringify({event:"SessionStart",stdin:JSON.parse(i||"{}")})+"\\n")});\n`,
    );
    const hookJson = JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: nonce,
      },
    });
    fs.writeFileSync(
      path.join(ACTIVE_PLUGIN, "scripts", "inject-context.js"),
      `import fs from 'node:fs';\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const j=JSON.parse(input||'{}');fs.appendFileSync(${JSON.stringify(canaryLog)},JSON.stringify({event:'UserPromptSubmit',stdin:j})+'\\n');process.stdout.write(${JSON.stringify(hookJson + "\n")});});\n`,
    );
    await step(
      "real codex exec fires SessionStart/UserPromptSubmit/SessionEnd",
      async () => {
        fs.rmSync(canaryLog, { force: true });
        const workdir = path.join(TMP, "work");
        fs.mkdirSync(workdir, { recursive: true });
        const r = spawnSync(
          "codex",
          [
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-hook-trust",
            "-C",
            workdir,
            "If you have additional context, repeat verbatim the text it contains. Otherwise say NONE.",
          ],
          { env: ENV, encoding: "utf8", timeout: 180000 },
        );
        if (r.status !== 0)
          throw new Error(`codex exec failed: ${(r.stderr || "").slice(-300)}`);
        const events = fs.existsSync(canaryLog)
          ? fs
              .readFileSync(canaryLog, "utf8")
              .trim()
              .split("\n")
              .map((l) => parseJson(l, "canary event log line"))
          : [];
        const names = events.map((e) => e.event).sort();
        for (const expected of [
          "SessionStart",
          "SessionEnd",
          "UserPromptSubmit",
        ]) {
          if (!names.includes(expected))
            throw new Error(`missing canary event ${expected}; got ${names}`);
        }
        for (const unique of ["UserPromptSubmit", "Stop", "SessionEnd"]) {
          const count = names.filter((name) => name === unique).length;
          if (count !== 1) throw new Error(`expected one ${unique}, got ${count}`);
        }
        const ups = events.find((e) => e.event === "UserPromptSubmit");
        if (!ups.stdin.prompt || typeof ups.stdin.prompt !== "string")
          throw new Error("UserPromptSubmit stdin lacked prompt");
        if (!ups.stdin.session_id)
          throw new Error("UserPromptSubmit stdin lacked session_id");
        if (ups.stdin.prompt.includes(nonce))
          throw new Error(
            "nonce leaked into user prompt (false positive risk)",
          );
        const reply = (r.stdout || "").trim();
        if (!reply.includes(nonce))
          throw new Error(
            `additionalContext not injected; reply: ${reply.slice(0, 200)}`,
          );
        return `events=${names.join(",")} injection=observed nonce=${nonce.slice(0, 16)}...`;
      },
    );
    await step(
      "real SessionEnd final fence then deferred Capsule update through Luna",
      async () => {
        // Restore real handlers, write the final fence synchronously, then run
        // the durable queue worker as a separate process.
        fs.rmSync(canaryLog, { force: true });
        fs.cpSync(
          path.join(REPO, "scripts"),
          path.join(ACTIVE_PLUGIN, "scripts"),
          { recursive: true },
        );
        const sessDir = path.join(CODEX_HOME, "sessions", "2026", "08", "26");
        fs.mkdirSync(sessDir, { recursive: true });
        const sid = "01a039aa-1111-4222-8333-a44445555666";
        const rollout = path.join(
          sessDir,
          `rollout-2026-08-26T01-00-00-${sid}.jsonl`,
        );
        fs.writeFileSync(
          rollout,
          [
            JSON.stringify({
              timestamp: "2026-08-26T01:00:00Z",
              type: "session_meta",
              payload: {
                id: sid,
                session_id: sid,
                timestamp: "2026-08-26T01:00:00Z",
                cwd: TEST_PROJECT,
                originator: "codex-tui",
                cli_version: "0.149.1",
                source: "cli",
              },
            }),
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: `We decided the API will use cursor pagination with encrypted opaque cursors. Test marker: ${RUN_MARKER}`,
                  },
                ],
              },
            }),
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: `Understood: cursor pagination with encrypted opaque cursors is the chosen approach. Marker ${RUN_MARKER}.`,
                  },
                ],
              },
            }),
          ].join("\n") + "\n",
        );
        const started = Date.now();
        const r = spawnSync(
          process.execPath,
          [path.join(ACTIVE_PLUGIN, "scripts", "continuity-hook.js")],
          {
            input: JSON.stringify({
              hook_event_name: "SessionEnd",
              transcript_path: rollout,
              session_id: sid,
              cwd: TEST_PROJECT,
            }),
            env: {
              ...ENV,
              MEMEX_CONTINUITY_NO_WAKE: "1",
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        if (r.status !== 0 || r.stdout || r.stderr)
          throw new Error(`final fence failed: status=${r.status} ${(r.stdout + r.stderr).slice(-300)}`);
        const hookMs = Date.now() - started;
        const { default: Database } = await import("better-sqlite3");
        const dbPath = path.join(MB_HOME, "conversation-index", "db.sqlite");
        let db = new Database(dbPath, { readonly: true });
        const pending = db.prepare(`
          SELECT COUNT(*) AS n FROM memory_jobs WHERE checkpoint_id IN
            (SELECT checkpoint_id FROM checkpoints WHERE session_id = ?)
            AND state = 'pending'
        `).get(sid);
        db.close();
        if (Number(pending.n) !== 2) throw new Error(`expected two deferred jobs, got ${pending.n}`);
        const worker = spawnSync(
          process.execPath,
          [path.join(ACTIVE_PLUGIN, "scripts", "continuity-worker.js")],
          { env: ENV, encoding: "utf8", timeout: 600000 },
        );
        if (worker.status !== 0)
          throw new Error(`continuity worker failed: ${worker.stderr.slice(-500)}`);
        db = new Database(dbPath, { readonly: true });
        const capsule = db.prepare(`
          SELECT generation, authority FROM work_capsules
          WHERE workstream_id = (SELECT workstream_id FROM session_memory_state WHERE session_id = ?)
        `).get(sid);
        db.close();
        if (!capsule || Number(capsule.generation) < 1 || capsule.authority !== "context-only")
          throw new Error(`Capsule missing after worker: ${JSON.stringify(capsule)}; worker=${worker.stderr.slice(-1000)}`);
        return `hook=${hookMs}ms, deferred jobs=2, Capsule generation=${capsule.generation}`;
      },
    );
  }

  // ── Next-session observability: compact resumes from local projection ───
  if (TIER === "authenticated") {
    await step(
      "next-session compact rehydrates the local Work Capsule immediately",
      () => {
        const sid = "01a039aa-1111-4222-8333-a44445555666";
        const r = spawnSync(
          process.execPath,
          [path.join(ACTIVE_PLUGIN, "scripts", "continuity-hook.js")],
          {
            input: JSON.stringify({
              hook_event_name: "SessionStart",
              source: "compact",
              session_id: sid,
              cwd: TEST_PROJECT,
            }),
            env: { ...ENV, MEMEX_CONTINUITY_NO_WAKE: "1" },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
        const output = parseJson(r.stdout, "compact additionalContext");
        const context = output?.hookSpecificOutput?.additionalContext;
        if (!context || (!context.includes("[WORK NOW]") && !context.includes("[WORK NOW — DETERMINISTIC TAIL BATON]")))
          throw new Error(`Capsule context not surfaced: ${r.stdout.slice(0, 300)}`);
        return "bounded Work Capsule context emitted without retrieval/model wait";
      },
    );
  }

  // ── Step N: removal preserves foreign entries; data preserved ───────────
  await step("remove-hooks removes only owned entries", () => {
    const setup = MB(["setup-hooks"]);
    if (setup.status !== 0) throw new Error(setup.stderr || `setup-hooks exit ${setup.status}`);
    // Plant a foreign entry first.
    const file = path.join(CODEX_HOME, "hooks.json");
    const j = parseJson(
      fs.readFileSync(file, "utf8"),
      "hooks.json before foreign-entry plant",
    );
    j.hooks.PreToolUse = [
      {
        matcher: "^Bash$",
        hooks: [{ command: "atuin hook codex", type: "command" }],
      },
    ];
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    const r = MB(["remove-hooks"]);
    if (r.status !== 0) throw new Error(r.stderr);
    const afterJ = parseJson(
      fs.readFileSync(file, "utf8"),
      "hooks.json after remove-hooks",
    );
    if (!afterJ.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command)
      throw new Error("foreign entry removed!");
    if (
      afterJ.hooks.SessionStart ||
      afterJ.hooks.UserPromptSubmit ||
      afterJ.hooks.SessionEnd
    ) {
      throw new Error("owned entries not removed");
    }
    return `removed 11 owned, foreign preserved`;
  });

  await step("remove isolated plugin and marketplace registrations", () => {
    let r = CODEX(["plugin", "remove", PLUGIN_ID, "--json"]);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    r = CODEX(["plugin", "marketplace", "remove", MARKET_NAME, "--json"]);
    if (r.status !== 0) throw new Error(r.stderr || r.stdout);
    const plugins =
      parseJson(
        CODEX(["plugin", "list", "--json"]).stdout,
        "isolated plugin registry after removal",
      ).installed || [];
    const markets =
      parseJson(
        CODEX(["plugin", "marketplace", "list", "--json"]).stdout,
        "isolated marketplace registry after removal",
      ).marketplaces || [];
    if (plugins.some((plugin) => plugin.pluginId === PLUGIN_ID))
      throw new Error("plugin registration survived remove");
    if (markets.some((market) => market.name === MARKET_NAME))
      throw new Error("marketplace registration survived remove");
    return "plugin and marketplace absent from isolated Codex registry";
  });

  let cleanupReceipt = null;
  await step("cleanup inventory: 7-surface exact check", () => {
    const errors = [];

    // 1. Plugin and marketplace registration are absent from the live isolated registry.
    const pluginList = CODEX(["plugin", "list", "--json"]);
    const marketplaceList = CODEX(["plugin", "marketplace", "list", "--json"]);
    const pluginRegistrationAbsent =
      pluginList.status === 0 &&
      !(
        parseJson(pluginList.stdout, "cleanup inventory plugin list")
          .installed || []
      ).some((plugin) => plugin.pluginId === PLUGIN_ID) &&
      marketplaceList.status === 0 &&
      !(
        parseJson(marketplaceList.stdout, "cleanup inventory marketplace list")
          .marketplaces || []
      ).some((market) => market.name === MARKET_NAME);
    if (!pluginRegistrationAbsent)
      errors.push("isolated plugin or marketplace registration remains");

    // 2. Owned hooks are absent while the planted foreign hook remains.
    const tempHooksPath = path.join(CODEX_HOME, "hooks.json");
    let hooks = null;
    try {
      hooks = JSON.parse(fs.readFileSync(tempHooksPath, "utf8"));
    } catch {
      errors.push("temp hooks.json unreadable");
    }
    const ownedHooksAbsent =
      hooks !== null &&
      !JSON.stringify(hooks).includes("_memex") &&
      Boolean(hooks.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command);
    if (!ownedHooksAbsent)
      errors.push("owned hooks remain or foreign hook was lost");

    // 3-6. Inspect the process table and live socket ownership before deleting
    // test data, then delete only this test's roots and prove absence.
    const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    const testWorkers = (ps.stdout || "")
      .split("\n")
      .filter(
        (line) =>
          line.includes(TMP) ||
          line.includes(MB_HOME) ||
          line.includes(CODEX_HOME),
      );
    const testWorkersZero = testWorkers.length === 0;
    if (!testWorkersZero)
      errors.push(
        `test-owned workers remain: ${testWorkers.join("; ").slice(0, 300)}`,
      );

    const socketOwners = fs.existsSync(TEMP_SOCKET)
      ? spawnSync("lsof", [TEMP_SOCKET], { encoding: "utf8" })
      : { status: 1, stdout: "" };
    const testListenersZero =
      socketOwners.status !== 0 || !(socketOwners.stdout || "").trim();
    if (!testListenersZero)
      errors.push(
        `test socket still has a live listener: ${socketOwners.stdout.slice(0, 300)}`,
      );

    fs.rmSync(MB_HOME, { recursive: true, force: true });
    fs.rmSync(MARKET, { recursive: true, force: true });
    const tempDataAbsent = !fs.existsSync(MB_HOME) && !fs.existsSync(MARKET);
    const injectSocketsZero = !fs.existsSync(TEMP_SOCKET);
    if (!tempDataAbsent) errors.push("test DB/archive/log/plugin tree remains");
    if (!injectSocketsZero) errors.push("test inject socket remains");

    // 7. Compare the real user surfaces byte-for-byte/tree-for-tree and also
    // compare the actual user Codex plugin registries obtained from the CLI.
    const afterHooks = fs.existsSync(USER_HOOKS)
      ? sha256(USER_HOOKS)
      : "ABSENT";
    const afterConfig = fs.existsSync(USER_CONFIG)
      ? sha256(USER_CONFIG)
      : "ABSENT";
    const afterUserPluginList = spawnSync(
      "codex",
      ["plugin", "list", "--json"],
      { encoding: "utf8" },
    ).stdout;
    const afterUserMarketplaceList = spawnSync(
      "codex",
      ["plugin", "marketplace", "list", "--json"],
      { encoding: "utf8" },
    ).stdout;
    const userEnvironmentIsolated =
      afterHooks === before.hooks &&
      afterConfig === before.config &&
      afterUserPluginList === before.userPluginList &&
      afterUserMarketplaceList === before.userMarketplaceList &&
      !treeContains(USER_DATA_ROOT, RUN_MARKER);
    if (!userEnvironmentIsolated)
      errors.push(
        "stable user config/registry changed or test marker leaked into real user data",
      );

    cleanupReceipt = {
      plugin_registration_absent: pluginRegistrationAbsent,
      owned_hooks_absent: ownedHooksAbsent,
      temp_data_absent: tempDataAbsent,
      test_workers_zero: testWorkersZero,
      inject_sockets_zero: injectSocketsZero,
      test_listeners_zero: testListenersZero,
      user_environment_isolated: userEnvironmentIsolated,
    };
    if (errors.length) throw new Error(errors.join("; "));
    return JSON.stringify(cleanupReceipt);
  });

  // Report
  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n=== CX-05 lifecycle E2E (" + TIER + ") ===");
  for (const r of results)
    console.log(
      `${r.status === "PASS" ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`,
    );
  console.log(
    `\n${results.length - failed.length}/${results.length} steps passed${failed.length ? ` — FAILURES: ${failed.length}` : ""}`,
  );
  if (cleanupReceipt)
    console.log(`__CLEANUP_JSON__${JSON.stringify(cleanupReceipt)}`);
  if (KEEP) console.log(`Kept isolated outer root for diagnosis: ${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
  process.exitCode = failed.length ? 1 : 0;
}

main();
