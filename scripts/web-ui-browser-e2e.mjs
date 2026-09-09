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

const probe = (body) => `(async()=>{${DRIVER}${body}})()`;

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
const SHOWCASE_DOMAINS = [
  ["engineering", "엔지니어링", "저장소, 동기화, 검색 런타임"],
  ["product", "제품 · 경험", "탐색 구조와 편집 경험"],
  ["operations", "운영 · 신뢰", "관측, 보안, 진단"],
  ["workflow", "작업 방식", "릴리스 절차와 팀 규칙"],
];
const SHOWCASE_CATEGORIES = [
  ["storage", "engineering", "로컬 저장소", "SQLite 스키마와 파일 배치"],
  ["sync", "engineering", "동기화", "변경 로그 교환과 충돌 해결"],
  ["search", "engineering", "검색", "FTS 인덱스와 임베딩 조회"],
  ["navigation", "product", "정보 구조", "노트 목록과 탐색 경로"],
  ["editor", "product", "편집 경험", "단축키, 자동 저장, 서식"],
  ["observability", "operations", "관측 · 추적", "로그, 지표, 실패 기록"],
  ["security", "operations", "보안 · 권한", "자격 증명과 데이터 보호"],
  ["release", "workflow", "릴리스 절차", "브랜치, 태그, 배포 일정"],
  ["conventions", "workflow", "팀 규칙", "리뷰, 문서화, 개인 선호"],
];
// [category, kind, Korean text, English source text or null]
const SHOWCASE_FACTS = [
  ["storage", "decision", "노트 본문은 로컬 SQLite에 저장하고, 원격에는 변경 로그만 내보낸다.", "Atlas keeps note bodies in local SQLite and exports only the change log."],
  ["storage", "constraint", "노트 삭제는 즉시 파기하지 않고 30일 동안 휴지통에 보관한 뒤 정리한다.", null],
  ["storage", "pattern", "첨부 파일은 본문 테이블과 분리해 콘텐츠 해시 경로에 저장한다.", null],
  ["storage", "knowledge", "데이터베이스 마이그레이션은 실행 전에 자동으로 스냅샷을 남긴다.", null],
  ["sync", "decision", "동기화 충돌은 마지막 쓰기 승리 대신 필드 단위 병합으로 해결한다.", "Sync resolves conflicts field by field instead of last-write-wins."],
  ["sync", "constraint", "동기화 실패를 조용히 넘기지 않고 실패 사유를 그대로 남긴다.", null],
  ["sync", "pattern", "기기별 커서는 서버가 아니라 각 기기의 로컬 상태에 보관한다.", null],
  ["sync", "knowledge", "오프라인 편집은 재연결 시 한 번의 배치로 전송된다.", null],
  ["search", "decision", "검색은 FTS5 인덱스를 먼저 조회하고, 결과가 부족할 때만 임베딩 검색으로 보완한다.", "Search queries FTS5 first and only falls back to embeddings when results are thin."],
  ["search", "constraint", "검색 인덱스 재구축은 사용자가 명시적으로 시작할 때만 실행한다.", null],
  ["search", "knowledge", "제목 일치는 본문 일치보다 높은 가중치를 받는다.", null],
  ["navigation", "decision", "노트 목록의 기본 정렬은 최근 수정순이다.", null],
  ["navigation", "preference", "사이드바 폭은 사용자가 조절한 값을 기기별로 기억한다.", null],
  ["navigation", "pattern", "폴더 대신 태그를 기본 분류 수단으로 사용한다.", null],
  ["editor", "constraint", "에디터 단축키는 운영체제의 기본 텍스트 단축키를 재정의하지 않는다.", "The editor never overrides the operating system's default text shortcuts."],
  ["editor", "decision", "자동 저장은 입력이 멈춘 뒤 800ms에 한 번만 실행한다.", null],
  ["editor", "preference", "마크다운 미리보기는 기본으로 접어 두고 필요할 때 펼친다.", null],
  ["observability", "constraint", "로그에는 노트 제목과 본문을 남기지 않는다.", null],
  ["observability", "knowledge", "성능 회귀는 노트 1,000개 기준 벤치마크로 확인한다.", null],
  ["observability", "pattern", "수집되지 않은 지표는 0이 아니라 미수집으로 표시한다.", "Uncollected metrics are shown as not-collected, never as zero."],
  ["security", "constraint", "인증 토큰은 운영체제 키체인에 저장하고 설정 파일에 남기지 않는다.", null],
  ["security", "decision", "원격 저장소는 노트 본문을 평문으로 보관하지 않는다.", null],
  ["security", "knowledge", "내보내기 파일에는 기기 식별자를 포함하지 않는다.", null],
  ["release", "decision", "릴리스는 매월 첫째 주 화요일에만 태그한다.", null],
  ["release", "pattern", "핫픽스는 릴리스 브랜치에서 분기하고 main으로 되돌려 병합한다.", null],
  ["release", "constraint", "실험 기능은 기본 꺼짐 상태로 배포하고 설정에서만 켠다.", null],
  ["conventions", "decision", "변경은 최소 한 명의 리뷰 승인을 받은 뒤 병합한다.", null],
  ["conventions", "preference", "회의록은 별도 도구 대신 Atlas 노트 안에서 관리한다.", null],
  ["conventions", "knowledge", "공개 동작이 바뀌면 같은 변경에서 문서도 함께 고친다.", null],
];
const SHOWCASE_GLOBAL_FACTS = [
  ["conventions", "preference", "커밋 메시지는 무엇을 왜 바꿨는지 한 문장으로 먼저 적는다.", null],
  ["observability", "preference", "실패한 작업은 재시도 횟수와 마지막 오류를 함께 확인한다.", null],
  ["conventions", "knowledge", "설계 결정은 결정 시점의 근거와 함께 기록해 둔다.", null],
];
const SHOWCASE_ALT_FACTS = [
  ["storage", "decision", "모바일은 최근 200개 노트만 오프라인으로 보관한다.", null],
  ["editor", "constraint", "모바일 편집기는 첨부 업로드를 25MB로 제한한다.", null],
  ["navigation", "preference", "모바일 첫 화면은 검색이 아니라 최근 노트를 보여준다.", null],
];
const SHOWCASE_SESSIONS = [
  ["로컬 우선 저장 구조를 어떻게 잡을까?", "노트 본문과 첨부를 어디에 두는지 정리하고 싶어.", "storage"],
  ["두 기기에서 같은 노트를 고치면 어떻게 되지?", "충돌 처리 규칙을 정해두자.", "sync"],
  ["검색이 느려지는 구간을 찾아보자.", "인덱스 구성과 조회 순서를 확인하고 싶어.", "search"],
  ["에디터 단축키 정책을 확정하자.", "운영체제 기본 동작과 겹치는 부분이 문제야.", "editor"],
  ["첨부 파일 저장 위치를 정리하자.", "본문과 같은 테이블에 두면 나중에 곤란할 것 같아.", "storage"],
  ["릴리스와 핫픽스 흐름을 문서로 남기자.", "브랜치 규칙이 사람마다 다르게 이해되고 있어.", "release"],
  ["토큰 보관과 로그 정책을 점검하자.", "설정 파일에 토큰이 남는 경로가 있는지 확인해줘.", "security"],
  ["노트 목록 정렬과 사이드바 동작을 맞추자.", "기기마다 다르게 보이는 이유를 알고 싶어.", "navigation"],
  ["성능 회귀를 어떤 기준으로 볼까?", "벤치마크 조건을 고정해두면 좋겠어.", "observability"],
];
const SHOWCASE_SESSIONS_ALT = [
  ["모바일 오프라인 편집 범위를 정하자.", "전부 내려받는 건 현실적이지 않아 보여.", "storage"],
  ["모바일 업로드 제한을 얼마로 둘까?", "큰 첨부에서 실패가 반복되고 있어.", "editor"],
  ["모바일 첫 화면 구성을 정리하자.", "실제로 가장 많이 쓰는 동선을 기준으로 하자.", "navigation"],
];

/** Build a presentable demo database against the real core schema. */
function seedShowcase(initDatabase, dbPath) {
  const db = initDatabase({ dbPath });
  const now = Date.now();
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
              : "결정한 내용을 기록해 두고, 나중에 근거를 찾을 수 있게 원문 위치도 남겨줘.",
          t === 0
            ? "현재 구조를 확인한 뒤, 결정할 지점과 이미 정해진 제약을 나눠서 정리하겠습니다."
            : "정리한 결정과 그 근거가 된 대화 위치를 함께 남겨두겠습니다. 확정되지 않은 항목은 결정으로 기록하지 않습니다.",
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
  // states so the 처리 작업 screen is not a wall of green.
  sessions.forEach((session, index) => {
    const state =
      index === 0 ? "running" : index === 3 ? "retry" : index === 6 ? "dead" : "completed";
    const lastError =
      state === "retry"
        ? "MODEL_BUDGET_EXHAUSTED: 이번 실행의 시도 예산을 모두 사용했습니다."
        : state === "dead"
          ? "EVIDENCE_UNRESOLVED: 근거로 지목된 원문을 다시 찾지 못했습니다."
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
            ? "모델 작업 기한을 초과했습니다."
            : state === "dead"
              ? "근거 원문을 확인하지 못해 저장하지 않았습니다."
              : null,
        ],
      );
    // Capture indexing and Work Capsule jobs run on the same queue; showing only
    // extraction would misrepresent what the 처리 작업 tab actually lists.
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
            ? "CAPSULE_STALE: 이후 턴이 먼저 반영되어 이 갱신을 다시 계산합니다."
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
          "작업 기한을 초과해 이 구간을 재시도 대상으로 남겼습니다.",
          "retry",
          2,
          at(session.ageBase - 2),
          at(session.ageBase - 6),
        ],
      );
  });

  // Facts, bound to real exchanges in the same project so 근거 has something
  // to show, plus a smaller alternate project and a few global preferences.
  const mainSessions = sessions.filter((s) => s.project === SHOWCASE_PROJECT);
  const altSessions = sessions.filter((s) => s.project === SHOWCASE_PROJECT_ALT);
  const factIds = [];
  let seq = 0;
  const addFact = (index, entry, options) => {
    const [category, kind, korean, english] = entry;
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
        english || korean,
        english ? korean : null,
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
    factIds.push({ id, category, korean, english, global: !!options.global, project: session.project });
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
        changed ? "이 항목은 아직 결정되지 않은 후보였습니다." : null,
        english || korean,
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
          ? "대화에서 확정된 표현으로 문장을 교체하고 근거를 다시 연결했습니다."
          : "사용자가 직접 확정한 문장을 그대로 기록했습니다.",
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
          "같은 설계 주제를 서로 다른 관점에서 설명하는 기억입니다.",
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
    graphLabel: factIds[0].korean,
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
    fs.writeFileSync(path.join(SCREENSHOTS, file), Buffer.from(shot.data, "base64"));
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
    fs.mkdirSync(SCREENSHOTS, { recursive: true });
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
    const scope =
      "?scope=project&project=" + encodeURIComponent(SHOWCASE_PROJECT) + "&includeGlobal=1";
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
           return el&&el.textContent.includes('해석에 참고한 맥락')?el:null;
         });
         await sleep(350);
         return {tab:text('#detail .tab.active'),hasDirectEvidence:body.textContent.includes('직접 근거')};`,
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
           return el&&el.textContent.includes('처리 대상')?el:null;
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

  // #24: with no scope in the URL the workspace must land on 전체 프로젝트 (조회), not
  // common memory. This probe runs before anything that calls changeScope(), because
  // the browser profile is shared and a persisted scope would mask the default.
  const scopeDefaults = await pageProbe(
    cdp,
    base + "/facts",
    probe(`
      await until('facts row',()=>document.querySelector('#main .data-table .fact-text'));
      const select=document.querySelector('#scope-select');
      const hint=document.querySelector('#scope-hint');
      return {
        urlScope:new URL(location.href).searchParams.get('scope'),
        selected:select.value,
        options:[...select.options].map(o=>o.textContent.trim()),
        groups:[...select.querySelectorAll('optgroup')].map(g=>g.label),
        navLabels:[...document.querySelectorAll('#sidebar .nav-item .nav-label')].map(x=>x.textContent),
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
    base + "/facts?scope=all&fact=" + encodeURIComponent(factId),
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
    base + "/conversations?scope=global",
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

  if (
    scopeDefaults.urlScope !== "all" ||
    scopeDefaults.selected !== "all" ||
    !scopeDefaults.options[0]?.startsWith("전체 프로젝트 (조회)") ||
    !scopeDefaults.options[1]?.startsWith("공통 기억") ||
    !scopeDefaults.options.slice(0, 2).every((o) => /기억 \d/.test(o)) ||
    !scopeDefaults.groups.includes("프로젝트") ||
    !scopeDefaults.navLabels.includes("기억·사실") ||
    scopeDefaults.heading !== "기억·사실" ||
    !scopeDefaults.title.startsWith("기억·사실 · ") ||
    !scopeDefaults.hint.includes("주입") ||
    !scopeDefaults.hintTitle.includes("공통 기억") ||
    !scopeDefaults.scopeLine.includes("조회 전용")
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
    !scopeSwitch.bannerText.includes("공통 기억 범위에는 대화가 없습니다") ||
    !scopeSwitch.bannerCleared
  ) {
    throw new Error(
      "Common-scope switch assertion failed: " + JSON.stringify(scopeSwitch),
    );
  }
  if (
    facts.hasInjectedImage ||
    facts.injectedFlag ||
    facts.rowCount !== 1 ||
    facts.pageOverflowX ||
    !facts.factText.includes("한글 사실") ||
    facts.navItems.length !== 7 ||
    facts.navItems[2] !== "기억·사실" ||
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
          scopeDefaults,
          factDeepLink,
          scopeSwitch,
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
          directory: SCREENSHOTS,
          files: showcase.results.map((r) => ({
            file: r.file,
            bytes: fs.statSync(path.join(SCREENSHOTS, r.file)).size,
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
