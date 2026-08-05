import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  LocalSandboxProvider,
  SandboxRuntime,
} from '../packages/sandbox-runtime/src/index.js';

describe('sandbox runtime package', () => {
  it('publishes the consolidated package root', async () => {
    const manifest = JSON.parse(await readFile(
      new URL('../packages/sandbox-runtime/package.json', import.meta.url),
      'utf8',
    ));
    expect(manifest.name).toBe('@aiop/sandbox-runtime');
    expect(manifest.exports).toEqual({ '.': { types: './bin/index.d.ts', import: './bin/index.js' } });
  });

  it('runs the provider-neutral lifecycle over the local provider', async () => {
    const runtime = new SandboxRuntime({ provider: new LocalSandboxProvider(), providerName: 'local' });
    const lease = await runtime.acquire({ spec: { key: 'package-local', profile: 'test' } });
    await expect(runtime.execute({
      lease,
      command: `${process.execPath} -e "process.stdout.write('hello')"`,
    })).resolves.toMatchObject({ stdout: 'hello', stderr: '', exitCode: 0 });
    await runtime.release({ lease });
    await expect(runtime.execute({ lease, command: 'true' })).rejects.toThrow('lease is not active');
  });
});
