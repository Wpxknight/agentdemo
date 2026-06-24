import { describe, expect, it, vi } from 'vitest';
import { SandboxManager } from '../src/sandbox/lifecycle.js';
import { LocalSandboxProvider } from '../src/sandbox/local.js';
import { OpenSandboxDesktopProvider } from '../src/sandbox/opensandbox-desktop.js';
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

  it('renews backend timeout on reuse', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider, timeoutMs: 5_000 });

    const h = await mgr.get({ key: 's1' }); // 新建：不续期
    expect(h.setTimeout).not.toHaveBeenCalled();

    await mgr.get({ key: 's1' }); // 复用：按 timeoutMs 续期
    await mgr.get({ key: 's1' });
    expect(h.setTimeout).toHaveBeenCalledTimes(2);
    expect(h.setTimeout).toHaveBeenLastCalledWith(5_000);
  });

  it('disposeSession kills the default key and all cluster keys', async () => {
    const { provider, killed } = mockProvider();
    const mgr = new SandboxManager({ provider });

    await mgr.get({ key: 'sess' }); // 默认会话沙箱
    await mgr.get({ key: 'sess:prod' }); // 集群键
    await mgr.get({ key: 'sess:dev' });
    await mgr.get({ key: 'other' }); // 别的会话，不应被清

    const keys = await mgr.disposeSession('sess');

    expect(keys.sort()).toEqual(['sess', 'sess:dev', 'sess:prod']);
    expect(killed.length).toBe(3);
    expect(mgr.has('sess')).toBe(false);
    expect(mgr.has('sess:prod')).toBe(false);
    expect(mgr.has('other')).toBe(true);
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

  it('sbx__run_command flags non-zero exit as error', async () => {
    const { provider } = mockProvider();
    const mgr = new SandboxManager({ provider });
    const tools = buildSandboxTools(mgr);
    const runCommand = tools.find((t) => t.def.name === 'sbx__run_command')!;

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

describe('LocalSandboxProvider', () => {
  it('executes shell commands in a disposable local sandbox', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.create({ key: 'local-test' });
    try {
      const res = await handle.runCommand('printf local-ok');

      expect(res).toMatchObject({ stdout: 'local-ok', stderr: '', exitCode: 0 });
    } finally {
      await handle.kill();
    }
  });

  it('executes JavaScript code and returns stdout', async () => {
    const provider = new LocalSandboxProvider();
    const handle = await provider.create({ key: 'local-code-test' });
    try {
      const res = await handle.runCode('console.log("js-ok")', { language: 'javascript' });

      expect(res.stdout.trim()).toBe('js-ok');
      expect(res.exitCode).toBe(0);
    } finally {
      await handle.kill();
    }
  });
});

describe('OpenSandboxDesktopProvider', () => {
  it('reuses the same session sandbox as code tools', async () => {
    const handle: SandboxHandle = {
      sandboxId: 'shared-sandbox',
      runCode: vi.fn(async (code: string) => ({ stdout: `code:${code}`, stderr: '', exitCode: 0 })),
      runCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      setTimeout: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
    };
    const provider: SandboxProvider = {
      create: vi.fn(async () => handle),
      connect: vi.fn(async () => handle),
    };
    const manager = new SandboxManager({ provider });
    const [runCode] = buildSandboxTools(manager);

    await runCode!.run({ code: 'print("same")' }, { sessionId: 'sess-k8s' });
    const desktops = new OpenSandboxDesktopProvider(manager);
    const desktop = await desktops.create({ key: 'sess-k8s', timeoutMs: 60_000 });
    await desktop.launch('google-chrome', 'https://example.com');

    expect(provider.create).toHaveBeenCalledOnce();
    expect(handle.runCode).toHaveBeenCalledOnce();
    expect(handle.runCommand).toHaveBeenCalled();
    expect(handle.runCommand).toHaveBeenCalledWith(expect.stringContaining('/ms-playwright'), { timeoutMs: 30_000 });
    expect(desktop.sandboxId).toBe('shared-sandbox');
  });

  it('returns screenshot bytes from the sandbox-local CDP helper output', async () => {
    const png = Buffer.from([1, 2, 3, 4]);
    const runCommand = vi.fn(async (command: string): Promise<ExecResult> => {
      if (command.includes('Page.captureScreenshot')) {
        return { stdout: `__AIOP_SCREENSHOT__${png.toString('base64')}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const handle: SandboxHandle = {
      sandboxId: 'shot-sandbox',
      runCode: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
      runCommand,
      setTimeout: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
    };
    const provider: SandboxProvider = {
      create: vi.fn(async () => handle),
      connect: vi.fn(async () => handle),
    };
    const manager = new SandboxManager({ provider });
    const desktop = await new OpenSandboxDesktopProvider(manager).create({ key: 'shot-session' });

    const shot = await desktop.screenshot();

    expect([...shot]).toEqual([1, 2, 3, 4]);
    expect(runCommand).toHaveBeenCalledWith(expect.stringContaining('Page.captureScreenshot'), { timeoutMs: 15_000 });
  });
});
