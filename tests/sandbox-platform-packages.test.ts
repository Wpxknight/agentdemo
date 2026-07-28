import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LocalSandboxProvider } from '../packages/sandbox-local/src/index.js';
import { OpenSandboxProvider } from '../packages/sandbox-opensandbox/src/index.js';
import { E2BSandboxProvider } from '../packages/sandbox-e2b/src/index.js';

describe('sandbox platform packages', () => {
  it('publishes core, local, OpenSandbox and E2B package roots', async () => {
    for (const name of ['sandbox-core', 'sandbox-local', 'sandbox-opensandbox', 'sandbox-e2b']) {
      const manifest = JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));
      expect(manifest.name).toBe(`@aiop/${name}`);
      expect(manifest.exports).toEqual({ '.': { types: './bin/index.d.ts', import: './bin/index.js' } });
    }
  });

  it('runs commands and transfers files with the standalone local provider', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.acquire({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] }, profile: 'test',
    });
    await provider.upload(handle, { path: 'input.txt', content: new TextEncoder().encode('hello') });
    const output: string[] = [];
    for await (const item of provider.execute(handle, {
      program: process.execPath, args: ['-e', "process.stdout.write(require('fs').readFileSync('input.txt','utf8'))"],
    })) output.push(item.text);
    expect(output.join('')).toBe('hello');
    expect(new TextDecoder().decode((await provider.download(handle, 'input.txt')).content)).toBe('hello');
    await provider.release(handle);
    await expect(provider.download(handle, 'input.txt')).rejects.toThrow('Sandbox handle');
  });

  it('uses the injected OpenSandbox SDK directly with safe tenant metadata and byte transfers', async () => {
    const calls: Array<{ type: string; value?: unknown }> = [];
    let stored: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const sdk = {
      id: 'open-1',
      commands: {
        run: async (_command: string, options: unknown, handlers: {
          onStdout?: (message: { text: string }) => void;
          onStderr?: (message: { text: string }) => void;
        }) => {
          calls.push({ type: 'run', value: options });
          handlers.onStdout?.({ text: 'out' });
          handlers.onStderr?.({ text: 'err' });
          return { exitCode: 0 };
        },
      },
      files: {
        writeFiles: async (files: Array<{ path: string; data: Uint8Array }>) => { stored = files[0]!.data; },
        readBytes: async () => stored,
      },
      kill: async () => { calls.push({ type: 'kill' }); },
      close: async () => { calls.push({ type: 'close' }); },
    };
    const provider = new OpenSandboxProvider({
      apiKey: 'secret-open',
      defaultImage: 'image:test',
      sdkFactory: { create: async (options) => { calls.push({ type: 'create', value: options }); return sdk; } },
    });
    const handle = await provider.acquire({
      identity: { tenantId: 'tenant/a', actorId: 'user-a', roles: ['user'] },
      profile: 'python', timeoutMs: 2_500, cpu: 2, memoryMb: 1024, network: 'restricted',
    });
    expect(handle).toEqual({ id: 'open-1', provider: 'opensandbox', profile: 'python' });
    expect(JSON.stringify(handle)).not.toContain('secret-open');
    expect(calls[0]).toMatchObject({ type: 'create', value: {
      image: 'image:test', timeoutSeconds: 3,
      metadata: expect.objectContaining({ tenantId: expect.stringMatching(/^tenant-a-/), actorId: 'user-a' }),
      resource: { cpu: '2', memory: '1024Mi' },
    } });
    await provider.upload(handle, { path: 'data/input.bin', content: new Uint8Array([1, 2, 3]) });
    await expect(provider.download(handle, 'data/input.bin')).resolves.toEqual({
      path: 'data/input.bin', content: new Uint8Array([1, 2, 3]),
    });
    const output = [];
    for await (const item of provider.execute(handle, {
      program: 'node', args: ['-e', 'ok'], cwd: 'work', env: { A: '1' }, timeoutMs: 1_500,
    })) output.push(item);
    expect(output).toEqual([
      { stream: 'stdout', text: 'out' },
      { stream: 'stderr', text: 'err' },
      { stream: 'stdout', text: '', exitCode: 0 },
    ]);
    await expect(provider.upload(handle, { path: '../escape', content: new Uint8Array() }))
      .rejects.toThrow('Sandbox path');
    await provider.release(handle);
    expect(calls.slice(-2).map((call) => call.type)).toEqual(['kill', 'close']);
  });

  it('uses the injected E2B SDK directly with streaming commands, timeout, files, and kill-on-release', async () => {
    const calls: Array<{ type: string; value?: unknown }> = [];
    let stored: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const sdk = {
      sandboxId: 'e2b-1',
      commands: {
        run: async (_command: string, options: {
          onStdout?: (text: string) => void;
          onStderr?: (text: string) => void;
        }) => {
          calls.push({ type: 'run', value: options });
          options.onStdout?.('out');
          options.onStderr?.('err');
          return { stdout: 'out', stderr: 'err', exitCode: 0 };
        },
      },
      files: {
        write: async (_path: string, content: ArrayBuffer) => { stored = new Uint8Array(content); },
        read: async () => stored,
      },
      kill: async () => { calls.push({ type: 'kill' }); },
    };
    const provider = new E2BSandboxProvider({
      apiKey: 'secret-e2b', domain: 'e2b.internal', template: 'template-a',
      sdkFactory: { create: async (options) => { calls.push({ type: 'create', value: options }); return sdk; } },
    });
    const handle = await provider.acquire({
      identity: { tenantId: 'tenant-a', actorId: 'user-a', roles: ['user'] },
      profile: 'node', timeoutMs: 5_000, network: 'none',
    });
    expect(handle).toEqual({ id: 'e2b-1', provider: 'e2b', profile: 'node' });
    expect(calls[0]).toMatchObject({ type: 'create', value: {
      apiKey: 'secret-e2b', domain: 'e2b.internal', template: 'template-a', timeoutMs: 5_000,
      allowInternetAccess: false,
      metadata: { tenantId: 'tenant-a', actorId: 'user-a', profile: 'node' },
    } });
    await provider.upload(handle, { path: 'data.bin', content: new Uint8Array([4, 5]) });
    await expect(provider.download(handle, 'data.bin')).resolves.toEqual({
      path: 'data.bin', content: new Uint8Array([4, 5]),
    });
    const output = [];
    for await (const item of provider.execute(handle, { program: 'echo', args: ['hello'], timeoutMs: 500 })) {
      output.push(item);
    }
    expect(output.at(-1)).toEqual({ stream: 'stdout', text: '', exitCode: 0 });
    await expect(provider.download(handle, '/absolute')).rejects.toThrow('Sandbox paths must be relative');
    await provider.release(handle);
    expect(calls.at(-1)?.type).toBe('kill');
    await expect(provider.download(handle, 'data.bin')).rejects.toThrow('Sandbox handle');
  });
});
