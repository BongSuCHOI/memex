import {esc,icon,header,btn,linkBtn,banner,kv,badge,name,options,table,number,date,short,bytes} from '../ui.mjs';
import {visibleTabs,tabFor,renderedBySettingsPage} from './settings-tabs.mjs';
import {t,localeTag,LOCALES} from '../i18n/index.mjs';
import {ENDONYMS} from '../i18n/endonyms.mjs';
const DIR_SOURCE={env:'MEMEX_SYNC_DIR 환경 변수',configured:'이 화면에서 지정',default:'기본 로컬 경로 · 공유되지 않음'};
/** 이 서버 실행 중 마지막으로 누른 내보내기·가져오기의 결과. 서버는 이 값을 보관하지 않는다. */
let lastSyncRun=null,lastArchive=null,lastPreview=null;
export const setLastSyncRun=value=>{lastSyncRun=value;};
/** 마지막으로 만든 세대 파일(zip)과 마지막 가져오기 미리보기. 둘 다 이 브라우저 세션용이다. */
export const setLastArchive=value=>{lastArchive=value;};
export const setLastPreview=value=>{lastPreview=value;};
const importCounts=r=>`기억 +${number(r.newFacts)} / ~${number(r.updatedFacts)} / -${number(r.deletedFacts)} · 변경 이력 +${number(r.newRevisions)} · tombstone +${number(r.newTombstones)} · 제공 기록 +${number(r.newRecallEvents)} / ~${number(r.updatedRecallEvents)}`;
const SKIP={disabled:'동기화가 꺼져 있어 아무것도 하지 않았습니다.',unchanged:'마지막 내보내기 이후 durable 변경이 없습니다.',locked:'다른 내보내기가 진행 중이라 이번 요청은 건너뛰었습니다.'};
const WINNER={peer:'가져온 기기의 값',local:'이 기기의 값'};
const deviceName=(alias,id)=>alias?`${esc(alias)} <code class="subtle">${esc(short(id))}</code>`:`<code>${esc(id||'미수집')}</code>`;
/** 거부 사유 표 — 세대는 하나라도 깨지면 통째로 거부되고, 그 사유를 코어 원문 그대로 싣는다. */
const rejectedTable=issues=>issues.length
 ?table(['위치','줄','사유'],issues.map(i=>`<tr><td class="mono subtle">${esc(i.file)}</td><td>${number(i.line)}</td><td class="wrap">${esc(i.error)}</td></tr>`))
 :'<p class="caption">거부된 세대가 없습니다. 세대는 하나라도 깨지면 통째로 거부되며, 그 사유가 여기에 그대로 나옵니다.</p>';
/**
 * 관리 › 동기화 (#48).
 *
 * 0.6.1에서 스위치·상태·공유 폴더 실행까지, 0.6.3에서 **수동 세대 파일(zip) 내보내기·가져오기,
 * 기기 별칭, 충돌 이력**이 들어왔다. 모두 `/api/v2/sync` 한 엔드포인트의 action이다.
 */
export function syncTab(ctx,env,data,error,run=lastSyncRun,archive=lastArchive,preview=lastPreview){
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
  // 별칭은 로컬 sync/devices.json에 저장되고, 이 기기의 별칭만 세대 manifest에 실려 피어에 보인다.
  ['이 기기 이름',`<div class="row wrap">${s.deviceAlias?`<strong>${esc(s.deviceAlias)}</strong>`:'<span class="muted">지정 없음 · 다른 맥에서 UUID로 보입니다</span>'}${btn(s.deviceAlias?'이름 바꾸기':'이름 지정','edit',`data-alias="${esc(s.deviceId||'')}" data-alias-name="${esc(s.deviceAlias||'')}" ${s.deviceId?'':'disabled'}`,'small ghost')}</div>${s.deviceId?'':'<p class="caption">기기 ID가 부여된 뒤에 이름을 지을 수 있습니다.</p>'}`],
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
 <h2 class="mt">감지된 다른 기기</h2>${peers.length?table(['기기 이름','기기 ID','호스트','마지막 세대','시각','행 수'],peers.map(p=>`<tr><td><div class="row wrap">${p.alias?`<strong>${esc(p.alias)}</strong>`:'<span class="muted">이름 없음</span>'}${btn('이름','edit',`data-alias="${esc(p.deviceId)}" data-alias-name="${esc(p.alias||'')}"`,'small ghost')}</div>${p.alias&&!p.aliasIsLocal?'<p class="caption">상대 기기가 보낸 이름입니다.</p>':''}</td><td class="mono subtle">${esc(short(p.deviceId))}</td><td>${esc(p.hostname||'미수집')}</td><td class="mono subtle">${esc(short(p.generation))}</td><td class="nowrap">${esc(date(p.exportedAt))}</td><td>${p.counts?esc(`${number(p.counts.facts)} / ${number(p.counts.revisions)} / ${number(p.counts.tombstones)} / ${number(p.counts.recallEvents)}`):'<span class="muted">manifest를 읽지 못했습니다</span>'}</td></tr>`)):`<p class="caption">${esc(s.dirExists?'공유 폴더에서 다른 기기의 세대를 찾지 못했습니다.':'공유 폴더가 아직 없습니다.')}</p>`}</section></div>
 ${archiveCard(s,archive,preview)}
 ${run?`<section class="card pad mt"><h2>이 서버 실행 중 마지막 ${esc(run.action==='export'?'내보내기':'가져오기')}</h2>
 ${run.outcome?.skipped?banner(esc(SKIP[run.outcome.skipped]||run.outcome.skipped),'neutral'):''}
 ${run.outcome?.error?banner(esc(run.outcome.error),'error'):''}
 ${run.outcome?.result&&run.action==='import'?kv([['적용 결과',esc(importCounts(run.outcome.result))],...(run.source?[['가져온 파일',`<code>${esc(run.source)}</code>`]]:[]),['실행 시각',esc(date(run.at))]]):''}
 ${run.outcome?.result&&run.action==='export'?kv([['내보낸 행 수',esc(`기억 ${number(run.outcome.result.facts)} · 변경 이력 ${number(run.outcome.result.revisions)} · tombstone ${number(run.outcome.result.tombstones)} · 제공 기록 ${number(run.outcome.result.recallEvents)}`)],['실행 시각',esc(date(run.at))]]):''}
 <h2 class="mt">거부된 세대와 사유</h2>${rejectedTable(issues)}</section>`:''}
 <div class="footer-note"><span>실제 두 대의 맥 사이 라운드트립은 아직 <strong>검증되지 않았습니다</strong>(liveTwoDeviceRoundTrip: NOT_PROVEN) — 기능은 모두 들어와 있고, 두 기기에서의 실제 확인만 남았습니다.</span><span>가져오기 결과·미리보기는 이 서버가 실행되는 동안만 이 화면에 남습니다.</span></div>`;
}
/**
 * 수동 파일 교환 (#48, 0.6.3).
 *
 * 브라우저 다운로드·업로드는 이 UI의 샌드박스(CSP·loopback 전용)에서 쓰지 않는다. 그래서 서버가
 * **데이터 루트 안**에 zip을 쓰고 그 경로를 보여주고(복사 → Finder에서 열기), 가져오기는 사용자가
 * 받아 둔 파일 경로를 받는다. 가져오기는 항상 **검증 → 미리보기 → 확인** 순서이고, 미리보기는
 * 아무것도 바꾸지 않는다.
 */
export function archiveCard(s,archive,preview){
 const ready=!!archive;
 return `<section class="card pad mt" id="sync-archive"><div class="spread"><h2>수동 파일로 주고받기</h2><span class="tag outline">공유 폴더가 없어도 됩니다</span></div>
 <p class="caption mt">세대 하나를 <strong>zip 파일</strong>로 만들어 다른 맥으로 옮깁니다(AirDrop · 메일 · USB). 브라우저 다운로드는 이 UI에서 막혀 있으므로 서버가 <strong>데이터 루트 안</strong>에 파일을 쓰고 경로를 알려줍니다. 받은 파일은 아래에 경로를 넣어 <strong>검증 → 미리보기 → 확인</strong> 순서로 가져옵니다. 모델을 호출하지 않습니다. 파일에는 기억 원문이 <strong>평문 JSONL</strong>로 들어 있으니 본인 기기끼리만 주고받으세요.</p>
 <div class="two-col mt">
  <div><h3>세대 파일로 내보내기</h3>
  <p class="caption mt">지금 상태로 새 세대를 만들고 그 세대를 zip으로 저장합니다. 동기화가 꺼져 있어도 동작합니다.</p>
  <div class="row wrap mt">${btn('세대 파일로 내보내기','download','data-archive="export"','primary')}${ready?btn('경로 복사','copy',`data-copy-command="${esc(archive.path)}"`,'small ghost'):''}</div>
  ${ready?kv([['만든 파일',`<code>${esc(archive.path)}</code>`],['크기',esc(bytes(archive.bytes))],['기기 · 세대',`${deviceName(archive.deviceAlias,archive.deviceId)} · <code class="subtle">${esc(short(archive.generation))}</code>`],['담긴 행 수',esc(`기억 ${number(archive.counts.facts)} · 변경 이력 ${number(archive.counts.revisions)} · tombstone ${number(archive.counts.tombstones)} · 제공 기록 ${number(archive.counts.recallEvents)}`)]])+`<p class="caption mt">Finder에서 열기: 경로를 복사한 뒤 Finder에서 <strong>⇧⌘G</strong>로 붙여 넣으세요. 기억 원문이 <strong>평문 JSONL</strong>로 들어 있으므로 본인 기기끼리만 주고받으세요.</p>`:`<p class="caption mt">기본 저장 위치: <code>${esc(s.archiveDir||'미수집')}</code></p>`}
  </div>
  <div><h3>세대 파일 가져오기</h3>
  <p class="caption mt">다른 맥에서 만든 zip(또는 풀어 둔 세대 디렉터리)의 절대 경로를 넣으세요.</p>
  <form class="stack-sm mt" id="archive-import-form"><label class="field">받은 파일 경로<input name="path" autocomplete="off" spellcheck="false" placeholder="/Users/me/Downloads/&lt;device&gt;-&lt;generation&gt;.zip" value="${esc(preview?.path||'')}" required></label>
  <!-- 가져오기는 form 안에 있지만 submit이 아니다: 기본 type이면 클릭이 미리보기까지 다시 보낸다. -->
  <div class="row wrap">${btn('검증하고 미리보기','search','type="submit"')}${btn('확인하고 가져오기','check',`type="button" data-archive="import" ${preview?.preview?.generations?.length?'':'disabled'}`,'primary')}</div></form>
  ${preview?'':'<p class="caption mt">미리보기는 세대의 해시·스키마를 검증하고 적용 결과만 계산합니다. 이 기기의 기억은 바뀌지 않습니다.</p>'}
  </div>
 </div>
 ${preview?`<div class="divider"></div><div class="spread"><h3>가져오기 미리보기</h3><span class="caption">${esc(date(preview.at))}</span></div>
 ${preview.error?banner(esc(preview.error),'error'):''}
 ${preview.preview?kv([['파일',`<code>${esc(preview.preview.source||preview.path)}</code>`],['보낸 기기',deviceName(preview.preview.deviceAlias,preview.preview.deviceId)],['세대',`<code class="subtle">${esc(short(preview.preview.generation))}</code>`],['적용하면',esc(`기억 +${number(preview.preview.newFacts)} / ~${number(preview.preview.updatedFacts)} / -${number(preview.preview.deletedFacts)}`)],['충돌',preview.preview.conflicts.length?esc(`${number(preview.preview.conflicts.length)}건`):'<span class="muted">없음</span>']]):''}
 ${preview.preview?`<p class="caption mt">미리보기의 <code>~N</code>은 <strong>기억 개수</strong>이고, 적용 결과의 <code>~N</code>은 의미·근거·활성 상태를 축별로 세므로 더 클 수 있습니다. 변경 이력·제공 기록 수는 미리 세지 않습니다.</p>`:''}
 ${preview.preview?.conflicts?.length?table(['기억','보낸 기기','남는 값','판정'],preview.preview.conflicts.map(c=>`<tr><td class="mono subtle">${esc(short(c.factId))}</td><td>${deviceName(c.deviceAlias,c.deviceId)}</td><td>${esc(WINNER[c.winner]||'미수집')}</td><td class="wrap">${esc(c.reason)}</td></tr>`)):''}
 <h3 class="mt">거부된 세대와 사유</h3>${rejectedTable(preview.preview?.rejected||[])}`:''}</section>`;
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
 if(tab==='runtime')body=`<div class="settings-layout"><section class="card"><div class="card-head"><h2>로컬 실행 환경</h2>${badge(ctx.bootstrap.db.available?'active':'error',undefined)}</div><div class="card-body">${kv([['코어 버전',esc(env.version||'확인 불가')],['UI 버전',esc(ctx.bootstrap.uiVersion)],['Node.js',esc(env.node)],['실행 플랫폼',esc(env.platform)],['레포 위치',`<code>${esc(env.root)}</code>`],['데이터 루트',`<code>${esc(env.home)}</code>`],['DB 경로',`<code>${esc(env.dbPath)}</code>`],['서버 프로세스',esc(env.pid)],['접속 주소',`<code>${esc(location.origin)}</code>`]])}</div></section><section class="card pad"><h2>관측 경계</h2><ul class="notice-list"><li><strong>UI 연결 ≠ 플러그인 연결</strong>브라우저와 이 서버의 연결 상태만 직접 확인합니다. 마지막 활동은 작업·로그 기록에서 확인하세요.</li><li><strong>조회는 작업을 시작하지 않습니다</strong>대화 조회, 그래프 탐색, 새로고침으로 추출·분류가 실행되지 않습니다.</li><li><strong>환경은 이 프로세스 기준</strong>${esc(env.note)}</li><li><strong>로컬 접근만 허용</strong>127.0.0.1에만 바인딩하며 동일 출처·변경 요청 토큰을 검사합니다. OS 사용자 인증을 대체하지는 않습니다.</li></ul></section></div><section class="card mt"><div class="card-head"><h2>상속한 환경 변수</h2><span class="meta">읽기 전용</span></div>${table(['변수','현재 값'],Object.entries(env.values||{}).map(([k,v])=>`<tr><td><code>${esc(k)}</code></td><td>${v===null?'<span class="muted">설정되지 않음 · 코어 기본값 적용</span>':`<code>${esc(v)}</code>`}</td></tr>`))}<div class="card-body caption">이 화면은 플러그인 설정 파일을 임의로 수정하지 않습니다. 환경 변경은 실행 셸 또는 플러그인 호스트 설정에 적용한 뒤 해당 프로세스를 다시 시작해야 합니다.</div></section>`;
 if(tab==='actions')body=banner('아래 명령은 <strong>전체 데이터베이스</strong>를 대상으로 합니다. 상단의 프로젝트 필터는 명령 범위를 제한하지 않습니다. 한 번에 하나의 관리 명령만 실행합니다.','warning')+(!env.commands?banner('이 경로에서 cli/memex.js를 찾지 못했습니다. 레포 루트에 적용한 뒤 다시 실행하세요.','error'):'')+`<div class="three-col">${Object.entries(ctx.bootstrap.commands).filter(([,c])=>!c.group).map(([key,c])=>`<section class="card action-card"><div class="row wrap">${icon(c.model?'layers':c.mutates?'refresh':'shield')}${c.mutates?badge('CHANGED'):badge('VALIDATED')}${c.model?'<span class="tag amber">모델 호출 가능</span>':''}</div><h2>${esc(c.label)}</h2><p>${esc(descriptions[key])}</p><code>memex ${esc(c.args.join(' '))}</code>${btn('실행 검토','play',`data-command="${esc(key)}" ${!env.commands?'disabled':''}`,c.mutates?'':'primary')}</section>`).join('')}</div>${migrationCard(ctx,env,tierRuns)}<div class="mt">${linkBtn('관리 실행 내역','terminal',ctx.href('/activity',{tab:'operations'}))}</div>`;
 if(tab==='sync')body=syncTab(ctx,env,syncData,syncError);
 if(tab==='interface')body=`<div class="settings-layout"><section class="card pad"><h2>이 브라우저의 표시 설정</h2>${languageRow(ctx)}<form id="preferences-form"><div class="setting-row"><div><h3>테마</h3><p>밝게, 어둡게 또는 시스템 설정을 따릅니다.</p></div><select name="theme" aria-label="테마">${options([['light','밝게'],['dark','어둡게'],['system','시스템']],ctx.prefs.theme)}</select></div><div class="setting-row"><div><h3>목록 밀도</h3><p>테이블과 타임라인의 세로 여백입니다.</p></div><select name="density" aria-label="목록 밀도">${options([['comfortable','편안하게'],['compact','촘촘하게']],ctx.prefs.density)}</select></div><div class="setting-row"><div><h3>기억의 한국어 표시</h3><p>저장된 한국어 번역이 있을 때 우선 표시합니다. 새 번역을 생성하지 않습니다.</p></div><input type="checkbox" name="preferTranslatedFacts" aria-label="한국어 우선" ${ctx.prefs.preferTranslatedFacts?'checked':''}></div><div class="setting-row"><div><h3>도움말 표시</h3><p>페이지 제목 옆 안내 아이콘과 사이드바 용어집 링크를 언제 보여줄지 정합니다. "처음만"은 한 번 연 항목을 다시 띄우지 않습니다. 컨트롤·배지의 한 줄 툴팁은 항상 남습니다.</p></div><select name="help" aria-label="도움말 표시">${options([['always','항상'],['first','처음만'],['off','끄기']],ctx.prefs.help||'always')}</select></div><div class="setting-row"><div><h3>활동 화면 자동 갱신</h3><p>활동 화면에서 10초마다 갱신합니다. 입력·상세 확인 중에는 멈춥니다.</p></div><input type="checkbox" name="live" aria-label="자동 갱신" ${ctx.prefs.live?'checked':''}></div><div class="row mt">${btn('설정 저장','check','type="submit"','primary')}</div></form></section><section class="card pad"><h2>키보드로 사용하기</h2>${kv([['⌘ / Ctrl + K','현재 범위에서 통합 검색'],['Esc','상세 패널 또는 대화상자 닫기'],['Tab / Shift + Tab','컨트롤 사이 이동'],['그래프 방향키','이동 · 3D에서는 회전'],['그래프 + / − / 0','확대 · 축소 · 위치 초기화'],['?','용어집 열기']])}<p class="caption mt">설정은 브라우저의 localStorage에만 저장됩니다. Memex의 기억, 플러그인 환경 또는 다른 브라우저에는 영향을 주지 않습니다.</p></section></div>`;
 if(tab==='diagnostics')body=`${!ctx.bootstrap.db.available?banner(esc(ctx.bootstrap.db.error?.message||'DB 연결 불가'),'error'):banner('데이터베이스 읽기 연결이 열렸습니다. 아래 표는 테이블 존재 여부이며 각 기능의 성공·완료를 보증하지 않습니다.')}<div class="settings-layout"><section class="card"><div class="card-head"><h2>저장소 기능 확인</h2></div>${table(['기록 테이블','상태'],Object.entries(ctx.bootstrap.capabilities).map(([k,v])=>`<tr><td><code>${esc(k)}</code></td><td>${v?'<span class="tag green">조회 가능</span>':'<span class="tag">테이블 없음</span>'}</td></tr>`))}</section><section class="card pad"><h2>진단 정보 내보내기</h2><p class="caption mt">UI·코어 버전, 플랫폼, 테이블 존재 여부, 관리 작업 상태만 포함합니다. 대화, 팩트 문장, 원시 로그, 절대 경로 및 환경 변수 값은 포함하지 않습니다.</p><div class="row wrap mt">${btn('진단 JSON 다운로드','download','data-action="diagnostics-download"')}${btn('코어 진단 실행','shield',`data-command="doctor" ${!env.commands?'disabled':''}`)}</div><hr><h2>문제가 생겼을 때</h2><ul class="notice-list"><li><strong>DB가 없음</strong>데이터 경로를 확인하고 대화 동기화를 명시적으로 실행하세요.</li><li><strong>코어 모듈을 찾을 수 없음</strong>레포 루트에서 의존성을 설치하고 코어를 빌드한 뒤 서버를 다시 시작하세요.</li><li><strong>기록이 비어 있음</strong>프로젝트 범위, 날짜 및 필터를 확인하세요. 과거 데이터에 없던 계측은 재구성하지 않습니다.</li><li><strong>모델 작업 실패</strong>작업·모델 시도·관리 출력에서 실제 오류를 확인하세요. 인증 정보는 이 UI에 입력하지 않습니다.</li></ul></section></div>`;
 // 기능 레인이 레지스트리 항목에 자기 렌더 함수를 넣으면 그 함수가 탭 본문을 그린다 (C4.2).
 if(entry.render&&entry.render!==renderedBySettingsPage)body=(await entry.render(ctx,env))??body;
 return {html:header('관리','로컬 환경을 확인하고, 필요한 작업만 명시적으로 실행하세요.',btn('다시 확인','refresh','data-action="refresh-bootstrap"'),'CONTROL CENTER','/settings')+`<nav class="tabs" aria-label="관리 탭">${visibleTabs().map(x=>`<a class="tab ${tab===x.id?'active':''}" href="${esc(ctx.href('/settings',{tab:x.id}))}" data-nav>${esc(t(x.labelKey))}</a>`).join('')}</nav>`+body,mount(el){el.querySelector('#preferences-form')?.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.currentTarget);ctx.savePrefs({theme:f.get('theme'),density:f.get('density'),preferTranslatedFacts:f.has('preferTranslatedFacts'),live:f.has('live'),help:f.get('help')||'always'});ctx.toast('이 브라우저의 설정을 저장했습니다.');});
 // 언어는 폼과 분리해 즉시 확정한다 — 저장 후 화면을 다시 불러온다.
 el.querySelector('#language-select')?.addEventListener('change',event=>ctx.setLanguage?.(event.target.value));
 // 스위치는 낙관적으로 되돌리고 서버 상태가 다시 그리게 둔다 — 모달을 닫기만 해도 어긋나지 않는다.
 el.querySelector('#sync-switch')?.addEventListener('change',event=>{const wanted=event.target.checked;event.target.checked=!wanted;wanted?enableSync(ctx):disableSync(ctx);});
 el.querySelectorAll('[data-sync]').forEach(b=>b.addEventListener('click',()=>runSync(ctx,b.dataset.sync)));
 el.querySelectorAll('[data-alias]').forEach(b=>b.addEventListener('click',()=>renameDevice(ctx,b.dataset.alias,b.dataset.aliasName)));
 el.querySelector('[data-archive="export"]')?.addEventListener('click',()=>exportArchive(ctx));
 el.querySelector('[data-archive="import"]')?.addEventListener('click',()=>importArchive(ctx));
 el.querySelector('#archive-import-form')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const path=String(new FormData(event.currentTarget).get('path')||'').trim();
  if(!path)return ctx.toast('받은 파일의 절대 경로를 입력하세요.');
  try{
   const result=await postSync(ctx,{action:'archive-preview',path});
   setLastPreview({path,preview:result.preview,at:new Date().toISOString()});
   ctx.toast(result.preview.rejected.length?'검증에서 거부된 항목이 있습니다. 사유를 확인하세요.':'미리보기를 만들었습니다. 내용을 확인한 뒤 가져오세요.');
  }catch(e){setLastPreview({path,error:e.message,at:new Date().toISOString()});ctx.toast(e.message);}
  ctx.invalidate();
 });
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
/** 기기 이름(별칭). 로컬 sync/devices.json에만 쓰고, 이 기기의 이름만 세대 manifest로 나간다. */
function renameDevice(ctx,deviceId,current){
 if(!deviceId)return ctx.toast('이 기기에는 아직 동기화 ID가 없습니다. 먼저 한 번 내보내세요.');
 ctx.modal('기기 이름 지정',
  banner('이름은 이 기기의 <code>sync/config.json</code> 옆 <code>sync/devices.json</code>에 저장됩니다. <strong>이 기기의 이름만</strong> 세대 파일의 <code>meta.json</code>에 실려 다른 맥에도 보이고, 다른 기기에 붙인 이름은 이 기기에만 남습니다.','neutral')
  +kv([['기기 ID',`<code>${esc(deviceId)}</code>`]])
  +`<label class="field mt">기기 이름<input name="alias" maxlength="60" autocomplete="off" placeholder="예: 집 맥미니" value="${esc(current||'')}"><small>비우고 저장하면 이름을 지웁니다. 최대 60자.</small></label>`,
  '이름 저장',async fd=>{
   const result=await postSync(ctx,{action:'alias',deviceId,alias:String(fd.get('alias')||'').trim()});
   setLastSyncRun(lastSyncRun?{...lastSyncRun,status:result.status}:null);
   ctx.toast('기기 이름을 저장했습니다.');ctx.invalidate();
  });
}
/** 세대 파일 내보내기: 새 세대를 만들고 데이터 루트 안에 zip으로 저장한 뒤 경로를 보여준다. */
function exportArchive(ctx){
 ctx.modal('세대 파일로 내보내기',
  banner('지금 상태로 <strong>새 세대 하나</strong>를 만들고, 그 세대를 zip 파일로 <strong>데이터 루트 안에</strong> 저장합니다. 브라우저로 내려받지 않고 경로를 알려줍니다. 동기화가 꺼져 있어도 동작하며 모델을 호출하지 않습니다.','warning')
  +banner('파일에는 기억 원문이 <strong>평문 JSONL</strong>로 들어 있습니다. 본인 기기끼리만 주고받으세요.','neutral')
  +'<label class="check-row mt"><input type="checkbox" name="confirm" required> 전체 기억 상태가 이 파일에 담긴다는 것을 확인했습니다.</label>',
  '내보내기',async fd=>{
   if(!fd.has('confirm'))throw new Error('확인란을 체크하세요.');
   const result=await postSync(ctx,{action:'archive-export'});
   setLastArchive(result.archive);
   ctx.toast(`세대 파일을 만들었습니다: ${result.archive.path}`);ctx.invalidate();
  });
}
/** 미리보기에서 확인한 그 파일만 적용한다. 경로는 미리보기가 검증한 값을 그대로 쓴다. */
function importArchive(ctx){
 const staged=lastPreview;
 if(!staged?.preview?.generations?.length)return ctx.toast('먼저 파일 경로를 검증하고 미리보기를 확인하세요.');
 const p=staged.preview;
 ctx.modal('세대 파일 가져오기',
  banner('아래 미리보기에서 확인한 세대를 <strong>이 기기의 기억에 적용</strong>합니다. 세대는 하나라도 깨지면 통째로 거부되며, 충돌은 이벤트 시각으로 판정해 <strong>변경 이력에 기록</strong>됩니다. 모델을 호출하지 않습니다.','warning')
  +kv([['파일',`<code>${esc(p.source||staged.path)}</code>`],['보낸 기기',deviceName(p.deviceAlias,p.deviceId)],['적용하면',esc(`기억 +${number(p.newFacts)} / ~${number(p.updatedFacts)} / -${number(p.deletedFacts)}`)],['충돌',p.conflicts.length?esc(`${number(p.conflicts.length)}건`):'없음']])
  +'<label class="check-row mt"><input type="checkbox" name="confirm" required> 위 내용을 확인했습니다.</label>',
  '가져오기',async fd=>{
   if(!fd.has('confirm'))throw new Error('확인란을 체크하세요.');
   const result=await postSync(ctx,{action:'archive-import',path:staged.path});
   setLastSyncRun({action:'import',source:result.outcome.source,outcome:{skipped:null,error:null,result:result.outcome.result},status:result.status,at:new Date().toISOString()});
   setLastPreview(null);
   ctx.toast('세대 파일을 적용했습니다.');ctx.invalidate();
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
