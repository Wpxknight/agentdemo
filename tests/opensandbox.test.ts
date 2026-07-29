import { beforeEach, describe, expect, it, vi } from 'vitest';

// 用 hoisted 共享 mock，断言对 SDK 的调用
const h = vi.hoisted(() => ({
  run: vi.fn(),
  kill: vi.fn(),
  close: vi.fn(),
  renew: vi.fn(),
  created: [] as unknown[],
  connected: [] as unknown[],
}));

vi.mock('@alibaba-group/opensandbox', () => {
  class Sandbox {
    readonly id = 'sb-123';
    readonly commands = { run: h.run };
    async kill() { h.kill(); }
    async close() { h.close(); }
    async renew(s: number) { h.renew(s); return {}; }
    static async create(o: unknown) { h.created.push(o); return new Sandbox(); }
    static async connect(o: unknown) { h.connected.push(o); return new Sandbox(); }
  }
  return { Sandbox };
});

const { OpenSandboxProvider } = await import('../src/sandbox/opensandbox.js');

const exec = (stdout: string, extra: Record<string, unknown> = {}) => ({
  logs: { stdout: [{ text: stdout }], stderr: [] },
  exitCode: 0,
  ...extra,
});

const execLogs = (stdout: string[], stderr: string[] = [], extra: Record<string, unknown> = {}) => ({
  logs: {
    stdout: stdout.map((text) => ({ text })),
    stderr: stderr.map((text) => ({ text })),
  },
  exitCode: 0,
  ...extra,
});

beforeEach(() => {
  h.run.mockReset();
  h.kill.mockReset();
  h.close.mockReset();
  h.renew.mockReset();
  h.created.length = 0;
  h.connected.length = 0;
});

describe('OpenSandboxProvider', () => {
  it('create maps spec → SDK options', async () => {
    const p = new OpenSandboxProvider({ defaultImage: 'def:latest' });
    const handle = await p.create({
      key: 'k1',
      timeoutMs: 60_000,
      template: 'ubuntu',
      domain: 'host:8080',
      envs: { A: '1' },
      namespace: 'aiop',
      serviceAccount: 'aiop-ops',
      metadata: { cluster: 'dev' },
    });
    expect(handle.sandboxId).toBe('sb-123');
    const opts = h.created[0] as Record<string, any>;
    expect(opts.image).toBe('ubuntu');
    expect(opts.timeoutSeconds).toBe(60);
    expect(opts.env).toEqual({ A: '1' });
    expect(opts.metadata).toEqual({
      aiop_key: 'k1',
      cluster: 'dev',
      namespace: 'aiop',
      serviceAccount: 'aiop-ops',
    });
    expect(opts.connectionConfig.domain).toBe('host:8080');
  });

  it('sanitizes metadata values before passing them to Kubernetes-backed OpenSandbox', async () => {
    const p = new OpenSandboxProvider({ defaultImage: 'def:latest' });

    await p.create({
      key: '部署验证-netdiag:profile:netdiag',
      metadata: {
        sessionId: '部署验证-netdiag',
        profile: 'netdiag',
        privileged: 'true',
        capabilities: 'kubectl,tcpdump',
      },
    });

    const opts = h.created[0] as Record<string, any>;
    const labelValue = /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/;
    expect(opts.metadata.aiop_key).toMatch(labelValue);
    expect(opts.metadata.aiop_key.length).toBeLessThanOrEqual(63);
    expect(opts.metadata.aiop_key).not.toContain('部署验证');
    expect(opts.metadata.sessionId).toMatch(labelValue);
    expect(opts.metadata.sessionId).not.toBe('部署验证-netdiag');
    expect(opts.metadata.capabilities).toMatch(labelValue);
    expect(opts.metadata.capabilities).not.toContain(',');
    expect(opts.metadata.profile).toBe('netdiag');
    expect(opts.metadata.privileged).toBe('true');
  });

  it('create falls back to defaultImage', async () => {
    const p = new OpenSandboxProvider({ defaultImage: 'def:latest' });
    await p.create({ key: 'k' });
    expect((h.created[0] as Record<string, any>).image).toBe('def:latest');
  });

  it('runCommand maps logs/exitCode', async () => {
    h.run.mockResolvedValue(exec('hello'));
    const p = new OpenSandboxProvider();
    const handle = await p.create({ key: 'k' });
    const r = await handle.runCommand('echo hello', { timeoutMs: 5_000 });
    expect(r.stdout).toBe('hello');
    expect(r.exitCode).toBe(0);
    expect(h.run).toHaveBeenCalledWith('echo hello', { timeoutSeconds: 5 }, undefined);
  });

  it('preserves line breaks between separate stdout and stderr log messages', async () => {
    h.run.mockResolvedValue(execLogs(['alpha', 'beta'], ['warn', 'again']));
    const p = new OpenSandboxProvider();
    const handle = await p.create({ key: 'k' });
    const r = await handle.runCommand('network-check');
    expect(r.stdout).toBe('alpha\nbeta');
    expect(r.stderr).toBe('warn\nagain');
  });

  it('runCommand surfaces execution error', async () => {
    h.run.mockResolvedValue(exec('', { error: { name: 'Err', value: 'boom' }, exitCode: 1 }));
    const p = new OpenSandboxProvider();
    const handle = await p.create({ key: 'k' });
    const r = await handle.runCommand('false');
    expect(r.error).toBe('Err: boom');
    expect(r.exitCode).toBe(1);
  });

  it('runCode pipes base64 source to the interpreter', async () => {
    h.run.mockResolvedValue(exec('2'));
    const p = new OpenSandboxProvider();
    const handle = await p.create({ key: 'k' });
    expect(handle.workspacePath?.('skills/demo')).toBe('/workspace/skills/demo');
    expect(handle.supportsSecretFiles).toBe(true);
    expect(() => handle.workspacePath?.('../escape')).toThrow('escapes sandbox root');
    await handle.runCode('print(1+1)', { language: 'python' });
    const b64 = Buffer.from('print(1+1)', 'utf8').toString('base64');
    expect(h.run).toHaveBeenCalledWith(`echo ${b64} | base64 -d | python3`, undefined, undefined);
  });

  it('runCommand forwards stdout/stderr to onOutput via SDK handlers', async () => {
    h.run.mockImplementation(async (_cmd: string, _opts: unknown, handlers: any) => {
      handlers?.onStdout?.({ text: 'out-line', timestamp: 0 });
      handlers?.onStderr?.({ text: 'err-line', timestamp: 0 });
      return exec('out-line');
    });
    const p = new OpenSandboxProvider();
    const handle = await p.create({ key: 'k' });
    const chunks: Array<{ stream: string; text: string }> = [];
    await handle.runCommand('echo hi', { onOutput: (c) => chunks.push(c) });
    expect(chunks).toEqual([
      { stream: 'stdout', text: 'out-line' },
      { stream: 'stderr', text: 'err-line' },
    ]);
  });

  it('runCode picks node for javascript', async () => {
    h.run.mockResolvedValue(exec('1'));
    const p = new OpenSandboxProvider();
    const handle = await p.create({ key: 'k' });
    await handle.runCode('console.log(1)', { language: 'js' });
    expect((h.run.mock.calls[0]![0] as string).endsWith('| node')).toBe(true);
  });

  it('setTimeout renews; kill closes the client', async () => {
    h.run.mockResolvedValue(exec(''));
    const p = new OpenSandboxProvider();
    const handle = await p.create({ key: 'k' });
    await handle.setTimeout(30_000);
    expect(h.renew).toHaveBeenCalledWith(30);
    await handle.kill();
    expect(h.kill).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
  });

  it('connect uses Sandbox.connect with the id', async () => {
    const p = new OpenSandboxProvider();
    const handle = await p.connect('sb-existing', { key: 'k', timeoutMs: 10_000 });
    expect(handle.sandboxId).toBe('sb-123');
    expect((h.connected[0] as Record<string, any>).sandboxId).toBe('sb-existing');
    expect(h.renew).toHaveBeenCalledWith(10);
  });
});
