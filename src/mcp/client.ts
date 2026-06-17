import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  McpCallResult,
  McpClientLike,
  McpConnectFn,
  McpServerConfig,
} from './types.js';

function makeTransport(name: string, cfg: McpServerConfig): Transport {
  switch (cfg.transport) {
    case 'stdio':
      if (!cfg.command) throw new Error(`mcp ${name}: stdio 需要 command`);
      return new StdioClientTransport({ command: cfg.command, args: cfg.args });
    case 'sse':
      if (!cfg.url) throw new Error(`mcp ${name}: sse 需要 url`);
      return new SSEClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
    case 'http':
      if (!cfg.url) throw new Error(`mcp ${name}: http 需要 url`);
      return new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
      });
  }
}

/** 用官方 MCP SDK 连接一个 server，返回最小客户端接口。 */
export const connectMcp: McpConnectFn = async (name, cfg): Promise<McpClientLike> => {
  const client = new Client({ name: `aiop:${name}`, version: '0.1.0' });
  await client.connect(makeTransport(name, cfg));

  return {
    async listTools() {
      const res = await client.listTools();
      return {
        tools: res.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        })),
      };
    },
    async callTool(params) {
      const res = await client.callTool(params);
      return {
        content: (res.content ?? []) as McpCallResult['content'],
        isError: res.isError === true,
      };
    },
    async close() {
      await client.close();
    },
  };
};
