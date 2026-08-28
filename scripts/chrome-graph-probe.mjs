#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome CDP connection timed out')), 10_000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome CDP connection failed')); }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.method === message.method && (!waiter.sessionId || waiter.sessionId === message.sessionId)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message.params ?? {});
        }
      }
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitEvent(method, sessionId, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Chrome CDP event timed out: ${method}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

function waitForDevTools(proc) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not expose CDP\n${stderr}`)), 15_000);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before CDP was ready (${code})\n${stderr}`));
    });
  });
}

async function measurePage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    const loaded = cdp.waitEvent('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;
    const expression = `new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('graph did not become interactive')), 15000);
      const finish = () => {
        const boot = document.querySelector('#boot');
        const canvas = document.querySelector('#stage canvas');
        const loadFailure = boot && boot.textContent.includes('로드 실패');
        if (loadFailure) {
          clearTimeout(deadline);
          reject(new Error(boot.textContent.trim()));
          return true;
        }
        if (canvas && boot && boot.classList.contains('hide')) {
          requestAnimationFrame(() => {
            clearTimeout(deadline);
            resolve({
              firstInteractiveMs: performance.now(),
              canvasWidth: canvas.width,
              canvasHeight: canvas.height,
              domains: document.querySelector('#stDomains')?.textContent,
              facts: document.querySelector('#stFacts')?.textContent,
              bootHidden: true
            });
          });
          return true;
        }
        return false;
      };
      if (finish()) return;
      const observer = new MutationObserver(() => { if (finish()) observer.disconnect(); });
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    })`;
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

export async function probeGraphBrowser({ url, iterations = 3, chromePath = process.env.MEMEX_CHROME_PATH || DEFAULT_CHROME }) {
  if (!url) throw new Error('url is required');
  if (!fs.existsSync(chromePath)) throw new Error(`Google Chrome not found: ${chromePath}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-chrome-'));
  const proc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const wsUrl = await waitForDevTools(proc);
    cdp = new CdpClient(wsUrl);
    await cdp.connect();
    const samples = [];
    for (let i = 0; i < iterations; i++) samples.push(await measurePage(cdp, url));
    return {
      browser: 'Google Chrome',
      transport: 'Chrome DevTools Protocol',
      url,
      samples,
    };
  } finally {
    cdp?.close();
    proc.kill('SIGTERM');
    await new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve();
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 5_000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const url = process.argv[2];
  const iterations = Number(process.argv[3] || 3);
  probeGraphBrowser({ url, iterations })
    .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
}
