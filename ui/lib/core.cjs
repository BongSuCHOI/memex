'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {pathToFileURL}=require('node:url');
const {Store}=require('./store.cjs');const {HttpError,text,identifier}=require('./util.cjs');
/** `/api/v2/sync` 본문의 action. 0.6.3에서 수동 세대 파일과 기기 별칭이 추가됐다 (#48). */
const SYNC_ACTIONS=['status','enable','disable','export','import','archive-export','archive-preview','archive-import','alias'];
const ARCHIVE_SERVICES=['exportGenerationArchive','previewImportArchive','importArchive','setDeviceAlias'];
/** 기억 본문 길이 한도. 문구에 보간되므로 상수로 둔다 — 0.6.x는 검사와 문장에 각각 박혀 있었다. */
const FACT_TEXT_MIN=4,FACT_TEXT_MAX=20000;
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
    this.version=null;this.db=null;this.modules=new Map();this.lastConnect=0;this.error=null;this.errorInfo=null;this.busy=new Set();
    // pinned() 중첩 깊이와 가장 바깥 호출이 저장한 환경 (#96).
    this.pinDepth=0;this.pinSaved=null;
    try{this.version=JSON.parse(fs.readFileSync(path.join(this.root,'package.json'),'utf8')).version;}catch{}
  }
  async module(name){
    if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error('Invalid module');
    if(!this.modules.has(name)){
      const m=await import(pathToFileURL(path.join(this.root,'dist',name+'.js')).href);
      this.modules.set(name,{...(m.default&&typeof m.default==='object'?m.default:{}),...m});
    }return this.modules.get(name);
  }
  /**
   * 오류 캐시는 **메시지 문자열이 아니라 오류 레코드**다 (#109 · 설계 §5.5).
   * 3초 스로틀 재throw가 code·key·params·message를 전부 복원해야 하고, 이미 분류된
   * HttpError는 재포장하지 않아야 DB_INDEX_MISSING / CORE_UNAVAILABLE 구분이 살아남는다.
   */
  async connect(force=false){
    if(this.db){this.store.refreshSchema();return this.store;}
    if(this.connecting)return this.connecting;
    if(!force&&Date.now()-this.lastConnect<3000)throw new HttpError(503,this.errorInfo??{code:'DB_UNAVAILABLE',key:'error.db.connectFailed',message:'Cannot connect to the local database.'});
    this.lastConnect=Date.now();
    const pending=(async()=>{
      try{
        if(!fs.existsSync(this.dbPath))throw new HttpError(503,{code:'DB_INDEX_MISSING',key:'error.db.indexMissing',message:'Index database is missing. Run `memex sync` first.'});
        const factory=await this.module('db');
        if(typeof factory.openReadDb!=='function')throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'error.core.openReadDbMissing',message:'dist/db.js has no openReadDb. Build the core.'});
        this.db=factory.openReadDb(this.dbPath);this.store=new Store(this.db);this.error=null;this.errorInfo=null;return this.store;
      }catch(e){
        // 코어·런타임 원문만 key:null로 감싼다 — 그 문장이 유일한 진단 정보다.
        const wrapped=e instanceof HttpError?e:new HttpError(503,{code:'DB_UNAVAILABLE',key:null,message:e.message});
        this.errorInfo={code:wrapped.code,key:wrapped.key,params:wrapped.params,message:wrapped.uiMessage};
        this.error=wrapped.uiMessage;this.db=null;throw wrapped;
      }
    })();
    this.connecting=pending;
    try{return await pending;}finally{if(this.connecting===pending)this.connecting=null;}
  }
  async pipeline(){
    const m=await this.module('pipeline-status');
    if(typeof m.getPipelineStatus!=='function')throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'error.core.pipelineModuleMissing',message:'The pipeline status module is missing.'});
    const status=await m.getPipelineStatus({dbPath:this.dbPath});
    // `pipeline-status`의 `attention`은 보류 중 `model_config_rejected` 하나만 센다(#31). 개요의
    // "확인이 필요한 작업" 카드는 세 사유를 모두 세야 하므로, 모델·오버레이 탭이 이미 쓰는 같은
    // 집계를 그대로 덧붙인다 — 숫자를 새로 만들지 않는다.
    return {...status,heldJobs:await this.heldJobs()};
  }
  /** 사유별 보류 작업 수. `model-budget`의 HOLD 집계를 그대로 읽는다(지어내지 않는다). */
  async heldJobs(){
    if(!fs.existsSync(this.dbPath))return [];
    let db=this.db,owned=false;
    try{
      if(!db){const factories=await this.module('db');db=factories.openReadDb(this.dbPath);owned=true;}
      const budget=await this.module('model-budget');
      if(typeof budget.heldJobSummary!=='function')return [];
      return budget.heldJobSummary(db);
    }catch{return [];}
    finally{if(owned&&db){try{db.close();}catch{}}}
  }
  environment(){
    // #31: MEMEX_CODEX_REASONING·MEMEX_EMBEDDING_* 는 모델 탭이 "환경 변수로 고정됨"을 말할 때
    // 근거로 쓰는 값이므로 런타임 탭의 표에도 그대로 보여야 한다.
    const names=['MEMEX_AUTO_ONTOLOGY','MEMEX_CODEX_MODEL','MEMEX_CODEX_REASONING','MEMEX_MODEL_BUDGET_MAX_ATTEMPTS','MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS','MEMEX_MODEL_BUDGET_MAX_OUTPUT_CHARS','MEMEX_MODEL_BUDGET_DEADLINE_MS','MEMEX_EMBEDDING_MODEL','MEMEX_EMBEDDING_DIMS','MEMEX_MODEL_CACHE_DIR','CODEX_HOME','MEMEX_SESSIONS_DIR'];
    return {root:this.root,home:this.home,dbPath:this.dbPath,version:this.version,node:process.version,platform:process.platform,pid:process.pid,
      values:Object.fromEntries(names.map(k=>[k,process.env[k]??null])),
      noteKey:'note.environment.inherited',
      // Mirrors src/model-budget.ts isAutomaticOntologyEnabled(): on by default
      // since 0.4.3; only an explicit non-empty value other than '1' disables it.
      autoOntology:(v=>v===undefined||v===''||v==='1')(process.env.MEMEX_AUTO_ONTOLOGY?.trim()),
      mutable:fs.existsSync(path.join(this.root,'dist','fact-management.js')),
      commands:fs.existsSync(path.join(this.root,'cli','memex.js')),
      sync:fs.existsSync(path.join(this.root,'dist','sync-control.js')),
      // #31 — 모델 탭의 capability. `sync:` 선례와 같은 등급이고, 없으면 탭이 배너로 degrade한다.
      models:fs.existsSync(path.join(this.root,'dist','model-settings.js')),
      // #29/#30 — 오버레이 탭의 capability. 쓰기 모듈이 기준이다: 읽기만 되는 설치에서 "추가"
      // 버튼을 내보내면 그 버튼이 503으로만 끝난다.
      overlays:fs.existsSync(path.join(this.root,'dist','overlay-admin.js')),
    };
  }
  async impact(id,scope){
    const store=await this.connect();store.visibleFact(id,scope);
    const fm=await this.module('fact-management');return fm.hardDeleteImpact(this.db,id);
  }
  /**
   * 코어 호출 동안 MEMEX_HOME / MEMEX_DB_PATH를 이 서버가 해석한 값으로 고정한다 (#78).
   *
   * 코어 모듈은 자기 경로를 환경에서 읽는다(`src/paths.ts` getMemexHome). 이 UI는 명시된 DB에서
   * 다른 home을 유도했을 수 있으므로, 고정하지 않으면 코어가 남기는 기록(`logs/ui-audit.jsonl`)이
   * 이 UI의 home이 아니라 기본 데이터 루트로 간다 — 임시 DB로 띄운 세션이 사용자의 실제
   * `~/.config/memex`에 쓰는 것을 막아야 한다.
   *
   * 환경 저장·설정은 **첫 `await` 이전에** 동기적으로 끝난다(#76). 호출자가 잠금을 잡은 직후 이
   * 함수를 부르면 검사와 설정 사이에 양보 지점이 없으므로, 두 번째 요청이 끼어들어 남의 환경을
   * 저장하거나 복원하는 일이 없다.
   *
   * #96 — 겹침은 **깊이 카운터**로 견딘다. 변경 잠금은 fact ID별(`busy`)이므로 서로 다른 기억의
   * 변경 둘은 실제로 겹치는데, 호출마다 저장·복원하면 (1) 나중 호출이 이미 고정된 값을 "원래 값"으로
   * 저장하고 (2) 먼저 끝난 호출이 아직 실행 중인 호출의 환경을 되돌려 코어가 기본 데이터 루트에
   * 기록하고 (3) 마지막 호출이 이 UI의 home을 프로세스에 영구히 남겼다. `this.home`/`this.dbPath`는
   * 인스턴스 수명 동안 불변이므로 중첩 호출이 요구하는 값은 늘 같다 — 가장 바깥(깊이 0→1) 호출만
   * 저장·설정하고 마지막으로 빠져나가는(1→0) 호출만 되돌리면 충분하다.
   */
  async pinned(fn){
    if(this.pinDepth===0){
      this.pinSaved={MEMEX_HOME:process.env.MEMEX_HOME,MEMEX_DB_PATH:process.env.MEMEX_DB_PATH};
      process.env.MEMEX_HOME=this.home;process.env.MEMEX_DB_PATH=this.dbPath;
    }
    this.pinDepth++;
    try{return await fn();}
    finally{
      this.pinDepth--;
      if(this.pinDepth===0){
        const saved=this.pinSaved;this.pinSaved=null;
        for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
      }
    }
  }
  /**
   * Cross-device sync through dist/sync-control.js (#48).
   *
   * The core module resolves its own paths from MEMEX_HOME / MEMEX_DB_PATH, and this UI may have
   * derived a different home from an explicitly pointed DB. So the call runs inside `pinned()` —
   * the shared helper every core mutation uses (#78) — and one sync call at a time keeps that
   * window from overlapping with another.
   *
   * #76 — the lock is taken BEFORE the first `await`, and `pinned()` sets the env synchronously
   * before its first `await` too. With no yield between the check and the set, a second caller
   * cannot enter, so the saved environment is always the original and no caller releases
   * another's lock.
   *
   * 0.6.3 (#48): 수동 세대 파일(zip) 내보내기·미리보기·가져오기와 기기 별칭도 같은 엔드포인트의
   * action으로 들어온다. 하위 경로(`/api/v2/sync/...`)는 만들지 않는다.
   */
  async sync(action,body={}){
    if(!SYNC_ACTIONS.includes(action))throw new HttpError(400,{code:'INVALID_SYNC_ACTION',key:'error.sync.unsupportedAction',message:'Unsupported sync action.'});
    if(this.syncBusy)throw new HttpError(409,{code:'SYNC_BUSY',key:'error.sync.alreadyRunning',message:'A sync run is already in progress.'});
    if(action!=='status'&&this.busy.size)throw new HttpError(409,{code:'MUTATION_BUSY',key:'error.sync.blockedByMutation',message:'A memory change is in progress. Run this after it finishes.'});
    // #96 대칭 — overlays()가 syncBusy를 보고 거절하는 것의 반대 방향.
    if(action!=='status'&&this.overlayBusy)throw new HttpError(409,{code:'OVERLAY_BUSY',key:'overlays.error.overlayBusy',message:'An overlay change is in progress. Run this after it finishes.'});
    // #31 대칭 — models()가 syncBusy를 보고 거절하는 것의 반대 방향. 한쪽만 막으면 배타성이
    // **요청 순서**로 결정된다: 1회 테스트가 먼저 들어오면(최대 60초) 그 뒤의 동기화가 그냥 통과했다.
    if(action!=='status'&&this.modelsBusy)throw new HttpError(409,{code:'MODELS_BUSY',key:'models.error.busy',message:'A model settings action is in progress. Run this after it finishes.'});
    this.syncBusy=true;
    try{
      return await this.pinned(async()=>{
        const m=await this.module('sync-control');
        for(const fn of ['getSyncStatus','setSyncEnabled','runSyncExport','runSyncImport'])
          if(typeof m[fn]!=='function')throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'error.core.syncServiceMissing',message:'The installed core has no sync service. Build the core.'});
        if(action==='status')return {status:m.getSyncStatus()};
        if(action==='enable'){
          const dir=text(body.dir,4096).trim();
          if(!dir)throw new HttpError(400,{code:'SYNC_DIR_REQUIRED',key:'error.sync.dirRequired',message:'Enter the shared folder path.'});
          if(!path.isAbsolute(dir)||/[\x00-\x1f]/.test(dir))throw new HttpError(400,{code:'INVALID_SYNC_DIR',key:'error.sync.dirNotAbsolute',message:'The shared folder must be an absolute path that can be normalised.'});
          return {status:m.setSyncEnabled({enabled:true,dir:path.normalize(dir)})};
        }
        if(action==='disable')return {status:m.setSyncEnabled({enabled:false})};
        if(action!=='export'&&action!=='import'){
          for(const fn of ARCHIVE_SERVICES)
            if(typeof m[fn]!=='function')throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'error.core.archiveServiceMissing',message:'The installed core has no generation-archive or device-alias service. Build the core.'});
          if(action==='alias'){
            // 빈 이름은 별칭 삭제다. 별칭은 로컬 sync/devices.json에만 쓰고 피어 설정은 건드리지 않는다.
            m.setDeviceAlias(identifier(body.deviceId),text(body.alias,200).trim()||null);
            return {status:m.getSyncStatus()};
          }
          // 세대 파일 내보내기는 동기화가 꺼져 있어도 동작한다 — 공유 폴더가 없을 때를 위한 경로다.
          if(action==='archive-export')return {archive:m.exportGenerationArchive(),status:m.getSyncStatus()};
          // 가져오기 경로는 사용자가 다른 맥에서 받아 둔 파일을 지목한다. 경로는 제한하지 않지만
          // payload는 기존 v5 검증을 그대로 통과해야 하므로 동기화 파일이 아니면 사유와 함께 거부된다.
          const source=text(body.path,4096).trim();
          if(!source)throw new HttpError(400,{code:'ARCHIVE_PATH_REQUIRED',key:'error.archive.pathRequired',message:'Enter the absolute path of a generation archive (zip) or a generation directory.'});
          if(!path.isAbsolute(source)||/[\x00-\x1f]/.test(source))throw new HttpError(400,{code:'INVALID_ARCHIVE_PATH',key:'error.archive.pathNotAbsolute',message:'The generation archive path must be an absolute path that can be normalised.'});
          const normalized=path.normalize(source);
          if(action==='archive-preview')return {preview:m.previewImportArchive(normalized)};
          return {outcome:await m.importArchive(normalized),status:m.getSyncStatus()};
        }
        // 사용자가 버튼을 눌렀다면 변경이 없어도 내보낸다(force). 자동 훅만 빈 세대를 피한다.
        const outcome=action==='export'?m.runSyncExport({force:true}):await m.runSyncImport();
        return {outcome,status:m.getSyncStatus()};
      });
    }catch(e){
      if(e.status)throw e;
      if(/not writable/.test(e.message))throw new HttpError(400,{code:'SYNC_DIR_UNWRITABLE',key:'error.sync.dirUnwritable',params:{detail:e.message},message:'The shared folder is not writable. Check the path and its permissions: '+e.message});
      // 코어의 세대 파일 거부 사유는 사용자가 고칠 수 있는 입력 문제다. 원문을 그대로 전달한다.
      if(/^sync archive /.test(e.message))throw new HttpError(400,{code:'INVALID_ARCHIVE',key:null,message:e.message});
      throw e;
    }finally{this.syncBusy=false;}
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
   *
   * #78 — the core writes its own audit line through `getMemexHome()`, so the call runs inside
   * `pinned()`: the tier move's `logs/ui-audit.jsonl` line lands under THIS server's home, never
   * in the default data root.
   */
  async tier(body,scope){
    const id=identifier(body.id);const action=body.action;
    if(!['promote','demote'].includes(action))throw new HttpError(400,{code:'INVALID_TIER_ACTION',key:'error.tier.unsupportedAction',message:'Unsupported tier move.'});
    if(this.busy.has(id))throw new HttpError(409,{code:'MUTATION_BUSY',key:'error.fact.mutationInFlight',message:'A change to this memory is already in progress.'});
    // #96 — sync()가 busy를 보고 거절하는 것과 대칭. 같은 쪽만 막으면 동기화와 변경이 겹친다.
    if(this.syncBusy)throw new HttpError(409,{code:'SYNC_BUSY',key:'error.fact.blockedBySync',message:'A sync run is in progress. Run this after it finishes.'});
    if(this.overlayBusy)throw new HttpError(409,{code:'OVERLAY_BUSY',key:'overlays.error.overlayBusy',message:'An overlay change is in progress. Run this after it finishes.'});
    if(this.modelsBusy)throw new HttpError(409,{code:'MODELS_BUSY',key:'models.error.busy',message:'A model settings action is in progress. Run this after it finishes.'});
    this.busy.add(id);let writer;
    try{
      return await this.pinned(async()=>{
        const store=await this.connect();const current=store.visibleFact(id,scope);
        if(body.expectedUpdatedAt&&current.updated_at!==body.expectedUpdatedAt)throw new HttpError(409,{code:'STALE_FACT',key:'error.fact.stale',message:'This memory changed in another operation. Refresh, then check again.'});
        const fm=await this.module('fact-management');
        if(typeof fm.promoteFact!=='function'||typeof fm.demoteFact!=='function')throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'error.core.tierServiceMissing',message:'The installed core has no tier-move service. Build the core.'});
        // 읽은 tier에서 한 칸만 — 목표를 코어에 명시해야 경쟁에서 져도 두 칸이 움직이지 않는다.
        const LADDER=['workstream','project','global'];
        const from=typeof fm.factTierOf==='function'
          ?fm.factTierOf({scope_type:current.scope_type,promotion_state:current.promotion_state??null}):null;
        const to=from?LADDER[LADDER.indexOf(from)+(action==='promote'?1:-1)]:undefined;
        if(from&&!to)throw new HttpError(409,{code:'TIER_STEP',key:'error.tier.oneRungOnly',message:'Tiers move one rung at a time. To reach global, promote to project-wide first.'});
        const factories=await this.module('db');writer=factories.openWriteDb(this.dbPath);
        const options={actor:'user',reason:text(body.reason,500)||null,projectId:scope.projectId||null,workstreamId:scope.workstreamId||null,
          ...(to?{to}:{}),expected:{...(from?{tier:from}:{}),...(current.updated_at?{updatedAt:current.updated_at}:{})}};
        return action==='promote'?fm.promoteFact(writer,id,options):fm.demoteFact(writer,id,options);
      });
    }catch(e){
      if(e.status)throw e;
      if(e.name==='TierStaleError')throw new HttpError(409,{code:'STALE_FACT',key:'error.fact.stale',message:'This memory changed in another operation. Refresh, then check again.'});
      if(e.name==='TierStepError')throw new HttpError(409,{code:'TIER_STEP',key:'error.tier.oneRungOnly',message:'Tiers move one rung at a time. To reach global, promote to project-wide first.'});
      if(/requires a target project/.test(e.message))throw new HttpError(400,{code:'TIER_TARGET_REQUIRED',key:'error.tier.targetProjectRequired',message:'To demote a global memory, pick the target project scope at the top first.'});
      if(/requires a workstream/.test(e.message))throw new HttpError(400,{code:'TIER_TARGET_REQUIRED',key:'error.tier.targetWorkstreamRequired',message:'To demote to the branch tier, pick a workstream in the detail scope first.'});
      if(/requires project identity/.test(e.message))throw new HttpError(400,{code:'TIER_TARGET_REQUIRED',key:'error.tier.projectIdentityMissing',message:'This memory has no project identifier, so its tier cannot move. Check it from the CLI.'});
      throw e;
    }
    finally{this.busy.delete(id);if(writer&&writer!==this.db){try{writer.close();}catch{}}}
  }
  async mutate(body,scope){
    const id=identifier(body.id);const action=body.action;
    if(!['edit','deactivate','restore','delete'].includes(action))throw new HttpError(400,{code:'INVALID_FACT_ACTION',key:'error.fact.unsupportedMutation',message:'Unsupported memory change.'});
    if(this.busy.has(id))throw new HttpError(409,{code:'MUTATION_BUSY',key:'error.fact.mutationInFlight',message:'A change to this memory is already in progress.'});
    // #96 — sync()가 busy를 보고 거절하는 것과 대칭. 같은 쪽만 막으면 동기화와 변경이 겹친다.
    if(this.syncBusy)throw new HttpError(409,{code:'SYNC_BUSY',key:'error.fact.blockedBySync',message:'A sync run is in progress. Run this after it finishes.'});
    if(this.overlayBusy)throw new HttpError(409,{code:'OVERLAY_BUSY',key:'overlays.error.overlayBusy',message:'An overlay change is in progress. Run this after it finishes.'});
    if(this.modelsBusy)throw new HttpError(409,{code:'MODELS_BUSY',key:'models.error.busy',message:'A model settings action is in progress. Run this after it finishes.'});
    // #106 — 잠금은 첫 await 앞에서 동기적으로 잡는다(#77이 tier()에 세운 규칙과 같다). 0.6.6은
    // syncBusy를 검사한 뒤 `await this.connect()`로 양보하고 나서야 busy.add(id)를 했고, 그 창에
    // 들어온 sync()는 빈 busy를 보고 통과했다. 재개된 변경은 syncBusy를 다시 보지 않으므로 동기화와
    // 변경이 겹쳤다. 양쪽 잠금이 모두 첫 await 앞에서 잡히면 어느 순서로 들어와도 배타적이다.
    this.busy.add(id);let writer;
    try{
      const store=await this.connect();const current=store.visibleFact(id,scope);
      if(body.expectedUpdatedAt&&current.updated_at!==body.expectedUpdatedAt)throw new HttpError(409,{code:'STALE_FACT',key:'error.fact.stale',message:'This memory changed in another operation. Refresh, then check again.'});
      if(body.expectedText!==undefined&&current.fact!==body.expectedText)throw new HttpError(409,{code:'STALE_FACT',key:'error.fact.textStale',message:'The memory text changed. Refresh the page.'});
      if(action==='edit'&&(typeof body.text!=='string'||body.text.trim().length<FACT_TEXT_MIN||body.text.length>FACT_TEXT_MAX))throw new HttpError(400,{code:'INVALID_FACT_TEXT',key:'error.fact.textLength',params:{min:FACT_TEXT_MIN,max:FACT_TEXT_MAX},message:`Enter between ${FACT_TEXT_MIN} and ${FACT_TEXT_MAX} characters of memory text.`});
      if(action==='delete'&&(!body.confirm||body.confirmId!==id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))throw new HttpError(400,{code:'CONFIRMATION_REQUIRED',key:'error.fact.deleteConfirmRequired',message:'Review the impact, then type the full UUID exactly.'});
      // #78 — 코어의 감사 줄도 이 서버의 home에 남아야 하므로 코어 호출을 pinned() 안에서 한다.
      return await this.pinned(async()=>{
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
      });
    }catch(e){if(e.name==='StaleFactMutationError')throw new HttpError(409,{code:'STALE_FACT',key:null,message:e.message});throw e;}
    finally{this.busy.delete(id);if(writer&&writer!==this.db){try{writer.close();}catch{}}}
  }
  /* ═══ Issue #31 — 모델 선택 (`/api/v2/models`) ══════════════════════════════════════════ *
   * 이 블록은 `memex models`가 부르는 **바로 그 코어 함수들**을 부른다: 설정 파일은
   * `dist/model-settings.js`, 목록은 `dist/codex-catalog.js`, 1회 테스트는
   * `dist/model-settings-probe.js`, 보류·대기 작업은 `dist/model-budget.js`의 HOLD API다.
   * `memex` CLI를 셸로 실행하지 않는다 — 그러면 이 서버가 해석한 home이 아니라 자식 프로세스의
   * 환경이 경로를 정하게 되고(#78), 결과를 구조화해서 받을 수도 없다.
   *
   * 세 가지 규칙:
   *  1. **조회는 DB 없이도 답한다.** 선택과 출처는 파일·환경 변수만으로 결정되므로, 인덱스
   *     데이터베이스가 없는 새 설치에서도 200이다. 보류·대기 작업·마지막 테스트만 비게 된다.
   *  2. **코어 호출은 `pinned()` 안에서 한다.** `models.json` 경로와 코어의 감사 줄이 모두
   *     `getMemexHome()`에서 오므로, 고정하지 않으면 임시 DB로 띄운 세션이 사용자의 실제
   *     데이터 루트에 쓴다(#78).
   *  3. **한 번에 하나.** `modelsBusy`는 sync의 단일 실행 락과 같고, 기억 변경·동기화와도
   *     배타적이다 — 테스트 호출은 최대 3분이 걸릴 수 있고 그 사이 같은 파일을 두 번 쓰면
   *     "무엇이 저장됐는가"가 경합으로 결정된다.
   */
  async models(action,body={}){
    if(!Core.MODEL_ACTIONS.includes(action))throw new HttpError(400,{code:'UNKNOWN_ACTION',key:'models.error.unknown_action',
      message:`unsupported model action: ${text(action,40)}`});
    if(this.modelsBusy)throw new HttpError(409,{code:'MODELS_BUSY',key:'models.error.busy',
      message:'a model settings action is already running'});
    if(action!=='status'&&(this.busy.size||this.syncBusy||this.overlayBusy))throw new HttpError(409,{code:'MUTATION_BUSY',key:'models.error.mutation_busy',
      message:'a memory change or a sync is running'});
    this.modelsBusy=true;
    try{
      return await this.pinned(async()=>{
        const settings=await this.module('model-settings');
        for(const fn of ['readModelSettings','writeModelSettings','resetModelSettings','resolveLlmSelection','isValidModelId','normalizeReasoningEffort'])
          if(typeof settings[fn]!=='function')throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'models.error.core_unavailable',
            message:`dist/model-settings.js has no ${fn}. Build the core.`});
        if(action==='status')return await this.modelStatus(settings);
        if(action==='reset'){
          const had=fs.existsSync(settings.modelSettingsPath());
          const before=settings.resolveLlmSelection();
          settings.resetModelSettings();
          const after=settings.resolveLlmSelection();
          const settled=await this.settleModelSelection(before.fingerprint,after.fingerprint);
          await this.modelAudit('models.reset',{had_llm:had,source:'ui'});
          return {ok:true,removed:had,settled,warnings:this.modelSettleWarnings(settled),status:await this.modelStatus(settings)};
        }
        const input=this.modelSelectionInput(settings,body);
        if(action==='set-llm'){
          if(input.model===undefined&&input.reasoning===undefined)
            throw new HttpError(422,{code:'NOTHING_TO_SAVE',key:'models.error.nothing_to_save',
              message:'choose a model and/or a reasoning effort',
              details:{issues:[{field:'model',key:'models.error.nothing_to_save'}]}});
          const before=settings.resolveLlmSelection();
          settings.writeModelSettings({llm:{
            ...(input.model!==undefined?{model:input.model}:{}),
            ...(input.reasoning!==undefined?{reasoning:input.reasoning}:{}),
          }});
          const saved=settings.readModelSettings();
          const after=settings.resolveLlmSelection();
          const settled=await this.settleModelSelection(before.fingerprint,after.fingerprint);
          await this.modelAudit('models.llm.set',{from_model:before.model,to_model:after.model,
            from_reasoning:before.reasoning,to_reasoning:after.reasoning,source:'ui'});
          const status=await this.modelStatus(settings);
          return {ok:true,saved:{model:saved.llm.model,reasoning:saved.llm.reasoning},settled,
            warnings:[...await this.modelSaveWarnings(settings,input,saved,after),...this.modelSettleWarnings(settled)],status};
        }
        // test — 실제 제공자 호출 1회. 원장에 시도 1건을 남기므로 쓰기 가능한 DB가 필요하다.
        if(!fs.existsSync(this.dbPath))throw new HttpError(503,{code:'DB_INDEX_MISSING',key:'models.error.db_missing',
          message:'the index database is missing, so a probe has nowhere to record its attempt'});
        const probe=await this.module('model-settings-probe');
        if(typeof probe.probeModel!=='function')throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'models.error.core_unavailable',
          message:'dist/model-settings-probe.js has no probeModel. Build the core.'});
        const selection=settings.resolveLlmSelection({
          ...(input.model!==undefined&&input.model!==null?{model:input.model}:{}),
          ...(input.reasoning!==undefined?{reasoningEffort:input.reasoning}:{}),
        });
        const factories=await this.module('db');
        const writer=factories.openWriteDb(this.dbPath);
        let result;
        try{result=await probe.probeModel(writer,{model:selection.model,reasoning:selection.reasoning});}
        finally{try{writer.close();}catch{}}
        return {ok:!!result.ok,probe:result,status:await this.modelStatus(settings)};
      });
    }finally{this.modelsBusy=false;}
  }
  /**
   * 입력 검증. 모델 id·추론 강도는 **형식만** 보고, 맞지 않으면 정규화하지 않고 422로 거절한다
   * (설정 저장은 조용한 교정이 오류보다 나쁜 유일한 자리다 — 한 시간 뒤 원인 모를 보류가 된다).
   * 행별 사유를 `details.issues`로 실어 클라이언트의 renderIssues()가 그대로 그린다.
   */
  modelSelectionInput(settings,body){
    const out={};
    // 검증은 **자르기 전 원문**으로 한다. `text(body.model,256)`를 먼저 통과시키면 257자 id도,
    // 256자 뒤에 붙은 금지 문자도 검증기에 닿지 못해 422여야 할 요청이 성공하고 사용자가 요청하지
    // 않은 256자 id가 저장됐다(원문을 보는 CLI와도 결과가 달랐다). 잘린 값은 화면에 되돌려줄
    // 문구에만 쓴다 — 거대한 입력을 오류 본문에 그대로 싣지 않기 위한 경계다.
    const model=typeof body.model==='string'?body.model.trim():'';
    if(body.model!==undefined&&body.model!==null&&model!==''){
      if(!settings.isValidModelId(model)){
        const shown=text(model,256);
        throw new HttpError(422,{code:'INVALID_MODEL_ID',key:'models.error.invalid_model_id',
          params:{value:shown},message:`invalid model id ${JSON.stringify(shown)} — expected 1-256 characters matching [\\w./:@+-]`,
          details:{issues:[{field:'model',key:'models.error.invalid_model_id',params:{value:shown}}]}});
      }
      out.model=model;
    }
    if(body.reasoning!==undefined){
      // `none`은 제공자의 실제 강도이므로, "플래그를 보내지 않음"은 null 또는 'unset'으로만 말한다.
      const raw=body.reasoning===null||body.reasoning===''||body.reasoning==='unset'?null:text(body.reasoning,40).trim();
      if(raw===null)out.reasoning=null;
      else{
        const normalized=settings.normalizeReasoningEffort(raw);
        const allowed=(settings.ALLOWED_REASONING_EFFORTS||[]).join(', ');
        if(!normalized)throw new HttpError(422,{code:'INVALID_REASONING',key:'models.error.invalid_reasoning',
          params:{allowed},message:`invalid reasoning effort ${JSON.stringify(raw)} — expected one of ${allowed}`,
          details:{issues:[{field:'reasoning',key:'models.error.invalid_reasoning',params:{allowed}}]}});
        out.reasoning=normalized;
      }
    }
    return out;
  }
  /** 선택·출처·카탈로그·보류·대기 작업·마지막 테스트를 한 번에. 항상 성공한다. */
  async modelStatus(settings){
    const catalog=await this.module('codex-catalog');
    const selection=settings.resolveLlmSelection();
    const saved=settings.readModelSettings();
    const read=typeof catalog.readCodexCatalog==='function'?catalog.readCodexCatalog():null;
    const levels=read&&typeof catalog.reasoningEffortsForModel==='function'
      ?catalog.reasoningEffortsForModel(selection.model,read):null;
    const facts=await this.modelDbFacts(selection.fingerprint);
    const settingsPath=settings.modelSettingsPath();
    return {
      settingsPath,fileExists:fs.existsSync(settingsPath),version:saved.version,updatedAt:saved.updatedAt,
      llm:{
        effective:{model:{value:selection.model,source:selection.modelSource},
          reasoning:{value:selection.reasoning,source:selection.reasoningSource}},
        saved:{model:saved.llm.model,reasoning:saved.llm.reasoning},
        defaults:{model:settings.DEFAULT_LLM_MODEL,reasoning:null},
        allowedReasoning:[...(settings.ALLOWED_REASONING_EFFORTS||[])],
        catalogReasoning:levels,
        catalog:read?{source:read.source,path:read.path,fetchedAt:read.fetchedAt,
          codexHome:typeof catalog.codexHome==='function'?catalog.codexHome():null,
          models:read.models.map(m=>({slug:m.slug,displayName:m.displayName,visible:m.visible,
            defaultReasoning:m.defaultReasoning,reasoningEfforts:m.reasoningEfforts}))}:null,
        fingerprint:selection.fingerprint,
        hold:facts.holds.find(h=>h.current)||null,holds:facts.holds,heldJobs:facts.heldJobs,lastProbe:facts.lastProbe,
      },
      embedding:await this.modelEmbeddingReport(),
      env:{MEMEX_CODEX_MODEL:process.env.MEMEX_CODEX_MODEL??null,MEMEX_CODEX_REASONING:process.env.MEMEX_CODEX_REASONING??null,
        MEMEX_EMBEDDING_MODEL:process.env.MEMEX_EMBEDDING_MODEL??null,MEMEX_EMBEDDING_DIMS:process.env.MEMEX_EMBEDDING_DIMS??null},
      db:{path:this.dbPath,exists:facts.exists},
    };
  }
  /**
   * 보류·대기 작업·마지막 테스트. 없는 테이블·컬럼은 "없음"이고 오류가 아니다 — 0.6.x DB로도
   * 이 화면은 열려야 한다. 읽기 연결은 이미 열려 있으면 재사용하고, 내가 열었으면 내가 닫는다.
   */
  async modelDbFacts(fingerprint){
    const out={exists:fs.existsSync(this.dbPath),holds:[],heldJobs:[],lastProbe:null};
    if(!out.exists)return out;
    let db=this.db,owned=false;
    try{
      if(!db){const factories=await this.module('db');db=factories.openReadDb(this.dbPath);owned=true;}
      const budget=await this.module('model-budget');
      if(typeof budget.listModelConfigHolds==='function')out.holds=budget.listModelConfigHolds(db,fingerprint);
      if(typeof budget.heldJobSummary==='function')out.heldJobs=budget.heldJobSummary(db);
      const probe=await this.module('model-settings-probe');
      out.lastProbe=this.modelLastProbe(db,probe.MODEL_PROBE_STAGE||'model_probe');
    }catch{/* 조회는 부분 실패해도 선택·출처는 답해야 한다 */}
    finally{if(owned&&db){try{db.close();}catch{}}}
    return out;
  }
  /** 원장에서 읽는 마지막 `model_probe` 시도. 추정하지 않고, 없으면 null이다. */
  modelLastProbe(db,stage){
    try{
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_work_attempts'").get())return null;
      const columns=new Set(db.prepare("SELECT name FROM pragma_table_info('model_work_attempts')").all().map(r=>r.name));
      const extra=['model','reasoning_effort'].filter(c=>columns.has(c));
      const row=db.prepare(`SELECT state, started_at, finished_at, duration_ms, error_class${extra.map(c=>', '+c).join('')}
        FROM model_work_attempts WHERE stage = ? ORDER BY started_at DESC, attempt_id DESC LIMIT 1`).get(stage);
      if(!row)return null;
      return {ok:row.state==='completed',at:row.finished_at??row.started_at,latencyMs:row.duration_ms??null,
        model:row.model??null,reasoning:row.reasoning_effort??null,errorClass:row.error_class??null};
    }catch{return null;}
  }
  /** 임베딩은 아직 읽기 전용이다(전환은 #118). 측정하지 않은 차원을 주장하지 않는다. */
  async modelEmbeddingReport(){
    try{
      const cacheModule=await this.module('model-cache');
      const cache=typeof cacheModule.embeddingCacheStatus==='function'?cacheModule.embeddingCacheStatus():null;
      return {readOnly:true,model:cacheModule.EMBEDDING_MODEL??null,
        source:process.env.MEMEX_EMBEDDING_MODEL?'env':'default',
        cache:{present:!!cache?.present,files:cache?.files??0,bytes:cache?.bytes??0,
          modelDir:cache?.modelDir??null,stub:!!cache?.stub}};
    }catch(e){return {readOnly:true,model:null,source:'default',
      cache:{present:false,files:0,bytes:0,modelDir:null,stub:false},error:e.message};}
  }
  /**
   * 선택이 바뀌면 **옛 지문의 보류는 영원히 다시 매칭되지 않으므로** 여기서 닫고, 그 사유로
   * 파킹된 작업도 함께 푼다(§3.5.2 규칙 3). 내 지문의 행만 만진다 — 다른 설정으로 도는
   * 프로세스의 보류를 지우지 않는 것이 이 설계의 핵심이다.
   */
  async settleModelSelection(previousFingerprint,nextFingerprint){
    if(previousFingerprint===nextFingerprint||!fs.existsSync(this.dbPath))return null;
    let writer=null;
    try{
      const factories=await this.module('db');
      const budget=await this.module('model-budget');
      if(typeof budget.clearModelConfigHold!=='function'||typeof budget.releaseHeldJobs!=='function')return null;
      writer=factories.openWriteDb(this.dbPath);
      const clearedHolds=budget.clearModelConfigHold(writer,previousFingerprint,'manual')?1:0;
      const releasedJobs=budget.releaseHeldJobs(writer,'model_config_rejected');
      if(clearedHolds>0)await this.modelAudit('models.llm.hold.cleared',{reason:'manual',
        fingerprint_prefix:String(previousFingerprint).slice(0,12),source:'ui'});
      return {clearedHolds,releasedJobs};
    }catch{return null;}
    finally{if(writer){try{writer.close();}catch{}}}
  }
  modelSettleWarnings(settled){
    return settled&&(settled.clearedHolds>0||settled.releasedJobs>0)
      ?[{code:'HOLD_CLEARED',params:{holds:settled.clearedHolds,jobs:settled.releasedJobs}}]:[];
  }
  /**
   * 저장은 성공했지만 사용자가 알아야 하는 것들. **거절이 아니라 경고**인 이유: 카탈로그는 낡을
   * 수 있고 id는 실제 호출만이 증명한다(§3.3 규칙 2).
   */
  async modelSaveWarnings(settings,input,saved,after){
    const catalog=await this.module('codex-catalog');
    const read=typeof catalog.readCodexCatalog==='function'?catalog.readCodexCatalog():null;
    const warnings=[];
    if(input.model!==undefined&&read){
      if(read.source==='none')warnings.push({code:'CATALOG_UNAVAILABLE',
        params:{home:typeof catalog.codexHome==='function'?catalog.codexHome():''}});
      else{
        const entry=typeof catalog.findCatalogModel==='function'?catalog.findCatalogModel(read,input.model):null;
        if(!entry)warnings.push({code:'MODEL_NOT_IN_CATALOG',params:{model:input.model,path:read.path||''}});
        else if(!entry.visible)warnings.push({code:'MODEL_HIDDEN_IN_CATALOG',params:{model:input.model}});
      }
    }
    // 강도는 **저장한 모델**을 기준으로 본다 — 환경 변수가 이기는 모델의 목록을 경고하면 버그로 읽힌다.
    const checked=input.model!==undefined?input.model:after.model;
    const levels=read&&typeof catalog.reasoningEffortsForModel==='function'
      ?catalog.reasoningEffortsForModel(checked,read):null;
    if(saved.llm.reasoning&&levels&&!levels.includes(saved.llm.reasoning))
      warnings.push({code:'REASONING_UNSUPPORTED',params:{model:checked,levels:levels.join(' / ')}});
    if(after.modelSource==='env'&&input.model!==undefined)
      warnings.push({code:'ENV_OVERRIDES_MODEL',params:{name:'MEMEX_CODEX_MODEL',value:after.model,model:input.model}});
    if(after.reasoningSource==='env'&&input.reasoning!==undefined)
      warnings.push({code:'ENV_OVERRIDES_REASONING',params:{name:'MEMEX_CODEX_REASONING',value:after.reasoning??''}});
    return warnings;
  }
  /**
   * 감사 줄은 코어의 writer를 재사용한다(설계 §10.1 C5) — 새 모듈을 만들지 않고, 없으면 기능은
   * 그대로 돌고 줄만 빠진다. `pinned()` 안에서 불리므로 이 서버의 home에 떨어진다(#78).
   * 서버 라우트의 `logs.audit()`와 역할이 다르다: 그 줄은 "요청이 성공했는가", 이 줄은 "무엇이
   * 바뀌었는가"를 남긴다.
   */
  async modelAudit(action,detail){
    // await으로 끝낸다 — pinned()를 빠져나간 뒤에 쓰면 이 서버의 home이 아닌 곳에 떨어진다.
    try{const admin=await this.module('ontology-admin');admin.appendUiAuditLine?.(action,detail);}
    catch{/* 원장이 durable 기록이고 감사 줄은 best-effort다 */}
  }
  /* ═══ Issue #29 · #30 — 사용자 오버레이 (`/api/v2/overlays`) ═══════════════════════════ *
   * `memex gate`가 부르는 **바로 그 코어 함수들**을 부른다: 읽기는 `dist/recall-gate-overlay.js`와
   * `dist/extraction-rules.js`(둘 다 DB 없는 leaf), 쓰기는 `dist/overlay-admin.js`(lock + revision
   * CAS), 사용자 정규식 실행은 `dist/overlay-matcher.js`의 시간 상자 worker, 대기 작업 집계는
   * `dist/model-budget.js`의 `heldJobSummary`다. `memex`를 셸로 실행하지 않는다 — 자식 프로세스의
   * 환경이 오버레이 파일 경로를 정하게 되고(#78) 결과를 구조화해서 받을 수도 없다.
   *
   * 네 가지 규칙:
   *  1. **조회·쓰기 모두 DB 없이 된다.** 오버레이는 `<home>/overlays/*.json` 파일이므로 인덱스
   *     데이터베이스가 없는 새 설치에서도 200이다. 대기 작업·드리프트·시뮬레이션만 DB를 본다.
   *  2. **코어 호출은 `pinned()` 안에서 한다.** 오버레이 파일·히스토리·`logs/ui-audit.jsonl`이 모두
   *     `getMemexHome()`에서 오므로, 고정하지 않으면 임시 DB로 띄운 세션이 사용자의 실제 데이터
   *     루트에 쓴다(#78).
   *  3. **한 번에 하나.** `overlayBusy`는 sync의 단일 실행 락과 같고 기억 변경·동기화와도 배타적이다
   *     (#96 대칭). 검증 프로브가 lock 안에서 최대 300 ms를 쓰므로 두 쓰기가 겹치면 "무엇이
   *     저장됐는가"가 경합으로 결정된다.
   *  4. **감사는 코어가 남긴다.** `overlay-admin`이 `appendUiAuditLine`으로 이미 쓰므로 여기서
   *     다시 쓰지 않는다(§1.4의 "네 번째 writer를 만들지 않는다" 규칙 — 이중 기록 금지).
   */
  async overlays(action,body={}){
    if(!Core.OVERLAY_ACTIONS.includes(action))throw new HttpError(400,{code:'INVALID_ACTION',key:'overlays.error.invalidAction',
      message:`unsupported overlay action: ${text(action,40)}`});
    const write=Core.OVERLAY_WRITE_ACTIONS.has(action);
    if(write){
      if(this.overlayBusy)throw new HttpError(409,{code:'OVERLAY_BUSY',key:'overlays.error.overlayBusy',
        message:'an overlay change is already in progress'});
      if(this.syncBusy)throw new HttpError(409,{code:'SYNC_BUSY',key:'overlays.error.syncBusy',message:'a sync run is in progress'});
      if(this.busy.size)throw new HttpError(409,{code:'MUTATION_BUSY',key:'overlays.error.mutationBusy',message:'a memory change is in progress'});
      // #31 대칭 — models()가 overlayBusy를 보고 거절하는 것의 반대 방향.
      if(this.modelsBusy)throw new HttpError(409,{code:'MODELS_BUSY',key:'models.error.busy',message:'a model settings action is in progress'});
      this.overlayBusy=true;                       // 첫 await 앞에서 동기적으로 (#76/#106 규칙)
    }
    try{
      return await this.pinned(async()=>{
        const gate=await this.overlayModule('recall-gate-overlay');
        const rules=await this.overlayModule('extraction-rules');
        if(action==='status')return await this.overlayStatus(gate,rules);
        const overlay=body.overlay==='rules'?'rules':body.overlay==='gate'?'gate':null;
        if(overlay===null)throw new HttpError(400,{code:'INVALID_OVERLAY',key:'overlays.error.invalidOverlay',
          message:'overlay must be "gate" or "rules"'});
        if(action==='validate')return await this.overlayValidate(overlay,gate,rules,body);
        if(action==='test'){
          if(overlay!=='gate')throw new HttpError(400,{code:'INVALID_ACTION',key:'overlays.error.gateOnly',
            message:'test applies to the recall-gate overlay only'});
          return await this.overlayTest(gate,body);
        }
        if(action==='simulate'){
          if(overlay!=='rules')throw new HttpError(400,{code:'INVALID_ACTION',key:'overlays.error.rulesOnly',
            message:'simulate applies to the extraction-rules overlay only'});
          return await this.overlaySimulate(rules,body);
        }
        const result=await this.overlayWrite(overlay,action,gate,rules,body);
        return {ok:true,...result,status:await this.overlayStatus(gate,rules)};
      });
    }finally{if(write)this.overlayBusy=false;}
  }
  /** 오버레이 모듈은 없을 수 있다 — 코어를 빌드하지 않은 설치에서 503의 사유가 이것이다. */
  async overlayModule(name){
    if(!fs.existsSync(path.join(this.root,'dist',name+'.js')))
      throw new HttpError(503,{code:'CORE_UNAVAILABLE',key:'overlays.error.coreUnavailable',params:{module:`dist/${name}.js`},
        message:`dist/${name}.js is missing. Build the core.`});
    return this.module(name);
  }
  /**
   * 두 오버레이의 전체 상태. 항상 성공한다 — 파일이 깨져 있으면 그 사실이 `issues[]`로 실린다
   * (게이트는 내장으로 계속, 추출은 HOLD라는 비대칭이 화면에서 읽혀야 한다).
   */
  async overlayStatus(gate,rules){
    const loadedGate=gate.loadRecallGateOverlay();
    const catalog=gate.gateCatalog();
    const loadedRules=rules.loadExtractionRules();
    const resolved=rules.resolveExtractionRules(null,loadedRules);
    const matcher=await this.module('overlay-matcher');
    const admin=await this.overlayModule('overlay-admin');
    const policy=await this.extractionPolicyVersion();
    const doc=loadedGate.doc;
    return {
      available:true,
      // 0.7.0은 기기 간 공유가 없다 (§1.7). 화면이 이 사실을 배너로 말하고 0.7.1을 가리킨다.
      shared:false,
      limits:{...gate.OVERLAY_LIMITS,matchWallMs:matcher.MATCH_WALL_MS,probeWallMs:admin.PROBE_WALL_MS,
        rules:rules.EXTRACTION_RULES_LIMITS,inputChars:matcher.MATCH_INPUT_CHARS,historySnapshots:admin.HISTORY_SNAPSHOT_LIMIT},
      paths:typeof admin.overlayPaths==='function'?admin.overlayPaths():null,
      disabledByEnv:!!loadedRules.disabledByEnv,
      gate:{
        present:loadedGate.present,revision:loadedGate.revision,hash:loadedGate.hash,
        updatedAt:doc?.updated_at??null,updatedBy:doc?.updated_by?.surface??null,
        builtin:{patterns:catalog.builtin.map(p=>({id:p.id,intent:p.intent,source:p.source,flags:p.flags,form:p.form})),
          words:Object.fromEntries(Object.entries(catalog.words).map(([k,v])=>[k,[...v]]))},
        user:{patterns:(doc?.patterns?.add??[]).map(p=>({...p})),disabled:[...loadedGate.disabled],
          words:{add:{...loadedGate.words.add},disable:{...loadedGate.words.disable}}},
        quarantined:loadedGate.quarantined.map(q=>({...q})),
        issues:loadedGate.issues,
        history:admin.listOverlayHistory('recall-gate',20),
        snapshots:typeof admin.listOverlaySnapshots==='function'?admin.listOverlaySnapshots('recall-gate'):[],
      },
      rules:{
        present:loadedRules.present,revision:loadedRules.revision,hash:loadedRules.hash,
        updatedAt:loadedRules.doc?.updated_at??null,updatedBy:loadedRules.doc?.updated_by?.surface??null,
        schema:rules.EXTRACTION_RULES_OVERLAY_SCHEMA,version:rules.EXTRACTION_RULES_OVERLAY_VERSION,
        doc:loadedRules.doc,emptyDoc:rules.emptyExtractionRulesDoc(),
        resolved:{preferredLanguage:resolved.preferredLanguage,excludeTopics:resolved.excludeTopics,
          neverExtract:resolved.neverExtract,decisionHints:resolved.decisionHints},
        clause:(text=>({chars:text.length,text}))(rules.renderExtractionConstraintClause(resolved)),
        // 검증기·증거 기준은 오버레이가 건드릴 수 없다 — 화면이 그 사실을 단정으로 말한다.
        verifierUnchanged:true,
        enforcementPoints:[...rules.EXTRACTION_RULE_ENFORCEMENT_POINTS],
        schedulingPolicyVersion:policy.scheduling,
        effectivePolicyVersion:policy.scheduling===null?null
          :rules.composeEffectivePolicyVersion(policy.scheduling,loadedRules.hash),
        quarantined:loadedRules.quarantined.map(q=>({...q})),
        issues:loadedRules.issues,
        history:admin.listOverlayHistory('extraction-rules',20),
        snapshots:typeof admin.listOverlaySnapshots==='function'?admin.listOverlaySnapshots('extraction-rules'):[],
        drift:{...this.overlayDrift(loadedRules.hash),heldJobs:await this.overlayHeldJobs()},
      },
    };
  }
  /** 스케줄링 키는 코어 상수다 — UI가 복제하면 두 값이 갈라진다. 읽을 수 없으면 null이다. */
  async extractionPolicyVersion(){
    try{
      const store=await this.module('continuity-store');
      return {scheduling:typeof store.FACT_EXTRACTION_POLICY_VERSION==='string'?store.FACT_EXTRACTION_POLICY_VERSION:null};
    }catch{return {scheduling:null};}
  }
  /**
   * 다른 규칙으로 추출된 대상과 규칙 오류로 대기 중인 작업. DB가 없으면 `available:false`이고
   * 0을 지어내지 않는다. 없는 표·컬럼도 "없음"이며 오류가 아니다(0.6.x DB로도 화면은 열린다).
   */
  overlayDrift(currentHash){
    if(!fs.existsSync(this.dbPath))return {available:false,staleTargets:0,staleSessions:0,heldJobs:[]};
    let db=this.db,owned=false;
    const out={available:true,staleTargets:0,staleSessions:0,heldJobs:[]};
    try{
      if(!db){const better=require(path.join(this.root,'node_modules','better-sqlite3'));db=new better(this.dbPath,{readonly:true});owned=true;}
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extraction_targets'").get()){
        const columns=new Set(db.prepare("SELECT name FROM pragma_table_info('extraction_targets')").all().map(r=>r.name));
        if(columns.has('rules_hash')){
          const row=db.prepare(`SELECT COUNT(*) AS targets, COUNT(DISTINCT session_id) AS sessions
            FROM extraction_targets WHERE IFNULL(rules_hash,'') IS NOT ?`).get(currentHash??'');
          out.staleTargets=Number(row?.targets||0);out.staleSessions=Number(row?.sessions||0);
        }
      }
    }catch{out.available=false;}
    finally{if(owned&&db){try{db.close();}catch{}}}
    return out;
  }
  /** 규칙 오류로 파킹된 작업 수. 소유 화면이 추출 규칙인 사유만 남긴다. */
  async overlayHeldJobs(){
    return (await this.heldJobs()).filter(r=>String(r.reason).startsWith('extraction_rules_'));
  }
  /** 검증만. 파일을 건드리지 않고 `Issue[]`를 그대로 돌려준다(프로브 포함). */
  async overlayValidate(overlay,gate,rules,body){
    const doc=body.doc;
    if(doc===null||typeof doc!=='object')throw new HttpError(400,{code:'INVALID_DOCUMENT',key:'overlays.error.invalidDocument',
      message:'validate needs a doc object'});
    const admin=await this.overlayModule('overlay-admin');
    const result=await admin.validateOverlay(overlay==='gate'?'recall-gate':'extraction-rules',doc,{
      probe:body.probe!==false,forWrite:true,
      ...(overlay==='rules'?{validator:rules.validateExtractionRules}:{}),
    });
    return {ok:!!result.ok,issues:result.issues??[]};
  }
  /**
   * 한 프롬프트를 내장 + 오버레이로 판정해 **왜 발화했는지**를 돌려준다. 모델도 임베딩도 부르지
   * 않고, 어떤 기록도 남기지 않는다 — 유일한 예외는 격리 파일이며, 그것은 이 호출이 실제 matcher를
   * 썼다는 사실 그대로다(§2.4 explainRecall).
   */
  async overlayTest(gate,body){
    const prompt=text(body.prompt,8000);
    if(!prompt.trim())throw new HttpError(400,{code:'PROMPT_REQUIRED',key:'overlays.error.promptRequired',
      message:'test needs a prompt'});
    const matcher=await this.module('overlay-matcher');
    const handle=matcher.oneShotMatcher();
    try{
      return await gate.explainRecall({prompt,compareBuiltin:body.compareBuiltin===true},handle);
    }finally{try{handle.dispose();}catch{}}
  }
  /**
   * 모델 0회 시뮬레이션 (§3.8 1단계): 저장된 기억·최근 교환에 **운영과 같은 matcher worker로**
   * 금지 패턴을 돌려 "무엇이 차단되는가"를 결정적으로 보여준다. 이미 저장된 것은 바뀌지 않고,
   * `exclude_topics`·결정 힌트·선호 언어는 **로컬에서 판정할 수 없다**는 사실을 그대로 싣는다.
   */
  async overlaySimulate(rules,body){
    const loaded=rules.loadExtractionRules();
    const resolved=rules.resolveExtractionRules(typeof body.projectId==='string'?body.projectId:null,loaded);
    const report={
      rulesHash:loaded.hash,
      clause:(clause=>({chars:clause.length,text:clause}))(rules.renderExtractionConstraintClause(resolved)),
      verifierUnchanged:true,
      enforcementPoints:[...rules.EXTRACTION_RULE_ENFORCEMENT_POINTS],
      existingFacts:{scanned:0,wouldBeBlocked:[]},
      recentExchanges:{scanned:0,matched:[]},
      matcher:{elapsedMs:0,timedOut:false,unavailable:false,quarantined:[]},
      advisoryOnly:{excludeTopics:resolved.excludeTopics,decisionHints:resolved.decisionHints.map(p=>p.id),
        preferredLanguage:resolved.preferredLanguage},
      available:true,
    };
    if(!fs.existsSync(this.dbPath))throw new HttpError(503,{code:'DB_INDEX_MISSING',key:'overlays.error.dbMissing',
      message:'the index database is missing, so there is nothing to simulate against'});
    if(resolved.neverExtract.length===0)return report;
    const store=await this.connect();
    const facts=store.all(`SELECT id, fact, fact_kr, category FROM facts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 200`);
    const exchanges=store.all(`SELECT id, session_id, user_message, assistant_message FROM exchanges ORDER BY timestamp DESC LIMIT 50`);
    report.existingFacts.scanned=facts.length;
    report.recentExchanges.scanned=exchanges.length;
    const matcher=await this.module('overlay-matcher');
    const handle=matcher.oneShotMatcher();
    try{
      const candidates=[
        ...facts.map(f=>({item:{kind:'fact',row:f},candidate:{factText:[f.fact,f.fact_kr].filter(Boolean),evidence:[]}})),
        ...exchanges.map(e=>({item:{kind:'exchange',row:e},
          candidate:{factText:[],evidence:[e.user_message,e.assistant_message].filter(Boolean)}})),
      ];
      const bulk=await rules.buildBlockSet(handle,resolved.neverExtract,candidates,'web-ui');
      if(!bulk.ok){
        report.available=false;report.reason=bulk.reason;report.detail=bulk.detail;
        report.matcher.quarantined=bulk.quarantined;
        report.matcher.timedOut=bulk.reason==='extraction_rules_unavailable';
        return report;
      }
      report.matcher.elapsedMs=bulk.elapsedMs;
      // 어느 규칙이 막았는지는 **막힌 항목만** 1건씩 다시 돌려 귀속한다(운영 경로는 집합만 필요하다).
      for(const entry of candidates){
        if(!bulk.blocked.has(entry.item))continue;
        const one=await rules.buildBlockSet(handle,resolved.neverExtract,[entry],'web-ui');
        const patternId=one.ok?(one.patternIds[0]??null):null;
        if(entry.item.kind==='fact')report.existingFacts.wouldBeBlocked.push({id:entry.item.row.id,
          category:entry.item.row.category,patternId,preview:String(entry.item.row.fact||'').slice(0,160)});
        else report.recentExchanges.matched.push({exchangeId:entry.item.row.id,sessionId:entry.item.row.session_id,
          patternId,preview:String(entry.item.row.user_message||entry.item.row.assistant_message||'').slice(0,160)});
        if(report.existingFacts.wouldBeBlocked.length+report.recentExchanges.matched.length>=50)break;
      }
    }finally{try{handle.dispose();}catch{}}
    return report;
  }
  /**
   * 쓰기 네 갈래. 전부 `overlay-admin`의 lock + revision CAS를 지나며, 추출 규칙은 **lane C의
   * 검증기와 빈 문서**를 요구하는 래퍼(`extraction-rules`의 set/reset/rollback)를 쓴다. 규칙 쓰기가
   * 성공하면 그 래퍼가 `releaseExtractionRulesHold(db)`로 대기 작업을 함께 푼다.
   */
  async overlayWrite(overlay,action,gate,rules,body){
    const admin=await this.overlayModule('overlay-admin');
    const name=overlay==='gate'?'recall-gate':'extraction-rules';
    const expectedRevision=body.expectedRevision===undefined||body.expectedRevision===null
      ?undefined:Number(body.expectedRevision);
    if(expectedRevision!==undefined&&!Number.isInteger(expectedRevision))
      throw new HttpError(400,{code:'INVALID_REVISION',key:'overlays.error.invalidRevision',message:'expectedRevision must be an integer'});
    let writer=null;
    const db=()=>{
      if(writer||overlay!=='rules'||!fs.existsSync(this.dbPath))return writer;
      try{writer=this.openOverlayWriteDb();}catch{writer=null;}
      return writer;
    };
    try{
      if(action==='quarantine-clear'){
        const all=body.all===true;
        const patternId=all?undefined:text(body.patternId,200).trim();
        if(!all&&!patternId)throw new HttpError(400,{code:'PATTERN_REQUIRED',key:'overlays.error.patternRequired',
          message:'quarantine-clear needs a patternId or all:true'});
        return await admin.clearQuarantine(patternId,{surface:'web-ui'});
      }
      if(action==='reset'){
        if(overlay==='rules')return await rules.resetExtractionRules({surface:'web-ui',expectedRevision,db:db()});
        return await admin.resetOverlay('recall-gate',{surface:'web-ui',expectedRevision,
          ...(body.intent?{intent:String(body.intent)}:{})});
      }
      if(action==='rollback'){
        const revision=Number(body.revision);
        if(!Number.isInteger(revision)||revision<1)throw new HttpError(400,{code:'INVALID_REVISION',key:'overlays.error.invalidRevision',
          message:'rollback needs the revision to restore'});
        if(overlay==='rules')return await rules.rollbackExtractionRules(revision,{surface:'web-ui',expectedRevision,db:db()});
        return await admin.rollbackOverlay('recall-gate',revision,{surface:'web-ui',expectedRevision});
      }
      if(action==='set'){
        if(overlay!=='rules')throw new HttpError(400,{code:'INVALID_ACTION',key:'overlays.error.rulesOnly',
          message:'set applies to the extraction-rules overlay only'});
        if(body.doc===null||typeof body.doc!=='object')throw new HttpError(400,{code:'INVALID_DOCUMENT',key:'overlays.error.invalidDocument',
          message:'set needs a doc object'});
        // 전체 문서 경로는 갱신 유실을 막기 위해 파일이 있으면 expectedRevision이 필수다 (§1.5).
        if(expectedRevision===undefined&&rules.currentExtractionRulesRevision()>0)
          throw new HttpError(400,{code:'EXPECTED_REVISION_REQUIRED',key:'overlays.error.expectedRevisionRequired',
            message:'set needs expectedRevision when a rules file already exists'});
        return await rules.setExtractionRules(body.doc,{surface:'web-ui',expectedRevision,db:db()});
      }
      // patch — 한 호출 = 한 가지 변경. 감사 줄과 히스토리 항목이 무엇이 바뀌었는지 말할 수 있어야 한다.
      if(overlay!=='gate')throw new HttpError(400,{code:'INVALID_ACTION',key:'overlays.error.gateOnly',
        message:'patch applies to the recall-gate overlay only'});
      return await this.overlayGatePatch(admin,gate,body,expectedRevision);
    }catch(e){throw this.overlayError(e,name);}
    finally{if(writer){try{writer.close();}catch{}}}
  }
  /** 규칙 쓰기의 HOLD 해제용 쓰기 연결. 없으면 null이고, 그때는 1시간 안전망이 복구한다. */
  openOverlayWriteDb(){
    const better=require(path.join(this.root,'node_modules','better-sqlite3'));
    return new better(this.dbPath);
  }
  async overlayGatePatch(admin,gate,body,expectedRevision){
    const add=Array.isArray(body.patternsAdd)?body.patternsAdd:[];
    const disable=Array.isArray(body.patternsDisable)?body.patternsDisable:[];
    const enable=Array.isArray(body.patternsEnable)?body.patternsEnable:[];
    const words=body.words&&typeof body.words==='object'?body.words:null;
    const chosen=[add.length?'add':null,disable.length?'disable':null,enable.length?'enable':null,words?'words':null].filter(Boolean);
    if(chosen.length!==1)throw new HttpError(400,{code:'INVALID_PATCH',key:'overlays.error.invalidPatch',
      message:'a patch carries exactly one of patternsAdd, patternsDisable, patternsEnable, words'});
    if(chosen[0]==='add'){
      const input=add[0];
      if(!input||typeof input!=='object')throw new HttpError(400,{code:'INVALID_PATTERN',key:'overlays.error.invalidPattern',
        message:'patternsAdd needs {intent, source}'});
      return admin.addGatePattern({intent:String(input.intent||''),source:text(input.source,400),
        flags:input.flags===undefined?undefined:text(input.flags,8),
        ...(input.note?{note:text(input.note,200)}:{})},{surface:'web-ui',expectedRevision});
    }
    if(chosen[0]==='disable')return admin.disableGatePattern(text(disable[0],400),{surface:'web-ui',expectedRevision});
    if(chosen[0]==='enable'){
      // `disable`의 역연산은 `patterns.disable`에서 id를 빼는 것이다 — 내장 항목은 카탈로그에 남는다.
      const id=text(enable[0],400);
      if(!gate.loadRecallGateOverlay().disabled.includes(id))
        throw new HttpError(422,{code:'PATTERN_NOT_DISABLED',key:'overlays.error.patternNotDisabled',params:{id},
          message:`${id} is not disabled`,details:{issues:[{field:'patternId',key:'overlays.error.patternNotDisabled',params:{id}}]}});
      return admin.applyOverlayChange('recall-gate',{delta:{patternsRemove:[id]}},
        {surface:'web-ui',expectedRevision,probe:false,auditAction:'gate.pattern-enable',history:{removed:[id]}});
    }
    const lexicon=String(words.lexicon||'');
    if(!['ack','continue','filler'].includes(lexicon))throw new HttpError(400,{code:'INVALID_LEXICON',key:'overlays.error.invalidLexicon',
      message:'words.lexicon must be ack, continue or filler'});
    const list=key=>Array.isArray(words[key])?words[key].map(w=>text(w,32)).filter(Boolean):undefined;
    const change={add:list('add'),disable:list('disable'),removeAdd:list('removeAdd'),removeDisable:list('removeDisable')};
    if(!Object.values(change).some(v=>v&&v.length))throw new HttpError(400,{code:'INVALID_PATCH',key:'overlays.error.invalidPatch',
      message:'words needs at least one of add, disable, removeAdd, removeDisable'});
    return admin.setGateWords(lexicon,change,{surface:'web-ui',expectedRevision});
  }
  /**
   * 코어의 오버레이 오류를 HTTP로 옮긴다. 이름으로 분기한다 — `extraction-rules`가 동적 import로
   * 가져온 클래스와 이 서버가 본 클래스가 같은 모듈 인스턴스라는 보장이 없으므로 instanceof는
   * 조용히 실패할 수 있다.
   */
  overlayError(e,overlay){
    if(e instanceof HttpError)return e;
    // 코어의 영어 한 줄은 로그·curl용으로 `message`에 실리고, 사용자가 읽는 문장은 `key`가 만든다
    // (패스스루가 아니다 — 아래 OVERLAY_REJECTED 하나만 key:null이다).
    const line=e&&e.message?e.message:String(e);
    if(e&&e.name==='OverlayInvalidError')return new HttpError(422,{code:'OVERLAY_INVALID',key:'overlays.error.overlayInvalid',
      params:{count:(e.issues||[]).filter(i=>i.severity!=='warning').length},message:line,details:{issues:e.issues||[]}});
    if(e&&e.name==='OverlayStaleError')return new HttpError(409,{code:'OVERLAY_STALE',key:'overlays.error.overlayStale',
      params:{current:e.currentRevision,expected:e.expectedRevision},message:line});
    if(e&&e.name==='OverlayLockedError')return new HttpError(409,{code:'OVERLAY_LOCKED',key:'overlays.error.overlayLocked',
      params:{pid:e.holderPid===null?0:e.holderPid},message:line});
    // 분류되지 않은 코어 원문은 key:null로 통과시킨다 — 그 문장이 유일한 진단 정보다 (§5.2).
    return new HttpError(422,{code:'OVERLAY_REJECTED',key:null,params:{overlay},message:line});
  }
  close(){if(this.db){try{this.db.close();}catch{}this.db=null;}}
}
/** `/api/v2/models` 본문의 action. preview-embedding·set-embedding은 #118(이후 0.7.x)이다. */
Core.MODEL_ACTIONS=['status','set-llm','test','reset'];
/** `/api/v2/overlays` 본문의 action (§4.1). 하위 경로는 만들지 않는다 — sync·models와 같은 규칙. */
Core.OVERLAY_ACTIONS=['status','validate','test','simulate','patch','set','reset','rollback','quarantine-clear'];
Core.OVERLAY_WRITE_ACTIONS=new Set(['patch','set','reset','rollback','quarantine-clear']);
module.exports={Core};
