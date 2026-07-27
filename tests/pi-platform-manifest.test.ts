import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('Pi agent platform build baseline', () => {
  it('requires the Node version supported by Pi and Kysely', async () => {
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      engines?: { node?: string };
    };
    expect(manifest.engines?.node).toBe('>=22.19.0');
  });

  it('pins the Pi runtime packages to the reviewed version', async () => {
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@earendil-works/pi-agent-core']).toBe('0.82.1');
    expect(manifest.dependencies?.['@earendil-works/pi-ai']).toBe('0.82.1');
  });

  it('provides the documented build and deployment entry points', async () => {
    const makefile = await readFile(new URL('Makefile', root), 'utf8');
    for (const target of ['verify-node:', 'test-agent-platform:', 'image:', 'deploy-staging:', 'rollback-staging:']) {
      expect(makefile).toContain(target);
    }
  });
});
