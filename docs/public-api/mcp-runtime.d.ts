// file: index.d.ts
import type { IdentityContext, JsonValue, ToolDefinition } from '@aiop/control-contracts';
export interface McpToolDescription {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    readOnly?: boolean;
    idempotent?: boolean;
}
export interface McpClientPort {
    listTools(): Promise<readonly McpToolDescription[]>;
    callTool(name: string, argumentsValue: JsonValue): Promise<{
        content: unknown;
    }>;
    close(): Promise<void>;
}
export interface McpServerBinding {
    name: string;
    client: McpClientPort;
    visible?: (identity: IdentityContext) => boolean;
    timeoutMs?: number;
}
export interface McpAuditSink {
    record(event: {
        tenantId: string;
        actorId: string;
        server: string;
        tool: string;
        ok: boolean;
    }): Promise<void>;
}
export declare class McpRuntime {
    private readonly options;
    private readonly tools;
    constructor(options: {
        servers: readonly McpServerBinding[];
        audit?: McpAuditSink;
    });
    discover(identity: IdentityContext): Promise<ToolDefinition[]>;
    invoke(name: string, argumentsValue: JsonValue, identity: IdentityContext): Promise<{
        content: string;
    }>;
    close(): Promise<void>;
}
