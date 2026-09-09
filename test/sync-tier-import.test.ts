import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';
import { craftCommittedGeneration, factRow } from './sync-fixture.js';

/**
 * Issue #37 — sync-import silently produced identity combinations the local
 * writer refuses, and branch-tier memories never left the device while their
 * tombstones did.
 *
 * Observed on the v0.5.2 audit tree:
 *   SELECT scope_type, promotion_state, count(*) FROM facts GROUP BY 1,2;
 *   -- global |legacy-project|15
 *   -- project|legacy-project|103
 *   -- project|workstream    |9      <- never reached a second device
 * and `src/sync-import.ts` updated `promotion_state` while omitting
 * `workspace_id`/`workstream_id`, so a peer's promotion to `project-current`
 * left the branch key behind — the exact combination
 * `src/continuity-identity.ts` throws on and `consolidationEligibility`
 * permanently rejects as `invalid project-wide identity`.
 */

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

const AT = '2026-08-01T00:00:00.000Z';
const LATER = '2026-08-02T00:00:00.000Z';
const PROJECT_ID = 'proj-alpha-0001';
const PORTABLE_KEY = 'memex:alpha';
const originalEnv = { ...process.env };

interface SeedFact {
  id: string;
  fact: string;
  promotionState: string;
  workspaceId: string | null;
  workstreamId: string | null;
  tierReason?: string | null;
  subjectKey: string;
}

async function seedRoot(root: string, facts: SeedFact[], branch?: { workstreamId: string; hint: string }) {
  process.env.MEMEX_HOME = root;
  const { initDatabase } = await import('../src/db.js');
  const db = initDatabase();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO projects(project_id, portable_project_key, display_name, memory_revision, created_at, updated_at)
      VALUES (?, ?, 'alpha', 0, ?, ?)
    `).run(PROJECT_ID, PORTABLE_KEY, AT, AT);
    if (branch) {
      db.prepare(`
        INSERT OR IGNORE INTO minimal_workstreams
          (workstream_id, project, session_id, branch_hint, binding_reason, created_at, updated_at,
           project_id, workspace_id, status)
        VALUES (?, '/alpha', ?, ?, 'workspace-branch', ?, ?, ?, NULL, 'active')
      `).run(branch.workstreamId, `session-${branch.workstreamId}`, branch.hint, AT, AT, PROJECT_ID);
    }
    for (const fact of facts) {
      db.prepare(`
        INSERT INTO facts
          (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at,
           consolidated_count, is_active, embedding_version, needs_consolidation,
           semantic_generation, semantic_updated_at, lifecycle_generation, lifecycle_updated_at,
           project_id, subject_key, promotion_state, tier_reason, workspace_id, workstream_id)
        VALUES (?, ?, 'knowledge', 'project', NULL, '[]', ?, ?, 1, 1, 2, 0, 1, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fact.id, fact.fact, AT, AT, AT, AT,
        PROJECT_ID, fact.subjectKey, fact.promotionState, fact.tierReason ?? null,
        fact.workspaceId, fact.workstreamId,
      );
    }
  } finally {
    db.close();
  }
}

async function readFactRow(root: string, id: string) {
  process.env.MEMEX_HOME = root;
  const { initDatabase } = await import('../src/db.js');
  const db = initDatabase();
  try {
    return db.prepare(`
      SELECT id, promotion_state, workspace_id, workstream_id, tier_reason, fact
      FROM facts WHERE id = ?
    `).get(id) as
      | {
          id: string;
          promotion_state: string;
          workspace_id: string | null;
          workstream_id: string | null;
          tier_reason: string | null;
          fact: string;
        }
      | undefined;
  } finally {
    db.close();
  }
}

describe('sync tier identity (#37)', () => {
  let roots: string[];
  let restoreConsole: () => void;

  beforeEach(() => {
    roots = [];
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMEX_DB_PATH;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  function tempRoot(prefix: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  it('a peer promotion of a branch fact lands as a LEGAL project-wide row', async () => {
    const root = tempRoot('memex-sync-tier-promote-');
    await seedRoot(root, [{
      id: 'fact-promoted',
      fact: 'local branch truth',
      promotionState: 'workstream',
      workspaceId: 'workspace-local-1',
      workstreamId: 'ws-branch-1',
      tierReason: 'workspace-branch',
      subjectKey: 'alpha.deploy.target',
    }]);

    // The peer promoted the same fact id to project-wide truth. It also carries
    // the pre-promotion branch key: the importer must not trust it.
    craftCommittedGeneration('peer-device', {
      'facts.jsonl': factRow({
        id: 'fact-promoted',
        fact: 'promoted project truth',
        scope_type: 'project',
        scope_project: null,
        project_id: PROJECT_ID,
        portable_project_key: PORTABLE_KEY,
        subject_key: 'alpha.deploy.target',
        promotion_state: 'project-current',
        tier_reason: 'merged',
        workspace_id: 'workspace-peer-9',
        workstream_id: 'ws-branch-1',
        semantic_updated_at: LATER,
        updated_at: LATER,
      }) + '\n',
    });

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.malformedRows).toEqual([]);
    expect(result.updatedFacts).toBe(1);

    const row = await readFactRow(root, 'fact-promoted');
    expect(row?.promotion_state).toBe('project-current');
    // The invariant src/continuity-identity.ts and src/fact-db.ts both throw on.
    expect(row?.workspace_id).toBeNull();
    expect(row?.workstream_id).toBeNull();
    expect(row?.tier_reason).toBe('merged');

    // And the row is one consolidation would accept — the user-visible symptom
    // of the old bug was a fact that could never be consolidated again.
    const { consolidationEligibility } = await import('../src/fact-policy.js');
    const imported = {
      id: row!.id,
      is_active: 1,
      scope_type: 'project',
      project_id: PROJECT_ID,
      promotion_state: row!.promotion_state,
      workspace_id: row!.workspace_id,
      workstream_id: row!.workstream_id,
      subject_key: 'alpha.deploy.target',
    } as never;
    const sibling = { ...(imported as object), id: 'other-fact' } as never;
    expect(consolidationEligibility(imported, sibling)).not.toBe('invalid project-wide identity');
  });

  it('an unknown promotion_state is reported, not rewritten to legacy-project', async () => {
    const root = tempRoot('memex-sync-tier-unknown-');
    await seedRoot(root, []);
    craftCommittedGeneration('peer-device', {
      'facts.jsonl': factRow({
        id: 'fact-from-the-future',
        fact: 'a state this version does not know',
        scope_type: 'project',
        scope_project: null,
        project_id: PROJECT_ID,
        portable_project_key: PORTABLE_KEY,
        subject_key: 'alpha.future.state',
        promotion_state: 'organization-current',
      }) + '\n',
    });

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.malformedRows.length).toBeGreaterThan(0);
    expect(result.malformedRows[0].file).toContain('facts.jsonl');
    expect(result.malformedRows[0].error).toContain('schema validation');
    // Nothing from the rejected generation is imported.
    expect(await readFactRow(root, 'fact-from-the-future')).toBeUndefined();
  });

  it('an illegal tier shape (workstream without its workstream_id) is rejected', async () => {
    const root = tempRoot('memex-sync-tier-illegal-');
    await seedRoot(root, []);
    craftCommittedGeneration('peer-device', {
      'facts.jsonl': factRow({
        id: 'fact-no-stream',
        fact: 'branch truth with no branch',
        scope_type: 'project',
        scope_project: null,
        project_id: PROJECT_ID,
        portable_project_key: PORTABLE_KEY,
        subject_key: 'alpha.orphan.stream',
        promotion_state: 'workstream',
        workstream_id: null,
      }) + '\n',
    });

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.malformedRows.length).toBeGreaterThan(0);
    expect(await readFactRow(root, 'fact-no-stream')).toBeUndefined();
  });

  it('a branch-tier memory round-trips A -> B with its tier, workspace and branch metadata', async () => {
    const rootA = tempRoot('memex-sync-tier-a-');
    const rootB = tempRoot('memex-sync-tier-b-');
    const { deterministicWorkstreamId } = await import('../src/continuity-identity.js');
    const workstreamId = deterministicWorkstreamId(PROJECT_ID, 'feature/tier-sync');

    await seedRoot(
      rootA,
      [
        {
          id: 'fact-branch',
          fact: 'the feature branch uses the staging queue',
          promotionState: 'workstream',
          workspaceId: null,
          workstreamId,
          tierReason: 'workspace-branch',
          subjectKey: 'alpha.queue.branch',
        },
        {
          id: 'fact-common',
          fact: 'the project deploys from main',
          promotionState: 'project-current',
          workspaceId: null,
          workstreamId: null,
          tierReason: 'no-branch-signal',
          subjectKey: 'alpha.queue.common',
        },
      ],
      { workstreamId, hint: 'feature/tier-sync' },
    );

    process.env.MEMEX_HOME = rootA;
    const { exportForSync, getSyncDir } = await import('../src/sync-export.js');
    const exported = exportForSync();
    // Before this change the branch fact was filtered out of the payload
    // entirely while its tombstone would still have travelled.
    expect(exported.facts).toBe(2);

    const syncA = getSyncDir();
    const payloadPath = fs
      .readdirSync(path.join(syncA, 'devices'))
      .map((device) => path.join(syncA, 'devices', device))[0];
    const generation = (JSON.parse(fs.readFileSync(path.join(payloadPath, 'CURRENT'), 'utf-8')) as {
      generation: string;
    }).generation;
    const rows = fs
      .readFileSync(path.join(payloadPath, 'generations', generation, 'facts.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const branchRow = rows.find((row) => row.id === 'fact-branch')!;
    expect(branchRow.promotion_state).toBe('workstream');
    expect(branchRow.workstream_id).toBe(workstreamId);
    expect(branchRow.workstream_branch).toBe('feature/tier-sync');
    expect(branchRow.tier_reason).toBe('workspace-branch');
    // Device paths still never travel.
    expect(branchRow.scope_project).toBeNull();

    // Device B shares the folder; the same logical project already exists there.
    await seedRoot(rootB, []);
    fs.cpSync(path.join(syncA, 'devices'), path.join(rootB, 'conversation-index', 'sync', 'devices'), {
      recursive: true,
    });

    process.env.MEMEX_HOME = rootB;
    const { importFromSync } = await import('../src/sync-import.js');
    const imported = await importFromSync();
    expect(imported.malformedRows).toEqual([]);
    expect(imported.newFacts).toBe(2);

    const onB = await readFactRow(rootB, 'fact-branch');
    expect(onB?.promotion_state).toBe('workstream');
    expect(onB?.tier_reason).toBe('workspace-branch');
    // The workstream id is hash(project_id, branch), so device B resolves the
    // SAME id when it binds a session on that branch and the memory lands back
    // in its branch tier instead of leaking into project-common scope.
    expect(onB?.workstream_id).toBe(workstreamId);
    expect(onB?.workstream_id).toBe(deterministicWorkstreamId(PROJECT_ID, 'feature/tier-sync'));
    expect(onB?.workspace_id).toBeNull();

    const commonOnB = await readFactRow(rootB, 'fact-common');
    expect(commonOnB?.promotion_state).toBe('project-current');
    expect(commonOnB?.workstream_id).toBeNull();
  });

  it('a protocol-4 generation still imports; an unsupported version is reported', async () => {
    const root = tempRoot('memex-sync-tier-proto-');
    await seedRoot(root, []);
    craftCommittedGeneration(
      'legacy-peer',
      {
        'facts.jsonl': factRow({
          id: 'fact-legacy-peer',
          fact: 'exported before the tier keys existed',
          scope_type: 'project',
          scope_project: null,
          project_id: PROJECT_ID,
          portable_project_key: PORTABLE_KEY,
          subject_key: 'alpha.legacy.row',
          promotion_state: 'legacy-project',
        }) + '\n',
      },
      { protocolVersion: 4 },
    );
    craftCommittedGeneration(
      'future-peer',
      { 'facts.jsonl': factRow({ id: 'fact-future-peer', fact: 'from a newer protocol' }) + '\n' },
      { protocolVersion: 99 },
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1);
    expect((await readFactRow(root, 'fact-legacy-peer'))?.promotion_state).toBe('legacy-project');
    expect(await readFactRow(root, 'fact-future-peer')).toBeUndefined();
    expect(result.malformedRows.some((issue) => issue.error.includes('unsupported protocol_version 99'))).toBe(true);
  });
});
