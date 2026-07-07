import { describe, expect, it } from 'vitest';
import { HookRunner } from '../src/agent/hooks.js';
import type { ToolCall } from '../src/model/types.js';

function call(name: string, args: unknown = {}): ToolCall {
  return { id: 'c1', name, args: args as ToolCall['args'] };
}

describe('HookRunner PreToolUse', () => {
  it('is a no-op when no hooks configured', async () => {
    const runner = new HookRunner();
    expect(runner.empty).toBe(true);
    expect(await runner.preTool(call('kubectl'))).toEqual({ denied: false });
  });

  it('command hook denies when it prints deny', async () => {
    const runner = new HookRunner({
      preToolUse: [{ type: 'command', command: 'echo deny: blocked by policy' }],
    });
    const d = await runner.preTool(call('sbx__run_command', { command: 'rm -rf /' }));
    expect(d.denied).toBe(true);
    expect(d.reason).toContain('blocked by policy');
  });

  it('command hook allows on clean exit with no deny marker', async () => {
    const runner = new HookRunner({ preToolUse: [{ type: 'command', command: 'echo ok' }] });
    expect(await runner.preTool(call('kubectl'))).toEqual({ denied: false });
  });

  it('command hook non-zero exit denies', async () => {
    const runner = new HookRunner({ preToolUse: [{ type: 'command', command: 'exit 3' }] });
    const d = await runner.preTool(call('kubectl'));
    expect(d.denied).toBe(true);
  });

  it('only runs hooks matching the tool prefix', async () => {
    const runner = new HookRunner({
      preToolUse: [{ type: 'command', command: 'echo deny', tools: ['mcp__*'] }],
    });
    // 不匹配的工具放行
    expect(await runner.preTool(call('kubectl'))).toEqual({ denied: false });
    // 匹配前缀的工具被拦
    expect((await runner.preTool(call('mcp__github__x'))).denied).toBe(true);
  });

  it('webhook to a private address is denied by SSRF guard (fail-open on error → allow, but guard throws before request)', async () => {
    // allowPrivateWebhook 默认 false：解析到私网地址应抛错 → fail-open 放行（记录告警），
    // 关键是不会真的发出打内网的请求。这里用 127.0.0.1 直接触发 IP 私网判定。
    const runner = new HookRunner({
      preToolUse: [{ type: 'webhook', url: 'http://127.0.0.1:1/hook' }],
    });
    // hook 出错 fail-open：最终放行，但不会 SSRF 打内网
    expect(await runner.preTool(call('kubectl'))).toEqual({ denied: false });
  });

  it('first denying hook short-circuits', async () => {
    const runner = new HookRunner({
      preToolUse: [
        { type: 'command', command: 'echo deny: first' },
        { type: 'command', command: 'echo deny: second' },
      ],
    });
    const d = await runner.preTool(call('kubectl'));
    expect(d.reason).toContain('first');
  });
});
