// models — 관리 › 모델 탭과 `/api/v2/models`의 오류 (#31, 0.7.0 lane E · 설계 §12.5).
//
// 한국어 원문은 **이 파일에만** 있다. 화면 코드(ui/public/pages/model.mjs)와 서버
// (ui/lib/core.cjs · ui/lib/server.cjs)에는 한글 리터럴을 두지 않는다.
export default {
  // ── 화면 상태 ─────────────────────────────────────────────────────────────
  'models.missingCore': '설치된 코어에 <code>dist/model-settings.js</code>가 없습니다. 코어를 빌드하고 서버를 다시 시작하면 이 화면에서 모델을 고를 수 있습니다.',
  'models.statusUnavailable': '모델 설정을 읽지 못했습니다.',
  'models.envPinned': '환경 변수로 고정됨',
  'models.envPinned.detail': '이 서버에 {name}={value}가 설정돼 있어 설정 파일보다 우선합니다.',
  'models.saveDisabledByEnv': '두 값 모두 환경 변수에서 오므로 이 화면이 저장할 것이 없습니다. 셸 프로필·런치 에이전트·Memex를 띄운 훅처럼 환경 변수를 설정한 곳에서 바꾸십시오.',

  // ── 값의 출처 ─────────────────────────────────────────────────────────────
  'models.source.env': '환경 변수',
  'models.source.file': 'models.json',
  'models.source.explicit': '호출 인자',
  'models.source.default': '코어 기본값',

  // ── LLM 카드 ──────────────────────────────────────────────────────────────
  'models.llm.title': '기억을 만드는 모델 (LLM)',
  'models.llm.intro': '이 선택은 <strong>이 기기 전용</strong>입니다. 기기마다 쓸 수 있는 모델이 다르므로 <code>models.json</code>은 동기화되지 않습니다.',
  'models.llm.row.model': '모델',
  'models.llm.row.modelBody': '추출·통합·작업 맥락·분류 등 기억을 만드는 모든 호출이 이 모델을 지나갑니다.',
  'models.llm.row.reasoning': '추론 강도',
  'models.llm.row.reasoningBody': '-c model_reasoning_effort로 전달합니다. 목록은 이 Codex 설치본이 알려 준 값입니다.',
  'models.llm.custom.label': '또는 모델 id를 직접 입력',
  'models.llm.custom.hint': '위 목록보다 우선합니다. 카탈로그는 낡을 수 있고, id는 실제 호출만이 증명합니다.',
  'models.llm.save': '저장',
  'models.llm.test': '이 모델로 1회 테스트',
  'models.llm.reset': '기본값으로 되돌리기',
  'models.llm.latencyWarning': '강도를 높이면 호출당 지연이 늘어납니다. 추출이 실행 기한에 걸리기 시작하면 모델을 낮추기 전에 <code>MEMEX_MODEL_BUDGET_DEADLINE_MS</code>를 올리십시오.',
  'models.llm.workersNote': '백그라운드 워커는 다음 세션부터, 실행 중인 MCP 서버는 다음 모델 호출부터 이 설정을 따릅니다.',

  // ── 사실 표 ───────────────────────────────────────────────────────────────
  'models.row.effectiveModel': '지금 실효값',
  'models.row.effectiveReasoning': '실효 추론 강도',
  'models.row.default': '코어 기본값',
  'models.row.defaultNoReasoning': '추론 플래그 없음',
  'models.row.saved': 'models.json에 저장된 값',
  'models.row.savedUnset': '미설정',
  'models.row.savedNone': '저장된 값이 없어 코어 기본값으로 동작합니다.',
  'models.row.catalog': '카탈로그',
  'models.row.levels': '허용 강도',
  'models.row.lastTest': '마지막 테스트 호출',
  'models.row.settingsFile': '설정 파일',
  'models.row.fileMissing': '아직 만들어지지 않음',
  'models.row.updatedAt': '저장 시각',

  // ── 카탈로그 ──────────────────────────────────────────────────────────────
  'models.catalog.none': '이 Codex 설치본에서 모델 목록을 찾지 못했습니다({home}). 어떤 id든 입력할 수 있고, 첫 호출에서 검증됩니다.',
  'models.catalog.found': '{n}개 · {path}',
  'models.catalog.fetched': '{at} 수신',
  'models.catalog.levels': '{model}은(는) {levels}을(를) 받습니다',
  'models.catalog.levelsUnknown': '이 설치본은 {model}에 대해 알려 주는 것이 없습니다.',

  // ── 추론 강도 ─────────────────────────────────────────────────────────────
  'models.reasoning.none': '플래그 없음',
  'models.reasoning.unsetOption': '플래그를 보내지 않음',

  // ── 설정 오류 보류 ────────────────────────────────────────────────────────
  'models.hold.title': '모델 작업이 멈췄습니다. 제공자가 이 설정을 거절했습니다.',
  'models.hold.selection': '{model} / {reasoning} · {status} {type} · {n}회 관측',
  'models.hold.noDamage': '실패로 기록된 작업도, 소모된 시도도 없습니다. 아래에서 설정을 고치면 자동으로 재개됩니다.',
  'models.hold.others': '이 기기의 다른 선택에 걸린 보류가 {n}건 더 있지만 지금 선택을 막지는 않습니다.',
  'models.held.title': '설정을 기다리는 작업',
  'models.held.body': '이 작업들은 실패가 아니라 보류입니다. 시도는 환불됐고, 기다리는 설정이 유효해지는 즉시 재개됩니다.',
  'models.held.col.reason': '대기 사유',
  'models.held.col.jobs': '작업 수',
  'models.held.col.oldest': '보류 시작',

  // ── 1회 테스트 ────────────────────────────────────────────────────────────
  'models.probe.never': '아직 실행하지 않음',
  'models.probe.ok': '성공',
  'models.probe.failed': '실패 ({reason})',
  'models.probe.detail': '{ms} · {at}',
  'models.probe.confirm.title': '이 모델로 1회 테스트',
  'models.probe.confirm.body': '제공자에게 실제로 1회 호출하고 모델 작업 원장에 시도 1건을 남깁니다. 성공하면 설정 보류가 해제되고 기다리던 작업이 재개됩니다.',
  'models.probe.running': '모델을 1회 호출하는 중…',
  'models.probe.okToast': '{model}이(가) {ms} 만에 응답했습니다.',
  'models.probe.failedToast': '호출이 성공하지 못했습니다: {message}',

  // ── 저장·초기화 ───────────────────────────────────────────────────────────
  'models.toast.saved': '저장했습니다. 이제 {model} / {reasoning}(으)로 호출합니다.',
  'models.toast.reset': 'models.json을 삭제했습니다. 선택은 {model}(으)로 돌아갔습니다.',
  'models.reset.title': '모델 선택 초기화',
  'models.reset.body': 'models.json을 삭제하고 모든 LLM 값을 코어 기본값으로 되돌립니다. 실효 임베딩 모델은 그대로입니다 — 벡터 공간은 데이터베이스가 소유하며, 설정 파일을 지워도 벡터는 지워지지 않습니다.',

  // ── 경고(서버 코드 → 문장) ────────────────────────────────────────────────
  'models.warning.modelNotInCatalog': '{model}은(는) 이 설치본의 카탈로그({path})에 없습니다. 카탈로그는 낡을 수 있고 id는 실제 호출만이 증명하므로 그대로 저장했습니다.',
  'models.warning.catalogUnavailable': '이 Codex 설치본에서 모델 목록을 찾지 못했습니다({home}). 입력한 id는 첫 호출에서 검증됩니다.',
  'models.warning.modelHidden': '{model}은(는) 목록에 표시되지 않는 카탈로그 항목입니다. 선택은 가능합니다.',
  'models.warning.reasoningUnsupported': '카탈로그는 {model}이(가) {levels}을(를) 받는다고 말합니다. 그대로 저장했으니 1회 테스트로 제공자의 실제 응답을 확인하십시오.',
  'models.warning.envOverridesModel': '{name}={value}가 설정돼 있어 우선합니다. models.json에는 {model}이(가) 저장됐지만 이 서버는 {value}를 호출합니다.',
  'models.warning.envOverridesReasoning': '{name}={value}가 설정돼 있어 방금 저장한 추론 강도보다 우선합니다.',
  'models.warning.holdCleared': '설정 보류 {holds}건과 대기 중이던 작업 {jobs}건을 해제했습니다.',

  // ── 임베딩(0.7.0 읽기 전용) ───────────────────────────────────────────────
  'models.embedding.title': '검색을 만드는 모델 (임베딩)',
  'models.embedding.readOnlyTag': '읽기 전용',
  'models.embedding.row.model': '지금 실효값',
  'models.embedding.row.cache': '가중치 캐시',
  'models.embedding.cache.present': '{files}개 파일 · {size} · {dir}',
  'models.embedding.cache.absent': '이 기기에 아직 없습니다 — 실행: memex deps warm ({dir})',
  'models.embedding.cache.stub': '스텁 모드(MEMEX_EMBEDDING_STUB=1) — 가중치가 필요 없습니다.',
  'models.embedding.readOnly': '임베딩 모델을 바꾸면 모든 벡터를 다시 만들어야 하므로 이번 릴리즈에서는 읽기 전용이며, 변경은 0.7.1에서 제공됩니다.',

  // ── 서버 오류 (`/api/v2/models`) ──────────────────────────────────────────
  'models.error.method_not_allowed': '이 엔드포인트는 GET과 POST만 받습니다.',
  'models.error.confirm_required': '모델 설정 변경에는 명시적 확인이 필요합니다.',
  'models.error.unknown_action': '지원하지 않는 모델 작업입니다.',
  'models.error.invalid_model_id': '모델 id는 [\\w./:@+-]에 맞는 1~256자여야 합니다.',
  'models.error.invalid_reasoning': '추론 강도는 {allowed} 중 하나여야 합니다.',
  'models.error.nothing_to_save': '모델이나 추론 강도 중 하나는 골라야 합니다.',
  'models.error.busy': '다른 모델 설정 작업이 아직 실행 중입니다.',
  'models.error.mutation_busy': '기억 변경 또는 동기화가 진행 중입니다. 완료 후 다시 실행하세요.',
  'models.error.operation_busy': '관리 명령이 실행 중입니다. 완료 후 다시 실행하세요.',
  'models.error.core_unavailable': '설치된 코어에 모델 설정 서비스가 없습니다. 코어를 빌드하세요.',
  'models.error.db_missing': '인덱스 데이터베이스가 없어 테스트 호출의 시도를 기록할 곳이 없습니다. 먼저 대화 동기화를 실행하세요.',
};
