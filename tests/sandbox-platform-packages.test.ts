import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LocalSandboxProvider } from '../packages/sandbox-local/src/index.js';

describe('sandbox platform packages', () => {
  it('publishes core, local, OpenSandbox and E2B package roots', async () => {
    for (const name of ['sandbox-core', 'sandbox-local', 'sandbox-opensandbox', 'sandbox-e2b']) {
      const manifest = JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));
      expect(manifest.name).toBe(`@aiop/${name}`);
      expect(manifest.exports).toEqual({ '.': './src/index.ts' });
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
});
