import fs from "fs";
import path from "path";
import { getIndexDir } from "./paths.js";

/**
 * Observability log for the UserPromptSubmit context injection pipeline.
 *
 * The injection hook historically failed silently (stderr discarded, empty
 * output indistinguishable from "no relevant facts"), which let a broken
 * install go unnoticed for months. Every run now appends one JSONL line so
 * "injection never fires" becomes measurable instead of invisible.
 *
 * Logging is strictly best-effort: it must never throw or block injection.
 */

const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate at 5MB

export interface InjectLogEntry {
 ts: string;
 /** 'deduped': 후보 전부가 이 세션에서 이미 주입됨 → 재주입 0 (토큰 절약 관측용). */
 status:
  /** At least one extracted fact entered the prompt. */
  | "injected"
  /**
   * Issue #32: a bundle was emitted but it carried zero facts — Capsule or
   * assistant-context sections only. This used to be logged as `injected`, so
   * "the memory system is working" and "no fact has ever been injected" were
   * indistinguishable. The real data root emitted 7 such bundles and 0 facts.
   */
  | "context-only"
  | "no-match"
  | "skipped"
  | "error"
  | "deduped"
  | "no-session-provenance"
  /**
   * Issue #44: context was emitted but its durable `prepared` recall receipt
   * could not be marked emitted. The provenance contract
   * (RETRIEVAL-AND-CONTEXT.md §43-48) is broken for that emission. This used to
   * go to a hook's stderr, which Codex discards, so a contract violation was
   * unobservable — the real data root had 7 emitted bundles and 0 recall_events.
   */
  | "receipt-failed";
 project?: string;
 prompt_len?: number;
 candidates?: number;
 injected?: number;
 /** 세션 원장 dedup 으로 걸러진 fact 수 — 절감량이 로그로 상시 측정된다. */
 deduped?: number;
 /** 실제 주입된 블록 크기(자) — 토큰 비용 관측용 (~chars/3 tok). */
 chars?: number;
 duration_ms?: number;
 error?: string;
 /** Which execution path served this injection: warm MCP-server daemon, cold fallback, or the Continuity hook. */
 via?: "daemon" | "fallback" | "continuity";
 /** Phase 5 cheap gate outcome: why retrieval ran or was skipped. */
 gate?: string;
 /** Number of embedding model calls made for this prompt (0 on the skip path). */
 embedding_calls?: number;
 /** Memory Bundle sections emitted, in order. */
 sections?: string[];
 /** Issue #32: 'unavailable' means the literal-match lane threw for this prompt. */
 lexical_lane?: "ok" | "unavailable";
}

export function getInjectLogPath(): string {
 const dir = path.join(getIndexDir(), "logs");
 if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
 }
 return path.join(dir, "inject-context.jsonl");
}

/**
 * Append a single JSONL entry to the injection log.
 * Rotates to `.old` (replacing any previous rotation) when the log exceeds 5MB.
 * Never throws.
 */
export function appendInjectLog(entry: Omit<InjectLogEntry, "ts">): void {
 try {
  const logPath = getInjectLogPath();

  try {
   const stat = fs.statSync(logPath);
   if (stat.size > MAX_LOG_BYTES) {
    fs.renameSync(logPath, `${logPath}.old`);
   }
  } catch {
   // No existing log — nothing to rotate.
  }

  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(logPath, line + "\n");
 } catch {
  // Best-effort only: observability must not break injection.
 }
}
