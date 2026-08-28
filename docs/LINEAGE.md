# 프로젝트 계보와 Codex-native 전환

## 1. 계보

Memex는 MIT 라이선스의 두 공개 프로젝트에서 이어집니다.

1. [`obra/episodic-memory`](https://github.com/obra/episodic-memory)
2. [`jung-wan-kim/memory-bank`](https://github.com/jung-wan-kim/memory-bank)
3. `BongSuCHOI/memex` — Codex-native 독립 프로젝트

원 저작권 고지는 root [LICENSE](../LICENSE)에 유지합니다. 독립 저장소라는 말은 upstream
기여와 라이선스 계보를 지운다는 뜻이 아니라, GitHub fork network와 Claude Code host
adapter를 제품 정체성/배포 경계로 사용하지 않는다는 뜻입니다.

## 2. 보존한 제품 개념

- conversation archive와 semantic/text search
- full-history analysis
- fact extraction/consolidation/revision/provenance
- ontology와 typed relation graph
- RAG/context injection
- scope isolation과 cross-project insight
- compressed archives
- MCP, Web UI, 3D graph

이 기능은 Claude path/SDK/hook을 복제해서가 아니라 host-independent core와 데이터
불변식을 Codex adapter에 연결해 보존합니다.

## 3. 교체한 host adapter

| 이전 host 개념 | Memex Codex 구현 |
| --- | --- |
| Claude conversation transcript | `$CODEX_HOME/sessions/**/rollout-*.jsonl` |
| Claude project/session metadata | Codex `session_meta`와 main-thread 판정 |
| Claude lifecycle hooks | Codex plugin-managed three-event hooks; fingerprinted explicit fallback |
| Claude model SDK/CLI | isolated local `codex exec`, default `gpt-5.6-luna` |
| Claude plugin root | Codex marketplace installed cache `installedPath` |
| Claude MCP registration | `.codex-plugin/plugin.json` + `.mcp.json` |
| Claude plugin skills | Codex plugin `skills/` |

Claude Code, OMC, Superpowers runtime fallback은 없습니다. Memex는 Codex용
독립 저장소이므로 현재 canonical Memex storage namespace만 사용합니다.

## 4. 독립 프로젝트의 변경 기준

앞으로 upstream을 기계적으로 merge하지 않습니다. 가져올 가치가 있는 변경은 다음을
별도 평가합니다.

1. host-independent product behavior인가
2. Codex rollout/lifecycle/scope contract와 양립하는가
3. 현재 schema/provenance/watermark 불변식을 보존하는가
4. local-first/explicit-install/security 경계를 약화하지 않는가
5. 테스트와 문서를 Memex owner surface에 함께 이식할 수 있는가

upstream의 Claude-specific 경로, checkout-mutating dependency self-heal, unrelated QA/marketing
harness, 개인 배포 artifact는 이 저장소의 제품 범위가 아닙니다.
