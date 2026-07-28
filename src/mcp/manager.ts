import { logger } from '../logger.js';
import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolHandler } from '../agent/tools.js';
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
  generation: number;
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
      this.servers.set(name, { config: cfg, status: 'error', handlers: [], generation: 0 });
    }
  }

  /** 连接全部 server 并构建工具列表；单个 server 失败不影响其他。 */
  async start(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.connectServer(name)));
  }

  private async connectServer(name: string, reservedGeneration?: number): Promise<ServerState> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`mcp server 不存在: ${name}`);
    const generation = reservedGeneration ?? ++state.generation;
    let client: McpClientLike | undefined;
    try {
      client = await this.connect(name, state.config);
      const { tools } = await client.listTools();
      if (this.servers.get(name) !== state || state.generation !== generation) {
        await client.close().catch(() => {});
        return state;
      }
      const connectedClient = client;
      state.client = client;
      state.handlers = tools.map((t) => this.makeHandler(name, state.config, connectedClient, t));
      state.status = 'connected';
      state.error = undefined;
      state.connectedAt = new Date().toISOString();
      log.info({ server: name, tools: tools.length }, 'mcp server connected');
    } catch (err) {
      await client?.close().catch(() => {});
      if (this.servers.get(name) !== state || state.generation !== generation) return state;
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
    config: McpServerConfig,
    client: McpClientLike,
    tool: import('./types.js').McpToolInfo,
  ): ToolHandler {
    return defineTool({
        name: mcpToolName(server, tool.name),
        description: tool.description ?? `MCP 工具 ${tool.name}（来自 ${server}）`,
        inputSchema: tool.inputSchema,
        capability: mcpCapability(config, tool),
      async execute(args: JsonValue): Promise<ToolResult> {
        const argObj =
          args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const res = await client.callTool({ name: tool.name, arguments: argObj });
        return {
          id: '',
          content: textFromContent(res.content),
          isError: res.isError,
        };
      },
    });
  }

  /** 新增 server 并连接；连接失败时保留 error 状态（可 reconnect），不抛异常。 */
  async add(name: string, config: McpServerConfig): Promise<McpServerInfo> {
    if (this.servers.has(name)) throw new Error(`mcp server 已存在: ${name}`);
    this.servers.set(name, { config, status: 'error', handlers: [], generation: 0 });
    await this.connectServer(name);
    return this.info(name)!;
  }

  /** 移除 server：断开连接并丢弃其工具。返回是否存在。 */
  async remove(name: string): Promise<boolean> {
    const state = this.servers.get(name);
    if (!state) return false;
    state.generation += 1;
    this.servers.delete(name);
    await state.client?.close().catch(() => {});
    return true;
  }

  /** 断开并重连一个 server（配置不变）。 */
  async reconnect(name: string): Promise<McpServerInfo> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`mcp server 不存在: ${name}`);
    const generation = ++state.generation;
    const previousClient = state.client;
    state.client = undefined;
    state.handlers = [];
    await previousClient?.close().catch(() => {});
    if (this.servers.get(name) !== state || state.generation !== generation) {
      const current = this.info(name);
      if (!current) throw new Error(`mcp server 不存在: ${name}`);
      return current;
    }
    await this.connectServer(name, generation);
    const current = this.info(name);
    if (!current) throw new Error(`mcp server 不存在: ${name}`);
    return current;
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
    for (const state of this.servers.values()) state.generation += 1;
    await Promise.all(
      [...this.servers.values()].map((s) => s.client?.close().catch(() => {})),
    );
    this.servers.clear();
  }
}

function mcpCapability(
  config: McpServerConfig,
  tool: import('./types.js').McpToolInfo,
): 'read' | 'retryable_write' | 'non_idempotent_write' {
  const configured = config.toolCapabilities?.[tool.name];
  if (configured) return configured;
  const annotated = tool.annotations?.readOnlyHint === true
    ? 'read'
    : tool.annotations?.idempotentHint === true && tool.annotations.readOnlyHint === false
      ? 'retryable_write'
      : 'non_idempotent_write';
  return moreRestrictive('non_idempotent_write', annotated);
}

const CAPABILITY_RESTRICTION = {
  read: 0,
  retryable_write: 1,
  non_idempotent_write: 2,
} as const;

function moreRestrictive<T extends keyof typeof CAPABILITY_RESTRICTION>(left: T, right: T): T {
  return CAPABILITY_RESTRICTION[left] >= CAPABILITY_RESTRICTION[right] ? left : right;
}
