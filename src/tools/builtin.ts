import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import type { SandboxManager } from '../sandbox/lifecycle.js';
import type { ExecResult, SandboxSpec } from '../sandbox/types.js';

/** 由 ctx 推导出本次该用哪个沙箱（缓存键 / 是否连接远端）。 */
export type SpecResolver = (ctx: ToolContext) => Partial<SandboxSpec>;

/** 默认：每个会话一个沙箱（S4 起按 session×cluster）。 */
const defaultResolver: SpecResolver = (ctx) => ({ key: ctx.sessionId });

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

function resolveSpec(resolve: SpecResolver, ctx: ToolContext): SandboxSpec {
  const partial = resolve(ctx);
  return { key: ctx.sessionId, ...partial };
}

/** 构造 E2B 沙箱内置工具：sbx__run_code / sbx__run_command。 */
export function buildSandboxTools(
  manager: SandboxManager,
  resolve: SpecResolver = defaultResolver,
): ToolHandler[] {
  return [
    {
      def: {
        name: 'sbx__run_code',
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
      },
      async run(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const code = reqString(o, 'code');
        const language = typeof o.language === 'string' ? o.language : undefined;
        const sbx = await manager.get(resolveSpec(resolve, ctx));
        return formatExec(await sbx.runCode(code, { language, onOutput: ctx.onOutput }));
      },
    },
    {
      def: {
        name: 'sbx__run_command',
        description: '在隔离沙箱中执行 shell 命令，返回 stdout/stderr 与退出码。',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
          },
          required: ['command'],
        },
      },
      async run(args, ctx): Promise<ToolResult> {
        const o = asObject(args);
        const command = reqString(o, 'command');
        const sbx = await manager.get(resolveSpec(resolve, ctx));
        return formatExec(await sbx.runCommand(command, { onOutput: ctx.onOutput }));
      },
    },
  ];
}
