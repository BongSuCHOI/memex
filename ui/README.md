# Memex Workspace UI

`node ui/server.cjs` — 기본 주소 `http://127.0.0.1:3847`.

기존 `memex-ui` bin을 유지하는 전체 UI입니다. 운영 실행에 추가 npm 패키지나 프런트엔드 빌드가 필요하지 않습니다. **기존 Memex의 의존성과 `npm run build` 결과는 필요합니다.**

- `lib/server.cjs`: loopback HTTP, API v2, CSRF, SSE, 정적 파일
- `lib/store.cjs`: 읽기 전용 조회와 프로젝트/워크스페이스/작업 흐름 범위
- `lib/core.cjs`: 기존 `dist/db.js`, `fact-management.js`, `pipeline-status.js` 연결 — 의미 수정과 계층 승격/강등(`promoteFact`/`demoteFact`, `actor: 'user'`) 모두 코어 서비스를 통과합니다
- `lib/logs.cjs`: 제한된 로그 tail, UI 감사 메타데이터
- `lib/operations.cjs`: 기존 CLI allowlist 실행, 취소, 출력 제한 (`doctor` · `status` · `sync` · `backfill *` · `recover --all-dead` · `facts migrate-tiers --dry-run|--apply`)
- `public/pages/`: 개요, 대화 원장, 기억·사실, 분류, 지도, 활동, 관리(런타임·관리 작업·동기화·화면 설정·진단)
- `public/help.mjs`: 도움말·툴팁·용어집 카탈로그 — 아무것도 import하지 않습니다(배지 툴팁 때문에 `ui.mjs`가 이 파일을 읽습니다)
- `public/guidance.mjs`: 실패 클래스 카탈로그 — 원인·영향·다음 행동·액션·무시 가능 여부 (단일 출처는 `docs/GUIDE.md` §20)
- `public/details.mjs`: 기억·대화·작업·모델 시도·Chronicle·관리 실행 상세
- `public/graph-engine.mjs`: 네이티브 WebGL, Canvas2D fallback

서버 환경 우선순위:

```text
core root: MEMEX_PLUGIN_ROOT > PLUGIN_ROOT > this repository
DB:        MEMEX_DB_PATH > TEST_DB_PATH > home/conversation-index/db.sqlite
home:      MEMEX_HOME > 명시된 DB에서 유도 > XDG_CONFIG_HOME/memex > ~/.config/memex
port:      PORT > 3847
```

`MEMEX_DB_PATH`(또는 `TEST_DB_PATH`)로 DB를 직접 지정하고 `MEMEX_HOME`을 지정하지 않으면 home은 그 DB 경로에서 유도합니다 — `<home>/conversation-index/db.sqlite`이면 `<home>`, 그 밖에는 DB가 들어 있는 디렉터리입니다. 이 UI가 쓰는 파일(`logs/ui-audit.jsonl`, `ui/operations.json`)은 항상 home 아래에 있으므로, 임시 DB를 가리킨 테스트가 실제 `~/.config/memex`에 기록을 남기지 않습니다. 테스트와 스크립트는 `MEMEX_HOME`(과 `XDG_CONFIG_HOME`)을 자기 임시 디렉터리로 명시하세요.

조회는 DB를 생성·마이그레이션하지 않고 모델 작업도 시작하지 않습니다. 작업 실행과 기억 변경은 명시적 확인 뒤 기존 코어 서비스를 사용합니다. 원문과 과거 로그는 민감할 수 있으므로 loopback 외부로 서비스하지 마세요.

테스트: `node --test ui/test/*.test.cjs` (Node >=22.15; fixture는 node:sqlite 사용). 테스트 파일은 운영 서버에서 import하지 않습니다.

상세: `../docs/WEBUI-WORKSPACE.md`.
