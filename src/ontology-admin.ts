/**
 * Operator-facing taxonomy repair (issue #47).
 *
 * The ontology used to be strictly APPEND-ONLY: across `src` and `scripts`
 * there was not one `UPDATE ontology_categories SET name`, no merge, and the
 * only `DELETE FROM ontology_categories` was the full privacy purge. Once
 * near-duplicate categories appeared (`Auth` / `Authentication` / `AuthN`) the
 * only remedy was wiping the whole taxonomy — and the sprawl is not
 * hypothetical: this classifier once grew to 1,612 categories (~95K tokens).
 *
 * Both operations are LOCAL-DERIVED edits:
 *  - no Chronicle event: fact MEANING does not change, only the overlay it is
 *    filed under, and Chronicle is the meaning ledger;
 *  - no semantic/lifecycle generation bump, no attempt-ledger reset, no
 *    taxonomy-epoch bump: nothing in flight becomes stale, because no fact's
 *    meaning and no candidate's identity was invalidated;
 *  - one metadata-only line in logs/ui-audit.jsonl, matching the shape the
 *    fact tier ladder and job recovery already write.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getMemexHome } from './paths.js';
import { deleteCategoryEmbedding, getCategory } from './ontology-db.js';

export interface CategoryMergePlan {
  dryRun: boolean;
  fromCategoryId: string;
  fromName: string;
  toCategoryId: string;
  toName: string;
  /** True when the two categories live under different domains. */
  crossDomain: boolean;
  /** Active + inactive facts re-pointed (or that would be). */
  factsMoved: number;
}

export interface CategoryRenameResult {
  categoryId: string;
  previousName: string;
  name: string;
  /** Renaming changes the embedded "name: description" text, so the vector is
   * invalidated and healCategoryIndex / the re-embed worker rebuild it. */
  embeddingInvalidated: boolean;
}

/** Metadata-only audit line; never fact text, category description or prompts. */
function appendOntologyAudit(action: string, detail: Record<string, unknown>): void {
  try {
    const dir = path.join(getMemexHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'ui-audit.jsonl');
    const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
    if (stat?.isSymbolicLink()) return;
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        source: 'memex-core',
        action,
        status: 'ok',
        operation: null,
        error_code: null,
        ...detail,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* auditing is best-effort and never blocks the repair */
  }
}

/**
 * Fold `fromCategoryId` into `toCategoryId`: every fact filed under the source
 * moves to the target, the source row and its vector are removed.
 *
 * `deleteCategoryEmbedding` finally gets a caller here — it has been exported
 * dead code documenting a delete path that was never implemented.
 */
export function mergeCategories(
  db: Database.Database,
  input: { fromCategoryId: string; toCategoryId: string; dryRun?: boolean },
): CategoryMergePlan {
  const dryRun = input.dryRun ?? false;
  const from = getCategory(db, input.fromCategoryId);
  if (!from) throw new Error(`ontology category not found: ${input.fromCategoryId}`);
  const to = getCategory(db, input.toCategoryId);
  if (!to) throw new Error(`ontology category not found: ${input.toCategoryId}`);
  if (from.id === to.id) throw new Error('merge source and target are the same category');

  const plan: CategoryMergePlan = {
    dryRun,
    fromCategoryId: from.id,
    fromName: from.name,
    toCategoryId: to.id,
    toName: to.name,
    crossDomain: from.domain_id !== to.domain_id,
    factsMoved: Number(
      (db.prepare('SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ?').get(from.id) as { n: number }).n,
    ),
  };
  if (dryRun) return plan;

  // IMMEDIATE: the count above and the moves below must not interleave with a
  // classifier writing new assignments into the disappearing category.
  const apply = db.transaction(() => {
    const moved = db
      .prepare('UPDATE facts SET ontology_category_id = ? WHERE ontology_category_id = ?')
      .run(to.id, from.id);
    db.prepare('DELETE FROM ontology_categories WHERE id = ?').run(from.id);
    return moved.changes;
  });
  plan.factsMoved = apply.immediate();
  // Outside the transaction: the vec row is derived index state, and
  // healCategoryIndex purges an orphan row on the next classification anyway.
  deleteCategoryEmbedding(db, from.id);

  appendOntologyAudit('ontology-merge', {
    id: from.id,
    target_id: to.id,
    facts_moved: plan.factsMoved,
    cross_domain: plan.crossDomain,
  });
  return plan;
}

/**
 * Rename one category in place. Facts keep their assignment (this is a label
 * change, not a re-classification); only the derived vector is invalidated,
 * because the embedded text is "name: description".
 */
export function renameCategory(
  db: Database.Database,
  input: { categoryId: string; name: string },
): CategoryRenameResult {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (name === '' || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('category name must be a non-empty single line');
  }
  if (name.length > 60) throw new Error('category name must be at most 60 characters');
  const category = getCategory(db, input.categoryId);
  if (!category) throw new Error(`ontology category not found: ${input.categoryId}`);

  const rename = db.transaction(() => {
    const clash = db
      .prepare(
        `SELECT id FROM ontology_categories
         WHERE domain_id = ? AND name = ? COLLATE NOCASE AND id <> ?`,
      )
      .get(category.domain_id, name, category.id) as { id: string } | undefined;
    if (clash) {
      throw new Error(
        `category "${name}" already exists in this domain (${clash.id}) — merge instead: memex ontology merge ${category.id} ${clash.id}`,
      );
    }
    db.prepare('UPDATE ontology_categories SET name = ?, embedding_version = 0 WHERE id = ?')
      .run(name, category.id);
  });
  rename.immediate();
  // Drop the stale vector so the next classification's bounded self-heal (or
  // `memex backfill embeddings`) re-embeds the new label instead of matching
  // candidates against the old one.
  deleteCategoryEmbedding(db, category.id);

  appendOntologyAudit('ontology-rename', { id: category.id, domain_id: category.domain_id });
  return {
    categoryId: category.id,
    previousName: category.name,
    name,
    embeddingInvalidated: true,
  };
}
