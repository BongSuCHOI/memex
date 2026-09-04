#!/usr/bin/env node
/**
 * MCP Server for Memex.
 *
 * This server provides tools to search and explore indexed Codex conversations
 * using semantic search, text search, and conversation display capabilities.
 */
export declare function getToolDefinitions(): ({
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                oneOf: ({
                    type: string;
                    minLength: number;
                    maxLength: number;
                    items?: undefined;
                    minItems?: undefined;
                    maxItems?: undefined;
                } | {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                        maxLength: number;
                    };
                    minItems: number;
                    maxItems: number;
                    minLength?: undefined;
                    maxLength?: undefined;
                })[];
                type?: undefined;
                minLength?: undefined;
                maxLength?: undefined;
                description?: undefined;
            };
            mode: {
                type: string;
                enum: string[];
                default: string;
            };
            project: {
                type: string;
                maxLength: number;
                description: string;
            };
            project_id: {
                type: string;
                pattern: string;
            };
            workspace_id: {
                type: string;
                pattern: string;
            };
            workstream_id: {
                type: string;
                pattern: string;
            };
            session_id: {
                type: string;
                pattern: string;
            };
            scope: {
                type: string;
                enum: string[];
                description?: undefined;
            };
            limit: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description?: undefined;
            };
            after: {
                type: string;
                pattern: string;
            };
            before: {
                type: string;
                pattern: string;
            };
            response_format: {
                type: string;
                enum: string[];
                default: string;
            };
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            include_hot_evidence?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
            hops?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            path: {
                type: string;
                minLength: number;
            };
            startLine: {
                type: string;
                minimum: number;
            };
            endLine: {
                type: string;
                minimum: number;
            };
            query?: undefined;
            mode?: undefined;
            project?: undefined;
            project_id?: undefined;
            workspace_id?: undefined;
            workstream_id?: undefined;
            session_id?: undefined;
            scope?: undefined;
            limit?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            include_hot_evidence?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
            hops?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                minLength: number;
                maxLength: number;
                description: string;
                oneOf?: undefined;
            };
            project: {
                type: string;
                maxLength: number;
                description: string;
            };
            project_id: {
                type: string;
                pattern: string;
            };
            workspace_id: {
                type: string;
                pattern: string;
            };
            workstream_id: {
                type: string;
                pattern: string;
            };
            session_id: {
                type: string;
                pattern: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
            category: {
                type: string;
                enum: string[];
                description: string;
            };
            include_revisions: {
                type: string;
                description: string;
                default: boolean;
            };
            include_hot_evidence: {
                type: string;
                description: string;
                default: boolean;
            };
            hot_before: {
                type: string;
                format: string;
            };
            hot_before_evidence_id: {
                type: string;
                maxLength: number;
            };
            limit: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            mode?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
            hops?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            domain: {
                type: string;
                description: string;
            };
            category: {
                type: string;
                description: string;
                enum?: undefined;
            };
            include_relations: {
                type: string;
                default: boolean;
                description: string;
            };
            project: {
                type: string;
                maxLength: number;
                description: string;
            };
            project_id: {
                type: string;
                pattern: string;
            };
            workspace_id: {
                type: string;
                pattern: string;
            };
            workstream_id: {
                type: string;
                pattern: string;
            };
            session_id: {
                type: string;
                pattern: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
            query?: undefined;
            mode?: undefined;
            limit?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            include_revisions?: undefined;
            include_hot_evidence?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            question?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
            hops?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            question: {
                type: string;
                minLength: number;
                maxLength: number;
                description: string;
            };
            project: {
                type: string;
                maxLength: number;
                description: string;
            };
            project_id: {
                type: string;
                pattern: string;
            };
            workspace_id: {
                type: string;
                pattern: string;
            };
            workstream_id: {
                type: string;
                pattern: string;
            };
            session_id: {
                type: string;
                pattern: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
            query?: undefined;
            mode?: undefined;
            limit?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            include_hot_evidence?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
            hops?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                minLength: number;
                maxLength: number;
                description: string;
                oneOf?: undefined;
            };
            fact_id: {
                type: string;
                pattern: string;
                description: string;
            };
            subject_key: {
                type: string;
                pattern: string;
                description: string;
            };
            project: {
                type: string;
                maxLength: number;
                description: string;
            };
            project_id: {
                type: string;
                pattern: string;
            };
            workspace_id: {
                type: string;
                pattern: string;
            };
            workstream_id: {
                type: string;
                pattern: string;
            };
            session_id: {
                type: string;
                pattern: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
            limit: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            include_timeline: {
                type: string;
                default: boolean;
                description: string;
            };
            timeline_limit: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            timeline_cursor: {
                type: string;
                maxLength: number;
                description: string;
            };
            timeline_order: {
                type: string;
                enum: string[];
                default: string;
                description: string;
            };
            include_incidents: {
                type: string;
                default: boolean;
                description: string;
            };
            include_sources: {
                type: string;
                default: boolean;
                description: string;
            };
            include_hot_evidence: {
                type: string;
                default: boolean;
                description: string;
            };
            mode?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
            hops?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            project: {
                type: string;
                maxLength: number;
                description: string;
            };
            project_id: {
                type: string;
                pattern: string;
            };
            workspace_id: {
                type: string;
                pattern: string;
            };
            workstream_id: {
                type: string;
                pattern: string;
            };
            session_id: {
                type: string;
                pattern: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
            query?: undefined;
            mode?: undefined;
            limit?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            include_hot_evidence?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
            hops?: undefined;
        };
        additionalProperties: boolean;
        required?: undefined;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                minLength: number;
                maxLength: number;
                description: string;
                oneOf?: undefined;
            };
            current_project: {
                type: string;
                maxLength: number;
                description: string;
            };
            current_project_id: {
                type: string;
                pattern: string;
                description: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
            limit: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            mode?: undefined;
            project?: undefined;
            project_id?: undefined;
            workspace_id?: undefined;
            workstream_id?: undefined;
            session_id?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            include_hot_evidence?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            hops?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: {
            query: {
                type: string;
                minLength: number;
                maxLength: number;
                description: string;
                oneOf?: undefined;
            };
            hops: {
                type: string;
                minimum: number;
                maximum: number;
                default: number;
                description: string;
            };
            project: {
                type: string;
                maxLength: number;
                description: string;
            };
            project_id: {
                type: string;
                pattern: string;
            };
            workspace_id: {
                type: string;
                pattern: string;
            };
            workstream_id: {
                type: string;
                pattern: string;
            };
            session_id: {
                type: string;
                pattern: string;
            };
            scope: {
                type: string;
                enum: string[];
                description: string;
            };
            mode?: undefined;
            limit?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            include_hot_evidence?: undefined;
            hot_before?: undefined;
            hot_before_evidence_id?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            fact_id?: undefined;
            subject_key?: undefined;
            include_timeline?: undefined;
            timeline_limit?: undefined;
            timeline_cursor?: undefined;
            timeline_order?: undefined;
            include_incidents?: undefined;
            include_sources?: undefined;
            current_project?: undefined;
            current_project_id?: undefined;
        };
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
})[];
/**
 * CX-03: exported so isolated tests can drive the exact tool surface without
 * a stdio transport. Mirrors the protocol handler one-for-one.
 */
export declare function handleToolCall(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{
        type: string;
        text: string;
    }>;
    isError?: boolean;
}>;
