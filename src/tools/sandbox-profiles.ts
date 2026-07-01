import type { JsonValue, ToolResult } from '../model/types.js';
import type { ToolContext, ToolHandler } from '../agent/tools.js';
import type { SandboxManager } from '../sandbox/lifecycle.js';
import type { SandboxProfile } from '../sandbox/profiles.js';
import { findSandboxProfile, publicSandboxProfiles, sandboxSpecForProfile } from '../sandbox/profiles.js';
import type { ExecResult } from '../sandbox/types.js';

function asObject(args: JsonValue): Record<string, JsonValue> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function reqString(o: Record<string, JsonValue>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${key} 必须是非空字符串`);
  return v;
}

function optString(o: Record<string, JsonValue>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v ? v : undefined;
}

function formatExec(r: ExecResult): ToolResult {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.error) parts.push(`[error]\n${r.error}`);
  if (typeof r.exitCode === 'number' && r.exitCode !== 0) parts.push(`[exit code] ${r.exitCode}`);
  const isError = Boolean(r.error) || (typeof r.exitCode === 'number' && r.exitCode !== 0);
  return { id: '', content: parts.join('\n\n') || '(no output)', isError };
}

function markdownProfiles(profiles: SandboxProfile[]): string {
  const rows = profiles.map((profile) => [
    profile.name,
    profile.description,
    profile.capabilities.join(', ') || '-',
    profile.desktop ? '是' : '否',
    profile.privileged ? '是' : '否',
    profile.image || '-',
  ]);
  return [
    '| profile | 用途 | 能力 | 浏览器 | 特权 | 镜像/模板 |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`),
  ].join('\n');
}

export function buildSandboxProfileTools(manager: SandboxManager, profiles: SandboxProfile[]): ToolHandler[] {
  const select = (args: Record<string, JsonValue>) => findSandboxProfile(profiles, optString(args, 'profile'));
  return [
    {
      def: {
        name: 'sandbox_list_profiles',
        description: '列出当前支持的沙箱模板/profile，便于根据任务选择 code/browser/netdiag 等沙箱。',
        inputSchema: { type: 'object', properties: {} },
      },
      async run(): Promise<ToolResult> {
        return {
          id: '',
          content: markdownProfiles(profiles),
          contentBlocks: [{ type: 'text', text: JSON.stringify({ profiles: publicSandboxProfiles(profiles) }) }],
        };
      },
    },
    {
      def: {
        name: 'sandbox_ensure',
        description: '按指定 profile 拉起或复用当前会话的沙箱。profile 省略时使用默认代码沙箱。',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: '沙箱模板名，如 code / browser / netdiag' },
          },
        },
      },
      async run(args, ctx: ToolContext): Promise<ToolResult> {
        const profile = select(asObject(args));
        const spec = sandboxSpecForProfile(profile, ctx);
        const handle = await manager.get(spec);
        return {
          id: '',
          content: `沙箱已就绪：profile=${profile.name}，sandboxId=${handle.sandboxId}，key=${spec.key}`,
        };
      },
    },
    {
      def: {
        name: 'sandbox_run_code',
        description: '在指定 profile 沙箱中执行代码。先用 sandbox_list_profiles 判断任务该使用哪种沙箱。',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: '沙箱模板名，如 code / browser / netdiag' },
            code: { type: 'string', description: '要执行的源代码' },
            language: { type: 'string', description: '语言，如 python / javascript；缺省 python' },
          },
          required: ['code'],
        },
      },
      async run(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const profile = select(o);
        const code = reqString(o, 'code');
        const language = optString(o, 'language');
        const sbx = await manager.get(sandboxSpecForProfile(profile, ctx));
        return formatExec(await sbx.runCode(code, { language, onOutput: ctx.onOutput }));
      },
    },
    {
      def: {
        name: 'sandbox_run_command',
        description: '在指定 profile 沙箱中执行 shell 命令。网络/运维排查应选择 netdiag 等运维 profile。',
        inputSchema: {
          type: 'object',
          properties: {
            profile: { type: 'string', description: '沙箱模板名，如 code / browser / netdiag' },
            command: { type: 'string', description: '要执行的 shell 命令' },
          },
          required: ['command'],
        },
      },
      async run(args, ctx: ToolContext): Promise<ToolResult> {
        const o = asObject(args);
        const profile = select(o);
        const command = reqString(o, 'command');
        const sbx = await manager.get(sandboxSpecForProfile(profile, ctx));
        return formatExec(await sbx.runCommand(command, { onOutput: ctx.onOutput }));
      },
    },
  ];
}
