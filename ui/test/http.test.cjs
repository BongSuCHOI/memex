'use strict';
const {test,before,after}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs');const {fixture,FixtureCore,PROJECT,uid}=require('./fixture.cjs');const {createServer}=require('../lib/server.cjs');
let app,base,f;before(async()=>{f=fixture();app=createServer({core:new FixtureCore(f)});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;});after(()=>{app.close();fs.rmSync(f.home,{recursive:true,force:true});});
const scope='scope=project&project='+encodeURIComponent(PROJECT);
async function get(route){const r=await fetch(base+route);return {status:r.status,headers:r.headers,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};}
for(const endpoint of ['bootstrap','health','overview','projects','scopes','facts','sessions','exchanges','taxonomy','graph','chronicle','jobs','attempts','recalls','log-files','environment','diagnostics','operations','pipeline'])test('GET /api/v2/'+endpoint,async()=>{const r=await get('/api/v2/'+endpoint+'?'+scope);assert.equal(r.status,200,JSON.stringify(r.data));});
for(const [endpoint,id]of [['fact',uid(1)],['exchange','exchange-0'],['session','session-0'],['job','job-0'],['event','event-0'],['attempt','attempt-0']])test('detail endpoint /'+endpoint,async()=>assert.equal((await get('/api/v2/'+endpoint+'?'+scope+'&id='+id)).status,200));
test('all seven pages and static modules have proper MIME and CSP',async()=>{for(const route of ['/','/facts','/conversations','/taxonomy','/graph','/activity','/settings','/pipeline','/assets/app.mjs']){const r=await get(route);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert(r.headers.get('content-type').includes(route.endsWith('mjs')?'javascript':'html'));}});
test('foreign Host and Origin are rejected',async()=>{const raw=headers=>new Promise((resolve,reject)=>{http.get(base+'/api/v2/bootstrap',{headers},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(await raw({Host:'attacker.invalid'}),403);assert.equal(await raw({Origin:'https://evil.invalid'}),403);assert.equal(await raw({'Sec-Fetch-Site':'cross-site'}),403);});
test('writes require a real token and JSON',async()=>{const url=base+'/api/v2/facts/mutate?'+scope;const body=JSON.stringify({id:uid(1),action:'deactivate'});assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Memex-CSRF':app.token},body})).status,403);assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain','X-Memex-CSRF':app.token},body})).status,415);});
test('malformed and oversized JSON have distinct errors',async()=>{const url=base+'/api/v2/facts/mutate?'+scope,headers={'Content-Type':'application/json','X-Memex-CSRF':app.token};assert.equal((await fetch(url,{method:'POST',headers,body:'{' })).status,400);assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({text:'x'.repeat(70000)})})).status,413);});
test('계층 이동 API는 CSRF 토큰과 POST를 요구한다',async()=>{
 for(const action of ['promote','demote']){
  const url=base+'/api/v2/facts/'+action+'?'+scope;const body=JSON.stringify({id:uid(1),reason:'테스트'});
  const noToken=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body});
  assert.equal(noToken.status,403);assert.equal((await noToken.json()).error.code,'CSRF_REJECTED');
  const withToken=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Memex-CSRF':app.token},body});
  assert.equal(withToken.status,403);assert.equal((await withToken.json()).error.code,'FIXTURE_READ_ONLY');
  assert.equal((await get('/api/v2/facts/'+action+'?'+scope)).status,405);
 }
});
test('동기화 상태는 DB 없이도 읽히고, 변경에는 토큰과 명시적 확인이 필요하다',async()=>{
 const read=await get('/api/v2/sync');
 assert.equal(read.status,200);
 assert.equal(read.data.status.enabled,false,'기본값은 꺼짐이어야 합니다');
 assert(read.data.status.configPath.endsWith('config.json'));
 const url=base+'/api/v2/sync',headers={'Content-Type':'application/json','X-Memex-CSRF':app.token};
 const noToken=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'export',confirm:true})});
 assert.equal((await noToken.json()).error.code,'CSRF_REJECTED');
 const noConfirm=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'export'})});
 assert.equal(noConfirm.status,400);assert.equal((await noConfirm.json()).error.code,'CONFIRMATION_REQUIRED');
 const confirmed=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'export',confirm:true})});
 assert.equal((await confirmed.json()).error.code,'FIXTURE_READ_ONLY');
 assert.equal((await fetch(url,{method:'DELETE',headers})).status,405);
 // 0.6.3 (#48): 수동 세대 파일·별칭도 같은 엔드포인트의 action이고 같은 안전장치를 통과한다.
 for(const body of [{action:'archive-export'},{action:'archive-preview',path:'/tmp/x.zip'},{action:'archive-import',path:'/tmp/x.zip'},{action:'alias',deviceId:'device-aaa',alias:'집 맥미니'}]){
  const noConfirm=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await noConfirm.json()).error.code,'CONFIRMATION_REQUIRED',JSON.stringify(body));
  const res=await fetch(url,{method:'POST',headers,body:JSON.stringify({...body,confirm:true})});
  assert.equal((await res.json()).error.code,'FIXTURE_READ_ONLY',JSON.stringify(body));
 }
});
test('계층 이관 명령은 관리 명령 allowlist에 등록되어 있다',async()=>{
 const boot=(await get('/api/v2/bootstrap')).data;
 assert.deepEqual(boot.commands['tiers-preview'].args,['facts','migrate-tiers','--dry-run']);
 assert.deepEqual(boot.commands['tiers-apply'].args,['facts','migrate-tiers','--apply']);
 assert.equal(boot.commands['tiers-preview'].mutates,false);
 assert.equal(boot.commands['tiers-apply'].mutates,true);
 assert.equal(boot.commands['tiers-apply'].group,'tiers');
});
test('read APIs reject POST rather than silently mutate',async()=>assert.equal((await fetch(base+'/api/v2/facts?'+scope,{method:'POST',headers:{'X-Memex-CSRF':app.token}})).status,405));
test('unsupported management commands and missing confirmation fail',async()=>{for(const body of [{command:'shell',confirm:true,scope:'all'},{command:'constructor',confirm:true,scope:'all'},{command:'doctor',confirm:false,scope:'all'}])assert.equal((await fetch(base+'/api/v2/operations',{method:'POST',headers:{'Content-Type':'application/json','X-Memex-CSRF':app.token},body:JSON.stringify(body)})).status,400);});
test('private rows remain out of scope over HTTP',async()=>assert.equal((await get('/api/v2/fact?'+scope+'&id='+uid(73))).status,404));
test('diagnostic export excludes secrets, content and paths',async()=>{const d=(await get('/api/v2/diagnostics')).data;const txt=JSON.stringify(d);assert(!txt.includes(f.home));assert(!txt.includes('fact_kr'));assert(!txt.includes(app.token));assert(!txt.includes(PROJECT));});
test('SSE emits a connected event and change notification',async()=>{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('SSE timeout')),3000);const req=http.get(base+'/api/v2/events',r=>{let txt='';r.on('data',chunk=>{txt+=chunk.toString();if(txt.includes('event: connected')&&!txt.includes('event: change'))app.notify();if(txt.includes('event: change')){clearTimeout(timer);req.destroy();resolve();}});});req.on('error',e=>{if(e.code!=='ECONNRESET')reject(e);});});});
