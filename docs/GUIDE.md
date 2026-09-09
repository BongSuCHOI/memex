# Memex 설치 및 운영 가이드

이 문서는 처음 설치하는 사용자와 repository 기여자가 Memex를 안전하게 운영하는 데 필요한 현재 절차만 설명합니다.

빠른 이동: [문제가 생겼을 때 — 실패 클래스별 복구](#20-문제가-생겼을-때--실패-클래스별-복구) · [CLI 한눈에 보기](#18-cli-한눈에-보기) · [환경 변수](#19-환경-변수) · [기억 계층과 승격](#7-fact-관리)

## 1. 요구 사항

- Node.js 22.15 이상
- 로컬 인증이 완료된 Codex CLI
- macOS 또는 Linux
- plugin hook과 Unix socket을 사용할 수 있는 환경

Memex는 native SQLite/vector/embedding 의존성을 사용합니다. 일반 설치에서는 source checkout을 직접 build하거나 global package를 설치할 필요가 없습니다.

## 2. 권장 설치

```bash
codex plugin marketplace add BongSuCHOI/memex
codex plugin add memex@memex
```

plugin은 manifest, MCP declaration, 3개 skills, hooks, UI launcher를 Codex cache에 설치합니다. 설치 절차가 production dependencies를 materialize한 뒤 `cli/runtime-exec.js`는 동일한 설치 artifact의 로컬 binary를 우선 실행합니다. 아직 materialize되지 않은 raw plugin registration만 `github:BongSuCHOI/memex#main`을 `npx` isolated cache에서 실행하는 compatibility fallback을 사용합니다.

첫 실행은 native dependency와 npm cache 준비로 평소보다 오래 걸릴 수 있습니다. MCP manifest는 이를 고려해 startup timeout을 넉넉하게 둡니다.

### 개발용 local marketplace

repository 자체를 수정하거나 air-gapped validation을 할 때만 local checkout을 사용합니다.

```bash
git clone https://github.com/BongSuCHOI/memex.git
cd memex
npm install
npm run build
```

이 경로는 일반 사용자 설치 절차가 아닙니다.

## 3. CLI shim과 Codex Memory 충돌 점검

터미널에서 `memex` CLI를 직접 사용하려면 한 번만 shim을 설치합니다.

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex setup --install-cli
```

기본 위치는 `~/.local/bin/memex`입니다. 제거는:

```bash
memex setup --uninstall-cli
```

`memex setup`은 Codex built-in Memory의 effective 상태를 확인합니다. Memex와 built-in Memory가 동시에 같은 prompt에 다른 기억을 주입할 수 있으므로, 사용자는 필요하면 explicit approval로 built-in Memory를 비활성화할 수 있습니다.

```bash
memex setup --dry-run
memex setup --disable-codex-memory
```

설정 변경 후에는 Codex를 재시작합니다.

## 4. 최초 onboarding

Codex를 재시작한 뒤 기존 session history를 준비합니다.

```bash
memex sync
memex backfill all
memex status
memex status --json
```

- `memex status` — 단계별 준비 상태. 격리된 프로젝트가 있으면 `Quarantined projects: N` 줄과
  프로젝트 ID·표시 이름·fact 수를 함께 출력합니다(0.6.0 #38: `/`처럼 신뢰할 수 없는 cwd에서 생긴
  프로젝트. fact는 보존하고 주입·조회 범위에서만 제외합니다).
  - Ontology 줄은 `Ontology: READY|PENDING (N classified, P parked, Q pending)` 형태이고
    `pending`이 0일 때만 `READY`입니다(0.6.1 #41).
    `parked`는 분류 시도를 소진해 General/Misc에 보관 중인 fact이며 **classified가 아닙니다**.
    이전에는 이것이 classified로 집계되어 pending을 0으로 만들었습니다. parked fact는 분류
    정책/embedding 세대당 정확히 한 번 다시 시도됩니다(`memex backfill ontology`).
  - `facts without local evidence: N / M` 줄은(0.6.1 #45) 로컬 의미 검증 영수증이 없는 활성 fact
    수입니다. 그 fact들은 자동 통합 대상에서 제외되며(사용자에게는 "중복 fact가 계속 쌓인다"로
    보입니다) `memex backfill receipts`로 재구성합니다. 동기화와의 관계는 **한 방향**입니다:
    영수증은 sync 충돌 판정에 들어가지 않고, 반대로 peer의 semantic win이 로컬 영수증을
    `peer-authority`로 강등시켜 그 fact의 통합을 막습니다(아래 `backfill receipts` 항목 참고).
  - `Derived lanes: skipped N times (reason: continuity backlog)` 줄이 보이면(0.6.1 #43) P0/P1
    (capture index / Work Capsule) 백로그 때문에 하위 레인 4개(consolidation, re-embed, ontology,
    extraction)가 그 세션에서 건너뛰어진 것입니다. "왜 pending이 안 줄지"의 답이 완전히 다른
    파이프라인에 있을 때 이 줄이 그것을 이어줍니다. 같은 사유의 **3번째 연속 호출에서** 하위 레인을
    한 번 통과시키고 연속 카운터를 0으로 되돌립니다 — 앞의 두 번은 P0/P1이 이깁니다(우선순위는
    유지, 기아는 방지). 백로그 자체는
    `memex jobs list --state retry` / `memex recover`로 해소합니다.
  - `Memory jobs: N (state=…, …)` 줄과 그 아래 kind별 줄은(0.6.1 #46) `memory_jobs`를 kind × state로
    집계한 것입니다. `Needs attention`의 dead/retry는 이 표의 부분집합입니다. `--json`에서는
    `jobs.total` · `jobs.byKind` · `jobs.byState`로 같은 값을 읽습니다([§15](#작업이-실패했을-때-terminal-상태-복구)).
  - 0.6.1이 `memex status --json`에 더한 키: `evidence`(`factsWithoutLocalEvidence` ·
    `activeFactsWithSources`), `jobs`, `derivedLaneSkips`(`reason` · `consecutive` · `totalSkips` ·
    `lastSkippedAt` · `lastForcedAt`, 한 번도 건너뛴 적이 없으면 `null`), 그리고 `ontology`에 붙은
    `parkedFacts` · `parkedRetryable` · `indexRepair`.
  - `ontology category index: MANUAL REPAIR REQUIRED (...)` 줄이 보이면 category vector index가
    self-heal로 고칠 수 없는 상태이며 분류가 멈춰 있습니다. `memex backfill embeddings`로 vector를
    재생성하십시오. 같은 상태는 `memex doctor`의 `ontology-index` check가 FAIL로 보고합니다.
- `memex sync` — `$CODEX_HOME/sessions` rollout을 archive/index/search corpus로 반영
- `memex backfill extract` — durable fact 추출
- `memex backfill ontology` — local ontology/relation 생성
- `memex backfill embeddings` — 누락된 semantic vector 생성
- `memex backfill receipts` — 누락된 로컬 의미 검증 영수증(`fact_evidence_receipts`) 재구성.
  model 호출이 없습니다(0.6.1 #45). 한 번에 기본 1,000건까지 훑으므로(`BACKFILL_RECEIPTS_MAX`)
  백로그가 크면 `facts without local evidence`가 0이 될 때까지 반복 실행하십시오.
  영수증이 없는 fact는 자동 통합에서 제외되므로,
  `memex status`의 `facts without local evidence: N / M` 줄이 0이 아니면 이 단계를 돌리십시오.
  (`memex status`와 `memex backfill --help`는 이 상태를 "lose sync tie-breaks"라고도 표현하지만,
  실제 sync 충돌 판정은 `semantic_updated_at`과 내용 키만 봅니다 — 영수증을 읽는 코드 경로는
  없습니다. 영향을 주는 방향은 sync → 영수증 강등 → 통합 차단입니다.)
- `memex backfill all` — 위 backlog 단계를 순서대로 실행

`backfill`은 기본 foreground 실행이며 다음 exit code를 반환합니다.

- `0` — 처리 가능·실행 중·미해결 작업이 모두 없음
- `2` — worker는 정상 종료했지만 재시도 가능한 backlog, active extraction claim 또는 terminal extraction failure가 남음
- `1` — worker 실패. 첫 실패 단계에서 이후 실행을 중단

`2`일 때 CLI는 `completed with deferred work` 또는 outstanding work와 선택한 단계별 실행 후 건수를 출력합니다. 각 단계 수치는 extraction session, ontology fact/relation target, category/fact/Korean-fact/exchange vector를 worker selector로 센 실행 직후 스냅샷입니다. `--background`의 “started” 출력은 완료 증거가 아닙니다. 구조화된 pipeline 상태는 `memex status --json`으로 확인하십시오. 모든 단계는 idempotent하므로 다시 실행할 수 있습니다.

extract 단계에서 세션 선점이 실패하면 워커는 사유를 구분해 출력합니다. exit code 의미는 동일하며(재시도 가능한 backlog가 남으므로 `2`), 구분되는 것은 보고입니다.

- `HANDOFF (lease held by another runner)` — 다른 러너가 같은 partition의 lease를 쥐고 있음. 실패가 아니며 그 러너가 끝내면 진행됩니다.
- `DEFERRED (retry backoff until <ISO>)` — 러너는 없고 재시도 backoff만 남은 상태. 표시된 시각 이후에 다시 선정됩니다. 요약줄의 `backoff-deferred N`과 `memex status`의 `N backoff` / `earliest retry <ISO>`가 같은 큐를 셉니다(모두 `pending`의 내역이며 terminal `deferred`와 다릅니다).
- `SKIPPED (attempt cap reached)` — 시도 상한 도달. exact range가 failed-visible로 기록되며 운영 점검 대상입니다.

### Ontology taxonomy 수리 (0.6.1 #47)

0.6.1 이전 taxonomy는 append-only였습니다 — merge도 rename도 delete도 없어서, 근사 중복 category
(`Auth` / `Authentication` / `AuthN`)가 생기면 온톨로지 전체를 날리는 것 외에 방법이 없었습니다.
(이 classifier는 과거에 category 1,612개 ≈ 95K 토큰까지 번진 적이 있습니다.)

```bash
memex ontology list [--json]                                        # id / domain / category
memex ontology merge <from-category-id> <to-category-id> --dry-run  # 계획만
memex ontology merge <from-category-id> <to-category-id>            # fact 재지정 + 원본 삭제
memex ontology rename <category-id> "Authentication"                # label만 변경
```

- `merge`는 `from`의 모든 fact를 `to`로 옮기고 `from` 행과 그 vector를 삭제합니다.
- `rename`은 fact 할당을 유지하고 category vector만 무효화합니다 — `memex backfill embeddings`(또는
  다음 분류의 self-heal)가 새 label로 다시 임베딩합니다. 같은 domain에 이미 있는 이름으로는 거부되며
  merge를 안내합니다.
- 둘 다 fact 의미를 건드리지 않습니다: Chronicle 이벤트 없음, semantic/lifecycle generation bump 없음,
  attempt ledger reset 없음, taxonomy epoch bump 없음. `logs/ui-audit.jsonl`에 metadata 한 줄만 남습니다.

0.6.1부터 domain 이름과 domain 내 category 이름에 unique index가 생기고, 기존 대소문자 중복은 DB를
열 때 자동 병합됩니다(가장 오래된 행 유지). 무비용 결정론적 재사용 레인은 `MEMEX_ONTOLOGY_DET_GATE`를
설정하지 않으면 꺼져 있습니다(기본 `+Infinity`).

### KR translation은 별도 수동 단계

`fact_kr`는 local derived state이며 `backfill all`에 포함되지 않습니다. SessionStart마다 번역 LLM을 자동 실행하지 않습니다.

원할 때 다음을 실행합니다.

```bash
node scripts/translate-facts.mjs
```

스크립트는 batch cardinality/type을 검증하고 fact의 semantic generation/text가 바뀌지 않은 경우에만 번역을 저장합니다.

- 이 실행으로 `fact_kr`가 채워집니다.
- `vec_facts_kr`는 이후 reembed maintenance 또는 다음 SessionStart에서 생성됩니다.

한국어 fact vector가 즉시 필요하다면 번역 실행 후 maintenance/reembed가 한 번 실행됐는지 확인하십시오.

## 5. Lifecycle hooks

| 이벤트 | 주요 동작 | 성격 |
| --- | --- | --- |
| SessionStart(startup/resume) | session/workstream restore, queue recovery, version/sync/import/maintenance | continuity resolve는 sync, 나머지는 독립 async |
| SessionStart(clear/compact) | 새 `context_epoch`; compact는 Capsule/tail baton/current revisions 즉시 복원 | 새 retrieval/model 대기 없음 |
| UserPromptSubmit | scoped retrieval, relevance/dedup/budget, recall receipt, `additionalContext` | no-match는 무주입 |
| Stop | incremental journal append + closed fence + outbox | 3초 timeout, model/embedding 0 |
| Interrupt | incremental journal append + interrupted/open fence | 3초 timeout, 완료 처리 금지 |
| PreCompact(manual/auto) | fsync + immutable prefix checkpoint + carry freeze + outbox | 5초 timeout |
| PostCompact(manual/auto) | telemetry/diagnostics only | correctness 비의존, 3초 timeout |
| SessionEnd | final delta + final fence + outbox, 그리고 **별도 async** 크로스디바이스 export | fence는 3초 timeout·foreground extraction 없음. export는 async 항목이라 세션을 붙잡지 않고, 동기화가 꺼져 있거나(기본) 마지막 export 이후 durable 변경이 없으면 즉시 no-op |

Capture가 만든 durable queue의 우선순위는 `capture_index`(P0) → `capsule_update`(P1) → fact extraction(이후)입니다. Stop/Interrupt boundary 6개 또는 8KiB, PreCompact, SessionEnd에서 Capsule job을 coalesce합니다. Capture hook은 commit 뒤 detached worker를 깨우지만 완료를 기다리지 않으며, wake 실패나 expired lease는 다음 startup/resume에서 복구합니다.

구형/별도 host에서 plugin-managed hook를 사용할 수 없을 때만 explicit fallback을 사용합니다.

```bash
memex setup-hooks --dry-run
memex setup-hooks
memex doctor --json
```

plugin hooks와 fallback hooks를 동시에 활성화하지 마십시오.

## 6. 검색과 분석

```bash
memex search "인증 구조를 결정한 이유"
memex search --text "SQLITE_BUSY"          # 정확한 문자열만 (SHA·에러 코드)
memex search --vector "SQLite로 옮긴 이유"   # 의미 검색만
memex show /absolute/archive/path.jsonl
memex stats
memex analyze --top 30 --out ~/memex-report.md
```

`memex search`의 mode 플래그는 `--vector`(의미만), `--text`(정확한 문자열만), `--both`(hybrid를 명시)
셋이고, 아무것도 주지 않으면 hybrid가 기본입니다. 인자를 두 개 이상 주면 multi-concept AND 검색이며,
인식하지 못한 `--` 옵션은 검색어로 삼지 않고 exit `1`로 거절합니다(#46).

project-sensitive 명령과 MCP tool은 canonical absolute project 또는 explicit scope를 사용합니다. server process cwd를 project로 추측하지 않습니다.

## 7. Fact 관리

```bash
memex facts list
memex facts list --project /absolute/project/path
memex facts list --scope all
memex facts list --all                    # 비활성 fact까지 포함
memex facts list --limit 50 --offset 100  # 페이지 단위 조회
memex facts show --id <uuid>
memex facts edit --id <uuid> --text "updated fact"
memex facts deactivate --id <uuid>
memex facts restore --id <uuid>
memex facts history --id <uuid>
memex facts tier <id>
memex facts promote <id> --reason "team agreed"
memex facts demote <id> --reason "branch only"
memex facts migrate-tiers --dry-run
memex facts migrate-tiers --apply
memex facts delete --id <full-uuid> --hard --yes
```

| 명령 | 하는 일 |
| --- | --- |
| `memex facts tier <id>` | 그 기억의 현재 tier(`workstream`/`project`/`global`)와 판단 근거(`tier_reason`) 조회 |
| `memex facts promote <id>` | 사다리 한 칸 위로. Chronicle `PROMOTED`(actor `user`) + `logs/ui-audit.jsonl` 한 줄 |
| `memex facts demote <id>` | 사다리 한 칸 아래로. Chronicle `DEMOTED`(actor `user`) |
| `memex facts migrate-tiers --dry-run` | 0.6.0 기본 tier 규칙대로면 프로젝트 공용이어야 하는 기존 `workstream` fact 목록만 출력(변경 없음) |
| `memex facts migrate-tiers --apply` | 위 목록을 `project-current`로 이동. fact마다 Chronicle `PROMOTED`(actor `migration`, reason `no-branch-signal`) 한 건 |

- 사다리는 `workstream ⇄ project ⇄ global`이며 **한 칸씩만** 움직입니다. 두 칸을 요구하면
  `TierStepError`(`tier ladder moves one step at a time: … is not adjacent`)로 거절되고 기억은 그대로
  남습니다. `--to workstream|project|global`로 목적지를 명시할 수 있지만 인접하지 않으면 같은 이유로
  거절됩니다. `--reason`은 Chronicle에 사용자 진술로, `--json`은 이동 결과와 이벤트 ID를 기계가 읽을 수
  있게 출력합니다. CLI의 이동은 actor `user`이므로 `logs/ui-audit.jsonl`에도 한 줄이 남습니다.
- 이동하면 `facts.tier_reason`은 추출 시점의 브랜치 신호 대신 `tier:user` / `tier:auto` /
  `tier:user-directive`로 덮어써집니다 — "지금 이 계층에 있는 이유"를 담는 컬럼입니다.
- 근거 기반 자동 승격·강등은 세션 시작 유지보수 단계에서 모델 호출 없이 SQL로만 판정합니다.

- `memex facts list`는 기본적으로 **활성 fact만** 보여줍니다. `restore`할 대상을 찾으려면
  `--all`이 필요합니다 — 비활성 fact는 이 플래그 없이는 목록에 뜨지 않습니다. `--limit`/`--offset`으로
  페이지를 넘깁니다.
- `memex facts edit --source-exchange <id>`는 수정의 근거가 되는 exchange를 명시합니다.
- edit는 revision과 semantic derived-state invalidation을 하나의 transaction으로 처리합니다.
- deactivate/restore는 의미 편집과 독립적인 lifecycle event입니다.
- hard delete는 full UUID, `--hard`, `--yes`가 모두 필요합니다.
- `migrate-tiers`는 `--dry-run` 또는 `--apply` 중 하나가 반드시 필요하며 자동 실행되지 않습니다. `--json`을 붙이면 후보와 적용 결과를 JSON으로 출력합니다.

## 8. MCP와 skills

Codex 재시작 후 `.mcp.json`의 `memex` server와 세 skills가 로드됩니다.

```text
search
read
search_facts
search_ontology
ask_avatar
trace_fact
explore_graph
cross_project_insights
graph_stats
```

세부 schema와 routing은 [MCP-AND-SKILLS.md](MCP-AND-SKILLS.md)를 참조하십시오.

## 9. Web UI

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex-ui
# http://127.0.0.1:3847  (PORT로 변경)
```

| URL | 역할 |
| --- | --- |
| `/` | 개요: 파이프라인 준비 상태, 최근 기억 변화, 활동 |
| `/conversations` | 대화 원장: 세션, 대화 턴, 원문 |
| `/facts` | 기억: fact, revision, 직접 근거와 해석 맥락, 변경 |
| `/taxonomy` | 분류: ontology domain/category |
| `/graph` | 지식 지도: WebGL 2D/3D 관계 그래프 (Canvas2D fallback) |
| `/activity` | 활동·추적: Chronicle, 작업, 모델 시도, 주입, 로그, 관리 실행 |
| `/settings` | 관리: 런타임, 관리 명령, 화면 설정, 진단 |

범위는 화면 상단에서 명시적으로 선택하며 query에도 그대로 반영됩니다:
`scope=global`, `scope=project&project=/abs/path`, `scope=all`.

UI server는 127.0.0.1에만 bind하고 Host/Origin을 검사합니다. 변경 요청은 same-origin
POST JSON과 CSRF 토큰, service-level validation을 통과해야 하며 코어의
`fact-management` 트랜잭션을 그대로 사용합니다.

자세한 내용은 [WEBUI-WORKSPACE.md](WEBUI-WORKSPACE.md)를 참고하세요.

## 10. 저장 위치와 sync

기본 data root:

```text
~/.config/memex/
├── lifecycle-registration.json         # 명시적 fallback hook 등록 기록
├── conversation-archive/
│   └── <project>--<hash>/              # 보관된 rollout(.jsonl)과 요약
├── conversation-index/
│   ├── db.sqlite                       # (+ -wal, -shm)
│   ├── exclude.txt
│   ├── inject-daemon.sock
│   ├── logs/
│   │   └── inject-context.jsonl        # (+ .old, 5 MB에서 회전)
│   ├── state/
│   │   └── inject-ledger/
│   ├── sync/
│   │   ├── export-status.json
│   │   └── devices/<device>/CURRENT, generations/<id>/
│   └── *.lock, *.log                   # backfill / consolidate / reembed 워커
├── sync/
│   └── config.json                     # 크로스디바이스 동기화 on/off + 공유 폴더 (기본 off)
├── journals/<session>/<epoch>.jsonl    # rolling transcript 저널
├── run-locks/
├── ui/
│   └── operations.json
└── logs/
    ├── hook-events.jsonl
    └── ui-audit.jsonl
```

`logs/ui-audit.jsonl`은 Web UI와 코어의 변경·복구·관리 실행 감사 메타데이터이고(`memex facts promote/demote`, `memex recover`, `memex jobs retry`, `memex jobs dismiss`도 여기에 한 줄씩 남깁니다), `ui/operations.json`은 Web UI가 실행한 관리 명령의 메타데이터입니다. 둘 다 원문·출력이 아니라 메타데이터만 남깁니다. `logs/hook-events.jsonl`은 관측된 lifecycle hook의 이벤트 이름·시각만, `conversation-index/logs/inject-context.jsonl`은 retrieval 1건당 상태·건수·소요 시간만 기록합니다.

`conversation-archive/`와 `journals/`에는 실제 대화 원문이 들어 있습니다. `run-locks/`, `*.lock`, `inject-daemon.sock`은 실행 중 파일이며 백업 대상이 아닙니다.

우선순위:

```text
MEMEX_HOME
→ XDG_CONFIG_HOME/memex
→ ~/.config/memex
```

DB path는 별도로 `MEMEX_DB_PATH`가 우선할 수 있습니다.

확인:

```bash
memex home
memex home --json
```

### 두 번째 맥 설정 절차 (크로스디바이스 동기화)

크로스디바이스 동기화는 **기본 off**입니다. 켜기 전에는 아무것도 기기 밖으로 나가지 않습니다.

```bash
# 1) 두 기기 모두: 본인 계정의 공유 폴더를 지정하고 켠다
memex sync enable --dir ~/Library/Mobile\ Documents/com~apple~CloudDocs/memex-sync
memex sync status            # 공유 폴더·쓰기 가능 여부·이 기기 id·다른 기기 목록

# 2) 첫 기기: 첫 세대를 내보낸다
memex sync export

# 3) 두 번째 기기: 가져온다 (SessionStart에서도 자동으로 실행됩니다)
memex sync import
memex sync status
```

- **공유 폴더 지정 순서**: `MEMEX_SYNC_DIR` → `memex sync enable --dir`로 저장한 값 →
  기존 로컬 기본값 `<data root>/conversation-index/sync`. 지정하지 않으면 0.6.0까지와 같은 경로입니다.
- **on/off 스위치**는 data root의 `sync/config.json`에 저장됩니다. 공유 폴더가 아니라 **기기 로컬**
  상태이므로 다른 기기의 스위치를 건드리지 않습니다. off일 때 export 훅·유지보수 export·SessionStart
  import은 모두 stderr 한 줄만 남기고 끝납니다.
- **자동 export 시점**: SessionEnd(별도 async 항목)와 자동 유지보수 wake. 두 경우 모두
  "마지막 성공 export 이후 durable 변경이 있을 때만" 세대를 만듭니다(빈 세대 방지).
  변경이 없어도 강제로 내보내려면 `memex sync export --force`.
- **원자성**: 세대는 임시 디렉터리에 payload를 먼저 쓰고 `meta.json`을 **마지막에** 쓴 뒤
  rename으로 공개합니다. 클라우드가 파일 단위로 업로드하는 중에 관측되더라도 `meta.json`이 없거나,
  있으면 이미 완전한 payload를 가리킵니다. `CURRENT`가 새 세대를 가리키는 순간이 commit point입니다.
- **로컬 재생성 항목**: 대화 원문·아카이브, KR 번역, ontology·관계, 벡터는 전송되지 않고 각 기기가
  다시 만듭니다.
- **평문 주의**: 공유 폴더의 기억은 평문 JSONL입니다. 암호화는 범위 밖이므로 **본인 계정의
  클라우드/드라이브만** 공유 폴더로 사용하십시오.

### Sync에 포함되는 것

protocol v5는 durable facts/revisions/tombstones/recall receipts만 sync합니다. KR translation, ontology, relation, vectors는 각 기기가 자체 rebuild합니다.

기억 계층(#18/#19)은 **전부** 전송됩니다(0.6.1, #37/#48 결정 3).

| 계층 | 전송 | 받는 기기에서 |
| --- | --- | --- |
| 글로벌 | 예 | 어디서나 주입 |
| 프로젝트 공용 (`legacy-project`·`project-current`·`decision`) | 예 | 해당 프로젝트에서 주입 |
| `workspace` | 예 (`workspace_id` 그대로) | 주입 안 됨 — workspace id는 기기 로컬 UUID |
| `workstream`(브랜치) | 예 (`workstream_id`·`tier_reason`·`workstream_branch`) | 같은 프로젝트의 같은 브랜치일 때만 주입 |

`workstream_id`는 `hash(project_id, branch)`로 결정되므로 다른 맥에서 같은 브랜치를 열면 같은 id가
나오고, 브랜치 기억이 브랜치 tier 그대로 되살아납니다. 0.6.0까지는 브랜치 tier fact가 export에서
빠지면서 그 삭제 기록(tombstone)만 전송되는 비대칭이 있었습니다(#37). 이제 모든 promotion state가
전송되므로 tombstone과 fact가 같은 모집단을 가리킵니다.

import는 로컬 writer와 같은 불변식을 강제합니다: `project-current` / `decision`으로 승격된 fact는
`workspace_id`·`workstream_id`가 NULL로 강제되고, 이 버전이 모르는 `promotion_state`는
`legacy-project`로 조용히 바뀌는 대신 malformed row로 보고되어 그 generation 전체가 거부됩니다.
protocol v4 generation은 계속 읽습니다. v4 피어는 v5 generation을 **거부**합니다(잘못 읽는 대신
실패하도록 버전을 올렸습니다) — 두 기기를 모두 0.6.1로 올린 뒤 sync가 재개됩니다.

## 11. DO NOT INDEX와 재분류 비용

conversation exclusion이 적용되면 해당 conversation에서 유래한 Memex searchable/model-derived state를 purge합니다. private-derived taxonomy가 남지 않도록 taxonomy를 전면 invalidate하므로 surviving public facts도 ontology pending으로 돌아갑니다.

따라서 다음 ontology backfill에서 분류 LLM 호출이 다시 발생할 수 있습니다. worker는 bounded batch/run으로 처리하며, 이는 privacy correctness를 위해 의도된 비용입니다.

## 12. 업데이트

```bash
memex update --dry-run
memex update
memex update --marketplace <name>     # Memex 설치가 둘 이상일 때 하나를 지정
memex update --no-materialize         # 의존성 materialize를 건너뛰고 명령만 안내
```

Git marketplace에서는 marketplace snapshot을 갱신하고 plugin cache를 다시 설치합니다. Memex data root는 보존합니다. 완료 후 Codex를 재시작하십시오.

`codex plugin add`는 새 버전을 **비어 있는** cache 디렉터리에 풀어놓기 때문에, 업데이트 직후에는
설치본에 `node_modules`가 없어 모든 hook이 다시 `npx github:BongSuCHOI/memex#main`(고정 버전 아님)
폴백으로 돌아갑니다. 그래서 `memex update`는 재설치 성공 직후 새 plugin root에서
`memex deps materialize`를 자동 수행합니다(`--no-materialize`면 실행 대신 명령만 출력).

## 13. 진단

```bash
memex doctor --json
memex status --json
node scripts/validate-plugin.mjs
node scripts/install-e2e.mjs
node scripts/marketplace-e2e.mjs
node scripts/package-runtime-e2e.mjs
node scripts/lifecycle-e2e.mjs
```

`memex doctor`가 출력하는 점검 항목은 다음 순서로 **항상 11개**이고, `ontology-index`는 repair
marker가 있을 때만 추가되어 최대 12개입니다. 하나라도 `FAIL`이면 전체가 `FAIL`이고 exit code는 `1`,
전부 `ok`면 `PASS`, 그 밖에는 `PARTIAL`입니다.

| 점검 | ok / warn / fail |
| --- | --- |
| `dependencies` | 설치된 plugin root의 `better-sqlite3`·`@xenova/transformers`·`sqlite-vec` 존재 여부. 없으면 fail. 어떤 root를 봤는지와 그 해석 경로(`env`/`codex-cache`/`codex-plugin-list`/`launcher`)를 detail에 함께 출력합니다 |
| `build` | plugin root의 `dist/db.js` 존재 여부 |
| `codex-home` | `CODEX_HOME` 디렉터리 존재 여부 |
| `lifecycle-configured` | 7개 hook event 전부 활성이면 ok, 일부면 warn, 전무하면 fail |
| `lifecycle-observed` | 모든 event를 최소 1회 관측했으면 ok, 아니면 warn |
| `inject-output` | 최근 20줄의 마지막 상태. `error`/`receipt-failed`면 fail, 창 안에 `receipt-failed`가 섞이면 warn |
| `recall-provenance` (0.6.0) | 발행 건수와 `recall_events` 행 수 비교. 발행이 있는데 영수증이 0이면 fail, 모자라면 warn |
| `injection-yield` (0.6.0) | fact 0개 주입이 8회 이상 연속이고 창의 주입 합이 0이면 warn. 리터럴 레인이 죽어도 warn |
| `hook-trust` | 등록된 event 전부가 trust를 가지면 ok, 아니면 warn (fail 없음) |
| `mcp-manifest` | `.codex-plugin/plugin.json` 존재 여부 |
| `ontology-index` (0.6.1, 조건부) | `ontology_index_repair_state`에 marker가 있을 때만 나타납니다. category vector index 수리가 `blocked`면 fail(분류가 멈춘 상태 — `memex backfill embeddings`로 벡터 재생성), 화해되었으면 ok |
| `sync-export` | 동기화가 꺼져 있으면 `skipped(off)`로 ok(경고 아님). 켜져 있는데 export 훅이 어느 hook에도 등록되지 않았거나 한 번도 내보낸 적이 없으면 warn. 마지막 export가 실패면 fail, 성공이면 ok |

`dependencies`가 검사하는 **설치된 plugin root**는 다음 순서로 해석하며, `memex install`,
`memex deps materialize`, `cli/runtime-exec.js`의 폴백 메시지가 모두 같은 값을 씁니다.

```text
MEMEX_PLUGIN_ROOT
→ $CODEX_HOME/plugins/cache/<marketplace>/memex/<manifest version>
→ codex plugin list --json 의 installedPath
→ 실행 중인 launcher의 루트
```

`~/.local/bin/memex` shim은 `npx --package=github:BongSuCHOI/memex#main`이라 CLI가 npx cache에서
실행됩니다. 예전에는 그 npx cache를 "설치된 plugin root"로 착각해 실제 설치본과 다른 판정을 냈습니다.

`dependencies`, `inject-output` / `recall-provenance`, `injection-yield`의 원인과 복구 명령은
[§20](#20-문제가-생겼을-때--실패-클래스별-복구)이 단일 출처입니다. 여기서는 §20이 다루지 않는 항목만
적습니다.

- runtime 준비 실패 — Node/npm network, cache permission
- MCP 시작 실패 — `runtime-exec`, isolated cache, packaged wrapper
- injection 로그 상태 8종 — `injected`(fact ≥ 1), `context-only`(fact = 0, Capsule/assistant context만
  발행), `no-match`, `deduped`, `skipped`, `no-session-provenance`, `receipt-failed`, `error`
- stale socket — Memex-owned orphan socket만 정리
- repair 실패 — 실패 file을 보고하고 non-zero 종료; 원인 수정 뒤 재실행

검증 절차와 최신 merge-gate baseline은 [VERIFICATION.md](VERIFICATION.md)를 참조하십시오.

`--help`의 부작용 없음 보장은 [§18](#18-cli-한눈에-보기)에 있습니다.

## 14. 제거와 데이터 보존

```bash
memex remove-hooks --dry-run   # explicit fallback을 쓴 경우에만
memex remove-hooks
codex plugin remove memex@memex --json
codex plugin marketplace remove memex --json
```

plugin 제거는 Memex data root나 `$CODEX_HOME/sessions`를 삭제하지 않습니다.

전체 Memex data를 삭제하려면 **실제 path를 먼저 확인**하십시오.

```bash
memex home
memex home --json
```

그 다음 필요할 때만:

```bash
rm -rf "$(memex home)"
```

이 삭제는 Memex archive/index/facts/sync state를 제거합니다. 원본 Codex rollout인 `$CODEX_HOME/sessions`는 Memex가 삭제하거나 수정하지 않습니다.

## 15. Continuity 운영

### 업그레이드

기존 설치(0.4.0 이하 DB)를 최신 plugin으로 올리면 첫 hook/MCP/CLI 실행에서 Continuity schema `7`으로 additive migration이 한 번 실행됩니다(`PRAGMA user_version`으로 확인). 중단되면 다음 실행에서 이어서 재실행되며 released row와 rowid는 보존됩니다. 절차는 §12와 같고, 완료 후 Codex를 재시작하십시오. v7은 현재 남은 evidence를 한 번 replay하며 기존 Capsule은 첫 새 projection commit까지 유지합니다. 구버전 진행 중 Capsule job의 lease는 폐기됩니다. Migration·cursor 계약은 [SCHEMA.md](SCHEMA.md#sequence-cursors-schema-v7)에 있습니다.

```bash
memex update
memex doctor --json
memex status --json
```

### Worker 시작과 복구

capture hook은 commit 후 detached worker를 깨웁니다. wake 실패·expired lease·retry 잔량은 다음 `SessionStart(startup|resume)`에서 복구되고, 수동으로는 다음으로 확인합니다.

```bash
memex status --json                 # 단계별 pending/processing/retry/dead + 종료 상태 카운트
node scripts/continuity-worker.js   # 즉시 drain (설치 artifact에서는 memex-continuity-worker)
memex backfill all                  # extraction/ontology/embedding backlog
```

worker 재실행이 회수하는 것은 **만료된 lease를 가진 비-terminal 행**뿐입니다.

### 작업이 실패했을 때 (terminal 상태 복구)

`dead` job/target, `dead-letter`/`failed-visible` checkpoint, `failed-visible` range는 완료로 위장되지 않지만, **재실행으로는 회복되지 않습니다.** worker를 몇 번 다시 돌려도 dead target이나 failed-visible range는 다시 선택되지 않습니다(`pending-extraction`이 dead target을 가진 세션을 제외하고, claim은 `pending/retry/running`만 봅니다). 회복은 명시적으로 실행합니다.

```bash
memex status                        # "Needs attention: N" + 종료 상태 내역
memex status --json                 # 위와 같은 값 + memory_jobs를 kind × state로 집계한 jobs 객체
memex jobs list --state dead        # 무엇이 왜 죽었는지 (last_error 포함)
memex jobs show <job-id>            # checkpoint / target / 실패 range / retry_history
memex recover <job-id> --dry-run    # 무엇을 되돌릴지 먼저 확인
memex recover <job-id>              # 한 트랜잭션에서 6개 테이블을 함께 리셋
memex recover --all-dead            # dead job/target 전부
memex jobs retry <job-id|--all-dead> [--kind capsule_update]   # recover와 동일 동작
memex jobs dismiss <job-id> --reason "왜 포기하는가"            # 재시도하지 않고 정리
```

| 명령 | 하는 일 |
| --- | --- |
| `memex jobs list [--state dead\|retry\|running\|pending\|all] [--kind <kind>] [--limit n] [--json]` | 큐 상태 조회(읽기 전용). 만료된 lease를 `[lease expired]`로 표시 |
| `memex jobs show <job-id> [--json]` | 한 job의 checkpoint·capsule state·target·실패 range·`retry_history` |
| `memex jobs retry <job-id\|--all-dead> [--kind <kind>] [--dry-run]` | `memex recover`와 같은 복구 |
| `memex jobs dismiss <job-id> --reason "..."` | job을 `superseded`로 정리. `last_error = 'user dismissed: <reason>'` + `logs/ui-audit.jsonl` 감사 1줄 |
| `memex recover <job-id\|target-id\|--all-dead> [--dry-run] [--kind <kind>] [--json]` | terminal이 된 단위와 **같은 단위**로 되돌립니다 |

`recover`는 terminal 상태가 함께 쓰인 트랜잭션과 같은 범위를 한 트랜잭션에서 되돌립니다 — `memory_jobs`(pending, attempts 0, lease 해제), `checkpoints`, `capsule_checkpoint_state`(page 축소 힌트·고정 target 해제), `extraction_targets`, `extraction_target_items`, `exchange_extraction_state`, `extraction_failed_ranges`(CHECK 제약상 `retry`로만 되돌아가며 오류 원문은 보존). 지운 것은 없습니다: `last_error`는 `retry_history` JSON 배열로 보존되고, `dismiss`는 사유를 `last_error`에 남깁니다.

복구 후에는 worker를 실행해야 실제로 처리됩니다(`memex-continuity-worker`, `memex backfill extract`). `memex status`의 "Needs attention"은 `retry`/`dismiss` 직후 바로 줄어듭니다.

여덟 가지 terminal 상태 전체와 각각의 복구 명령은 [§20](#20-문제가-생겼을-때--실패-클래스별-복구)의 표에 정리되어 있습니다.

`capture_gaps.state = 'open'`과 `model_work_budgets.state = 'exhausted'`는 `recover` 대상이 아닙니다. 전자는 다음 성공 캡처에서 자동 해소되고(둘 다 `memex status`에 카운트로 표시), 후자는 `memex model-work resume <budget-id> --new-run`으로 복구합니다.

`memex status --json`의 `jobs`는 `memory_jobs`를 **kind × state**로 집계합니다.

```jsonc
"jobs": {
  "total": 7,
  "byKind": { "capture_index": { "pending": 3, "dead": 1 }, "capsule_update": { "retry": 3 } },
  "byState": { "pending": 3, "retry": 3, "dead": 1 }
}
```

`attention.total`은 이 중 "사람의 판단이 필요한" `dead` + `retry`만 센 값이고, `jobs`는 큐 전체를
보여줍니다. 존재하지 않는 조합은 `0`으로 채우지 않고 아예 나오지 않습니다. 텍스트 출력에도
`Memory jobs: …`와 kind별 줄로 같은 값이 나옵니다.

### 대화 인덱스 무결성 (`memex index`)

fact 파이프라인과 별개로, **대화 인덱스** 자체가 깨질 수 있습니다(FK 위반, orphan 행, 요약 누락,
손상된 아카이브 파일). 진단과 복구는 `memex index`가 담당합니다.

```bash
memex index --verify        # 인덱스 무결성 점검 (읽기 전용)
memex index --repair        # 감지된 문제 수정. 실패한 파일을 보고하고 non-zero로 종료
memex index --cleanup       # 아직 인덱싱되지 않은 대화만 처리 (빠름)
memex index --session <id>  # 특정 세션만 인덱싱 (훅이 쓰는 경로)
memex index --rebuild       # DB를 지우고 전부 다시 인덱싱 (확인 게이트 있음)
```

| 플래그 | 하는 일 |
| --- | --- |
| `--verify` | FK 위반·orphan·요약 누락·손상 파일을 보고만 합니다. 아무것도 쓰지 않습니다 |
| `--repair` | 위 문제를 고칩니다. 고치지 못한 file을 이름으로 보고하고 non-zero로 종료합니다 |
| `--cleanup` | 미인덱싱 대화만 처리합니다. backfill의 기본 진입점입니다 |
| `--session <id>` | 한 세션만 인덱싱합니다 |
| `--rebuild` | **DB를 삭제하고** 전부 다시 만듭니다. `yes` 확인을 요구합니다 |
| `--concurrency N` / `-c N` | 요약 병렬도(1–16, 기본 1) |
| `--no-summaries` | AI 요약 생성을 건너뜁니다(무료·빠름, 결과에 요약 없음) |

`--repair`가 non-zero로 끝나면 보고된 file의 원인을 고친 뒤 다시 실행하십시오. 그래도 남으면
`--rebuild`가 마지막 수단입니다(아카이브 원본은 read-only이므로 인덱스는 항상 다시 만들 수 있습니다).

### Journal/checkpoint 무결성과 capture gap

```sql
-- sqlite3 "$(memex home)/conversation-index/db.sqlite"
SELECT state, COUNT(*) FROM capture_gaps GROUP BY state;
SELECT session_id, stream_epoch, journal_byte_end FROM journal_streams WHERE state = 'active';
SELECT state, COUNT(*) FROM checkpoints GROUP BY state;
```

`capture_gaps.state = 'open'`은 recovery 대기입니다. `MEMEX_STRICT_CAPTURE=1`을 켜면 gap 대신 hook이 실패합니다. transcript가 rewrite되면 새 stream epoch이 생기고 이전 journal은 보존됩니다.

### Project link/split, workstream rebind

resolver는 basename/remote만으로 project를 합치지 않습니다. 명시 연결은 API로 수행합니다(각각 idempotent이며 `project_identity_audit`에 남음).

```bash
node -e 'import("./dist/index.js").then(m => { const db = m.initDatabase(); console.log(m.linkWorkspaceToProject(db, { workspaceId: "<ws>", projectId: "<project>" })); })'
# splitWorkspace(db, { workspaceId }), approveRemoteProjectMapping(db, { remoteFingerprint, projectId }),
# rebindSessionWorkstream(db, { sessionId, workstreamId })
```

### Capsule · current fact · Chronicle 진단

```bash
memex facts list --project <cwd>
memex facts show --id <uuid>
memex facts history --id <uuid>
memex facts explain --subject state.runtime.session_store --project-id <project_id>
```

MCP에서는 `trace_fact`(`subject_key`/`fact_id`/`query`, `timeline_cursor`)가 current → Chronicle → source → other session을 보여 줍니다. `grounded cause (source-cited)`와 `classifier note (…NOT authoritative)`는 항상 분리 표시됩니다.

Capsule 한 세대의 bounded storage size는 기본 12,000자입니다(`MEMEX_CAPSULE_MAX_CHARS`, 하한 2,000자). 초과분은 job을 죽이지 않고 우선순위대로 절단해 저장하며, 무엇이 줄었는지 남깁니다.

```sql
-- sqlite3 "$(memex home)/conversation-index/db.sqlite"
SELECT workstream_id, generation, truncated, original_chars, truncated_fields_json
FROM work_capsules WHERE truncated = 1;
```

이 상한은 Capsule projection에만 적용됩니다. 긴 붙여넣기 프롬프트는 `exchanges`에 원문 그대로 보관되고, 추출은 `MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS`(기본 120,000자) 창으로 분할되므로 이 상한과 무관합니다.

### Privacy purge

§11의 conversation exclusion은 journal/checkpoint/job/exchange/fact/Chronicle event/incident/Capsule/vector/Hot Evidence/session state를 한 transaction에서 제거하고 `fact_tombstones`/`chronicle_tombstones`를 남깁니다. pending worker와 sync replay는 tombstone 때문에 재생성하지 못합니다.

### Rollback

schema `7`의 column/table은 additive이지만 구버전 writer는 evidence sequence와 frontier를 유지하지 못합니다. 따라서 같은 DB에 구버전 worker를 함께 실행하거나 그대로 downgrade하는 방식은 지원하지 않습니다. 되돌릴 때는 worker를 중지하고 업그레이드 전 DB 백업과 해당 plugin 버전을 함께 복원하십시오. 구버전 peer는 새 sync row shape(stable identity, Chronicle event, event tombstone)를 포함한 generation 전체를 visible하게 거부합니다.

### 호환 surface (support window)

`scripts/session-end-hook.js`(final-fence alias, D-011), legacy canonical path query(D-016), `extraction_log`/`SEED`/`PERMANENT` marker(D-007)는 읽기/호환 용도로만 남아 있으며 completion authority가 아닙니다.

## 16. 기억 정합성 감사와 선별 복구

이 절의 도구는 source checkout에서 `npm run build` 후 실행합니다. 전체 backfill이나 fact 삭제로
시작하지 않습니다. 먼저 `memex home --json`으로 실제 root/DB를 확인합니다.

### 백업과 독립 복원 확인

```bash
node scripts/memory-integrity-snapshot.mjs \
  /absolute/memex-home /absolute/codex-home/sessions /outside/source-roots/new-backup-dir
```

출력 directory의 부모는 미리 존재해야 하며 두 source root 밖이어야 합니다. 도구는 원문을
수정하지 않고 SQLite online backup과 archive/journal/sync 파일, Codex sessions를 `snapshot/`에
복사한 뒤 `restored/`에 복원합니다. Manifest의 SHA-256 전체 일치와 SQLite integrity/FK 검사를
확인합니다. Locks/socket, DB WAL/SHM와 `.log`는 제외하고 symlink는 명시적 mapping 없이는 거부합니다.
이 도구의 DB 경로는 `MEMEX_HOME/conversation-index/db.sqlite`입니다. 별도 `MEMEX_DB_PATH`나
root 밖 저장소를 쓴다면 그 저장소도 별도로 백업하고 복원 범위에 기록해야 합니다.

`restore.status=PASS`는 복사한 bytes와 DB 복원 검사입니다. `capture.fileStability=FAIL`이면 원문이
복사 중 바뀐 것이므로 전체 status는 FAIL, CLI exit는 1입니다. Writer를 일괄 중지하지 않았다면
root 간 한 시점의 정합성은 `capture.crossRootAtomicity=NOT_PROVEN`입니다. 실제 rollback은 writer를
중지한 뒤 exact absolute path mapping과 plugin 버전을 함께 복원하고, 백업 이후의 privacy tombstone을
잃지 않는 별도 계획이 필요합니다. 이 도구는 live root를 교체하지 않습니다.

### 미리보기 → 선택 → 적용 → 재검증

```bash
node scripts/fact-integrity.mjs audit /absolute/db.sqlite /private/new-preview.json
```

Audit는 DB를 read-only로 열고 migration하지 않으며 report도 새 파일로만 씁니다.
`review` 항목은 mixed/foreign workstream lineage, 승격 근거 누락, 과거 자동/출처 불명 재서술,
legacy identity, 원문 누락입니다. 원문과 revision을 검토하되 이 목록 자체를 오류 확정으로 보지 않습니다.

`repairable`은 부재/비활성 fact의 vector/relation, 부모가 없는 interpretive context, 기존 terminal
privacy tombstone과 충돌하는 fact입니다. Inactive fact의 유효한 context는 history/privacy용으로 유지합니다.
Report의 `id`를 직접 검토하여 선택한 문자열 배열을 `/private/selection.json`에 저장합니다.
의미나 scope를 자동 수정하는 선택은 지원하지 않습니다.

```bash
# selection.json: ["<reviewed finding id>", "<another reviewed finding id>"]
# 우선 복원본/clone에 적용하고 durable fact/revision/tombstone 보존을 확인
node scripts/fact-integrity.mjs apply /absolute/clone.sqlite /private/new-preview.json /private/selection.json
# 동일 preview가 아직 유효한 경우에만 live DB에 적용
node scripts/fact-integrity.mjs apply /absolute/db.sqlite /private/new-preview.json /private/selection.json
node scripts/fact-integrity.mjs audit /absolute/db.sqlite /private/new-after.json
```

Apply는 `BEGIN IMMEDIATE` 안에서 finding fingerprint를 다시 확인합니다. 대상이 달라지면 전체
선택을 rollback하고 새 preview를 요구합니다. 수정과 `fact_integrity_repairs` ledger는 같은
transaction입니다. 동일 선택 재실행은 `applied=[]`, `alreadyApplied=[…]`로 종료합니다. 이미 고친
손상이 재발했다면 자동 재삭제하지 않고 새 검토를 요구합니다. 전체 preview/report에는 private
fact/source identity가 있을 수 있으므로 repository에는 집계와 hash만 기록합니다.

## 17. 모델 작업 예산과 대기 진단

```bash
memex model-work status
memex model-work status <budget-id> --json
```

Status는 read-only입니다. Parent wave별로 실제 시도·stage/job/target, 관측된 토큰·지연,
미관측 usage와 남은 작업을 확인합니다. 시도 수에는 실패와 재시도가 포함됩니다.
Process가 끝났다는 사실만으로 증거 처리 작업이 완료되었다고 표시하지 않습니다.

| 설정 | 기본값 | 실제 제한 |
| --- | --- | --- |
| `MEMEX_MODEL_BUDGET_MAX_ATTEMPTS` | 64 | 같은 작업 run의 provider 시도 수 |
| `MEMEX_MODEL_BUDGET_DEADLINE_MS` | 900000 | run 전체 deadline |
| `MEMEX_CODEX_EXEC_TIMEOUT_MS` | 180000 | 호출 timeout; 남은 run 시간보다 길게 실행하지 않음 |
| `MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS` | 120000 | 호출 입력 UTF-16 문자 수 |
| `MEMEX_MODEL_BUDGET_MAX_OUTPUT_CHARS` | 16000 | 최종 답변 문자 수; domain schema/필드 검증은 추가 적용 |

`maxTokens`는 기존 호출 API의 호환 인자이며 provider 출력 토큰 상한으로 집행되지 않습니다.
토큰 수는 provider 관측값이고, 자동 주입의 token budget은 별도의 보수적 추정치입니다.
사용량 미관측은 `null` / `NOT_PROVEN`, 일부 시도만 관측되면 `partial`로 읽어야 합니다.
달러 비용이나 누락 usage를 0으로 추정하지 않습니다.

자동 유지보수의 한도 소진은 pending 상태를 보존합니다. 이후 SessionStart 또는 UserPromptSubmit에서 다음 조건을
만족하면 새 run(예산 묶음)을 만들고 미완료 작업을 옮깁니다. 예산이 남은 기존 run은 재사용합니다.
각 시작·메시지 제출 이벤트에서 조건을 재검사하며, 조건이 아직 맞지 않으면 그 다음 시작 이벤트까지 쉽니다.
별도 타이머나 상시 프로세스는 만들지 않습니다.
메시지 훅의 유지보수는 `async`로 등록되어 context injection과 별도로 실행합니다.
같은 데이터 루트의 시작·메시지 이벤트를 3분 단위로 묶어 queue 검사·worker 기동을 제한합니다.
이 wake 제한은 모델 예산을 초기화하지 않으며 기존 worker lock과 job lease가 실제 중복 작업을 막습니다.

- 같은 run의 마지막 호출(호출이 없으면 생성 시각)부터 최소 1시간 대기
- 같은 데이터 루트의 자동 유지보수 전체가 최근 24시간 호출 한도 미만
- 활성 job lease 없음 AND (provider 호출 종료 OR 해당 run의 deadline 경과 후 1분)
- deadline이 없는 run의 미확인 예약은 자동으로 종료됐다고 추정하지 않음

Rollover는 wave 이름에 접미사를 누적하지 않습니다(0.6.1 #42). `parent_wave_id`는 root(`maintenance`)와
그 다음 run(`maintenance#2`, `maintenance#3`)만 갖고, 계보는 `root_wave_id` / `run_seq` 컬럼이 들고
있습니다. 0.6.1 이전에는 rollover 1회마다 `:run:<uuid>` 41자가 붙어 무한히 자랐고, 확장된 id가
환경변수로 자식 워커에 전파되면 그 워커의 계보 조회 범위가 좁아져 공통 rolling 한도에서 이탈했습니다.
DB를 열 때 기존 중첩 id는 자동으로 정규화됩니다. 자식 워커에는 항상 root wave id를 전달합니다.

공통 호출 한도는 `MEMEX_AUTO_MODEL_MAX_ATTEMPTS=256`이 기본값이며 실패·재시도·결과 미확인
예약도 계산합니다. 예약 1건이 1회이며 재시도는 새 예약 1회를 소비합니다. 성공 여부와 무관하게
예약 시각부터 24시간 동안 셉니다. `0`은 자동 유지보수 모델 호출을 막습니다. 각 호출 예약과 새 run 생성은
SQLite write transaction에서 검사하므로 여러 세션·wave 이름·프로세스 재시작으로 상한을
우회하지 못합니다. 이 한도는 해당 데이터 루트의 자동 유지보수용이며 계정 전체나 명시적 수동
run의 한도가 아닙니다. `model-work status`의 `automaticMaintenance`와 `automatic`으로 구분합니다.

미완료 membership과 만료된 queue claim만 옮기며 완료 기록·provider 시도 이력·job 실패 횟수와
향후 retry backoff를 유지합니다. 영구 실패·사용자 취소는 자동으로 되살리지 않습니다.
Ontology 일괄 작업은 기존 pending 관계 → 기존 pending 분류 → 새 분류 순으로 선택합니다.
관계는 fact 갱신 순, 분류는 각 그룹의 생성 순으로 처리합니다. 반복 분류 실패의 기존
3회 한도와 fallback, 일괄 작업량·동시 실행 제한은 유지합니다.

자동 유지보수에 속하지 않는 작업을 재개하거나 수동으로 새 예산을 허용하려면:

```bash
memex model-work resume <budget-id> --new-run --max-attempts 32
```

이 명령은 기존 attempt ledger를 보존하고 active lease가 없는 미완료 작업만 새 budget에 연결합니다.
출력된 worker 명령으로 처리를 재개한 뒤 status를 다시 확인합니다. 수동 갱신은 기존처럼
queue 재시도 횟수를 초기화하므로 자동 재개와 구별합니다.

Ledger는 local-derived operational state이고 sync하지 않습니다. 업데이트 전에 이전 Memex worker를
종료해야 합니다. 같은 DB를 읽는 이전 코드가 새 예산을 준수한다고 가정하지 않습니다.

자동 ontology는 기본 활성화입니다. `MEMEX_AUTO_ONTOLOGY=0`이면 자동 분류와 그 후속 관계
작업을 끕니다. `1` 또는 미설정이면 활성화하며, 그 밖의 유효하지 않은 값은 비활성화합니다.
환경 변수는 Codex/Memex 프로세스가 상속해야 하며 변경 후 재시작합니다. 필요할 때
`memex backfill ontology`로 수동 분류할 수 있고, `BACKFILL_RELATIONS=1`을 함께 주면 새 관계
검사도 요청합니다. 기존 파생 데이터·core embedding·stale-vector 복구는 유지합니다.
번역은 계속 수동입니다. [이전 비교 결과와 한계](verification/codex-usability/README.md#four-arm-result-and-default-decision)는
자동 재개 개선 이전에 측정된 결과이며, 기본 ON의 장기 실사용 품질을 증명하지 않습니다.

## 18. CLI 한눈에 보기

README / README-KR의 표와 같은 순서입니다. 모든 서브커맨드는 `--help` / `-h`를 인식해 사용법만
출력하고 exit `0`으로 끝나며, 부작용이 있는 명령(`update`, `setup-hooks`, `remove-hooks`,
`migrate-projects`, `install`)도 `--help`로는 아무것도 쓰지 않습니다.

| 명령 | 역할 | 상세 |
| --- | --- | --- |
| `memex setup` | Codex built-in Memory 충돌 점검. `--install-cli` / `--uninstall-cli`로 `~/.local/bin/memex` shim 관리 | [§3](#3-cli-shim과-codex-memory-충돌-점검) |
| `memex install` | 플러그인 등록과 runtime 의존성 materialize (idempotent). `--marketplace`·`--plugin-root`·`--root`·`--dry-run` | [§13](#13-진단) |
| `memex deps materialize` | 설치된 plugin root에 runtime 의존성 설치(`npm install --omit=dev --no-audit --no-fund`). `--root`·`--dry-run`·`--force`·`--json` | [§13](#13-진단) |
| `memex setup-hooks` / `memex remove-hooks` | Memex 소유 lifecycle hook 등록·제거 (명시적 fallback 호스트 전용) | [§5](#5-lifecycle-hooks), [§14](#14-제거와-데이터-보존) |
| `memex update` | data를 보존하면서 marketplace/plugin 갱신. `--dry-run`·`--marketplace <name>`·`--no-materialize` | [§12](#12-업데이트) |
| `memex sync` | 새 Codex rollout을 archive/index/search corpus로 반영. `--background` | [§4](#4-최초-onboarding) |
| `memex sync enable\|disable\|status\|export\|import` | 크로스디바이스 동기화 스위치(기본 off)·공유 폴더(`--dir`)·상태·수동 export(`--force`)/import. `--json` | [§10](#두-번째-맥-설정-절차-크로스디바이스-동기화) |
| `memex index` | conversation index 생성·`--verify`·`--repair`·`--rebuild`·`--cleanup`·`--session`·`--concurrency`·`--no-summaries` | [§4](#4-최초-onboarding), [§15](#대화-인덱스-무결성-memex-index) |
| `memex search` | semantic / `--text` / `--vector` / hybrid 검색, `--after`·`--before`·`--limit` | [§6](#6-검색과-분석) |
| `memex show` | archive conversation 읽기 (`--format markdown\|html`) | [§6](#6-검색과-분석) |
| `memex stats` | corpus/index 통계 | [§6](#6-검색과-분석) |
| `memex analyze` | deterministic 전체 이력 보고서 (`--json`, `--out`, `--top`, `--months`) | [§6](#6-검색과-분석) |
| `memex facts` | durable fact 조회·관리: `list\|show\|edit\|deactivate\|restore\|history\|explain\|delete`. `list`는 `--all`(비활성 포함)·`--limit`·`--offset`, `edit`는 `--source-exchange` | [§7](#7-fact-관리) |
| `memex facts tier\|promote\|demote` | `workstream ⇄ project ⇄ global` 사다리 조회·이동(한 칸씩) | [§7](#7-fact-관리) |
| `memex facts migrate-tiers` | 0.6.0 기본 tier 규칙 back-fill 목록(`--dry-run`)·적용(`--apply`) | [§7](#7-fact-관리) |
| `memex ontology` | 로컬 taxonomy 조회·수리: `list\|merge\|rename`. `merge`는 `--dry-run` | [§4](#ontology-taxonomy-수리-061-47) |
| `memex backfill` | `all\|extract\|ontology\|embeddings\|receipts` backlog 처리. `--background` | [§4](#4-최초-onboarding) |
| `memex status` | pipeline readiness, `Needs attention`, terminal 상태, 격리된 프로젝트, `memory_jobs`의 kind × state 집계(`--json`의 `jobs.total`·`byKind`·`byState`) | [§4](#4-최초-onboarding), [§15](#작업이-실패했을-때-terminal-상태-복구), [§20](#20-문제가-생겼을-때--실패-클래스별-복구) |
| `memex jobs` | memory job 조회·복구: `list\|show\|retry\|dismiss` | [§15](#작업이-실패했을-때-terminal-상태-복구) |
| `memex recover` | terminal(dead) 작업을 한 트랜잭션에서 되돌리기. `--all-dead`, `--kind`, `--dry-run` | [§15](#작업이-실패했을-때-terminal-상태-복구) |
| `memex model-work` | `status [budget-id]`, `resume <budget-id> --new-run` | [§17](#17-모델-작업-예산과-대기-진단) |
| `memex doctor` | 의존성·빌드·Codex home·hook 등록/관측·주입 출력·recall provenance·sync export 진단 (`--json`) | [§13](#13-진단) |
| `memex home` | 해석된 Memex data root 출력 (`--json`) | [§10](#10-저장-위치와-sync) |
| `memex migrate-projects` | cwd 근거로 project identity 재도출 (CX-02). `--dry-run` | — |

`memex-ui`, `memex-continuity-worker`, `memex-mcp-server`는 `memex`의 서브커맨드가 아니라 별도 bin입니다.

## 19. 환경 변수

세 문서에 흩어져 있던 사용자 대면 환경 변수의 전체 목록입니다. Codex/Memex 프로세스가 상속해야
하므로 변경 후에는 Codex를 재시작하십시오.

### 경로와 실행

| 변수 | 기본 | 의미 |
| --- | --- | --- |
| `MEMEX_HOME` | — | Memex data root. 가장 우선하는 지정 |
| `XDG_CONFIG_HOME` | — | 대체 경로 `$XDG_CONFIG_HOME/memex` |
| `MEMEX_DB_PATH` | `<home>/conversation-index/db.sqlite` | data root와 별개로 index DB 경로를 지정 |
| `MEMEX_SYNC_DIR` | `<home>/conversation-index/sync` | 크로스디바이스 동기화 공유 폴더(iCloud Drive/Dropbox/Syncthing 등). `memex sync enable --dir`로 저장한 값보다 우선합니다 |
| `CODEX_HOME` | `~/.codex` | Codex home. `$CODEX_HOME/sessions`가 read-only rollout 원본 |
| `MEMEX_SESSIONS_DIR` | `$CODEX_HOME/sessions` | rollout 원본 디렉터리를 직접 지정 (Web UI의 관리 화면도 이 값을 표시합니다) |
| `MEMEX_ALLOWED_TRANSCRIPT_ROOTS` | Codex sessions root | hook이 읽어도 되는 transcript root |
| `MEMEX_PLUGIN_ROOT` | 설치된 plugin | core/`dist` 해석 루트 (checkout 실행·진단용) |
| `MEMEX_RUNTIME_FORCE_REMOTE` | unset | `runtime-exec`가 설치본 대신 `npx` 경로를 쓰게 강제 (진단용) |
| `MEMEX_MCP_AUTOSTART` | unset | MCP wrapper가 서버를 자동 기동 (진단용) |
| `PORT` | `3847` | Web UI 포트 |

### 수집과 기억 계층

| 변수 | 기본 | 의미 |
| --- | --- | --- |
| `MEMEX_STRICT_CAPTURE` | unset | `1`이면 capture 실패가 `capture_gaps` 대신 hook 실패가 됩니다 |
| `MEMEX_CONTINUITY_NO_WAKE` | unset | detached worker wake 비활성 (테스트/진단) |
| `MEMEX_CAPSULE_MAX_CHARS` | `12000` (하한 `2000`) | Work Capsule 한 세대의 bounded storage size. 초과 patch는 버리지 않고 우선순위대로 절단해 저장하고 `work_capsules.truncated`에 기록 |
| `MEMEX_INJECT_BASELINE_MARGIN` | `0.045` (허용 `0`–`1`) | 주입 관련성 게이트가 요구하는 baseline 대비 마진. 범위를 벗어난 값은 기본값으로 되돌아갑니다. **`baseline_margin_gap`으로 측정한 뒤에 조정하십시오** |
| `MEMEX_AUTO_ONTOLOGY` | unset (= on) | 자동 ontology 분류와 후속 관계 작업 스위치. **on으로 인정하는 값은 미설정·빈 문자열·`1` 뿐**이고 그 밖의 값(`0`은 물론 `true`·`yes`도)은 끕니다. 수동 `memex backfill ontology`는 유지 |
| `MEMEX_ONTOLOGY_DET_GATE` | unset (= `+Infinity`, 꺼짐) | 무비용 결정론적 category 재사용 레인의 유사도 임계값. 설정하지 않으면 어떤 후보도 통과하지 못합니다(0.6.1 #47). 켤 때는 현재 taxonomy에서 `facts.ontology_similarity`로 **측정한** `(0,1)` 값을 쓰십시오 |
| `MEMEX_MAX_EXTRACT_WINDOWS` | `12` | 세션당 extraction generator window 예산. 미설정이면 `MEMEX_MAX_EXTRACT_CALLS`를 봅니다 |
| `MEMEX_MAX_EXTRACT_CALLS` | `12` | 위 변수의 이전 이름 (호환) |

### 모델과 임베딩

| 변수 | 기본 | 의미 |
| --- | --- | --- |
| `MEMEX_CODEX_BIN` | `codex` | worker가 실행할 Codex CLI 경로 |
| `MEMEX_CODEX_MODEL` | `gpt-5.6-luna` | worker 모델. 명시적 호출 옵션 > 이 변수 > 기본값 |
| `MEMEX_CODEX_EXEC_TIMEOUT_MS` | `180000` | 호출 timeout. 남은 run 시간보다 길게 실행하지 않습니다 |
| `MEMEX_LLM_RETRIES` | `2` (상한 `5`) | 재시도 횟수(총 시도 − 1) |
| `MEMEX_LLM_RETRY_BASE_MS` | `500` (상한 `5000`) | 지수 백오프 기준값. 실제 대기는 최대 30초 |
| `MEMEX_EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | embedding model. 바꾸면 embedding version이 함께 바뀝니다 |
| `MEMEX_EMBEDDING_STUB` | unset | `1` deterministic stub, `fail` 모델 부재 시뮬레이션 — harness/test 전용 |

### 모델 작업 예산 ([§17](#17-모델-작업-예산과-대기-진단))

| 변수 | 기본 | 실제 제한 |
| --- | --- | --- |
| `MEMEX_MODEL_BUDGET_MAX_ATTEMPTS` | `64` | 같은 작업 run의 provider 시도 수 |
| `MEMEX_MODEL_BUDGET_DEADLINE_MS` | `900000` | run 전체 deadline |
| `MEMEX_MODEL_BUDGET_DEADLINE_AT` | unset | 절대 시각(ISO)으로 deadline 지정. 유효하면 `..._DEADLINE_MS`보다 우선 |
| `MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS` | `120000` | 호출 입력 UTF-16 문자 수 |
| `MEMEX_MODEL_BUDGET_MAX_OUTPUT_CHARS` | `16000` | 최종 답변 문자 수. domain schema/필드 검증은 추가 적용 |
| `MEMEX_AUTO_MODEL_MAX_ATTEMPTS` | `256` | 한 data root의 자동 유지보수 24시간 공통 호출 한도. `0`이면 차단 |

`BACKFILL_RELATIONS=1`은 `memex backfill ontology`에 새 관계 검사도 함께 요청합니다.
`BACKFILL_RECEIPTS_MAX`는 `memex backfill receipts` 한 번이 훑을 fact 수입니다(기본 `1000`, 상한
`20000`). CLI는 워커에 인자를 넘기지 않으므로 `memex backfill receipts --max N`은 무시됩니다 —
한 번에 더 많이 처리하려면 이 환경 변수를 쓰거나 워커를 직접 실행하십시오.

## 20. 문제가 생겼을 때 — 실패 클래스별 복구

이 표가 실패 클래스 → 원인 → 명령의 **단일 출처**입니다. Web UI의 실패 안내도 이 표에서 파생합니다.
먼저 `memex status`와 `memex doctor`를 읽고, 표의 "어디에 보이나" 문자열로 자기 상황을 찾으십시오.

```bash
memex status          # Needs attention / terminal state / Quarantined projects
memex doctor          # dependencies / inject-output / recall-provenance / injection-yield ...
```

| 실패 클래스 | 어디에 보이나 | 원인 | 복구 명령 |
| --- | --- | --- | --- |
| `memory_jobs` dead | `Needs attention: N (N dead, …)` | 재시도 상한을 소진해 terminal이 된 작업 | `memex jobs show <job-id>` → `memex recover <job-id>` 또는 `memex recover --all-dead` |
| `memory_jobs` retry (backoff) | `Needs attention: … of which N in backoff` | 실패 후 backoff 시각이 아직 안 됨. 고장이 아님 | 기다리거나 `memex-continuity-worker` 실행. 즉시 되돌리려면 `memex jobs retry <job-id>` |
| checkpoint dead-letter / failed-visible | `terminal state: checkpointsDeadLetter=…` / `checkpointsFailedVisible=…` | P0 capture-index가 hash·journal 경계 검증에 반복 실패 | `memex recover <job-id> --dry-run` → `memex recover <job-id>` |
| extraction target dead | `terminal state: extractionTargetsDead=…`, `Fact extraction … N deferred` | 추출 target이 재시도를 소진 | `memex recover <target-id>` 또는 `--all-dead` |
| extraction target item failed-visible | `terminal state: extractionTargetItemsFailedVisible=…` | 특정 item이 결정론적으로 실패 | 같은 단위로 `memex recover` |
| Capsule checkpoint failed-visible | `terminal state: capsuleCheckpointFailedVisible=…` | 최소 page로 줄여도 Capsule patch가 실패해 frontier를 전진시키고 표시한 상태 | `memex recover <job-id>`. `--kind capsule_update`로 종류를 좁히는 것은 `--all-dead`와 함께일 때만 의미가 있고, job id를 직접 준 경우에는 무시됩니다 |
| extraction failed range | `terminal state: extractionFailedRanges=…`, `N failed-visible` | 정확히 어떤 구간이 실패했는지 기록된 terminal range | `memex recover …` (CHECK 제약상 `retry`로 되돌아가며 오류 원문은 보존) |
| capture gap open | `terminal state: captureGapsOpen=…` | capture가 fail-open으로 넘어간 구간 | **`recover` 대상 아님.** 같은 세션의 다음 성공 capture가 닫습니다. 실패를 즉시 드러내려면 `MEMEX_STRICT_CAPTURE=1` |
| model-work budget exhausted | `terminal state: modelWorkBudgetsExhausted=…` | run 예산(시도·deadline) 소진 | `memex model-work status` → `memex model-work resume <budget-id> --new-run` |
| 되살릴 가치가 없는 작업 | 위 어느 줄이든 | 원인이 사라졌거나 다른 방식으로 처리함 | `memex jobs dismiss <job-id> --reason "왜 포기하는가"` — `superseded`로 정리, 삭제 없음, 감사 1줄 |
| 격리된 프로젝트 | `Quarantined projects: N (…)` | `/`처럼 프로젝트를 지목할 수 없는 cwd에서 만들어진 프로젝트. fact는 보존하고 주입·조회에서만 제외 | 복구 명령 없음(사람이 판단). 정상 cwd에서 다시 작업하면 올바른 프로젝트로 기록되고, 이전 fact가 필요하면 `memex facts list --scope all`로 확인 후 `memex facts promote/demote`로 옮깁니다 |
| 런타임 의존성 없음 | `doctor`의 `dependencies: fail`, stderr `[memex] runtime deps missing at <ROOT>; installed plugin root: <설치본>; falling back to npx …` | 설치된 플러그인 루트에 `better-sqlite3` / `@xenova/transformers` / `sqlite-vec` 중 하나라도 없어 모든 hook이 `npx github:BongSuCHOI/memex#main`(고정 버전 아님)으로 폴백 | `memex deps materialize` (해석된 설치본에서 `npm install --omit=dev --no-audit --no-fund` 실행). 루트를 직접 지정하려면 `--root <path>`. `memex install`도 같은 단계를 수행합니다 |
| 영수증 없는 컨텍스트 발행 | `doctor`의 `inject-output: fail` / `recall-provenance: fail`, `inject-context.jsonl`의 `status: "receipt-failed"` | 컨텍스트는 나갔는데 durable recall 영수증이 `prepared`에 머무름(provenance 계약 위반) | `memex doctor --json`으로 확인. DB 쓰기 가능 여부·디스크·권한을 점검. 이 상태에서는 "어떤 기억이 언제 어느 세션에 들어갔는가"의 사후 감사가 불가능합니다 |
| 기억이 계속 0개 주입 | `doctor`의 `injection-yield: warn` | 로그의 최근 20건 안에서 fact 0개 retrieval이 8회 이상 연속이고 그 창의 주입 fact 합이 0. 관련성 게이트에서 전부 탈락한 상태 | `continuity_telemetry`의 `baseline_margin_gap`을 먼저 **측정**한 뒤 `MEMEX_INJECT_BASELINE_MARGIN` 조정 |
| 리터럴 매칭 레인 정지 | 로그의 `lexical_lane: unavailable`, `lexical_lane_unavailable` 텔레메트리 | 리터럴 매칭 레인이 예외로 죽음(이전에는 빈 `catch`가 삼켰음) | 텔레메트리의 `dims.reason` 확인 후 원인 수정. semantic 레인은 계속 동작합니다 |
| ontology 분류 보류(parked) | `memex status`의 `Ontology: … (N classified, P parked, Q pending)`에서 `P > 0` | 분류 시도를 소진해 `General`/`Misc`에 보관된 fact. **classified가 아닙니다** | `memex backfill ontology`. 재시도는 분류 정책/embedding 세대당 정확히 1회이므로, 세대가 그대로면 다시 돌려도 같은 fact를 재시도하지 않습니다 |
| ontology category index 수리 필요 | `memex status`의 `ontology category index: MANUAL REPAIR REQUIRED (…)`, `doctor`의 `ontology-index: fail` | category vector index가 self-heal로 고칠 수 없는 상태라 분류 자체가 멈춤 | `memex backfill embeddings`로 vector를 재생성한 뒤 `memex status`에서 줄이 사라졌는지 확인 |
| 하위(derived) 레인이 계속 밀림 | `memex status`의 `Derived lanes: skipped N times (reason: continuity backlog)` | P0/P1(capture index / Work Capsule) 백로그 때문에 consolidation·re-embed·ontology·extraction이 그 세션에서 양보됨 | 고장이 아닙니다. 같은 사유의 3번째 연속 호출에서 하위 레인이 한 번 통과하고 카운터가 0으로 돌아갑니다. 백로그 자체는 `memex jobs list --state retry` → `memex recover`로 해소 |
| 로컬 의미 검증 영수증 없음 | `memex status`의 `facts without local evidence: N / M` | `fact_evidence_receipts`가 없는 활성 fact. 자동 통합에서 빠짐("중복 fact가 계속 쌓인다"). peer의 semantic win이 영수증을 `peer-authority`로 강등해도 같은 상태가 됨 | `memex backfill receipts` — model 호출이 없는 재구성입니다. 원본 exchange가 이미 사라진 fact는 복구 대상이 아닙니다 |
| sync export 실패 | `doctor`의 `sync-export: fail` | 마지막 export generation이 실패로 끝남(대개 공유 폴더에 쓸 수 없음) | `memex sync status`로 공유 폴더·쓰기 가능 여부 확인 → 원인 수정 → `memex sync export`. 다음 SessionEnd/유지보수 wake에서도 재시도합니다 |
| 동기화가 켜져 있는데 한 번도 나가지 않음 | `doctor`의 `sync-export: warn` | 스위치는 on인데 export 기록이 없음(또는 export 훅이 어느 hook에도 등록되지 않음) | `memex sync export`로 첫 세대를 만들고 `memex sync status`로 확인 |
| 동기화가 꺼져 있음 | `doctor`의 `sync-export: ok` + `skipped(off)` | 기본값. 고장이 아님 | 쓰려면 `memex sync enable --dir <공유 폴더>` |
| 기억이 브랜치에 갇혀 있음 | `memex facts tier <id>` 또는 `memex facts show --id <id>`가 `workstream`(`memex facts list`는 tier를 출력하지 않습니다) | 0.6.0 이전 fact는 전부 브랜치 tier에 있음 | `memex facts migrate-tiers --dry-run` → `memex facts migrate-tiers --apply` |

탈락한 후보가 임계값에서 얼마나 떨어져 있었는지는 조정 전에 이 질의로 확인하십시오.

```sql
-- sqlite3 "$(memex home)/conversation-index/db.sqlite"
SELECT recorded_at, value AS closest_gap, dims_json
FROM continuity_telemetry WHERE metric = 'baseline_margin_gap'
ORDER BY recorded_at DESC LIMIT 20;
```

복구 뒤에는 worker를 실행해야 실제로 처리됩니다(`memex-continuity-worker` 또는 `memex backfill extract`).
`memex recover`와 `memex jobs retry`는 **아무것도 삭제하지 않습니다**: 지워진 `last_error`는
`memory_jobs.retry_history` JSON 배열에 보존되고, `dismiss`는 사유를 `last_error`에 남깁니다.
