import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

async function manifest(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`packages/${name}/package.json`, root), 'utf8')) as Record<string, unknown>;
}

describe('agent platform package boundaries', () => {
  it('declares the contracts and runtime core workspaces', async () => {
    const rootManifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as { workspaces?: string[] };
    expect(rootManifest.workspaces).toContain('packages/*');
    expect((await manifest('agent-contracts')).name).toBe('@aiop/agent-contracts');
    expect((await manifest('agent-runtime-core')).name).toBe('@aiop/agent-runtime-core');
    expect((await manifest('agent-runtime-aiop')).name).toBe('@aiop/agent-runtime-aiop');
  });

  it('exports package-root public APIs', async () => {
    expect((await manifest('agent-contracts')).exports).toEqual({ '.': './src/index.ts' });
    expect((await manifest('agent-runtime-core')).exports).toEqual({ '.': './src/index.ts' });
    expect((await manifest('agent-runtime-aiop')).exports).toEqual({ '.': './src/index.ts' });
  });

  it('keeps product and LangGraph types outside public contracts', async () => {
    const contracts = await readFile(new URL('packages/agent-contracts/src/index.ts', root), 'utf8');
    for (const forbidden of ['RequestContext', "../db/store", 'langgraph', '@langchain']) {
      expect(contracts.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
