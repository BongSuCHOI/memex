import type Database from 'better-sqlite3';
import { recordLocalMeaningEvidence } from '../src/fact-policy.js';

/** Accepted global input fixtures for mutation/rollback tests. Scope-isolation
 * and evidence acceptance have dedicated tests; no production guard is mocked. */
export function prepareVerifiedGlobalPair(db: Database.Database, ...ids: string[]): void {
  for (const [index, id] of ids.entries()) {
    db.prepare(`UPDATE facts SET scope_type = 'global', scope_project = NULL, project_id = NULL,
      workspace_id = NULL, workstream_id = NULL, subject_key = 'state.fixture.setting' WHERE id = ?`).run(id);
    const row = db.prepare('SELECT fact, source_exchange_ids FROM facts WHERE id = ?').get(id) as { fact: string; source_exchange_ids: string };
    const sources = JSON.parse(row.source_exchange_ids ?? '[]') as string[];
    for (const source of sources) db.prepare(`INSERT OR IGNORE INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
      VALUES (?, '/fixture', ?, ?, '', '/fixture/source.jsonl', 1, 2)`)
      .run(source, `2026-01-0${index + 1}T00:00:00.000Z`, row.fact);
  }
  // Capture receipts only after every source fixture exists.
  for (const id of ids) {
    const row = db.prepare('SELECT fact, source_exchange_ids FROM facts WHERE id = ?').get(id) as { fact: string; source_exchange_ids: string };
    recordLocalMeaningEvidence(db, id, row.fact, 'user', JSON.parse(row.source_exchange_ids ?? '[]'));
  }
}
