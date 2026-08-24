# Memory Bank for Codex

Memory Bank는 로컬 Codex 롤아웃 세션을 검색 가능한 장기 메모리로
변환합니다. user/assistant exchange를 보관·인덱싱하고, Codex CLI로 장기
facts를 추출하며, MCP 도구와 로컬 대시보드로 결과를 제공합니다.

## 핵심 기능

- `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` 수집
- subagent·harness context 제외
- 로컬 embedding + FTS5 기반 대화 검색
- facts·ontology·provenance·cross-project insight
- prompt context 주입과 SessionEnd facts 추출
- MCP 도구 9개와 포트 3847의 로컬 대시보드

모델 작업은 전부 로컬에 로그인된 Codex CLI를 사용합니다. 외부 모델 SDK나
API key가 필요 없으며 기본 모델은 `gpt-5.6-luna`입니다.

## 요구 사항과 빌드

- Node.js 22.15 이상
- Codex CLI 0.149 이상

```bash
cd /path/to/memory-bank-codex
npm install
npm run build
```

의존성 설치, MCP 등록, Codex 설정 변경은 자동으로 수행하지 않습니다.

## Codex 구성

- `.codex-plugin/plugin.json`: native plugin manifest
- `.mcp.json`: Memory Bank MCP server
- `hooks.json`: `SessionStart`, `UserPromptSubmit`, `SessionEnd`
- `skills/`: 과거 대화 검색, 전체 대화 분석, 대시보드 실행

체크아웃 개발은 이 저장소에서 Codex를 열어 `.mcp.json`과 `hooks.json`을
사용합니다. 개인 plugin 설치는 Codex marketplace 명령을 통해 수행하고,
plugin cache는 직접 수정하지 마세요.

## 등록부터 해제까지

로컬 marketplace 생성, plugin 등록, 첫 동기화, MCP 확인, dashboard 실행,
plugin·marketplace 해제와 선택적 DB 삭제까지의 전체 절차는
[운영·아키텍처 가이드](docs/GUIDE-KR.md)에 정리되어 있습니다.

등록과 해제의 핵심 명령은 다음과 같습니다. 먼저 가이드의 marketplace
구조를 준비해야 합니다.

```bash
codex plugin marketplace add "/absolute/path/to/memory-bank-marketplace" --json
codex plugin add memory-bank@memory-bank-local --json

# 새 Codex thread에서 사용한 뒤 해제
codex plugin remove memory-bank@memory-bank-local --json
codex plugin marketplace remove memory-bank-local --json
```

plugin 제거는 `~/.config/memory-bank`의 DB나 원본 Codex rollouts를 자동으로
삭제하지 않습니다.

## CLI

```bash
node cli/memory-bank.js sync
node cli/memory-bank.js search "React 인증"
node cli/memory-bank.js stats
node cli/memory-bank.js analyze
```

기본 데이터 경로는 `~/.config/memory-bank`입니다.

| 변수 | 용도 |
| --- | --- |
| `MEMORY_BANK_HOME` | Memory Bank 데이터 루트 변경 |
| `MEMORY_BANK_CONFIG_DIR` | 테스트용 데이터 루트 alias |
| `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/memory-bank` 사용 |
| `MEMORY_BANK_DB_PATH` | SQLite DB 경로만 변경 |
| `MEMORY_BANK_SESSIONS_DIR` | Codex 롤아웃 루트 변경 |
| `MEMORY_BANK_CODEX_MODEL` | 모든 모델 작업의 모델; 기본 `gpt-5.6-luna` |
| `MEMORY_BANK_CODEX_BIN` | 대체 Codex 실행 파일 |

## 검증

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
```

현재 스키마는 `docs/SCHEMA.md`에 정리되어 있습니다.

MCP·CLI 기능표, hooks의 사용 시점, 증분 추출과 idempotency 로직, 모델 격리
경계 및 Mermaid 다이어그램은 [운영·아키텍처 가이드](docs/GUIDE-KR.md)를
참고하세요.

## 라이선스와 출처

MIT. 이 Codex-native 프로젝트는
[`jung-wan-kim/memory-bank`](https://github.com/jung-wan-kim/memory-bank)에서
파생되었습니다. 저작자 표시는 `LICENSE`와 Git history를 따릅니다.
