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
function readBody(req,max=64*1024){return new Promise((resolve,reject)=>{
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return reject(new HttpError(415,'Content-Type: application/json이 필요합니다.'));
  let bytes=0;const chunks=[];let failed=false;
  req.on('data',chunk=>{bytes+=chunk.length;if(bytes>max){if(!failed){failed=true;reject(new HttpError(413,'요청 본문이 너무 큽니다.'));}return;}chunks.push(chunk);});
  req.on('end',()=>{if(failed)return;try{const b=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!b||Array.isArray(b)||typeof b!=='object')throw new Error();resolve(b);}catch{reject(new HttpError(400,'유효한 JSON 객체가 필요합니다.'));}});
  req.on('error',reject);req.on('aborted',()=>reject(new HttpError(400,'요청이 중단됐습니다.')));
});}
function createServer(options={}){
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
    let store=null,error=null,projects=[];try{store=await core.connect();projects=store.projects();}catch(e){error={message:e.message,code:e.code};}
    return {uiVersion:VERSION,csrfToken:token,environment:core.environment(),db:{available:!!store,error},capabilities:store?.capabilities()||{},projects,commands:COMMANDS,revision,serverStartedAt:startedAt};
  }
  const startedAt=new Date().toISOString();
  function guard(req,write){
    const port=server.address()?.port;const host=req.headers.host||'';
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))throw new HttpError(403,'루프백 Host만 허용됩니다.','HOST_REJECTED');
    const origin=req.headers.origin;
    if(origin&&origin!==`http://${host}`)throw new HttpError(403,'다른 출처의 요청은 허용되지 않습니다.','ORIGIN_REJECTED');
    if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'Cross-site 요청을 차단했습니다.','ORIGIN_REJECTED');
    if(write){const provided=String(req.headers['x-memex-csrf']||'');if(Buffer.byteLength(provided)!==Buffer.byteLength(token)||!crypto.timingSafeEqual(Buffer.from(provided),Buffer.from(token)))throw new HttpError(403,'세션 보안 토큰이 없습니다. 화면을 새로고침하세요.','CSRF_REJECTED');}
  }
  async function handler(req,res){
    try{
      const write=!['GET','HEAD'].includes(req.method);guard(req,write);
      let u;try{u=new URL(req.url,'http://localhost');}catch{throw new HttpError(400,'잘못된 URL입니다.');}
      const p=u.pathname,q=u.searchParams;
      if(p==='/api/v2/events'){
        if(req.method!=='GET')throw new HttpError(405,'GET만 허용됩니다.');
        if(clients.size>=24)throw new HttpError(429,'실시간 연결 수가 너무 많습니다.');
        res.writeHead(200,{...SECURITY,'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
        res.write(`id: ${revision}\nevent: connected\ndata: ${JSON.stringify({revision})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;
      }
      if(p==='/api/v2/bootstrap'){if(req.method!=='GET')throw new HttpError(405,'GET만 허용됩니다.');json(res,200,await bootstrap());return;}
      if(p==='/api/v2/health'){if(req.method!=='GET')throw new HttpError(405,'GET만 허용됩니다.');json(res,200,{ui:'connected',db:!!core.db,revision,startedAt});return;}
      if(p==='/api/v2/operations'){
        if(req.method==='GET'){json(res,200,{items:operations.list(),scope:'all'});return;}
        if(req.method!=='POST')throw new HttpError(405,'GET 또는 POST만 허용됩니다.');
        const b=await readBody(req);const result=operations.run(b);json(res,202,result);return;
      }
      if(p==='/api/v2/operation'){
        if(req.method==='GET'){json(res,200,operations.get(q.get('id')));return;}
        if(req.method!=='POST')throw new HttpError(405,'POST만 허용됩니다.');
        const b=await readBody(req);if(b.action!=='cancel')throw new HttpError(400,'cancel만 허용됩니다.');json(res,200,operations.cancel(b.id));return;
      }
      if(p==='/api/v2/environment'){if(req.method!=='GET')throw new HttpError(405,'GET만 허용됩니다.');json(res,200,core.environment());return;}
      if(p==='/api/v2/diagnostics'){
        if(req.method!=='GET')throw new HttpError(405,'GET만 허용됩니다.');
        const b=await bootstrap();const env=b.environment;
        // No raw logs, prompts, fact text, or local file paths in the export.
        const diagnostic={generated_at:new Date().toISOString(),uiVersion:VERSION,coreVersion:env.version,node:env.node,platform:env.platform,dbAvailable:b.db.available,dbErrorCode:b.db.error?.code||null,capabilities:b.capabilities,operationSummary:operations.list().map(x=>({command:x.command,status:x.status,started_at:x.started_at,finished_at:x.finished_at,exit_code:x.exit_code})),limits:['No conversations, fact text, raw logs, environment secrets, or absolute paths included.','This does not certify host/plugin connectivity.']};
        json(res,200,diagnostic,{'Content-Disposition':'attachment; filename="memex-ui-diagnostics.json"'});return;
      }
      if(p==='/api/v2/log-files'||p==='/api/v2/logs'){
        if(req.method!=='GET')throw new HttpError(405,'GET만 허용됩니다.');
        if(p.endsWith('log-files')){json(res,200,{items:logs.files()});return;}
        let store;try{store=await core.connect();}catch{}
        const scope=store?store.scope(q):Store.prototype.scope.call({has:()=>false},q);
        json(res,200,logs.read(q,scope));return;
      }
      if(p.startsWith('/api/')){
        if(p==='/api/v2/pipeline'||p==='/api/pipeline-status'){if(req.method!=='GET')throw new HttpError(405,'GET만 허용됩니다.');json(res,200,await core.pipeline());return;}
        const store=await core.connect();const s=store.scope(q);
        if(p==='/api/v2/facts/mutate'||p==='/api/facts-mutate'){
          if(req.method!=='POST')throw new HttpError(405,'POST만 허용됩니다.');
          const b=await readBody(req);if(operations.children?.size)throw new HttpError(409,'관리 명령이 실행 중입니다. 완료 후 기억을 변경하세요.','OPERATION_BUSY');let result;
          try{result=await core.mutate(b,s);try{logs.audit({action:'fact.'+b.action,status:'completed',id:b.id,project:s.project});}catch{}}
          catch(e){try{logs.audit({action:'fact.'+b.action,status:'failed',id:b.id,project:s.project,error_code:e.code||e.name});}catch{}throw e;}
          notify();json(res,200,result);return;
        }
        if(req.method!=='GET')throw new HttpError(405,'조회 API는 GET만 허용됩니다.');
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
          case '/api/v2/event':{result=store.chronicle(new URLSearchParams({id:q.get('id')||'',limit:'1'}),s).items[0];if(!result)throw new HttpError(404,'현재 범위에서 이벤트를 찾을 수 없습니다.');break;}
          case '/api/v2/jobs':result=store.jobs(q,s);break;
          case '/api/v2/job':result=store.job(q.get('id'),s);break;
          case '/api/v2/attempts':result=store.attempts(q,s);break;
          case '/api/v2/attempt':{result=store.attempts(new URLSearchParams({id:q.get('id')||'',limit:'1'}),s).items[0];if(!result)throw new HttpError(404,'현재 범위에서 모델 시도를 찾을 수 없습니다.');break;}
          case '/api/v2/recalls':result=store.recalls(q,s);break;
          case '/api/v2/log-files':result={items:logs.files()};break;
          case '/api/v2/logs':result=logs.read(q,s);break;
          case '/api/search':case '/api/user-prompts':{const r=store.exchanges(q,s);result={...r,results:r.items};break;}
          case '/api/stats':{const r=store.overview(s);result={total:r.exchanges,projects:store.projects().length,sessions:r.sessions};break;}
          case '/api/fact-provenance':{const f=store.fact(q.get('id'),s);result={fact:f,sources:f.sources,revisions:f.revisions,context_dependencies:f.context_dependencies};break;}
          default:throw new HttpError(404,'API를 찾을 수 없습니다.','NOT_FOUND');
        }
        json(res,200,result);return;
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(405,'허용되지 않는 HTTP 메서드입니다.');
      const pages=['/','/dashboard','/conversations','/facts','/taxonomy','/graph','/activity','/settings','/pipeline'];
      let file;
      if(pages.includes(p)||/^\/(?:conversations|facts)\/[^/]+$/.test(p))file=path.join(PUBLIC,'index.html');
      else if(p.startsWith('/assets/')){
        let rel;try{rel=decodeURIComponent(p.slice(8));}catch{throw new HttpError(400,'잘못된 경로입니다.');}
        if(!/^[a-zA-Z0-9_./-]+$/.test(rel)||rel.split('/').includes('..'))throw new HttpError(404,'파일을 찾을 수 없습니다.');
        file=path.resolve(PUBLIC,rel);if(!file.startsWith(PUBLIC+path.sep))throw new HttpError(404,'파일을 찾을 수 없습니다.');
      }else if(p==='/favicon.ico'){res.writeHead(204,SECURITY);res.end();return;}
      else throw new HttpError(404,'페이지를 찾을 수 없습니다.','NOT_FOUND');
      if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw new HttpError(404,'파일을 찾을 수 없습니다.');
      const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
      if(!types[ext])throw new HttpError(404,'파일을 찾을 수 없습니다.');
      const body=fs.readFileSync(file);res.writeHead(200,{...SECURITY,'Content-Type':types[ext],'Cache-Control':'no-cache','Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR',message:redact(e.message)}});else res.end();}
  }
  const server=http.createServer(handler);server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  function close(){if(closing)return;closing=true;clearInterval(interval);for(const res of clients)res.end();clients.clear();operations.close();core.close();server.close();}
  server.on('close',()=>{clearInterval(interval);});
  return {server,core,logs,operations,close,notify,token};
}
async function start(options={}){
  const raw=process.env.PORT||'3847';if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>65535)throw new Error('PORT must be 1–65535');
  const app=createServer(options);
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(Number(raw),'127.0.0.1',resolve);});
  console.log(`Memex Workspace ${VERSION}\nhttp://127.0.0.1:${app.server.address().port}\nDB: ${app.core.dbPath}\n읽기는 모델 작업을 시작하지 않습니다. 종료: Ctrl+C`);
  for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{app.close();setTimeout(()=>process.exit(0),5500).unref();});
  return app;
}
module.exports={createServer,start,readBody,VERSION};
