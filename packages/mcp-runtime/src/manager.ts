import type { IdentityContext, JsonValue, ToolCall, ToolExecutionContext } from '@aiop/control-contracts';
import { McpRuntime } from './runtime.js';
import type {
  McpConnectFn,
  McpLegacyTool,
  McpRuntimeOptions,
  McpServerConfig,
  McpServerInfo,
} from './types.js';

const DEFAULT_IDENTITY: IdentityContext = {
  tenantId: 'default', actorId: 'mcp-manager', roles: ['platform'],
};

export class McpManager {
  private readonly runtime: McpRuntime;
  private definitions: Awaited<ReturnType<McpRuntime['discover']>> = [];

  constructor(
    initial: Record<string, McpServerConfig>,
    connect: McpConnectFn,
    options: Omit<McpRuntimeOptions, 'connect'> = {},
  ) {
    this.runtime = new McpRuntime({ ...options, connect });
    void this.runtime.configure(DEFAULT_IDENTITY, initial);
  }

  async start(): Promise<void> {
    this.definitions = await this.runtime.discover(DEFAULT_IDENTITY);
  }

  async add(name: string, config: McpServerConfig): Promise<McpServerInfo> {
    const info = await this.runtime.add(DEFAULT_IDENTITY, name, config);
    this.definitions = await this.runtime.discover(DEFAULT_IDENTITY);
    return info;
  }

  async remove(name: string): Promise<boolean> {
    const removed = await this.runtime.remove(DEFAULT_IDENTITY, name);
    if (removed) this.definitions = await this.runtime.discover(DEFAULT_IDENTITY);
    return removed;
  }

  async reconnect(name: string): Promise<McpServerInfo> {
    const info = await this.runtime.reconnect(DEFAULT_IDENTITY, name);
    this.definitions = await this.runtime.discover(DEFAULT_IDENTITY);
    return info;
  }

  info(name: string): McpServerInfo | undefined {
    return this.runtime.info(DEFAULT_IDENTITY, name);
  }

  list(): McpServerInfo[] {
    return this.runtime.list(DEFAULT_IDENTITY);
  }

  configs(): Record<string, McpServerConfig> {
    return this.runtime.configs(DEFAULT_IDENTITY);
  }

  tools(): McpLegacyTool[] {
    return this.definitions.map((definition) => {
      const def = {
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        capability: definition.capability,
      };
      const run = async (
        argumentsValue: JsonValue,
        context: {
          tenantId?: string; userId?: string; role?: string; signal?: AbortSignal;
          [key: string]: unknown;
        },
      ) => {
        const call: ToolCall = {
          id: '', logicalCallId: '', name: definition.name, arguments: argumentsValue,
        };
        const executionContext: ToolExecutionContext & { idempotencyKey: string } = {
          identity: {
            tenantId: DEFAULT_IDENTITY.tenantId,
            actorId: context.userId ?? DEFAULT_IDENTITY.actorId,
            roles: [context.role ?? 'user'],
          },
          runId: 'legacy-mcp', attemptId: 'legacy-mcp', turnNo: 0,
          signal: context.signal, idempotencyKey: 'legacy-mcp',
        };
        const result = await definition.execute(call, executionContext);
        return { id: '', ...result };
      };
      return { ...def, execute: run, def, run };
    });
  }

  async close(): Promise<void> {
    await this.runtime.close();
    this.definitions = [];
  }
}
