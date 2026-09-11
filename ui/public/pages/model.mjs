import {esc,btn,banner,kv,options,table,number,date,duration,bytes} from '../ui.mjs';
import {t,tHtml} from '../i18n/index.mjs';
/**
 * 관리 › 모델 (#31, 0.7.0 · 설계 §12).
 *
 * This tab answers one question — *which model does Memex use for its own memory work, and
 * where did that choice come from* — and gives the two repairs the answer implies: change the
 * selection, or prove it with one real call. Everything it shows is read from the same core
 * functions `memex models` uses; the screen never guesses.
 *
 * Three things shape the layout:
 *  - **A hold is the headline.** When the provider refused the request envelope, model work is
 *    paused and nothing else on this screen matters until that is fixed. It goes above the cards
 *    with the provider's own sentence, and it says explicitly that no job failed and no attempt
 *    was consumed — the thing a user cannot tell from a red banner alone.
 *  - **The environment wins, so the screen admits it.** A value pinned by `MEMEX_CODEX_MODEL`
 *    is shown as a disabled control with the variable that beats it, not as an editable field
 *    that silently has no effect.
 *  - **The embedding section is read-only.** Changing it rebuilds every vector, which lands
 *    in a later 0.7.x release (#118, §7) — not in 0.7.1. Showing the resolved model now is
 *    honest; offering a select that cannot work is not.
 *
 * The tab registry calls `render(ctx, env)`; `modelTab()` is exported separately so the unit
 * tests can render every state without a server (the `syncTab` pattern).
 */

/** Where a resolved value came from. Literal t() calls — `--keys` harvests these. */
const sourceLabel=source=>source==='env'?t('models.source.env')
 :source==='file'?t('models.source.file')
 :source==='explicit'?t('models.source.explicit')
 :t('models.source.default');

/**
 * Server warnings arrive as machine codes, not i18n keys: the response crosses `ui/lib`, which
 * owns no dictionary, and a key assembled at runtime would be invisible to the extraction lint
 * (it would read as a dead translation). The mapping lives here, as literal calls.
 */
function warningText(warning){
 const p=warning.params||{};
 switch(warning.code){
  case 'MODEL_NOT_IN_CATALOG':return t('models.warning.modelNotInCatalog',p);
  case 'CATALOG_UNAVAILABLE':return t('models.warning.catalogUnavailable',p);
  case 'MODEL_HIDDEN_IN_CATALOG':return t('models.warning.modelHidden',p);
  case 'REASONING_UNSUPPORTED':return t('models.warning.reasoningUnsupported',p);
  case 'ENV_OVERRIDES_MODEL':return t('models.warning.envOverridesModel',p);
  case 'ENV_OVERRIDES_REASONING':return t('models.warning.envOverridesReasoning',p);
  case 'HOLD_CLEARED':return t('models.warning.holdCleared',p);
  default:return warning.code;
 }
}
export const warningLines=warnings=>(warnings||[]).map(warningText);

const reasoningText=value=>value||t('models.reasoning.none');

/** The provider's own refusal, above everything else. */
function holdBanner(hold,others){
 const body=`<strong>${esc(t('models.hold.title'))}</strong>`
  +`<p class="mt">${esc(t('models.hold.selection',{model:hold.model,reasoning:reasoningText(hold.reasoningEffort),status:hold.status??'?',type:hold.providerType||t('common.unknown'),n:number(hold.observedCount)}))}</p>`
  +`<p class="mt"><code class="wrap">${esc(hold.providerMessage)}</code></p>`
  +`<p class="caption mt">${esc(t('models.hold.noDamage'))}</p>`
  +(others>0?`<p class="caption mt">${esc(t('models.hold.others',{n:number(others)}))}</p>`:'');
 return banner(body,'error','warning');
}

/** Jobs parked on a configuration. The badge is lane-0's shared `common.job.hold.<reason>`. */
function heldJobsCard(rows){
 return `<section class="card pad mt" id="model-held-jobs"><h2>${esc(t('models.held.title'))}</h2>
 <p class="caption mt">${esc(t('models.held.body'))}</p>
 ${table([esc(t('models.held.col.reason')),esc(t('models.held.col.jobs')),esc(t('models.held.col.oldest'))],
   rows.map(r=>`<tr><td><span class="tag amber">${esc(t('common.job.hold.'+r.reason))}</span></td><td>${number(r.jobs)}</td><td class="nowrap">${esc(date(r.oldestHeldAt))}</td></tr>`))}</section>`;
}

/** Catalog provenance for the kv row — "what this Codex installation told us". */
function catalogSummary(catalog){
 if(!catalog||catalog.source==='none')return esc(t('models.catalog.none',{home:catalog?.codexHome||t('common.unknown')}));
 return `${esc(t('models.catalog.found',{n:number(catalog.models.length),path:catalog.path||t('common.unknown')}))}`
  +(catalog.fetchedAt?` <span class="caption">${esc(t('models.catalog.fetched',{at:date(catalog.fetchedAt)}))}</span>`:'');
}

function probeSummary(probe){
 if(!probe)return `<span class="muted">${esc(t('models.probe.never'))}</span>`;
 const when=date(probe.at);
 return probe.ok
  ? `<span class="tag green">${esc(t('models.probe.ok'))}</span> ${esc(t('models.probe.detail',{ms:duration(probe.latencyMs),at:when}))}`
  : `<span class="tag red">${esc(t('models.probe.failed',{reason:probe.errorClass||t('common.unknown')}))}</span> ${esc(t('models.probe.detail',{ms:duration(probe.latencyMs),at:when}))}`;
}

/** Model options: the catalog's listable entries, plus the current value whatever it is. */
function modelOptions(data){
 const catalog=data.llm.catalog;
 const items=(catalog?.models||[]).filter(m=>m.visible).map(m=>[m.slug,m.displayName&&m.displayName!==m.slug?`${m.slug} · ${m.displayName}`:m.slug]);
 const current=data.llm.effective.model.value;
 if(current&&!items.some(([slug])=>slug===current))items.unshift([current,current]);
 return options(items,current);
}

/** Reasoning options: what the catalog says this model accepts, else the provider union. */
function reasoningOptions(data){
 const levels=data.llm.catalogReasoning||data.llm.allowedReasoning||[];
 const current=data.llm.effective.reasoning.value;
 const items=[['unset',t('models.reasoning.unsetOption')],...levels.map(level=>[level,level])];
 if(current&&!levels.includes(current))items.push([current,current]);
 return options(items,current||'unset');
}

/**
 * 관리 › 모델 본문. `data`는 `/api/v2/models`의 status 응답이다.
 * @param {object} ctx 페이지 컨텍스트
 * @param {object} env bootstrap.environment
 * @param {object|null} data status 응답
 * @param {string|null} error 조회 실패 사유
 */
export function modelTab(ctx,env,data,error){
 if(!env.models)return banner(tHtml('models.missingCore'),'error');
 if(!data)return banner(esc(error||t('models.statusUnavailable')),'error');
 const llm=data.llm;
 const modelPinned=llm.effective.model.source==='env';
 const reasoningPinned=llm.effective.reasoning.source==='env';
 const pinTag=`<span class="tag amber">${esc(t('models.envPinned'))}</span>`;
 const currentHold=llm.hold||null;
 const otherHolds=(llm.holds||[]).filter(h=>!h.current).length;
 const heldJobs=llm.heldJobs||[];
 const levels=llm.catalogReasoning;
 const rows=[
  [t('models.row.effectiveModel'),`<code>${esc(llm.effective.model.value)}</code> <span class="caption">${esc(sourceLabel(llm.effective.model.source))}</span>`],
  [t('models.row.effectiveReasoning'),`<code>${esc(reasoningText(llm.effective.reasoning.value))}</code> <span class="caption">${esc(sourceLabel(llm.effective.reasoning.source))}</span>`],
  [t('models.row.default'),`<code>${esc(llm.defaults.model)}</code> <span class="caption">${esc(t('models.row.defaultNoReasoning'))}</span>`],
  [t('models.row.saved'),llm.saved.model||llm.saved.reasoning
   ?`<code>${esc(llm.saved.model||t('models.row.savedUnset'))}</code> / <code>${esc(reasoningText(llm.saved.reasoning))}</code>`
   :`<span class="muted">${esc(t('models.row.savedNone'))}</span>`],
  [t('models.row.catalog'),catalogSummary(llm.catalog)],
  [t('models.row.levels'),levels&&levels.length
   ?esc(t('models.catalog.levels',{model:llm.effective.model.value,levels:levels.join(' / ')}))
   :`<span class="muted">${esc(t('models.catalog.levelsUnknown',{model:llm.effective.model.value}))}</span>`],
  [t('models.row.lastTest'),probeSummary(llm.lastProbe)],
  [t('models.row.settingsFile'),`<code>${esc(data.settingsPath)}</code>${data.fileExists?'':` <span class="caption">${esc(t('models.row.fileMissing'))}</span>`}`],
  [t('models.row.updatedAt'),data.updatedAt?esc(date(data.updatedAt)):`<span class="muted">${esc(t('common.unknown'))}</span>`],
 ];
 const unsupported=levels&&llm.effective.reasoning.value&&!levels.includes(llm.effective.reasoning.value);
 const embedding=data.embedding;
 const cache=embedding.cache;
 return `${currentHold?holdBanner(currentHold,otherHolds):''}
 ${heldJobs.length?heldJobsCard(heldJobs):''}
 <section class="card pad${currentHold||heldJobs.length?' mt':''}" id="model-llm"><div class="spread"><h2>${esc(t('models.llm.title'))}</h2><span class="tag outline">${esc(sourceLabel(llm.effective.model.source))}</span></div>
 <p class="caption mt">${tHtml('models.llm.intro')}</p>
 ${unsupported?banner(esc(t('models.warning.reasoningUnsupported',{model:llm.effective.model.value,levels:levels.join(' / ')})),'warning'):''}
 ${llm.catalog&&llm.catalog.source==='none'?banner(esc(t('models.catalog.none',{home:llm.catalog.codexHome})),'warning'):''}
 <form id="model-llm-form" class="stack-sm mt">
  <div class="setting-row"><div><div class="row wrap"><h3>${esc(t('models.llm.row.model'))}</h3>${modelPinned?pinTag:''}</div><p>${esc(t('models.llm.row.modelBody'))}</p>${modelPinned?`<p class="caption">${esc(t('models.envPinned.detail',{name:'MEMEX_CODEX_MODEL',value:data.env.MEMEX_CODEX_MODEL||''}))}</p>`:''}</div>
  <select name="model" aria-label="${esc(t('models.llm.row.model'))}" ${modelPinned?'disabled':''}>${modelOptions(data)}</select></div>
  <label class="field">${esc(t('models.llm.custom.label'))}<input name="custom" autocomplete="off" spellcheck="false" maxlength="256" placeholder="gpt-6-astra" ${modelPinned?'disabled':''}><small>${esc(t('models.llm.custom.hint'))}</small></label>
  <div class="setting-row"><div><div class="row wrap"><h3>${esc(t('models.llm.row.reasoning'))}</h3>${reasoningPinned?pinTag:''}</div><p>${esc(t('models.llm.row.reasoningBody'))}</p>${reasoningPinned?`<p class="caption">${esc(t('models.envPinned.detail',{name:'MEMEX_CODEX_REASONING',value:data.env.MEMEX_CODEX_REASONING||''}))}</p>`:''}</div>
  <select name="reasoning" aria-label="${esc(t('models.llm.row.reasoning'))}" ${reasoningPinned?'disabled':''}>${reasoningOptions(data)}</select></div>
  <div class="row wrap mt">${btn(t('models.llm.save'),'check',`type="submit" ${modelPinned&&reasoningPinned?'disabled':''}`,'primary')}${btn(t('models.llm.test'),'play','type="button" data-model="test"')}${btn(t('models.llm.reset'),'refresh',`type="button" data-model="reset" ${data.fileExists?'':'disabled'}`)}</div>
 </form>
 ${modelPinned&&reasoningPinned?`<p class="caption mt">${esc(t('models.saveDisabledByEnv'))}</p>`:''}
 ${kv(rows)}
 ${banner(tHtml('models.llm.latencyWarning'),'warning')}
 <p class="caption mt">${esc(t('models.llm.workersNote'))}</p></section>
 <section class="card pad mt" id="model-embedding"><div class="spread"><h2>${esc(t('models.embedding.title'))}</h2><span class="tag outline">${esc(t('models.embedding.readOnlyTag'))}</span></div>
 ${kv([
  [t('models.embedding.row.model'),`<code>${esc(embedding.model)}</code> <span class="caption">${esc(embedding.source==='env'?t('models.source.env'):t('models.source.default'))}</span>`],
  [t('models.embedding.row.cache'),cache.stub?esc(t('models.embedding.cache.stub'))
   :cache.present?esc(t('models.embedding.cache.present',{size:bytes(cache.bytes),files:number(cache.files),dir:cache.modelDir}))
   :esc(t('models.embedding.cache.absent',{dir:cache.modelDir}))],
 ])}
 <p class="caption mt">${esc(t('models.embedding.readOnly'))}</p></section>`;
}

/** 탭 레지스트리 진입점. 조회 실패도 화면으로 설명한다 — 탭이 빈 화면으로 끝나지 않는다. */
export async function render(ctx,env){
 let data=null,error=null;
 if(env.models){try{data=await ctx.api('models');}catch(e){error=e.message;}}
 return modelTab(ctx,env,data,error);
}

const post=(ctx,body)=>ctx.api('models',{},{body:{...body,confirm:true},timeout:180000});

/**
 * 이벤트 배선. settings.mjs의 mount가 그대로 부르고, 이 탭이 아니면 아무것도 찾지 못해 no-op다.
 * 저장·초기화·테스트는 모두 `/api/v2/models`의 action 하나씩이다.
 */
export function mountModelTab(el,ctx){
 const form=el.querySelector('#model-llm-form');
 if(!form)return;
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  const fd=new FormData(event.currentTarget);
  const custom=String(fd.get('custom')||'').trim();
  const model=custom||String(fd.get('model')||'').trim();
  const reasoning=String(fd.get('reasoning')||'unset');
  try{
   const result=await post(ctx,{action:'set-llm',...(model?{model}:{}),reasoning});
   // 토스트는 하나뿐인 DOM 노드다 — 연달아 부르면 마지막 것만 보인다. 저장 문장과 경고를
   // 한 줄로 잇는다: 경고(낡은 카탈로그·환경 변수 우선)는 저장 결과의 일부다.
   ctx.toast([t('models.toast.saved',{model:result.status.llm.effective.model.value,
     reasoning:reasoningText(result.status.llm.effective.reasoning.value)}),
     ...warningLines(result.warnings)].join(' · '));
  }catch(e){ctx.toast(e.message);}
  ctx.invalidate();
 });
 el.querySelector('[data-model="reset"]')?.addEventListener('click',()=>{
  ctx.confirm(t('models.reset.title'),t('models.reset.body'),async()=>{
   const result=await post(ctx,{action:'reset'});
   ctx.toast(t('models.toast.reset',{model:result.status.llm.effective.model.value}));
   ctx.invalidate();
  });
 });
 // One real provider call, so it asks first and says what it costs (one ledger attempt).
 el.querySelector('[data-model="test"]')?.addEventListener('click',()=>{
  ctx.confirm(t('models.probe.confirm.title'),t('models.probe.confirm.body'),async()=>{
   ctx.toast(t('models.probe.running'));
   const result=await post(ctx,{action:'test'});
   if(result.ok)ctx.toast(t('models.probe.okToast',{model:result.probe.model,ms:duration(result.probe.latencyMs)}));
   else ctx.toast(t('models.probe.failedToast',{message:result.probe.rejection?.message||result.probe.error||t('common.unknown')}));
   ctx.invalidate();
  });
 });
}
