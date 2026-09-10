import {esc,icon,header,btn,linkBtn,empty,banner,table,pagination,options,searchField,eventRow,badge,name,number,date,duration,short,raw,kv,th,tierHiddenTotal} from '../ui.mjs';
import {classify,guidanceCell,guidancePanel,guidanceFor,jobGuidance,attemptGuidance,operationGuidance} from '../guidance.mjs';
import {t,tHtml,tn} from '../i18n/index.mjs';
import {payloadText} from '../api.mjs';
// 사전은 boot()에서 꽂히므로 탭·상태 표는 모듈 최상위 상수가 아니라 함수로 둔다(설계 §2.6).
const tabsOf=()=>[['chronicle',t('activity.tab.chronicle')],['jobs',t('activity.tab.jobs')],['attempts',t('activity.tab.attempts')],['recalls',t('activity.tab.recalls')],['logs',t('activity.tab.logs')],['operations',t('activity.tab.operations')]];
// inject-context 로그는 0개를 제공해도 status가 injected로 남는다. 0건은 성공 색으로 표시하지 않는다.
export const logStatus=r=>r.status==='injected'&&Number(r.data?.injected)===0?'no-inject':r.status;
/** 오류로 분류된 로그 행에만 클래스 설명을 붙인다. 정상 행에는 아무것도 덧붙이지 않는다. */
export function logGuidance(r,ctx){
 const status=logStatus(r);
 if(!/error|fail|dead|retry/i.test(String(status))&&!r.data?.error&&status!=='no-inject'&&status!=='no-match')return '';
 const cls=classify({status,error:r.data?.error||r.data?.message||r.raw});
 return cls?`<div class="mb"><h3>${esc(t('activity.nextAction'))}</h3>${guidanceCell(cls,ctx)}</div>`:'';
}
/**
 * `memory_jobs.hold_reason` → 그 보류를 **소유한 화면**. 사유마다 고치는 곳이 다르므로 "다음
 * 행동"도 다르다. 모르는 사유는 지어내지 않고 링크 없이 배지만 남긴다.
 */
const HOLD_OWNER={
 model_config_rejected:{query:{tab:'models'},labelKey:'guidance.action.viewModelSettings'},
 extraction_rules_invalid:{query:{tab:'overlays',overlay:'rules'},labelKey:'guidance.action.viewExtractionRules'},
 extraction_rules_unavailable:{query:{tab:'overlays',overlay:'rules'},labelKey:'guidance.action.viewExtractionRules'},
};
/** 상태 배지 옆의 보류 사유 배지. 대기(pending)로만 보이면 "기다리면 풀린다"로 읽힌다. */
export function holdBadge(j){
 const reason=j?.hold_reason;
 return reason?`<span class="tag amber">${esc(t('common.job.hold.'+reason))}</span>`:'';
}
/** 보류 행의 한 줄 다음 행동. 사유를 소유한 관리 탭으로 곧장 보낸다. */
export function holdNext(j,ctx){
 const owner=HOLD_OWNER[j?.hold_reason];
 if(!owner)return '';
 return `<div class="stack-sm mt"><p class="caption">${esc(t('activity.jobs.hold.next'))}</p>${linkBtn(t(owner.labelKey),'arrow',ctx.href('/settings',owner.query),'small ghost')}</div>`;
}
// 필터의 상태 이름은 배지(status.*, L1)보다 짧게 쓴다 — 드롭다운 폭 때문이다.
const statusesOf=()=>({
 jobs:[['',t('activity.filter.state.all')],['running',t('activity.filter.state.running')],['pending',t('activity.filter.state.pending')],['retry',t('activity.filter.state.retry')],['completed',t('activity.filter.state.completed')],['dead',t('activity.filter.state.dead')],['superseded',t('activity.filter.state.superseded')]],
 attempts:[['',t('activity.filter.state.all')],['reserved',t('activity.filter.state.reserved')],['completed',t('activity.filter.state.completed')],['failed',t('activity.filter.state.failed')],['unknown',t('activity.filter.state.unknown')]],
 recalls:[['',t('activity.filter.state.all')],['prepared',t('activity.filter.state.prepared')],['emitted',t('activity.filter.state.emitted')]],
});
export async function render(ctx){
 const {p}=ctx;const tabs=tabsOf();const statuses=statusesOf();const tab=tabs.some(x=>x[0]===p.get('tab'))?p.get('tab'):'chronicle';let page,files=[],body='';const query=Object.fromEntries(p);query.limit='40';
 if(tab==='logs'){files=(await ctx.api('log-files')).items;query.file=p.get('file')||files[0]?.id||'';query.limit='200';page=await ctx.api('logs',query);}
 else if(tab==='operations'){page=await ctx.api('operations');}
 else page=await ctx.api(tab,query);
 // 컨텍스트 제공 탭의 "관련 기억 없음" 안내는 실제 기억 수를 근거로 말해야 한다.
 let factContext=null;if(tab==='recalls'){try{factContext=await ctx.api('facts',{limit:1});}catch{}}
 const tabbar=`<nav class="tabs" aria-label="${esc(t('activity.a11y.tabs'))}">${tabs.map(([k,v])=>`<a class="tab ${tab===k?'active':''}" href="${esc(ctx.href('/activity',{tab:k}))}" data-nav>${esc(v)}</a>`).join('')}</nav>`;
 let filter='';
 if(tab!=='operations'){
 const search=!['recalls'].includes(tab)?searchField(p.get('q')||'',tab==='jobs'?t('activity.search.jobs'):tab==='attempts'?t('activity.search.attempts'):tab==='logs'?t('activity.search.logs'):t('activity.search.chronicle')):'';
 const select=tab==='chronicle'?`<select name="kind" aria-label="${esc(t('activity.a11y.kind'))}">${options([['',t('activity.filter.kind.all')],...['ASSERTED','CHANGED','RETIRED','RESTORED','PROMOTED','DEMOTED','SYNC_IMPORTED','INCIDENT','REVERT_REQUESTED','VALIDATED'].map(k=>[k,name(k)])],p.get('kind'))}</select><select name="time" aria-label="${esc(t('activity.a11y.time'))}">${options([['recorded',t('activity.filter.time.recorded')],['effective',t('activity.filter.time.effective')]],p.get('time')||'effective')}</select>`:statuses[tab]?`<select name="state" aria-label="${esc(t('activity.a11y.state'))}">${options(statuses[tab],p.get('state'))}</select>`:tab==='logs'?`<select name="file" aria-label="${esc(t('activity.a11y.file'))}">${options(files.map(f=>[f.id,`${f.name} · ${f.group}`]),query.file)}</select><select name="level" aria-label="${esc(t('activity.a11y.level'))}">${options([['',t('activity.filter.level.all')],['error',t('activity.filter.level.error')]],p.get('level'))}</select>`:'';
 filter=`<form class="toolbar" data-filter>${search}${select}<input type="date" name="from" aria-label="${esc(t('activity.a11y.from'))}" title="${esc(t('activity.filter.from.title'))}" value="${esc(p.get('from')||'')}"><input type="date" name="to" aria-label="${esc(t('activity.a11y.to'))}" title="${esc(t('activity.filter.to.title'))}" value="${esc(p.get('to')||'')}">${btn(t('activity.action.apply'),'search','type="submit"')}${btn(t('activity.action.reset'),null,'type="button" data-action="activity-reset"','ghost')}</form>`;
 }
 // 카드 밖에 놓는 탭 단위 안내(#23). 안에 넣으면 카드가 중첩된다.
 let lead='';
 if(tab==='chronicle'&&page.items?.some(e=>e.event_kind==='INCIDENT')){
  const incident=page.items.find(e=>e.event_kind==='INCIDENT');
  lead=guidancePanel(classify({error:incident.problem||incident.grounded_cause||incident.reason}),ctx,`<p class="caption">${esc(t('activity.chronicle.incident.note'))}</p>`);
 }
 if(tab==='recalls'){
  const prepared=page.items?.filter(r=>r.status==='prepared'&&!r.emitted_at).length||0;
  if(!page.items?.length&&page.available!==false)lead+=guidancePanel(guidanceFor('no-match'),ctx,factContext?kv([[t('activity.recalls.context.active'),number(factContext.total)],[t('activity.recalls.context.hidden'),number(tierHiddenTotal(factContext.hiddenByTier))]]):`<p class="caption">${esc(t('activity.recalls.context.unavailable'))}</p>`);
  if(prepared)lead+=guidancePanel(guidanceFor('receipt-failed'),ctx,`<p class="caption">${esc(tn('activity.recalls.prepared.note',prepared,{n:number(prepared)}))}</p>`);
 }
 // 서버는 사유 문장을 만들지 않고 `reasonKey`(+params)만 싣는다 — 표 이름이 사라지지 않도록 payloadText로 읽는다(설계 §5.3 분류 c).
 if(page.available===false)body=empty(t('activity.unavailable.title'),payloadText(page,'reason')||t('activity.unavailable.body'),'','activity');
 else if(tab==='chronicle')body=page.items.length?page.items.map(eventRow).join('')+pagination(page,ctx):empty(t('activity.chronicle.empty.title'),t('activity.chronicle.empty.body'),'','clock');
 else if(tab==='jobs')body=page.items.length?table([esc(t('activity.jobs.th.job')),esc(t('activity.jobs.th.state')),th(t('activity.jobs.th.attempts'),'attempts'),esc(t('activity.jobs.th.updated')),th(t('activity.nextAction'),'nextAction'),''],page.items.map(j=>`<tr><td><button class="text-link" data-job="${esc(j.job_id)}">${esc(name(j.kind))}</button><div class="meta mono">${esc(short(j.job_id))} · ${esc(short(j.session_id))}</div>${j.last_error?`<div class="cell-preview danger-text">${esc(j.last_error)}</div>`:''}${holdNext(j,ctx)}</td><td>${badge(j.state)}${holdBadge(j)}</td><td>${number(j.attempts)}${j.max_attempts!==null?` / ${number(j.max_attempts)}`:''}</td><td class="nowrap">${esc(date(j.updated_at))}</td><td>${guidanceCell(jobGuidance(j),ctx)}</td><td><button class="icon-btn" data-job="${esc(j.job_id)}" aria-label="${esc(t('activity.jobs.a11y.trace'))}">${icon('chevron')}</button></td></tr>`))+pagination(page,ctx):empty(t('activity.jobs.empty.title'),t('activity.jobs.empty.body'),'','activity');
 else if(tab==='attempts')body=page.items.length?table([esc(t('activity.attempts.th.stage')),esc(t('activity.attempts.th.state')),esc(t('activity.attempts.th.duration')),esc(t('activity.attempts.th.chars')),th(t('activity.attempts.th.tokens'),'tokens'),th(t('activity.nextAction'),'nextAction'),''],page.items.map(a=>`<tr><td><button class="text-link" data-attempt='${esc(JSON.stringify(a))}'>${esc(a.stage)}</button><div class="meta">${esc(date(a.started_at))} · #${number(a.attempt_no)}</div></td><td>${badge(a.state)}</td><td>${esc(duration(a.duration_ms))}</td><td>${number(a.input_chars)} / ${number(a.output_chars)}</td><td>${badge(a.token_usage_status||'NOT_PROVEN')}</td><td>${guidanceCell(attemptGuidance(a),ctx)}</td><td>${a.job_id?`<button class="icon-btn" data-job="${esc(a.job_id)}" aria-label="${esc(t('activity.attempts.a11y.job'))}">${icon('branch')}</button>`:''}</td></tr>`))+pagination(page,ctx):empty(t('activity.attempts.empty.title'),t('activity.attempts.empty.body'),'','activity');
 else if(tab==='recalls')body=banner(tHtml('activity.recalls.banner'))+(page.items.length?page.items.map(r=>`<details class="log-record"><summary><span class="log-time">${esc(date(r.emitted_at||r.created_at))}</span>${badge(r.status)}<span class="grow">${esc(tn('activity.recalls.summary',r.fact_ids.length,{n:number(r.fact_ids.length),session:short(r.session_id)}))}</span>${icon('down')}</summary><div class="card-body"><div class="row wrap">${linkBtn(t('activity.recalls.action.conversation'),'chat',ctx.href('/conversations',{session:r.session_id}))}${r.fact_ids.map(id=>`<button class="chip" data-fact="${esc(id)}">${icon('memory')}${esc(short(id))}</button>`).join('')}</div><p class="caption mt">${esc(t('activity.recalls.note'))}</p>${kv([[t('activity.recalls.kv.prepared'),esc(date(r.created_at))],[t('activity.recalls.kv.emitted'),esc(date(r.emitted_at))],[t('activity.recalls.kv.source'),esc(r.source_type||t('common.unknown'))],[t('activity.recalls.kv.promptHash'),`<code>${esc(r.prompt_hash||t('common.unknown'))}</code>`]])}${raw(r)}</div></details>`).join('')+pagination(page,ctx):empty(t('activity.recalls.empty.title'),t('activity.recalls.empty.body'),'','layers'));
 else if(tab==='logs')body=banner([t('activity.logs.banner.read',{bytes:number(page.bytesRead),limit:number(page.limit||200)}),page.truncated?t('activity.logs.banner.truncated'):'',page.hiddenForScope?t('activity.logs.banner.hidden',{n:number(page.hiddenForScope)}):'',t('activity.logs.banner.sensitive')].filter(Boolean).map(esc).join(' '))+(page.items.length?page.items.map(r=>`<details class="log-record"><summary><span class="log-time">${esc(r.timestamp?date(r.timestamp,'time'):t('activity.logs.noTimestamp'))}</span>${badge(logStatus(r))}<span class="grow cell-preview">${esc(r.data?.message||r.data?.error||r.data?.action||(r.data?.injected!==undefined?tn('activity.logs.injected',r.data.injected,{n:r.data.injected,ms:r.data.duration_ms??'—'}):r.raw))}</span>${icon('down')}</summary><div class="card-body">${logGuidance(r,ctx)}${r.data?kv(Object.entries(r.data).filter(([k,v])=>v===null||['string','number','boolean'].includes(typeof v)).map(([k,v])=>[k,esc(String(v??t('common.unknown')))])):''}<pre class="terminal">${esc(r.raw)}</pre></div></details>`).join(''):empty(t('activity.logs.empty.title'),ctx.scope.scope==='all'?t('activity.logs.empty.body.all'):t('activity.logs.empty.body.scoped'),'','terminal'));
 else if(tab==='operations')body=banner(tHtml('activity.operations.banner'))+(page.items.length?table([esc(t('activity.operations.th.command')),esc(t('activity.operations.th.state')),esc(t('activity.operations.th.started')),esc(t('activity.operations.th.exitCode')),th(t('activity.nextAction'),'nextAction'),''],page.items.map(o=>`<tr><td><button class="text-link" data-operation="${esc(o.id)}">${esc(o.label||o.command)}</button><div class="meta mono">${esc(short(o.id))}</div></td><td>${badge(o.status)}</td><td>${esc(date(o.started_at))}</td><td>${number(o.exit_code)}</td><td>${guidanceCell(operationGuidance(o),ctx)}</td><td><button class="icon-btn" data-operation="${esc(o.id)}" aria-label="${esc(t('activity.operations.a11y.output'))}">${icon('terminal')}</button></td></tr>`)):empty(t('activity.operations.empty.title'),t('activity.operations.empty.body'),linkBtn(t('activity.action.openAdmin'),'settings',ctx.href('/settings',{tab:'actions'})),'terminal'));
 // 활동 기록은 모두 세션(=프로젝트)에 묶여 있으므로 공통 기억 범위에서는 항상 비어 있다. 한 번의 클릭으로 전체 프로젝트로 넘어갈 수 있게 한다.
 const scopeBanner=ctx.scope.scope==='global'?banner(`<div class="spread"><div><strong>${esc(t('activity.globalScope.title'))}</strong><p>${esc(t('activity.globalScope.body'))}</p></div>${btn(t('activity.action.scopeAll'),'layers','data-action="scope-all"','small')}</div>`,'neutral','folder'):'';
 return {html:header(t('activity.title'),t('activity.subtitle'),btn(ctx.prefs.live?t('activity.action.liveOn'):t('activity.action.liveOff'),ctx.prefs.live?'pause':'play','data-action="toggle-live"',`live-button ${ctx.prefs.live?'active':''}`)+btn(t('activity.action.refresh'),'refresh','data-action="refresh"'),'OBSERVABILITY','/activity')+scopeBanner+tabbar+filter+lead+`<section class="card">${body}</section><div class="footer-note"><span>${esc(t('activity.footer.note'))}</span><span>${esc(tab==='operations'?t('activity.footer.scope.operations'):t('activity.footer.scope.current'))}</span></div>`,mount(el){el.querySelector('[data-action="activity-reset"]')?.addEventListener('click',()=>ctx.update({q:null,kind:null,state:null,time:null,from:null,to:null,level:null,offset:null}));}};
}
