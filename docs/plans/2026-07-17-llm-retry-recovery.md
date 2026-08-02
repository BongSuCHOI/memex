# LLM 실패·빈응답 복구 로직 (사용자 피드백)

> 피드백: "llm 작업 결과가 에러나거나 0바이트에서 재시도니 복구 로직이 없다"

## Phase 0 — 실측 진단 (코드 대조 완료)

### memory-bank (local) — 결함 3건 확정

| # | 결함 | 위치 | 영향 |
|---|------|------|------|
| **C1** | **transient 실패 세션이 영구 손실** | `fact-extractor.ts:199` catch가 실패를 집계 안 함 → `allFacts=[]` → caller가 `extraction_log`에 `extracted=0` **성공 기록**(284) → `pendingExtractionCoreQuery`가 그 세션을 **영구 제외** | 그 대화의 fact가 **영원히 추출 안 됨** (데이터 영구 손실) |
| **H1** | **in-call 재시도 0 + 빈 응답을 성공으로 반환** | `llm.ts:137-141` — Agent SDK 스트림이 result 없이 끝나면 `''` 반환, 호출자가 "정상적으로 아무것도 없음"과 구분 불가. 재시도 루프 전무 | 일회성 flake가 곧바로 작업 손실 |
| **H2** | **빈 응답을 정상 결과로 오인** | `consolidator.ts:187` `''`→null→verdict `'none'`(예산 소모+확정), `avatar-responder.ts:118` `''`→"응답을 생성할 수 없습니다"를 **성공 형식**으로 반환 | 잘못된 확정 / fail-loud 위반 |

**비대칭 근거**: 같은 파일(`ontology-classifier.ts:305-317`)의 **임베딩** 경로는 이미 probe + 동일입력 재시도로 flake를 흡수한다. **LLM 경로만** 그 규율이 없다. 배치 분류(641)만 빈 응답을 transient로 올바르게 처리 — 나머지 전부 누락.

### memory-bank-cloud — 해당 없음(변경 불필요) + 레퍼런스 보유

- `callHaiku` / `messages.create` / `claude-agent-sdk` / `query(` — **0건**. cloud는 ingest/search/MCP/store plane이고 **LLM 작업을 하지 않는다** → 이 결함이 존재할 수 없음(해결된 게 아니라 해당 없음).
- 단 cloud에는 **bounded-attempt 레퍼런스**가 있다: `SET_DEPRECATED_MAX_ATTEMPTS` 루프(1611·2457) — 유한 재시도 후 **미수렴 시 명시적 throw**(조용한 성공 위장 없음). local이 이식할 규율이 바로 이것.
- QA에서 cloud의 네트워크 경로에 **동일 클래스**(실패를 성공으로 오인) 결함이 있는지 별도 스캔.

## 설계 — fail-loud + bounded retry (single-source 분류기)

1. **`src/llm-error-class.ts` (신규)** — 3분류기 단일 소스. consolidator에서 `LlmErrorClass`/`extractStatus`/`LlmCallError`/`classifyLlmError`/`isTransientLlmError`를 **이동**(중복 금지 — coupling drift 차단), consolidator는 re-export로 하위호환. `EmptyLlmResponseError`(신규, transient) 추가.
2. **`src/llm.ts`** — `callHaiku`에 bounded retry:
   - 시도 = 1 + `MEMORY_BANK_LLM_RETRIES`(기본 2 → 총 3회), 백오프 500ms→1500ms
   - **빈 응답도 재시도 대상**(transient)
   - `deterministic`(400/413/max_tokens 등)은 **즉시 throw** — 재시도해도 같음, 예산 낭비 차단
   - 재시도 소진 시 **`''` 대신 throw** → 호출자의 기존 3분류가 비로소 작동
3. **`src/fact-extractor.ts`** — 배치 실패를 3분류로 집계:
   - `deterministic`/`unknown` → 그 배치만 포기하고 진행(무한 pending 방지)
   - `transient` ≥1 → **throw** → `extraction_log` 기록 보류 → 다음 run 재시도 (**C1 근본 해소**)
4. **`src/avatar-responder.ts`** — 사용자 대면이라 crash 대신 graceful: catch 후 실패를 **명시**(confidence 0 + 실패 사유), 성공 위장 금지.
5. **테스트** — `test/llm-retry.test.ts`: 빈응답 재시도→성공, transient 재시도 소진→throw, deterministic 즉시 throw(재시도 0), 재시도 횟수 env, fact-extractor transient→throw / deterministic→진행.

## 수용 기준 (Phase 4 QA 과녁)

- [ ] AC1: 빈 응답(`''`)이 재시도되고, 재시도 성공 시 정상 결과 반환 (실행 증거)
- [ ] AC2: 재시도 소진 시 `''` 아닌 **throw** (호출자가 실패를 인지 가능)
- [ ] AC3: deterministic 에러는 **재시도 없이** 즉시 throw (호출 횟수 1회 실증)
- [ ] AC4: fact-extractor — transient 배치 실패 시 throw → extraction_log 미기록(세션 재시도 가능) / deterministic은 진행
- [ ] AC5: 분류기 단일 소스 — consolidator 재수출로 기존 importer(테스트 포함) 무회귀
- [ ] AC6: 전체 vitest 회귀 0
- [ ] AC7: cloud 비교 결론이 코드 증거로 뒷받침(LLM 호출 0건) + 동일 클래스 스캔 결과 보고

## Deviations
- hard-process-contract 부재(이 repo는 /init-project 미적용) — 이전 /team 3회와 동일하게 진행.
- Phase 3를 executor subagent 대신 리드 인라인 수행: 변경이 5파일·정밀 설계(3분류 의미론 보존, 하위호환 re-export)이고 진단 컨텍스트가 리드에 있어 재구축 손실이 큼. QA는 규칙대로 격리 subagent fan-out.
