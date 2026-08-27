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
                    items?: undefined;
                    minItems?: undefined;
                    maxItems?: undefined;
                } | {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    minItems: number;
                    maxItems: number;
                    minLength?: undefined;
                })[];
                type?: undefined;
                minLength?: undefined;
                description?: undefined;
            };
            mode: {
                type: string;
                enum: string[];
                default: string;
            };
            project: {
                type: string;
                description: string;
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
            scope?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            current_project?: undefined;
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
            readonly project?: undefined;
            limit?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            scope?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            current_project?: undefined;
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
                description: string;
                oneOf?: undefined;
            };
            project: {
                type: string;
                description: string;
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
            current_project?: undefined;
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
                description: string;
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
            question?: undefined;
            current_project?: undefined;
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
                description: string;
            };
            project: {
                type: string;
                description: string;
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
            domain?: undefined;
            include_relations?: undefined;
            current_project?: undefined;
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
                description: string;
                oneOf?: undefined;
            };
            project: {
                type: string;
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
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            current_project?: undefined;
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
            project: {
                type: string;
                description: string;
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
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            current_project?: undefined;
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
                description: string;
                oneOf?: undefined;
            };
            current_project: {
                type: string;
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
            readonly project?: undefined;
            after?: undefined;
            before?: undefined;
            response_format?: undefined;
            path?: undefined;
            startLine?: undefined;
            endLine?: undefined;
            category?: undefined;
            include_revisions?: undefined;
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
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
                description: string;
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
            domain?: undefined;
            include_relations?: undefined;
            question?: undefined;
            current_project?: undefined;
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
