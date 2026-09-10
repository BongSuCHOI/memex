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
const {label,badge,th,header}=require('../public/ui.mjs');
const {COMMANDS}=require('../lib/operations.cjs');
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
 const nav=[...APP.matchAll(/\['(\/[a-z]*)','[a-z]+','[^']+'\]/g)].map(m=>m[1]);
 assert.equal(nav.length,7,'app.mjs navigation 추출 실패: '+JSON.stringify(nav));
 for(const route of nav)assert(help.PAGES[route],'도움말 없는 메뉴: '+route);
 assert.equal(Object.keys(help.PAGES).length,nav.length,'navigation에 없는 도움말 항목이 있습니다');
});

test('배지 종류 전종에 한 줄 설명이 있다',()=>{
 const kinds=Object.keys(label);
 assert(kinds.length>60,'배지 라벨 추출 실패: '+kinds.length);
 const missing=kinds.filter(k=>!help.BADGES[k]);
 assert.deepEqual(missing,[],'설명 없는 배지: '+missing.join(', '));
 const extra=Object.keys(help.BADGES).filter(k=>!(k in label));
 assert.deepEqual(extra,[],'라벨이 없는 배지 설명: '+extra.join(', '));
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
});

test('앵커 계산기는 실제 문서의 헤딩을 재현한다',()=>{
 const guide=anchorsOf('docs/GUIDE.md');
 assert(guide.has('20-문제가-생겼을-때--실패-클래스별-복구'),'em dash 헤딩 앵커가 어긋납니다');
 assert(guide.has('7-fact-관리'));
 assert(anchorsOf('docs/WEBUI-WORKSPACE.md').has('api--테스트'),'슬래시 헤딩 앵커가 어긋납니다');
});

test('용어집은 이슈가 요구한 용어를 담고 각 항목이 화면과 문서로 연결된다',()=>{
 const terms=help.GLOSSARY.map(g=>g.term).join(' | ');
 for(const needle of ['기억 · 사실','직접 근거','해석에 참고한 맥락','주입 계층','워크스페이스','작업 흐름','Capsule','주입 · 컨텍스트 제공','미수집','발생 시각 vs 기록 시각','모델 작업 예산'])
  assert(terms.includes(needle),'용어집에 없는 용어: '+needle);
 for(const g of help.GLOSSARY){
  assert(g.body.length>15,g.term+': 설명이 너무 짧습니다');
  assert(help.PAGES[g.to],g.term+': 연결된 화면이 메뉴에 없습니다 — '+g.to);
  assert(g.source.includes('#'),g.term+': 문서 앵커가 없습니다');
 }
 // 제공됨 ≠ 활용됨. 이 구분은 문구로 남아 있어야 한다.
 assert(/증거는 아닙니다|증명하지/.test(help.GLOSSARY.find(g=>g.term.includes('컨텍스트 제공')).body),'제공됨 ≠ 활용됨 구분이 사라졌습니다');
});

test('문서 링크는 릴리스 태그에 고정되고 로컬 경로를 내보내지 않는다',()=>{
 const url=help.docUrl('docs/GUIDE.md#7-fact-관리','0.6.1');
 assert.equal(url,'https://github.com/BongSuCHOI/memex/blob/v0.6.1/docs/GUIDE.md#7-fact-관리');
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
