import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  created: [] as unknown[],
  connected: [] as unknown[],
  runCode: vi.fn(),
  runCommand: vi.fn(),
  setTimeout: vi.fn(),
  kill: vi.fn(),
}));

vi.mock('@e2b/code-interpreter', () => {
  class Sandbox {
    readonly sandboxId = 'sb-e2b';
    readonly commands = { run: h.runCommand };
    async runCode(code: string) {
      return h.runCode(code);
    }
    async setTimeout(ms: number) { h.setTimeout(ms); }
    async kill() { h.kill(); }
    static async create(opts: unknown) {
      h.created.push(opts);
      return new Sandbox();
    }
    static async connect(sandboxId: string, opts: unknown) {
      h.connected.push({ sandboxId, opts });
      return new Sandbox();
    }
  }
  return { Sandbox };
});

const { E2bProvider } = await import('../src/sandbox/e2b.js');

beforeEach(() => {
  h.created.length = 0;
  h.connected.length = 0;
  h.runCode.mockReset();
  h.runCommand.mockReset();
  h.runCode.mockResolvedValue({ logs: { stdout: [], stderr: [] } });
  h.setTimeout.mockReset();
  h.kill.mockReset();
});

describe('E2bProvider', () => {
  it('forwards namespace and serviceAccount metadata to create options', async () => {
    const p = new E2bProvider({ apiKey: 'key', domain: 'e2b.local' });

    await p.create({
      key: 'session:dev',
      template: 'kubectl:latest',
      namespace: 'aiop',
      serviceAccount: 'aiop-ops',
      metadata: { cluster: 'dev' },
    });

    expect(h.created[0]).toMatchObject({
      template: 'kubectl:latest',
      metadata: {
        cluster: 'dev',
        namespace: 'aiop',
        serviceAccount: 'aiop-ops',
      },
    });
  });

  it('preserves line breaks between separate runCode log messages', async () => {
    h.runCode.mockResolvedValue({
      logs: {
        stdout: ['alpha', 'beta'],
        stderr: ['warn', 'again'],
      },
    });
    const p = new E2bProvider({ apiKey: 'key' });
    const handle = await p.create({ key: 'session:dev' });
    const result = await handle.runCode('print("x")', { language: 'python' });
    expect(result.stdout).toBe('alpha\nbeta');
    expect(result.stderr).toBe('warn\nagain');
  });
});
