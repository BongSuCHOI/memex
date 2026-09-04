#!/usr/bin/env node
/**
 * MCP Server for Memex.
 *
 * This server provides tools to search and explore indexed Codex conversations
 * using semantic search, text search, and conversation display capabilities.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startInjectDaemon } from "./inject-daemon.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchConversations,
  searchMultipleConcepts,
  formatResults,
  formatMultiConceptResults,
  getKnowledgeContext,
  formatKnowledgeContext,
  type SearchOptions,
} from "./search.js";
import { formatConversationAsMarkdown } from "./show.js";
import { canonicalizeProjectPath } from "./project-identity.js";
import { initDatabase } from "./db.js";
import {
  searchFactsByScope,
  listFactsByScope,
  getRevisions,
  factMatchesScope,
  rowToFact,
  type FactSearchScope,
} from "./fact-db.js";
import {
  CHRONICLE_LANE_LABELS,
  currentFactRevision,
  formatChronicleEvent,
  isSemanticSubjectKey,
  listIncidentOccurrences,
  matchIncidentPatterns,
  readChronicleTimeline,
} from "./chronicle.js";
import { generateEmbedding, initEmbeddings } from "./embeddings.js";
import {
  getOntologyTree,
  listDomains,
  listCategories,
  getRelatedFacts,
} from "./ontology-db.js";
import { askAvatar } from "./avatar-responder.js";
import path from "path";
import fs from "fs";
import { readArchiveFile, resolveArchiveFile } from "./archive-io.js";
import { getArchiveDir, getSessionsRoot } from "./paths.js";
import { readHotEvidence } from "./continuity-identity.js";

// Zod Schemas for Input Validation

const SearchModeEnum = z.enum(["vector", "text", "both"]);
const ResponseFormatEnum = z.enum(["markdown", "json"]);
const ContinuityScopeEnum = z.enum(["project", "workspace", "workstream", "session", "global", "all"]);

const SearchInputSchema = z
  .object({
    query: z
      .union([
        z
          .string()
          .min(2, "Query must be at least 2 characters")
          .max(10000, "Query too long (max 10000 chars)"),
        z
          .array(z.string().min(2).max(10000))
          .min(2, "Must provide at least 2 concepts for multi-concept search")
          .max(5, "Cannot search more than 5 concepts at once"),
      ])
      .describe(
        "Search query - string for single concept, array of strings for multi-concept AND search",
      ),
    mode: SearchModeEnum.default("both").describe(
      'Search mode: "vector" for semantic similarity, "text" for exact matching, "both" for combined (default: "both"). Only used for single-concept searches.',
    ),
    project: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Canonical absolute Codex thread cwd. When provided, RAG knowledge-context facts are scoped to this project + global; without it, no fact context is attached implicitly.",
      ),
    project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workspace_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workstream_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    session_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    scope: ContinuityScopeEnum.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of results to return (default: 10)"),
    after: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
      .optional()
      .describe(
        "Only return conversations after this date (YYYY-MM-DD format)",
      ),
    before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
      .optional()
      .describe(
        "Only return conversations before this date (YYYY-MM-DD format)",
      ),
    response_format: ResponseFormatEnum.default("markdown").describe(
      'Output format: "markdown" for human-readable or "json" for machine-readable (default: "markdown")',
    ),
  })
  .strict();

const ShowConversationInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "Path is required")
      .describe("Absolute path to the JSONL conversation file to display"),
    startLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Starting line number (1-indexed, inclusive). Omit to start from beginning.",
      ),
    endLine: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Ending line number (1-indexed, inclusive). Omit to read to end.",
      ),
  })
  .strict();

const SearchFactsInputSchema = z
  .object({
    query: z
      .string()
      .min(2, "Query must be at least 2 characters")
      .max(10000, "Query too long (max 10000 chars)"),
    project: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Legacy canonical cwd compatibility key for project scope; prefer project_id",
      ),
    project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workspace_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workstream_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    session_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    scope: ContinuityScopeEnum.optional().describe(
      'Explicit project/workspace/workstream/session/global/all scope. Project accepts project_id or legacy canonical path.',
    ),
    include_hot_evidence: z.boolean().default(false),
    hot_before: z.string().datetime().optional(),
    hot_before_evidence_id: z.string().max(128).optional(),
    category: z
      .enum(["decision", "preference", "pattern", "knowledge", "constraint"])
      .optional(),
    include_revisions: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

const SearchOntologyInputSchema = z
  .object({
    domain: z
      .string()
      .optional()
      .describe("Filter by domain name (case-insensitive partial match)"),
    category: z
      .string()
      .optional()
      .describe("Filter by category name (case-insensitive partial match)"),
    include_relations: z
      .boolean()
      .default(false)
      .describe("Include 1-hop fact relations"),
    project: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Canonical absolute Codex thread cwd (required unless scope is global/all)",
      ),
    project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workspace_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workstream_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    session_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    scope: ContinuityScopeEnum.optional().describe(
      'Explicit project/workspace/workstream/session/global/all scope',
    ),
  })
  .strict();

type SearchOntologyInput = z.infer<typeof SearchOntologyInputSchema>;

const AskAvatarInputSchema = z
  .object({
    question: z
      .string()
      .min(2, "Question must be at least 2 characters")
      .max(10000, "Question too long (max 10000 chars)")
      .describe("Question to ask"),
    project: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Canonical absolute Codex thread cwd (required unless scope is global/all)",
      ),
    project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workspace_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
    workstream_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    session_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
    scope: ContinuityScopeEnum.optional().describe(
      'Explicit project/workspace/workstream/session/global/all scope',
    ),
  })
  .strict();

type AskAvatarInput = z.infer<typeof AskAvatarInputSchema>;

// ── CX-03: explicit active-project scope contract ───────────────────────────
// Project-sensitive tools never fall back to process.cwd(): the MCP server
// runs with the plugin root as cwd, so an omitted project would silently mix
// plugin-root facts into the user's project. The caller must pass the
// canonical absolute Codex thread cwd, or an explicit global/all scope.

type StableResolvedScope = {
  factScope: FactSearchScope;
  scope: "project" | "workspace" | "workstream" | "session" | "global" | "all";
  projectId: string | null;
  workspaceId: string | null;
  workstreamId: string | null;
  sessionId: string | null;
  legacyProject: string | null;
  label: string;
};

function resolveStableScope(
  db: ReturnType<typeof initDatabase>,
  raw: {
    project?: string;
    project_id?: string;
    workspace_id?: string;
    workstream_id?: string;
    session_id?: string;
    scope?: "project" | "workspace" | "workstream" | "session" | "global" | "all";
  },
  tool: string,
): StableResolvedScope {
  const scope = raw.scope ?? "project";
  if (scope === "global" || scope === "all") {
    if (raw.project || raw.project_id || raw.workspace_id || raw.workstream_id || raw.session_id) {
      throw new Error(`${tool}: ${scope} scope cannot be combined with project/workspace/workstream/session identity`);
    }
    return {
      factScope: scope === "global" ? { type: "global" } : { type: "all" },
      scope,
      projectId: null,
      workspaceId: null,
      workstreamId: null,
      sessionId: null,
      legacyProject: null,
      label: scope,
    };
  }
  if (scope !== "project" && raw.project) {
    throw new Error(`${tool}: legacy project path cannot be combined with ${scope} scope; use stable IDs`);
  }
  if (scope === "session") {
    if (!raw.session_id) throw new Error(`${tool}: session_id is required for session scope`);
    const row = db.prepare(`
      SELECT project_id, workspace_id, workstream_id, project
      FROM session_memory_state WHERE session_id = ?
    `).get(raw.session_id) as { project_id: string; workspace_id: string | null; workstream_id: string; project: string } | undefined;
    if (!row?.project_id) throw new Error(`${tool}: unknown session_id`);
    if (raw.project_id && raw.project_id !== row.project_id) throw new Error(`${tool}: session_id is outside project_id`);
    if (raw.workspace_id && raw.workspace_id !== row.workspace_id) throw new Error(`${tool}: session_id is outside workspace_id`);
    if (raw.workstream_id && raw.workstream_id !== row.workstream_id) throw new Error(`${tool}: session_id is outside workstream_id`);
    return { factScope: { type: "session-id", projectId: row.project_id, sessionId: raw.session_id }, scope, projectId: row.project_id, workspaceId: row.workspace_id, workstreamId: row.workstream_id, sessionId: raw.session_id, legacyProject: row.project, label: `session:${raw.session_id}` };
  }
  if (scope === "workstream") {
    if (!raw.workstream_id) throw new Error(`${tool}: workstream_id is required for workstream scope`);
    const row = db.prepare(`
      SELECT project_id, workspace_id, project FROM minimal_workstreams WHERE workstream_id = ?
    `).get(raw.workstream_id) as { project_id: string; workspace_id: string | null; project: string } | undefined;
    if (!row?.project_id) throw new Error(`${tool}: unknown workstream_id`);
    if (raw.project_id && raw.project_id !== row.project_id) throw new Error(`${tool}: workstream_id is outside project_id`);
    if (raw.workspace_id && raw.workspace_id !== row.workspace_id) throw new Error(`${tool}: workstream_id is outside workspace_id`);
    if (raw.session_id && !db.prepare(`
      SELECT 1 FROM workstream_sessions WHERE session_id = ? AND workstream_id = ?
    `).get(raw.session_id, raw.workstream_id)) throw new Error(`${tool}: session_id is outside workstream_id`);
    return { factScope: { type: "workstream-id", projectId: row.project_id, workspaceId: row.workspace_id, workstreamId: raw.workstream_id }, scope, projectId: row.project_id, workspaceId: row.workspace_id, workstreamId: raw.workstream_id, sessionId: null, legacyProject: row.project, label: `workstream:${raw.workstream_id}` };
  }
  if (scope === "workspace") {
    if (!raw.workspace_id) throw new Error(`${tool}: workspace_id is required for workspace scope`);
    const row = db.prepare(`
      SELECT project_id, canonical_path FROM workspaces WHERE workspace_id = ?
    `).get(raw.workspace_id) as { project_id: string; canonical_path: string } | undefined;
    if (!row) throw new Error(`${tool}: unknown workspace_id`);
    if (raw.project_id && raw.project_id !== row.project_id) throw new Error(`${tool}: workspace_id is outside project_id`);
    if (raw.workstream_id && !db.prepare(`
      SELECT 1 FROM minimal_workstreams WHERE workstream_id = ? AND workspace_id = ?
    `).get(raw.workstream_id, raw.workspace_id)) throw new Error(`${tool}: workstream_id is outside workspace_id`);
    if (raw.session_id && !db.prepare(`
      SELECT 1 FROM session_memory_state WHERE session_id = ? AND workspace_id = ?
    `).get(raw.session_id, raw.workspace_id)) throw new Error(`${tool}: session_id is outside workspace_id`);
    return { factScope: { type: "workspace-id", projectId: row.project_id, workspaceId: raw.workspace_id }, scope, projectId: row.project_id, workspaceId: raw.workspace_id, workstreamId: null, sessionId: null, legacyProject: row.canonical_path, label: `workspace:${raw.workspace_id}` };
  }
  let projectId = raw.project_id ?? null;
  let legacyProject: string | null = null;
  if (projectId) {
    if (raw.project?.trim()) {
      throw new Error(`${tool}: choose project_id or legacy project path, not both`);
    }
    const workspace = db.prepare(`
      SELECT canonical_path FROM workspaces WHERE project_id = ? ORDER BY last_seen_at DESC LIMIT 1
    `).get(projectId) as { canonical_path: string } | undefined;
    if (!db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(projectId)) {
      throw new Error(`${tool}: unknown project_id`);
    }
    legacyProject = workspace?.canonical_path ?? null;
  } else if (raw.project?.trim()) {
    legacyProject = canonicalizeProjectPath(raw.project);
    const known = db.prepare(`
      SELECT project_id FROM workspaces WHERE canonical_path = ?
      ORDER BY last_seen_at DESC, workspace_id LIMIT 1
    `).get(legacyProject) as { project_id: string } | undefined;
    if (!known) {
      return {
        factScope: { type: "project", project: legacyProject },
        scope,
        projectId: null,
        workspaceId: null,
        workstreamId: null,
        sessionId: null,
        legacyProject,
        label: `legacy-project:${legacyProject}`,
      };
    }
    projectId = known.project_id;
  } else {
    throw new Error(`${tool}: project is required for project scope; provide project_id or canonical absolute project path`);
  }
  if (raw.workspace_id && !db.prepare("SELECT 1 FROM workspaces WHERE workspace_id = ? AND project_id = ?").get(raw.workspace_id, projectId)) {
    throw new Error(`${tool}: workspace_id is outside project_id`);
  }
  if (raw.workstream_id && !db.prepare("SELECT 1 FROM minimal_workstreams WHERE workstream_id = ? AND project_id = ?").get(raw.workstream_id, projectId)) {
    throw new Error(`${tool}: workstream_id is outside project_id`);
  }
  if (raw.session_id && !db.prepare("SELECT 1 FROM session_memory_state WHERE session_id = ? AND project_id = ?").get(raw.session_id, projectId)) {
    throw new Error(`${tool}: session_id is outside project_id`);
  }
  return { factScope: { type: "project-id", projectId }, scope, projectId, workspaceId: null, workstreamId: null, sessionId: null, legacyProject, label: `project:${projectId}` };
}

// Error Handling Utility

function handleError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

// Create MCP Server

const server = new Server(
  {
    name: "memex",
    version: "0.4.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Register Tools. Export the exact discovery contract so tests and docs can
// verify that the published JSON Schema matches the handler validation.
export function getToolDefinitions() {
  return [
    {
      name: "search",
      description: `Search raw conversation evidence across sessions with optional explicit project/workspace/workstream/session scope. Single string performs semantic/text search; an array of 2-5 concepts performs precise AND matching. Stable IDs are preferred and process cwd is never inferred.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            oneOf: [
              { type: "string", minLength: 2, maxLength: 10000 },
              {
                type: "array",
                items: { type: "string", minLength: 2, maxLength: 10000 },
                minItems: 2,
                maxItems: 5,
              },
            ],
          },
          mode: {
            type: "string",
            enum: ["vector", "text", "both"],
            default: "both",
          },
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Canonical absolute cwd. When set, attached RAG fact context is scoped to this project + global.",
          },
          project_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workspace_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workstream_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          session_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          scope: {
            type: "string",
            enum: ["project", "workspace", "workstream", "session", "global", "all"],
          },
          limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
          after: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          before: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          response_format: {
            type: "string",
            enum: ["markdown", "json"],
            default: "markdown",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        title: "Search Episodic Memory",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "read",
      description: `Read full conversations to extract detailed context after finding relevant results with search. Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Use startLine/endLine pagination for large conversations to avoid context bloat (line numbers are 1-indexed).`,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          startLine: { type: "number", minimum: 1 },
          endLine: { type: "number", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: {
        title: "Show Full Conversation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "search_facts",
      description:
        "Search extracted facts with explicit project/workspace/workstream/session/global/all scope. Optionally returns separately labeled recent Hot Evidence.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 2,
            maxLength: 10000,
            description: "Search query for facts",
          },
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Canonical absolute Codex thread cwd. Required unless scope is global/all.",
          },
          project_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workspace_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workstream_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          session_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          scope: {
            type: "string",
            enum: ["project", "workspace", "workstream", "session", "global", "all"],
            description:
              'Explicit project/workspace/workstream/session/global/all scope; the matching stable ID is required except for global/all.',
          },
          category: {
            type: "string",
            enum: [
              "decision",
              "preference",
              "pattern",
              "knowledge",
              "constraint",
            ],
            description: "Filter by fact category",
          },
          include_revisions: {
            type: "boolean",
            description: "Include revision history",
            default: false,
          },
          include_hot_evidence: {
            type: "boolean",
            description: "Include recent authoritative raw evidence with a NOT YET DISTILLED label",
            default: false,
          },
          hot_before: { type: "string", format: "date-time" },
          hot_before_evidence_id: { type: "string", maxLength: 128 },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 50,
            default: 10,
            description: "Max results",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        title: "Search Facts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "search_ontology",
      description:
        "Browse the ontology hierarchy (Domain > Category > Facts). Use to understand how past decisions are organized, or to find all facts in a specific domain/category.",
      inputSchema: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Filter by domain name (partial, case-insensitive)",
          },
          category: {
            type: "string",
            description: "Filter by category name (partial, case-insensitive)",
          },
          include_relations: {
            type: "boolean",
            default: false,
            description: "Include 1-hop relations for each fact",
          },
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Canonical absolute Codex thread cwd. Required unless scope is global/all.",
          },
          project_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workspace_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workstream_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          session_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          scope: {
            type: "string",
            enum: ["project", "workspace", "workstream", "session", "global", "all"],
            description:
              "Explicit stable scope; project may use a legacy canonical path.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Search Ontology",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "ask_avatar",
      description:
        "Ask the user's technical alter ego a question. Returns an answer grounded in past decisions and preferences, with cited sources and confidence level.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            minLength: 2,
            maxLength: 10000,
            description: "Question to ask",
          },
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Legacy canonical cwd compatibility key for project scope; prefer project_id.",
          },
          project_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workspace_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workstream_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          session_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          scope: {
            type: "string",
            enum: ["project", "workspace", "workstream", "session", "global", "all"],
            description:
              "Explicit stable scope; project may use a legacy canonical path.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      annotations: {
        title: "Ask Avatar",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "trace_fact",
      description:
        "Deep memory path: trace a current fact (by query, fact_id, or subject_key) to its Chronicle timeline (ASSERTED/CHANGED/RETIRED/RESTORED/VALIDATED/INCIDENT/CONTRADICTED), previous values and rollbacks, source-cited causes versus classifier notes, incident occurrences, and authoritative source conversations with separately labeled non-authoritative context. History is bounded and cursor-paginated.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 2,
            maxLength: 10000,
            description: "Search query to find the fact to trace (optional when fact_id or subject_key is given)",
          },
          fact_id: {
            type: "string",
            pattern: "^[0-9a-fA-F-]{36}$",
            description: "Exact fact UUID to trace",
          },
          subject_key: {
            type: "string",
            pattern: "^[a-z0-9_.]{3,200}$",
            description: "Stable subject slot to trace (e.g. state.runtime.session_store)",
          },
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Legacy canonical cwd compatibility key for project scope; prefer project_id.",
          },
          project_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workspace_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workstream_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          session_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          scope: {
            type: "string",
            enum: ["project", "workspace", "workstream", "session", "global", "all"],
            description:
              'Explicit project/workspace/workstream/session/global/all scope; the matching stable ID is required except for global/all.',
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 10,
            default: 3,
            description: "Max facts to trace",
          },
          include_timeline: { type: "boolean", default: true, description: "Include the Chronicle timeline" },
          timeline_limit: { type: "number", minimum: 1, maximum: 50, default: 10, description: "Events per page" },
          timeline_cursor: { type: "string", maxLength: 512, description: "Keyset cursor from a previous page" },
          timeline_order: { type: "string", enum: ["asc", "desc"], default: "asc", description: "Effective-time order" },
          include_incidents: { type: "boolean", default: true, description: "Include incident occurrences and matching patterns" },
          include_sources: { type: "boolean", default: true, description: "Include raw source evidence for each event" },
          include_hot_evidence: { type: "boolean", default: false, description: "Append recent not-yet-distilled evidence for the scope" },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Trace Fact Provenance and Chronicle",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "graph_stats",
      description:
        "Get knowledge graph statistics: total facts, domains, categories, relations, and top domains by fact count. Useful for understanding what knowledge has been accumulated.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Canonical absolute Codex thread cwd. Required unless scope is global/all.",
          },
          project_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workspace_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workstream_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          session_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          scope: {
            type: "string",
            enum: ["project", "workspace", "workstream", "session", "global", "all"],
            description:
              "Explicit stable scope; project may use a legacy canonical path.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Knowledge Graph Stats",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "cross_project_insights",
      description:
        "Find similar decisions and patterns from OTHER projects. Useful for knowledge transfer — see how similar problems were solved in different projects.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 2,
            maxLength: 10000,
            description: "Topic or decision to find cross-project insights for",
          },
          current_project: {
            type: "string",
            maxLength: 500,
            description:
              "Canonical absolute Codex thread cwd to exclude. Required unless current_project_id is provided.",
          },
          current_project_id: {
            type: "string",
            pattern: "^[A-Za-z0-9_-]{8,128}$",
            description: "Stable logical project ID to exclude. Required unless current_project is provided.",
          },
          scope: {
            type: "string",
            enum: ["project"],
            description:
              "cross_project_insights excludes the explicit current project identity.",
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Max results",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        title: "Cross-Project Insights",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "explore_graph",
      description:
        "Explore the knowledge graph starting from a fact or topic. Performs multi-hop traversal to discover indirectly connected knowledge, patterns, and decision chains.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 2,
            maxLength: 10000,
            description: "Starting topic or fact to explore from",
          },
          hops: {
            type: "number",
            minimum: 1,
            maximum: 3,
            default: 2,
            description: "Graph traversal depth (1-3 hops)",
          },
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Canonical absolute Codex thread cwd. Required unless scope is global/all.",
          },
          project_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workspace_id: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          workstream_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          session_id: { type: "string", pattern: "^[A-Za-z0-9_-]{4,128}$" },
          scope: {
            type: "string",
            enum: ["project", "workspace", "workstream", "session", "global", "all"],
            description:
              "Explicit stable scope; project may use a legacy canonical path.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        title: "Explore Knowledge Graph",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ];
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: getToolDefinitions() };
});

// Handle Tool Calls

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleToolCall(name, args ?? {});
});

/**
 * CX-03: exported so isolated tests can drive the exact tool surface without
 * a stdio transport. Mirrors the protocol handler one-for-one.
 */
export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  try {
    if (name === "search") {
      const params = SearchInputSchema.parse(args);
      let resultText: string;
      let identityScope: SearchOptions["identityScope"];
      let legacyProjectScope = params.project;
      const hasExplicitIdentity = !!(
        params.scope || params.project_id || params.workspace_id ||
        params.workstream_id || params.session_id
      );
      if (hasExplicitIdentity) {
        const identityDb = initDatabase();
        try {
          const resolved = resolveStableScope(identityDb, params, "search");
          legacyProjectScope = resolved.scope === "project" && !resolved.projectId
            ? resolved.legacyProject ?? undefined
            : undefined;
          if (resolved.scope === "project" && resolved.projectId) {
            identityScope = { type: "project", projectId: resolved.projectId };
          } else if (resolved.scope === "workspace" && resolved.workspaceId) {
            identityScope = { type: "workspace", workspaceId: resolved.workspaceId };
          } else if (resolved.scope === "workstream" && resolved.workstreamId) {
            identityScope = { type: "workstream", workstreamId: resolved.workstreamId };
          } else if (resolved.scope === "session" && resolved.sessionId) {
            identityScope = { type: "session", sessionId: resolved.sessionId };
          } else if (resolved.scope === "global") {
            return { content: [{ type: "text", text: "No conversation evidence exists in global fact scope." }] };
          }
        } finally {
          identityDb.close();
        }
      }

      // Check if query is array (multi-concept) or string (single-concept)
      if (Array.isArray(params.query)) {
        // Multi-concept search
        const options = {
          limit: params.limit,
          after: params.after,
          before: params.before,
          project: legacyProjectScope,
          identityScope,
        };

        const results = await searchMultipleConcepts(params.query, options);

        if (params.response_format === "json") {
          resultText = JSON.stringify(
            {
              results: results,
              count: results.length,
              concepts: params.query,
            },
            null,
            2,
          );
        } else {
          resultText = await formatMultiConceptResults(results, params.query);
        }
      } else {
        // Single-concept search
        const options: SearchOptions = {
          mode: params.mode,
          limit: params.limit,
          after: params.after,
          before: params.before,
          project: legacyProjectScope,
          identityScope,
        };

        const results = await searchConversations(params.query, options);

        if (params.response_format === "json") {
          resultText = JSON.stringify(
            {
              results: results.map((r) => ({
                exchange: r.exchange,
                similarity: r.similarity,
                snippet: r.snippet,
              })),
              count: results.length,
              mode: params.mode,
            },
            null,
            2,
          );
        } else {
          resultText = await formatResults(results);

          // Append knowledge graph context for markdown format.
          // CX-11/F5: never attach all-project facts implicitly — only when
          // the caller scoped the search with an explicit project.
          try {
            if (params.project) {
              const knowledgeCtx = await getKnowledgeContext(
                params.query,
                params.project,
                3,
              );
              resultText += formatKnowledgeContext(knowledgeCtx);
            }
          } catch {
            // Knowledge context is best-effort, don't fail the search
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: resultText,
          },
        ],
      };
    }

    if (name === "read") {
      const params = ShowConversationInputSchema.parse(args);

      // Validate path: must be absolute and a .jsonl file (optionally .zst-compressed)
      const resolvedPath = path.resolve(params.path);
      if (
        !resolvedPath.endsWith(".jsonl") &&
        !resolvedPath.endsWith(".jsonl.zst")
      ) {
        throw new Error(`Invalid file type: only .jsonl files are supported`);
      }

      // Verify file exists (plain or compressed variant)
      const resolvedFile = resolveArchiveFile(resolvedPath);
      if (!resolvedFile) {
        throw new Error(`File not found: ${resolvedPath}`);
      }

      // Confine reads to conversation storage roots — this tool must not be
      // usable as an arbitrary-file reader (prompt-injected paths like
      // /tmp/secret.jsonl would otherwise be readable).
      const realFile = fs.realpathSync(resolvedFile);
      const allowedRoots = [getArchiveDir(), getSessionsRoot()].map((root) => {
        try {
          return fs.realpathSync(root);
        } catch {
          return path.resolve(root);
        }
      });
      const isAllowed = allowedRoots.some(
        (root) => realFile === root || realFile.startsWith(root + path.sep),
      );
      if (!isAllowed) {
        throw new Error(
          "Access denied: path is outside the conversation archive",
        );
      }

      // Read and format conversation with optional line range
      const jsonlContent = readArchiveFile(realFile);
      const markdownContent = formatConversationAsMarkdown(
        jsonlContent,
        params.startLine,
        params.endLine,
      );

      return {
        content: [
          {
            type: "text",
            text: markdownContent,
          },
        ],
      };
    }

    if (name === "search_facts") {
      const params = SearchFactsInputSchema.parse(args);

      await initEmbeddings();
      const db = initDatabase();
      try {
        // Stable identity is resolved from explicit IDs or a caller-supplied
        // compatibility path. MCP process cwd is never consulted.
        const scopeInfo = resolveStableScope(db, params, "search_facts");
        const queryEmbedding = await generateEmbedding(params.query, "query");
        const results = searchFactsByScope(
          db,
          queryEmbedding,
          scopeInfo.factScope,
          params.limit,
          0.85,
          { category: params.category },
        );
        const scopeLabel = scopeInfo.label;
        let output = `# Facts Search Results\n\nQuery: "${params.query}"\nScope: ${scopeLabel}\nResults: ${results.length}\n\n`;

        if (results.length === 0) {
          output += "_No matching facts found._\n";
        }

        // Build ontology lookup
        const allDomains = listDomains(db);
        const allCategories = listCategories(db);
        const domainMap = new Map(allDomains.map((d) => [d.id, d.name]));
        const catMap = new Map(
          allCategories.map((c) => [
            c.id,
            { name: c.name, domainId: c.domain_id },
          ]),
        );

        for (const { fact, distance } of results) {
          const similarity = (1 - (distance * distance) / 2).toFixed(3);
          const catInfo = fact.ontology_category_id
            ? catMap.get(fact.ontology_category_id)
            : undefined;
          const domainName = catInfo
            ? (domainMap.get(catInfo.domainId) ?? "")
            : "";
          const catName = catInfo ? catInfo.name : "";

          output += `## [${fact.category}] ${fact.fact}\n`;
          output += `- Scope: ${fact.scope_type}${fact.scope_project ? ` (${fact.scope_project})` : ""}\n`;
          output += `- Confirmed: ${fact.consolidated_count}x | Similarity: ${similarity}\n`;
          if (domainName) output += `- Ontology: ${domainName}/${catName}\n`;
          output += `- Created: ${fact.created_at}\n`;

          if (params.include_revisions) {
            const revisions = getRevisions(db, fact.id);
            if (revisions.length > 0) {
              output += "- Chronicle (use trace_fact for grounded cause vs classifier note):\n";
              for (const rev of revisions) {
                output += `  - ${rev.event_kind ?? "CHANGED"} effective ${rev.effective_at ?? rev.created_at}: "${rev.previous_fact}" → "${rev.new_fact}"${rev.reason ? ` (note: ${rev.reason})` : ""}\n`;
              }
            }
          }

          // Show graph relations for this fact
          const related = getRelatedFacts(
            db,
            fact.id,
            1,
            0.6,
            0.2,
            scopeInfo.legacyProject,
            scopeInfo.scope === "global" || scopeInfo.scope === "all" ? scopeInfo.scope : "project",
          );
          if (related.length > 0) {
            output += `- Related:\n`;
            for (const { fact: relFact, relation } of related) {
              output += `  - [${relation.relation_type}] ${relFact.fact}\n`;
            }
          }

          output += "\n";
        }
        if (params.include_hot_evidence && scopeInfo.projectId) {
          const hot = readHotEvidence(db, {
            projectId: scopeInfo.projectId,
            workspaceId: scopeInfo.scope === "workspace" ? scopeInfo.workspaceId : null,
            workstreamId: scopeInfo.scope === "workstream" ? scopeInfo.workstreamId : null,
            sessionId: scopeInfo.scope === "session" ? scopeInfo.sessionId : null,
            beforeCreatedAt: params.hot_before ?? null,
            beforeEvidenceId: params.hot_before_evidence_id ?? null,
            limit: params.limit,
          });
          output += `\n## Recent Evidence — NOT YET DISTILLED (${hot.length})\n\n`;
          output += hot.map((item) =>
            `- [${item.source_type}] ${item.evidence_text}\n  - Cursor: ${item.created_at} / ${item.evidence_id}`,
          ).join("\n") || "_No recent evidence._";
          output += "\n";
        }

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === "search_ontology") {
      const params = SearchOntologyInputSchema.parse(
        args,
      ) as SearchOntologyInput;

      try {
        const db = initDatabase();
        const scopeInfo = resolveStableScope(db, params, "search_ontology");
        const tree = getOntologyTree(
          db,
          scopeInfo.legacyProject,
          scopeInfo.scope === "global" || scopeInfo.scope === "all" ? scopeInfo.scope : "project",
          scopeInfo.factScope,
        );

        // Apply domain/category filters
        const domainFilter = params.domain?.toLowerCase();
        const categoryFilter = params.category?.toLowerCase();

        const filtered = tree.filter((entry) => {
          if (
            domainFilter &&
            !entry.domain.name.toLowerCase().includes(domainFilter)
          )
            return false;
          return true;
        });

        let output = `# Ontology Tree\n\n`;

        if (filtered.length === 0) {
          output +=
            "_No ontology data found. Facts are classified automatically as they are extracted._\n";
        }

        for (const { domain, categories } of filtered) {
          output += `## ${domain.name}\n`;
          if (domain.description) output += `> ${domain.description}\n`;
          output += "\n";

          const filteredCategories = categories.filter(({ category }) => {
            if (
              categoryFilter &&
              !category.name.toLowerCase().includes(categoryFilter)
            )
              return false;
            return true;
          });

          if (filteredCategories.length === 0) {
            output += "_No matching categories._\n\n";
            continue;
          }

          for (const { category, facts } of filteredCategories) {
            output += `### ${category.name}`;
            if (category.description) output += ` — ${category.description}`;
            output += `\n(${facts.length} facts)\n\n`;

            for (const fact of facts) {
              output += `- **[${fact.category}]** ${fact.fact}\n`;
              output += `  - ID: ${fact.id} | Confirmed: ${fact.consolidated_count}x | ${fact.created_at.slice(0, 10)}\n`;

              if (params.include_relations) {
                const related = getRelatedFacts(
                  db,
                  fact.id,
                  1,
                  0.6,
                  0.2,
                  scopeInfo.legacyProject,
                  scopeInfo.scope === "global" || scopeInfo.scope === "all" ? scopeInfo.scope : "project",
                  scopeInfo.factScope,
                );
                if (related.length > 0) {
                  for (const { fact: relFact, relation } of related) {
                    output += `  - ↔ [${relation.relation_type}] "${relFact.fact}"\n`;
                  }
                }
              }
            }
            output += "\n";
          }
        }

        db.close();
        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error) }],
          isError: true,
        };
      }
    }

    if (name === "ask_avatar") {
      const params = AskAvatarInputSchema.parse(args) as AskAvatarInput;

      try {
        const db = initDatabase();
        const avatarScope = resolveStableScope(db, params, "ask_avatar");
        const result = await askAvatar(
          db,
          params.question,
          avatarScope.legacyProject ?? undefined,
          avatarScope.scope === "global" || avatarScope.scope === "all" ? avatarScope.scope : "project",
          avatarScope.factScope,
        );
        db.close();

        const confidenceLabel =
          result.confidence >= 0.9
            ? "HIGH"
            : result.confidence >= 0.7
              ? "MEDIUM"
              : result.confidence >= 0.5
                ? "LOW"
                : "INSUFFICIENT";

        let output = `# Avatar Response\n\n`;
        output += `**Question:** ${params.question}\n\n`;
        output += `**Answer:** ${result.answer}\n\n`;
        output += `**Confidence:** ${(result.confidence * 100).toFixed(0)}% (${confidenceLabel})\n\n`;

        if (result.sources.length > 0) {
          output += `## Supporting Decisions\n\n`;
          for (const source of result.sources) {
            output += `- **[${source.domain}/${source.category}]** ${source.fact.fact}\n`;
            output += `  - Relevance: ${(source.relevance * 100).toFixed(0)}% | Date: ${source.fact.created_at.slice(0, 10)}\n`;
          }
          output += "\n";
        }

        if (result.relatedDecisions.length > 0) {
          output += `## Related Decisions\n\n`;
          for (const { fact, relation } of result.relatedDecisions) {
            output += `- **[${relation}]** ${fact.fact} _(${fact.created_at.slice(0, 10)})_\n`;
          }
        }

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error) }],
          isError: true,
        };
      }
    }

    if (name === "trace_fact") {
      const params = z
        .object({
          query: z.string().min(2).max(10000).optional(),
          fact_id: z.string().regex(/^[0-9a-fA-F-]{36}$/).optional(),
          subject_key: z.string().regex(/^[a-z0-9_.]{3,200}$/).optional(),
          project: z.string().max(500).optional(),
          project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
          workspace_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
          workstream_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
          session_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
          scope: ContinuityScopeEnum.optional(),
          limit: z.number().int().min(1).max(10).default(3),
          include_timeline: z.boolean().default(true),
          timeline_limit: z.number().int().min(1).max(50).default(10),
          timeline_cursor: z.string().max(512).optional(),
          timeline_order: z.enum(["asc", "desc"]).default("asc"),
          include_incidents: z.boolean().default(true),
          include_sources: z.boolean().default(true),
          include_hot_evidence: z.boolean().default(false),
        })
        .strict()
        .parse(args);
      if (!params.query && !params.fact_id && !params.subject_key) {
        return {
          content: [{ type: "text", text: "trace_fact: provide query, fact_id, or subject_key" }],
          isError: true,
        };
      }

      const db = initDatabase();

      try {
        const traceScope = resolveStableScope(db, params, "trace_fact");
        type Traced = { fact: ReturnType<typeof rowToFact>; distance: number | null };
        let results: Traced[] = [];
        if (params.fact_id) {
          const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(params.fact_id) as Record<string, unknown> | undefined;
          if (!row) {
            return { content: [{ type: "text", text: `trace_fact: fact ${params.fact_id} not found` }] };
          }
          const fact = rowToFact(row);
          if (!factMatchesScope(db, fact, traceScope.factScope)) {
            return { content: [{ type: "text", text: `trace_fact: fact ${params.fact_id} is outside ${traceScope.label}` }], isError: true };
          }
          results = [{ fact, distance: null }];
        } else if (params.subject_key) {
          const rows = db.prepare(`
            SELECT * FROM facts WHERE subject_key = ? ORDER BY is_active DESC, updated_at DESC LIMIT 50
          `).all(params.subject_key) as Array<Record<string, unknown>>;
          results = rows.map(rowToFact)
            .filter((fact) => factMatchesScope(db, fact, traceScope.factScope))
            .slice(0, params.limit)
            .map((fact) => ({ fact, distance: null }));
        } else {
          await initEmbeddings();
          const queryEmbedding = await generateEmbedding(params.query as string, "query");
          results = searchFactsByScope(
            db,
            queryEmbedding,
            traceScope.factScope,
            params.limit,
            0.5,
          ).map(({ fact, distance }) => ({ fact, distance }));
        }

        let output = `# Fact Provenance Trace\n\nScope: ${traceScope.label}${params.query ? `\nQuery: "${params.query}"` : ""}${params.subject_key ? `\nSubject: ${params.subject_key}` : ""}\n\n`;
        output += `_Lanes: ${CHRONICLE_LANE_LABELS.currentFact} is authoritative current truth; ${CHRONICLE_LANE_LABELS.event} is append-only history; ${CHRONICLE_LANE_LABELS.rawEvidence} is source; ${CHRONICLE_LANE_LABELS.assistantContext} and ${CHRONICLE_LANE_LABELS.hotEvidence} are not fact authority._\n\n`;

        if (results.length === 0) {
          if (params.subject_key && traceScope.projectId && params.include_timeline) {
            // No current fact occupies the slot; the slot may still have history.
            const page = readChronicleTimeline(db, {
              projectId: traceScope.projectId,
              subjectKey: params.subject_key,
              workspaceId: traceScope.scope === "workspace" || traceScope.scope === "workstream" ? traceScope.workspaceId : null,
              workstreamId: traceScope.scope === "workstream" ? traceScope.workstreamId : null,
              sessionId: traceScope.scope === "session" ? traceScope.sessionId : null,
              projectTruthOnly: traceScope.scope === "project",
              cursor: params.timeline_cursor ?? null,
              limit: params.timeline_limit,
              order: params.timeline_order,
            });
            if (page.events.length > 0) {
              output += `## Subject ${params.subject_key} — no current fact, ${page.events.length} historical event(s)\n\n`;
              output += page.events.map((event) => formatChronicleEvent(db, event, { includeSources: params.include_sources })).join("\n") + "\n";
              if (page.nextCursor) output += `\n_Next timeline cursor: ${page.nextCursor}_\n`;
              return { content: [{ type: "text", text: output }] };
            }
          }
          return {
            content: [
              { type: "text", text: "No matching facts found to trace." },
            ],
          };
        }

        for (const { fact, distance } of results) {
          const revision = currentFactRevision(db, fact.id);
          output += `## [${CHRONICLE_LANE_LABELS.currentFact}] ${fact.fact}\n`;
          output += `- Fact ID: ${fact.id} | Active: ${fact.is_active ? "yes" : "no (retired)"}\n`;
          output += `- Category: ${fact.category} | Scope: ${fact.scope_type} | Promotion: ${fact.promotion_state ?? "legacy-project"}\n`;
          output += `- Subject: ${fact.subject_key ?? "(none)"}${isSemanticSubjectKey(fact.subject_key) ? "" : " (per-fact slot, not a semantic subject)"}\n`;
          output += `- Revision: semantic ${revision?.semanticGeneration ?? "?"} / lifecycle ${revision?.lifecycleGeneration ?? "?"} | Current since: ${revision?.latestEffectiveAt ?? fact.updated_at}\n`;
          if (distance !== null) {
            const similarity = (1 - (distance * distance) / 2).toFixed(3);
            output += `- Similarity: ${similarity} | Confirmed: ${fact.consolidated_count}x\n`;
          } else {
            output += `- Confirmed: ${fact.consolidated_count}x\n`;
          }
          output += `- Created: ${fact.created_at}\n`;

          // Trace back to source exchanges
          if (fact.source_exchange_ids && fact.source_exchange_ids.length > 0) {
            output += `\n### Source Conversations [${CHRONICLE_LANE_LABELS.rawEvidence}]\n\n`;
            for (const exchangeId of fact.source_exchange_ids) {
              const exchange = db
                .prepare(
                  "SELECT id, project, timestamp, session_id, user_message, archive_path, line_start, line_end FROM exchanges WHERE id = ?",
                )
                .get(exchangeId) as Record<string, unknown> | undefined;

              if (exchange) {
                const userMsg = (exchange["user_message"] as string)
                  .substring(0, 200)
                  .replace(/\s+/g, " ");
                output += `- **[${exchange["project"]}, ${(exchange["timestamp"] as string).slice(0, 10)}, session ${exchange["session_id"] ?? "?"}]**\n`;
                output += `  "${userMsg}..."\n`;
                output += `  Lines ${exchange["line_start"]}-${exchange["line_end"]} in ${exchange["archive_path"]}\n\n`;
              } else {
                output += `- ${exchangeId}: source unavailable (purged or missing)\n\n`;
              }
            }
          } else {
            output += `\n_Source exchanges not available._\n\n`;
          }

          const contextDependencies = db.prepare(`
            SELECT d.exchange_id, d.dependency_kind,
                   e.project, e.timestamp, e.assistant_message,
                   e.archive_path, e.line_start, e.line_end
            FROM fact_context_dependencies d
            JOIN exchanges e ON e.id = d.exchange_id
            WHERE d.fact_id = ?
            ORDER BY d.created_at, d.exchange_id, d.dependency_kind
          `).all(fact.id) as Array<Record<string, unknown>>;
          if (contextDependencies.length > 0) {
            output += `### Interpretive Context (Non-Authoritative) [${CHRONICLE_LANE_LABELS.assistantContext}]\n\n`;
            output += `_These exchanges helped resolve meaning but are not Fact evidence._\n\n`;
            for (const dependency of contextDependencies) {
              const assistant = String(dependency["assistant_message"] ?? "")
                .substring(0, 200)
                .replace(/\s+/g, " ");
              output += `- **[${dependency["dependency_kind"]}, ${dependency["project"]}, ${String(dependency["timestamp"]).slice(0, 10)}]**\n`;
              output += `  Assistant context: "${assistant}..."\n`;
              output += `  Lines ${dependency["line_start"]}-${dependency["line_end"]} in ${dependency["archive_path"]}\n\n`;
            }
          }

          if (params.include_timeline) {
            const bySubject = isSemanticSubjectKey(fact.subject_key) && !!fact.project_id;
            const page = readChronicleTimeline(db, {
              ...(bySubject
                ? { projectId: fact.project_id, subjectKey: fact.subject_key }
                : { factId: fact.id }),
              workspaceId: traceScope.scope === "workspace" || traceScope.scope === "workstream" ? traceScope.workspaceId : null,
              workstreamId: traceScope.scope === "workstream" ? traceScope.workstreamId : null,
              sessionId: traceScope.scope === "session" ? traceScope.sessionId : null,
              projectTruthOnly: traceScope.scope === "project",
              cursor: params.timeline_cursor ?? null,
              limit: params.timeline_limit,
              order: params.timeline_order,
            });
            output += `### Chronicle Timeline (${bySubject ? "subject" : "fact"}, ${params.timeline_order} by effective time, ${page.events.length} of max ${page.limit})\n\n`;
            if (page.events.length === 0) {
              output += `_No Chronicle events recorded._\n`;
            } else {
              output += page.events.map((event) => formatChronicleEvent(db, event, { includeSources: params.include_sources })).join("\n") + "\n";
            }
            if (page.nextCursor) output += `\n_Next timeline cursor: ${page.nextCursor}_\n`;
            output += "\n";
          }

          if (params.include_incidents && fact.project_id) {
            const occurrences = isSemanticSubjectKey(fact.subject_key)
              ? listIncidentOccurrences(db, { projectId: fact.project_id, subjectKey: fact.subject_key, limit: 10 })
              : [];
            const patterns = matchIncidentPatterns(db, {
              projectId: fact.project_id,
              text: `${params.query ?? ""} ${fact.fact}`,
              limit: 3,
              includeRemediated: true,
            });
            if (occurrences.length > 0 || patterns.length > 0) {
              output += `### Incidents\n\n`;
              for (const occurrence of occurrences) {
                output += `- [${CHRONICLE_LANE_LABELS.event}] INCIDENT occurrence ${occurrence.occurrence_id} · ${occurrence.effective_at} · session ${occurrence.session_id ?? "?"} · retries ${occurrence.retry_count} · ${occurrence.state} · signature ${occurrence.signature_key}\n  "${occurrence.signature_text}"\n`;
              }
              for (const pattern of patterns) {
                output += `- Pattern ${pattern.signatureKey} (${pattern.patternState}, ${pattern.episodeCount} episode(s), score ${pattern.score.toFixed(2)}): "${pattern.signatureText}"${pattern.remediationSummary ? ` — remediation: ${pattern.remediationSummary}` : ""}\n`;
              }
              output += "\n";
            }
          }

          // Show graph relations
          const related = getRelatedFacts(
            db,
            fact.id,
            1,
            0.6,
            0.2,
            traceScope.legacyProject,
            traceScope.scope === "global" || traceScope.scope === "all" ? traceScope.scope : "project",
          );
          if (related.length > 0) {
            output += `### Related Facts (1-hop)\n\n`;
            for (const { fact: relFact, relation } of related) {
              output += `- **[${relation.relation_type}]** ${relFact.fact}\n`;
            }
            output += "\n";
          }
        }

        if (params.include_hot_evidence && traceScope.projectId) {
          const hot = readHotEvidence(db, {
            projectId: traceScope.projectId,
            workspaceId: traceScope.scope === "workspace" ? traceScope.workspaceId : null,
            workstreamId: traceScope.scope === "workstream" ? traceScope.workstreamId : null,
            sessionId: traceScope.scope === "session" ? traceScope.sessionId : null,
            beforeCreatedAt: null,
            beforeEvidenceId: null,
            limit: params.limit,
          });
          output += `\n## Recent Evidence — NOT YET DISTILLED (${hot.length})\n\n`;
          output += hot.map((item) =>
            `- [${item.source_type}] ${item.evidence_text}\n  - Cursor: ${item.created_at} / ${item.evidence_id}`,
          ).join("\n") || "_No recent evidence._";
          output += "\n";
        }

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === "graph_stats") {
      const gs = z
        .object({
          project: z.string().max(500).optional(),
          project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
          workspace_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
          workstream_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
          session_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
          scope: ContinuityScopeEnum.optional(),
        })
        .strict()
        .parse(args);

      const db = initDatabase();
      try {
        const gsScope = resolveStableScope(db, gs, "graph_stats");
        const facts = listFactsByScope(db, gsScope.factScope);
        const factIds = new Set(facts.map((fact) => fact.id));
        const categoryRows = listCategories(db);
        const categoryById = new Map(categoryRows.map((category) => [category.id, category]));
        const domainById = new Map(listDomains(db).map((domain) => [domain.id, domain]));
        const categories = new Set(facts.map((fact) => fact.ontology_category_id).filter(Boolean));
        const domains = new Set([...categories].map((id) => categoryById.get(id as string)?.domain_id).filter(Boolean));
        const relations = (db.prepare(`
          SELECT source_fact_id, target_fact_id, relation_type FROM ontology_relations
        `).all() as Array<{ source_fact_id: string; target_fact_id: string; relation_type: string }>)
          .filter((row) => factIds.has(row.source_fact_id) && factIds.has(row.target_fact_id));
        const revisions = (db.prepare("SELECT fact_id FROM fact_revisions").all() as Array<{ fact_id: string }>)
          .filter((row) => factIds.has(row.fact_id));
        const countBy = <T extends string>(values: T[]): Array<{ key: T; count: number }> => {
          const counts = new Map<T, number>();
          for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
          return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
        };
        const totalFacts = facts.length;
        const totalDomains = domains.size;
        const totalCategories = categories.size;
        const totalRelations = relations.length;
        const totalRevisions = revisions.length;
        const categoryBreakdown = countBy(facts.map((fact) => fact.category))
          .map(({ key: category, count }) => ({ category, count }));
        const topDomains = countBy(facts.map((fact) => {
          const category = fact.ontology_category_id ? categoryById.get(fact.ontology_category_id) : undefined;
          return category ? (domainById.get(category.domain_id)?.name ?? "Unknown") : "Unknown";
        })).slice(0, 10).map(({ key: name, count: fact_count }) => ({ name, fact_count }));
        const relationBreakdown = countBy(relations.map((row) => row.relation_type))
          .map(({ key: relation_type, count }) => ({ relation_type, count }));

        let output = `# Knowledge Graph Statistics\n\n`;
        output += `| Metric | Count |\n|--------|-------|\n`;
        output += `| Active Facts | ${totalFacts} |\n`;
        output += `| Domains | ${totalDomains} |\n`;
        output += `| Categories | ${totalCategories} |\n`;
        output += `| Relations | ${totalRelations} |\n`;
        output += `| Revisions | ${totalRevisions} |\n\n`;

        if (categoryBreakdown.length > 0) {
          output += `## Fact Categories\n\n`;
          for (const { category, count } of categoryBreakdown)
            output += `- ${category}: ${count}\n`;
          output += "\n";
        }

        if (topDomains.length > 0) {
          output += `## Top Domains\n\n`;
          for (const { name: dn, fact_count } of topDomains)
            output += `- ${dn}: ${fact_count} facts\n`;
          output += "\n";
        }

        if (relationBreakdown.length > 0) {
          output += `## Relation Types\n\n`;
          for (const { relation_type, count } of relationBreakdown)
            output += `- ${relation_type}: ${count}\n`;
          output += "\n";
        }

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === "cross_project_insights") {
      // KNOWLEDGE-GRAPH.md:60-65 — 이 도구는 current_project 를 **항상 제외**한다.
      // scope=global/all 을 허용하면 resolveProjectScope 가 project=null 을 돌려
      // 제외 필터가 무력화되어 현재 프로젝트가 결과에 포함된다(스코프 누수).
      // 따라서 scope 는 'project' 만 허용한다(툴 스키마와도 일치).
      const params = z
        .object({
          query: z.string().min(2).max(10000),
          current_project: z.string().max(500).optional(),
          current_project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
          scope: z.enum(["project"]).optional(),
          limit: z.number().int().min(1).max(20).default(5),
        })
        .strict()
        .parse(args);

      await initEmbeddings();
      const db = initDatabase();

      try {
        const cxScope = resolveStableScope(db, {
          project: params.current_project,
          project_id: params.current_project_id,
          scope: "project",
        }, "cross_project_insights");
        const queryEmbedding = await generateEmbedding(params.query, "query");
        const crossProjectResults = searchFactsByScope(
          db,
          queryEmbedding,
          cxScope.projectId
            ? { type: "other-project-id", projectId: cxScope.projectId }
            : { type: "other-projects", project: cxScope.legacyProject as string },
          params.limit,
          0.5,
        );

        if (crossProjectResults.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No cross-project insights found for "${params.query}". Similar decisions may not exist in other projects yet.`,
              },
            ],
          };
        }

        // Group by project
        const byProject = new Map<
          string,
          Array<{
            fact: (typeof crossProjectResults)[0]["fact"];
            distance: number;
          }>
        >();
        for (const { fact, distance } of crossProjectResults) {
          const proj = fact.project_id || fact.scope_project || "global";
          if (!byProject.has(proj)) byProject.set(proj, []);
          byProject.get(proj)!.push({ fact, distance });
        }

        let output = `# Cross-Project Insights\n\nQuery: "${params.query}"\nExcluding: ${cxScope.label}\n\n`;

        for (const [project, facts] of byProject) {
          output += `## Project: ${project}\n\n`;
          for (const { fact, distance } of facts) {
            const similarity = Math.round(
              (1 - (distance * distance) / 2) * 100,
            );
            output += `- **[${fact.category}]** ${fact.fact} _(${similarity}% relevant, ${fact.created_at.slice(0, 10)})_\n`;
          }
          output += "\n";
        }

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    if (name === "explore_graph") {
      const params = z
        .object({
          query: z.string().min(2).max(10000),
          hops: z.number().int().min(1).max(3).default(2),
          project: z.string().max(500).optional(),
          project_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
          workspace_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(),
          workstream_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
          session_id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/).optional(),
          scope: ContinuityScopeEnum.optional(),
        })
        .strict()
        .parse(args);
      // CX-11/F4: traversal seeds obey the same scope contract; no all-project
      // default. Relation hops are filtered to stay inside the resolved scope.
      await initEmbeddings();
      const db = initDatabase();

      try {
        const egScope = resolveStableScope(db, params, "explore_graph");
        const queryEmbedding = await generateEmbedding(params.query, "query");
        const seedFacts = searchFactsByScope(
          db,
          queryEmbedding,
          egScope.factScope,
          3,
          0.5,
        );
        const seedIds = new Set(seedFacts.map((r) => r.fact.id));

        if (seedFacts.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No facts found related to "${params.query}" to start graph exploration.`,
              },
            ],
          };
        }

        // Build domain/category maps
        const domains = listDomains(db);
        const categories = listCategories(db);
        const domainMap = new Map(domains.map((d) => [d.id, d.name]));
        const categoryMap = new Map(
          categories.map((c) => [
            c.id,
            { name: c.name, domainId: c.domain_id },
          ]),
        );

        let output = `# Knowledge Graph Exploration\n\nSeed: "${params.query}" | Depth: ${params.hops} hops\n\n`;

        const allDiscovered = new Set<string>();

        for (const { fact: seedFact, distance } of seedFacts) {
          const similarity = Math.round((1 - (distance * distance) / 2) * 100);
          const catInfo = seedFact.ontology_category_id
            ? categoryMap.get(seedFact.ontology_category_id)
            : undefined;
          const domainName = catInfo
            ? (domainMap.get(catInfo.domainId) ?? "?")
            : "?";
          const catName = catInfo ? catInfo.name : "?";

          output += `## Seed: ${seedFact.fact}\n`;
          output += `- [${domainName}/${catName}] ${seedFact.category} | ${similarity}% relevant\n\n`;

          allDiscovered.add(seedFact.id);

          // Multi-hop traversal, confined to the resolved scope:
          const related = getRelatedFacts(
            db,
            seedFact.id,
            params.hops,
            0.6,
            0.2,
            egScope.legacyProject,
            egScope.scope === "global" || egScope.scope === "all" ? egScope.scope : "project",
            egScope.factScope,
          ).slice(0, 20);
          void seedIds;

          if (related.length === 0) {
            output += `_No connected facts found._\n\n`;
            continue;
          }

          // Group by hop distance (approximate via order)
          output += `### Connected Facts (${related.length} found, up to ${params.hops} hops)\n\n`;

          for (const { fact: relFact, relation } of related) {
            if (allDiscovered.has(relFact.id)) continue;
            allDiscovered.add(relFact.id);

            const relCatInfo = relFact.ontology_category_id
              ? categoryMap.get(relFact.ontology_category_id)
              : undefined;
            const relDomain = relCatInfo
              ? (domainMap.get(relCatInfo.domainId) ?? "?")
              : "?";
            const relCat = relCatInfo ? relCatInfo.name : "?";

            output += `- **[${relation.relation_type}]** ${relFact.fact}\n`;
            output += `  [${relDomain}/${relCat}] ${relFact.category} | ${relFact.created_at.slice(0, 10)}\n`;
            if (relation.reasoning) {
              output += `  _${relation.reasoning}_\n`;
            }
          }
          output += "\n";
        }

        output += `\n_Total unique facts discovered: ${allDiscovered.size}_\n`;

        return { content: [{ type: "text", text: output }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error) }],
          isError: true,
        };
      } finally {
        db.close();
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    // Return errors within the result (not as protocol errors)
    return {
      content: [
        {
          type: "text",
          text: handleError(error),
        },
      ],
      isError: true,
    };
  }
}

// Main Function

async function main() {
  console.error("Episodic Memory MCP server running via stdio");

  // Warm inject sidecar BEFORE connecting the transport: it lets the
  // UserPromptSubmit hook reuse this process's loaded embedding model over a
  // unix socket (~150ms warm vs ~2.3s cold). Starting it first means it is
  // available immediately and is never gated on server.connect() completing
  // (best-effort, unref'd — adds no lifecycle and never blocks MCP traffic).
  startInjectDaemon();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run the Server — only when this file is the entry process (direct run or
// spawned by cli/mcp-server-wrapper.js with MEMEX_MCP_AUTOSTART=1).
// Library/test imports must not start a stdio server or inject daemon.
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("mcp-server.js") ||
    process.argv[1].endsWith("mcp-server"));

if (
  isDirectRun
  || process.env.MEMEX_MCP_AUTOSTART === "1"
) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
