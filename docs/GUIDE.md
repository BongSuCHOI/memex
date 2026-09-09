# Memex 설치 및 운영 가이드

이 문서는 처음 설치하는 사용자와 repository 기여자가 Memex를 안전하게 운영하는 데 필요한 현재 절차만 설명합니다.

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
- `memex sync` — `$CODEX_HOME/sessions` rollout을 archive/index/search corpus로 반영
- `memex backfill extract` — durable fact 추출
- `memex backfill ontology` — local ontology/relation 생성
- `memex backfill embeddings` — 누락된 semantic vector 생성
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
| SessionEnd | final delta + final fence + outbox | 3초 timeout, foreground extraction/export 없음 |

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
memex search --both "SQLite migration"
memex show /absolute/archive/path.jsonl
memex stats
memex analyze --top 30 --out ~/memex-report.md
```

project-sensitive 명령과 MCP tool은 canonical absolute project 또는 explicit scope를 사용합니다. server process cwd를 project로 추측하지 않습니다.

## 7. Fact 관리

```bash
memex facts list
memex facts list --project /absolute/project/path
memex facts list --scope all
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
  `TierStepError`로 거절되고 기억은 그대로 남습니다. `--reason`은 Chronicle에 사용자 진술로,
  `--json`은 이동 결과와 이벤트 ID를 기계가 읽을 수 있게 출력합니다.
- 근거 기반 자동 승격·강등은 세션 시작 유지보수 단계에서 모델 호출 없이 SQL로만 판정합니다.

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
├── lifecycle-registration.json
├── logs/
│   └── ui-audit.jsonl
├── ui/
│   └── operations.json
├── conversation-archive/
└── conversation-index/
    ├── db.sqlite
    ├── sync/
    └── logs/
```

`logs/ui-audit.jsonl`은 Web UI의 변경·관리 실행 감사 메타데이터이고, `ui/operations.json`은 Web UI가 실행한 관리 명령의 메타데이터입니다. 둘 다 원문·출력이 아니라 메타데이터만 남깁니다.

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

### Sync에 포함되는 것

protocol v4는 durable facts/revisions/tombstones/recall receipts만 sync합니다. KR translation, ontology, relation, vectors는 각 기기가 자체 rebuild합니다.

## 11. DO NOT INDEX와 재분류 비용

conversation exclusion이 적용되면 해당 conversation에서 유래한 Memex searchable/model-derived state를 purge합니다. private-derived taxonomy가 남지 않도록 taxonomy를 전면 invalidate하므로 surviving public facts도 ontology pending으로 돌아갑니다.

따라서 다음 ontology backfill에서 분류 LLM 호출이 다시 발생할 수 있습니다. worker는 bounded batch/run으로 처리하며, 이는 privacy correctness를 위해 의도된 비용입니다.

## 12. 업데이트

```bash
memex update --dry-run
memex update
```

Git marketplace에서는 marketplace snapshot을 갱신하고 plugin cache를 다시 설치합니다. Memex data root는 보존합니다. 완료 후 Codex를 재시작하십시오.

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

자주 확인할 항목:

- `dependencies: fail` — **설치된 플러그인 루트**(`~/.codex/plugins/cache/.../<version>/`)에 `node_modules`가 없다는 뜻입니다. 이 상태에서는 모든 hook이 조용히 `npx github:BongSuCHOI/memex#main`으로 폴백해 고정한 버전이 아니라 `main` HEAD가 실행되고, foreground hook마다 npx 해석 비용이 붙습니다. 폴백이 실제로 일어나면 stderr에 `[memex] runtime deps missing at <ROOT>; falling back to npx … — run: memex install` 1줄이 남습니다. 복구는 `memex install`(idempotent, 네트워크 없이 이미 설치된 production 의존성만 Codex cache로 복사)입니다.
- runtime 준비 실패 — Node/npm network, cache permission
- MCP 시작 실패 — `runtime-exec`, isolated cache, packaged wrapper
- injection 없음 — `injected`(fact ≥ 1), `context-only`(fact = 0, Capsule/assistant context만 발행), `no-match`, `deduped`, `skipped`, `error` 로그 상태
- `injection-yield: warn` — 최근 retrieval이 연속으로 fact를 0개 주입했다는 뜻입니다(후보는 있었음). 관련성 게이트를 확인하십시오. 탈락한 후보가 임계값에서 얼마나 떨어져 있었는지는 `continuity_telemetry`의 `baseline_margin_gap`(`dims.gaps`, `dims.margin`, `dims.baseline`)에 남고, 임계값은 `MEMEX_INJECT_BASELINE_MARGIN`(기본 `0.045`)으로 조정합니다 — **측정 후에 조정하십시오.** 리터럴 매칭 레인이 예외로 죽으면 `lexical_lane: unavailable`과 `lexical_lane_unavailable` 텔레메트리로 드러납니다(이전에는 빈 `catch`가 삼켰습니다).

```sql
-- sqlite3 "$(memex home)/conversation-index/db.sqlite"
SELECT recorded_at, value AS closest_gap, dims_json
FROM continuity_telemetry WHERE metric = 'baseline_margin_gap'
ORDER BY recorded_at DESC LIMIT 20;
```
- `inject-output: fail` / `recall-provenance: fail` — 컨텍스트를 내보냈는데 durable recall 영수증이 남지 않았다는 뜻입니다(`logs/inject-context.jsonl`의 `status: "receipt-failed"`). 훅의 stderr는 Codex가 버리므로 이 로그와 doctor가 유일한 관측 지점입니다. `recall-provenance`는 최근 로그의 emit 건수와 `recall_events` 행 수를 비교하며, emit이 있는데 `recall_events`가 비어 있으면 실패로 보고합니다 — 이 상태에서는 "어떤 fact가 언제 어느 세션에 들어갔는가"의 사후 감사가 불가능합니다.
- stale socket — Memex-owned orphan socket만 정리
- repair 실패 — 실패 file을 보고하고 non-zero 종료; 원인 수정 뒤 재실행

검증 절차와 최신 merge-gate baseline은 [VERIFICATION.md](VERIFICATION.md)를 참조하십시오.

모든 서브커맨드는 `--help`/`-h`를 인식하며, 사용법만 출력하고 exit 0으로 끝납니다. 부작용이 있는 명령(`update`, `setup-hooks`, `remove-hooks`, `migrate-projects`, `install`)도 `--help`로는 아무것도 쓰지 않습니다.

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

`capture_gaps.state = 'open'`과 `model_work_budgets.state = 'exhausted'`는 `recover` 대상이 아닙니다. 전자는 다음 성공 캡처에서 자동 해소되고(둘 다 `memex status`에 카운트로 표시), 후자는 `memex model-work resume <budget-id> --new-run`으로 복구합니다.

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
