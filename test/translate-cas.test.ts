// 재감사 P2 v4: scripts/translate-facts.mjs의 translation CAS 계약. 스크립트는
// 실제 Codex CLI를 호출하므로 이 테스트는 스크립트와 동일한 SQL 문장으로
// read → semantic edit → stale write 경합을 검증한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

import { initDatabase } from '../src/db.js';

// translate-facts.mjs와 동일한 CAS 문장 — 스크립트가 이 형태를 유지하는 한
// 경합 의미론이 함께 검증된다.
const TRANSLATE_CAS =
  'UPDATE facts SET fact_kr = ? WHERE id = ? AND semantic_generation = ? AND fact = ?';
// translate-facts.mjs와 동일한 읽기 문장.
const READ_FOR_TRANSLATE =
  "SELECT id, fact, semantic_generation FROM facts WHERE is_active = 1 AND (fact_kr IS NULL OR fact_kr = '') ORDER BY consolidated_count DESC";

describe('translation CAS contract (P2 v4)', () => {
  let db: ReturnType<typeof initDatabase>;
  let tmpDir: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-translate-'));
    process.env.TEST_DB_PATH = path.join(tmpDir, 'test.db');
    db = initDatabase();
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    restoreConsole();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records a translation when the meaning is unchanged since the read', async () => {
    const { insertFact } = await import('../src/fact-db.js');
    const id = insertFact(db, {
      fact: 'Metrics are exported once per minute', category: 'decision', scope_type: 'global',
      scope_project: null, source_exchange_ids: [], embedding: new Array(384).fill(0.05),
    });

    const snapshot = db.prepare(READ_FOR_TRANSLATE).get() as { id: string; fact: string; semantic_generation: number };
    const changed = db.prepare(TRANSLATE_CAS).run('메트릭은 1분마다 내보낸다', snapshot.id, snapshot.semantic_generation, snapshot.fact);

    expect(changed.changes).toBe(1);
    const row = db.prepare('SELECT fact_kr FROM facts WHERE id = ?').get(id) as { fact_kr: string | null };
    expect(row.fact_kr).toBe('메트릭은 1분마다 내보낸다');
  });

  it('discards a translation whose fact changed meaning during the LLM await', async () => {
    const { insertFact } = await import('../src/fact-db.js');
    const { mutateFactMeaning } = await import('../src/fact-management.js');
    const id = insertFact(db, {
      fact: 'Old meaning text', category: 'decision', scope_type: 'global',
      scope_project: null, source_exchange_ids: [], embedding: new Array(384).fill(0.05),
    });

    // Snapshot taken before the translation LLM call.
    const snapshot = db.prepare(READ_FOR_TRANSLATE).get() as { id: string; fact: string; semantic_generation: number };

    // A semantic edit lands mid-await: generation bumps, fact_kr resets to NULL.
    await mutateFactMeaning(db, { factId: id, newText: 'New meaning text' });

    // The stale translation arrives — the CAS must reject it, otherwise the
    // NEW meaning would carry the OLD text's Korean translation and the
    // reembed worker would vectorize it as if it were current.
    const changed = db.prepare(TRANSLATE_CAS).run('옛 의미의 번역', snapshot.id, snapshot.semantic_generation, snapshot.fact);
    expect(changed.changes).toBe(0);

    const row = db.prepare('SELECT fact, fact_kr FROM facts WHERE id = ?').get(id) as { fact: string; fact_kr: string | null };
    expect(row.fact).toBe('New meaning text');
    expect(row.fact_kr).toBeNull();
  });
});
