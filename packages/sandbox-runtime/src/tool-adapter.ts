import type { JsonValue } from '@aiop/control-contracts';
import type { GovernedToolDefinition } from '@aiop/pi-runtime';
import type { ExecResult } from './types.js';

interface OperationOptions { signal?: AbortSignal }

export interface SandboxToolOperations {
  runCode(code: string, options: OperationOptions & { language?: string }): Promise<ExecResult>;
  runCommand(command: string, options: OperationOptions): Promise<ExecResult>;
  readFile(path: string, options: OperationOptions): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, options: OperationOptions): Promise<void>;
  desktop(input: Record<string, JsonValue>, options: OperationOptions): Promise<string>;
}

export function createSandboxToolDefinitions(operations: SandboxToolOperations): GovernedToolDefinition[] {
  return [
    definition('sbx__run_code', '在隔离沙箱中执行代码。', 'non_idempotent_write', ['code'], async (args, signal) => {
      const code = requiredString(args, 'code');
      const language = optionalString(args, 'language');
      return formatExec(await operations.runCode(code, { ...(language ? { language } : {}), signal }));
    }),
    definition('sbx__run_command', '在隔离沙箱中执行命令。', 'non_idempotent_write', ['command'], async (args, signal) => (
      formatExec(await operations.runCommand(requiredString(args, 'command'), { signal }))
    )),
    definition('sbx__read_file', '读取沙箱文件。', 'read', ['path'], async (args, signal) => (
      Buffer.from(await operations.readFile(requiredString(args, 'path'), { signal })).toString('base64')
    )),
    definition('sbx__write_file', '写入沙箱文件。', 'retryable_write', ['path', 'content'], async (args, signal) => {
      await operations.writeFile(
        requiredString(args, 'path'),
        new TextEncoder().encode(requiredString(args, 'content')),
        { signal },
      );
      return '(no output)';
    }),
    definition('sbx__desktop', '调用沙箱桌面能力。', 'non_idempotent_write', [], async (args, signal) => (
      operations.desktop(args, { signal })
    )),
  ];
}

function definition(
  name: string,
  description: string,
  capability: GovernedToolDefinition['capability'],
  required: string[],
  execute: (
    args: Record<string, JsonValue>,
    signal?: AbortSignal,
  ) => Promise<string | { content: string; isError?: boolean }>,
): GovernedToolDefinition {
  return {
    name,
    description,
    capability,
    inputSchema: { type: 'object', properties: {}, ...(required.length ? { required } : {}) },
    execute: async (call, context) => {
      const output = await execute(asObject(call.arguments), context.signal);
      return typeof output === 'string' ? { content: output } : output;
    },
  };
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredString(value: Record<string, JsonValue>, key: string): string {
  const found = value[key];
  if (typeof found !== 'string' || !found) throw new Error(`参数 ${key} 必须是非空字符串`);
  return found;
}

function optionalString(value: Record<string, JsonValue>, key: string): string | undefined {
  const found = value[key];
  return typeof found === 'string' && found ? found : undefined;
}

function formatExec(result: ExecResult): { content: string; isError: boolean } {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout.trimEnd());
  if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (result.error) parts.push(`[error]\n${result.error}`);
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) parts.push(`[exit code] ${result.exitCode}`);
  const isError = Boolean(result.error) || (typeof result.exitCode === 'number' && result.exitCode !== 0);
  return {
    content: parts.join('\n\n') || '(no output)',
    isError,
  };
}
