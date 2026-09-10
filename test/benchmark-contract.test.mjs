import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateBenchmarkReport,
  isArchivedRecord,
  CURRENT_RECORD,
  REGENERATE_COMMAND,
} from '../scripts/benchmark-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRecord = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, 'docs/verification', name), 'utf8'));

/* -------------------------------------------------------------------------- */
/* A synthetic compliant report — the positive control                         */
/* -------------------------------------------------------------------------- */

/**
 * Built in code rather than copied from the committed record on purpose: the
 * negative cases below have to prove that ONE tampered field flips the verdict,
 * and that is only a proof if the baseline is known-good independently of
 * whatever the tree happens to hold.
 */
function compliantReport() {
  const pass = (...keys) => Object.fromEntries(keys.map((key) => [key, true]));
  return {
    verdict: 'PASS',
    environment: {
      platform: 'darwin arm64 (synthetic)',
      node: process.version,
      chrome: 'Google Chrome',
      recorded_at: '2026-09-10T00:00:00.000Z',
      isolation: '/tmp/mb-bench-synthetic',
      thresholds_predeclared: { AC_PERF_01_vector_p95_ms: 2000 },
      models: {
        llm_model: 'gpt-5.6-luna',
        llm_model_source: 'default',
        llm_reasoning: 'unset',
        llm_reasoning_source: 'default',
        embedding_model: 'Xenova/multilingual-e5-small',
        embedding_model_source: 'default',
        embedding_version: 3,
        embedding_dims: 384,
        embedding_source: 'resolved-config',
        embedding_generation: null,
        embedding_stub: false,
      },
      overlays: {
        recall_gate: 'absent',
        extraction_rules: 'absent',
        quarantine: 'absent',
        disabled_by_env: true,
      },
    },
    corpus: { rollouts: 200, exchanges: 800 },
    results: {
      AC_PERF_01_conversation_search: {
        raw_samples: { vector_ms: [1] },
        threshold_check: pass('vector_p95_pass'),
      },
      AC_PERF_02_fact_and_graph_search: {
        raw_samples: { fact_ms: [1] },
        threshold_check: pass('fact_p95_pass'),
      },
      AC_PERF_03_context_injection: {
        warm_transport: 'hook-process -> unix-socket -> MCP-sidecar',
        cold_transport: 'fresh-hook-process -> local fallback',
        raw_samples: { warm_ms: [1] },
        threshold_check: pass('warm_p95_pass'),
      },
      AC_PERF_04_incremental_sync: {
        memory_method: 'child-process resourceUsage.maxRSS',
        raw_samples: { sync_ms: [1] },
        threshold_check: pass('sync_p95_pass'),
      },
      AC_PERF_05_3d_graph: {
        api_transport: 'loopback HTTP /api/v2/graph',
        browser_transport: 'Google Chrome headless via CDP',
        raw_samples: { api_ms: [1] },
        threshold_check: pass('api_p95_pass'),
      },
      AC_PERF_06_full_history_analyze: {
        memory_method: 'child-process resourceUsage.maxRSS',
        raw_samples: { analyze_ms: [1] },
        threshold_check: pass('analyze_p95_pass'),
      },
    },
  };
}

/** `mutate` edits a deep clone, so each case starts from the same good report. */
function tampered(mutate) {
  const report = compliantReport();
  mutate(report);
  return validateBenchmarkReport(report);
}

const assertFails = (errors, fragment) => {
  assert.ok(errors.length > 0, `expected a contract failure mentioning ${fragment}`);
  assert.ok(
    errors.some((line) => line.includes(fragment)),
    `no error mentioned ${fragment}: ${JSON.stringify(errors)}`,
  );
};

test('a synthetic compliant report passes — the positive control', () => {
  assert.deepEqual(validateBenchmarkReport(compliantReport()), []);
});

/* -------------------------------------------------------------------------- */
/* environment.models — REQUIRED, every sub-field (models §13.1)               */
/* -------------------------------------------------------------------------- */

test('a missing environment.models block fails', () => {
  assertFails(
    tampered((report) => {
      delete report.environment.models;
    }),
    'environment.models is missing',
  );
  // An empty object is not "present": each sub-field is reported by name.
  const empty = tampered((report) => {
    report.environment.models = {};
  });
  assert.equal(empty.length, 10);
  assertFails(empty, 'environment.models.llm_model is missing');
  assertFails(empty, 'environment.models.embedding_dims is missing');
});

test('a single missing model sub-field fails and names that field', () => {
  for (const field of [
    'llm_model',
    'llm_model_source',
    'llm_reasoning',
    'llm_reasoning_source',
    'embedding_model',
    'embedding_model_source',
    'embedding_version',
    'embedding_dims',
    'embedding_source',
    'embedding_stub',
  ]) {
    const nulled = tampered((report) => {
      report.environment.models[field] = null;
    });
    assert.deepEqual(nulled, [`environment.models.${field} is missing`], `null ${field}`);
    const deleted = tampered((report) => {
      delete report.environment.models[field];
    });
    assert.deepEqual(deleted, [`environment.models.${field} is missing`], `deleted ${field}`);
  }
});

test('a non-default memory model or reasoning effort fails', () => {
  assertFails(
    tampered((report) => {
      report.environment.models.llm_model = 'gpt-5.6-codex';
    }),
    'non-default memory model (gpt-5.6-codex)',
  );
  assertFails(
    tampered((report) => {
      report.environment.models.llm_reasoning = 'high';
    }),
    'non-default reasoning effort (high)',
  );
});

test('a non-default embedding model, geometry, version or the stub fails', () => {
  assertFails(
    tampered((report) => {
      report.environment.models.embedding_model = 'Xenova/all-MiniLM-L6-v2';
    }),
    'non-default embedding model (Xenova/all-MiniLM-L6-v2)',
  );
  assertFails(
    tampered((report) => {
      report.environment.models.embedding_dims = 768;
    }),
    'vector geometry is not the default (768)',
  );
  assertFails(
    tampered((report) => {
      report.environment.models.embedding_version = 1;
    }),
    'vector space is not the default version (1)',
  );
  // AC_PERF_01/02 would be measuring a hash function, not a model.
  assertFails(
    tampered((report) => {
      report.environment.models.embedding_stub = true;
    }),
    'deterministic embedding stub',
  );
});

test('a tampered provenance string fails — a source must be a real source', () => {
  assertFails(
    tampered((report) => {
      report.environment.models.llm_model_source = 'default (trust me)';
    }),
    'llm_model_source is not a known source',
  );
  assertFails(
    tampered((report) => {
      report.environment.models.llm_reasoning_source = 'unset';
    }),
    'llm_reasoning_source is not a known source',
  );
  assertFails(
    tampered((report) => {
      report.environment.models.embedding_model_source = 'file';
    }),
    'embedding_model_source is not a known source',
  );
  assertFails(
    tampered((report) => {
      report.environment.models.embedding_source = 'assumed';
    }),
    'embedding_source is not a known source',
  );
  // 0.7.1 moves authority to the `embedding_identity` row; that value is allowed.
  assert.deepEqual(
    tampered((report) => {
      report.environment.models.embedding_source = 'embedding_identity';
    }),
    [],
  );
});

/* -------------------------------------------------------------------------- */
/* environment.overlays — REQUIRED, every sub-field (overlays §6)              */
/* -------------------------------------------------------------------------- */

test('a missing environment.overlays block fails', () => {
  assertFails(
    tampered((report) => {
      delete report.environment.overlays;
    }),
    'environment.overlays is missing',
  );
  const empty = tampered((report) => {
    report.environment.overlays = {};
  });
  assert.equal(empty.length, 4);
  assertFails(empty, 'environment.overlays.disabled_by_env is missing');
});

test('a single missing overlay sub-field fails and names that field', () => {
  for (const field of ['recall_gate', 'extraction_rules', 'quarantine', 'disabled_by_env']) {
    assert.deepEqual(
      tampered((report) => {
        delete report.environment.overlays[field];
      }),
      [`environment.overlays.${field} is missing`],
      field,
    );
  }
});

test('a present overlay fails — the benchmark must run with empty overlays', () => {
  assertFails(
    tampered((report) => {
      report.environment.overlays.recall_gate = 'present';
    }),
    'overlays/recall-gate.json is present',
  );
  assertFails(
    tampered((report) => {
      report.environment.overlays.extraction_rules = 'present';
    }),
    'overlays/extraction-rules.json is present',
  );
  assertFails(
    tampered((report) => {
      report.environment.overlays.quarantine = 'present';
    }),
    'overlays/quarantine.json is present',
  );
});

test('claiming overlays were off without the env var — or with a tampered observation — fails', () => {
  assertFails(
    tampered((report) => {
      report.environment.overlays.disabled_by_env = false;
    }),
    'MEMEX_DISABLE_OVERLAYS=1',
  );
  // `absent` and `present` are the only observations; anything else is a claim.
  assertFails(
    tampered((report) => {
      report.environment.overlays.extraction_rules = 'empty';
    }),
    'environment.overlays.extraction_rules is not an observation (empty)',
  );
  assertFails(
    tampered((report) => {
      report.environment.overlays.recall_gate = true;
    }),
    'environment.overlays.recall_gate is not an observation (true)',
  );
});

/* -------------------------------------------------------------------------- */
/* Records in the tree                                                         */
/* -------------------------------------------------------------------------- */

test('the archived pre-0.7.0 record is historical evidence, never a current record', () => {
  assert.ok(isArchivedRecord('docs/verification/benchmark-pre-0.7.0.json'));
  assert.ok(!isArchivedRecord(CURRENT_RECORD));
  const archived = readRecord('benchmark-pre-0.7.0.json');
  const errors = validateBenchmarkReport(archived);
  // It was true of the build that produced it and is kept unedited, but it
  // predates both identity blocks, so it must never satisfy today's contract.
  assertFails(errors, 'environment.models is missing');
  assertFails(errors, 'environment.overlays is missing');
});

test(`the published record at ${CURRENT_RECORD} satisfies the contract`, () => {
  const errors = validateBenchmarkReport(readRecord('benchmark.json'));
  assert.deepEqual(
    errors,
    [],
    `${CURRENT_RECORD} does not satisfy the 0.7.0 contract. Do not edit it by ` +
      `hand (AGENTS.md:146) and do not loosen the contract — re-run ` +
      `\`${REGENERATE_COMMAND}\`. Failures: ${JSON.stringify(errors, null, 2)}`,
  );
});
