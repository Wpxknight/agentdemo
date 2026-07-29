import { describe, expect, it, vi } from 'vitest';
import { RunCenterService, type RunCenterStore } from '../src/agent/run-center.js';

describe('Pi Run Center summaries', () => {
  it('adds attempt and committed-turn summaries to every listed run', async () => {
    const createdAt = new Date('2026-07-27T00:00:00.000Z');
    const store = {
      listAgentRuns: vi.fn(async () => [{
        tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', runId: 'run-a',
        kernel: 'pi' as const, kernelVersion: '0.82.1', runtimeVersion: '1', graphName: '', graphVersion: '',
        createdAt, status: 'succeeded' as const, stepCount: 2,
        usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        updatedAt: createdAt, leaseToken: 1,
      }]),
      countAgentRuns: vi.fn(async () => 1),
      listAgentRunAttempts: vi.fn(async () => [
        { attemptId: 'attempt-1', kernel: 'pi', kernelVersion: '0.82.1', status: 'failed', startedAt: createdAt },
        { attemptId: 'attempt-2', kernel: 'pi', kernelVersion: '0.82.1', status: 'succeeded', startedAt: createdAt, completedAt: createdAt },
      ]),
      listAgentRunTurns: vi.fn(async () => [
        { attemptId: 'attempt-2', turnNo: 1, commitId: 'commit-1', transcriptVersion: 1, usage: {}, eventSequenceEnd: 1, committedAt: createdAt },
        { attemptId: 'attempt-2', turnNo: 2, commitId: 'commit-2', transcriptVersion: 2, stopReason: 'end_turn', usage: {}, eventSequenceEnd: 2, committedAt: createdAt },
      ]),
      getAgentRun: vi.fn(), listAgentRunEvents: vi.fn(), listAgentRunInteractions: vi.fn(),
      listAgentRunToolExecutions: vi.fn(), requestAgentRunCancellation: vi.fn(),
      updateAgentRun: vi.fn(), appendAgentRunEvent: vi.fn(),
    } as unknown as RunCenterStore;
    const service = new RunCenterService(store);

    await expect(service.list({ tenantId: 'tenant-a', userId: 'user-a', role: 'user' })).resolves.toMatchObject({
      runs: [{
        runId: 'run-a',
        attemptSummary: { count: 2, latest: { attemptId: 'attempt-2', status: 'succeeded' } },
        turnSummary: { count: 2, latest: { attemptId: 'attempt-2', turnNo: 2, stopReason: 'end_turn' } },
      }],
    });
    expect(store.listAgentRunAttempts).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }), 'run-a');
    expect(store.listAgentRunTurns).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }), 'run-a');
  });
});
