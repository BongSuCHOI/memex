# Memory Bank for Codex (한국어)

> 로컬 **Codex** 세션 롤아웃을 검색 가능한 지식 그래프로: 사실(facts)·온톨로지 관계·RAG 검색·컨텍스트 자동 주입.

이 포크는 Claude/Anthropic 런타임 의존을 모두 제거했습니다. fact 추출·요약·통합·번역의 LLM 백엔드는 로컬에 설치된 **codex CLI**(CodexExec provider)이며, 별도 API 키 없이 기존 Codex 로그인으로 인증됩니다.

## 주요 기능

- **롤아웃 수집** — `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` 재귀 탐색. `response_item.message`(user/assistant)와 `custom_tool_call`/`function_call`로 턴 조립. `reasoning`·developer/system·harness 컨텍스트 블록은 인덱싱하지 않음.
- **서브에이전트 격리** — `session_meta.parent_thread_id` 또는 subagent source로 표시된 스레드는 전 단계에서 제외.
- **지식 그래프 / RAG / 컨텍스트 주입 / MCP 서버 9개 도구** — 상세는 [README.md](README.md) 참조.

## 요구 사항

| 도구 | 버전 |
|---|---|
| Node.js | ≥ 22.15 |
| codex CLI | ≥ 0.149 |

## 설치

```bash
git clone --branch codex-only https://github.com/BongSuCHOI/memory-bank.git
cd memory-bank
npm install
npm run build
```

MCP 등록은 루트 `.mcp.json`(프로젝트 스코프) 또는 `~/.codex/config.toml`의 `[mcp_servers.memory-bank]`. 훅은 저장소 루트 [`hooks.json`](hooks.json)이 이 체크아웃에서 열린 세션의 기본 탐색 대상입니다.

## 빠른 시작

```bash
node cli/memory-bank.js sync
node cli/memory-bank.js search "React auth"
node cli/memory-bank.js stats
```

## 환경 변수

| 변수 | 의미 |
|---|---|
| `MEMORY_BANK_CODEX_MODEL` | `codex exec -m` 전달 모델. 기본값: **gpt-5.6-luna** |
| `MEMORY_BANK_CODEX_BIN` | 대체 codex 바이너리(기본 PATH의 `codex`) |
| `MEMORY_BANK_SESSIONS_DIR` / `TEST_SESSIONS_DIR` | 롤아웃 탐색 루트 override |

## 안전 계약

모든 LLM 호출은 `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check -C <임시디렉터리>` 로 실행됩니다. 자식 롤아웃 미생성, 플러그인/훅 재귀 차단, 작업공간 무오염이 보장되며 중첩 호출은 env 가드로 거부됩니다.

## 검증

설치 없이 실행 가능한 동작 스위트:

```bash
node --test test/codex-slice.test.mjs
```

전체 typecheck/build/vitest는 위 설치 후 가능합니다. 실제 `codex plugin add` 수용성과 라이브 훅 발화는 진행 예정 게이트입니다.

## 라이선스

MIT — 원 프로젝트 및 히스토리는 [jung-wan-kim/memory-bank](https://github.com/jung-wan-kim/memory-bank).
