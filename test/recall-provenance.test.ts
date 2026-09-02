import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyToolEvidence,
  initDatabase,
  insertExchange,
  markRecallEventEmitted,
  recordRecallEvent,
} from "../src/db.js";
import {
  buildExtractionPrompt,
  extractFactsFromExchanges,
} from "../src/fact-extractor.js";
import { insertFact, getActiveFacts, getRevisions } from "../src/fact-db.js";
import { applyConsolidationResult } from "../src/consolidator.js";
import { searchConversations } from "../src/search.js";

vi.mock("../src/embeddings.js", () => ({
  EMBEDDING_VERSION: 73,
  initEmbeddings: vi.fn(async () => undefined),
  generateEmbedding: vi.fn(async () => new Array(384).fill(0.75)),
}));

describe("Memex recall provenance", () => {
  let tmp = "";
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    delete process.env.TEST_DB_PATH;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps recalled assistant text FTS/vector searchable but excludes it from learnable evidence", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-recall-provenance-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();

    const prompt = "Which database did this project choose?";
    recordRecallEvent(db, {
      sessionId: "session-recall-1",
      project: "/tmp/project",
      prompt,
      factIds: ["fact-sqlite"],
    });
    expect(
      markRecallEventEmitted(db, {
        sessionId: "session-recall-1",
        prompt,
      }),
    ).toBe(true);
    insertExchange(
      db,
      {
        id: "exchange-recall-1",
        project: "/tmp/project",
        timestamp: "2026-08-27T01:00:00Z",
        userMessage: prompt,
        assistantMessage: "The project uses SQLite for local persistence.",
        archivePath: "/tmp/rollout.jsonl",
        lineStart: 10,
        lineEnd: 20,
        sessionId: "session-recall-1",
      },
      Array(384).fill(0),
    );

    const row = db
      .prepare(`
      SELECT provenance, assistant_learnable, has_memex_recall,
             user_message, assistant_message
      FROM exchanges WHERE id = ?
    `)
      .get("exchange-recall-1") as {
      provenance: string;
      assistant_learnable: number;
      has_memex_recall: number;
      user_message: string;
      assistant_message: string;
    };
    expect(JSON.parse(row.provenance)).toEqual([
      "human_assertion",
      "assistant_generated",
      "memex_recall",
    ]);
    expect(row.has_memex_recall).toBe(1);
    expect(row.assistant_learnable).toBe(0);

    const promptText = buildExtractionPrompt([row]);
    expect(promptText).toContain(prompt);
    const envelope = JSON.parse(promptText);
    expect(envelope.local_exchanges[0].assistant_context_only).toEqual({
      content: "The project uses SQLite for local persistence.",
      recall_influenced: true,
    });
    expect(envelope.local_exchanges[0].trusted_tool_evidence).toEqual([]);

    const searchable = db
      .prepare(`
      SELECT rowid FROM exchanges_fts WHERE exchanges_fts MATCH 'SQLite'
    `)
      .all();
    expect(searchable).toHaveLength(1);

    const textResults = await searchConversations("SQLite", {
      mode: "text",
      project: "/tmp/project",
    });
    const vectorResults = await searchConversations("SQLite", {
      mode: "vector",
      project: "/tmp/project",
    });
    expect(textResults.map((result) => result.exchange.id)).toContain(
      "exchange-recall-1",
    );
    expect(vectorResults.map((result) => result.exchange.id)).toContain(
      "exchange-recall-1",
    );
  });

  it("keeps ordinary assistant synthesis searchable but not learnable by default", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-normal-provenance-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();
    insertExchange(
      db,
      {
        id: "exchange-normal-1",
        project: "/tmp/project",
        timestamp: "2026-08-27T01:00:00Z",
        userMessage: "Let us use PostgreSQL.",
        assistantMessage: "I will update the persistence layer to PostgreSQL.",
        archivePath: "/tmp/rollout.jsonl",
        lineStart: 1,
        lineEnd: 2,
        sessionId: "session-normal-1",
      },
      Array(384).fill(0),
    );

    const row = db
      .prepare(`SELECT provenance, assistant_learnable, has_memex_recall,
      user_message, assistant_message FROM exchanges WHERE id = ?`)
      .get("exchange-normal-1") as any;
    expect(JSON.parse(row.provenance)).toEqual([
      "human_assertion",
      "assistant_generated",
    ]);
    expect(row.assistant_learnable).toBe(0);
    expect(row.has_memex_recall).toBe(0);
    const promptText = buildExtractionPrompt([row]);
    expect(promptText).toContain("Let us use PostgreSQL");
    expect(JSON.parse(promptText).local_exchanges[0].assistant_context_only).toEqual({
      content: "I will update the persistence layer to PostgreSQL.",
      recall_influenced: false,
    });
  });

  it("taints an exchange only after its prepared recall receipt is emitted", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-recall-status-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();
    const prompt = "Recall the deployment decision.";
    const event = {
      sessionId: "session-recall-status",
      project: "/tmp/project",
      prompt,
      factIds: ["fact-deploy"],
    };
    recordRecallEvent(db, event);
    const exchange = {
      id: "exchange-recall-status",
      project: "/tmp/project",
      timestamp: "2026-08-29T00:00:00Z",
      userMessage: prompt,
      assistantMessage: "Prepared receipt response.",
      archivePath: "/tmp/rollout.jsonl",
      lineStart: 1,
      lineEnd: 2,
      sessionId: event.sessionId,
    };

    insertExchange(db, exchange, Array(384).fill(0));
    expect(
      db.prepare(
        "SELECT has_memex_recall FROM exchanges WHERE id = ?",
      ).get(exchange.id),
    ).toEqual({ has_memex_recall: 0 });

    expect(markRecallEventEmitted(db, event)).toBe(true);
    insertExchange(db, exchange, Array(384).fill(0));
    expect(
      db.prepare(
        "SELECT has_memex_recall FROM exchanges WHERE id = ?",
      ).get(exchange.id),
    ).toEqual({ has_memex_recall: 1 });
  });

  it("taints only Memex tool evidence while retaining trusted local tool evidence", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-tool-provenance-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();
    insertExchange(
      db,
      {
        id: "exchange-tool-1",
        project: "/tmp/project",
        timestamp: "2026-08-27T01:00:00Z",
        userMessage: "What did we decide about persistence?",
        assistantMessage: "The earlier decision was SQLite.",
        archivePath: "/tmp/rollout.jsonl",
        lineStart: 1,
        lineEnd: 5,
        sessionId: "session-tool-1",
        cwd: "/tmp/project",
        toolCalls: [
          {
            id: "call-1",
            exchangeId: "exchange-tool-1",
            toolName: "mcp__memex__search_facts",
            toolInput: { query: "persistence" },
            toolResult: "The old fact says SQLite.",
            isError: false,
            timestamp: "2026-08-27T01:00:01Z",
          },
          {
            id: "call-2",
            exchangeId: "exchange-tool-1",
            toolName: "shell",
            toolInput: { cmd: "grep DATABASE_URL .env.example" },
            toolResult: "DATABASE_URL=postgres://localhost/app",
            isError: false,
            timestamp: "2026-08-27T01:00:02Z",
          },
        ],
      },
      Array(384).fill(0),
    );

    const row = db
      .prepare(
        "SELECT provenance, assistant_learnable, has_memex_recall FROM exchanges WHERE id = ?",
      )
      .get("exchange-tool-1") as any;
    expect(JSON.parse(row.provenance)).toEqual([
      "human_assertion",
      "assistant_generated",
      "memex_recall",
      "repo_file",
    ]);
    expect(row.assistant_learnable).toBe(0);
    expect(row.has_memex_recall).toBe(1);

    const toolRows = db
      .prepare(
        "SELECT tool_name, source_type, learnable FROM tool_calls ORDER BY id",
      )
      .all() as any[];
    expect(toolRows).toEqual([
      {
        tool_name: "mcp__memex__search_facts",
        source_type: "memex_recall",
        learnable: 0,
      },
      { tool_name: "shell", source_type: "repo_file", learnable: 1 },
    ]);
    const extractionRow = db
      .prepare(`SELECT user_message, assistant_message,
      assistant_learnable, has_memex_recall FROM exchanges WHERE id = ?`)
      .get("exchange-tool-1") as any;
    extractionRow.tool_evidence = db
      .prepare(`SELECT tool_name, tool_result, source_type, learnable
      FROM tool_calls WHERE exchange_id = ? ORDER BY id`)
      .all("exchange-tool-1");
    const extractionPrompt = buildExtractionPrompt([extractionRow]);
    const extractionEnvelope = JSON.parse(extractionPrompt).local_exchanges[0];
    expect(extractionEnvelope.trusted_tool_evidence).toEqual([
      expect.objectContaining({ content: "DATABASE_URL=postgres://localhost/app" }),
    ]);
    expect(extractionEnvelope.memex_recall_context_only).toEqual([
      expect.objectContaining({ content: "The old fact says SQLite." }),
    ]);
    expect(extractionEnvelope.assistant_context_only).toEqual({
      content: "The earlier decision was SQLite.",
      recall_influenced: true,
    });
  });

  it("rejects assistant/recall self-grounding end to end and resolves lineage only from matching trusted DB evidence", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-grounding-validator-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();
    insertExchange(
      db,
      {
        id: "exchange-grounding-1",
        project: "/tmp/project",
        cwd: "/tmp/project",
        timestamp: "2026-08-31T02:00:00Z",
        userMessage: "Check the current database configuration in this project.",
        assistantMessage: "The recalled answer says SQLite, but the repository says PostgreSQL.",
        archivePath: "/tmp/rollout.jsonl",
        lineStart: 1,
        lineEnd: 5,
        sessionId: "session-grounding-1",
        toolCalls: [
          {
            id: "call-grounding-recall",
            exchangeId: "exchange-grounding-1",
            toolName: "mcp__memex__search_facts",
            toolInput: { query: "database" },
            toolResult: "The old fact says SQLite.",
            isError: false,
            timestamp: "2026-08-31T02:00:01Z",
          },
          {
            id: "call-grounding-repo",
            exchangeId: "exchange-grounding-1",
            toolName: "shell",
            toolInput: { cmd: "grep DATABASE_URL .env.example" },
            toolResult: "DATABASE_URL=postgres://localhost/app",
            isError: false,
            timestamp: "2026-08-31T02:00:02Z",
          },
        ],
      },
      Array(384).fill(0),
    );

    const facts = await extractFactsFromExchanges(
      db,
      "session-grounding-1",
      undefined,
      undefined,
      {
        modelCall: async (systemPrompt, userMessage) => systemPrompt.includes('authoritative-entailment-v3')
          ? JSON.stringify((JSON.parse(userMessage) as { candidates: Array<{
              selected_context_dependencies: Array<{ context_id: string; relation: string }>;
              local_context_before_authority: Array<{ exchange_index: number }>;
              authoritative_evidence: Array<{ kind: string }>;
            }> }).candidates.map((candidate, index) => ({
              candidate_index: index + 1,
              verdict: 'ENTAILED',
              used_context_dependencies: candidate.selected_context_dependencies,
              used_local_context_exchange_indices:
                candidate.selected_context_dependencies.length === 0 &&
                candidate.authoritative_evidence.some(({ kind }) => kind === 'ratification') &&
                candidate.local_context_before_authority.length > 0
                  ? [candidate.local_context_before_authority.at(-1)!.exchange_index]
                  : [],
            })))
          : JSON.stringify([
          {
            fact: "Assistant says this project uses SQLite.",
            category: "knowledge",
            scope_type: "project",
            grounding_type: "explicit",
            durable: true,
            confidence: 0.99,
            evidence: [{ exchange_index: 1, source: "assistant", kind: "assertion" }],
          },
          {
            fact: "Recalled memory proves this project uses SQLite.",
            category: "knowledge",
            scope_type: "project",
            grounding_type: "verified",
            durable: true,
            confidence: 0.99,
            evidence: [{
              exchange_index: 1,
              source: "tool",
              kind: "memex_recall",
              tool_name: "mcp__memex__search_facts",
              source_type: "memex_recall",
            }],
          },
          {
            fact: "This project currently uses PostgreSQL.",
            category: "knowledge",
            scope_type: "project",
            grounding_type: "verified",
            durable: true,
            confidence: 0.95,
            evidence: [{
              exchange_index: 1,
              source: "tool",
              kind: "repo_file",
              tool_call_id: "call-grounding-repo",
              tool_name: "shell",
              source_type: "repo_file",
              supporting_span: "DATABASE_URL=postgres://localhost/app",
            }],
            context_exchange_indices: [],
          },
          ]),
      },
    );

    expect(facts).toEqual([
      expect.objectContaining({
        fact: "This project currently uses PostgreSQL.",
        grounding_type: "verified",
        source_exchange_ids: ["exchange-grounding-1"],
      }),
    ]);
  });

  it("trust classifier separates local evidence from network and generated output", () => {
    const project = "/tmp/project";
    expect(
      classifyToolEvidence(
        "shell",
        { cmd: "git log -1 --oneline" },
        { cwd: project },
      ),
    ).toEqual({ sourceType: "git_history", learnable: true });
    expect(
      classifyToolEvidence(
        "functions__exec_command",
        { cmd: "npm test" },
        { cwd: project },
      ),
    ).toEqual({ sourceType: "test_execution", learnable: true });
    expect(
      classifyToolEvidence("shell", { cmd: "curl https://example.com/config" }),
    ).toEqual({ sourceType: "external_unverified", learnable: false });
    expect(
      classifyToolEvidence("image_gen__imagegen", {
        prompt: "database diagram",
      }),
    ).toEqual({ sourceType: "external_unverified", learnable: false });
  });

  // 복합 셸 명령은 첫 토큰이 신뢰 구간(git/test)이어도 출력 전체를 신뢰할 수 없다.
  // FACT-LIFECYCLE.md:49-50 — composite exec output 은 external_unverified/learnable=0.
  it("demotes composite shell commands even when the first token is trusted", () => {
    const ctx = { cwd: "/tmp/project" };
    const unverified = { sourceType: "external_unverified", learnable: false };
    // 신뢰 토큰 뒤에 임의 명령이 붙는 조합
    expect(
      classifyToolEvidence("shell", { cmd: "git log && cat config" }, ctx),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence("shell", {
        cmd: "npm test | grep -q PASS && echo leak",
      }, ctx),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence("shell", { cmd: "git status; curl https://x" }, ctx),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence("shell", { cmd: "npm test & rm -rf /tmp/x" }, ctx),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence("shell", { cmd: "git show HEAD > /tmp/out" }, ctx),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence("shell", { cmd: "git log $(cat secret.txt)" }, ctx),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence(
        "shell",
        { cmd: 'git log --grep="$(cat ../secret.txt)"' },
        ctx,
      ),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence("shell", { cmd: "npm test\nrm -rf /" }, ctx),
    ).toEqual(unverified);
    expect(
      classifyToolEvidence("shell", { cmd: "git log || git rev-parse" }, ctx),
    ).toEqual(unverified);
    // 단일 명령은 그대로 신뢰된다 — 인자 내부의 quoted 메타문자는 복합이 아니다
    expect(
      classifyToolEvidence("shell", { cmd: "git log --grep='fix && build'" }, ctx),
    ).toEqual({
      sourceType: "git_history",
      learnable: true,
    });
    expect(
      classifyToolEvidence("shell", { cmd: "rg 'pattern|other' src" }, ctx),
    ).toEqual({
      sourceType: "repo_file",
      learnable: true,
    });
  });

  it("requires cwd-locality proof for every trusted shell observation", () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), "memex-shell-locality-project-"),
    );
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "memex-shell-locality-outside-"),
    );
    const insidePackage = path.join(project, "packages", "app");
    fs.mkdirSync(insidePackage, { recursive: true });
    fs.symlinkSync(outside, path.join(project, "linked-outside"));
    const unverified = { sourceType: "external_unverified", learnable: false };
    const ctx = { cwd: project };

    try {
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: `grep needle ${path.join(outside, "secret.txt")}` },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: `grep needle ../${path.basename(outside)}/secret.txt` },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "grep needle ~other-user/secret.txt" },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "grep needle {src,../outside}/secret.txt" },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: `jq . ${path.join(outside, "external.json")}` },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence("shell", { cmd: `find ${outside} -type f` }, ctx),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: `git -C ${outside} log -1` },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "functions__exec_command",
          { cmd: `npm --prefix ${outside} test` },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "grep needle linked-outside/secret.txt" },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "read_file",
          { path: "linked-outside/secret.txt" },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "functions__exec_command",
          { cmd: "git log -1", workdir: outside },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence("shell", { cmd: "grep needle" }, ctx),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: `/bin/zsh -lc 'git -C ${outside} log'` },
          ctx,
        ),
      ).toEqual(unverified);
      expect(
        classifyToolEvidence("shell", { cmd: "git log -1" }),
      ).toEqual(unverified);

      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "grep needle src/config.ts" },
          ctx,
        ),
      ).toEqual({ sourceType: "repo_file", learnable: true });
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "git -C packages/app log -1" },
          ctx,
        ),
      ).toEqual({ sourceType: "git_history", learnable: true });
      expect(
        classifyToolEvidence(
          "functions__exec_command",
          { cmd: "npm --prefix packages/app test" },
          ctx,
        ),
      ).toEqual({ sourceType: "test_execution", learnable: true });
      expect(
        classifyToolEvidence(
          "functions__exec_command",
          { cmd: "npm test", workdir: insidePackage },
          ctx,
        ),
      ).toEqual({ sourceType: "test_execution", learnable: true });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // Path-aware locality proof: a read result is repository-local evidence only
  // when its target resolves inside the project cwd AND outside every Memex
  // data surface. Reading our own summaries/rollouts back through a local file
  // tool would otherwise launder assistant synthesis into learnable evidence.
  it("demotes repo reads of Memex data roots, sessions, model workdirs, or out-of-project paths", () => {
    const memexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "memex-evidence-home-"),
    );
    const sessionsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "memex-evidence-sessions-"),
    );
    process.env.MEMEX_HOME = memexHome;
    process.env.MEMEX_SESSIONS_DIR = sessionsDir;
    try {
      // Virtual project root kept OUTSIDE every denied data surface so legit
      // in-project reads exercise pure locality math (no fs needed).
      const project = path.join(os.tmpdir(), "memex-selfread-virtual-project");
      const summaryPath = path.join(
        memexHome,
        "archive",
        "proj",
        "conv-summary.txt",
      );
      const rolloutPath = path.join(
        sessionsDir,
        "2026",
        "08",
        "27",
        "rollout-x.jsonl",
      );
      const tmpScript = path.join(
        os.tmpdir(),
        "memex-llm",
        "last-message.txt",
      );
      const outside = path.join(os.tmpdir(), "other-repo", "a.ts");

      // Out-of-project targets can never be proven repository-local.
      expect(
        classifyToolEvidence(
          "read_file",
          { path: summaryPath },
          { cwd: project },
        ),
      ).toEqual({ sourceType: "external_unverified", learnable: false });
      expect(
        classifyToolEvidence("read", { path: rolloutPath }, { cwd: project }),
      ).toEqual({ sourceType: "external_unverified", learnable: false });
      expect(
        classifyToolEvidence(
          "view_image",
          { path: tmpScript },
          { cwd: project },
        ),
      ).toEqual({ sourceType: "external_unverified", learnable: false });
      expect(
        classifyToolEvidence("read_file", { path: outside }, { cwd: project }),
      ).toEqual({ sourceType: "external_unverified", learnable: false });

      // Proven-local reads INTO Memex data surfaces keep the label but lose
      // learnability (e.g. a project that legitimately sits beside our data).
      const insideBoth = path.join(memexHome, "work", "notes.md");
      expect(
        classifyToolEvidence(
          "read_file",
          { path: insideBoth },
          { cwd: memexHome },
        ),
      ).toEqual({ sourceType: "repo_file", learnable: false });

      // Shell-based listing outside the project fails the locality proof even
      // when that target is also a denied Memex data surface.
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: `ls ${summaryPath}` },
          { cwd: project },
        ),
      ).toEqual({ sourceType: "external_unverified", learnable: false });
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "ls archive/proj/conv-summary.txt" },
          { cwd: memexHome },
        ),
      ).toEqual({ sourceType: "repo_file", learnable: false });
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "git log -1" },
          { cwd: sessionsDir },
        ),
      ).toEqual({ sourceType: "git_history", learnable: false });
      expect(
        classifyToolEvidence(
          "functions__exec_command",
          { cmd: "npm test" },
          { cwd: path.join(os.tmpdir(), "memex-llm", "model-work") },
        ),
      ).toEqual({ sourceType: "test_execution", learnable: false });

      // Legitimate in-project reads stay trusted (regression guard).
      expect(
        classifyToolEvidence(
          "read_file",
          { path: path.join(project, "src.ts") },
          { cwd: project },
        ),
      ).toEqual({ sourceType: "repo_file", learnable: true });
      expect(
        classifyToolEvidence(
          "read_file",
          { path: "relative/a.ts" },
          { cwd: project },
        ),
      ).toEqual({ sourceType: "repo_file", learnable: true });
      expect(
        classifyToolEvidence(
          "shell",
          { cmd: "rg pattern src/" },
          { cwd: project },
        ),
      ).toEqual({ sourceType: "repo_file", learnable: true });

      // Unprovable locality (no extractable path) fails closed...
      expect(classifyToolEvidence("grep", {}, { cwd: project })).toEqual({
        sourceType: "external_unverified",
        learnable: false,
      });
      // Missing project identity cannot prove locality for any file surface.
      expect(
        classifyToolEvidence("read_file", { path: "/any/where.txt" }),
      ).toEqual({ sourceType: "external_unverified", learnable: false });
    } finally {
      delete process.env.MEMEX_HOME;
      delete process.env.MEMEX_SESSIONS_DIR;
      fs.rmSync(memexHome, { recursive: true, force: true });
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  // Runtime model workdirs are mkdtemp'd as `<tmpdir>/memex-llm-XXXXXX` — a
  // SIBLING of the plain `memex-llm` denied root, not a child. The evidence
  // layer must deny that shape too (same basename-vs-mkdtemp bug class that
  // once leaked worker-prompt exchanges into the index), and a shell workdir
  // that disagrees with the project cwd is unprovable and fails closed.
  it("demotes the mkdtemp model-workdir shape and workdir/cwd mismatches", () => {
    const project = path.join(os.tmpdir(), "memex-selfread-virtual-project");
    const workdir = path.join(os.tmpdir(), "memex-llm-a1b2c3");

    expect(
      classifyToolEvidence(
        "functions__exec_command",
        { cmd: "npm test" },
        { cwd: workdir },
      ),
    ).toEqual({ sourceType: "test_execution", learnable: false });
    expect(
      classifyToolEvidence(
        "read_file",
        { path: path.join(workdir, "last-message.txt") },
        { cwd: workdir },
      ),
    ).toEqual({ sourceType: "repo_file", learnable: false });

    const other = path.join(os.tmpdir(), "memex-evidence-other-cwd");
    expect(
      classifyToolEvidence(
        "functions__exec_command",
        { cmd: "npm test", workdir: other },
        { cwd: project },
      ),
    ).toEqual({ sourceType: "external_unverified", learnable: false });
  });

  it("keeps archived-summary reads out of the extraction prompt end to end", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-summary-laundering-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();
    const memexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "memex-archive-home-"),
    );
    process.env.MEMEX_HOME = memexHome;
    try {
      const summaryPath = path.join(
        memexHome,
        "archive",
        "proj",
        "conv-summary.txt",
      );
      insertExchange(
        db,
        {
          id: "exchange-summary-read-1",
          project: "/tmp/project",
          timestamp: "2026-08-27T03:00:00Z",
          userMessage: "Summarize what we did last time.",
          assistantMessage: "Reading our archive for that.",
          archivePath: "/tmp/rollout.jsonl",
          lineStart: 1,
          lineEnd: 6,
          sessionId: "session-summary-read-1",
          cwd: "/tmp/project",
          toolCalls: [
            {
              id: "call-read-summary",
              exchangeId: "exchange-summary-read-1",
              toolName: "read_file",
              toolInput: { path: summaryPath },
              toolResult: "recalled-fact-marker: decision was SQLite",
              isError: false,
              timestamp: "2026-08-27T03:00:01Z",
            },
          ],
        },
        Array(384).fill(0),
      );

      const toolRow = db
        .prepare(`SELECT source_type, learnable FROM tool_calls
        WHERE exchange_id = 'exchange-summary-read-1'`)
        .get() as any;
      expect(toolRow).toEqual({
        source_type: "external_unverified",
        learnable: 0,
      });

      const row = db
        .prepare(`SELECT user_message, assistant_message,
        assistant_learnable, has_memex_recall FROM exchanges
        WHERE id = 'exchange-summary-read-1'`)
        .get() as any;
      row.tool_evidence = db
        .prepare(`SELECT tool_name, tool_result, source_type, learnable
        FROM tool_calls WHERE exchange_id = ? ORDER BY id`)
        .all("exchange-summary-read-1");
      const prompt = buildExtractionPrompt([row]);
      expect(prompt).not.toContain("recalled-fact-marker");
    } finally {
      delete process.env.MEMEX_HOME;
      fs.rmSync(memexHome, { recursive: true, force: true });
    }
  });

  it("keeps repeated identical prompts as distinct prepared/emitted recall events", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-recall-events-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();
    const event = {
      sessionId: "repeat-session",
      project: "/tmp/project",
      prompt: "same prompt",
      factIds: ["fact-1"],
    };
    const first = recordRecallEvent(db, event);
    const second = recordRecallEvent(db, event);
    expect(first).not.toBe(second);
    expect(markRecallEventEmitted(db, event)).toBe(true);
    const rows = db
      .prepare("SELECT status, emitted_at FROM recall_events ORDER BY rowid")
      .all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual([
      "emitted",
      "prepared",
    ]);
    expect(
      rows.find((row) => row.status === "emitted")?.emitted_at,
    ).toBeTruthy();
  });

  it("trusted repo evidence can evolve an old recalled fact without using recall or assistant text", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-evolution-provenance-"));
    process.env.TEST_DB_PATH = path.join(tmp, "index.sqlite");
    db = initDatabase();
    insertExchange(
      db,
      {
        id: "exchange-repo-observation",
        project: "/tmp/project",
        timestamp: "2026-08-27T02:00:00Z",
        userMessage: "Check the current database configuration.",
        assistantMessage: "The project now uses PostgreSQL instead of SQLite.",
        archivePath: "/tmp/evolution-rollout.jsonl",
        lineStart: 1,
        lineEnd: 8,
        sessionId: "evolution-session",
        cwd: "/tmp/project",
        toolCalls: [
          {
            id: "evolution-recall",
            exchangeId: "exchange-repo-observation",
            toolName: "mcp__memex__search_facts",
            toolInput: { query: "database" },
            toolResult: "Project database is SQLite",
            isError: false,
            timestamp: "2026-08-27T02:00:01Z",
          },
          {
            id: "evolution-read",
            exchangeId: "exchange-repo-observation",
            toolName: "read_file",
            toolInput: { path: "docker-compose.yml" },
            toolResult: "image: postgres:17",
            isError: false,
            timestamp: "2026-08-27T02:00:02Z",
          },
        ],
      },
      Array(384).fill(0),
    );
    const exchange = db
      .prepare(`SELECT user_message, assistant_message, assistant_learnable,
      has_memex_recall FROM exchanges WHERE id = ?`)
      .get("exchange-repo-observation") as any;
    exchange.tool_evidence = db
      .prepare(`SELECT tool_name, tool_result, source_type, learnable
      FROM tool_calls WHERE exchange_id = ? ORDER BY id`)
      .all("exchange-repo-observation");
    const evidencePrompt = buildExtractionPrompt([exchange]);
    const evidenceEnvelope = JSON.parse(evidencePrompt).local_exchanges[0];
    expect(evidenceEnvelope.trusted_tool_evidence).toEqual([
      expect.objectContaining({ content: "image: postgres:17" }),
    ]);
    expect(evidenceEnvelope.memex_recall_context_only).toEqual([
      expect.objectContaining({ content: "Project database is SQLite" }),
    ]);
    expect(evidenceEnvelope.assistant_context_only).toEqual({
      content: "The project now uses PostgreSQL instead of SQLite.",
      recall_influenced: true,
    });

    const oldId = insertFact(db, {
      fact: "Project database is SQLite",
      category: "decision",
      scope_type: "project",
      scope_project: "/tmp/project",
      source_exchange_ids: ["exchange-old"],
      embedding: null,
    });
    const newId = insertFact(db, {
      fact: "Project database is PostgreSQL",
      category: "decision",
      scope_type: "project",
      scope_project: "/tmp/project",
      source_exchange_ids: ["exchange-repo-observation"],
      embedding: null,
    });
    const [oldFact, newFact] = [oldId, newId].map(
      (id) => getActiveFacts(db!).find((fact) => fact.id === id)!,
    );

    await applyConsolidationResult(db, oldFact, newFact, {
      relation: "EVOLUTION",
      merged_fact: "Project database is PostgreSQL",
      reason: "Repository configuration now points to PostgreSQL",
    });

    const active = getActiveFacts(db);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(oldId);
    expect(active[0].fact).toBe("Project database is PostgreSQL");
    expect(active[0].source_exchange_ids).toEqual([
      "exchange-old",
      "exchange-repo-observation",
    ]);
    const revisions = getRevisions(db, oldId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].source_exchange_id).toBe("exchange-repo-observation");
  });
});
