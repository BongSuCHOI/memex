// common — 두 곳 이상에서 쓰이는 조각. 소유: i18n L1.
// 복수형은 ko에 `.other` 하나만 둔다 — `.one`을 넣으면 Intl.PluralRules(ko)가 절대 고르지
// 않아 영원히 죽은 키가 된다(설계 §2.4 R2).
export default {
  // ── 공통 명사 ──────────────────────────────────────────────────────────────
  'common.unknown': '미수집',
  'common.uncategorized': '미분류',
  'common.commonMemory': '공통 기억',
  'common.allProjects': '전체',
  'common.search': '검색',
  'common.rawData': '원시 데이터',
  'common.markdownTruncated': '브라우저 표시 한도 {max}자를 초과했습니다.',
  // memory_jobs.hold_reason 값 3종. 보류는 실패가 아니라 "설정 대기"다.
  'common.job.hold.extraction_rules_invalid': '추출 규칙 확인 필요',
  'common.job.hold.extraction_rules_unavailable': '추출 규칙을 확인하지 못함',
  'common.job.hold.model_config_rejected': '모델 설정 대기',
  // ── 단위 ───────────────────────────────────────────────────────────────────
  'unit.count.other': '{count}개',
  'unit.memories.other': '기억 {count}개',
  'unit.duration.ms': '{value} ms',
  'unit.duration.sec': '{value} s',
  'unit.duration.minsec': '{m}분 {s}초',
  'unit.bytes.b': '{value} B',
  'unit.bytes.kb': '{value} KB',
  'unit.bytes.mb': '{value} MB',
  // ── 공통 액션 ──────────────────────────────────────────────────────────────
  'action.retry': '다시 시도',
  'action.refresh': '새로고침',
  'action.close': '닫기',
  'action.cancel': '취소',
  'action.confirm': '확인',
  'action.previous': '이전',
  'action.next': '다음',
  'action.goTo': '보러 가기',
  // ── 서버 페이로드의 프로즈 (HTTP 200 본문) ─────────────────────────────────
  'label.session.untitled': '제목 없는 대화',
  'state.schema.tableAbsent': '{table} 기록이 이 데이터베이스에 없습니다.',
  'state.fact.sourceUnavailable': '현재 범위 밖이거나 원문이 없습니다.',
  'state.log.selectFileFirst': '먼저 로그 파일을 선택하세요.',
  'note.environment.inherited': '이 UI 서버가 시작될 때 상속한 환경입니다. 이미 실행 중인 플러그인·훅 프로세스의 환경을 증명하지 않습니다.',
  'note.log.tailOnlyRedaction': '파일 끝부분만 조회합니다. 비밀정보 마스킹은 최선 노력이며 모든 형태의 개인정보를 제거하지는 않습니다.',
  'note.job.relatedFactsBasis': '동일한 원문을 근거로 가진 현재 기억입니다. 해당 실행의 직접 산출물임을 의미하지 않습니다.',
  // ── 관리 명령 카탈로그 (operations.cjs COMMANDS) ───────────────────────────
  'op.doctor.label': '설치·런타임 진단',
  'op.status.label': '파이프라인 상태 확인',
  'op.sync.label': '대화 동기화',
  'op.extract.label': '기억 추출 백필',
  'op.ontology.label': '온톨로지 분류 백필',
  'op.embeddings.label': '임베딩 백필',
  'op.all.label': '전체 백필',
  'op.recover.label': '실패 종료 작업 복구',
  'op.tiers-preview.label': '기억 계층 이관 미리보기',
  'op.tiers-apply.label': '기억 계층 이관 적용',
  'op.recover.note': '실패로 종료된 작업을 다시 대기 상태로 되돌립니다. 아무것도 삭제하지 않으며 지워진 last_error는 retry_history에 보존됩니다. 개별 작업만 다루려면 CLI에서 memex recover [job-id]를 쓰세요.',
  'op.tiers-preview.note': '브랜치 신호 없이 브랜치 계층에 남아 있는 기억을 나열만 합니다. 아무것도 바꾸지 않습니다.',
  'op.tiers-apply.note': '미리보기에 나온 기억을 프로젝트 공용으로 올리고 Chronicle에 계층 승격 이벤트를 남깁니다. 실제 브랜치에서 만들어진 기억은 옮기지 않습니다.',
  'op.output.lostAcrossRestart': '이전 서버 실행의 출력은 보존하지 않습니다.',
};
