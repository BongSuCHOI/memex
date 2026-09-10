import {badgeHelp,helpFor} from './help.mjs';
import {t,tHtml,tn,intlTag,localeTag} from './i18n/index.mjs';
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={
 grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z',
 memory:'M9 3H5a2 2 0 0 0-2 2v4 M15 3h4a2 2 0 0 1 2 2v4 M21 15v4a2 2 0 0 1-2 2h-4 M9 21H5a2 2 0 0 1-2-2v-4 M8 8h8v8H8z',
 folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
 graph:'M12 5l-6 9 M12 5l6 9 M6 17h12 M12 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M5 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M19 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
 activity:'M3 12h4l3-8 4 16 3-8h4',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
 search:'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
 arrow:'M5 12h14 M13 6l6 6-6 6',left:'M19 12H5 M11 6l-6 6 6 6',chevron:'M9 5l7 7-7 7',down:'M6 9l6 6 6-6',
 close:'M6 6l12 12 M18 6L6 18',check:'M5 12l4 4L19 6',
 refresh:'M20 7V3l-4 4 M4 17v4l4-4 M20 7a8 8 0 0 0-14-2 M4 17a8 8 0 0 0 14 2',
 clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
 info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7v1',
 warning:'M12 3L2 21h20L12 3z M12 9v5 M12 17v1',
 link:'M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l2-2',
 layers:'M12 3L2 8l10 5 10-5-10-5z M2 12l10 5 10-5 M2 16l10 5 10-5',
 play:'M7 4l14 8-14 8V4z',pause:'M7 4v16 M17 4v16',
 download:'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',copy:'M9 9h12v12H9z M15 9V3H3v12h6',
 edit:'M15 4l5 5 M4 20l5-1L21 7l-4-4L5 15l-1 5z',trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
 shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3z M8 12l3 3 5-6',
 terminal:'M4 7l5 5-5 5 M12 17h8',branch:'M6 3v12a5 5 0 0 0 10 0V9 M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M16 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
 database:'M3 6a9 3 0 1 0 18 0 9 3 0 0 0-18 0 M3 6v12c0 4 18 4 18 0V6 M3 12c0 4 18 4 18 0',
 sun:'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10 M12 1v3 M12 20v3 M1 12h3 M20 12h3 M4 4l2 2 M18 18l2 2 M4 20l2-2 M18 6l2-2',
 moon:'M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11z',menu:'M3 6h18 M3 12h18 M3 18h18',
 maximize:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',focus:'M9 3H3v6 M15 3h6v6 M21 15v6h-6 M3 15v6h6 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
 code:'M8 5L2 12l6 7 M16 5l6 7-6 7 M14 3l-4 18',external:'M14 3h7v7 M21 3L10 14 M10 3H3v18h18v-7',
};
export const icon=(name,cls='')=>`<svg class="icon ${esc(cls)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.info}"/></svg>`;
/**
 * 상태·이벤트·액터·작업 종류의 표시 이름 (#109 · 설계 §2.6 · §12.3 X1).
 *
 * 0.6.x의 `export const label={…}` 71항목 테이블을 없애고 `badge/` 네임스페이스의
 * `badge.<value>.label`을 조회한다. 사전에 없는 값은 **코어 원문을 그대로** 돌려준다 —
 * 이 화면의 규율은 "모르는 값의 이름을 지어내지 않는다"다.
 */
export const name=v=>{
 if(v===null||v===undefined||v==='')return t('common.unknown');
 const key=`badge.${v}.label`;const out=t(key);
 return out===key?String(v):out;
};
// 계층은 src/fact-management.ts factTierOf()와 같은 순서로 읽는다: scope_type이 먼저, 그다음 promotion_state.
export function tierOf(f){if(!f)return null;if(f.scope_type==='global')return 'global';const state=f.promotion_state||'legacy-project';return state==='workstream'||state==='workspace'?state:'project';}
// 브랜치 이름은 facts.tier_reason('branch:<name>')이 우선이고, 없으면 작업 흐름의 branch_hint를 쓴다. 추정하지 않는다.
export function tierBranch(f){const reason=String(f?.tier_reason||'');if(reason.startsWith('branch:'))return reason.slice(7)||null;return f?.workstream_branch||null;}
export function tierLabel(f){const tier=tierOf(f),branch=tierBranch(f);
 if(tier==='global')return t('tier.global.label');
 if(tier==='workstream')return branch?t('tier.workstream.branch',{branch}):t('tier.workstream.label');
 if(tier==='workspace')return t('tier.workspace.label');
 return t('tier.project.label');}
export function tierExplain(f,project){const tier=tierOf(f),branch=tierBranch(f);
 if(tier==='global')return t('tier.global.explain');
 if(tier==='workstream')return branch?t('tier.workstream.explain.branch',{branch}):t('tier.workstream.explain');
 if(tier==='workspace')return t('tier.workspace.explain');
 return t('tier.project.explain',{project:project||t('common.allProjects')});}
export const tierBadge=(f,project)=>`<span class="tag outline" data-tier="${esc(tierOf(f))}" title="${esc(tierExplain(f,project))}">${esc(tierLabel(f))}</span>`;
export const tierHiddenTotal=hidden=>hidden?Number(hidden.workstream||0)+Number(hidden.workspace||0):0;
export function badge(v,override){const color=override||(/^(active|completed|processed|injected|emitted|observed|CREATED|VALIDATED)$/.test(v)?'green':/^(failed|dead|error|failed-visible|CONTRADICTED|INCIDENT)$/.test(v)?'red':/^(running|processing|retry|reserved|pending|partial|prepared|cancelling|timed-out)$/.test(v)?'amber':/^(CHANGED|decision)$/.test(v)?'blue':v==='preference'?'purple':'');// 배지는 상태의 한국어 이름과, 그 상태가 무엇을 뜻하는지의 한 줄 설명(#28)을 함께 싣는다.
const tip=badgeHelp(v);return `<span class="tag ${esc(color)}"${tip?` title="${esc(tip)}"`:''}>${esc(name(v))}</span>`;}
export const number=v=>v===null||v===undefined?'—':Number(v).toLocaleString(intlTag());
export const short=id=>id?String(id).slice(0,8):'—';
export const basename=p=>p?p.split('/').filter(Boolean).pop()||'/':t('common.commonMemory');
function parseDate(value){if(!value)return null;const normalized=/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(value)?value.replace(' ','T')+'Z':value;const d=new Date(normalized);return Number.isNaN(d.valueOf())?null:d;}
// 24시간제를 유지한다 — en-US 기본은 12시간제인데 이 화면은 로그·작업 시각을 읽는 운영 화면이고
// 열 폭이 ko 화면과 같아야 한다. 타임존은 건드리지 않는다(브라우저 로컬, 설계 §4).
export function date(value,mode='full'){const d=parseDate(value);if(!d)return t('common.unknown');return new Intl.DateTimeFormat(intlTag(),mode==='day'?{month:'short',day:'numeric'}:mode==='time'?{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}:{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
/** 상대 시간은 사전에서 빼고 Intl에 맡긴다 — 영어 복수형이 공짜로 해결된다(설계 §4). */
export function relative(value){const d=parseDate(value);if(!d)return t('common.unknown');const delta=(Date.now()-d)/1000;if(delta<0)return date(value);
 const rtf=new Intl.RelativeTimeFormat(intlTag(),{numeric:'auto'});
 if(delta<60)return rtf.format(-Math.floor(delta),'second');
 if(delta<3600)return rtf.format(-Math.floor(delta/60),'minute');
 if(delta<86400)return rtf.format(-Math.floor(delta/3600),'hour');
 if(delta<86400*7)return rtf.format(-Math.floor(delta/86400),'day');
 return date(value,'day');}
export const duration=ms=>ms===null||ms===undefined?t('common.unknown')
 :ms<1000?t('unit.duration.ms',{value:number(ms)})
 :ms<60000?t('unit.duration.sec',{value:(ms/1000).toFixed(1)})
 :t('unit.duration.minsec',{m:Math.floor(ms/60000),s:Math.round(ms%60000/1000)});
export const bytes=b=>b===null||b===undefined?t('common.unknown')
 :b<1024?t('unit.bytes.b',{value:b})
 :b<1024**2?t('unit.bytes.kb',{value:(b/1024).toFixed(1)})
 :t('unit.bytes.mb',{value:(b/1024**2).toFixed(1)});
/** 표 머리글의 한 줄 툴팁(#28). 설명이 없는 열은 그대로 둔다. */
export function th(label,key){const entry=helpFor('header:'+key);return entry?`<span title="${esc(entry.body)}">${esc(label)}</span>`:esc(label);}
export function header(title,subtitle,actions='',eyebrow='WORKSPACE',help=null){
 const entry=help?helpFor('page:'+help):null;
 // 문장 조립 금지 — 영어는 "<title> help"가 아니라 "Help for <title>"이 자연스럽다(설계 §2.3).
 const aria=entry?t('a11y.pageHelp',{title:entry.title}):'';
 const button=entry?`<button class="icon-btn help-toggle" data-help="page:${esc(help)}" aria-label="${esc(aria)}" title="${esc(aria)}">${icon('info')}</button>`:'';
 return `<div class="page-header"><div><div class="eyebrow">${esc(eyebrow)}</div><div class="row"><h1>${esc(title)}</h1>${button}</div><p>${esc(subtitle)}</p></div><div class="page-actions">${actions}</div></div>`;}
export const btn=(title,ico,attrs='',cls='')=>`<button class="btn ${esc(cls)}" ${attrs}>${ico?icon(ico):''}${esc(title)}</button>`;
export const linkBtn=(title,ico,href,cls='')=>`<a class="btn ${esc(cls)}" href="${esc(href)}" data-nav>${ico?icon(ico):''}${esc(title)}</a>`;
export const empty=(title,description,action='',ico='memory')=>`<div class="empty"><div class="empty-icon">${icon(ico)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
export const banner=(description,type='neutral',ico='info')=>`<div class="banner ${esc(type)}">${icon(ico)}<div>${description}</div></div>`;
// 기본 제목은 **호출 시점에** 평가해야 한다 — 기본 인자는 모듈 평가 시점이 아니라 호출마다
// 계산되므로 사전이 꽂힌 뒤의 언어를 쓴다(설계 §2.6).
export const raw=(data,title)=>`<details class="json-details"><summary>${esc(title??t('common.rawData'))}</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`;
/**
 * 오류 카드. `key===null`(코어·런타임 원문)이면 "코어가 보고한 내용" 캡션을 덧붙인다 —
 * 번역 누락이 아니라는 것을 화면이 알려야 한다(설계 §5.2). 행별 오류는 renderIssues()가 그린다.
 */
export function errorCard(error){
 const e=error||{};
 const fromCore=(e.key??null)===null&&!!e.message;
 const issues=Array.isArray(e.issues)?e.issues:(Array.isArray(e.details?.issues)?e.details.issues:[]);
 return `<div class="card">${empty(t('error.card.title'),e.message||t('error.client.unknown'),btn(t('action.retry'),'refresh','data-action="refresh"'),'warning')}`
  +(fromCore?`<p class="caption" style="padding:0 20px">${esc(t('error.fromCore'))}</p>`:'')
  +(issues.length?`<div style="padding:0 20px">${renderIssues(issues)}</div>`:'')
  +`<div class="error-code right" style="padding:0 20px 15px">${esc(e.code||'REQUEST_FAILED')}</div></div>`;}
/**
 * 행별 검증 오류 (#109 · 설계 §5.2 F2). 422 응답의 `details.issues`를 목록으로 그린다.
 * 오버레이·모델 설정 레인이 그대로 호출한다 — 새 CSS 컴포넌트는 만들지 않는다.
 *
 * 위치 표기는 `path`(구조적 경로)가 가장 구체적이므로 먼저 본다. 서버 경계에서 변환하지
 * 않으므로 생산자가 쓴 표기가 그대로 도착한다.
 */
function issueLocation(i){
 if(typeof i.path==='string'&&i.path)return i.path;
 if(Number.isInteger(i.row))return t('error.issue.at',{row:i.row,field:i.field??t('common.unknown')});
 return typeof i.field==='string'?i.field:'';
}
export function renderIssues(issues){
 const list=Array.isArray(issues)?issues:[];
 if(!list.length)return '';
 return `<ul class="issue-list">${list.map(i=>{
  const where=issueLocation(i);
  const text=i.key?t(i.key,i.params||undefined):(i.message||t('error.client.unknown'));
  const warn=i.severity==='warning';
  return `<li${warn?' class="muted"':''}>`
   +(warn?`<span class="tag amber">${esc(t('error.issue.warning'))}</span> `:'')
   +(where?`<code>${esc(where)}</code> `:'')
   +esc(text)+`</li>`;
 }).join('')}</ul>`;
}
export const skeleton=()=>`<div class="page-header"><div class="skeleton" style="width:180px;height:28px"></div></div><div class="loading-grid">${Array(4).fill('<div class="skeleton card"></div>').join('')}</div><div class="skeleton card mt" style="height:300px"></div>`;
export function pagination(page,ctx,keys={}){if(page.total===null||page.total===undefined)return '';const {offset,limit,total}=page;const prev=Math.max(0,offset-limit),next=offset+limit;
 const count=tn('pagination.total',total,{total:number(total)});
 const range=total?` · ${t('pagination.range',{from:number(offset+1),to:number(Math.min(offset+limit,total))})}`:'';
 const pages=t('pagination.page',{page:Math.floor(offset/limit)+1,pages:Math.max(1,Math.ceil(total/limit))});
 return `<div class="pagination"><span>${esc(count)}${esc(range)}</span><div class="pages"><button class="btn" data-page="${prev}" ${keys.attr||''} ${offset===0?'disabled':''}>${icon('left')}${esc(t('action.previous'))}</button><span>${esc(pages)}</span><button class="btn" data-page="${next}" ${keys.attr||''} ${next>=total?'disabled':''}>${esc(t('action.next'))}${icon('chevron')}</button></div></div>`;}
export const table=(heads,rows)=>`<div class="table-wrap"><table class="data-table"><thead><tr>${heads.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
export const options=(items,current)=>items.map(([value,title])=>`<option value="${esc(value)}" ${String(value)===String(current??'')?'selected':''}>${esc(title)}</option>`).join('');
export const searchField=(value='',placeholder,field='q')=>{const label=placeholder??t('common.search');
 return `<label class="search-field">${icon('search')}<input type="search" name="${esc(field)}" value="${esc(value)}" placeholder="${esc(label)}" aria-label="${esc(label)}" maxlength="500"></label>`;};
export const kv=rows=>`<dl class="kv">${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
/**
 * 기억 본문의 저장된 한국어 번역(`fact_kr`) 우선 표시 여부 (#109 · 설계 §14.5).
 *
 * 0.6.x의 `factLink`는 `fact_kr`를 **무조건** 먼저 썼고, 그래서 en 화면·en 스크린샷의 관계
 * 링크와 연결된 기억 버튼에 한국어가 그대로 남았다. app.mjs가 `prefs.preferTranslatedFacts`를
 * 여기에 꽂는다 — 호출부 시그니처를 바꾸지 않으려고 모듈 상태로 둔다. 꽂히기 전의 기본값은
 * 화면 언어를 따른다.
 */
let preferTranslatedFacts=null;
export const setPreferTranslatedFacts=value=>{preferTranslatedFacts=value===null||value===undefined?null:!!value;};
export const translatesFacts=()=>preferTranslatedFacts??(localeTag()==='ko');
export const factText=f=>String((translatesFacts()&&f?.fact_kr)||f?.fact||f?.id||'');
export const factLink=f=>`<button class="text-link" data-fact="${esc(f.id)}">${esc(factText(f))}</button>`;
/**
 * 동기화 가져오기 충돌 이벤트의 출처 (#48, 0.6.3).
 *
 * `SYNC_IMPORTED`의 `outcome_json`에 들어 있는 것만 읽는다: 어느 기기(별칭 또는 id 앞 8자)의 어느
 * 세대에서 왔고, 의미가 달랐을 때 누가 남았는지. 값이 없으면 null을 돌려주고 **지어내지 않는다.**
 */
// 사유 문구는 조회 시점에 사전에서 읽는다 — 값 테이블을 두면 import 시점에 평가돼 사전보다 먼저
// 굳는다(설계 §2.6). 키는 리터럴로 적어 사전 완전성 검사가 3개를 실제로 볼 수 있게 한다.
const SYNC_REASON={
 'peer-newer':()=>t('sync.reason.peer-newer'),
 'local-newer':()=>t('sync.reason.local-newer'),
 'tie-broken-by-key':()=>t('sync.reason.tie-broken-by-key'),
};
const syncReasonText=reason=>(Object.hasOwn(SYNC_REASON,reason??'')?SYNC_REASON[reason]():null);
export function syncOrigin(e){
 if(!e||e.event_kind!=='SYNC_IMPORTED')return null;
 let outcome=e.outcome??e.outcome_json;
 if(typeof outcome==='string'){try{outcome=JSON.parse(outcome);}catch{return null;}}
 if(!outcome||typeof outcome!=='object')return null;
 const device=outcome.source_device_alias||(outcome.source_device_id?short(outcome.source_device_id):null);
 return {device,alias:outcome.source_device_alias||null,deviceId:outcome.source_device_id||null,
  generation:outcome.generation||null,winner:['peer','local'].includes(outcome.winner)?outcome.winner:null,
  reason:outcome.reason||null,reasonText:syncReasonText(outcome.reason)};
}
export function syncOriginTag(e){
 const o=syncOrigin(e);if(!o)return '';
 const label=o.device?t('sync.origin.fromDevice',{device:o.device}):t('sync.origin.fromOtherDevice');
 const winner=o.winner==='local'?t('sync.winner.local'):o.winner==='peer'?t('sync.winner.peer'):'';
 return `<span class="tag outline"${o.reasonText?` title="${esc(o.reasonText)}"`:''}>${esc(label)}</span>${winner?`<span class="tag ${o.winner==='peer'?'blue':''}">${esc(winner)}</span>`:''}`;
}
export function eventRow(e){return `<div class="timeline-item"><div class="timeline-icon">${icon(e.event_kind==='CREATED'?'memory':e.event_kind==='INCIDENT'?'warning':e.event_kind==='SYNC_IMPORTED'?'layers':'refresh')}</div><div class="grow"><div class="row wrap">${badge(e.event_kind||'LEGACY')}<span class="meta">${esc(name(e.actor))}</span>${syncOriginTag(e)}</div>${e.fact_id?`<button class="title" data-fact="${esc(e.fact_id)}">${esc(e.new_fact||e.previous_fact||e.reason||e.subject_key||t('event.fact.defaultTitle'))}</button>`:`<div class="title">${esc(e.problem||e.reason||e.subject_key||t('event.knowledge.defaultTitle'))}</div>`}<div class="meta"><span title="${esc(t('a11y.recordedAt'))}">${esc(date(e.recorded_at||e.created_at))}</span>${e.effective_at?`<span>${esc(t('event.occurredAt',{date:date(e.effective_at,'day')}))}</span>`:''}${e.projection_applied===0?`<span>${esc(t('event.noFactChange'))}</span>`:''}</div></div><button class="icon-btn" data-event='${esc(JSON.stringify(e))}' aria-label="${esc(t('a11y.eventDetail'))}">${icon('chevron')}</button></div>`;}
/** 브라우저 표시 한도. 문구에 보간되므로 상수로 둔다. */
const MARKDOWN_LIMIT=250000;
export function markdown(input){
  // Deliberately small, safe Markdown subset. Raw HTML and remote images never execute/load.
  const source=String(input??'').slice(0,MARKDOWN_LIMIT);const chunks=source.split(/```/);
  // 이름을 `inline`으로 둔다 — 0.6.x의 `t=>…`는 번역 함수 t를 가렸다.
  const inline=text=>esc(text).replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  const rendered=chunks.map((chunk,i)=>i%2?`<pre><code>${esc(chunk.replace(/^[a-zA-Z0-9_-]*\n/,''))}</code></pre>`:chunk.split(/\n\s*\n/).map(block=>{
    if(/^#{1,4} /.test(block))return '<h3>'+inline(block.replace(/^#{1,4} /,''))+'</h3>';
    return '<p>'+inline(block).replaceAll('\n','<br>')+'</p>';
  }).join('')).join('');return `<div class="markdown">${rendered}${source.length<String(input??'').length?`<p class="muted">${esc(t('common.markdownTruncated',{max:number(MARKDOWN_LIMIT)}))}</p>`:''}</div>`;
}
export function download(data,name,type='application/json'){const blob=new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export async function copy(text){if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);const el=document.createElement('textarea');el.value=text;document.body.append(el);el.select();const ok=document.execCommand('copy');el.remove();if(!ok)throw new Error(t('error.client.clipboardUnavailable'));}
