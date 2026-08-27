// memex backfill CLI contract (v0.2 UX):
//   - default execution mode is FOREGROUND (completion observable from exit code)
//   - 'all' orchestrates extract -> ontology -> embeddings sequentially,
//     stopping at the first failure
//   - --background detaches (kept as opt-in); output only reports start
//   - --foreground is accepted as a deprecated no-op for pre-v0.2 scripts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?!\/)/, "/")),
  "..",
);
const CLI = path.join(ROOT, "cli", "memex.js");

let tmpRoot;

function runMemex(args, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      MEMEX_HOME: path.join(tmpRoot, "home"),
      MEMEX_SESSIONS_DIR: path.join(tmpRoot, "sessions"),
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mb-backfill-cli-"));
  fs.mkdirSync(path.join(tmpRoot, "sessions"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memex backfill CLI 계약", () => {
  it('unknown target prints usage including "all" and fails', () => {
    let stderr = "";
    try {
      runMemex(["backfill", "bogus"]);
      assert.fail("expected nonzero exit");
    } catch (err) {
      assert.equal(err.status, 1);
      stderr = err.stderr;
    }
    assert.match(
      stderr,
      /Usage: memex backfill <all\|extract\|ontology\|embeddings>/,
    );
    assert.match(stderr, /\[--background\]/);
  });

  it("missing target also fails with usage", () => {
    try {
      runMemex(["backfill"]);
      assert.fail("expected nonzero exit");
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /Usage: memex backfill/);
    }
  });

  it("default (no flag) runs every stage to completion in-process", () => {
    const out = runMemex(["backfill", "all"]);
    for (const stage of ["extract", "ontology", "embeddings"]) {
      assert.match(
        out,
        new RegExp(`Running ${stage} backfill in foreground\\.\\.\\.`),
      );
    }
    assert.match(out, /All backfill stages completed\./);
  });

  it("--foreground remains accepted as deprecated no-op", () => {
    const out = runMemex(["backfill", "extract", "--foreground"]);
    assert.match(out, /Running extract backfill in foreground\.\.\./);
  });

  it("--background detaches and only claims to have started", () => {
    const out = runMemex(["backfill", "extract", "--background"]);
    assert.match(
      out,
      /started in background \(pid \d+\)\. Check progress: memex status/,
    );
    // No completion evidence in background mode's own output.
    assert.doesNotMatch(out, /completed/);
  });

  it("help text documents the orchestrated surface", () => {
    const out = runMemex(["--help"]);
    assert.match(
      out,
      /backfill\s+Run extract\/ontology\/embeddings backlog explicitly \('all' runs each stage in order\)/,
    );
  });
});
