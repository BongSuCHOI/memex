'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const {HttpError,integer,redact}=require('./util.cjs');
const COMMANDS={
  doctor:{label:'설치·런타임 진단',args:['doctor'],model:false,mutates:false},
  status:{label:'파이프라인 상태 확인',args:['status'],model:false,mutates:false},
  sync:{label:'대화 동기화',args:['sync'],model:false,mutates:true},
  extract:{label:'기억 추출 백필',args:['backfill','extract'],model:true,mutates:true},
  ontology:{label:'온톨로지 분류 백필',args:['backfill','ontology'],model:true,mutates:true},
  embeddings:{label:'임베딩 백필',args:['backfill','embeddings'],model:false,mutates:true},
  all:{label:'전체 백필',args:['backfill','all'],model:true,mutates:true},
};
class Operations {
  constructor(core,logs,options={}){
    this.core=core;this.logs=logs;this.children=new Map();this.entries=[];this.onChange=options.onChange||(()=>{});this.spawn=options.spawn||spawn;
    this.file=path.join(core.home,'ui','operations.json');
    try{const previous=JSON.parse(fs.readFileSync(this.file,'utf8'));if(Array.isArray(previous))this.entries=previous.slice(0,100).map(x=>({...x,status:['running','cancelling'].includes(x.status)?'unknown':x.status,output:'이전 서버 실행의 출력은 보존하지 않습니다.',outputLost:true}));}catch{}
  }
  list(){return this.entries.map(({output,killTimer,...e})=>({...e,outputBytes:Buffer.byteLength(output||'')}));}
  get(id){const e=this.entries.find(x=>x.id===id);if(!e)throw new HttpError(404,'실행 내역을 찾을 수 없습니다.');return e;}
  persist(){
    const dir=path.dirname(this.file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    if(fs.existsSync(this.file)&&fs.lstatSync(this.file).isSymbolicLink())throw new Error('Refusing operations symlink');
    const tmp=this.file+'.'+process.pid+'.tmp';const entries=this.entries.slice(0,100).map(({output,killTimer,...e})=>e);
    fs.writeFileSync(tmp,JSON.stringify(entries,null,2),{mode:0o600});fs.renameSync(tmp,this.file);
  }
  changed(){try{this.persist();}catch(e){console.error('[memex-ui] operation metadata:',e.message);}this.onChange();}
  run(body){
    const command=Object.hasOwn(COMMANDS,body.command)?COMMANDS[body.command]:null;if(!command)throw new HttpError(400,'허용되지 않은 명령입니다.','INVALID_COMMAND');
    if(body.confirm!==true||body.scope!=='all')throw new HttpError(400,'CLI 작업은 전체 데이터에 적용됩니다. 전체 범위와 실행을 확인하세요.','CONFIRMATION_REQUIRED');
    if(this.children.size)throw new HttpError(409,'다른 관리 작업이 실행 중입니다. 완료 또는 중단 후 다시 실행하세요.','OPERATION_BUSY');
    if(this.core.busy?.size)throw new HttpError(409,'기억 변경이 진행 중입니다. 완료 후 실행하세요.','MUTATION_BUSY');
    const cli=path.join(this.core.root,'cli','memex.js');if(!fs.existsSync(cli))throw new HttpError(503,'코어 CLI가 없습니다. 소스 레포에 적용한 뒤 실행하세요.','CORE_UNAVAILABLE');
    const maxAttempts=integer(body.maxAttempts,12,1,1000);const timeoutSeconds=integer(body.timeoutSeconds,600,10,7200);
    const id=crypto.randomUUID();const entry={id,command:body.command,label:command.label,status:'running',started_at:new Date().toISOString(),finished_at:null,exit_code:null,signal:null,maxAttempts:command.model?maxAttempts:null,timeoutSeconds,scope:'all',output:'',truncated:false};
    const env={...process.env,MEMEX_PLUGIN_ROOT:this.core.root,PLUGIN_ROOT:this.core.root,MEMEX_HOME:this.core.home,MEMEX_DB_PATH:this.core.dbPath,NO_COLOR:'1',FORCE_COLOR:'0'};
    if(command.model)Object.assign(env,{MEMEX_MODEL_BUDGET_MAX_ATTEMPTS:String(maxAttempts),MEMEX_MODEL_BUDGET_DEADLINE_MS:String(timeoutSeconds*1000)});
    this.entries.unshift(entry);this.entries=this.entries.slice(0,100);this.changed();
    const child=this.spawn(process.execPath,[cli,...command.args],{cwd:this.core.root,env,stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32'});
    this.children.set(id,child);
    const append=(chunk)=>{entry.output+=redact(chunk.toString('utf8'));if(Buffer.byteLength(entry.output)>1024*1024){entry.output=entry.output.slice(-500000);entry.truncated=true;}this.onChange();};
    child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
    child.stdout?.on('data',append);child.stderr?.on('data',append);
    const timer=setTimeout(()=>{entry.timedOut=true;this.cancel(id);},timeoutSeconds*1000);timer.unref();
    child.on('error',e=>{append(e.message);entry.spawnError=true;});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);if(entry.killTimer)clearTimeout(entry.killTimer);delete entry.killTimer;
      entry.status=entry.timedOut?'timed-out':entry.cancelRequested?'cancelled':code===0?'completed':'failed';entry.exit_code=code;entry.signal=signal;entry.finished_at=new Date().toISOString();this.children.delete(id);this.changed();
      try{this.logs.audit({action:'operation.finished',status:entry.status,id,operation:body.command});}catch{}
    });
    try{this.logs.audit({action:'operation.started',status:'running',id,operation:body.command});}catch{}
    return {...entry,output:undefined};
  }
  signal(child,signal){try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch(e){if(e.code!=='ESRCH')console.error(e.message);}}
  cancel(id){
    const child=this.children.get(id);const e=this.get(id);if(!child)return {...e,output:undefined};
    if(e.cancelRequested)return {...e,killTimer:undefined,output:undefined};
    e.cancelRequested=true;e.status='cancelling';this.signal(child,'SIGTERM');
    e.killTimer=setTimeout(()=>{if(this.children.has(id))this.signal(child,'SIGKILL');},5000);e.killTimer.unref();
    // Timers are deliberately not persisted or serialized.
    this.onChange();return {id,status:e.status};
  }
  close(){for(const id of this.children.keys())this.cancel(id);}
}
module.exports={Operations,COMMANDS};
