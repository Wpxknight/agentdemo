import { describe, expect, it, vi } from 'vitest';
import {
  McpManager,
  McpRuntime,
  type McpClientLike,
  type McpConnectFn,
} from '../../packages/mcp-runtime/src/index.js';

const identity = (tenantId: string) => ({ tenantId, actorId: `${tenantId}-user`, roles: ['user'] });

function client(label: string): McpClientLike {
  return {
    listTools: vi.fn(async () => ({
      tools: [{ name: 'whoami', inputSchema: { type: 'object' } }],
    })),
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: label }] })),
    close: vi.fn(async () => undefined),
  };
}

describe('MCP multi-tenant isolation', () => {
  it('resolves manager tools with the request identity and returns governed definitions only', async () => {
    const connections: string[] = [];
    const manager = new McpManager({
      shared: { transport: 'http', url: 'https://mcp.example', toolCapabilities: { whoami: 'read' } },
    }, async (_name, _config, context) => {
      connections.push(context.identity.tenantId);
      return client(context.identity.tenantId);
    });
    const tenantA = identity('tenant-a');
    const tenantB = identity('tenant-b');

    await manager.start(tenantA);
    const [toolA] = await manager.tools(tenantA);
    await manager.start(tenantB);
    const [toolB] = await manager.tools(tenantB);

    expect(connections).toEqual(['tenant-a', 'tenant-b']);
    expect(toolA).not.toHaveProperty('def');
    expect(toolA).not.toHaveProperty('run');
    await expect(toolA!.execute({
      id: 'a', logicalCallId: 'a', name: toolA!.name, arguments: {},
    }, {
      identity: tenantA, runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      idempotencyKey: 'a',
    })).resolves.toMatchObject({ content: 'tenant-a' });
    await expect(toolB!.execute({
      id: 'b', logicalCallId: 'b', name: toolB!.name, arguments: {},
    }, {
      identity: tenantB, runId: 'run-b', attemptId: 'attempt-b', turnNo: 1,
      idempotencyKey: 'b',
    })).resolves.toMatchObject({ content: 'tenant-b' });
  });

  it('never shares credentials, clients, or resolved tools across tenants', async () => {
    const connections: Array<{ tenantId: string; authorization?: string }> = [];
    const connect: McpConnectFn = vi.fn(async (_name, _config, context) => {
      connections.push({
        tenantId: context.identity.tenantId,
        authorization: context.credentials.headers?.authorization,
      });
      return client(`${context.identity.tenantId}:${context.credentials.headers?.authorization}`);
    });
    const runtime = new McpRuntime({
      connect,
      credentials: {
        resolve: async ({ tenantId }) => ({ headers: { authorization: `Bearer ${tenantId}` } }),
      },
    });
    runtime.configure(identity('tenant-a'), {
      shared: { transport: 'http', url: 'https://mcp.example' },
    });
    runtime.configure(identity('tenant-b'), {
      shared: { transport: 'http', url: 'https://mcp.example' },
    });

    const [tenantATools, tenantBTools] = await Promise.all([
      runtime.discover(identity('tenant-a')),
      runtime.discover(identity('tenant-b')),
    ]);
    await expect(tenantATools[0]!.execute({
      id: 'a', logicalCallId: 'a', name: tenantATools[0]!.name, arguments: {},
    }, {
      identity: identity('tenant-a'), runId: 'r-a', attemptId: 'a-a', turnNo: 1,
      idempotencyKey: 'a',
    })).resolves.toMatchObject({ content: 'tenant-a:Bearer tenant-a' });
    await expect(tenantBTools[0]!.execute({
      id: 'b', logicalCallId: 'b', name: tenantBTools[0]!.name, arguments: {},
    }, {
      identity: identity('tenant-b'), runId: 'r-b', attemptId: 'a-b', turnNo: 1,
      idempotencyKey: 'b',
    })).resolves.toMatchObject({ content: 'tenant-b:Bearer tenant-b' });

    expect(connections).toEqual([
      { tenantId: 'tenant-a', authorization: 'Bearer tenant-a' },
      { tenantId: 'tenant-b', authorization: 'Bearer tenant-b' },
    ]);
    await runtime.discover(identity('tenant-a'));
    expect(connect).toHaveBeenCalledTimes(2);
    await expect(tenantATools[0]!.execute({
      id: 'leak', logicalCallId: 'leak', name: tenantATools[0]!.name, arguments: {},
    }, {
      identity: identity('tenant-b'), runId: 'r', attemptId: 'a', turnNo: 1,
      idempotencyKey: 'leak',
    })).rejects.toThrow('tenant identity mismatch');
  });

  it('never reuses the first actor credentials for another actor in the same tenant', async () => {
    const connections: string[] = [];
    const runtime = new McpRuntime({
      connect: async (_name, _config, context) => {
        connections.push(`${context.identity.actorId}:${context.credentials.headers?.authorization}`);
        return client(String(context.credentials.headers?.authorization));
      },
      credentials: {
        resolve: async ({ actorId }) => ({ headers: { authorization: `Bearer ${actorId}` } }),
      },
    });
    const actorA = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] };
    const actorB = { tenantId: 'tenant-a', actorId: 'user-b', roles: ['user'] };
    await runtime.configure(actorA, { shared: { transport: 'http', url: 'https://mcp.example' } });
    await runtime.configure(actorB, { shared: { transport: 'http', url: 'https://mcp.example' } });

    const [toolA] = await runtime.discover(actorA);
    const [toolB] = await runtime.discover(actorB);
    await expect(toolA!.execute({ id: 'a', logicalCallId: 'a', name: toolA!.name, arguments: {} }, {
      identity: actorA, runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
      idempotencyKey: 'actor-a',
    })).resolves.toMatchObject({ content: 'Bearer user-a' });
    await expect(toolB!.execute({ id: 'b', logicalCallId: 'b', name: toolB!.name, arguments: {} }, {
      identity: actorB, runId: 'run-b', attemptId: 'attempt-b', turnNo: 1,
      idempotencyKey: 'actor-b',
    })).resolves.toMatchObject({ content: 'Bearer user-b' });
    expect(connections).toEqual(['user-a:Bearer user-a', 'user-b:Bearer user-b']);
  });

  it('shares tenant server configuration changes without sharing actor clients or credentials', async () => {
    const connections: string[] = [];
    const manager = new McpManager({
      shared: { transport: 'http', url: 'https://mcp.example/shared' },
    }, async (name, _config, context) => {
      connections.push(`${context.identity.actorId}:${name}`);
      return client(`${context.identity.actorId}:${name}`);
    }, {
      credentials: { resolve: async ({ actorId }) => ({ headers: { authorization: `Bearer ${actorId}` } }) },
    });
    const actorA = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['tenant_admin'] };
    const actorB = { tenantId: 'tenant-a', actorId: 'user-b', roles: ['user'] };
    await manager.tools(actorA);
    await manager.tools(actorB);

    await manager.add(actorA, 'extra', { transport: 'http', url: 'https://mcp.example/extra' });
    expect((await manager.list(actorB)).map((server) => server.name).sort()).toEqual(['extra', 'shared']);
    const extraB = (await manager.tools(actorB)).find((tool) => tool.name === 'mcp__extra__whoami');
    await expect(extraB!.execute({ id: 'extra-b', logicalCallId: 'extra-b', name: extraB!.name, arguments: {} }, {
      identity: actorB, runId: 'run-extra-b', attemptId: 'attempt-extra-b', turnNo: 1,
      idempotencyKey: 'extra-b',
    })).resolves.toMatchObject({ content: 'user-b:extra' });

    await manager.remove(actorA, 'shared');
    expect((await manager.list(actorB)).map((server) => server.name)).toEqual(['extra']);
    expect(connections).toContain('user-b:extra');
  });

  it('does not let a delayed actor initialization restore an obsolete tenant snapshot', async () => {
    let releaseActorB!: () => void;
    const actorBMayLoad = new Promise<void>((resolve) => { releaseActorB = resolve; });
    const manager = new McpManager({}, async (name) => client(name), {
      loadConfigs: async ({ actorId }) => {
        if (actorId === 'user-b') await actorBMayLoad;
        return { old: { transport: 'http', url: 'https://mcp.example/old' } };
      },
    });
    const actorA = { tenantId: 'tenant-a', actorId: 'user-a', roles: ['tenant_admin'] };
    const actorB = { tenantId: 'tenant-a', actorId: 'user-b', roles: ['user'] };
    await manager.list(actorA);
    const delayedActorB = manager.list(actorB);
    await Promise.resolve();
    await manager.add(actorA, 'new', { transport: 'http', url: 'https://mcp.example/new' });
    releaseActorB();
    await delayedActorB;

    expect((await manager.list(actorA)).map((server) => server.name).sort()).toEqual(['new', 'old']);
    expect((await manager.list(actorB)).map((server) => server.name).sort()).toEqual(['new', 'old']);
  });

  it('reuses a tenant/server connection and closes it when configuration changes', async () => {
    const first = client('first');
    const second = client('second');
    const connect = vi.fn<McpConnectFn>(async (_name, config) => (
      config.url?.endsWith('/v1') ? first : second
    ));
    const runtime = new McpRuntime({ connect });
    const tenant = identity('tenant-a');
    runtime.configure(tenant, { api: { transport: 'http', url: 'https://mcp.example/v1' } });

    await runtime.discover(tenant);
    await runtime.discover(tenant);
    expect(connect).toHaveBeenCalledTimes(1);

    await runtime.configure(tenant, {
      api: { transport: 'http', url: 'https://mcp.example/v2' },
    });
    expect(first.close).toHaveBeenCalledOnce();
    await runtime.discover(tenant);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('treats nested credential/header changes as connection-invalidating configuration', async () => {
    const first = client('first');
    const second = client('second');
    let calls = 0;
    const runtime = new McpRuntime({
      connect: vi.fn(async () => (++calls === 1 ? first : second)),
    });
    const tenant = identity('tenant-a');
    runtime.configure(tenant, {
      api: {
        transport: 'http', url: 'https://mcp.example',
        headers: { authorization: 'Bearer old' },
      },
    });
    await runtime.discover(tenant);

    await runtime.configure(tenant, {
      api: {
        transport: 'http', url: 'https://mcp.example',
        headers: { authorization: 'Bearer new' },
      },
    });

    expect(first.close).toHaveBeenCalledOnce();
    await runtime.discover(tenant);
    expect(calls).toBe(2);
  });
});
