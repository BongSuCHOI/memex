// common — 두 곳 이상에서 쓰이는 조각. 소유: i18n L1.
// 접두사 5종: common.* (공통 명사) · unit.* (수량·기간·용량) · action.* (버튼 라벨)
// label.*/state.*/note.* (서버 페이로드의 프로즈) · op.* (관리 명령 카탈로그).
//
// `op.<command>.{label,note}`의 `<command>`는 operations.cjs의 COMMANDS 키이고
// `~/.memex/ui/operations.json`에 이미 영속화돼 있다 — 그래서 라벨을 저장하지 않고 키로
// 렌더한다(설계 §5.4). 레거시 항목은 `entry.label`이 남아 있으므로 사전 우선·저장값 폴백이다.
export default {
  // ── 공통 명사 ──────────────────────────────────────────────────────────────
  'common.unknown': 'Not recorded',
  'common.commonMemory': 'Common memory',
  'common.allProjects': 'all projects',
  'common.search': 'Search',
  'common.rawData': 'Raw data',
  'common.markdownTruncated': 'Over the {max}-character browser display limit.',
  // memory_jobs.hold_reason 값 3종. 보류는 실패가 아니라 "설정 대기"다.
  'common.job.hold.extraction_rules_invalid': 'Waiting on extraction rules',
  'common.job.hold.extraction_rules_unavailable': 'Extraction rules could not be checked',
  'common.job.hold.model_config_rejected': 'Waiting on model configuration',
  // ── 단위 ───────────────────────────────────────────────────────────────────
  'unit.duration.ms': '{value} ms',
  'unit.duration.sec': '{value} s',
  'unit.duration.minsec': '{m}m {s}s',
  'unit.bytes.b': '{value} B',
  'unit.bytes.kb': '{value} KB',
  'unit.bytes.mb': '{value} MB',
  // ── 공통 액션 ──────────────────────────────────────────────────────────────
  'action.retry': 'Try again',
  'action.refresh': 'Refresh',
  'action.close': 'Close',
  'action.cancel': 'Cancel',
  'action.confirm': 'Confirm',
  'action.previous': 'Previous',
  'action.next': 'Next',
  'action.goTo': 'Open',
  // ── 서버 페이로드의 프로즈 (HTTP 200 본문) ─────────────────────────────────
  'label.session.untitled': 'Untitled conversation',
  'state.schema.tableAbsent': 'No {table} records in this database.',
  'state.fact.sourceUnavailable': 'Outside the current scope, or the transcript is missing.',
  'state.log.selectFileFirst': 'Pick a log file first.',
  'note.environment.inherited': 'The environment this UI server inherited when it started. It does not prove the environment of plugin or hook processes that are already running.',
  'note.log.tailOnlyRedaction': 'Only the tail of the file is read. Secret redaction is best-effort and does not remove every form of personal data.',
  'note.job.relatedFactsBasis': 'Current memories that cite the same transcript as evidence. That does not mean they are direct output of this run.',
  // ── 관리 명령 카탈로그 (operations.cjs COMMANDS) ───────────────────────────
  'op.doctor.label': 'Install and runtime diagnostics',
  'op.status.label': 'Check pipeline status',
  'op.sync.label': 'Sync conversations',
  'op.extract.label': 'Memory extraction backfill',
  'op.ontology.label': 'Taxonomy classification backfill',
  'op.embeddings.label': 'Embedding backfill',
  'op.all.label': 'Full backfill',
  'op.recover.label': 'Recover dead jobs',
  'op.tiers-preview.label': 'Preview memory tier migration',
  'op.tiers-apply.label': 'Apply memory tier migration',
  'op.recover.note': 'Returns jobs that ended in failure to the pending state. Nothing is deleted, and the cleared last_error is kept in retry_history. To handle a single job, use memex recover [job-id] from the CLI.',
  'op.tiers-preview.note': 'Only lists memories left on the branch tier without a branch signal. It changes nothing.',
  'op.tiers-apply.note': 'Raises the memories from the preview to project-wide and records a tier promotion event in the Chronicle. Memories actually created on a branch are left alone.',
  // 서버 재기동으로 잃은 출력. operations.cjs가 outputLost:true만 남기고 문장은 화면이 만든다.
  'op.output.lostAcrossRestart': 'Output from an earlier server run is not kept.',
};
