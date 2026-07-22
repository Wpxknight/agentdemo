import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import type { AgentKernel } from '../src/agent/kernel.js';
import type { RunAgentOptions, RunAgentResult } from '../src/agent/core.js';
import { ToolRegistry } from '../src/agent/tools.js';
import { AllowAllPolicy } from '../src/agent/policy.js';

function runOptions(): RunAgentOptions {
  return {
    model: {
      id: 'unused',
      async *stream() {
        yield { type: 'text_delta' as const, text: 'unused' };
      },
    },
    tools: new ToolRegistry(),
    policy: new AllowAllPolicy(),
    ctx: { sessionId: 'runtime-test' },
    task: 'test',
  };
}

describe('AgentRuntime', () => {
  it('routes the complete options object through the configured kernel', async () => {
    const expected: RunAgentResult = {
      messages: [{ role: 'assistant', text: 'ok' }],
      text: 'ok',
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compacted: false,
    };
    const kernel = {
      name: 'test',
      run: vi.fn(async () => expected),
    } satisfies AgentKernel;
    const runtime = new AgentRuntime({ kernel });
    const options = runOptions();

    await expect(runtime.run(options)).resolves.toBe(expected);
    expect(kernel.run).toHaveBeenCalledOnce();
    expect(kernel.run).toHaveBeenCalledWith(options);
    expect(runtime.kernelName).toBe('test');
  });

  it('uses the legacy kernel by default', () => {
    expect(new AgentRuntime().kernelName).toBe('legacy');
  });
});
