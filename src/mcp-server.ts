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
  getRevisions,
  type FactSearchScope,
} from "./fact-db.js";
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

// Zod Schemas for Input Validation

const SearchModeEnum = z.enum(["vector", "text", "both"]);
const ResponseFormatEnum = z.enum(["markdown", "json"]);

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

const ScopeEnum = z.enum(["project", "global", "all"]);

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
        "Canonical absolute Codex thread cwd (required unless scope is global/all)",
      ),
    scope: ScopeEnum.optional().describe(
      '"project" (default, requires project), "global" (global facts only), or "all"',
    ),
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
    scope: ScopeEnum.optional().describe(
      '"project" (default, requires project), "global" (global facts only), or "all"',
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
    scope: ScopeEnum.optional().describe(
      '"project" (default, requires project), "global" (global facts only), or "all"',
    ),
  })
  .strict();

type AskAvatarInput = z.infer<typeof AskAvatarInputSchema>;

// ── CX-03: explicit active-project scope contract ───────────────────────────
// Project-sensitive tools never fall back to process.cwd(): the MCP server
// runs with the plugin root as cwd, so an omitted project would silently mix
// plugin-root facts into the user's project. The caller must pass the
// canonical absolute Codex thread cwd, or an explicit global/all scope.

type ResolvedScope =
  | { project: string; scope: "project" }
  | { project: null; scope: "global" }
  | { project: null; scope: "all" };

function toFactSearchScope(resolved: ResolvedScope): FactSearchScope {
  if (resolved.scope === "global") return { type: "global" };
  if (resolved.scope === "all") return { type: "all" };
  return { type: "project", project: resolved.project };
}

function resolveProjectScope(
  raw: {
    project?: string;
    current_project?: string;
    scope?: "project" | "global" | "all";
  },
  tool: string,
  field: "project" | "current_project" = "project",
): ResolvedScope {
  const scope = raw.scope ?? "project";
  if (scope === "global" || scope === "all") return { project: null, scope };
  const value =
    (field === "current_project" ? raw.current_project : raw.project) ?? "";
  if (!value.trim()) {
    throw new Error(
      JSON.stringify({
        error: `${tool}: ${field} is required for project-scoped queries`,
        expected:
          'canonical absolute Codex thread cwd (session_meta.cwd), or scope: "global" | "all"',
        example: { [field]: "/Users/me/work/app-a" },
      }),
    );
  }
  return { project: canonicalizeProjectPath(value.trim()), scope };
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
    version: "0.1.0",
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
      description: `Gives you memory across sessions. You don't automatically remember past conversations - this tool restores context by searching them. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Single string for semantic search or array of 2-5 concepts for precise AND matching. Returns ranked results with project, date, snippets, and file paths.`,
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
        "Search extracted facts from past conversations. Returns project-scoped and global facts. Facts are long-term knowledge automatically extracted and consolidated from conversations.",
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
              "Canonical absolute Codex thread cwd (session_meta.cwd). Required unless scope is global/all.",
          },
          scope: {
            type: "string",
            enum: ["project", "global", "all"],
            description:
              '"project" (default, requires project), "global" (global facts only), or "all"',
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
          scope: {
            type: "string",
            enum: ["project", "global", "all"],
            description:
              '"project" (default, requires project), "global", or "all"',
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
              "Canonical absolute Codex thread cwd. Required unless scope is global/all.",
          },
          scope: {
            type: "string",
            enum: ["project", "global", "all"],
            description:
              '"project" (default, requires project), "global", or "all"',
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
        "Trace a fact back to its source conversations. Shows the original exchanges that led to a knowledge graph fact, providing full provenance and context.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 2,
            maxLength: 10000,
            description: "Search query to find the fact to trace",
          },
          project: {
            type: "string",
            maxLength: 500,
            description:
              "Canonical absolute Codex thread cwd. Required unless scope is global/all.",
          },
          scope: {
            type: "string",
            enum: ["project", "global", "all"],
            description:
              '"project" (default, requires project), "global", or "all"',
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 10,
            default: 3,
            description: "Max facts to trace",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        title: "Trace Fact Provenance",
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
          scope: {
            type: "string",
            enum: ["project", "global", "all"],
            description:
              '"project" (default, requires project), "global", or "all"',
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
              "Canonical absolute Codex thread cwd to exclude (required).",
          },
          scope: {
            type: "string",
            enum: ["project"],
            description:
              "cross_project_insights always excludes the given current_project; pass its cwd explicitly.",
          },
          limit: {
            type: "number",
            minimum: 1,
            maximum: 20,
            default: 5,
            description: "Max results",
          },
        },
        required: ["query", "current_project"],
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
          scope: {
            type: "string",
            enum: ["project", "global", "all"],
            description:
              '"project" (default, requires project), "global", or "all"',
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

      // Check if query is array (multi-concept) or string (single-concept)
      if (Array.isArray(params.query)) {
        // Multi-concept search
        const options = {
          limit: params.limit,
          after: params.after,
          before: params.before,
          project: params.project,
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
          project: params.project,
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
      // CX-03: no cwd fallback — explicit project or global/all scope required.
      const scopeInfo = resolveProjectScope(params, "search_facts");
      const scopeFilter = scopeInfo.scope;

      await initEmbeddings();
      const db = initDatabase();
      try {
        const queryEmbedding = await generateEmbedding(params.query, "query");
        const results = searchFactsByScope(
          db,
          queryEmbedding,
          toFactSearchScope(scopeInfo),
          params.limit,
          0.85,
          { category: params.category },
        );
        const scopeLabel =
          scopeFilter === "project"
            ? scopeInfo.project
            : `${scopeFilter} facts only`;
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
              output += "- Revisions:\n";
              for (const rev of revisions) {
                output += `  - ${rev.created_at}: "${rev.previous_fact}" → "${rev.new_fact}" (${rev.reason})\n`;
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
            scopeInfo.project,
            scopeInfo.scope,
          );
          if (related.length > 0) {
            output += `- Related:\n`;
            for (const { fact: relFact, relation } of related) {
              output += `  - [${relation.relation_type}] ${relFact.fact}\n`;
            }
          }

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
      const scopeInfo = resolveProjectScope(params, "search_ontology");

      try {
        const db = initDatabase();
        const tree = getOntologyTree(db, scopeInfo.project, scopeInfo.scope);

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
                  scopeInfo.project,
                  scopeInfo.scope,
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
      // CX-03: explicit scope contract; global/all scopes restrict sources.
      const avatarScope = resolveProjectScope(params, "ask_avatar");

      try {
        const db = initDatabase();
        const result = await askAvatar(
          db,
          params.question,
          avatarScope.project ?? undefined,
          avatarScope.scope,
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
          query: z.string().min(2).max(10000),
          project: z.string().max(500).optional(),
          scope: ScopeEnum.optional(),
          limit: z.number().int().min(1).max(10).default(3),
        })
        .strict()
        .parse(args);

      // CX-03: explicit scope contract.
      const traceScope = resolveProjectScope(params, "trace_fact");

      await initEmbeddings();
      const db = initDatabase();

      try {
        const queryEmbedding = await generateEmbedding(params.query, "query");
        const results = searchFactsByScope(
          db,
          queryEmbedding,
          toFactSearchScope(traceScope),
          params.limit,
          0.5,
        );

        if (results.length === 0) {
          return {
            content: [
              { type: "text", text: "No matching facts found to trace." },
            ],
          };
        }

        let output = `# Fact Provenance Trace\n\nQuery: "${params.query}"\n\n`;

        for (const { fact, distance } of results) {
          const similarity = (1 - (distance * distance) / 2).toFixed(3);
          output += `## ${fact.fact}\n`;
          output += `- Category: ${fact.category} | Scope: ${fact.scope_type}\n`;
          output += `- Similarity: ${similarity} | Confirmed: ${fact.consolidated_count}x\n`;
          output += `- Created: ${fact.created_at}\n`;

          // Trace back to source exchanges
          if (fact.source_exchange_ids && fact.source_exchange_ids.length > 0) {
            output += `\n### Source Conversations\n\n`;
            for (const exchangeId of fact.source_exchange_ids) {
              const exchange = db
                .prepare(
                  "SELECT id, project, timestamp, user_message, archive_path, line_start, line_end FROM exchanges WHERE id = ?",
                )
                .get(exchangeId) as Record<string, unknown> | undefined;

              if (exchange) {
                const userMsg = (exchange["user_message"] as string)
                  .substring(0, 200)
                  .replace(/\s+/g, " ");
                output += `- **[${exchange["project"]}, ${(exchange["timestamp"] as string).slice(0, 10)}]**\n`;
                output += `  "${userMsg}..."\n`;
                output += `  Lines ${exchange["line_start"]}-${exchange["line_end"]} in ${exchange["archive_path"]}\n\n`;
              }
            }
          } else {
            output += `\n_Source exchanges not available._\n\n`;
          }

          // Show ontology context
          const revisions = getRevisions(db, fact.id);
          if (revisions.length > 0) {
            output += `### Revision History\n\n`;
            for (const rev of revisions) {
              output += `- ${rev.created_at.slice(0, 10)}: "${rev.previous_fact}" → "${rev.new_fact}" (${rev.reason})\n`;
            }
            output += "\n";
          }

          // Show graph relations
          const related = getRelatedFacts(
            db,
            fact.id,
            1,
            0.6,
            0.2,
            traceScope.project,
            traceScope.scope,
          );
          if (related.length > 0) {
            output += `### Related Facts (1-hop)\n\n`;
            for (const { fact: relFact, relation } of related) {
              output += `- **[${relation.relation_type}]** ${relFact.fact}\n`;
            }
            output += "\n";
          }
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
          scope: ScopeEnum.optional(),
        })
        .strict()
        .parse(args);
      // CX-11/F3: the scope parameter is a contract, not decoration — apply it.
      const gsScope = resolveProjectScope(gs, "graph_stats");

      const db = initDatabase();
      try {
        const factWhere =
          gsScope.scope === "global"
            ? "f.is_active = 1 AND f.scope_type = 'global'"
            : gsScope.project
              ? "f.is_active = 1 AND (f.scope_type = 'global' OR f.scope_project = ?)"
              : "f.is_active = 1";
        const factArgs =
          gsScope.scope === "project" && gsScope.project
            ? [gsScope.project]
            : [];

        const totalFacts = (
          db
            .prepare(`SELECT COUNT(*) as count FROM facts f WHERE ${factWhere}`)
            .get(...factArgs) as { count: number }
        ).count;

        const totalDomains = (
          db
            .prepare(`
          SELECT COUNT(DISTINCT d.id) as count
          FROM ontology_domains d
          JOIN ontology_categories c ON c.domain_id = d.id
          JOIN facts f ON f.ontology_category_id = c.id
          WHERE ${factWhere}
        `)
            .get(...factArgs) as { count: number }
        ).count;

        const totalCategories = (
          db
            .prepare(`
          SELECT COUNT(DISTINCT c.id) as count
          FROM ontology_categories c
          JOIN facts f ON f.ontology_category_id = c.id
          WHERE ${factWhere}
        `)
            .get(...factArgs) as { count: number }
        ).count;

        const relWhere =
          gsScope.scope === "global"
            ? "s.is_active = 1 AND t.is_active = 1 AND s.scope_type = 'global' AND t.scope_type = 'global'"
            : gsScope.project
              ? "s.is_active = 1 AND t.is_active = 1 AND (s.scope_type = 'global' OR s.scope_project = ?) AND (t.scope_type = 'global' OR t.scope_project = ?)"
              : "s.is_active = 1 AND t.is_active = 1";
        const relArgs =
          gsScope.scope === "project" && gsScope.project
            ? [gsScope.project, gsScope.project]
            : [];

        const totalRelations = (
          db
            .prepare(`
          SELECT COUNT(*) as count
          FROM ontology_relations r
          JOIN facts s ON r.source_fact_id = s.id
          JOIN facts t ON r.target_fact_id = t.id
          WHERE ${relWhere}
        `)
            .get(...relArgs) as { count: number }
        ).count;

        const totalRevisions = (
          db
            .prepare(`
          SELECT COUNT(*) as count
          FROM fact_revisions fr
          JOIN facts f ON fr.fact_id = f.id
          WHERE ${factWhere}
        `)
            .get(...factArgs) as { count: number }
        ).count;

        const categoryBreakdown = db
          .prepare(
            `SELECT f.category, COUNT(*) as count FROM facts f WHERE ${factWhere} GROUP BY f.category ORDER BY count DESC`,
          )
          .all(...factArgs) as Array<{ category: string; count: number }>;

        const topDomains = db
          .prepare(`
          SELECT d.name, COUNT(f.id) as fact_count
          FROM ontology_domains d
          JOIN ontology_categories c ON c.domain_id = d.id
          JOIN facts f ON f.ontology_category_id = c.id
          WHERE ${factWhere}
          GROUP BY d.id ORDER BY fact_count DESC LIMIT 10
        `)
          .all(...factArgs) as Array<{ name: string; fact_count: number }>;

        const relationBreakdown = db
          .prepare(`
          SELECT r.relation_type, COUNT(*) as count
          FROM ontology_relations r
          JOIN facts s ON r.source_fact_id = s.id
          JOIN facts t ON r.target_fact_id = t.id
          WHERE ${relWhere}
          GROUP BY r.relation_type ORDER BY count DESC
        `)
          .all(...relArgs) as Array<{ relation_type: string; count: number }>;

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
          scope: z.enum(["project"]).optional(),
          limit: z.number().int().min(1).max(20).default(5),
        })
        .strict()
        .parse(args);

      // CX-03: current_project is required — never guess the active project.
      const cxScope = resolveProjectScope(
        params,
        "cross_project_insights",
        "current_project",
      );
      if (cxScope.scope !== "project") {
        throw new Error("cross_project_insights requires project scope");
      }
      const currentProject = cxScope.project;

      await initEmbeddings();
      const db = initDatabase();

      try {
        const queryEmbedding = await generateEmbedding(params.query, "query");
        const crossProjectResults = searchFactsByScope(
          db,
          queryEmbedding,
          { type: "other-projects", project: currentProject },
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
          const proj = fact.scope_project || "global";
          if (!byProject.has(proj)) byProject.set(proj, []);
          byProject.get(proj)!.push({ fact, distance });
        }

        let output = `# Cross-Project Insights\n\nQuery: "${params.query}"\nExcluding: ${currentProject}\n\n`;

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
          scope: ScopeEnum.optional(),
        })
        .strict()
        .parse(args);
      // CX-11/F4: traversal seeds obey the same scope contract; no all-project
      // default. Relation hops are filtered to stay inside the resolved scope.
      const egScope = resolveProjectScope(params, "explore_graph");

      await initEmbeddings();
      const db = initDatabase();

      try {
        const queryEmbedding = await generateEmbedding(params.query, "query");
        const seedFacts = searchFactsByScope(
          db,
          queryEmbedding,
          toFactSearchScope(egScope),
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
            egScope.project,
            egScope.scope,
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
  || process.env.MEMORY_BANK_MCP_AUTOSTART === "1"
) {
  main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
