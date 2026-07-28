import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type {
  AgentRunEvent,
  AgentRunResult,
  AttemptStatus,
  ClaimedRun,
  ClaimRunInput,
  DurableInteractionUpdate,
  DurableRunRuntime,
  IdentityContext,
  LeaseLostError,
  RenewLeaseInput,
  ResolveInteractionInput,
  RunStore,
  SseProjectionEvent,
  StartRunInput,
  ToolDefinition,
  ToolExecutionOutcome,
} from '@aiop/control-contracts';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

describe('@aiop/control-contracts', () => {
  it('exports stable control-plane contracts', () => {
    const identity: IdentityContext = { tenantId: 't1', actorId: 'u1', roles: [] };
    const contracts: [
      DurableRunRuntime,
      RunStore,
      StartRunInput,
      AgentRunResult,
      AttemptStatus,
      ClaimRunInput,
      ClaimedRun,
      RenewLeaseInput,
      ResolveInteractionInput,
      DurableInteractionUpdate,
      ToolDefinition,
      ToolExecutionOutcome,
      AgentRunEvent,
      SseProjectionEvent,
      LeaseLostError,
    ] | undefined = undefined;

    expect(identity.tenantId).toBe('t1');
    expect(contracts).toBeUndefined();
  });

  it('does not expose implementation or transport types', async () => {
    const sources = await readSources(new URL('packages/control-contracts/src/', root));
    const declarations = await readSources(new URL('packages/control-contracts/bin/', root), '.d.ts');
    const publicContract = `${sources}\n${declarations}`;
    const forbidden = [
      /\bAgentKernel\b/,
      /\bKernelMessage\b/,
      /\bKernelEvent\b/,
      /\bModelProvider\b/,
      /@earendil-works\/pi/,
      /\bkysely\b/i,
      /\b(?:Request|Response)\b/,
      /@aiop\/agent-contracts/,
    ];

    for (const pattern of forbidden) expect(publicContract).not.toMatch(pattern);
  });

  it('removes legacy package dist outputs during package builds', async () => {
    const packages = await readdir(new URL('packages/', root), { withFileTypes: true });
    const legacyOutputs: string[] = [];
    for (const entry of packages.filter((item) => item.isDirectory())) {
      const children = await readdir(new URL(`packages/${entry.name}/`, root), { withFileTypes: true });
      if (children.some((item) => item.isDirectory() && item.name === 'dist')) legacyOutputs.push(entry.name);
    }

    expect(legacyOutputs).toEqual([]);
  });
});

async function readSources(directory: URL, suffix = '.ts'): Promise<string> {
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .sort((left, right) => left.name.localeCompare(right.name));
  return (await Promise.all(files.map((entry) => readFile(new URL(entry.name, directory), 'utf8')))).join('\n');
}
