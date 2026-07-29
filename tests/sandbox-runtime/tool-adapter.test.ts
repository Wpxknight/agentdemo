import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@aiop/control-contracts';
import { createSandboxToolDefinitions } from '../../packages/sandbox-runtime/src/index.js';

describe('Sandbox Pi Tool adapter', () => {
  it('converts command, file and desktop calls without taking over lease lifecycle', async () => {
    const runCode = vi.fn(async () => ({ stdout: 'code', stderr: '' }));
    const runCommand = vi.fn(async () => ({ stdout: 'command', stderr: '' }));
    const readFile = vi.fn(async () => new Uint8Array([1, 2]));
    const writeFile = vi.fn(async () => undefined);
    const desktop = vi.fn(async () => 'desktop-ok');
    const acquire = vi.fn();
    const release = vi.fn();
    const tools = createSandboxToolDefinitions({ runCode, runCommand, readFile, writeFile, desktop });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const signal = new AbortController().signal;
    const context = {
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      runId: 'run-a', attemptId: 'attempt-a', turnNo: 1, idempotencyKey: 'idem-a', signal,
    } as const;
    const invoke = (name: string, args: JsonValue) => byName.get(name)!.execute({
      id: `call-${name}`, logicalCallId: `logical-${name}`, name, arguments: args,
    }, context);

    await expect(invoke('sbx__run_code', { code: 'print(1)', language: 'python' }))
      .resolves.toEqual({ content: 'code', isError: false });
    await expect(invoke('sbx__run_command', { command: 'pwd' }))
      .resolves.toEqual({ content: 'command', isError: false });
    await expect(invoke('sbx__read_file', { path: 'a.bin' }))
      .resolves.toEqual({ content: 'AQI=' });
    await expect(invoke('sbx__write_file', { path: 'a.txt', content: 'hello' }))
      .resolves.toEqual({ content: '(no output)' });
    await expect(invoke('sbx__desktop', { action: 'screenshot' }))
      .resolves.toEqual({ content: 'desktop-ok' });

    expect(runCode).toHaveBeenCalledWith('print(1)', { language: 'python', signal });
    expect(runCommand).toHaveBeenCalledWith('pwd', { signal });
    expect(readFile).toHaveBeenCalledWith('a.bin', { signal });
    expect(writeFile).toHaveBeenCalledWith('a.txt', new TextEncoder().encode('hello'), { signal });
    expect(desktop).toHaveBeenCalledWith({ action: 'screenshot' }, { signal });
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
