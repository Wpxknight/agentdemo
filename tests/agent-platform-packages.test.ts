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
    expect((await manifest('control-contracts')).name).toBe('@aiop/control-contracts');
    expect((await manifest('agent-runtime-core')).name).toBe('@aiop/agent-runtime-core');
    expect((await manifest('agent-runtime-aiop')).name).toBe('@aiop/agent-runtime-aiop');
    expect((await manifest('pi-runtime')).name).toBe('@aiop/pi-runtime');
  });

  it('exports package-root public APIs', async () => {
    for (const name of ['control-contracts', 'agent-runtime-core', 'agent-runtime-aiop', 'pi-runtime']) {
      expect((await manifest(name)).exports).toEqual({
        '.': { types: './bin/index.d.ts', import: './bin/index.js' },
      });
    }
  });

  it('snapshots every declaration file in stable order without map references', async () => {
    const contracts = await readFile(new URL('docs/public-api/control-contracts.d.ts', root), 'utf8');
    const runtimeCore = await readFile(new URL('docs/public-api/agent-runtime-core.d.ts', root), 'utf8');

    expect(contracts).toContain('// file: run.d.ts');
    expect(contracts).toContain('export interface DurableRunRuntime');
    expect(contracts).toContain('append(input: AppendRunMessageInput): Promise<void>;');
    expect(contracts).toContain('export interface RunStore');
    expect(contracts).toContain('renewLease(input: RenewLeaseInput): Promise<void>;');
    expect(runtimeCore).toContain('// file: kernel.d.ts');
    expect(runtimeCore).toContain('export interface AgentKernel');
    expect(runtimeCore).toContain('// file: store.d.ts');

    for (const snapshot of [contracts, runtimeCore]) {
      const files = [...snapshot.matchAll(/^\/\/ file: (.+)$/gm)].map((match) => match[1]!);
      expect(files).toEqual([...files].sort((left, right) => left.localeCompare(right)));
      expect(snapshot).not.toContain('.d.ts.map');
      expect(snapshot).not.toContain('sourceMappingURL');
    }
  });

  it('does not generate source or declaration maps for publishable packages', async () => {
    const config = JSON.parse(await readFile(new URL('tsconfig.packages.json', root), 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    };

    expect(config.compilerOptions.sourceMap).toBe(false);
    expect(config.compilerOptions.declarationMap).toBe(false);
  });

  it('keeps product and LangGraph types outside public contracts', async () => {
    const contracts = await readFile(new URL('packages/control-contracts/src/index.ts', root), 'utf8');
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
      'control-contracts', 'agent-kernel-pi', 'agent-runtime-aiop', 'agent-runtime-core', 'agent-runtime-mysql', 'pi-runtime',
      'mcp-runtime', 'sandbox-runtime',
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
