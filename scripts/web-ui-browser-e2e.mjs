#!/usr/bin/env node
// Real-Chrome QA for affected Memex Workspace surfaces. Isolated data, processes
// and browser profiles are removed before exit; caller-selected screenshots remain.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
// #109 L5: expectations come from the shipped dictionaries, never from a second
// copy of the prose. One `L` object is built here and used by BOTH sides — the
// injected probe string and the Node assertion block — so `--lang en` and
// `--lang ko` assert the same screens without two sets of literals.
import { setLocale, t, tn } from "../ui/public/i18n/index.mjs";
import { loadDictionary } from "../ui/public/i18n/load.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Product default is en, so the gate's default is en too. ko is one explicit
// release-gate run: `node scripts/web-ui-browser-e2e.mjs --lang ko`.
const langArg = process.argv.indexOf("--lang");
const LANG = langArg >= 0 ? String(process.argv[langArg + 1]) : "en";
if (!["en", "ko"].includes(LANG))
  throw new Error("--lang must be en or ko, got " + JSON.stringify(process.argv[langArg + 1]));
const ALT = LANG === "en" ? "ko" : "en";
setLocale(LANG, loadDictionary(LANG).dict);
const ALT_DICT = loadDictionary(ALT).dict;
/** Pick the fixture wording for this run. Demo data, not UI prose. */
const sc = (ko, en) => (LANG === "en" ? en : ko);
/** Dictionary value as the DOM shows it — `tHtml` markup is stripped, text is not. */
const plain = (key, params) => String(t(key, params)).replace(/<[^>]+>/g, "");
/**
 * Dictionary value as a RegExp: everything is escaped except the named params,
 * whose replacements are spliced in as regex fragments (`{total}` -> `\d+`).
 */
function tRe(key, params) {
  let out = String(t(key)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [name, fragment] of Object.entries(params))
    out = out.split("\\{" + name + "\\}").join(fragment);
  return new RegExp(out);
}
const evidenceArg = process.argv.indexOf("--evidence-dir");
const EVIDENCE =
  evidenceArg >= 0
    ? path.resolve(process.argv[evidenceArg + 1])
    : fs.mkdtempSync("/tmp/memex-web-ui-evidence-");
// Opt-in documentation capture. Absent, nothing below the gate runs and the
// gate's fixture, browser flags, probes and receipt stay exactly as they were.
const screenshotArg = process.argv.indexOf("--screenshots");
const SCREENSHOTS =
  screenshotArg >= 0 ? path.resolve(process.argv[screenshotArg + 1]) : null;
const TEMP = fs.mkdtempSync("/tmp/memex-web-ui-e2e-");
const XDG_CONFIG_HOME = path.join(TEMP, "xdg");
// Same directory the XDG fallback resolves to, pinned explicitly so the UI's own
// writes (logs/ui-audit.jsonl, ui/operations.json) can never reach a real home.
const MEMEX_HOME = path.join(XDG_CONFIG_HOME, "memex");
const PROFILE = path.join(TEMP, "chrome-profile");
const CONTEXT_PROJECT = "/tmp/memex-web-ui";
const DOMAIN_ID = "engineering";
const CATEGORY_ID = "storage";
// ★ The Korean tail stays Korean in BOTH languages. What this probe asserts is
// that the markup is escaped and the Hangul still renders — content safety, not
// UI language (design §10.3, the single exception to "no Hangul in en").
const MALICIOUS =
  "<img src=x onerror=globalThis.__memexInjected=true> 한글 사실은 안전하게 표시됩니다";
const MALICIOUS_VISIBLE = "한글 사실";
const EDITED =
  "The Memex Workspace mutation path uses an initialized vec0 connection.";
// #22 branch-tier seed: a project memory the default project predicate hides.
const TIER_WORKSTREAM_ID = "stream-web-ui";
const TIER_BRANCH = "feature/tier-ladder";
const TIER_AT = "2026-08-01T00:00:00.000Z";
const BRANCH_FACT = sc(
  "브랜치 계층 기억은 그 브랜치 세션에만 주입된다.",
  "A branch-tier memory is injected only into sessions on that branch.",
);
// #23 failure-class seed.
const DEAD_JOB_ID = "e2e-dead-capsule-job";
const DEAD_JOB_ERROR = "capsule patch exceeds bounded storage size";
// Gate fixture prose that reaches the screen. Languaged so the en run can assert
// "zero Hangul outside user content" without carving out half the surface.
const CONTEXT_USER = sc("그 선택으로 진행해줘.", "Go ahead with that choice.");
const CONTEXT_ASSISTANT = sc(
  "SQLite를 선택하면 로컬 우선 요구사항을 충족합니다.",
  "Choosing SQLite satisfies the local-first requirement.",
);
const DOMAIN_NAME = sc("엔지니어링", "Engineering");
const DOMAIN_DESC = sc("코어, 저장소와 데이터 처리", "Core, storage and data handling");
const CATEGORY_NAME = sc("데이터 저장소", "Data storage");
const CATEGORY_DESC = sc("SQLite 접근과 데이터 일관성", "SQLite access and data consistency");
const PEER_FACT = sc(
  "두 번째 맥에서 만든 기억은 세대 파일로 넘어온다.",
  "A memory made on the second Mac arrives in a generation file.",
);
const PEER_QUERY = sc("세대 파일", "generation file");
const PEER_ALIAS = sc("두 번째 맥", "Second Mac");
const LOCAL_ALIAS = sc("이 맥", "This Mac");
const NO_MATCH_QUERY = sc(
  "이문자열은어떤기억과도일치하지않습니다",
  "thisstringmatchesnostoredmemory",
);
const OVERLAY_PATTERN = sc("배포\\s*이력", "deploy\\s*history");
const OVERLAY_PATTERN_TEXT = sc("배포", "deploy");
const OVERLAY_NOTE = sc("릴리스 질문은 항상 회수", "Always recall release questions");

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    this.runtimeErrors = [];
    // #109 L5: `Runtime.exceptionThrown` alone sees neither a CSP violation nor a
    // `console.error`, and the missing-key report is a console.error. `Log.enable`
    // plus `Runtime.consoleAPICalled` are what make both observable.
    this.consoleMessages = [];
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
      if (message.method === "Log.entryAdded") {
        const entry = message.params?.entry || {};
        this.consoleMessages.push(
          [entry.source, entry.level, entry.text].filter(Boolean).join(" "),
        );
      }
      if (message.method === "Runtime.consoleAPICalled") {
        const args = (message.params?.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ""))
          .join(" ");
        this.consoleMessages.push(
          "console " + (message.params?.type || "log") + " " + args,
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

function startServer(port, home = MEMEX_HOME, xdg = XDG_CONFIG_HOME) {
  const child = spawn(process.execPath, [path.join(ROOT, "ui", "server.cjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      MEMEX_HOME: home,
      MEMEX_DB_PATH: "",
      TEST_DB_PATH: "",
      XDG_CONFIG_HOME: xdg,
      MEMEX_PLUGIN_ROOT: ROOT,
      PORT: String(port),
      // #109 L5: the server default is what `<html data-lang>` carries, and the
      // CSP probe below reads exactly that with no `?lang` in the URL. Every
      // other navigation also pins `&lang=`, because a stored preference would
      // otherwise beat the server default.
      MEMEX_UI_LANG: LANG,
      // Screenshots are compared side by side across languages, so the clock the
      // page formats with must not be the developer's.
      TZ: "UTC",
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

function startChrome(profile = PROFILE, extraArgs = []) {
  if (!fs.existsSync(CHROME)) throw new Error("Chrome not found: " + CHROME);
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      ...extraArgs,
      "about:blank",
    ],
    // Intl in the page formats against the browser's zone, not the server's.
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TZ: "UTC" } },
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
  if (process.env.MEMEX_E2E_TRACE) console.error("probe " + screenshotName + " " + url);
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
    // CSP violations and console.error (= the i18n missing-key report) only reach
    // the transport once these two domains are on for the session.
    await cdp.send("Log.enable", {}, sessionId).catch(() => {});
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
  // Classify every pixel of the map canvas against the engine's own clear
  // colour, clearColor(.063,.114,.145) -> rgb(16,29,37), which the Canvas2D
  // fallback also paints as #101d25.
  //
  // The readback must never race the engine's requestAnimationFrame: a WebGL
  // drawing buffer that has not been cleared yet reads back as transparent
  // black, and transparent black is not the clear colour, so an undrawn canvas
  // would otherwise be counted as fully painted. renderNow() produces a real
  // frame in this same JS task, and the frame counter proves one actually
  // happened, so "background only" and "never drawn" stay distinguishable.
  const mapSurface=canvas=>{
    const engine=canvas&&canvas.closest('#graph-stage')?.__knowledgeGraph;
    const frames=engine?.renderNow?engine.renderNow():0;
    if(!canvas||!canvas.width)return {painted:0,background:0,total:0,frames};
    const total=canvas.width*canvas.height;
    const gl=canvas.getContext('webgl');
    let data;
    if(gl){
      data=new Uint8Array(total*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    }else{
      data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    }
    let painted=0,background=0;
    for(let i=0;i<data.length;i+=4){
      if(Math.abs(data[i]-16)<=8&&Math.abs(data[i+1]-29)<=8&&Math.abs(data[i+2]-37)<=8)background++;
      else painted++;
    }
    return {painted,background,total,frames};
  };
  const mapPixels=canvas=>mapSurface(canvas).painted;
`;

// ---------------------------------------------------------------------------
// #109 L5 · the one expectation table.
//
// `probe()` injects this page-side as `L`, and the Node assertion block reads the
// same object, so a label is written once and checked on both sides. Everything
// here comes out of `ui/public/i18n/<ns>/<lang>.mjs` — a literal in this file
// would be a second translation nobody maintains.
// ---------------------------------------------------------------------------
const L = {
  lang: LANG,
  // shell · scope
  scopeAllOption: t("shell.scope.allProjectsOption"),
  commonMemory: t("common.commonMemory"),
  projectGroup: t("shell.scope.projectGroup"),
  scopeInjection: t("shell.scope.injection"),
  scopeHint: t("shell.scope.hint"),
  scopeAllLine: t("shell.scope.allLine"),
  navFacts: t("shell.nav.facts"),
  // "· N memories" / "· 기억 N개". en splits one/other, ko has only other, so the
  // alternation is built from whichever forms this language's dictionary declares.
  factCountRe: ["one", "other"]
    .filter((form) => loadDictionary(LANG).dict["shell.scope.factCount." + form] !== undefined)
    .map((form) => tRe("shell.scope.factCount." + form, { total: "\\d+" }).source)
    .join("|"),
  // facts
  factsTitle: t("pages.facts.title"),
  factsEmptyScope: t("pages.facts.empty.scope.title"),
  factsEmptyFiltered: t("pages.facts.empty.filtered.title"),
  taxonomyAll: t("pages.facts.taxonomy.all"),
  taxonomyFilterBanner: plain("pages.facts.taxonomy.filterBanner", { htmlClear: "" }).trim(),
  hiddenTierOne: tn("pages.facts.hiddenTier.more.title", 1, { n: "1" }),
  // conversations · taxonomy · graph
  conversationsGlobalScope: t("pages.conversations.globalScope.title"),
  taxonomyMapAction: t("pages.taxonomy.action.map"),
  graphTitle: t("pages.graph.title"),
  graphEmptyTitle: t("pages.graph.empty.title"),
  graphLegend3d: t("pages.graph.legend.pan.3d"),
  graphRendererWebgl: t("pages.graph.renderer.webgl"),
  graphRendererCanvas2d: t("pages.graph.renderer.canvas2d"),
  // fact detail
  factDetailTitle: t("details.fact.title"),
  evidenceIntro: plain("details.fact.evidence.intro"),
  evidenceEmpty: t("details.fact.evidence.empty.title"),
  evidenceHeading: tn("details.fact.evidence.title", 1, { n: "1" }).split(" · ")[0],
  contextTitle: t("details.fact.context.title"),
  contextOnly: t("details.source.contextOnly", { kind: "assistant_context" }),
  historyTab: t("details.fact.tab.history"),
  reuseTitle: t("details.fact.reuse.title"),
  reuseActive: t("details.fact.reuse.active"),
  tierLadder: plain("details.tier.ladder"),
  tierBranch: t("tier.workstream.branch", { branch: TIER_BRANCH }),
  tierBranchExplain: t("tier.workstream.explain.branch", { branch: TIER_BRANCH }),
  tierGlobal: t("tier.global.label"),
  tierProject: t("tier.project.label"),
  promoted: t("badge.PROMOTED.label"),
  badgeActive: t("badge.active.label"),
  badgeInactive: t("badge.inactive.label"),
  jobTarget: t("details.job.target.title"),
  operationStatus: t("details.operation.status"),
  operationCompleted: t("badge.completed.label"),
  // help layer
  helpFactsBody: t("help.page.facts.body"),
  helpScopeControl: t("help.control.scope.body"),
  glossaryCapsule: t("help.glossary.capsule.term"),
  // guidance
  attentionHeading: t("guidance.attention.heading"),
  jobDeadTitle: t("guidance.job-dead.title"),
  jobDeadImpact: t("guidance.job-dead.impact"),
  nextAction: t("activity.nextAction"),
  actionNeeded: t("guidance.ignorable.false"),
  pipelineConversations: t("pages.overview.pipeline.conversations.title"),
  // settings · diagnostics / sync / models / overlays
  diagnosticsReadable: t("settings.diagnostics.capabilities.present"),
  syncSwitchTitle: t("settings.sync.switch.title"),
  syncRunExport: t("settings.sync.run.title.export"),
  syncRunImport: t("settings.sync.run.title.import"),
  syncDeviceMissing: t("settings.sync.deviceId.missing"),
  syncRows: t("settings.sync.rows"),
  syncRejectedEmpty: t("settings.sync.rejected.empty"),
  archiveIntro: plain("settings.archive.intro"),
  archivePreviewTitle: t("settings.archive.preview.title"),
  archiveImportWarning: plain("settings.archive.import.modal.warning"),
  archivePreviewDeltas: t("settings.archive.preview.deltas", { added: "1", updated: "0", deleted: "0" }),
  importCountsRe: tRe("settings.sync.importCounts", {
    newFacts: "\\d+", updatedFacts: "\\d+", deletedFacts: "\\d+", newRevisions: "\\d+",
    newTombstones: "\\d+", newRecalls: "\\d+", updatedRecalls: "\\d+",
  }).source,
  modelHoldNoDamage: t("models.hold.noDamage"),
  modelHeldBadge: t("common.job.hold.model_config_rejected"),
  modelAltTitle: ALT_DICT["models.llm.title"],
  overlaysNotShared: t("overlays.notShared"),
  overlaysNoRecord: t("overlays.gate.test.caption"),
  overlaysOriginUser: t("overlays.gate.origin.user"),
  overlaysSavedToast: t("overlays.toast.saved", { revision: "1" }),
  overlaysVerifierUnchanged: t("overlays.rules.verifierUnchanged"),
  overlaysTiming: t("overlays.rules.timingBody"),
  overlaysHeld: t("overlays.rules.held.title"),
  // fixture values the probes type or look for
  branchFact: BRANCH_FACT,
  peerFact: PEER_FACT,
  peerAlias: PEER_ALIAS,
  localAlias: LOCAL_ALIAS,
  noMatchQuery: NO_MATCH_QUERY,
  overlayPattern: OVERLAY_PATTERN,
  overlayPatternText: OVERLAY_PATTERN_TEXT,
  overlayNote: OVERLAY_NOTE,
  maliciousVisible: MALICIOUS_VISIBLE,
  deadJobError: DEAD_JOB_ERROR,
  editedFact: EDITED,
  // ★ Content that is legitimately in the OTHER language because it is data, not
  // UI prose. The leak probe strips these before judging a text node, so the
  // exemption is a short, named list rather than "skip this subtree".
  userContent: LANG === "en"
    ? ["한글 사실은 안전하게 표시됩니다"]
    : [EDITED, DEAD_JOB_ERROR,
       "The 'gpt-6-astraX' model is not supported when using Codex with a ChatGPT account."],
};

const probe = (body) => `(async()=>{const L=${JSON.stringify(L)};${DRIVER}${body}})()`;

// ---------------------------------------------------------------------------
// Documentation screenshots (`--screenshots <dir>`), opt-in only.
//
// The release gate above deliberately seeds one hostile fact (an XSS probe) and
// asserts a single-row list, so it can never double as a presentable fixture.
// This pass therefore builds its own data root, server, Chrome profile and
// browser process from an invented demo project, and never touches the gate.
// ---------------------------------------------------------------------------
const SHOWCASE_PROJECT = "/Users/demo/projects/atlas-notes";
const SHOWCASE_PROJECT_ALT = "/Users/demo/projects/atlas-mobile";
// Demo content, fully bilingual: the English screenshots must not show a single
// Korean sentence (design §10.3), so every fixture row carries both wordings and
// `sc()` picks one. Nothing here is UI prose — it is the store's content.
const SHOWCASE_DOMAINS = [
  ["engineering", sc("엔지니어링", "Engineering"), sc("저장소, 동기화, 검색 런타임", "Storage, sync and the search runtime")],
  ["product", sc("제품 · 경험", "Product · experience"), sc("탐색 구조와 편집 경험", "Navigation structure and the editing experience")],
  ["operations", sc("운영 · 신뢰", "Operations · trust"), sc("관측, 보안, 진단", "Observability, security, diagnostics")],
  ["workflow", sc("작업 방식", "Ways of working"), sc("릴리스 절차와 팀 규칙", "Release process and team conventions")],
];
const SHOWCASE_CATEGORIES = [
  ["storage", "engineering", sc("로컬 저장소", "Local storage"), sc("SQLite 스키마와 파일 배치", "SQLite schema and file layout")],
  ["sync", "engineering", sc("동기화", "Sync"), sc("변경 로그 교환과 충돌 해결", "Change-log exchange and conflict resolution")],
  ["search", "engineering", sc("검색", "Search"), sc("FTS 인덱스와 임베딩 조회", "FTS index and embedding lookups")],
  ["navigation", "product", sc("정보 구조", "Information architecture"), sc("노트 목록과 탐색 경로", "Note lists and navigation paths")],
  ["editor", "product", sc("편집 경험", "Editing experience"), sc("단축키, 자동 저장, 서식", "Shortcuts, autosave, formatting")],
  ["observability", "operations", sc("관측 · 추적", "Observability · tracing"), sc("로그, 지표, 실패 기록", "Logs, metrics, failure records")],
  ["security", "operations", sc("보안 · 권한", "Security · permissions"), sc("자격 증명과 데이터 보호", "Credentials and data protection")],
  ["release", "workflow", sc("릴리스 절차", "Release process"), sc("브랜치, 태그, 배포 일정", "Branches, tags, release schedule")],
  ["conventions", "workflow", sc("팀 규칙", "Team conventions"), sc("리뷰, 문서화, 개인 선호", "Review, documentation, personal preferences")],
];
// [category, kind, Korean text, English text]
const SHOWCASE_FACTS = [
  ["storage", "decision", "노트 본문은 로컬 SQLite에 저장하고, 원격에는 변경 로그만 내보낸다.", "Atlas keeps note bodies in local SQLite and exports only the change log."],
  ["storage", "constraint", "노트 삭제는 즉시 파기하지 않고 30일 동안 휴지통에 보관한 뒤 정리한다.", "A deleted note is not destroyed at once: it stays in the trash for 30 days, then is cleaned up."],
  ["storage", "pattern", "첨부 파일은 본문 테이블과 분리해 콘텐츠 해시 경로에 저장한다.", "Attachments live under a content-hash path, separate from the body table."],
  ["storage", "knowledge", "데이터베이스 마이그레이션은 실행 전에 자동으로 스냅샷을 남긴다.", "A database migration snapshots itself automatically before it runs."],
  ["sync", "decision", "동기화 충돌은 마지막 쓰기 승리 대신 필드 단위 병합으로 해결한다.", "Sync resolves conflicts field by field instead of last-write-wins."],
  ["sync", "constraint", "동기화 실패를 조용히 넘기지 않고 실패 사유를 그대로 남긴다.", "A sync failure is never passed over quietly; its reason is kept verbatim."],
  ["sync", "pattern", "기기별 커서는 서버가 아니라 각 기기의 로컬 상태에 보관한다.", "Per-device cursors are kept in each device's local state, never on a server."],
  ["sync", "knowledge", "오프라인 편집은 재연결 시 한 번의 배치로 전송된다.", "Offline edits are sent as a single batch once the device reconnects."],
  ["search", "decision", "검색은 FTS5 인덱스를 먼저 조회하고, 결과가 부족할 때만 임베딩 검색으로 보완한다.", "Search queries FTS5 first and only falls back to embeddings when results are thin."],
  ["search", "constraint", "검색 인덱스 재구축은 사용자가 명시적으로 시작할 때만 실행한다.", "A search index rebuild runs only when the user starts it explicitly."],
  ["search", "knowledge", "제목 일치는 본문 일치보다 높은 가중치를 받는다.", "A title match is weighted higher than a body match."],
  ["navigation", "decision", "노트 목록의 기본 정렬은 최근 수정순이다.", "The note list sorts by most recently edited by default."],
  ["navigation", "preference", "사이드바 폭은 사용자가 조절한 값을 기기별로 기억한다.", "The sidebar width the user sets is remembered per device."],
  ["navigation", "pattern", "폴더 대신 태그를 기본 분류 수단으로 사용한다.", "Tags, not folders, are the primary way notes are classified."],
  ["editor", "constraint", "에디터 단축키는 운영체제의 기본 텍스트 단축키를 재정의하지 않는다.", "The editor never overrides the operating system's default text shortcuts."],
  ["editor", "decision", "자동 저장은 입력이 멈춘 뒤 800ms에 한 번만 실행한다.", "Autosave runs once, 800ms after typing stops."],
  ["editor", "preference", "마크다운 미리보기는 기본으로 접어 두고 필요할 때 펼친다.", "The markdown preview stays collapsed by default and opens on demand."],
  ["observability", "constraint", "로그에는 노트 제목과 본문을 남기지 않는다.", "Logs never carry note titles or note bodies."],
  ["observability", "knowledge", "성능 회귀는 노트 1,000개 기준 벤치마크로 확인한다.", "Performance regressions are measured against a 1,000-note benchmark."],
  ["observability", "pattern", "수집되지 않은 지표는 0이 아니라 미수집으로 표시한다.", "Uncollected metrics are shown as not-collected, never as zero."],
  ["security", "constraint", "인증 토큰은 운영체제 키체인에 저장하고 설정 파일에 남기지 않는다.", "Auth tokens are kept in the OS keychain and never written to a config file."],
  ["security", "decision", "원격 저장소는 노트 본문을 평문으로 보관하지 않는다.", "The remote store never holds note bodies in plain text."],
  ["security", "knowledge", "내보내기 파일에는 기기 식별자를 포함하지 않는다.", "An export file carries no device identifier."],
  ["release", "decision", "릴리스는 매월 첫째 주 화요일에만 태그한다.", "Releases are tagged only on the first Tuesday of the month."],
  ["release", "pattern", "핫픽스는 릴리스 브랜치에서 분기하고 main으로 되돌려 병합한다.", "A hotfix branches off the release branch and merges back into main."],
  ["release", "constraint", "실험 기능은 기본 꺼짐 상태로 배포하고 설정에서만 켠다.", "Experimental features ship off by default and are turned on in settings only."],
  ["conventions", "decision", "변경은 최소 한 명의 리뷰 승인을 받은 뒤 병합한다.", "A change merges only after at least one review approval."],
  ["conventions", "preference", "회의록은 별도 도구 대신 Atlas 노트 안에서 관리한다.", "Meeting notes are kept inside Atlas notes rather than in a separate tool."],
  ["conventions", "knowledge", "공개 동작이 바뀌면 같은 변경에서 문서도 함께 고친다.", "When public behaviour changes, the documentation changes in the same commit."],
];
const SHOWCASE_GLOBAL_FACTS = [
  ["conventions", "preference", "커밋 메시지는 무엇을 왜 바꿨는지 한 문장으로 먼저 적는다.", "A commit message opens with one sentence on what changed and why."],
  ["observability", "preference", "실패한 작업은 재시도 횟수와 마지막 오류를 함께 확인한다.", "A failed job is reviewed together with its retry count and its last error."],
  ["conventions", "knowledge", "설계 결정은 결정 시점의 근거와 함께 기록해 둔다.", "A design decision is recorded together with the reasoning behind it."],
];
const SHOWCASE_ALT_FACTS = [
  ["storage", "decision", "모바일은 최근 200개 노트만 오프라인으로 보관한다.", "Mobile keeps only the 200 most recent notes offline."],
  ["editor", "constraint", "모바일 편집기는 첨부 업로드를 25MB로 제한한다.", "The mobile editor caps attachment uploads at 25MB."],
  ["navigation", "preference", "모바일 첫 화면은 검색이 아니라 최근 노트를 보여준다.", "The mobile home screen shows recent notes rather than search."],
];
// [session title, opening user turn]
const SHOWCASE_SESSIONS = [
  [sc("로컬 우선 저장 구조를 어떻게 잡을까?", "How should local-first storage be laid out?"), sc("노트 본문과 첨부를 어디에 두는지 정리하고 싶어.", "I want to settle where note bodies and attachments live.")],
  [sc("두 기기에서 같은 노트를 고치면 어떻게 되지?", "What happens when the same note is edited on two devices?"), sc("충돌 처리 규칙을 정해두자.", "Let's pin down the conflict rules.")],
  [sc("검색이 느려지는 구간을 찾아보자.", "Let's find where search slows down."), sc("인덱스 구성과 조회 순서를 확인하고 싶어.", "I want to check the index layout and the lookup order.")],
  [sc("에디터 단축키 정책을 확정하자.", "Let's settle the editor shortcut policy."), sc("운영체제 기본 동작과 겹치는 부분이 문제야.", "The overlap with the operating system defaults is the problem.")],
  [sc("첨부 파일 저장 위치를 정리하자.", "Let's tidy up where attachments are stored."), sc("본문과 같은 테이블에 두면 나중에 곤란할 것 같아.", "Keeping them in the body table will hurt us later.")],
  [sc("릴리스와 핫픽스 흐름을 문서로 남기자.", "Let's write down the release and hotfix flow."), sc("브랜치 규칙이 사람마다 다르게 이해되고 있어.", "People read the branch rules differently.")],
  [sc("토큰 보관과 로그 정책을 점검하자.", "Let's review token storage and the logging policy."), sc("설정 파일에 토큰이 남는 경로가 있는지 확인해줘.", "Check whether a token can end up in a config file.")],
  [sc("노트 목록 정렬과 사이드바 동작을 맞추자.", "Let's align note-list sorting with the sidebar."), sc("기기마다 다르게 보이는 이유를 알고 싶어.", "I want to know why it looks different on each device.")],
  [sc("성능 회귀를 어떤 기준으로 볼까?", "What should a performance regression be measured against?"), sc("벤치마크 조건을 고정해두면 좋겠어.", "Pinning the benchmark conditions would help.")],
];
const SHOWCASE_SESSIONS_ALT = [
  [sc("모바일 오프라인 편집 범위를 정하자.", "Let's decide how much mobile keeps offline."), sc("전부 내려받는 건 현실적이지 않아 보여.", "Downloading everything does not look realistic.")],
  [sc("모바일 업로드 제한을 얼마로 둘까?", "What should the mobile upload limit be?"), sc("큰 첨부에서 실패가 반복되고 있어.", "Large attachments keep failing.")],
  [sc("모바일 첫 화면 구성을 정리하자.", "Let's tidy up the mobile home screen."), sc("실제로 가장 많이 쓰는 동선을 기준으로 하자.", "Let's base it on the path people actually use.")],
];

/** Build a presentable demo database against the real core schema. */
function seedShowcase(initDatabase, dbPath) {
  const db = initDatabase({ dbPath });
  // The en and ko passes run minutes apart, so a raw `Date.now()` would put the
  // two sets of shots in different relative-time buckets and, across midnight,
  // on different calendar days. Anchoring on today's UTC noon keeps every
  // rendered date and every "N days ago" identical between the two runs.
  const now = Date.parse(new Date().toISOString().slice(0, 10) + "T12:00:00.000Z");
  const at = (minutes) => new Date(now - minutes * 60000).toISOString();
  const run = (sql, args) => db.prepare(sql).run(...args);
  const uid = (n) => `7c1f0a20-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const projects = [
    ["project-atlas-notes", "Atlas Notes", SHOWCASE_PROJECT, "main"],
    ["project-atlas-mobile", "Atlas Mobile", SHOWCASE_PROJECT_ALT, "release/1.4"],
  ];
  for (const [projectId, displayName, canonical, branch] of projects) {
    run(
      "INSERT INTO projects (project_id, portable_project_key, display_name, memory_revision, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      [projectId, "demo:" + projectId, displayName, 0, at(60 * 24 * 90), at(30)],
    );
    run(
      "INSERT INTO workspaces (workspace_id, project_id, device_id, canonical_path, location_kind, branch, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
      [
        "workspace-" + projectId,
        projectId,
        "device-demo",
        canonical,
        "directory",
        branch,
        at(30),
        at(60 * 24 * 90),
      ],
    );
  }
  for (const [id, name, description] of SHOWCASE_DOMAINS)
    run(
      "INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?,?,?,?)",
      [id, name, description, at(60 * 24 * 60)],
    );
  for (const [id, domainId, name, description] of SHOWCASE_CATEGORIES)
    run(
      "INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?,?,?,?,?)",
      [id, domainId, name, description, at(60 * 24 * 60)],
    );

  // Sessions: newest first, spread across the 30-day activity window.
  const sessions = [];
  let rowid = 1000;
  const addSession = (index, project, projectId, spec, alt) => {
    const sessionId = (alt ? "atlas-mobile-" : "atlas-notes-") + (index + 1);
    const workstreamId = "stream-" + sessionId;
    const ageBase = (alt ? 60 * 24 * (3 + index * 6) : 60 * 24 * index * 3) + 120;
    run(
      "INSERT INTO minimal_workstreams (workstream_id, project, session_id, branch_hint, binding_reason, created_at, updated_at, project_id, workspace_id, status) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        workstreamId,
        project,
        sessionId,
        alt ? "release/1.4" : "main",
        "session-local",
        at(ageBase + 40),
        at(ageBase),
        projectId,
        "workspace-" + projectId,
        "active",
      ],
    );
    const turns = 3 + (index % 3);
    const exchanges = [];
    for (let t = 0; t < turns; t++) {
      const id = sessionId + "-turn-" + (t + 1);
      const age = ageBase - t * 7;
      run(
        "INSERT INTO exchanges (id, project, project_id, workspace_id, workstream_id, session_id, timestamp, user_message, assistant_message, archive_path, line_start, line_end, cwd, git_branch, exchange_seq, content_generation, content_hash, closure_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          id,
          project,
          projectId,
          "workspace-" + projectId,
          workstreamId,
          sessionId,
          at(age),
          t === 0
            ? spec[0]
            : t === 1
              ? spec[1]
              : sc(
                  "결정한 내용을 기록해 두고, 나중에 근거를 찾을 수 있게 원문 위치도 남겨줘.",
                  "Record what we decided, and keep the transcript location so the evidence can be found later.",
                ),
          t === 0
            ? sc(
                "현재 구조를 확인한 뒤, 결정할 지점과 이미 정해진 제약을 나눠서 정리하겠습니다.",
                "I will look at the current structure, then separate what still needs deciding from the constraints already fixed.",
              )
            : sc(
                "정리한 결정과 그 근거가 된 대화 위치를 함께 남겨두겠습니다. 확정되지 않은 항목은 결정으로 기록하지 않습니다.",
                "I will record each decision together with the conversation location that supports it. Anything still unsettled is not recorded as a decision.",
              ),
          "/Users/demo/.config/atlas/archive/" + sessionId + ".jsonl",
          t * 2 + 1,
          t * 2 + 2,
          project,
          alt ? "release/1.4" : "main",
          t,
          1,
          "sha256:demo-" + id,
          "closed",
        ],
      );
      exchanges.push({ id, rowid: ++rowid, age });
    }
    run(
      "INSERT INTO extraction_log (session_id, processed_at, extracted, saved, dropped_batches, last_exchange_rowid) VALUES (?,?,?,?,?,?)",
      [sessionId, at(ageBase - turns * 7), turns, Math.max(1, turns - 1), 0, rowid],
    );
    sessions.push({ sessionId, workstreamId, project, projectId, exchanges, ageBase, spec });
    return sessions[sessions.length - 1];
  };
  SHOWCASE_SESSIONS.forEach((spec, i) =>
    addSession(i, SHOWCASE_PROJECT, "project-atlas-notes", spec, false),
  );
  SHOWCASE_SESSIONS_ALT.forEach((spec, i) =>
    addSession(i, SHOWCASE_PROJECT_ALT, "project-atlas-mobile", spec, true),
  );

  // One durable job pipeline per session, with a couple of honest non-success
  // states so the jobs screen is not a wall of green.
  sessions.forEach((session, index) => {
    const state =
      index === 0 ? "running" : index === 3 ? "retry" : index === 6 ? "dead" : "completed";
    const lastError =
      state === "retry"
        ? sc(
            "MODEL_BUDGET_EXHAUSTED: 이번 실행의 시도 예산을 모두 사용했습니다.",
            "MODEL_BUDGET_EXHAUSTED: this run used up its attempt budget.",
          )
        : state === "dead"
          ? sc(
              "EVIDENCE_UNRESOLVED: 근거로 지목된 원문을 다시 찾지 못했습니다.",
              "EVIDENCE_UNRESOLVED: the transcript named as evidence could not be found again.",
            )
          : null;
    const targetId = "target-" + session.sessionId;
    const budgetId = "budget-" + session.sessionId;
    const checkpointId = "checkpoint-" + session.sessionId;
    run(
      "INSERT INTO checkpoints (checkpoint_id, session_id, workspace_id, workstream_id, ordinal, kind, closure_state, state, idempotency_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        checkpointId,
        session.sessionId,
        "workspace-" + session.projectId,
        session.workstreamId,
        index + 1,
        "stop",
        "closed",
        "captured",
        "demo-checkpoint-" + session.sessionId,
        at(session.ageBase - 1),
      ],
    );
    run(
      "INSERT INTO extraction_targets (target_id, session_id, project, from_rowid, through_rowid, cursor_ordinal, item_count, policy_version, state, lease_owner, lease_until, attempts, last_error, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        targetId,
        session.sessionId,
        session.project,
        session.exchanges[0].rowid,
        session.exchanges[session.exchanges.length - 1].rowid,
        0,
        session.exchanges.length,
        "facts-v4",
        state,
        state === "running" ? "worker-demo" : null,
        state === "running" ? at(-4) : null,
        state === "retry" ? 2 : 1,
        lastError,
        "demo-target-" + session.sessionId,
        at(session.ageBase - 2),
        at(session.ageBase - 6),
      ],
    );
    session.exchanges.forEach((exchange, ordinal) =>
      run(
        "INSERT INTO extraction_target_items (target_id, ordinal, exchange_id, exchange_rowid, content_generation, content_hash, state) VALUES (?,?,?,?,?,?,?)",
        [
          targetId,
          ordinal,
          exchange.id,
          exchange.rowid,
          1,
          "sha256:demo-" + exchange.id,
          state === "running" ? "processing" : state === "retry" ? "retry" : "processed",
        ],
      ),
    );
    session.exchanges.forEach((exchange) =>
      run(
        "INSERT INTO exchange_extraction_state (exchange_id, content_generation, policy_version, state, target_id, processed_at) VALUES (?,?,?,?,?,?)",
        [
          exchange.id,
          1,
          "facts-v4",
          state === "running" ? "processing" : state === "retry" ? "retry" : "processed",
          targetId,
          state === "running" ? null : at(session.ageBase - 6),
        ],
      ),
    );
    run(
      "INSERT INTO model_work_budgets (budget_id, parent_wave_id, state, max_attempts, reserved_attempts, max_input_chars, max_output_chars, deadline_at, created_at, updated_at, automatic) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        budgetId,
        "wave-demo-" + index,
        state === "retry" ? "exhausted" : state === "running" ? "active" : "completed",
        12,
        state === "retry" ? 12 : 1,
        60000,
        16000,
        at(session.ageBase - 20),
        at(session.ageBase - 2),
        at(session.ageBase - 6),
        1,
      ],
    );
    run(
      "INSERT INTO memory_jobs (job_id, kind, partition_key, checkpoint_id, target_id, from_cursor, through_cursor, policy_version, priority, state, available_at, lease_owner, lease_until, attempts, max_attempts, last_error, idempotency_key, created_at, updated_at, budget_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "job-" + session.sessionId,
        "fact_extract",
        "session:" + session.sessionId,
        checkpointId,
        targetId,
        0,
        session.exchanges.length,
        "facts-v4",
        100,
        state,
        at(session.ageBase - 10),
        state === "running" ? "worker-demo" : null,
        state === "running" ? at(-4) : null,
        state === "retry" ? 2 : 1,
        5,
        lastError,
        "demo-job-" + session.sessionId,
        at(session.ageBase - 2),
        at(session.ageBase - 6),
        budgetId,
      ],
    );
    const attempts = state === "retry" ? 2 : 1;
    for (let n = 1; n <= attempts; n++)
      run(
        "INSERT INTO model_work_attempts (attempt_id, budget_id, attempt_no, stage, job_id, target_id, state, started_at, finished_at, duration_ms, input_chars, output_chars, token_usage_json, token_usage_status, error_class, error_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          "attempt-" + session.sessionId + "-" + n,
          budgetId,
          n,
          "fact-extraction",
          "job-" + session.sessionId,
          targetId,
          state === "running"
            ? "reserved"
            : state === "retry" || state === "dead"
              ? "failed"
              : "completed",
          at(session.ageBase - 3 - n),
          state === "running" ? null : at(session.ageBase - 6),
          state === "running" ? null : 2410 + index * 137 + n * 41,
          4200 + index * 260,
          state === "running" ? null : 640 + index * 27,
          index % 3 === 0
            ? null
            : JSON.stringify({ input_tokens: 1180 + index * 24, output_tokens: 210 + index * 9 }),
          index % 3 === 0 ? "NOT_PROVEN" : "observed",
          state === "retry" ? "deadline_exceeded" : state === "dead" ? "evidence_unresolved" : null,
          state === "retry"
            ? sc("모델 작업 기한을 초과했습니다.", "The model work deadline was exceeded.")
            : state === "dead"
              ? sc(
                  "근거 원문을 확인하지 못해 저장하지 않았습니다.",
                  "Nothing was saved because the evidence transcript could not be confirmed.",
                )
              : null,
        ],
      );
    // Capture indexing and Work Capsule jobs run on the same queue; showing only
    // extraction would misrepresent what the jobs tab actually lists.
    for (const [suffix, kind, jobState, minutes] of [
      ["index", "capture_index", "completed", 8],
      ["capsule", "capsule_update", index === 1 ? "retry" : "completed", 7],
    ]) {
      if (kind === "capsule_update" && index > 3) continue;
      run(
        "INSERT INTO memory_jobs (job_id, kind, partition_key, checkpoint_id, target_id, from_cursor, through_cursor, policy_version, priority, state, available_at, attempts, max_attempts, last_error, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          "job-" + session.sessionId + "-" + suffix,
          kind,
          "session:" + session.sessionId,
          checkpointId,
          null,
          0,
          session.exchanges.length,
          "continuity-v1",
          kind === "capture_index" ? 10 : 50,
          jobState,
          at(session.ageBase - minutes),
          jobState === "retry" ? 2 : 1,
          5,
          jobState === "retry"
            ? sc(
                "CAPSULE_STALE: 이후 턴이 먼저 반영되어 이 갱신을 다시 계산합니다.",
                "CAPSULE_STALE: a later turn landed first, so this update is recomputed.",
              )
            : null,
          "demo-job-" + session.sessionId + "-" + suffix,
          at(session.ageBase - 2),
          at(session.ageBase - minutes),
        ],
      );
    }
    if (state === "retry")
      run(
        "INSERT INTO extraction_failed_ranges (failure_id, target_id, from_ordinal, through_ordinal, from_rowid, through_rowid, payload_fingerprint, error_kind, error_message, state, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          "failure-" + session.sessionId,
          targetId,
          0,
          session.exchanges.length - 1,
          session.exchanges[0].rowid,
          session.exchanges[session.exchanges.length - 1].rowid,
          "demo-payload",
          "model_budget",
          sc(
            "작업 기한을 초과해 이 구간을 재시도 대상으로 남겼습니다.",
            "The deadline was exceeded, so this range is left for a retry.",
          ),
          "retry",
          2,
          at(session.ageBase - 2),
          at(session.ageBase - 6),
        ],
      );
  });

  // Facts, bound to real exchanges in the same project so the evidence tab has something
  // to show, plus a smaller alternate project and a few global preferences.
  const mainSessions = sessions.filter((s) => s.project === SHOWCASE_PROJECT);
  const altSessions = sessions.filter((s) => s.project === SHOWCASE_PROJECT_ALT);
  const factIds = [];
  let seq = 0;
  const addFact = (index, entry, options) => {
    const [category, kind, korean, english] = entry;
    // ★ The run's language IS the stored original; `fact_kr` stays null. Filling
    // it would put a "· translated" meta line and a "stored original" fold into
    // the shots, which is a different feature than the one being documented.
    const primary = sc(korean, english);
    const id = uid(index + 1);
    const session = options.session;
    const source = session.exchanges[index % session.exchanges.length];
    const context = session.exchanges[(index + 1) % session.exchanges.length];
    const updatedAt = at(60 * index + 25);
    const inactive = index === 17;
    run(
      "INSERT INTO facts (id, fact, fact_kr, category, scope_type, scope_project, project_id, workspace_id, workstream_id, promotion_state, subject_key, is_active, ontology_category_id, source_exchange_ids, consolidated_count, created_at, updated_at, semantic_generation, semantic_updated_at, lifecycle_generation, lifecycle_updated_at, embedding_version, needs_consolidation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        primary,
        null,
        kind,
        options.global ? "global" : "project",
        options.global ? null : session.project,
        options.global ? null : session.projectId,
        null,
        null,
        options.global ? "legacy-project" : index === 4 ? "decision" : "legacy-project",
        "atlas." + category + "." + (index + 1),
        inactive ? 0 : 1,
        index === 11 ? null : category,
        JSON.stringify([source.id]),
        1 + (index % 3),
        at(60 * 24 * 20 + index * 90),
        updatedAt,
        index % 4 === 0 ? 2 : 1,
        updatedAt,
        1,
        updatedAt,
        1,
        0,
      ],
    );
    factIds.push({ id, category, text: primary, global: !!options.global, project: session.project });
    run(
      "INSERT INTO fact_context_dependencies (fact_id, exchange_id, dependency_kind, created_at) VALUES (?,?,?,?)",
      [id, context.id, "assistant_context", updatedAt],
    );
    run(
      "INSERT INTO fact_evidence_receipts (fact_id, semantic_generation, fact_hash, source_snapshot_json, method, verified_at) VALUES (?,?,?,?,?,?)",
      [
        id,
        index % 4 === 0 ? 2 : 1,
        "sha256:demo-fact-" + (index + 1),
        JSON.stringify([{ id: source.id, text: source.id }]),
        "extractor",
        updatedAt,
      ],
    );
    const changed = index % 4 === 0;
    run(
      "INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at, project_id, subject_key, event_kind, from_semantic_generation, to_semantic_generation, lifecycle_generation, rationale, source_exchange_ids, source_evidence_ids, related_event_ids, actor, policy_version, evidence_authority, effective_at, effective_at_source, recorded_at, projection_applied, chronicle_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "event-" + (++seq),
        id,
        changed
          ? sc("이 항목은 아직 결정되지 않은 후보였습니다.", "This entry was still an undecided candidate.")
          : null,
        primary,
        null,
        source.id,
        updatedAt,
        options.global ? null : session.projectId,
        "atlas." + category + "." + (index + 1),
        changed ? "CHANGED" : "ASSERTED",
        changed ? 1 : null,
        index % 4 === 0 ? 2 : 1,
        1,
        changed
          ? sc(
              "대화에서 확정된 표현으로 문장을 교체하고 근거를 다시 연결했습니다.",
              "The wording was replaced with the phrasing settled in the conversation and the evidence was relinked.",
            )
          : sc(
              "사용자가 직접 확정한 문장을 그대로 기록했습니다.",
              "Recorded exactly as the user settled it.",
            ),
        JSON.stringify([source.id]),
        "[]",
        "[]",
        changed ? "user" : "extractor",
        "facts-v4",
        "human",
        at(60 * index + 90),
        "source",
        updatedAt,
        1,
        seq,
      ],
    );
    return id;
  };
  SHOWCASE_FACTS.forEach((entry, i) =>
    addFact(i, entry, { session: mainSessions[i % mainSessions.length] }),
  );
  SHOWCASE_ALT_FACTS.forEach((entry, i) =>
    addFact(SHOWCASE_FACTS.length + i, entry, {
      session: altSessions[i % altSessions.length],
    }),
  );
  SHOWCASE_GLOBAL_FACTS.forEach((entry, i) =>
    addFact(SHOWCASE_FACTS.length + SHOWCASE_ALT_FACTS.length + i, entry, {
      session: mainSessions[i % mainSessions.length],
      global: true,
    }),
  );

  // Relations stay inside one project (the core forbids cross-project edges).
  const relatable = factIds.filter((f) => f.global || f.project === SHOWCASE_PROJECT);
  const types = ["SUPPORTS", "INFLUENCES", "SUPERSEDES", "CONTRADICTS"];
  let relation = 0;
  for (let i = 1; i < relatable.length; i++) {
    for (const offset of [1, 4, 7]) {
      const target = relatable[i - offset];
      if (!target || (i + offset) % 3 === 0) continue;
      run(
        "INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at) VALUES (?,?,?,?,?,?)",
        [
          "relation-" + ++relation,
          relatable[i].id,
          types[(i + offset) % types.length],
          target.id,
          sc(
            "같은 설계 주제를 서로 다른 관점에서 설명하는 기억입니다.",
            "Memories that explain the same design topic from different angles.",
          ),
          at(60 * i + 20),
        ],
      );
    }
  }
  mainSessions.slice(0, 6).forEach((session, i) =>
    run(
      "INSERT INTO recall_events (id, session_id, project, prompt_hash, fact_ids, source_type, learnable, status, created_at, emitted_at, project_id, context_epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "recall-" + (i + 1),
        session.sessionId,
        session.project,
        "sha256:demo-prompt-" + (i + 1),
        JSON.stringify([factIds[i].id, factIds[i + 6].id]),
        "memex_recall",
        0,
        i === 0 ? "prepared" : "emitted",
        at(session.ageBase - 8),
        i === 0 ? null : at(session.ageBase - 8),
        session.projectId,
        1,
      ],
    ),
  );
  db.close();
  return {
    facts: factIds,
    evidenceFactId: factIds[0].id,
    jobId: "job-" + mainSessions[0].sessionId,
    graphLabel: factIds[0].text,
  };
}

/** Capture one framed surface. `after` runs between the probe and the shot. */
async function showcaseShot(cdp, url, body, file, after) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId).catch(() => {});
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    const loaded = cdp.wait("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url }, sessionId);
    await loaded;
    const evaluate = async (expression) => {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        );
      return result.result.value;
    };
    const value = await evaluate(probe(body));
    const extra = after ? await after({ evaluate, sessionId, value }) : null;
    const shot = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      sessionId,
    );
    fs.writeFileSync(path.join(SCREENSHOTS, LANG, file), Buffer.from(shot.data, "base64"));
    return { file, value, extra };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function captureShowcase() {
  const temp = fs.mkdtempSync("/tmp/memex-web-ui-shots-");
  const xdg = path.join(temp, "xdg");
  const home = path.join(xdg, "memex");
  const dbPath = path.join(home, "conversation-index", "db.sqlite");
  let server;
  let browser;
  let shotCdp;
  try {
    // `--screenshots assets/readme --lang en` writes assets/readme/en/*.png. The
    // subdirectory is chosen here, not by the caller, so the flag and the folder
    // can never disagree.
    fs.mkdirSync(path.join(SCREENSHOTS, LANG), { recursive: true });
    const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
    const seeded = seedShowcase(initDatabase, dbPath);
    const port = await freePort();
    server = startServer(port, home, xdg);
    await server.ready;
    // SwiftShader keeps the WebGL layer inside the captured frame; headless
    // Chrome's default compositor screenshots the GPU layer blank.
    browser = startChrome(path.join(temp, "chrome-profile"), [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
    ]);
    shotCdp = new Cdp(await browser.ready);
    await shotCdp.connect();
    const base = "http://127.0.0.1:" + port;
    // `?lang` outranks every stored preference, and the dark-mode shot writes to
    // localStorage, so the language is pinned on the URL as well as in the server
    // env: env alone loses to storage, URL alone flashes the default on first paint.
    const scope =
      "?scope=project&project=" +
      encodeURIComponent(SHOWCASE_PROJECT) +
      "&includeGlobal=1&lang=" +
      LANG;
    const settled = `
      await until('page rendered',()=>document.querySelector('#main .page-header h1'));
      await until('shell rendered',()=>document.querySelector('#sidebar .nav-item'));
    `;
    const results = [];

    results.push(
      await showcaseShot(
        shotCdp,
        base + "/" + scope,
        `${settled}
         await until('pipeline',()=>document.querySelectorAll('#main .status-list .status-step').length===4);
         await until('metrics',()=>document.querySelectorAll('#main .metric').length===4);
         await until('chronicle',()=>document.querySelectorAll('#main .timeline-item,#main .event-row,#main .card .session-mini').length);
         await sleep(350);
         return {heading:text('#main .page-header h1')};`,
        "overview.png",
      ),
    );

    results.push(
      await showcaseShot(
        shotCdp,
        base +
          "/facts" +
          scope +
          "&panel=fact&item=" +
          encodeURIComponent(seeded.evidenceFactId) +
          "&panelTab=evidence",
        `${settled}
         await until('rows',()=>document.querySelectorAll('#main .data-table tbody tr').length>5);
         const body=await until('evidence tab',()=>{
           const el=document.querySelector('#detail[open] .drawer-body');
           return el&&el.textContent.includes(L.contextTitle)?el:null;
         });
         await sleep(350);
         return {tab:text('#detail .tab.active'),hasDirectEvidence:body.textContent.includes(L.evidenceHeading)};`,
        "facts-detail.png",
      ),
    );

    const graph = await showcaseShot(
      shotCdp,
      base + "/graph" + scope,
      `${settled}
       const stage=document.querySelector('#graph-stage .graph-canvas');
       await until('map painted',()=>mapPixels(stage)||null,20000);
       const canvas=stage,tip=document.querySelector('#graph-stage .graph-tooltip');
       const r=canvas.getBoundingClientRect();
       // The stage runs past the fold; only nodes inside the captured frame,
       // with room for the label above and the tooltip below, are candidates.
       const top=Math.max(r.top+60,90),bottom=Math.min(r.bottom-20,innerHeight-150);
       const left=r.left+40,right=r.right-40;
       const hits=new Map();
       // pick() has a 13px radius, so a 12px grid can never miss a drawn node.
       for(let y=top;y<bottom;y+=12)
         for(let x=left;x<right;x+=12){
           canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
           if(!tip.hidden&&!hits.has(tip.textContent))hits.set(tip.textContent,{x,y});
         }
       if(!hits.size)throw new Error('no pickable node found inside the captured frame');
       const cx=(left+right)/2,cy=(top+bottom)/2;
       let pick=null;
       for(const [label,point] of hits){
         const d=Math.hypot(point.x-cx,point.y-cy);
         if(!pick||d<pick.d)pick={label,...point,d};
       }
       return {renderer:text('#graph-renderer'),meta:text('#graph-stage .graph-meta'),label:pick.label,x:Math.round(pick.x),y:Math.round(pick.y)};`,
      "graph.png",
      // Selection needs a trusted pointer sequence (the canvas calls
      // setPointerCapture), so the click goes through the input domain. The
      // drawer it opens is then closed again: the engine keeps the selection,
      // and the map — ring, label, relation arrows — stays the subject.
      async ({ evaluate, sessionId, value }) => {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
          await shotCdp.send(
            "Input.dispatchMouseEvent",
            {
              type,
              x: value.x,
              y: value.y,
              button: "left",
              buttons: type === "mousePressed" ? 1 : 0,
              clickCount: 1,
            },
            sessionId,
          );
        return evaluate(
          probe(`
            await until('selection drawer',()=>document.querySelector('#detail[open] .drawer-quote'));
            const selected=text('#detail .drawer-quote');
            document.querySelector('#detail [data-action="close-detail"]').click();
            await until('drawer closed',()=>!document.querySelector('#detail').open);
            const canvas=document.querySelector('#graph-stage .graph-canvas');
            canvas.dispatchEvent(new PointerEvent('pointermove',{clientX:${value.x},clientY:${value.y},bubbles:true,pointerId:1}));
            await sleep(450);
            return {selected,tooltip:document.querySelector('#graph-stage .graph-tooltip')?.textContent||''};
          `),
        );
      },
    );
    results.push(graph);

    results.push(
      await showcaseShot(
        shotCdp,
        base + "/activity" + scope + "&tab=jobs&panel=job&item=" + encodeURIComponent(seeded.jobId),
        `${settled}
         await until('job rows',()=>document.querySelectorAll('#main .data-table tbody tr').length>3);
         await until('job drawer',()=>{
           const el=document.querySelector('#detail[open] .drawer-body');
           return el&&el.textContent.includes(L.jobTarget)?el:null;
         });
         await sleep(350);
         return {title:text('#detail .drawer-title'),rows:document.querySelectorAll('#main .data-table tbody tr').length};`,
        "activity-jobs.png",
      ),
    );

    results.push(
      await showcaseShot(
        shotCdp,
        base + "/" + scope,
        `${settled}
         await until('pipeline',()=>document.querySelectorAll('#main .status-list .status-step').length===4);
         document.querySelector('[data-action="theme"]').click();
         await until('dark applied',()=>document.documentElement.dataset.theme==='dark');
         await sleep(400);
         return {theme:document.documentElement.dataset.theme};`,
        "overview-dark.png",
      ),
    );
    return { seeded, results };
  } finally {
    shotCdp?.close();
    await stop(browser?.child);
    await stop(server?.child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

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
  const { resolveProjectWorkspace } = await import(
    path.join(ROOT, "dist", "continuity-identity.js")
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
    CONTEXT_USER,
    CONTEXT_ASSISTANT,
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
  // Taxonomy seed: the topic filter on /facts and the "show on map" link on
  // /taxonomy both need one classified fact. The edit probe below clears
  // ontology_category_id (core resets it on a meaning change), so every
  // taxonomy assertion has to run before the mutation probe.
  db.prepare(
    "INSERT INTO ontology_domains (id, name, description) VALUES (?, ?, ?)",
  ).run(DOMAIN_ID, DOMAIN_NAME, DOMAIN_DESC);
  db.prepare(
    "INSERT INTO ontology_categories (id, domain_id, name, description) VALUES (?, ?, ?, ?)",
  ).run(CATEGORY_ID, DOMAIN_ID, CATEGORY_NAME, CATEGORY_DESC);
  db.prepare("UPDATE facts SET ontology_category_id = ? WHERE id = ?").run(
    CATEGORY_ID,
    factId,
  );
  // #22: one project memory parked on the branch tier. It is invisible to the project
  // screen's default predicate, which is exactly what the hiddenByTier banner, the
  // tiers=all toggle and a real promoteFact() call have to prove.
  // Identity comes from the core, not from invented rows: resolveProjectWorkspace keys the
  // workspace on this device, so a hand-written row would let a later core call mint a second
  // project for the same path and make every project-scoped read AMBIGUOUS_PROJECT.
  const identity = resolveProjectWorkspace(db, {
    cwd: CONTEXT_PROJECT,
    locationKind: "directory",
    branch: TIER_BRANCH,
    gitCommonDir: null,
    remoteFingerprint: null,
  });
  db.prepare(
    "INSERT INTO minimal_workstreams (workstream_id, project, session_id, branch_hint, binding_reason, created_at, updated_at, project_id, workspace_id, status) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(TIER_WORKSTREAM_ID, CONTEXT_PROJECT, "web-ui-tier-session", TIER_BRANCH, "session-local", TIER_AT, TIER_AT, identity.projectId, identity.workspaceId, "active");
  const branchFactId = insertFact(db, {
    fact: BRANCH_FACT,
    category: "decision",
    scope_type: "project",
    scope_project: CONTEXT_PROJECT,
    source_exchange_ids: [],
    embedding: new Array(384).fill(0.2),
    embedding_version: 1,
    project_id: identity.projectId,
    workspace_id: identity.workspaceId,
    workstream_id: TIER_WORKSTREAM_ID,
    promotion_state: "workstream",
    promotion_evidence: "experimental",
    tier_reason: "branch:" + TIER_BRANCH,
  });
  // Kept older than the hostile fact so every existing "first row" assertion still
  // reads the row it was written for.
  db.prepare("UPDATE facts SET created_at = ?, updated_at = ? WHERE id = ?").run(TIER_AT, TIER_AT, branchFactId);
  // #23/#79: one dead capsule job carrying the historical bound error. The catalogue must
  // classify it by its terminal STATE (recovery required), keep the stored error text visible,
  // and `memex recover --all-dead` has to clear it.
  db.prepare(
    "INSERT INTO memory_jobs (job_id, kind, partition_key, policy_version, priority, state, available_at, attempts, max_attempts, last_error, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(DEAD_JOB_ID, "capsule_update", "session:web-ui-tier-session", "capsule-v1", 100, "dead", TIER_AT, 5, 5, DEAD_JOB_ERROR, "e2e-dead-job", TIER_AT, TIER_AT);
  db.close();

  // #48 (0.6.3): a SECOND data root stands in for the other Mac. It exports one
  // generation as a zip with the real core (sync switched off, no shared folder),
  // and the browser then drives this server's manual file import against that file —
  // a genuine two-root round trip through the UI, without touching a real home.
  const PEER_HOME = path.join(TEMP, "peer-home");
  const peerArchive = await (async () => {
    process.env.MEMEX_HOME = PEER_HOME;
    delete process.env.MEMEX_SYNC_DIR;
    try {
      const peerDb = initDatabase();
      try {
        insertFact(peerDb, {
          fact: PEER_FACT,
          category: "knowledge",
          scope_type: "global",
          scope_project: null,
          source_exchange_ids: [],
          embedding: new Array(384).fill(0.3),
          embedding_version: 1,
        });
      } finally {
        peerDb.close();
      }
      const control = await import(path.join(ROOT, "dist", "sync-control.js"));
      // The device id only exists after an export, so name it and export again:
      // the alias has to reach the importing device inside the manifest.
      const first = control.exportGenerationArchive();
      control.setDeviceAlias(first.deviceId, PEER_ALIAS);
      return control.exportGenerationArchive();
    } finally {
      process.env.MEMEX_HOME = MEMEX_HOME;
    }
  })();
  if (!fs.existsSync(peerArchive.path) || peerArchive.deviceAlias !== PEER_ALIAS) {
    throw new Error("peer archive seed failed: " + JSON.stringify(peerArchive));
  }

  // #31: the model tab reads the model catalog from the Codex installation. A temp
  // CODEX_HOME makes the dropdown deterministic AND keeps the gate away from the
  // developer's real ~/.codex — startServer() spreads process.env into the child.
  const CODEX_HOME_DIR = path.join(TEMP, "codex");
  fs.mkdirSync(CODEX_HOME_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CODEX_HOME_DIR, "models_cache.json"),
    JSON.stringify({
      fetched_at: "2026-09-09T00:00:00.000Z",
      etag: "web-ui-e2e",
      client_version: "0.153.4",
      models: [
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          description: "fixture",
          default_reasoning_level: "low",
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
          visibility: "list",
          supported_in_api: true,
          priority: 1,
        },
        {
          slug: "gpt-5.6-luna",
          display_name: "GPT-5.6-Luna",
          description: "fixture",
          default_reasoning_level: null,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          visibility: "list",
          supported_in_api: true,
          priority: 2,
        },
        {
          slug: "gpt-reserve",
          display_name: "Reserve",
          description: "fixture",
          default_reasoning_level: null,
          supported_reasoning_levels: [{ effort: "low" }],
          visibility: "hide",
          supported_in_api: true,
          priority: 9,
        },
      ],
    }),
  );
  process.env.CODEX_HOME = CODEX_HOME_DIR;
  // #31: one durable config hold plus one job parked on it. The hold is keyed on the
  // fingerprint THIS process resolves (no models.json yet, so the built-in default),
  // which is the same selection the server resolves from the same MEMEX_HOME — that is
  // what makes the banner say "this one is blocking you" instead of listing someone
  // else's. No provider call is involved: the row is the durable record of one.
  const { llmSelectionFingerprint } = await import(path.join(ROOT, "dist", "model-settings.js"));
  const holdFingerprint = llmSelectionFingerprint();
  // Observed just now: a hold nobody has seen for 30 days is closed by TTL inside
  // ensureModelBudgetSchema(), and several probes below open a writable core.
  const HELD_AT = new Date().toISOString();
  const modelDb = initDatabase();
  try {
    modelDb.prepare(
      `INSERT INTO model_config_holds (selection_fingerprint, held_at, model, reasoning_effort,
         provider_status, provider_type, provider_message, observed_count, last_observed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(holdFingerprint, HELD_AT, "gpt-6-astraX", "max", 400, "invalid_request_error",
      "The 'gpt-6-astraX' model is not supported when using Codex with a ChatGPT account.", 3, HELD_AT);
    modelDb.prepare(
      `INSERT INTO memory_jobs (job_id, kind, partition_key, policy_version, priority, state,
         available_at, attempts, max_attempts, idempotency_key, created_at, updated_at, hold_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("web-ui-held-job", "fact_extract", "session:web-ui-tier-session", "facts-v4", 100,
      "pending", TIER_AT, 0, 5, "e2e-held-job", TIER_AT, TIER_AT, "model_config_rejected");
  } finally {
    modelDb.close();
  }

  const port = await freePort();
  ui = startServer(port);
  const readyLines = await ui.ready;
  chrome = startChrome();
  cdp = new Cdp(await chrome.ready);
  await cdp.connect();
  const base = "http://127.0.0.1:" + port;
  // ?scope=all is the explicit cross-project scope; conversations (and therefore
  // interpretive context rows) are never visible from the global-only scope.
  // Every gate URL pins `&lang=` for the same reason the showcase does: the browser
  // profile is shared across probes and `?lang` outranks anything stored in it.
  const allScope = "?scope=all&lang=" + LANG;
  const projectScope =
    "?scope=project&lang=" + LANG + "&project=" + encodeURIComponent(CONTEXT_PROJECT);

  // #24: with no scope in the URL the workspace must land on all-projects (read-only),
  // not common memory. This probe runs before anything that calls changeScope(), because
  // the browser profile is shared and a persisted scope would mask the default.
  const scopeDefaults = await pageProbe(
    cdp,
    base + "/facts?lang=" + LANG,
    probe(`
      await until('facts row',()=>document.querySelector('#main .data-table .fact-text'));
      const select=document.querySelector('#scope-select');
      const hint=document.querySelector('#scope-hint');
      return {
        urlScope:new URL(location.href).searchParams.get('scope'),
        selected:select.value,
        options:[...select.options].map(o=>o.textContent.trim()),
        groups:[...select.querySelectorAll('optgroup')].map(g=>g.label),
        navLabels:[...document.querySelectorAll('#sidebar nav .nav-item .nav-label')].map(x=>x.textContent),
        heading:text('#main .page-header h1'),
        title:document.title,
        hint:hint?.textContent?.trim()||'',
        hintTitle:hint?.getAttribute('title')||'',
        scopeLine:text('#topbar .scope-line'),
      };
    `),
    "facts-default-scope.png",
    false,
  );

  // #26: /facts?fact=<id> opens the same drawer as the /facts/<id> path form.
  const factDeepLink = await pageProbe(
    cdp,
    base + "/facts?scope=all&lang=" + LANG + "&fact=" + encodeURIComponent(factId),
    probe(`
      await until('deep-linked drawer',()=>document.querySelector('#detail[open] .drawer-meta'));
      const params=new URL(location.href).searchParams;
      return {
        factId:text('#detail .drawer-meta'),
        panel:params.get('panel'),
        item:params.get('item'),
        leftoverFactParam:params.get('fact'),
      };
    `),
    "facts-deep-link.png",
    false,
  );

  // #24: common memory has no conversations, so the banner must switch scope in one click.
  const scopeSwitch = await pageProbe(
    cdp,
    base + "/conversations?scope=global&lang=" + LANG,
    probe(`
      const button=await until('scope switch',()=>document.querySelector('#main [data-action="scope-all"]'));
      const bannerText=text('#main .banner');
      button.click();
      await until('scope switched',()=>new URL(location.href).searchParams.get('scope')==='all');
      // The gate fixture stores one session-less exchange, so the ledger legitimately
      // renders its empty state here; what must change is the scope, not the row count.
      await until('ledger rendered',()=>document.querySelector('#main .session-card')||document.querySelector('#main .empty'));
      return {
        bannerText,
        scope:new URL(location.href).searchParams.get('scope'),
        selected:document.querySelector('#scope-select').value,
        bannerCleared:!document.querySelector('#main [data-action="scope-all"]'),
      };
    `),
    "conversations-scope-switch.png",
    false,
  );

  // #28: the help layer must be reachable without documentation — page ⓘ, the doc link
  // pinned to the release tag, native tooltips, and the ? glossary.
  const helpLayer = await pageProbe(
    cdp,
    base + "/facts" + allScope,
    probe(`
      const toggle=await until('page help',()=>document.querySelector('#main [data-help="page:/facts"]'));
      const badgeTitle=document.querySelector('#main .data-table .tag')?.getAttribute('title')||'';
      const headerTitle=document.querySelector('#main .data-table th span[title]')?.getAttribute('title')||'';
      const scopeTitle=document.querySelector('#scope-select')?.getAttribute('title')||'';
      toggle.click();
      const panel=await until('help modal',()=>document.querySelector('#modal[open] .modal-body'));
      const helpText=panel.textContent;
      const docHref=panel.querySelector('a[href^="https://github.com/"]')?.getAttribute('href')||'';
      document.querySelector('#modal [data-action="close-modal"]').click();
      await until('help closed',()=>!document.querySelector('#modal').open);
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}));
      const list=await until('glossary',()=>document.querySelector('#modal[open] #glossary-list'));
      const terms=[...list.querySelectorAll('[data-term]')].length;
      const input=document.querySelector('#glossary-input');
      input.value='capsule';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await sleep(150);
      const visible=[...list.querySelectorAll('[data-term]')].filter(x=>!x.hidden).map(x=>x.querySelector('strong').textContent);
      return {helpText:helpText.slice(0,260),hasFactsBody:helpText.includes(L.helpFactsBody),docHref,terms,visible,badgeTitle,headerTitle,scopeTitle,sidebarGlossary:Boolean(document.querySelector('#sidebar [data-action="glossary"]'))};
    `),
    "facts-help.png",
    false,
  );

  const facts = await pageProbe(
    cdp,
    base + "/facts" + allScope,
    probe(`
      const cell=await until('facts row',()=>{
        const el=document.querySelector('#main .data-table .fact-text');
        return el&&el.textContent.includes(L.maliciousVisible)?el:null;
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
        navItems:[...document.querySelectorAll('#sidebar nav .nav-item .nav-label')].map(x=>x.textContent),
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
        return el&&el.textContent.includes(L.contextTitle)?el:null;
      });
      return {
        heading:text('#detail .drawer-title'),
        factId:text('#detail .drawer-meta'),
        tabs:[...document.querySelectorAll('#detail .tab')].map(x=>x.textContent),
        separationBanner:body.textContent.includes(L.evidenceIntro),
        directEvidenceEmpty:body.textContent.includes(L.evidenceEmpty),
        hasContextSection:body.textContent.includes(L.contextTitle),
        hasAssistantKind:body.textContent.includes('assistant_context'),
        hasNonAuthoritativeLabel:body.textContent.includes(L.contextOnly),
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
      await rerender('no-match search',f=>{f.querySelector('input[name="q"]').value=L.noMatchQuery;f.requestSubmit();});
      const filteredEmpty=await until('filtered empty state',()=>{
        const el=document.querySelector('#main .empty h3');
        return el&&el.textContent.includes(L.factsEmptyFiltered)?el.textContent.trim():null;
      });
      const reset=await until('reset action',()=>document.querySelector('#main [data-action="reset-facts-filter"]'));
      reset.click();
      await until('filters cleared',()=>!new URL(location.href).searchParams.get('taxonomy')&&!new URL(location.href).searchParams.get('q'));
      const restored=await until('restored row',()=>document.querySelector('#main .data-table .fact-text'));
      return {
        options,
        hasAllOption:options.some(o=>o.value===''&&o.label===L.taxonomyAll),
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
      if(!mapLink)throw new Error('taxonomy map link missing on the card');
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
        return badges.includes(L.badgeInactive)?badges:null;
      },30000);
      const listWhileInactive=[...document.querySelectorAll('#main .data-table .fact-text')].map(x=>x.textContent);
      (await drawerButton('restore')).click();
      await submit('restore');
      const active=await until('active fact',()=>{
        const badges=[...document.querySelectorAll('#detail .drawer-body .tag')].map(x=>x.textContent);
        return badges.includes(L.badgeActive)?badges:null;
      },30000);
      const row=await until('restored row',()=>document.querySelector('#main .data-table .fact-text'));
      return {
        factId:text('#detail .drawer-meta'),
        factText:document.querySelector('#detail .drawer-quote')?.textContent||'',
        rowText:row.textContent,
        inactiveBadges:inactive,
        activeBadges:active,
        listWhileInactive,
        toast:text('#toast'),
      };
    `),
    "facts-mutations.png",
    false,
  );

  // #23: the jobs tab must say what the stored error means and what to do about it.
  const jobGuidance = await pageProbe(
    cdp,
    base + "/activity" + allScope + "&tab=jobs",
    probe(`
      const row=await until('dead job row',()=>[...document.querySelectorAll('#main .data-table tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(DEAD_JOB_ERROR)})));
      const cells=[...row.querySelectorAll('td')];
      const guidance=cells[cells.length-2];
      return {
        heads:[...document.querySelectorAll('#main .data-table thead th')].map(x=>x.textContent.trim()),
        rowText:row.textContent,
        guidanceText:guidance.textContent,
        ignorable:guidance.querySelector('.tag')?.textContent.trim(),
        copyCommands:[...guidance.querySelectorAll('[data-copy-command]')].map(x=>x.dataset.copyCommand),
        operationButtons:[...guidance.querySelectorAll('[data-command]')].map(x=>x.dataset.command),
      };
    `),
    "activity-job-guidance.png",
    false,
  );

  // #23: the overview groups by class and the action clears the group.
  const attention = await pageProbe(
    cdp,
    base + "/" + allScope,
    probe(`
      const card=await until('attention card',()=>[...document.querySelectorAll('#main .card')].find(c=>c.textContent.includes(L.attentionHeading)));
      const before=card.textContent;
      const recover=await until('recover action',()=>card.querySelector('[data-command="recover"]:not([disabled])'));
      recover.click();
      const form=await until('command modal',()=>document.querySelector('#modal[open] #modal-form'));
      const modalText=form.textContent;
      form.querySelector('input[name="confirm"]').checked=true;
      form.requestSubmit();
      await until('operation drawer',()=>{
        const error=document.querySelector('#modal[open] .modal-error')?.textContent?.trim();
        if(error)throw new Error('recover rejected: '+error);
        return document.querySelector('#detail[open] #operation-body');
      },60000);
      // The command's own label says "failed", so completion is read from the status row,
      // not from the drawer text; the cancel button only exists while it is still running.
      const finished=await until('operation finished',()=>{
        const body=document.querySelector('#detail[open] #operation-body');
        if(!body||body.querySelector('[data-action="cancel-operation"]'))return null;
        const term=[...body.querySelectorAll('.kv dt')].find(d=>d.textContent.trim()===L.operationStatus);
        return term?.nextElementSibling?.textContent?.trim()||null;
      },180000);
      const output=(document.querySelector('#operation-output')?.textContent||'').slice(-600);
      document.querySelector('#detail [data-action="close-detail"]').click();
      await until('drawer closed',()=>!document.querySelector('#detail').open);
      const staleMetrics=document.querySelector('#main .metrics');
      document.querySelector('[data-action="refresh"]').click();
      await until('overview reloaded',()=>{const now=document.querySelector('#main .metrics');return now&&now!==staleMetrics?now:null;},60000);
      await sleep(400);
      const after=[...document.querySelectorAll('#main .card')].find(c=>c.textContent.includes(L.attentionHeading))?.textContent||'';
      return {
        beforeHasDeadClass:before.includes(L.jobDeadTitle),
        beforeHasImpact:before.includes(L.jobDeadImpact),
        modalCommand:modalText.includes('memex recover --all-dead'),
        output,
        finishedState:finished,
        afterHasDeadClass:after.includes(L.jobDeadTitle),
      };
    `),
    "overview-attention.png",
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
    base + "/settings?scope=all&lang=" + LANG + "&tab=diagnostics",
    probe(`
      const table=await until('capability table',()=>{
        const el=document.querySelector('#main .data-table tbody');
        return el&&el.querySelectorAll('tr').length?el:null;
      });
      return {
        title:document.title,
        heading:text('#main .page-header h1'),
        rows:table.querySelectorAll('tr').length,
        factsReadable:[...table.querySelectorAll('tr')].some(r=>r.textContent.includes('facts')&&r.textContent.includes(L.diagnosticsReadable)),
        contextTableReadable:[...table.querySelectorAll('tr')].some(r=>r.textContent.includes('fact_context_dependencies')&&r.textContent.includes(L.diagnosticsReadable)),
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
        return el&&el.textContent.includes(L.graphLegend3d)?el.textContent:null;
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
        return el&&el.textContent.includes(L.graphEmptyTitle)?el:null;
      },20000).catch(e=>{throw new Error(e.message+' | main='+(document.querySelector('#main')?.innerText||'').slice(0,500).replace(/\\s+/g,' ')+' | nodes='+document.querySelectorAll('#node-list [data-fact]').length+' | meta='+text('#graph-stage .graph-meta'));});
      const canvas=document.querySelector('#graph-stage .graph-canvas');
      const surface=mapSurface(canvas);
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
        nodePixels:surface.painted,
        mapFrames:surface.frames,
        mapBackground:surface.background,
        mapTotal:surface.total,
      };
    `),
    "graph-empty.png",
    true,
  );

  // #48: the sync tab drives the real dist/sync-control.js. The shared folder lives inside this
  // run's temp root, so nothing reaches a real data root.
  const SHARED_SYNC = path.join(TEMP, "shared-sync");
  const syncTab = await pageProbe(
    cdp,
    base + "/settings?scope=all&lang=" + LANG + "&tab=sync",
    probe(`
      const submit=async(label)=>{
        const form=await until(label+' modal',()=>document.querySelector('#modal[open] #modal-form'));
        form.requestSubmit();
        await until(label+' committed',()=>{
          const error=document.querySelector('#modal[open] .modal-error')?.textContent?.trim();
          if(error)throw new Error(label+' rejected: '+error);
          return !document.querySelector('#modal[open]');
        },120000);
      };
      const tabText=()=>document.querySelector('#main')?.textContent||'';
      await until('sync tab',()=>tabText().includes(L.syncSwitchTitle));
      const offSwitch=document.querySelector('#sync-switch');
      const before={
        checked:offSwitch.checked,
        exportDisabled:document.querySelector('[data-sync="export"]').disabled,
        importDisabled:document.querySelector('[data-sync="import"]').disabled,
        footnote:document.querySelector('#main .footer-note')?.textContent||'',
      };
      offSwitch.click();
      const enable=await until('enable modal',()=>document.querySelector('#modal[open] input[name="dir"]'));
      enable.value=${JSON.stringify(SHARED_SYNC)};
      await submit('enable');
      await until('sync on',()=>document.querySelector('#sync-switch')?.checked===true,60000);
      const on={
        folder:tabText().includes(${JSON.stringify(SHARED_SYNC)}),
        exportDisabled:document.querySelector('[data-sync="export"]').disabled,
      };
      document.querySelector('[data-sync="export"]').click();
      (await until('export confirm',()=>document.querySelector('#modal[open] input[name="confirm"]'))).checked=true;
      await submit('export');
      await until('export result',()=>tabText().includes(L.syncRunExport),120000);
      const exported=tabText();
      document.querySelector('[data-sync="import"]').click();
      (await until('import confirm',()=>document.querySelector('#modal[open] input[name="confirm"]'))).checked=true;
      await submit('import');
      await until('import result',()=>tabText().includes(L.syncRunImport),120000);
      const imported=document.querySelector('#main').textContent;
      return {
        before,
        on,
        deviceAssigned:!imported.includes(L.syncDeviceMissing),
        exportedHasCounts:exported.includes(L.syncRows),
        importSummary:(imported.match(new RegExp(L.importCountsRe))||[''])[0],
        rejected:imported.includes(L.syncRejectedEmpty),
      };
    `),
    "settings-sync.png",
    false,
  );

  // #31: the model tab drives the real dist/model-settings.js. Saving writes models.json
  // inside this run's temp MEMEX_HOME, and the catalog comes from the temp CODEX_HOME —
  // no real data root and no real ~/.codex is touched. The one-call test button is NOT
  // clicked: it would make a real provider call, which a gate must never do.
  const modelTab = await pageProbe(
    cdp,
    base + "/settings?scope=all&lang=" + LANG + "&tab=models",
    probe(`
      const tabText=()=>document.querySelector('#main')?.textContent||'';
      await until('model tab',()=>document.querySelector('#model-llm form#model-llm-form'));
      const modelSelect=document.querySelector('#model-llm select[name="model"]');
      const reasoningSelect=document.querySelector('#model-llm select[name="reasoning"]');
      const before={
        models:[...modelSelect.options].map(o=>o.value),
        reasoning:[...reasoningSelect.options].map(o=>o.value),
        selected:modelSelect.value,
        holdBanner:Boolean(document.querySelector('#main .banner.error')),
        holdResumes:tabText().includes(L.modelHoldNoDamage),
        heldCard:Boolean(document.querySelector('#model-held-jobs')),
        heldBadge:document.querySelector('#model-held-jobs .tag')?.textContent?.trim()||'',
        embeddingReadOnly:Boolean(document.querySelector('#model-embedding')),
        testButton:Boolean(document.querySelector('[data-model="test"]')),
      };
      // 'high' is in the catalog for BOTH the default model and the one being saved, so
      // the save is a real selection change rather than an accidental "no flag".
      modelSelect.value='gpt-6-astra';
      reasoningSelect.value='high';
      document.querySelector('#model-llm-form').requestSubmit();
      // Any toast, not only the expected one: a refused save must fail with the
      // server's own sentence in the receipt rather than as a bare timeout.
      const toast=await until('save toast',
        ()=>document.querySelector('#toast.show')?.textContent?.trim()||null,60000);
      // The re-render replaces the node, so a NEW select element is the proof.
      const fresh=await until('re-rendered',()=>{
        const next=document.querySelector('#model-llm select[name="model"]');
        return next&&next!==modelSelect?next:null;
      },60000);
      const after={
        selected:fresh.value,
        reasoning:document.querySelector('#model-llm select[name="reasoning"]').value,
        source:tabText().includes('models.json'),
      };
      return {before,after,toast};
    `),
    "settings-model.png",
    false,
  );

  // #31 + #109 L5: the same tab in the OTHER language. `?lang` wins over every stored
  // preference, so one navigation answers the question a single-language gate cannot:
  // does the other language's prose overflow the existing card/kv/select tokens? Whichever
  // way the gate is run, both widths are measured on the same screen.
  const modelTabAlt = await pageProbe(
    cdp,
    base + "/settings?scope=all&tab=models&lang=" + ALT,
    probe(`
      await until('model tab alt',()=>document.querySelector('#model-llm form#model-llm-form'));
      const body=document.querySelector('#main').textContent;
      return {
        otherLanguage:body.includes(L.modelAltTitle),
        bodyOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
        mainOverflow:overflows('#main'),
        cardOverflow:overflows('#model-llm')||overflows('#model-embedding'),
        tableOverflow:overflows('#model-held-jobs .table-wrap'),
      };
    `),
    "settings-model-alt.png",
    false,
  );

  // #29/#30: the overlay tab drives the real dist/overlay-admin.js. Saving a pattern takes the
  // write lock, bumps `revision` and writes `overlays/recall-gate.json` inside this run's temp
  // MEMEX_HOME — no real data root is touched, and no model or embedding call is involved. The
  // refused pattern is the review's own counter-example shape: it must come back as ISSUE ROWS
  // with the row that needs fixing, not as a bare toast.
  const overlayTab = await pageProbe(
    cdp,
    base + "/settings?scope=all&lang=" + LANG + "&tab=overlays&overlay=gate",
    probe(`
      const tabText=()=>document.querySelector('#main')?.textContent||'';
      await until('overlay tab',()=>document.querySelector('#overlay-subnav'));
      await until('pattern table',()=>document.querySelector('#gate-patterns .data-table'));
      const gate={
        subnav:[...document.querySelectorAll('#overlay-subnav .filter-chip')].map(c=>c.dataset.paramValue),
        active:document.querySelector('#overlay-subnav .filter-chip.active')?.dataset.paramValue,
        builtinRows:document.querySelectorAll('#gate-patterns .data-table tbody tr').length,
        testForm:Boolean(document.querySelector('#gate-test-form textarea[name="prompt"]')),
        notShared:tabText().includes(L.overlaysNotShared),
        noRecord:tabText().includes(L.overlaysNoRecord),
      };
      // (1) A refused regex — the reason has to show up per row.
      const form=document.querySelector('#gate-add-form');
      form.querySelector('[name="source"]').value='(a+)+b';
      form.requestSubmit();
      const issues=await until('issue rows',
        ()=>document.querySelector('#gate-add-issues .issue-list li')?document.querySelector('#gate-add-issues'):null,60000);
      const refused={
        rows:issues.querySelectorAll('li').length,
        path:issues.querySelector('code')?.textContent?.trim()||'',
        text:issues.textContent.trim().slice(0,160),
        toast:document.querySelector('#toast.show')?.textContent?.trim()||'',
        table:document.querySelectorAll('#gate-patterns .data-table tbody tr').length,
      };
      // There is one toast node, so the refusal is still showing: clear it first.
      document.querySelector('#toast')?.classList.remove('show');
      // (2) An accepted regex — the toast names the revision and the row appears.
      form.querySelector('[name="source"]').value=L.overlayPattern;
      form.querySelector('[name="note"]').value=L.overlayNote;
      form.requestSubmit();
      const toast=await until('save toast',
        ()=>document.querySelector('#toast.show')?.textContent?.trim()||null,60000);
      const row=await until('user pattern row',()=>[...document.querySelectorAll('#gate-patterns .data-table tbody tr')]
        .find(r=>r.textContent.includes(L.overlayPatternText)),60000);
      const saved={
        toast,
        id:row.querySelector('code')?.textContent?.trim()||'',
        origin:row.textContent.includes(L.overlaysOriginUser),
        note:row.textContent.includes(L.overlayNote),
        rows:document.querySelectorAll('#gate-patterns .data-table tbody tr').length,
      };
      // (3) The sub-nav goes to the extraction-rules view — same tab, other screen.
      document.querySelector('#overlay-subnav [data-param-value="rules"]').click();
      await until('rules view',()=>document.querySelector('#rules-editor-form'));
      const rulesText=tabText();
      const rules={
        editor:Boolean(document.querySelector('#rules-editor-form textarea[name="exclude_topics"]')),
        rawPromptField:Boolean(document.querySelector('#rules-editor-form [name="system_prompt"],#rules-editor-form [name="raw_prompt"]')),
        clause:Boolean(document.querySelector('#rules-clause')),
        simulate:Boolean(document.querySelector('#rules-simulate-form [type="submit"]')),
        verifierUnchanged:rulesText.includes(L.overlaysVerifierUnchanged),
        enforcement:['fact_insert','incident','remediation','chronicle'].every(p=>rulesText.includes(p)),
        schedulingKey:rulesText.includes('continuity-fact-v1'),
        timing:rulesText.includes(L.overlaysTiming),
        heldBanner:rulesText.includes(L.overlaysHeld),
        noReextractApply:!document.querySelector('[data-rules="reextract"]'),
        gateFormGone:!document.querySelector('#gate-test-form'),
        bodyOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
        mainOverflow:overflows('#main'),
      };
      return {gate,refused,saved,rules,lang:document.documentElement.lang};
    `),
    "settings-overlays.png",
    false,
  );

  // #22: the project screen must admit the branch-tier memory exists and be able to include it.
  const tierBanner = await pageProbe(
    cdp,
    base + "/facts" + projectScope,
    probe(`
      const node=await until('tier banner',()=>[...document.querySelectorAll('#main .banner')].find(b=>b.textContent.includes(L.hiddenTierOne)));
      const bannerText=node.textContent;
      const before=document.querySelectorAll('#main .data-table tbody tr').length;
      node.querySelector('[data-param-key="tiers"]').click();
      await until('tiers applied',()=>new URL(location.href).searchParams.get('tiers')==='all');
      await until('branch row',()=>[...document.querySelectorAll('#main .data-table tbody tr')].some(r=>r.textContent.includes(${JSON.stringify(BRANCH_FACT)})));
      return {
        bannerText,
        before,
        after:document.querySelectorAll('#main .data-table tbody tr').length,
        badges:[...document.querySelectorAll('#main .data-table [data-tier]')].map(x=>({tier:x.dataset.tier,label:x.textContent.trim(),title:x.getAttribute('title')})),
        hasRevert:Boolean(document.querySelector('#main [data-param-key="tiers"][data-param-value=""]')),
      };
    `),
    "facts-tier-banner.png",
    false,
  );

  // #22: promote through the real dist/fact-management.js ladder and read the Chronicle event back.
  const tierPromote = await pageProbe(
    cdp,
    base +
      "/facts" +
      projectScope +
      "&tiers=all&panel=fact&item=" +
      encodeURIComponent(branchFactId) +
      "&panelTab=reuse",
    probe(`
      const drawer=await until('injection section',()=>{
        const el=document.querySelector('#detail[open] .drawer-body');
        return el&&el.textContent.includes(L.reuseTitle)?el:null;
      });
      const condition=drawer.textContent.slice(0,600);
      const conditionBadge=drawer.querySelector('[data-tier]');
      document.querySelector('#detail [data-panel-tab="summary"]').click();
      const promote=await until('promote button',()=>{
        const el=document.querySelector('#detail[open] [data-tier-move="promote"]');
        return el&&!el.disabled?el:null;
      });
      const demoteDisabled=document.querySelector('#detail [data-tier-move="demote"]').disabled;
      const summaryBadge=document.querySelector('#detail [data-tier]')?.textContent.trim();
      promote.click();
      const form=await until('promote modal',()=>document.querySelector('#modal[open] #modal-form'));
      const rule=form.textContent;
      form.querySelector('input[name="reason"]').value='browser E2E';
      form.requestSubmit();
      await until('promote committed',()=>{
        const error=document.querySelector('#modal[open] .modal-error')?.textContent?.trim();
        if(error)throw new Error('promote rejected: '+error);
        return !document.querySelector('#modal[open]');
      },60000);
      const history=await until('promotion event',()=>{
        const el=document.querySelector('#detail[open] .drawer-body');
        return el&&el.textContent.includes(L.promoted)?el:null;
      },60000);
      const historyTab=text('#detail .tab.active');
      const promotedBadge=await until('promoted badge',()=>{
        document.querySelector('#detail [data-panel-tab="summary"]')?.click();
        const el=document.querySelector('#detail [data-tier]');
        return el&&el.dataset.tier==='project'?el.textContent.trim():null;
      },30000);
      const bannerGone=await until('banner cleared',()=>
        [...document.querySelectorAll('#main .banner')].every(b=>!b.textContent.includes(L.hiddenTierOne))?'cleared':null,30000);
      return {
        condition,
        conditionTier:conditionBadge?.dataset.tier,
        conditionLabel:conditionBadge?.textContent.trim(),
        summaryBadge,
        demoteDisabled,
        rule,
        historyTab,
        historyHasPromotion:history.textContent.includes(L.promoted),
        promotedBadge,
        bannerGone,
      };
    `),
    "facts-tier-promote.png",
    false,
  );

  // #48 runs LAST on purpose: importing the other root's generation adds a
  // memory, and every probe above asserts exact row and node counts.
  // #48 (0.6.3): the manual file path, end to end in the browser — write a zip of
  // this device, name a device, then validate → preview → import the OTHER root's
  // generation and read the imported memory back.
  const syncArchive = await pageProbe(
    cdp,
    base + "/settings?scope=all&lang=" + LANG + "&tab=sync",
    probe(`
      const submit=async(label)=>{
        const form=await until(label+' modal',()=>document.querySelector('#modal[open] #modal-form'));
        form.requestSubmit();
        await until(label+' committed',()=>{
          const error=document.querySelector('#modal[open] .modal-error')?.textContent?.trim();
          if(error)throw new Error(label+' rejected: '+error);
          return !document.querySelector('#modal[open]');
        },180000);
      };
      const tabText=()=>document.querySelector('#main')?.textContent||'';
      await until('archive card',()=>document.querySelector('#sync-archive'));
      const before={
        importLocked:document.querySelector('[data-archive="import"]').disabled,
        defaultDir:/sync\\/exports/.test(tabText()),
        plaintext:tabText().includes(L.archiveIntro),
      };

      // (1) Name this device — the alias editor in the status block.
      document.querySelector('[data-alias]').click();
      const aliasField=await until('alias modal',()=>document.querySelector('#modal[open] input[name="alias"]'));
      aliasField.value=L.localAlias;
      await submit('alias');
      await until('alias shown',()=>tabText().includes(L.localAlias));

      // (2) Export a generation — the server writes inside the data root and says where.
      document.querySelector('[data-archive="export"]').click();
      (await until('export confirm',()=>document.querySelector('#modal[open] input[name="confirm"]'))).checked=true;
      await submit('archive export');
      const exportedPath=(await until('archive path',()=>{
        const node=[...document.querySelectorAll('#sync-archive code')].find(c=>/\\.zip$/.test(c.textContent.trim()));
        return node?node.textContent.trim():null;
      },180000));
      const exported={
        path:exportedPath,
        hasCopy:Boolean(document.querySelector('#sync-archive [data-copy-command]')),
        finderHint:document.querySelector('#sync-archive').textContent.includes('⇧⌘G'),
      };

      // (3) Verify the other root's generation file, then preview it.
      const form=await until('import form',()=>document.querySelector('#archive-import-form'));
      form.querySelector('input[name="path"]').value=${JSON.stringify(peerArchive.path)};
      form.requestSubmit();
      await until('preview rendered',()=>document.querySelector('#sync-archive').textContent.includes(L.archivePreviewTitle),120000);
      const previewText=document.querySelector('#sync-archive').textContent;
      const preview={
        summary:previewText.includes(L.archivePreviewDeltas)?L.archivePreviewDeltas:'',
        peerAlias:previewText.includes(${JSON.stringify(PEER_ALIAS)}),
        importOpen:!document.querySelector('[data-archive="import"]').disabled,
      };

      // (4) Confirm and import — only the file reviewed in the preview is applied.
      document.querySelector('[data-archive="import"]').click();
      const confirmBox=await until('import confirm',()=>document.querySelector('#modal[open] input[name="confirm"]'));
      const modalText=document.querySelector('#modal[open]').textContent;
      confirmBox.checked=true;
      await submit('archive import');
      await until('import applied',()=>tabText().includes(L.syncRunImport),180000);
      return {before,exported,preview,modalText,applied:tabText()};
    `),
    "settings-sync-archive.png",
    false,
  );

  // #48: the imported memory must be a real memory on this device afterwards.
  const importedFact = await pageProbe(
    cdp,
    base + "/facts?scope=global&lang=" + LANG + "&q=" + encodeURIComponent(PEER_QUERY),
    probe(`
      const row=await until('imported fact row',()=>[...document.querySelectorAll('#main .data-table .fact-text')].find(x=>x.textContent.includes(${JSON.stringify(PEER_FACT)})));
      return {text:row.textContent.trim()};
    `),
    "facts-imported.png",
    false,
  );

  // #109 L5: the language-integrity sweep. It walks every visible text node of all
  // seven pages plus the two drawers and reports the nodes that betray a broken
  // translation. Two exemptions, both structural rather than "skip this screen":
  //   · `[data-endonym]` subtrees — a language name is never translated (§7.1)
  //   · `docs/*.md#<anchor>` links — docs/ is Korean only, with no English edition (§6.4)
  // Fixture content that is legitimately in the other language (the XSS sentence in
  // en, the provider's own message in ko) is stripped via `L.userContent` BEFORE the
  // judgement, so it exempts those strings and nothing else.
  //
  // What counts as broken:
  //   · a dotted namespace key on screen  — a missing dictionary entry, either language
  //   · Hangul in en mode                 — a string that was never moved to the dictionary
  //   · two English function words in ko  — an English sentence leaking into a ko screen
  const langIntegrity = await pageProbe(
    cdp,
    base + "/" + allScope,
    probe(`
      const strip=s=>{
        let out=String(s).replace(/docs\\/[A-Za-z0-9._-]+\\.md#[^\\s]*/g,' ');
        for(const allowed of L.userContent) out=out.split(allowed).join(' ');
        return out;
      };
      const KEYISH=/\\b(?:pages|activity|details|settings|help|guidance|badge|common|shell|ui|tier|a11y|error|overlays|models|status|action|unit|op|pagination|sync)\\.[a-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9_-]+)+/;
      const HANGUL=/[\\uac00-\\ud7a3\\u1100-\\u11ff\\u3130-\\u318f]/;
      const FUNCTION_WORD=/\\b(?:the|of|and|is|are|to|in|for|with|not|no|this|that|an?|be|on|by|it|as|at|from|or|was|were|been|which|when|only|never|your)\\b/gi;
      const findings=[];
      // §14.1: .kv is a 145px + minmax(0,1fr) grid. A longer label wrapping to two
      // lines is fine; a dt that overflows its own column is not. Both are counted,
      // and only the second one is a failure.
      const kv={rows:0,wrapped:[],overflowing:[]};
      const measureKv=()=>{
        for(const dt of document.querySelectorAll('.kv dt')){
          kv.rows++;
          const line=parseFloat(getComputedStyle(dt).lineHeight)||16;
          if(dt.getBoundingClientRect().height>line*1.5&&kv.wrapped.length<12)kv.wrapped.push(dt.textContent.trim());
          if(dt.scrollWidth>dt.clientWidth+1)kv.overflowing.push(dt.textContent.trim());
        }
      };
      const sweep=where=>{
        measureKv();
        const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
        for(let node=walker.nextNode();node;node=walker.nextNode()){
          const el=node.parentElement;
          // <noscript> keeps its markup as a TEXT node once scripting is on, so it
          // has to go with script/style/template rather than be judged as prose.
          if(!el||el.closest('script,style,template,noscript,[data-endonym],[hidden]'))continue;
          const raw=node.nodeValue.trim();
          if(!raw)continue;
          const value=strip(raw).trim();
          if(!value)continue;
          if(KEYISH.test(value))findings.push({where,kind:'key',text:value.slice(0,120)});
          else if(L.lang==='en'&&HANGUL.test(value))findings.push({where,kind:'hangul',text:value.slice(0,120)});
          else if(L.lang==='ko'&&!HANGUL.test(value)&&(value.match(FUNCTION_WORD)||[]).length>1)
            findings.push({where,kind:'english',text:value.slice(0,120)});
        }
      };
      // The shell is an SPA: the click handler intercepts a[data-nav], so one probe
      // covers every page and the console stays attached for the whole sweep. The
      // node has to be looked up again each time — render() replaces #sidebar
      // wholesale, and a DETACHED anchor's click is not intercepted, it navigates.
      const nav=sel=>until('nav '+sel,()=>document.querySelector('#sidebar nav .nav-item'+sel));
      const navHrefs=[...document.querySelectorAll('#sidebar nav .nav-item')].map(a=>a.getAttribute('href'));
      const visited=[];
      for(const href of navHrefs){
        (await nav('[href="'+href+'"]')).click();
        await until('page '+href,()=>document.querySelector('#main .page-header h1'));
        await sleep(450);
        visited.push(text('#main .page-header h1'));
        sweep(href);
      }
      // The memory drawer (summary, then evidence) on top of the same shell.
      (await nav('[href^="/facts"]')).click();
      const row=await until('facts rows',()=>document.querySelector('#main .data-table .fact-text'));
      row.click();
      await until('fact drawer',()=>document.querySelector('#detail[open] .drawer-body'));
      await sleep(350);
      sweep('drawer:fact');
      document.querySelector('#detail [data-panel-tab="evidence"]').click();
      await until('evidence tab',()=>document.querySelector('#detail[open] .drawer-body').textContent.includes(L.contextTitle));
      sweep('drawer:fact/evidence');
      // §14.1 width measurement. English labels are longer than Korean ones, and the
      // two CSS changes the design pre-authorised (.nav-label ellipsis, .kv minmax)
      // are only warranted if a real overflow shows up. The numbers go in the receipt
      // so the decision is made on measurements, not on a guess.
      const sidebar=document.querySelector('#sidebar');
      const labels=()=>[...document.querySelectorAll('#sidebar nav .nav-label')]
        .map(el=>({label:el.textContent,text:Math.ceil(el.scrollWidth),box:Math.ceil(el.clientWidth)}));
      const wide=labels();
      // The ≤1150px breakpoint narrows --sidebar-width to 190px, and that is where the
      // longer language runs out of room. Setting the variable reproduces exactly that
      // box without leaving the gate's fixed 1440×900 viewport.
      document.documentElement.style.setProperty('--sidebar-width','190px');
      await sleep(120);
      // Per nav ITEM, not per sidebar: the sidebar also holds two hard-coded English
      // captions ("MEMORY SPACE", "OBSERVE & CONTROL") that are wider than 190px in
      // both languages, so a whole-sidebar measurement cannot tell en from ko.
      const narrow={
        overflow:[...document.querySelectorAll('#sidebar nav .nav-item')]
          .filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.textContent.trim()),
        clipped:labels().filter(w=>w.text>w.box+1).map(w=>w.label),
        sidebarOverflow:sidebar.scrollWidth>sidebar.clientWidth+1,
      };
      document.documentElement.style.removeProperty('--sidebar-width');
      return {visited,findings:findings.slice(0,40),total:findings.length,
        htmlLang:document.documentElement.lang,dataLang:document.documentElement.dataset.lang,
        width:{sidebarOverflow:sidebar.scrollWidth>sidebar.clientWidth+1,navLabels:wide,
          navLabelOverflow:wide.filter(w=>w.text>w.box+1).map(w=>w.label),narrow,kv}};
    `),
    "lang-integrity.png",
    false,
  );

  // #109 L5 · §9.4 (5): the ONLY automated check that a fresh browser with no stored
  // preference picks up the server's language. A brand-new profile means no
  // localStorage, and the URL carries no `?lang`, so `<html data-lang>` — planted by
  // the server, read by an external module because CSP forbids an inline script — is
  // the only channel left. Its companion assertion is "zero CSP console messages".
  let freshChrome;
  let freshCdp;
  let serverLangDefault;
  try {
    freshChrome = startChrome(path.join(TEMP, "chrome-fresh"));
    freshCdp = new Cdp(await freshChrome.ready);
    await freshCdp.connect();
    serverLangDefault = await pageProbe(
      freshCdp,
      base + "/",
      probe(`
        await until('shell rendered',()=>document.querySelector('#sidebar .nav-item'));
        await until('page rendered',()=>document.querySelector('#main .page-header h1'));
        await sleep(300);
        return {
          htmlLang:document.documentElement.lang,
          dataLang:document.documentElement.dataset.lang,
          meta:document.querySelector('meta[name="memex-ui-lang"]')?.content||'',
          storedLanguage:localStorage.getItem('memex.workspace.language'),
          navFacts:[...document.querySelectorAll('#sidebar nav .nav-item .nav-label')].map(x=>x.textContent),
          scopeInjection:text('#scope-hint'),
          urlHasLang:new URL(location.href).searchParams.has('lang'),
        };
      `),
      "server-language-default.png",
      false,
    );
    serverLangDefault.consoleMessages = [...freshCdp.consoleMessages];
  } finally {
    freshCdp?.close();
    await stop(freshChrome?.child);
  }

  if (
    scopeDefaults.urlScope !== "all" ||
    scopeDefaults.selected !== "all" ||
    !scopeDefaults.options[0]?.startsWith(L.scopeAllOption) ||
    !scopeDefaults.options[1]?.startsWith(L.commonMemory) ||
    !scopeDefaults.options.slice(0, 2).every((o) => new RegExp(L.factCountRe).test(o)) ||
    !scopeDefaults.groups.includes(L.projectGroup) ||
    !scopeDefaults.navLabels.includes(L.navFacts) ||
    scopeDefaults.heading !== L.factsTitle ||
    !scopeDefaults.title.startsWith(L.factsTitle + " · ") ||
    scopeDefaults.hint !== L.scopeInjection ||
    scopeDefaults.hintTitle !== L.scopeHint ||
    !scopeDefaults.scopeLine.includes(L.scopeAllLine)
  ) {
    throw new Error(
      "Default scope assertion failed: " + JSON.stringify(scopeDefaults),
    );
  }
  if (
    factDeepLink.factId !== factId ||
    factDeepLink.panel !== "fact" ||
    factDeepLink.item !== factId ||
    factDeepLink.leftoverFactParam !== null
  ) {
    throw new Error(
      "fact= deep link assertion failed: " + JSON.stringify(factDeepLink),
    );
  }
  if (
    scopeSwitch.scope !== "all" ||
    scopeSwitch.selected !== "all" ||
    !scopeSwitch.bannerText.includes(L.conversationsGlobalScope) ||
    !scopeSwitch.bannerCleared
  ) {
    throw new Error(
      "Common-scope switch assertion failed: " + JSON.stringify(scopeSwitch),
    );
  }
  if (
    !helpLayer.hasFactsBody ||
    !helpLayer.docHref.startsWith("https://github.com/BongSuCHOI/memex/blob/") ||
    !helpLayer.docHref.includes("/docs/GUIDE.md#") ||
    /blob\/main\//.test(helpLayer.docHref) ||
    !helpLayer.badgeTitle ||
    !helpLayer.headerTitle ||
    helpLayer.scopeTitle !== L.helpScopeControl ||
    !helpLayer.sidebarGlossary ||
    helpLayer.terms < 10 ||
    !helpLayer.visible.includes(L.glossaryCapsule) ||
    helpLayer.visible.length !== 1
  ) {
    throw new Error("Help layer assertion failed: " + JSON.stringify(helpLayer));
  }
  if (
    facts.hasInjectedImage ||
    facts.injectedFlag ||
    facts.rowCount !== 2 ||
    facts.pageOverflowX ||
    !facts.factText.includes(L.maliciousVisible) ||
    facts.navItems.length !== 7 ||
    facts.navItems[2] !== L.navFacts ||
    facts.scopeSelected !== "all"
  ) {
    throw new Error("Facts browser assertion failed: " + JSON.stringify(facts));
  }
  if (
    factDetail.heading !== L.factDetailTitle ||
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
    !factsTaxonomy.categoryGroups.includes(DOMAIN_NAME) ||
    factsTaxonomy.keptSelection !== CATEGORY_ID ||
    !factsTaxonomy.filteredRowText.includes(L.maliciousVisible) ||
    !factsTaxonomy.bannerText.includes(L.taxonomyFilterBanner) ||
    factsTaxonomy.filteredEmpty !== L.factsEmptyFiltered ||
    !factsTaxonomy.restoredRowText.includes(L.maliciousVisible) ||
    /taxonomy=/.test(factsTaxonomy.resetUrl)
  ) {
    throw new Error(
      "Facts taxonomy filter assertion failed: " + JSON.stringify(factsTaxonomy),
    );
  }
  if (
    taxonomyMap.mapText !== L.taxonomyMapAction ||
    !taxonomyMap.mapHref.includes("/graph") ||
    !taxonomyMap.mapHref.includes("domain=" + DOMAIN_ID) ||
    !taxonomyMap.factsHref.includes("taxonomy=" + CATEGORY_ID) ||
    !taxonomyMap.url.startsWith("/graph") ||
    !taxonomyMap.url.includes("domain=" + DOMAIN_ID) ||
    taxonomyMap.domainSelected !== DOMAIN_ID ||
    taxonomyMap.heading !== L.graphTitle ||
    taxonomyMap.nodeButtons !== 1
  ) {
    throw new Error(
      "Taxonomy graph link assertion failed: " + JSON.stringify(taxonomyMap),
    );
  }
  if (
    factsEmptyScope.title !== L.factsEmptyScope ||
    !factsEmptyScope.hasActionsLink ||
    factsEmptyScope.hasResetAction
  ) {
    throw new Error(
      "Facts empty-scope assertion failed: " + JSON.stringify(factsEmptyScope),
    );
  }
  if (
    mutations.factId !== factId ||
    !mutations.activeBadges.includes(L.badgeActive) ||
    !mutations.inactiveBadges.includes(L.badgeInactive) ||
    !mutations.factText.includes("initialized vec0 connection") ||
    !mutations.rowText.includes("initialized vec0 connection") ||
    // Deactivating drops the row from the default active list, and only that row.
    mutations.listWhileInactive.some((t) => t.includes("initialized vec0 connection")) ||
    !mutations.listWhileInactive.some((t) => t.includes(BRANCH_FACT))
  ) {
    throw new Error(
      "Facts mutation assertion failed: " + JSON.stringify(mutations),
    );
  }
  if (
    syncTab.before.checked ||
    !syncTab.before.exportDisabled ||
    !syncTab.before.importDisabled ||
    !syncTab.before.footnote.includes("liveTwoDeviceRoundTrip: NOT_PROVEN") ||
    !syncTab.on.folder ||
    syncTab.on.exportDisabled ||
    !syncTab.deviceAssigned ||
    !syncTab.exportedHasCounts ||
    !syncTab.importSummary ||
    !syncTab.rejected
  ) {
    throw new Error("Sync tab assertion failed: " + JSON.stringify(syncTab));
  }
  if (
    // Import stays locked until a file has been validated and previewed.
    !syncArchive.before.importLocked ||
    !syncArchive.before.defaultDir ||
    !syncArchive.before.plaintext ||
    // The zip the server wrote is inside this run's data root, never downloaded.
    !syncArchive.exported.path.startsWith(path.join(MEMEX_HOME, "sync", "exports")) ||
    !fs.existsSync(syncArchive.exported.path) ||
    !syncArchive.exported.hasCopy ||
    !syncArchive.exported.finderHint ||
    // The other root's generation previews as one new memory, named by its alias.
    syncArchive.preview.summary !== L.archivePreviewDeltas ||
    !syncArchive.preview.peerAlias ||
    !syncArchive.preview.importOpen ||
    !syncArchive.modalText.includes(L.archiveImportWarning) ||
    !tRe("settings.sync.importCounts", {
      newFacts: "1", updatedFacts: "\\d+", deletedFacts: "\\d+", newRevisions: "\\d+",
      newTombstones: "\\d+", newRecalls: "\\d+", updatedRecalls: "\\d+",
    }).test(syncArchive.applied) ||
    !syncArchive.applied.includes(LOCAL_ALIAS) ||
    importedFact.text !== PEER_FACT
  ) {
    throw new Error(
      "Sync archive assertion failed: " +
        JSON.stringify({ syncArchive, importedFact }),
    );
  }
  if (
    !tierBanner.bannerText.includes(L.hiddenTierOne) ||
    tierBanner.before !== 1 ||
    tierBanner.after !== 2 ||
    !tierBanner.hasRevert ||
    !tierBanner.badges.some(
      (b) => b.tier === "workstream" && b.label === L.tierBranch && b.title === L.tierBranchExplain,
    ) ||
    !tierBanner.badges.some((b) => b.tier === "global" && b.label === L.tierGlobal)
  ) {
    throw new Error(
      "Hidden tier banner assertion failed: " + JSON.stringify(tierBanner),
    );
  }
  if (
    tierPromote.conditionTier !== "workstream" ||
    tierPromote.conditionLabel !== L.tierBranch ||
    !tierPromote.condition.includes(L.tierBranchExplain) ||
    !tierPromote.condition.includes(L.reuseActive) ||
    tierPromote.summaryBadge !== L.tierBranch ||
    !tierPromote.demoteDisabled ||
    !tierPromote.rule.includes(L.tierLadder) ||
    tierPromote.historyTab !== L.historyTab ||
    !tierPromote.historyHasPromotion ||
    tierPromote.promotedBadge !== L.tierProject ||
    tierPromote.bannerGone !== "cleared"
  ) {
    throw new Error(
      "Tier promotion assertion failed: " + JSON.stringify(tierPromote),
    );
  }
  if (
    !jobGuidance.heads.includes(L.nextAction) ||
    // #79: a dead job is classified by its STATE, so the historical capsule bound
    // error can no longer present a terminal job as harmless.
    !jobGuidance.guidanceText.includes(L.jobDeadTitle) ||
    jobGuidance.ignorable !== L.actionNeeded ||
    !jobGuidance.operationButtons.includes("recover") ||
    !jobGuidance.copyCommands.some((c) => c.includes("memex recover")) ||
    // The stored error text stays on the row: nothing is hidden, only reclassified.
    !jobGuidance.rowText.includes(DEAD_JOB_ERROR)
  ) {
    throw new Error(
      "Job guidance assertion failed: " + JSON.stringify(jobGuidance),
    );
  }
  if (
    !attention.beforeHasDeadClass ||
    !attention.beforeHasImpact ||
    !attention.modalCommand ||
    attention.finishedState !== L.operationCompleted ||
    !attention.output.includes("Recovered") ||
    attention.afterHasDeadClass
  ) {
    throw new Error(
      "Attention card assertion failed: " + JSON.stringify(attention),
    );
  }
  if (
    pipeline.steps.length !== 4 ||
    !pipeline.text.includes(L.pipelineConversations) ||
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
    graph.nodeButtons !== 2 ||
    !graph.meta.includes("2 NODES") ||
    graph.relationFilters.length !== 4 ||
    ![L.graphRendererWebgl, L.graphRendererCanvas2d].includes(graph.renderer)
  ) {
    throw new Error("Graph browser assertion failed: " + JSON.stringify(graph));
  }
  if (
    !graphEmpty.emptyState ||
    graphEmpty.emptyTitle !== L.graphEmptyTitle ||
    !graphEmpty.canvas.every(Boolean) ||
    !graphEmpty.meta.includes("0 NODES") ||
    graphEmpty.labelPixels !== 0 ||
    graphEmpty.nodePixels !== 0 ||
    // A real frame must have been drawn, and every one of its pixels must be
    // the engine's clear colour. Asserting only "nothing painted" would also
    // accept a canvas that was never cleared.
    !graphEmpty.mapFrames ||
    !graphEmpty.mapTotal ||
    graphEmpty.mapBackground !== graphEmpty.mapTotal ||
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
  // #31: the tab must offer the catalog (hidden entries excluded), say which hold is
  // blocking this selection, admit the parked job, and actually persist a save.
  if (
    !modelTab.before.models.includes("gpt-6-astra") ||
    !modelTab.before.models.includes("gpt-5.6-luna") ||
    modelTab.before.models.includes("gpt-reserve") ||
    !modelTab.before.reasoning.includes("unset") ||
    !modelTab.before.reasoning.includes("high") ||
    modelTab.before.reasoning.includes("ultra") ||
    !modelTab.before.holdBanner ||
    !modelTab.before.holdResumes ||
    !modelTab.before.heldCard ||
    modelTab.before.heldBadge !== L.modelHeldBadge ||
    !modelTab.before.embeddingReadOnly ||
    !modelTab.before.testButton ||
    modelTab.after.selected !== "gpt-6-astra" ||
    modelTab.after.reasoning !== "high" ||
    !modelTab.after.source ||
    !modelTab.toast.includes("gpt-6-astra")
  ) {
    throw new Error("Model tab assertion failed: " + JSON.stringify(modelTab));
  }
  if (
    !modelTabAlt.otherLanguage ||
    modelTabAlt.bodyOverflow ||
    modelTabAlt.mainOverflow ||
    modelTabAlt.cardOverflow ||
    modelTabAlt.tableOverflow
  ) {
    throw new Error("Model tab (other language) assertion failed: " + JSON.stringify(modelTabAlt));
  }
  // #29/#30: one tab, two screens; a refused pattern must name the row it came from, and an
  // accepted one must reach the table through a real lock + CAS write.
  if (
    overlayTab.lang !== LANG ||
    overlayTab.gate.subnav.join(",") !== "gate,rules" ||
    overlayTab.gate.active !== "gate" ||
    overlayTab.gate.builtinRows < 1 ||
    !overlayTab.gate.testForm ||
    !overlayTab.gate.notShared ||
    !overlayTab.gate.noRecord ||
    overlayTab.refused.rows < 1 ||
    !/^patterns\.add\[\d+\]\.source$/.test(overlayTab.refused.path) ||
    overlayTab.refused.table !== overlayTab.gate.builtinRows ||
    !overlayTab.refused.toast ||
    overlayTab.saved.toast !== L.overlaysSavedToast ||
    !overlayTab.saved.id.startsWith("user.") ||
    !overlayTab.saved.origin ||
    !overlayTab.saved.note ||
    overlayTab.saved.rows !== overlayTab.gate.builtinRows + 1 ||
    !overlayTab.rules.editor ||
    overlayTab.rules.rawPromptField ||
    !overlayTab.rules.clause ||
    !overlayTab.rules.simulate ||
    !overlayTab.rules.verifierUnchanged ||
    !overlayTab.rules.enforcement ||
    !overlayTab.rules.schedulingKey ||
    !overlayTab.rules.timing ||
    !overlayTab.rules.noReextractApply ||
    !overlayTab.rules.gateFormGone ||
    overlayTab.rules.bodyOverflow ||
    overlayTab.rules.mainOverflow
  ) {
    throw new Error("Overlay tab assertion failed: " + JSON.stringify(overlayTab));
  }
  const savedOverlay = JSON.parse(
    fs.readFileSync(path.join(MEMEX_HOME, "overlays", "recall-gate.json"), "utf8"),
  );
  if (
    savedOverlay.revision !== 1 ||
    savedOverlay.updated_by?.surface !== "web-ui" ||
    savedOverlay.patterns.add.length !== 1 ||
    savedOverlay.patterns.add[0].source !== OVERLAY_PATTERN
  ) {
    throw new Error(
      "recall-gate.json was not written by the UI: " + JSON.stringify(savedOverlay),
    );
  }
  const savedSelection = JSON.parse(
    fs.readFileSync(path.join(MEMEX_HOME, "models.json"), "utf8"),
  );
  if (savedSelection.llm.model !== "gpt-6-astra" || savedSelection.llm.reasoning !== "high")
    throw new Error("models.json was not written by the UI: " + JSON.stringify(savedSelection));
  // #109 L5 · §9.4 (4): every surface is in this run's language and nothing else.
  if (
    langIntegrity.total ||
    langIntegrity.visited.length !== 7 ||
    langIntegrity.htmlLang !== LANG ||
    langIntegrity.dataLang !== LANG ||
    // §14.1: the longer language must not spill out of the shell — at the gate's own
    // width or at the 190px sidebar the ≤1150px breakpoint uses. `.nav-label` truncates
    // instead (the `title` attribute keeps the full label reachable), and a `.kv` label
    // may wrap but must never overflow its column.
    langIntegrity.width.sidebarOverflow ||
    langIntegrity.width.navLabelOverflow.length ||
    langIntegrity.width.narrow.overflow.length ||
    langIntegrity.width.kv.overflowing.length
  ) {
    throw new Error(
      "Language integrity assertion failed (" + LANG + "): " + JSON.stringify(langIntegrity),
    );
  }
  // #109 L5 · §9.4 (5): a fresh profile, no `?lang`, server default only.
  if (
    serverLangDefault.htmlLang !== LANG ||
    serverLangDefault.dataLang !== LANG ||
    serverLangDefault.meta !== LANG ||
    serverLangDefault.storedLanguage !== null ||
    serverLangDefault.urlHasLang ||
    !serverLangDefault.navFacts.includes(L.navFacts) ||
    serverLangDefault.scopeInjection !== L.scopeInjection
  ) {
    throw new Error(
      "Server default language assertion failed: " + JSON.stringify(serverLangDefault),
    );
  }
  // #109 L5 · §9.4 (6): CSP is never relaxed for the language channel, and a missing
  // dictionary key is a build-time bug — neither may ever reach the browser console.
  const consoleMessages = [...cdp.consoleMessages, ...serverLangDefault.consoleMessages];
  const cspViolations = consoleMessages.filter((m) => /Content Security Policy/i.test(m));
  const missingKeys = consoleMessages.filter((m) => /\[memex-ui\]\[i18n\] missing/.test(m));
  if (cspViolations.length || missingKeys.length)
    throw new Error(
      "browser console is not clean: " +
        JSON.stringify({ cspViolations, missingKeys }),
    );
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
          language: LANG,
          timezone: "UTC",
          server: readyLines.split("\n")[0],
        },
        verdict: "PASS",
        checks: {
          scopeDefaults,
          factDeepLink,
          scopeSwitch,
          helpLayer,
          tierBanner,
          tierPromote,
          jobGuidance,
          attention,
          syncTab,
          syncArchive,
          modelTab,
          modelTabAlt,
          overlayTab,
          importedFact,
          langIntegrity,
          serverLangDefault,
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
  if (SCREENSHOTS) {
    const showcase = await captureShowcase();
    console.log(
      "__WEB_UI_SCREENSHOTS__" +
        JSON.stringify({
          directory: path.join(SCREENSHOTS, LANG),
          language: LANG,
          files: showcase.results.map((r) => ({
            file: r.file,
            bytes: fs.statSync(path.join(SCREENSHOTS, LANG, r.file)).size,
            observed: { ...r.value, ...(r.extra || {}) },
          })),
        }),
    );
  }
} finally {
  cdp?.close();
  await stop(chrome?.child);
  await stop(ui?.child);
  fs.rmSync(TEMP, { recursive: true, force: true });
}
