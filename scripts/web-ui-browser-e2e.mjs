#!/usr/bin/env node
// Real-Chrome QA for affected Web UI surfaces. Isolated data, processes and
// browser profiles are removed before exit; caller-selected screenshots remain.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME =
  process.env.MEMORY_BANK_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const evidenceArg = process.argv.indexOf("--evidence-dir");
const EVIDENCE =
  evidenceArg >= 0
    ? path.resolve(process.argv[evidenceArg + 1])
    : fs.mkdtempSync("/tmp/mb-web-ui-evidence-");
const TEMP = fs.mkdtempSync("/tmp/mb-web-ui-e2e-");
const HOME = path.join(TEMP, "memory-bank");
const DB_PATH = path.join(HOME, "conversation-index", "db.sqlite");
const PROFILE = path.join(TEMP, "chrome-profile");
const MALICIOUS =
  "<img src=x onerror=globalThis.__mbInjected=true> 한글 사실은 안전하게 표시됩니다";

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
      MEMEX_HOME: HOME,
      TEST_DB_PATH: DB_PATH,
      MEMORY_BANK_PLUGIN_ROOT: ROOT,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("UI start timeout\n" + stderr)),
      10000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("Memex UI: http://localhost:" + port)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("UI exited " + code + "\n" + stderr));
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

function waitFor(condition, value) {
  return (
    "new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('surface timeout')),15000);const done=()=>{if(" +
    condition +
    "){clearTimeout(deadline);resolve(" +
    value +
    ");return true}return false};if(done())return;const observer=new MutationObserver(()=>{if(done())observer.disconnect()});observer.observe(document.documentElement,{attributes:true,childList:true,subtree:true});document.addEventListener('transitionend',()=>{if(done())observer.disconnect()},{capture:true});document.addEventListener('animationend',()=>{if(done())observer.disconnect()},{capture:true})})"
  );
}

let ui;
let chrome;
let cdp;
try {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  process.env.MEMEX_HOME = HOME;
  process.env.TEST_DB_PATH = DB_PATH;
  const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
  const db = initDatabase();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, is_active) VALUES (?, ?, ?, 'global', NULL, '[]', ?, ?, 1)",
  ).run(
    "00000000-0000-4000-8000-000000000001",
    MALICIOUS,
    "decision",
    now,
    now,
  );
  db.close();

  const port = await freePort();
  ui = startServer(port);
  await ui.ready;
  chrome = startChrome();
  cdp = new Cdp(await chrome.ready);
  await cdp.connect();
  const base = "http://127.0.0.1:" + port;

  const facts = await pageProbe(
    cdp,
    base + "/facts",
    waitFor(
      "document.querySelector('#rows td.fact')?.textContent.includes('한글 사실')",
      "({title:document.title,factText:document.querySelector('#rows td.fact').textContent,hasInjectedImage:Boolean(document.querySelector('#rows td.fact img')),injectedFlag:Boolean(globalThis.__mbInjected),rowCount:document.querySelectorAll('#rows tr').length,wordBreak:getComputedStyle(document.querySelector('#rows td.fact')).wordBreak})",
    ),
    "facts.png",
    true,
  );
  const pipeline = await pageProbe(
    cdp,
    base + "/pipeline",
    waitFor(
      "document.querySelector('#out table') && document.querySelector('#out pre')?.textContent.includes('conversationReady')",
      "({title:document.title,text:document.querySelector('#out').innerText,rows:document.querySelectorAll('#out tr').length})",
    ),
    "pipeline.png",
    true,
  );
  const graph = await pageProbe(
    cdp,
    base + "/graph?scope=global",
    waitFor(
      "document.querySelector('#stage canvas') && document.querySelector('#boot')?.classList.contains('hide') && getComputedStyle(document.querySelector('#boot')).opacity === '0' && document.body.innerText.includes('아직 표시할 active fact가 없습니다')",
      "({title:document.title,canvas:[document.querySelector('#stage canvas').width,document.querySelector('#stage canvas').height],facts:document.querySelector('#stFacts')?.textContent,emptyState:document.body.innerText.includes('아직 표시할 active fact가 없습니다'),pipelineLink:Boolean(document.querySelector('a[href=\\\"/pipeline\\\"]'))})",
    ),
    "graph-empty.png",
    true,
  );

  if (
    facts.hasInjectedImage ||
    facts.injectedFlag ||
    facts.rowCount !== 1 ||
    !facts.factText.includes("한글 사실")
  ) {
    throw new Error("Facts browser assertion failed: " + JSON.stringify(facts));
  }
  if (pipeline.rows !== 3 || !pipeline.text.includes("conversation-ready")) {
    throw new Error(
      "Pipeline browser assertion failed: " + JSON.stringify(pipeline),
    );
  }
  if (
    graph.facts !== "0" ||
    !graph.emptyState ||
    !graph.pipelineLink ||
    !graph.canvas.every(Boolean)
  ) {
    throw new Error(
      "Graph empty-state assertion failed: " + JSON.stringify(graph),
    );
  }
  for (const result of [facts, pipeline, graph]) {
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
        },
        verdict: "PASS",
        checks: {
          facts,
          pipeline,
          graphEmpty: graph,
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
