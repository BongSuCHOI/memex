'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {pathToFileURL}=require('node:url');
const {Store}=require('./store.cjs');const {HttpError,text,identifier}=require('./util.cjs');
/** `/api/v2/sync` 본문의 action. 0.6.3에서 수동 세대 파일과 기기 별칭이 추가됐다 (#48). */
const SYNC_ACTIONS=['status','enable','disable','export','import','archive-export','archive-preview','archive-import','alias'];
const ARCHIVE_SERVICES=['exportGenerationArchive','previewImportArchive','importArchive','setDeviceAlias'];
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
    if(!SYNC_ACTIONS.includes(action))throw new HttpError(400,'지원하지 않는 동기화 작업입니다.');
    if(this.syncBusy)throw new HttpError(409,'동기화 작업이 이미 진행 중입니다.','SYNC_BUSY');
    if(action!=='status'&&this.busy.size)throw new HttpError(409,'기억 변경이 진행 중입니다. 완료 후 실행하세요.','MUTATION_BUSY');
    this.syncBusy=true;
    try{
      return await this.pinned(async()=>{
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
        if(action!=='export'&&action!=='import'){
          for(const fn of ARCHIVE_SERVICES)
            if(typeof m[fn]!=='function')throw new HttpError(503,'설치된 코어에 세대 파일·기기 별칭 서비스가 없습니다. 코어를 빌드하세요.','CORE_UNAVAILABLE');
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
          if(!source)throw new HttpError(400,'세대 파일(zip) 또는 세대 디렉터리의 절대 경로를 입력하세요.');
          if(!path.isAbsolute(source)||/[\x00-\x1f]/.test(source))throw new HttpError(400,'세대 파일 경로는 정규화 가능한 절대 경로여야 합니다.','INVALID_ARCHIVE_PATH');
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
      if(/not writable/.test(e.message))throw new HttpError(400,'공유 폴더에 쓸 수 없습니다. 경로와 권한을 확인하세요: '+e.message,'SYNC_DIR_UNWRITABLE');
      // 코어의 세대 파일 거부 사유는 사용자가 고칠 수 있는 입력 문제다. 원문을 그대로 전달한다.
      if(/^sync archive /.test(e.message))throw new HttpError(400,e.message,'INVALID_ARCHIVE');
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
    if(!['promote','demote'].includes(action))throw new HttpError(400,'지원하지 않는 계층 이동입니다.');
    if(this.busy.has(id))throw new HttpError(409,'이 기억에 대한 변경이 이미 진행 중입니다.','MUTATION_BUSY');
    // #96 — sync()가 busy를 보고 거절하는 것과 대칭. 같은 쪽만 막으면 동기화와 변경이 겹친다.
    if(this.syncBusy)throw new HttpError(409,'동기화 작업이 진행 중입니다. 완료 후 실행하세요.','SYNC_BUSY');
    this.busy.add(id);let writer;
    try{
      return await this.pinned(async()=>{
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
      });
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
    // #96 — sync()가 busy를 보고 거절하는 것과 대칭. 같은 쪽만 막으면 동기화와 변경이 겹친다.
    if(this.syncBusy)throw new HttpError(409,'동기화 작업이 진행 중입니다. 완료 후 실행하세요.','SYNC_BUSY');
    const store=await this.connect();const current=store.visibleFact(id,scope);
    if(body.expectedUpdatedAt&&current.updated_at!==body.expectedUpdatedAt)throw new HttpError(409,'기억이 다른 작업에서 변경됐습니다. 새로고침한 뒤 다시 확인하세요.','STALE_FACT');
    if(body.expectedText!==undefined&&current.fact!==body.expectedText)throw new HttpError(409,'기억 내용이 변경됐습니다. 새로고침하세요.','STALE_FACT');
    if(action==='edit'&&(typeof body.text!=='string'||body.text.trim().length<4||body.text.length>20000))throw new HttpError(400,'기억 내용은 4–20,000자로 입력하세요.');
    if(action==='delete'&&(!body.confirm||body.confirmId!==id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))throw new HttpError(400,'영향을 확인한 뒤 전체 UUID를 정확히 입력하세요.','CONFIRMATION_REQUIRED');
    this.busy.add(id);let writer;
    try{
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
    }catch(e){if(e.name==='StaleFactMutationError')throw new HttpError(409,e.message,'STALE_FACT');throw e;}
    finally{this.busy.delete(id);if(writer&&writer!==this.db){try{writer.close();}catch{}}}
  }
  close(){if(this.db){try{this.db.close();}catch{}this.db=null;}}
}
module.exports={Core};
