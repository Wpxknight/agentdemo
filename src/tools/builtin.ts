import type { JsonValue, ToolResult } from '../llm/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import type { SandboxManagerLike } from '@aiop/sandbox-runtime';
import { isSandboxAcquirer, normalizeSandboxPlacement, type SandboxPlacementInput, type SpecResolver } from '@aiop/sandbox-runtime';
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

function optString(o: Record<string, JsonValue>, key: string): string | undefined {
  const value = o[key];
  return typeof value === 'string' && value ? value : undefined;
}

function placementFromArgs(o: Record<string, JsonValue>): SandboxPlacementInput | undefined {
  const keys = ['clusterName', 'clusterId', 'namespace'] as const;
  if (!keys.some((key) => o[key] !== undefined)) return undefined;
  for (const key of keys) if (o[key] !== undefined && typeof o[key] !== 'string') throw new Error(`参数 ${key} 必须是字符串`);
  return { clusterName: optString(o, 'clusterName'), clusterId: optString(o, 'clusterId'), namespace: optString(o, 'namespace') };
}

const placementProperties = {
  clusterName: { type: 'string', description: '目标 Kubernetes 集群名称；与 clusterId 二选一，不能猜测 ID' },
  clusterId: { type: 'string', description: '目标 Kubernetes 集群 ID；与 clusterName 二选一' },
  namespace: { type: 'string', description: '目标 namespace；省略时使用 aios-system', default: 'aios-system' },
} as const;

export async function resolveSandboxSpec(resolve: SpecResolver, ctx: ToolContext, placement?: SandboxPlacementInput): Promise<SandboxSpec> {
  const partial = await resolve(ctx, undefined, placement);
  if (placement !== undefined) normalizeSandboxPlacement(placement);
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
  const acquire = async (ctx: ToolContext, placement?: SandboxPlacementInput) => {
    if (isSandboxAcquirer(manager)) return manager.acquire(ctx, undefined, placement);
    const spec = await resolveSandboxSpec(resolve, ctx, placement);
    const handle = await manager.get(spec, { signal: ctx.signal });
    return { handle, spec, invalidate: () => manager.evict?.(spec.key, handle) };
  };
  const executeAdapter = async (
    name: 'sbx__run_code' | 'sbx__run_command',
    args: JsonValue,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const acquired = await acquire(ctx, placementFromArgs(asObject(args)));
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
            ...placementProperties,
          },
          required: ['code'],
        },
      async execute(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const code = reqString(o, 'code');
        const language = typeof o.language === 'string' ? o.language : undefined;
        const placement = placementFromArgs(o);
        return executeAdapter('sbx__run_code', { code, ...(language ? { language } : {}), ...placement }, ctx);
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
            ...placementProperties,
          },
          required: ['command'],
        },
      async execute(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const command = reqString(o, 'command');
        return executeAdapter('sbx__run_command', { command, ...placementFromArgs(o) }, ctx);
      },
    }),
  ];
}
