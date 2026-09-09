import {esc,icon,header,btn,linkBtn,banner,kv,badge,name,options,table,number,date,short} from '../ui.mjs';
const tabs=[['runtime','런타임'],['actions','관리 작업'],['sync','동기화'],['interface','화면 설정'],['diagnostics','진단']];
const DIR_SOURCE={env:'MEMEX_SYNC_DIR 환경 변수',configured:'이 화면에서 지정',default:'기본 로컬 경로 · 공유되지 않음'};
/** 이 서버 실행 중 마지막으로 누른 내보내기·가져오기의 결과. 서버는 이 값을 보관하지 않는다. */
let lastSyncRun=null;
export const setLastSyncRun=value=>{lastSyncRun=value;};
const importCounts=r=>`기억 +${number(r.newFacts)} / ~${number(r.updatedFacts)} / -${number(r.deletedFacts)} · 변경 이력 +${number(r.newRevisions)} · tombstone +${number(r.newTombstones)} · 제공 기록 +${number(r.newRecallEvents)} / ~${number(r.updatedRecallEvents)}`;
const SKIP={disabled:'동기화가 꺼져 있어 아무것도 하지 않았습니다.',unchanged:'마지막 내보내기 이후 durable 변경이 없습니다.',locked:'다른 내보내기가 진행 중이라 이번 요청은 건너뛰었습니다.'};
/**
 * 관리 › 동기화 (#48 UI 절반).
 * 상태·켜기/끄기·수동 실행만 다룬다. 수동 파일 내보내기/가져오기, 기기 별칭, 충돌 이력은 0.6.2다.
 */
export function syncTab(ctx,env,data,error,run=lastSyncRun){
 if(!env.sync)return banner('설치된 코어에 <code>dist/sync-control.js</code>가 없습니다. 레포 루트에서 코어를 빌드한 뒤 서버를 다시 시작하세요.','error');
 if(!data)return banner(esc(error||'동기화 상태를 읽지 못했습니다.'),'error');
 const s=data.status||{};const on=!!s.enabled;
 const peers=(s.peers||[]).filter(p=>!p.isSelf);
 const last=s.lastExport||null;
 const off=on?'':'disabled';
 const rows=[
  ['상태',on?'<span class="tag green">켜짐</span>':'<span class="tag">꺼짐 · 기본값</span>'],
  ['공유 폴더',`<code>${esc(s.dir||'미설정')}</code>`],
  ['경로 출처',esc(DIR_SOURCE[s.dirSource]||s.dirSource||'미수집')],
  ['폴더 상태',s.dirExists?(s.dirWritable?'<span class="tag green">쓰기 가능</span>':'<span class="tag red">쓸 수 없음</span>'):'<span class="tag amber">아직 없음</span>'],
  ['설정 파일',`<code>${esc(s.configPath||'미수집')}</code>`],
  ['설정 변경 시각',esc(date(s.updatedAt))],
  ['이 기기 ID',s.deviceId?`<code>${esc(s.deviceId)}</code>`:'<span class="muted">아직 없음 · 첫 내보내기에서 부여됩니다</span>'],
 ];
 const exportRows=last?[
  ['마지막 내보내기',esc(date(last.at))],
  ['결과',last.ok?'<span class="tag green">성공</span>':'<span class="tag red">실패</span>'],
  ...(last.counts?[['내보낸 행 수',esc(`기억 ${number(last.counts.facts)} · 변경 이력 ${number(last.counts.revisions)} · tombstone ${number(last.counts.tombstones)} · 제공 기록 ${number(last.counts.recallEvents)}`)]]:[]),
  ...(last.error?[['오류',`<span class="danger-text">${esc(last.error)}</span>`]]:[]),
 ]:null;
 const issues=run?.outcome?.result?.malformedRows||[];
 return `${banner(on?'동기화는 durable 기억 상태만 주고받습니다. 대화 원문·번역·분류·벡터는 각 기기에서 다시 만듭니다. 공유 폴더에는 기억 원문이 <strong>평문 JSONL</strong>로 저장되므로 본인 계정의 클라우드·드라이브만 쓰세요.':'다기기 동기화는 <strong>기본으로 꺼져 있습니다.</strong> 꺼져 있는 동안 내보내기 훅·유지보수 내보내기·SessionStart 가져오기는 모두 아무 일도 하지 않습니다.',on?'neutral':'warning')}
 <div class="settings-layout"><section class="card pad"><div class="setting-row"><div><h3>다기기 동기화</h3><p>켜면 공유 폴더 경로를 확인하고, 이 기기의 기억 상태를 세대 단위로 주고받습니다.</p></div><input type="checkbox" id="sync-switch" aria-label="다기기 동기화" ${on?'checked':''}></div>
 ${kv(rows)}
 <div class="row wrap mt">${btn('지금 내보내기','download',`data-sync="export" ${off}`,'primary')}${btn('지금 가져오기','refresh',`data-sync="import" ${off}`)}</div>
 ${on?'':'<p class="caption mt">동기화가 꺼져 있어 수동 실행 버튼을 쓸 수 없습니다. 위 스위치로 먼저 켜세요.</p>'}</section>
 <section class="card pad"><h2>마지막 내보내기</h2>${exportRows?kv(exportRows):banner(on?'아직 한 번도 내보내지 않았습니다. 지금 내보내기로 첫 세대를 만드세요.':'내보내기 기록이 없습니다.','neutral')}
 <h2 class="mt">감지된 다른 기기</h2>${peers.length?table(['기기','호스트','마지막 세대','시각','행 수'],peers.map(p=>`<tr><td><code>${esc(p.deviceId)}</code></td><td>${esc(p.hostname||'미수집')}</td><td class="mono subtle">${esc(short(p.generation))}</td><td class="nowrap">${esc(date(p.exportedAt))}</td><td>${p.counts?esc(`${number(p.counts.facts)} / ${number(p.counts.revisions)} / ${number(p.counts.tombstones)} / ${number(p.counts.recallEvents)}`):'<span class="muted">manifest를 읽지 못했습니다</span>'}</td></tr>`)):`<p class="caption">${esc(s.dirExists?'공유 폴더에서 다른 기기의 세대를 찾지 못했습니다.':'공유 폴더가 아직 없습니다.')}</p>`}</section></div>
 ${run?`<section class="card pad mt"><h2>이 서버 실행 중 마지막 ${esc(run.action==='export'?'내보내기':'가져오기')}</h2>
 ${run.outcome?.skipped?banner(esc(SKIP[run.outcome.skipped]||run.outcome.skipped),'neutral'):''}
 ${run.outcome?.error?banner(esc(run.outcome.error),'error'):''}
 ${run.outcome?.result&&run.action==='import'?kv([['적용 결과',esc(importCounts(run.outcome.result))],['실행 시각',esc(date(run.at))]]):''}
 ${run.outcome?.result&&run.action==='export'?kv([['내보낸 행 수',esc(`기억 ${number(run.outcome.result.facts)} · 변경 이력 ${number(run.outcome.result.revisions)} · tombstone ${number(run.outcome.result.tombstones)} · 제공 기록 ${number(run.outcome.result.recallEvents)}`)],['실행 시각',esc(date(run.at))]]):''}
 <h2 class="mt">거부된 세대와 사유</h2>${issues.length?table(['위치','줄','사유'],issues.map(i=>`<tr><td class="mono subtle">${esc(i.file)}</td><td>${number(i.line)}</td><td class="wrap">${esc(i.error)}</td></tr>`)):'<p class="caption">거부된 세대가 없습니다. 세대는 하나라도 깨지면 통째로 거부되며, 그 사유가 여기에 그대로 나옵니다.</p>'}</section>`:''}
 <div class="footer-note"><span>수동 파일 내보내기·가져오기, 기기 별칭, 충돌 이력 화면은 0.6.2에서 들어옵니다. 지금은 공유 폴더 경로가 유일한 교환 방법입니다.</span><span>가져오기 결과는 이 서버가 실행되는 동안만 이 화면에 남습니다.</span></div>`;
}
const descriptions={doctor:'설치, 실행 환경, 데이터베이스 준비 상태를 코어 CLI로 검사합니다.',status:'전체 데이터의 파이프라인 처리 상태를 확인합니다.',sync:'보관된 대화를 인덱스에 동기화합니다. 코어의 동기화 로직을 그대로 사용합니다.',extract:'미처리 대화의 기억 추출을 백필합니다. 모델 호출이 발생할 수 있습니다.',ontology:'미분류 기억의 온톨로지 분류와 관련 후속 처리를 요청합니다.',embeddings:'누락된 임베딩을 백필합니다. 코어에 설정된 임베딩 런타임이 필요합니다.',all:'추출·분류·임베딩 백필을 코어가 정의한 순서로 수행합니다.',recover:'실패로 종료된 작업을 전부 다시 대기 상태로 되돌립니다. 삭제하지 않으며 오류 원문은 보존됩니다.'};
/**
 * 기억 계층 이관 카드(#22): dry-run 출력을 그대로 보여주고, 적용은 기존 관리 명령 확인 모달을 거친다.
 * 출력은 코어 CLI가 찍은 원문이며 UI가 요약하거나 추정하지 않는다.
 */
export function migrationCard(ctx,env,runs={}){
 const preview=runs.preview,apply=runs.apply,output=runs.previewOutput;
 return `<section class="card pad mt" id="tier-migration"><div class="spread"><h2>기억 계층 이관</h2>${preview?badge(preview.status):'<span class="tag outline">미실행</span>'}</div>
 <p class="caption mt">0.6.0 이전에 만들어진 기억은 브랜치 신호가 없어도 브랜치 계층에 남아 있어 프로젝트 화면에 보이지 않습니다. <code>memex facts migrate-tiers</code>는 <strong>브랜치 신호가 없는 브랜치 계층 기억만</strong> 프로젝트 공용으로 올리고, 실제 브랜치에서 만들어진 기억은 그대로 둡니다.</p>
 <div class="row wrap mt">${btn('미리보기 실행','play',`data-command="tiers-preview" ${!env.commands?'disabled':''}`,'primary')}${btn('확인하고 적용','check',`data-command="tiers-apply" ${!env.commands||!preview?'disabled':''}`)}${preview?linkBtn('실행 내역','terminal',ctx.href('/activity',{tab:'operations'}),'ghost'):''}</div>
 ${preview?kv([['마지막 미리보기',esc(date(preview.started_at))],['상태',badge(preview.status)],['종료 코드',number(preview.exit_code)]]):banner('아직 미리보기를 실행하지 않았습니다. 적용 버튼은 미리보기로 대상을 확인한 뒤에 열립니다.','neutral')}
 ${output?`<pre class="terminal mt" id="tier-migration-output">${esc(output)}</pre>`:preview&&preview.status==='completed'?'<p class="caption mt">이 서버 실행에는 보존된 출력이 없습니다. 미리보기를 다시 실행하세요.</p>':''}
 ${apply?banner(`마지막 적용 · ${esc(date(apply.started_at))} · ${esc(name(apply.status))}`,'neutral'):''}</section>`;
}
export async function render(ctx){
 const p=ctx.p;const tab=tabs.some(x=>x[0]===p.get('tab'))?p.get('tab'):'runtime';const env=ctx.bootstrap.environment;let body='';
 let tierRuns={},syncData=null,syncError=null;
 if(tab==='sync'&&env.sync){try{syncData=await ctx.api('sync');}catch(e){syncError=e.message;}}
 if(tab==='actions'){
  try{
   const runs=(await ctx.api('operations')).items||[];
   tierRuns={preview:runs.find(x=>x.command==='tiers-preview')||null,apply:runs.find(x=>x.command==='tiers-apply')||null};
   if(tierRuns.preview&&!tierRuns.preview.outputLost){const full=await ctx.api('operation',{id:tierRuns.preview.id});tierRuns.previewOutput=String(full.output||'').slice(-4000)||null;}
  }catch{tierRuns={};}
 }
 if(tab==='runtime')body=`<div class="settings-layout"><section class="card"><div class="card-head"><h2>로컬 실행 환경</h2>${badge(ctx.bootstrap.db.available?'active':'error',undefined)}</div><div class="card-body">${kv([['코어 버전',esc(env.version||'확인 불가')],['UI 버전',esc(ctx.bootstrap.uiVersion)],['Node.js',esc(env.node)],['실행 플랫폼',esc(env.platform)],['레포 위치',`<code>${esc(env.root)}</code>`],['데이터 루트',`<code>${esc(env.home)}</code>`],['DB 경로',`<code>${esc(env.dbPath)}</code>`],['서버 프로세스',esc(env.pid)],['접속 주소',`<code>${esc(location.origin)}</code>`]])}</div></section><section class="card pad"><h2>관측 경계</h2><ul class="notice-list"><li><strong>UI 연결 ≠ 플러그인 연결</strong>브라우저와 이 서버의 연결 상태만 직접 확인합니다. 마지막 활동은 작업·로그 기록에서 확인하세요.</li><li><strong>조회는 작업을 시작하지 않습니다</strong>대화 조회, 그래프 탐색, 새로고침으로 추출·분류가 실행되지 않습니다.</li><li><strong>환경은 이 프로세스 기준</strong>${esc(env.note)}</li><li><strong>로컬 접근만 허용</strong>127.0.0.1에만 바인딩하며 동일 출처·변경 요청 토큰을 검사합니다. OS 사용자 인증을 대체하지는 않습니다.</li></ul></section></div><section class="card mt"><div class="card-head"><h2>상속한 환경 변수</h2><span class="meta">읽기 전용</span></div>${table(['변수','현재 값'],Object.entries(env.values||{}).map(([k,v])=>`<tr><td><code>${esc(k)}</code></td><td>${v===null?'<span class="muted">설정되지 않음 · 코어 기본값 적용</span>':`<code>${esc(v)}</code>`}</td></tr>`))}<div class="card-body caption">이 화면은 플러그인 설정 파일을 임의로 수정하지 않습니다. 환경 변경은 실행 셸 또는 플러그인 호스트 설정에 적용한 뒤 해당 프로세스를 다시 시작해야 합니다.</div></section>`;
 if(tab==='actions')body=banner('아래 명령은 <strong>전체 데이터베이스</strong>를 대상으로 합니다. 상단의 프로젝트 필터는 명령 범위를 제한하지 않습니다. 한 번에 하나의 관리 명령만 실행합니다.','warning')+(!env.commands?banner('이 경로에서 cli/memex.js를 찾지 못했습니다. 레포 루트에 적용한 뒤 다시 실행하세요.','error'):'')+`<div class="three-col">${Object.entries(ctx.bootstrap.commands).filter(([,c])=>!c.group).map(([key,c])=>`<section class="card action-card"><div class="row wrap">${icon(c.model?'layers':c.mutates?'refresh':'shield')}${c.mutates?badge('CHANGED'):badge('VALIDATED')}${c.model?'<span class="tag amber">모델 호출 가능</span>':''}</div><h2>${esc(c.label)}</h2><p>${esc(descriptions[key])}</p><code>memex ${esc(c.args.join(' '))}</code>${btn('실행 검토','play',`data-command="${esc(key)}" ${!env.commands?'disabled':''}`,c.mutates?'':'primary')}</section>`).join('')}</div>${migrationCard(ctx,env,tierRuns)}<div class="mt">${linkBtn('관리 실행 내역','terminal',ctx.href('/activity',{tab:'operations'}))}</div>`;
 if(tab==='sync')body=syncTab(ctx,env,syncData,syncError);
 if(tab==='interface')body=`<div class="settings-layout"><section class="card pad"><h2>이 브라우저의 표시 설정</h2><form id="preferences-form"><div class="setting-row"><div><h3>테마</h3><p>밝게, 어둡게 또는 시스템 설정을 따릅니다.</p></div><select name="theme" aria-label="테마">${options([['light','밝게'],['dark','어둡게'],['system','시스템']],ctx.prefs.theme)}</select></div><div class="setting-row"><div><h3>목록 밀도</h3><p>테이블과 타임라인의 세로 여백입니다.</p></div><select name="density" aria-label="목록 밀도">${options([['comfortable','편안하게'],['compact','촘촘하게']],ctx.prefs.density)}</select></div><div class="setting-row"><div><h3>기억의 한국어 표시</h3><p>저장된 한국어 번역이 있을 때 우선 표시합니다. 새 번역을 생성하지 않습니다.</p></div><input type="checkbox" name="korean" aria-label="한국어 우선" ${ctx.prefs.korean?'checked':''}></div><div class="setting-row"><div><h3>도움말 표시</h3><p>페이지 제목 옆 안내 아이콘과 사이드바 용어집 링크를 언제 보여줄지 정합니다. "처음만"은 한 번 연 항목을 다시 띄우지 않습니다. 컨트롤·배지의 한 줄 툴팁은 항상 남습니다.</p></div><select name="help" aria-label="도움말 표시">${options([['always','항상'],['first','처음만'],['off','끄기']],ctx.prefs.help||'always')}</select></div><div class="setting-row"><div><h3>활동 화면 자동 갱신</h3><p>활동 화면에서 10초마다 갱신합니다. 입력·상세 확인 중에는 멈춥니다.</p></div><input type="checkbox" name="live" aria-label="자동 갱신" ${ctx.prefs.live?'checked':''}></div><div class="row mt">${btn('설정 저장','check','type="submit"','primary')}</div></form></section><section class="card pad"><h2>키보드로 사용하기</h2>${kv([['⌘ / Ctrl + K','현재 범위에서 통합 검색'],['Esc','상세 패널 또는 대화상자 닫기'],['Tab / Shift + Tab','컨트롤 사이 이동'],['그래프 방향키','이동 · 3D에서는 회전'],['그래프 + / − / 0','확대 · 축소 · 위치 초기화'],['?','용어집 열기']])}<p class="caption mt">설정은 브라우저의 localStorage에만 저장됩니다. Memex의 기억, 플러그인 환경 또는 다른 브라우저에는 영향을 주지 않습니다.</p></section></div>`;
 if(tab==='diagnostics')body=`${!ctx.bootstrap.db.available?banner(esc(ctx.bootstrap.db.error?.message||'DB 연결 불가'),'error'):banner('데이터베이스 읽기 연결이 열렸습니다. 아래 표는 테이블 존재 여부이며 각 기능의 성공·완료를 보증하지 않습니다.')}<div class="settings-layout"><section class="card"><div class="card-head"><h2>저장소 기능 확인</h2></div>${table(['기록 테이블','상태'],Object.entries(ctx.bootstrap.capabilities).map(([k,v])=>`<tr><td><code>${esc(k)}</code></td><td>${v?'<span class="tag green">조회 가능</span>':'<span class="tag">테이블 없음</span>'}</td></tr>`))}</section><section class="card pad"><h2>진단 정보 내보내기</h2><p class="caption mt">UI·코어 버전, 플랫폼, 테이블 존재 여부, 관리 작업 상태만 포함합니다. 대화, 팩트 문장, 원시 로그, 절대 경로 및 환경 변수 값은 포함하지 않습니다.</p><div class="row wrap mt">${btn('진단 JSON 다운로드','download','data-action="diagnostics-download"')}${btn('코어 진단 실행','shield',`data-command="doctor" ${!env.commands?'disabled':''}`)}</div><hr><h2>문제가 생겼을 때</h2><ul class="notice-list"><li><strong>DB가 없음</strong>데이터 경로를 확인하고 대화 동기화를 명시적으로 실행하세요.</li><li><strong>코어 모듈을 찾을 수 없음</strong>레포 루트에서 의존성을 설치하고 코어를 빌드한 뒤 서버를 다시 시작하세요.</li><li><strong>기록이 비어 있음</strong>프로젝트 범위, 날짜 및 필터를 확인하세요. 과거 데이터에 없던 계측은 재구성하지 않습니다.</li><li><strong>모델 작업 실패</strong>작업·모델 시도·관리 출력에서 실제 오류를 확인하세요. 인증 정보는 이 UI에 입력하지 않습니다.</li></ul></section></div>`;
 return {html:header('관리','로컬 환경을 확인하고, 필요한 작업만 명시적으로 실행하세요.',btn('다시 확인','refresh','data-action="refresh-bootstrap"'),'CONTROL CENTER','/settings')+`<nav class="tabs" aria-label="관리 탭">${tabs.map(([k,v])=>`<a class="tab ${tab===k?'active':''}" href="${esc(ctx.href('/settings',{tab:k}))}" data-nav>${esc(v)}</a>`).join('')}</nav>`+body,mount(el){el.querySelector('#preferences-form')?.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.currentTarget);ctx.savePrefs({theme:f.get('theme'),density:f.get('density'),korean:f.has('korean'),live:f.has('live'),help:f.get('help')||'always'});ctx.toast('이 브라우저의 설정을 저장했습니다.');});
 // 스위치는 낙관적으로 되돌리고 서버 상태가 다시 그리게 둔다 — 모달을 닫기만 해도 어긋나지 않는다.
 el.querySelector('#sync-switch')?.addEventListener('change',event=>{const wanted=event.target.checked;event.target.checked=!wanted;wanted?enableSync(ctx):disableSync(ctx);});
 el.querySelectorAll('[data-sync]').forEach(b=>b.addEventListener('click',()=>runSync(ctx,b.dataset.sync)));
 }};
}
async function postSync(ctx,body){const result=await ctx.api('sync',{},{body:{...body,confirm:true},timeout:180000});return result;}
function enableSync(ctx){
 const status=lastSyncRun?.status||null;
 ctx.modal('다기기 동기화 켜기',
  banner('공유 폴더는 <strong>두 기기가 모두 볼 수 있는 경로</strong>여야 합니다(iCloud Drive, Dropbox, Syncthing, 네트워크 드라이브). 기억 원문이 평문 JSONL로 저장되므로 본인 계정의 저장소만 쓰세요.','warning')
  +`<label class="field">공유 폴더 절대 경로<input name="dir" required autocomplete="off" placeholder="/Users/me/Library/Mobile Documents/com~apple~CloudDocs/memex-sync" value="${esc(status?.dir||'')}"></label>`
  +banner('켤 때 폴더를 만들고 <strong>쓰기 가능한지 지금 확인</strong>합니다. 실패하면 켜지 않습니다. 이 설정은 데이터 루트의 <code>sync/config.json</code>에 저장됩니다.','neutral'),
  '확인하고 켜기',async fd=>{
   const result=await postSync(ctx,{action:'enable',dir:String(fd.get('dir')||'').trim()});
   ctx.toast(`동기화를 켰습니다. 공유 폴더: ${result.status.dir}`);ctx.invalidate();
  });
}
function disableSync(ctx){
 ctx.confirm('다기기 동기화 끄기','끄면 내보내기 훅·유지보수 내보내기·SessionStart 가져오기가 모두 아무 일도 하지 않습니다. 이미 공유 폴더에 있는 세대는 지우지 않습니다.',async()=>{
  await postSync(ctx,{action:'disable'});ctx.toast('동기화를 껐습니다.');ctx.invalidate();
 });
}
function runSync(ctx,action){
 const isExport=action==='export';
 ctx.modal(isExport?'지금 내보내기':'지금 가져오기',
  banner(isExport
   ?'이 기기의 durable 기억 상태로 <strong>새 세대 하나</strong>를 공유 폴더에 만듭니다. 변경이 없어도 사용자가 요청하면 내보냅니다. 모델을 호출하지 않습니다.'
   :'공유 폴더의 다른 기기 세대를 읽어 이 기기의 기억에 반영합니다. 세대는 하나라도 깨지면 <strong>통째로 거부</strong>하며, 거부 사유를 그대로 보여줍니다. 모델을 호출하지 않습니다.','warning')
  +'<label class="check-row mt"><input type="checkbox" name="confirm" required> 전체 데이터에 적용된다는 것을 확인했습니다.</label>',
  isExport?'내보내기':'가져오기',async fd=>{
   if(!fd.has('confirm'))throw new Error('확인란을 체크하세요.');
   const result=await postSync(ctx,{action});
   setLastSyncRun({action,outcome:result.outcome,status:result.status,at:new Date().toISOString()});
   ctx.toast(result.outcome?.error?'실행이 실패했습니다. 결과를 확인하세요.':result.outcome?.skipped?'건너뛰었습니다. 사유를 확인하세요.':isExport?'새 세대를 내보냈습니다.':'가져오기를 적용했습니다.');
   ctx.invalidate();
  });
}
