// Stage 6 fixture contract. These are sanitized records produced by the
// bounded host harness; they never stand in for a missing host observation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(ROOT, "test", "fixtures", "codex-host", "0.153.4");
const PTY_DRIVER = path.join(ROOT, "scripts", "codex-host-pty-driver.py");

function fixtures() {
  return fs
    .readdirSync(FIXTURE_ROOT)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, name), "utf8")));
}

test("0.153.4 host fixtures preserve sanitized input and delivery evidence", () => {
  assert.ok(fs.existsSync(PTY_DRIVER), "real-TUI PTY driver is present");
  const records = fixtures();
  assert.ok(records.length >= 4);
  const names = new Set(records.map((record) => record.event));
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"])
    assert.ok(names.has(event), `missing observed ${event} fixture`);

  for (const record of records) {
    assert.equal(record.host, "codex-cli");
    assert.equal(record.version, "0.153.4");
    assert.ok(["codex-exec", "app-server-stdio", "codex-cli-pty"].includes(record.transport));
    assert.equal(record.replay, false);
    assert.match(record.source, /sanitized actual host-delivered payload/);
    assert.equal(record.prepared, true);
    assert.ok(record.input && typeof record.input === "object");
    assert.equal(record.input.cwd, "<project-cwd>");
    assert.equal(record.input.session_id, "<session_id>");
    assert.equal(record.input.transcript_path, "<codex-session-rollout>");
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /auth\.json|Bearer\s|codex-home|memex-home|HOST-UP-[0-9a-f]+/i);
    assert.doesNotMatch(serialized, /\/private\/|\/Users\//);
  }

  const prompt = records.find((record) => record.event === "UserPromptSubmit");
  assert.equal(prompt.input.prompt, "<user-prompt>");
  assert.equal(prompt.stdoutEmitted, true);
  assert.equal(prompt.hostAcceptance, true);
  assert.equal(prompt.hookOnlyNonceReflected, true);
  assert.equal(prompt.untrustedMemoryOverrideObserved, false);
});
