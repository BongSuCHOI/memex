import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startUi(dbPath, port, home) {
  const child = spawn(process.execPath, [path.join(REPO, "ui/server.cjs")], {
    cwd: REPO,
    env: {
      ...process.env,
      // The UI writes its audit log and operation metadata under MEMEX_HOME:
      // pin both it and the XDG fallback to this test's temp dir so nothing
      // lands in the developer's real ~/.config/memex.
      MEMEX_HOME: home,
      XDG_CONFIG_HOME: path.join(home, "xdg"),
      MEMEX_DB_PATH: dbPath,
      MEMEX_PLUGIN_ROOT: REPO,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`UI start timeout\n${stderr}`)),
      10_000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // ui/lib/server.cjs prints "Memex Workspace <v>\nhttp://127.0.0.1:<port>".
      if (stdout.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI exited ${code}\n${stderr}`));
    });
  });
  return { child, ready, getStderr: () => stderr };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function bootstrap(base) {
  const response = await fetch(`${base}/api/v2/bootstrap`, {
    headers: { Origin: base },
  });
  const payload = await response.json();
  assert.equal(
    response.status,
    200,
    `bootstrap failed: ${JSON.stringify(payload)}`,
  );
  assert.equal(
    payload.db.available,
    true,
    `UI could not open the DB: ${JSON.stringify(payload.db.error)}`,
  );
  return payload;
}

async function mutate(base, token, action, id, extra = {}) {
  const response = await fetch(`${base}/api/v2/facts/mutate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      "X-Memex-CSRF": token,
    },
    body: JSON.stringify({ action, id, ...extra }),
  });
  const payload = await response.json();
  assert.equal(
    response.status,
    200,
    `${action} failed: ${JSON.stringify(payload)}`,
  );
  return payload;
}

test("Web UI mutations use a sqlite-vec initialized writable connection", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-ui-db-factory-"));
  const home = path.join(temp, "home");
  fs.mkdirSync(home, { recursive: true });
  const dbPath = path.join(temp, "db.sqlite");
  const restore = {};
  for (const key of ["MEMEX_DB_PATH", "MEMEX_HOME", "XDG_CONFIG_HOME"])
    restore[key] = process.env[key];
  process.env.MEMEX_DB_PATH = dbPath;
  process.env.MEMEX_HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, "xdg");
  t.after(() => {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const { initDatabase } = await import(path.join(REPO, "dist/db.js"));
  const { insertFact } = await import(path.join(REPO, "dist/fact-db.js"));
  const db = initDatabase();
  const id = insertFact(db, {
    fact: "The Web UI shares initialized database connections.",
    category: "decision",
    scope_type: "global",
    scope_project: null,
    source_exchange_ids: [],
    embedding: new Array(384).fill(0.1),
    embedding_version: 1,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM vec_facts WHERE id = ?").get(id).c,
    1,
  );
  db.close();

  const port = await freePort();
  const ui = startUi(dbPath, port, home);
  t.after(() => stop(ui.child));
  await ui.ready;
  const base = `http://127.0.0.1:${port}`;

  const { csrfToken } = await bootstrap(base);

  const editedText = "The Web UI always shares initialized database connections.";
  const edit = await mutate(base, csrfToken, "edit", id, {
    text: editedText,
    reason: "Web UI vec0 E2E",
  });
  assert.equal(edit.embeddingRefreshed, true);
  await mutate(base, csrfToken, "deactivate", id);
  await mutate(base, csrfToken, "restore", id);

  const check = initDatabase();
  assert.deepEqual(
    check
      .prepare(
        "SELECT fact, is_active, needs_consolidation FROM facts WHERE id = ?",
      )
      .get(id),
    { fact: editedText, is_active: 1, needs_consolidation: 1 },
  );
  // fact_revisions is the Chronicle ledger: one event per applied mutation.
  assert.deepEqual(
    check
      .prepare(
        "SELECT event_kind, COUNT(*) AS c FROM fact_revisions WHERE fact_id = ? GROUP BY event_kind ORDER BY event_kind",
      )
      .all(id),
    [
      { event_kind: "CHANGED", c: 1 },
      { event_kind: "RESTORED", c: 1 },
      { event_kind: "RETIRED", c: 1 },
    ],
  );
  assert.equal(
    check.prepare("SELECT COUNT(*) AS c FROM vec_facts WHERE id = ?").get(id).c,
    1,
  );
  check.close();
  // Isolation receipt: the UI audit trail for a temp DB stays in the temp home.
  const audit = path.join(home, "logs", "ui-audit.jsonl");
  assert.equal(fs.existsSync(audit), true, "UI audit log missing from temp home");
  assert.equal(
    fs.readFileSync(audit, "utf8").trim().split("\n").length,
    3,
    "expected exactly the three UI mutations in the isolated audit log",
  );
  assert.doesNotMatch(ui.getStderr(), /no such module|DB open failed|Error:/i);
});
