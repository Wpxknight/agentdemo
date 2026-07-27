import { describe, expect, it } from 'vitest';
import { runEmbeddedPiAgent } from '../examples/pi-agent-platform.js';

describe('non-AIOP Pi embedding example', () => {
  it('runs durable model-tool-model execution using only public packages', async () => {
    await expect(runEmbeddedPiAgent()).resolves.toMatchObject({
      status: 'succeeded',
      text: 'The answer is 7.',
    });
  });
});
