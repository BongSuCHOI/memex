import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyToolEvidence, initDatabase, insertExchange, markRecallEventEmitted, recordRecallEvent,
} from '../src/db.js';
import { buildExtractionPrompt } from '../src/fact-extractor.js';
import { insertFact, getActiveFacts, getRevisions } from '../src/fact-db.js';
import { applyConsolidationResult } from '../src/consolidator.js';

describe('Memex recall provenance', () => {
  let tmp = '';
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    delete process.env.TEST_DB_PATH;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps recalled assistant text searchable but excludes it from learnable evidence', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-recall-provenance-'));
    process.env.TEST_DB_PATH = path.join(tmp, 'index.sqlite');
    db = initDatabase();

    const prompt = 'Which database did this project choose?';
    recordRecallEvent(db, {
      sessionId: 'session-recall-1',
      project: '/tmp/project',
      prompt,
      factIds: ['fact-sqlite'],
    });
    insertExchange(db, {
      id: 'exchange-recall-1',
      project: '/tmp/project',
      timestamp: '2026-08-27T01:00:00Z',
      userMessage: prompt,
      assistantMessage: 'The project uses SQLite for local persistence.',
      archivePath: '/tmp/rollout.jsonl',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 'session-recall-1',
    }, Array(384).fill(0));

    const row = db.prepare(`
      SELECT provenance, assistant_learnable, has_memex_recall,
             user_message, assistant_message
      FROM exchanges WHERE id = ?
    `).get('exchange-recall-1') as {
      provenance: string;
      assistant_learnable: number;
      has_memex_recall: number;
      user_message: string;
      assistant_message: string;
    };
    expect(JSON.parse(row.provenance)).toEqual(['human_assertion', 'assistant_generated', 'memex_recall']);
    expect(row.has_memex_recall).toBe(1);
    expect(row.assistant_learnable).toBe(0);

    const promptText = buildExtractionPrompt([row]);
    expect(promptText).toContain(prompt);
    expect(promptText).not.toContain('SQLite for local persistence');
    expect(promptText).toContain('assistant synthesis excluded');

    const searchable = db.prepare(`
      SELECT rowid FROM exchanges_fts WHERE exchanges_fts MATCH 'SQLite'
    `).all();
    expect(searchable).toHaveLength(1);
  });

  it('keeps ordinary assistant synthesis searchable but not learnable by default', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-normal-provenance-'));
    process.env.TEST_DB_PATH = path.join(tmp, 'index.sqlite');
    db = initDatabase();
    insertExchange(db, {
      id: 'exchange-normal-1',
      project: '/tmp/project',
      timestamp: '2026-08-27T01:00:00Z',
      userMessage: 'Let us use PostgreSQL.',
      assistantMessage: 'I will update the persistence layer to PostgreSQL.',
      archivePath: '/tmp/rollout.jsonl',
      lineStart: 1,
      lineEnd: 2,
      sessionId: 'session-normal-1',
    }, Array(384).fill(0));

    const row = db.prepare(`SELECT provenance, assistant_learnable, has_memex_recall,
      user_message, assistant_message FROM exchanges WHERE id = ?`).get('exchange-normal-1') as any;
    expect(JSON.parse(row.provenance)).toEqual(['human_assertion', 'assistant_generated']);
    expect(row.assistant_learnable).toBe(0);
    expect(row.has_memex_recall).toBe(0);
    const promptText = buildExtractionPrompt([row]);
    expect(promptText).toContain('Let us use PostgreSQL');
    expect(promptText).not.toContain('I will update the persistence layer');
  });

  it('taints only Memex tool evidence while retaining trusted local tool evidence', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-tool-provenance-'));
    process.env.TEST_DB_PATH = path.join(tmp, 'index.sqlite');
    db = initDatabase();
    insertExchange(db, {
      id: 'exchange-tool-1',
      project: '/tmp/project',
      timestamp: '2026-08-27T01:00:00Z',
      userMessage: 'What did we decide about persistence?',
      assistantMessage: 'The earlier decision was SQLite.',
      archivePath: '/tmp/rollout.jsonl',
      lineStart: 1,
      lineEnd: 5,
      sessionId: 'session-tool-1',
      toolCalls: [
        {
          id: 'call-1', exchangeId: 'exchange-tool-1',
          toolName: 'mcp__memex__search_facts', toolInput: { query: 'persistence' },
          toolResult: 'The old fact says SQLite.', isError: false, timestamp: '2026-08-27T01:00:01Z',
        },
        {
          id: 'call-2', exchangeId: 'exchange-tool-1',
          toolName: 'shell', toolInput: { cmd: 'grep DATABASE_URL .env.example' },
          toolResult: 'DATABASE_URL=postgres://localhost/app', isError: false, timestamp: '2026-08-27T01:00:02Z',
        },
      ],
    }, Array(384).fill(0));

    const row = db.prepare('SELECT provenance, assistant_learnable, has_memex_recall FROM exchanges WHERE id = ?')
      .get('exchange-tool-1') as any;
    expect(JSON.parse(row.provenance)).toEqual([
      'human_assertion', 'assistant_generated', 'memex_recall', 'repo_file',
    ]);
    expect(row.assistant_learnable).toBe(0);
    expect(row.has_memex_recall).toBe(1);

    const toolRows = db.prepare('SELECT tool_name, source_type, learnable FROM tool_calls ORDER BY id').all() as any[];
    expect(toolRows).toEqual([
      { tool_name: 'mcp__memex__search_facts', source_type: 'memex_recall', learnable: 0 },
      { tool_name: 'shell', source_type: 'repo_file', learnable: 1 },
    ]);
    const extractionRow = db.prepare(`SELECT user_message, assistant_message,
      assistant_learnable, has_memex_recall FROM exchanges WHERE id = ?`).get('exchange-tool-1') as any;
    extractionRow.tool_evidence = db.prepare(`SELECT tool_name, tool_result, source_type, learnable
      FROM tool_calls WHERE exchange_id = ? ORDER BY id`).all('exchange-tool-1');
    const extractionPrompt = buildExtractionPrompt([extractionRow]);
    expect(extractionPrompt).toContain('DATABASE_URL=postgres://localhost/app');
    expect(extractionPrompt).not.toContain('The old fact says SQLite');
    expect(extractionPrompt).not.toContain('The earlier decision was SQLite');
  });

  it('trust classifier separates local evidence from network and generated output', () => {
    expect(classifyToolEvidence('shell', { cmd: 'git log -1 --oneline' }))
      .toEqual({ sourceType: 'git_history', learnable: true });
    expect(classifyToolEvidence('functions__exec_command', { cmd: 'npm test' }))
      .toEqual({ sourceType: 'test_execution', learnable: true });
    expect(classifyToolEvidence('shell', { cmd: 'curl https://example.com/config' }))
      .toEqual({ sourceType: 'external_unverified', learnable: false });
    expect(classifyToolEvidence('image_gen__imagegen', { prompt: 'database diagram' }))
      .toEqual({ sourceType: 'external_unverified', learnable: false });
  });

  it('keeps repeated identical prompts as distinct prepared/emitted recall events', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-recall-events-'));
    process.env.TEST_DB_PATH = path.join(tmp, 'index.sqlite');
    db = initDatabase();
    const event = { sessionId: 'repeat-session', project: '/tmp/project', prompt: 'same prompt', factIds: ['fact-1'] };
    const first = recordRecallEvent(db, event);
    const second = recordRecallEvent(db, event);
    expect(first).not.toBe(second);
    expect(markRecallEventEmitted(db, event)).toBe(true);
    const rows = db.prepare('SELECT status, emitted_at FROM recall_events ORDER BY rowid').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status).sort()).toEqual(['emitted', 'prepared']);
    expect(rows.find((row) => row.status === 'emitted')?.emitted_at).toBeTruthy();
  });

  it('trusted repo evidence can evolve an old recalled fact without using recall or assistant text', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-evolution-provenance-'));
    process.env.TEST_DB_PATH = path.join(tmp, 'index.sqlite');
    db = initDatabase();
    insertExchange(db, {
      id: 'exchange-repo-observation',
      project: '/tmp/project',
      timestamp: '2026-08-27T02:00:00Z',
      userMessage: 'Check the current database configuration.',
      assistantMessage: 'The project now uses PostgreSQL instead of SQLite.',
      archivePath: '/tmp/evolution-rollout.jsonl',
      lineStart: 1,
      lineEnd: 8,
      sessionId: 'evolution-session',
      toolCalls: [
        {
          id: 'evolution-recall', exchangeId: 'exchange-repo-observation',
          toolName: 'mcp__memex__search_facts', toolInput: { query: 'database' },
          toolResult: 'Project database is SQLite', isError: false, timestamp: '2026-08-27T02:00:01Z',
        },
        {
          id: 'evolution-read', exchangeId: 'exchange-repo-observation',
          toolName: 'read_file', toolInput: { path: 'docker-compose.yml' },
          toolResult: 'image: postgres:17', isError: false, timestamp: '2026-08-27T02:00:02Z',
        },
      ],
    }, Array(384).fill(0));
    const exchange = db.prepare(`SELECT user_message, assistant_message, assistant_learnable,
      has_memex_recall FROM exchanges WHERE id = ?`).get('exchange-repo-observation') as any;
    exchange.tool_evidence = db.prepare(`SELECT tool_name, tool_result, source_type, learnable
      FROM tool_calls WHERE exchange_id = ? ORDER BY id`).all('exchange-repo-observation');
    const evidencePrompt = buildExtractionPrompt([exchange]);
    expect(evidencePrompt).toContain('image: postgres:17');
    expect(evidencePrompt).not.toContain('Project database is SQLite');
    expect(evidencePrompt).not.toContain('The project now uses PostgreSQL instead of SQLite');

    const oldId = insertFact(db, {
      fact: 'Project database is SQLite', category: 'decision', scope_type: 'project',
      scope_project: '/tmp/project', source_exchange_ids: ['exchange-old'], embedding: null,
    });
    const newId = insertFact(db, {
      fact: 'Project database is PostgreSQL', category: 'decision', scope_type: 'project',
      scope_project: '/tmp/project', source_exchange_ids: ['exchange-repo-observation'], embedding: null,
    });
    const [oldFact, newFact] = [oldId, newId].map((id) =>
      getActiveFacts(db!).find((fact) => fact.id === id)!);

    applyConsolidationResult(db, oldFact, newFact, {
      relation: 'EVOLUTION',
      merged_fact: 'Project database is PostgreSQL',
      reason: 'Repository configuration now points to PostgreSQL',
    });

    const active = getActiveFacts(db);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(oldId);
    expect(active[0].fact).toBe('Project database is PostgreSQL');
    expect(active[0].source_exchange_ids).toEqual(['exchange-old', 'exchange-repo-observation']);
    const revisions = getRevisions(db, oldId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].source_exchange_id).toBe('exchange-repo-observation');
  });
});
