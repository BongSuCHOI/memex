'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const {HttpError,integer,redact}=require('./util.cjs');
/**
 * 관리 명령 allowlist (#109 · 설계 §5.4).
 *
 * 라벨·설명은 **프로즈가 아니라 사전 키**다. 0.6.x는 `entry.label`에 한국어 라벨을
 * `~/.memex/ui/operations.json`에 최대 100건 **영속화**했고, 그 이력은 en 화면에서도 한국어로
 * 남았다. 이제 저장하는 것은 `entry.command`(= 이 객체의 키)뿐이고 화면이
 * `t('op.'+command+'.label')`로 렌더한다 — 읽는 시점의 언어가 적용된다.
 * 레거시 항목에는 `label`이 남아 있으므로 **사전 우선, 없으면 저장된 label**이다.
 */
const COMMANDS={
  doctor:{labelKey:'op.doctor.label',args:['doctor'],model:false,mutates:false},
  status:{labelKey:'op.status.label',args:['status'],model:false,mutates:false},
  sync:{labelKey:'op.sync.label',args:['sync'],model:false,mutates:true},
  extract:{labelKey:'op.extract.label',args:['backfill','extract'],model:true,mutates:true},
  ontology:{labelKey:'op.ontology.label',args:['backfill','ontology'],model:true,mutates:true},
  embeddings:{labelKey:'op.embeddings.label',args:['backfill','embeddings'],model:false,mutates:true},
  all:{labelKey:'op.all.label',args:['backfill','all'],model:true,mutates:true},
  recover:{labelKey:'op.recover.label',args:['recover','--all-dead'],model:false,mutates:true,noteKey:'op.recover.note'},
  // group: rendered by a dedicated card instead of the generic admin-actions grid.
  'tiers-preview':{labelKey:'op.tiers-preview.label',args:['facts','migrate-tiers','--dry-run'],model:false,mutates:false,group:'tiers',noteKey:'op.tiers-preview.note'},
  'tiers-apply':{labelKey:'op.tiers-apply.label',args:['facts','migrate-tiers','--apply'],model:false,mutates:true,group:'tiers',noteKey:'op.tiers-apply.note'},
};
class Operations {
  constructor(core,logs,options={}){
    this.core=core;this.logs=logs;this.children=new Map();this.entries=[];this.onChange=options.onChange||(()=>{});this.spawn=options.spawn||spawn;
    this.file=path.join(core.home,'ui','operations.json');
    try{const previous=JSON.parse(fs.readFileSync(this.file,'utf8'));if(Array.isArray(previous))this.entries=previous.slice(0,100).map(x=>({...x,status:['running','cancelling'].includes(x.status)?'unknown':x.status,output:'',outputLost:true}));}catch{}
  }
  list(){return this.entries.map(({output,killTimer,...e})=>({...e,outputBytes:Buffer.byteLength(output||'')}));}
  get(id){const e=this.entries.find(x=>x.id===id);if(!e)throw new HttpError(404,{code:'NOT_FOUND',key:'error.operation.notFound',message:'Run history entry not found.'});return e;}
  persist(){
    const dir=path.dirname(this.file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    if(fs.existsSync(this.file)&&fs.lstatSync(this.file).isSymbolicLink())throw new Error('Refusing operations symlink');
    const tmp=this.file+'.'+process.pid+'.tmp';const entries=this.entries.slice(0,100).map(({output,killTimer,...e})=>e);
    fs.writeFileSync(tmp,JSON.stringify(entries,null,2),{mode:0o600});fs.renameSync(tmp,this.file);
  }
  changed(){try{this.persist();}catch(e){console.error('[memex-ui] operation metadata:',e.message);}this.onChange();}
  run(body){
    const command=Object.hasOwn(COMMANDS,body.command)?COMMANDS[body.command]:null;if(!command)throw new HttpError(400,{code:'INVALID_COMMAND',key:'error.operation.commandNotAllowed',message:'That command is not allowed.'});
    if(body.confirm!==true||body.scope!=='all')throw new HttpError(400,{code:'CONFIRMATION_REQUIRED',key:'error.operation.confirmRequired',message:'CLI actions apply to all data. Confirm the full scope and the run.'});
    if(this.children.size)throw new HttpError(409,{code:'OPERATION_BUSY',key:'error.operation.busy',message:'Another admin action is running. Let it finish or stop it, then run again.'});
    if(this.core.busy?.size)throw new HttpError(409,{code:'MUTATION_BUSY',key:'error.operation.blockedByMutation',message:'A memory change is in progress. Run this after it finishes.'});
    const cli=path.join(this.core.root,'cli','memex.js');if(!fs.existsSync(cli))throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'error.core.cliMissing',message:'The core CLI is missing. Apply Memex to the source repository, then run it.'});
    const maxAttempts=integer(body.maxAttempts,12,1,1000);const timeoutSeconds=integer(body.timeoutSeconds,600,10,7200);
    const id=crypto.randomUUID();const entry={id,command:body.command,status:'running',started_at:new Date().toISOString(),finished_at:null,exit_code:null,signal:null,maxAttempts:command.model?maxAttempts:null,timeoutSeconds,scope:'all',output:'',truncated:false};
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
