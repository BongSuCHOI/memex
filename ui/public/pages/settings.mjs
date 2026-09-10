import {esc,icon,header,btn,linkBtn,banner,kv,badge,name,options,table,number,date,short,bytes} from '../ui.mjs';
import {visibleTabs,tabFor,renderedBySettingsPage} from './settings-tabs.mjs';
// 레지스트리는 렌더 함수만 들고 있다(C4.2). 배선은 탭 모듈이 자기 것을 가지고 있고, 그 탭이
// 아니면 선택자를 하나도 찾지 못해 no-op다 (#31 lane E).
import {mountModelTab} from './model.mjs';
import {t,tHtml,tn,localeTag,LOCALES} from '../i18n/index.mjs';
import {ENDONYMS} from '../i18n/endonyms.mjs';
// 한국어 테이블이던 상수는 전부 함수다 — 사전은 boot()에서 꽂히고 모듈 최상위는 그보다 먼저
// 평가된다(#109 · 설계 §2.6). 키를 런타임에 조립하지 않고 리터럴 t() 호출을 남겨 두는 것이
// `i18n-extract --keys`의 "죽은 번역" 검사를 통과하는 조건이기도 하다.
const DIR_SOURCE=()=>({env:t('settings.sync.dirSource.env'),configured:t('settings.sync.dirSource.configured'),default:t('settings.sync.dirSource.default')});
/** 이 서버 실행 중 마지막으로 누른 내보내기·가져오기의 결과. 서버는 이 값을 보관하지 않는다. */
let lastSyncRun=null,lastArchive=null,lastPreview=null;
export const setLastSyncRun=value=>{lastSyncRun=value;};
/** 마지막으로 만든 세대 파일(zip)과 마지막 가져오기 미리보기. 둘 다 이 브라우저 세션용이다. */
export const setLastArchive=value=>{lastArchive=value;};
export const setLastPreview=value=>{lastPreview=value;};
const importCounts=r=>t('settings.sync.importCounts',{newFacts:number(r.newFacts),updatedFacts:number(r.updatedFacts),deletedFacts:number(r.deletedFacts),newRevisions:number(r.newRevisions),newTombstones:number(r.newTombstones),newRecalls:number(r.newRecallEvents),updatedRecalls:number(r.updatedRecallEvents)});
const exportCounts=c=>t('settings.sync.counts',{facts:number(c.facts),revisions:number(c.revisions),tombstones:number(c.tombstones),recalls:number(c.recallEvents)});
const SKIP=()=>({disabled:t('settings.sync.skip.disabled'),unchanged:t('settings.sync.skip.unchanged'),locked:t('settings.sync.skip.locked')});
const WINNER=()=>({peer:t('settings.sync.winner.peer'),local:t('settings.sync.winner.local')});
const deviceName=(alias,id)=>alias?`${esc(alias)} <code class="subtle">${esc(short(id))}</code>`:`<code>${esc(id||t('common.unknown'))}</code>`;
/** 거부 사유 표 — 세대는 하나라도 깨지면 통째로 거부되고, 그 사유를 코어 원문 그대로 싣는다. */
const rejectedTable=issues=>issues.length
 ?table([esc(t('settings.sync.rejected.col.file')),esc(t('settings.sync.rejected.col.line')),esc(t('settings.sync.rejected.col.error'))],issues.map(i=>`<tr><td class="mono subtle">${esc(i.file)}</td><td>${number(i.line)}</td><td class="wrap">${esc(i.error)}</td></tr>`))
 :`<p class="caption">${esc(t('settings.sync.rejected.empty'))}</p>`;
/**
 * 관리 › 동기화 (#48).
 *
 * 0.6.1에서 스위치·상태·공유 폴더 실행까지, 0.6.3에서 **수동 세대 파일(zip) 내보내기·가져오기,
 * 기기 별칭, 충돌 이력**이 들어왔다. 모두 `/api/v2/sync` 한 엔드포인트의 action이다.
 */
export function syncTab(ctx,env,data,error,run=lastSyncRun,archive=lastArchive,preview=lastPreview){
 if(!env.sync)return banner(tHtml('settings.sync.missingCore'),'error');
 if(!data)return banner(esc(error||t('settings.sync.statusUnavailable')),'error');
 const s=data.status||{};const on=!!s.enabled;
 const peers=(s.peers||[]).filter(p=>!p.isSelf);
 const last=s.lastExport||null;
 const off=on?'':'disabled';
 const rows=[
  [t('settings.sync.row.state'),on?`<span class="tag green">${esc(t('settings.sync.state.on'))}</span>`:`<span class="tag">${esc(t('settings.sync.state.off'))}</span>`],
  [t('settings.sync.row.dir'),`<code>${esc(s.dir||t('settings.sync.dir.unset'))}</code>`],
  [t('settings.sync.row.dirSource'),esc(DIR_SOURCE()[s.dirSource]||s.dirSource||t('common.unknown'))],
  [t('settings.sync.row.dirState'),s.dirExists?(s.dirWritable?`<span class="tag green">${esc(t('settings.sync.dirState.writable'))}</span>`:`<span class="tag red">${esc(t('settings.sync.dirState.readonly'))}</span>`):`<span class="tag amber">${esc(t('settings.sync.dirState.missing'))}</span>`],
  [t('settings.sync.row.configPath'),`<code>${esc(s.configPath||t('common.unknown'))}</code>`],
  [t('settings.sync.row.updatedAt'),esc(date(s.updatedAt))],
  [t('settings.sync.row.deviceId'),s.deviceId?`<code>${esc(s.deviceId)}</code>`:`<span class="muted">${esc(t('settings.sync.deviceId.missing'))}</span>`],
  // 별칭은 로컬 sync/devices.json에 저장되고, 이 기기의 별칭만 세대 manifest에 실려 피어에 보인다.
  [t('settings.sync.row.deviceAlias'),`<div class="row wrap">${s.deviceAlias?`<strong>${esc(s.deviceAlias)}</strong>`:`<span class="muted">${esc(t('settings.sync.deviceAlias.missing'))}</span>`}${btn(s.deviceAlias?t('settings.sync.alias.rename'):t('settings.sync.alias.set'),'edit',`data-alias="${esc(s.deviceId||'')}" data-alias-name="${esc(s.deviceAlias||'')}" ${s.deviceId?'':'disabled'}`,'small ghost')}</div>${s.deviceId?'':`<p class="caption">${esc(t('settings.sync.alias.needsId'))}</p>`}`],
 ];
 const exportRows=last?[
  [t('settings.sync.lastExport.at'),esc(date(last.at))],
  [t('settings.sync.lastExport.result'),last.ok?`<span class="tag green">${esc(t('settings.sync.result.ok'))}</span>`:`<span class="tag red">${esc(t('settings.sync.result.failed'))}</span>`],
  ...(last.counts?[[t('settings.sync.rows'),esc(exportCounts(last.counts))]]:[]),
  ...(last.error?[[t('settings.sync.lastExport.error'),`<span class="danger-text">${esc(last.error)}</span>`]]:[]),
 ]:null;
 const issues=run?.outcome?.result?.malformedRows||[];
 return `${banner(on?tHtml('settings.sync.intro.on'):tHtml('settings.sync.intro.off'),on?'neutral':'warning')}
 <div class="settings-layout"><section class="card pad"><div class="setting-row"><div><h3>${esc(t('settings.sync.switch.title'))}</h3><p>${esc(t('settings.sync.switch.body'))}</p></div><input type="checkbox" id="sync-switch" aria-label="${esc(t('settings.sync.switch.title'))}" ${on?'checked':''}></div>
 ${kv(rows)}
 <div class="row wrap mt">${btn(t('settings.sync.action.exportNow'),'download',`data-sync="export" ${off}`,'primary')}${btn(t('settings.sync.action.importNow'),'refresh',`data-sync="import" ${off}`)}</div>
 ${on?'':`<p class="caption mt">${esc(t('settings.sync.offHint'))}</p>`}</section>
 <section class="card pad"><h2>${esc(t('settings.sync.lastExport.title'))}</h2>${exportRows?kv(exportRows):banner(esc(on?t('settings.sync.lastExport.none.on'):t('settings.sync.lastExport.none.off')),'neutral')}
 <h2 class="mt">${esc(t('settings.sync.peers.title'))}</h2>${peers.length?table([esc(t('settings.sync.peers.col.name')),esc(t('settings.sync.peers.col.id')),esc(t('settings.sync.peers.col.host')),esc(t('settings.sync.peers.col.generation')),esc(t('settings.sync.peers.col.at')),esc(t('settings.sync.peers.col.rows'))],peers.map(p=>`<tr><td><div class="row wrap">${p.alias?`<strong>${esc(p.alias)}</strong>`:`<span class="muted">${esc(t('settings.sync.peers.noName'))}</span>`}${btn(t('settings.sync.peers.aliasButton'),'edit',`data-alias="${esc(p.deviceId)}" data-alias-name="${esc(p.alias||'')}"`,'small ghost')}</div>${p.alias&&!p.aliasIsLocal?`<p class="caption">${esc(t('settings.sync.peers.aliasFromPeer'))}</p>`:''}</td><td class="mono subtle">${esc(short(p.deviceId))}</td><td>${esc(p.hostname||t('common.unknown'))}</td><td class="mono subtle">${esc(short(p.generation))}</td><td class="nowrap">${esc(date(p.exportedAt))}</td><td>${p.counts?esc(`${number(p.counts.facts)} / ${number(p.counts.revisions)} / ${number(p.counts.tombstones)} / ${number(p.counts.recallEvents)}`):`<span class="muted">${esc(t('settings.sync.peers.noManifest'))}</span>`}</td></tr>`)):`<p class="caption">${esc(s.dirExists?t('settings.sync.peers.empty'):t('settings.sync.peers.noDir'))}</p>`}</section></div>
 ${archiveCard(s,archive,preview)}
 ${run?`<section class="card pad mt"><h2>${esc(run.action==='export'?t('settings.sync.run.title.export'):t('settings.sync.run.title.import'))}</h2>
 ${run.outcome?.skipped?banner(esc(SKIP()[run.outcome.skipped]||run.outcome.skipped),'neutral'):''}
 ${run.outcome?.error?banner(esc(run.outcome.error),'error'):''}
 ${run.outcome?.result&&run.action==='import'?kv([[t('settings.sync.run.applied'),esc(importCounts(run.outcome.result))],...(run.source?[[t('settings.sync.run.sourceFile'),`<code>${esc(run.source)}</code>`]]:[]),[t('settings.sync.run.at'),esc(date(run.at))]]):''}
 ${run.outcome?.result&&run.action==='export'?kv([[t('settings.sync.rows'),esc(exportCounts(run.outcome.result))],[t('settings.sync.run.at'),esc(date(run.at))]]):''}
 <h2 class="mt">${esc(t('settings.sync.rejected.title'))}</h2>${rejectedTable(issues)}</section>`:''}
 <div class="footer-note"><span>${tHtml('settings.sync.footer.notProven')}</span><span>${esc(t('settings.sync.footer.session'))}</span></div>`;
}
/**
 * 수동 파일 교환 (#48, 0.6.3).
 *
 * 브라우저 다운로드·업로드는 이 UI의 샌드박스(CSP·loopback 전용)에서 쓰지 않는다. 그래서 서버가
 * **데이터 루트 안**에 zip을 쓰고 그 경로를 보여주고(복사 → Finder에서 열기), 가져오기는 사용자가
 * 받아 둔 파일 경로를 받는다. 가져오기는 항상 **검증 → 미리보기 → 확인** 순서이고, 미리보기는
 * 아무것도 바꾸지 않는다.
 *
 * 가져오기 버튼은 form 안에 있지만 `type="button"`이다 — 기본 type(submit)이면 클릭이 미리보기까지
 * 다시 보내고, 그 재렌더가 진행 중인 가져오기를 끊는다. (설명을 HTML 주석으로 두면 화면 문자열이
 * 되어 한글 린트에 걸리므로 여기 JS 주석으로 옮겼다.)
 */
export function archiveCard(s,archive,preview){
 const ready=!!archive;
 return `<section class="card pad mt" id="sync-archive"><div class="spread"><h2>${esc(t('settings.archive.title'))}</h2><span class="tag outline">${esc(t('settings.archive.noFolderNeeded'))}</span></div>
 <p class="caption mt">${tHtml('settings.archive.intro')}</p>
 <div class="two-col mt">
  <div><h3>${esc(t('settings.archive.export.title'))}</h3>
  <p class="caption mt">${esc(t('settings.archive.export.body'))}</p>
  <div class="row wrap mt">${btn(t('settings.archive.export.title'),'download','data-archive="export"','primary')}${ready?btn(t('settings.archive.copyPath'),'copy',`data-copy-command="${esc(archive.path)}"`,'small ghost'):''}</div>
  ${ready?kv([[t('settings.archive.file'),`<code>${esc(archive.path)}</code>`],[t('settings.archive.size'),esc(bytes(archive.bytes))],[t('settings.archive.device'),`${deviceName(archive.deviceAlias,archive.deviceId)} · <code class="subtle">${esc(short(archive.generation))}</code>`],[t('settings.archive.rows'),esc(exportCounts(archive.counts))]])+`<p class="caption mt">${tHtml('settings.archive.finderHint')}</p>`:`<p class="caption mt">${tHtml('settings.archive.defaultDir',{path:s.archiveDir||t('common.unknown')})}</p>`}
  </div>
  <div><h3>${esc(t('settings.archive.import.title'))}</h3>
  <p class="caption mt">${esc(t('settings.archive.import.body'))}</p>
  <form class="stack-sm mt" id="archive-import-form"><label class="field">${esc(t('settings.archive.import.pathLabel'))}<input name="path" autocomplete="off" spellcheck="false" placeholder="/Users/me/Downloads/&lt;device&gt;-&lt;generation&gt;.zip" value="${esc(preview?.path||'')}" required></label>
  <div class="row wrap">${btn(t('settings.archive.import.verify'),'search','type="submit"')}${btn(t('settings.archive.import.apply'),'check',`type="button" data-archive="import" ${preview?.preview?.generations?.length?'':'disabled'}`,'primary')}</div></form>
  ${preview?'':`<p class="caption mt">${esc(t('settings.archive.import.hint'))}</p>`}
  </div>
 </div>
 ${preview?`<div class="divider"></div><div class="spread"><h3>${esc(t('settings.archive.preview.title'))}</h3><span class="caption">${esc(date(preview.at))}</span></div>
 ${preview.error?banner(esc(preview.error),'error'):''}
 ${preview.preview?kv([[t('settings.archive.preview.file'),`<code>${esc(preview.preview.source||preview.path)}</code>`],[t('settings.archive.preview.fromDevice'),deviceName(preview.preview.deviceAlias,preview.preview.deviceId)],[t('settings.archive.preview.generation'),`<code class="subtle">${esc(short(preview.preview.generation))}</code>`],[t('settings.archive.preview.applies'),esc(t('settings.archive.preview.deltas',{added:number(preview.preview.newFacts),updated:number(preview.preview.updatedFacts),deleted:number(preview.preview.deletedFacts)}))],[t('settings.archive.preview.conflicts'),preview.preview.conflicts.length?esc(tn('settings.archive.preview.conflicts.count',preview.preview.conflicts.length,{n:number(preview.preview.conflicts.length)})):`<span class="muted">${esc(t('settings.archive.preview.conflicts.none'))}</span>`]]):''}
 ${preview.preview?`<p class="caption mt">${tHtml('settings.archive.preview.countingNote')}</p>`:''}
 ${preview.preview?.conflicts?.length?table([esc(t('settings.archive.conflicts.col.fact')),esc(t('settings.archive.conflicts.col.device')),esc(t('settings.archive.conflicts.col.winner')),esc(t('settings.archive.conflicts.col.reason'))],preview.preview.conflicts.map(c=>`<tr><td class="mono subtle">${esc(short(c.factId))}</td><td>${deviceName(c.deviceAlias,c.deviceId)}</td><td>${esc(WINNER()[c.winner]||t('common.unknown'))}</td><td class="wrap">${esc(c.reason)}</td></tr>`)):''}
 <h3 class="mt">${esc(t('settings.sync.rejected.title'))}</h3>${rejectedTable(preview.preview?.rejected||[])}`:''}</section>`;
}
const descriptions=()=>({doctor:t('settings.actions.description.doctor'),status:t('settings.actions.description.status'),sync:t('settings.actions.description.sync'),extract:t('settings.actions.description.extract'),ontology:t('settings.actions.description.ontology'),embeddings:t('settings.actions.description.embeddings'),all:t('settings.actions.description.all'),recover:t('settings.actions.description.recover')});
/**
 * 기억 계층 이관 카드(#22): dry-run 출력을 그대로 보여주고, 적용은 기존 관리 명령 확인 모달을 거친다.
 * 출력은 코어 CLI가 찍은 원문이며 UI가 요약하거나 추정하지 않는다.
 */
export function migrationCard(ctx,env,runs={}){
 const preview=runs.preview,apply=runs.apply,output=runs.previewOutput;
 return `<section class="card pad mt" id="tier-migration"><div class="spread"><h2>${esc(t('settings.migration.title'))}</h2>${preview?badge(preview.status):`<span class="tag outline">${esc(t('settings.migration.notRun'))}</span>`}</div>
 <p class="caption mt">${tHtml('settings.migration.intro')}</p>
 <div class="row wrap mt">${btn(t('settings.migration.preview'),'play',`data-command="tiers-preview" ${!env.commands?'disabled':''}`,'primary')}${btn(t('settings.migration.apply'),'check',`data-command="tiers-apply" ${!env.commands||!preview?'disabled':''}`)}${preview?linkBtn(t('settings.migration.history'),'terminal',ctx.href('/activity',{tab:'operations'}),'ghost'):''}</div>
 ${preview?kv([[t('settings.migration.lastPreview'),esc(date(preview.started_at))],[t('settings.migration.status'),badge(preview.status)],[t('settings.migration.exitCode'),number(preview.exit_code)]]):banner(esc(t('settings.migration.notRunYet')),'neutral')}
 ${output?`<pre class="terminal mt" id="tier-migration-output">${esc(output)}</pre>`:preview&&preview.status==='completed'?`<p class="caption mt">${esc(t('settings.migration.noOutput'))}</p>`:''}
 ${apply?banner(esc(t('settings.migration.lastApply',{at:date(apply.started_at),status:name(apply.status)})),'neutral'):''}</section>`;
}
/**
 * 표시 언어 행 (#109 · 설계 §7.1).
 *
 * 표시 설정 폼과 **분리**한다 — 언어 변경은 사전을 다시 꽂아야 해서 화면을 다시 불러오고,
 * 다른 입력과 한 번에 submit하면 "저장했는데 입력이 날아간 듯" 보인다. change에서 즉시 확정한다.
 * 언어 이름은 번역하지 않는다(endonym): 잘못된 언어로 들어온 사용자가 자기 언어를 찾아야 한다.
 * `data-endonym`이 "en 화면에 한글 0건 / ko 화면에 미번역 0건" 검사를 구조적으로 면제한다.
 */
function languageRow(ctx){
 const asked=ctx.p.get('lang');
 const fromUrl=LOCALES.includes(asked)?`<span class="tag outline">${esc(t('settings.interface.language.fromUrl'))}</span>`:'';
 return `<div class="setting-row"><div><div class="row wrap"><h3>${esc(t('settings.interface.language.title'))}</h3>${fromUrl}</div><p>${esc(t('settings.interface.language.body'))}</p></div><select name="lang" id="language-select" data-endonym aria-label="${esc(t('settings.interface.language.title'))}">${options([['en',ENDONYMS.en],['ko',ENDONYMS.ko]],localeTag())}</select></div>`;
}
export async function render(ctx){
 // 탭 순서·id·레이블의 진원지는 settings-tabs.mjs다 (#109 · C4.4). 미지원·비활성 탭은
 // runtime으로 떨어진다 — 개명하지 않았으므로 ?tab=actions·?tab=interface는 그대로다.
 const p=ctx.p;const entry=tabFor(p.get('tab'));const tab=entry.id;const env=ctx.bootstrap.environment;let body='';
 let tierRuns={},syncData=null,syncError=null;
 if(tab==='sync'&&env.sync){try{syncData=await ctx.api('sync');}catch(e){syncError=e.message;}}
 if(tab==='actions'){
  try{
   const runs=(await ctx.api('operations')).items||[];
   tierRuns={preview:runs.find(x=>x.command==='tiers-preview')||null,apply:runs.find(x=>x.command==='tiers-apply')||null};
   if(tierRuns.preview&&!tierRuns.preview.outputLost){const full=await ctx.api('operation',{id:tierRuns.preview.id});tierRuns.previewOutput=String(full.output||'').slice(-4000)||null;}
  }catch{tierRuns={};}
 }
 if(tab==='runtime')body=`<div class="settings-layout"><section class="card"><div class="card-head"><h2>${esc(t('settings.runtime.env.title'))}</h2>${badge(ctx.bootstrap.db.available?'active':'error',undefined)}</div><div class="card-body">${kv([[t('settings.runtime.coreVersion'),esc(env.version||t('settings.runtime.versionUnknown'))],[t('settings.runtime.uiVersion'),esc(ctx.bootstrap.uiVersion)],['Node.js',esc(env.node)],[t('settings.runtime.platform'),esc(env.platform)],[t('settings.runtime.repo'),`<code>${esc(env.root)}</code>`],[t('settings.runtime.dataRoot'),`<code>${esc(env.home)}</code>`],[t('settings.runtime.dbPath'),`<code>${esc(env.dbPath)}</code>`],[t('settings.runtime.pid'),esc(env.pid)],[t('settings.runtime.origin'),`<code>${esc(location.origin)}</code>`]])}</div></section><section class="card pad"><h2>${esc(t('settings.runtime.boundary.title'))}</h2><ul class="notice-list"><li><strong>${esc(t('settings.runtime.boundary.connection.title'))}</strong>${esc(t('settings.runtime.boundary.connection.body'))}</li><li><strong>${esc(t('settings.runtime.boundary.read.title'))}</strong>${esc(t('settings.runtime.boundary.read.body'))}</li><li><strong>${esc(t('settings.runtime.boundary.env.title'))}</strong>${esc(env.note)}</li><li><strong>${esc(t('settings.runtime.boundary.local.title'))}</strong>${esc(t('settings.runtime.boundary.local.body'))}</li></ul></section></div><section class="card mt"><div class="card-head"><h2>${esc(t('settings.runtime.envVars.title'))}</h2><span class="meta">${esc(t('settings.runtime.envVars.readonly'))}</span></div>${table([esc(t('settings.runtime.envVars.col.name')),esc(t('settings.runtime.envVars.col.value'))],Object.entries(env.values||{}).map(([k,v])=>`<tr><td><code>${esc(k)}</code></td><td>${v===null?`<span class="muted">${esc(t('settings.runtime.envVars.unset'))}</span>`:`<code>${esc(v)}</code>`}</td></tr>`))}<div class="card-body caption">${esc(t('settings.runtime.envVars.note'))}</div></section>`;
 if(tab==='actions')body=banner(tHtml('settings.actions.scopeWarning'),'warning')+(!env.commands?banner(esc(t('settings.actions.noCli')),'error'):'')+`<div class="three-col">${(desc=>Object.entries(ctx.bootstrap.commands).filter(([,c])=>!c.group).map(([key,c])=>`<section class="card action-card"><div class="row wrap">${icon(c.model?'layers':c.mutates?'refresh':'shield')}${c.mutates?badge('CHANGED'):badge('VALIDATED')}${c.model?`<span class="tag amber">${esc(t('settings.actions.modelTag'))}</span>`:''}</div><h2>${esc(c.label)}</h2><p>${esc(desc[key])}</p><code>memex ${esc(c.args.join(' '))}</code>${btn(t('settings.actions.review'),'play',`data-command="${esc(key)}" ${!env.commands?'disabled':''}`,c.mutates?'':'primary')}</section>`).join(''))(descriptions())}</div>${migrationCard(ctx,env,tierRuns)}<div class="mt">${linkBtn(t('settings.actions.history'),'terminal',ctx.href('/activity',{tab:'operations'}))}</div>`;
 if(tab==='sync')body=syncTab(ctx,env,syncData,syncError);
 if(tab==='interface')body=`<div class="settings-layout"><section class="card pad"><h2>${esc(t('settings.interface.title'))}</h2>${languageRow(ctx)}<form id="preferences-form"><div class="setting-row"><div><h3>${esc(t('settings.interface.theme.title'))}</h3><p>${esc(t('settings.interface.theme.body'))}</p></div><select name="theme" aria-label="${esc(t('settings.interface.theme.title'))}">${options([['light',t('settings.interface.theme.light')],['dark',t('settings.interface.theme.dark')],['system',t('settings.interface.theme.system')]],ctx.prefs.theme)}</select></div><div class="setting-row"><div><h3>${esc(t('settings.interface.density.title'))}</h3><p>${esc(t('settings.interface.density.body'))}</p></div><select name="density" aria-label="${esc(t('settings.interface.density.title'))}">${options([['comfortable',t('settings.interface.density.comfortable')],['compact',t('settings.interface.density.compact')]],ctx.prefs.density)}</select></div><div class="setting-row"><div><h3>${esc(t('settings.interface.translated.title'))}</h3><p>${esc(t('settings.interface.translated.body'))}</p></div><input type="checkbox" name="preferTranslatedFacts" aria-label="${esc(t('settings.interface.translated.aria'))}" ${ctx.prefs.preferTranslatedFacts?'checked':''}></div><div class="setting-row"><div><h3>${esc(t('settings.interface.help.title'))}</h3><p>${esc(t('settings.interface.help.body'))}</p></div><select name="help" aria-label="${esc(t('settings.interface.help.title'))}">${options([['always',t('settings.interface.help.always')],['first',t('settings.interface.help.first')],['off',t('settings.interface.help.off')]],ctx.prefs.help||'always')}</select></div><div class="setting-row"><div><h3>${esc(t('settings.interface.live.title'))}</h3><p>${esc(t('settings.interface.live.body'))}</p></div><input type="checkbox" name="live" aria-label="${esc(t('settings.interface.live.aria'))}" ${ctx.prefs.live?'checked':''}></div><div class="row mt">${btn(t('settings.interface.save'),'check','type="submit"','primary')}</div></form></section><section class="card pad"><h2>${esc(t('settings.interface.keyboard.title'))}</h2>${kv([['⌘ / Ctrl + K',esc(t('settings.interface.keyboard.search'))],['Esc',esc(t('settings.interface.keyboard.close'))],['Tab / Shift + Tab',esc(t('settings.interface.keyboard.move'))],[t('settings.interface.keyboard.graphArrows.label'),esc(t('settings.interface.keyboard.graphArrows'))],[t('settings.interface.keyboard.graphZoom.label'),esc(t('settings.interface.keyboard.graphZoom'))],['?',esc(t('settings.interface.keyboard.glossary'))]])}<p class="caption mt">${esc(t('settings.interface.localStorage'))}</p></section></div>`;
 if(tab==='diagnostics')body=`${!ctx.bootstrap.db.available?banner(esc(ctx.bootstrap.db.error?.message||t('settings.diagnostics.dbUnavailable')),'error'):banner(esc(t('settings.diagnostics.dbOk')))}<div class="settings-layout"><section class="card"><div class="card-head"><h2>${esc(t('settings.diagnostics.capabilities.title'))}</h2></div>${table([esc(t('settings.diagnostics.capabilities.col.table')),esc(t('settings.diagnostics.capabilities.col.state'))],Object.entries(ctx.bootstrap.capabilities).map(([k,v])=>`<tr><td><code>${esc(k)}</code></td><td>${v?`<span class="tag green">${esc(t('settings.diagnostics.capabilities.present'))}</span>`:`<span class="tag">${esc(t('settings.diagnostics.capabilities.missing'))}</span>`}</td></tr>`))}</section><section class="card pad"><h2>${esc(t('settings.diagnostics.export.title'))}</h2><p class="caption mt">${esc(t('settings.diagnostics.export.body'))}</p><div class="row wrap mt">${btn(t('settings.diagnostics.export.json'),'download','data-action="diagnostics-download"')}${btn(t('settings.diagnostics.export.doctor'),'shield',`data-command="doctor" ${!env.commands?'disabled':''}`)}</div><hr><h2>${esc(t('settings.diagnostics.trouble.title'))}</h2><ul class="notice-list"><li><strong>${esc(t('settings.diagnostics.trouble.noDb.title'))}</strong>${esc(t('settings.diagnostics.trouble.noDb.body'))}</li><li><strong>${esc(t('settings.diagnostics.trouble.noCore.title'))}</strong>${esc(t('settings.diagnostics.trouble.noCore.body'))}</li><li><strong>${esc(t('settings.diagnostics.trouble.empty.title'))}</strong>${esc(t('settings.diagnostics.trouble.empty.body'))}</li><li><strong>${esc(t('settings.diagnostics.trouble.modelFail.title'))}</strong>${esc(t('settings.diagnostics.trouble.modelFail.body'))}</li></ul></section></div>`;
 // 기능 레인이 레지스트리 항목에 자기 렌더 함수를 넣으면 그 함수가 탭 본문을 그린다 (C4.2).
 if(entry.render&&entry.render!==renderedBySettingsPage)body=(await entry.render(ctx,env))??body;
 return {html:header(t('settings.page.title'),t('settings.page.subtitle'),btn(t('settings.page.refresh'),'refresh','data-action="refresh-bootstrap"'),'CONTROL CENTER','/settings')+`<nav class="tabs" aria-label="${esc(t('settings.a11y.tabs'))}">${visibleTabs().map(x=>`<a class="tab ${tab===x.id?'active':''}" href="${esc(ctx.href('/settings',{tab:x.id}))}" data-nav>${esc(t(x.labelKey))}</a>`).join('')}</nav>`+body,mount(el){el.querySelector('#preferences-form')?.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.currentTarget);ctx.savePrefs({theme:f.get('theme'),density:f.get('density'),preferTranslatedFacts:f.has('preferTranslatedFacts'),live:f.has('live'),help:f.get('help')||'always'});ctx.toast(t('settings.interface.saved'));});
 // 언어는 폼과 분리해 즉시 확정한다 — 저장 후 화면을 다시 불러온다.
 el.querySelector('#language-select')?.addEventListener('change',event=>ctx.setLanguage?.(event.target.value));
 // 스위치는 낙관적으로 되돌리고 서버 상태가 다시 그리게 둔다 — 모달을 닫기만 해도 어긋나지 않는다.
 el.querySelector('#sync-switch')?.addEventListener('change',event=>{const wanted=event.target.checked;event.target.checked=!wanted;wanted?enableSync(ctx):disableSync(ctx);});
 el.querySelectorAll('[data-sync]').forEach(b=>b.addEventListener('click',()=>runSync(ctx,b.dataset.sync)));
 el.querySelectorAll('[data-alias]').forEach(b=>b.addEventListener('click',()=>renameDevice(ctx,b.dataset.alias,b.dataset.aliasName)));
 el.querySelector('[data-archive="export"]')?.addEventListener('click',()=>exportArchive(ctx));
 el.querySelector('[data-archive="import"]')?.addEventListener('click',()=>importArchive(ctx));
 mountModelTab(el,ctx);
 el.querySelector('#archive-import-form')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const path=String(new FormData(event.currentTarget).get('path')||'').trim();
  if(!path)return ctx.toast(t('settings.archive.import.needPath'));
  try{
   const result=await postSync(ctx,{action:'archive-preview',path});
   setLastPreview({path,preview:result.preview,at:new Date().toISOString()});
   ctx.toast(result.preview.rejected.length?t('settings.archive.import.rejectedToast'):t('settings.archive.import.previewToast'));
  }catch(e){setLastPreview({path,error:e.message,at:new Date().toISOString()});ctx.toast(e.message);}
  ctx.invalidate();
 });
 }};
}
async function postSync(ctx,body){const result=await ctx.api('sync',{},{body:{...body,confirm:true},timeout:180000});return result;}
function enableSync(ctx){
 const status=lastSyncRun?.status||null;
 ctx.modal(t('settings.sync.enable.title'),
  banner(tHtml('settings.sync.enable.warning'),'warning')
  +`<label class="field">${esc(t('settings.sync.enable.dirLabel'))}<input name="dir" required autocomplete="off" placeholder="/Users/me/Library/Mobile Documents/com~apple~CloudDocs/memex-sync" value="${esc(status?.dir||'')}"></label>`
  +banner(tHtml('settings.sync.enable.note'),'neutral'),
  t('settings.sync.enable.submit'),async fd=>{
   const result=await postSync(ctx,{action:'enable',dir:String(fd.get('dir')||'').trim()});
   ctx.toast(t('settings.sync.enable.done',{dir:result.status.dir}));ctx.invalidate();
  });
}
function disableSync(ctx){
 ctx.confirm(t('settings.sync.disable.title'),t('settings.sync.disable.body'),async()=>{
  await postSync(ctx,{action:'disable'});ctx.toast(t('settings.sync.disable.done'));ctx.invalidate();
 });
}
/** 기기 이름(별칭). 로컬 sync/devices.json에만 쓰고, 이 기기의 이름만 세대 manifest로 나간다. */
function renameDevice(ctx,deviceId,current){
 if(!deviceId)return ctx.toast(t('settings.sync.alias.needsExport'));
 ctx.modal(t('settings.sync.alias.modal.title'),
  banner(tHtml('settings.sync.alias.modal.note'),'neutral')
  +kv([[t('settings.sync.alias.modal.deviceId'),`<code>${esc(deviceId)}</code>`]])
  +`<label class="field mt">${esc(t('settings.sync.alias.modal.label'))}<input name="alias" maxlength="60" autocomplete="off" placeholder="${esc(t('settings.sync.alias.modal.placeholder'))}" value="${esc(current||'')}"><small>${esc(t('settings.sync.alias.modal.hint'))}</small></label>`,
  t('settings.sync.alias.modal.submit'),async fd=>{
   const result=await postSync(ctx,{action:'alias',deviceId,alias:String(fd.get('alias')||'').trim()});
   setLastSyncRun(lastSyncRun?{...lastSyncRun,status:result.status}:null);
   ctx.toast(t('settings.sync.alias.done'));ctx.invalidate();
  });
}
/** 세대 파일 내보내기: 새 세대를 만들고 데이터 루트 안에 zip으로 저장한 뒤 경로를 보여준다. */
function exportArchive(ctx){
 ctx.modal(t('settings.archive.export.title'),
  banner(tHtml('settings.archive.export.modal.warning'),'warning')
  +banner(tHtml('settings.archive.export.modal.note'),'neutral')
  +`<label class="check-row mt"><input type="checkbox" name="confirm" required> ${esc(t('settings.archive.export.modal.confirm'))}</label>`,
  t('settings.sync.action.export'),async fd=>{
   if(!fd.has('confirm'))throw new Error(t('settings.confirmRequired'));
   const result=await postSync(ctx,{action:'archive-export'});
   setLastArchive(result.archive);
   ctx.toast(t('settings.archive.export.done',{path:result.archive.path}));ctx.invalidate();
  });
}
/** 미리보기에서 확인한 그 파일만 적용한다. 경로는 미리보기가 검증한 값을 그대로 쓴다. */
function importArchive(ctx){
 const staged=lastPreview;
 if(!staged?.preview?.generations?.length)return ctx.toast(t('settings.archive.import.needPreview'));
 const p=staged.preview;
 ctx.modal(t('settings.archive.import.title'),
  banner(tHtml('settings.archive.import.modal.warning'),'warning')
  +kv([[t('settings.archive.preview.file'),`<code>${esc(p.source||staged.path)}</code>`],[t('settings.archive.preview.fromDevice'),deviceName(p.deviceAlias,p.deviceId)],[t('settings.archive.preview.applies'),esc(t('settings.archive.preview.deltas',{added:number(p.newFacts),updated:number(p.updatedFacts),deleted:number(p.deletedFacts)}))],[t('settings.archive.preview.conflicts'),p.conflicts.length?esc(tn('settings.archive.preview.conflicts.count',p.conflicts.length,{n:number(p.conflicts.length)})):esc(t('settings.archive.preview.conflicts.none'))]])
  +`<label class="check-row mt"><input type="checkbox" name="confirm" required> ${esc(t('settings.archive.import.modal.confirm'))}</label>`,
  t('settings.sync.action.import'),async fd=>{
   if(!fd.has('confirm'))throw new Error(t('settings.confirmRequired'));
   const result=await postSync(ctx,{action:'archive-import',path:staged.path});
   setLastSyncRun({action:'import',source:result.outcome.source,outcome:{skipped:null,error:null,result:result.outcome.result},status:result.status,at:new Date().toISOString()});
   setLastPreview(null);
   ctx.toast(t('settings.archive.import.done'));ctx.invalidate();
  });
}
function runSync(ctx,action){
 const isExport=action==='export';
 ctx.modal(isExport?t('settings.sync.action.exportNow'):t('settings.sync.action.importNow'),
  banner(isExport?tHtml('settings.sync.run.export.warning'):tHtml('settings.sync.run.import.warning'),'warning')
  +`<label class="check-row mt"><input type="checkbox" name="confirm" required> ${esc(t('settings.sync.run.confirm'))}</label>`,
  isExport?t('settings.sync.action.export'):t('settings.sync.action.import'),async fd=>{
   if(!fd.has('confirm'))throw new Error(t('settings.confirmRequired'));
   const result=await postSync(ctx,{action});
   setLastSyncRun({action,outcome:result.outcome,status:result.status,at:new Date().toISOString()});
   ctx.toast(result.outcome?.error?t('settings.sync.run.failedToast'):result.outcome?.skipped?t('settings.sync.run.skippedToast'):isExport?t('settings.sync.run.exportDone'):t('settings.sync.run.importDone'));
   ctx.invalidate();
  });
}
