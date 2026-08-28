# Memex 설치 및 운영 가이드

이 문서는 공개 marketplace 등록부터 runtime 준비, 첫 동기화, CLI/MCP/UI 사용,
업데이트, 진단, 해제까지의 현재 Codex-native 운영 계약입니다.

## 1. 요구 사항과 설치 경계

- Node.js 22.15 이상
- 로컬 인증이 완료된 Codex CLI
- hook/Unix socket을 사용할 수 있는 macOS 또는 Linux

Memex는 native SQLite/vector/embedding 의존성을 사용합니다. Node에 포함된 `npx`가
`github:BongSuCHOI/memex#main`의 최신 runtime을 npm isolated cache에 준비합니다.
사용자 project를 clone/build하거나 global package를 설치하지 않습니다. Marketplace
main은 곧 runtime release channel이므로 검증된 code만 merge해야 합니다.

## 2. 권장 설치: repository marketplace

저장소 루트의 `.agents/plugins/marketplace.json`이 공식 marketplace입니다. 일반
사용자 설치는 다음 두 명령으로 끝납니다.

```bash
codex plugin marketplace add BongSuCHOI/memex
codex plugin add memex@memex
```

`plugin add`는 Codex cache에 manifest, MCP declaration, skills, hooks, UI, CLI를
설치합니다. dependency-free `cli/runtime-exec.js`가 MCP와 hook에서 공통으로 최신
runtime을 실행합니다. 첫 호출은 npm cache와 native dependency 준비 때문에 평소보다
오래 걸릴 수 있으므로 MCP manifest는 첫 준비를 위한 시작 제한을 300초로 설정합니다.

## Manual local marketplace

개발/기여/air-gapped validation에서는 checkout을 준비한 기존 외부 local marketplace
방식도 유지합니다. 이 절은 일반 사용자 설치 경로가 아닙니다.

```bash
git clone https://github.com/BongSuCHOI/memex.git
cd memex
npm ci
npm run build
```

```text
/absolute/path/memex-local-marketplace/
├── .agents/plugins/marketplace.json
└── plugins/
    └── memex -> /absolute/path/memex
```

`marketplace.json`:

```json
{
  "name": "memex-local",
  "interface": { "displayName": "Memex Local" },
  "plugins": [
    {
      "name": "memex",
      "source": { "source": "local", "path": "./plugins/memex" },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
```

```bash
codex plugin marketplace add /absolute/path/memex-local-marketplace
codex plugin add memex@memex-local

node scripts/install-memex.mjs \
  --marketplace /absolute/path/memex-local-marketplace \
  --dry-run

node scripts/install-memex.mjs \
  --marketplace /absolute/path/memex-local-marketplace
```

## 4. Codex 재시작과 최초 onboarding

설치 후 **Codex를 재시작**합니다. 이미 열린 session은 새 MCP server, skills, plugin
hooks를 다시 로드하지 않습니다.

첫 사용 전에 기존 Codex session history를 conversation → fact → ontology/vector
순서로 준비합니다. 터미널에서 `memex` CLI를 직접 쓰려면 플러그인 등록만으로는 PATH에
실행 파일이 생기지 않으므로, 다음 명령을 **한 번만** 실행해 영구 shim을 만듭니다:

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex setup --install-cli
```

`~/.local/bin/memex`가 생겨 이후 터미널에서 `memex`를 직접 실행할 수 있습니다.
전역 설치는 하지 않으며, PATH 누락 시 안내를 출력합니다. 제거는
`memex setup --uninstall-cli`(본 명령이 만든 파일만 삭제)입니다.

### Built-in Memory 충돌 점검

`memex setup`은 `codex features list`의 effective `memories` 상태를 읽습니다. 활성화된
경우 Codex built-in Memory와 Memex가 같은 prompt에 서로 다른 기억을 주입할 수 있는
double-memory/conflicting-memory 위험을 설명하고 OFF를 권장합니다.

- 대화형 terminal: `Disable Codex built-in Memory now? [y/N]`에서 승인한 경우만 OFF
- 비대화형 terminal: 상태만 보고하며 설정을 변경하지 않음
- 명시적 자동화 승인: `memex setup --disable-codex-memory`
- preview: `memex setup --dry-run`

승인된 변경은 TOML을 Memex가 직접 편집하지 않고
`codex features disable memories`로 수행하며, 다시 `features list`를 읽어 OFF를
검증합니다. 설정 변경 뒤 Codex를 재시작합니다.

```bash
memex sync
memex backfill all
memex status
memex status --json
```

- `sync`: `$CODEX_HOME/sessions` rollout을 읽고 archive/index/search corpus 생성
- `backfill all`: 각 backlog 단계를 순서대로 실행 — `extract`(durable fact 추출),
  `ontology`(fact 분류와 graph 구조 생성), `embeddings`(누락된 semantic vector 생성).
  단일 단계만 실행하려면 `memex backfill <extract|ontology|embeddings>` 사용
- `status`: conversation/fact/graph readiness와 pending count 확인

`backfill`은 기본적으로 foreground로 실행되어 완료가 직접 관측되고, 첫 실패 단계에서
멈춥니다(단계는 idempotent하므로 `memex backfill all`을 다시 실행해 이어갈 수
있습니다). 대화 기록이 많거나 local Codex model이 fact를 추출하는 경우 수분 이상
걸릴 수 있습니다. `--background`의 “started” 출력은 완료 증거가 아닙니다.
`memex status`의 pending count를 확인해야 합니다.

`sync`는 idempotent하므로 onboarding 이후 다시 실행해도 안전합니다.

## 5. Lifecycle hooks

Marketplace 설치의 기본은 `.codex-plugin/plugin.json`이 선언한
`./hooks.json`입니다.

| 이벤트 | 동작 | 실패 성격 |
| --- | --- | --- |
| SessionStart | version drift → background sync → sync import → bounded maintenance | 비동기, session 시작을 차단하지 않음 |
| UserPromptSubmit | scoped conversation/fact retrieval → relevance/dedup/budget → `additionalContext` | no-match는 무주입 |
| SessionEnd | rollout 안정화/main-thread 판정 → incremental extraction → export | 증거 없는 실패는 watermark를 전진시키지 않음 |

plugin manifest hook를 지원하지 않는 별도/구형 host에서만 explicit fallback을
사용합니다.

```bash
memex setup-hooks --dry-run
memex setup-hooks
memex doctor --json
```

fallback은 `$CODEX_HOME/hooks.json`의 fingerprinted Memex entry만 병합합니다.
`remove-hooks`는 exact owned entry만 제거하고 다른 hook를 보존합니다. Marketplace
plugin hooks와 fallback hooks를 동시에 활성화하지 마십시오.

UserPromptSubmit이 실제 fact를 주입하면 `session_id`, human prompt hash, fact IDs를
`recall_events`에 기록합니다. 이 receipt를 쓰지 못하면 context도 주입하지 않습니다.
Memex MCP retrieval tool call도 같은 `memex_recall` provenance로 분류됩니다.

trust는 “non-Memex”와 동의어가 아닙니다. call ID별 result를 다음처럼 분류합니다.

| 분류 | 기본 학습 |
| --- | --- |
| local file/read/grep observation | 허용 (project cwd 내부 + Memex 데이터 루트·Codex sessions·model workdir 밖일 때만) |
| bounded read-only Git history/status/diff | 허용 |
| 명시적 test command 결과 | 허용 |
| Memex MCP result | 금지 |
| network URL/curl/wget, unknown MCP/tool, generated output | 금지 |
| assistant conclusion | 금지 |

shell/exec 입력에 network command가 섞이면 전체 result를 안전하게
`external_unverified`로 분류합니다. generated artifact를 향후 허용하려면 source별
validator와 회귀 테스트를 먼저 추가하고 allowlist를 좁게 확장합니다.

allowlisted shell/exec도 command 이름만으로 신뢰하지 않습니다. exchange cwd, tool
`workdir`/`cwd`, `git -C`, `npm --prefix`, 관측 target을 canonicalize하고 symlink까지
해결한 뒤 모두 project cwd 내부일 때만 학습합니다. wrapper나 target이 불명확하거나
project 밖 경로, pipeline, redirect, command substitution이 있으면 fail-closed입니다.

경로가 증명되는 파일 관측이어도 대상이 `MEMEX_HOME`(archive/index/DB),
`$CODEX_HOME/sessions`, 임시 model workdir 안에 있으면 Memex 자료의 재독입(self
재섭취)이므로 `learnable=0`으로 강등합니다. project cwd 밖 경로나 대상을 특정할 수
없는 관측은 repository evidence로 인정하지 않습니다.

Codex의 unified `exec`처럼 한 tool result 안에 여러 내부 호출의 출력이 합쳐지고 각
출력의 원 source를 안정적으로 역매핑할 수 없는 surface는 기본적으로
`external_unverified/learnable=0`입니다. 개별 call ID가 있는 `read_file`, bounded
Git/test command처럼 source를 독립적으로 귀속할 수 있을 때만 allowlist가 적용됩니다.
따라서 하나의 Memex MCP call이 별도 sibling result를 taint하지는 않지만, provenance를
분해할 수 없는 composite result를 추측으로 학습시키지도 않습니다.

## 6. CLI 사용

```bash
memex search "인증 구조를 결정한 이유"
memex search --both "SQLite migration"
memex show /absolute/archive/path.jsonl
memex stats
memex analyze --top 30 --out ~/memex-report.md
```

Fact 관리:

```bash
memex facts list
memex facts list --project /absolute/project/path
memex facts list --scope all
memex facts show --id <uuid>
memex facts edit --id <uuid> --text "updated fact"
memex facts deactivate --id <uuid>
memex facts restore --id <uuid>
memex facts history --id <uuid>
memex facts delete --id <full-uuid> --hard --yes
```

기본 fact list는 global-only입니다. project path는 canonical absolute path여야 하며
`all`은 명시적으로만 허용됩니다. hard delete는 full UUID, `--hard`, `--yes`가
모두 필요합니다.

## 7. MCP와 skills

Codex를 재시작하면 `.mcp.json`의 `memex` server와 세 skills가 로드됩니다.

```text
search, read, search_facts, search_ontology, ask_avatar,
trace_fact, explore_graph, cross_project_insights, graph_stats
```

project-sensitive tool은 canonical absolute project 또는 명시적
`scope: global|all`을 요구합니다. server process cwd로 project를 추측하지
않습니다. 정확한 schema와 skill routing은
[MCP-AND-SKILLS.md](MCP-AND-SKILLS.md)를 참조합니다.

## 8. Web UI와 3D Galaxy

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex-ui
# http://localhost:3847
```

| URL | 역할 |
| --- | --- |
| `/` | project/conversation/search/exchange |
| `/facts` | fact/revision/provenance/mutation |
| `/graph?scope=global` | global facts 3D graph |
| `/graph?scope=project&project=/abs/path` | project + global graph |
| `/graph?scope=all` | 명시적 전체 graph |
| `/pipeline` | read-only readiness/backlog |

서버는 loopback에만 bind합니다. mutation은 same-origin POST JSON, content-type,
body-size guard를 통과한 뒤 CLI와 같은 transactional service를 사용합니다.

## 9. 저장소와 개인정보

```text
~/.config/memex/
├── conversation-archive/
└── conversation-index/
    ├── db.sqlite
    ├── logs/
    └── lifecycle-registration.json
```

우선순위: `MEMEX_HOME` → `MEMORY_BANK_HOME`(호환) → `MEMORY_BANK_CONFIG_DIR`
(호환) → `$XDG_CONFIG_HOME/memex` → `~/.config/memex`.

기존 설치가 여전히 `~/.config/memory-bank/`에 데이터를 두고 있다면 런타임은
그 디렉터리를 건드리지 않고 새 root를 바라봅니다. 데이터 이전은 명령어로
명시적으로 수행합니다:

```bash
memex migrate-home            # 감지된 legacy root에서 copy → verify → switch
memex migrate-home --dry-run  # 쓰기 없이 계획만 출력
memex home --json             # 해석된 data root 확인 (JSON)
```

마이그레이션은 source를 절대 삭제하지 않으며 SQLite integrity_check와
row-count 비교로 무결성을 검증한 뒤 receipts(`<new>/logs/home-migration.json`)를
남깁니다. 검증 완료 후 필요하면 수동으로 옛 디렉터리를 정리합니다.
이 namespace 규칙은 Claude runtime 호환 계층이 아닙니다. 원본 Codex rollout은
항상 read-only입니다.

## 10. 업데이트

```bash
memex update --dry-run
memex update
```

Git marketplace이면 snapshot을 먼저 upgrade하고, 현재 plugin을 remove/add해 skills,
hooks, MCP metadata를 최신화합니다. Local marketplace는 현재 source를 다시 읽습니다.
runtime launcher는 항상 최신 main을 대상으로 합니다. 완료 후 Codex를 재시작합니다.
Memex data는 보존됩니다. version drift guard는 같은 Memex cache namespace의 stale
background worker만 대상으로 합니다.

## 11. 진단

```bash
memex doctor --json
memex status --json
npm run test:marketplace
npm run test:package
node scripts/validate-plugin.mjs
```

- runtime dependency 실패: Node/npm network 접근과 npm cache 권한을 확인한 뒤 재시작
- plugin configured지만 observed 없음: Codex 재시작, hook trust, observation log 확인
- injection 없음: `injected|no-match|deduped|skipped|error` 상태 확인
- MCP 실패: 설치된 `.mcp.json`의 `startup_timeout_sec = 300`, `runtime-exec`, npm
  cache, packaged wrapper, 9-tool handshake 확인. MCP 전용 npm cache는
  `$XDG_CACHE_HOME/memex/npm-mcp`이며 미설정 시 `~/.cache/memex/npm-mcp`
- stale socket: 소유 process가 없는 Memex data-root socket만 제거
- project 충돌: `memex migrate-projects --dry-run`의 evidence/count/backup 확인
- `--repair` 실패: 성공한 file은 유지되지만 하나라도 재색인에 실패하면 실패 경로를
  출력하고 non-zero로 종료합니다. 원인을 수정한 뒤 같은 명령을 재실행합니다.

Codex CLI 0.149.1에는 formal `plugin validate` subcommand가 없습니다.
`scripts/validate-plugin.mjs`는 isolated marketplace/cache/MCP/skills/hooks/UI/cleanup
계약을 검증하는 version-bound substitute이며 formal validator로 부르지 않습니다.

## Uninstall and data retention

Marketplace plugin hooks는 plugin 제거와 함께 사라집니다. explicit fallback을 사용한
경우에만 먼저 owned hook를 제거합니다.

```bash
memex remove-hooks --dry-run
memex remove-hooks
codex plugin remove memex@memex --json
codex plugin marketplace remove memex --json
```

외부 marketplace를 썼다면 실제 이름으로 selector를 바꿉니다.

```bash
codex plugin remove memex@memex-local --json
codex plugin marketplace remove memex-local --json
```

기본 해제는 `$CODEX_HOME/sessions`와 Memex data root를 보존합니다. derived data
삭제가 필요하면 환경변수 해석 결과와 exact path를 먼저 확인한 뒤 별도 수행합니다.

### 데이터 삭제 가이드

plugin 제거만으로는 데이터가 남습니다. 완전히 삭제하려면 아래 순서를 따릅니다.

먼저 실제 데이터 위치를 확인합니다. `MEMEX_HOME`, `MEMORY_BANK_HOME`,
`MEMORY_BANK_CONFIG_DIR` 중 설정된 값이 우선 적용됩니다(과거 변수는 하위 호환용
read-only fallback).

```bash
memex home            # 현재 data root exact path 출력
memex home --json
```

Memex가 생성하는 데이터는 모두 이 data root 안에 있습니다:

- `memex.db` — 관측·facts·graph 등 파생 SQLite DB (재구성 가능)
- `archives/` — rollout에서 유래한 원문 스냅샷 (재구성 가능)
- `logs/` — 백필 수행 기록, migration receipts (재구성 가능)
- Web UI 소켓/임시 파일

전체 삭제(복구 불가, 재동기화 시 처음부터 다시 추출):

```bash
memex doctor          # 종료 전 상태 점검(선택)
rm -rf "$(memex home)"
```

부분 삭제:

- derived SQLite index만 초기화하고 원문·sync state 보존 → data root 안의 실제 DB
  path만 삭제. 다음 `memex sync`가 unchanged archive/source rollout까지 다시 index하고,
  다음 SessionStart가 facts/revisions/tombstones/recall receipts를 sync JSONL에서 import한 뒤
  maintenance/backfill이 local processing state를 재생성합니다. `extraction_log`와
  `needs_consolidation`과 consolidation attempt는 local 처리 상태이므로 sync하지 않습니다.
  imported active fact는 local dirty queue에 새로 등록됩니다.
- 특정 프로젝트의 facts만 제거 → scope를 지정해 CLI/MCP delete 계열 도구 사용
  (근원 rollout은 건드리지 않음). 세부 방법은 `docs/FACT-LIFECYCLE.md` 참조.

주의사항:

- **삭제 대상은 Memex 파생 데이터뿐**입니다. `$CODEX_HOME/sessions` rollout은
  절대 삭제·수정하지 않습니다(원본 대화 기록이며 Memex의 유일한 근원).
- legacy 경로(`~/.config/memory-bank`)를 쓰던 설치는 `memex home`이 해당 폴더를
  가리킬 수 있습니다. 반드시 출력된 exact path만 삭제하고, 이후 정리는 수동으로
  판단합니다(`memex migrate-home` 후 남은 구폴더 포함).
- dry-run 없이 되돌릴 수 없으므로, 필요 시 사전에 data root 폴더를 통째로 백업합니다.
