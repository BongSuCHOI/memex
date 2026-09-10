'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {Core}=require('./core.cjs');const {Store}=require('./store.cjs');const {Logs}=require('./logs.cjs');const {Operations,COMMANDS}=require('./operations.cjs');
const {HttpError,redact,hash}=require('./util.cjs');
const PUBLIC=path.resolve(__dirname,'../public');const VERSION='1.0.0';
const SECURITY={
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
};
function json(res,status,payload,headers={}){res.writeHead(status,{...SECURITY,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(payload,(k,v)=>k==='killTimer'?undefined:typeof v==='bigint'?Number(v):v));}
/** UI 표시 언어 (#109). 서버는 index.html에 기본값을 심기만 하고 API 응답은 언어로 분기하지 않는다. */
const LOCALES=['en','ko'];
/**
 * 오류 봉투 (#109 · 설계 §5.1 · §16.2 C2). 직렬화 지점은 두 곳(:유일한 catch, bootstrap)이고
 * 둘 다 이 함수를 쓴다.
 *
 * `key`는 **검증하지 않고 그대로 통과**시킨다 — 사전 조회가 없으므로 ui/lib은 ui/public에
 * 의존하지 않는다. 사전에 없는 키는 클라이언트가 키 문자열로 노출하고 console.error를 찍는다.
 * `key===null`이 "코어 원문 패스스루"의 유일한 신호다.
 */
function errorBody(e){
  const params=e&&e.params?Object.fromEntries(Object.entries(e.params).map(([k,v])=>[k,redactParam(v)])):undefined;
  const details=e?redactIssues(e.details):undefined;
  return {
    code:(e&&e.code)||'INTERNAL_ERROR',
    key:(e&&e.key)??null,
    ...(params?{params}:{}),
    message:redact((e&&e.uiMessage)??(e&&e.message)),
    ...(details?{details}:{}),
  };
}
/**
 * 보간 값 마스킹. 유한한 수·boolean·null은 **타입을 보존**한다 — 비밀을 담을 수 없고,
 * 문자열로 바꾸면 복수형 선택(tn)과 숫자 포맷이 흔들린다. 나머지는 redact()를 통과시킨다.
 */
const redactParam=v=>(typeof v==='number'&&Number.isFinite(v))||typeof v==='boolean'||v===null?v:redact(v);
const SEVERITIES=new Set(['error','warning']);
/**
 * `details`는 기능 레인이 채우는 자유 영역이므로 경계에서 모양을 고정한다 — 허용 형태는
 * `{issues:[…]}` 하나, 상한 200행, 필드 화이트리스트(row/field/path/key/params/message/severity),
 * 값마다 redact(). `path → row/field` 변환은 **하지 않는다**(생산자의 위치 표기를 보존한다).
 */
function redactIssues(details){
  const issues=Array.isArray(details&&details.issues)?details.issues:null;
  if(!issues)return undefined;
  return {issues:issues.slice(0,200).map(i=>({
    ...(Number.isInteger(i.row)?{row:i.row}:{}),
    ...(typeof i.field==='string'?{field:i.field.slice(0,80)}:{}),
    ...(typeof i.path==='string'?{path:redact(i.path).slice(0,200)}:{}),
    key:typeof i.key==='string'?i.key:null,
    ...(i.params?{params:Object.fromEntries(Object.entries(i.params).map(([k,v])=>[k,redactParam(v)]))}:{}),
    ...(typeof i.message==='string'?{message:redact(i.message)}:{}),
    ...(SEVERITIES.has(i.severity)?{severity:i.severity}:{}),
  }))};
}
/** `--lang ko` / `MEMEX_UI_LANG=ko`. 잘못된 값은 기동 실패다 — PORT 검증과 같은 방식. */
function resolveServerLocale(argv=process.argv.slice(2),env=process.env){
  const i=argv.indexOf('--lang');
  const inline=(argv.find(a=>a.startsWith('--lang='))||'').split('=')[1];
  const flag=i>=0?(argv[i+1]??''):inline;
  for(const value of [flag,env.MEMEX_UI_LANG]){
    if(value===undefined||value==='')continue;
    const tag=String(value).toLowerCase().split(/[-_]/)[0];
    if(!LOCALES.includes(tag))throw new Error(`--lang must be one of ${LOCALES.join(', ')}`);
    return tag;
  }
  return 'en';
}
/** 요청 단위 해석. index.html 치환에만 쓰고 API 응답에는 쓰지 않는다. 반환값은 항상 'en'|'ko'. */
function resolveRequestLocale(q,serverDefault){
  const asked=q&&q.get?q.get('lang'):null;
  return LOCALES.includes(asked)?asked:(LOCALES.includes(serverDefault)?serverDefault:'en');
}
const HTML_LANG_TOKEN='<html lang="en" data-lang="en"';
const HTML_META_TOKEN='<meta name="memex-ui-lang" content="en">';
/**
 * 인라인 스크립트 없이 언어를 심는다 — CSP가 `script-src 'self'`이고 완화하지 않는다.
 * `tag`는 리터럴 화이트리스트를 통과한 2글자이고 치환은 정확 일치 리터럴만 쓴다(정규식 아님).
 */
function localizeHtml(html,tag){
  if(!LOCALES.includes(tag)||tag==='en')return html;
  return html.replace(HTML_LANG_TOKEN,`<html lang="${tag}" data-lang="${tag}"`)
    .replace(HTML_META_TOKEN,`<meta name="memex-ui-lang" content="${tag}">`);
}
function readBody(req,max=64*1024){return new Promise((resolve,reject)=>{
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return reject(new HttpError(415,{code:'UNSUPPORTED_MEDIA_TYPE',key:'error.request.contentTypeJson',message:'Content-Type: application/json is required.'}));
  let bytes=0;const chunks=[];let failed=false;
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>max){if(!failed){failed=true;reject(new HttpError(413,{code:'BODY_TOO_LARGE',key:'error.request.bodyTooLarge',message:'The request body is too large.'}));}return;}chunks.push(chunk);});
  req.on('end',()=>{if(failed)return;try{const b=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!b||Array.isArray(b)||typeof b!=='object')throw new Error();resolve(b);}catch{reject(new HttpError(400,{code:'INVALID_JSON',key:'error.request.jsonObjectRequired',message:'A valid JSON object is required.'}));}});
  req.on('error',reject);req.on('aborted',()=>reject(new HttpError(400,{code:'REQUEST_ABORTED',key:'error.request.aborted',message:'The request was aborted.'})));
});}
function createServer(options={}){
  // 기본 표시 언어. options.lang으로도 넣을 수 있어 테스트가 argv를 건드리지 않는다.
  const lang=options.lang!==undefined?resolveServerLocale(['--lang',String(options.lang)],{}):resolveServerLocale();
  const core=options.core||new Core();const logs=options.logs||new Logs(core.home,core.dbPath);const clients=new Set();const token=crypto.randomBytes(32).toString('hex');let revision=0;let closing=false;
  const notify=()=>{revision++;for(const res of clients){if(!res.writableEnded&&!res.destroyed)res.write(`id: ${revision}\nevent: change\ndata: ${JSON.stringify({revision,at:new Date().toISOString()})}\n\n`);}};
  const operations=options.operations||new Operations(core,logs,{onChange:notify});
  let lastFingerprint='';
  const interval=setInterval(()=>{
    if(!clients.size)return;
    const parts=[];for(const f of [core.dbPath,core.dbPath+'-wal',path.join(core.home,'logs'),path.join(path.dirname(core.dbPath),'logs')]){try{const st=fs.statSync(f);parts.push(`${st.mtimeMs}:${st.size}`);}catch{parts.push('missing');}}
    const fingerprint=hash(parts.join('|'));
    if(lastFingerprint&&lastFingerprint!==fingerprint)notify();lastFingerprint=fingerprint;
    for(const res of clients)res.write(`: heartbeat ${Date.now()}\n\n`);
  },5000);interval.unref();
  async function bootstrap(){
    // bootstrap의 DB 오류는 HTTP 200 본문에 실린다 — 유일한 catch를 통과하지 않으므로
    // 여기서도 같은 봉투를 쓴다(설계 §5.2 · C1.5). 신규 사용자가 가장 먼저 보는 오류다.
    let store=null,error=null,projects=[],factTotals=null;try{store=await core.connect();projects=store.projects();factTotals=store.factTotals();}catch(e){error=errorBody(e);}
    return {uiVersion:VERSION,csrfToken:token,environment:core.environment(),db:{available:!!store,error},capabilities:store?.capabilities()||{},projects,factTotals,commands:COMMANDS,revision,serverStartedAt:startedAt};
  }
  const startedAt=new Date().toISOString();
  function guard(req,write){
    const port=server.address()?.port;const host=req.headers.host||'';
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))throw new HttpError(403,{code:'HOST_REJECTED',key:'error.security.loopbackHostOnly',message:'Only a loopback Host is allowed.'});
    const origin=req.headers.origin;
    if(origin&&origin!==`http://${host}`)throw new HttpError(403,{code:'ORIGIN_REJECTED',key:'error.security.originRejected',message:'Requests from another origin are not allowed.'});
    if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,{code:'ORIGIN_REJECTED',key:'error.security.crossSiteBlocked',message:'A cross-site request was blocked.'});
    if(write){const provided=String(req.headers['x-memex-csrf']||'');if(Buffer.byteLength(provided)!==Buffer.byteLength(token)||!crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(token)))throw new HttpError(403,{code:'CSRF_REJECTED',key:'error.security.csrfMissing',message:'The session security token is missing. Refresh the page.'});}
  }
  async function handler(req,res){
    try{
      const write=!['GET','HEAD'].includes(req.method);guard(req,write);
      let u;try{u=new URL(req.url,'http://localhost');}catch{throw new HttpError(400,{code:'INVALID_URL',key:'error.request.invalidUrl',message:'Invalid URL.'});}
      const p=u.pathname,q=u.searchParams;
      if(p==='/api/v2/events'){
        if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOnly',message:'Only GET is allowed.'});
        if(clients.size>=24)throw new HttpError(429,{code:'TOO_MANY_CLIENTS',key:'error.events.tooManyClients',message:'Too many live connections.'});
        res.writeHead(200,{...SECURITY,'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
        res.write(`id: ${revision}\nevent: connected\ndata: ${JSON.stringify({revision})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;
      }
      if(p==='/api/v2/bootstrap'){if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOnly',message:'Only GET is allowed.'});json(res,200,await bootstrap());return;}
      if(p==='/api/v2/health'){if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOnly',message:'Only GET is allowed.'});json(res,200,{ui:'connected',db:!!core.db,revision,startedAt});return;}
      if(p==='/api/v2/operations'){
        if(req.method==='GET'){json(res,200,{items:operations.list(),scope:'all'});return;}
        if(req.method!=='POST')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOrPostOnly',message:'Only GET or POST is allowed.'});
        const b=await readBody(req);const result=operations.run(b);json(res,202,result);return;
      }
      if(p==='/api/v2/operation'){
        if(req.method==='GET'){json(res,200,operations.get(q.get('id')));return;}
        if(req.method!=='POST')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.postOnly',message:'Only POST is allowed.'});
        const b=await readBody(req);if(b.action!=='cancel')throw new HttpError(400,{code:'INVALID_ACTION',key:'error.operation.cancelOnly',message:'Only cancel is allowed.'});json(res,200,operations.cancel(b.id));return;
      }
      if(p==='/api/v2/sync'){
        // 조회는 DB 연결과 무관하다. DB가 없어도 동기화 설정은 읽을 수 있어야 한다.
        if(req.method==='GET'){json(res,200,await core.sync('status'));return;}
        if(req.method!=='POST')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOrPostOnly',message:'Only GET or POST is allowed.'});
        const b=await readBody(req);
        if(b.confirm!==true)throw new HttpError(400,{code:'CONFIRMATION_REQUIRED',key:'error.sync.confirmRequired',message:'A sync action needs explicit confirmation.'});
        if(operations.children?.size)throw new HttpError(409,{code:'OPERATION_BUSY',key:'error.sync.blockedByOperation',message:'An admin command is running. Run this after it finishes.'});
        let result;
        try{result=await core.sync(b.action,b);try{logs.audit({action:'sync.'+b.action,status:'completed'});}catch{}}
        catch(e){try{logs.audit({action:'sync.'+String(b.action),status:'failed',error_code:e.code||e.name});}catch{}throw e;}
        notify();json(res,200,result);return;
      }
      /* #31 — 모델 선택. sync 블록 바로 뒤, `p.startsWith('/api/')`의 DB 요구 구간보다 **위**에
       * 둔다: 모델 설정은 파일과 환경 변수만으로 답할 수 있어야 하고(새 설치에 DB가 없다), 그
       * 아래는 `core.connect()`가 DB를 강제한다. 안전장치는 sync와 동일하다 — CSRF(guard),
       * 명시적 confirm, 관리 명령 실행 중 거절. 오류 문장은 코어가 만들고 번역은 클라이언트가
       * 한다(§12.2 C2): 여기서 사전을 조회하지 않는다. */
      if(p==='/api/v2/models'){
        if(req.method==='GET'){json(res,200,await core.models('status'));return;}
        if(req.method!=='POST')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'models.error.method_not_allowed',
          message:'GET or POST only'});
        const b=await readBody(req);
        if(b.confirm!==true)throw new HttpError(400,{code:'CONFIRMATION_REQUIRED',key:'models.error.confirm_required',
          message:'a model settings change needs an explicit confirm'});
        if(operations.children?.size)throw new HttpError(409,{code:'OPERATION_BUSY',key:'models.error.operation_busy',
          message:'an admin command is running'});
        let result;
        try{result=await core.models(b.action,b);try{logs.audit({action:'models.'+b.action,status:'completed'});}catch{}}
        catch(e){try{logs.audit({action:'models.'+String(b.action),status:'failed',error_code:e.code||e.name});}catch{}throw e;}
        notify();json(res,200,result);return;
      }
      /* #29/#30 — 사용자 오버레이. models 블록 바로 뒤, `p.startsWith('/api/')`의 DB 요구 구간보다
       * **위**에 둔다: 오버레이는 `<home>/overlays/*.json` 파일이므로 인덱스 데이터베이스가 없어도
       * 읽고 써야 하고(회수 게이트 규칙은 DB와 무관하게 적용된다), 그 아래는 `core.connect()`가 DB를
       * 강제한다. 안전장치는 sync·models와 같다 — CSRF(guard), 쓰기 action에 명시적 confirm, 관리
       * 명령 실행 중 거절. **읽기 action(validate·test·simulate)은 confirm을 요구하지 않고 감사 줄도
       * 남기지 않는다**: dry-run은 어떤 기록에도 쓰지 않는다는 계약이다(§1.4). */
      if(p==='/api/v2/overlays'){
        if(req.method==='GET'){json(res,200,await core.overlays('status'));return;}
        if(req.method!=='POST')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'overlays.error.methodNotAllowed',
          message:'GET or POST only'});
        const b=await readBody(req);
        const action=typeof b.action==='string'?b.action:'';
        const write=Core.OVERLAY_WRITE_ACTIONS.has(action);
        if(write&&b.confirm!==true)throw new HttpError(400,{code:'CONFIRMATION_REQUIRED',key:'overlays.error.confirmRequired',
          message:'an overlay change needs an explicit confirm'});
        if(write&&operations.children?.size)throw new HttpError(409,{code:'OPERATION_BUSY',key:'overlays.error.operationBusy',
          message:'an admin command is running'});
        let result;
        try{
          result=await core.overlays(action,b);
          if(write)try{logs.audit({action:'overlays.'+action,status:'completed'});}catch{}
        }catch(e){
          if(write)try{logs.audit({action:'overlays.'+String(action),status:'failed',error_code:e.code||e.name});}catch{}
          throw e;
        }
        if(write)notify();
        json(res,200,result);return;
      }
      if(p==='/api/v2/environment'){if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOnly',message:'Only GET is allowed.'});json(res,200,core.environment());return;}
      if(p==='/api/v2/diagnostics'){
        if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOnly',message:'Only GET is allowed.'});
        const b=await bootstrap();const env=b.environment;
        // No raw logs, prompts, fact text, or local file paths in the export.
        const diagnostic={generated_at:new Date().toISOString(),uiVersion:VERSION,coreVersion:env.version,node:env.node,platform:env.platform,dbAvailable:b.db.available,dbErrorCode:b.db.error?.code||null,capabilities:b.capabilities,operationSummary:operations.list().map(x=>({command:x.command,status:x.status,started_at:x.started_at,finished_at:x.finished_at,exit_code:x.exit_code})),limits:['No conversations, fact text, raw logs, environment secrets, or absolute paths included.','This does not certify host/plugin connectivity.']};
        json(res,200,diagnostic,{'Content-Disposition':'attachment; filename="memex-ui-diagnostics.json"'});return;
      }
      if(p==='/api/v2/log-files'||p==='/api/v2/logs'){
        if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOnly',message:'Only GET is allowed.'});
        if(p.endsWith('log-files')){json(res,200,{items:logs.files()});return;}
        let store;try{store=await core.connect();}catch{}
        const scope=store?store.scope(q):Store.prototype.scope.call({has:()=>false},q);
        json(res,200,logs.read(q,scope));return;
      }
      if(p.startsWith('/api/')){
        if(p==='/api/v2/pipeline'||p==='/api/pipeline-status'){if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.getOnly',message:'Only GET is allowed.'});json(res,200,await core.pipeline());return;}
        const store=await core.connect();const s=store.scope(q);
        if(p==='/api/v2/facts/promote'||p==='/api/v2/facts/demote'){
          if(req.method!=='POST')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.postOnly',message:'Only POST is allowed.'});
          const action=p.endsWith('promote')?'promote':'demote';
          const b=await readBody(req);if(operations.children?.size)throw new HttpError(409,{code:'OPERATION_BUSY',key:'error.fact.blockedByOperation',message:'An admin command is running. Change memories after it finishes.'});let result;
          try{result=await core.tier({...b,action},s);try{logs.audit({action:'fact.'+action,status:'completed',id:b.id,project:s.project});}catch{}}
          catch(e){try{logs.audit({action:'fact.'+action,status:'failed',id:b.id,project:s.project,error_code:e.code||e.name});}catch{}throw e;}
          notify();json(res,200,result);return;
        }
        if(p==='/api/v2/facts/mutate'||p==='/api/facts-mutate'){
          if(req.method!=='POST')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.postOnly',message:'Only POST is allowed.'});
          const b=await readBody(req);if(operations.children?.size)throw new HttpError(409,{code:'OPERATION_BUSY',key:'error.fact.blockedByOperation',message:'An admin command is running. Change memories after it finishes.'});let result;
          try{result=await core.mutate(b,s);try{logs.audit({action:'fact.'+b.action,status:'completed',id:b.id,project:s.project});}catch{}}
          catch(e){try{logs.audit({action:'fact.'+b.action,status:'failed',id:b.id,project:s.project,error_code:e.code||e.name});}catch{}throw e;}
          notify();json(res,200,result);return;
        }
        if(req.method!=='GET')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.readApiGetOnly',message:'Read APIs allow GET only.'});
        let result;
        switch(p){
          case '/api/v2/overview':result=store.overview(s);break;
          case '/api/v2/scopes':result=store.scopeOptions(s);break;
          case '/api/v2/projects':case '/api/projects':result=store.projects();break;
          case '/api/v2/facts':result=store.facts(q,s);break;
          case '/api/facts':{if(q.get('all')==='1')q.set('state','all');result=store.facts(q,s).items;break;}
          case '/api/v2/fact':case '/api/facts-detail':result=store.fact(q.get('id'),s);break;
          case '/api/v2/facts/impact':result=await core.impact(q.get('id'),s);break;
          case '/api/v2/sessions':result=store.sessions(q,s);break;
          case '/api/v2/session':result=store.session(q.get('id'),q,s);break;
          case '/api/v2/exchanges':result=store.exchanges(q,s);break;
          case '/api/v2/exchange':case '/api/exchange':result=store.exchange(q.get('id'),s);break;
          case '/api/v2/taxonomy':result=store.taxonomy(s);break;
          case '/api/v2/graph':result=store.graph(q,s);break;
          case '/api/v2/chronicle':result=store.chronicle(q,s);break;
          case '/api/v2/event':{result=store.chronicle(new URLSearchParams({id:q.get('id')||'',limit:'1'}),s).items[0];if(!result)throw new HttpError(404,{code:'NOT_FOUND',key:'error.event.notFoundInScope',message:'No event found in the current scope.'});break;}
          case '/api/v2/jobs':result=store.jobs(q,s);break;
          case '/api/v2/job':result=store.job(q.get('id'),s);break;
          case '/api/v2/attempts':result=store.attempts(q,s);break;
          case '/api/v2/attempt':{result=store.attempts(new URLSearchParams({id:q.get('id')||'',limit:'1'}),s).items[0];if(!result)throw new HttpError(404,{code:'NOT_FOUND',key:'error.attempt.notFoundInScope',message:'No model attempt found in the current scope.'});break;}
          case '/api/v2/recalls':result=store.recalls(q,s);break;
          case '/api/v2/log-files':result={items:logs.files()};break;
          case '/api/v2/logs':result=logs.read(q,s);break;
          case '/api/search':case '/api/user-prompts':{const r=store.exchanges(q,s);result={...r,results:r.items};break;}
          case '/api/stats':{const r=store.overview(s);result={total:r.exchanges,projects:store.projects().length,sessions:r.sessions};break;}
          case '/api/fact-provenance':{const f=store.fact(q.get('id'),s);result={fact:f,sources:f.sources,revisions:f.revisions,context_dependencies:f.context_dependencies};break;}
          default:throw new HttpError(404,{code:'NOT_FOUND',key:'error.route.apiNotFound',message:'API not found.'});
        }
        json(res,200,result);return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(405,{code:'METHOD_NOT_ALLOWED',key:'error.method.notAllowed',message:'That HTTP method is not allowed.'});
      const pages=['/','/dashboard','/conversations','/facts','/taxonomy','/graph','/activity','/settings','/pipeline'];
      let file;
      if(pages.includes(p)||/^\/(?:conversations|facts)\/[^/]+$/.test(p))file=path.join(PUBLIC,'index.html');
      else if(p.startsWith('/assets/')){
        let rel;try{rel=decodeURIComponent(p.slice(8));}catch{throw new HttpError(400,{code:'INVALID_PATH',key:'error.asset.invalidPath',message:'Invalid path.'});}
        if(!/^[a-zA-Z0-9_./-]+$/.test(rel)||rel.split('/').includes('..'))throw new HttpError(404,{code:'NOT_FOUND',key:'error.asset.fileNotFound',message:'File not found.'});
        file=path.resolve(PUBLIC,rel);if(!file.startsWith(PUBLIC+path.sep))throw new HttpError(404,{code:'NOT_FOUND',key:'error.asset.fileNotFound',message:'File not found.'});
      }else if(p==='/favicon.ico'){res.writeHead(204,SECURITY);res.end();return;}
      else throw new HttpError(404,{code:'NOT_FOUND',key:'error.route.pageNotFound',message:'Page not found.'});
      if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw new HttpError(404,{code:'NOT_FOUND',key:'error.asset.fileNotFound',message:'File not found.'});
      const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
      if(!types[ext])throw new HttpError(404,{code:'NOT_FOUND',key:'error.asset.fileNotFound',message:'File not found.'});
      // HTML만 언어 토큰 2개를 치환한다. Content-Length는 치환 후 바이트 길이로 다시 센다.
      const body=ext==='.html'
        ?Buffer.from(localizeHtml(fs.readFileSync(file,'utf8'),resolveRequestLocale(q,lang)),'utf8')
        :fs.readFileSync(file);
      res.writeHead(200,{...SECURITY,'Content-Type':types[ext],'Cache-Control':'no-cache','Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:errorBody(e)});else res.end();}
  }
  const server=http.createServer(handler);server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  function close(){if(closing)return;closing=true;clearInterval(interval);for(const res of clients)res.end();clients.clear();operations.close();core.close();server.close();}
  server.on('close',()=>{clearInterval(interval);});
  return {server,core,logs,operations,close,notify,token,lang};
}
async function start(options={}){
  const raw=process.env.PORT||'3847';if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>65535)throw new Error('PORT must be 1–65535');
  const app=createServer(options);
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(Number(raw),'127.0.0.1',resolve);});
  // 기동 배너는 en 고정이다 — 서버는 사전을 읽지 않고(C3.8), 이 줄은 터미널 전용이다.
  console.log(`Memex Workspace ${VERSION}\nhttp://127.0.0.1:${app.server.address().port}\nDB: ${app.core.dbPath}\nLanguage: ${app.lang}\nReading never starts model work. Stop with Ctrl+C.`);
  for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{app.close();setTimeout(()=>process.exit(0),5500).unref();});
  return app;
}
module.exports={createServer,start,readBody,VERSION,LOCALES,errorBody,redactIssues,resolveServerLocale,resolveRequestLocale,localizeHtml};
