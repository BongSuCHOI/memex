/** Frozen small safety corpus: run unchanged before and after the repair. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
vi.mock('../src/embeddings.js', () => ({
  EMBEDDING_VERSION: 2, EMBEDDING_MODEL: 'fixed-integrity-fixture',
  initEmbeddings: async () => {}, generateEmbedding: vi.fn(async () => new Array(384).fill(0.1)),
}));
vi.mock('../src/llm.js', async (original) => ({
  ...(await original<typeof import('../src/llm.js')>()),
  callMemoryModel: vi.fn(async () => JSON.stringify({ relation: 'DUPLICATE', merged_fact: 'unused', reason: 'same fact' })),
}));
import { initDatabase, insertExchange } from '../src/db.js';
import { insertFact, getActiveFacts } from '../src/fact-db.js';
import { applyConsolidationResult, consolidateAllPending } from '../src/consolidator.js';
import { ensureSessionMemoryState } from '../src/continuity-core.js';
import { createWorkstream } from '../src/continuity-identity.js';
import { createRelation, getRelatedFacts } from '../src/ontology-db.js';
import { recordChronicleEvent } from '../src/chronicle.js';
import { handleToolCall } from '../src/mcp-server.js';
import { generateEmbedding } from '../src/embeddings.js';
import { callMemoryModel } from '../src/llm.js';
import { StaleFactMutationError } from '../src/fact-management.js';

let db: Database.Database;
let root: string;
let session: ReturnType<typeof ensureSessionMemoryState>;
let sibling: string;
let factSequence: number;
const cwd = '/fixture/memory-integrity';
const embedding = new Array(384).fill(0.1);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-integrity-'));
  process.env.TEST_DB_PATH = path.join(root, 'db.sqlite');
  process.env.MEMEX_HOME = path.join(root, 'home');
  db = initDatabase();
  session = ensureSessionMemoryState(db, { sessionId: 'integrity-a', project: cwd });
  sibling = createWorkstream(db, { projectId: session.projectId, workspaceId: session.workspaceId,
    projectPath: cwd, ownerSessionId: 'integrity-b', workstreamId: 'integrity-workstream-b' });
  vi.clearAllMocks();
  factSequence = 0;
});
afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

function fact(text: string, workstream: string | null = session.workstreamId) {
  const source = `source-${text}`;
  const at = `2026-09-${String(++factSequence).padStart(2, '0')}T00:00:00.000Z`;
  insertExchange(db, { id: source, project: cwd, cwd, timestamp: at,
    userMessage: text, assistantMessage: '', archivePath: path.join(root, 'source.jsonl'), lineStart: 1, lineEnd: 2,
    }, embedding);
  db.prepare('UPDATE exchanges SET project_id = ?, workspace_id = ?, workstream_id = ? WHERE id = ?')
    .run(workstream === 'global' ? null : session.projectId, workstream && workstream !== 'global' ? session.workspaceId : null, workstream === 'global' ? null : workstream, source);
  const id = insertFact(db, { fact: text, category: 'decision', scope_type: workstream === 'global' ? 'global' : 'project', scope_project: workstream === 'global' ? null : cwd,
    source_exchange_ids: [source], embedding, project_id: workstream === 'global' ? null : session.projectId,
    ...(workstream === 'global' ? {} : workstream ? { workspace_id: session.workspaceId, workstream_id: workstream,
      promotion_state: 'workstream' as const, promotion_evidence: 'experimental' as const }
      : { promotion_state: 'project-current' as const, promotion_evidence: 'validated' as const }),
    ...(workstream === 'global' ? { subject_key: 'state.cache.production' } : {}),
  });
  recordChronicleEvent(db, { kind: 'ASSERTED', factId: id, newValue: text, actor: 'extractor',
    evidenceAuthority: 'human-decision', effectiveAt: at, effectiveAtSource: 'source',
    projectionApplied: true, sourceExchangeIds: [source] });
  return getActiveFacts(db).find(f => f.id === id)!;
}

it('same project/path sibling workstreams never consolidate', async () => {
  const a = fact('Use SQLite for cache A');
  const b = fact('Use SQLite for cache B', sibling);
  await applyConsolidationResult(db, a, b, { relation: 'DUPLICATE', merged_fact: a.fact, reason: 'same storage' });
  expect(getActiveFacts(db)).toHaveLength(2);
});

it('candidate selection filters sibling workstreams before calling a model', async () => {
  fact('Use SQLite for cache A');
  fact('Use SQLite for cache B', sibling);
  await consolidateAllPending(db);
  expect(callMemoryModel).not.toHaveBeenCalled();
  expect(getActiveFacts(db)).toHaveLength(2);
});

it('a workstream fact cannot overwrite or absorb project-wide truth', async () => {
  const project = fact('Production cache uses PostgreSQL', null);
  const task = fact('Production cache uses SQLite for experiment');
  await applyConsolidationResult(db, project, task, { relation: 'EVOLUTION', merged_fact: task.fact, reason: 'newer experiment' });
  expect(getActiveFacts(db)).toHaveLength(2);
  expect(getActiveFacts(db).find(f => f.id === project.id)?.fact).toBe(project.fact);
});

it('automatic consolidation cannot introduce unsupported merged wording', async () => {
  const old = fact('Production cache uses SQLite', 'global');
  const next = fact('Production cache uses Redis', 'global');
  for (const [f, at] of [[old, '2026-09-01T00:00:00.000Z'], [next, '2026-09-02T00:00:00.000Z']] as const) {
    recordChronicleEvent(db, { kind: 'ASSERTED', factId: f.id, projectId: f.project_id,
      subjectKey: f.subject_key, newValue: f.fact, actor: 'extractor', evidenceAuthority: 'human-decision',
      effectiveAt: at, effectiveAtSource: 'source', projectionApplied: true, sourceExchangeIds: f.source_exchange_ids });
  }
  await applyConsolidationResult(db, old, next, {
    relation: 'EVOLUTION', merged_fact: 'Every project must use Redis with no exceptions', reason: 'same subject and production conditions',
    ...{ same_subject: true, same_conditions: true },
  });
  const active = getActiveFacts(db);
  expect(active.some(f => f.fact.includes('Every project'))).toBe(false);
  expect(active.some(f => f.fact === next.fact)).toBe(true);
});

it('semantic mutation during embedding rejects the stale consolidation', async () => {
  const old = fact('Production cache uses SQLite', 'global');
  const next = fact('Production cache uses Redis', 'global');
  vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
    db.prepare('UPDATE facts SET fact = ?, semantic_generation = semantic_generation + 1 WHERE id = ?').run('Explicit user correction: use MariaDB', old.id);
    return embedding;
  });
  await expect(applyConsolidationResult(db, old, next, {
    relation: 'EVOLUTION', merged_fact: next.fact, reason: 'same subject',
    ...{ same_subject: true, same_conditions: true },
  })).rejects.toThrow(StaleFactMutationError);
  expect(getActiveFacts(db)).toHaveLength(2);
});

it.each(['search_facts', 'trace_fact'])('%s applies identity scope to related facts', async (tool) => {
  const seed = fact('Visible seed in workstream A');
  const secret = fact('PRIVATE sibling workstream B', sibling);
  createRelation(db, seed.id, 'SUPPORTS', secret.id);
  const response = await handleToolCall(tool, { query: 'Visible seed', scope: 'workstream', workstream_id: session.workstreamId, limit: 1 });
  expect(response.isError).not.toBe(true);
  expect(response.content[0].text).toContain(seed.fact);
  expect(response.content[0].text).not.toContain(secret.fact);
});

it('graph traversal prunes out-of-scope bridges at every hop', () => {
  const seed = fact('Visible seed in workstream A');
  const bridge = fact('PRIVATE bridge in workstream B', sibling);
  const end = fact('Reachable only through private bridge');
  createRelation(db, seed.id, 'SUPPORTS', bridge.id);
  createRelation(db, bridge.id, 'SUPPORTS', end.id);
  expect(getRelatedFacts(db, seed.id, 3, 0.6, 0.2, null, 'project', {
    type: 'workstream-id', projectId: session.projectId!, workspaceId: session.workspaceId, workstreamId: session.workstreamId,
  })).toEqual([]);
});
