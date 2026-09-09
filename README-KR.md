# Memex

[![Release](https://img.shields.io/badge/release-0.6.0-2563eb)](CHANGELOG.md)
[![Codex](https://img.shields.io/badge/Codex-native-111827)](https://developers.openai.com/codex/)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.15-339933)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> Codex를 위한 로컬 우선 장기 기억 계층입니다. 대화를 모으고, 재사용할 지식을 증류하고, 서로 연결한 뒤, 필요한 순간에 다시 꺼내 씁니다.

![Memex Workspace 개요 화면: 파이프라인 준비 상태, 최근 기억의 변화, 범위별 활동 지표](assets/readme/overview.png)

Memex는 로컬 Codex 세션 이력을 검색 가능한 대화 아카이브, 장기 fact, 범위가 분리된 지식 그래프, 그리고 이후 작업에 다시 주입할 수 있는 제한된 컨텍스트로 바꿉니다. Memex는 **두 번째 에이전트가 아니라 기억 시스템**입니다. 실제 작업은 Codex가 계속 수행하고, Memex는 그 주변에서 장기 기억 계층을 제공합니다.

[English README](README.md) · [문서](docs/README.md) · [운영 가이드](docs/GUIDE.md) · [아키텍처](docs/ARCHITECTURE.md) · [검증](docs/VERIFICATION.md)

### Memex가 하는 일

- **대화를 보관합니다** — 원본 Codex rollout은 수정하지 않고 검색 가능한 스냅샷을 남기며, semantic vector search와 FTS5/BM25 검색을 함께 제공합니다.
- **장기 fact를 증류합니다** — 재사용할 가치가 있는 decision, preference, pattern, knowledge, constraint를 추출하고 각 fact를 그것을 증명하는 대화 턴에 묶습니다.
- **fact의 변화를 추적합니다** — duplicate 통합, contradiction, revision, deactivate, restore, provenance를 기록합니다.
- **연결하고 다시 꺼냅니다** — fact를 domain/category로 분류해 typed relation을 만들고, 관련도와 예산을 통과한 작은 기억 블록만 이후 Codex prompt에 주입합니다.
- **근거를 보여줍니다** — loopback Web UI, 9개 MCP 도구, 그리고 fact 상태만 주고받는 멀티디바이스 durable sync를 제공합니다.

---

## 왜 Memex인가

**Local-first.** 원본 Codex rollout은 항상 read-only입니다. DB·검색 인덱스·파생 그래프·운영 로그는 로컬 Memex data root 아래에 있으며, archive와 DB는 언제든 다시 만들 수 있는 로컬 계층입니다.

**근거에 묶인 기억.** fact는 대화 요약이 아닙니다. `source_exchange_ids`에는 정확한 authoritative human 또는 trusted local-tool exchange만 들어가고, fact를 *해석*하는 데 필요한 long-range non-authoritative 맥락은 별도의 로컬 `fact_context_dependencies`에 기록되며 authority로 승격되지 않습니다. Web UI와 `trace_fact`는 이 두 경로를 항상 분리해 보여줍니다.

**정직한 관측.** 수집되지 않은 값은 `0`으로 환산하지 않고 미수집으로 표시합니다. 관측되지 않은 토큰 사용량은 `null` / `NOT_PROVEN`, 일부만 관측되면 `partial`입니다. "컨텍스트를 제공했다"는 사실만 기록하며, 모델이 답변에 실제로 활용했다는 증거로 쓰지 않습니다.

**명시적인 실행 없이는 모델을 부르지 않습니다.** capture hook은 bounded local I/O만 수행합니다. Web UI 화면을 여는 것만으로는 모델 작업이 시작되지 않고, 자동 유지보수는 대기 시간과 공통 호출 한도가 허용할 때만 미완료 작업을 재개합니다.

**프로젝트 격리.** Memex는 canonical absolute `session_meta.cwd`로 로컬 workspace를 식별하고 stable `project_id`로 논리적 프로젝트를 구분합니다. 검색·관련 사실·추적·graph의 모든 hop이 같은 scope를 사용하며, MCP server는 자신의 process cwd를 project identity로 추측하지 않습니다. 프로젝트를 지목할 수 없는 cwd(`/`, `unknown`, basename이 비어 있는 경로)는 한 곳에 몰아넣지 않고 거절하며, 그런 세션은 글로벌 기억만 읽습니다.

**기억은 한 덩어리가 아니라 계층입니다.** 깃 프로젝트에서는 디렉터리가 프로젝트이고 브랜치가 계층입니다. 기본 브랜치에서 한 작업은 프로젝트 공용 기억이 되고, 그 외 브랜치·워크트리의 작업은 자기 브랜치 tier에 남으며, `브랜치 ⇄ 프로젝트 공용 ⇄ 글로벌` 사다리를 한 칸씩 오르내릴 때마다 누가 왜 옮겼는지가 함께 기록됩니다. 일반 디렉터리에는 브랜치 계층이 아예 없습니다. [범위와 기억 계층](#범위와-기억-계층)을 참고하세요.

자세한 내용은 [ARCHITECTURE.md](docs/ARCHITECTURE.md), [FACT-LIFECYCLE.md](docs/FACT-LIFECYCLE.md), [WEBUI-WORKSPACE.md](docs/WEBUI-WORKSPACE.md)를 참고하세요.

---

## 빠른 시작

**요구 사항** — Node.js 22.15 이상, 인증이 완료된 Codex CLI, 그리고 현재 hook / Unix socket runtime 기준 macOS 또는 Linux.

```bash
# 1. 플러그인 설치 후 Codex를 재시작해 hook·skills·MCP server를 로드합니다
codex plugin marketplace add BongSuCHOI/memex
codex plugin add memex@memex

# 2. 선택: 터미널에서도 memex 명령 사용 (~/.local/bin/memex 생성,
#    global npm install은 하지 않음)
npx --yes --package=github:BongSuCHOI/memex#main memex setup --install-cli

# 3. 기존 Codex 대화 이력 준비
memex setup          # Codex built-in Memory와의 충돌 점검
memex sync           # $CODEX_HOME/sessions의 eligible rollout을 archive/index
memex backfill all   # durable fact 추출, ontology 분류, 누락 embedding
memex status         # readiness와 남은 backlog 확인

# 4. http://127.0.0.1:3847 에서 로컬 워크스페이스 열기
npx --yes --package=github:BongSuCHOI/memex#main memex-ui

# 5. 이미 했던 작업을 물어보기 — Codex에서는 bundled skill이 Memex MCP 도구를
#    사용하며, 같은 조회를 셸에서 하면 다음과 같습니다
memex search "왜 SQLite를 선택했지?"
```

`memex setup`은 사용자 승인 없이 Codex built-in Memory를 비활성화하지 않습니다. backfill 단계는 모두 idempotent하게 다시 실행할 수 있습니다.

Memex는 native SQLite, vector, embedding 의존성을 사용합니다. 설치 절차가 이를 plugin 옆에 materialize하고 launcher는 그 설치 artifact를 우선 실행합니다. isolated npm cache는 MCP server와, 아직 materialize되지 않은 plugin registration이 쓰는 `npx` fallback에만 적용됩니다. 어느 경로도 일반 사용 시 사용자 프로젝트에 dependency를 설치하거나 source checkout을 요구하지 않습니다.

local marketplace 개발과 source 기반 검증은 [운영 가이드](docs/GUIDE.md)를 참고하세요.

---

## Web UI

워크스페이스는 서버 측 CommonJS와 브라우저로 보내는 ES module로만 구성됩니다. 별도의 프런트엔드 빌드도, 추가 npm 패키지도 없습니다. 서버는 `127.0.0.1`에만 bind하고 `Host`/`Origin`을 검사하며 변경 요청에는 CSRF 토큰을 요구합니다. Fact mutation은 CLI와 동일한 transactional service를 사용합니다. 포트는 `PORT`로 바꿉니다.

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex-ui
# http://127.0.0.1:3847
```

| 화면 | 내용 |
| --- | --- |
| `/` 개요 | 파이프라인 준비 상태, 최근 기억 변화, 활동 |
| `/conversations` 대화 원장 | 세션, 대화 턴, 원문 |
| `/facts` 기억·사실 | fact, revision, 직접 근거와 해석 맥락, 확인 후 수정·비활성화·복원·삭제 |
| `/taxonomy` 분류 | ontology domain과 category |
| `/graph` 지식 지도 | WebGL 2D/3D 관계 그래프, Canvas2D fallback |
| `/activity` 활동 · 추적 | Chronicle, 처리 작업, 모델 시도, 컨텍스트 제공, 로그, 관리 실행 |
| `/settings` 관리 | 런타임, 관리 명령, 화면 설정, 진단 |

모든 화면은 프로젝트 / 공통 기억 / 전체 프로젝트 범위를 명시적으로 선택합니다. 기본값은 전체 프로젝트이고 이 범위는 **조회 전용**입니다 — 실제 주입 범위는 언제나 현재 프로젝트 + 공통 기억이며, 범위 선택 옆에 그 사실을 상시 표시합니다. 화면을 여는 것만으로는 모델 작업이 시작되지 않습니다.

![기억 상세 패널의 근거 탭. 직접 근거와 해석에 참고한 맥락이 별도 절로 나뉘어 있다](assets/readme/facts-detail.png)

*기억 상세 · 근거 탭 — 직접 근거와 해석에 참고한 맥락을 분리해 보여주고, 그 아래에 검증 영수증을 남깁니다.*

![2D 지식 지도에서 노드 하나가 선택되고 연결된 관계가 강조된 화면](assets/readme/graph.png)

*지식 지도 — fact 노드와 typed relation(`SUPPORTS`, `INFLUENCES`, `SUPERSEDES`, `CONTRADICTS`)을 브라우저 네이티브 WebGL로 그립니다. 레이아웃은 도메인 그룹만 인코딩하며, 화면상의 거리는 임베딩 유사도 수치가 **아닙니다**.*

![활동·추적의 처리 작업 탭에서 durable job 하나가 대상·입력 버전·모델 시도까지 펼쳐진 화면](assets/readme/activity-jobs.png)

*활동 · 추적 · 처리 작업 — durable job 하나를 추출 대상, 처리한 입력 버전, 모델 실행 시도까지 펼쳐 확인합니다.*

<details>
<summary>다크 모드</summary>

![같은 개요 화면을 다크 모드로 렌더링한 모습](assets/readme/overview-dark.png)

</details>

Web UI는 인증·TLS·다중 사용자 격리 서비스가 아니므로 포트 포워딩이나 공개 배포를 하지 않습니다. 자세한 내용은 [WEBUI-WORKSPACE.md](docs/WEBUI-WORKSPACE.md)를 참고하세요.

---

## 동작 방식

```mermaid
flowchart TB
    subgraph Codex[Codex]
      Rollouts[Session rollouts]
      Hooks[Lifecycle hooks]
      MCP[MCP + skills]
    end

    subgraph Core[Memex core]
      Archive[Archive / index]
      Extract[Fact extraction]
      Reconcile[Fact reconciliation]
      Retrieve[Retrieval / injection]
      Graph[Ontology / relations]
    end

    subgraph Durable[Durable state]
      Facts[(Facts)]
      Revisions[(Fact revisions)]
      Tombstones[(Fact tombstones)]
      Recall[(Recall receipts)]
    end

    subgraph Local[Local derived state]
      Exchanges[(Conversation index)]
      Vectors[(FTS / vectors)]
      KR[(KR translations)]
      Ontology[(Ontology / relations)]
    end

    Rollouts --> Archive
    Archive --> Exchanges
    Exchanges --> Extract
    Extract --> Facts
    Facts --> Reconcile
    Reconcile --> Revisions
    Reconcile --> Tombstones
    Facts --> Graph
    Graph --> Ontology
    Facts --> Vectors
    Facts --> KR
    Exchanges --> Retrieve
    Facts --> Retrieve
    Ontology --> Retrieve
    Retrieve --> Hooks
    Retrieve --> MCP
    Hooks --> Recall
```

### Fact 상태 모델

sync protocol v4는 fact 상태를 서로 독립적인 축으로 나눕니다.

| 축 | 예시 | 병합 규칙 |
| --- | --- | --- |
| **Semantic** | fact text, category, scope | semantic event clock + deterministic tie-break |
| **Lifecycle** | active / inactive | lifecycle event clock; 완전 동률이면 inactive 승리 |
| **Lineage** | source exchange IDs, consolidated count | monotonic union / max |
| **Derived overlay** | KR text, ontology, relations, vectors | local-only, 재생성 가능 |

이 분리가 중요한 이유는 fact의 의미를 편집하는 것과 비활성화하는 것이 서로 다른 사건이기 때문입니다. 더 최신 semantic edit가 더 최신 deactivate를 되돌려서는 안 되고, 오래된 peer snapshot 때문에 provenance가 사라져서도 안 됩니다.

### 범위와 기억 계층

| 상황 | 동작 |
|---|---|
| **깃 프로젝트** | 디렉터리 = 프로젝트. 기본 브랜치(main/master/`origin/HEAD`) 세션의 기억 → **프로젝트 공용**. 그 외 브랜치/워크트리 세션의 기억 → `(project, branch)`로 키를 잡는 독립 **브랜치 tier**. 브랜치끼리 서로 희석되지 않고, 같은 저장소의 워크트리 두 개가 같은 브랜치를 체크아웃하고 있으면 하나의 tier를 공유해 서로의 기억을 봅니다. 주입·조회 = 글로벌 + 프로젝트 공용 + 현재 브랜치. |
| **일반(비-git) 프로젝트** | 디렉터리 = 프로젝트, 브랜치 계층 없음. 모든 기억 = 프로젝트 공용 (+ 글로벌). |
| **일반 → 깃 전환** | `workspace_id`·`project_id` 불변, workspace 메타데이터만 갱신 + `WORKSPACE_LOCATION_CHANGED` 이벤트. 기존 프로젝트 공용 기억은 데이터 변경 없이 그대로. 전이 이후 세션부터 브랜치 규칙 적용. 브랜치를 만들지 않으면 아무것도 달라지지 않음. 새 common dir/remote가 다른 프로젝트에 이미 묶여 있으면 자동으로 병합하지 않고, `WORKSPACE_LOCATION_CHANGED` 행에 `requires_approval = 1`과 `project_identity_audit`의 `suggest` 행으로 남긴 뒤 `approved_remote_mappings` 명시 승인을 기다립니다. |
| **승격/강등** | 사다리 `브랜치 ⇄ 프로젝트 공용 ⇄ 글로벌`, 한 칸씩만. 채널 3개: ① Web UI/CLI 사용자 확언 ② 근거 기반 자동(다른 브랜치/기본 브랜치 재확인 → 프로젝트; 서로 다른 프로젝트 2곳 이상 확인 → 글로벌; 상위 근거 소실 → 강등) ③ 세션 내 명시 요청("이건 프로젝트 공용으로 기억하자" → `actor=user-directive`). 모두 Chronicle `PROMOTED/DEMOTED`. 추출 시점의 개인 선호 → 글로벌 최초 분류는 유지. |

승격/강등 채널 ①은 0.6.1부터 CLI와 Web UI **둘 다** 있습니다 — 기억 상세 패널의 승격/강등 버튼이 `POST /api/v2/facts/promote|demote`를 통해 같은 `promoteFact`/`demoteFact` 서비스를 `actor=user`로 호출합니다. Web UI의 기억 변경 allowlist는 `edit|deactivate|restore|delete`에 이 두 계층 이동이 더해집니다. 저장되는 값은 `facts.promotion_state`(`workstream` = 브랜치 tier, `project-current` = 프로젝트 공용, `scope_type = global` = 글로벌)이고, 그 자리에 놓인 근거는 `facts.tier_reason`(`no-branch-signal` | `default-branch` | `branch:<name>`)에 남습니다.

지원하는 scope는 **project**(project-wide truth와 필요한 global fact), **workspace/workstream/session**(명시한 작업 범위와 허용된 상위 truth), **global**(global fact만), **all**(사용자가 명시적으로 요청한 cross-project 접근)입니다.

읽기 범위와 통합 권한은 분리됩니다. 통합기는 다른 계층이나 승격 상태의 fact를 흡수하지 않고 검증된 새 문장만 채택하며, 불명확한 legacy identity는 검토 대상으로 보존합니다. 기존 DB의 [감사·백업·선별 복구](docs/GUIDE.md#16-기억-정합성-감사와-선별-복구)는 전체 fact 재추출 없이 수행할 수 있습니다.

0.6.0 이전에 추출된 fact는 전부 브랜치 tier에 있습니다. `memex facts migrate-tiers --dry-run`이 새 규칙상 프로젝트 공용이어야 하는 항목을 나열하고, `--apply`가 실제로 옮깁니다.

### Recall이 자기 자신을 다시 학습하지 않도록

과거 기억을 다시 꺼낸 뒤 Codex가 그 내용을 반복했다고 해서, 그 반복 문장이 새로운 사실의 근거가 되어서는 안 됩니다. Memex는 human assertion, 신뢰 가능한 local repository / Git / test 관측, external 또는 검증 불가능한 tool output, Memex recall, assistant-generated synthesis를 구분합니다. 뒤의 두 가지는 검색에는 남지만 새로운 durable fact evidence로 사용하지 않으며, 따라서 다음 증폭 루프를 막습니다.

```text
기존 fact → prompt에 recall → assistant가 반복 → 반복 문장을 새 fact로 추출
```

Context를 실제로 내보내기 전에 durable recall receipt를 먼저 기록합니다.

### 개인정보와 conversation 제외

user-role message의 `DO NOT INDEX` marker는 해당 conversation 전체를 Memex knowledge corpus에서 제외합니다. Privacy purge는 exchange와 tool-call index state, FTS/vector rows, extraction/recall processing state, 제외된 conversation에 authoritative evidence 또는 persisted interpretive context로 의존한 fact, 그 fact에서 파생된 revision/relation/vector, 기존 corpus에서 파생된 local taxonomy를 제거하거나 무효화합니다. 이렇게 제거된 fact에는 terminal privacy tombstone이 남아 오래된 다른 기기의 snapshot이 되살릴 수 없고, 남은 공개 fact는 남아 있는 근거만으로 다시 분류됩니다.

### 멀티디바이스 sync

크로스디바이스 동기화는 **기본 off**이며, 켜기 전에는 아무것도 기기 밖으로 나가지 않습니다. 두 맥이 같은 공유 폴더(본인 계정의 iCloud Drive·Dropbox·Syncthing 등)를 보게 하면 durable 기억 상태가 서로 맞춰집니다.

```bash
memex sync enable --dir ~/Library/Mobile\ Documents/com~apple~CloudDocs/memex-sync
memex sync export      # 이 기기의 첫 세대 내보내기
memex sync status      # 공유 폴더·이 기기·마지막 export·감지된 다른 기기
```

이후 export는 자동입니다. SessionEnd의 async 훅과 자동 유지보수 wake가 "마지막 export 이후 durable 변경이 있을 때만" 세대를 만들고, SessionStart가 다른 기기의 세대를 가져옵니다. `MEMEX_SYNC_DIR`은 저장된 공유 폴더보다 우선하며, on/off 스위치는 `<data root>/sync/config.json`의 기기 로컬 상태라 전송되지 않습니다. `memex sync disable`이면 이 경로 전부가 stderr 한 줄짜리 no-op이 됩니다. 공유 폴더의 기억은 평문 JSONL이고 암호화는 범위 밖이므로 **본인 계정의** 클라우드만 사용하십시오.

protocol v5는 기기별로 하나의 committed generation을 export하며, 각 generation은 `facts.jsonl`, `fact-revisions.jsonl`, `fact-tombstones.jsonl`, `recall-events.jsonl`과 protocol version·device/generation identity·row count·payload별 SHA-256을 담은 `meta.json`으로 구성됩니다. Importer는 SQLite를 변경하기 전에 generation 전체를 pin하고 검증하며, 필수 파일 누락·hash 불일치·JSON 오류·row schema 오류가 하나라도 있으면 해당 device generation 전체를 reject합니다. 같은 local device의 exporter는 SQLite `BEGIN IMMEDIATE` transaction으로 직렬화되므로 늦게 끝난 오래된 export가 `CURRENT`를 되돌릴 수 없고 cloud-sync되는 lockfile도 필요하지 않습니다. KR 번역, ontology category, relation, vector index는 각 기기에서 로컬로 다시 만듭니다.

| 기억 계층 | 전송 | 받는 기기에서 |
| --- | --- | --- |
| 글로벌 | 예 | 어디서나 주입 |
| 프로젝트 공용 (`legacy-project`, `project-current`, `decision`) | 예 | 해당 프로젝트에서 주입 |
| workspace | 예 (`workspace_id` 포함) | 주입되지 않음 — workspace id는 기기 로컬 값 |
| 브랜치 / workstream | 예 (`workstream_id`·`tier_reason`·브랜치 이름 포함) | 같은 프로젝트의 같은 브랜치에 있을 때만 주입 (`workstream_id`가 `hash(project_id, branch)`라 그대로 일치) |

모든 promotion state가 전송되므로, 자체 tier를 가질 수 없는 fact tombstone이 export되는 fact와 정확히 같은 모집단을 가리킵니다. 프로젝트 전역 승격(`project-current` / `decision`)은 workspace·브랜치 키가 항상 비워진 채 도착하며(로컬 writer가 강제하는 것과 같은 불변식), 이 버전이 모르는 `promotion_state`는 프로젝트 범위로 뭉개지 않고 malformed row로 보고해 해당 generation을 거부합니다. protocol v4 generation은 계속 import되고, v4 피어는 v5 generation을 잘못 읽는 대신 거부합니다.

더 깊은 내용: [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [CONVERSATION-LIFECYCLE.md](docs/CONVERSATION-LIFECYCLE.md) · [FACT-LIFECYCLE.md](docs/FACT-LIFECYCLE.md) · [RETRIEVAL-AND-CONTEXT.md](docs/RETRIEVAL-AND-CONTEXT.md) · [SCHEMA.md](docs/SCHEMA.md)

---

## 사용법

```bash
memex search "왜 SQLite를 선택했지?"
memex search --text "ERR_MODULE_NOT_FOUND"     # 임베딩 없이 정확한 문자열
memex facts list
memex stats
memex analyze --top 30 --out ~/memex-report.md
memex status
```

| 명령 | 역할 |
| --- | --- |
| `memex setup` | Codex built-in Memory 충돌 점검. `--install-cli` / `--uninstall-cli`로 `~/.local/bin/memex` shim 관리 |
| `memex install` | 플러그인 등록과 runtime 의존성 materialize (idempotent). `--root`로 설치본 루트 직접 지정 |
| `memex deps materialize` | 해석된 설치 plugin root에 runtime 의존성 설치(`npm install --omit=dev --no-audit --no-fund`). `--root`, `--dry-run`, `--force`, `--json` |
| `memex setup-hooks` / `memex remove-hooks` | Memex 소유 lifecycle hook 등록·제거 (명시적 fallback 호스트 전용) |
| `memex update` | data를 보존하면서 marketplace/plugin 갱신. `--marketplace <name>`, `--no-materialize` |
| `memex sync` | 새 Codex rollout archive/index. `--background` |
| `memex sync enable\|disable\|status\|export\|import` | 크로스디바이스 동기화 스위치(기본 off)·공유 폴더(`--dir`)·상태·수동 export(`--force`)/import. `--json` |
| `memex index` | conversation index 생성·검증·복구·재구축: `--cleanup`, `--session <id>`, `--verify`, `--repair`, `--rebuild`, `--concurrency N`, `--no-summaries` |
| `memex search` | semantic / text / hybrid conversation search |
| `memex show` | archive conversation 읽기 |
| `memex stats` | corpus/index 통계 |
| `memex analyze` | deterministic 전체 이력 보고서 생성 |
| `memex facts` | durable fact 조회·관리: `list\|show\|edit\|deactivate\|restore\|history\|explain\|delete`. `list --all`은 비활성 fact까지(`--limit`·`--offset`), `edit --source-exchange <id>`는 근거 지정 |
| `memex facts tier\|promote\|demote` | `workstream ⇄ project ⇄ global` 사다리 조회·이동(한 칸씩) |
| `memex facts migrate-tiers` | 0.6.0 기본 tier 규칙 back-fill 목록(`--dry-run`)·적용(`--apply`) |
| `memex backfill` | extraction / ontology / embedding / 증거 영수증 backlog 처리 |
| `memex ontology` | local taxonomy 조회·수리: `list\|merge\|rename` (더 이상 append-only가 아님) |
| `memex status` | pipeline readiness(`Ontology: … classified, … parked, … pending`)와 `Needs attention`·격리된 프로젝트·`memory_jobs`의 kind × state 집계. `--json` |
| `memex jobs` | memory job 조회·복구: `list\|show\|retry\|dismiss` |
| `memex recover` | terminal(dead) 작업을 한 트랜잭션에서 되돌리기; `--all-dead`, `--dry-run` |
| `memex model-work` | 모델 작업 예산 확인과 명시적 재개; [예산 재개](docs/GUIDE.md#17-모델-작업-예산과-대기-진단) |
| `memex doctor` | 의존성·빌드·hook·주입 출력·recall provenance 진단 |
| `memex home` | 해석된 Memex data root 출력 |
| `memex migrate-projects` | cwd 근거로 project identity 재도출 (CX-02). `--dry-run`은 계획만 출력하고 아무것도 쓰지 않음 |

모든 서브커맨드는 `--help` / `-h`를 인식해 사용법만 출력하고 exit `0`으로 끝납니다. 부작용이 있는 명령(`update`, `setup-hooks`, `remove-hooks`, `migrate-projects`, `install`)도 `--help`로는 아무것도 쓰지 않습니다.

Fact 관리에는 edit, deactivate, restore, history, guarded hard delete가 포함됩니다. semantic edit는 fact ID와 revision history를 유지하면서 이전 의미에서 파생된 상태를 무효화합니다.

foreground backfill은 처리 가능하거나 실행 중이거나 해결되지 않은 작업이 없을 때만 exit code `0`을 반환합니다. 유계 실행 뒤 재시도 가능한 backlog가 남으면 `completed with deferred work`와 선택한 단계별 실행 후 건수를 출력하고 `2`를 반환합니다. active claim과 terminal extraction failure도 outstanding work와 `2`로 보고합니다. worker 실패는 우선하여 이후 단계를 중단하고 `1`을 반환합니다.

전체 CLI와 lifecycle 계약은 [GUIDE.md](docs/GUIDE.md)를 참고하세요.

### MCP 도구와 skills

Memex는 9개의 MCP 도구를 제공합니다.

| 도구 | 용도 |
| --- | --- |
| `search` | 과거 conversation 검색 |
| `read` | archive 원문/line range 읽기 |
| `search_facts` | 증류된 fact 검색 |
| `search_ontology` | domain/category별 fact 탐색 |
| `ask_avatar` | 저장된 evidence를 바탕으로 답변 합성 |
| `trace_fact` | current fact → Chronicle timeline → source evidence 추적 |
| `explore_graph` | 1–3 hop relation 탐색 |
| `cross_project_insights` | 다른 project의 유사 해결책 탐색 |
| `graph_stats` | graph 규모와 health 확인 |

project-sensitive 도구는 stable project/workspace/workstream/session ID 또는 legacy canonical absolute project path, `scope: global`, `scope: all` 중 하나가 필요합니다.

Bundled Codex skill 3개는 과거 대화 기억, 전체 대화 분석, Memex dashboard 열기를 담당합니다. 자세한 내용은 [MCP-AND-SKILLS.md](docs/MCP-AND-SKILLS.md)를 참고하세요.

### 자동 lifecycle

| 이벤트 | Memex 동작 |
| --- | --- |
| **SessionStart(startup/resume)** | session state 복원과 durable queue recovery 후 background sync/import/maintenance |
| **SessionStart(clear/compact)** | `context_epoch` 전환; compact는 bounded Capsule/current-fact bundle을 즉시 반환 |
| **UserPromptSubmit** | scoped retrieval·bounded context injection, 별도 비동기 유지보수 재개 검사 |
| **Stop** | 새 complete transcript bytes만 append하고 closed-turn fence commit |
| **Interrupt** | delta append와 interrupted/open fence 보존 |
| **PreCompact** | journal fsync, carry freeze, checkpoint + outbox atomic commit |
| **PostCompact** | optional telemetry 전용; correctness 비의존 |
| **SessionEnd** | final delta + final fence + durable job만 수행; foreground model/embedding/extraction/export 없음 |

Durable queue는 capture indexing, Work Capsule, fact/derived 순으로 처리합니다. SessionStart background 작업은 eventual consistency이며 각 writer가 자체 transaction/CAS 안전성을 책임집니다.

### 데이터 위치

해석 우선순위는 `MEMEX_HOME`, `$XDG_CONFIG_HOME/memex`, `~/.config/memex` 순입니다.

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
├── journals/<session>/<epoch>.jsonl    # rolling transcript 저널
├── run-locks/
├── ui/
│   └── operations.json
└── logs/
    ├── hook-events.jsonl
    └── ui-audit.jsonl
```

`ui/operations.json`은 Web UI가 실행한 관리 명령의 메타데이터, `logs/ui-audit.jsonl`은 Web UI 감사 기록입니다. 둘 다 대화 원문·기억 원문·실행 출력이 아니라 메타데이터만 남깁니다. `logs/hook-events.jsonl`에는 관측된 lifecycle hook의 이벤트 이름과 시각만 남고, `conversation-index/logs/inject-context.jsonl`에는 retrieval 1건당 상태·건수·소요 시간만 남습니다(프롬프트·기억 원문 없음). 반면 `conversation-archive/`와 `journals/`에는 실제 대화 원문이 들어 있으므로 민감 정보로 취급하세요. 원본 `$CODEX_HOME/sessions` rollout은 항상 read-only input으로 취급합니다. 삭제나 이동 전에는 `memex home`(또는 `memex home --json`)으로 정확한 경로를 확인하세요.

---

## 설정

| 변수 | 효과 |
| --- | --- |
| `MEMEX_HOME` | Memex data root. 가장 우선하는 지정 |
| `XDG_CONFIG_HOME` | 대체 경로 `$XDG_CONFIG_HOME/memex` |
| `MEMEX_DB_PATH` | data root와 별개로 index DB 경로를 지정 |
| `CODEX_HOME` | Codex home. `$CODEX_HOME/sessions`가 read-only rollout 원본 |
| `MEMEX_AUTO_ONTOLOGY` | 자동 ontology는 기본 활성화이며 `0`이면 끔 |
| `MEMEX_STRICT_CAPTURE` | `1`이면 capture gap 대신 hook이 실패 |
| `MEMEX_CAPSULE_MAX_CHARS` | Work Capsule 한 세대의 bounded storage size (기본 `12000`, 하한 `2000`). 초과 patch는 버리지 않고 우선순위대로 절단해 저장하고 기록 |
| `MEMEX_INJECT_BASELINE_MARGIN` | 주입 관련성 게이트가 요구하는 baseline 대비 마진 (기본 `0.045`, 0~1). 조정 전에 `baseline_margin_gap` 텔레메트리로 측정 |
| `PORT` | Web UI 포트 (기본 `3847`) |

자동 ontology를 꺼도 수동 `memex backfill ontology`와 기존 파생 데이터·core embedding은 그대로 유지됩니다.

모델 작업은 run 단위로 예산이 정해집니다([GUIDE §17](docs/GUIDE.md#17-모델-작업-예산과-대기-진단)).

| 설정 | 기본값 | 실제 제한 |
| --- | --- | --- |
| `MEMEX_MODEL_BUDGET_MAX_ATTEMPTS` | `64` | 같은 작업 run의 provider 시도 수 |
| `MEMEX_MODEL_BUDGET_DEADLINE_MS` | `900000` | run 전체 deadline |
| `MEMEX_CODEX_EXEC_TIMEOUT_MS` | `180000` | 호출 timeout; 남은 run 시간보다 길게 실행하지 않음 |
| `MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS` | `120000` | 호출 입력 UTF-16 문자 수 |
| `MEMEX_MODEL_BUDGET_MAX_OUTPUT_CHARS` | `16000` | 최종 답변 문자 수; domain schema/필드 검증은 추가 적용 |
| `MEMEX_AUTO_MODEL_MAX_ATTEMPTS` | `256` | 한 데이터 루트의 자동 유지보수 24시간 공통 호출 한도; `0`이면 차단 |

토큰 수는 provider 관측값입니다. 미관측은 `null` / `NOT_PROVEN`, 일부 관측은 `partial`로 읽으며, 누락 usage나 달러 비용을 0으로 추정하지 않습니다.

선택적 한국어 fact 번역(`fact_kr`)은 local derived state입니다. 일반 lifecycle hook마다 자동 번역하지 않고 sync payload에도 포함하지 않으므로 세션마다 번역 모델 비용이 발생하지 않습니다. source checkout에서는 `node scripts/translate-facts.mjs`로 수동 실행할 수 있으며, 스크립트는 번역 요청 시작 이후 fact 의미가 바뀌지 않은 경우에만 결과를 기록합니다.

---

## 검증과 릴리스

Repository의 release gate는 구현 commit과 증거 receipt를 분리해 관리합니다. 현재 검증된 code baseline은 [`docs/verification/merge-gate.json`](docs/verification/merge-gate.json)에 기록되며, committed candidate SHA·environment·exact gate 결과·hard-safety 결과·retained note를 담습니다. Owner document에 복제된 숫자로 현재 검증 상태를 추정하지 않습니다.

필수 항목에 FAIL이 하나라도 있으면 merge gate는 FAIL이며, 관측하지 않은 동작을 추정으로 PASS 처리하지 않습니다. 전체 acceptance model과 machine receipt 정책은 [VERIFICATION.md](docs/VERIFICATION.md)를 참고하세요.

---

## 기여

```bash
git clone https://github.com/BongSuCHOI/memex.git
cd memex
npm install
npm run build          # tsc + esbuild bundle
npm test               # vitest
npm run typecheck
node --test ui/test/*.test.cjs          # Web UI 서비스·HTTP 계약
node scripts/web-ui-browser-e2e.mjs     # 실제 headless Chrome UI gate
MEMEX_PLUGIN_ROOT="$PWD" node ui/server.cjs   # checkout에서 Web UI 실행
```

behavior를 변경하기 전 [AGENTS.md](AGENTS.md)를 읽어주세요. repository invariant, verification rule, documentation ownership이 정리되어 있습니다. public command, persisted field, lifecycle rule, MCP schema, release contract가 바뀌면 해당 owner document도 같은 변경에서 갱신해야 합니다.

문서는 하나의 거대한 manual 대신 책임 영역별로 나눠 관리합니다. 전체 지도는 [docs/README.md](docs/README.md)에 있습니다.

| 문서 | 내용 |
| --- | --- |
| [GUIDE.md](docs/GUIDE.md) | 설치, onboarding, CLI, lifecycle, 제거 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 시스템 경계와 전체 데이터 흐름 |
| [CONVERSATION-LIFECYCLE.md](docs/CONVERSATION-LIFECYCLE.md) | rollout parsing, archive/index, sync protocol |
| [FACT-LIFECYCLE.md](docs/FACT-LIFECYCLE.md) | extraction, consolidation, semantic/lifecycle state |
| [KNOWLEDGE-GRAPH.md](docs/KNOWLEDGE-GRAPH.md) | ontology, relation, traversal |
| [RETRIEVAL-AND-CONTEXT.md](docs/RETRIEVAL-AND-CONTEXT.md) | search, RAG, context injection |
| [SCHEMA.md](docs/SCHEMA.md) | SQLite schema와 transaction invariant |
| [MCP-AND-SKILLS.md](docs/MCP-AND-SKILLS.md) | MCP 도구와 bundled skills |
| [WEBUI-WORKSPACE.md](docs/WEBUI-WORKSPACE.md) | 로컬 Web UI 화면, 범위 모델, 지식 지도 |
| [CONTINUITY.md](docs/CONTINUITY.md) | lifecycle/journal/outbox/worker, Capsule, identity, Chronicle의 as-built |
| [VERIFICATION.md](docs/VERIFICATION.md) | tests, E2E gate, release evidence |
| [LINEAGE.md](docs/LINEAGE.md) | upstream attribution과 project lineage |

---

## 계보와 라이선스

Memex는 MIT 라이선스의 [`obra/episodic-memory`](https://github.com/obra/episodic-memory)와 [`jung-wan-kim/memory-bank`](https://github.com/jung-wan-kim/memory-bank)에서 이어진 Codex-native 독립 프로젝트입니다. 기존 knowledge-system 아이디어는 유지하되, host adapter는 Codex-native rollout, hook, plugin, MCP, model-execution 계약으로 교체했습니다. 자세한 내용은 [LINEAGE.md](docs/LINEAGE.md)와 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.

MIT. [LICENSE](LICENSE)를 참고하세요.
