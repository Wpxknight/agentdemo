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
    const handle = await p.create({ key: 'k1', timeoutMs: 60_000, template: 'ubuntu', domain: 'host:8080', envs: { A: '1' } });
    expect(handle.sandboxId).toBe('sb-123');
    const opts = h.created[0] as Record<string, any>;
    expect(opts.image).toBe('ubuntu');
    expect(opts.timeoutSeconds).toBe(60);
    expect(opts.env).toEqual({ A: '1' });
    expect(opts.metadata).toEqual({ aiop_key: 'k1' });
    expect(opts.connectionConfig.domain).toBe('host:8080');
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
    expect(h.run).toHaveBeenCalledWith('echo hello', { timeoutSeconds: 5 });
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
    await handle.runCode('print(1+1)', { language: 'python' });
    const b64 = Buffer.from('print(1+1)', 'utf8').toString('base64');
    expect(h.run).toHaveBeenCalledWith(`echo ${b64} | base64 -d | python3`);
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
