import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  GovernedToolFactory,
  UnifiedToolRegistry,
  type ToolLedgerStore,
} from '../../packages/pi-runtime/src/index.js';
import { ToolRegistry, defineTool } from '../../src/agent/tools.js';
import { McpManager } from '../../src/mcp/manager.js';
import { buildAskUserTool } from '../../src/tools/ask-user.js';
import { buildSandboxTools } from '../../src/tools/builtin.js';
import { buildTodoTool } from '../../src/tools/todo.js';
import { buildWebFetchTool } from '../../src/tools/webfetch.js';

const context = {
  identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
  runId: 'run-a', attemptId: 'attempt-a', turnNo: 1,
} as const;

const ledger = (): ToolLedgerStore => {
  const records = new Map<string, Parameters<ToolLedgerStore['putIfAbsent']>[0]>();
  return {
    putIfAbsent: async (record) => {
      if (records.has(record.logicalCallId)) return false;
      records.set(record.logicalCallId, structuredClone(record));
      return true;
    },
    get: async ({ logicalCallId }) => structuredClone(records.get(logicalCallId)),
    update: async (record) => { records.set(record.logicalCallId, structuredClone(record)); },
    claimPendingApproval: async (input) => {
      const current = records.get(input.logicalCallId);
      if (!current || current.status !== 'pending_approval'
        || current.approvedInteractionId !== input.approvedInteractionId) return false;
      records.set(input.logicalCallId, structuredClone(input.started));
      return true;
    },
  };
};

const piRead = (): AgentTool => ({
  name: 'read', label: 'read', description: 'Pi read', parameters: { type: 'object' },
  execute: async () => ({ content: [{ type: 'text', text: 'pi-read' }], details: undefined }),
} as AgentTool);

describe('real unified tool sources', () => {
  it('product builders expose governed/Pi-compatible definitions as their source of truth', () => {
    expect(buildAskUserTool()).toMatchObject({
      name: 'ask_user', capability: 'read', inputSchema: expect.any(Object), execute: expect.any(Function),
    });
    expect(buildWebFetchTool()).toMatchObject({
      name: 'web_fetch', capability: 'read', execute: expect.any(Function),
    });
    expect(buildTodoTool()).toMatchObject({
      name: 'todo_write', capability: 'retryable_write', execute: expect.any(Function),
    });
  });

  it('executes Pi, AIoP, MCP, and Sandbox tools from one real registry through governance', async () => {
    const mcpCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'mcp-ok' }] }));
    const mcp = new McpManager({
      demo: {
        transport: 'http',
        url: 'https://mcp.example',
        toolCapabilities: { example: 'read' },
      },
    }, async () => ({
      listTools: async () => ({ tools: [{
        name: 'example', description: 'example', inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      }] }),
      callTool: mcpCall,
      close: async () => undefined,
    }));
    await mcp.start();
    const sandboxRun = vi.fn(async () => ({ stdout: 'sandbox-ok', exitCode: 0 }));
    const sandboxTools = buildSandboxTools({
      get: async () => ({ runCode: sandboxRun, runCommand: sandboxRun }),
    } as never);
    const answers = vi.fn(async () => ({ Continue: ['Yes'] }));
    const products = new ToolRegistry()
      .register(buildAskUserTool(), 'aiop')
      .register(mcp.tools()[0]!, 'mcp')
      .register(sandboxTools[0]!, 'sandbox');
    const registry = products.unified({ sessionId: 'session-a', askUser: answers })
      .registerPi(piRead(), 'read');
    const runtime = new GovernedToolFactory({ ledger: ledger() }).create(registry.definitions());

    expect(registry.names()).toEqual(expect.arrayContaining([
      'read', 'ask_user', 'mcp__demo__example', 'sbx__run_code',
    ]));
    const execute = (name: string, argumentsValue: import('@aiop/control-contracts').JsonValue, index: number) => runtime.execute({
      id: `call-${index}`, logicalCallId: `logical-${index}`, name, arguments: argumentsValue,
    }, { ...context, runId: `run-${index}` });
    await expect(execute('read', {}, 1)).resolves.toMatchObject({ result: { content: 'pi-read' } });
    await expect(execute('ask_user', {
      questions: [{ question: 'Continue', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }, 2)).resolves.toMatchObject({ result: { content: expect.stringContaining('Yes') } });
    await expect(execute('mcp__demo__example', {}, 3)).resolves.toMatchObject({ result: { content: 'mcp-ok' } });
    await expect(execute('sbx__run_code', { code: 'print(1)' }, 4)).resolves.toMatchObject({
      result: { content: 'sandbox-ok' },
    });
    expect(mcpCall).toHaveBeenCalledOnce();
    expect(sandboxRun).toHaveBeenCalledOnce();
  });

  it('preserves explicit capabilities for real sources and rejects conflicts at assembly', async () => {
    const mcp = new McpManager({
      demo: {
        transport: 'http',
        url: 'https://mcp.example',
        toolCapabilities: { read: 'read', mutate: 'retryable_write' },
      },
    }, async () => ({
      listTools: async () => ({ tools: [
        { name: 'read', inputSchema: {}, annotations: { readOnlyHint: true } },
        { name: 'mutate', inputSchema: {}, annotations: { readOnlyHint: false, idempotentHint: true } },
      ] }),
      callTool: async () => ({ content: [] }), close: async () => undefined,
    }));
    await mcp.start();
    expect(mcp.tools().map((tool) => [tool.name, tool.capability])).toEqual([
      ['mcp__demo__read', 'read'], ['mcp__demo__mutate', 'retryable_write'],
    ]);
    const registry = new ToolRegistry().register(buildAskUserTool());
    expect(() => registry.register({ ...buildAskUserTool() }, 'mcp')).toThrow('duplicate tool: ask_user');
  });

  it('rejects a duplicate Pi name in the unified registry', () => {
    const registry = new UnifiedToolRegistry().registerPi(piRead(), 'read');
    expect(() => registry.registerPi(piRead(), 'read')).toThrow('duplicate tool: read');
  });

  it('propagates the governed abort signal into product tool context', async () => {
    const received = vi.fn<(signal: AbortSignal | undefined) => void>();
    const registry = new ToolRegistry().register(defineTool({
      name: 'signal_probe', description: 'signal', inputSchema: {}, capability: 'read',
      execute: async (_args, toolContext) => {
        received(toolContext.signal);
        return { id: '', content: 'ok' };
      },
    })).unified({ sessionId: 'session-a' });
    const runtime = new GovernedToolFactory({ ledger: ledger() }).create(registry.definitions());
    const abort = new AbortController();

    await runtime.execute({
      id: 'call-signal', logicalCallId: 'logical-signal', name: 'signal_probe', arguments: {},
    }, { ...context, signal: abort.signal });

    expect(received).toHaveBeenCalledWith(abort.signal);
  });
});
