import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// Save original env
const originalEnv = { ...process.env };

describe("paths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-bank-paths-"));
    // Clear all relevant env vars before each test
    delete process.env.MEMEX_HOME;
    delete process.env.MEMEX_DB_PATH;
    delete process.env.MEMORY_BANK_CONFIG_DIR;
    delete process.env.MEMORY_BANK_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.MEMORY_BANK_DB_PATH;
    delete process.env.TEST_DB_PATH;
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;
  });

  afterEach(() => {
    // Restore original env
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getMemexHome", () => {
    it("should use MEMEX_HOME when set (highest priority)", async () => {
      const homeDir = path.join(tmpDir, "home");
      process.env.MEMORY_BANK_HOME = path.join(tmpDir, "legacy-ignored");
      process.env.MEMEX_HOME = homeDir;
      const { getMemexHome } = await import("../src/paths.js");
      expect(getMemexHome()).toBe(homeDir);
    });

    it("should honor historical MEMORY_BANK_HOME next (compat, read-only)", async () => {
      delete process.env.MEMEX_HOME;
      const legacyHome = path.join(tmpDir, "legacy-home");
      process.env.MEMORY_BANK_HOME = legacyHome;
      const { getMemexHome } = await import("../src/paths.js");
      expect(getMemexHome()).toBe(legacyHome);
    });

    it("should use MEMORY_BANK_CONFIG_DIR when only it is set", async () => {
      delete process.env.MEMEX_HOME;
      const configDir = path.join(tmpDir, "custom-config");
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      const { getMemexHome } = await import("../src/paths.js");
      expect(getMemexHome()).toBe(configDir);
    });

    it("should use XDG_CONFIG_HOME/memex when set", async () => {
      delete process.env.MEMEX_HOME;
      delete process.env.MEMORY_BANK_HOME;
      delete process.env.MEMORY_BANK_CONFIG_DIR;
      const xdgDir = path.join(tmpDir, "xdg");
      process.env.XDG_CONFIG_HOME = xdgDir;
      const { getMemexHome } = await import("../src/paths.js");
      expect(getMemexHome()).toBe(path.join(xdgDir, "memex"));
    });

    it("should default to ~/.config/memex", async () => {
      delete process.env.MEMEX_HOME;
      delete process.env.MEMORY_BANK_HOME;
      delete process.env.MEMORY_BANK_CONFIG_DIR;
      delete process.env.XDG_CONFIG_HOME;
      const { getMemexHome } = await import("../src/paths.js");
      expect(getMemexHome()).toBe(path.join(os.homedir(), ".config", "memex"));
    });

    it("deprecated memory-bank aliases resolve the same Memex root", async () => {
      delete process.env.MEMEX_HOME;
      process.env.MEMORY_BANK_HOME = path.join(tmpDir, "legacy");
      const {
        getMemexHome,
        getMemoryBankHome,
        ensureMemexHome,
        ensureMemoryBankHome,
      } = await import("../src/paths.js");
      expect(getMemoryBankHome()).toBe(getMemexHome());
      expect(ensureMemoryBankHome()).toBe(ensureMemexHome());
    });

    it("detectLegacyDataRoot recognizes a pre-v0.2 memory-bank layout", async () => {
      const legacyRoot = path.join(tmpDir, "memory-bank");
      fs.mkdirSync(path.join(legacyRoot, "conversation-index"), {
        recursive: true,
      });
      const XDG = tmpDir;
      process.env.XDG_CONFIG_HOME = XDG;
      const { detectLegacyDataRoot } = await import("../src/paths.js");
      expect(detectLegacyDataRoot()).toBe(legacyRoot);
    });

    it("detectLegacyDataRoot returns null without derived-data subdirs", async () => {
      fs.mkdirSync(path.join(tmpDir, "memory-bank"), { recursive: true });
      process.env.XDG_CONFIG_HOME = tmpDir;
      const { detectLegacyDataRoot } = await import("../src/paths.js");
      expect(detectLegacyDataRoot()).toBeNull();
    });
  });

  describe("getArchiveDir", () => {
    it("should use TEST_ARCHIVE_DIR when set without creating directory", async () => {
      const archiveDir = path.join(tmpDir, "test-archive");
      process.env.TEST_ARCHIVE_DIR = archiveDir;
      const { getArchiveDir, ensureArchiveDir } = await import(
        "../src/paths.js"
      );
      const result = getArchiveDir();
      expect(result).toBe(archiveDir);
      expect(fs.existsSync(archiveDir)).toBe(false);
      ensureArchiveDir();
      expect(fs.existsSync(archiveDir)).toBe(true);
    });

    it("should use memory-bank/conversation-archive by default", async () => {
      const configDir = path.join(tmpDir, "config");
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      const { getArchiveDir } = await import("../src/paths.js");
      const result = getArchiveDir();
      expect(result).toBe(path.join(configDir, "conversation-archive"));
    });
  });

  describe("getDbPath", () => {
    it("should use MEMORY_BANK_DB_PATH when set", async () => {
      const dbPath = path.join(tmpDir, "custom.sqlite");
      process.env.MEMORY_BANK_DB_PATH = dbPath;
      const { getDbPath } = await import("../src/paths.js");
      expect(getDbPath()).toBe(dbPath);
    });

    it("should use TEST_DB_PATH as fallback", async () => {
      const dbPath = path.join(tmpDir, "test.sqlite");
      process.env.TEST_DB_PATH = dbPath;
      const { getDbPath } = await import("../src/paths.js");
      expect(getDbPath()).toBe(dbPath);
    });

    it("should prefer MEMEX_DB_PATH over MEMORY_BANK_DB_PATH", async () => {
      const memexPath = path.join(tmpDir, "memex.sqlite");
      const legacyPath = path.join(tmpDir, "legacy.sqlite");
      process.env.MEMEX_DB_PATH = memexPath;
      process.env.MEMORY_BANK_DB_PATH = legacyPath;
      const { getDbPath } = await import("../src/paths.js");
      expect(getDbPath()).toBe(memexPath);
    });
  });

  describe("getExcludedProjects", () => {
    it("should return empty array when no config", async () => {
      process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
      const { getExcludedProjects } = await import("../src/paths.js");
      expect(getExcludedProjects()).toEqual([]);
    });

    it("should parse env var comma-separated list", async () => {
      process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS =
        "project1, project2, project3";
      const { getExcludedProjects } = await import("../src/paths.js");
      expect(getExcludedProjects()).toEqual([
        "project1",
        "project2",
        "project3",
      ]);
    });

    it("should read from exclude.txt config file", async () => {
      const configDir = path.join(tmpDir, "config");
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      // Need to create the index dir structure
      const indexDir = path.join(configDir, "conversation-index");
      fs.mkdirSync(indexDir, { recursive: true });
      fs.writeFileSync(
        path.join(indexDir, "exclude.txt"),
        "# comment\nproject1\nproject2\n\n# another comment\nproject3\n",
      );
      const { getExcludedProjects } = await import("../src/paths.js");
      expect(getExcludedProjects()).toEqual([
        "project1",
        "project2",
        "project3",
      ]);
    });

    it("should filter empty strings from env var with consecutive commas", async () => {
      process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS =
        "project1,,project2, ,project3";
      const { getExcludedProjects } = await import("../src/paths.js");
      expect(getExcludedProjects()).toEqual([
        "project1",
        "project2",
        "project3",
      ]);
    });

    it("should ignore comments and empty lines in exclude.txt", async () => {
      const configDir = path.join(tmpDir, "config");
      process.env.MEMORY_BANK_CONFIG_DIR = configDir;
      const indexDir = path.join(configDir, "conversation-index");
      fs.mkdirSync(indexDir, { recursive: true });
      fs.writeFileSync(
        path.join(indexDir, "exclude.txt"),
        "#full comment\n\n  \nvalid-project\n",
      );
      const { getExcludedProjects } = await import("../src/paths.js");
      expect(getExcludedProjects()).toEqual(["valid-project"]);
    });
  });

  describe("isExcludedProject", () => {
    it("should exclude the current LLM workdir path (built-in, CX-02 canonical)", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      expect(
        isExcludedProject(
          "/private/var/folders/ms/q41xyz/T/memex-llm",
          [],
        ),
      ).toBe(true);
    });

    it("should exclude nested temporary LLM workdir paths (built-in, CX-02 canonical)", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      expect(isExcludedProject("/tmp/03lvGlu1k7/memex-llm", [])).toBe(
        true,
      );
    });

    it("should exclude the bare workdir basename (built-in)", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      expect(isExcludedProject("memex-llm", [])).toBe(true);
    });

    it("should exclude the mkdtemp suffix form codex-exec actually creates", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      // fs.mkdtempSync(path.join(os.tmpdir(), "memex-llm-")) appends six
      // random characters — the reserved-name guard must cover that shape too.
      expect(isExcludedProject("/tmp/memex-llm-a1b2c3", [])).toBe(true);
      expect(
        isExcludedProject(
          "/private/var/folders/ms/q41xyz/T/memex-llm-9x8y7z",
          [],
        ),
      ).toBe(true);
    });

    it("should not exclude ordinary projects", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      expect(isExcludedProject("-Users-example-Project-codex-sync", [])).toBe(
        false,
      );
      // Repo dir itself is not the worker slug
      expect(isExcludedProject("-Users-example-Project-memory-bank", [])).toBe(
        false,
      );
    });

    it("should not exclude names merely containing the workdir basename mid-slug", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      expect(isExcludedProject("-Users-x-memex-llm-docs", [])).toBe(
        false,
      );
    });

    it("should exclude current and historical reserved workdir namespaces", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      // Reserved prefix (mkdtemp form protection) — documented trade-off: any
      // Current namespace and legacy in-flight workers are both excluded.
      expect(isExcludedProject("/tmp/real/memex-llm-docs", [])).toBe(true);
      expect(isExcludedProject("/tmp/real/memory-bank-llm-docs", [])).toBe(true);
    });

    it("should honor the user-configured exact-match list", async () => {
      const { isExcludedProject } = await import("../src/paths.js");
      expect(isExcludedProject("some-project", ["some-project"])).toBe(true);
      expect(isExcludedProject("other-project", ["some-project"])).toBe(false);
    });

    it("should fall back to getExcludedProjects when no list is given", async () => {
      process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = "env-excluded";
      const { isExcludedProject } = await import("../src/paths.js");
      expect(isExcludedProject("env-excluded")).toBe(true);
      expect(isExcludedProject("env-included")).toBe(false);
    });
  });
});

describe("isWorkerPromptMessage", () => {
  it("matches every worker prompt prefix and nothing ordinary", async () => {
    const { isWorkerPromptMessage, WORKER_PROMPT_PREFIXES } = await import(
      "../src/paths.js"
    );
    for (const p of WORKER_PROMPT_PREFIXES) {
      expect(isWorkerPromptMessage(p + "\n\n## Rules ...")).toBe(true);
    }
    expect(isWorkerPromptMessage("How do I fix this typescript error?")).toBe(
      false,
    );
    expect(
      isWorkerPromptMessage("You are an expert developer — help me refactor"),
    ).toBe(false); // 부분 유사 문구는 불일치
    expect(isWorkerPromptMessage("")).toBe(false);
    expect(isWorkerPromptMessage(null)).toBe(false);
    expect(isWorkerPromptMessage(undefined)).toBe(false);
  });
});

describe("sync lock creation contract", () => {
  it("creates the shared parent recursively but the lock leaf exclusively", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "sync-cli.ts"),
      "utf8",
    );
    expect(source).toContain(
      "fs.mkdirSync(path.dirname(__lockDir), { recursive: true });",
    );
    expect(source).toContain("fs.mkdirSync(__lockDir);");
    expect(source).not.toMatch(
      /mkdirSync\(__lockDir,\s*\{\s*recursive:\s*true/,
    );
  });
});
