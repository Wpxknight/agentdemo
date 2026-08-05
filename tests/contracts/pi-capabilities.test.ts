import { describe, expect, it } from 'vitest';
import {
  AgentHarness,
  InMemorySessionRepo,
  loadSkills,
  type AgentHarnessTool,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createModels, type Model } from '@earendil-works/pi-ai';

const model: Model<'contract-test'> = {
  id: 'contract-test', name: 'Contract Test', api: 'contract-test', provider: 'contract-test', baseUrl: '',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024, maxTokens: 128,
};

describe('Pi 0.82.1 capability contracts', () => {
  it('exposes the Harness steering, follow-up, abort and tool replacement APIs', async () => {
    const session = await new InMemorySessionRepo().create({ id: 'pi-capability-contract' });
    const harness = new AgentHarness({ session, models: createModels(), model });

    const steer: (text: string) => Promise<void> = harness.steer.bind(harness);
    const followUp: (text: string) => Promise<void> = harness.followUp.bind(harness);
    const abort: () => Promise<unknown> = harness.abort.bind(harness);
    const setTools: (tools: AgentHarnessTool<undefined>[], active?: string[]) => Promise<void> = harness.setTools.bind(harness);

    expect(steer).toBeTypeOf('function');
    expect(followUp).toBeTypeOf('function');
    await expect(steer('queued steering')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(followUp('queued follow-up')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(setTools([], [])).resolves.toBeUndefined();
    expect(harness.getTools()).toEqual([]);
    await expect(abort()).resolves.toMatchObject({ clearedSteer: [], clearedFollowUp: [] });
  });

  it('imports and lightly runs the Skill Loader and Session APIs from public exports', async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    try {
      await expect(loadSkills(env, 'tests/contracts/fixtures/not-present')).resolves.toEqual({
        skills: [], diagnostics: [],
      });
    } finally {
      await env.cleanup();
    }

    const session = await new InMemorySessionRepo().create({ id: 'pi-session-contract' });
    const timestamp = Date.now();
    const entryId = await session.appendMessage({ role: 'user', content: 'hello', timestamp });
    await expect(session.getEntry(entryId)).resolves.toMatchObject({
      id: entryId, type: 'message', message: { role: 'user', content: 'hello', timestamp },
    });
    await expect(session.buildContext()).resolves.toMatchObject({
      messages: [{ role: 'user', content: 'hello', timestamp }],
    });
  });
});
