'use strict';
require('./helpers/locale.cjs').useKo();   // #109: 기존 한국어 단정은 ko 로케일에서 그대로 통과한다.
/**
 * 도움말 카탈로그 커버리지 (#28).
 *
 * (a) 메뉴 · 배지 종류 · 관리 명령 · 범위 옵션에 항목이 있는지
 * (b) 참조한 docs 앵커가 실제로 문서에 존재하는지 검사한다.
 */
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const help=require('../public/help.mjs');
const {badge,th,header,name}=require('../public/ui.mjs');
const {COMMANDS}=require('../lib/operations.cjs');
const {en,ko}=require('./helpers/locale.cjs');
const {DOC_ANCHORS}=require('../public/i18n/doc-anchors.mjs');
const ROOT=path.resolve(__dirname,'../..');
const APP=fs.readFileSync(path.join(__dirname,'../public/app.mjs'),'utf8');

/** GitHub 헤딩 앵커 규칙: 소문자화 → 마크다운 링크·백틱 제거 → 문자·숫자·_·-·공백만 남김 → 공백을 -로. */
function slug(heading){
 return heading.trim().toLowerCase()
  .replace(/`/g,'')
  .replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
  .replace(/[^\p{L}\p{N}_\- ]/gu,'')
  .replace(/ /g,'-');
}
const anchorCache=new Map();
function anchorsOf(file){
 if(!anchorCache.has(file)){
  const text=fs.readFileSync(path.join(ROOT,file),'utf8');
  const anchors=new Set();let fenced=false;
  for(const line of text.split('\n')){
   if(/^\s*```/.test(line)){fenced=!fenced;continue;}
   if(fenced)continue;
   const m=line.match(/^(#{1,6})\s+(.*)$/);
   if(m)anchors.add(slug(m[2]));
  }
  anchorCache.set(file,anchors);
 }
 return anchorCache.get(file);
}

test('메뉴 7개에 모두 도움말 항목이 있다',()=>{
 // 0.7.0 (#109): 라벨이 사전 키가 됐다 — `['/facts','memory',t('shell.nav.facts')]`.
 const nav=[...APP.matchAll(/\['(\/[a-z]*)','[a-z]+',t\('shell\.nav\.[a-z]+'\)\]/g)].map(m=>m[1]);
 assert.equal(nav.length,7,'app.mjs navigation 추출 실패: '+JSON.stringify(nav));
 for(const route of nav)assert(help.PAGES[route],'도움말 없는 메뉴: '+route);
 assert.equal(Object.keys(help.PAGES).length,nav.length,'navigation에 없는 도움말 항목이 있습니다');
});

/**
 * 0.7.0 (#109): `ui.mjs`의 `label`(71)과 `help.mjs`의 `BADGES`(71)를 `badge.*` 한 네임스페이스로
 * 합쳤다(설계 §6.2 · §12.3 X1). 그래서 계약이 "두 파일의 키 집합 양방향 차집합 0"에서
 * **"한 네임스페이스의 `.label`/`.help` 쌍 존재"** 로 좁아진다.
 *
 * 사전을 단일 출처로 삼고 `ui.mjs`·`help.mjs` 양쪽 조회 함수가 그것을 실제로 반환하는지 본다 —
 * 어느 한쪽이 사전을 안 보게 되면(= 자기 테이블을 다시 들이면) 여기서 드러난다.
 */
test('배지 종류 전종에 짧은 라벨과 한 줄 설명이 쌍으로 있다',()=>{
 const kinds=Object.keys(ko).filter(k=>k.startsWith('badge.')&&k.endsWith('.label')).map(k=>k.slice(6,-6));
 assert(kinds.length>60,'badge.*.label 추출 실패: '+kinds.length);
 const problems=[];
 for(const kind of kinds){
  for(const [tag,dict] of [['en',en],['ko',ko]]){
   if(!dict[`badge.${kind}.label`])problems.push(`${tag} badge.${kind}.label 없음`);
   if(!dict[`badge.${kind}.help`])problems.push(`${tag} badge.${kind}.help 없음`);
  }
  // help.mjs는 `.help`를, ui.mjs는 `.label`을 같은 사전에서 읽어야 한다.
  if(help.badgeHelp(kind)!==ko[`badge.${kind}.help`])problems.push(`badgeHelp(${kind})가 사전 값과 다름`);
  if(name(kind)!==ko[`badge.${kind}.label`])problems.push(`name(${kind})가 사전 값과 다름`);
 }
 assert.deepEqual(problems,[]);
 // 쌍 없이 남은 `.help`가 있으면 죽은 번역이다.
 const orphan=Object.keys(ko).filter(k=>k.startsWith('badge.')&&k.endsWith('.help')).map(k=>k.slice(6,-5)).filter(k=>!kinds.includes(k));
 assert.deepEqual(orphan,[],'짝이 없는 배지 설명: '+orphan.join(', '));
 assert.equal(help.badgeHelp('no-such-badge'),null,'없는 배지에는 null을 돌려줘야 합니다');
 assert(badge('dead').includes('title="'),'배지가 툴팁을 싣지 않습니다');
});

test('관리 명령 전종에 무엇을 하는지·모델을 부르는지가 적혀 있다',()=>{
 for(const key of Object.keys(COMMANDS)){
  const entry=help.COMMANDS[key];
  assert(entry,'도움말 없는 관리 명령: '+key);
  assert(entry.body.length>20,key+': 설명이 너무 짧습니다');
 }
 const extra=Object.keys(help.COMMANDS).filter(k=>!(k in COMMANDS));
 assert.deepEqual(extra,[],'allowlist에 없는 명령 도움말: '+extra.join(', '));
 // 모델을 부를 수 있는 명령은 그 사실을 반드시 말한다.
 for(const [key,cmd] of Object.entries(COMMANDS))if(cmd.model)assert(/모델/.test(help.COMMANDS[key].body),key+': 모델 호출 가능성을 말하지 않습니다');
});

test('범위 옵션 3종에 항목이 있고 전체 범위가 조회 전용임을 말한다',()=>{
 for(const key of ['all','global','project'])assert(help.SCOPES[key],'도움말 없는 범위: '+key);
 assert(/조회 전용/.test(help.SCOPES.all.body));
});

test('참조한 docs 앵커가 실제로 존재한다',()=>{
 assert(help.SOURCES.length>10,'source 수집 실패');
 const missing=[];
 for(const source of help.SOURCES){
  const [file,anchor]=source.split('#');
  assert(fs.existsSync(path.join(ROOT,file)),'없는 문서: '+file);
  if(anchor&&!anchorsOf(file).has(anchor))missing.push(source);
 }
 assert.deepEqual(missing,[],'문서에 없는 앵커: '+missing.join(', '));
 // 0.7.0 (#109): 앵커 값의 유일한 출처는 언어 무관 모듈이다. 인라인 문자열로 되돌아오면
 // 한글 프래그먼트가 사전 밖에 남아 §8.2 게이트를 막는다(설계 §6.4 · §14.3).
 const known=new Set(Object.values(DOC_ANCHORS));
 const inline=help.SOURCES.filter(s=>!known.has(s));
 assert.deepEqual(inline,[],'doc-anchors.mjs 밖의 인라인 앵커: '+inline.join(', '));
});

test('앵커 계산기는 실제 문서의 헤딩을 재현한다',()=>{
 const guide=anchorsOf('docs/GUIDE.md');
 assert(guide.has('20-문제가-생겼을-때--실패-클래스별-복구'),'em dash 헤딩 앵커가 어긋납니다');
 assert(guide.has('7-fact-관리'));
 assert(anchorsOf('docs/WEBUI-WORKSPACE.md').has('api--테스트'),'슬래시 헤딩 앵커가 어긋납니다');
});

/**
 * 0.7.0 (#109): 용어집 항목에 **안정적 `id`** 가 생겼다. 0.6.x까지는 한국어 `term`이 사실상 키여서
 * 이 테스트가 한국어 문자열 11개를 needle로 찾았고, 사전을 한국어 산문으로 키잉하게 되는 구조였다
 * (설계 §6.2). 이제 항목은 `id`로 조회하고, 한국어 기대값은 ko 사전에서 가져온다.
 */
test('용어집은 이슈가 요구한 용어를 담고 각 항목이 화면과 문서로 연결된다',()=>{
 const ids=help.GLOSSARY.map(g=>g.id);
 for(const id of ['fact','directEvidence','interpretiveContext','tier','workspace','workstream','capsule','recall','notRecorded','effectiveVsRecorded','modelBudget'])
  assert(ids.includes(id),'용어집에 없는 항목: '+id);
 assert.equal(new Set(ids).size,ids.length,'용어집 id가 중복됩니다');
 for(const g of help.GLOSSARY){
  assert(help.glossaryFor(g.id)===g,g.id+': id로 조회되지 않습니다');
  assert(g.body.length>15,g.id+': 설명이 너무 짧습니다');
  assert(help.PAGES[g.to],g.id+': 연결된 화면이 메뉴에 없습니다 — '+g.to);
  assert(g.source.includes('#'),g.id+': 문서 앵커가 없습니다');
  // 산문은 사전이 갖는다 — 모듈에 한국어가 되돌아오면 여기서 어긋난다.
  assert.equal(g.term,ko[`help.glossary.${g.id}.term`],g.id+': term이 ko 사전과 다릅니다');
  // `body`는 평문이다 — 사전 값에서 허용 태그만 지운 것과 같아야 한다(help.mjs의 `plain`).
  assert.equal(g.body,ko[`help.glossary.${g.id}.body`].replace(/<[^>]+>/g,''),g.id+': body가 ko 사전과 다릅니다');
  assert.equal(/<[a-z]/.test(g.body),false,g.id+': body에 태그가 남아 있습니다');
  assert(en[`help.glossary.${g.id}.term`],g.id+': en term이 없습니다');
 }
 // 제공됨 ≠ 활용됨. 이 구분은 문구로 남아 있어야 한다.
 assert(/증거는 아닙니다|증명하지/.test(help.glossaryFor('recall').body),'제공됨 ≠ 활용됨 구분이 사라졌습니다');
 assert(/not evidence/i.test(en['help.glossary.recall.body']),'en에서 제공됨 ≠ 활용됨 구분이 사라졌습니다');
});

/**
 * 0.6.x부터 있던 표시 버그: 용어집 본문에 마크다운(`**…**`, 백틱)이 들어 있는데 호출자가 `esc()`로
 * 출력해 별표와 백틱이 문자 그대로 보였다. 사전 값이 `<strong>`·`<code>`를 담고 `bodyHtml`이
 * `tHtml`로 렌더한다(설계 §6.2 부수 버그). 허용 태그는 §9.1 (2)가 따로 강제한다.
 */
test('용어집 본문의 강조·코드는 마크다운 원문이 아니라 HTML로 렌더된다',()=>{
 assert(help.glossaryFor('recall').bodyHtml.includes('<strong>'),'강조가 HTML로 렌더되지 않습니다');
 assert(help.glossaryFor('directEvidence').bodyHtml.includes('<code>source_exchange_ids</code>'),'코드 조각이 HTML로 렌더되지 않습니다');
 const markdown=help.GLOSSARY.filter(g=>/\*\*|`/.test(ko[`help.glossary.${g.id}.body`]));
 assert.deepEqual(markdown.map(g=>g.id),[],'사전 값에 마크다운 원문이 남아 있습니다');
});

test('문서 링크는 릴리스 태그에 고정되고 로컬 경로를 내보내지 않는다',()=>{
 // 앵커 리터럴을 다시 적지 않는다 — 값의 출처는 doc-anchors.mjs 하나다(설계 §14.3).
 const url=help.docUrl(DOC_ANCHORS.GUIDE_FACTS,'0.6.1');
 assert.equal(url,`https://github.com/BongSuCHOI/memex/blob/v0.6.1/${DOC_ANCHORS.GUIDE_FACTS}`);
 assert(help.docUrl('docs/GUIDE.md','0.4.2 · fixture').includes('/blob/v0.4.2/'),'버전 접미사를 잘라내지 못했습니다');
 assert(help.docUrl('docs/GUIDE.md',null).includes('/blob/main/'),'버전을 모르면 main으로 떨어져야 합니다');
 assert(!help.docUrl('docs/GUIDE.md','0.6.1').startsWith('file:'));
});

test('도움말 표시 설정은 세 가지이고 끄기가 실제로 감춘다',()=>{
 const settings=fs.readFileSync(path.join(__dirname,'../public/pages/settings.mjs'),'utf8');
 assert(/name="help"/.test(settings),'도움말 표시 설정이 없습니다');
 for(const value of ['always','first','off'])assert(settings.includes(`'${value}'`),'없는 선택지: '+value);
 assert(/help:f\.get\('help'\)/.test(settings),'설정이 저장되지 않습니다');
 assert(APP.includes("dataset.help=prefs.help"),'설정이 문서 루트에 반영되지 않습니다');
 assert(fs.readFileSync(path.join(__dirname,'../public/style.css'),'utf8').includes('[data-help=off] .help-toggle{display:none}'),'끄기 규칙이 없습니다');
 assert(APP.includes("e.key==='?'"),'용어집 단축키가 없습니다');
});

test('페이지 헤더와 표 머리글이 도움말을 실제로 렌더링한다',()=>{
 const rendered=header('기억·사실','부제','','MEMORY / FACTS','/facts');
 assert(rendered.includes('data-help="page:/facts"'));
 assert(rendered.includes('class="icon-btn help-toggle"'));
 assert(!header('제목','부제').includes('data-help'),'도움말 키가 없으면 버튼을 만들지 않아야 합니다');
 assert.equal(th('다음 행동','nextAction'),'<span title="'+help.HEADERS.nextAction.body+'">다음 행동</span>');
 assert.equal(th('그냥 열','알-수-없는-키'),'그냥 열');
});
