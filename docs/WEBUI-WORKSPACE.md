# Memex Workspace: integrated local Web UI

이 UI는 0.4.2 / `f2dfc02967c35c5c9b64090e904779dcfe5cafb9`의 읽기 스키마·팩트 관리 서비스·CLI를 설계 기준선으로 삼아 구성됐고, 0.5.0과 함께 배포되며 0.5.0 릴리스 게이트에서 현재 스키마로 검증됐다. 기존 `ui/server.cjs` bin과 `ui/` 패키징을 유지한다.

## 화면

`/` 개요, `/conversations` 대화 원장, `/facts` 기억·사실, `/taxonomy` 분류, `/graph` WebGL/Canvas 지도, `/activity` Chronicle·작업·모델 시도·주입·로그·관리 실행, `/settings` 환경·작업 실행·화면 설정·진단.

범위는 상단에서 명시적으로 선택하며 선택 순서는 **전체 프로젝트 (조회) → 공통 기억 → 프로젝트 목록**이고, 각 항목에 그 범위의 활성 기억 수를 함께 보여준다. 화면의 기본값은 **전체 프로젝트 (조회)** 다(0.6.1, #24). 프로젝트 범위는 공통 기억 포함 여부와 승격 상태(`promotion_state`)를 구분한다. 상세 패널과 검색에도 같은 범위를 적용한다.

전체 프로젝트는 **조회 전용 범위**이고 실제 주입 범위와 다르다. 그래서 범위 선택 옆에 `주입: 현재 프로젝트 + 공통 기억` 안내를 상시 표시한다. 대화 원장·활동·개요는 공통 기억 범위에서 항상 0건이므로(대화와 작업은 프로젝트 세션에 묶여 있다) 배너에서 한 번의 클릭으로 전체 프로젝트로 전환한다.

`/facts?fact=<id>`는 `/facts/<id>`와 같은 상세 패널을 연다(#26).

**0.6.0 기억 계층과의 대응.** 화면에 보이는 승격 상태는 [범위 모델](FACT-LIFECYCLE.md#1-fact란-무엇인가)의
세 계층과 다음처럼 대응한다: `workstream`(과 `workspace`) = 브랜치 tier, `project-current`(와 `decision`) =
프로젝트 공용, `scope_type = global` = 글로벌. 새 기억의 기본 계층은 세션의 브랜치 신호가 정하므로,
기본 브랜치나 비-git 디렉터리에서 만들어진 기억은 프로젝트 범위 화면에 바로 나타난다.
`facts.tier_reason`이 그 근거를 담는다.

**0.6.0에서 UI 코드는 바뀌지 않았다.** 계층 배지·숨김 배너·승격/강등 버튼·마이그레이션 카드·실패
클래스별 안내는 0.6.1(#22 #23 #24)에서 들어온다. 그때까지 계층 이동은 CLI가 유일한 경로다 —
`memex facts tier|promote|demote`, `memex facts migrate-tiers`([GUIDE §7](GUIDE.md#7-fact-관리)).
실패 상태의 원인·복구 안내는 [GUIDE §20](GUIDE.md#20-문제가-생겼을-때--실패-클래스별-복구)의 표를
단일 출처로 삼는다.

## 실행

```bash
npm run build
MEMEX_PLUGIN_ROOT="$PWD" node ui/server.cjs
```

`http://127.0.0.1:3847`. `PORT`로 포트 변경. 별도 프런트엔드 빌드는 없다. 사용자 홈/DB 환경 변수는 기존 값을 상속한다.

`MEMEX_HOME`이 없고 `MEMEX_DB_PATH`만 있으면 home을 그 DB 경로에서 유도하고, 감사 로그(`logs/ui-audit.jsonl`)와 관리 실행 메타데이터(`ui/operations.json`)를 그 home 아래에 쓴다. 정확한 우선순위는 [`ui/README.md`](../ui/README.md)에 있다.

## 계약

조회: `dist/db.js`의 `openReadDb`만 사용. 의미 수정·비활성화·복원·영구 삭제는 `dist/fact-management.js`를 호출. 모델/임베딩 런타임 미준비 오류를 숨기지 않는다. 기존 core API를 우회하는 raw SQL 수정은 하지 않는다.

Chronicle의 사건 발생/기록 시각을 구분하고 직접 근거와 해석 맥락을 분리한다. 연결 ID가 없는 기록을 추정 연결하지 않으며 후보 탈락 사유·토큰 미수집을 만들어내지 않는다. 그래프 위치는 임베딩 거리 수치가 아니다. 컨텍스트 제공은 답변에서 실제 사용됐다는 증거가 아니다.

관리 명령은 `doctor`, `status`, `sync`, `backfill extract|ontology|embeddings|all`만 실행한다. 모두 전체 저장소 범위로 확인을 요구한다. 상단 필터가 CLI 실행 범위를 제한하지 않는다. 취소는 완료된 데이터 변경을 롤백하지 않는다.

SSE는 조회 갱신 알림이다. 로그/추적 원장 전체 재생 프로토콜이 아니다. UI 연결 상태는 플러그인 전체 건강 상태와 다르다. 실행 출력은 메모리 제한 보관, 실행 메타데이터만 로컬 JSON에 보존한다.

## 지식 지도

`/graph`는 fact 노드와 typed relation(`SUPPORTS`, `INFLUENCES`, `SUPERSEDES`,
`CONTRADICTS`)을 브라우저 네이티브 WebGL로 그린다. `2D Map`과 `3D Galaxy` 모드를
같은 데이터로 전환하며, WebGL을 얻지 못하면 Canvas2D로 자동 대체하고 화면에 실제
렌더러를 표시한다. 서드파티 3D 라이브러리, CDN, 외부 폰트를 쓰지 않는다.

레이아웃은 도메인 그룹만 인코딩한다. **노드 사이의 화면 거리는 임베딩 유사도 수치가
아니다.** 도메인·관계 유형·최대 노드 수(기본 1,200, 최대 5,000)로 필터하며 관계는
30,000개에서 잘린다. 잘린 경우 화면에 그 사실을 표시한다.

ontology와 relation은 protocol v5의 local-derived state다. sync 직후 taxonomy
backfill이 끝나기 전에는 durable fact가 있어도 지도가 부분적으로 비어 있을 수 있고,
privacy purge 뒤에는 재분류 때문에 다시 대기로 보일 수 있다. 이는 오류가 아니다.
빈 결과와 오류는 같은 빈 화면으로 합치지 않는다.

## 점검 항목

1. 빈 DB에서 모든 화면이 오류 없이 열리고, DB 부재를 실제 부재로 표시한다.
2. 대화 → 기억 → 직접 근거와 해석 맥락이 분리된 채로 연결된다.
3. 공통 기억 / 프로젝트 / 전체 범위가 조회·상세·검색에서 동일하게 적용된다.
4. 관계 필터, 노드 선택, 상세 이동, 지도 PNG 내보내기가 동작한다.
5. 사용자 텍스트가 markup이나 script로 실행되지 않는다.
6. 잘못된 method·Origin·Content-Type·본문 크기·CSRF 토큰의 변경 요청이 거부된다.
7. 수정 → 비활성화 → 복원이 `dist/fact-management.js`를 통해 완료된다.
8. 종료 뒤 UI가 만든 서버·리스너·임시 파일이 남지 않는다.

## 로컬 보안

127.0.0.1 바인딩, Host/Origin 검증, 쓰기 CSRF, 경로 제한, escaped rendering/CSP를 적용한다. 인증·TLS·다중 사용자 격리 서비스가 아니므로 포트 포워딩/공개 배포를 하지 않는다. 로그 redaction은 best-effort다.

## API / 테스트

새 UI의 API namespace는 `/api/v2/`. `/bootstrap`에서 CSRF 토큰·코어 정보·스키마 가용성을 조회한다. DB가 없을 때는 실제 부재 상태를 표시한다. 없음/빈 결과/오류를 구분한다. 일부 기존 URL 별칭만 유지하므로 외부 비공개 API 소비자의 전체 호환은 별도 점검한다.

`node --test ui/test/*.test.cjs`로 fixture/HTTP/서비스 호출 계약을 점검한다. 실제 embedding/core 트랜잭션과 브라우저 GPU는 별도로 종단 검증해야 한다.
