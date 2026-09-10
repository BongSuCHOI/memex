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
    return m.getPipelineStatus({dbPath:this.dbPath});
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
    if(action!=='status'&&(this.busy.size||this.syncBusy))throw new HttpError(409,{code:'MUTATION_BUSY',key:'models.error.mutation_busy',
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
    if(body.model!==undefined&&body.model!==null&&text(body.model,256).trim()!==''){
      const model=text(body.model,256).trim();
      if(!settings.isValidModelId(model))throw new HttpError(422,{code:'INVALID_MODEL_ID',key:'models.error.invalid_model_id',
        params:{value:model},message:`invalid model id ${JSON.stringify(model)} — expected 1-256 characters matching [\\w./:@+-]`,
        details:{issues:[{field:'model',key:'models.error.invalid_model_id',params:{value:model}}]}});
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
  /** 0.7.0의 임베딩은 읽기 전용이다. 측정하지 않은 차원을 주장하지 않는다(0.7.1). */
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
  close(){if(this.db){try{this.db.close();}catch{}this.db=null;}}
}
/** `/api/v2/models` 본문의 action. 0.7.1이 preview-embedding·set-embedding을 더한다. */
Core.MODEL_ACTIONS=['status','set-llm','test','reset'];
module.exports={Core};
