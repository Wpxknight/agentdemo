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
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallResult>;
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

export type McpConnectFn = (
  name: string,
  config: McpServerConfig,
  context: McpConnectContext,
) => Promise<McpClientLike>;

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
