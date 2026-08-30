import fs from "node:fs";
import readline from "node:readline";
import type Database from "better-sqlite3";
import { createArchiveReadStream } from "./archive-io.js";
import { SUMMARIZER_CONTEXT_MARKER } from "./constants.js";
import { isExcludedProject } from "./paths.js";
import { recordFactTombstone } from "./fact-management.js";

export const USER_EXCLUSION_MARKERS = [
  "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
  "Only use NO_INSIGHTS_FOUND",
  SUMMARIZER_CONTEXT_MARKER,
] as const;

/**
 * Tombstone reason written when a conversation-wide user exclusion purges
 * facts. This reason is terminal privacy state: sync import must never let a
 * newer peer edit resurrect an excluded fact, because no un-exclude or
 * re-consent event exists anywhere in the protocol.
 */
export const PRIVACY_TOMBSTONE_REASON = "source_conversation_excluded";

export type ConversationIneligibilityReason =
  | "subagent"
  | "excluded_project"
  | "user_excluded";

export type ConversationEligibility =
  | { eligible: true }
  | { eligible: false; reason: ConversationIneligibilityReason };

export interface ConversationEligibilityInput {
  filePath: string;
  project: string;
  isSubagent?: boolean;
  excludedProjects?: string[];
}

export interface ConversationPurgeResult {
  exchanges: number;
  facts: number;
  summaries: number;
}

/**
 * User exclusion applies only to user-role message payloads. Raw transcript
 * bytes, tool output, and assistant output can quote marker source text and
 * must never exclude a conversation by themselves.
 */
export async function isUserExcludedConversation(
  filePath: string,
): Promise<boolean> {
  let stream: ReturnType<typeof createArchiveReadStream>;
  try {
    stream = createArchiveReadStream(filePath);
  } catch {
    return false;
  }
  try {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: {
        type?: unknown;
        payload?: { type?: unknown; role?: unknown; content?: unknown };
      };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = rec?.payload;
      if (
        rec?.type !== "response_item" ||
        !payload ||
        payload.type !== "message" ||
        payload.role !== "user"
      ) {
        continue;
      }
      const text =
        typeof payload.content === "string"
          ? payload.content
          : Array.isArray(payload.content)
            ? (payload.content as Array<{ text?: unknown }>)
                .filter((part) => part && typeof part.text === "string")
                .map((part) => part.text as string)
                .join("\n")
            : "";
      if (USER_EXCLUSION_MARKERS.some((marker) => text.includes(marker))) {
        return true;
      }
    }
    return false;
  } catch {
    // Unreadable or undecidable input is not silently reclassified as a user
    // privacy instruction. The caller's normal parse/error path remains active.
    return false;
  } finally {
    stream.destroy();
  }
}

/** Single ingestion-policy decision shared by sync, index, repair, and summary. */
export async function getConversationEligibility(
  input: ConversationEligibilityInput,
): Promise<ConversationEligibility> {
  if (input.isSubagent) return { eligible: false, reason: "subagent" };
  if (isExcludedProject(input.project, input.excludedProjects)) {
    return { eligible: false, reason: "excluded_project" };
  }
  if (await isUserExcludedConversation(input.filePath)) {
    return { eligible: false, reason: "user_excluded" };
  }
  return { eligible: true };
}

function parseSourceIds(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Conversation-wide user exclusion purge. Source rollouts stay untouched and
 * their archive copy remains retained/rebuildable; searchable and model-derived
 * state is removed. Facts touching excluded evidence are removed as a whole
 * because a merged sentence cannot prove which words came from which source.
 */
export function purgeConversationFromIndex(
  db: Database.Database,
  input: { archivePath: string; sessionId?: string | null },
): ConversationPurgeResult {
  const rows = (
    input.sessionId
      ? db
          .prepare(
            "SELECT id FROM exchanges WHERE archive_path = ? OR session_id = ?",
          )
          .all(input.archivePath, input.sessionId)
      : db
          .prepare("SELECT id FROM exchanges WHERE archive_path = ?")
          .all(input.archivePath)
  ) as Array<{ id: string }>;
  const exchangeIds = new Set(rows.map((row) => row.id));

  const factIds = new Set<string>();
  if (exchangeIds.size > 0) {
    const facts = db
      .prepare("SELECT id, source_exchange_ids FROM facts")
      .all() as Array<{ id: string; source_exchange_ids: string | null }>;
    for (const fact of facts) {
      if (
        parseSourceIds(fact.source_exchange_ids).some((id) => exchangeIds.has(id))
      ) {
        factIds.add(fact.id);
      }
    }
    const revisions = db
      .prepare(
        "SELECT fact_id, source_exchange_id FROM fact_revisions WHERE source_exchange_id IS NOT NULL",
      )
      .all() as Array<{ fact_id: string; source_exchange_id: string }>;
    for (const revision of revisions) {
      if (exchangeIds.has(revision.source_exchange_id)) {
        factIds.add(revision.fact_id);
      }
    }
  }

  const purge = db.transaction(() => {
    const deleteRelation = db.prepare(
      "DELETE FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?",
    );
    const deleteFactVector = db.prepare("DELETE FROM vec_facts WHERE id = ?");
    const deleteFactVectorKr = db.prepare("DELETE FROM vec_facts_kr WHERE id = ?");
    const deleteRevisions = db.prepare(
      "DELETE FROM fact_revisions WHERE fact_id = ?",
    );
    const deleteFact = db.prepare("DELETE FROM facts WHERE id = ?");
    for (const factId of factIds) {
      recordFactTombstone(db, factId, PRIVACY_TOMBSTONE_REASON);
      deleteRelation.run(factId, factId);
      deleteFactVector.run(factId);
      deleteFactVectorKr.run(factId);
      deleteRevisions.run(factId);
      deleteFact.run(factId);
    }

    const deleteTools = db.prepare("DELETE FROM tool_calls WHERE exchange_id = ?");
    const deleteVector = db.prepare("DELETE FROM vec_exchanges WHERE id = ?");
    const deleteExchange = db.prepare("DELETE FROM exchanges WHERE id = ?");
    for (const exchangeId of exchangeIds) {
      deleteTools.run(exchangeId);
      deleteVector.run(exchangeId);
      deleteExchange.run(exchangeId);
    }
    // 재감사 P1-4(protocol v4): taxonomy는 fact에서 파생된 model-derived
    // 상태다 — LLM이 만든 domain/category description과 그 벡터는 제거된
    // private 증거에서 유래했을 수 있고, purge 계약("searchable and
    // model-derived state is removed")은 그 잔존을 허용하지 않는다. 전면
    // invalidate하고 남은 facts의 overlay를 끊는다; 분류 백필이 공개 facts만으로
    // taxonomy를 재구축한다(derived 상태이므로 재구축 가능).
    db.prepare("DELETE FROM vec_categories").run();
    db.prepare("DELETE FROM ontology_categories").run();
    db.prepare("DELETE FROM ontology_domains").run();
    db.prepare("UPDATE facts SET ontology_category_id = NULL").run();
    if (input.sessionId) {
      db.prepare("DELETE FROM extraction_log WHERE session_id = ?").run(
        input.sessionId,
      );
      db.prepare("DELETE FROM recall_events WHERE session_id = ?").run(
        input.sessionId,
      );
    }
  });
  purge.immediate();

  const summaryPath = input.archivePath.replace(
    /\.jsonl(?:\.zst)?$/,
    "-summary.txt",
  );
  let summaries = 0;
  for (const candidate of [summaryPath, `${summaryPath}.zst`]) {
    if (fs.existsSync(candidate)) {
      fs.unlinkSync(candidate);
      summaries++;
    }
  }

  return { exchanges: exchangeIds.size, facts: factIds.size, summaries };
}
