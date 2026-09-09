/**
 * Issue #47 — `memex ontology` is the operator surface for a taxonomy that
 * used to be append-only. Runs the real CLI in an isolated MEMEX_HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const CLI = path.join(REPO, "cli", "memex.js");

function isolated(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memex-ontology-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, env: { ...process.env, MEMEX_HOME: home } };
}

function run(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

async function seedTaxonomy(env) {
  const { initDatabase } = await import(path.join(REPO, "dist/db.js"));
  const { createCategory, createDomain } = await import(
    path.join(REPO, "dist/ontology-db.js")
  );
  const prior = process.env.MEMEX_HOME;
  process.env.MEMEX_HOME = env.MEMEX_HOME;
  const db = initDatabase();
  try {
    const domain = createDomain(db, "Security", "auth and secrets");
    const from = createCategory(db, domain.id, "AuthN");
    const to = createCategory(db, domain.id, "Authentication");
    const now = "2026-01-01T00:00:00.000Z";
    db.prepare(
      `INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids,
         created_at, updated_at, ontology_category_id, semantic_updated_at, lifecycle_updated_at)
       VALUES ('f1', 'a decision', 'decision', 'global', '[]', ?, ?, ?, ?, ?)`,
    ).run(now, now, from.id, now, now);
    return { fromId: from.id, toId: to.id };
  } finally {
    db.close();
    if (prior === undefined) delete process.env.MEMEX_HOME;
    else process.env.MEMEX_HOME = prior;
  }
}

test("memex ontology --help documents merge and rename and writes nothing", (t) => {
  const { home, env } = isolated(t);
  const before = fs.readdirSync(home);
  const result = run(env, ["ontology", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /memex ontology merge <from-category-id> <to-category-id>/);
  assert.match(result.stdout, /memex ontology rename <category-id>/);
  assert.deepEqual(fs.readdirSync(home), before);
});

test("memex ontology rejects an unknown subcommand", (t) => {
  const { env } = isolated(t);
  const result = run(env, ["ontology", "explode"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /memex ontology merge/);
});

test("memex ontology merge --dry-run reports the plan without moving facts", async (t) => {
  const { env } = isolated(t);
  const { fromId, toId } = await seedTaxonomy(env);

  const dry = run(env, ["ontology", "merge", fromId, toId, "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.factsMoved, 1);

  const listed = run(env, ["ontology", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 2, "dry run must not delete the source");
});

test("memex ontology merge re-points facts and records one audit line", async (t) => {
  const { home, env } = isolated(t);
  const { fromId, toId } = await seedTaxonomy(env);

  const merged = run(env, ["ontology", "merge", fromId, toId]);
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stdout, /Facts re-pointed: 1/);

  const listed = JSON.parse(run(env, ["ontology", "list", "--json"]).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, toId);

  const audit = fs.readFileSync(path.join(home, "logs", "ui-audit.jsonl"), "utf8");
  assert.match(audit, /"action":"ontology-merge"/);
  assert.doesNotMatch(audit, /a decision/, "audit is metadata-only");
});

test("memex ontology rename relabels a category and invalidates its vector", async (t) => {
  const { env } = isolated(t);
  const { toId } = await seedTaxonomy(env);

  const renamed = run(env, ["ontology", "rename", toId, "Identity", "--json"]);
  assert.equal(renamed.status, 0, renamed.stderr);
  const result = JSON.parse(renamed.stdout);
  assert.equal(result.previousName, "Authentication");
  assert.equal(result.name, "Identity");
  assert.equal(result.embeddingInvalidated, true);

  const listed = JSON.parse(run(env, ["ontology", "list", "--json"]).stdout);
  assert.ok(listed.some((row) => row.id === toId && row.name === "Identity"));
});
