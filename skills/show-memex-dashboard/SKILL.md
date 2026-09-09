---
name: show-memex-dashboard
description: Launch or reuse the loopback Memex Workspace UI when the user asks to browse conversations, manage facts, inspect taxonomy or pipeline health, or explore the knowledge map.
---

# Show Memex Dashboard

Resolve `PLUGIN_ROOT` as two directories above this skill directory. The default
URL is `http://127.0.0.1:3847`; the `PORT` environment variable overrides the
port and the server always binds loopback only.

Before starting a process, inspect the port owner. Reuse it only when it is the
Memex server for this installed root. If another process owns the port, report
the conflict without terminating it.

Start a new server only when needed:

```bash
node "$PLUGIN_ROOT/cli/runtime-exec.js" memex-ui
```

The server is ready once it prints `Memex Workspace <version>`, the loopback URL
and the resolved `DB:` path.

Keep the process observable for clean shutdown. Open only the route relevant to
the request:

| 화면 | 경로 | 용도 |
| --- | --- | --- |
| 개요 | `/` | 범위 요약, 파이프라인 상태, 최근 기억 변화 |
| 대화 원장 | `/conversations` | 세션·턴 원문과 추출 근거 |
| 기억 | `/facts` | 기억 검색, 상세 패널에서 수정·비활성화·복원·삭제. 목록 행과 상세에 승격 상태가 한국어 이름으로 표시됩니다(`작업 흐름`·`워크스페이스` = 브랜치 계층, `프로젝트 현행` = 프로젝트 공용, 범위가 `공통 기억`이면 글로벌). `이전 방식 배치`(legacy-project)는 표시하지 않습니다. 계층 이동 버튼은 없습니다 — `memex facts promote\|demote`가 유일한 경로입니다 |
| 분류 | `/taxonomy` | 온톨로지 도메인과 주제 분류 |
| 지식 지도 | `/graph` | 기억 관계 지도 (2D Map / 3D Galaxy) |
| 활동 · 추적 | `/activity` | 처리 작업, 모델 시도, 변경 이력, 로그 |
| 관리 | `/settings` | 런타임, 관리 작업, 화면 설정, 진단 |

Scope is a query parameter on every route: no parameter means common (global)
memory, `?scope=all` reads every project plus common memory, and
`?scope=project&project=<encoded-canonical-absolute-cwd>` reads one project.
Conversations, activity and interpretive-context rows are not visible from the
global-only scope, so use `?scope=all` or a project scope for those.

Report the URL and exact process started or reused. Do not install dependencies,
register hooks/plugins, change facts, or expose the server beyond loopback merely
to show the dashboard.
