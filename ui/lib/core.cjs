'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {pathToFileURL}=require('node:url');
const {Store}=require('./store.cjs');const {HttpError,text,identifier}=require('./util.cjs');
class Core {
  constructor(options={}) {
    this.root=options.root||process.env.MEMEX_PLUGIN_ROOT||process.env.PLUGIN_ROOT||path.resolve(__dirname,'../..');
    const pointedDb=options.dbPath||process.env.MEMEX_DB_PATH||process.env.TEST_DB_PATH||'';
    // 명시된 DB가 이 UI의 기록 대상(감사 로그·관리 실행 메타데이터)을 결정한다. 기본 배치에서는
    // <home>/conversation-index/db.sqlite 가 같은 home으로 되돌아오고, 임시 DB를 가리키면
    // 그 DB 옆에 기록하므로 사용자의 실제 ~/.config/memex에는 남의 DB 기록을 남기지 않는다.
    const homeForDb=file=>path.basename(path.dirname(file))==='conversation-index'?path.dirname(path.dirname(file)):path.dirname(file);
    this.home=options.home||process.env.MEMEX_HOME||(pointedDb?homeForDb(path.resolve(pointedDb)):path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'memex'));
    this.dbPath=pointedDb||path.join(this.home,'conversation-index','db.sqlite');
    this.version=null;this.db=null;this.modules=new Map();this.lastConnect=0;this.error=null;this.busy=new Set();
    try{this.version=JSON.parse(fs.readFileSync(path.join(this.root,'package.json'),'utf8')).version;}catch{}
  }
  async module(name){
    if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error('Invalid module');
    if(!this.modules.has(name)){
      const m=await import(pathToFileURL(path.join(this.root,'dist',name+'.js')).href);
      this.modules.set(name,{...(m.default&&typeof m.default==='object'?m.default:{}),...m});
    }return this.modules.get(name);
  }
  async connect(force=false){
    if(this.db){this.store.refreshSchema();return this.store;}
    if(this.connecting)return this.connecting;
    if(!force&&Date.now()-this.lastConnect<3000)throw new HttpError(503,this.error||'데이터베이스에 연결할 수 없습니다.','DB_UNAVAILABLE');
    this.lastConnect=Date.now();
    const pending=(async()=>{
      try{
        if(!fs.existsSync(this.dbPath))throw new Error('인덱스 DB가 없습니다. memex sync를 먼저 실행하세요.');
        const factory=await this.module('db');
        if(typeof factory.openReadDb!=='function')throw new Error('dist/db.js에 openReadDb가 없습니다. 코어를 빌드하세요.');
        this.db=factory.openReadDb(this.dbPath);this.store=new Store(this.db);this.error=null;return this.store;
      }catch(e){this.error=e.message;this.db=null;throw new HttpError(503,e.message,'DB_UNAVAILABLE');}
    })();
    this.connecting=pending;
    try{return await pending;}finally{if(this.connecting===pending)this.connecting=null;}
  }
  async pipeline(){
    const m=await this.module('pipeline-status');
    if(typeof m.getPipelineStatus!=='function')throw new HttpError(503,'파이프라인 상태 모듈이 없습니다.','CORE_UNAVAILABLE');
    return m.getPipelineStatus({dbPath:this.dbPath});
  }
  environment(){
    const names=['MEMEX_AUTO_ONTOLOGY','MEMEX_CODEX_MODEL','MEMEX_MODEL_BUDGET_MAX_ATTEMPTS','MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS','MEMEX_MODEL_BUDGET_MAX_OUTPUT_CHARS','MEMEX_MODEL_BUDGET_DEADLINE_MS','CODEX_HOME','MEMEX_SESSIONS_DIR'];
    return {root:this.root,home:this.home,dbPath:this.dbPath,version:this.version,node:process.version,platform:process.platform,pid:process.pid,
      values:Object.fromEntries(names.map(k=>[k,process.env[k]??null])),
      note:'이 UI 서버가 시작될 때 상속한 환경입니다. 이미 실행 중인 플러그인·훅 프로세스의 환경을 증명하지 않습니다.',
      // Mirrors src/model-budget.ts isAutomaticOntologyEnabled(): on by default
      // since 0.4.3; only an explicit non-empty value other than '1' disables it.
      autoOntology:(v=>v===undefined||v===''||v==='1')(process.env.MEMEX_AUTO_ONTOLOGY?.trim()),
      mutable:fs.existsSync(path.join(this.root,'dist','fact-management.js')),
      commands:fs.existsSync(path.join(this.root,'cli','memex.js')),
      sync:fs.existsSync(path.join(this.root,'dist','sync-control.js')),
    };
  }
  async impact(id,scope){
    const store=await this.connect();store.visibleFact(id,scope);
    const fm=await this.module('fact-management');return fm.hardDeleteImpact(this.db,id);
  }
  /**
   * Cross-device sync through dist/sync-control.js (#48).
   *
   * The core module resolves its own paths from MEMEX_HOME / MEMEX_DB_PATH, and this UI may have
   * derived a different home from an explicitly pointed DB. So the env is pinned to the home and
   * DB this server actually resolved for the duration of the call and restored afterwards — a
   * temp-DB session must never write sync state into the user's real data root. One sync call at a
   * time keeps that window from overlapping with another.
   *
   * #76 — the lock is taken BEFORE the first `await`, and the env save/restore lives inside the
   * same block. With no yield between the check and the set, a second caller cannot enter, so
   * `saved` is always the original environment and no caller releases another's lock.
   */
  async sync(action,body={}){
    if(!['status','enable','disable','export','import'].includes(action))throw new HttpError(400,'지원하지 않는 동기화 작업입니다.');
    if(this.syncBusy)throw new HttpError(409,'동기화 작업이 이미 진행 중입니다.','SYNC_BUSY');
    if(action!=='status'&&this.busy.size)throw new HttpError(409,'기억 변경이 진행 중입니다. 완료 후 실행하세요.','MUTATION_BUSY');
    this.syncBusy=true;
    const saved={MEMEX_HOME:process.env.MEMEX_HOME,MEMEX_DB_PATH:process.env.MEMEX_DB_PATH};
    process.env.MEMEX_HOME=this.home;process.env.MEMEX_DB_PATH=this.dbPath;
    try{
      const m=await this.module('sync-control');
      for(const fn of ['getSyncStatus','setSyncEnabled','runSyncExport','runSyncImport'])
        if(typeof m[fn]!=='function')throw new HttpError(503,'설치된 코어에 동기화 서비스가 없습니다. 코어를 빌드하세요.','CORE_UNAVAILABLE');
      if(action==='status')return {status:m.getSyncStatus()};
      if(action==='enable'){
        const dir=text(body.dir,4096).trim();
        if(!dir)throw new HttpError(400,'공유 폴더 경로를 입력하세요.');
        if(!path.isAbsolute(dir)||/[\x00-\x1f]/.test(dir))throw new HttpError(400,'공유 폴더는 정규화 가능한 절대 경로여야 합니다.','INVALID_SYNC_DIR');
        return {status:m.setSyncEnabled({enabled:true,dir:path.normalize(dir)})};
      }
      if(action==='disable')return {status:m.setSyncEnabled({enabled:false})};
      // 사용자가 버튼을 눌렀다면 변경이 없어도 내보낸다(force). 자동 훅만 빈 세대를 피한다.
      const outcome=action==='export'?m.runSyncExport({force:true}):await m.runSyncImport();
      return {outcome,status:m.getSyncStatus()};
    }catch(e){
      if(e.status)throw e;
      if(/not writable/.test(e.message))throw new HttpError(400,'공유 폴더에 쓸 수 없습니다. 경로와 권한을 확인하세요: '+e.message,'SYNC_DIR_UNWRITABLE');
      throw e;
    }finally{
      this.syncBusy=false;
      for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    }
  }
  /**
   * Tier ladder move through dist/fact-management.js promoteFact/demoteFact.
   * The ladder is branch ⇄ project-common ⇄ global, one rung per call: the core refuses a
   * two-rung jump for actor 'user', and this UI never sends 'user-directive'.
   *
   * #77 — the per-id lock is taken BEFORE the first `await` (the read, the version check and the
   * module loads all yield), so two clicks can no longer both pass the same version check. The
   * call also names the ONE rung the user approved (`options.to`) plus the tier and row version it
   * read (`options.expected`), so a request that loses the race is refused by the core
   * (`TierStaleError` / `TierStepError` → 409) instead of applying a second rung on top.
   */
  async tier(body,scope){
    const id=identifier(body.id);const action=body.action;
    if(!['promote','demote'].includes(action))throw new HttpError(400,'지원하지 않는 계층 이동입니다.');
    if(this.busy.has(id))throw new HttpError(409,'이 기억에 대한 변경이 이미 진행 중입니다.','MUTATION_BUSY');
    this.busy.add(id);let writer;
    try{
      const store=await this.connect();const current=store.visibleFact(id,scope);
      if(body.expectedUpdatedAt&&current.updated_at!==body.expectedUpdatedAt)throw new HttpError(409,'기억이 다른 작업에서 변경됐습니다. 새로고침한 뒤 다시 확인하세요.','STALE_FACT');
      const fm=await this.module('fact-management');
      if(typeof fm.promoteFact!=='function'||typeof fm.demoteFact!=='function')throw new HttpError(503,'설치된 코어에 계층 이동 서비스가 없습니다. 코어를 빌드하세요.','CORE_UNAVAILABLE');
      // 읽은 tier에서 한 칸만 — 목표를 코어에 명시해야 경쟁에서 져도 두 칸이 움직이지 않는다.
      const LADDER=['workstream','project','global'];
      const from=typeof fm.factTierOf==='function'
        ?fm.factTierOf({scope_type:current.scope_type,promotion_state:current.promotion_state??null}):null;
      const to=from?LADDER[LADDER.indexOf(from)+(action==='promote'?1:-1)]:undefined;
      if(from&&!to)throw new HttpError(409,'계층은 한 칸씩만 움직입니다. 글로벌로 보내려면 먼저 프로젝트 공용으로 승격하세요.','TIER_STEP');
      const factories=await this.module('db');writer=factories.openWriteDb(this.dbPath);
      const options={actor:'user',reason:text(body.reason,500)||null,projectId:scope.projectId||null,workstreamId:scope.workstreamId||null,
        ...(to?{to}:{}),expected:{...(from?{tier:from}:{}),...(current.updated_at?{updatedAt:current.updated_at}:{})}};
      return action==='promote'?fm.promoteFact(writer,id,options):fm.demoteFact(writer,id,options);
    }catch(e){
      if(e.status)throw e;
      if(e.name==='TierStaleError')throw new HttpError(409,'기억이 다른 작업에서 변경됐습니다. 새로고침한 뒤 다시 확인하세요.','STALE_FACT');
      if(e.name==='TierStepError')throw new HttpError(409,'계층은 한 칸씩만 움직입니다. 글로벌로 보내려면 먼저 프로젝트 공용으로 승격하세요.','TIER_STEP');
      if(/requires a target project/.test(e.message))throw new HttpError(400,'글로벌 기억을 강등하려면 상단에서 대상 프로젝트 범위를 먼저 선택하세요.','TIER_TARGET_REQUIRED');
      if(/requires a workstream/.test(e.message))throw new HttpError(400,'브랜치 계층으로 강등하려면 상세 조회 범위에서 작업 흐름을 먼저 선택하세요.','TIER_TARGET_REQUIRED');
      if(/requires project identity/.test(e.message))throw new HttpError(400,'이 기억에는 프로젝트 식별자가 없어 계층을 옮길 수 없습니다. CLI에서 확인하세요.','TIER_TARGET_REQUIRED');
      throw e;
    }
    finally{this.busy.delete(id);if(writer&&writer!==this.db){try{writer.close();}catch{}}}
  }
  async mutate(body,scope){
    const id=identifier(body.id);const action=body.action;
    if(!['edit','deactivate','restore','delete'].includes(action))throw new HttpError(400,'지원하지 않는 기억 변경 작업입니다.');
    if(this.busy.has(id))throw new HttpError(409,'이 기억에 대한 변경이 이미 진행 중입니다.','MUTATION_BUSY');
    const store=await this.connect();const current=store.visibleFact(id,scope);
    if(body.expectedUpdatedAt&&current.updated_at!==body.expectedUpdatedAt)throw new HttpError(409,'기억이 다른 작업에서 변경됐습니다. 새로고침한 뒤 다시 확인하세요.','STALE_FACT');
    if(body.expectedText!==undefined&&current.fact!==body.expectedText)throw new HttpError(409,'기억 내용이 변경됐습니다. 새로고침하세요.','STALE_FACT');
    if(action==='edit'&&(typeof body.text!=='string'||body.text.trim().length<4||body.text.length>20000))throw new HttpError(400,'기억 내용은 4–20,000자로 입력하세요.');
    if(action==='delete'&&(!body.confirm||body.confirmId!==id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))throw new HttpError(400,'영향을 확인한 뒤 전체 UUID를 정확히 입력하세요.','CONFIRMATION_REQUIRED');
    this.busy.add(id);let writer;
    try{
      const fm=await this.module('fact-management');const factories=await this.module('db');writer=factories.openWriteDb(this.dbPath);
      if(action==='edit'){
        if(typeof fm.mutateFactMeaning==='function')return await fm.mutateFactMeaning(writer,{
          factId:id,newText:body.text.trim(),expectedPreviousFact:current.fact,
          expectedSemanticGeneration:current.semantic_generation??undefined,expectedLifecycleGeneration:current.lifecycle_generation??undefined,
          lineageMode:'preserve-identity',reason:text(body.reason,500)||undefined,
          chronicle:{actor:'user',userStatedRationale:text(body.reason,500)||null,evidenceAuthority:'human'},
        });
        return await fm.editFact(writer,id,{text:body.text.trim(),reason:text(body.reason,500)||undefined});
      }
      if(action==='deactivate')return await fm.deactivateFactTransactional(writer,id);
      if(action==='restore')return await fm.restoreFact(writer,id);
      return await fm.hardDeleteFact(writer,id,{confirm:true});
    }catch(e){if(e.name==='StaleFactMutationError')throw new HttpError(409,e.message,'STALE_FACT');throw e;}
    finally{this.busy.delete(id);if(writer&&writer!==this.db){try{writer.close();}catch{}}}
  }
  close(){if(this.db){try{this.db.close();}catch{}this.db=null;}}
}
module.exports={Core};
