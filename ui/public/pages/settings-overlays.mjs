import {esc,btn,banner,kv,options,table,number,date,duration,renderIssues} from '../ui.mjs';
import {t,tHtml} from '../i18n/index.mjs';
/**
 * 관리 › 오버레이 (#29 회수 게이트 정규식 · #30 추출 규칙, 0.7.0 · 설계 §4.3).
 *
 * 이 탭이 답하는 질문은 두 개이고, 하위 내비(`?overlay=gate|rules`)가 그 둘을 가른다:
 *   - **무엇을 다시 꺼내오는가**(회수 게이트) — 내 정규식과 단어를 내장 규칙 **위에** 얹는다.
 *   - **무엇을 저장하지 않는가**(추출 규칙) — 구조화된 제한만 얹는다. 원시 프롬프트는 편집할 수
 *     없고, 증거 기준·검증기·정밀도 게이트는 오버레이가 건드리지 못한다.
 *
 * 화면을 결정한 것 세 가지:
 *  - **실패 방향이 두 오버레이에서 반대다.** 게이트가 깨지면 내장 규칙으로 계속 가고(fail-safe)
 *    프롬프트는 정상 처리된다. 추출 규칙이 깨지면 아무것도 저장되지 않고 작업이 설정 대기로
 *    간다(fail-closed). 그래서 규칙 쪽 배너는 경고가 아니라 오류이고, 대기 작업 수가 headline이다.
 *  - **격리는 "내 규칙이 조용히 꺼진 상태"다.** 실행 상한을 넘긴 패턴은 매칭에서 빠지므로, 표에
 *    남기고 배너로 말하고 다시 시도 버튼을 준다 — 사라지게 두지 않는다.
 *  - **dry-run은 아무것도 기록하지 않는다.** 프롬프트 테스트와 영향 시뮬레이션은 모델을 부르지
 *    않고 감사·히스토리 어디에도 쓰지 않는다. 화면이 그 사실을 캡션으로 말한다.
 *
 * 탭 레지스트리는 `render(ctx, env)`를 부르고, `overlayTab()`은 서버 없이 모든 상태를 렌더할 수
 * 있도록 따로 export한다(모델 탭의 `modelTab()`과 같은 형태).
 */

const GATE_INTENTS=['memory','trace','highImpact','acknowledgement','continuation','minorCorrection'];
const LEXICONS=['ack','continue','filler'];
const SCOPES=['both','fact_text','evidence'];

/** 의도 이름은 리터럴 t() 호출로 둔다 — 런타임 조립 키는 추출 린트에 보이지 않는다. */
const intentLabel=intent=>intent==='memory'?t('overlays.gate.intent.memory')
 :intent==='trace'?t('overlays.gate.intent.trace')
 :intent==='highImpact'?t('overlays.gate.intent.highImpact')
 :intent==='acknowledgement'?t('overlays.gate.intent.acknowledgement')
 :intent==='continuation'?t('overlays.gate.intent.continuation')
 :intent==='minorCorrection'?t('overlays.gate.intent.minorCorrection')
 :intent;
const lexiconLabel=lexicon=>lexicon==='ack'?t('overlays.gate.lexicon.ack')
 :lexicon==='continue'?t('overlays.gate.lexicon.continue')
 :t('overlays.gate.lexicon.filler');
const scopeLabel=scope=>scope==='fact_text'?t('overlays.rules.scope.factText')
 :scope==='evidence'?t('overlays.rules.scope.evidence')
 :t('overlays.rules.scope.both');

const codeCell=(source,flags)=>`<code class="wrap">/${esc(source)}/${esc(flags||'')}</code>`;
/** 적용 중인 규칙의 지문. 해시가 없으면 "적용된 규칙 없음"이고 rev를 지어내지 않는다. */
const revisionTag=side=>side.hash
 ?`<span class="tag outline">${esc(t('overlays.applied',{hash:side.hash,revision:number(side.revision)}))}</span>`
 :`<span class="tag">${esc(t('overlays.notApplied'))}</span>`;

/** 0.7.0은 오버레이를 기기 간에 공유하지 않는다 (§1.7). 화면이 그 사실과 예정을 항상 말한다. */
const sharedBanner=data=>data.shared?'':banner(esc(t('overlays.notShared')),'warning');

function quarantineCard(rows,overlay){
 if(!rows.length)return '';
 return banner(esc(t('overlays.quarantine.banner',{count:number(rows.length)})),'error','warning')
  +`<section class="card pad mt" id="${overlay}-quarantine"><div class="spread"><h2>${esc(t('overlays.quarantine.title'))}</h2>
  ${btn(t('overlays.quarantine.clearAll'),'refresh',`type="button" data-quarantine-clear-all="${esc(overlay)}"`)}</div>
  ${table([esc(t('overlays.quarantine.col.id')),esc(t('overlays.quarantine.col.regex')),esc(t('overlays.quarantine.col.at')),
    esc(t('overlays.quarantine.col.input')),esc(t('overlays.quarantine.col.surface')),''],
    rows.map(row=>`<tr><td><code>${esc(row.pattern_id)}</code></td><td><code>${esc(row.source_sha8||'')}</code></td>
     <td class="nowrap">${esc(date(row.at))}</td><td>${esc(t('overlays.quarantine.elapsed',{ms:duration(row.elapsed_ms),chars:number(row.input_chars??0)}))}</td>
     <td>${esc(row.surface||t('common.unknown'))}</td>
     <td>${btn(t('overlays.quarantine.retry'),'refresh',`type="button" data-quarantine-clear="${esc(row.pattern_id)}" data-overlay="${esc(overlay)}"`)}</td></tr>`))}
  <p class="caption mt">${esc(t('overlays.quarantine.autoClear'))}</p></section>`;
}

function historyCard(side,overlay){
 const rows=side.history||[];
 return `<section class="card pad mt" id="${overlay}-history"><div class="spread"><h2>${esc(t('overlays.history.title'))}</h2>
 ${btn(t('overlays.reset.button'),'refresh',`type="button" data-overlay-reset="${esc(overlay)}" ${side.present?'':'disabled'}`)}</div>
 ${rows.length?table([esc(t('overlays.history.col.at')),esc(t('overlays.history.col.action')),esc(t('overlays.history.col.revision')),
   esc(t('overlays.history.col.hash')),esc(t('overlays.history.col.change')),''],
   rows.map(row=>`<tr><td class="nowrap">${esc(date(row.ts))}</td><td><code>${esc(row.action)}</code></td>
    <td class="nowrap">${esc(t('overlays.history.revisionRange',{from:number(row.from_revision),to:number(row.to_revision)}))}</td>
    <td><code>${esc(row.to_hash||'—')}</code></td>
    <td>${esc(historyChange(row))}</td>
    <td>${btn(t('overlays.history.rollback'),'refresh',`type="button" data-overlay-rollback="${esc(overlay)}" data-revision="${esc(row.to_revision)}"`)}</td></tr>`))
  :`<p class="caption mt">${esc(t('overlays.history.empty'))}</p>`}
 <p class="caption mt">${esc(t('overlays.history.note'))}</p></section>`;
}
/** 히스토리 항목은 메타데이터만 담는다 — 규칙 본문은 스냅숏 파일에만 있다(§1.4). */
function historyChange(row){
 const parts=[];
 if(row.added?.length)parts.push(t('overlays.history.added',{ids:row.added.join(' · ')}));
 if(row.disabled?.length)parts.push(t('overlays.history.disabled',{ids:row.disabled.join(' · ')}));
 if(row.removed?.length)parts.push(t('overlays.history.removed',{ids:row.removed.join(' · ')}));
 return parts.join(' / ')||t('overlays.history.noItems');
}

/* ── 회수 게이트 ─────────────────────────────────────────────────────────────── */

/** 카탈로그 + 오버레이를 한 표로 합친다. 내장은 남고, 꺼진 것도 남는다(§2.1의 "remove가 아니라 disable"). */
export function gatePatternRows(gate){
 const disabled=new Set(gate.user.disabled||[]);
 const quarantined=new Set((gate.quarantined||[]).map(entry=>entry.pattern_id));
 const rows=(gate.builtin.patterns||[]).map(pattern=>({...pattern,origin:'builtin',
  state:disabled.has(pattern.id)?'disabled':'active'}));
 for(const pattern of gate.user.patterns||[])rows.push({...pattern,origin:'user',
  state:quarantined.has(pattern.id)?'quarantined':disabled.has(pattern.id)?'disabled':'active'});
 // 이 코어가 모르는 id를 꺼 둔 오버레이도 그 사실이 보여야 한다(옛 빌드의 term일 수 있다).
 const known=new Set(rows.map(row=>row.id));
 for(const id of gate.user.disabled||[])if(!known.has(id))rows.push({id,intent:'—',source:'—',flags:'',origin:'builtin',state:'disabled'});
 return rows;
}
const stateTag=row=>row.state==='quarantined'?`<span class="tag red">${esc(t('overlays.gate.state.quarantined'))}</span>`
 :row.state==='disabled'?`<span class="tag">${esc(t('overlays.gate.state.disabled'))}</span>`
 :`<span class="tag green">${esc(t('overlays.gate.state.active'))}</span>`;
const originTag=row=>row.origin==='user'?`<span class="tag blue">${esc(t('overlays.gate.origin.user'))}</span>`
 :`<span class="tag outline">${esc(t('overlays.gate.origin.builtin'))}</span>`;

function patternsCard(ctx,gate){
 const filter=ctx.p.get('intent')||'';
 const rows=gatePatternRows(gate).filter(row=>!filter||row.intent===filter);
 const chip=(value,label)=>`<button class="filter-chip ${filter===value?'active':''}" data-param-key="intent" data-param-value="${esc(value)}">${esc(label)}</button>`;
 return `<section class="card pad mt" id="gate-patterns"><h2>${esc(t('overlays.gate.patterns.title'))}</h2>
 <p class="caption mt">${esc(t('overlays.gate.patterns.body'))}</p>
 <div class="filters mt">${chip('',t('overlays.gate.patterns.filterAll'))}${GATE_INTENTS.map(intent=>chip(intent,intentLabel(intent))).join('')}</div>
 ${rows.length?table([esc(t('overlays.gate.patterns.col.id')),esc(t('overlays.gate.patterns.col.intent')),esc(t('overlays.gate.patterns.col.regex')),
   esc(t('overlays.gate.patterns.col.origin')),esc(t('overlays.gate.patterns.col.note')),''],
   rows.map(row=>`<tr${row.state==='active'?'':' class="muted"'}><td><code>${esc(row.id)}</code></td>
    <td class="nowrap">${esc(row.intent==='—'?row.intent:intentLabel(row.intent))}</td>
    <td>${codeCell(row.source,row.flags)}</td>
    <td class="nowrap">${originTag(row)} ${stateTag(row)}</td>
    <td>${esc(row.note||'')}</td>
    <td class="nowrap">${row.state==='disabled'
      ?btn(t('overlays.gate.patterns.enable'),'check',`type="button" data-gate-enable="${esc(row.id)}"`)
      :btn(row.origin==='user'?t('overlays.gate.patterns.remove'):t('overlays.gate.patterns.disable'),'close',
        `type="button" data-gate-disable="${esc(row.id)}" data-origin="${esc(row.origin)}"`)}</td></tr>`))
  :`<p class="caption mt">${esc(t('overlays.gate.patterns.empty'))}</p>`}</section>`;
}

function addPatternCard(limits){
 return `<section class="card pad mt" id="gate-add"><h2>${esc(t('overlays.gate.add.title'))}</h2>
 <p class="caption mt">${esc(t('overlays.gate.add.body'))}</p>
 <form id="gate-add-form" class="stack-sm mt">
  <label class="field">${esc(t('overlays.gate.add.intent'))}<select name="intent" aria-label="${esc(t('overlays.gate.add.intent'))}">${options(GATE_INTENTS.map(intent=>[intent,intentLabel(intent)]),'memory')}</select></label>
  <label class="field">${esc(t('overlays.gate.add.source'))}<input name="source" class="input" autocomplete="off" spellcheck="false" maxlength="${esc(limits.patternSource)}" placeholder="deploy\\s*history"><small>${esc(t('overlays.gate.add.sourceHint'))}</small></label>
  <label class="field">${esc(t('overlays.gate.add.flags'))}<input name="flags" class="input" autocomplete="off" spellcheck="false" maxlength="3" placeholder="i"><small>${esc(t('overlays.gate.add.flagsHint'))}</small></label>
  <label class="field">${esc(t('overlays.gate.add.note'))}<input name="note" class="input" autocomplete="off" maxlength="${esc(limits.noteChars)}"></label>
  <div class="row wrap mt">${btn(t('overlays.gate.add.submit'),'check','type="submit"','primary')}</div>
 </form>
 <div id="gate-add-issues"></div>
 <p class="caption mt">${esc(t('overlays.gate.add.caption',{chars:number(limits.patternSource),quantifiers:number(limits.quantifiers),ms:duration(limits.matchWallMs)}))}</p></section>`;
}

function wordsCard(gate){
 const chips=(lexicon,side)=>{
  const list=(gate.user.words?.[side]?.[lexicon])||[];
  return list.length?list.map(word=>`<span class="tag ${side==='add'?'blue':''}">${esc(word)} <button class="text-link" type="button" data-word-remove="${esc(word)}" data-lexicon="${esc(lexicon)}" data-side="${esc(side)}" aria-label="${esc(t('overlays.gate.words.remove'))}">×</button></span>`).join(' ')
   :`<span class="muted">${esc(t('overlays.gate.words.none'))}</span>`;
 };
 return `<section class="card pad mt" id="gate-words"><h2>${esc(t('overlays.gate.words.title'))}</h2>
 <p class="caption mt">${esc(t('overlays.gate.words.body'))}</p>
 ${kv(LEXICONS.map(lexicon=>[lexiconLabel(lexicon),
   `<div class="row wrap">${chips(lexicon,'add')}</div>
    <div class="row wrap mt">${esc(t('overlays.gate.words.disabledLabel'))} ${chips(lexicon,'disable')}</div>
    <p class="caption mt">${esc(t('overlays.gate.words.builtin',{words:(gate.builtin.words?.[lexicon]||[]).slice(0,12).join(' · ')||t('overlays.gate.words.none')}))}</p>`]))}
 <form id="gate-words-form" class="row wrap mt">
  <select name="lexicon" aria-label="${esc(t('overlays.gate.words.lexicon'))}">${options(LEXICONS.map(lexicon=>[lexicon,lexiconLabel(lexicon)]),'ack')}</select>
  <select name="side" aria-label="${esc(t('overlays.gate.words.side'))}">${options([['add',t('overlays.gate.words.sideAdd')],['disable',t('overlays.gate.words.sideDisable')]],'add')}</select>
  <input name="word" class="input" style="max-width:220px" autocomplete="off" maxlength="32" aria-label="${esc(t('overlays.gate.words.word'))}">
  ${btn(t('overlays.gate.words.submit'),'check','type="submit"')}
 </form></section>`;
}

function testCard(){
 return `<section class="card pad mt" id="gate-test"><h2>${esc(t('overlays.gate.test.title'))}</h2>
 <p class="caption mt">${esc(t('overlays.gate.test.body'))}</p>
 <form id="gate-test-form" class="stack-sm mt">
  <label class="field">${esc(t('overlays.gate.test.prompt'))}<textarea name="prompt" maxlength="8000" spellcheck="false" placeholder="${esc(t('overlays.gate.test.placeholder'))}"></textarea></label>
  <label class="check-row"><input type="checkbox" name="compareBuiltin"> ${esc(t('overlays.gate.test.compare'))}</label>
  <div class="row wrap mt">${btn(t('overlays.gate.test.submit'),'play','type="submit"','primary')}</div>
 </form>
 <div id="gate-test-result"></div>
 <p class="caption mt">${esc(t('overlays.gate.test.caption'))}</p></section>`;
}

/** `explainRecall()`의 결과. 마운트가 이 함수로 결과 영역만 다시 그린다. */
export function testResultHtml(explanation){
 if(!explanation)return '';
 const fired=Object.entries(explanation.intents||{});
 const matcher=explanation.matcher||{};
 const rows=[
  [t('overlays.gate.test.row.decision'),`<code>${esc(explanation.decision?.action||t('common.unknown'))}</code>`],
  [t('overlays.gate.test.row.triggers'),`<code class="wrap">${esc((explanation.decision?.triggers||[]).join(' + ')||t('overlays.gate.test.noTriggers'))}</code>`],
  [t('overlays.gate.test.row.overlay'),explanation.overlay?.hash
    ?`<code>${esc(explanation.overlay.hash)}</code>`:`<span class="muted">${esc(t('overlays.notApplied'))}</span>`],
  [t('overlays.gate.test.row.matcher'),matcher.unavailable?`<span class="tag amber">${esc(t('overlays.gate.test.matcherUnavailable'))}</span>`
    :matcher.timedOut?`<span class="tag red">${esc(t('overlays.gate.test.matcherTimedOut'))}</span>`
    :esc(t('overlays.gate.test.matcherDetail',{ms:duration(matcher.elapsedMs??0)}))],
 ];
 if(explanation.builtinOnly)rows.push([t('overlays.gate.test.row.builtinOnly'),`<code>${esc(explanation.builtinOnly.action)}</code>`]);
 if(explanation.diffCause?.length)rows.push([t('overlays.gate.test.row.diffCause'),
  `<code class="wrap">${esc(explanation.diffCause.map(rule=>rule.id).join(' · '))}</code>`]);
 return `<div class="mt">${kv(rows)}
 ${table([esc(t('overlays.gate.test.col.intent')),esc(t('overlays.gate.test.col.fired')),esc(t('overlays.gate.test.col.matched'))],
   fired.map(([intent,value])=>`<tr><td class="nowrap">${esc(intentLabel(intent))}</td>
    <td>${value.fired?`<span class="tag green">${esc(t('overlays.gate.test.fired'))}</span>`:`<span class="muted">${esc(t('overlays.gate.test.notFired'))}</span>`}</td>
    <td>${(value.matched||[]).map(hit=>`<code class="wrap">${esc(hit.id)}</code>`).join(' · ')||'—'}</td></tr>`))}</div>`;
}

function gateView(ctx,data){
 const gate=data.gate;
 return `${banner(tHtml('overlays.gate.intro'),'neutral')}${sharedBanner(data)}
 ${gate.issues?.length?`<div class="card pad mt">${renderIssues(gate.issues)}</div>`:''}
 ${quarantineCard(gate.quarantined||[],'gate')}
 <section class="card pad mt" id="gate-summary"><div class="spread"><h2>${esc(t('overlays.gate.summary.title'))}</h2>${revisionTag(gate)}</div>
 ${kv([
  [t('overlays.gate.summary.builtin'),esc(t('overlays.gate.summary.builtinValue',{n:number((gate.builtin.patterns||[]).length)}))],
  [t('overlays.gate.summary.user'),esc(t('overlays.gate.summary.userValue',{added:number((gate.user.patterns||[]).length),
    disabled:number((gate.user.disabled||[]).length),quarantined:number((gate.quarantined||[]).length)}))],
  [t('overlays.gate.summary.updated'),gate.updatedAt?esc(date(gate.updatedAt)):`<span class="muted">${esc(t('overlays.never'))}</span>`],
 ])}</section>
 ${testCard()}${patternsCard(ctx,gate)}${addPatternCard(data.limits)}${wordsCard(gate)}${historyCard(gate,'gate')}`;
}

/* ── 추출 규칙 ───────────────────────────────────────────────────────────────── */

function heldJobsBanner(drift){
 const held=drift?.heldJobs||[];
 if(!held.length)return '';
 const total=held.reduce((sum,row)=>sum+Number(row.jobs||0),0);
 return banner(`<strong>${esc(t('overlays.rules.held.title'))}</strong>`
  +`<p class="mt">${esc(t('overlays.rules.held.body',{n:number(total)}))}</p>`
  +`<p class="mt">${held.map(row=>`<span class="tag amber">${esc(t('common.job.hold.'+row.reason))}</span> ${esc(t('overlays.rules.held.count',{n:number(row.jobs),at:date(row.oldestHeldAt)}))}`).join('<br>')}</p>`
  +`<p class="caption mt">${esc(t('overlays.rules.held.fix'))}</p>`,'error','warning');
}

function rulesFactsCard(rules){
 return `<section class="card pad mt" id="rules-facts"><div class="spread"><h2>${esc(t('overlays.rules.facts.title'))}</h2>${revisionTag(rules)}</div>
 ${kv([
  [t('overlays.rules.row.verifier'),esc(t('overlays.rules.verifierUnchanged'))],
  [t('overlays.rules.row.scheduling'),rules.schedulingPolicyVersion
    ?`<code>${esc(rules.schedulingPolicyVersion)}</code> <span class="caption">${esc(t('overlays.rules.row.schedulingNote'))}</span>`
    :`<span class="muted">${esc(t('common.unknown'))}</span>`],
  [t('overlays.rules.row.effective'),rules.effectivePolicyVersion
    ?`<code class="wrap">${esc(rules.effectivePolicyVersion)}</code>`:`<span class="muted">${esc(t('common.unknown'))}</span>`],
  [t('overlays.rules.row.enforcement'),(rules.enforcementPoints||[]).map(point=>`<code>${esc(point)}</code>`).join(' · ')],
  [t('overlays.rules.row.timing'),esc(t('overlays.rules.timingBody'))],
  [t('overlays.rules.row.updated'),rules.updatedAt?esc(date(rules.updatedAt)):`<span class="muted">${esc(t('overlays.never'))}</span>`],
 ])}</section>`;
}

function rulesEditorCard(rules){
 const doc=rules.doc||rules.emptyDoc||{};
 const never=doc.never_extract_patterns||[];
 const decision=doc.always_treat_as_decision_patterns||[];
 const overrides=Object.keys(doc.project_overrides||{});
 const keepRow=(pattern,field)=>`<tr><td><label class="check-row"><input type="checkbox" name="${field}" value="${esc(pattern.id)}" checked> ${esc(t('overlays.rules.keep'))}</label></td>
  <td>${codeCell(pattern.source,pattern.flags)}</td>
  ${field==='keepNever'?`<td class="nowrap">${esc(scopeLabel(pattern.scope))}</td>`:''}
  <td>${esc(pattern.note||'')}</td></tr>`;
 return `<section class="card pad mt" id="rules-editor"><h2>${esc(t('overlays.rules.editor.title'))}</h2>
 <p class="caption mt">${esc(t('overlays.rules.editor.body'))}</p>
 <form id="rules-editor-form" class="stack-sm mt" data-doc="${esc(JSON.stringify(doc))}" data-revision="${esc(rules.revision)}">
  <div class="setting-row"><div><h3>${esc(t('overlays.rules.language.title'))}</h3><p>${esc(t('overlays.rules.language.body'))}</p></div>
   <select name="preferred_language" aria-label="${esc(t('overlays.rules.language.title'))}">${options([['','—'],['ko',t('overlays.rules.language.ko')],['en',t('overlays.rules.language.en')]],doc.preferred_language||'')}</select></div>
  <label class="field">${esc(t('overlays.rules.topics.label'))}<textarea name="exclude_topics" style="min-height:90px" spellcheck="false">${esc((doc.exclude_topics||[]).join('\n'))}</textarea><small>${esc(t('overlays.rules.topics.hint'))}</small></label>
  <h3 class="mt">${esc(t('overlays.rules.never.title'))}</h3>
  <p class="caption">${esc(t('overlays.rules.never.body'))}</p>
  ${never.length?table([esc(t('overlays.rules.col.keep')),esc(t('overlays.rules.col.regex')),esc(t('overlays.rules.col.scope')),esc(t('overlays.rules.col.note'))],
    never.map(pattern=>keepRow(pattern,'keepNever')))
   :`<p class="caption">${esc(t('overlays.rules.never.empty'))}</p>`}
  <div class="row wrap mt">
   <input name="neverSource" class="input" style="max-width:280px" autocomplete="off" spellcheck="false" maxlength="200" placeholder="${esc(t('overlays.rules.never.placeholder'))}" aria-label="${esc(t('overlays.rules.never.add'))}">
   <input name="neverFlags" class="input" style="max-width:80px" autocomplete="off" maxlength="3" placeholder="i" aria-label="${esc(t('overlays.rules.col.flags'))}">
   <select name="neverScope" aria-label="${esc(t('overlays.rules.col.scope'))}">${options(SCOPES.map(scope=>[scope,scopeLabel(scope)]),'both')}</select>
   <input name="neverNote" class="input" style="max-width:200px" autocomplete="off" maxlength="200" aria-label="${esc(t('overlays.rules.col.note'))}">
  </div>
  <h3 class="mt">${esc(t('overlays.rules.decision.title'))}</h3>
  <p class="caption">${esc(t('overlays.rules.decision.body'))}</p>
  ${decision.length?table([esc(t('overlays.rules.col.keep')),esc(t('overlays.rules.col.regex')),esc(t('overlays.rules.col.note'))],
    decision.map(pattern=>keepRow(pattern,'keepDecision')))
   :`<p class="caption">${esc(t('overlays.rules.decision.empty'))}</p>`}
  <div class="row wrap mt">
   <input name="decisionSource" class="input" style="max-width:280px" autocomplete="off" spellcheck="false" maxlength="200" placeholder="${esc(t('overlays.rules.decision.placeholder'))}" aria-label="${esc(t('overlays.rules.decision.add'))}">
   <input name="decisionFlags" class="input" style="max-width:80px" autocomplete="off" maxlength="3" placeholder="i" aria-label="${esc(t('overlays.rules.col.flags'))}">
   <input name="decisionNote" class="input" style="max-width:200px" autocomplete="off" maxlength="200" aria-label="${esc(t('overlays.rules.col.note'))}">
  </div>
  <div class="row wrap mt">${btn(t('overlays.rules.editor.validate'),'shield','type="button" data-rules="validate"')}${btn(t('overlays.rules.editor.submit'),'check','type="submit"','primary')}</div>
 </form>
 <div id="rules-issues"></div>
 ${overrides.length?`<p class="caption mt">${esc(t('overlays.rules.overrides',{projects:overrides.join(' · ')}))}</p>`:''}
 <p class="caption mt">${esc(t('overlays.rules.editor.caption'))}</p></section>`;
}

function clauseCard(rules){
 const clause=rules.clause||{chars:0,text:''};
 return `<section class="card pad mt" id="rules-clause"><h2>${esc(t('overlays.rules.clause.title'))}</h2>
 <p class="caption mt">${esc(t('overlays.rules.clause.body'))}</p>
 ${clause.text?`<pre class="terminal mt">${esc(clause.text)}</pre>
  <p class="caption mt">${esc(t('overlays.rules.clause.chars',{n:number(clause.chars)}))}</p>`
  :`<p class="caption mt">${esc(t('overlays.rules.clause.empty'))}</p>`}</section>`;
}

function simulateCard(rules){
 return `<section class="card pad mt" id="rules-simulate"><h2>${esc(t('overlays.rules.simulate.title'))}</h2>
 <p class="caption mt">${esc(t('overlays.rules.simulate.body'))}</p>
 <form id="rules-simulate-form" class="row wrap mt">${btn(t('overlays.rules.simulate.submit'),'play','type="submit"')}</form>
 <div id="rules-simulate-result"></div>
 ${banner(esc(t('overlays.rules.simulate.storedUnchanged')),'neutral')}
 <p class="caption mt">${esc(t('overlays.rules.simulate.modelOnly',{topics:(rules.resolved?.excludeTopics||[]).join(' · ')||t('overlays.rules.simulate.noTopics')}))}</p>
 <p class="caption">${esc(t('overlays.rules.simulate.caption'))}</p></section>`;
}

/** 시뮬레이션 결과. 로컬에서 판정할 수 없는 항목은 숫자를 지어내지 않고 문장으로 남긴다. */
export function simulationHtml(report){
 if(!report)return '';
 if(report.available===false)return banner(esc(t('overlays.rules.simulate.unavailable',
  {reason:report.reason||t('common.unknown'),detail:report.detail||''})),'error');
 const facts=report.existingFacts||{scanned:0,wouldBeBlocked:[]};
 const exchanges=report.recentExchanges||{scanned:0,matched:[]};
 const rows=[
  ...facts.wouldBeBlocked.map(row=>({kind:t('overlays.rules.simulate.kindFact'),id:row.id,patternId:row.patternId,preview:row.preview})),
  ...exchanges.matched.map(row=>({kind:t('overlays.rules.simulate.kindExchange'),id:row.exchangeId,patternId:row.patternId,preview:row.preview})),
 ];
 return `<div class="mt">${kv([
  [t('overlays.rules.simulate.scanned'),esc(t('overlays.rules.simulate.scannedValue',{facts:number(facts.scanned),exchanges:number(exchanges.scanned)}))],
  [t('overlays.rules.simulate.blocked'),esc(t('overlays.rules.simulate.blockedValue',{n:number(rows.length)}))],
  [t('overlays.rules.simulate.matcher'),esc(t('overlays.gate.test.matcherDetail',{ms:duration(report.matcher?.elapsedMs??0)}))],
 ])}
 ${rows.length?table([esc(t('overlays.rules.simulate.col.kind')),esc(t('overlays.rules.simulate.col.item')),
   esc(t('overlays.rules.simulate.col.pattern')),esc(t('overlays.rules.simulate.col.preview'))],
   rows.map(row=>`<tr><td class="nowrap">${esc(row.kind)}</td><td><code>${esc(row.id)}</code></td>
    <td><code>${esc(row.patternId||'—')}</code></td><td>${esc(row.preview||'')}</td></tr>`))
  :`<p class="caption mt">${esc(t('overlays.rules.simulate.none'))}</p>`}</div>`;
}

function driftCard(rules){
 const drift=rules.drift||{available:false};
 return `<section class="card pad mt" id="rules-drift"><h2>${esc(t('overlays.rules.drift.title'))}</h2>
 ${drift.available
  ?(drift.staleTargets>0
    ?banner(esc(t('overlays.rules.drift.banner',{targets:number(drift.staleTargets),sessions:number(drift.staleSessions)})),'warning')
    :`<p class="caption mt">${esc(t('overlays.rules.drift.none'))}</p>`)
  :`<p class="caption mt">${esc(t('overlays.rules.drift.unavailable'))}</p>`}
 <p class="caption mt">${esc(t('overlays.rules.drift.noApply'))}</p></section>`;
}

function rulesView(ctx,data){
 const rules=data.rules;
 return `${banner(tHtml('overlays.rules.intro'),'warning')}${sharedBanner(data)}
 ${heldJobsBanner(rules.drift)}
 ${rules.issues?.length?`<div class="card pad mt">${renderIssues(rules.issues)}</div>`:''}
 ${quarantineCard(rules.quarantined||[],'rules')}
 ${rulesFactsCard(rules)}${rulesEditorCard(rules)}${clauseCard(rules)}${simulateCard(rules)}${driftCard(rules)}${historyCard(rules,'rules')}`;
}

/* ── 탭 본문 ─────────────────────────────────────────────────────────────────── */

/**
 * 관리 › 오버레이 본문. `data`는 `/api/v2/overlays`의 status 응답이다.
 * @param {object} ctx 페이지 컨텍스트
 * @param {object} env bootstrap.environment
 * @param {object|null} data status 응답
 * @param {string|null} error 조회 실패 사유
 */
export function overlayTab(ctx,env,data,error){
 if(!env.overlays)return banner(tHtml('overlays.missingCore'),'error');
 if(!data)return banner(esc(error||t('overlays.statusUnavailable')),'error');
 const view=ctx.p.get('overlay')==='rules'?'rules':'gate';
 const chip=(value,label)=>`<button class="filter-chip ${view===value?'active':''}" data-param-key="overlay" data-param-value="${esc(value)}">${esc(label)}</button>`;
 const subnav=`<div class="filters" id="overlay-subnav" role="group" aria-label="${esc(t('overlays.subnav.aria'))}">${chip('gate',t('overlays.subnav.gate'))}${chip('rules',t('overlays.subnav.rules'))}</div>`;
 const body=view==='rules'?rulesView(ctx,data):gateView(ctx,data);
 return subnav
  +(data.disabledByEnv?banner(esc(t('overlays.disabledByEnv')),'warning'):'')
  +body;
}

/** 탭 레지스트리 진입점. 조회 실패도 화면으로 설명한다 — 탭이 빈 화면으로 끝나지 않는다. */
export async function render(ctx,env){
 let data=null,error=null;
 if(env.overlays){try{data=await ctx.api('overlays');}catch(e){error=e.message;}}
 return overlayTab(ctx,env,data,error);
}

const post=(ctx,body)=>ctx.api('overlays',{},{body,timeout:120000});
const write=(ctx,body)=>post(ctx,{...body,confirm:true});
/** 422의 행별 사유는 lane-0의 renderIssues()가 그린다 — 새 오류 컴포넌트를 만들지 않는다. */
const showIssues=(el,selector,issues)=>{const slot=el.querySelector(selector);if(slot)slot.innerHTML=renderIssues(issues||[]);};

/**
 * 이벤트 배선. settings.mjs의 mount가 그대로 부르고, 이 탭이 아니면 아무것도 찾지 못해 no-op다.
 * 쓰기는 전부 `/api/v2/overlays`의 action 하나씩이고, 성공하면 화면을 다시 읽는다.
 */
export function mountOverlayTab(el,ctx){
 const guard=async(fn,slot)=>{
  try{await fn();}
  catch(e){
   if(slot&&e.issues?.length)showIssues(el,slot,e.issues);
   ctx.toast(e.message);
  }
 };
 el.querySelector('#gate-test-form')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const fd=new FormData(event.currentTarget);
  const slot=el.querySelector('#gate-test-result');
  await guard(async()=>{
   // 조회 action이므로 confirm을 붙이지 않는다 — 이 호출은 아무것도 쓰지 않는다.
   const result=await post(ctx,{overlay:'gate',action:'test',prompt:String(fd.get('prompt')||''),
     compareBuiltin:fd.has('compareBuiltin')});
   slot.innerHTML=testResultHtml(result);
  });
 });
 el.querySelector('#gate-add-form')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const fd=new FormData(event.currentTarget);
  const pattern={intent:String(fd.get('intent')||'memory'),source:String(fd.get('source')||'').trim(),
    flags:String(fd.get('flags')||'').trim()||undefined,note:String(fd.get('note')||'').trim()||undefined};
  showIssues(el,'#gate-add-issues',[]);
  await guard(async()=>{
   const result=await write(ctx,{overlay:'gate',action:'patch',patternsAdd:[pattern]});
   ctx.toast(t('overlays.toast.saved',{revision:number(result.revision)}));
   ctx.invalidate();
  },'#gate-add-issues');
 });
 el.querySelectorAll('[data-gate-disable]').forEach(button=>button.addEventListener('click',()=>{
  const id=button.dataset.gateDisable;
  const body=button.dataset.origin==='user'
   ?t('overlays.gate.disable.userBody',{id}):t('overlays.gate.disable.builtinBody',{id});
  ctx.confirm(t('overlays.gate.disable.title'),body,async()=>{
    const result=await write(ctx,{overlay:'gate',action:'patch',patternsDisable:[id]});
    ctx.toast(t('overlays.toast.saved',{revision:number(result.revision)}));
    ctx.invalidate();
   });
 }));
 el.querySelectorAll('[data-gate-enable]').forEach(button=>button.addEventListener('click',()=>guard(async()=>{
  const result=await write(ctx,{overlay:'gate',action:'patch',patternsEnable:[button.dataset.gateEnable]});
  ctx.toast(t('overlays.toast.saved',{revision:number(result.revision)}));
  ctx.invalidate();
 })));
 el.querySelector('#gate-words-form')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const fd=new FormData(event.currentTarget);
  const word=String(fd.get('word')||'').trim();
  if(!word)return ctx.toast(t('overlays.gate.words.needWord'));
  await guard(async()=>{
   const result=await write(ctx,{overlay:'gate',action:'patch',
     words:{lexicon:String(fd.get('lexicon')||'ack'),[String(fd.get('side')||'add')]:[word]}});
   ctx.toast(t('overlays.toast.saved',{revision:number(result.revision)}));
   ctx.invalidate();
  });
 });
 el.querySelectorAll('[data-word-remove]').forEach(button=>button.addEventListener('click',()=>guard(async()=>{
  const key=button.dataset.side==='add'?'removeAdd':'removeDisable';
  const result=await write(ctx,{overlay:'gate',action:'patch',
    words:{lexicon:button.dataset.lexicon,[key]:[button.dataset.wordRemove]}});
  ctx.toast(t('overlays.toast.saved',{revision:number(result.revision)}));
  ctx.invalidate();
 })));
 el.querySelectorAll('[data-quarantine-clear]').forEach(button=>button.addEventListener('click',()=>guard(async()=>{
  const result=await write(ctx,{overlay:button.dataset.overlay,action:'quarantine-clear',patternId:button.dataset.quarantineClear});
  ctx.toast(t('overlays.toast.quarantineCleared',{n:number(result.cleared??0)}));
  ctx.invalidate();
 })));
 el.querySelectorAll('[data-quarantine-clear-all]').forEach(button=>button.addEventListener('click',()=>guard(async()=>{
  const result=await write(ctx,{overlay:button.dataset.quarantineClearAll,action:'quarantine-clear',all:true});
  ctx.toast(t('overlays.toast.quarantineCleared',{n:number(result.cleared??0)}));
  ctx.invalidate();
 })));
 el.querySelectorAll('[data-overlay-rollback]').forEach(button=>button.addEventListener('click',()=>{
  const revision=Number(button.dataset.revision);
  ctx.confirm(t('overlays.history.confirm.title'),t('overlays.history.confirm.body',{revision:number(revision)}),async()=>{
   const result=await write(ctx,{overlay:button.dataset.overlayRollback,action:'rollback',revision});
   ctx.toast(t('overlays.toast.rolledBack',{revision:number(result.revision)}));
   ctx.invalidate();
  });
 }));
 el.querySelectorAll('[data-overlay-reset]').forEach(button=>button.addEventListener('click',()=>{
  ctx.confirm(t('overlays.reset.title'),t('overlays.reset.body'),async()=>{
   const result=await write(ctx,{overlay:button.dataset.overlayReset,action:'reset'});
   ctx.toast(t('overlays.toast.reset',{revision:number(result.revision)}));
   ctx.invalidate();
  });
 }));
 const rulesForm=el.querySelector('#rules-editor-form');
 if(rulesForm){
  // 편집기는 **구조화된 항목만** 다룬다 — 프롬프트 원문 필드는 이 화면에 존재하지 않는다.
  const build=()=>{
   const base=JSON.parse(rulesForm.dataset.doc||'{}');
   const fd=new FormData(rulesForm);
   const keep=(name,list)=>{const kept=new Set(fd.getAll(name).map(String));return (list||[]).filter(item=>kept.has(item.id));};
   const topics=String(fd.get('exclude_topics')||'').split('\n').map(line=>line.trim()).filter(Boolean);
   const never=keep('keepNever',base.never_extract_patterns);
   const decision=keep('keepDecision',base.always_treat_as_decision_patterns);
   const neverSource=String(fd.get('neverSource')||'').trim();
   if(neverSource)never.push({source:neverSource,flags:String(fd.get('neverFlags')||'').trim(),
     scope:String(fd.get('neverScope')||'both'),...(String(fd.get('neverNote')||'').trim()?{note:String(fd.get('neverNote')).trim()}:{})});
   const decisionSource=String(fd.get('decisionSource')||'').trim();
   if(decisionSource)decision.push({source:decisionSource,flags:String(fd.get('decisionFlags')||'').trim(),
     ...(String(fd.get('decisionNote')||'').trim()?{note:String(fd.get('decisionNote')).trim()}:{})});
   const language=String(fd.get('preferred_language')||'');
   return {...base,preferred_language:language||null,exclude_topics:topics,
     never_extract_patterns:never,always_treat_as_decision_patterns:decision};
  };
  rulesForm.addEventListener('submit',async event=>{
   event.preventDefault();
   showIssues(el,'#rules-issues',[]);
   await guard(async()=>{
    const result=await write(ctx,{overlay:'rules',action:'set',doc:build(),
      expectedRevision:Number(rulesForm.dataset.revision)});
    ctx.toast(t('overlays.toast.saved',{revision:number(result.revision)}));
    ctx.invalidate();
   },'#rules-issues');
  });
  el.querySelector('[data-rules="validate"]')?.addEventListener('click',()=>guard(async()=>{
   const result=await post(ctx,{overlay:'rules',action:'validate',doc:build()});
   showIssues(el,'#rules-issues',result.issues);
   ctx.toast(result.ok?t('overlays.toast.validated'):t('overlays.toast.invalid',{n:number((result.issues||[]).length)}));
  },'#rules-issues'));
 }
 el.querySelector('#rules-simulate-form')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const slot=el.querySelector('#rules-simulate-result');
  slot.innerHTML='';
  await guard(async()=>{
   const report=await post(ctx,{overlay:'rules',action:'simulate'});
   slot.innerHTML=simulationHtml(report);
   ctx.toast(t('overlays.toast.simulated'));
  });
 });
}
