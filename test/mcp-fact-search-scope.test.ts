import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'test',
}));

import { initDatabase, insertExchange } from '../src/db.js';
import { insertFact, insertFactContextDependencies } from '../src/fact-db.js';
import { handleToolCall } from '../src/mcp-server.js';
import { ensureSessionMemoryState } from '../src/continuity-core.js';
import { getToolDefinitions } from '../src/mcp-server.js';
import { createWorkstream } from '../src/continuity-identity.js';
import { createRelation } from '../src/ontology-db.js';

describe('MCP scope-aware fact search', () => {
  let db: Database.Database;
  let testDir: string;
  const embedding = new Array(384).fill(0.1);

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-fact-scope-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('search_facts(scope=global) reaches a global fact behind a project crowd', async () => {
    for (let i = 0; i < 240; i++) {
      insertFact(db, {
        fact: `project crowd ${i}`,
        category: 'decision',
        scope_type: 'project',
        scope_project: `/project-${i}`,
        source_exchange_ids: [],
        embedding,
      });
    }
    insertFact(db, {
      fact: 'global target decision',
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.101),
    });

    const response = await handleToolCall('search_facts', {
      query: 'global target decision',
      scope: 'global',
      limit: 5,
    });
    const text = response.content[0].text;

    expect(response.isError).not.toBe(true);
    expect(text).toContain('global target decision');
    expect(text).toContain('Results: 1');
    expect(text).not.toContain('project crowd');
  });

  it('search_facts applies category before limit', async () => {
    for (let i = 0; i < 60; i++) {
      insertFact(db, {
        fact: `decision crowd ${i}`,
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding,
      });
    }
    insertFact(db, {
      fact: 'global preference target',
      category: 'preference',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: new Array(384).fill(0.101),
    });

    const response = await handleToolCall('search_facts', {
      query: 'global preference target',
      scope: 'global',
      category: 'preference',
      limit: 1,
    });
    const text = response.content[0].text;

    expect(response.isError).not.toBe(true);
    expect(text).toContain('global preference target');
    expect(text).toContain('Results: 1');
    expect(text).not.toContain('decision crowd');
  });

  it('trace_fact separates authoritative source from interpretive context', async () => {
    const insertExchange = db.prepare(`
      INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message,
         archive_path, line_start, line_end)
      VALUES (?, '/project', '2026-08-31T00:00:00.000Z', ?, ?, ?, ?, ?)
    `);
    insertExchange.run(
      'source-human',
      '좋아, SQLite로 하자.',
      '결정을 기록했습니다.',
      '/tmp/source.jsonl',
      20,
      21,
    );
    insertExchange.run(
      'context-assistant',
      '저장소 선택지를 알려줘.',
      '로컬 우선 요구에는 SQLite를 추천합니다.',
      '/tmp/context.jsonl',
      10,
      11,
    );
    const factId = insertFact(db, {
      fact: 'The project uses SQLite for local persistence.',
      category: 'decision',
      scope_type: 'project',
      scope_project: '/project',
      source_exchange_ids: ['source-human'],
      embedding,
    });
    insertFactContextDependencies(db, factId, [{
      exchange_id: 'context-assistant',
      dependency_kind: 'assistant_context',
    }]);

    const response = await handleToolCall('trace_fact', {
      query: 'SQLite local persistence',
      project: '/project',
      limit: 1,
    });
    const text = response.content[0].text;

    expect(response.isError).not.toBe(true);
    expect(text).toContain('### Source Conversations');
    expect(text).toContain('좋아, SQLite로 하자.');
    expect(text).toContain('### Interpretive Context (Non-Authoritative)');
    expect(text).toContain('assistant_context');
    expect(text).toContain('helped resolve meaning but are not Fact evidence');
  });

  it('accepts stable project/workspace/workstream/session scopes without process-cwd inference', async () => {
    const session = ensureSessionMemoryState(db, { sessionId: 'scope-session', project: '/stable/project' });
    insertFact(db, {
      fact: 'project current truth', category: 'decision', scope_type: 'project',
      scope_project: '/stable/project', source_exchange_ids: [], embedding,
      project_id: session.projectId, promotion_state: 'project-current', promotion_evidence: 'validated', subject_key: 'state.main.cache',
    });
    const unrelated = createWorkstream(db, {
      projectId: session.projectId, workspaceId: session.workspaceId,
      projectPath: '/stable/project', ownerSessionId: 'unrelated-owner', workstreamId: 'unrelated-stream',
    });
    insertFact(db, {
      fact: 'other workstream experiment', category: 'knowledge', scope_type: 'project',
      scope_project: '/stable/project', source_exchange_ids: [], embedding,
      project_id: session.projectId, workstream_id: unrelated, promotion_state: 'workstream', promotion_evidence: 'experimental', subject_key: 'workstream.cache',
    });
    const response = await handleToolCall('search_facts', {
      query: 'project current truth', scope: 'workstream', workstream_id: session.workstreamId, limit: 10,
    });
    const text = response.content[0].text;
    expect(response.isError).not.toBe(true);
    expect(text).toContain('project current truth');
    expect(text).not.toContain('other workstream experiment');

    const definition = getToolDefinitions().find((tool) => tool.name === 'search_facts');
    expect((definition?.inputSchema.properties.scope as { enum: string[] }).enum)
      .toEqual(['project', 'workspace', 'workstream', 'session', 'global', 'all']);
  });

  it('keeps lookup read-only and rejects mixed stable identity membership', async () => {
    const first = ensureSessionMemoryState(db, { sessionId: 'scope-first', project: '/stable/first' });
    const second = ensureSessionMemoryState(db, { sessionId: 'scope-second', project: '/stable/second' });
    const before = {
      projects: (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n,
      workspaces: (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n,
    };
    const legacy = await handleToolCall('search_facts', {
      query: 'unknown compatibility query',
      project: '/stable/not-registered',
      limit: 5,
    });
    expect(legacy.isError).not.toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n)
      .toBe(before.projects);
    expect((db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n)
      .toBe(before.workspaces);

    const mixed = await handleToolCall('search_facts', {
      query: 'mixed identity request',
      scope: 'workstream',
      workstream_id: first.workstreamId,
      project_id: second.projectId,
    });
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0].text).toContain('outside project_id');
    const ambiguousGlobal = await handleToolCall('graph_stats', {
      scope: 'global', project_id: first.projectId,
    });
    expect(ambiguousGlobal.isError).toBe(true);
    expect(ambiguousGlobal.content[0].text).toContain('cannot be combined');
    const ambiguousProject = await handleToolCall('search_facts', {
      query: 'mixed stable and compatibility identity',
      scope: 'project', project_id: first.projectId, project: '/stable/second',
    });
    expect(ambiguousProject.isError).toBe(true);
    expect(ambiguousProject.content[0].text).toContain('choose project_id or legacy project path');
  });

  it('exposes stable scope on every fact/ontology/avatar/graph surface', async () => {
    for (const name of ['search_facts', 'search_ontology', 'ask_avatar', 'trace_fact', 'graph_stats', 'explore_graph']) {
      const definition = getToolDefinitions().find((tool) => tool.name === name);
      expect((definition?.inputSchema.properties.scope as { enum: string[] }).enum)
        .toEqual(['project', 'workspace', 'workstream', 'session', 'global', 'all']);
      expect(definition?.inputSchema.properties).toHaveProperty('project_id');
      expect(definition?.inputSchema.properties).toHaveProperty('workspace_id');
      expect(definition?.inputSchema.properties).toHaveProperty('workstream_id');
      expect(definition?.inputSchema.properties).toHaveProperty('session_id');
    }
  });

  it('keeps stable workstream graph traversal from exposing a related sibling workstream', async () => {
    const session = ensureSessionMemoryState(db, { sessionId: 'graph-session', project: '/stable/graph' });
    const sibling = createWorkstream(db, {
      projectId: session.projectId, workspaceId: session.workspaceId,
      projectPath: '/stable/graph', ownerSessionId: 'sibling-owner', workstreamId: 'graph-sibling',
    });
    const seed = insertFact(db, {
      fact: 'visible graph seed', category: 'knowledge', scope_type: 'project',
      scope_project: '/stable/graph', source_exchange_ids: [], embedding,
      project_id: session.projectId, workspace_id: session.workspaceId,
      workstream_id: session.workstreamId, promotion_state: 'workstream', promotion_evidence: 'experimental', subject_key: 'workstream.graph.seed',
    });
    const secret = insertFact(db, {
      fact: 'sibling graph secret', category: 'knowledge', scope_type: 'project',
      scope_project: '/stable/graph', source_exchange_ids: [], embedding,
      project_id: session.projectId, workspace_id: session.workspaceId,
      workstream_id: sibling, promotion_state: 'workstream', promotion_evidence: 'experimental', subject_key: 'workstream.graph.secret',
    });
    createRelation(db, seed, 'SUPPORTS', secret);
    const response = await handleToolCall('explore_graph', {
      query: 'visible graph seed', scope: 'workstream', workstream_id: session.workstreamId, hops: 1,
    });
    expect(response.isError).not.toBe(true);
    expect(response.content[0].text).toContain('visible graph seed');
    expect(response.content[0].text).not.toContain('sibling graph secret');

    const stats = await handleToolCall('graph_stats', {
      scope: 'workstream', workstream_id: session.workstreamId,
    });
    expect(stats.isError).not.toBe(true);
    expect(stats.content[0].text).toContain('| Active Facts | 1 |');
    expect(stats.content[0].text).toContain('| Relations | 0 |');
  });

  it('finds path-free stable facts through ontology and avatar scope', async () => {
    const session = ensureSessionMemoryState(db, { sessionId: 'path-free-session', project: '/stable/path-free' });
    const now = '2026-09-03T00:00:00.000Z';
    db.prepare("INSERT INTO ontology_domains(id, name, created_at) VALUES ('stable-domain', 'Stable Domain', ?)").run(now);
    db.prepare("INSERT INTO ontology_categories(id, domain_id, name, created_at) VALUES ('stable-category', 'stable-domain', 'Stable Category', ?)").run(now);
    const factId = insertFact(db, {
      fact: 'path free stable fact', category: 'knowledge', scope_type: 'project',
      scope_project: null, source_exchange_ids: [], embedding,
      project_id: session.projectId, promotion_state: 'project-current', promotion_evidence: 'validated',
      subject_key: 'state.path.free',
    });
    db.prepare("UPDATE facts SET ontology_category_id = 'stable-category' WHERE id = ?").run(factId);
    const ontology = await handleToolCall('search_ontology', {
      scope: 'project', project_id: session.projectId,
    });
    expect(ontology.isError).not.toBe(true);
    expect(ontology.content[0].text).toContain('path free stable fact');
    const avatar = await handleToolCall('ask_avatar', {
      question: 'unrelated question with no matching threshold', scope: 'session', session_id: 'path-free-session',
    });
    expect(avatar.isError).not.toBe(true);
    expect(avatar.content[0].text).toContain('Avatar Response');
  });

  it('searches raw conversation evidence with explicit session scope', async () => {
    const cwd = '/stable/raw-search';
    ensureSessionMemoryState(db, { sessionId: 'raw-session-a', project: cwd });
    ensureSessionMemoryState(db, { sessionId: 'raw-session-b', project: cwd });
    for (const [id, sessionId, suffix] of [
      ['raw-ex-a', 'raw-session-a', 'scope-a'],
      ['raw-ex-b', 'raw-session-b', 'scope-b'],
    ]) {
      insertExchange(db, {
        id,
        project: cwd,
        cwd,
        timestamp: '2026-09-03T00:00:00.000Z',
        userMessage: `shared needle ${suffix}`,
        assistantMessage: 'ack',
        archivePath: path.join(testDir, `${sessionId}.jsonl`),
        lineStart: 1,
        lineEnd: 2,
        sessionId,
        closureState: 'closed',
      }, embedding);
    }
    const response = await handleToolCall('search', {
      query: 'shared needle',
      mode: 'text',
      scope: 'session',
      session_id: 'raw-session-a',
      response_format: 'json',
      limit: 10,
    });
    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].text) as {
      results: Array<{ exchange: { userMessage: string } }>;
    };
    expect(payload.results.map((result) => result.exchange.userMessage))
      .toEqual(['shared needle scope-a']);
  });
});
