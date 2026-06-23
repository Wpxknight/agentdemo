import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/db/memory.js';
import { resolveRuntimeModelConfig } from '../src/runtime.js';
import type { Config } from '../src/config/schema.js';

const config: Config = {
  models: {
    fallback: {
      protocol: 'anthropic',
      baseURL: 'http://fallback',
      apiKey: 'fallback-key',
      model: 'fallback-model',
    },
  },
  defaultModel: 'fallback',
};

describe('resolveRuntimeModelConfig', () => {
  it('prefers persisted default tenant LLM settings over startup config', async () => {
    const store = new MemoryStore();
    await store.setLlmSettings({ tenantId: 'default' }, {
      id: 'persisted',
      protocol: 'openai',
      baseURL: 'http://persisted/v1',
      apiKey: 'plain-persisted-key',
      model: 'persisted-model',
    });

    await expect(resolveRuntimeModelConfig(config, store)).resolves.toEqual({
      id: 'persisted',
      protocol: 'openai',
      baseURL: 'http://persisted/v1',
      apiKey: 'plain-persisted-key',
      model: 'persisted-model',
    });
  });
});
