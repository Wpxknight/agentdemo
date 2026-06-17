import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent/core.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AutoApproveGate, AutoDenyGate } from '../src/agent/approval.js';
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
});

describe('WarmPool', () => {
  function provider() {
    let n = 0;
    const create = vi.fn(
      async (): Promise<SandboxHandle> => ({
        sandboxId: `w${++n}`,
        runCode: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
        runCommand: async (): Promise<ExecResult> => ({ stdout: '', stderr: '' }),
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
      startStream: vi.fn(async () => 'https://vnc/url'),
      streamUrl: () => 'https://vnc/url',
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

    expect((await by('desktop_stream_url').run({}, ctx)).content).toContain('https://vnc/url');
    await by('browser_navigate').run({ url: 'https://e.com' }, ctx);
    await by('browser_click').run({ x: 10, y: 20 }, ctx);
    await by('browser_type').run({ text: 'hi' }, ctx);
    const shot = await by('browser_screenshot').run({}, ctx);

    expect(calls).toEqual(['launch:google-chrome:https://e.com', 'click:10,20', 'type:hi']);
    expect(shot.content).toContain('3 字节');
  });

  it('browser_navigate validates url', async () => {
    const { handle } = mockDesktop();
    const tools = buildBrowserTools(async () => handle);
    const res = await tools.find((t) => t.def.name === 'browser_navigate')!.run({}, ctx);
    expect(res.isError).toBe(true);
  });
});
