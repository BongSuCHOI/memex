#!/usr/bin/env node
// Explicit, isolated acceptance benchmark. It never reads or writes user data.
//   node scripts/benchmark.mjs [--rollouts 200] [--queries 30]
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeGraphBrowser } from "./chrome-graph-probe.mjs";
import { validateBenchmarkReport } from "./benchmark-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const numberArg = (name, fallback) => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? Number(argv[index + 1]) : fallback;
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return Math.floor(value);
};

const THRESHOLDS = {
  AC_PERF_01_vector_p95_ms: 2_000,
  AC_PERF_01_text_p95_ms: 1_000,
  AC_PERF_01_both_p95_ms: 2_000,
  AC_PERF_02_fact_p95_ms: 500,
  AC_PERF_02_graph_p95_ms: 500,
  AC_PERF_03_warm_p95_ms: 3_000,
  AC_PERF_03_cold_p95_ms: 5_000,
  AC_PERF_04_sync_p95_ms: 120_000,
  AC_PERF_04_peak_rss_mb: 2_048,
  AC_PERF_05_api_p95_ms: 1_000,
  AC_PERF_05_browser_p95_ms: 10_000,
  AC_PERF_06_analyze_p95_ms: 5_000,
  AC_PERF_06_peak_rss_mb: 1_024,
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
}

function resourceUsageMb() {
  return Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;
}

async function workerMain(kind) {
  const started = performance.now();
  if (kind === "sync") {
    const { syncConversations } = await import(
      path.join(ROOT, "dist", "sync.js")
    );
    const result = await syncConversations(
      process.env.BENCH_SOURCE,
      process.env.BENCH_ARCHIVE,
      { skipSummaries: true },
    );
    process.stdout.write(
      `__BENCH_JSON__${JSON.stringify({
        runtime_ms: performance.now() - started,
        peak_rss_mb: resourceUsageMb(),
        copied: result.copied,
        indexed: result.indexed,
        skipped: result.skipped,
        errors: result.errors,
      })}\n`,
    );
    return;
  }
  if (kind === "analyze") {
    const { analyzeHistory } = await import(
      path.join(ROOT, "dist", "analyze.js")
    );
    const report = await analyzeHistory({ dbPath: process.env.TEST_DB_PATH });
    process.stdout.write(
      `__BENCH_JSON__${JSON.stringify({
        runtime_ms: performance.now() - started,
        peak_rss_mb: resourceUsageMb(),
        coverage: report.coverage,
      })}\n`,
    );
    return;
  }
  throw new Error(`unknown worker: ${kind}`);
}

function runJsonProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`process timed out: ${command} ${args.join(" ")}\n${stderr}`),
      );
    }, options.timeoutMs ?? 180_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new Error(
            `process failed (${code}): ${command} ${args.join(" ")}\n${stderr}\n${stdout}`,
          ),
        );
      const marker = stdout
        .split("\n")
        .findLast((line) => line.startsWith("__BENCH_JSON__"));
      if (marker) {
        try {
          return resolve(JSON.parse(marker.slice("__BENCH_JSON__".length)));
        } catch (error) {
          return reject(
            new Error(`invalid benchmark worker JSON: ${error.message}`),
          );
        }
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `process returned no JSON: ${error.message}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function runHook(env, input) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "scripts", "inject-context.js")],
      {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`inject hook timed out\n${stderr}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error(`inject hook failed (${code})\n${stderr}`));
      let payload = null;
      if (stdout.trim()) {
        try {
          payload = JSON.parse(stdout.trim());
        } catch (e) {
          return reject(
            new Error(
              `inject hook returned invalid JSON (${e.message})\n${stdout.slice(0, 300)}`,
            ),
          );
        }
      }
      resolve({ runtime_ms: performance.now() - started, payload, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function waitForSocket(socketPath, timeoutMs = 15_000) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  return new Promise((resolve, reject) => {
    let watcher;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {}
      if (error) reject(error);
      else resolve();
    };
    const probe = () => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        finish();
      });
      socket.once("error", () => socket.destroy());
    };
    watcher = fs.watch(path.dirname(socketPath), (_event, filename) => {
      if (!filename || String(filename) === path.basename(socketPath)) probe();
    });
    const timer = setTimeout(
      () =>
        finish(
          new Error(`inject daemon socket did not become ready: ${socketPath}`),
        ),
      timeoutMs,
    );
    probe();
  });
}

function startMcpDaemon(env, socketPath) {
  const ready = waitForSocket(socketPath);
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "cli", "mcp-server-wrapper.js")],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((_, reject) =>
    child.once("exit", (code) =>
      reject(new Error(`MCP daemon exited (${code})\n${stderr}`)),
    ),
  );
  return {
    child,
    ready: Promise.race([ready, exited]),
    stop: async () => {
      child.stdin.end();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startUiServer(env, port) {
  const child = spawn(process.execPath, [path.join(ROOT, "ui", "server.cjs")], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`UI server did not start\n${stderr}`)),
      10_000,
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes(`Memex UI: http://localhost:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI server exited (${code})\n${stderr}`));
    });
  });
  return {
    child,
    ready,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function writeCorpus(source, rollouts) {
  for (let i = 0; i < rollouts; i++) {
    const day = path.join(
      source,
      "2026",
      "08",
      String(20 + (i % 6)).padStart(2, "0"),
    );
    fs.mkdirSync(day, { recursive: true });
    const project = `/tmp/bench/proj-${i % 7}`;
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-26T01:00:00Z",
        payload: {
          id: `thr-b${i}`,
          session_id: `sess-b${i}`,
          cwd: project,
          source: "cli",
        },
      }),
    ];
    for (let turn = 0; turn < 4; turn++) {
      lines.push(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Benchmark question ${i}-${turn} about pagination caching auth flows and deployment pipelines.`,
              },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: `Benchmark answer ${i}-${turn}: use keyset pagination cache invalidation with etags OAuth2 PKCE and blue-green deploys.`,
              },
            ],
          },
        }),
      );
    }
    fs.writeFileSync(
      path.join(day, `rollout-bench-${i}.jsonl`),
      lines.join("\n") + "\n",
    );
  }
}

async function main() {
  const rollouts = Math.max(numberArg("--rollouts", 200), 200);
  const queries = Math.max(numberArg("--queries", 30), 10);
  // Keep the Unix-socket path below macOS sockaddr_un's limit.
  const temp = fs.mkdtempSync("/tmp/mb-bench-");
  const source = path.join(temp, "sessions");
  const processes = [];
  try {
    writeCorpus(source, rollouts);

    const syncSamples = [];
    const homes = [];
    for (let run = 0; run < 3; run++) {
      const home = path.join(temp, `run-${run}`);
      const dbPath = path.join(home, "conversation-index", "db.sqlite");
      const archive = path.join(home, "conversation-archive");
      homes.push({ home, dbPath, archive });
      syncSamples.push(
        await runJsonProcess(process.execPath, [SELF, "--worker", "sync"], {
          env: {
            MEMEX_HOME: home,
            TEST_DB_PATH: dbPath,
            BENCH_SOURCE: source,
            BENCH_ARCHIVE: archive,
          },
        }),
      );
    }
    if (
      syncSamples.some(
        (sample) => sample.errors.length || sample.indexed !== rollouts,
      )
    ) {
      throw new Error(
        `sync correctness failed: ${JSON.stringify(syncSamples)}`,
      );
    }
    const primary = homes[0];
    const noopSample = await runJsonProcess(
      process.execPath,
      [SELF, "--worker", "sync"],
      {
        env: {
          MEMEX_HOME: primary.home,
          TEST_DB_PATH: primary.dbPath,
          BENCH_SOURCE: source,
          BENCH_ARCHIVE: primary.archive,
        },
      },
    );
    if (
      noopSample.errors.length ||
      noopSample.indexed !== 0 ||
      noopSample.skipped !== rollouts
    ) {
      throw new Error(
        `no-op sync correctness failed: ${JSON.stringify(noopSample)}`,
      );
    }

    process.env.MEMEX_HOME = primary.home;
    process.env.TEST_DB_PATH = primary.dbPath;
    const { initDatabase } = await import(path.join(ROOT, "dist", "db.js"));
    const { insertFact, searchSimilarFacts } = await import(
      path.join(ROOT, "dist", "fact-db.js")
    );
    const { createDomain, createCategory, createRelation, getRelatedFacts } =
      await import(path.join(ROOT, "dist", "ontology-db.js"));
    const { initEmbeddings, generateEmbedding } = await import(
      path.join(ROOT, "dist", "embeddings.js")
    );
    const { searchConversations } = await import(
      path.join(ROOT, "dist", "search.js")
    );
    const db = initDatabase();
    await initEmbeddings();

    const domain = createDomain(
      db,
      "Benchmark Architecture",
      "Synthetic benchmark domain",
    );
    const category = createCategory(
      db,
      domain.id,
      "Resilience",
      "Resilience and observability rules",
    );
    const factIds = [];
    for (let i = 0; i < 50; i++) {
      const text = `Architecture rule ${i}: structured logging circuit breakers keyset pagination and blue-green deployment for project ${i % 7}`;
      const id = insertFact(db, {
        fact: text,
        category: "architecture",
        scope_type: i % 4 === 0 ? "global" : "project",
        scope_project: i % 4 === 0 ? null : `/tmp/bench/proj-${i % 7}`,
        source_exchange_ids: [`sess-b${i}-0`],
        embedding: await generateEmbedding(text),
      });
      db.prepare("UPDATE facts SET ontology_category_id = ? WHERE id = ?").run(
        category.id,
        id,
      );
      factIds.push(id);
    }
    for (let i = 1; i < factIds.length; i++) {
      createRelation(
        db,
        factIds[i - 1],
        i % 2 ? "INFLUENCES" : "SUPPORTS",
        factIds[i],
        "benchmark relation",
      );
    }

    await searchConversations("keyset pagination caching", {
      mode: "both",
      limit: 10,
    });
    const queryTexts = Array.from(
      { length: queries },
      (_, i) => `keyset pagination caching deployment ${i}`,
    );
    const vector = [];
    const text = [];
    const both = [];
    let searchErrors = 0;
    let searchNoMatch = 0;
    for (const [mode, samples] of [
      ["vector", vector],
      ["text", text],
      ["both", both],
    ]) {
      for (const query of queryTexts) {
        const started = performance.now();
        try {
          const found = await searchConversations(query, { mode, limit: 10 });
          if (!found.length) searchNoMatch++;
        } catch {
          searchErrors++;
        }
        samples.push(performance.now() - started);
      }
    }

    const factSearch = [];
    const graphHop = [];
    let factErrors = 0;
    for (let i = 0; i < queries; i++) {
      const embedding = await generateEmbedding(
        `structured logging circuit breakers ${i}`,
      );
      let facts = [];
      let started = performance.now();
      try {
        facts = searchSimilarFacts(
          db,
          embedding,
          `/tmp/bench/proj-${i % 7}`,
          5,
        );
      } catch {
        factErrors++;
      }
      factSearch.push(performance.now() - started);
      if (!facts.length) {
        factErrors++;
        continue;
      }
      started = performance.now();
      try {
        getRelatedFacts(
          db,
          facts[0].fact.id,
          1,
          0.6,
          0.2,
          `/tmp/bench/proj-${i % 7}`,
        );
      } catch {
        factErrors++;
      }
      graphHop.push(performance.now() - started);
    }
    db.close();

    const daemonEnv = {
      MEMEX_HOME: primary.home,
      TEST_DB_PATH: primary.dbPath,
    };
    const socketPath = path.join(
      primary.home,
      "conversation-index",
      "inject-daemon.sock",
    );
    const daemon = startMcpDaemon(daemonEnv, socketPath);
    processes.push(daemon);
    await daemon.ready;
    const hookInput = (i, session) => ({
      prompt: `How should architecture rule ${i} use structured logging circuit breakers and keyset pagination?`,
      cwd: `/tmp/bench/proj-${i % 7}`,
      session_id: session,
    });
    await runHook(daemonEnv, hookInput(0, "bench-warmup"));
    const warmInject = [];
    let warmInjected = 0;
    for (let i = 0; i < 10; i++) {
      const result = await runHook(daemonEnv, hookInput(i, `bench-warm-${i}`));
      warmInject.push(result.runtime_ms);
      if (result.payload?.hookSpecificOutput?.additionalContext) warmInjected++;
    }
    await daemon.stop();
    processes.pop();
    if (fs.existsSync(socketPath))
      throw new Error(`MCP daemon socket survived shutdown: ${socketPath}`);

    const coldHome = path.join(temp, "cold-fallback");
    const coldEnv = { MEMEX_HOME: coldHome, TEST_DB_PATH: primary.dbPath };
    const coldInject = [];
    let coldInjected = 0;
    for (let i = 0; i < 5; i++) {
      const result = await runHook(coldEnv, hookInput(i, `bench-cold-${i}`));
      coldInject.push(result.runtime_ms);
      if (result.payload?.hookSpecificOutput?.additionalContext) coldInjected++;
    }
    if (
      fs.existsSync(
        path.join(coldHome, "conversation-index", "inject-daemon.sock"),
      )
    ) {
      throw new Error("cold fallback unexpectedly created a daemon socket");
    }

    const analyzeSamples = [];
    for (let run = 0; run < 3; run++) {
      analyzeSamples.push(
        await runJsonProcess(process.execPath, [SELF, "--worker", "analyze"], {
          env: { MEMEX_HOME: primary.home, TEST_DB_PATH: primary.dbPath },
        }),
      );
    }
    if (
      analyzeSamples.some(
        (sample) =>
          sample.coverage.totalConversations !== rollouts ||
          sample.coverage.totalExchanges !== rollouts * 4,
      )
    ) {
      throw new Error(
        `analyze correctness failed: ${JSON.stringify(analyzeSamples)}`,
      );
    }

    const port = await getFreePort();
    const ui = startUiServer(
      { MEMEX_HOME: primary.home, TEST_DB_PATH: primary.dbPath },
      port,
    );
    processes.push(ui);
    await ui.ready;
    const graphUrl = `http://127.0.0.1:${port}/graph?scope=all`;
    const graphApiUrl = `http://127.0.0.1:${port}/api/graph-data?scope=all`;
    const apiSamples = [];
    let graphPayload;
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const response = await fetch(graphApiUrl);
      const payload = await response.json();
      apiSamples.push(performance.now() - started);
      if (!response.ok)
        throw new Error(`graph API failed: ${JSON.stringify(payload)}`);
      graphPayload = payload;
    }
    if (graphPayload.meta.facts !== 50 || graphPayload.meta.relations !== 49) {
      throw new Error(
        `graph API correctness failed: ${JSON.stringify(graphPayload.meta)}`,
      );
    }
    const browser = await probeGraphBrowser({ url: graphUrl, iterations: 3 });
    await ui.stop();
    processes.pop();
    const browserSamples = browser.samples.map(
      (sample) => sample.firstInteractiveMs,
    );
    if (
      browser.samples.some(
        (sample) =>
          !sample.bootHidden || !sample.canvasWidth || sample.facts !== "50",
      )
    ) {
      throw new Error(
        `browser correctness failed: ${JSON.stringify(browser.samples)}`,
      );
    }

    const syncTimes = syncSamples.map((sample) => sample.runtime_ms);
    const syncRss = syncSamples.map((sample) => sample.peak_rss_mb);
    const analyzeTimes = analyzeSamples.map((sample) => sample.runtime_ms);
    const analyzeRss = analyzeSamples.map((sample) => sample.peak_rss_mb);
    const report = {
      verdict: "PASS",
      environment: {
        platform: `${os.platform()} ${os.arch()} (${os.cpus()[0].model})`,
        node: process.version,
        chrome: browser.browser,
        recorded_at: new Date().toISOString(),
        isolation: temp,
        thresholds_predeclared: THRESHOLDS,
      },
      corpus: {
        rollouts,
        exchanges: rollouts * 4,
        projects: 7,
        facts: 50,
        relations: 49,
        repeated_runs: 3,
      },
      results: {
        AC_PERF_01_conversation_search: {
          vector_p50_ms: percentile(vector, 50),
          vector_p95_ms: percentile(vector, 95),
          text_p50_ms: percentile(text, 50),
          text_p95_ms: percentile(text, 95),
          both_p50_ms: percentile(both, 50),
          both_p95_ms: percentile(both, 95),
          error_ratio: searchErrors / (queries * 3),
          no_match_ratio: searchNoMatch / (queries * 3),
          raw_samples: { vector, text, both },
          threshold_check: {
            vector_p95_pass:
              percentile(vector, 95) <= THRESHOLDS.AC_PERF_01_vector_p95_ms,
            text_p95_pass:
              percentile(text, 95) <= THRESHOLDS.AC_PERF_01_text_p95_ms,
            both_p95_pass:
              percentile(both, 95) <= THRESHOLDS.AC_PERF_01_both_p95_ms,
            error_ratio_pass: searchErrors === 0,
            no_match_ratio_pass: searchNoMatch === 0,
          },
        },
        AC_PERF_02_fact_and_graph_search: {
          fact_p50_ms: percentile(factSearch, 50),
          fact_p95_ms: percentile(factSearch, 95),
          graph_p50_ms: percentile(graphHop, 50),
          graph_p95_ms: percentile(graphHop, 95),
          error_ratio: factErrors / queries,
          raw_samples: { fact: factSearch, graph: graphHop },
          threshold_check: {
            fact_p95_pass:
              percentile(factSearch, 95) <= THRESHOLDS.AC_PERF_02_fact_p95_ms,
            graph_p95_pass:
              percentile(graphHop, 95) <= THRESHOLDS.AC_PERF_02_graph_p95_ms,
            error_ratio_pass: factErrors === 0,
          },
        },
        AC_PERF_03_context_injection: {
          warm_transport: "hook-process -> unix-socket -> MCP-sidecar",
          cold_transport: "fresh-hook-process -> local fallback",
          warm_p50_ms: percentile(warmInject, 50),
          warm_p95_ms: percentile(warmInject, 95),
          cold_p50_ms: percentile(coldInject, 50),
          cold_p95_ms: percentile(coldInject, 95),
          warm_injected_ratio: warmInjected / warmInject.length,
          cold_injected_ratio: coldInjected / coldInject.length,
          error_ratio: 0,
          raw_samples: { warm: warmInject, cold: coldInject },
          threshold_check: {
            warm_p95_pass:
              percentile(warmInject, 95) <= THRESHOLDS.AC_PERF_03_warm_p95_ms,
            cold_p95_pass:
              percentile(coldInject, 95) <= THRESHOLDS.AC_PERF_03_cold_p95_ms,
            warm_injection_pass: warmInjected === warmInject.length,
            cold_injection_pass: coldInjected === coldInject.length,
          },
        },
        AC_PERF_04_incremental_sync: {
          memory_method: "child-process resourceUsage.maxRSS",
          sync_p50_ms: percentile(syncTimes, 50),
          sync_p95_ms: percentile(syncTimes, 95),
          noop_resync_ms: noopSample.runtime_ms,
          peak_rss_p95_mb: percentile(syncRss, 95),
          raw_samples: {
            sync_ms: syncTimes,
            peak_rss_mb: syncRss,
            noop: noopSample,
          },
          threshold_check: {
            sync_p95_pass:
              percentile(syncTimes, 95) <= THRESHOLDS.AC_PERF_04_sync_p95_ms,
            peak_rss_pass:
              percentile(syncRss, 95) <= THRESHOLDS.AC_PERF_04_peak_rss_mb,
            noop_pass:
              noopSample.indexed === 0 && noopSample.skipped === rollouts,
          },
        },
        AC_PERF_05_3d_graph: {
          api_transport: "loopback HTTP /api/graph-data",
          browser_transport: "Google Chrome headless via CDP",
          api_p50_ms: percentile(apiSamples, 50),
          api_p95_ms: percentile(apiSamples, 95),
          browser_first_interactive_p50_ms: percentile(browserSamples, 50),
          browser_first_interactive_p95_ms: percentile(browserSamples, 95),
          rendered_nodes: graphPayload.meta.facts,
          rendered_edges: graphPayload.meta.relations,
          raw_samples: { api_ms: apiSamples, browser: browser.samples },
          threshold_check: {
            api_p95_pass:
              percentile(apiSamples, 95) <= THRESHOLDS.AC_PERF_05_api_p95_ms,
            browser_p95_pass:
              percentile(browserSamples, 95) <=
              THRESHOLDS.AC_PERF_05_browser_p95_ms,
            populated_graph_pass:
              graphPayload.meta.facts === 50 &&
              graphPayload.meta.relations === 49,
          },
        },
        AC_PERF_06_full_history_analyze: {
          memory_method: "child-process resourceUsage.maxRSS",
          analyze_p50_ms: percentile(analyzeTimes, 50),
          analyze_p95_ms: percentile(analyzeTimes, 95),
          peak_rss_p95_mb: percentile(analyzeRss, 95),
          analyzed_conversations: analyzeSamples[0].coverage.totalConversations,
          analyzed_exchanges: analyzeSamples[0].coverage.totalExchanges,
          raw_samples: { analyze_ms: analyzeTimes, peak_rss_mb: analyzeRss },
          threshold_check: {
            analyze_p95_pass:
              percentile(analyzeTimes, 95) <=
              THRESHOLDS.AC_PERF_06_analyze_p95_ms,
            peak_rss_pass:
              percentile(analyzeRss, 95) <= THRESHOLDS.AC_PERF_06_peak_rss_mb,
            coverage_pass:
              analyzeSamples[0].coverage.totalConversations === rollouts,
          },
        },
      },
    };
    const failed = validateBenchmarkReport(report);
    if (failed.length)
      throw new Error(`benchmark contract failed: ${failed.join("; ")}`);
    const outFile = path.join(ROOT, "docs", "verification", "benchmark.json");
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.stderr.write(`Saved: ${outFile}\n`);
  } finally {
    for (const processHandle of processes.reverse())
      await processHandle.stop().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const workerIndex = argv.indexOf("--worker");
if (workerIndex >= 0) {
  workerMain(argv[workerIndex + 1]).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
} else {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}
