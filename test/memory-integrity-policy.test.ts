import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
vi.mock('../src/embeddings.js', () => ({ EMBEDDING_VERSION: 2, initEmbeddings: async () => {},
  generateEmbedding: vi.fn(async () => new Array(384).fill(0.1)) }));
vi.mock('../src/llm.js', async original => ({ ...(await original<typeof import('../src/llm.js')>()),
  callMemoryModel: vi.fn(async () => JSON.stringify({ relation: 'DUPLICATE', reason: 'same meaning' })) }));
import { initDatabase, insertExchange } from '../src/db.js';
import { insertFact, getActiveFacts, rowToFact, searchFactsInScope, factMatchesReadScope } from '../src/fact-db.js';
import { applyConsolidationResult, consolidateAllPending } from '../src/consolidator.js';
import { recordChronicleEvent } from '../src/chronicle.js';
import { captureMutationPolicy, hasLocalMeaningEvidence, recordLocalMeaningEvidence } from '../src/fact-policy.js';
import { editFact, mutateFactMeaningWithPolicy, StaleFactMutationError } from '../src/fact-management.js';
import { generateEmbedding } from '../src/embeddings.js';
import { callMemoryModel } from '../src/llm.js';
import { ensureSessionMemoryState, readResidentRevisionCorrections, recordResidentFactRevisions,
  readResidentFactRevisions } from '../src/continuity-core.js';
import { createWorkstream } from '../src/continuity-identity.js';
import { getRelatedFacts, getRelatedFactsInScope, createRelation } from '../src/ontology-db.js';
import { saveExtractedFactsDetailed } from '../src/fact-extractor.js';
import type { Fact, ConsolidationResult } from '../src/types.js';

let db: Database.Database;
let root: string;
let sequence: number;
const embedding = new Array(384).fill(0.1);
const evolution: ConsolidationResult = { relation: 'EVOLUTION', reason: 'same production cache', merged_fact: 'UNSUPPORTED universal rule', same_subject: true, same_conditions: true };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-policy-'));
  process.env.TEST_DB_PATH = path.join(root, 'db.sqlite');
  process.env.MEMEX_HOME = path.join(root, 'home');
  db = initDatabase(); sequence = 0;
  vi.mocked(generateEmbedding).mockReset().mockResolvedValue(embedding);
  vi.mocked(callMemoryModel).mockReset().mockResolvedValue(JSON.stringify({ relation: 'DUPLICATE', reason: 'same meaning' }));
});
afterEach(() => {
  db.close(); delete process.env.TEST_DB_PATH; delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});
function current(id: string): Fact { return rowToFact(db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Record<string, unknown>); }
function source(text: string): string {
  const id = `source-${++sequence}`;
  insertExchange(db, { id, project: '/fixture/policy', cwd: '/fixture/policy',
    timestamp: `2026-09-${String(sequence).padStart(2, '0')}T00:00:00.000Z`, userMessage: text,
    assistantMessage: '', archivePath: path.join(root, `${id}.jsonl`), lineStart: 1, lineEnd: 2 }, embedding);
  return id;
}
function known(text: string): Fact {
  const sourceId = source(text);
  const id = insertFact(db, { fact: text, scope_type: 'global', scope_project: null, category: 'knowledge',
    source_exchange_ids: [sourceId], embedding, subject_key: 'state.cache.production' });
  recordChronicleEvent(db, { kind: 'ASSERTED', factId: id, newValue: text, actor: 'extractor',
    evidenceAuthority: 'human-decision', sourceExchangeIds: [sourceId], projectionApplied: true, toSemanticGeneration: 1 });
  return current(id);
}

it('rejects omitted core read and mutation policies at runtime', async () => {
  const a = known('Production cache is SQLite');
  expect(() => searchFactsInScope(db, embedding, undefined as never)).toThrow('ReadScope is required');
  expect(() => getRelatedFactsInScope(db, a.id, undefined as never)).toThrow('ReadScope is required');
  await expect(mutateFactMeaningWithPolicy(db, { factId: a.id, newText: 'Changed', policy: undefined as never })).rejects.toThrow('MutationPolicy is required');
});

it('keeps legacy project facts active and records why they require review', async () => {
  const params = { category: 'knowledge' as const, scope_type: 'project' as const, scope_project: '/legacy', source_exchange_ids: [], embedding };
  const a = insertFact(db, { ...params, fact: 'Legacy first fact' });
  const b = insertFact(db, { ...params, fact: 'Legacy second fact' });
  expect(await applyConsolidationResult(db, current(a), current(b), { relation: 'DUPLICATE', merged_fact: '', reason: 'similar' })).toBe(false);
  expect(getActiveFacts(db)).toHaveLength(2);
  expect(db.prepare('SELECT classifier_note FROM fact_revisions WHERE fact_id = ?').get(b)).toEqual({ classifier_note: 'consolidation withheld: legacy or incomplete project identity' });
  await consolidateAllPending(db);
  expect(callMemoryModel).not.toHaveBeenCalled();
});

it.each(['same_subject', 'same_conditions'] as const)('preserves both facts when %s is absent or false', async field => {
  const a = known('Production cache is SQLite'); const b = known('Production cache is Redis');
  for (const value of [undefined, false]) expect(await applyConsolidationResult(db, a, b, { ...evolution, [field]: value })).toBe(false);
  expect(getActiveFacts(db)).toHaveLength(2);
  expect(db.prepare("SELECT COUNT(*) n FROM fact_revisions WHERE classifier_note LIKE 'consolidation withheld:%'").get()).toEqual({ n: 1 });
});

it('preserves different canonical subjects even with a confident competing verdict', async () => {
  const a = known('Production cache is SQLite'); const b = known('Development cache is Redis');
  db.prepare("UPDATE facts SET subject_key = 'state.cache.development' WHERE id = ?").run(b.id);
  expect(await applyConsolidationResult(db, a, current(b.id), evolution)).toBe(false);
  expect(getActiveFacts(db)).toHaveLength(2);
});

it('does not equate peer authority with current local verification', async () => {
  const a = known('Production cache is SQLite'); const b = known('Production cache is Redis');
  db.prepare("UPDATE fact_revisions SET effective_at_source = 'peer' WHERE fact_id = ?").run(b.id);
  db.prepare('DELETE FROM fact_evidence_receipts WHERE fact_id = ?').run(b.id);
  expect(await applyConsolidationResult(db, a, b, evolution)).toBe(false);
  expect(getActiveFacts(db)).toHaveLength(2);
  expect(generateEmbedding).not.toHaveBeenCalled();
});

it.each(['subject_key', 'promotion_state', 'lifecycle_generation'])('rejects %s changes during embedding, even without a semantic clock bump', async field => {
  const a = known('Production cache is SQLite'); const b = known('Production cache is Redis');
  vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
    const value = field === 'subject_key' ? 'state.cache.other' : field === 'promotion_state' ? 'decision' : 2;
    db.prepare(`UPDATE facts SET ${field} = ? WHERE id = ?`).run(value, b.id);
    return embedding;
  });
  await expect(applyConsolidationResult(db, a, b, evolution)).rejects.toThrow(StaleFactMutationError);
  expect(getActiveFacts(db)).toHaveLength(2);
  expect(current(a.id).fact).toBe(a.fact);
});

it.each(['delete', 'edit'])('rejects source %s during embedding', async action => {
  const a = known('Production cache is SQLite'); const b = known('Production cache is Redis');
  vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
    if (action === 'delete') db.prepare('DELETE FROM exchanges WHERE id = ?').run(b.source_exchange_ids[0]);
    else db.prepare("UPDATE exchanges SET user_message = 'Use MariaDB instead' WHERE id = ?").run(b.source_exchange_ids[0]);
    return embedding;
  });
  await expect(applyConsolidationResult(db, a, b, evolution)).rejects.toThrow(StaleFactMutationError);
  expect(getActiveFacts(db)).toHaveLength(2);
});

it('rejects source mutation during the comparison model call', async () => {
  known('Production cache is SQLite'); const b = known('Production cache remains SQLite');
  vi.mocked(callMemoryModel).mockImplementationOnce(async () => {
    db.prepare("UPDATE exchanges SET user_message = 'Use MariaDB instead' WHERE id = ?").run(b.source_exchange_ids[0]);
    return JSON.stringify({ relation: 'DUPLICATE', reason: 'same' });
  });
  await consolidateAllPending(db);
  expect(getActiveFacts(db)).toHaveLength(2);
});

it('unions the live lineage of both duplicate participants after comparison', async () => {
  const a = known('Production cache is SQLite'); const b = known('Production cache remains SQLite');
  const extraA = source('Confirm first cache choice'); const extraB = source('Confirm second cache choice');
  db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?').run(JSON.stringify([...a.source_exchange_ids, extraA]), a.id);
  db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?').run(JSON.stringify([...b.source_exchange_ids, extraB]), b.id);
  await applyConsolidationResult(db, a, b, { relation: 'DUPLICATE', reason: 'same', merged_fact: '' });
  expect(current(a.id).source_exchange_ids.sort()).toEqual([...a.source_exchange_ids, ...b.source_exchange_ids, extraA, extraB].sort());
});

it('explicit user correction is authoritative and also rejects concurrent scope changes', async () => {
  const a = known('Production cache is SQLite');
  await editFact(db, a.id, { text: 'Production cache is Redis', reason: 'User selected Redis' });
  const event = db.prepare("SELECT actor, rationale, new_fact FROM fact_revisions WHERE fact_id = ? AND event_kind = 'CHANGED'").get(a.id);
  expect(event).toEqual({ actor: 'user', rationale: 'User selected Redis', new_fact: 'Production cache is Redis' });
  vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
    db.prepare("UPDATE facts SET subject_key = 'state.other' WHERE id = ?").run(a.id); return embedding;
  });
  await expect(editFact(db, a.id, { text: 'Production cache is MariaDB' })).rejects.toThrow(StaleFactMutationError);
  expect(current(a.id).fact).toBe('Production cache is Redis');
});

it('automatic mutation policy rejects rewritten verified text before embedding', async () => {
  const a = known('Production cache is SQLite');
  const policy = captureMutationPolicy(db, 'verified-extraction', [a.id], { verifiedText: 'Production cache is Redis', sourceExchangeIds: a.source_exchange_ids });
  await expect(mutateFactMeaningWithPolicy(db, { policy, factId: a.id, newText: 'All projects must use Redis' })).rejects.toThrow('cannot rewrite verified text');
  expect(generateEmbedding).not.toHaveBeenCalled();
});

it('extraction cannot commit after a source changes during embedding', async () => {
  const id = source('Production cache is SQLite');
  vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
    db.prepare("UPDATE exchanges SET user_message = 'Use MariaDB instead' WHERE id = ?").run(id); return embedding;
  });
  await expect(saveExtractedFactsDetailed(db, [{ fact: 'Production cache is SQLite', category: 'knowledge', scope_type: 'global', source_exchange_ids: [id] }], '/fixture/policy', [id]))
    .rejects.toThrow(StaleFactMutationError);
  expect(getActiveFacts(db)).toHaveLength(0);
});

it('revokes resident text after a scope move and prunes out-of-scope seed pivots', () => {
  const s = ensureSessionMemoryState(db, { sessionId: 'scope-a', project: '/fixture/scope' });
  const other = createWorkstream(db, { projectId: s.projectId, workspaceId: s.workspaceId, projectPath: '/fixture/scope', workstreamId: 'scope-b', ownerSessionId: 'owner-b' });
  const add = (text: string) => insertFact(db, { fact: text, category: 'knowledge', scope_type: 'project', scope_project: '/fixture/scope',
    source_exchange_ids: [], embedding, project_id: s.projectId, workspace_id: s.workspaceId,
    workstream_id: s.workstreamId, promotion_state: 'workstream', promotion_evidence: 'experimental' });
  const seed = add('Known resident memory'); const publicEnd = add('Public end');
  createRelation(db, seed, 'SUPPORTS', publicEnd);
  recordResidentFactRevisions(db, 'scope-a', s.contextEpoch, [[seed, 1, 1]]);
  db.prepare("UPDATE facts SET workstream_id = ?, fact = 'PRIVATE revised meaning', semantic_generation = 2 WHERE id = ?").run(other, seed);
  const scope = { type: 'workstream-id' as const, projectId: s.projectId!, workspaceId: s.workspaceId, workstreamId: s.workstreamId };
  expect(getRelatedFactsInScope(db, seed, scope)).toEqual([]);
  expect(getRelatedFacts(db, seed)).toEqual([]); // omitted legacy scope is global
  expect(factMatchesReadScope(db, current(seed), scope)).toBe(false);
  const corrections = readResidentRevisionCorrections(db, 'scope-a');
  expect(JSON.stringify(corrections)).not.toContain('PRIVATE');
  expect(corrections[0].scope_revoked).toBe(true);
  recordResidentFactRevisions(db, 'scope-a', s.contextEpoch, [[seed, 2, 1]]);
  expect(readResidentFactRevisions(db, 'scope-a').resident).toEqual([]);
});

it('unions both live lineages when evolution embeds the adopted meaning', async () => {
  const a = known('Production cache is SQLite'); const b = known('Production cache is Redis');
  const extraA = source('Confirm first cache choice'); const extraB = source('Confirm second cache choice');
  vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
    db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?').run(JSON.stringify([...a.source_exchange_ids, extraA]), a.id);
    db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?').run(JSON.stringify([...b.source_exchange_ids, extraB]), b.id);
    return embedding;
  });
  expect(await applyConsolidationResult(db, a, b, evolution)).toBe(true);
  expect(current(a.id).source_exchange_ids.sort()).toEqual([...a.source_exchange_ids, ...b.source_exchange_ids, extraA, extraB].sort());
});

it('an adopted meaning retains every verified source in its local receipt', async () => {
  const a = known('Production cache is SQLite'); const b = known('Production cache is Redis');
  const supporting = source('Redis applies to production');
  db.prepare('UPDATE facts SET source_exchange_ids = ? WHERE id = ?').run(JSON.stringify([...b.source_exchange_ids, supporting]), b.id);
  recordLocalMeaningEvidence(db, b.id, b.fact, 'extractor', [...b.source_exchange_ids, supporting]);
  expect(await applyConsolidationResult(db, a, current(b.id), evolution)).toBe(true);
  expect(hasLocalMeaningEvidence(db, current(a.id))).toBe(true);
  db.prepare("UPDATE exchanges SET user_message = 'Only staging uses Redis' WHERE id = ?").run(supporting);
  expect(hasLocalMeaningEvidence(db, current(a.id))).toBe(false);
});
