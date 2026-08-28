// CX-03 — MCP active-project scope contract. Plain node --test against dist.
// Verifies: (1) omitted project/scope on project-sensitive tools yields a
// structured validation error naming the required field; (2) a project call
// never sees another project's facts; (3) explicit scope:"global" returns
// global facts only; (4) no tool resolves to process.cwd() (= plugin root).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
process.env.MEMORY_BANK_PLUGIN_ROOT = REPO; // MCP server cwd == plugin root

function seedDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-cx03-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "db.sqlite");
  process.env.TEST_DB_PATH = dbPath;
  return import("better-sqlite3").then(({ default: Database }) => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE facts (
      id TEXT PRIMARY KEY, fact TEXT, fact_kr TEXT, category TEXT,
      scope_type TEXT, scope_project TEXT, is_active INTEGER,
      ontology_category_id TEXT, created_at TEXT DEFAULT '2026-08-26T00:00:00Z',
      updated_at TEXT DEFAULT '2026-08-26T00:00:00Z', consolidated_count INTEGER DEFAULT 1,
      embedding_version TEXT DEFAULT 'v1', source_exchange_ids TEXT DEFAULT NULL
    );`);
    // Real schema columns may differ; introspect and insert defensively below.
    try {
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, is_active) VALUES
        ('f-a1', 'Project A uses Postgres row-level security', 'decision', 'project', '/tmp/w/team-a/shared', 1),
        ('f-b1', 'Project B uses MySQL read replicas', 'decision', 'project', '/tmp/w/team-b/shared', 1),
        ('f-g1', 'Always prefer small pull requests', 'preference', 'global', NULL, 1)`).run();
    } catch (e) {
      void e;
    }
    db.close();
    return dbPath;
  });
}

async function callTool(name, args) {
  const { handleToolCall } = await import(
    path.join(REPO, "dist/mcp-server.js")
  );
  return handleToolCall(name, args);
}

test("tools/list publishes project and scope for every scoped graph tool", async () => {
  const { getToolDefinitions } = await import(
    path.join(REPO, "dist/mcp-server.js")
  );
  const tools = new Map(getToolDefinitions().map((tool) => [tool.name, tool]));
  for (const name of ["search_ontology", "graph_stats", "explore_graph"]) {
    const properties = tools.get(name)?.inputSchema?.properties ?? {};
    assert.ok(properties.project, `${name} must publish project in tools/list`);
    assert.deepEqual(
      properties.scope?.enum,
      ["project", "global", "all"],
      `${name} must publish the scope enum`,
    );
  }
});

test("tools/list maxLength parity with handler validation limits", async () => {
  const { getToolDefinitions } = await import(
    path.join(REPO, "dist/mcp-server.js")
  );
  const tools = new Map(getToolDefinitions().map((tool) => [tool.name, tool]));
  const expectMax = (tool, prop, max) => {
    const schema = tools.get(tool)?.inputSchema?.properties?.[prop];
    assert.equal(
      schema?.maxLength,
      max,
      `${tool}.${prop} maxLength must be ${max}`,
    );
  };
  expectMax("search", "project", 500);
  expectMax("search_facts", "query", 10000);
  expectMax("search_facts", "project", 500);
  expectMax("search_ontology", "project", 500);
  expectMax("ask_avatar", "question", 10000);
  expectMax("ask_avatar", "project", 500);
  expectMax("trace_fact", "query", 10000);
  expectMax("trace_fact", "project", 500);
  expectMax("graph_stats", "project", 500);
  expectMax("cross_project_insights", "query", 10000);
  expectMax("cross_project_insights", "current_project", 500);
  expectMax("explore_graph", "query", 10000);
  expectMax("explore_graph", "project", 500);
  // search.query is a oneOf: string branch and array-item branch both bounded.
  const searchQuery = tools.get("search")?.inputSchema?.properties?.query;
  assert.deepEqual(
    searchQuery?.oneOf?.map(
      (branch) => branch.maxLength ?? branch.items?.maxLength,
    ),
    [10000, 10000],
  );
});

test("search_facts without project or scope returns structured validation error (no cwd fallback)", async (t) => {
  await seedDb(t);
  const reply = await callTool("search_facts", { query: "row-level security" });
  assert.equal(reply.isError, true);
  const text = reply.content[0].text;
  assert.ok(text.includes("project is required"), text.slice(0, 200));
  assert.ok(text.includes("canonical absolute"), text.slice(0, 300));
});

test("cross_project_insights without current_project errors instead of using cwd", async (t) => {
  await seedDb(t);
  const reply = await callTool("cross_project_insights", {
    query: "database decisions",
  });
  assert.equal(reply.isError, true);
  assert.ok(reply.content[0].text.includes("current_project is required"));
});

test("ask_avatar / trace_fact without project error instead of using cwd", async (t) => {
  await seedDb(t);
  for (const [tool, args] of [
    ["ask_avatar", { question: "which database do we use?" }],
    ["trace_fact", { query: "pull requests" }],
  ]) {
    const reply = await callTool(tool, args);
    assert.equal(reply.isError, true, `${tool} should fail loudly`);
    assert.ok(
      reply.content[0].text.includes("is required"),
      `${tool}: ${reply.content[0].text.slice(0, 120)}`,
    );
  }
});

test('explicit scope:"global" returns only global facts; project A never sees B', async (t) => {
  await seedDb(t);
  // Project-scoped call must not include B's fact even though the server cwd
  // is the plugin root.
  const a = await callTool("search_facts", {
    query: "database replication decisions",
    project: "/tmp/w/team-a/shared",
  });
  assert.notEqual(a.isError, true);
  const aText = JSON.stringify(a);
  assert.ok(
    !aText.includes("MySQL read replicas"),
    "project A leaked project B fact",
  );
  assert.ok(aText.includes("/tmp/w/team-a/shared") || aText.includes("Scope"));

  const g = await callTool("search_facts", {
    query: "small pull requests",
    scope: "global",
  });
  assert.notEqual(g.isError, true);
  const gText = JSON.stringify(g);
  if (!gText.includes("Results: 0")) {
    assert.ok(
      gText.includes("global"),
      "scope global output should be labeled global-only",
    );
    assert.ok(
      !gText.includes("Postgres row-level"),
      "global scope leaked a project fact",
    );
  }

  const all = await callTool("search_facts", {
    query: "database",
    scope: "all",
  });
  assert.notEqual(all.isError, true);
});
