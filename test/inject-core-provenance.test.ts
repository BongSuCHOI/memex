import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Provenance 게이트 (RETRIEVAL-AND-CONTEXT.md:43-48, 2026-08-28 감사 ⑦).
 *
 * 컨텍스트 발행 전 durable `prepared` recall 영수증이 있어야 한다. sessionId 없는
 * 호출은 recall_events 행을 남길 수 없으므로 fact 주입을 생략해야 한다 — 그렇지
 * 않으면 주입된 fact 가 provenance 없이 소비되어 "one recall must not taint sibling
 * tools" 불변식의 추적 가능성이 깨진다.
 */

let tmp: string;
const prevHome = process.env.MEMEX_HOME;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mb-inject-provenance-"));
  process.env.MEMEX_HOME = tmp;
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.MEMEX_HOME;
  else process.env.MEMEX_HOME = prevHome;
});

describe("inject provenance 게이트", () => {
  it("sessionId 없는 호출은 DB/embedding 없이 빈 문자열을 반환한다", async () => {
    const { computeInjectContext } = await import("../src/inject-core.js");
    const out = await computeInjectContext(
      "이전에 캐시 무효화 전략을 어떻게 결정했는지 알려줘",
      "/tmp/proj-x",
      "daemon",
      undefined,
    );
    expect(out).toBe("");
    // 게이트가 DB 접근 전에 반환했음을 inject log 로 증명한다
    const logPath = path.join(
      tmp,
      "conversation-index",
      "logs",
      "inject-context.jsonl",
    );
    const entries = fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
    expect(entries.some((e) => e.status === "no-session-provenance")).toBe(
      true,
    );
  });
});
