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
    for (const name of ['agent-contracts', 'agent-runtime-core', 'agent-runtime-aiop']) {
      expect((await manifest(name)).exports).toEqual({
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      });
    }
  });

  it('keeps product and LangGraph types outside public contracts', async () => {
    const contracts = await readFile(new URL('packages/agent-contracts/src/index.ts', root), 'utf8');
    for (const forbidden of ['RequestContext', "../db/store", 'langgraph', '@langchain']) {
      expect(contracts.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('exposes only Pi records from the AIOP Run Center adapter', async () => {
    const source = await readFile(new URL('packages/agent-runtime-aiop/src/index.ts', root), 'utf8');
    expect(source).toContain("kernel: 'pi'");
    expect(source).not.toMatch(/['"]legacy['"]/);
    expect(source).not.toMatch(/['"]langgraph['"]/i);
  });

  it('keeps every public package free of product imports and undeclared workspace dependencies', async () => {
    const names = [
      'agent-contracts', 'agent-kernel-pi', 'agent-runtime-aiop', 'agent-runtime-core', 'agent-runtime-mysql',
      'mcp-runtime', 'sandbox-core', 'sandbox-e2b', 'sandbox-local', 'sandbox-opensandbox',
      'scheduler-core', 'scheduler-mysql', 'skill-runtime', 'tool-runtime',
    ];
    for (const name of names) {
      const pkg = await manifest(name) as { dependencies?: Record<string, string> };
      const source = await readFile(new URL(`packages/${name}/src/index.ts`, root), 'utf8');
      expect(source).not.toMatch(/from ['"]\.\.\/\.\.\/\.\.\/src\//);
      for (const match of source.matchAll(/from ['"](@aiop\/[^'"]+)['"]/g)) {
        expect(pkg.dependencies, `${name} must declare ${match[1]}`).toHaveProperty(match[1]!);
      }
      expect(source).not.toMatch(/@earendil-works\/pi-(agent-core|ai)\//);
    }
  });
});
