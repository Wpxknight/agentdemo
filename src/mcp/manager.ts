import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolHandler } from '../agent/tools.js';
import type {
  McpClientLike,
  McpConnectFn,
  McpServerConfig,
} from './types.js';

const log = logger.child({ mod: 'mcp' });

/** 工具名命名空间：mcp__<server>__<tool>（与模型 API 合法字符集兼容）。 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function textFromContent(content: { type: string; text?: string }[]): string {
  const parts = content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  return parts.join('\n') || '(no text content)';
}

/**
 * 连接多个 MCP server，把其工具以 mcp__server__tool 暴露为 ToolHandler，
 * dispatch 时转调对应 server 的 callTool。
 */
export class McpManager {
  private clients = new Map<string, McpClientLike>();
  private handlers: ToolHandler[] = [];

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly connect: McpConnectFn,
  ) {}

  /** 连接全部 server 并构建工具列表；单个 server 失败不影响其他。 */
  async start(): Promise<void> {
    for (const [name, cfg] of Object.entries(this.servers)) {
      try {
        const client = await this.connect(name, cfg);
        this.clients.set(name, client);
        const { tools } = await client.listTools();
        for (const t of tools) this.handlers.push(this.makeHandler(name, client, t.name, t.description, t.inputSchema));
        log.info({ server: name, tools: tools.length }, 'mcp server connected');
      } catch (err) {
        log.error({ server: name, err: String(err) }, 'mcp server connect failed');
      }
    }
  }

  private makeHandler(
    server: string,
    client: McpClientLike,
    tool: string,
    description: string | undefined,
    inputSchema: Record<string, unknown>,
  ): ToolHandler {
    return {
      def: {
        name: mcpToolName(server, tool),
        description: description ?? `MCP 工具 ${tool}（来自 ${server}）`,
        inputSchema,
      },
      async run(args: JsonValue): Promise<ToolResult> {
        const argObj =
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const res = await client.callTool({ name: tool, arguments: argObj });
        return {
          id: '',
          content: textFromContent(res.content),
          isError: res.isError,
        };
      },
    };
  }

  tools(): ToolHandler[] {
    return this.handlers;
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
    this.clients.clear();
    this.handlers = [];
  }
}
