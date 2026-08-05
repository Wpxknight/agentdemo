import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpCallResult, McpClientLike, McpConnectFn, McpServerConfig } from './types.js';

function makeTransport(
  name: string,
  config: McpServerConfig,
  credentials: { headers?: Record<string, string>; env?: Record<string, string> },
): Transport {
  const headers = { ...config.headers, ...credentials.headers };
  switch (config.transport) {
    case 'stdio': {
      if (!config.command) throw new Error(`mcp ${name}: stdio 需要 command`);
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...inherited, ...config.env, ...credentials.env },
      });
    }
    case 'sse':
      if (!config.url) throw new Error(`mcp ${name}: sse 需要 url`);
      return new SSEClientTransport(new URL(config.url), {
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
    case 'http':
      if (!config.url) throw new Error(`mcp ${name}: http 需要 url`);
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
  }
}

export const connectMcp = async (
  name: string,
  config: McpServerConfig,
  context: Parameters<McpConnectFn>[2] = {
    identity: { tenantId: 'default', actorId: 'mcp-client', roles: ['platform'] },
    credentials: {},
  },
): Promise<McpClientLike> => {
  const client = new Client({ name: `aiop:${name}`, version: '0.1.0' });
  await client.connect(makeTransport(name, config, context.credentials));
  return {
    async listTools() {
      const response = await client.listTools();
      return {
        tools: response.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          annotations: tool.annotations,
        })),
      };
    },
    async callTool(params) {
      const response = await client.callTool(params);
      return {
        content: (response.content ?? []) as McpCallResult['content'],
        isError: response.isError === true,
      };
    },
    async close() {
      await client.close();
    },
  };
};
