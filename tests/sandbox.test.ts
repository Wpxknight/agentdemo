import { describe, expect, it, vi } from 'vitest';
import { SandboxManager } from '../src/sandbox/lifecycle.js';
import { buildSandboxTools } from '../src/tools/builtin.js';
import type {
  ExecResult,
  SandboxHandle,
  SandboxProvider,
  SandboxSpec,
} from '../src/sandbox/types.js';

/** 一个可控的 mock 沙箱句柄 + provider，记录调用次数。 */
function mockProvider() {
  let seq = 0;
  const killed: string[] = [];
  const makeHandle = (id: string): SandboxHandle => ({
    sandboxId: id,
    runCode: vi.fn(
      async (code: string): Promise<ExecResult> => ({ stdout: `code:${code}`, stderr: '' }),
    ),
    runCommand: vi.fn(
      async (cmd: string): Promise<ExecResult> => ({
        stdout: `out:${cmd}`,
        stderr: '',
        exitCode: cmd.includes('fail') ? 1 : 0,
        error: cmd.includes('fail') ? 'boom' : undefined,
      }),
    ),
    setTimeout: vi.fn(async () => {}),
    kill: vi.fn(async () => {
      killed.push(id);
    }),
  });

  const provider: SandboxProvider = {
    create: vi.fn(async (_spec: SandboxSpec) => makeHandle(`new-${++seq}`)),
    connect: vi.fn(async (sandboxId: string) => makeHandle(sandboxId)),
  };
  return { provider, killed };
}

describe('SandboxManager', () => {
  it('caches by key: repeated get creates only once', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });

    const a = await mgr.get({ key: 's1' });
    const b = await mgr.get({ key: 's1' });

    expect(a).toBe(b);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(mgr.size()).toBe(1);
  });

  it('dedups concurrent get for same key', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });

    const [a, b] = await Promise.all([mgr.get({ key: 's1' }), mgr.get({ key: 's1' })]);

    expect(a).toBe(b);
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it('connects to remote when sandboxId given', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });

    const h = await mgr.get({ key: 's1', sandboxId: 'remote-x' });

    expect(provider.connect).toHaveBeenCalledOnce();
    expect(provider.create).not.toHaveBeenCalled();
    expect(h.sandboxId).toBe('remote-x');
  });

  it('sweep reclaims idle sandboxes and keeps fresh ones', async () => {
    const { provider, killed } = mockProvider();
    let clock = 1_000;
    const mgr = new SandboxManager({ provider, idleMs: 100, now: () => clock });

    await mgr.get({ key: 'old' });
    clock += 50;
    await mgr.get({ key: 'fresh' }); // fresh used at 1050

    clock += 80; // now 1130: old idle 130>100, fresh idle 80<=100
    const reclaimed = await mgr.sweep();

    expect(reclaimed).toEqual(['old']);
    expect(killed).toEqual(['new-1']);
    expect(mgr.has('old')).toBe(false);
    expect(mgr.has('fresh')).toBe(true);
  });

  it('disposeAll kills everything', async () => {
    const { provider, killed } = mockProvider();
    const mgr = new SandboxManager({ provider });
    await mgr.get({ key: 'a' });
    await mgr.get({ key: 'b' });

    await mgr.disposeAll();

    expect(killed.sort()).toEqual(['new-1', 'new-2']);
    expect(mgr.size()).toBe(0);
  });
});

describe('sandbox tools', () => {
  const ctx = { sessionId: 'sess-1' };

  it('sbx:run_code returns stdout', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(mgr);

    const res = await runCode!.run({ code: 'print(1)' }, ctx);

    expect(res.content).toBe('code:print(1)');
    expect(res.isError).toBeFalsy();
  });

  it('sbx:run_command flags non-zero exit as error', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const tools = buildSandboxTools(mgr);
    const runCommand = tools.find((t) => t.def.name === 'sbx:run_command')!;

    const res = await runCommand.run({ command: 'do-fail' }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content).toContain('boom');
    expect(res.content).toContain('exit code');
  });

  it('sbx:run_code validates required arg', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(mgr);

    await expect(runCode!.run({}, ctx)).rejects.toThrow(/code/);
  });
});
