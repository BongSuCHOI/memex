// guidance — 실패 분류 카탈로그의 산문. 소유: i18n L4 (#109).
//
// `ui/public/guidance.mjs`에는 **구조와 로직만** 남는다: `CLASSES` 배열의 순서(= classify의
// 우선순위), `id`, `match` 규칙, `ignorable`, `actions[].kind/command/to/query/labelKey`,
// `source` 앵커. 제목·원인·영향·다음 행동은 전부 여기 있다.
//
// 규칙 둘:
//   1. **HTML도 보간 슬롯도 없다** — `guidance.attention.*.detail` 하나만 예외다(어순 때문에
//      `{count}`를 사전 안에 둔다). 렌더러 6개가 전부 `esc()`로 조립한다.
//   2. 임계값·환경 변수·버전은 보간이 아니라 **산문에 박힌 리터럴**이다(MEMEX_CAPSULE_MAX_CHARS,
//      0.6.1, General/Misc, MEMEX_STRICT_CAPTURE=1). 번역할 때도 그대로 둔다.
export default {
  // ── 36 클래스 × {title, cause, impact, next}. 배열 순서는 모듈이 갖는다 ──
  'guidance.db-unavailable.title': '로컬 데이터베이스에 연결할 수 없음',
  'guidance.db-unavailable.cause': '인덱스 DB 파일이 없거나 열 수 없습니다. 아직 한 번도 동기화하지 않았거나 경로·권한이 바뀐 상태입니다.',
  'guidance.db-unavailable.impact': '조회·주입·기억 변경이 모두 멈춥니다. 저장된 기억이 사라진 것은 아닙니다.',
  'guidance.db-unavailable.next': '관리 › 런타임에서 DB 경로를 확인하고, 진단을 실행한 뒤 대화 동기화로 인덱스를 만드세요.',

  'guidance.deps-missing.title': '런타임 의존성이 설치되지 않음',
  'guidance.deps-missing.cause': '설치된 플러그인 루트에 네이티브 의존성이 없어 모든 훅이 고정되지 않은 npx 폴백으로 실행됩니다.',
  'guidance.deps-missing.impact': '훅이 느려지고 버전이 고정되지 않습니다. 기억 데이터 자체는 손상되지 않습니다.',
  'guidance.deps-missing.next': '설치본 루트에서 의존성을 실체화한 뒤 진단으로 dependencies가 ok인지 확인하세요.',

  'guidance.capsule-bound-exceeded.title': '0.6.0 이전 상한으로 죽은 Capsule 작업',
  'guidance.capsule-bound-exceeded.cause': '0.6.1 이전 코어는 Capsule 패치가 저장 한도(MEMEX_CAPSULE_MAX_CHARS)를 넘으면 작업을 실패시켰습니다. 이 오류를 남긴 작업은 그때 terminal 상태로 끝난 작업입니다 — 0.6.1부터는 실패시키지 않고 잘라서 저장합니다.',
  'guidance.capsule-bound-exceeded.impact': '그 작업 흐름의 연속성 요약이 갱신되지 않은 채 남아 있습니다. 기억(fact)은 잃지 않았습니다.',
  'guidance.capsule-bound-exceeded.next': '업그레이드만으로는 재개되지 않습니다(worker는 pending·retry만 가져갑니다). memex recover로 다시 대기 상태로 되돌리세요 — 복구는 아무것도 삭제하지 않습니다.',

  'guidance.capsule-truncated.title': '작업 맥락 Capsule이 잘림',
  'guidance.capsule-truncated.cause': 'Capsule 패치가 저장 한도(MEMEX_CAPSULE_MAX_CHARS, 기본 12,000자)를 넘어 우선순위가 낮은 항목부터 잘렸습니다. 0.6.1부터 코어는 작업을 실패시키지 않고 잘라서 저장합니다.',
  'guidance.capsule-truncated.impact': '기억(fact)에는 영향이 없습니다 — Capsule은 해석용 맥락이며 직접 근거가 아닙니다. 연속성 요약의 일부 항목만 보존되지 않습니다.',
  'guidance.capsule-truncated.next': '무시해도 됩니다. 잘린 항목이 계속 필요하면 MEMEX_CAPSULE_MAX_CHARS를 올린 뒤 해당 작업 흐름을 다시 처리하세요.',

  'guidance.budget-exhausted.title': '모델 작업 예산 소진',
  'guidance.budget-exhausted.cause': '이번 실행(run)의 예산을 다 썼습니다 — 기한(deadline), 호출 창(window), 시도 수(attempts) 중 하나입니다.',
  'guidance.budget-exhausted.impact': '남은 대상은 처리되지 않고 대기 상태로 남습니다. 이미 저장된 기억은 그대로입니다.',
  'guidance.budget-exhausted.next': '예산 상태를 확인한 뒤 새 실행으로 이어서 진행하세요. 예산 ID는 작업 상세의 "예산 ID"에 있습니다.',

  'guidance.claim-handoff.title': '다른 실행기가 먼저 가져감',
  'guidance.claim-handoff.cause': '같은 작업을 다른 worker가 이미 임대(lease)했거나, 동시 쓰기 경합에서 이번 실행이 졌습니다.',
  'guidance.claim-handoff.impact': '없습니다. 작업은 이긴 실행기가 처리합니다.',
  'guidance.claim-handoff.next': '무시해도 됩니다. 같은 작업이 계속 넘겨지기만 한다면 임대가 만료된 실행기가 남아 있는지 확인하세요.',

  'guidance.claim-backoff.title': '재시도 대기 중(backoff)',
  'guidance.claim-backoff.cause': '실패 후의 재시도 시각이 아직 되지 않았습니다. 고장이 아닙니다.',
  'guidance.claim-backoff.impact': '해당 작업만 잠시 미뤄집니다.',
  'guidance.claim-backoff.next': '기다리거나 worker를 실행하세요. 즉시 되돌리려면 해당 작업만 재시도하세요.',

  'guidance.claim-attempts.title': '시도 상한 도달',
  'guidance.claim-attempts.cause': '이 작업이 허용된 시도 수를 모두 썼습니다.',
  'guidance.claim-attempts.impact': '해당 범위는 자동으로 다시 처리되지 않습니다.',
  'guidance.claim-attempts.next': '저장된 오류를 확인해 원인을 고친 뒤 복구하거나, 되살릴 가치가 없으면 사유를 남기고 정리하세요.',

  'guidance.claim-error.title': '작업 확보 중 오류',
  'guidance.claim-error.cause': '작업을 확보하는 단계에서 오류가 났습니다. 처리 자체는 시작되지 않았습니다.',
  'guidance.claim-error.impact': '이번 회차만 건너뜁니다.',
  'guidance.claim-error.next': '같은 작업에서 반복되면 시스템 로그의 원문을 확인하세요.',

  'guidance.excluded-project.title': '정책상 제외된 프로젝트',
  'guidance.excluded-project.cause': '설정에서 제외한 프로젝트라 수집·추출 대상이 아닙니다. 실패가 아니라 정상 동작입니다.',
  'guidance.excluded-project.impact': '이 프로젝트의 대화는 기억이 되지 않습니다.',
  'guidance.excluded-project.next': '의도한 것이면 무시하세요. 아니라면 제외 설정을 확인하세요.',

  'guidance.failed-visible.title': '결정론적으로 실패해 표시된 구간',
  'guidance.failed-visible.cause': '재시도해도 같은 결과가 나오는 실패라서, 숨기지 않고 그대로 표시한 상태입니다.',
  'guidance.failed-visible.impact': '해당 구간의 기억만 만들어지지 않습니다. 다른 구간은 정상 처리됩니다.',
  'guidance.failed-visible.next': '작업 상세에서 저장된 오류 원문과 실패 구간을 확인한 뒤 복구하세요.',

  'guidance.job-dead.title': '실패로 종료된 작업',
  'guidance.job-dead.cause': '재시도 상한을 소진해 terminal 상태가 된 작업입니다.',
  'guidance.job-dead.impact': '그 작업이 담당하던 대화 구간은 기억으로 추출되지 않습니다.',
  'guidance.job-dead.next': '작업 상세에서 원인을 확인한 뒤 복구하거나, 되살릴 가치가 없으면 사유를 남기고 정리하세요. 복구는 아무것도 삭제하지 않습니다.',

  'guidance.job-retry.title': '재시도를 기다리는 작업',
  'guidance.job-retry.cause': '실패한 뒤 다음 재시도 시각을 기다리는 중입니다.',
  'guidance.job-retry.impact': '처리가 늦어질 뿐, 손실은 아닙니다.',
  'guidance.job-retry.next': 'worker가 돌면 자동으로 처리됩니다. 대기가 길어지면 저장된 오류를 확인하세요.',

  'guidance.extraction-failed-range.title': '추출 실패 구간이 기록됨',
  'guidance.extraction-failed-range.cause': '어떤 입력 구간이 실패했는지까지 기록된 terminal 범위입니다.',
  'guidance.extraction-failed-range.impact': '그 구간의 기억만 비어 있습니다.',
  'guidance.extraction-failed-range.next': '같은 단위로 복구하세요. 오류 원문은 보존됩니다.',

  'guidance.capture-gap.title': 'capture 공백이 열려 있음',
  'guidance.capture-gap.cause': 'capture가 fail-open으로 넘어간 구간입니다. 코어가 의도적으로 허용한 상태입니다.',
  'guidance.capture-gap.impact': '그 구간의 대화가 인덱스에 없습니다.',
  'guidance.capture-gap.next': '복구 명령의 대상이 아닙니다. 같은 세션의 다음 성공 capture가 닫습니다. 실패를 즉시 드러내려면 MEMEX_STRICT_CAPTURE=1로 실행하세요.',

  'guidance.lease-expired.title': '임대가 만료된 실행 중 작업',
  'guidance.lease-expired.cause': '실행 중으로 표시돼 있지만 임대 시각이 이미 지났습니다. 실행기가 중간에 사라진 상태입니다.',
  'guidance.lease-expired.impact': '다른 worker가 다시 가져갈 때까지 진행되지 않습니다.',
  'guidance.lease-expired.next': 'worker를 실행하면 임대가 회수됩니다. 계속 남아 있으면 복구하세요.',

  'guidance.model-call-failed.title': '모델 호출 자체가 실패',
  'guidance.model-call-failed.cause': '모델을 호출하는 단계에서 실패했습니다 — 네트워크, 실행기(codex) 기동, 인증 같은 호출 경로의 문제이며 응답 내용의 문제가 아닙니다.',
  'guidance.model-call-failed.impact': '그 호출의 산출물이 없습니다. 코어는 이 실패를 일시적 오류로 보고 시도를 소모하지 않으므로 예산은 그대로입니다.',
  'guidance.model-call-failed.next': '대개 재시도로 해결됩니다. 반복되면 모델 시도 탭의 오류 원문으로 실행기·인증 상태를 먼저 확인하세요 — 프롬프트나 입력 길이를 고칠 문제가 아닙니다.',

  'guidance.model-invalid-json.title': '모델이 형식에 맞지 않는 응답을 반환',
  'guidance.model-invalid-json.cause': '모델 응답이 요구한 JSON 스키마를 만족하지 않아 코어가 저장을 거부했습니다.',
  'guidance.model-invalid-json.impact': '그 시도의 산출물만 버려집니다. 잘못된 내용이 기억으로 저장되지는 않습니다.',
  'guidance.model-invalid-json.next': '대개 재시도로 해결됩니다. 반복되면 모델 시도 탭에서 오류 원문과 입력 길이를 확인하세요.',

  'guidance.embedding-unavailable.title': '임베딩 런타임을 준비하지 못함',
  'guidance.embedding-unavailable.cause': '로컬 임베딩 모델을 적재하지 못했습니다. 모델 파일이 없거나 런타임 의존성이 준비되지 않은 상태입니다.',
  'guidance.embedding-unavailable.impact': '의미 검색과 분류가 멈추고, 의미 수정 저장도 실패합니다. 저장된 기억은 그대로입니다.',
  'guidance.embedding-unavailable.next': '의존성을 실체화하고 진단을 실행한 뒤, 누락된 임베딩을 백필하세요.',

  'guidance.ontology-parked.title': '분류가 보류(parked)된 기억',
  'guidance.ontology-parked.cause': '분류를 정해진 횟수만큼 시도했지만 실패해 General/Misc에 보류된 기억입니다. 분류 완료로 세지 않습니다.',
  'guidance.ontology-parked.impact': '분류·지도에서 제 자리를 찾지 못합니다. 기억 자체와 주입에는 영향이 없습니다.',
  'guidance.ontology-parked.next': '정책·임베딩 토큰이 바뀐 보류 건은 한 번의 재시도를 받을 수 있습니다. 온톨로지 백필을 실행하세요.',

  'guidance.ontology-index-repair.title': '온톨로지 카테고리 인덱스 수리 필요',
  'guidance.ontology-index-repair.cause': '카테고리 벡터 인덱스가 자가 치유로 복구되지 않는 상태입니다. 기억의 문제가 아니라 인덱스의 문제입니다.',
  'guidance.ontology-index-repair.impact': '분류가 차단됩니다. 새 기억은 계속 저장되지만 분류 대기로 쌓입니다.',
  'guidance.ontology-index-repair.next': '임베딩을 백필해 벡터를 다시 만드세요. 그래도 남으면 진단 결과와 함께 확인하세요.',

  'guidance.derived-lane-skip.title': '파생 레인이 밀림',
  'guidance.derived-lane-skip.cause': '우선순위가 높은 capture·capsule 작업이 밀려 있어 통합·재임베딩·분류·추출 백필이 순번을 양보했습니다.',
  'guidance.derived-lane-skip.impact': '"대기가 줄지 않는다"처럼 보이지만 원인은 다른 레인에 있습니다. 데이터 손실은 아닙니다.',
  'guidance.derived-lane-skip.next': '밀린 백로그를 먼저 비우세요. 연속으로 밀리면 코어가 강제로 한 번 통과시킵니다.',

  'guidance.evidence-missing.title': '로컬 검증 영수증이 없는 기억',
  'guidance.evidence-missing.cause': '현재 의미 버전에 대한 로컬 검증 영수증이 없습니다. 원문이 아직 있으면 다시 만들 수 있습니다.',
  'guidance.evidence-missing.impact': '자동 통합에서 제외되고 동기화 충돌에서 밀립니다 — "중복 기억이 계속 쌓인다"의 실제 원인입니다.',
  'guidance.evidence-missing.next': '영수증 백필로 다시 만드세요. 원문이 사라진 기억은 복구되지 않습니다.',

  'guidance.evidence-unresolved.title': '근거 원문을 다시 찾지 못함',
  'guidance.evidence-unresolved.cause': '기억이 가리키는 원문 exchange를 현재 인덱스에서 찾지 못했습니다.',
  'guidance.evidence-unresolved.impact': '그 작업은 기억을 저장하지 않고 종료합니다. 잘못된 근거로 저장하지는 않습니다.',
  'guidance.evidence-unresolved.next': '대화 동기화로 인덱스를 채운 뒤 복구하세요.',

  'guidance.stale-fact.title': '변경 중에 기억이 바뀜',
  'guidance.stale-fact.cause': '저장을 시도하는 사이에 같은 기억이 다른 경로에서 바뀌어, 코어가 덮어쓰기를 거부했습니다.',
  'guidance.stale-fact.impact': '없습니다 — 이전 값이 그대로 유지됩니다. 안전장치가 동작한 것입니다.',
  'guidance.stale-fact.next': '화면을 새로고침해 현재 값을 확인한 뒤 다시 시도하세요.',

  'guidance.tier-step.title': '계층은 한 칸씩만 움직임',
  'guidance.tier-step.cause': '브랜치 ⇄ 프로젝트 공용 ⇄ 글로벌 사다리에서 두 칸을 한 번에 옮기려 했거나 이미 끝에 있습니다.',
  'guidance.tier-step.impact': '없습니다. 아무것도 바뀌지 않았습니다.',
  'guidance.tier-step.next': '한 칸씩 옮기세요. 글로벌로 보내려면 먼저 프로젝트 공용으로 승격합니다.',

  'guidance.receipt-failed.title': '컨텍스트는 나갔는데 영수증이 남지 않음',
  'guidance.receipt-failed.cause': '기억을 컨텍스트로 내보냈지만 durable recall 영수증이 준비 상태에 머물렀습니다.',
  'guidance.receipt-failed.impact': '"어떤 기억이 언제 어느 세션에 들어갔는가"의 사후 감사가 불가능해집니다.',
  'guidance.receipt-failed.next': '진단을 실행하고 DB 쓰기 가능 여부·디스크·권한을 점검하세요.',

  'guidance.no-match.title': '관련 기억을 찾지 못함',
  'guidance.no-match.cause': '후보가 없었거나 관련성 게이트에서 전부 탈락했습니다. 오류가 아닙니다.',
  'guidance.no-match.impact': '그 요청에는 기억이 제공되지 않았습니다.',
  'guidance.no-match.next': '이 프로젝트에 저장된 기억 수를 확인하세요. 브랜치 계층에 가려진 기억이 있으면 포함해서 볼 수 있습니다.',

  'guidance.quarantined-project.title': '격리된 프로젝트',
  'guidance.quarantined-project.cause': '`/`처럼 프로젝트를 지목할 수 없는 cwd에서 만들어진 프로젝트입니다. 기억은 보존하고 주입·조회에서만 제외합니다.',
  'guidance.quarantined-project.impact': '그 프로젝트의 기억은 주입되지 않습니다. 삭제되지는 않았습니다.',
  'guidance.quarantined-project.next': '자동 복구 명령이 없습니다. 정상 cwd에서 다시 작업하고, 이전 기억이 필요하면 계층 이동으로 옮기세요.',

  'guidance.sync-disabled.title': '동기화가 꺼져 있음',
  'guidance.sync-disabled.cause': '기본값입니다. 고장이 아닙니다.',
  'guidance.sync-disabled.impact': '다른 기기와 기억 상태를 주고받지 않습니다.',
  'guidance.sync-disabled.next': '쓰려면 관리 › 동기화에서 공유 폴더를 지정해 켜세요.',

  'guidance.sync-never-exported.title': '동기화가 켜져 있는데 한 번도 내보내지 않음',
  'guidance.sync-never-exported.cause': '스위치는 켜져 있는데 export 기록이 없습니다.',
  'guidance.sync-never-exported.impact': '다른 기기에서 이 기기의 기억을 볼 수 없습니다.',
  'guidance.sync-never-exported.next': '관리 › 동기화에서 지금 내보내기로 첫 세대를 만드세요.',

  'guidance.sync-locked.title': '다른 내보내기가 진행 중',
  'guidance.sync-locked.cause': '같은 데이터 루트에서 export가 이미 실행 중입니다.',
  'guidance.sync-locked.impact': '없습니다. 이번 요청만 건너뜁니다.',
  'guidance.sync-locked.next': '무시해도 됩니다. 잠시 뒤 다시 시도하세요.',

  'guidance.sync-unchanged.title': '내보낼 변경이 없음',
  'guidance.sync-unchanged.cause': '마지막 export 이후 durable 기억이 바뀌지 않았습니다. 빈 세대를 만들지 않기 위한 정상 동작입니다.',
  'guidance.sync-unchanged.impact': '없습니다. 다른 기기가 이미 마지막 세대를 받았다면 받을 것도 없습니다.',
  'guidance.sync-unchanged.next': '무시해도 됩니다. 그래도 새 세대를 만들려면 CLI에서 --force로 내보내세요.',

  'guidance.sync-export-failed.title': '동기화 내보내기 실패',
  'guidance.sync-export-failed.cause': '대개 공유 폴더에 쓸 수 없는 상태입니다(경로 없음, 권한, 클라우드 동기화 중단).',
  'guidance.sync-export-failed.impact': '이 기기의 변경이 다른 기기로 나가지 않습니다. 로컬 기억은 그대로입니다.',
  'guidance.sync-export-failed.next': '관리 › 동기화에서 공유 폴더 경로와 쓰기 가능 여부를 확인한 뒤 다시 내보내세요.',

  'guidance.sync-archive-invalid.title': '세대 파일을 쓰거나 읽을 수 없음',
  'guidance.sync-archive-invalid.cause': '지목한 경로가 Memex 세대 파일이 아니거나(zip 안에 meta.json과 4개 JSONL이 모두 있어야 합니다), 이 기기가 만든 파일이거나, 내보내기 경로가 데이터 루트 밖입니다.',
  'guidance.sync-archive-invalid.impact': '아무것도 적용되지 않았습니다. 기존 기억은 그대로입니다.',
  'guidance.sync-archive-invalid.next': '다른 맥의 관리 › 동기화에서 만든 zip 경로를 그대로 입력하세요. 오류 원문에 어느 조건이 깨졌는지 그대로 적혀 있습니다.',

  'guidance.operation-incomplete.title': '관리 실행이 남은 작업을 두고 끝남',
  'guidance.operation-incomplete.cause': '백필이 전경에서 끝났지만 처리할 작업이 남아 종료 코드 2로 끝났습니다. 실패가 아닙니다.',
  'guidance.operation-incomplete.impact': '남은 대상은 다음 실행이나 worker가 처리합니다.',
  'guidance.operation-incomplete.next': '같은 명령을 다시 실행하거나 worker를 돌리세요.',

  // ── unknownClass()가 런타임에 만드는 37번째 클래스 ──
  'guidance.unknown.title': '알 수 없는 오류',
  'guidance.unknown.cause': '이 오류 문자열에 대응하는 안내가 아직 없습니다. 원인을 추측하지 않습니다.',
  'guidance.unknown.impact': '영향 범위를 단정할 수 없습니다. 아래 원문과 작업 상세를 함께 확인하세요.',
  'guidance.unknown.next': '진단 JSON을 내보내 원문과 함께 보고하세요. 진단에는 대화·기억 원문과 절대 경로가 들어가지 않습니다.',

  // ── 액션 버튼 라벨 24개 (actions[].labelKey) ──
  'guidance.action.recoverDeadWork': '실패 종료 작업 복구',
  'guidance.action.runDoctor': '코어 진단 실행',
  'guidance.action.syncConversations': '대화 동기화',
  'guidance.action.viewRuntime': '런타임 정보',
  'guidance.action.viewDeadJobs': '실패 작업 보기',
  'guidance.action.viewEnvVars': '환경 변수 확인',
  'guidance.action.viewAttempts': '모델 시도 보기',
  'guidance.action.viewRunningJobs': '실행 중 작업 보기',
  'guidance.action.viewErrorLogs': '오류 로그 보기',
  'guidance.action.viewEnvironment': '환경 확인',
  'guidance.action.viewJobs': '처리 작업 보기',
  'guidance.action.viewRetryJobs': '재시도 대기 보기',
  'guidance.action.backfillEmbeddings': '임베딩 백필',
  'guidance.action.backfillOntology': '온톨로지 분류 백필',
  'guidance.action.viewTaxonomy': '분류 보기',
  'guidance.action.viewFacts': '기억 목록 보기',
  'guidance.action.viewChronicle': '변경 이력 보기',
  'guidance.action.viewRecalls': '컨텍스트 제공 보기',
  'guidance.action.viewFactsAllTiers': '계층 포함해 기억 보기',
  'guidance.action.viewAllFacts': '전체 기억 보기',
  'guidance.action.syncSettings': '동기화 설정',
  'guidance.action.syncStatus': '동기화 상태',
  'guidance.action.viewOperations': '관리 실행 내역',
  'guidance.action.exportDiagnostics': '진단 내보내기',

  // ── 개요 경고 카드의 수량 라벨 11개. **1슬롯 패턴**이다(어순을 사전이 가져야 한다) ──
  'guidance.attention.job-dead.detail': '실패로 종료된 작업 {count}건',
  'guidance.attention.job-retry.detail': '재시도를 기다리는 작업 {count}건',
  'guidance.attention.failed-visible.detail': '결정론적 실패로 표시된 구간 {count}개',
  'guidance.attention.extraction-failed-range.detail': '기록된 추출 실패 구간 {count}개',
  'guidance.attention.capture-gap.detail': '열려 있는 capture 공백 {count}개',
  'guidance.attention.budget-exhausted.detail': '소진된 모델 작업 예산 {count}개',
  'guidance.attention.ontology-parked.detail': '분류가 보류된 기억 {count}건',
  'guidance.attention.evidence-missing.detail': '검증 영수증이 없는 기억 {count}건',
  'guidance.attention.quarantined-project.detail': '격리된 프로젝트 {count}개',
  'guidance.attention.derived-lane-skip.detail': '연속 양보 {count}회',
  // 인덱스 수리는 수량이 아니라 코어가 남긴 차단 사유가 정보다. 사유가 없으면 common.unknown.
  'guidance.attention.ontology-index-repair.detail': '차단됨 · {reason}',

  // ── 공통 라벨 ──
  'guidance.ignorable.true': '무시해도 됩니다',
  'guidance.ignorable.false': '조치가 필요합니다',
  'guidance.ignorable.unknown': '영향 미확인',
  'guidance.kv.cause': '원인',
  'guidance.kv.impact': '영향',
  'guidance.kv.next': '다음 행동',
  'guidance.source.label': '단일 출처',
  'guidance.attention.heading': '확인이 필요한 상태',
  'guidance.attention.subtitle': '실패 클래스별로 묶었습니다. 수집되지 않은 값은 0으로 세지 않습니다.',
  'guidance.attention.link': '활동 · 추적',
};
