const REQUIRED_CHECKS = [
  'AC_PERF_01_conversation_search',
  'AC_PERF_02_fact_and_graph_search',
  'AC_PERF_03_context_injection',
  'AC_PERF_04_incremental_sync',
  'AC_PERF_05_3d_graph',
  'AC_PERF_06_full_history_analyze',
];

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
  if (graph.api_transport !== 'loopback HTTP /api/graph-data') {
    errors.push('AC_PERF_05 API was not measured through loopback HTTP');
  }
  if (graph.browser_transport !== 'Google Chrome headless via CDP') {
    errors.push('AC_PERF_05 first-interactive was not measured in a real browser');
  }

  const analyze = results.AC_PERF_06_full_history_analyze ?? {};
  if (analyze.memory_method !== 'child-process resourceUsage.maxRSS') {
    errors.push('AC_PERF_06 memory is not isolated child maxRSS');
  }
  return errors;
}
