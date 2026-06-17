/**
 * MCP 抽象层：McpManager 只依赖 McpClientLike + connect 工厂，
 * 真实实现用官方 SDK（mcp/client.ts），测试用 mock。
 */

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** content blocks（text/image/...），我们主要取 text。 */
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

/** 一个已连接的 MCP server 客户端（最小子集）。 */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** server 连接配置（对应 config.mcpServers 的一项）。 */
export interface McpServerConfig {
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

/** 由配置建立连接的工厂（真实实现注入 SDK，测试注入 mock）。 */
export type McpConnectFn = (
  name: string,
  config: McpServerConfig,
) => Promise<McpClientLike>;
