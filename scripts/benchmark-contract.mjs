// Pure validator for the performance receipt. It deliberately has no
// dependencies and never imports `dist/` — the thing that judges a receipt must
// not be able to drift with the runtime that produced it.
//
// Loopback graph-API surface that counts as direct HTTP evidence. The Memex
// Workspace UI serves /api/v2/graph.
const GRAPH_API_TRANSPORTS = new Set(['loopback HTTP /api/v2/graph']);

const REQUIRED_CHECKS = [
  'AC_PERF_01_conversation_search',
  'AC_PERF_02_fact_and_graph_search',
  'AC_PERF_03_context_injection',
  'AC_PERF_04_incremental_sync',
  'AC_PERF_05_3d_graph',
  'AC_PERF_06_full_history_analyze',
];

/* -------------------------------------------------------------------------- */
/* Model identity and overlays — 0.7.0 (models §13.1, overlays §6)             */
/* -------------------------------------------------------------------------- */

/**
 * The numbers in this receipt only mean something for the SHIPPED defaults.
 * A run on another memory model, another reasoning effort, another embedding
 * model, another vector geometry, or with a user overlay loaded is a different
 * system, and the receipt has to say which one it measured.
 *
 * Literals rather than imports from `dist/`: `DEFAULT_LLM_MODEL`
 * (src/model-settings.ts) and `DEFAULT_EMBEDDING_MODEL` (src/model-cache.ts)
 * changing is exactly the event this gate must notice, so changing them has to
 * mean re-running the benchmark rather than silently re-baselining the judge.
 */
const REQUIRED_LLM_MODEL = 'gpt-5.6-luna';
const REQUIRED_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';
const REQUIRED_EMBEDDING_DIMS = 384;
const REQUIRED_EMBEDDING_VERSION = 3;

/** `SettingSource` in src/model-settings.ts. */
const SETTING_SOURCES = new Set(['env', 'file', 'default', 'explicit']);
/** 0.7.0 resolves the embedding model from config; 0.7.1 from `embedding_identity`. */
const EMBEDDING_SOURCES = new Set(['resolved-config', 'embedding_identity']);
const OVERLAY_PRESENCE = new Set(['present', 'absent']);

/**
 * Every field is REQUIRED. A missing block and a missing sub-field are both
 * contract failures — "check it only when it is there" would let anyone pass by
 * deleting the identifier they did not like (2nd review 16).
 */
const REQUIRED_MODEL_FIELDS = [
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
];

const REQUIRED_OVERLAY_FIELDS = [
  'recall_gate',
  'extraction_rules',
  'quarantine',
  'disabled_by_env',
];

const REGENERATE = 'node scripts/benchmark.mjs';

function validateModelIdentity(report, errors) {
  const models = report.environment?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    errors.push(
      `environment.models is missing — this record predates the 0.7.0 model-identity contract; re-run \`${REGENERATE}\` on this build`,
    );
    return;
  }
  let complete = true;
  for (const field of REQUIRED_MODEL_FIELDS) {
    if (models[field] === undefined || models[field] === null) {
      errors.push(`environment.models.${field} is missing`);
      complete = false;
    }
  }
  if (!complete) return;

  if (models.llm_model !== REQUIRED_LLM_MODEL) {
    errors.push(`benchmark ran on a non-default memory model (${models.llm_model})`);
  }
  if (models.llm_reasoning !== 'unset') {
    errors.push(`benchmark ran at a non-default reasoning effort (${models.llm_reasoning})`);
  }
  if (!SETTING_SOURCES.has(models.llm_model_source)) {
    errors.push(`environment.models.llm_model_source is not a known source (${models.llm_model_source})`);
  }
  if (!SETTING_SOURCES.has(models.llm_reasoning_source)) {
    errors.push(
      `environment.models.llm_reasoning_source is not a known source (${models.llm_reasoning_source})`,
    );
  }
  if (models.embedding_model !== REQUIRED_EMBEDDING_MODEL) {
    errors.push(`benchmark ran on a non-default embedding model (${models.embedding_model})`);
  }
  if (models.embedding_model_source !== 'env' && models.embedding_model_source !== 'default') {
    errors.push(
      `environment.models.embedding_model_source is not a known source (${models.embedding_model_source})`,
    );
  }
  if (models.embedding_dims !== REQUIRED_EMBEDDING_DIMS) {
    errors.push(`benchmark vector geometry is not the default (${models.embedding_dims})`);
  }
  if (models.embedding_version !== REQUIRED_EMBEDDING_VERSION) {
    errors.push(`benchmark vector space is not the default version (${models.embedding_version})`);
  }
  if (!EMBEDDING_SOURCES.has(models.embedding_source)) {
    errors.push(`environment.models.embedding_source is not a known source (${models.embedding_source})`);
  }
  // The deterministic stub would make AC_PERF_01/02 measure a hash, not a model.
  if (models.embedding_stub !== false) {
    errors.push('benchmark ran on the deterministic embedding stub, not the real model');
  }
}

function validateOverlays(report, errors) {
  const overlays = report.environment?.overlays;
  if (!overlays || typeof overlays !== 'object' || Array.isArray(overlays)) {
    errors.push(
      `environment.overlays is missing — this record predates the 0.7.0 overlay contract; re-run \`${REGENERATE}\` on this build`,
    );
    return;
  }
  let complete = true;
  for (const field of REQUIRED_OVERLAY_FIELDS) {
    if (overlays[field] === undefined || overlays[field] === null) {
      errors.push(`environment.overlays.${field} is missing`);
      complete = false;
    }
  }
  if (!complete) return;

  // AC_PERF_03 is decided by the recall gate and the matcher worker, so a user
  // overlay in the benchmark root would silently change what is being measured.
  for (const field of ['recall_gate', 'extraction_rules', 'quarantine']) {
    if (!OVERLAY_PRESENCE.has(overlays[field])) {
      errors.push(`environment.overlays.${field} is not an observation (${overlays[field]})`);
    } else if (overlays[field] !== 'absent') {
      errors.push(`benchmark ran with a user overlay loaded (overlays/${field.replace(/_/g, '-')}.json is present)`);
    }
  }
  if (overlays.disabled_by_env !== true) {
    errors.push('benchmark did not run with MEMEX_DISABLE_OVERLAYS=1');
  }
}

export function validateBenchmarkReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object') return ['report must be an object'];
  if (report.verdict !== 'PASS') errors.push('verdict must be PASS');
  if ((report.corpus?.rollouts ?? 0) < 200) errors.push('corpus must contain at least 200 rollouts');
  if ((report.corpus?.exchanges ?? 0) < 800) errors.push('corpus must contain at least 800 exchanges');

  const results = report.results ?? {};
  for (const name of REQUIRED_CHECKS) {
    const entry = results[name];
    if (!entry) {
      errors.push(`missing ${name}`);
      continue;
    }
    const checks = entry.threshold_check;
    if (!checks || !Object.keys(checks).length) errors.push(`${name} has no threshold_check`);
    else for (const [key, value] of Object.entries(checks)) {
      if (value !== true) errors.push(`${name}.${key} is not true`);
    }
    if (!Array.isArray(entry.raw_samples) && typeof entry.raw_samples !== 'object') {
      errors.push(`${name} has no raw_samples`);
    }
  }

  const inject = results.AC_PERF_03_context_injection ?? {};
  if (inject.warm_transport !== 'hook-process -> unix-socket -> MCP-sidecar') {
    errors.push('AC_PERF_03 warm path is not the real hook/daemon transport');
  }
  if (inject.cold_transport !== 'fresh-hook-process -> local fallback') {
    errors.push('AC_PERF_03 cold path is not a fresh fallback process');
  }

  const sync = results.AC_PERF_04_incremental_sync ?? {};
  if (sync.memory_method !== 'child-process resourceUsage.maxRSS') {
    errors.push('AC_PERF_04 memory is not isolated child maxRSS');
  }

  const graph = results.AC_PERF_05_3d_graph ?? {};
  if (!GRAPH_API_TRANSPORTS.has(graph.api_transport)) {
    errors.push('AC_PERF_05 API was not measured through loopback HTTP');
  }
  if (graph.browser_transport !== 'Google Chrome headless via CDP') {
    errors.push('AC_PERF_05 first-interactive was not measured in a real browser');
  }

  const analyze = results.AC_PERF_06_full_history_analyze ?? {};
  if (analyze.memory_method !== 'child-process resourceUsage.maxRSS') {
    errors.push('AC_PERF_06 memory is not isolated child maxRSS');
  }

  validateModelIdentity(report, errors);
  validateOverlays(report, errors);
  return errors;
}

/**
 * `docs/verification/benchmark-pre-*.json` are HISTORICAL evidence: they were
 * true of the build that produced them and stay in the tree unedited
 * (AGENTS.md:146), but they are not current records and are never validated as
 * one. `package.json`'s `files` already excludes them from the tarball.
 */
export function isArchivedRecord(file) {
  return /(^|[/\\])benchmark-pre-[^/\\]*\.json$/.test(file);
}

export const CURRENT_RECORD = 'docs/verification/benchmark.json';
export const REGENERATE_COMMAND = REGENERATE;

/* -------------------------------------------------------------------------- */
/* CLI — the `benchmark-contract` merge gate                                   */
/* -------------------------------------------------------------------------- */

/**
 * `node scripts/benchmark-contract.mjs [<record>]`
 *
 * Before 0.7.0 this module exported the validator and nothing ran it, so the
 * gate's own command exited 0 without reading a byte. It now judges the
 * committed record and exits non-zero with the failing FIELD names, so the
 * receipt line means what it says.
 */
async function main(argv) {
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const relative = argv[0] ?? CURRENT_RECORD;
  const file = path.resolve(root, relative);

  if (isArchivedRecord(file)) {
    process.stderr.write(
      `${relative} is an archived pre-0.7.0 record — historical evidence, not a current one.\n` +
        `The gate judges ${CURRENT_RECORD}; regenerate it with \`${REGENERATE}\`.\n`,
    );
    return 2;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`cannot read ${relative}: ${error.message}\n`);
    return 1;
  }
  const errors = validateBenchmarkReport(report);
  if (!errors.length) {
    process.stdout.write(`benchmark contract satisfied: ${relative}\n`);
    return 0;
  }
  process.stderr.write(
    `benchmark contract FAILED for ${relative} (${errors.length} error(s)):\n` +
      errors.map((line) => `  - ${line}\n`).join('') +
      `Do not edit the record by hand — re-run \`${REGENERATE}\`.\n`,
  );
  return 1;
}

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
