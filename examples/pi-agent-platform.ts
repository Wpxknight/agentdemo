import type { ToolRuntime } from '@aiop/control-contracts';
import type { ModelProvider } from '@aiop/agent-runtime-core';
import { PiAgentKernel } from '@aiop/agent-kernel-pi';
import { DurableAgentRuntime, MemoryRuntimeStore } from '@aiop/agent-runtime-core';

export async function runEmbeddedPiAgent() {
  let modelTurn = 0;
  const modelProvider: ModelProvider = {
    async *stream() {
      modelTurn++;
      if (modelTurn === 1) {
        yield {
          type: 'tool_call',
          call: { id: 'lookup-1', logicalCallId: 'lookup-1', name: 'lookup', arguments: { key: 'answer' } },
        };
        yield { type: 'stop', reason: 'toolUse' };
        return;
      }
      yield { type: 'text_delta', text: 'The answer is 7.' };
      yield { type: 'stop', reason: 'stop' };
    },
  };
  const toolRuntime: ToolRuntime = {
    execute: async (call) => ({ kind: 'result', result: { callId: call.id, content: '7' } }),
  };
  const runtime = new DurableAgentRuntime({
    store: new MemoryRuntimeStore(),
    kernels: [new PiAgentKernel({ modelProvider, toolRuntime, systemPrompt: 'Answer concisely.' })],
    defaultKernel: 'pi',
    modelBinding: { provider: 'example', model: 'fake-model' },
    tools: [{ name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object' }, capability: 'read' }],
  });
  const handle = await runtime.run({
    identity: { tenantId: 'example', actorId: 'developer', roles: ['user'] },
    sessionId: 'embedded-example',
    input: [{ role: 'user', text: 'What is the answer?' }],
  });
  return handle.result();
}
