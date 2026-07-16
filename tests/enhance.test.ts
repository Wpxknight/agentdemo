import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent/core.js';
import { ToolRegistry } from '../src/agent/tools.js';
import {
  AutoApproveGate,
  AutoDenyGate,
  InMemoryApprovalStore,
  InteractiveApprovalGate,
  type ApprovalPending,
} from '../src/agent/approval.js';
import { WarmPool } from '../src/sandbox/warmpool.js';
import { SandboxManager } from '../src/sandbox/lifecycle.js';
import { buildBrowserTools } from '../src/tools/browser.js';
import type { ChatModel, StreamEvent, StreamInput } from '../src/model/types.js';
import type { ExecResult, SandboxHandle, SandboxProvider } from '../src/sandbox/types.js';
import type { DesktopHandle } from '../src/sandbox/desktop.js';

const ctx = { sessionId: 't1', tenantId: 'tn', userId: 'u', role: 'user' as const };

/** mock 模型：第一轮发起一次工具调用，第二轮纯文本结束。 */
function mockModel(): ChatModel {
  let turn = 0;
  return {
    id: 'mock',
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      turn++;
      if (turn === 1) {
        yield { type: 'tool_call', call: { id: 'c1', name: 'act', args: {} } };
        yield { type: 'stop', reason: 'tool_use' };
      } else {
        const got = input.messages.at(-1)?.toolResults?.[0];
        yield { type: 'text_delta', text: got?.isError ? 'blocked' : 'ran' };
        yield { type: 'stop', reason: 'end_turn' };
      }
    },
  };
}

function toolsWith(run: () => Promise<{ id: string; content: string }>) {
  const reg = new ToolRegistry();
  reg.register({ def: { name: 'act', description: 'act', inputSchema: { type: 'object' } }, run });
  return reg;
}

describe('approval gate', () => {
  const needApproval = { check: async () => ({ blocked: false, needApproval: true }) };

  it('runs tool when gate approves', async () => {
    const run = vi.fn(async () => ({ id: '', content: 'done' }));
    const r = await runAgent({
      model: mockModel(),
      tools: toolsWith(run),
      policy: needApproval,
      approval: new AutoApproveGate(),
      ctx,
      task: 'go',
    });
    expect(run).toHaveBeenCalledOnce();
    expect(r.text).toBe('ran');
  });

  it('blocks tool when gate denies (and default has no gate)', async () => {
    const run = vi.fn(async () => ({ id: '', content: 'done' }));
    const r = await runAgent({
      model: mockModel(),
      tools: toolsWith(run),
      policy: needApproval,
      approval: new AutoDenyGate(),
      ctx,
      task: 'go',
    });
    expect(run).not.toHaveBeenCalled();
    expect(r.text).toBe('blocked');
  });

  it('interactive approval waits until approved', async () => {
    const store = new InMemoryApprovalStore();
    const emitted: ApprovalPending[] = [];
    const gate = new InteractiveApprovalGate({ store, emit: (p) => emitted.push(p) });

    const waiting = gate.request({ call: { id: 'c1', name: 'act', args: {} }, reason: 'prod', ctx });

    expect(emitted).toHaveLength(1);
    expect(await store.approve(emitted[0]!.id, ctx.tenantId)).toBe(true);
    await expect(waiting).resolves.toBe(true);
    expect(store.get(emitted[0]!.id)).toBeUndefined();
  });

  it('interactive approval resolves false when denied', async () => {
    const store = new InMemoryApprovalStore();
    const gate = new InteractiveApprovalGate({ store, emit: () => {} });

    const waiting = gate.request({ call: { id: 'c1', name: 'act', args: {} }, reason: 'prod', ctx });
    const pending = store.list(ctx.tenantId)[0]!;

    expect(await store.deny(pending.id, ctx.tenantId)).toBe(true);
    await expect(waiting).resolves.toBe(false);
    expect(store.get(pending.id)).toBeUndefined();
  });
});

describe('WarmPool', () => {
  function provider() {
    let n = 0;
    const create = vi.fn(
      async (): Promise<SandboxHandle> => ({
        sandboxId: `w${++n}`,
        runCode: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
        runCommand: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
        readFile: async (): Promise<Uint8Array> => new Uint8Array(),
        setTimeout: async () => {},
        kill: async () => {},
      }),
    );
    const p: SandboxProvider = { create, connect: create };
    return { p, create };
  }

  it('prewarms to size and refills after acquire', async () => {
    const { p, create } = provider();
    const pool = new WarmPool({ provider: p, spec: { template: 'k8s' }, size: 2 });
    await pool.start();
    expect(create).toHaveBeenCalledTimes(2);
    expect(pool.available()).toBe(2);

    const h = await pool.acquire();
    expect(h.sandboxId).toBeDefined();
    // 取一个后异步补位回到 size
    await new Promise((r) => setTimeout(r, 0));
    expect(create).toHaveBeenCalledTimes(3);
    expect(pool.available()).toBe(2);
  });

  it('drain waits for an in-flight refill and kills the late handle', async () => {
    let resolveCreate!: (handle: SandboxHandle) => void;
    const late = new Promise<SandboxHandle>((resolve) => { resolveCreate = resolve; });
    const kill = vi.fn(async () => {});
    const p: SandboxProvider = {
      create: vi.fn(async () => late),
      connect: vi.fn(async () => late),
    };
    const pool = new WarmPool({ provider: p, spec: { template: 'k8s' }, size: 1 });
    const starting = pool.start();
    await vi.waitFor(() => expect(p.create).toHaveBeenCalledOnce());

    const draining = pool.drain();
    resolveCreate({
      sandboxId: 'late',
      runCode: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
      runCommand: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
      readFile: async (): Promise<Uint8Array> => new Uint8Array(),
      setTimeout: async () => {},
      kill,
    });
    await Promise.all([starting, draining]);

    expect(kill).toHaveBeenCalledOnce();
    expect(pool.available()).toBe(0);
    await expect(pool.acquire()).rejects.toThrow(/drained/);
  });

  it('cancels the default drain timeout when refill settles first', async () => {
    vi.useFakeTimers();
    try {
      let resolveCreate!: (handle: SandboxHandle) => void;
      const late = new Promise<SandboxHandle>((resolve) => { resolveCreate = resolve; });
      const kill = vi.fn(async () => {});
      const p: SandboxProvider = {
        create: vi.fn(async () => late),
        connect: vi.fn(async () => late),
      };
      const pool = new WarmPool({ provider: p, spec: { template: 'k8s' }, size: 1 });
      const starting = pool.start();
      expect(p.create).toHaveBeenCalledOnce();

      const draining = pool.drain();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);

      resolveCreate({
        sandboxId: 'refill-before-timeout',
        runCode: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
        runCommand: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
        readFile: async (): Promise<Uint8Array> => new Uint8Array(),
        setTimeout: async () => {},
        kill,
      });
      await Promise.all([starting, draining]);

      expect(kill).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drain returns after a bounded wait and kills a refill that completes later', async () => {
    let resolveCreate!: (handle: SandboxHandle) => void;
    const late = new Promise<SandboxHandle>((resolve) => { resolveCreate = resolve; });
    let releaseTimeout!: () => void;
    const timeout = new Promise<void>((resolve) => { releaseTimeout = resolve; });
    const kill = vi.fn(async () => {});
    const p: SandboxProvider = {
      create: vi.fn(async () => late),
      connect: vi.fn(async () => late),
    };
    const pool = new WarmPool({
      provider: p,
      spec: { template: 'k8s' },
      size: 1,
      drainTimeoutMs: 10,
      sleep: async () => timeout,
    });
    const starting = pool.start();
    await vi.waitFor(() => expect(p.create).toHaveBeenCalledOnce());

    const draining = pool.drain();
    releaseTimeout();
    await draining;
    await expect(pool.acquire()).rejects.toThrow(/drained/);

    resolveCreate({
      sandboxId: 'late-after-timeout',
      runCode: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
      runCommand: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
      readFile: async (): Promise<Uint8Array> => new Uint8Array(),
      setTimeout: async () => {},
      kill,
    });
    await starting;

    expect(kill).toHaveBeenCalledOnce();
    expect(pool.available()).toBe(0);
  });

  it('SandboxManager draws new sandboxes from the pool', async () => {
    const { p, create } = provider();
    const pool = new WarmPool({ provider: p, spec: { template: 'k8s' }, size: 1 });
    await pool.start();
    create.mockClear();

    const mgr = new SandboxManager({ provider: p, warmPool: pool });
    await mgr.get({ key: 's1' }); // 应取自池，不直接 provider.create 一个新 key

    expect(mgr.has('s1')).toBe(true);
  });
});

describe('browser tools', () => {
  function mockDesktop() {
    const calls: string[] = [];
    const handle: DesktopHandle = {
      sandboxId: 'd1',
      startStream: vi.fn(async () => 'https://browser-preview/url'),
      streamUrl: () => 'https://browser-preview/url',
      launch: vi.fn(async (app: string, uri?: string) => {
        calls.push(`launch:${app}:${uri ?? ''}`);
      }),
      leftClick: vi.fn(async (x: number, y: number) => {
        calls.push(`click:${x},${y}`);
      }),
      write: vi.fn(async (t: string) => {
        calls.push(`type:${t}`);
      }),
      screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
      kill: vi.fn(async () => {}),
    };
    return { handle, calls };
  }

  it('navigate/click/type/screenshot/stream operate on the desktop', async () => {
    const { handle, calls } = mockDesktop();
    const tools = buildBrowserTools(async () => handle);
    const by = (n: string) => tools.find((t) => t.def.name === n)!;

    expect((await by('desktop_stream_url').run({}, ctx)).content).toContain('https://browser-preview/url');
    await by('browser_navigate').run({ url: 'https://e.com' }, ctx);
    await by('browser_click').run({ x: 10, y: 20 }, ctx);
    await by('browser_type').run({ text: 'hi' }, ctx);
    const shot = await by('browser_screenshot').run({}, ctx);

    expect(calls).toEqual(['launch:google-chrome:https://e.com', 'click:10,20', 'type:hi']);
    expect(shot.content).toContain('3 字节');
    expect(shot.contentBlocks).toEqual([
      { type: 'text', text: '截图已捕获（3 字节）。浏览器预览：https://browser-preview/url' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') },
    ]);
  });

  it('browser_navigate validates url', async () => {
    const { handle } = mockDesktop();
    const tools = buildBrowserTools(async () => handle);
    const res = await tools.find((t) => t.def.name === 'browser_navigate')!.run({}, ctx);
    expect(res.isError).toBe(true);
  });
});
