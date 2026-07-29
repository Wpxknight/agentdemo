import type { JsonValue, ToolResult } from '../llm/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import type { SandboxManagerLike } from '@aiop/sandbox-runtime';
import { isSandboxAcquirer, type SpecResolver } from '@aiop/sandbox-runtime';
import { sandboxIdentityKey, sandboxIdentityMetadata } from '@aiop/sandbox-runtime';
import { createSandboxToolDefinitions, downloadAcquiredSandbox, executeAcquiredSandbox, uploadAcquiredSandbox } from '@aiop/sandbox-runtime';
import type { SandboxSpec } from '@aiop/sandbox-runtime';

export type { SpecResolver } from '@aiop/sandbox-runtime';

/** 默认：每个租户用户会话一个沙箱。 */
const defaultResolver: SpecResolver = (ctx) => ({
  key: sandboxIdentityKey(ctx),
  metadata: sandboxIdentityMetadata(ctx),
});

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function reqString(o: Record<string, JsonValue>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必须是非空字符串`);
  return v;
}

export async function resolveSandboxSpec(resolve: SpecResolver, ctx: ToolContext): Promise<SandboxSpec> {
  const partial = await resolve(ctx);
  return {
    key: sandboxIdentityKey(ctx),
    ...partial,
    metadata: { ...sandboxIdentityMetadata(ctx), ...partial.metadata },
  };
}

/** 构造 E2B 沙箱内置工具：sbx__run_code / sbx__run_command。 */
export function buildSandboxTools(
  manager: SandboxManagerLike,
  resolve: SpecResolver = defaultResolver,
): ToolHandler[] {
  const acquire = async (ctx: ToolContext) => {
    if (isSandboxAcquirer(manager)) return manager.acquire(ctx);
    const spec = await resolveSandboxSpec(resolve, ctx);
    const handle = await manager.get(spec, { signal: ctx.signal });
    return { handle, spec, invalidate: () => manager.evict?.(spec.key, handle) };
  };
  const executeAdapter = async (
    name: 'sbx__run_code' | 'sbx__run_command',
    args: JsonValue,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const acquired = await acquire(ctx);
    const definitions = createSandboxToolDefinitions({
      runCode: (code, options) => executeAcquiredSandbox(acquired, { code, language: options.language, signal: options.signal, onOutput: ctx.onOutput }),
      runCommand: (command, options) => executeAcquiredSandbox(acquired, { command, signal: options.signal, onOutput: ctx.onOutput }),
      readFile: async (path, options) => (await downloadAcquiredSandbox(acquired, { path, signal: options.signal })).content,
      writeFile: (path, content, options) => uploadAcquiredSandbox(acquired, { file: { path, content }, signal: options.signal }),
      desktop: async () => { throw new Error('desktop calls require the desktop runtime'); },
    });
    const definition = definitions.find((candidate) => candidate.name === name)!;
    const output = await definition.execute({
      id: name,
      logicalCallId: name,
      name,
      arguments: args,
    }, {
      identity: {
        tenantId: ctx.tenantId ?? 'default',
        actorId: ctx.userId ?? 'anonymous',
        roles: ctx.role ? [ctx.role] : [],
      },
      runId: ctx.sessionId,
      attemptId: ctx.sessionId,
      turnNo: 0,
      idempotencyKey: `${ctx.sessionId}:${name}`,
      signal: ctx.signal,
    });
    return { id: '', content: output.content, isError: output.isError };
  };
  return [
    defineTool({
        name: 'sbx__run_code',
        capability: 'non_idempotent_write',
        description:
          '在隔离沙箱中执行代码（默认 Python），返回 stdout/stderr。可引用同会话先前定义的变量。',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '要执行的源代码' },
            language: {
              type: 'string',
              description: '语言，如 python / javascript；缺省 python',
            },
          },
          required: ['code'],
        },
      async execute(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const code = reqString(o, 'code');
        const language = typeof o.language === 'string' ? o.language : undefined;
        return executeAdapter('sbx__run_code', { code, ...(language ? { language } : {}) }, ctx);
      },
    }),
    defineTool({
        name: 'sbx__run_command',
        capability: 'non_idempotent_write',
        description: '在隔离沙箱中执行 shell 命令，返回 stdout/stderr 与退出码。',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
          },
          required: ['command'],
        },
      async execute(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const command = reqString(o, 'command');
        return executeAdapter('sbx__run_command', { command }, ctx);
      },
    }),
  ];
}
