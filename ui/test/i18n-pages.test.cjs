'use strict';
/**
 * en 스모크 (#109, 설계 §9.2).
 *
 * 기존 테스트는 `helpers/locale.cjs`의 `useKo()`로 **한국어 단정을 그대로** 통과시킨다. 그 반대편,
 * 즉 "en으로 렌더하면 실제로 영어가 나오는가"는 이 파일이 본다:
 *   (1) 한글 0건 — 이관을 빠뜨린 리터럴이 그대로 드러난다
 *   (2) 미번역 키 0건 — 런타임 언어 간 폴백이 없으므로(§2.2) 누락 키는 `a.b.c` 꼴로 화면에 뜬다
 *   (3) 주요 문구가 en 사전 값과 일치 — 모듈이 사전을 실제로 읽는지
 *
 * **레인마다 독립된 절을 갖는다.** 자기 절만 고치고 남의 절은 읽기만 한다 — 그래야 네 레인이 이
 * 파일을 동시에 늘려도 충돌이 한 곳에 몰리지 않는다.
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {useEn,useKo,en,ko}=require('./helpers/locale.cjs');
const {DOC_ANCHORS}=require('../public/i18n/doc-anchors.mjs');

useEn();

const HANGUL=/[가-힣ㄱ-ㅎㅏ-ㅣ]/;
/** 누락 키는 en으로 떨어지지 않고 키 문자열 그대로 나온다(§2.2) — 그 모양을 찾는다. */
const UNTRANSLATED=/\b[a-z]+(?:\.[a-zA-Z0-9_-]+){2,}\b/;
/**
 * `docs/*.md` 13편은 전부 한국어이고 영문판이 없다. en UI도 같은 앵커로 보내고 대신 한 줄 고지를
 * 붙인다(설계 §6.4). 그래서 en 렌더에 남는 한글은 **문서 앵커 하나뿐**이고, 텍스트 허용 목록이
 * 아니라 `doc-anchors.mjs`의 값을 지우는 **구조적 면제**로 처리한다.
 */
const withoutAnchors=html=>Object.values(DOC_ANCHORS).reduce((out,anchor)=>out.split(anchor).join(''),String(html));
const textOf=html=>withoutAnchors(html).replace(/<[^>]*>/g,' ');

// ══════════════════════════════════════════════════════════════════════════════
// i18n L4 · 도움말(help.mjs) + 실패 안내(guidance.mjs)
// ══════════════════════════════════════════════════════════════════════════════
const help=require('../public/help.mjs');
const guidance=require('../public/guidance.mjs');

const ctx={href:(p,q={})=>p+'?'+new URLSearchParams(q),bootstrap:{environment:{commands:true}}};

test('[L4] 도움말 카탈로그를 en으로 읽으면 한글도 미번역 키도 없다',()=>{
 useEn();
 const problems=[];
 const check=(where,value)=>{
  if(typeof value!=='string'||!value)return problems.push(`${where}: 값이 비었습니다`);
  if(HANGUL.test(value))problems.push(`${where}: 한글 — ${value.slice(0,40)}`);
  if(UNTRANSLATED.test(value))problems.push(`${where}: 미번역 키 — ${value.slice(0,60)}`);
 };
 for(const [key,entry] of help.ALL){check(key+'.title',entry.title);check(key+'.body',entry.body);}
 for(const g of help.GLOSSARY){check('glossary:'+g.id+'.term',g.term);check('glossary:'+g.id+'.body',g.body);}
 assert.deepEqual(problems,[]);
 assert.equal(help.ALL.length,36,'도움말 항목 수가 바뀌었습니다');
 assert.equal(help.GLOSSARY.length,17);
 // 모듈이 사전을 실제로 읽는다.
 assert.equal(help.PAGES['/facts'].title,en['help.page.facts.title']);
 assert.equal(help.helpFor('header:nextAction').body,en['help.header.nextAction.body']);
 assert.equal(help.badgeHelp('dead'),en['badge.dead.help']);
});

test('[L4] 실패 분류 카탈로그를 en으로 읽으면 한글도 미번역 키도 없다',()=>{
 useEn();
 const problems=[];
 const check=(where,value)=>{
  if(typeof value!=='string'||!value)return problems.push(`${where}: 값이 비었습니다`);
  if(HANGUL.test(value))problems.push(`${where}: 한글 — ${value.slice(0,40)}`);
  if(UNTRANSLATED.test(value))problems.push(`${where}: 미번역 키 — ${value.slice(0,60)}`);
 };
 for(const cls of [...guidance.CLASSES,guidance.unknownClass('boom')]){
  for(const field of ['title','cause','impact','next'])check(`${cls.id}.${field}`,cls[field]);
 }
 assert.deepEqual(problems,[]);
 assert.equal(guidance.CLASSES.length,36,'실패 클래스 수가 바뀌었습니다');
 assert.equal(guidance.guidanceFor('job-dead').title,en['guidance.job-dead.title']);
});

test('[L4] 안내 렌더러의 en 출력에는 문서 앵커 말고 한글이 없다',()=>{
 useEn();
 const groups=guidance.attentionFromPipeline({
  attention:{memoryJobsDead:7,memoryJobsRetry:2,terminal:{modelWorkBudgetsExhausted:3}},
  ontology:{parkedFacts:4,indexRepair:{blocked:true,reason:'write'}},
  evidence:{factsWithoutLocalEvidence:118},
  derivedLaneSkips:{consecutive:2},
  quarantinedProjects:[{projectId:'p'}],
 });
 const rendered=[
  guidance.guidancePanel(guidance.guidanceFor('job-dead'),ctx),
  guidance.guidancePanel(guidance.unknownClass('LLM boom'),ctx),
  guidance.guidanceCell(guidance.guidanceFor('sync-export-failed'),ctx),
  guidance.attentionCard(groups,ctx),
 ].join('\n');
 const text=textOf(rendered);
 assert.equal(HANGUL.test(text),false,'en 렌더에 한글이 남았습니다: '+(text.match(/.{0,30}[가-힣].{0,30}/)||[''])[0]);
 // 수량 라벨은 사전의 1슬롯 패턴이 어순까지 갖는다.
 assert.equal(groups.find(g=>g.cls.id==='job-dead').detail,en['guidance.attention.job-dead.detail'].replace('{count}','7'));
 assert(rendered.includes(en['guidance.attention.heading']));
 assert(rendered.includes(en['guidance.kv.cause']));
 assert(rendered.includes(en['guidance.action.recoverDeadWork']),'액션 라벨이 en 사전 값이 아닙니다');
 assert(rendered.includes(en['guidance.ignorable.false']));
 // 코어가 남긴 원문은 번역하지 않고 그대로 보여준다.
 assert(rendered.includes('LLM boom'),'알 수 없는 오류의 원문이 사라졌습니다');
});

test('[L4] en에서는 문서가 한국어라는 고지를 붙이고 ko에서는 붙이지 않는다',()=>{
 useEn();
 assert.equal(help.docsNotice(),en['help.docs.koreanOnly']);
 assert(help.docsNotice().length>0,'en 고지가 비었습니다');
 assert.equal(HANGUL.test(help.docsNotice()),false);
 useKo();
 assert.equal(help.docsNotice(),'','ko에서는 고지를 붙이지 않습니다');
 assert.equal(help.PAGES['/facts'].title,ko['help.page.facts.title']);
 useEn();
});
