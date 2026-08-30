# Web UI와 3D Knowledge Galaxy

## 1. 실행 경계

`ui/server.cjs`는 기본 `127.0.0.1:3847`에 bind합니다. 외부 network interface로 공개하지 않습니다.

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex-ui
```

UI는 CLI와 같은 Memex data-root 해석을 사용합니다. read/write connection은 공통 DB factory를 통해 sqlite-vec와 pragma를 초기화합니다.

## 2. 화면

| Route | 역할 |
| --- | --- |
| `/` | projects, conversations, search, exchange detail |
| `/facts` | fact, revision, provenance, mutation |
| `/graph` | 3D Knowledge Galaxy |
| `/pipeline` | readiness와 backlog |

Graph query는 `scope=global`, `scope=project&project=/abs/path`, `scope=all`을 명시적으로 사용합니다.

## 3. Knowledge Galaxy data

`/api/graph-data`의 핵심 배열:

```text
domains
cats
facts
rel
```

ontology와 relation은 protocol v4 local-derived state입니다. sync 직후 taxonomy backfill이 끝나기 전에는 durable facts가 존재해도 graph가 부분적으로 비어 있을 수 있습니다.

## 4. Empty와 error

신규 설치의 다음 payload는 정상입니다.

```json
{"domains":[],"cats":[],"facts":[],"rel":[]}
```

반면 필수 배열 누락, 잘못된 타입, dangling relation 등은 error입니다. empty state와 malformed data를 같은 빈 화면으로 숨기지 않습니다.

## 5. Facts mutation

`/api/facts-mutate`는 CLI와 같은 `fact-management` service를 사용합니다.

방어:

- POST only
- JSON content type
- same-origin
- body size limit
- action/schema validation
- UUID/confirmation gate
- escaped user text

edit/deactivate/restore가 UI 전용 shortcut으로 DB를 직접 갱신해서는 안 됩니다.

## 6. Pipeline 상태

`/pipeline`은 conversation sync, extraction, consolidation, ontology, embedding backlog를 관측하는 read-only surface입니다.

extraction `done`은 successful watermark가 현재 session 마지막 row까지 도달했을 때만 의미합니다. session이 resume되어 suffix가 생기면 다시 pending이 될 수 있습니다.

privacy purge 뒤에는 ontology가 전면 invalidate되므로 graph readiness가 다시 pending으로 보일 수 있습니다. 이는 오류가 아니라 public facts를 새 taxonomy에서 재분류하는 의도된 상태입니다.

## 7. 성능과 접근성

- labels는 compositor-friendly하게 유지
- point size와 relation animation은 bounded
- DPR/eco mode 지원
- API fetch/parse와 browser first-interactive를 분리 측정
- keyboard로 navigation/search/fact action 접근 가능해야 함
- user fact text가 HTML/JS로 실행되지 않아야 함

## 8. QA 체크리스트

1. empty DB에서 모든 route가 crash 없이 열린다.
2. populated DB에서 conversation → fact → provenance가 연결된다.
3. global/project/all graph scope가 올바르게 분리된다.
4. relation filter와 node detail 이동이 동작한다.
5. malicious text가 markup으로 실행되지 않는다.
6. 잘못된 mutation method/origin/content-type/body가 거부된다.
7. edit → deactivate → restore가 공통 service를 통해 완료된다.
8. 종료 후 Memex가 만든 browser/server/listener/temp artifact가 남지 않는다.
