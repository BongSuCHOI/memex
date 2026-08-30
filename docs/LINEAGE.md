# 프로젝트 계보와 Codex-native 전환

## 1. 계보

Memex는 다음 공개 프로젝트의 아이디어와 코드 계보에서 이어집니다.

1. `obra/episodic-memory`
2. `jung-wan-kim/memory-bank`
3. `BongSuCHOI/memex` — Codex-native 독립 프로젝트

원 저작권과 라이선스 고지는 root `LICENSE`를 따릅니다. 독립 프로젝트라는 표현은 upstream attribution을 지운다는 뜻이 아니라, 현재 제품 identity와 release boundary가 별도라는 뜻입니다.

## 2. 보존한 제품 개념

- conversation archive와 text/semantic search
- full-history analysis
- fact extraction/consolidation/revision/provenance
- ontology와 typed relation graph
- RAG/context injection
- scope isolation과 cross-project insight
- compressed archive support
- MCP, Web UI, 3D graph

## 3. Codex-native adapter

| 이전 host 개념 | 현재 Memex 구현 |
| --- | --- |
| conversation transcript | `$CODEX_HOME/sessions/**/rollout-*.jsonl` |
| project/session metadata | Codex `session_meta`와 main-thread 판정 |
| lifecycle hooks | Codex plugin-managed SessionStart/UserPromptSubmit/SessionEnd |
| model execution | isolated local `codex exec` |
| plugin root | Codex marketplace installed cache |
| MCP registration | `.codex-plugin/plugin.json` + `.mcp.json` |
| plugin skills | Codex plugin `skills/` |

Memex는 현재 Claude Code runtime fallback이나 다른 agent transcript fallback을 제품 계약으로 제공하지 않습니다.

## 4. 독립 프로젝트의 변경 기준

upstream 변경을 기계적으로 merge하지 않습니다. 가져올 변경은 다음을 확인합니다.

1. host-independent product behavior인가
2. Codex rollout/lifecycle/scope contract와 양립하는가
3. 현재 semantic/lifecycle/lineage 및 privacy 불변식을 보존하는가
4. local-first/security 경계를 약화하지 않는가
5. tests와 owner docs를 함께 이식할 수 있는가

upstream-specific runtime adapter나 개인 배포 artifact는 자동으로 Memex 범위가 되지 않습니다.

## 5. 현재 설계가 diverged한 핵심 지점

Memex는 multi-device sync를 protocol v4 generation으로 다루며 fact state를 semantic/lifecycle/lineage로 분리합니다. ontology/KR/relation/vector는 local derived state로 둡니다.

이 구조는 현재 Memex의 고유한 persistence/sync/privacy 계약이므로 upstream을 참고할 때도 이 불변식을 우선합니다.
