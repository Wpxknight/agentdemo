import { randomUUID } from 'node:crypto';
import type { IdentityContext, JsonValue, ToolCapability, ToolCall, ToolExecutionContext } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from '@aiop/pi-runtime';
import { connectMcp } from './client.js';
import type {
  McpAuditEvent,
  McpCallResult,
  McpClientLike,
  McpCredentials,
  McpRuntimeOptions,
  McpServerConfig,
  McpServerInfo,
  McpToolInfo,
} from './types.js';

interface ServerState {
  config: McpServerConfig;
  fingerprint: string;
  generation: number;
  client?: McpClientLike;
  connecting?: Promise<McpClientLike>;
  tools?: McpToolInfo[];
  status: 'connected' | 'error';
  error?: string;
  connectedAt?: string;
}

export class McpTimeoutError extends Error {}
export class McpDisconnectedError extends Error {}

export class McpRuntime {
  private readonly tenants = new Map<string, Map<string, ServerState>>();
  private readonly tenantConfigs = new Map<string, Record<string, McpServerConfig>>();
  private readonly connect;

  constructor(private readonly options: McpRuntimeOptions) {
    this.connect = options.connect ?? connectMcp;
  }

  configure(
    identity: IdentityContext,
    configs: Record<string, McpServerConfig>,
  ): Promise<void> {
    this.tenantConfigs.set(identity.tenantId, structuredClone(configs));
    const scope = identityScope(identity);
    const current = this.tenants.get(scope) ?? new Map<string, ServerState>();
    this.tenants.set(scope, current);
    const closing: Promise<void>[] = [];
    for (const states of this.tenantStates(identity.tenantId)) {
      for (const [name, state] of states) {
        const config = configs[name];
        if (!config || fingerprint(config) !== state.fingerprint) {
          states.delete(name);
          state.generation += 1;
          if (state.client) closing.push(closeQuietly(state.client));
        }
      }
      for (const [name, config] of Object.entries(configs)) {
        if (!states.has(name)) states.set(name, newServerState(config));
      }
    }
    return Promise.all(closing).then(() => undefined);
  }

  async discover(identity: IdentityContext): Promise<GovernedToolDefinition[]> {
    const states = this.ensureScope(identity);
    const output: GovernedToolDefinition[] = [];
    for (const [server, state] of states) {
      try {
        const tools = state.tools ?? await this.listWithReconnect(identity, server, state);
        for (const tool of tools) {
          if (this.options.visible && !this.options.visible(identity, server, tool)) continue;
          output.push(this.adaptTool(identity, server, state, tool));
        }
      } catch (error) {
        state.status = 'error';
        state.error = safeMessage(error);
      }
    }
    return output;
  }

  async invoke(
    name: string,
    argumentsValue: JsonValue,
    identity: IdentityContext,
    options: { idempotencyKey?: string } = {},
  ): Promise<{ content: string }> {
    const tools = await this.discover(identity);
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error('MCP tool is not visible');
    if (!this.options.governance) throw new Error('MCP invoke requires an injected governance runtime');
    const logicalCallId = options.idempotencyKey ?? randomUUID();
    const call = { id: logicalCallId, logicalCallId, name, arguments: argumentsValue };
    const outcome = await this.options.governance(tools).execute(call, {
        identity, runId: `mcp-direct:${identity.actorId}:${logicalCallId}`, attemptId: logicalCallId, turnNo: 0,
      });
    if (outcome.kind === 'result') {
      if (outcome.result.isError) throw new Error(outcome.result.content);
      return { content: outcome.result.content };
    }
    throw new Error(outcome.kind === 'waiting'
      ? `MCP tool is waiting for ${outcome.reason}`
      : outcome.message);
  }

  async reconnect(identity: IdentityContext, server: string): Promise<McpServerInfo> {
    const state = this.requireState(identity, server);
    await this.invalidate(state);
    try {
      await this.listWithReconnect(identity, server, state);
    } catch (error) {
      state.status = 'error';
      state.error = safeMessage(error);
    }
    return this.info(identity, server)!;
  }

  async add(identity: IdentityContext, server: string, config: McpServerConfig): Promise<McpServerInfo> {
    this.ensureScope(identity);
    if (this.tenantStates(identity.tenantId).some((candidate) => candidate.has(server))) {
      throw new Error(`mcp server 已存在: ${server}`);
    }
    const configs = this.tenantConfigs.get(identity.tenantId) ?? {};
    this.tenantConfigs.set(identity.tenantId, { ...configs, [server]: structuredClone(config) });
    for (const candidate of this.tenantStates(identity.tenantId)) candidate.set(server, newServerState(config));
    await this.discover(identity);
    return this.info(identity, server)!;
  }

  async remove(identity: IdentityContext, server: string): Promise<boolean> {
    this.ensureScope(identity);
    let removed = false;
    const closing: Promise<void>[] = [];
    for (const states of this.tenantStates(identity.tenantId)) {
      const state = states.get(server);
      if (!state) continue;
      removed = true;
      states.delete(server);
      state.generation += 1;
      if (state.client) closing.push(closeQuietly(state.client));
    }
    await Promise.all(closing);
    const configs = this.tenantConfigs.get(identity.tenantId);
    if (configs && server in configs) {
      const next = { ...configs };
      delete next[server];
      this.tenantConfigs.set(identity.tenantId, next);
    }
    return removed;
  }

  info(identity: IdentityContext, server: string): McpServerInfo | undefined {
    const state = this.ensureScope(identity).get(server);
    if (!state) return undefined;
    return {
      name: server,
      transport: state.config.transport,
      command: state.config.command,
      args: state.config.args,
      url: state.config.url,
      status: state.status,
      error: state.error,
      connectedAt: state.connectedAt,
      tools: (state.tools ?? []).map((tool) => mcpToolName(server, tool.name)),
    };
  }

  list(identity: IdentityContext): McpServerInfo[] {
    return [...this.ensureScope(identity).keys()]
      .map((server) => this.info(identity, server)!);
  }

  configs(identity: IdentityContext): Record<string, McpServerConfig> {
    this.ensureScope(identity);
    return structuredClone(this.tenantConfigs.get(identity.tenantId) ?? {});
  }

  async close(): Promise<void> {
    for (const states of this.tenants.values()) {
      for (const state of states.values()) state.generation += 1;
    }
    const clients = [...this.tenants.values()].flatMap((states) =>
      [...states.values()].flatMap((state) => state.client ? [state.client] : []));
    this.tenants.clear();
    this.tenantConfigs.clear();
    await Promise.all(clients.map(closeQuietly));
  }

  private async listWithReconnect(
    identity: IdentityContext,
    server: string,
    state: ServerState,
  ): Promise<McpToolInfo[]> {
    return this.withReconnect(identity, server, state, 'discovery', async (client) => {
      const response = await withTimeout(
        client.listTools(), state.config.timeoutMs ?? 30_000,
        `MCP ${server} discovery timeout`,
      );
      state.tools = response.tools;
      return response.tools;
    });
  }

  private adaptTool(
    identity: IdentityContext,
    server: string,
    state: ServerState,
    tool: McpToolInfo,
  ): GovernedToolDefinition {
    const capability = capabilityFor(state.config, tool);
    return {
      name: mcpToolName(server, tool.name),
      description: tool.description ?? `MCP tool ${tool.name} from ${server}`,
      inputSchema: tool.inputSchema,
      capability,
      execute: (call, context) => this.executeTool(identity, server, state, tool, capability, call, context),
    };
  }

  private async executeTool(
    resolvedIdentity: IdentityContext,
    server: string,
    state: ServerState,
    tool: McpToolInfo,
    capability: ToolCapability,
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<{ content: string; isError?: boolean }> {
    if (identityScope(context.identity) !== identityScope(resolvedIdentity)) {
      throw new Error('MCP tenant identity mismatch');
    }
    const startedAt = Date.now();
    let ok = false;
    let errorMessage: string | undefined;
    try {
      const result = await this.withReconnect(
        resolvedIdentity, server, state, 'call',
        async (client) => withTimeout(
          client.callTool({ name: tool.name, arguments: objectArguments(call.arguments) }),
          state.config.timeoutMs ?? 30_000,
          `MCP ${server}/${tool.name} timeout`,
        ),
        capability !== 'non_idempotent_write',
      );
      ok = !result.isError;
      return { content: textFromContent(result.content), isError: result.isError === true };
    } catch (error) {
      errorMessage = auditError(error);
      throw error;
    } finally {
      const event: McpAuditEvent = {
        tenantId: context.identity.tenantId,
        actorId: context.identity.actorId,
        server,
        tool: tool.name,
        ok,
        durationMs: Date.now() - startedAt,
        ...(errorMessage ? { error: errorMessage } : {}),
      };
      await Promise.resolve(this.options.audit?.record(event)).catch(() => undefined);
    }
  }

  private async withReconnect<T>(
    identity: IdentityContext,
    server: string,
    state: ServerState,
    operation: 'discovery' | 'call',
    run: (client: McpClientLike) => Promise<T>,
    retrySafe = true,
  ): Promise<T> {
    const policy = state.config.reconnect;
    const maxAttempts = Math.max(0, policy?.maxAttempts ?? 0);
    let attempt = 0;
    while (true) {
      try {
        return await run(await this.ensureConnected(identity, server, state));
      } catch (error) {
        const timeout = error instanceof McpTimeoutError;
        const disconnected = error instanceof McpDisconnectedError || looksDisconnected(error);
        const allowed = retrySafe && attempt < maxAttempts && (
          timeout && policy?.retryOnTimeout === true
          || disconnected && policy?.retryOnDisconnect === true
        );
        if (!allowed) throw error;
        attempt += 1;
        await this.invalidate(state);
        if ((policy?.backoffMs ?? 0) > 0) await delay(policy!.backoffMs!);
        if (operation === 'call') state.tools = undefined;
      }
    }
  }

  private async ensureConnected(
    identity: IdentityContext,
    server: string,
    state: ServerState,
  ): Promise<McpClientLike> {
    if (state.client) return state.client;
    if (state.connecting) return state.connecting;
    const generation = ++state.generation;
    let valid = true;
    const connecting = (async () => {
      const credentials: McpCredentials = await this.options.credentials?.resolve(identity, server) ?? {};
      const pendingClient = this.connect(server, state.config, { identity, credentials });
      const guardedClient = pendingClient.then(async (client) => {
        if (!valid || state.generation !== generation) {
          await closeQuietly(client);
          throw new McpDisconnectedError(`MCP ${server} connection superseded`);
        }
        return client;
      });
      const client = await withTimeout(
        guardedClient, state.config.timeoutMs ?? 30_000, `MCP ${server} connection timeout`,
      );
      state.client = client;
      state.status = 'connected';
      state.error = undefined;
      state.connectedAt = new Date().toISOString();
      return client;
    })();
    state.connecting = connecting;
    try {
      return await connecting;
    } catch (error) {
      valid = false;
      if (error instanceof McpTimeoutError && state.generation === generation) {
        state.generation += 1;
      }
      state.status = 'error';
      state.error = safeMessage(error);
      throw error;
    } finally {
      if (state.connecting === connecting) state.connecting = undefined;
    }
  }

  private async invalidate(state: ServerState): Promise<void> {
    state.generation += 1;
    const client = state.client;
    state.client = undefined;
    state.connecting = undefined;
    state.tools = undefined;
    state.status = 'error';
    if (client) await closeQuietly(client);
  }

  private requireState(identity: IdentityContext, server: string): ServerState {
    const state = this.ensureScope(identity).get(server);
    if (!state) throw new Error(`mcp server 不存在: ${server}`);
    return state;
  }

  private tenantStates(tenantId: string): Map<string, ServerState>[] {
    const prefix = `${tenantId}\0`;
    return [...this.tenants.entries()].filter(([scope]) => scope.startsWith(prefix)).map(([, states]) => states);
  }

  private ensureScope(identity: IdentityContext): Map<string, ServerState> {
    const scope = identityScope(identity);
    const existing = this.tenants.get(scope);
    if (existing) return existing;
    const states = new Map<string, ServerState>();
    for (const [name, config] of Object.entries(this.tenantConfigs.get(identity.tenantId) ?? {})) {
      states.set(name, newServerState(config));
    }
    this.tenants.set(scope, states);
    return states;
  }

}

function identityScope(identity: IdentityContext): string {
  return `${identity.tenantId}\0${identity.actorId}`;
}

function newServerState(config: McpServerConfig): ServerState {
  return { config: structuredClone(config), fingerprint: fingerprint(config), generation: 0, status: 'error' };
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function capabilityFor(config: McpServerConfig, tool: McpToolInfo): ToolCapability {
  return config.toolCapabilities?.[tool.name] ?? 'non_idempotent_write';
}

function objectArguments(value: JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textFromContent(content: McpCallResult['content']): string {
  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!);
  return text.join('\n') || '(no text content)';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fingerprint(config: McpServerConfig): string {
  return JSON.stringify(sortJson(config));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function looksDisconnected(error: unknown): boolean {
  return /disconnect|socket closed|connection closed|econnreset|econnrefused|broken pipe/i.test(safeMessage(error));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function auditError(error: unknown): string {
  if (error instanceof McpTimeoutError) return 'timeout';
  if (error instanceof McpDisconnectedError || looksDisconnected(error)) return 'disconnected';
  return 'mcp_error';
}

async function closeQuietly(client: McpClientLike): Promise<void> {
  await client.close().catch(() => undefined);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
