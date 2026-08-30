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

plugin은 manifest, MCP declaration, 3개 skills, hooks, UI launcher를 Codex cache에 설치합니다. dependency-free `cli/runtime-exec.js`가 `github:BongSuCHOI/memex#main` runtime을 `npx` isolated cache에서 실행합니다.

첫 실행은 native dependency와 npm cache 준비로 평소보다 오래 걸릴 수 있습니다. MCP manifest는 이를 고려해 startup timeout을 넉넉하게 둡니다.

### 개발용 local marketplace

repository 자체를 수정하거나 air-gapped validation을 할 때만 local checkout을 사용합니다.

```bash
git clone https://github.com/BongSuCHOI/memex.git
cd memex
npm ci
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

- `memex sync` — `$CODEX_HOME/sessions` rollout을 archive/index/search corpus로 반영
- `memex backfill extract` — durable fact 추출
- `memex backfill ontology` — local ontology/relation 생성
- `memex backfill embeddings` — 누락된 semantic vector 생성
- `memex backfill all` — 위 backlog 단계를 순서대로 실행

`backfill`은 기본 foreground 실행입니다. 실패하면 첫 실패 단계에서 멈추며 idempotent하므로 다시 실행할 수 있습니다. `--background`의 “started” 출력은 완료 증거가 아닙니다. `memex status`의 pending/readiness를 확인하십시오.

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
| SessionStart | version drift check, archive/index sync, sync import, bounded maintenance | 독립 async / eventual consistency |
| UserPromptSubmit | scoped retrieval, relevance/dedup/budget, recall receipt, `additionalContext` | no-match는 무주입 |
| SessionEnd | rollout 안정화, extraction/consolidation, durable sync export | 실패 시 watermark 선행 전진 금지 |

SessionStart의 여러 작업은 ordered pipeline이 아닙니다. 서로 완료를 기다리지 않으며 concurrency-safe writer와 다음 SessionStart의 eventual recovery에 의존합니다.

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
memex facts delete --id <full-uuid> --hard --yes
```

- edit는 revision과 semantic derived-state invalidation을 하나의 transaction으로 처리합니다.
- deactivate/restore는 의미 편집과 독립적인 lifecycle event입니다.
- hard delete는 full UUID, `--hard`, `--yes`가 모두 필요합니다.

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

## 9. Web UI와 Knowledge Galaxy

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex-ui
# http://localhost:3847
```

| URL | 역할 |
| --- | --- |
| `/` | projects/conversations/search |
| `/facts` | fact, revision, provenance, mutation |
| `/graph?scope=global` | global graph |
| `/graph?scope=project&project=/abs/path` | project + global graph |
| `/graph?scope=all` | explicit all-project graph |
| `/pipeline` | readiness/backlog |

UI server는 loopback에만 bind합니다. mutation은 same-origin POST JSON과 service-level validation을 통과합니다.

## 10. 저장 위치와 sync

기본 data root:

```text
~/.config/memex/
├── lifecycle-registration.json
├── logs/
├── conversation-archive/
└── conversation-index/
    ├── db.sqlite
    ├── sync/
    └── logs/
```

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

- runtime 준비 실패 — Node/npm network, cache permission
- MCP 시작 실패 — `runtime-exec`, isolated cache, packaged wrapper
- injection 없음 — `injected`, `no-match`, `deduped`, `skipped`, `error` 로그 상태
- stale socket — Memex-owned orphan socket만 정리
- repair 실패 — 실패 file을 보고하고 non-zero 종료; 원인 수정 뒤 재실행

검증 절차와 최신 merge-gate baseline은 [VERIFICATION.md](VERIFICATION.md)를 참조하십시오.

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
