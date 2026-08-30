#!/usr/bin/env node
/**
 * Batch translate facts to Korean and store in fact_kr column.
 * Uses the local codex CLI (CodexExec) — no API key involved.
 * Run: node scripts/translate-facts.mjs
 */
import { runCodex } from "../dist/codex-exec.js";
import { openWriteDb } from "../dist/db.js";

const db = openWriteDb();

// Get untranslated facts. semantic_generation is captured with the text so the
// write below is a CAS: a translation that lands after the fact changed
// meaning must not be recorded against the NEW meaning (재감사 P2 v4).
const untranslated = db
  .prepare(
    "SELECT id, fact, semantic_generation FROM facts WHERE is_active = 1 AND (fact_kr IS NULL OR fact_kr = '') ORDER BY consolidated_count DESC",
  )
  .all();

console.log(`Found ${untranslated.length} untranslated facts`);

if (untranslated.length === 0) {
  console.log("All facts already translated");
  db.close();
  process.exit(0);
}

// Batch translate (chunks of 20), processed with a concurrency pool for speed.
const BATCH = 20;
// Clamp to a sane positive range: 0/NaN/negative would create no workers (silent no-op),
// and an unbounded value would launch too many concurrent query() calls (rate-limit/SDK risk).
const CONCURRENCY = Math.min(
  Math.max(
    Number.parseInt(process.env.TRANSLATE_CONCURRENCY || "5", 10) || 5,
    1,
  ),
  20,
);
// CAS write (재감사 P2 v4): the row must still carry the semantic generation
// AND the exact text that was sent to the translator — otherwise the fact was
// edited during the LLM await and the stale translation is discarded (the
// next run re-translates the new meaning; the KR vector gap heal is unaffected
// because fact_kr stays NULL).
const updateStmt = db.prepare(
  "UPDATE facts SET fact_kr = ? WHERE id = ? AND semantic_generation = ? AND fact = ?",
);

const batches = [];
for (let i = 0; i < untranslated.length; i += BATCH)
  batches.push(untranslated.slice(i, i + BATCH));
const total = batches.length;
let nextIdx = 0;
let done = 0;

async function translateBatch(batch, idx) {
  const texts = batch.map((f) => f.fact);
  const prompt = `Translate the following English texts to natural Korean. Keep technical terms (API names, tool names, framework names, file paths, CLI commands, variable names) in English. Return ONLY a JSON array of translated strings, same order, same count. No markdown wrapper.

Texts:
${JSON.stringify(texts)}`;

  // One-shot CodexExec call: ephemeral, config-isolated, read-only sandbox —
  // no cascade and nothing persisted for the child session.
  const result = await runCodex({ userMessage: prompt });
  const match = result.match(/\[[\s\S]*\]/);
  if (match) {
    // Model output is untrusted input: malformed JSON must not crash the
    // whole batch worker — report the batch as failed so it can be re-run.
    let translated;
    try {
      translated = JSON.parse(match[0]);
    } catch (e) {
      console.error(`Batch ${idx + 1}: invalid JSON in result (${e.message})`);
      return;
    }
    if (!Array.isArray(translated)) {
      console.error(`Batch ${idx + 1}: result is not a JSON array`);
      return;
    }
    let staleCount = 0;
    const tx = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        if (!translated[j]) continue;
        const src = batch[j];
        const changed = updateStmt.run(translated[j], src.id, src.semantic_generation, src.fact);
        if (changed.changes === 0) staleCount++;
      }
    });
    tx();
    if (staleCount > 0) {
      console.error(
        `Batch ${idx + 1}: ${staleCount} translation(s) discarded (fact changed during translation) — re-run to translate the new meaning`,
      );
    }
    console.log(
      `Translated batch ${idx + 1}/${total} (${batch.length} facts) [done ${++done}/${total}]`,
    );
  } else {
    console.error(`Batch ${idx + 1}: no JSON array in result`);
  }
}

async function poolWorker() {
  while (true) {
    const idx = nextIdx++;
    if (idx >= total) return;
    try {
      await translateBatch(batches[idx], idx);
    } catch (e) {
      console.error(`Batch ${idx + 1} failed:`, e.message);
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, total) }, () => poolWorker()),
);

const remaining = db
  .prepare(
    "SELECT COUNT(*) as cnt FROM facts WHERE is_active = 1 AND (fact_kr IS NULL OR fact_kr = '')",
  )
  .get();
console.log(`Done. Remaining untranslated: ${remaining.cnt}`);
db.close();
