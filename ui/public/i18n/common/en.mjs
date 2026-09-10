// common — 두 곳 이상에서 쓰이는 조각. 소유: i18n L1.
// lane-0은 렌더 유틸(renderIssues)과 작업 보류 사유(decisions-v3 H2)에 필요한 것만 넣었다.
export default {
  'common.unknown': 'Not collected',
  // memory_jobs.hold_reason 값 3종. 보류는 실패가 아니라 "설정 대기"다.
  'common.job.hold.extraction_rules_invalid': 'Waiting on extraction rules',
  'common.job.hold.extraction_rules_unavailable': 'Extraction rules could not be checked',
  'common.job.hold.model_config_rejected': 'Waiting on model configuration',
};
