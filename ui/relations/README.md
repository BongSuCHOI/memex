# Memex Knowledge Galaxy

`ui/relations/`는 Memex ontology graph의 3D client입니다. production path는
`ui/server.cjs`의 `/graph`와 live `/api/graph-data`입니다.

## Files

- `index.html`: UI shell, filters, detail panel, accessibility labels
- `app.js`: response validation, layout, rendering, interaction, empty/error state
- `three.min.js`, `orbit-controls.js`: vendored local renderer dependencies
- `generate-data.mjs`: 명시적으로 요청한 offline static export helper

`data.json`은 개인 fact를 포함하므로 gitignored이며 기본 runtime이 생성하지 않습니다.
기본 개발 확인은 root에서 `node ui/server.cjs` 후
`http://127.0.0.1:3847/graph?scope=global`을 엽니다.

상세 데이터/empty/performance/QA 계약은
[`docs/VISUALIZATION.md`](../../docs/VISUALIZATION.md)를 참조하세요.
