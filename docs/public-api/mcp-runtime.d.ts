// file: client.d.ts
import type { McpClientLike, McpConnectFn, McpServerConfig } from './types.js';
export declare const connectMcp: (name: string, config: McpServerConfig, context?: Parameters<McpConnectFn>[2]) => Promise<McpClientLike>;

// file: index.d.ts
export * from './types.js';
export * from './client.js';
export * from './runtime.js';
export * from './manager.js';

// file: manager.d.ts
import type { IdentityContext } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from '@aiop/pi-runtime';
import type { McpConnectFn, McpRuntimeOptions, McpServerConfig, McpServerInfo } from './types.js';
export interface McpManagerOptions extends Omit<McpRuntimeOptions, 'connect'> {
    loadConfigs?(identity: IdentityContext): Promise<Record<string, McpServerConfig> | undefined>;
}
export declare class McpManager {
    private readonly initial;
    private readonly options;
    private readonly runtime;
    private readonly initialized;
    constructor(initial: Record<string, McpServerConfig>, connect: McpConnectFn, options?: McpManagerOptions);
    start(identity: IdentityContext): Promise<void>;
    tools(identity: IdentityContext): Promise<GovernedToolDefinition[]>;
    add(identity: IdentityContext, name: string, config: McpServerConfig): Promise<McpServerInfo>;
    remove(identity: IdentityContext, name: string): Promise<boolean>;
    reconnect(identity: IdentityContext, name: string): Promise<McpServerInfo>;
    info(identity: IdentityContext, name: string): Promise<McpServerInfo | undefined>;
    list(identity: IdentityContext): Promise<McpServerInfo[]>;
    configs(identity: IdentityContext): Promise<Record<string, McpServerConfig>>;
    close(): Promise<void>;
    private ensureConfigured;
}

// file: runtime.d.ts
import type { IdentityContext, JsonValue } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from '@aiop/pi-runtime';
import type { McpRuntimeOptions, McpServerConfig, McpServerInfo } from './types.js';
export declare class McpTimeoutError extends Error {
}
export declare class McpDisconnectedError extends Error {
}
export declare class McpRuntime {
    private readonly options;
    private readonly tenants;
    private readonly connect;
    constructor(options: McpRuntimeOptions);
    configure(identity: IdentityContext, configs: Record<string, McpServerConfig>): Promise<void>;
    discover(identity: IdentityContext): Promise<GovernedToolDefinition[]>;
    invoke(name: string, argumentsValue: JsonValue, identity: IdentityContext): Promise<{
        content: string;
    }>;
    reconnect(identity: IdentityContext, server: string): Promise<McpServerInfo>;
    add(identity: IdentityContext, server: string, config: McpServerConfig): Promise<McpServerInfo>;
    remove(identity: IdentityContext, server: string): Promise<boolean>;
    info(identity: IdentityContext, server: string): McpServerInfo | undefined;
    list(identity: IdentityContext): McpServerInfo[];
    configs(identity: IdentityContext): Record<string, McpServerConfig>;
    close(): Promise<void>;
    private listWithReconnect;
    private adaptTool;
    private executeTool;
    private withReconnect;
    private ensureConnected;
    private invalidate;
    private requireState;
}
export declare function mcpToolName(server: string, tool: string): string;

// file: types.d.ts
import type { IdentityContext, ToolCapability, ToolRuntime } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from '@aiop/pi-runtime';
export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
    };
}
export interface McpCallResult {
    content: Array<{
        type: string;
        text?: string;
        [key: string]: unknown;
    }>;
    isError?: boolean;
}
export interface McpClientLike {
    listTools(): Promise<{
        tools: McpToolInfo[];
    }>;
    callTool(params: {
        name: string;
        arguments?: Record<string, unknown>;
    }): Promise<McpCallResult>;
    close(): Promise<void>;
}
export interface McpReconnectPolicy {
    maxAttempts?: number;
    backoffMs?: number;
    retryOnTimeout?: boolean;
    retryOnDisconnect?: boolean;
}
export interface McpServerConfig {
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    timeoutMs?: number;
    reconnect?: McpReconnectPolicy;
    toolCapabilities?: Record<string, ToolCapability>;
}
export interface McpCredentials {
    headers?: Record<string, string>;
    env?: Record<string, string>;
}
export interface McpCredentialProvider {
    resolve(identity: IdentityContext, server: string): Promise<McpCredentials>;
}
export interface McpConnectContext {
    identity: IdentityContext;
    credentials: McpCredentials;
}
export type McpConnectFn = (name: string, config: McpServerConfig, context: McpConnectContext) => Promise<McpClientLike>;
export interface McpServerInfo {
    name: string;
    transport: McpServerConfig['transport'];
    command?: string;
    args?: string[];
    url?: string;
    status: 'connected' | 'error';
    error?: string;
    connectedAt?: string;
    tools: string[];
}
export interface McpAuditEvent {
    tenantId: string;
    actorId: string;
    server: string;
    tool: string;
    ok: boolean;
    durationMs: number;
    error?: string;
}
export interface McpAuditSink {
    record(event: McpAuditEvent): Promise<void>;
}
export interface McpRuntimeOptions {
    connect?: McpConnectFn;
    credentials?: McpCredentialProvider;
    audit?: McpAuditSink;
    visible?: (identity: IdentityContext, server: string, tool: McpToolInfo) => boolean;
    /** Required by invoke(); production callers inject their fully configured governance runtime. */
    governance?: (definitions: readonly GovernedToolDefinition[]) => ToolRuntime;
}
