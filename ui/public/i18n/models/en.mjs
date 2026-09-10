// models — 관리 › 모델 탭과 `/api/v2/models`의 오류 (#31, 0.7.0 lane E · 설계 §12.5).
//
// 이 사전이 소유하는 접두사는 `models.` 하나다. 탭 레이블(`settings.tabs.models`)은 lane-0의
// `settings` 사전에 있고, 보류 사유 배지(`common.job.hold.*`)와 오류 봉투 렌더는 lane-0의
// `common`/`errors` 사전에 있다 — 여기서 다시 선언하지 않는다.
export default {
  // ── 화면 상태 ─────────────────────────────────────────────────────────────
  'models.missingCore': 'The installed core has no <code>dist/model-settings.js</code>. Build the core and restart the server to choose a model here.',
  'models.statusUnavailable': 'The model settings could not be read.',
  'models.envPinned': 'Pinned by the environment',
  'models.envPinned.detail': '{name}={value} is set for this server and wins over the settings file.',
  'models.saveDisabledByEnv': 'Both values come from the environment, so there is nothing this screen can save. Change them where the environment is set — a shell profile, a launch agent, or the hook that started Memex.',

  // ── 값의 출처 ─────────────────────────────────────────────────────────────
  'models.source.env': 'environment',
  'models.source.file': 'models.json',
  'models.source.explicit': 'call option',
  'models.source.default': 'built-in default',

  // ── LLM 카드 ──────────────────────────────────────────────────────────────
  'models.llm.title': 'The model that makes memories (LLM)',
  'models.llm.intro': 'The selection is <strong>local to this machine</strong>: <code>models.json</code> is never synced, because the set of usable models differs per device.',
  'models.llm.row.model': 'Model',
  'models.llm.row.modelBody': 'Every memory-making call — extraction, consolidation, capsules, classification — goes through this model.',
  'models.llm.row.reasoning': 'Reasoning effort',
  'models.llm.row.reasoningBody': 'Passed as -c model_reasoning_effort. The list is what this Codex installation says the model accepts.',
  'models.llm.custom.label': 'Or type a model id',
  'models.llm.custom.hint': 'Wins over the list above. The catalog can be stale, and only a real call can prove an id.',
  'models.llm.save': 'Save',
  'models.llm.test': 'Test this model once',
  'models.llm.reset': 'Reset to defaults',
  'models.llm.latencyWarning': 'A higher effort raises per-call latency. If extraction starts hitting the run deadline, raise <code>MEMEX_MODEL_BUDGET_DEADLINE_MS</code> rather than lowering the model.',
  'models.llm.workersNote': 'Background workers pick this up from their next session; a running MCP server from its next model call.',

  // ── 사실 표 ───────────────────────────────────────────────────────────────
  'models.row.effectiveModel': 'In effect now',
  'models.row.effectiveReasoning': 'Reasoning in effect',
  'models.row.default': 'Built-in default',
  'models.row.defaultNoReasoning': 'no reasoning flag',
  'models.row.saved': 'Saved in models.json',
  'models.row.savedUnset': 'not set',
  'models.row.savedNone': 'Nothing saved — the built-in default applies.',
  'models.row.catalog': 'Catalog',
  'models.row.levels': 'Accepted levels',
  'models.row.lastTest': 'Last test call',
  'models.row.settingsFile': 'Settings file',
  'models.row.fileMissing': 'not written yet',
  'models.row.updatedAt': 'Saved at',

  // ── 카탈로그 ──────────────────────────────────────────────────────────────
  'models.catalog.none': 'This Codex installation publishes no model catalog ({home}). Any id is accepted here and verified by the first call.',
  'models.catalog.found': '{n} model(s) · {path}',
  'models.catalog.fetched': 'fetched {at}',
  'models.catalog.levels': '{model} accepts {levels}',
  'models.catalog.levelsUnknown': 'This installation says nothing about {model}.',

  // ── 추론 강도 ─────────────────────────────────────────────────────────────
  'models.reasoning.none': 'no flag',
  'models.reasoning.unsetOption': 'Do not send the flag',

  // ── 설정 오류 보류 ────────────────────────────────────────────────────────
  'models.hold.title': 'Model work is paused: the provider refused this configuration.',
  'models.hold.selection': '{model} / {reasoning} · {status} {type} · seen {n} time(s)',
  'models.hold.noDamage': 'No job was failed and no attempt was consumed. Fix the selection below and the work resumes on its own.',
  'models.hold.others': '{n} more hold(s) belong to other selections on this machine and do not block this one.',
  'models.held.title': 'Jobs waiting on a configuration',
  'models.held.body': 'These jobs are parked, not failed: their attempts were refunded and they resume as soon as the configuration they are waiting on is valid.',
  'models.held.col.reason': 'Waiting on',
  'models.held.col.jobs': 'Jobs',
  'models.held.col.oldest': 'Since',

  // ── 1회 테스트 ────────────────────────────────────────────────────────────
  'models.probe.never': 'never run',
  'models.probe.ok': 'ok',
  'models.probe.failed': 'failed ({reason})',
  'models.probe.detail': '{ms} · {at}',
  'models.probe.confirm.title': 'Test this model once',
  'models.probe.confirm.body': 'This makes one real call to the provider and records one attempt in the model-work ledger. A success also clears the configuration hold and releases the jobs waiting on it.',
  'models.probe.running': 'Calling the model once…',
  'models.probe.okToast': '{model} answered in {ms}.',
  'models.probe.failedToast': 'The call did not succeed: {message}',

  // ── 저장·초기화 ───────────────────────────────────────────────────────────
  'models.toast.saved': 'Saved. Memex now calls {model} / {reasoning}.',
  'models.toast.reset': 'Deleted models.json. The selection is back to {model}.',
  'models.reset.title': 'Reset the model selection',
  'models.reset.body': 'This deletes models.json, and every LLM value returns to the built-in default. The effective embedding model is not affected — the database owns it, and deleting a settings file can never delete a vector.',

  // ── 경고(서버 코드 → 문장) ────────────────────────────────────────────────
  'models.warning.modelNotInCatalog': '{model} is not in this installation\'s catalog ({path}) — saved anyway, because the catalog can be stale and only a real call can prove an id.',
  'models.warning.catalogUnavailable': 'This Codex installation publishes no model catalog ({home}) — the id is verified by the first call.',
  'models.warning.modelHidden': '{model} is a hidden catalog entry: selectable, just not listed.',
  'models.warning.reasoningUnsupported': 'The catalog says {model} accepts {levels}. Saved anyway — run the one-call test to find out what the provider actually says.',
  'models.warning.envOverridesModel': '{name}={value} is set and wins: models.json now holds {model}, but this server calls {value}.',
  'models.warning.envOverridesReasoning': '{name}={value} is set and wins over the reasoning level you just saved.',
  'models.warning.holdCleared': 'Released {holds} configuration hold(s) and {jobs} waiting job(s).',

  // ── 임베딩(0.7.0 읽기 전용) ───────────────────────────────────────────────
  'models.embedding.title': 'The model that makes search (embedding)',
  'models.embedding.readOnlyTag': 'read-only',
  'models.embedding.row.model': 'In effect now',
  'models.embedding.row.cache': 'Weights cache',
  'models.embedding.cache.present': '{size} in {files} file(s) · {dir}',
  'models.embedding.cache.absent': 'Not on this machine yet — run: memex deps warm ({dir})',
  'models.embedding.cache.stub': 'Stubbed (MEMEX_EMBEDDING_STUB=1) — no weights needed.',
  'models.embedding.readOnly': 'Changing the embedding model rebuilds every vector, so it is read-only in this release and lands in 0.7.1.',

  // ── 서버 오류 (`/api/v2/models`) ──────────────────────────────────────────
  'models.error.method_not_allowed': 'This endpoint answers GET and POST only.',
  'models.error.confirm_required': 'A model settings change needs an explicit confirmation.',
  'models.error.unknown_action': 'That model action does not exist.',
  'models.error.invalid_model_id': 'A model id must be 1-256 characters matching [\\w./:@+-].',
  'models.error.invalid_reasoning': 'The reasoning effort must be one of {allowed}.',
  'models.error.nothing_to_save': 'Choose a model or a reasoning effort first.',
  'models.error.busy': 'Another model settings action is still running.',
  'models.error.mutation_busy': 'A memory change or a sync is running. Try again when it finishes.',
  'models.error.operation_busy': 'An admin command is running. Try again when it finishes.',
  'models.error.core_unavailable': 'The installed core has no model settings service. Build the core.',
  'models.error.db_missing': 'The index database is missing, so a test call has nowhere to record its attempt. Run a conversation sync first.',
};
