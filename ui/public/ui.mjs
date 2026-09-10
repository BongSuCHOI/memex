import {badgeHelp,helpFor} from './help.mjs';
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
export const label={ASSERTED:'기억 확정',RETIRED:'비활성화',RELATION_CREATED:'관계 생성',RELATION_REMOVED:'관계 제거',active:'활성',inactive:'비활성',running:'실행 중',pending:'대기',processing:'처리 중',processed:'처리 완료',completed:'완료',failed:'실패',dead:'실패 · 종료',retry:'재시도 대기',superseded:'새 버전으로 대체',reserved:'시도 예약',unknown:'상태 미확인',cancelled:'중단됨',cancelling:'중단 요청 중','timed-out':'시간 제한 종료','failed-visible':'실패 · 확인 필요',injected:'기억 제공',emitted:'컨텍스트 제공',prepared:'제공 준비',deduped:'중복 제공 생략','no-match':'관련 기억 없음',skipped:'정책상 생략',error:'오류',observed:'관측됨',partial:'부분 관측',NOT_PROVEN:'미수집',decision:'결정',preference:'선호',constraint:'제약',pattern:'패턴',knowledge:'지식',CREATED:'기억 생성',CHANGED:'기억 변경',DEACTIVATED:'비활성화',REACTIVATED:'다시 활성화',RESTORED:'복원',PROMOTED:'계층 승격',DEMOTED:'계층 강등',SYNC_IMPORTED:'동기화 가져옴',CONSOLIDATED:'통합',CONTRADICTED:'충돌 감지',INCIDENT:'문제 발생',VALIDATED:'검증',REVERTED:'되돌림',REVERT_REQUESTED:'되돌림 요청',LEGACY:'이전 버전 기록',SUPPORTS:'뒷받침',INFLUENCES:'영향',SUPERSEDES:'대체',CONTRADICTS:'상충',fact_extract:'기억 추출',capture_index:'대화 인덱싱',capsule_update:'작업 맥락 갱신',ontology:'온톨로지 분류',extract:'기억 추출',user:'사용자',extractor:'추출기',consolidator:'통합기',sync:'기기 동기화',project:'프로젝트',global:'공통 기억',workspace:'워크스페이스',workstream:'작업 흐름','legacy-project':'이전 방식 배치','project-current':'프로젝트 현행','no-inject':'제공 없음'};
export const name=v=>label[v]||v||'미수집';
// 계층은 src/fact-management.ts factTierOf()와 같은 순서로 읽는다: scope_type이 먼저, 그다음 promotion_state.
export function tierOf(f){if(!f)return null;if(f.scope_type==='global')return 'global';const state=f.promotion_state||'legacy-project';return state==='workstream'||state==='workspace'?state:'project';}
// 브랜치 이름은 facts.tier_reason('branch:<name>')이 우선이고, 없으면 작업 흐름의 branch_hint를 쓴다. 추정하지 않는다.
export function tierBranch(f){const reason=String(f?.tier_reason||'');if(reason.startsWith('branch:'))return reason.slice(7)||null;return f?.workstream_branch||null;}
export function tierLabel(f){const tier=tierOf(f),branch=tierBranch(f);if(tier==='global')return '글로벌 공용';if(tier==='workstream')return branch?`브랜치: ${branch}`:'브랜치';if(tier==='workspace')return '워크스페이스';return '프로젝트 공용';}
export function tierExplain(f,project){const tier=tierOf(f),branch=tierBranch(f);
 if(tier==='global')return '모든 프로젝트의 세션에 주입 후보로 올라갑니다.';
 if(tier==='workstream')return branch?`브랜치 ${branch} 세션에만 주입됩니다.`:'이 기억을 만든 작업 흐름의 세션에만 주입됩니다.';
 if(tier==='workspace')return '이 체크아웃(워크스페이스)의 세션에만 주입됩니다.';
 return `프로젝트 ${project||'전체'}의 모든 세션에 주입됩니다.`;}
export const tierBadge=(f,project)=>`<span class="tag outline" data-tier="${esc(tierOf(f))}" title="${esc(tierExplain(f,project))}">${esc(tierLabel(f))}</span>`;
export const tierHiddenTotal=hidden=>hidden?Number(hidden.workstream||0)+Number(hidden.workspace||0):0;
export function badge(v,override){const color=override||(/^(active|completed|processed|injected|emitted|observed|CREATED|VALIDATED)$/.test(v)?'green':/^(failed|dead|error|failed-visible|CONTRADICTED|INCIDENT)$/.test(v)?'red':/^(running|processing|retry|reserved|pending|partial|prepared|cancelling|timed-out)$/.test(v)?'amber':/^(CHANGED|decision)$/.test(v)?'blue':v==='preference'?'purple':'');// 배지는 상태의 한국어 이름과, 그 상태가 무엇을 뜻하는지의 한 줄 설명(#28)을 함께 싣는다.
const tip=badgeHelp(v);return `<span class="tag ${esc(color)}"${tip?` title="${esc(tip)}"`:''}>${esc(name(v))}</span>`;}
export const number=v=>v===null||v===undefined?'—':Number(v).toLocaleString('ko-KR');
export const short=id=>id?String(id).slice(0,8):'—';
export const basename=p=>p?p.split('/').filter(Boolean).pop()||'/':'공통 기억';
function parseDate(value){if(!value)return null;const normalized=/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(value)?value.replace(' ','T')+'Z':value;const d=new Date(normalized);return Number.isNaN(d.valueOf())?null:d;}
export function date(value,mode='full'){const d=parseDate(value);if(!d)return '미수집';return new Intl.DateTimeFormat('ko-KR',mode==='day'?{month:'short',day:'numeric'}:mode==='time'?{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}:{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
export function relative(value){const d=parseDate(value);if(!d)return '미수집';const delta=(Date.now()-d)/1000;if(delta<0)return date(value);if(delta<60)return '방금 전';if(delta<3600)return `${Math.floor(delta/60)}분 전`;if(delta<86400)return `${Math.floor(delta/3600)}시간 전`;if(delta<86400*7)return `${Math.floor(delta/86400)}일 전`;return date(value,'day');}
export const duration=ms=>ms===null||ms===undefined?'미수집':ms<1000?`${number(ms)} ms`:ms<60000?`${(ms/1000).toFixed(1)} s`:`${Math.floor(ms/60000)}분 ${Math.round(ms%60000/1000)}초`;
export const bytes=b=>b===null||b===undefined?'미수집':b<1024?`${b} B`:b<1024**2?`${(b/1024).toFixed(1)} KB`:`${(b/1024**2).toFixed(1)} MB`;
/** 표 머리글의 한 줄 툴팁(#28). 설명이 없는 열은 그대로 둔다. */
export function th(label,key){const entry=helpFor('header:'+key);return entry?`<span title="${esc(entry.body)}">${esc(label)}</span>`:esc(label);}
export function header(title,subtitle,actions='',eyebrow='WORKSPACE',help=null){
 const entry=help?helpFor('page:'+help):null;
 const button=entry?`<button class="icon-btn help-toggle" data-help="page:${esc(help)}" aria-label="${esc(entry.title)} 도움말" title="${esc(entry.title)} 도움말">${icon('info')}</button>`:'';
 return `<div class="page-header"><div><div class="eyebrow">${esc(eyebrow)}</div><div class="row"><h1>${esc(title)}</h1>${button}</div><p>${esc(subtitle)}</p></div><div class="page-actions">${actions}</div></div>`;}
export const btn=(title,ico,attrs='',cls='')=>`<button class="btn ${esc(cls)}" ${attrs}>${ico?icon(ico):''}${esc(title)}</button>`;
export const linkBtn=(title,ico,href,cls='')=>`<a class="btn ${esc(cls)}" href="${esc(href)}" data-nav>${ico?icon(ico):''}${esc(title)}</a>`;
export const empty=(title,description,action='',ico='memory')=>`<div class="empty"><div class="empty-icon">${icon(ico)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
export const banner=(description,type='neutral',ico='info')=>`<div class="banner ${esc(type)}">${icon(ico)}<div>${description}</div></div>`;
export const raw=(data,title='원시 데이터')=>`<details class="json-details"><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`;
export function errorCard(error){return `<div class="card">${empty('데이터를 불러오지 못했습니다',error.message,btn('다시 시도','refresh','data-action="refresh"'),'warning')}<div class="error-code right" style="padding:0 20px 15px">${esc(error.code||'REQUEST_FAILED')}</div></div>`;}
export const skeleton=()=>`<div class="page-header"><div class="skeleton" style="width:180px;height:28px"></div></div><div class="loading-grid">${Array(4).fill('<div class="skeleton card"></div>').join('')}</div><div class="skeleton card mt" style="height:300px"></div>`;
export function pagination(page,ctx,keys={}){if(page.total===null||page.total===undefined)return '';const {offset,limit,total}=page;const prev=Math.max(0,offset-limit),next=offset+limit;return `<div class="pagination"><span>총 ${number(total)}개${total?` · ${number(offset+1)}–${number(Math.min(offset+limit,total))} 표시`:''}</span><div class="pages"><button class="btn" data-page="${prev}" ${keys.attr||''} ${offset===0?'disabled':''}>${icon('left')}이전</button><span>${Math.floor(offset/limit)+1} / ${Math.max(1,Math.ceil(total/limit))}</span><button class="btn" data-page="${next}" ${keys.attr||''} ${next>=total?'disabled':''}>다음${icon('chevron')}</button></div></div>`;}
export const table=(heads,rows)=>`<div class="table-wrap"><table class="data-table"><thead><tr>${heads.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
export const options=(items,current)=>items.map(([value,title])=>`<option value="${esc(value)}" ${String(value)===String(current??'')?'selected':''}>${esc(title)}</option>`).join('');
export const searchField=(value='',placeholder='검색',field='q')=>`<label class="search-field">${icon('search')}<input type="search" name="${esc(field)}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" maxlength="500"></label>`;
export const kv=rows=>`<dl class="kv">${rows.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
export const factLink=f=>`<button class="text-link" data-fact="${esc(f.id)}">${esc(f.fact_kr||f.fact||f.id)}</button>`;
/**
 * 동기화 가져오기 충돌 이벤트의 출처 (#48, 0.6.3).
 *
 * `SYNC_IMPORTED`의 `outcome_json`에 들어 있는 것만 읽는다: 어느 기기(별칭 또는 id 앞 8자)의 어느
 * 세대에서 왔고, 의미가 달랐을 때 누가 남았는지. 값이 없으면 null을 돌려주고 **지어내지 않는다.**
 */
const SYNC_REASON={'peer-newer':'가져온 쪽의 의미 수정 시각이 더 최근입니다.','local-newer':'이 기기의 의미 수정 시각이 더 최근입니다.','tie-broken-by-key':'수정 시각이 같아 결정적 규칙(정규화된 내용 키)으로 정했습니다.'};
export function syncOrigin(e){
 if(!e||e.event_kind!=='SYNC_IMPORTED')return null;
 let outcome=e.outcome??e.outcome_json;
 if(typeof outcome==='string'){try{outcome=JSON.parse(outcome);}catch{return null;}}
 if(!outcome||typeof outcome!=='object')return null;
 const device=outcome.source_device_alias||(outcome.source_device_id?short(outcome.source_device_id):null);
 return {device,alias:outcome.source_device_alias||null,deviceId:outcome.source_device_id||null,
  generation:outcome.generation||null,winner:['peer','local'].includes(outcome.winner)?outcome.winner:null,
  reason:outcome.reason||null,reasonText:SYNC_REASON[outcome.reason]||null};
}
export function syncOriginTag(e){
 const o=syncOrigin(e);if(!o)return '';
 const label=o.device?`기기 ${o.device}에서 가져옴`:'다른 기기에서 가져옴';
 const winner=o.winner==='local'?'이 기기의 값이 남음':o.winner==='peer'?'가져온 값으로 대체됨':'';
 return `<span class="tag outline"${o.reasonText?` title="${esc(o.reasonText)}"`:''}>${esc(label)}</span>${winner?`<span class="tag ${o.winner==='peer'?'blue':''}">${esc(winner)}</span>`:''}`;
}
export function eventRow(e){return `<div class="timeline-item"><div class="timeline-icon">${icon(e.event_kind==='CREATED'?'memory':e.event_kind==='INCIDENT'?'warning':e.event_kind==='SYNC_IMPORTED'?'layers':'refresh')}</div><div class="grow"><div class="row wrap">${badge(e.event_kind||'LEGACY')}<span class="meta">${esc(name(e.actor))}</span>${syncOriginTag(e)}</div>${e.fact_id?`<button class="title" data-fact="${esc(e.fact_id)}">${esc(e.new_fact||e.previous_fact||e.reason||e.subject_key||'기억 상태 변경')}</button>`:`<div class="title">${esc(e.problem||e.reason||e.subject_key||'지식 이벤트')}</div>`}<div class="meta"><span title="기록한 시각">${esc(date(e.recorded_at||e.created_at))}</span>${e.effective_at?`<span>발생 ${esc(date(e.effective_at,'day'))}</span>`:''}${e.projection_applied===0?'<span>현재 기억 변경 없음</span>':''}</div></div><button class="icon-btn" data-event='${esc(JSON.stringify(e))}' aria-label="이벤트 상세">${icon('chevron')}</button></div>`;}
export function markdown(input){
  // Deliberately small, safe Markdown subset. Raw HTML and remote images never execute/load.
  const source=String(input??'').slice(0,250000);const chunks=source.split(/```/);
  const inline=t=>esc(t).replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
  const rendered=chunks.map((chunk,i)=>i%2?`<pre><code>${esc(chunk.replace(/^[a-zA-Z0-9_-]*\n/,''))}</code></pre>`:chunk.split(/\n\s*\n/).map(block=>{
    if(/^#{1,4} /.test(block))return '<h3>'+inline(block.replace(/^#{1,4} /,''))+'</h3>';
    return '<p>'+inline(block).replaceAll('\n','<br>')+'</p>';
  }).join('')).join('');return `<div class="markdown">${rendered}${source.length<String(input??'').length?'<p class="muted">브라우저 표시 한도 250,000자를 초과했습니다.</p>':''}</div>`;
}
export function download(data,name,type='application/json'){const blob=new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export async function copy(text){if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);const el=document.createElement('textarea');el.value=text;document.body.append(el);el.select();const ok=document.execCommand('copy');el.remove();if(!ok)throw new Error('클립보드에 접근할 수 없습니다.');}
