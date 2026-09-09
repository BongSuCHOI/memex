#!/usr/bin/env node
// Real-Chrome QA for affected Memex Workspace surfaces. Isolated data, processes
// and browser profiles are removed before exit; caller-selected screenshots remain.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const evidenceArg = process.argv.indexOf("--evidence-dir");
const EVIDENCE =
  evidenceArg >= 0
    ? path.resolve(process.argv[evidenceArg + 1])
    : fs.mkdtempSync("/tmp/memex-web-ui-evidence-");
const TEMP = fs.mkdtempSync("/tmp/memex-web-ui-e2e-");
const XDG_CONFIG_HOME = path.join(TEMP, "xdg");
// Same directory the XDG fallback resolves to, pinned explicitly so the UI's own
// writes (logs/ui-audit.jsonl, ui/operations.json) can never reach a real home.
const MEMEX_HOME = path.join(XDG_CONFIG_HOME, "memex");
const PROFILE = path.join(TEMP, "chrome-profile");
const CONTEXT_PROJECT = "/tmp/memex-web-ui";
const DOMAIN_ID = "engineering";
const CATEGORY_ID = "storage";
const MALICIOUS =
  "<img src=x onerror=globalThis.__memexInjected=true> 한글 사실은 안전하게 표시됩니다";
const EDITED =
  "The Memex Workspace mutation path uses an initialized vec0 connection.";

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    this.runtimeErrors = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP connect timeout")),
        10000,
      );
      this.ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("CDP connect failed"));
        },
        { once: true },
      );
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // malformed CDP transport frame — nothing recoverable
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.runtimeErrors.push(
          message.params?.exceptionDetails?.exception?.description ||
            message.params?.exceptionDetails?.text ||
            "runtime exception",
        );
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const waiter of [...this.waiters]) {
        if (
          waiter.method === message.method &&
          waiter.sessionId === message.sessionId
        ) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params || {});
        }
      }
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  wait(method, sessionId) {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(method + " timeout"));
      }, 15000);
      this.waiters.push(waiter);
    });
  }
  close() {
    try {
      this.ws?.close();
    } catch {}
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, "ui", "server.cjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      MEMEX_HOME,
      MEMEX_DB_PATH: "",
      TEST_DB_PATH: "",
      XDG_CONFIG_HOME,
      MEMEX_PLUGIN_ROOT: ROOT,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("UI start timeout\n" + stdout + stderr)),
      10000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // Memex Workspace <version> / http://127.0.0.1:<port> / DB: <path>
      if (
        stdout.includes("Memex Workspace") &&
        stdout.includes("http://127.0.0.1:" + port) &&
        stdout.includes("\nDB: ")
      ) {
        clearTimeout(timer);
        resolve(stdout);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("UI exited " + code + "\n" + stdout + stderr));
    });
  });
  return { child, ready };
}

function startChrome() {
  if (!fs.existsSync(CHROME)) throw new Error("Chrome not found: " + CHROME);
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--user-data-dir=" + PROFILE,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const ready = new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error("Chrome start timeout\n" + stderr)),
      15000,
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Chrome exited " + code + "\n" + stderr));
    });
  });
  return { child, ready };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function pageProbe(
  cdp,
  url,
  expression,
  screenshotName,
  keyboard = false,
) {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );
    const loaded = cdp.wait("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
    const result = await cdp.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text,
      );
    let keyboardFocus = null;
    if (keyboard) {
      await cdp.send(
        "Runtime.evaluate",
        { expression: "document.body.focus()" },
        sessionId,
      );
      await cdp.send(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "Tab", code: "Tab" },
        sessionId,
      );
      await cdp.send(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "Tab", code: "Tab" },
        sessionId,
      );
      const focus = await cdp.send(
        "Runtime.evaluate",
        {
          expression:
            '({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim(),href:document.activeElement?.getAttribute?.("href")})',
          returnByValue: true,
        },
        sessionId,
      );
      keyboardFocus = focus.result.value;
    }
    const screenshot = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      sessionId,
    );
    const screenshotPath = path.join(EVIDENCE, screenshotName);
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    return {
      ...result.result.value,
      keyboardFocus,
      screenshot: screenshotPath,
    };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// Async page driver shared by every probe: polls a predicate (the workspace
// renders through fetch + innerHTML, so DOM mutation alone is not a reliable
// signal) and fails loudly instead of resolving with a half-rendered surface.
const DRIVER = `
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(label,fn,timeout=20000)=>{
    const deadline=Date.now()+timeout;
    for(;;){
      const value=fn();
      if(value)return value;
      if(Date.now()>deadline)throw new Error('surface timeout: '+label);
      await sleep(100);
    }
  };
  const text=selector=>document.querySelector(selector)?.textContent?.trim()||'';
  const overflows=selector=>{const el=document.querySelector(selector);return el?el.scrollWidth>el.clientWidth+1:false;};
  const painted=canvas=>{
    if(!canvas||!canvas.width)return 0;
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let count=0;
    for(let i=3;i<data.length;i+=4)if(data[i])count++;
    return count;
  };
  // Pixels the map itself drew, read back from the live drawing buffer so the
  // check survives a headless compositor that screenshots the canvas blank.
  const mapPixels=canvas=>{
    if(!canvas||!canvas.width)return 0;
    const gl=canvas.getContext('webgl');
    if(gl){
      const buffer=new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,buffer);
      let count=0;
      // clearColor(.063,.114,.145) -> the untouched background
      for(let i=0;i<buffer.length;i+=4)
        if(Math.abs(buffer[i]-16)>8||Math.abs(buffer[i+1]-29)>8||Math.abs(buffer[i+2]-37)>8)count++;
      return count;
    }
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let count=0;
    // Canvas2D fallback paints #101d25 before the nodes.
    for(let i=0;i<data.length;i+=4)
      if(Math.abs(data[i]-16)>8||Math.abs(data[i+1]-29)>8||Math.abs(data[i+2]-37)>8)count++;
    return count;
  };
`;

const probe = (body) => `(async()=>{${DRIVER}${body}})()`;

let ui;
let chrome;
let cdp;
try {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  process.env.MEMEX_HOME = MEMEX_HOME;
  process.env.MEMEX_DB_PATH = "";
  process.env.TEST_DB_PATH = "";
  process.env.XDG_CONFIG_HOME = XDG_CONFIG_HOME;
  const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
  const { insertFact, insertFactContextDependencies } = await import(
    path.join(ROOT, "dist", "fact-db.js")
  );
  const db = initDatabase();
  const contextExchangeId = "web-ui-context-exchange";
  db.prepare(`
    INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message,
       archive_path, line_start, line_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    contextExchangeId,
    CONTEXT_PROJECT,
    "2026-08-31T00:00:00.000Z",
    "그 선택으로 진행해줘.",
    "SQLite를 선택하면 로컬 우선 요구사항을 충족합니다.",
    CONTEXT_PROJECT + "/session.jsonl",
    10,
    11,
  );
  const factId = insertFact(db, {
    fact: MALICIOUS,
    category: "decision",
    scope_type: "global",
    scope_project: null,
    source_exchange_ids: [],
    embedding: new Array(384).fill(0.1),
    embedding_version: 1,
  });
  insertFactContextDependencies(db, factId, [
    {
      exchange_id: contextExchangeId,
      dependency_kind: "assistant_context",
    },
  ]);
  // Taxonomy seed: the 분류 filter on /facts and the 지도에서 보기 link on
  // /taxonomy both need one classified fact. The edit probe below clears
  // ontology_category_id (core resets it on a meaning change), so every
  // taxonomy assertion has to run before the mutation probe.
  db.prepare(
    "INSERT INTO ontology_domains (id, name, description) VALUES (?, ?, ?)",
  ).run(DOMAIN_ID, "엔지니어링", "코어, 저장소와 데이터 처리");
  db.prepare(
    "INSERT INTO ontology_categories (id, domain_id, name, description) VALUES (?, ?, ?, ?)",
  ).run(CATEGORY_ID, DOMAIN_ID, "데이터 저장소", "SQLite 접근과 데이터 일관성");
  db.prepare("UPDATE facts SET ontology_category_id = ? WHERE id = ?").run(
    CATEGORY_ID,
    factId,
  );
  db.close();

  const port = await freePort();
  ui = startServer(port);
  const readyLines = await ui.ready;
  chrome = startChrome();
  cdp = new Cdp(await chrome.ready);
  await cdp.connect();
  const base = "http://127.0.0.1:" + port;
  // ?scope=all is the explicit cross-project scope; conversations (and therefore
  // interpretive context rows) are never visible from the global-only scope.
  const allScope = "?scope=all";
  const projectScope =
    "?scope=project&project=" + encodeURIComponent(CONTEXT_PROJECT);

  const facts = await pageProbe(
    cdp,
    base + "/facts" + allScope,
    probe(`
      const cell=await until('facts row',()=>{
        const el=document.querySelector('#main .data-table .fact-text');
        return el&&el.textContent.includes('한글 사실')?el:null;
      });
      return {
        title:document.title,
        heading:text('#main .page-header h1'),
        factText:cell.textContent,
        hasInjectedImage:Boolean(document.querySelector('#main .data-table img')),
        injectedFlag:Boolean(globalThis.__memexInjected),
        rowCount:document.querySelectorAll('#main .data-table tbody tr').length,
        wordBreak:getComputedStyle(cell).overflowWrap,
        pageOverflowX:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
        navItems:[...document.querySelectorAll('#sidebar .nav-item .nav-label')].map(x=>x.textContent),
        scopeSelected:document.querySelector('#scope-select')?.value,
      };
    `),
    "facts.png",
    true,
  );

  const factDetail = await pageProbe(
    cdp,
    base + "/facts" + allScope,
    probe(`
      (await until('facts row',()=>document.querySelector('#main .data-table .fact-text'))).click();
      await until('fact drawer',()=>document.querySelector('#detail[open] [data-panel-tab="evidence"]'));
      document.querySelector('#detail [data-panel-tab="evidence"]').click();
      const body=await until('evidence tab',()=>{
        const el=document.querySelector('#detail .drawer-body');
        return el&&el.textContent.includes('해석에 참고한 맥락')?el:null;
      });
      return {
        heading:text('#detail .drawer-title'),
        factId:text('#detail .drawer-meta'),
        tabs:[...document.querySelectorAll('#detail .tab')].map(x=>x.textContent),
        separationBanner:body.textContent.includes('직접 근거와 해석에 참고한 맥락을 분리합니다'),
        directEvidenceEmpty:body.textContent.includes('연결된 직접 근거 없음'),
        hasContextSection:body.textContent.includes('해석에 참고한 맥락'),
        hasAssistantKind:body.textContent.includes('assistant_context'),
        hasNonAuthoritativeLabel:body.textContent.includes('직접 근거 아님'),
        hasContextExchange:body.textContent.includes(${JSON.stringify(contextExchangeId)}),
        overflowX:overflows('#detail .drawer-body'),
      };
    `),
    "facts-detail-context.png",
    false,
  );

  const factsTaxonomy = await pageProbe(
    cdp,
    base + "/facts" + allScope,
    probe(`
      const form=()=>document.querySelector('#main form[data-filter]');
      // #main is replaced wholesale on every render; wait for a new form node so
      // no assertion reads the pre-navigation DOM.
      const rerender=async(label,act)=>{const before=await until(label+' form',form);act(before);return until(label+' rerendered',()=>{const now=form();return now&&now!==before?now:null;});};
      const select=await until('taxonomy select',()=>form()?.querySelector('select[name="taxonomy"]'));
      const options=[...select.options].map(o=>({value:o.value,label:o.textContent.trim(),group:o.parentElement.label||''}));
      await rerender('taxonomy filter',f=>{f.querySelector('select[name="taxonomy"]').value=${JSON.stringify(CATEGORY_ID)};f.requestSubmit();});
      await until('taxonomy param applied',()=>new URL(location.href).searchParams.get('taxonomy')===${JSON.stringify(CATEGORY_ID)});
      const row=await until('classified row',()=>document.querySelector('#main .data-table .fact-text'));
      const filteredRowText=row.textContent;
      const keptSelection=form().querySelector('select[name="taxonomy"]').value;
      const bannerText=text('#main .banner');
      await rerender('no-match search',f=>{f.querySelector('input[name="q"]').value='이문자열은어떤기억과도일치하지않습니다';f.requestSubmit();});
      const filteredEmpty=await until('filtered empty state',()=>{
        const el=document.querySelector('#main .empty h3');
        return el&&el.textContent.includes('조건에 맞는')?el.textContent.trim():null;
      });
      const reset=await until('reset action',()=>document.querySelector('#main [data-action="reset-facts-filter"]'));
      reset.click();
      await until('filters cleared',()=>!new URL(location.href).searchParams.get('taxonomy')&&!new URL(location.href).searchParams.get('q'));
      const restored=await until('restored row',()=>document.querySelector('#main .data-table .fact-text'));
      return {
        options,
        hasAllOption:options.some(o=>o.value===''&&o.label==='전체 분류'),
        hasUnclassifiedOption:options.some(o=>o.value==='unclassified'),
        categoryGroups:[...new Set(options.map(o=>o.group).filter(Boolean))],
        filteredRowText,
        keptSelection,
        bannerText,
        filteredEmpty,
        resetUrl:location.pathname+location.search,
        restoredRowText:restored.textContent,
      };
    `),
    "facts-taxonomy-filter.png",
    false,
  );

  const taxonomyMap = await pageProbe(
    cdp,
    base + "/taxonomy" + allScope,
    probe(`
      const card=await until('taxonomy card',()=>document.querySelector('#main .taxonomy-card'));
      const mapLink=card.querySelector('a[data-taxonomy-map]');
      if(!mapLink)throw new Error('지도에서 보기 link missing on the taxonomy card');
      const cardTitle=card.querySelector('h3')?.textContent?.trim()||'';
      const mapHref=mapLink.getAttribute('href');
      const factsHref=card.querySelector('.footer a[href*="taxonomy="]')?.getAttribute('href')||'';
      mapLink.click();
      await until('graph stage',()=>document.querySelector('#graph-stage .graph-canvas'));
      const domainSelect=await until('graph domain filter',()=>document.querySelector('#graph-domain'));
      return {
        cardTitle,
        mapText:mapLink.textContent.trim(),
        mapHref,
        factsHref,
        url:location.pathname+location.search,
        heading:text('#main .page-header h1'),
        domainSelected:domainSelect.value,
        nodeButtons:document.querySelectorAll('#node-list [data-fact]').length,
      };
    `),
    "taxonomy-graph-link.png",
    false,
  );

  const factsEmptyScope = await pageProbe(
    cdp,
    base + "/facts" + projectScope + "&includeGlobal=0",
    probe(`
      const empty=await until('scope empty state',()=>document.querySelector('#main .empty h3'));
      return {
        title:empty.textContent.trim(),
        body:text('#main .empty p'),
        hasActionsLink:Boolean(document.querySelector('#main .empty a[href*="tab=actions"]')),
        hasResetAction:Boolean(document.querySelector('#main [data-action="reset-facts-filter"]')),
      };
    `),
    "facts-empty-scope.png",
    false,
  );

  const mutations = await pageProbe(
    cdp,
    base + "/facts" + allScope,
    probe(`
      const submit=async(label)=>{
        const form=await until(label+' modal',()=>document.querySelector('#modal[open] #modal-form'));
        form.requestSubmit();
        await until(label+' committed',()=>{
          const error=document.querySelector('#modal[open] .modal-error')?.textContent?.trim();
          if(error)throw new Error(label+' rejected: '+error);
          return !document.querySelector('#modal[open]');
        },180000);
        await sleep(400);
      };
      const drawerButton=async(mutation)=>until(mutation+' button',()=>{
        const el=document.querySelector('#detail[open] [data-mutation="'+mutation+'"]');
        return el&&!el.disabled?el:null;
      },30000);
      (await until('facts row',()=>document.querySelector('#main .data-table .fact-text'))).click();
      (await drawerButton('edit')).click();
      const textarea=await until('edit fields',()=>document.querySelector('#modal[open] textarea[name="text"]'));
      textarea.value=${JSON.stringify(EDITED)};
      document.querySelector('#modal[open] input[name="reason"]').value='browser E2E';
      await submit('edit');
      await until('edited fact',()=>document.querySelector('#detail .drawer-quote')?.textContent.includes('initialized vec0 connection'),180000);
      (await drawerButton('deactivate')).click();
      await submit('deactivate');
      const inactive=await until('inactive fact',()=>{
        const badges=[...document.querySelectorAll('#detail .drawer-body .tag')].map(x=>x.textContent);
        return badges.includes('비활성')?badges:null;
      },30000);
      const listEmpty=document.querySelector('#main .empty h3')?.textContent||'';
      (await drawerButton('restore')).click();
      await submit('restore');
      const active=await until('active fact',()=>{
        const badges=[...document.querySelectorAll('#detail .drawer-body .tag')].map(x=>x.textContent);
        return badges.includes('활성')?badges:null;
      },30000);
      const row=await until('restored row',()=>document.querySelector('#main .data-table .fact-text'));
      return {
        factId:text('#detail .drawer-meta'),
        factText:document.querySelector('#detail .drawer-quote')?.textContent||'',
        rowText:row.textContent,
        inactiveBadges:inactive,
        activeBadges:active,
        listEmptyWhileInactive:listEmpty,
        toast:text('#toast'),
      };
    `),
    "facts-mutations.png",
    false,
  );

  const pipeline = await pageProbe(
    cdp,
    base + "/" + allScope,
    probe(`
      const list=await until('pipeline panel',()=>{
        const el=document.querySelector('#main .status-list');
        return el&&el.querySelectorAll('.status-step').length?el:null;
      });
      return {
        title:document.title,
        heading:text('#main .page-header h1'),
        steps:[...list.querySelectorAll('.status-step h3')].map(x=>x.textContent),
        text:list.innerText,
        metrics:[...document.querySelectorAll('#main .metric .metric-label')].map(x=>x.textContent),
        diagnosticsLink:Boolean(document.querySelector('#main a[href*="/settings"][href*="tab=diagnostics"]')),
      };
    `),
    "overview-pipeline.png",
    true,
  );

  const diagnostics = await pageProbe(
    cdp,
    base + "/settings?scope=all&tab=diagnostics",
    probe(`
      const table=await until('capability table',()=>{
        const el=document.querySelector('#main .data-table tbody');
        return el&&el.querySelectorAll('tr').length?el:null;
      });
      return {
        title:document.title,
        heading:text('#main .page-header h1'),
        rows:table.querySelectorAll('tr').length,
        factsReadable:[...table.querySelectorAll('tr')].some(r=>r.textContent.includes('facts')&&r.textContent.includes('조회 가능')),
        contextTableReadable:[...table.querySelectorAll('tr')].some(r=>r.textContent.includes('fact_context_dependencies')&&r.textContent.includes('조회 가능')),
        exportButton:Boolean(document.querySelector('#main [data-action="diagnostics-download"]')),
        tabs:[...document.querySelectorAll('#main .tabs .tab')].map(x=>x.textContent),
      };
    `),
    "settings-diagnostics.png",
    true,
  );

  const graph = await pageProbe(
    cdp,
    base + "/graph" + allScope,
    probe(`
      const stage=await until('graph stage',()=>{
        const el=document.querySelector('#graph-stage .graph-canvas');
        return el&&el.width&&text('#graph-renderer')?el:null;
      });
      const labels=document.querySelector('#graph-stage canvas.labels');
      const labelPixels=await until('2D map labels painted',()=>painted(labels)||null,20000);
      const nodePixels=await until('2D map nodes painted',()=>mapPixels(stage)||null,20000);
      const mode2d=document.querySelector('[data-graph-mode="2d"]').classList.contains('active');
      document.querySelector('[data-graph-mode="3d"]').click();
      await until('3D galaxy active',()=>document.querySelector('[data-graph-mode="3d"]').classList.contains('active'));
      const legend=await until('3D legend',()=>{
        const el=document.querySelector('#graph-stage .graph-legend');
        return el&&el.textContent.includes('회전')?el.textContent:null;
      });
      const labelPixels3d=await until('3D map labels painted',()=>painted(labels)||null,20000);
      const nodePixels3d=await until('3D map nodes painted',()=>mapPixels(stage)||null,20000);
      return {
        title:document.title,
        renderer:text('#graph-renderer'),
        canvas:[stage.width,stage.height],
        meta:text('#graph-stage .graph-meta'),
        nodeButtons:document.querySelectorAll('#node-list [data-fact]').length,
        relationFilters:[...document.querySelectorAll('[data-relation]')].map(x=>x.dataset.relation),
        emptyState:Boolean(document.querySelector('#graph-stage .empty')),
        mode2dDefault:mode2d,
        mode3dActive:document.querySelector('[data-graph-mode="3d"]').classList.contains('active'),
        legend,
        labelPixels,
        labelPixels3d,
        nodePixels,
        nodePixels3d,
      };
    `),
    "graph-2d-3d.png",
    true,
  );

  const graphEmpty = await pageProbe(
    cdp,
    base + "/graph" + projectScope + "&includeGlobal=0",
    probe(`
      const empty=await until('graph empty state',()=>{
        const el=document.querySelector('#graph-stage .empty');
        return el&&el.textContent.includes('표시할 기억이 없습니다')?el:null;
      });
      const canvas=document.querySelector('#graph-stage .graph-canvas');
      return {
        title:document.title,
        emptyTitle:text('#graph-stage .empty h3'),
        emptyBody:text('#graph-stage .empty p'),
        emptyState:Boolean(empty),
        canvas:[canvas.width,canvas.height],
        meta:text('#graph-stage .graph-meta'),
        renderer:text('#graph-renderer'),
        taxonomyLink:Boolean(document.querySelector('#main a[href*="/taxonomy"]')),
        labelPixels:painted(document.querySelector('#graph-stage canvas.labels')),
        nodePixels:mapPixels(canvas),
      };
    `),
    "graph-empty.png",
    true,
  );

  if (
    facts.hasInjectedImage ||
    facts.injectedFlag ||
    facts.rowCount !== 1 ||
    facts.pageOverflowX ||
    !facts.factText.includes("한글 사실") ||
    facts.navItems.length !== 7 ||
    facts.scopeSelected !== "all"
  ) {
    throw new Error("Facts browser assertion failed: " + JSON.stringify(facts));
  }
  if (
    factDetail.heading !== "기억 상세" ||
    factDetail.factId !== factId ||
    !factDetail.separationBanner ||
    !factDetail.directEvidenceEmpty ||
    !factDetail.hasContextSection ||
    !factDetail.hasAssistantKind ||
    !factDetail.hasNonAuthoritativeLabel ||
    !factDetail.hasContextExchange ||
    factDetail.overflowX
  ) {
    throw new Error(
      "Fact context detail assertion failed: " + JSON.stringify(factDetail),
    );
  }
  if (
    !factsTaxonomy.hasAllOption ||
    !factsTaxonomy.hasUnclassifiedOption ||
    !factsTaxonomy.categoryGroups.includes("엔지니어링") ||
    factsTaxonomy.keptSelection !== CATEGORY_ID ||
    !factsTaxonomy.filteredRowText.includes("한글 사실") ||
    !factsTaxonomy.bannerText.includes("분류 필터가 적용됐습니다") ||
    factsTaxonomy.filteredEmpty !== "조건에 맞는 기억이 없습니다" ||
    !factsTaxonomy.restoredRowText.includes("한글 사실") ||
    /taxonomy=/.test(factsTaxonomy.resetUrl)
  ) {
    throw new Error(
      "Facts taxonomy filter assertion failed: " + JSON.stringify(factsTaxonomy),
    );
  }
  if (
    taxonomyMap.mapText !== "지도에서 보기" ||
    !taxonomyMap.mapHref.includes("/graph") ||
    !taxonomyMap.mapHref.includes("domain=" + DOMAIN_ID) ||
    !taxonomyMap.factsHref.includes("taxonomy=" + CATEGORY_ID) ||
    !taxonomyMap.url.startsWith("/graph") ||
    !taxonomyMap.url.includes("domain=" + DOMAIN_ID) ||
    taxonomyMap.domainSelected !== DOMAIN_ID ||
    taxonomyMap.heading !== "지식 지도" ||
    taxonomyMap.nodeButtons !== 1
  ) {
    throw new Error(
      "Taxonomy graph link assertion failed: " + JSON.stringify(taxonomyMap),
    );
  }
  if (
    factsEmptyScope.title !== "이 범위에 저장된 기억이 없습니다" ||
    !factsEmptyScope.hasActionsLink ||
    factsEmptyScope.hasResetAction
  ) {
    throw new Error(
      "Facts empty-scope assertion failed: " + JSON.stringify(factsEmptyScope),
    );
  }
  if (
    mutations.factId !== factId ||
    !mutations.activeBadges.includes("활성") ||
    !mutations.inactiveBadges.includes("비활성") ||
    !mutations.factText.includes("initialized vec0 connection") ||
    !mutations.rowText.includes("initialized vec0 connection") ||
    mutations.listEmptyWhileInactive !== "조건에 맞는 기억이 없습니다"
  ) {
    throw new Error(
      "Facts mutation assertion failed: " + JSON.stringify(mutations),
    );
  }
  if (
    pipeline.steps.length !== 4 ||
    !pipeline.text.includes("대화 수집") ||
    !pipeline.diagnosticsLink ||
    pipeline.metrics.length !== 4
  ) {
    throw new Error(
      "Overview pipeline assertion failed: " + JSON.stringify(pipeline),
    );
  }
  if (
    !diagnostics.factsReadable ||
    !diagnostics.contextTableReadable ||
    !diagnostics.exportButton ||
    diagnostics.rows < 5
  ) {
    throw new Error(
      "Diagnostics assertion failed: " + JSON.stringify(diagnostics),
    );
  }
  if (
    !graph.canvas.every(Boolean) ||
    graph.emptyState ||
    !graph.mode2dDefault ||
    !graph.mode3dActive ||
    !graph.labelPixels ||
    !graph.labelPixels3d ||
    !graph.nodePixels ||
    !graph.nodePixels3d ||
    graph.nodeButtons !== 1 ||
    !graph.meta.includes("1 NODES") ||
    graph.relationFilters.length !== 4 ||
    !["LOCAL WEBGL", "CANVAS 2D · WEBGL 사용 불가"].includes(graph.renderer)
  ) {
    throw new Error("Graph browser assertion failed: " + JSON.stringify(graph));
  }
  if (
    !graphEmpty.emptyState ||
    graphEmpty.emptyTitle !== "표시할 기억이 없습니다" ||
    !graphEmpty.canvas.every(Boolean) ||
    !graphEmpty.meta.includes("0 NODES") ||
    graphEmpty.labelPixels !== 0 ||
    graphEmpty.nodePixels !== 0 ||
    !graphEmpty.taxonomyLink
  ) {
    throw new Error(
      "Graph empty-state assertion failed: " + JSON.stringify(graphEmpty),
    );
  }
  for (const result of [facts, pipeline, diagnostics, graph, graphEmpty]) {
    if (result.keyboardFocus?.tag !== "A")
      throw new Error(
        "keyboard focus did not enter navigation: " +
          JSON.stringify(result.keyboardFocus),
      );
  }
  if (cdp.runtimeErrors.length)
    throw new Error("browser runtime errors: " + cdp.runtimeErrors.join("; "));
  console.log(
    "__WEB_UI_RECEIPT__" +
      JSON.stringify({
        kind: "memex-web-ui-browser-e2e",
        recordedAt: new Date().toISOString(),
        environment: {
          browser: "Google Chrome headless",
          transport: "CDP",
          viewport: "1440x900",
          server: readyLines.split("\n")[0],
        },
        verdict: "PASS",
        checks: {
          facts,
          factDetail,
          factsTaxonomy,
          taxonomyMap,
          factsEmptyScope,
          mutations,
          pipeline,
          diagnostics,
          graph,
          graphEmpty,
          runtimeErrors: cdp.runtimeErrors,
        },
      }),
  );
} finally {
  cdp?.close();
  await stop(chrome?.child);
  await stop(ui?.child);
  fs.rmSync(TEMP, { recursive: true, force: true });
}
