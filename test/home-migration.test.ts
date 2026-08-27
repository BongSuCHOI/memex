import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const originalEnv = { ...process.env };

let tmpDir: string;

function makeLegacyRoot(
  base: string,
  opts: { withSqlite?: boolean } = {},
): string {
  const legacy = path.join(base, "legacy-root", "memory-bank");
  fs.mkdirSync(path.join(legacy, "conversation-index"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "conversation-archive"));
  fs.writeFileSync(
    path.join(legacy, "conversation-archive", "x.jsonl"),
    '{"a":1}\n',
  );
  if (opts.withSqlite) {
    const Database =
      require("better-sqlite3") as typeof import("better-sqlite3").default;
    const db = new Database(
      path.join(legacy, "conversation-index", "db.sqlite"),
    );
    db.exec(
      "CREATE TABLE exchanges(id TEXT PRIMARY KEY); INSERT INTO exchanges VALUES('row-1')",
    );
    db.close();
  }
  return legacy;
}

function setEnv(precedence: { xdg?: string }): void {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMORY_BANK_HOME;
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  if (precedence.xdg) {
    process.env.XDG_CONFIG_HOME = precedence.xdg;
  }
}

describe("home migration", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-home-migration-"));
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry-run copies nothing but reports plan", async () => {
    const legacyRoot = makeLegacyRoot(tmpDir);
    const targetBase = path.join(tmpDir, "xdg-config");
    fs.mkdirSync(targetBase, { recursive: true });
    process.env.XDG_CONFIG_HOME = targetBase;
    const { migrateHome } = await import("../src/home-migration.js");
    const r = migrateHome({ from: legacyRoot, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.status).toBe("ok");
    // Target resolves to <XDG>/memex; dry-run must not create it.
    const expectedTarget = path.join(targetBase, "memex");
    expect(fs.existsSync(expectedTarget)).toBe(false);
  });

  it("copies data into MEMEX_HOME and verifies parity", async () => {
    const legacyRoot = makeLegacyRoot(tmpDir, { withSqlite: true });
    const memexHome = path.join(tmpDir, "memex-home");
    fs.mkdirSync(memexHome, { recursive: true });
    process.env.MEMEX_HOME = memexHome;
    // XDG not used since MEMEX_HOME takes precedence.
    process.env.XDG_CONFIG_HOME = "";
    const { migrateHome } = await import("../src/home-migration.js");
    const r = migrateHome({ from: legacyRoot });
    expect(r.dryRun).toBe(false);
    expect(r.sqliteIntegrityChecked).toBe(true);
    expect(r.filesCopied).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(memexHome, "conversation-index", "db.sqlite")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(memexHome, "logs", "home-migration.json")),
    ).toBe(true);

    // Source untouched: original file still present and bytes identical.
    expect(
      fs.readFileSync(path.join(legacyRoot, "conversation-archive", "x.jsonl")),
    ).toBeTruthy();
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(memexHome, "logs", "home-migration.json"),
        "utf8",
      ),
    );
    expect(receipt.from).toBe(legacyRoot);
    expect(receipt.to).toBe(memexHome);
    expect(receipt.rows.find((r) => r.table === "exchanges")).toMatchObject({
      source: 1,
      target: 1,
    });
  });

  it("refuses to run when source and target are the same", async () => {
    const root = makeLegacyRoot(tmpDir);
    process.env.MEMEX_HOME = root; // resolve target == source
    const { migrateHome } = await import("../src/home-migration.js");
    expect(() => migrateHome({ from: root })).toThrow(/Source and target/);
  });

  it("refuses when the target already contains Memex data", async () => {
    const legacyRoot = makeLegacyRoot(tmpDir);
    const existingTarget = path.join(tmpDir, "already-has-data");
    fs.mkdirSync(path.join(existingTarget, "conversation-archive"), {
      recursive: true,
    });
    process.env.MEMEX_HOME = existingTarget;
    const { migrateHome } = await import("../src/home-migration.js");
    expect(() => migrateHome({ from: legacyRoot })).toThrow(
      /already contains Memex data/,
    );
  });

  it("throws a helpful error when no source exists", async () => {
    const emptyXdg = path.join(tmpDir, "empty-xdg");
    fs.mkdirSync(emptyXdg, { recursive: true });
    process.env.XDG_CONFIG_HOME = emptyXdg;
    const { migrateHome } = await import("../src/home-migration.js");
    expect(() => migrateHome({})).toThrow(
      /No legacy data root detected|Pass it explicitly/,
    );
  });

  it("detects pre-v0.2 layout via detectLegacyDataRoot (paths.ts contract)", async () => {
    const xdgConfig = path.join(tmpDir, "xdg-config-with-legacy");
    // Layout must sit exactly at <base>/memory-bank with derived-data subdirs.
    const legacy = path.join(xdgConfig, "memory-bank");
    fs.mkdirSync(path.join(legacy, "conversation-index"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "conversation-index", "db.sqlite"), "");
    setEnv({ xdg: xdgConfig });
    const { detectLegacyDataRoot } = await import("../src/paths.js");
    expect(detectLegacyDataRoot()).toBe(legacy);
  });

  it("detectLegacyDataRoot returns null for empty dirs or explicit overrides", async () => {
    const xdgEmpty = path.join(tmpDir, "xdg-empty");
    fs.mkdirSync(path.join(xdgEmpty, "memory-bank"), { recursive: true });
    setEnv({ xdg: xdgEmpty });
    let mod = await import("../src/paths.js");
    expect(mod.detectLegacyDataRoot()).toBeNull();

    // Explicit override suppresses detection.
    process.env.MEMEX_HOME = path.join(tmpDir, "explicit");
    mod = await import("../src/paths.js");
    expect(mod.detectLegacyDataRoot()).toBeNull();
  });
});
