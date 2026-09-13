// 사용자 정의 fact 종류 런타임 레지스트리 (#121).
//
// 내장 5종(decision·preference·pattern·knowledge·constraint)은 `badge.<value>.{label,help}`
// 사전이 갖는다. 사용자 정의 종류는 **사전 키가 없다** — `badge.custom.<id>`는 존재하지 않는
// 키이며, 라벨은 오버레이의 `label_en`/`label_ko`에서 로케일로 고른다. 운영자가 만든 id에
// 번역 키를 발급할 방법이 없기 때문이고, 그래서 `--lint`/`--keys`도 깨끗하게 유지된다.
//
// 값의 출처는 `/api/v2/bootstrap`의 `customFactKinds`(= 추출 규칙 오버레이)이고 `app.mjs`의
// `boot()`가 꽂는다. 화면 여러 곳(`ui.mjs` name()/badge(), `help.mjs` badgeHelp(),
// 기억 목록의 종류 칩)이 같은 값을 동기적으로 읽어야 하므로 모듈 하나에 모아 둔다.
//
// 부팅 때 **한 번만**은 틀렸다(0.7.5 후속 검토 P2 #5): 오버레이 저장·초기화는 코어 규칙을
// 바꾸는데 부트스트랩을 다시 읽지 않았고, 그래서 삭제된 종류의 칩이 남고 새로 만든 종류는
// id로 떴다. `syncCustomFactKinds()`가 그 재조회를 담당하고 `app.mjs`가
// `ctx.invalidate()`·SSE `change`에서 부른다.
//
// **leaf여야 한다**: `help.mjs`가 i18n 런타임 외에는 아무것도 import하지 않는 규율을 지키면서
// 이 레지스트리를 읽어야 하고, `ui.mjs`는 `help.mjs`를 import한다. 그래서 이 모듈은 아무것도
// import하지 않는다 — 사이클이 생기지 않는 유일한 배치다.

/** id → {id,label_en,label_ko,description,extraction_hint?}. 비어 있는 것이 정상 상태다. */
let registry = new Map();

/**
 * 오버레이가 정의한 종류를 꽂는다. 형태가 아닌 값은 조용히 버린다 — 부트스트랩이 실패해도
 * 화면은 떠야 하고, 모르는 종류는 코어 원문(id)으로 표시되는 것이 기존 규율이다.
 * @param {Array<object>|null|undefined} kinds
 */
export function setCustomFactKinds(kinds){
 const next=new Map();
 for(const kind of Array.isArray(kinds)?kinds:[]){
  const id=kind&&typeof kind.id==='string'?kind.id:'';
  if(!id||next.has(id))continue;
  next.set(id,{id,
   label_en:typeof kind.label_en==='string'?kind.label_en:'',
   label_ko:typeof kind.label_ko==='string'?kind.label_ko:'',
   description:typeof kind.description==='string'?kind.description:'',
   extraction_hint:typeof kind.extraction_hint==='string'?kind.extraction_hint:''});
 }
 registry=next;
}

/** 레지스트리의 동일성 지문. 재조회가 실제로 무언가를 바꿨는지만 판단한다. */
const fingerprint=()=>JSON.stringify([...registry.values()]);

/**
 * 레지스트리를 다시 읽어 꽂는다. 종류 목록이 **실제로 달라졌을 때만** true를 돌려주므로
 * 호출자가 불필요한 재렌더를 하지 않는다.
 *
 * 로더를 인자로 받는다 — 이 모듈은 leaf여야 하고(위 주석), 그래서 fetch도 `api.mjs`도
 * import하지 않는다. 실패는 **조용히 무시한다**: 오버레이 재조회가 안 된다고 화면이 멈추는
 * 것보다 직전 라벨을 계속 쓰는 편이 낫다.
 * @param {() => Promise<Array<object>|null|undefined>} load
 * @returns {Promise<boolean>} 종류 목록이 달라졌는가
 */
export async function syncCustomFactKinds(load){
 const before=fingerprint();
 try{setCustomFactKinds(await load());}catch{return false;}
 return fingerprint()!==before;
}

/** 등록된 종류 전부, 오버레이 파일 순서 그대로. */
export const customFactKinds=()=>[...registry.values()];

/** 한 종류, 없으면 null. */
export const customFactKind=id=>registry.get(String(id??''))||null;

/**
 * 로케일에 맞는 라벨. 두 라벨 모두 스키마가 필수로 요구하므로 한쪽만 있는 상태는 저장될 수
 * 없고, 그래도 비어 있으면 **다른 언어로 넘어가지 않고** null을 돌려준다 — 한국어 화면에
 * 영어 라벨이 섞이는 것은 "모르는 값의 이름을 지어내지 않는다"의 반대쪽 실패다.
 * @param {string} id
 * @param {string} tag 'ko' 또는 'en' (i18n의 localeTag())
 */
export function customFactKindLabel(id,tag){
 const kind=customFactKind(id);
 if(!kind)return null;
 const label=String(tag||'').startsWith('ko')?kind.label_ko:kind.label_en;
 return label||null;
}
