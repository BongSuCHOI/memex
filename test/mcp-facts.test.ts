import { describe, it, expect } from "vitest";
import fs from "fs";

describe("MCP Facts Tool", () => {
  it("should have search_facts tool defined in mcp-server.ts", () => {
    const content = fs.readFileSync("src/mcp-server.ts", "utf-8");
    // biome autofix reformats quotes — match both quote styles.
    expect(content).toMatch(/name:\s*['"]search_facts['"]/);
    expect(content).toContain("Search extracted facts");
  });

  it("should have SearchFactsInputSchema defined", () => {
    const content = fs.readFileSync("src/mcp-server.ts", "utf-8");
    expect(content).toContain("SearchFactsInputSchema");
  });

  it("should import fact-db functions", () => {
    const content = fs.readFileSync("src/mcp-server.ts", "utf-8");
    expect(content).toContain("searchFactsByScope");
    expect(content).toContain("getRevisions");
  });

  it("should handle search_facts in CallTool handler", () => {
    const content = fs.readFileSync("src/mcp-server.ts", "utf-8");
    expect(content).toMatch(/name\s*===\s*['"]search_facts['"]/);
  });

  it("labels trace_fact context dependencies as non-authoritative", () => {
    const content = fs.readFileSync("src/mcp-server.ts", "utf-8");
    expect(content).toContain("Interpretive Context (Non-Authoritative)");
    expect(content).toContain("helped resolve meaning but are not Fact evidence");
    expect(content).toContain("fact_context_dependencies");
  });
});
