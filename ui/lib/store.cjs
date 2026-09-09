'use strict';
/** Read-only projection over the Memex 0.4.2 schema. All writes live in core.cjs. */
const { HttpError, integer, text, identifier, sqlName, parseJSON, array, cleanRow, canonicalProject } = require('./util.cjs');
const FACT_FIELDS = ['id','fact','fact_kr','category','scope_type','scope_project','project_id','workspace_id','workstream_id','promotion_state','tier_reason','subject_key','is_active','ontology_category_id','source_exchange_ids','consolidated_count','created_at','updated_at','semantic_generation','lifecycle_generation','embedding_version','needs_consolidation'];
// facts.promotion_state values that src/fact-management.ts factTierOf() reads back as the project rung.
const PROJECT_TIER_STATES = ['legacy-project','decision','project-current'];
const EXCHANGE_FIELDS = ['id','project','project_id','workspace_id','workstream_id','session_id','timestamp','user_message','assistant_message','cwd','git_branch','archive_path','line_start','line_end','exchange_seq','content_generation','content_hash','closure_state','provenance'];
const TYPES = ['SUPPORTS','INFLUENCES','SUPERSEDES','CONTRADICTS'];
class Store {
  constructor(db) { this.db = db; this.schema = new Map(); this.refreshSchema(); }
  refreshSchema() {
    const version = this.one('PRAGMA schema_version')?.schema_version;
    if (version === this.schemaVersion) return;
    this.schemaVersion = version; this.schema.clear();
    for (const r of this.all("SELECT name FROM sqlite_master WHERE type IN ('table','view')")) {
      if (/^[a-z_][a-z0-9_]*$/i.test(r.name)) this.schema.set(r.name, new Set(this.all(`PRAGMA table_info(${sqlName(r.name)})`).map(x => x.name)));
    }
  }
  has(table, column) { return column ? !!this.schema.get(table)?.has(column) : this.schema.has(table); }
  all(sql, args = []) { return this.db.prepare(sql).all(...args).map(cleanRow); }
  one(sql, args = []) { return cleanRow(this.db.prepare(sql).get(...args)); }
  count(sql, args = []) { return Number(this.one(sql, args)?.n ?? 0); }
  select(table, fields, alias = '') { return fields.map(f => this.has(table, f) ? `${alias ? alias + '.' : ''}${sqlName(f)}` : `NULL AS ${sqlName(f)}`).join(','); }
  require(table) { if (!this.has(table)) throw new HttpError(503, `${table} 테이블이 없습니다. 설치된 코어의 초기화·마이그레이션 상태를 확인하세요.`, 'SCHEMA_UNAVAILABLE'); }
  missing(table) { return { available: false, reason: `${table} 기록이 이 데이터베이스에 없습니다.`, items: [], total: null, limit: 50, offset: 0 }; }
  paginate(q, fallback = 50, max = 200) { return { limit: integer(q.get('limit'), fallback, 1, max), offset: integer(q.get('offset'), 0, 0, 1_000_000) }; }
  page(from, where, args, order, q, fields = '*') {
    const { limit, offset } = this.paginate(q);
    const total = this.count(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`, args);
    const items = this.all(`SELECT ${fields} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, limit, offset]);
    return { available: true, items, total, limit, offset };
  }
  scope(q) {
    const type = q.get('scope') || (q.get('project') ? 'project' : 'global');
    if (!['project','global','all'].includes(type)) throw new HttpError(400, 'scope: project | global | all', 'INVALID_SCOPE');
    if (type !== 'project' && q.get('project')) throw new HttpError(400, 'project는 project 범위에서만 허용됩니다.', 'INVALID_SCOPE');
    // tiers=all drops the promotion-state predicate so a project screen can show its branch and
    // workspace tier memories too. It never widens the project identity itself.
    const tiers = q.get('tiers') || 'default';
    if (!['default','all'].includes(tiers)) throw new HttpError(400, 'tiers: default | all', 'INVALID_SCOPE');
    const s = { type, tiers, includeGlobal: q.get('includeGlobal') !== '0', project: null, projectId: null, workspaceId: q.get('workspace') || null, workstreamId: q.get('workstream') || null };
    if (type !== 'project' && (s.workspaceId || s.workstreamId)) throw new HttpError(400, '작업 범위에는 프로젝트가 필요합니다.', 'INVALID_SCOPE');
    if (type === 'project') {
      s.project = canonicalProject(q.get('project'));
      if (this.has('workspaces','project_id')) {
        const identities = this.all('SELECT DISTINCT project_id FROM workspaces WHERE canonical_path = ?', [s.project]);
        if (identities.length > 1) throw new HttpError(409, '동일 경로에 여러 프로젝트 ID가 있습니다. CLI에서 프로젝트 식별자를 확인하세요.', 'AMBIGUOUS_PROJECT');
        s.projectId = identities[0]?.project_id || null;
      }
      for (const [id, table, key] of [[s.workspaceId,'workspaces','workspace_id'],[s.workstreamId,'minimal_workstreams','workstream_id']]) {
        if (!id) continue;
        if (!s.projectId || !this.has(table,'project_id')) throw new HttpError(400, '이 데이터베이스에서 작업 범위를 확인할 수 없습니다.', 'INVALID_SCOPE');
        const row = this.one(`SELECT project_id FROM ${sqlName(table)} WHERE ${sqlName(key)}=?`, [id]);
        if (!row || row.project_id !== s.projectId) throw new HttpError(403, '다른 프로젝트의 작업 범위입니다.', 'SCOPE_MISMATCH');
      }
      if (s.workspaceId && s.workstreamId && this.has('minimal_workstreams','workspace_id')) {
        const ws = this.one('SELECT workspace_id FROM minimal_workstreams WHERE workstream_id=?',[s.workstreamId]);
        if (ws?.workspace_id && ws.workspace_id !== s.workspaceId) throw new HttpError(403,'작업 흐름과 워크스페이스가 다릅니다.','SCOPE_MISMATCH');
      }
    }
    return s;
  }
  factWhere(s, a = 'f') {
    if (s.type === 'all') return ['1=1', []];
    if (s.type === 'global') return [`${a}.scope_type='global'`, []];
    const args = [s.project];
    let identity = `${a}.scope_project=?`;
    if (s.projectId && this.has('facts','project_id')) { identity = `((${identity} AND ${a}.project_id IS NULL) OR ${a}.project_id=?)`; args.push(s.projectId); }
    let local = `(${a}.scope_type='project' AND ${identity})`;
    if (this.has('facts','promotion_state') && s.tiers !== 'all') {
      // Project-wide truth, mirroring src/chronicle.ts PROJECT_TRUTH and the
      // facts.promotion_state default ('legacy-project'). 'project' is not a
      // value the core ever writes.
      let level = `COALESCE(${a}.promotion_state,'legacy-project') IN (${PROJECT_TIER_STATES.map(x => `'${x}'`).join(',')})`;
      if (s.workspaceId && this.has('facts','workspace_id')) { level += ` OR (${a}.promotion_state='workspace' AND ${a}.workspace_id=?)`; args.push(s.workspaceId); }
      if (s.workstreamId && this.has('facts','workstream_id')) { level += ` OR (${a}.promotion_state='workstream' AND ${a}.workstream_id=?)`; args.push(s.workstreamId); }
      local += ` AND (${level})`;
    }
    return [s.includeGlobal ? `((${local}) OR ${a}.scope_type='global')` : `(${local})`, args];
  }
  /**
   * Same-project memories the current predicate leaves out, grouped by promotion_state.
   * Always measured against the default predicate, so the count stays visible (and the toggle
   * stays reversible) while tiers=all is on. null when the question does not apply.
   */
  hiddenByTier(s) {
    if (s.type !== 'project' || !this.has('facts') || !this.has('facts','promotion_state')) return null;
    const [everyTier, ep] = this.factWhere({ ...s, tiers: 'all', includeGlobal: false });
    const [visible, vp] = this.factWhere({ ...s, tiers: 'default', includeGlobal: false });
    const counts = { workstream: 0, workspace: 0 };
    for (const r of this.all(`SELECT f.promotion_state AS tier, COUNT(*) AS n FROM facts f WHERE f.is_active=1 AND (${everyTier}) AND NOT (${visible}) GROUP BY f.promotion_state`, [...ep, ...vp])) {
      if (Object.hasOwn(counts, r.tier)) counts[r.tier] = Number(r.n || 0);
    }
    return counts;
  }
  /** Branch name behind a workstream-tier memory. Never guessed: absent rows stay null. */
  workstreamBranches(ids) {
    const unique = [...new Set(ids.filter(x => typeof x === 'string' && x))];
    if (!unique.length || !this.has('minimal_workstreams','branch_hint')) return new Map();
    const rows = this.all('SELECT workstream_id, branch_hint FROM minimal_workstreams WHERE workstream_id IN (SELECT value FROM json_each(?))', [JSON.stringify(unique)]);
    return new Map(rows.map(r => [r.workstream_id, r.branch_hint || null]));
  }
  withBranches(items) {
    const branches = this.workstreamBranches(items.map(x => x.workstream_id));
    for (const item of items) item.workstream_branch = branches.get(item.workstream_id) ?? null;
    return items;
  }
  exchangeWhere(s, a = 'e') {
    if (s.type === 'all') return ['1=1', []];
    if (s.type === 'global') return ['0=1', []]; // Conversations do not have a global scope.
    const args = [s.project]; let w = `${a}.project=?`;
    if (s.projectId && this.has('exchanges','project_id')) { w = `((${w} AND ${a}.project_id IS NULL) OR ${a}.project_id=?)`; args.push(s.projectId); }
    if (s.workspaceId) {
      if (!this.has('exchanges','workspace_id')) return ['0=1', []];
      w += ` AND ${a}.workspace_id=?`; args.push(s.workspaceId);
    }
    if (s.workstreamId) {
      if (!this.has('exchanges','workstream_id')) return ['0=1', []];
      w += ` AND ${a}.workstream_id=?`; args.push(s.workstreamId);
    }
    return [w, args];
  }
  sessionExists(s, expression) {
    const [w,p] = this.exchangeWhere(s);
    return [`EXISTS (SELECT 1 FROM exchanges e WHERE e.session_id=${expression} AND ${w})`,p];
  }
  projects() {
    this.require('exchanges');
    const rows = this.all(`SELECT project, COUNT(*) AS exchanges, COUNT(DISTINCT session_id) AS sessions, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen FROM exchanges GROUP BY project ORDER BY last_seen DESC`);
    if (this.has('facts','scope_project')) {
      const known = new Set(rows.map(x => x.project));
      for (const r of this.all("SELECT DISTINCT scope_project AS project FROM facts WHERE scope_type='project' AND scope_project IS NOT NULL")) if (!known.has(r.project)) { rows.push({ ...r, exchanges:0, sessions:0 }); known.add(r.project); }
    }
    if (this.has('workspaces','canonical_path')) {
      const known = new Set(rows.map(x => x.project));
      for (const r of this.all('SELECT canonical_path AS project, project_id, workspace_id FROM workspaces ORDER BY last_seen_at DESC')) {
        if (!known.has(r.project)) { rows.push({ ...r, exchanges:0, sessions:0 }); known.add(r.project); }
      }
    }
    const list = rows.filter(r => r.project && r.project.startsWith('/')).map(r => ({ ...r, name: r.project.split('/').filter(Boolean).pop() || '/' }));
    // Scope selector counts. Identity resolution mirrors factWhere(): a stable project_id wins,
    // and a path-only row counts only while it carries no project_id of its own.
    if (this.has('facts', 'scope_project')) {
      const idByPath = new Map();
      if (this.has('workspaces', 'project_id')) for (const w of this.all('SELECT canonical_path, project_id FROM workspaces')) if (w.project_id && !idByPath.has(w.canonical_path)) idByPath.set(w.canonical_path, w.project_id);
      const byId = new Map(), byPath = new Map();
      const hasId = this.has('facts', 'project_id');
      for (const r of this.all(`SELECT f.scope_project AS project, ${hasId ? 'f.project_id' : 'NULL AS project_id'}, COUNT(*) AS n FROM facts f WHERE f.scope_type='project' AND f.is_active=1 GROUP BY f.scope_project, ${hasId ? 'f.project_id' : "''"}`)) {
        const n = Number(r.n || 0);
        if (r.project_id) byId.set(r.project_id, (byId.get(r.project_id) || 0) + n);
        else if (r.project) byPath.set(r.project, (byPath.get(r.project) || 0) + n);
      }
      for (const row of list) {
        const projectId = row.project_id || idByPath.get(row.project) || null;
        row.facts = (projectId ? byId.get(projectId) || 0 : 0) + (byPath.get(row.project) || 0);
      }
    }
    return list;
  }
  /** Totals behind the scope selector labels. Active facts only; null when the table is absent. */
  factTotals() {
    if (!this.has('facts')) return null;
    return { all: this.count('SELECT COUNT(*) AS n FROM facts WHERE is_active=1'), global: this.count("SELECT COUNT(*) AS n FROM facts WHERE is_active=1 AND scope_type='global'") };
  }
  scopeOptions(s) {
    if (!s.projectId) return { workspaces: [], workstreams: [] };
    return {
      workspaces: this.has('workspaces') ? this.all('SELECT workspace_id, canonical_path, branch FROM workspaces WHERE project_id=?',[s.projectId]) : [],
      workstreams: this.has('minimal_workstreams','project_id') ? this.all(`SELECT ${this.select('minimal_workstreams',['workstream_id','session_id','branch_hint','workspace_id'])} FROM minimal_workstreams WHERE project_id=? ORDER BY updated_at DESC LIMIT 200`,[s.projectId]) : [],
    };
  }
  factFilters(q,s) {
    let [w,p] = this.factWhere(s);
    const active = q.get('state') || 'active';
    if (!['all','active','inactive'].includes(active)) throw new HttpError(400,'잘못된 기억 상태입니다.');
    if (active !== 'all') { w += ' AND f.is_active=?'; p.push(active === 'active' ? 1 : 0); }
    const search = text(q.get('q'));
    if (search) { w += ` AND (instr(lower(f.fact),lower(?))>0${this.has('facts','fact_kr') ? ' OR instr(lower(COALESCE(f.fact_kr,\'\')),lower(?))>0' : ''})`; p.push(search); if(this.has('facts','fact_kr')) p.push(search); }
    if (q.get('category')) { w += ' AND f.category=?'; p.push(text(q.get('category'))); }
    if (q.get('taxonomy')) {
      if (q.get('taxonomy') === 'unclassified') w += ' AND f.ontology_category_id IS NULL';
      else { w += ' AND f.ontology_category_id=?'; p.push(identifier(q.get('taxonomy'))); }
    }
    return [w,p];
  }
  facts(q,s) {
    this.require('facts'); const [w,p] = this.factFilters(q,s);
    const order = q.get('sort') === 'created' ? 'f.created_at DESC,f.id DESC' : q.get('sort') === 'sources' ? 'f.consolidated_count DESC,f.id DESC' : 'f.updated_at DESC,f.id DESC';
    const page = this.page('facts f',w,p,order,q,this.select('facts',FACT_FIELDS,'f'));
    page.items = this.withBranches(page.items.map(r => ({...r, source_count:array(r.source_exchange_ids).length})));
    // Lets the client tell "this scope stores nothing" from "the filters exclude everything".
    const [sw,sp] = this.factWhere(s);
    page.scopeTotal = this.count(`SELECT COUNT(*) AS n FROM facts f WHERE ${sw}`,sp);
    page.hiddenByTier = this.hiddenByTier(s);
    page.tiers = s.tiers;
    return page;
  }
  visibleFact(id,s) {
    this.require('facts'); const [w,p] = this.factWhere(s);
    const f = this.one(`SELECT ${this.select('facts',FACT_FIELDS,'f')} FROM facts f WHERE f.id=? AND ${w}`,[identifier(id),...p]);
    if (!f) throw new HttpError(404,'현재 범위에서 기억을 찾을 수 없습니다.','NOT_FOUND');
    return this.withBranches([f])[0];
  }
  fact(id,s) {
    const f = this.visibleFact(id,s);
    const ids = array(f.source_exchange_ids).filter(x => typeof x === 'string');
    // Source text is scope checked, even for a globally-visible fact.
    const [ew,ep] = this.exchangeWhere(s);
    const sources = [];
    for (const sourceId of ids.slice(0,500)) {
      const row = this.one(`SELECT ${this.select('exchanges',EXCHANGE_FIELDS,'e')} FROM exchanges e WHERE e.id=? AND ${ew}`, [sourceId,...ep]);
      if (row) sources.push({...row, user_message:row.user_message?.slice(0,1000), assistant_message:undefined});
      else sources.push({id:sourceId,unavailable:true,reason:'현재 범위 밖이거나 원문이 없습니다.'});
    }
    let context = [];
    if(this.has('fact_context_dependencies')) context = this.all(`SELECT d.*, e.project,e.session_id,e.timestamp,substr(e.user_message,1,500) AS user_message FROM fact_context_dependencies d JOIN exchanges e ON e.id=d.exchange_id WHERE d.fact_id=? AND ${ew} ORDER BY d.created_at LIMIT 200`,[id,...ep]);
    const [fw,fp] = this.factWhere(s,'other');
    const relations = this.has('ontology_relations') ? this.all(`SELECT r.*,other.fact AS other_fact,other.id AS other_id FROM ontology_relations r JOIN facts other ON other.id=CASE WHEN r.source_fact_id=? THEN r.target_fact_id ELSE r.source_fact_id END WHERE (r.source_fact_id=? OR r.target_fact_id=?) AND ${fw} ORDER BY r.created_at DESC LIMIT 200`,[id,id,id,...fp]) : [];
    const revisions = this.has('fact_revisions') ? this.all('SELECT * FROM fact_revisions WHERE fact_id=? ORDER BY created_at DESC,id DESC LIMIT 200',[id]) : [];
    let receipt = this.has('fact_evidence_receipts') ? this.one('SELECT * FROM fact_evidence_receipts WHERE fact_id=?',[id]) : null;
    // Do not disclose cross-scope archived source snapshots.
    if(receipt) { receipt = {...receipt, source_snapshot_json:undefined, source_snapshot_available:true}; }
    const recallPage = this.recalls(new URLSearchParams({fact:id,limit:'100'}),s);
    return { ...f, sources, context_dependencies:context, revisions, relations, receipt, recalls:recallPage.items, source_total:ids.length,
      limits:{sources:500,revisions:200,relations:200,recalls:100}, provenance_parse_valid:Array.isArray(parseJSON(f.source_exchange_ids, null)) };
  }
  searchClause(q) {
    const search = text(q.get('q')); if(!search) return ['1=1',[],'recent'];
    const ftsReady = this.has('fts_meta') && this.has('exchanges_fts') && this.one("SELECT value FROM fts_meta WHERE key='exchanges_fts_built'")?.value === '1';
    const tokens = search.match(/[\p{L}\p{N}_]+/gu)?.slice(0,20);
    if(ftsReady && tokens?.length && q.get('searchMode') !== 'contains') return ['e.rowid IN (SELECT rowid FROM exchanges_fts WHERE exchanges_fts MATCH ?)',[tokens.map(t=>'"'+t.replaceAll('"','""')+'"').join(' AND ')],'fts'];
    return ["(instr(lower(e.user_message),lower(?))>0 OR instr(lower(e.assistant_message),lower(?))>0)",[search,search],'contains'];
  }
  sessions(q,s) {
    this.require('exchanges'); const [w,p] = this.exchangeWhere(s); const [search,sp,engine] = this.searchClause(q); const {limit,offset} = this.paginate(q,30);
    const args = [...p,...sp]; let where = `${w} AND e.session_id IS NOT NULL AND ${search}`;
    if(q.get('from')) { where+=' AND e.timestamp>=?'; args.push(text(q.get('from'),40)); }
    if(q.get('to')) { where+=' AND e.timestamp<=?'; args.push(text(q.get('to'),40)+'T23:59:59.999Z'); }
    const base = `FROM exchanges e WHERE ${where} GROUP BY e.session_id,e.project`;
    const total = this.count(`SELECT COUNT(*) AS n FROM (SELECT 1 ${base})`,args);
    const items = this.all(`SELECT e.session_id,e.project,COUNT(*) AS exchanges,MIN(e.timestamp) AS started_at,MAX(e.timestamp) AS ended_at,MAX(e.git_branch) AS branch ${base} ORDER BY ended_at DESC,e.session_id DESC LIMIT ? OFFSET ?`,[...args,limit,offset]);
    for(const r of items) {
      r.title = this.one('SELECT substr(user_message,1,200) AS title FROM exchanges WHERE session_id=? AND project=? ORDER BY timestamp, rowid LIMIT 1',[r.session_id,r.project])?.title || '제목 없는 대화';
      r.extraction = this.has('extraction_log') ? this.one('SELECT * FROM extraction_log WHERE session_id=?',[r.session_id]) || null : null;
    }
    return {available:true,items,total,limit,offset,engine};
  }
  exchanges(q,s) {
    const [w,p] = this.exchangeWhere(s); const [search,sp,engine] = this.searchClause(q);
    let where = `${w} AND ${search}`; const args=[...p,...sp];
    if(q.get('session')) { where+=' AND e.session_id=?';args.push(identifier(q.get('session'))); }
    const page=this.page('exchanges e',where,args,'e.timestamp DESC,e.id DESC',q,this.select('exchanges',EXCHANGE_FIELDS,'e'));
    page.engine=engine;return page;
  }
  session(id,q,s) {
    const [w,p]=this.exchangeWhere(s); const {limit,offset}=this.paginate(q,30,100);
    const args=[identifier(id),...p];const total=this.count(`SELECT COUNT(*) AS n FROM exchanges e WHERE e.session_id=? AND ${w}`,args);
    if(!total)throw new HttpError(404,'현재 범위에서 대화를 찾을 수 없습니다.','NOT_FOUND');
    const items=this.all(`SELECT ${this.select('exchanges',EXCHANGE_FIELDS,'e')} FROM exchanges e WHERE e.session_id=? AND ${w} ORDER BY e.timestamp,e.rowid LIMIT ? OFFSET ?`,[...args,limit,offset]);
    const summary=this.one(`SELECT MIN(e.timestamp) AS started_at, MAX(e.timestamp) AS ended_at,MIN(e.project) AS project,MAX(e.git_branch) AS branch FROM exchanges e WHERE e.session_id=? AND ${w}`,args);
    for(const e of items) e.extraction_state=this.has('exchange_extraction_state') ? this.all('SELECT * FROM exchange_extraction_state WHERE exchange_id=? ORDER BY content_generation DESC LIMIT 10',[e.id]) : [];
    const [fw,fp]=this.factWhere(s);
    const facts=this.has('facts') ? this.all(`SELECT ${this.select('facts',FACT_FIELDS,'f')} FROM facts f WHERE ${fw} AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(f.source_exchange_ids) THEN f.source_exchange_ids ELSE '[]' END) j JOIN exchanges e ON e.id=j.value WHERE e.session_id=? AND ${w}) ORDER BY f.updated_at DESC LIMIT 100`,[...fp,id,...p]) : [];
    const jobs=this.jobs(new URLSearchParams({session:id,limit:'100'}),s);
    const recalls=this.recalls(new URLSearchParams({session:id,limit:'100'}),s);
    const capsule=this.has('work_capsules') && this.has('minimal_workstreams') ? this.one(`SELECT c.* FROM work_capsules c JOIN minimal_workstreams m ON m.workstream_id=c.workstream_id WHERE m.session_id=?`,[id]) : null;
    return {available:true,session_id:id,...summary,items,total,limit,offset,facts,jobs:jobs.items,recalls:recalls.items,capsule,relatedLimit:100};
  }
  exchange(id,s) {
    const [w,p]=this.exchangeWhere(s);
    const e=this.one(`SELECT ${this.select('exchanges',EXCHANGE_FIELDS,'e')} FROM exchanges e WHERE e.id=? AND ${w}`,[identifier(id),...p]);
    if(!e)throw new HttpError(404,'현재 범위에서 원문을 찾을 수 없습니다. 범위를 변경해 다시 확인하세요.','NOT_FOUND');
    const tools=this.has('tool_calls')?this.all('SELECT * FROM tool_calls WHERE exchange_id=? ORDER BY timestamp,id LIMIT 200',[id]):[];
    const [fw,fp]=this.factWhere(s);
    const facts=this.has('facts')?this.all(`SELECT ${this.select('facts',FACT_FIELDS,'f')} FROM facts f WHERE ${fw} AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(f.source_exchange_ids) THEN f.source_exchange_ids ELSE '[]' END) j WHERE j.value=?) ORDER BY f.updated_at DESC LIMIT 100`,[...fp,id]):[];
    const extraction=this.has('exchange_extraction_state')?this.all('SELECT * FROM exchange_extraction_state WHERE exchange_id=? ORDER BY content_generation DESC',[id]):[];
    const targets=this.has('extraction_target_items')?this.all(`SELECT t.* FROM extraction_target_items i JOIN extraction_targets t ON t.target_id=i.target_id WHERE i.exchange_id=? ORDER BY t.created_at DESC LIMIT 50`,[id]):[];
    return {exchange:e,tools,facts,extraction,targets};
  }
  taxonomy(s) {
    if(!this.has('ontology_categories')||!this.has('ontology_domains'))return {available:false,domains:[],categories:[],unclassified:null};
    const [w,p]=this.factWhere(s);
    const categories=this.all(`SELECT c.id,c.name,c.description,c.domain_id,COUNT(*) AS facts FROM ontology_categories c JOIN facts f ON f.ontology_category_id=c.id WHERE f.is_active=1 AND ${w} GROUP BY c.id ORDER BY facts DESC,c.name`,p);
    const domains=this.all(`SELECT d.id,d.name,d.description,COUNT(DISTINCT c.id) AS categories,COUNT(*) AS facts FROM ontology_domains d JOIN ontology_categories c ON c.domain_id=d.id JOIN facts f ON f.ontology_category_id=c.id WHERE f.is_active=1 AND ${w} GROUP BY d.id ORDER BY facts DESC,d.name`,p);
    const unclassified=this.count(`SELECT COUNT(*) AS n FROM facts f WHERE f.is_active=1 AND f.ontology_category_id IS NULL AND ${w}`,p);
    return {available:true,domains,categories,unclassified};
  }
  graph(q,s) {
    this.require('facts');const [w,p]=this.factWhere(s);const limit=integer(q.get('limit'),1200,1,5000);
    const types=q.get('types')?q.get('types').split(','):TYPES;
    if(types.some(t=>!TYPES.includes(t)))throw new HttpError(400,'알 수 없는 관계 유형입니다.');
    const taxonomy=this.taxonomy(s);let extra='';const args=[...p];
    if(q.get('domain')) { extra+=' AND f.ontology_category_id IN (SELECT id FROM ontology_categories WHERE domain_id=?)';args.push(identifier(q.get('domain'))); }
    if(q.get('q')){ extra+=' AND instr(lower(f.fact),lower(?))>0';args.push(text(q.get('q'))); }
    const total=this.count(`SELECT COUNT(*) AS n FROM facts f WHERE f.is_active=1 AND ${w}${extra}`,args);
    let nodes=this.all(`SELECT ${this.select('facts',['id','fact','fact_kr','category','scope_type','ontology_category_id','updated_at'],'f')} FROM facts f WHERE f.is_active=1 AND ${w}${extra} ORDER BY f.updated_at DESC,f.id DESC LIMIT ?`,[...args,limit]);
    if(q.get('focus')){
      const f=this.visibleFact(q.get('focus'),s);const focusId=f.id;
      if(this.has('ontology_relations'))nodes=this.all(`SELECT ${this.select('facts',['id','fact','fact_kr','category','scope_type','ontology_category_id','updated_at'],'f')} FROM facts f WHERE f.is_active=1 AND ${w} AND (f.id=? OR f.id IN(SELECT target_fact_id FROM ontology_relations WHERE source_fact_id=?) OR f.id IN(SELECT source_fact_id FROM ontology_relations WHERE target_fact_id=?)) ORDER BY CASE WHEN f.id=? THEN 0 ELSE 1 END,f.updated_at DESC,f.id DESC LIMIT ?`,[...p,focusId,focusId,focusId,focusId,limit]);
    }
    const nodeIds=new Set(nodes.map(n=>n.id));
    // Join both endpoints to the bounded node selection; never return out-of-scope edges.
    let edges=[];
    if(nodes.length && this.has('ontology_relations')){
      const ids=[...nodeIds];const idsJson=JSON.stringify(ids);
      edges=this.all(`SELECT r.* FROM ontology_relations r WHERE r.source_fact_id IN(SELECT value FROM json_each(?)) AND r.target_fact_id IN(SELECT value FROM json_each(?)) ORDER BY r.id LIMIT 30001`,[idsJson,idsJson]).filter(e=>types.includes(e.relation_type));
    }
    const edgeTruncated=edges.length>30000;edges=edges.slice(0,30000);
    return {available:true,nodes,edges,types:TYPES,domains:taxonomy.domains,categories:taxonomy.categories,total,limit,truncated:!q.get('focus')&&nodes.length<total,edgeTruncated,focus:q.get('focus')||null};
  }
  chronicle(q,s) {
    if(!this.has('fact_revisions'))return this.missing('fact_revisions');
    const [fw,fp]=this.factWhere(s);const args=[...fp];
    let where=`EXISTS(SELECT 1 FROM facts f WHERE f.id=r.fact_id AND ${fw})`;
    if(s.type==='all') { where='1=1';args.length=0; }
    // Project event-only rows (e.g. INCIDENT) have no fact_id. Stable identity is mandatory.
    else if(s.projectId && !s.workspaceId && !s.workstreamId && this.has('fact_revisions','project_id')){where=`(${where} OR (r.fact_id IS NULL AND r.project_id=?))`;args.push(s.projectId);}
    if(q.has('id')){where+=' AND r.id=?';args.push(identifier(q.get('id')));}
    if(q.get('fact')){where+=' AND r.fact_id=?';args.push(identifier(q.get('fact')));}
    if(q.get('kind')&&this.has('fact_revisions','event_kind')){where+=' AND r.event_kind=?';args.push(text(q.get('kind'),40));}
    if(q.get('q')){where+=" AND (instr(lower(COALESCE(r.new_fact,'')),lower(?))>0 OR instr(lower(COALESCE(r.reason,'')),lower(?))>0)";args.push(text(q.get('q')),text(q.get('q')));}
    const time=q.get('time')!=='recorded'&&this.has('fact_revisions','effective_at')?'COALESCE(r.effective_at,r.created_at)':this.has('fact_revisions','recorded_at')?'COALESCE(r.recorded_at,r.created_at)':'r.created_at';
    if(q.get('from')){where+=` AND ${time}>=?`;args.push(text(q.get('from'),40));}
    if(q.get('to')){where+=` AND ${time}<=?`;args.push(text(q.get('to'),40)+'T23:59:59.999Z');}
    return this.page('fact_revisions r',where,args,`${time} DESC,r.id DESC`,q,'r.*');
  }
  jobs(q,s) {
    if(!this.has('memory_jobs'))return this.missing('memory_jobs');
    let from='memory_jobs j';let session='NULL',project='NULL';
    if(this.has('extraction_targets')){from+=' LEFT JOIN extraction_targets t ON t.target_id=j.target_id';session='t.session_id';project='t.project';}
    if(this.has('checkpoints')){from+=' LEFT JOIN checkpoints c ON c.checkpoint_id=j.checkpoint_id';session=session==='NULL'?'c.session_id':`COALESCE(${session},c.session_id)`;}
    let [w,p]=s.type==='all'?['1=1',[]]:this.sessionExists(s,session);
    if(q.get('state')){w+=' AND j.state=?';p.push(text(q.get('state'),40));}
    if(q.get('session')){w+=` AND ${session}=?`;p.push(identifier(q.get('session')));}
    if(q.get('q')){w+=" AND (instr(j.job_id,?)>0 OR instr(COALESCE(j.last_error,''),?)>0 OR instr(j.kind,?)>0)";p.push(...Array(3).fill(text(q.get('q'))));}
    if(q.get('id')){w+=' AND j.job_id=?';p.push(identifier(q.get('id')));}
    if(q.get('from')){w+=' AND j.updated_at>=?';p.push(text(q.get('from'),40));}
    if(q.get('to')){w+=' AND j.updated_at<=?';p.push(text(q.get('to'),40)+'T23:59:59.999Z');}
    return this.page(from,w,p,'j.updated_at DESC,j.job_id DESC',q,`j.*,${session} AS session_id,${project} AS project`);
  }
  job(id,s) {
    const page=this.jobs(new URLSearchParams({id,limit:'1'}),s);const job=page.items[0];if(!job)throw new HttpError(404,'현재 범위에서 작업을 찾을 수 없습니다.','NOT_FOUND');
    const target=job.target_id&&this.has('extraction_targets')?this.one('SELECT * FROM extraction_targets WHERE target_id=?',[job.target_id]):null;
    const items=target&&this.has('extraction_target_items')?this.all('SELECT * FROM extraction_target_items WHERE target_id=? ORDER BY ordinal LIMIT 500',[target.target_id]):[];
    const failures=target&&this.has('extraction_failed_ranges')?this.all('SELECT * FROM extraction_failed_ranges WHERE target_id=? ORDER BY updated_at DESC LIMIT 100',[target.target_id]):[];
    const attempts=this.has('model_work_attempts')?this.all('SELECT * FROM model_work_attempts WHERE job_id=? ORDER BY started_at,attempt_no LIMIT 500',[id]):[];
    const checkpoint=job.checkpoint_id&&this.has('checkpoints')?this.one('SELECT * FROM checkpoints WHERE checkpoint_id=?',[job.checkpoint_id]):null;
    const budget=job.budget_id&&this.has('model_work_budgets')?this.one('SELECT * FROM model_work_budgets WHERE budget_id=?',[job.budget_id]):null;
    const [fw,fp]=this.factWhere(s);
    const exchangeIds=items.map(x=>x.exchange_id);
    const relatedFacts=exchangeIds.length?this.all(`SELECT ${this.select('facts',FACT_FIELDS,'f')} FROM facts f WHERE ${fw} AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(f.source_exchange_ids) THEN f.source_exchange_ids ELSE '[]' END) j WHERE j.value IN(SELECT value FROM json_each(?))) ORDER BY f.updated_at DESC LIMIT 100`,[...fp,JSON.stringify(exchangeIds)]):[];
    return {job,target,items,failures,attempts,checkpoint,budget,relatedFacts,relatedFactsBasis:'동일한 원문을 근거로 가진 현재 기억입니다. 해당 실행의 직접 산출물임을 의미하지 않습니다.',itemsTruncated:!!target&&target.item_count>500};
  }
  attempts(q,s) {
    if(!this.has('model_work_attempts'))return this.missing('model_work_attempts');
    let w='1=1',p=[];
    if(s.type!=='all') {
      const [jw,jp]=this.sessionExists(s,'t.session_id');
      if(this.has('extraction_targets')) { w=`EXISTS(SELECT 1 FROM extraction_targets t WHERE t.target_id=a.target_id AND ${jw})`;p.push(...jp); }
      else w='0=1';
      if(this.has('memory_jobs')&&this.has('extraction_targets')){const [tw,tp]=this.sessionExists(s,'jt.session_id');w=`(${w} OR EXISTS(SELECT 1 FROM memory_jobs j JOIN extraction_targets jt ON jt.target_id=j.target_id WHERE j.job_id=a.job_id AND ${tw}))`;p.push(...tp);}
      if(this.has('memory_jobs')&&this.has('checkpoints')){const [cw,cp]=this.sessionExists(s,'c.session_id');w=`(${w} OR EXISTS(SELECT 1 FROM memory_jobs j JOIN checkpoints c ON c.checkpoint_id=j.checkpoint_id WHERE j.job_id=a.job_id AND ${cw}))`;p.push(...cp);}
    }
    if(q.has('id')){w+=' AND a.attempt_id=?';p.push(identifier(q.get('id')));}
    if(q.get('state')){w+=' AND a.state=?';p.push(text(q.get('state'),40));}
    if(q.get('q')){w+=" AND (instr(a.stage,?)>0 OR instr(COALESCE(a.error_message,''),?)>0 OR instr(a.attempt_id,?)>0)";p.push(...Array(3).fill(text(q.get('q'))));}
    if(q.get('from')){w+=' AND a.started_at>=?';p.push(text(q.get('from'),40));}
    if(q.get('to')){w+=' AND a.started_at<=?';p.push(text(q.get('to'),40)+'T23:59:59.999Z');}
    return this.page('model_work_attempts a',w,p,'a.started_at DESC,a.attempt_id DESC',q,'a.*');
  }
  recalls(q,s) {
    if(!this.has('recall_events'))return this.missing('recall_events');
    let [w,p]=s.type==='all'?['1=1',[]]:this.sessionExists(s,'r.session_id');
    if(q.get('fact')){w+=" AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(r.fact_ids) THEN r.fact_ids ELSE '[]' END) j WHERE j.value=?)";p.push(identifier(q.get('fact')));}
    if(q.get('session')){w+=' AND r.session_id=?';p.push(identifier(q.get('session')));}
    if(q.get('state')){w+=' AND r.status=?';p.push(text(q.get('state'),40));}
    if(q.get('from')){w+=' AND r.created_at>=?';p.push(text(q.get('from'),40));}
    if(q.get('to')){w+=' AND r.created_at<=?';p.push(text(q.get('to'),40)+'T23:59:59.999Z');}
    const page=this.page('recall_events r',w,p,'r.created_at DESC,r.id DESC',q,'r.*');
    page.items=page.items.map(r=>({...r,fact_ids:array(r.fact_ids)}));return page;
  }
  overview(s) {
    this.require('exchanges');this.require('facts');const [ew,ep]=this.exchangeWhere(s);const [fw,fp]=this.factWhere(s);
    const exchanges=this.count(`SELECT COUNT(*) AS n FROM exchanges e WHERE ${ew}`,ep);
    const sessions=this.count(`SELECT COUNT(DISTINCT e.session_id) AS n FROM exchanges e WHERE ${ew}`,ep);
    const facts=this.one(`SELECT COUNT(*) AS total,COALESCE(SUM(f.is_active=1),0) AS active,COALESCE(SUM(f.is_active=0),0) AS inactive,COALESCE(SUM(f.is_active=1 AND f.ontology_category_id IS NULL),0) AS unclassified FROM facts f WHERE ${fw}`,fp);
    const activity=this.all(`SELECT substr(e.timestamp,1,10) AS day,COUNT(*) AS count FROM exchanges e WHERE ${ew} AND e.timestamp>=? GROUP BY day ORDER BY day`,[...ep,new Date(Date.now()-29*86400000).toISOString().slice(0,10)]);
    const recent=this.chronicle(new URLSearchParams({limit:'6'}),s);
    const latest=this.sessions(new URLSearchParams({limit:'4'}),s);
    const running=this.jobs(new URLSearchParams({state:'running',limit:'4'}),s);
    const failed=this.jobs(new URLSearchParams({state:'dead',limit:'4'}),s);
    const retry=this.jobs(new URLSearchParams({state:'retry',limit:'4'}),s);
    return {exchanges,sessions,facts,hiddenByTier:this.hiddenByTier(s),activity,recent:recent.items,sessionsRecent:latest.items,jobsRunning:running.items,jobsFailed:failed.items,running:running.total,failed:failed.total,retry:retry.total,generated_at:new Date().toISOString()};
  }
  capabilities() { return Object.fromEntries(['facts','exchanges','ontology_domains','ontology_categories','ontology_relations','fact_revisions','memory_jobs','extraction_targets','extraction_target_items','model_work_attempts','recall_events','fact_context_dependencies','fact_evidence_receipts','work_capsules'].map(t=>[t,this.has(t)])); }
}
module.exports={Store,FACT_FIELDS,EXCHANGE_FIELDS,TYPES};
