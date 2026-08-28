import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import { createRelation } from "../src/ontology-db.js";

describe("ontology relation scope write invariant", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-relation-scope-"));
    process.env.TEST_DB_PATH = path.join(tmpDir, "memex.db");
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function addFact(scopeType: "global" | "project", scopeProject: string | null) {
    return insertFact(db, {
      fact: `${scopeType}:${scopeProject ?? "global"}`,
      category: "decision",
      scope_type: scopeType,
      scope_project: scopeProject,
      source_exchange_ids: [],
      embedding: null,
    });
  }

  it("rejects a cross-project edge through createRelation()", () => {
    const sourceId = addFact("project", "/project-a");
    const targetId = addFact("project", "/project-b");

    expect(() =>
      createRelation(db, sourceId, "SUPPORTS", targetId, "must reject"),
    ).toThrow(/cross-project/i);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM ontology_relations").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a cross-project edge that bypasses createRelation()", () => {
    const sourceId = addFact("project", "/project-a");
    const targetId = addFact("project", "/project-b");

    expect(() =>
      db.prepare(`
        INSERT INTO ontology_relations
          (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
        VALUES ('raw-cross-project', ?, 'SUPPORTS', ?, NULL, ?)
      `).run(sourceId, targetId, new Date().toISOString()),
    ).toThrow(/cross-project/i);
  });

  it("rejects an endpoint update that would make an edge cross-project", () => {
    const sourceId = addFact("project", "/project-a");
    const sameProjectTargetId = addFact("project", "/project-a");
    const otherProjectTargetId = addFact("project", "/project-b");
    const relation = createRelation(
      db,
      sourceId,
      "SUPPORTS",
      sameProjectTargetId,
    );

    expect(() =>
      db.prepare(
        "UPDATE ontology_relations SET target_fact_id = ? WHERE id = ?",
      ).run(otherProjectTargetId, relation.id),
    ).toThrow(/cross-project/i);
    expect(
      db.prepare(
        "SELECT target_fact_id FROM ontology_relations WHERE id = ?",
      ).get(relation.id),
    ).toEqual({ target_fact_id: sameProjectTargetId });
  });

  it("allows same-project and global-to-project edges", () => {
    const projectA = addFact("project", "/project-a");
    const projectB = addFact("project", "/project-a");
    const global = addFact("global", null);

    expect(createRelation(db, projectA, "SUPPORTS", projectB).id).toBeTruthy();
    expect(createRelation(db, global, "INFLUENCES", projectA).id).toBeTruthy();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM ontology_relations").get(),
    ).toEqual({ count: 2 });
  });
});
