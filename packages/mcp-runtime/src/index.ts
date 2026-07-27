import type { IdentityContext, JsonValue, ToolDefinition } from '@aiop/agent-contracts';

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  idempotent?: boolean;
}

export interface McpClientPort {
  listTools(): Promise<readonly McpToolDescription[]>;
  callTool(name: string, argumentsValue: JsonValue): Promise<{ content: unknown }>;
  close(): Promise<void>;
}

export interface McpServerBinding {
  name: string;
  client: McpClientPort;
  visible?: (identity: IdentityContext) => boolean;
  timeoutMs?: number;
}

export interface McpAuditSink {
  record(event: { tenantId: string; actorId: string; server: string; tool: string; ok: boolean }): Promise<void>;
}

export class McpRuntime {
  private readonly tools = new Map<string, { server: McpServerBinding; tool: McpToolDescription }>();

  constructor(private readonly options: { servers: readonly McpServerBinding[]; audit?: McpAuditSink }) {}

  async discover(identity: IdentityContext): Promise<ToolDefinition[]> {
    const output: ToolDefinition[] = [];
    for (const server of this.options.servers) {
      if (server.visible && !server.visible(identity)) continue;
      const tools = await withTimeout(server.client.listTools(), server.timeoutMs ?? 30_000, `MCP ${server.name} discovery timeout`);
      for (const tool of tools) {
        const name = `mcp__${server.name}__${tool.name}`;
        this.tools.set(name, { server, tool });
        output.push({
          name,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema,
          capability: tool.readOnly ? 'read' : tool.idempotent ? 'retryable_write' : 'non_idempotent_write',
        });
      }
    }
    return output.sort((a, b) => a.name.localeCompare(b.name));
  }

  async invoke(name: string, argumentsValue: JsonValue, identity: IdentityContext): Promise<{ content: string }> {
    if (!this.tools.has(name)) await this.discover(identity);
    const binding = this.tools.get(name);
    if (!binding || binding.server.visible && !binding.server.visible(identity)) throw new Error('MCP tool is not visible');
    let ok = false;
    try {
      const response = await withTimeout(
        binding.server.client.callTool(binding.tool.name, argumentsValue),
        binding.server.timeoutMs ?? 30_000,
        `MCP ${binding.server.name}/${binding.tool.name} timeout`,
      );
      ok = true;
      return { content: normalizeContent(response.content) };
    } finally {
      await this.options.audit?.record({
        tenantId: identity.tenantId, actorId: identity.actorId,
        server: binding.server.name, tool: binding.tool.name, ok,
      });
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.options.servers.map((server) => server.client.close()));
    this.tools.clear();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
      return JSON.stringify(item);
    }).join('\n');
  }
  return JSON.stringify(content);
}
