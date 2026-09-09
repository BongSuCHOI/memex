import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  getOrCreateMaintenanceModelBudget,
  isAutomaticOntologyEnabled,
  ensureModelBudgetSchema,
} from "../src/model-budget.js";

function databaseWithFacts(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL,
      ontology_category_id TEXT,
      needs_consolidation INTEGER NOT NULL DEFAULT 0
    )
  `);
  ensureModelBudgetSchema(db);
  return db;
}

afterEach(() => {
  delete process.env.MEMEX_AUTO_ONTOLOGY;
});

describe("automatic ontology maintenance flag", () => {
  it("keeps automatic ontology disabled by default and enables only on explicit one", () => {
    expect(isAutomaticOntologyEnabled()).toBe(false);
    process.env.MEMEX_AUTO_ONTOLOGY = "0";
    expect(isAutomaticOntologyEnabled()).toBe(false);
    process.env.MEMEX_AUTO_ONTOLOGY = "1";
    expect(isAutomaticOntologyEnabled()).toBe(true);
    process.env.MEMEX_AUTO_ONTOLOGY = "true";
    expect(isAutomaticOntologyEnabled()).toBe(false);
  });

  it("does not keep a maintenance wave active for disabled ontology-only backlog", () => {
    process.env.MEMEX_AUTO_ONTOLOGY = "0";
    const db = databaseWithFacts();
    try {
      const first = getOrCreateMaintenanceModelBudget(db, {
        limits: { maxAttempts: 2, deadlineAt: null },
      });
      db.prepare(
        "INSERT INTO facts (id, is_active, ontology_category_id) VALUES ('fact-1', 1, NULL)",
      ).run();

      const settled = getOrCreateMaintenanceModelBudget(db);
      expect(settled.budgetId).toBe(first.budgetId);
      expect(settled.state).toBe("completed");
    } finally {
      db.close();
    }
  });

  it("keeps ontology backlog attached when automatic maintenance is explicitly enabled", () => {
    process.env.MEMEX_AUTO_ONTOLOGY = "1";
    const db = databaseWithFacts();
    try {
      const first = getOrCreateMaintenanceModelBudget(db, {
        limits: { maxAttempts: 2, deadlineAt: null },
      });
      db.prepare(
        "INSERT INTO facts (id, is_active, ontology_category_id) VALUES ('fact-1', 1, NULL)",
      ).run();

      const resumed = getOrCreateMaintenanceModelBudget(db);
      expect(resumed.budgetId).toBe(first.budgetId);
      expect(resumed.state).toBe("active");
    } finally {
      db.close();
    }
  });
});
