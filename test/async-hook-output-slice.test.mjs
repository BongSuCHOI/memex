import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "memex.js");
const VERSION_DRIFT_HOOK = path.join(
  ROOT,
  "scripts",
  "version-drift-check.js",
);
const SYNC_IMPORT_HOOK = path.join(ROOT, "scripts", "sync-import-hook.js");
const SYNC_EXPORT_HOOK = path.join(ROOT, "scripts", "sync-export-hook.js");

function runNode(script, args = [], options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

/**
 * Both sync hooks now go through dist/sync-control.js, which owns the two gates
 * (#35/#48): cross-device sync must be ON, and an export additionally needs a
 * durable change since the last one. The sandbox stubs that module so the hook
 * scripts' own reporting is what is under test.
 */
function makeSyncImportSandbox() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "memex-async-hook-"));
  const scripts = path.join(sandbox, "scripts");
  const dist = path.join(sandbox, "dist");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "package.json"), '{"type":"module"}\n');
  fs.copyFileSync(SYNC_IMPORT_HOOK, path.join(scripts, "sync-import-hook.js"));
  fs.copyFileSync(SYNC_EXPORT_HOOK, path.join(scripts, "sync-export-hook.js"));

  const positive = {
    newFacts: 1,
    updatedFacts: 2,
    deletedFacts: 3,
    newRevisions: 4,
    newTombstones: 5,
    newRecallEvents: 6,
    updatedRecallEvents: 7,
    malformedRows: [],
  };
  const malformed = {
    ...positive,
    newFacts: 0,
    updatedFacts: 0,
    deletedFacts: 0,
    newRevisions: 0,
    newTombstones: 0,
    newRecallEvents: 0,
    updatedRecallEvents: 0,
    malformedRows: [
      { file: "facts.jsonl", line: 2, error: "invalid JSON" },
    ],
  };
  fs.writeFileSync(
    path.join(dist, "sync-control.js"),
    `const positive = ${JSON.stringify(positive)};
const malformed = ${JSON.stringify(malformed)};
export async function runSyncImport() {
  const mode = process.env.FAKE_SYNC_IMPORT_MODE;
  if (mode === "disabled") return { skipped: "disabled", result: null, error: null };
  return { skipped: null, result: mode === "malformed" ? malformed : positive, error: null };
}
export function runSyncExport() {
  const mode = process.env.FAKE_SYNC_EXPORT_MODE;
  if (mode === "disabled") return { skipped: "disabled", result: null, error: null };
  if (mode === "unchanged") return { skipped: "unchanged", result: null, error: null };
  return {
    skipped: null,
    result: { facts: 11, revisions: 12, tombstones: 13, recallEvents: 14 },
    error: null,
  };
}
`,
  );
  return {
    sandbox,
    script: path.join(scripts, "sync-import-hook.js"),
    exportScript: path.join(scripts, "sync-export-hook.js"),
  };
}

async function waitForPathToDisappear(target, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(target) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForPathToAppear(target, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(target) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fs.existsSync(target);
}

test("sync --background keeps its operational notice off stdout", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-sync-hook-"));
  const home = path.join(root, "memex-home");
  const sessions = path.join(root, "missing-sessions");
  const locks = path.join(root, "locks");
  const workerExitMarker = path.join(root, "sync-worker-exited");
  const preload = path.join(root, "sync-exit-marker.cjs");
  fs.writeFileSync(
    preload,
    `const fs = require("node:fs");
const marker = process.env.MEMEX_TEST_SYNC_EXIT_MARKER;
const isSyncWorker = process.argv.some((arg) => /(?:^|[/\\\\])dist[/\\\\]sync-cli\\.js$/.test(arg)) &&
  !process.argv.includes("--background");
if (marker && isSyncWorker) {
  process.once("exit", () => {
    try { fs.writeFileSync(marker, String(process.pid)); } catch {}
  });
}
`,
  );
  try {
    const result = runNode(CLI, ["sync", "--background"], {
      env: {
        ...process.env,
        MEMEX_HOME: home,
        MEMEX_SESSIONS_DIR: sessions,
        MEMEX_RUN_LOCKS_DIR: locks,
        MEMEX_TEST_SYNC_EXIT_MARKER: workerExitMarker,
        NODE_OPTIONS: `--require=${preload}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Sync started in background\.\.\.\n$/);

    // The detached child sees the intentionally missing source and exits
    // without contacting a provider. Its inherited preload marks that exact
    // child at exit, so cleanup cannot race a late lock acquisition.
    assert.equal(
      await waitForPathToAppear(workerExitMarker),
      true,
      "detached sync worker did not exit within the test bound",
    );
    await waitForPathToDisappear(path.join(locks, "memex-sync.lock"));
    assert.equal(
      fs.existsSync(path.join(locks, "memex-sync.lock")),
      false,
      "detached sync worker did not release its isolated lock",
    );
  } finally {
    // If an assertion fails before the marker check, still give the detached
    // child a bounded chance to finish before removing its isolated root.
    await waitForPathToAppear(workerExitMarker);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sync-import hook writes positive and malformed summaries to stderr", () => {
  const { sandbox, script } = makeSyncImportSandbox();
  try {
    const positive = runNode(script, [], {
      cwd: sandbox,
      env: { ...process.env, FAKE_SYNC_IMPORT_MODE: "positive" },
    });
    assert.equal(positive.status, 0, positive.stderr);
    assert.equal(positive.stdout, "");
    assert.match(
      positive.stderr,
      /sync-import: facts \+1\/~2\/-3, \+4 revisions, \+5 tombstones, \+6\/~7 recall events\n/,
    );

    const malformed = runNode(script, [], {
      cwd: sandbox,
      env: { ...process.env, FAKE_SYNC_IMPORT_MODE: "malformed" },
    });
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(malformed.stdout, "");
    assert.match(
      malformed.stderr,
      /sync-import: payload issue at facts\.jsonl:2 — invalid JSON\n/,
    );
    assert.match(
      malformed.stderr,
      /sync-import: 1 payload issue\(s\) reported \(see stderr\)\n/,
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

/**
 * Issue #35 / #48 decision 5 — with cross-device sync off (the default) both
 * hooks must be a one-line no-op on stderr and must never touch stdout, which
 * Codex parses as hook output.
 */
test("sync hooks no-op with one stderr line when cross-device sync is off", () => {
  const { sandbox, script, exportScript } = makeSyncImportSandbox();
  try {
    const importRun = runNode(script, [], {
      cwd: sandbox,
      env: { ...process.env, FAKE_SYNC_IMPORT_MODE: "disabled" },
    });
    assert.equal(importRun.status, 0, importRun.stderr);
    assert.equal(importRun.stdout, "");
    assert.match(importRun.stderr, /sync-import: skipped \(cross-device sync is off\)\n/);
    assert.doesNotMatch(importRun.stderr, /facts \+/);

    const exportRun = runNode(exportScript, [], {
      cwd: sandbox,
      env: { ...process.env, FAKE_SYNC_EXPORT_MODE: "disabled" },
    });
    assert.equal(exportRun.status, 0, exportRun.stderr);
    assert.equal(exportRun.stdout, "");
    assert.match(exportRun.stderr, /sync-export: skipped \(cross-device sync is off\)\n/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the sync export hook reports unchanged state and a published generation", () => {
  const { sandbox, exportScript } = makeSyncImportSandbox();
  try {
    const unchanged = runNode(exportScript, [], {
      cwd: sandbox,
      env: { ...process.env, FAKE_SYNC_EXPORT_MODE: "unchanged" },
    });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.stdout, "");
    assert.match(
      unchanged.stderr,
      /sync-export: skipped \(no durable change since the last export\)\n/,
    );

    const published = runNode(exportScript, [], {
      cwd: sandbox,
      env: { ...process.env, FAKE_SYNC_EXPORT_MODE: "published" },
    });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.stdout, "");
    assert.match(
      published.stderr,
      /sync-export: 11 facts, 12 revisions, 13 tombstones, 14 recall events\n/,
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("version drift warning stays on stderr", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-version-hook-"));
  const fakeBin = path.join(root, "bin");
  const codexHome = path.join(root, "codex-home");
  const newerVersion = "99.0.0";
  try {
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(
      path.join(
        codexHome,
        "plugins",
        "cache",
        "test-marketplace",
        "memex",
        newerVersion,
      ),
      { recursive: true },
    );
    const fakePs = path.join(fakeBin, "ps");
    fs.writeFileSync(fakePs, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakePs, 0o755);

    const result = runNode(VERSION_DRIFT_HOOK, [], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      new RegExp(
        `\\[memex\\] version drift: this session runs v[^ ]+ but v${newerVersion} is installed\\.`,
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
