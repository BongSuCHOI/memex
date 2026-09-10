'use strict';
const fs=require('node:fs');const path=require('node:path');const {HttpError,redact,parseJSON,text,integer}=require('./util.cjs');
class Logs {
  constructor(home,dbPath){this.home=home;this.roots=[{key:'home',path:path.join(home,'logs')},{key:'index',path:path.join(path.dirname(dbPath),'logs')}].filter((r,i,all)=>all.findIndex(x=>x.path===r.path)===i);}
  files(){
    const files=[];
    for(const root of this.roots){
      if(!fs.existsSync(root.path))continue;
      const realRoot=fs.realpathSync(root.path);
      for(const entry of fs.readdirSync(root.path,{withFileTypes:true}).slice(0,500)){
        if(!entry.isFile()||!/^[-a-zA-Z0-9_.]+\.(?:log|jsonl)(?:\.old|\.\d+)?$/.test(entry.name))continue;
        const full=path.join(root.path,entry.name);
        try{const real=fs.realpathSync(full);if(path.dirname(real)!==realRoot)continue;const st=fs.statSync(real);files.push({id:root.key+':'+entry.name,name:entry.name,group:root.key,bytes:st.size,modified_at:st.mtime.toISOString()});}catch{}
      }
    }return files.sort((a,b)=>b.modified_at.localeCompare(a.modified_at)).slice(0,100);
  }
  resolve(id){const item=this.files().find(f=>f.id===id);if(!item)throw new HttpError(404,{code:'NOT_FOUND',key:'error.log.fileNotFound',message:'Log file not found.'});return path.join(this.roots.find(r=>r.key===item.group).path,item.name);}
  read(q,s){
    const id=text(q.get('file'),200);const limit=integer(q.get('limit'),150,1,500);const maxBytes=512*1024;
    if(!id)return {available:false,items:[],total:null,reasonKey:'state.log.selectFileFirst'};
    const filename=this.resolve(id);const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    let content,size,start;
    try{const stat=fs.fstatSync(fd);if(!stat.isFile())throw new HttpError(400,{code:'INVALID_FILE',key:'error.log.notRegularFile',message:'Not a regular file.'});size=stat.size;start=Math.max(0,size-maxBytes);const buffer=Buffer.alloc(Math.min(size,maxBytes));const bytes=fs.readSync(fd,buffer,0,buffer.length,start);content=buffer.subarray(0,bytes).toString('utf8');}finally{fs.closeSync(fd);}
    let lines=content.split('\n');if(start>0)lines.shift();if(!content.endsWith('\n'))lines.pop();
    let hidden=0;const items=[];const search=text(q.get('q')).toLowerCase();const level=q.get('level');
    for(let i=lines.length-1;i>=0;i--){
      if(!lines[i].trim())continue;const raw=redact(lines[i]);const parsed=parseJSON(raw);const data=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;
      // Unscoped logs are visible only in explicitly selected all-projects mode.
      if(s.type!=='all'&&(s.type==='global'||s.workspaceId||s.workstreamId||!data?.project||data.project!==s.project)){hidden++;continue;}
      const status=String(data?.level||data?.status||data?.state||(data?.error?'error':'info'));
      if(level==='error'&&!/error|fail|dead|retry/i.test(status)&&!data?.error)continue;
      if(search&&!raw.toLowerCase().includes(search))continue;
      const ts=data?.ts||data?.timestamp||data?.created_at||data?.time||null;
      if(q.get('from')&&ts&&ts<q.get('from'))continue;
      if(q.get('to')&&ts&&ts>q.get('to')+'T23:59:59.999Z')continue;
      items.push({id:`${id}:${size}:${i}`,timestamp:ts,status,data,raw});if(items.length>=limit)break;
    }
    return {available:true,items,total:null,limit,file:id,bytesRead:Math.min(size,maxBytes),fileBytes:size,truncated:start>0||items.length>=limit,hiddenForScope:hidden,
      noticeKey:'note.log.tailOnlyRedaction'};
  }
  audit(event){
    const dir=path.join(this.home,'logs');fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'ui-audit.jsonl');
    const st=fs.existsSync(file)?fs.lstatSync(file):null;if(st?.isSymbolicLink())throw new Error('Refusing audit log symlink');
    if(st&&st.size>1024*1024){try{fs.renameSync(file,file+'.old');}catch{}}
    // Metadata only: never persist conversation text, fact text, prompts, or child stdout.
    const safe={ts:new Date().toISOString(),source:'memex-ui',action:event.action,status:event.status,id:event.id||null,project:event.project||null,operation:event.operation||null,error_code:event.error_code||null};
    fs.appendFileSync(file,JSON.stringify(safe)+'\n',{mode:0o600});
  }
}
module.exports={Logs};
