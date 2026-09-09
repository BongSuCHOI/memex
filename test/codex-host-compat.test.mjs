// Stage 6 fixture contract. These are sanitized records produced by the
// bounded host harness; they never stand in for a missing host observation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
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


test("stale probe indexes a fresh captured session and grades corrections in their own field", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-stale-regression-"));
  try {
    const result = spawnSync("python3", ["-B", "-c", `
import importlib.util, json, os, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]); repo = pathlib.Path(sys.argv[2])
home = root / "codex-home"; project = root / "project"; memex = root / "memex-home"
for p in [home / "sessions", project, memex]: p.mkdir(parents=True, exist_ok=True)
os.environ.update(CODEX_HOME=str(home), MEMEX_HOME=str(memex), MEMEX_CONTINUITY_NO_WAKE="1", MEMEX_ALLOWED_TRANSCRIPT_ROOTS=str(home / "sessions"))
spec = importlib.util.spec_from_file_location("driver", repo / "scripts/codex-host-pty-driver.py")
driver = importlib.util.module_from_spec(spec); spec.loader.exec_module(driver)
session = "11111111-2222-4333-8444-555555555555"
rollout = home / "sessions/rollout.jsonl"
rows = [
 {"type":"session_meta", "payload":{"id":session,"cwd":str(project),"source":"cli"}},
 {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":driver.STALE_CONTENT_PROMPT}]}},
 {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"READY"}]}}
]
rollout.write_text("".join(json.dumps(dict(timestamp="2026-09-08T00:00:00Z", **r)) + chr(10) for r in rows))
hook = {"hook_event_name":"Stop","session_id":session,"cwd":str(project),"transcript_path":str(rollout)}
r = subprocess.run(["node",str(repo / "scripts/continuity-hook.js")],input=json.dumps(hook),text=True,capture_output=True,env=os.environ,timeout=15)
assert r.returncode == 0, r.stderr
sys.argv = ["driver","--root",str(root),"--project",str(project),"--memex-home",str(memex),"--hook-log",str(root/"hooks.jsonl"),"--log",str(root/"terminal.log"),"--summary",str(root/"summary.json"),"--phase","stale"]
d = driver.PtyDriver(driver.parse_args()); d.session_id = session
d.materialize_session_evidence()
assert d.latest_exchange()["user_message"] == driver.STALE_CONTENT_PROMPT
assert "retry count as 4" not in driver.STALE_QUERY_PROMPT
assert "earlier count 2" not in driver.STALE_QUERY_PROMPT
answer = {"currentGoal":"Repair retryQueue", "verifiedResults":[],"unverifiedHypotheses":["Unverified delay hypothesis"],"recentCorrections":["Approved retry count is 4, replacing the earlier count of 2."],"blockers":["Credentials unavailable"],"nextActions":["Run regression"],"evidenceLocations":["fixture.json"],"capsuleStatus":"stale/context-only","pending":["Capsule update"]}
d.materialize_session_evidence = lambda: None
d.latest_exchange = lambda **kwargs: {"id":"fixture", "assistant_message":json.dumps(answer)}
driver.EVIDENCE_SETTLE_SECONDS = 0
context = "stale/context-only; Pending: Capsule update; current retry count is 4"
graded = d.stale_content_evidence("", driver.STALE_QUERY_PROMPT, context)
assert all(graded["assertions"].values()), graded
answer["recentCorrections"] = []
assert not d.stale_content_evidence("",driver.STALE_QUERY_PROMPT,context)["assertions"]["old_retry_count_explained_as_replaced"]
print("fresh capture indexed; correction field graded; query contains no answer hint")
`, root, ROOT], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, MEMEX_CONTINUITY_NO_WAKE: "1" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
