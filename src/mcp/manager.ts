import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolHandler } from '../agent/tools.js';
import type {
  McpClientLike,
  McpConnectFn,
  McpServerConfig,
  McpServerInfo,
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

/** 单个 server 的运行态：配置 + 连接状态 + 已注册工具。 */
interface ServerState {
  config: McpServerConfig;
  status: 'connected' | 'error';
  error?: string;
  client?: McpClientLike;
  handlers: ToolHandler[];
  connectedAt?: string;
}

/**
 * 连接多个 MCP server，把其工具以 mcp__server__tool 暴露为 ToolHandler，
 * dispatch 时转调对应 server 的 callTool。
 * 支持运行期 add/remove/reconnect；连接失败的 server 保留为 error 状态供重连。
 */
export class McpManager {
  private servers = new Map<string, ServerState>();

  constructor(
    initial: Record<string, McpServerConfig>,
    private readonly connect: McpConnectFn,
  ) {
    for (const [name, cfg] of Object.entries(initial)) {
      this.servers.set(name, { config: cfg, status: 'error', handlers: [] });
    }
  }

  /** 连接全部 server 并构建工具列表；单个 server 失败不影响其他。 */
  async start(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.connectServer(name)));
  }

  private async connectServer(name: string): Promise<ServerState> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`mcp server 不存在: ${name}`);
    try {
      const client = await this.connect(name, state.config);
      const { tools } = await client.listTools();
      state.client = client;
      state.handlers = tools.map((t) => this.makeHandler(name, client, t.name, t.description, t.inputSchema));
      state.status = 'connected';
      state.error = undefined;
      state.connectedAt = new Date().toISOString();
      log.info({ server: name, tools: tools.length }, 'mcp server connected');
    } catch (err) {
      state.client = undefined;
      state.handlers = [];
      state.status = 'error';
      state.error = String(err);
      log.error({ server: name, err: String(err) }, 'mcp server connect failed');
    }
    return state;
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

  /** 新增 server 并连接；连接失败时保留 error 状态（可 reconnect），不抛异常。 */
  async add(name: string, config: McpServerConfig): Promise<McpServerInfo> {
    if (this.servers.has(name)) throw new Error(`mcp server 已存在: ${name}`);
    this.servers.set(name, { config, status: 'error', handlers: [] });
    await this.connectServer(name);
    return this.info(name)!;
  }

  /** 移除 server：断开连接并丢弃其工具。返回是否存在。 */
  async remove(name: string): Promise<boolean> {
    const state = this.servers.get(name);
    if (!state) return false;
    this.servers.delete(name);
    await state.client?.close().catch(() => {});
    return true;
  }

  /** 断开并重连一个 server（配置不变）。 */
  async reconnect(name: string): Promise<McpServerInfo> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`mcp server 不存在: ${name}`);
    await state.client?.close().catch(() => {});
    state.client = undefined;
    await this.connectServer(name);
    return this.info(name)!;
  }

  /** 单个 server 的公开信息（不含 headers 敏感值）。 */
  info(name: string): McpServerInfo | undefined {
    const state = this.servers.get(name);
    if (!state) return undefined;
    return {
      name,
      transport: state.config.transport,
      command: state.config.command,
      args: state.config.args,
      url: state.config.url,
      status: state.status,
      error: state.error,
      connectedAt: state.connectedAt,
      tools: state.handlers.map((h) => h.def.name),
    };
  }

  list(): McpServerInfo[] {
    return [...this.servers.keys()].map((name) => this.info(name)!);
  }

  /** 当前全部 server 配置（用于持久化）。 */
  configs(): Record<string, McpServerConfig> {
    return Object.fromEntries([...this.servers.entries()].map(([name, s]) => [name, s.config]));
  }

  tools(): ToolHandler[] {
    return [...this.servers.values()].flatMap((s) => s.handlers);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map((s) => s.client?.close().catch(() => {})),
    );
    this.servers.clear();
  }
}
