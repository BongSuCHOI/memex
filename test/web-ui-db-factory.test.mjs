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

function startUi(dbPath, port) {
  const child = spawn(process.execPath, [path.join(REPO, "ui/server.cjs")], {
    cwd: REPO,
    env: {
      ...process.env,
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
    child.stdout.on("data", (chunk) => {
      if (chunk.includes(`Memex UI: http://localhost:${port}`)) {
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

async function mutate(base, action, id, extra = {}) {
  const response = await fetch(`${base}/api/facts-mutate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base,
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
  const dbPath = path.join(temp, "db.sqlite");
  const previousDbPath = process.env.MEMEX_DB_PATH;
  process.env.MEMEX_DB_PATH = dbPath;
  t.after(() => {
    if (previousDbPath === undefined) delete process.env.MEMEX_DB_PATH;
    else process.env.MEMEX_DB_PATH = previousDbPath;
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
  const ui = startUi(dbPath, port);
  t.after(() => stop(ui.child));
  await ui.ready;
  const base = `http://127.0.0.1:${port}`;

  const editedText = "The Web UI always shares initialized database connections.";
  const edit = await mutate(base, "edit", id, {
    text: editedText,
    reason: "Web UI vec0 E2E",
  });
  assert.equal(edit.embeddingRefreshed, true);
  await mutate(base, "deactivate", id);
  await mutate(base, "restore", id);

  const check = initDatabase();
  assert.deepEqual(
    check
      .prepare(
        "SELECT fact, is_active, needs_consolidation FROM facts WHERE id = ?",
      )
      .get(id),
    { fact: editedText, is_active: 1, needs_consolidation: 1 },
  );
  assert.equal(
    check
      .prepare("SELECT COUNT(*) AS c FROM fact_revisions WHERE fact_id = ?")
      .get(id).c,
    1,
  );
  assert.equal(
    check.prepare("SELECT COUNT(*) AS c FROM vec_facts WHERE id = ?").get(id).c,
    1,
  );
  check.close();
  assert.doesNotMatch(ui.getStderr(), /no such module|DB open failed|Error:/i);
});
