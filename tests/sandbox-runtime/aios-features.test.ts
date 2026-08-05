import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('AIOS sandbox runtime feature boundaries', () => {
  it('keeps profiles, template catalog, warm pool, placement and user home as package exports', async () => {
    const runtime = await import('../../packages/sandbox-runtime/src/index.js');
    expect(runtime).toMatchObject({
      AiosE2bProvider: expect.any(Function),
      AiosTemplateCatalog: expect.any(Function),
      WarmPool: expect.any(Function),
      normalizeUserHomeDir: expect.any(Function),
      resolveSandboxProfiles: expect.any(Function),
    });
    for (const file of ['aios-http.ts', 'aios-template-catalog.ts', 'warmpool.ts', 'userhome.ts', 'profiles.ts']) {
      await expect(readFile(new URL(`../../packages/sandbox-runtime/src/${file}`, import.meta.url), 'utf8'))
        .resolves.toBeTruthy();
    }
  });

  it('publishes one sandbox runtime package and removes legacy package roots', async () => {
    const manifest = JSON.parse(await readFile(
      new URL('../../packages/sandbox-runtime/package.json', import.meta.url), 'utf8',
    ));
    expect(manifest.name).toBe('@aiop/sandbox-runtime');
    for (const name of ['sandbox-core', 'sandbox-local', 'sandbox-e2b', 'sandbox-opensandbox']) {
      await expect(readFile(new URL(`../../packages/${name}/package.json`, import.meta.url), 'utf8')).rejects.toThrow();
    }
  });
});
