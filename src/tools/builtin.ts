import type { JsonValue, ToolResult } from '../model/types.js';
import { defineTool, type ToolContext, type ToolHandler } from '../agent/tools.js';
import type { SandboxManagerLike } from '../sandbox/lifecycle.js';
import { isSandboxAcquirer, type SpecResolver } from '../sandbox/acquisition.js';
import { sandboxIdentityKey, sandboxIdentityMetadata } from '../sandbox/keys.js';
import type { ExecResult, SandboxSpec } from '../sandbox/types.js';

export type { SpecResolver } from '../sandbox/acquisition.js';

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

function formatExec(r: ExecResult): ToolResult {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.error) parts.push(`[error]\n${r.error}`);
  if (typeof r.exitCode === 'number' && r.exitCode !== 0) {
    parts.push(`[exit code] ${r.exitCode}`);
  }
  const isError = Boolean(r.error) || (typeof r.exitCode === 'number' && r.exitCode !== 0);
  return {
    id: '',
    content: parts.join('\n\n') || '(no output)',
    isError,
  };
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
    return { handle: await manager.get(spec), spec };
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
        const sbx = (await acquire(ctx)).handle;
        return formatExec(await sbx.runCode(code, { language, onOutput: ctx.onOutput }));
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
        const sbx = (await acquire(ctx)).handle;
        return formatExec(await sbx.runCommand(command, { onOutput: ctx.onOutput }));
      },
    }),
  ];
}
